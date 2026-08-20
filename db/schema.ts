import type { DatabaseSync } from 'node:sqlite'

/**
 * Schema definition and forward-only migration runner.
 *
 * Versioning uses SQLite's built-in `user_version` pragma rather than a
 * migrations table. It is a single integer stored in the database header, needs
 * no bootstrapping (there is no chicken-and-egg problem of creating the
 * migrations table itself), and is read in one pragma call at startup.
 * The tradeoff is that it records only the version number -- no history of when
 * each migration ran. For a single-user local app that history has no consumer.
 *
 * Rules for adding a migration:
 *   - Append a new entry; never edit a released one. Users' databases have
 *     already run the old SQL, so editing it changes nothing for them and
 *     silently diverges their schema from a fresh install's.
 *   - Each entry runs inside a transaction and bumps user_version atomically.
 */

interface Migration {
  version: number
  name: string
  up: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE games (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        name                   TEXT    NOT NULL,
        executable_path        TEXT    NOT NULL,
        working_directory      TEXT,
        launch_args            TEXT,
        save_folder_path       TEXT,
        cover_image_path       TEXT,
        total_playtime_seconds INTEGER NOT NULL DEFAULT 0,
        last_played_at         TEXT,
        created_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL
      );

      CREATE TABLE play_sessions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        started_at       TEXT    NOT NULL,
        ended_at         TEXT,
        duration_seconds INTEGER,
        exit_reason      TEXT    CHECK (exit_reason IN ('exited','crashed','app_closed','unknown'))
      );

      -- Serves the detail view's "recent sessions" query directly.
      CREATE INDEX idx_sessions_game_started
        ON play_sessions(game_id, started_at DESC);

      -- Partial index: startup reconciliation asks "which sessions never
      -- closed?", which is normally zero rows. A partial index keeps that
      -- lookup free instead of scanning full session history.
      CREATE INDEX idx_sessions_open
        ON play_sessions(game_id) WHERE ended_at IS NULL;

      CREATE TABLE save_backups (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        backup_path  TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        size_bytes   INTEGER NOT NULL,
        file_count   INTEGER NOT NULL,
        trigger_type TEXT    NOT NULL CHECK (trigger_type IN ('pre_launch','post_session','manual','pre_restore')),
        is_pinned    INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1))
      );

      -- Serves both the history list and the rotation query.
      CREATE INDEX idx_backups_game_created
        ON save_backups(game_id, created_at DESC);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'backup_content_hash',
    up: `
      -- Fingerprint of the save folder at snapshot time, used to skip taking a
      -- second identical backup. Without it, the automatic pre-launch and
      -- post-session backups produce two copies per play session even when
      -- nothing changed, which halves how far back the rotation limit reaches.
      -- Nullable: rows written before this migration have no fingerprint, and
      -- a null simply means "cannot prove it is unchanged", so a backup is taken.
      ALTER TABLE save_backups ADD COLUMN content_hash TEXT;
    `
  },
  {
    version: 3,
    name: 'game_metadata',
    up: `
      -- Metadata fetched from an external provider (currently IGDB). Every
      -- column is nullable and NULL means "never looked up", which is not the
      -- same as "looked up and the provider reported nothing" -- that case is
      -- an empty JSON array in genres. The app must be able to tell those apart
      -- so it never claims a game has no genres when it simply has not asked.
      --
      -- genres is a JSON array of strings rather than a join table: it is only
      -- ever read and written whole, never queried by individual genre, and a
      -- join table would add two tables and a migration for no query we make.
      -- If genre filtering ever needs an index, that is the migration to write.
      ALTER TABLE games ADD COLUMN genres TEXT;
      ALTER TABLE games ADD COLUMN summary TEXT;

      -- Provider release date as YYYY-MM-DD, not a timestamp: IGDB reports a
      -- release date, and widening it to an instant would invent a precision
      -- (and a timezone) the source does not have.
      ALTER TABLE games ADD COLUMN release_date TEXT;

      -- Which provider the values came from, and its id for that game, so a
      -- later refresh can re-query the same entry instead of re-searching by
      -- name and possibly matching a different edition.
      ALTER TABLE games ADD COLUMN metadata_source TEXT;
      ALTER TABLE games ADD COLUMN metadata_id TEXT;
      ALTER TABLE games ADD COLUMN metadata_updated_at TEXT;
    `
  },
  {
    version: 4,
    name: 'game_hero_art',
    up: `
      -- Wide key art for the detail page's backdrop, kept separate from
      -- cover_image_path because the two are different shapes with different
      -- jobs: the cover is portrait 3:4 for the grid, the hero is roughly 16:6
      -- and only ever drawn full-bleed behind text.
      --
      -- One column rather than reusing cover_image_path, because a game can
      -- legitimately have one and not the other -- SteamGridDB carries grids for
      -- far more titles than it carries heroes -- and collapsing them would mean
      -- either stretching box art across the header or leaving the grid card
      -- empty. NULL means "no wide art", which the detail page states rather
      -- than papers over.
      --
      -- The file lives in the same managed covers folder as cover art: it is
      -- served by the same lpasset:// handler, swept by the same
      -- deleteCoversForGame() prefix match, and subject to the same download
      -- guards. A second directory would have duplicated all three.
      ALTER TABLE games ADD COLUMN hero_image_path TEXT;
    `
  }
]

/** The version a freshly migrated database should report. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

/**
 * Applies every migration newer than the database's current version.
 *
 * Throws if the database is NEWER than this build knows about: that means an
 * older app version has opened a database written by a newer one, and blindly
 * reading it risks corrupting data through columns this build cannot see.
 */
export function runMigrations(db: DatabaseSync): { from: number; to: number } {
  const startVersion = getSchemaVersion(db)

  if (startVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${startVersion} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}). Update LaunchPad to open this library.`
    )
  }

  const pending = MIGRATIONS.filter((m) => m.version > startVersion).sort(
    (a, b) => a.version - b.version
  )

  for (const migration of pending) {
    db.exec('BEGIN')
    try {
      db.exec(migration.up)
      // PRAGMA cannot take a bound parameter, so the version is interpolated.
      // It is an integer literal from this file, never user input.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${reason}`)
    }
  }

  return { from: startVersion, to: getSchemaVersion(db) }
}
