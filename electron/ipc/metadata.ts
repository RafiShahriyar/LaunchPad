import { rmSync } from 'node:fs'
import {
  Channels,
  type MetadataApplyOptions,
  type MetadataApplyResult,
  type MetadataSearchResponse,
  type MetadataSearchResult,
  type MetadataStatus
} from '@shared/ipc'
import type { CredentialProvider, Game, MetadataSource } from '@shared/types'
import { gamesRepo } from '@db/index'
import { importCoverFromUrl } from '../services/covers'
import {
  enrichResult,
  findProvider,
  getStatus,
  removeCredentials,
  resolveCoverUrl,
  resolveHeroUrl,
  saveCredentials,
  searchGames
} from '../services/metadata'
import { handle, requireId } from './handle'

const MAX_NAME_LENGTH = 200
const MAX_QUERY_LENGTH = 100
const MAX_SUMMARY_LENGTH = 5000
const MAX_GENRES = 20

/** Record-keyed so adding a MetadataSource cannot silently skip this list. */
const METADATA_SOURCE_KEYS: Record<MetadataSource, true> = { igdb: true, rawg: true }
const METADATA_SOURCES = Object.keys(METADATA_SOURCE_KEYS) as readonly MetadataSource[]

const nowIso = (): string => new Date().toISOString()

/**
 * Everything arriving from the renderer is validated here, even though the IPC
 * contract types it.
 *
 * Types are erased at runtime and the renderer is the untrusted side of the
 * boundary. A search result in particular does a round trip -- main returns it,
 * the renderer holds it, the renderer sends it back to be applied -- so by the
 * time it comes back it is renderer-supplied data, not something main can
 * assume it produced itself.
 */
function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${label} cannot be empty`)
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long (max ${maxLength} characters)`)
  }
  return trimmed
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${label} must be text or null`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, maxLength)
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

/** YYYY-MM-DD only. A partial or reordered date would render as nonsense. */
function optionalReleaseDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Release date must be text or null')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Release date must look like YYYY-MM-DD, got "${value}"`)
  }
  return value
}

function requireGenres(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Genres must be a list')
  if (value.length > MAX_GENRES) throw new Error(`Too many genres (max ${MAX_GENRES})`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`Genre ${index + 1} must be text`)
    const trimmed = entry.trim()
    if (trimmed.length === 0) throw new Error(`Genre ${index + 1} cannot be empty`)
    return trimmed.slice(0, 60)
  })
}

function requireSource(value: unknown): MetadataSource {
  if (typeof value !== 'string' || !(METADATA_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`Unknown metadata source: ${JSON.stringify(value)}`)
  }
  return value as MetadataSource
}

function validateSearchResult(raw: unknown): MetadataSearchResult {
  if (!raw || typeof raw !== 'object') throw new Error('No metadata entry was supplied')
  const value = raw as Record<string, unknown>

  const coverUrl = optionalString(value.coverUrl, 'Cover URL', 2000)
  if (coverUrl !== null && !/^https?:\/\//i.test(coverUrl)) {
    throw new Error('Cover URL must be an http(s) URL')
  }

  /*
   * Checked the same way as the cover, and for the same reason: this value
   * makes the round trip through the renderer, so on the way back it is
   * attacker-controlled input rather than something a provider said. The
   * scheme check here is the cheap first gate; importCoverFromUrl still
   * re-validates the protocol, the declared content type, the byte length and
   * the leading magic bytes before anything reaches disk.
   */
  const heroUrl = optionalString(value.heroUrl, 'Hero URL', 2000)
  if (heroUrl !== null && !/^https?:\/\//i.test(heroUrl)) {
    throw new Error('Hero URL must be an http(s) URL')
  }

  return {
    id: requireString(value.id, 'Metadata id', 64),
    source: requireSource(value.source),
    name: requireString(value.name, 'Game name', MAX_NAME_LENGTH),
    releaseDate: optionalReleaseDate(value.releaseDate),
    genres: requireGenres(value.genres),
    summary: optionalString(value.summary, 'Summary', MAX_SUMMARY_LENGTH),
    coverUrl,
    heroUrl,
    /*
     * Discarded rather than validated. The thumbnail exists only so the picker
     * can show art while choosing; applying re-resolves the full-size cover.
     * Accepting a renderer-supplied data URI here would mean trusting bytes
     * back from the untrusted side for no gain.
     */
    thumbnailDataUri: null
  }
}

