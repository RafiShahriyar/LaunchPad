import type { PlaySession, SessionExitReason } from '@shared/types'
import { getDb, transaction } from '../client'
import {
  readEnumOrNull,
  readNumber,
  readNumberOrNull,
  readString,
  readStringOrNull,
  toNumber,
  type SqlRow
} from '../row'
import { applyFinishedSession } from './games'

const EXIT_REASONS: readonly SessionExitReason[] = ['exited', 'crashed', 'app_closed', 'unknown']

const COLUMNS = 'id, game_id, started_at, ended_at, duration_seconds, exit_reason'

function mapSession(row: SqlRow): PlaySession {
  return {
    id: readNumber(row, 'id'),
    gameId: readNumber(row, 'game_id'),
    startedAt: readString(row, 'started_at'),
    endedAt: readStringOrNull(row, 'ended_at'),
    durationSeconds: readNumberOrNull(row, 'duration_seconds'),
    exitReason: readEnumOrNull(row, 'exit_reason', EXIT_REASONS)
  }
}

/**
 * Opens a session row at launch, before the game process is even confirmed
 * running.
 *
 * Writing at launch rather than at exit is what makes crash recovery possible:
 * if LaunchPad is killed while a game runs, the row survives with
 * `ended_at IS NULL` and startup reconciliation can close it. A row written
 * only at exit would lose the session entirely.
 */
export function startSession(gameId: number, startedAt: string): PlaySession {
  const result = getDb()
    .prepare('INSERT INTO play_sessions (game_id, started_at) VALUES (?, ?)')
    .run(gameId, startedAt)

  const session = getSession(toNumber(result.lastInsertRowid))
  if (!session) throw new Error('Session insert succeeded but the row could not be read back')
  return session
}

export function getSession(id: number): PlaySession | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM play_sessions WHERE id = ?`).get(id)
  return row ? mapSession(row) : null
}

/**
 * Closes a session and folds its duration into the game's roll-up.
 *
 * Both writes happen in one transaction: a crash between them would otherwise
 * leave a closed session whose hours were never counted, or counted twice on
 * retry.
 */
export function endSession(
  id: number,
  endedAt: string,
  durationSeconds: number,
  exitReason: SessionExitReason
): PlaySession {
  return transaction(() => {
    const db = getDb()

    const existing = getSession(id)
    if (!existing) throw new Error(`Session ${id} not found`)
    if (existing.endedAt !== null) throw new Error(`Session ${id} is already closed`)

    db.prepare(
      `UPDATE play_sessions
          SET ended_at = ?, duration_seconds = ?, exit_reason = ?
        WHERE id = ?`
    ).run(endedAt, durationSeconds, exitReason, id)

    applyFinishedSession(existing.gameId, durationSeconds, endedAt)

    const closed = getSession(id)
    if (!closed) throw new Error(`Session ${id} vanished during close`)
    return closed
  })
}

/**
 * Discards a session without counting it -- used for sessions shorter than
 * `minSessionSeconds` (misclicks, launcher handoffs, failed starts).
 *
 * Deleting rather than closing with a zero duration keeps the session history
 * meaningful: a list padded with 3-second entries makes the real ones harder
 * to read, and the aggregate is unaffected either way.
 */
export function discardSession(id: number): void {
  getDb().prepare('DELETE FROM play_sessions WHERE id = ?').run(id)
}

export function listSessionsForGame(gameId: number, limit = 100): PlaySession[] {
  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM play_sessions
        WHERE game_id = ?
        ORDER BY started_at DESC
        LIMIT ?`
    )
    .all(gameId, limit)
  return rows.map(mapSession)
}

/** Sessions still marked open. Normally empty; non-empty means an unclean exit. */
export function findOpenSessions(): PlaySession[] {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM play_sessions WHERE ended_at IS NULL ORDER BY started_at`)
    .all()
  return rows.map(mapSession)
}

/**
 * Startup reconciliation for sessions orphaned by an app crash or a machine
 * shutdown mid-game.
 *
 * The honest thing to do with an orphan is NOT to guess how long it ran. The
 * app was not alive to observe the exit, so any duration would be invented.
 * Each orphan is closed at its own start time with duration 0 and reason
 * `app_closed`, which records that the session happened and that its length is
 * unknown, without inflating playtime. Because duration is 0, the game roll-up
 * needs no adjustment.
 */
export function reconcileOpenSessions(): number {
  return transaction(() => {
    const orphans = findOpenSessions()
    if (orphans.length === 0) return 0

    const stmt = getDb().prepare(
      `UPDATE play_sessions
          SET ended_at = started_at, duration_seconds = 0, exit_reason = 'app_closed'
        WHERE id = ?`
    )
    for (const session of orphans) stmt.run(session.id)
    return orphans.length
  })
}

export interface GameSessionStats {
  sessionCount: number
  totalSeconds: number
  longestSeconds: number
  averageSeconds: number
  firstPlayedAt: string | null
  lastPlayedAt: string | null
}

/** Aggregates for the per-game detail view, computed in SQL rather than in JS. */
export function getSessionStats(gameId: number): GameSessionStats {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*)                              AS session_count,
              COALESCE(SUM(duration_seconds), 0)    AS total_seconds,
              COALESCE(MAX(duration_seconds), 0)    AS longest_seconds,
              MIN(started_at)                       AS first_played,
              MAX(ended_at)                         AS last_played
         FROM play_sessions
        WHERE game_id = ? AND ended_at IS NOT NULL`
    )
    .get(gameId)

  if (!row) {
    return {
      sessionCount: 0,
      totalSeconds: 0,
      longestSeconds: 0,
      averageSeconds: 0,
      firstPlayedAt: null,
      lastPlayedAt: null
    }
  }

  const sessionCount = readNumber(row, 'session_count')
  const totalSeconds = readNumber(row, 'total_seconds')

  return {
    sessionCount,
    totalSeconds,
    longestSeconds: readNumber(row, 'longest_seconds'),
    averageSeconds: sessionCount === 0 ? 0 : Math.round(totalSeconds / sessionCount),
    firstPlayedAt: readStringOrNull(row, 'first_played'),
    lastPlayedAt: readStringOrNull(row, 'last_played')
  }
}
