import type { MetadataSearchResult } from '@shared/ipc'
import { attachThumbnails, createThrottle, getJson } from './http'
import type { MetadataProviderClient } from './types'

/**
 * RAWG.io metadata provider.
 *
 * Chosen as the no-phone-verification alternative to IGDB: RAWG needs only an
 * email address, where IGDB requires a Twitch account with SMS two-factor
 * enabled — which is unavailable or unreliable in a number of countries.
 *
 * Its one real weakness is artwork. `background_image` is a landscape
 * screenshot, and the library grid draws portrait 3:4 cards, so it crops badly.
 * That is exactly the gap the SteamGridDB art provider fills; see
 * services/metadata.ts, which prefers portrait art when one is configured and
 * falls back to this image when it is not.
 */

const API_BASE = process.env.LAUNCHPAD_RAWG_API_BASE ?? 'https://api.rawg.io/api'

/** RAWG's free tier is a monthly quota, not a per-second limit; this is politeness. */
const throttle = createThrottle(120)

const MAX_RESULTS = 12
const NAME = 'RAWG'

interface RawgGame {
  id?: unknown
  name?: unknown
  released?: unknown
  background_image?: unknown
  genres?: unknown
  description_raw?: unknown
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

/** RAWG already reports YYYY-MM-DD, but an unreleased game sends null or "". */
function toReleaseDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function toImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return /^https?:\/\//i.test(value) ? value : null
}

/**
 * RAWG serves resized variants through a path segment, so a list thumbnail
 * costs a few kilobytes instead of the full screenshot. Falls back to the
 * original URL if the path is not in the expected shape rather than guessing.
 */
function toThumbUrl(fullUrl: string | null): string | null {
  if (fullUrl === null) return null
  return fullUrl.replace('/media/', '/media/resize/420/-/')
}

function mapResult(raw: RawgGame): { result: MetadataSearchResult; thumbUrl: string | null } | null {
  const id = raw.id
  const name = raw.name
  if (typeof id !== 'number' && typeof id !== 'string') return null
  if (typeof name !== 'string' || name.length === 0) return null

  const coverUrl = toImageUrl(raw.background_image)

  return {
    result: {
      id: String(id),
      source: 'rawg',
      name,
      releaseDate: toReleaseDate(raw.released),
      genres: toGenres(raw.genres),
      // The list endpoint carries no description. Fetched by enrich() for the
      // one entry the user picks, rather than for all twelve.
      summary: null,
      coverUrl,
      /*
       * The same image as the cover, and that is not a mistake.
       *
       * RAWG's `background_image` IS a landscape screenshot -- its unsuitability
       * as a 3:4 card is exactly why SteamGridDB exists in this project. As a
       * wide backdrop it is the right shape, so the field that makes a poor
       * cover makes a perfectly good hero, at zero extra cost.
       *
       * When SteamGridDB is configured its hero wins at apply time anyway; this
       * is what a RAWG-only setup falls back to.
       */
      heroUrl: coverUrl,
      thumbnailDataUri: null
    },
    thumbUrl: toThumbUrl(coverUrl)
  }
}

function keyed(path: string, apiKey: string, params: Record<string, string> = {}): URL {
  const url = new URL(`${API_BASE}${path}`)
  url.searchParams.set('key', apiKey)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url
}

export const rawg: MetadataProviderClient = {
  role: 'metadata',
  identityField: 'apiKey',
  descriptor: {
    id: 'rawg',
    name: 'RAWG',
    role: 'metadata',
    signupUrl: 'https://rawg.io/apidocs',
    blurb:
      'Genres, descriptions and release dates for a very large catalogue, including non-Steam games. Free with an email address — no phone number needed.',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'Your RAWG API key' }]
  },

  async verify(values) {
    await throttle()
    const { status, body } = await getJson(
      keyed('/games', values.apiKey ?? '', { page_size: '1' }),
      { headers: { Accept: 'application/json' } },
      NAME
    )
    if (status === 401 || status === 403) {
      throw new Error('RAWG rejected the API key. Check it and try again.')
    }
    if (status !== 200 || body === null) {
      throw new Error(`RAWG returned HTTP ${status} while checking the key.`)
    }
  },

  async search(query, values) {
    await throttle()
    const { status, body } = await getJson(
      keyed('/games', values.apiKey ?? '', {
        search: query,
        page_size: String(MAX_RESULTS),
        // Exact-ish ordering; without it a short term returns popular games that
        // merely mention the word, which reads as the search being wrong.
        search_precise: 'true'
      }),
      { headers: { Accept: 'application/json' } },
      NAME
    )

    if (status === 401 || status === 403) {
      throw new Error('RAWG rejected the stored API key. Re-enter it in Settings.')
    }
    if (status === 429) {
      throw new Error('RAWG rate limit reached. Wait a moment and search again.')
    }
    if (status !== 200 || body === null) throw new Error(`RAWG returned HTTP ${status}.`)

    const results = (body as { results?: unknown }).results
    if (!Array.isArray(results)) throw new Error('RAWG returned an unexpected response shape.')

    const mapped: { result: MetadataSearchResult; thumbUrl: string | null }[] = []
    for (const entry of results) {
      const row = mapResult(entry as RawgGame)
      if (row) mapped.push(row)
    }

    await attachThumbnails(mapped)
    return mapped.map((row) => row.result)
  },

  /**
   * Fetches the description for the chosen entry only.
   *
   * A failure here returns the result unchanged rather than throwing: the
   * genres, date and cover are already known and worth keeping. Losing the whole
   * apply because an optional field could not be fetched would be the app
   * discarding work that succeeded.
   */
  async enrich(result, values) {
    try {
      await throttle()
      const { status, body } = await getJson(
        keyed(`/games/${encodeURIComponent(result.id)}`, values.apiKey ?? ''),
        { headers: { Accept: 'application/json' } },
        NAME
      )
      if (status !== 200 || body === null) return result

      const description = (body as RawgGame).description_raw
      if (typeof description !== 'string' || description.trim().length === 0) return result

      return { ...result, summary: description.trim() }
    } catch {
      return result
    }
  }
}
