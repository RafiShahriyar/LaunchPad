import { credentialsRepo } from '@db/index'
import type { MetadataSearchResult } from '@shared/ipc'
import { attachThumbnails, createThrottle, describeNetworkError, getJson, REQUEST_TIMEOUT_MS } from './http'
import type { MetadataProviderClient } from './types'

/**
 * IGDB metadata provider, reached through Twitch's OAuth.
 *
 * The richest of the providers — it is the only one that returns genres,
 * summaries AND portrait box art from a single query, which is why it was built
 * first. Its cost is registration: Twitch requires an account with SMS
 * two-factor enabled, which is unavailable or unreliable in some countries.
 * RAWG plus SteamGridDB exists as the no-phone alternative.
 *
 * Every base URL is overridable through the environment so the end-to-end suite
 * can point the client at a local stub. Testing against the real service would
 * be flaky, would need a live secret in CI, and would burn a rate limit shared
 * with the user's own searching.
 */

const AUTH_BASE = process.env.LAUNCHPAD_IGDB_AUTH_BASE ?? 'https://id.twitch.tv'
const API_BASE = process.env.LAUNCHPAD_IGDB_API_BASE ?? 'https://api.igdb.com/v4'
const IMAGE_BASE =
  process.env.LAUNCHPAD_IGDB_IMAGE_BASE ?? 'https://images.igdb.com/igdb/image/upload'

/** IGDB documents a limit of four requests per second. */
const throttle = createThrottle(260)

const MAX_RESULTS = 12
const NAME = 'IGDB'

/**
 * Refresh a little before the token actually expires.
 *
 * A token that is valid when checked but expires in flight produces a 401 that
 * looks exactly like bad credentials. Sixty seconds of slack costs nothing on a
 * token that lives for sixty days.
 */
const TOKEN_EXPIRY_SLACK_MS = 60_000

const FIELDS = ['clientId', 'clientSecret'] as const

interface TokenResponse {
  access_token?: unknown
  expires_in?: unknown
}

async function requestToken(
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; expiresAt: string }> {
  const url = new URL('/oauth2/token', AUTH_BASE)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('client_secret', clientSecret)
  url.searchParams.set('grant_type', 'client_credentials')

  await throttle()

  let response: Response
  try {
    response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(describeNetworkError(err, NAME))
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Error('IGDB rejected the Client ID or Client Secret. Check both and try again.')
  }
  if (!response.ok) throw new Error(`IGDB authentication failed with HTTP ${response.status}.`)

  let body: TokenResponse
  try {
    body = (await response.json()) as TokenResponse
  } catch {
    throw new Error('IGDB returned a response that was not valid JSON.')
  }

  const accessToken = body.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('IGDB returned no access token.')
  }

  /*
   * Treat a missing or nonsensical lifetime as one hour rather than trusting it.
   * A short guess only costs one extra token request; assuming the token lasts
   * forever would wedge the feature until credentials were re-entered by hand.
   */
  const expiresIn = body.expires_in
  const lifetimeMs =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn * 1000
      : 3_600_000

  return { accessToken, expiresAt: new Date(Date.now() + lifetimeMs).toISOString() }
}

async function getAccessToken(
  values: Record<string, string>,
  forceRefresh = false
): Promise<string> {
  if (!forceRefresh) {
    const cached = credentialsRepo.getCachedToken('igdb')
    if (cached) {
      const expiresAtMs = Date.parse(cached.expiresAt)
      if (Number.isFinite(expiresAtMs) && expiresAtMs - TOKEN_EXPIRY_SLACK_MS > Date.now()) {
        return cached.accessToken
      }
    }
  }

  const fresh = await requestToken(values.clientId ?? '', values.clientSecret ?? '')
  credentialsRepo.setCachedToken('igdb', fresh)
  return fresh.accessToken
}

/**
 * Escapes a user-typed term for an Apicalypse string literal.
 *
 * Apicalypse is a query language and the search term is interpolated into it.
 * Backslashes and quotes are escaped so a term cannot close the literal, and the
 * statement separator and newlines are dropped so it cannot append a second
 * clause. Same class of problem as SQL injection, handled the same way: never
 * assume the caller sanitised it.
 */
function escapeApicalypse(term: string): string {
  return term
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[;\r\n]/g, ' ')
    .trim()
}

interface IgdbGame {
  id?: unknown
  name?: unknown
  summary?: unknown
  first_release_date?: unknown
  genres?: unknown
  cover?: unknown
  artworks?: unknown
}

/** IGDB reports release dates as whole-second Unix timestamps, in UTC. */
function toReleaseDate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function toGenres(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      const name = (entry as { name?: unknown }).name
      if (typeof name === 'string' && name.length > 0) names.push(name)
    }
  }
  return names
}

/**
 * First usable artwork id from IGDB's `artworks` array.
 *
 * Separate from toImageId because the shapes differ: `cover` is a single
 * object, `artworks` is a list. IGDB orders it by upload rather than quality,
 * so the first entry is simply the first -- there is no ranking to apply, and
 * inventing one would be guesswork dressed as selection.
 */
function toArtworkId(artworks: unknown): string | null {
  if (!Array.isArray(artworks)) return null
  for (const entry of artworks) {
    const id = toImageId(entry)
    if (id !== null) return id
  }
  return null
}

