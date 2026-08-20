import { credentialsRepo } from '@db/index'
import type {
  MetadataSearchResult,
  MetadataStatus,
  ProviderCredentialStatus,
  ProviderDescriptor
} from '@shared/ipc'
import type { CredentialProvider, MetadataSource } from '@shared/types'
import { igdb } from './providers/igdb'
import { rawg } from './providers/rawg'
import { steamGridDb } from './providers/steamgriddb'
import type { ArtProviderClient, MetadataProviderClient, ProviderClient } from './providers/types'

/**
 * Provider registry and dispatch.
 *
 * Everything above this file — the IPC handlers, the repository, the database
 * columns, the settings screen — is provider-agnostic. Adding a provider means
 * writing one client, adding it here, and adding a union member to
 * `MetadataSource` or `CoverArtSource`. That containment is deliberate:
 * catalogue APIs have a history of changing their terms, and swapping one
 * should not be a rewrite.
 */

const METADATA_PROVIDERS: MetadataProviderClient[] = [igdb, rawg]
const ART_PROVIDERS: ArtProviderClient[] = [steamGridDb]

/**
 * Search order when more than one metadata provider is configured.
 *
 * IGDB first because it returns portrait box art and a summary from the same
 * query, so it needs no art provider and no second request to be complete. The
 * settings screen reports which one is actually in use rather than leaving the
 * user to infer it.
 */
const SEARCH_PRIORITY: MetadataSource[] = ['igdb', 'rawg']

const ALL: ProviderClient[] = [...METADATA_PROVIDERS, ...ART_PROVIDERS]

export class MetadataNotConfiguredError extends Error {
  constructor() {
    super(
      'No metadata provider is configured. Add credentials in Settings, under Game metadata.'
    )
    this.name = 'MetadataNotConfiguredError'
  }
}

export function findProvider(id: string): ProviderClient | null {
  return ALL.find((provider) => provider.descriptor.id === id) ?? null
}

function fieldKeys(provider: ProviderClient): string[] {
  return provider.descriptor.fields.map((field) => field.key)
}

function storedValues(provider: ProviderClient): Record<string, string> | null {
  return credentialsRepo.getCredentials(provider.descriptor.id, fieldKeys(provider))
}

/**
 * Shows enough of an identifier to recognise which key is configured, without
 * reproducing it. Secrets are never returned in any form.
 */
function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function credentialStatus(provider: ProviderClient): ProviderCredentialStatus {
  const values = storedValues(provider)
  const identity = values?.[provider.identityField] ?? null
  return {
    provider: provider.descriptor.id,
    configured: values !== null,
    maskedKey: identity === null ? null : mask(identity),
    hasCachedToken: credentialsRepo.getCachedToken(provider.descriptor.id) !== null
  }
}

/** The metadata provider a search will use, or null when none is configured. */
function activeMetadataProvider(): MetadataProviderClient | null {
  for (const id of SEARCH_PRIORITY) {
    const provider = METADATA_PROVIDERS.find((candidate) => candidate.descriptor.id === id)
    if (provider && storedValues(provider) !== null) return provider
  }
  return null
}

function activeArtProvider(): ArtProviderClient | null {
  return ART_PROVIDERS.find((provider) => storedValues(provider) !== null) ?? null
}

export function getStatus(): MetadataStatus {
  const active = activeMetadataProvider()
  return {
    providers: ALL.map((provider): ProviderDescriptor => provider.descriptor),
    credentials: ALL.map(credentialStatus),
    activeSource: active ? (active.descriptor.id as MetadataSource) : null,
    artConfigured: activeArtProvider() !== null
  }
}

/** Verifies against the live service BEFORE storing, then persists. */
export async function saveCredentials(
  id: CredentialProvider,
  values: Record<string, string>
): Promise<void> {
  const provider = findProvider(id)
  if (!provider) throw new Error(`Unknown provider: ${id}`)

  const token = await provider.verify(values)
  credentialsRepo.setCredentials(id, values)
  // Written after the credentials, which clear any previous token as they land.
  if (token) credentialsRepo.setCachedToken(id, token)
}

export function removeCredentials(id: CredentialProvider): void {
  const provider = findProvider(id)
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  credentialsRepo.clearCredentials(id, fieldKeys(provider))
}

export async function searchGames(
  query: string
): Promise<{ results: MetadataSearchResult[]; source: MetadataSource }> {
  const provider = activeMetadataProvider()
  if (!provider) throw new MetadataNotConfiguredError()

  const values = storedValues(provider)
  if (!values) throw new MetadataNotConfiguredError()

  return {
    results: await provider.search(query, values),
    source: provider.descriptor.id as MetadataSource
  }
}

/**
 * Fills in fields a provider omits from its list endpoint.
 *
 * Returns the result unchanged when there is nothing to add or the provider is
 * no longer configured — enrichment is an improvement, never a precondition.
 */
export async function enrichResult(
  source: MetadataSource,
  result: MetadataSearchResult
): Promise<MetadataSearchResult> {
  const provider = METADATA_PROVIDERS.find((candidate) => candidate.descriptor.id === source)
  if (!provider?.enrich) return result

  const values = storedValues(provider)
  if (!values) return result

  return provider.enrich(result, values)
}

/**
 * Picks the cover to download for a game about to be applied.
 *
 * Prefers portrait box art from an art provider, because the library grid draws
 * 3:4 cards and a landscape screenshot cropped to that shape keeps only a
 * middle sliver. Falls back to whatever the metadata provider supplied, and
 * finally to nothing at all.
 *
 * Only ever called for the single game being applied, never for a page of
 * search results: twelve results would be twenty-four extra requests for
 * artwork the user is about to discard eleven twelfths of.
 */
export async function resolveCoverUrl(result: MetadataSearchResult): Promise<string | null> {
  const artProvider = activeArtProvider()
  if (artProvider) {
    const values = storedValues(artProvider)
    if (values) {
      const portrait = await artProvider.findCover(result.name, values)
      if (portrait) return portrait
    }
  }
  return result.coverUrl
}

/**
 * Picks the wide backdrop art to download, mirroring resolveCoverUrl.
 *
 * The preference order is the same and for the same reason: an art provider's
 * hero is composed as a banner, with the subject off-centre and room for a
 * title, while a metadata provider's wide image is a screenshot or a piece of
 * concept art that merely happens to be landscape.
 *
 * Returning null is ordinary, not a failure. Hero coverage is thinner than box
 * art even on SteamGridDB, and the detail page has a defined answer for a game
 * with none.
 */
export async function resolveHeroUrl(result: MetadataSearchResult): Promise<string | null> {
  const artProvider = activeArtProvider()
  if (artProvider?.findHero) {
    const values = storedValues(artProvider)
    if (values) {
      const wide = await artProvider.findHero(result.name, values)
      if (wide) return wide
    }
  }
  return result.heroUrl
}
