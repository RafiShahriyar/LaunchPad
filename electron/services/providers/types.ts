import type { CachedToken } from '@db/index'
import type { MetadataSearchResult, ProviderDescriptor } from '@shared/ipc'

/**
 * The shape every provider implements.
 *
 * Adding a provider means writing one of these and adding a union member to
 * `MetadataSource` (or `CoverArtSource`). Nothing above this line — the IPC
 * contract, the repository, the database columns, the settings screen — knows
 * which provider is in use. That containment is deliberate: catalogue APIs have
 * a history of changing terms, and swapping one should not be a rewrite.
 */
export interface ProviderClient {
  descriptor: ProviderDescriptor
  /**
   * The credential field shown (masked) in settings, so the user can tell which
   * key is configured without it being readable.
   */
  identityField: string
  /**
   * Checks the credentials against the live service.
   *
   * Throws with a user-facing message when they are wrong. Called BEFORE the
   * values are stored, so a bad key fails at the action that caused it rather
   * than later as a search that merely looks broken.
   *
   * Returns a token when the check produced one worth keeping. It must be
   * RETURNED rather than cached here: storing new credentials deliberately
   * clears any cached token (an old token cannot authenticate new credentials),
   * so a token written during verification would be wiped moments later. The
   * caller persists it after the credentials land.
   */
  verify(values: Record<string, string>): Promise<CachedToken | void>
}

export interface MetadataProviderClient extends ProviderClient {
  role: 'metadata'
  search(query: string, values: Record<string, string>): Promise<MetadataSearchResult[]>
  /**
   * Optionally fetches fields too expensive to include in a search.
   *
   * RAWG does not return descriptions in its list endpoint, and fetching one per
   * row would turn a single search into thirteen requests against a monthly
   * quota. Instead the description is fetched once, for the entry the user
   * actually chose, at apply time.
   */
  enrich?(
    result: MetadataSearchResult,
    values: Record<string, string>
  ): Promise<MetadataSearchResult>
}

export interface ArtProviderClient extends ProviderClient {
  role: 'art'
  /**
   * Finds portrait box art for a game name.
   *
   * Returns null when nothing matches, which is an ordinary outcome: the caller
   * falls back to whatever image the metadata provider supplied.
   */
  findCover(name: string, values: Record<string, string>): Promise<string | null>
  /**
   * Finds wide key art for the detail page's backdrop.
   *
   * Optional, because "supplies art" does not imply "supplies both shapes" —
   * a provider with only box art is still a useful art provider, and forcing it
   * to return null from a required method would say nothing the absence does
   * not already say.
   *
   * Same contract as findCover: null is an ordinary outcome, never an error.
   * The caller falls back to the metadata provider's own wide image, and the
   * page falls back to the cover after that.
   */
  findHero?(name: string, values: Record<string, string>): Promise<string | null>
}
