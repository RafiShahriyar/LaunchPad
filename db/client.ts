import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSchemaVersion, runMigrations } from './schema'
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from './defaults'

/**
 * Owns the single SQLite connection.
 *
 * Note that this module imports nothing from Electron: the database path is
 * passed in by the caller. That keeps the whole data layer runnable under plain
 * Node -- which is what makes db/verify.ts able to exercise these repositories
 * against a temp file without booting an Electron window.
 */

let connection: DatabaseSync | null = null

export interface InitDatabaseOptions {
  /** Absolute path to the SQLite file. Parent directories are created. */
  dbPath: string
  /** Seeded into settings.backups_root_path on first run only. */
  defaultBackupsRoot: string
}

export interface InitDatabaseResult {
  schemaVersion: number
  migratedFrom: number
  dbPath: string
}

export function initDatabase(options: InitDatabaseOptions): InitDatabaseResult {
  if (connection) {
    return {
      schemaVersion: getSchemaVersion(connection),
      migratedFrom: getSchemaVersion(connection),
      dbPath: options.dbPath
    }
  }

  mkdirSync(dirname(options.dbPath), { recursive: true })

  const db = new DatabaseSync(options.dbPath, { enableForeignKeyConstraints: true })

  // WAL lets reads proceed while a write is in flight. This app writes at
  // session start/end while the UI is reading the library, so the default
  // rollback journal would block the UI for the duration of each write.
  db.exec('PRAGMA journal_mode = WAL')
  // NORMAL is the standard companion to WAL: it skips an fsync per commit and
  // risks losing only the most recent transactions on an OS-level crash, not
  // corruption. Losing the last few seconds of playtime is an acceptable trade.
  db.exec('PRAGMA synchronous = NORMAL')
  // Wait rather than immediately erroring if another writer holds the lock.
  db.exec('PRAGMA busy_timeout = 5000')

  connection = db

  const { from, to } = runMigrations(db)
  seedDefaultSettings(db, options.defaultBackupsRoot)

  return { schemaVersion: to, migratedFrom: from, dbPath: options.dbPath }
}

export function getDb(): DatabaseSync {
  if (!connection) {
    throw new Error('Database not initialised. initDatabase() must run before any repository call.')
  }
  return connection
}

export function closeDatabase(): void {
  if (!connection) return
  // Checkpoint the WAL into the main file so the .db is self-contained when
  // the app exits -- otherwise recent writes live only in the -wal sidecar.
  try {
    connection.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // A checkpoint failure must not block shutdown; the WAL is still replayed
    // on next open.
  }
  connection.close()
  connection = null
}

/**
 * Runs `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * node:sqlite has no equivalent of better-sqlite3's `db.transaction()`, so this
 * is hand-rolled. Nested calls use SAVEPOINTs, because SQLite rejects a second
 * BEGIN with "cannot start a transaction within a transaction" -- which would
 * otherwise make any repository method that opens a transaction unusable inside
 * a larger one (exactly what the session-end and rotation flows need).
 */
let transactionDepth = 0

export function transaction<T>(fn: () => T): T {
  const db = getDb()
  const savepoint = `sp_${transactionDepth}`
  const isOutermost = transactionDepth === 0

  db.exec(isOutermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
  transactionDepth++

  try {
    const result = fn()
    transactionDepth--
    db.exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`)
    return result
  } catch (err) {
    transactionDepth--
    try {
      db.exec(isOutermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
    } catch {
      // If the rollback itself fails the connection is in an unknown state;
      // surface the original error rather than masking it with this one.
    }
    throw err
  }
}

/**
 * Inserts any settings row that does not exist yet.
 *
 * INSERT OR IGNORE rather than upsert, so a user's edited value is never reset
 * by a later startup. New settings added in future versions get their defaults
 * here automatically on first run after the update.
 */
function seedDefaultSettings(db: DatabaseSync, defaultBackupsRoot: string): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)')

  const values: Record<keyof typeof SETTINGS_KEYS, string> = {
    backupsRootPath: defaultBackupsRoot,
    maxBackupsPerGame: String(DEFAULT_SETTINGS.maxBackupsPerGame),
    backupBeforeLaunch: String(DEFAULT_SETTINGS.backupBeforeLaunch),
    backupAfterSession: String(DEFAULT_SETTINGS.backupAfterSession),
    minSessionSeconds: String(DEFAULT_SETTINGS.minSessionSeconds),
    theme: DEFAULT_SETTINGS.theme,
    sidebarCollapsed: String(DEFAULT_SETTINGS.sidebarCollapsed)
  }

  db.exec('BEGIN')
  try {
    for (const [camelKey, sqlKey] of Object.entries(SETTINGS_KEYS)) {
      stmt.run(sqlKey, values[camelKey as keyof typeof SETTINGS_KEYS])
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