function toImageId(cover: unknown): string | null {
  if (!cover || typeof cover !== 'object') return null
  const imageId = (cover as { image_id?: unknown }).image_id
  if (typeof imageId !== 'string' || imageId.length === 0) return null
  return imageId
}

function mapResult(raw: IgdbGame): { result: MetadataSearchResult; thumbUrl: string | null } | null {
  const id = raw.id
  const name = raw.name
  if (typeof id !== 'number' && typeof id !== 'string') return null
  if (typeof name !== 'string' || name.length === 0) return null

  const imageId = toImageId(raw.cover)
  const artworkId = toArtworkId(raw.artworks)

  return {
    result: {
      id: String(id),
      source: 'igdb',
      name,
      releaseDate: toReleaseDate(raw.first_release_date),
      genres: toGenres(raw.genres),
      summary: typeof raw.summary === 'string' && raw.summary.length > 0 ? raw.summary : null,
      /*
       * `t_cover_big_2x` is 528x748 -- very close to the 3:4 the library grid
       * draws, so a card crops almost nothing off it. The 1x variant is visibly
       * soft on a high-DPI display, and the original is many times larger for
       * art never shown above card size.
       */
      coverUrl: imageId === null ? null : `${IMAGE_BASE}/t_cover_big_2x/${imageId}.jpg`,
      /*
       * `artworks` before `screenshots`: artwork is produced key art, while a
       * screenshot is whatever frame someone captured -- often a HUD, a menu or
       * a loading screen, none of which read well with a title over them.
       *
       * `t_1080p` because this is drawn full-bleed across the window; the cover
       * sizes would be visibly soft stretched that wide.
       */
      heroUrl: artworkId === null ? null : `${IMAGE_BASE}/t_1080p/${artworkId}.jpg`,
      thumbnailDataUri: null
    },
    /** 90x128 -- a few kilobytes, which is what makes inlining them affordable. */
    thumbUrl: imageId === null ? null : `${IMAGE_BASE}/t_thumb/${imageId}.jpg`
  }
}

async function postGamesQuery(
  body: string,
  values: Record<string, string>,
  forceRefresh = false
): Promise<unknown> {
  const token = await getAccessToken(values, forceRefresh)

  await throttle()

  const { status, body: payload } = await getJson(
    `${API_BASE}/games`,
    {
      method: 'POST',
      headers: {
        'Client-ID': values.clientId ?? '',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'text/plain'
      },
      body
    },
    NAME
  )

  /*
   * A 401 here is ambiguous: the cached token may simply have been revoked or
   * expired early. Retrying once with a freshly minted token distinguishes the
   * two -- if it fails again, the credentials really are bad. Without this, a
   * revoked token would leave the feature permanently broken until the user
   * re-entered credentials they had no reason to suspect.
   */
  if (status === 401 && !forceRefresh) {
    credentialsRepo.clearCachedToken('igdb')
    return postGamesQuery(body, values, true)
  }

  if (status === 401 || status === 403) {
    throw new Error('IGDB rejected the stored credentials. Re-enter them in Settings.')
  }
  if (status === 429) {
    throw new Error('IGDB rate limit reached. Wait a few seconds and search again.')
  }
  if (status !== 200 || payload === null) throw new Error(`IGDB returned HTTP ${status}.`)

  return payload
}

export const igdb: MetadataProviderClient = {
  role: 'metadata',
  identityField: 'clientId',
  descriptor: {
    id: 'igdb',
    name: 'IGDB',
    role: 'metadata',
    signupUrl: 'https://dev.twitch.tv/console/apps',
    blurb:
      'Genres, summaries and portrait box art from one source. Requires a Twitch account with two-factor authentication enabled, which needs a phone number Twitch can reach by SMS.',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: false, placeholder: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret', secret: true, placeholder: 'Client Secret' }
    ]
  },

  async verify(values) {
    // Returned, not cached: saveCredentials() persists it AFTER the credentials
    // are stored, because storing them clears any cached token. The pair is
    // proven good, and discarding the token would make the very next search
    // re-authenticate for no reason.
    return requestToken(values.clientId ?? '', values.clientSecret ?? '')
  },

  /**
   * `where version_parent = null` drops alternate editions (Game of the Year,
   * regional re-releases), which otherwise crowd the list with near-duplicates
   * of the entry the user actually wants.
   */
  async search(rawQuery, values) {
    const query = escapeApicalypse(rawQuery).slice(0, 100)
    if (query.length === 0) return []

    const payload = await postGamesQuery(
      `search "${query}"; ` +
        'fields name,summary,first_release_date,genres.name,cover.image_id,artworks.image_id; ' +
        'where version_parent = null; ' +
        `limit ${MAX_RESULTS};`,
      values
    )

    if (!Array.isArray(payload)) throw new Error('IGDB returned an unexpected response shape.')

    const mapped: { result: MetadataSearchResult; thumbUrl: string | null }[] = []
    for (const entry of payload) {
      const row = mapResult(entry as IgdbGame)
      if (row) mapped.push(row)
    }

    await attachThumbnails(mapped)
    return mapped.map((row) => row.result)
  }
}

export const IGDB_FIELDS = FIELDS