function validateApplyOptions(raw: unknown): MetadataApplyOptions {
  if (!raw || typeof raw !== 'object') throw new Error('No apply options were supplied')
  const value = raw as Record<string, unknown>
  return {
    applyName: requireBoolean(value.applyName, 'applyName'),
    applyCover: requireBoolean(value.applyCover, 'applyCover')
  }
}

function requireProvider(raw: unknown): CredentialProvider {
  const id = requireString(raw, 'Provider', 40)
  if (!findProvider(id)) throw new Error(`Unknown provider: ${id}`)
  return id as CredentialProvider
}

/** Values are checked against the provider's own declared field list. */
function validateCredentialValues(
  provider: CredentialProvider,
  raw: unknown
): Record<string, string> {
  if (!raw || typeof raw !== 'object') throw new Error('No credentials were supplied')
  const client = findProvider(provider)
  if (!client) throw new Error(`Unknown provider: ${provider}`)

  const supplied = raw as Record<string, unknown>
  const values: Record<string, string> = {}
  for (const field of client.descriptor.fields) {
    values[field.key] = requireString(supplied[field.key], field.label, 200)
  }
  return values
}

export function registerMetadataHandlers(): void {
  handle(Channels.metadata.getStatus, (): MetadataStatus => getStatus())

  /**
   * Credentials are verified against the provider BEFORE they are stored.
   *
   * Storing first and validating later would leave the user with a settings
   * screen that says "configured" and a search box that fails, with nothing
   * connecting the two. Failing here attaches the error to the action that
   * caused it.
   */
  handle(
    Channels.metadata.setCredentials,
    async (rawProvider: unknown, rawValues: unknown): Promise<MetadataStatus> => {
      const provider = requireProvider(rawProvider)
      await saveCredentials(provider, validateCredentialValues(provider, rawValues))
      return getStatus()
    }
  )

  handle(Channels.metadata.clearCredentials, (rawProvider: unknown): MetadataStatus => {
    removeCredentials(requireProvider(rawProvider))
    return getStatus()
  })

  handle(Channels.metadata.search, async (rawQuery: unknown): Promise<MetadataSearchResponse> => {
    const query = requireString(rawQuery, 'Search text', MAX_QUERY_LENGTH)
    const { results, source } = await searchGames(query)
    return { query, source, results }
  })

  /**
   * Applies a chosen entry to a game.
   *
   * Ordering is deliberate: the local writes (name, genres, summary, release
   * date) happen first, and the cover -- the only step that must reach the
   * network -- happens last. A failed download therefore leaves the text fields
   * applied and reports `coverError`, rather than discarding work that
   * succeeded. That is why MetadataApplyResult carries an error field instead of
   * this handler throwing.
   */
  handle(
    Channels.metadata.apply,
    async (
      rawId: unknown,
      rawResult: unknown,
      rawOptions: unknown
    ): Promise<MetadataApplyResult> => {
      const gameId = requireId(rawId, 'game id')
      const validated = validateSearchResult(rawResult)
      const options = validateApplyOptions(rawOptions)

      const existing = gamesRepo.getGame(gameId)
      if (!existing) throw new Error(`Game ${gameId} not found`)

      /*
       * Some providers omit expensive fields from their list endpoint -- RAWG
       * carries no description there. Fetching it now, for the one entry the
       * user actually chose, costs a single request instead of one per row of
       * every search. A failure leaves the result untouched.
       */
      const result = await enrichResult(validated.source, validated)

      const now = nowIso()

      let game = gamesRepo.applyMetadata(
        gameId,
        {
          genres: result.genres,
          summary: result.summary,
          releaseDate: result.releaseDate,
          metadataSource: result.source,
          metadataId: result.id
        },
        now
      )

      if (options.applyName && result.name !== game.name) {
        game = gamesRepo.updateGame(gameId, { name: result.name }, now)
      }

      if (!options.applyCover) {
        return {
          game,
          coverImagePath: null,
          coverError: null,
          heroImagePath: null,
          heroError: null
        }
      }

      let coverImagePath: string | null = null
      let coverError: string | null = null
      let heroImagePath: string | null = null
      let heroError: string | null = null

      /*
       * Prefers portrait box art from an art provider over the metadata
       * provider's own image, because the grid draws 3:4 cards and a landscape
       * screenshot cropped to that shape keeps only a middle sliver.
       */
      const coverUrl = await resolveCoverUrl(result)
      if (coverUrl !== null) {
        try {
          const swapped = await swapArtwork(
            gameId,
            coverUrl,
            game.coverImagePath,
            game.heroImagePath,
            (path) => gamesRepo.updateGame(gameId, { coverImagePath: path }, nowIso())
          )
          coverImagePath = swapped.path
          game = swapped.game
        } catch (err) {
          coverError = err instanceof Error ? err.message : String(err)
        }
      }

      /*
       * The wide backdrop is downloaded independently of the cover, and its
       * failure is reported separately. They fail for different reasons and
       * cost different things: no cover leaves a blank grid card, no hero only
       * means the detail page falls back to the cover.
       */
      const wideUrl = await resolveHeroUrl(result)
      if (wideUrl !== null) {
        if (wideUrl === coverUrl && coverImagePath !== null) {
          /*
           * RAWG returns the same landscape image for both fields -- being a
           * poor 3:4 cover is precisely why it makes a good backdrop. It is
           * already downloaded, and content hashing means a second fetch would
           * spend the bandwidth only to arrive at the identical path.
           */
          try {
            game = gamesRepo.setHeroImagePath(gameId, coverImagePath, nowIso())
            heroImagePath = coverImagePath
          } catch (err) {
            heroError = err instanceof Error ? err.message : String(err)
          }
        } else {
          try {
            const swapped = await swapArtwork(
              gameId,
              wideUrl,
              game.heroImagePath,
              game.coverImagePath,
              (path) => gamesRepo.setHeroImagePath(gameId, path, nowIso())
            )
            heroImagePath = swapped.path
            game = swapped.game
          } catch (err) {
            heroError = err instanceof Error ? err.message : String(err)
          }
        }
      }

      return { game, coverImagePath, coverError, heroImagePath, heroError }
    }
  )
}

/**
 * Downloads one image, points the row at it, then removes the file it replaced.
 *
 * The order is the backup writer's rule again: the new file must be on disk AND
 * the row must already point at it before anything is deleted, so an
 * interrupted swap can only ever leave a harmless extra file, never a game
 * pointing at one that is gone.
 *
 * `keep` is the game's OTHER artwork path, and it is the whole reason this is a
 * shared helper rather than two blocks. Cover and hero can legitimately be the
 * same file — a RAWG-only setup stores one landscape image under both fields —
 * so replacing the cover would otherwise delete the file the hero still
 * references and leave the detail page pointing at nothing.
 */
async function swapArtwork(
  gameId: number,
  url: string,
  previousPath: string | null,
  keep: string | null,
  write: (path: string) => Game
): Promise<{ path: string; game: Game }> {
  const managed = await importCoverFromUrl(url, gameId)
  const game = write(managed)

  if (previousPath && previousPath !== managed && previousPath !== keep) {
    try {
      rmSync(previousPath, { force: true })
    } catch {
      // Stale image left behind; harmless.
    }
  }

  return { path: managed, game }
}
