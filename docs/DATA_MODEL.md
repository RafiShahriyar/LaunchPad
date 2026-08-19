# Data Model

> Status: **Schema v2.** Tables, indexes and repositories exist in `db/`, and
> 76 assertions in `db/verify.ts` pass (`npm run verify:db`), including a
> hand-built v1 -> v2 upgrade test. The schema below is what the running app
> actually creates.

## Decision: `node:sqlite`

**Settled — the data layer targets `node:sqlite`, Node 24's built-in module.**

The original plan specified `better-sqlite3`. While scaffolding, that turned out
to have a hard blocker on this machine:

- `better-sqlite3` **v13 ships no prebuilt binaries at all** (the v13.0.3 GitHub
  release has zero release assets; v12.4.1 had 110).
- The newest Electron ABI any `better-sqlite3` release provides a prebuild for
  is **139** (~Electron 40). Electron 43 is **ABI 148**. So no version of
  `better-sqlite3` has a usable prebuild for this Electron.
- Compiling from source therefore requires Visual Studio Build Tools. Verified
  failure on this machine:
  `Error: Could not find any Visual Studio installation to use`.

Meanwhile, Electron 43 bundles **Node 24.18.1**, whose built-in `node:sqlite`
module was verified working in this exact Electron build:

```
nodeSqlite: AVAILABLE
exports:    DatabaseSync, StatementSync, Session, constants, backup
sqlite:     3.53.1
round trip: [{ a: 1, b: 'hello' }]
```

| | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| Native build step | **None** | Requires VS Build Tools on every dev machine + CI |
| Electron 43 support | Built in | No prebuild; source build only |
| API | Synchronous `prepare/run/get/all` | Synchronous `prepare/run/get/all` (very similar) |
| Maturity | Node core, still marked experimental | Battle-tested, huge install base |
| Upgrade risk | Tied to Electron's bundled Node | Rebuild needed on every Electron upgrade |
| Extras | `backup()` built in | Extensions, custom collations, more helpers |

The deciding factor was that `node:sqlite` removes the native build step
entirely: no VS Build Tools, no `electron-rebuild` in the packaging path, and no
ABI breakage on future Electron upgrades. The accepted risk is that `node:sqlite`
is still marked experimental in the Node docs and is tied to whatever Node
version Electron bundles.

That risk is contained by keeping **all SQL and every `node:sqlite` call inside
`db/`**, with the rest of the app talking to a repository API. Switching to
`better-sqlite3` later would mean rewriting `db/client.ts` and nothing else —
the APIs are near-identical (both synchronous `prepare` / `run` / `get` / `all`).

## Tables

Four tables. Timestamps are stored as **ISO-8601 UTC strings** (SQLite has no
date type; text sorts correctly and survives IPC without conversion — see the
note on serializability in `ARCHITECTURE.md`).

### `games`

One row per game in the library.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Autoincrement |
| `name` | TEXT NOT NULL | Display name |
| `executable_path` | TEXT NOT NULL | Absolute path to the `.exe` that gets spawned |
| `working_directory` | TEXT NULL | Defaults to the executable's folder if unset |
| `launch_args` | TEXT NULL | Extra CLI args, stored as one string |
| `save_folder_path` | TEXT NULL | **NULL disables backups for this game** |
| `cover_image_path` | TEXT NULL | Absolute path on disk; NULL renders a placeholder |
| `total_playtime_seconds` | INTEGER NOT NULL DEFAULT 0 | Denormalised roll-up (see below) |
| `last_played_at` | TEXT NULL | ISO-8601 |
| `created_at` | TEXT NOT NULL | ISO-8601 |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

**Why `total_playtime_seconds` is denormalised.** It is derivable with
`SELECT SUM(duration_seconds) FROM play_sessions WHERE game_id = ?`, so storing
it duplicates state. It is stored anyway because the library grid shows playtime
for every game at once — the alternative is either an aggregate per card
(N+1 queries) or a `GROUP BY` join on every render. The duplication is safe
because exactly one code path writes it: the session-end transaction updates the
session row and this column together, atomically. A `recalculatePlaytime()`
repair function will be provided for the case where the two ever diverge.

