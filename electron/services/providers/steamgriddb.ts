import { createThrottle, getJson } from './http'
import type { ArtProviderClient } from './types'

/**
 * SteamGridDB — cover art only.
 *
 * Exists to solve one specific problem: the library grid draws portrait 3:4
 * cards, and most catalogue APIs return landscape screenshots that crop to a
 * useless middle sliver. SteamGridDB's "grids" are community-maintained
 * portrait box art, typically 600x900, which is very close to the shape the
 * card wants.
 *
 * It supplies no genres, descriptions or dates, so it never acts as a metadata
 * source — it upgrades the cover chosen by whichever metadata provider ran.
 * Sign-in is through Steam, so unlike IGDB it needs no phone verification.
 */

const API_BASE = process.env.LAUNCHPAD_SGDB_API_BASE ?? 'https://www.steamgriddb.com/api/v2'

const throttle = createThrottle(120)
const NAME = 'SteamGridDB'

/**
 * Portrait shapes only, largest first.
 *
 * Requesting every dimension and filtering afterwards would mean downloading a
 * candidate list full of landscape hero images that can never be used here.
 */
const PORTRAIT_DIMENSIONS = '600x900,342x482,660x930'

/**
 * Wide shapes, largest first.
 *
 * 1920x620 is SteamGridDB's standard hero and by far the best populated; the
 * 3840 variant is the same art at 2x for high-DPI displays. Listing landscape
 * dimensions explicitly matters for the same reason it does above — the default
 * response would be full of portrait grids that cannot be used as a backdrop.
 */
const HERO_DIMENSIONS = '3840x1240,1920x620,1600x650'

function authHeaders(values: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${values.apiKey ?? ''}`,
    Accept: 'application/json'
  }
}

function firstUrl(body: unknown): string | null {
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const url = (entry as { url?: unknown }).url
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
    }
  }
  return null
}

export const steamGridDb: ArtProviderClient = {
  role: 'art',
  identityField: 'apiKey',
  descriptor: {
    id: 'steamgriddb',
    name: 'SteamGridDB',
    role: 'art',
    signupUrl: 'https://www.steamgriddb.com/profile/preferences/api',
    blurb:
      'Community portrait box art, the shape the library grid actually draws. Optional, and only used to replace a landscape cover with a better one. Sign in with Steam — no phone number needed.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, placeholder: 'Your SteamGridDB API key' }
    ]
  },

  async verify(values) {
    await throttle()
    const { status } = await getJson(
      `${API_BASE}/search/autocomplete/${encodeURIComponent('portal')}`,
      { headers: authHeaders(values) },
      NAME
    )
    if (status === 401 || status === 403) {
      throw new Error('SteamGridDB rejected the API key. Check it and try again.')
    }
    if (status !== 200) {
      throw new Error(`SteamGridDB returned HTTP ${status} while checking the key.`)
    }
  },

  /**
   * Two requests: resolve the name to a game id, then ask for its portrait art.
   *
   * Only ever run for the single game being applied, never for a whole page of
   * search results — twelve results would be twenty-four requests for artwork
   * the user is about to discard eleven twelfths of.
   *
   * Every failure path returns null rather than throwing. Art is an upgrade; if
   * it cannot be had, the caller keeps the metadata provider's image and the
   * apply still succeeds.
   */
  findCover(name, values) {
    return findArt('grids', PORTRAIT_DIMENSIONS, name, values)
  },

  /**
   * The same two requests against the `heroes` endpoint.
   *
   * Heroes are the reason this provider is worth a second call at all: RAWG and
   * IGDB both hand back a wide image, but theirs is a screenshot or a piece of
   * concept art, while SteamGridDB's heroes are composed for exactly this use —
   * a banner with the focal point off to one side and room for text over it.
   *
   * Coverage is thinner than for grids, so null is common and expected. The
   * caller falls back to the metadata provider's wide image.
   */
  findHero(name, values) {
    return findArt('heroes', HERO_DIMENSIONS, name, values)
  }
}

/**
 * Resolves a name to a SteamGridDB game id, then returns the first usable image
 * of the requested kind.
 *
 * Shared by findCover and findHero because the id lookup is identical and
 * duplicating it would mean two places to keep the failure handling consistent.
 * Each call still pays for its own resolution: caching it across the two would
 * save one request per apply while adding a cache to invalidate, and apply is
 * not a hot path.
 */
async function findArt(
  kind: 'grids' | 'heroes',
  dimensions: string,
  name: string,
  values: Record<string, string>
): Promise<string | null> {
  try {
    await throttle()
    const search = await getJson(
      `${API_BASE}/search/autocomplete/${encodeURIComponent(name)}`,
      { headers: authHeaders(values) },
      NAME
    )
    if (search.status !== 200 || search.body === null) return null

    const data = (search.body as { data?: unknown }).data
    if (!Array.isArray(data) || data.length === 0) return null

    const gameId = (data[0] as { id?: unknown }).id
    if (typeof gameId !== 'number' && typeof gameId !== 'string') return null

    await throttle()
    const art = await getJson(
      `${API_BASE}/${kind}/game/${encodeURIComponent(String(gameId))}?dimensions=${dimensions}&types=static`,
      { headers: authHeaders(values) },
      NAME
    )
    if (art.status !== 200 || art.body === null) return null

    return firstUrl(art.body)
  } catch {
    return null
  }
}
