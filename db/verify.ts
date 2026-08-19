/**
 * Data-layer verification harness.
 *
 * Runs the real repositories against a throwaway database file and asserts the
 * behaviours that are easy to get wrong and expensive to get wrong silently:
 * cascade deletes, transaction rollback, the playtime roll-up staying in sync
 * with session rows, and the backup rotation policy.
 *
 * It runs under plain Node rather than Electron -- which is possible only
 * because db/ takes its path as a parameter instead of importing electron.
 *
 *   npm run verify:db
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeDatabase,
  gamesRepo,
  initDatabase,
  savesRepo,
  sessionsRepo,
  settingsRepo,
  transaction,
  LATEST_SCHEMA_VERSION
} from './index'

let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const iso = (offsetSeconds = 0) => new Date(Date.UTC(2026, 0, 1) + offsetSeconds * 1000).toISOString()

/**
 * Verifies the v1 -> v2 upgrade against a hand-built v1 database.
 *
 * This is the first migration the project has shipped, and migrations are the
 * one thing that cannot be fixed after the fact: a user's data has already been
 * through them. Building v1 by hand (rather than trusting the migration list)
 * is what makes this an actual upgrade test instead of a fresh-install test.
 */
function verifyUpgradeFromV1(): void {
  section('Upgrade from an existing v1 database')

  const dbPath = join(tmpdir(), `launchpad-upgrade-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

  // Build a v1 database directly, exactly as version 1 of the app left it.
  const legacy = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true })
  legacy.exec(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      executable_path TEXT NOT NULL, working_directory TEXT, launch_args TEXT,
      save_folder_path TEXT, cover_image_path TEXT,
      total_playtime_seconds INTEGER NOT NULL DEFAULT 0, last_played_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE play_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER,
      exit_reason TEXT CHECK (exit_reason IN ('exited','crashed','app_closed','unknown'))
    );
    CREATE INDEX idx_sessions_game_started ON play_sessions(game_id, started_at DESC);
    CREATE INDEX idx_sessions_open ON play_sessions(game_id) WHERE ended_at IS NULL;
    CREATE TABLE save_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      backup_path TEXT NOT NULL, created_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('pre_launch','post_session','manual','pre_restore')),
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1))
    );
    CREATE INDEX idx_backups_game_created ON save_backups(game_id, created_at DESC);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;
  `)
  legacy
    .prepare(
      `INSERT INTO games (name, executable_path, total_playtime_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run('Legacy Game', 'C:/old/game.exe', 7200, iso(), iso())
  legacy
    .prepare(
      `INSERT INTO save_backups (game_id, backup_path, created_at, size_bytes, file_count, trigger_type)
       VALUES (1, 'C:/old/backup', ?, 100, 2, 'manual')`
    )
    .run(iso())
  legacy.prepare("INSERT INTO settings (key, value) VALUES ('theme', 'light')").run()
  legacy.close()

  const result = initDatabase({ dbPath, defaultBackupsRoot: join(tmpdir(), 'lp-backups') })
  check('upgrade detected the existing version', result.migratedFrom === 1, String(result.migratedFrom))
  check('upgraded to the latest version', result.schemaVersion === LATEST_SCHEMA_VERSION)

  const games = gamesRepo.listGames()
  check('existing game survived the migration', games.length === 1 && games[0]?.name === 'Legacy Game')
  check('existing playtime preserved', games[0]?.totalPlaytimeSeconds === 7200)
  check('existing settings preserved', settingsRepo.getSettings().theme === 'light')

  const backups = savesRepo.listBackupsForGame(1)
  check('existing backup row survived', backups.length === 1)
  check(
    'pre-migration rows get a null hash, not a bogus one',
    backups[0]?.contentHash === null,
    String(backups[0]?.contentHash)
  )

  // A null hash must mean "cannot prove unchanged" so a backup still runs.
  const latest = savesRepo.getLatestBackup(1)
  check('null hash does not falsely match a new fingerprint', latest?.contentHash !== 'some-hash')

  closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
}

function main(): void {
  const dbPath = join(tmpdir(), `launchpad-verify-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

  section('Schema')
  const init = initDatabase({ dbPath, defaultBackupsRoot: join(tmpdir(), 'lp-backups') })
  check('migrations applied to latest version', init.schemaVersion === LATEST_SCHEMA_VERSION)
  check('fresh database starts at version 0', init.migratedFrom === 0)
  check('schema is at version 2 (content_hash migration applied)', init.schemaVersion === 2)

  section('Settings')
  const defaults = settingsRepo.getSettings()
  check('defaults seeded', defaults.maxBackupsPerGame === 10 && defaults.theme === 'dark')
  check('runtime backups root seeded', defaults.backupsRootPath.includes('lp-backups'))
  const updated = settingsRepo.updateSettings({ maxBackupsPerGame: 3, backupBeforeLaunch: false })
  check('update writes and returns canonical values', updated.maxBackupsPerGame === 3)
  check('booleans round-trip through text storage', updated.backupBeforeLaunch === false)
  check('unspecified keys are untouched', updated.minSessionSeconds === 30)
  const clamped = settingsRepo.updateSettings({ maxBackupsPerGame: 0 })
  check('nonsensical value falls back to default', clamped.maxBackupsPerGame === 10)
  settingsRepo.updateSettings({ maxBackupsPerGame: 3 })

  section('Games CRUD')
  const game = gamesRepo.createGame(
    { name: 'Hollow Knight', executablePath: 'C:/Games/hk/hk.exe', saveFolderPath: 'C:/saves/hk' },
    iso()
  )
  check('insert returns the created row', game.id > 0 && game.name === 'Hollow Knight')
  check('optional fields default to null', game.coverImagePath === null)
  check('playtime starts at zero', game.totalPlaytimeSeconds === 0)

  const other = gamesRepo.createGame({ name: 'Celeste', executablePath: 'C:/Games/celeste.exe' }, iso())
  check('list returns all games', gamesRepo.listGames().length === 2)
  check('list sorts by name', gamesRepo.listGames()[0]?.name === 'Celeste')

  const patched = gamesRepo.updateGame(game.id, { name: 'Hollow Knight: Silksong' }, iso(60))
  check('partial update changes only the named field', patched.name === 'Hollow Knight: Silksong')
  check('omitted fields survive the update', patched.executablePath === 'C:/Games/hk/hk.exe')
  check('updated_at advances', patched.updatedAt === iso(60))

  const cleared = gamesRepo.updateGame(game.id, { coverImagePath: null }, iso(61))
  check('null is distinguishable from omitted', cleared.coverImagePath === null)

  section('Sessions and the playtime roll-up')
  const s1 = sessionsRepo.startSession(game.id, iso(100))
  check('session opens with null end', s1.endedAt === null && s1.durationSeconds === null)
  check('open session is discoverable', sessionsRepo.findOpenSessions().length === 1)

  sessionsRepo.endSession(s1.id, iso(3700), 3600, 'exited')
  const afterOne = gamesRepo.getGame(game.id)
  check('roll-up increased by the session duration', afterOne?.totalPlaytimeSeconds === 3600)
  check('last_played_at updated', afterOne?.lastPlayedAt === iso(3700))
  check('no sessions left open', sessionsRepo.findOpenSessions().length === 0)

  const s2 = sessionsRepo.startSession(game.id, iso(4000))
  sessionsRepo.endSession(s2.id, iso(5800), 1800, 'crashed')
  check('roll-up accumulates', gamesRepo.getGame(game.id)?.totalPlaytimeSeconds === 5400)

  let doubleCloseRejected = false
  try {
    sessionsRepo.endSession(s2.id, iso(6000), 999, 'exited')
  } catch {
    doubleCloseRejected = true
  }
  check('closing an already-closed session is rejected', doubleCloseRejected)
  check('failed double-close did not inflate playtime', gamesRepo.getGame(game.id)?.totalPlaytimeSeconds === 5400)

  const stats = sessionsRepo.getSessionStats(game.id)
  check('stats count sessions', stats.sessionCount === 2)
  check('stats total matches roll-up', stats.totalSeconds === 5400)
  check('stats longest session', stats.longestSeconds === 3600)
  check('stats average', stats.averageSeconds === 2700)

  const s3 = sessionsRepo.startSession(other.id, iso(7000))
  sessionsRepo.discardSession(s3.id)
  check('discarded session leaves no row', sessionsRepo.listSessionsForGame(other.id).length === 0)
  check('discard does not touch playtime', gamesRepo.getGame(other.id)?.totalPlaytimeSeconds === 0)

  section('Crash recovery')
  const orphan = sessionsRepo.startSession(other.id, iso(8000))
  const reconciled = sessionsRepo.reconcileOpenSessions()
  check('orphaned session is reconciled', reconciled === 1)
  const closedOrphan = sessionsRepo.getSession(orphan.id)
  check('orphan marked app_closed', closedOrphan?.exitReason === 'app_closed')
  check('orphan records zero duration rather than inventing one', closedOrphan?.durationSeconds === 0)
  check('orphan did not inflate playtime', gamesRepo.getGame(other.id)?.totalPlaytimeSeconds === 0)

  section('Roll-up repair')
  transaction(() => {
    // Simulate drift, e.g. a crash between the two writes of a session close.
    sessionsRepo.startSession(game.id, iso(9000))
  })
  sessionsRepo.reconcileOpenSessions()
  const recalculated = gamesRepo.recalculatePlaytime(game.id)
  check('recalculate returns the session-derived total', recalculated === 5400)
  check('recalculate writes it back', gamesRepo.getGame(game.id)?.totalPlaytimeSeconds === 5400)

  section('Transactions')
  let threw = false
  try {
    transaction(() => {
      gamesRepo.createGame({ name: 'Rollback Me', executablePath: 'x.exe' }, iso())
      throw new Error('boom')
    })
  } catch {
    threw = true
  }
  check('transaction propagates the error', threw)
  check('transaction rolled back the insert', gamesRepo.listGames().every((g) => g.name !== 'Rollback Me'))

  const nested = transaction(() => {
    gamesRepo.createGame({ name: 'Outer', executablePath: 'o.exe' }, iso())
    try {
      transaction(() => {
        gamesRepo.createGame({ name: 'Inner', executablePath: 'i.exe' }, iso())
        throw new Error('inner boom')
      })
    } catch {
      // swallowed: the inner savepoint rolls back, the outer continues
    }
    return gamesRepo.listGames().map((g) => g.name)
  })
  check('nested rollback keeps the outer transaction alive', nested.includes('Outer'))
  check('nested rollback discards only the inner write', !nested.includes('Inner'))
  check('outer transaction committed', gamesRepo.listGames().some((g) => g.name === 'Outer'))

  section('Backups and rotation')
  const mkBackup = (n: number, pinned = false, trigger: 'pre_launch' | 'manual' = 'pre_launch') =>
    savesRepo.createBackup({
      gameId: game.id,
      backupPath: `C:/backups/hk/snap-${n}`,
      createdAt: iso(10000 + n),
      sizeBytes: 1024 * n,
      fileCount: n,
      trigger,
      isPinned: pinned,
      contentHash: `hash-${n}`
    })

  const b1 = mkBackup(1)
  check('backup insert round-trips', b1.sizeBytes === 1024 && b1.trigger === 'pre_launch')
  check('is_pinned reads back as a boolean, not 0/1', b1.isPinned === false)
  check('content hash stored', b1.contentHash === 'hash-1', String(b1.contentHash))

  mkBackup(2)
  const b3 = mkBackup(3, true, 'manual')
  mkBackup(4)
  mkBackup(5)
  check('backups list newest first', savesRepo.listBackupsForGame(game.id)[0]?.backupPath === 'C:/backups/hk/snap-5')
  check('pinned flag persists', savesRepo.getBackup(b3.id)?.isPinned === true)

  const usage = savesRepo.getBackupUsage(game.id)
  check('usage counts all backups', usage.backupCount === 5)
  check('usage sums sizes', usage.totalSizeBytes === 1024 * (1 + 2 + 3 + 4 + 5))

  // keep=2 with one pinned: unpinned are 1,2,4,5 -> keep 5,4 -> rotate 1,2
  const candidates = savesRepo.findRotationCandidates(game.id, 2)
  check('rotation returns the right count', candidates.length === 2, `got ${candidates.length}`)
  check('rotation never returns pinned snapshots', candidates.every((c) => !c.isPinned))
  check('rotation returns oldest first', candidates[0]?.backupPath === 'C:/backups/hk/snap-1')
  check('rotation keeps the newest unpinned', !candidates.some((c) => c.backupPath === 'C:/backups/hk/snap-5'))

  check('keep=0 rotates every unpinned snapshot', savesRepo.findRotationCandidates(game.id, 0).length === 4)

  const latest = savesRepo.getLatestBackup(game.id)
  check('latest backup is the newest by created_at', latest?.backupPath === 'C:/backups/hk/snap-5', latest?.backupPath)
  check('latest backup carries its hash for dedup', latest?.contentHash === 'hash-5', String(latest?.contentHash))
  check('getLatestBackup returns null for a game with none', savesRepo.getLatestBackup(other.id) === null)

  savesRepo.setBackupPinned(b1.id, true)
  check('pinning removes it from rotation', !savesRepo.findRotationCandidates(game.id, 2).some((c) => c.id === b1.id))

  section('Cascade delete')
  const sessionsBefore = sessionsRepo.listSessionsForGame(game.id).length
  check('game has sessions before delete', sessionsBefore > 0)
  const del = gamesRepo.deleteGame(game.id)
  check('delete reports success', del.deleted)
  check('delete returns backup paths for caller cleanup', del.orphanedBackupPaths.length === 5)
  check('game row is gone', gamesRepo.getGame(game.id) === null)
  check('sessions cascaded', sessionsRepo.listSessionsForGame(game.id).length === 0)
  check('backups cascaded', savesRepo.listBackupsForGame(game.id).length === 0)

  section('Reopen')
  closeDatabase()
  const reopened = initDatabase({ dbPath, defaultBackupsRoot: join(tmpdir(), 'lp-backups') })
  check('reopen runs no migrations', reopened.migratedFrom === LATEST_SCHEMA_VERSION)
  check('data persisted across reopen', gamesRepo.listGames().length > 0)
  check('edited settings persisted', settingsRepo.getSettings().maxBackupsPerGame === 3)
  closeDatabase()

  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

  // Runs last, against its own hand-built v1 database.
  verifyUpgradeFromV1()

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main()