**Why `save_folder_path` is nullable rather than a separate table.** A game has
at most one save location in this design. Games with saves split across several
folders (config in one place, saves in another) are a known limitation — see
`FEATURES.md`.

### `play_sessions`

One row per launch. Written at launch, updated at exit.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `game_id` | INTEGER NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `started_at` | TEXT NOT NULL | ISO-8601, written at spawn |
| `ended_at` | TEXT NULL | **NULL means the session is still running** |
| `duration_seconds` | INTEGER NULL | NULL until the session closes |
| `exit_reason` | TEXT NULL | `exited` \| `crashed` \| `app_closed` \| `unknown` |

**Why the row is written at launch rather than at exit.** If LaunchPad itself
crashes or is killed while a game is running, a row written only at exit would
lose the session entirely. Writing at launch means an interrupted session leaves
a detectable open row (`ended_at IS NULL`), which startup reconciliation can
close and mark `app_closed` rather than silently dropping the playtime.

**Why `exit_reason` exists.** It separates "the player quit" from "the process
died" from "we lost track of it". Without it, a 4-second session from a failed
launch is indistinguishable from a real one, and the `min_session_seconds`
filter has no basis to act on.

Index: `idx_sessions_game_started ON play_sessions(game_id, started_at DESC)` —
serves the detail view's "recent sessions" query directly.

### `save_backups`

One row per snapshot taken.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `game_id` | INTEGER NOT NULL | FK → `games(id)` ON DELETE CASCADE |
| `backup_path` | TEXT NOT NULL | Absolute path to this snapshot's folder |
| `created_at` | TEXT NOT NULL | ISO-8601; also encoded in the folder name |
| `size_bytes` | INTEGER NOT NULL | For the UI and for disk-usage awareness |
| `file_count` | INTEGER NOT NULL | Cheap sanity signal: a 0-file backup is suspect |
| `trigger_type` | TEXT NOT NULL | `pre_launch` \| `post_session` \| `manual` \| `pre_restore` |
| `is_pinned` | INTEGER NOT NULL DEFAULT 0 | Boolean; **pinned snapshots are exempt from rotation** |
| `content_hash` | TEXT NULL | Fingerprint of the save folder at snapshot time (schema v2). NULL means "cannot prove unchanged" |

**Why the column is `trigger_type`, not `trigger`.** `TRIGGER` is a SQLite
keyword. It can be used as an identifier if quoted everywhere, but a single
unquoted reference in a future query is a syntax error waiting to happen. The
domain field stays `trigger`; the mapper renames it. This is the only place the
column and field names differ.

**Why the trigger is recorded.** Not all snapshots are equally valuable. A
`pre_restore` snapshot is the user's undo button for a destructive restore; a
routine `pre_launch` snapshot is the most disposable. The trigger lets the UI
explain where each snapshot came from ("Before launch", "Before restore"), which
is what makes a history list readable rather than a wall of timestamps.

**Rotation does not read the trigger.** An earlier draft of this document said
it would; the implemented policy is purely *newest-N-unpinned*, and
`pre_restore` snapshots are protected by being **pinned at creation** instead.
Pinning is a simpler and stronger guarantee: a trigger-priority rule would still
eventually rotate an undo snapshot away once enough newer ones accumulated,
whereas a pin never does. The cost is that pre-restore snapshots accumulate
until the user removes them — see `FEATURES.md`.

**Why `is_pinned` exists.** Rotation deleting the one known-good save before a
corrupting patch is the exact failure this feature is meant to prevent. Pinning
opts a snapshot out.

**Why `content_hash` exists (added in schema v2).** Automatic backups run twice
per session (pre-launch and post-session). Without a change check, a session
that never touched the saves would still consume two of the ten rotation slots,
halving how far back history reaches. An automatic backup whose fingerprint
matches the previous snapshot is skipped.

