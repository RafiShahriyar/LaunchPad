import type { Game, GameMetadataPatch, GameUpdate, MetadataSource, NewGame } from '@shared/types'
import { getDb, transaction } from '../client'
import {
  bindNullable,
  readEnumOrNull,
  readNumber,
  readNumberOrNull,
  readString,
  readStringOrNull,
  toNumber,
  type SqlRow
} from '../row'

const COLUMNS = `
  id, name, executable_path, working_directory, launch_args, save_folder_path,
  cover_image_path, hero_image_path, genres, summary, release_date, metadata_source,
  metadata_id, metadata_updated_at, total_playtime_seconds, last_played_at, created_at,
  updated_at
`

/**
 * Declared as a Record keyed by the union rather than an array literal.
 *
 * An array typed `readonly MetadataSource[]` accepts a SHORT list happily, so
 * adding a provider and forgetting this line compiles and then fails at runtime
 * with "rawg is not one of igdb" the first time anyone applies metadata from it.
 * That was a real bug. A Record forces every member to be present, so the
 * omission is a compile error instead.
 */
const METADATA_SOURCE_KEYS: Record<MetadataSource, true> = { igdb: true, rawg: true }
const METADATA_SOURCES = Object.keys(METADATA_SOURCE_KEYS) as readonly MetadataSource[]

/**
 * Genres are stored as a JSON array in one TEXT column.
 *
 * A value that will not parse, or that parses to something other than an array
 * of strings, is reported as null — "we do not know" — rather than as an empty
 * list. An empty list is a positive claim that the provider listed no genres,
 * and a corrupt column is not evidence for that claim.
 */
