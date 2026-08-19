import type { BackupTrigger, NewSaveBackup, SaveBackup } from '@shared/types'
import { getDb } from '../client'
import {
  bindBoolean,
  bindNullable,
  readBoolean,
  readEnum,
  readNumber,
  readString,
  readStringOrNull,
  toNumber,
  type SqlRow
} from '../row'

const TRIGGERS: readonly BackupTrigger[] = ['pre_launch', 'post_session', 'manual', 'pre_restore']

const COLUMNS =
  'id, game_id, backup_path, created_at, size_bytes, file_count, trigger_type, is_pinned, content_hash'

function mapBackup(row: SqlRow): SaveBackup {
  return {
    id: readNumber(row, 'id'),
    gameId: readNumber(row, 'game_id'),
    backupPath: readString(row, 'backup_path'),
    createdAt: readString(row, 'created_at'),
    sizeBytes: readNumber(row, 'size_bytes'),
    fileCount: readNumber(row, 'file_count'),
    trigger: readEnum(row, 'trigger_type', TRIGGERS),
    isPinned: readBoolean(row, 'is_pinned'),
    contentHash: readStringOrNull(row, 'content_hash')
  }
}

/**
 * Records a snapshot that has ALREADY been written to disk.
 *
 * The row is written after the copy succeeds, never before: a row pointing at a
 * folder that does not exist would show up in the restore UI as a selectable
 * option and fail at the worst possible moment. A folder with no row is merely
 * orphaned disk space, which is recoverable.
 */
export function createBackup(input: NewSaveBackup): SaveBackup {
  const result = getDb()
    .prepare(
      `INSERT INTO save_backups (
         game_id, backup_path, created_at, size_bytes, file_count,
         trigger_type, is_pinned, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.gameId,
      input.backupPath,
      input.createdAt,
      input.sizeBytes,
      input.fileCount,
      input.trigger,
      bindBoolean(input.isPinned ?? false),
      bindNullable(input.contentHash)
    )

  const created = getBackup(toNumber(result.lastInsertRowid))
  if (!created) throw new Error('Backup insert succeeded but the row could not be read back')
  return created
}

export function getBackup(id: number): SaveBackup | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM save_backups WHERE id = ?`).get(id)
  return row ? mapBackup(row) : null
}

/**
 * Most recent snapshot for a game, or null. Used by the deduplication check:
 * if its fingerprint matches the save folder's current state, there is nothing
 * new to capture.
 */
export function getLatestBackup(gameId: number): SaveBackup | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM save_backups
        WHERE game_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .get(gameId)
  return row ? mapBackup(row) : null
}

export function listBackupsForGame(gameId: number): SaveBackup[] {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM save_backups WHERE game_id = ? ORDER BY created_at DESC`)
    .all(gameId)
  return rows.map(mapBackup)
}

export function setBackupPinned(id: number, isPinned: boolean): SaveBackup {
  const result = getDb()
    .prepare('UPDATE save_backups SET is_pinned = ? WHERE id = ?')
    .run(bindBoolean(isPinned), id)

  if (toNumber(result.changes) === 0) throw new Error(`Backup ${id} not found`)

  const updated = getBackup(id)
  if (!updated) throw new Error(`Backup ${id} not found after update`)
  return updated
}

/** Removes the row only. Deleting the folder is the caller's job. */
export function deleteBackupRow(id: number): boolean {
  return toNumber(getDb().prepare('DELETE FROM save_backups WHERE id = ?').run(id).changes) > 0
}

/**
 * Returns snapshots that rotation should delete, oldest first.
 *
 * The policy, and why:
 *
 *   - **Pinned snapshots are excluded entirely** and do not count toward the
 *     limit. Pinning exists precisely to protect a known-good save from being
 *     rotated away by routine launches; if pinned rows consumed quota, enough
 *     pins would silently stop new backups from being retained at all.
 *   - **Newest `keep` unpinned snapshots are retained**, the rest are returned.
 *     Recency beats any cleverer heuristic here: the most recent save is nearly
 *     always the one worth restoring.
 *   - Ordering is by `created_at DESC, id DESC`. The id tiebreak matters because
 *     a pre-launch and a post-session backup can land in the same second, and
 *     without it the LIMIT/OFFSET window would be non-deterministic.
 *
 * Returning rows instead of deleting them keeps this pure: the caller deletes
 * the folders first, then removes the rows, so a failed folder delete never
 * leaves a row pointing at nothing.
 */
export function findRotationCandidates(gameId: number, keep: number): SaveBackup[] {
  if (keep < 0) throw new Error('keep must be >= 0')

  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM save_backups
        WHERE game_id = ? AND is_pinned = 0
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?`
    )
    .all(gameId, keep)

  // SQLite requires a LIMIT before OFFSET; -1 means "no limit".
  return rows.map(mapBackup).reverse() // oldest first, so deletion order reads naturally
}

export interface BackupUsage {
  backupCount: number
  totalSizeBytes: number
}

/** Powers the "backups are using N MB" line in the settings/detail views. */
export function getBackupUsage(gameId?: number): BackupUsage {
  const db = getDb()
  const row =
    gameId === undefined
      ? db
          .prepare(
            'SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS total FROM save_backups'
          )
          .get()
      : db
          .prepare(
            'SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS total FROM save_backups WHERE game_id = ?'
          )
          .get(gameId)

  if (!row) return { backupCount: 0, totalSizeBytes: 0 }
  return { backupCount: readNumber(row, 'c'), totalSizeBytes: readNumber(row, 'total') }
}