The hash covers each file's **relative path, size and mtime**, not its contents:
hashing bytes would be exact but turns the check into a second full read of the
save folder. It errs safe -- a touched-but-identical file causes a redundant
backup, whereas a missed change would lose data.

It is nullable because rows written before v2 have no fingerprint, and the code
treats null as "cannot prove unchanged" so a backup still runs. Manual backups
ignore it entirely.

Index: `idx_backups_game_created ON save_backups(game_id, created_at DESC)` —
serves both the history list and the rotation query.

### `settings`

Single-row key/value table (`key` TEXT PK, `value` TEXT).

Key/value rather than a one-row typed table so that adding a setting is an
`INSERT`, not a migration. Values are stored as text and parsed on read; the
typed shape lives in `AppSettings` in `shared/types.ts`.

| Key | Default | Meaning |
|---|---|---|
| `backups_root_path` | `<userData>/backups` | Root folder for all per-game backup folders |
| `max_backups_per_game` | `10` | Rotation limit, unpinned snapshots only |
| `backup_before_launch` | `true` | Snapshot automatically before each launch |
| `backup_after_session` | `true` | Snapshot automatically after each session |
| `min_session_seconds` | `30` | Sessions shorter than this are discarded |
| `theme` | `dark` | UI theme |

## Relationships

```
games (1) ──< (N) play_sessions      ON DELETE CASCADE
games (1) ──< (N) save_backups       ON DELETE CASCADE

settings : standalone key/value, no relations
```

`ON DELETE CASCADE` on both children means deleting a game removes its session
history and its backup *rows* in one transaction.

**Important caveat:** the cascade deletes database rows, not files on disk.
Backup *folders* must be removed explicitly by the delete-game handler, and that
deletion will be presented to the user as a separate, explicit choice — deleting
a game from the library should not silently destroy the saves the app was
supposed to be protecting.

## Where the data lives

Everything sits under Electron's `userData` directory, which is per-user and
survives app updates:

```
<userData>/
  launchpad.db                       SQLite database
  covers/                            managed cover art
  backups/                           backups_root_path default
    12-hollow-knight/                <gameId>-<slug>
      2026-08-19T04-58-29-123Z/      one folder per snapshot
      .tmp-...                       in-progress copy, renamed on completion
```

**Snapshot folder names keep milliseconds.** Colons are illegal in Windows
filenames, hence the substitution, but truncating to whole seconds was an actual
bug: two backups taken in the same second resolved to the same path and the
second failed when renaming onto an existing directory. A manual backup landing
next to an automatic one hits this. The format still sorts lexicographically,
which the rotation ordering depends on.

**`.tmp-` folders are the commit mechanism.** A copy is written under a `.tmp-`
name and renamed only when complete, so a snapshot never appears half-written.
Nothing lists them (listings come from the database), and startup removes any
left by an interrupted copy.

On Windows this resolves to `%APPDATA%\launchpad`. The exact path and the
applied schema version are shown in the Settings screen via `app:getInfo`.

---

# Implementation

## Layout of `db/`

```
db/
  client.ts              connection, pragmas, transaction helper
  schema.ts              migrations + user_version runner
  defaults.ts            default settings (no imports, avoids a cycle)
  row.ts                 typed row reading + parameter binding
  repositories/
    games.ts
    sessions.ts
    saves.ts
    settings.ts
  index.ts               the only module anything outside db/ imports
  verify.ts              63-assertion harness, runs under plain Node
```

**Deviation from the original plan:** the plan listed only `db/schema.ts` and
`db/client.ts`. Repositories were split out per domain to mirror the IPC domain
split, so a `saves:backup` handler has exactly one obvious data module to call.
`row.ts` and `defaults.ts` exist for the reasons given below.

**`db/` imports nothing from Electron.** The database path is passed into
`initDatabase()` rather than read from `app.getPath()`. That is what lets
`verify.ts` exercise the real repositories against a temp file under plain Node,
with no Electron window — which is why the verification harness runs in about a
second.

