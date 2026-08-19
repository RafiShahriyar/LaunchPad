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
  async findCover(name, values) {
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
      const grids = await getJson(
        `${API_BASE}/grids/game/${encodeURIComponent(String(gameId))}?dimensions=${PORTRAIT_DIMENSIONS}&types=static`,
        { headers: authHeaders(values) },
        NAME
      )
      if (grids.status !== 200 || grids.body === null) return null

      return firstUrl(grids.body)
    } catch {
      return null
    }
  }
}