function parseGenres(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    if (!parsed.every((entry) => typeof entry === 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

function mapGame(row: SqlRow): Game {
  return {
    id: readNumber(row, 'id'),
    name: readString(row, 'name'),
    executablePath: readString(row, 'executable_path'),
    workingDirectory: readStringOrNull(row, 'working_directory'),
    launchArgs: readStringOrNull(row, 'launch_args'),
    saveFolderPath: readStringOrNull(row, 'save_folder_path'),
    coverImagePath: readStringOrNull(row, 'cover_image_path'),
    heroImagePath: readStringOrNull(row, 'hero_image_path'),
    genres: parseGenres(readStringOrNull(row, 'genres')),
    summary: readStringOrNull(row, 'summary'),
    releaseDate: readStringOrNull(row, 'release_date'),
    metadataSource: readEnumOrNull(row, 'metadata_source', METADATA_SOURCES),
    metadataId: readStringOrNull(row, 'metadata_id'),
    metadataUpdatedAt: readStringOrNull(row, 'metadata_updated_at'),
    totalPlaytimeSeconds: readNumber(row, 'total_playtime_seconds'),
    lastPlayedAt: readStringOrNull(row, 'last_played_at'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at')
  }
}

export function listGames(): Game[] {
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM games ORDER BY name COLLATE NOCASE`).all()
  return rows.map(mapGame)
}

export function getGame(id: number): Game | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM games WHERE id = ?`).get(id)
  return row ? mapGame(row) : null
}

export function createGame(input: NewGame, now: string): Game {
  const result = getDb()
    .prepare(
      `INSERT INTO games (
         name, executable_path, working_directory, launch_args,
         save_folder_path, cover_image_path, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.executablePath,
      bindNullable(input.workingDirectory),
      bindNullable(input.launchArgs),
      bindNullable(input.saveFolderPath),
      bindNullable(input.coverImagePath),
      now,
      now
    )

  const created = getGame(toNumber(result.lastInsertRowid))
  if (!created) throw new Error('Game insert succeeded but the row could not be read back')
  return created
}

/**
 * Updates only the keys present on `patch`.
 *
 * The SET clause is built dynamically so that omitting a field leaves it alone,
 * rather than the caller having to read the row, spread it and write it back --
 * which would clobber concurrent changes to fields they never intended to touch.
 * Column names come from a fixed internal map, never from caller input, so the
 * assembled SQL cannot be influenced from outside.
 */
const UPDATABLE_COLUMNS: Record<keyof GameUpdate, string> = {
  name: 'name',
  executablePath: 'executable_path',
  workingDirectory: 'working_directory',
  launchArgs: 'launch_args',
  saveFolderPath: 'save_folder_path',
  coverImagePath: 'cover_image_path'
}

export function updateGame(id: number, patch: GameUpdate, now: string): Game {
  const assignments: string[] = []
  const values: (string | number | null)[] = []

  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
    const value = patch[key as keyof GameUpdate]
    if (value === undefined) continue
    assignments.push(`${column} = ?`)
    values.push(bindNullable(value) as string | number | null)
  }

  if (assignments.length === 0) {
    const unchanged = getGame(id)
    if (!unchanged) throw new Error(`Game ${id} not found`)
    return unchanged
  }

  assignments.push('updated_at = ?')
  values.push(now)

  const result = getDb()
    .prepare(`UPDATE games SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id)

  if (toNumber(result.changes) === 0) throw new Error(`Game ${id} not found`)

  const updated = getGame(id)
  if (!updated) throw new Error(`Game ${id} not found after update`)
  return updated
}

/**
 * Writes the provider-supplied fields as a single unit.
 *
 * Separate from updateGame for the same reason GameMetadataPatch is separate
 * from GameUpdate: these columns carry a provenance (source, provider id,
 * fetched-at) that only the metadata flow may set. Writing them together also
 * keeps the row internally consistent — a summary from one provider sitting
 * next to genres from another would be a claim the schema could not detect as
 * false.
 *
 * `genres` is always written, as `[]` when the provider listed none, because
 * that is a real answer. Only a game that was never looked up keeps NULL.
 */
export function applyMetadata(id: number, patch: GameMetadataPatch, now: string): Game {
  const result = getDb()
    .prepare(
      `UPDATE games
          SET genres              = ?,
              summary             = ?,
              release_date        = ?,
              metadata_source     = ?,
              metadata_id         = ?,
              metadata_updated_at = ?,
              updated_at          = ?
        WHERE id = ?`
    )
    .run(
      JSON.stringify(patch.genres),
      bindNullable(patch.summary),
      bindNullable(patch.releaseDate),
      patch.metadataSource,
      patch.metadataId,
      now,
      now,
      id
    )

  if (toNumber(result.changes) === 0) throw new Error(`Game ${id} not found`)

  const updated = getGame(id)
  if (!updated) throw new Error(`Game ${id} not found after metadata update`)
  return updated
}

/**
 * Points a game at its wide backdrop art, or clears it with null.
 *
 * Its own function rather than a member of GameUpdate, because GameUpdate models
 * what a *user* authors and there is no picker for a hero image — it arrives
 * only from a provider. Adding it to NewGame would widen the games:create and
 * games:update IPC surface for a field nothing can currently send.
 *
 * Separate from applyMetadata for the opposite reason to genres: the hero is
 * downloaded after the text fields are already committed, so folding it in
 * would mean either delaying the metadata write behind a network round trip or
 * writing the same row twice anyway.
 */
export function setHeroImagePath(id: number, heroImagePath: string | null, now: string): Game {
  const result = getDb()
    .prepare('UPDATE games SET hero_image_path = ?, updated_at = ? WHERE id = ?')
    .run(bindNullable(heroImagePath), now, id)

  if (toNumber(result.changes) === 0) throw new Error(`Game ${id} not found`)

  const updated = getGame(id)
  if (!updated) throw new Error(`Game ${id} not found after hero image update`)
  return updated
}

/**
 * Deletes the game row. Sessions and backup ROWS cascade automatically.
 *
 * Backup FOLDERS on disk are deliberately not touched here -- the data layer
 * does not delete user files. The caller decides that, so that removing a game
 * from the library cannot silently destroy the saves the app exists to protect.
 * Returns the backup paths so the caller can offer to clean them up.
 */
export function deleteGame(id: number): { deleted: boolean; orphanedBackupPaths: string[] } {
  return transaction(() => {
    const db = getDb()
    const paths = db
      .prepare('SELECT backup_path FROM save_backups WHERE game_id = ?')
      .all(id)
      .map((row) => readString(row, 'backup_path'))

    const result = db.prepare('DELETE FROM games WHERE id = ?').run(id)
    return { deleted: toNumber(result.changes) > 0, orphanedBackupPaths: paths }
  })
}

/**
 * Applies a finished session to the game's denormalised roll-up.
 *
 * Kept here rather than in the sessions repository because it writes the games
 * table. Callers run it inside the same transaction that closes the session, so
 * the roll-up can never drift from the session rows by a partial write.
 */
export function applyFinishedSession(
  gameId: number,
  durationSeconds: number,
  endedAt: string
): void {
  const result = getDb()
    .prepare(
      `UPDATE games
          SET total_playtime_seconds = total_playtime_seconds + ?,
              last_played_at         = ?,
              updated_at             = ?
        WHERE id = ?`
    )
    .run(durationSeconds, endedAt, endedAt, gameId)

  if (toNumber(result.changes) === 0) throw new Error(`Game ${gameId} not found`)
}

/**
 * Repair function for the denormalised roll-up: recomputes it from the session
 * rows, which are the source of truth. Exists because `total_playtime_seconds`
 * is duplicated state (see docs/DATA_MODEL.md) and any duplicated state needs a
 * way back to consistency after a crash mid-transaction or a manual DB edit.
 */
export function recalculatePlaytime(gameId: number): number {
  return transaction(() => {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(duration_seconds), 0) AS total,
                MAX(ended_at)                      AS last_played
           FROM play_sessions
          WHERE game_id = ? AND ended_at IS NOT NULL`
      )
      .get(gameId)

    if (!row) throw new Error(`Game ${gameId} not found`)

    const total = readNumber(row, 'total')
    const lastPlayed = readStringOrNull(row, 'last_played')

    db.prepare('UPDATE games SET total_playtime_seconds = ?, last_played_at = ? WHERE id = ?').run(
      total,
      lastPlayed,
      gameId
    )
    return total
  })
}

/** Used by the library grid to show playtime without an aggregate per card. */
export function countGames(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM games').get()
  return row ? readNumberOrNull(row, 'c') ?? 0 : 0
}