## Connection settings

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Reads proceed while a write is in flight. The app writes at session start/end while the UI reads the library; the default rollback journal would block the UI for each write. |
| `synchronous` | `NORMAL` | Standard companion to WAL. Skips an fsync per commit; on an OS crash it risks losing the last few transactions, not corruption. Losing seconds of playtime is an acceptable trade. |
| `busy_timeout` | `5000` | Wait rather than immediately error if another writer holds the lock. |
| `foreign_keys` | `ON` | Enabled explicitly via `enableForeignKeyConstraints`. Without it the `ON DELETE CASCADE` rules are silently inert. |

`closeDatabase()` runs `wal_checkpoint(TRUNCATE)` on quit so the `.db` file is
self-contained; otherwise recent writes live only in the `-wal` sidecar.

## Migrations

Versioned with SQLite's `user_version` pragma rather than a migrations table: it
needs no bootstrapping (no chicken-and-egg problem of creating the migrations
table) and is one pragma read at startup. The tradeoff is that it stores only a
number — no record of when each migration ran, which for a single-user local app
has no consumer.

Each migration runs inside a transaction that also bumps `user_version`, so a
failed migration leaves the database exactly as it was.

**Opening a database from a newer build is refused**, not silently tolerated:
reading rows through a schema this build does not understand risks writing back
values that destroy columns it cannot see.

Rule for adding one: append a new entry, never edit a released one. Users'
databases have already run the old SQL, so editing it changes nothing for them
while silently diverging their schema from a fresh install's.

### Applied migrations

| Version | Name | Change |
|---|---|---|
| 1 | `initial_schema` | The four tables and three indexes above |
| 2 | `backup_content_hash` | Adds `save_backups.content_hash` for backup deduplication |

`db/verify.ts` includes an upgrade test that builds a **v1 database by hand**
and migrates it, asserting games, playtime, settings and backup rows all
survive. Building v1 by hand rather than trusting the migration list is what
makes it a genuine upgrade test rather than a fresh-install test -- and
migrations are the one thing that cannot be fixed after release, because user
data has already passed through them.

## node:sqlite quirks the code works around

Verified empirically against Electron 43's Node 24.18.1:

| Quirk | Consequence |
|---|---|
| `true`/`false` **cannot be bound** — throws `Provided value cannot be bound` | `bindBoolean()` converts to `1`/`0`. Applies to `is_pinned`. |
| `undefined` **cannot be bound** either | `bindNullable()` collapses `undefined` to `null`, so optional fields work. |
| No `db.transaction()` helper (better-sqlite3 has one) | `transaction()` in `client.ts` is hand-rolled, using SAVEPOINTs for nesting — SQLite rejects a second `BEGIN`, which would otherwise break any repository method used inside a larger transaction. |
| `changes` / `lastInsertRowid` are `number \| bigint` | `toNumber()` normalises. |
| Aggregates (`COUNT`, `SUM`) may return `bigint` | `readNumber()` accepts both. |
| Rows are `Record<string, SQLOutputValue>` | `row.ts` asserts each column's type at mapping time, so a renamed column fails immediately with the column name rather than surfacing as `undefined` far away. |
| Emits `ExperimentalWarning: SQLite is an experimental feature` on stderr | Cosmetic. Not suppressed — silencing process warnings globally would hide unrelated ones. |

## Verification

`npm run verify:db` runs `db/verify.ts` against a throwaway database. It covers
the things that are cheap to get wrong and expensive to notice late:

- migrations apply, and a reopen runs none
- partial updates leave omitted fields alone, and `null` stays distinguishable
  from "not provided"
- the playtime roll-up matches the session rows after each close
- a rejected double-close does **not** inflate playtime
- orphaned sessions reconcile to duration 0 rather than an invented length
- `recalculatePlaytime()` restores the roll-up from source data
- transaction rollback, and nested rollback that keeps the outer transaction alive
- rotation excludes pinned snapshots, returns oldest-first, and honours `keep=0`
- cascade deletes remove sessions and backup rows, and return backup paths for
  the caller to clean up

