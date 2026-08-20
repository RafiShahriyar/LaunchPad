# Features

A running list of what actually works, updated as each feature lands.

| # | Feature | Status |
|---|---|---|
| 1 | Project scaffolding (Electron + React + TS + Redux, dev & build) | **Done** |
| 2 | SQLite schema + data layer | **Done** |
| 3 | Add / edit / delete game | **Done** |
| 4 | Launch game + playtime tracking | **Done** |
| 5 | Save file backup | **Done** |
| 6 | Save restore | **Done** |
| 7 | Dashboard UI (grid, detail view, stats) | **Done** |
| 8 | Settings screen | **Done** |
| + | Window chrome: custom title bar, controls + fullscreen | **Done** |
| + | Collapsible sidebar | **Done** |
| + | Game metadata (IGDB / RAWG + SteamGridDB artwork) | **Done** |
| + | Sample data seeder (dev only) | **Done** |

---

## 1. Project scaffolding — Done

Three build targets compile from one `electron-vite` config, the security model
is in place and verified, and one real IPC round trip proves the whole chain.

### What works end to end

**App info flow** — the reference implementation every later feature copies:

```
App.tsx mounts
  -> dispatch(fetchAppInfo())                    src/store/slices/settingsSlice.ts
  -> unwrap(window.api.app.getInfo())            src/store/asyncStatus.ts
  -> ipcRenderer.invoke('app:getInfo')           electron/preload.ts
  -> handle('app:getInfo', fn)                   electron/ipc/handle.ts
  -> reads app.getVersion(), process.versions    electron/ipc/app.ts
  -> returns { ok: true, data: AppInfo }
  -> unwrap() returns data (or throws on !ok)
  -> settingsSlice .fulfilled writes state.appInfo
  -> SettingsPage re-renders with live values
```

Confirmed in the running app — the Settings screen displays Electron 43.4.1,
Chromium 150.0.7871.224, Node 24.18.1, win32, and the real `userData` path.

**Navigation** — the sidebar dispatches `uiSlice` actions (`libraryOpened`,
`viewChanged`); `App.tsx` selects `state.ui.activeView` to pick a page. There is
no router: navigation is Redux state, which keeps it inspectable in devtools and
means it survives hot reload.

### Verified during step 1

| Check | Result |
|---|---|
| `npm run dev` opens a working window | Yes |
| Hot reload patches the live window | Yes — edited `LibraryPage.tsx`, DOM updated without restart |
| `npm run build` produces a working bundle | Yes — main 2.84 kB, preload 0.27 kB, renderer 653 kB |
| Typecheck passes for both projects | Yes |
| Tailwind classes apply | Yes — `body` computed background is `rgb(11, 15, 25)` = `surface-900` |
| `require` unavailable in renderer | Yes — `typeof require === 'undefined'` |
| Raw `ipcRenderer` not exposed | Yes — `window.ipcRenderer === undefined` |
| Production CSP injected | Yes — present in `out/renderer/index.html`, absent in dev |

### Commands

```bash
npm run dev        # electron-vite dev --watch : renderer HMR + main/preload auto-restart
npm run build      # typecheck, then build all three targets into out/
npm start          # run the production build without packaging
npm run dist       # build + electron-builder -> Windows NSIS installer
npm run typecheck  # both tsconfig projects
```

### Known limitations at this stage

- **No data layer yet.** The library is empty and the games/sessions/saves
  slices hold no data; their async thunks arrive with their features.
- **No app icon.** `electron-builder` will fall back to the default Electron
  icon until `build/icon.ico` is added.
- **Renderer bundle is 653 kB** (~200 kB gzipped) — fine for a desktop app where
  assets load from disk, but worth code-splitting if it grows much further. It
  reached ~740 kB by step 8.

> Packaging was left unverified until step 8. See
> [Packaging status](#packaging-status) at the end of this document for what was
> found when it was finally exercised.

### Tradeoffs accepted

- **Tailwind over CSS Modules.** Tailwind was chosen because this UI is mostly
  one-off layout composition (grid cards, stat rows, modals) rather than a set of
  reusable styled primitives, and co-locating styles with markup avoids
  maintaining a parallel tree of `.module.css` files. The cost is noisy
  `className` strings — the usual mitigation, extracting components once a
  pattern repeats, applies. CSS Modules would have given better style isolation
  and smaller markup; if the UI turns out to need heavy theming later, that
  tradeoff is worth revisiting. Tailwind v4 needs no `tailwind.config.js`:
  design tokens live in `@theme` in `src/index.css`.
- **No router.** With three views, Redux state is simpler than React Router and
  keeps navigation inspectable. If deep-linking or back/forward navigation is
  wanted later, this is the piece to reconsider.
- **`sandbox: true` on the renderer.** Slightly more restrictive than most
  Electron templates. Since the renderer never needs Node, the restriction costs
  nothing here and closes a whole class of exploit.

---

## 2. SQLite schema + data layer — Done

Four tables, three indexes, four repositories, and a migration runner. Full
schema reference and the reasoning behind each column is in `DATA_MODEL.md`.

### How it works end to end

**Startup:** `app.whenReady()` → `setupDatabase()` opens
`<userData>/launchpad.db`, sets pragmas, runs pending migrations and seeds
default settings. Handlers register only after that, so no query can arrive
before the database is open. On quit, `will-quit` checkpoints the WAL and closes
the connection.

**Repository calls** are synchronous (`node:sqlite` is a synchronous API) and
run in the main process only. Nothing in `src/` can reach them: the renderer has
no Node access, so every future data operation goes through an IPC handler.

**Failure is surfaced, not swallowed.** If the database cannot be opened, the
app shows an error dialog naming the path and exits, rather than presenting an
empty library — which would invite the user to "re-add" games that already exist
in a database the app just failed to open.

### Verified

`npm run verify:db` — **63 assertions, all passing.** It runs the real
repositories against a temp database under plain Node (possible because `db/`
does not import Electron). Highlights:

| Area | What is proven |
|---|---|
| Migrations | Applied on a fresh DB; a reopen runs none; data and edited settings survive |
| Games CRUD | Partial updates leave omitted fields alone; `null` stays distinct from "omitted" |
| Playtime roll-up | Accumulates correctly; a rejected double-close does **not** inflate it |
| Crash recovery | Orphaned sessions close with duration 0 rather than an invented length |
| Repair | `recalculatePlaytime()` rebuilds the roll-up from session rows |
| Transactions | Rollback works; a nested rollback keeps the outer transaction alive |
| Rotation | Pinned snapshots excluded; oldest-first ordering; `keep=0` handled |
| Cascade | Deleting a game removes its sessions and backup rows, and returns backup paths |

Also confirmed inside the real Electron app: schema version 1, `journal_mode=wal`,
`foreign_keys=1`, all four tables and three indexes present, defaults seeded with
the runtime backups path resolved.

### Design decisions worth knowing

- **`db/` has no Electron import.** The path is injected. This is what makes the
  verification harness possible without booting a window.
- **Repositories return data, they do not touch files.** `deleteGame()` removes
  rows and *returns* the orphaned backup paths instead of deleting folders, so
  removing a game from the library can never silently destroy the saves the app
  exists to protect. The caller decides.
- **`createBackup()` is called after the copy succeeds**, never before. A row
  pointing at a folder that does not exist would appear in the restore UI as a
  selectable option and fail at the worst possible moment; an unreferenced folder
  is merely wasted disk space.
- **Orphaned sessions record duration 0.** The app was not running to observe the
  exit, so any duration would be invented. Recording that the session happened
  with an unknown length is the honest option, and it keeps playtime accurate.
- **Settings are re-parsed and clamped on read**, and `updateSettings()` returns
  the full canonical object — so the UI can never display a value the app is not
  actually using (e.g. `maxBackupsPerGame: 0` falls back to the default).

### Known limitations

- **`node:sqlite` prints `ExperimentalWarning` on startup.** Cosmetic. Not
  suppressed, because silencing process warnings globally would hide unrelated
  ones.
- **Migration rollback is per-migration, not whole-run.** If migration 3 fails
  after 2 succeeded, the DB sits at version 2. That is recoverable (fix and
  re-run) but is not a single atomic upgrade.
- **No `UNIQUE` constraint on `executable_path`.** Two library entries can point
  at the same executable — intentional, since separate mod profiles or save
  slots of one game are a legitimate use — but it also means an accidental
  duplicate add is not prevented. Worth a UI-level warning in step 3.
- **Single connection, single process.** The app already enforces this with a
  single-instance lock; WAL would permit multi-process access, but nothing else
  is designed for it.

---

## 3. Add / edit / delete game — Done

The first real IPC domain. Games can be added by pointing at an executable,
edited, and deleted, with native file pickers, cover art, and a library grid
that sorts and searches.

### End-to-end flows

**Add game:** `+ Add game` → `modalOpened({kind:'addGame'})` → `GameFormModal`
→ `Browse…` dispatches `pickExecutable` → IPC `games:pickExecutable` → native
dialog → path returns → name auto-suggested from the filename → `Add game`
dispatches `createGame` → IPC `games:create` → main validates every path →
`gamesRepo.createGame` → cover copied into the managed folder → `Game` returns →
`gamesAdapter.addOne` → grid re-renders. Step-by-step in `CODE_FLOW.md`.

**Delete game:** the dialog separates two consequences — the library entry always
goes, the backup folders only go if explicitly checked (default off).

### Cover images: the interesting problem

Displaying a user-chosen image is harder than it looks, because **the renderer
cannot load `file://` URLs**. In dev it is served from `http://localhost:5173`,
and Chromium blocks `file://` subresources from an http origin no matter what
the CSP says.

Three options were considered:

| Approach | Verdict |
|---|---|
| Base64 data URLs over IPC | Works, but puts every image's full bytes into IPC payloads and Redux state |
| Serve the original path via a custom protocol | Works, but means "the renderer can request any file on disk" |
| **Copy into a managed folder + custom protocol** | Chosen |

Covers are copied into `<userData>/covers/` and served by a `lpasset://` handler
confined to that directory. This buys three things at once:

1. **Security** — the protocol serves one folder, not the filesystem. It
   `basename()`s the request and then re-checks containment, so
   `lpasset://cover/..%2F..%2Flaunchpad.db` is rejected (verified).
2. **Durability** — pointing at an image inside a game's install folder would
   leave a broken cover after uninstalling. The copy survives.
3. **Cache correctness** — the filename embeds a SHA-1 of the file contents, so
   replacing a cover always yields a new URL. A stable name like `12.png` would
   have Chromium serving the old image from cache.

The cost is a duplicated copy per image (a few hundred KB), and covers are not
resized — a 20 MB limit is enforced instead, since no image library is bundled.

### A bug the tests caught

The first implementation inserted the game row and *then* imported the cover, on
the reasoning that "losing an image is better than losing the typed paths". The
functional test proved that wrong: creating a game with an invalid cover
returned `{ok:false}` to the renderer **while leaving the row in the database**.
The user would be told the save failed and then find a mystery entry in their
library.

Fixed in two parts: covers are now validated *before* the insert (so ordinary
mistakes never create a row), and if the copy still fails afterwards the row is
deleted and the error rethrown. A reported failure now leaves nothing behind.

### Verified — 54 assertions across two suites

**IPC suite (26):** validation rejects missing executables, blank names,
folders-as-executables, files-as-save-folders and non-image covers — all as
error envelopes, never crashes. Create assigns an id, trims launch args, and
copies the cover. The cover decodes in the renderer at the correct dimensions,
and path traversal is blocked. Partial updates preserve omitted fields; clearing
a cover deletes the file. Deletes cascade and report kept backup folders.

**UI suite (28):** driving the real React components — submit stays disabled
until required fields are filled, the name field takes focus on open, a
validation error keeps the dialog open *with the user's input intact* and
creates no phantom game, the duplicate-executable warning appears, Escape
dismisses, edit prefills and renames, search filters, list view renders paths,
and the delete dialog defaults to keeping backups while warning when that is
unchecked.

### Design decisions

- **Validation lives in main, not the form.** The renderer has no filesystem
  access, so it *cannot* check that a path exists — only main can. Main is also
  the layer guaranteed to run, so a renderer bug cannot bypass the checks. The
  form still does cheap checks (non-empty) for instant feedback.
- **Path fields stay hand-editable.** The picker is the normal route, but typing
  or pasting a known path is faster, and main validates either way.
- **Duplicate executables warn but do not block.** Separate mod profiles or save
  slots of one game are a legitimate reason to add the same exe twice, so this
  is a UI warning rather than a constraint (matching the deliberate absence of a
  `UNIQUE` index).
- **Save folders may not exist yet.** Many games only create them on first run,
  so requiring existence would block adding a game before playing it. A path
  that exists but is a *file* is still rejected.
- **Sorting and filtering are in a memoised selector**, not the component, so
  the work is skipped when unrelated slices change — which matters once session
  ticks start firing in step 4.
- **One modal at a time is unrepresentable otherwise.** `ui.modal` is a
  discriminated union, and a single `ModalHost` applies it.

### Known limitations

- **Cover art is not resized.** A 20 MB cap is enforced, but a 6000px image is
  stored and decoded at full size. Bundling an image library would fix it.
- **`.lnk` and `.url` files can be selected but will not launch correctly** until
  step 4 handles shell resolution — Steam shortcuts in particular resolve to a
  `steam://` URL rather than a process.
- **No drag-and-drop** for adding games or covers.
- **No bulk actions** — no multi-select, no folder scan to import a whole
  library at once.
- **Deleting a game leaves its backup folders orphaned by default.** That is the
  intended safe behaviour, but nothing yet surfaces those folders for later
  cleanup; the settings screen in step 8 is the natural home for that.

---

## 4. Launch game + playtime tracking — Done

Games launch from the library, sessions are timed, and playtime accumulates.
This step also introduces the **first main → renderer push channel**: a game
exits on its own schedule, with no renderer request to respond to.

### How tracking works

`spawn()` the executable, treat the child's `exit` event as the end of the
session. Exact for games whose executable *is* the game. The known failure mode
is documented under limitations rather than hidden — a confidently wrong
playtime number is worse than an obviously missing one.

Session rows are written **at launch**, not at exit, so a LaunchPad crash still
leaves a detectable open row for startup reconciliation.

### Three shutdown paths, deliberately distinguished

| What happened | Reason recorded | Duration | Why |
|---|---|---|---|
| Game process exits | `exited` / `crashed` | Measured | Normal case |
| LaunchPad quits while playing | `app_closed` | **Real elapsed time** | The app was alive to observe it. A lower bound, since the game keeps running. |
| LaunchPad crashed / machine off | `app_closed` | **0** | The app was *not* alive to observe it, so any duration would be invented |

That distinction is the whole point: the app never fabricates a number it did
not measure. Both paths are verified end to end, including a force-killed app
with a live game.

### Executable types

| Type | Handling |
|---|---|
| `.exe` and normal binaries | Spawned directly |
| `.lnk` | **Resolved** via `shell.readShortcutLink()` to its real target, then spawned — so tracking still works. Its stored args and working directory are merged in, since Steam/GOG shortcuts often carry the only correct ones |
| `.bat` / `.cmd` | Run through `cmd.exe /c` with the path as a separate argv entry, so no shell parsing touches the path |
| `.url` | **Refused**, with an explanation. These hand off to a protocol handler (`steam://…`), leaving no process to watch — a session that could never end would sit "running" forever and corrupt the totals |

Launch arguments are parsed by a hand-written quote-aware splitter rather than
`shell: true`, so a `&` or `|` in a path cannot execute additional commands.

### A bug that shipped, and how it hid

**"When I press Play, nothing happens."** No error, no banner, no session -- the
button flicked back from "Playing" to "Play" and that was all.

`spawn()` has two failure paths. Some failures throw **synchronously**; others
arrive **asynchronously** through the child's `error` event. `EACCES` -- a game
antivirus refuses to start -- takes the async path, which fires *after*
`sessions:launch` has already resolved successfully. The launch thunk therefore
had nothing left to reject with, and the handler only did this:

```js
console.error(`[launcher] failed to start game ${gameId}:`, err)   // message ends here
onSessionEnd({ ..., discarded: true })                             // reason dropped
```

The renderer received a discarded session, indistinguishable from one the user
quit after two seconds. `SessionEndedEvent.launchError` now carries the reason,
the error banner that already existed renders it, and `describeSpawnFailure()`
turns the errno into a sentence -- wired to **both** paths, since fixing one and
leaving the other leaking a raw `spawn EFTYPE` is the obvious way to half-fix
this.

Only the synchronous path can be provoked in a test: producing a real `EACCES`
needs a locked binary or antivirus interference, neither of which a suite can
conjure. The async path is covered by asserting the contract it rides on --
`launchError` present on the event, null for a normal exit -- rather than by
faking the operating system.

Diagnosing it also produced a finding no code change can address. On the dev
machine, `CreateProcess` on `Hades2.exe` returns `EACCES` from Node and Electron,
while `Start-Process` launches the same file fine and a byte-identical copy under
a different name spawns without complaint. ACLs, attributes, manifest
(`asInvoker`) and Mark-of-the-Web were all identical to a sibling executable in
the same folder that works, and Defender logged cloud-protection activity at the
moment of each attempt. LaunchPad cannot launch what the OS refuses to start --
it can only stop pretending nothing happened.

### A bug the tests caught

Testing the graceful-quit path surfaced an unrelated defect: calling
`sessions.launch(undefined)` returned
`Provided value cannot be bound to SQLite parameter 1` — a raw node:sqlite error,
leaked to the user, pointing at the wrong layer entirely.

TypeScript types the IPC contract, but types are erased at runtime and the
renderer is the untrusted side of the boundary. Every id-taking handler now runs
`requireId()` first, so malformed input produces `Invalid game id: null`.
Verified against `undefined`, `null`, strings, negatives, floats and objects.

### Verified — 61 assertions

| Suite | Count | Covers |
|---|---|---|
| Launch & exit (phase A) | 39 | `.url` refusal, real process spawn, running state, double-launch refusal, discard-under-threshold, recorded sessions, duration accuracy, exit codes, crash flagging, missing-exe refusal |
| Crash recovery (phase B) | 7 | Force-killed app → orphaned session closed at startup with duration 0, playtime uninflated, no stale "Playing" badge |
| Graceful quit | 6 | Window closed mid-session → real duration recorded as `app_closed`; reconciliation correctly does *not* fire |
| UI-driven | 11 | Clicking Play flips the badge, process exit clears it with no user action, playtime appears without a refetch, launch errors banner + dismiss |
| Input validation | 8 | Malformed ids rejected with clear messages, no raw SQLite errors leak |

Steps 2 and 3 re-run clean (63 + 26 + 28), so nothing regressed.

### Design decisions

- **Push events, not polling.** A game can exit at any moment. The alternative,
  polling `getRunning()` on a timer, would burn CPU while idle and still lag.
- **The event carries the updated game.** `SessionEndedEvent` includes the game
  with its refreshed playtime roll-up, so the grid updates from the push alone —
  no refetch for a number main already knows.
- **The event bridge is not a React hook.** `startEventBridge()` runs once at
  module level in `main.tsx`, because a game can exit while the library is
  unmounted and that playtime update must still land. It also sidesteps
  StrictMode's double-invoked effects.
- **Running state lives only in `sessionsSlice`.** A `runningGameIds` array in
  `gamesSlice` was removed once sessions owned it — two writers for one fact is
  exactly the duplicated state the store is meant to prevent.
- **`getRunning()` exists for resync.** What is running lives in main-process
  memory; a reload wipes the renderer's copy. `App` re-syncs on every mount.
- **`detached: true` + `unref()`.** The game is a sibling, not a dependent: it
  must survive LaunchPad closing, and Ctrl+C in a dev terminal must not kill it.
- **`stdio: 'ignore'`.** Nothing reads the game's output, and an unread pipe
  fills its buffer and can eventually block the game.
- **Both quit hooks are synchronous.** Electron does not await promises during
  quit, so a promise-based shutdown would silently lose the final writes.
  Sessions are written on `before-quit`, the DB closes on `will-quit`.

### Known limitations

- **Launcher-style games report near-zero playtime.** This is the big one. Games
  that start through a launcher (many Steam titles, Ubisoft Connect, Battle.net)
  spawn the real game as a *separate* process and exit immediately, so the
  tracked child dies seconds after launch. Fixing it properly means watching for
  a child process by name or polling the process table — worth doing, but it is
  a feature in its own right rather than a tweak. Right now such a game records
  a handful of seconds, or is discarded by the minimum-session filter.
- **`crashed` is a heuristic.** A non-zero exit code usually means a crash, but
  some games return non-zero on a perfectly normal quit. The raw exit code
  travels with the event so the UI can show the truth alongside the label.
- **The `app_closed` duration is a lower bound**, since the game keeps running
  after LaunchPad exits.
- **No way to stop a game from LaunchPad.** The child handle exists, so a "Force
  quit" action is feasible, but killing a game mid-save is a good way to corrupt
  the very saves this app protects — it needs a confirmation flow.
- **No live timer.** The Playing badge does not tick; elapsed time appears only
  once the session closes.
- **Playtime is wall-clock, not active time.** A game left paused overnight
  counts every hour.

---

## 5. Save file backup — Done

Save folders are copied into timestamped snapshots automatically before each
launch and after each session, plus on demand, with rotation keeping the total
bounded.

### The ordering rules are the design

Everything in this feature follows from three orderings, each chosen so that an
interruption fails in the recoverable direction:

1. **Copy to `.tmp-…`, then rename.** A snapshot only gets its real name once
   every byte is on disk. `rename` is the commit point. An interrupted copy
   leaves a `.tmp-` folder that nothing lists and startup deletes — never a
   half-copied snapshot that looks restorable.
2. **Write the database row last.** A row is a *promise* that the folder exists
   and is complete. A folder with no row is recoverable disk waste; a row with
   no folder is a restore that fails at the worst possible moment.
3. **Rotation deletes folders before rows.** If a folder delete fails, the row
   stays and the snapshot remains listed and restorable — the safe direction.

### When backups happen

| Trigger | When | Forced? |
|---|---|---|
| `pre_launch` | Before the process starts, awaited | No — skipped if unchanged |
| `post_session` | After the game exits | No |
| `manual` | "Back up now" | **Yes** |
| `pre_restore` | Reserved for step 6 | — |

**Pre-launch is awaited, not fired alongside the launch.** The entire point is
to capture the save state *before* the session can modify it; starting the game
first would race the copy against the game's own writes.

**A backup failure does not block the launch.** The user asked to play; refusing
because a copy failed is a worse outcome than playing with one fewer restore
point. The failure is broadcast so the UI can warn.

**Post-session is fire-and-forget.** The exit handler is driven by a process
event and is synchronous; blocking it on a folder copy would delay the UI update
that clears the "Playing" badge.

**No post-session backup on app quit.** If LaunchPad closes while a game is
still running, copying the save folder mid-play could capture a half-written
save. Skipping is correct.

### Skips are outcomes, not errors

`no_save_folder_configured`, `save_folder_missing`, `save_folder_empty` and
`unchanged_since_last_backup` return a *skip*, not a throw. A game whose saves
do not exist yet must not produce an error banner every single launch.

An **empty** folder is skipped deliberately: an empty snapshot is worse than no
snapshot, because restoring it would wipe the real saves while looking like a
legitimate recovery point.

Skips are still shown in the UI. "Saves have not changed since the last backup"
is the difference between the feature working correctly and the button looking
broken.

### Deduplication (an addition beyond the original spec)

Automatic backups fire twice per session. Without a change check, a five-minute
play session with no save activity would consume two of the ten rotation slots,
halving how far back history reaches. So each snapshot stores a fingerprint, and
an automatic backup whose fingerprint matches the previous one is skipped.

The fingerprint hashes each file's **relative path, size and mtime** — not its
contents. Reading every byte would be exact but turns the check into a second
full read of the save folder. This errs the safe way: a touched-but-identical
file causes a redundant backup (wasted space), while a missed change would lose
data.

Manual backups bypass the check. If a user presses "Back up now", doing nothing
because an mtime heuristic matched would look broken.

This required **schema migration v2** (`content_hash`), the first migration the
project has shipped — see below.

### A bug the tests caught

The first implementation named snapshot folders to whole-second precision.
Two backups in the same second resolved to the **same path**, and the second one
failed when `rename` hit an existing directory.

Not hypothetical: a manual backup next to an automatic one, or a pre-launch
backup followed by a very short session, both hit it. The test caught it as a
cascade of eight failures downstream of one bad assumption.

Fixed by keeping milliseconds in the folder name (still lexicographically
sortable, which rotation relies on), plus a collision counter for the
vanishingly unlikely same-millisecond case.

### Verified — 128 assertions

| Suite | Count | Covers |
|---|---|---|
| Data layer | 76 | Includes the new `content_hash` column and `getLatestBackup` |
| **v1 → v2 upgrade** | 8 | A hand-built v1 database upgrades with games, playtime, settings and backup rows intact; pre-migration rows get a **null** hash, which correctly means "cannot prove unchanged" |
| Backup end-to-end | 42 | Skip cases, real file copying including nested dirs, dedup, rotation, pinning, usage, deletion, validation |
| UI | 10 | Button enabled/disabled state with explanation, status bar success and skip reporting, temp-folder cleanup |

The upgrade suite is the important one: migrations are the only thing that
cannot be fixed after the fact, because a user's data has already been through
them. Building v1 by hand rather than trusting the migration list is what makes
it a real upgrade test.

### Design decisions

- **Rotation reports the ids it deleted**, not a count, so the renderer can drop
  exactly those rows from cached history. A count would leave the UI stale until
  the next fetch.
- **Pinned snapshots are excluded from rotation and do not consume quota.** If
  pins counted toward the limit, enough of them would silently stop new backups
  from being retained at all.
- **A path containment check guards every destructive operation.** Paths come
  from the app's own database, but a hand-edited database must not be able to
  turn rotation into `rm -rf` on an arbitrary directory.
- **Symlinks are not followed.** A link pointing outside the save folder would
  pull unrelated files into the snapshot; a cyclic one would never terminate.
- **Concurrent backups of one game are refused.** Two copies of the same folder
  would race on the temp directory and double-count disk usage.
- **Backups are async (`fs/promises`) while the database stays synchronous.** A
  large save folder copied synchronously would freeze the main process, and with
  it the window.

### Known limitations

- **No compression.** Snapshots are plain folder copies. Simple, inspectable and
  restorable by hand with a file manager — but a 500 MB save folder costs 500 MB
  per retained snapshot. Zipping would trade that for CPU and opacity.
- **No incremental or deduplicated storage between snapshots.** Ten snapshots of
  a mostly-unchanged folder store ten full copies. Hard-linking unchanged files
  would fix this and is the natural next optimisation.
- **The fingerprint trusts mtime.** A game that rewrites identical files bumps
  mtimes and causes a redundant backup. Safe, but wasteful for such games.
- **No per-game overrides.** `maxBackupsPerGame` and the automatic-backup
  toggles are global; a large game cannot be given a smaller limit.
- **No backup while a game is running**, other than manually. Games that
  autosave during long sessions are only captured at exit.
- **Rotation runs only after a successful backup.** Lowering the retention limit
  in settings does not immediately reclaim space; it takes effect on the next
  backup for that game.

---

## 6. Save restore — Done

A snapshot can be restored back over the game's save folder, behind a typed
confirmation, with an automatic undo snapshot taken first.

### The safety model

Restore is the only operation in the app that destroys user data on purpose.
Three mechanisms, in the order they apply:

1. **Every refusal happens before anything is written.** `planRestore()` checks
   the game is not running, the snapshot folder still exists, and a save folder
   is configured — all before a single byte moves. A rejected restore has
   touched nothing.
2. **A pinned `pre_restore` snapshot is taken first.** This is the undo button.
   It is *forced* (the deduplication check exists to avoid redundant routine
   backups; this is the one that must never be skipped) and *pinned* (rotating
   away the undo for a destructive action would defeat its purpose). **If the
   safety backup fails, the restore is abandoned** — overwriting saves with no
   way back is exactly what this feature exists to prevent.
3. **Swap, never overwrite in place.** The snapshot is staged beside the save
   folder, then swapped in with two renames:

   ```
   copy    snapshot        -> .lp-restore-<stamp>
   rename  saveFolder      -> .lp-replaced-<stamp>     (current saves moved aside)
   rename  .lp-restore-... -> saveFolder               (commit)
   delete  .lp-replaced-...
   ```

   If the commit rename fails, the moved-aside folder is renamed back. A copy
   that failed partway through would otherwise leave the save folder as a
   *mixture* of old and new files — the worst outcome, because it looks intact
   and is not.

   Staging happens in the save folder's **parent** so both renames stay within
   one filesystem. `rename` across volumes fails, and a cross-volume fallback
   would reintroduce the partial-copy risk the design exists to avoid.

### Restore is a replacement, not a merge

Restoring snapshot A removes files that were added after A was taken. That is
what "restore to this point" has to mean — a merge would leave a state that
never existed, and for save data that is often worse than either version. The
confirmation says so explicitly, and it is verified.

### Why a typed confirmation

A plain OK/Cancel is too easy to click through for an operation whose blast
radius is "everything in this folder". The dialog also states the **full target
path** — "are you sure?" without naming the target is not informed consent — and
promises the undo snapshot *before* the user decides, rather than revealing it
afterwards.

### The reinstall case

If the save folder does not exist at all — the game was uninstalled and its
saves removed — restore recreates the folder and its parents, and skips the
safety backup (there is nothing to protect). This is the headline use case from
the original brief: *restore them on reinstall*.

### Verified — 52 assertions

| Suite | Count | Covers |
|---|---|---|
| Restore end-to-end | 32 | Content rollback including nested files, replacement-not-merge semantics, the undo round trip, reinstall case, refusal while running, missing snapshot folder, unknown/malformed ids, no staging folders left behind |
| UI | 20 | Confirmation names the folder, warns about newer files, promises the undo, stays disabled until the word is typed, success view points at the undo snapshot, pinned badge shown, running game disables both the button *and* the input |

Highlights worth calling out:

- **The undo actually works**: restore A, then restore the `pre_restore`
  snapshot, and the folder is byte-for-byte back where it started.
- **Refused restores are inert**: after a refusal (game running, snapshot folder
  deleted), the save files are unchanged on disk.
- **Interrupted-restore cleanup is scoped**: planted `.lp-restore-` and
  `.lp-replaced-` folders are removed at startup, while an unrelated dotfolder
  in the same directory is left untouched — this code runs in the user's real
  save directory, not a folder the app owns.

Steps 2–5 re-run clean (76 + 26 + 28 + 8 + 42), so nothing regressed.

### Design decisions

- **`planRestore()` and `performRestore()` are separate.** The safety backup has
  to happen between validation and the swap; splitting the phases is what makes
  that ordering explicit rather than incidental.
- **The backup history list is a modal, not the card.** With restore available,
  the snapshot history is what users need to reach, and a one-click
  destructive-adjacent action sitting next to Delete would be easy to mis-hit.
- **Cleanup only matches the app's own prefixes.** It runs in a directory full
  of the user's real files, so a broader sweep would be unacceptable.

### Known limitations

- **`pre_restore` snapshots accumulate.** They are pinned, so rotation never
  removes them, and pinned snapshots do not consume the retention quota. A user
  who restores frequently will collect them until they unpin or delete them by
  hand. This is a deliberate trade: losing an undo is worse than keeping folders
  that can be deleted in two clicks. Surfacing total backup usage in the step 8
  settings screen is the natural mitigation.
- **No preview of what a restore would change.** The dialog shows the snapshot's
  size, date and file count, but not a diff against the current saves. A
  file-level comparison would make the choice much better informed.
- **No partial restore.** It is all-or-nothing for the whole folder; individual
  files cannot be picked out.
- **Restore does not verify snapshot integrity** beyond the folder existing. A
  snapshot corrupted on disk after it was taken would be restored as-is. The
  stored `content_hash` covers the source folder at capture time, not the
  snapshot's later state — re-hashing it before restore would close this.
- **A game launched outside LaunchPad is invisible.** The running-game refusal
  relies on LaunchPad having started the process; a game started from Steam
  directly will not be detected.

---

## 7. Dashboard UI — Done

The library grid gains a per-game detail view: stats, a 30-day activity chart,
session history and backup history in one place.

### What the detail view shows

| Section | Source |
|---|---|
| Hero — cover, name, executable, Play / Edit / Back up now / Delete | `gamesSlice` |
| Five stat tiles — total playtime, sessions, longest, average, last played | `sessions:getStats` (SQL aggregate) |
| 30-day activity chart | Computed from the session rows already in the store |
| Session history | `sessions:listForGame` |
| Save backups | `saves:listForGame`, via the shared `BackupList` |

Session history, stats and backups are fetched **per game on open** rather than
loaded with the library. Holding every game's history in memory would cost far
more than one round trip.

### Presentation decisions that carry meaning

These are the places where the UI has to be careful not to state more than the
app actually knows:

- **`crashed` renders as "Ended unexpectedly", not "Crashed".** The underlying
  signal is a non-zero exit code, and plenty of games return one on a normal
  quit. Calling it a crash would assert something unknowable; the softer phrasing
  with a tooltip explaining the caveat is the honest version.
- **A zero-duration session reads "Unknown", not "0s".** Zero means the app was
  not alive to measure it (closed by startup reconciliation). "0s" would imply a
  measurement that never happened.
- **`app_closed` renders as "Interrupted"** with a tooltip noting the length may
  be incomplete, since the game may have kept running after LaunchPad closed.
- **The in-progress session is prepended to history** and labelled "Playing now".
  It has no database row yet, so without this the detail view would look
  unchanged after pressing Play.
- **Days with no play still draw a 2px baseline** in the activity chart. Bars
  that vanish entirely make the axis ambiguous — a flat row reads as "no data",
  a baseline reads as "zero".

### Design decisions

- **The card's cover is a real `<button>`, not a clickable div.** The card
  already contains buttons (Play, Edit, Delete), and an `onClick` on the wrapper
  would leave keyboard users no way to reach the card itself. Wrapping the cover
  and title in a button keeps it tabbable and correctly announced, while the
  nested actions stop propagation so they never trigger navigation.
- **`BackupList` was extracted and is now shared** by the detail page and the
  quick-access modal. Restore is the riskiest button in the app; it should have
  exactly one implementation to reason about.
- **The activity chart is plain divs, not a chart library.** One bar per day, no
  axes, tooltip only. A charting dependency would cost more than it returns here.
- **Stats are re-fetched when the cached entry is cleared.** The session-ended
  reducer deliberately drops cached stats so a finished session cannot leave a
  stale average on screen.
- **The detail view handles its game disappearing.** Deleting from the detail
  page returns to the library; a game removed in another window renders a
  message rather than crashing.

### Verified — 30 assertions

Navigation both ways, all five stat tiles computing correctly from seeded
sessions (1h 40m total, longest 1h, average 25m), the exit-reason phrasing
above, the chart rendering exactly 30 bars with only the 3 active days filled,
backups listed with restore reachable, and **live updates while the page is
open**: pressing Play adds "Playing now" immediately, and the finished session
lands in history with the count going 4 → 5 without a reload.

Steps 2–6 re-run clean (76 + 26 + 28 + 8 + 42 + 32 + 20).

### Known limitations

- **The activity chart is built from the fetched session list**, which is capped
  at 100 rows. A game with more sessions in 30 days would under-report. The
  caption says "last 30 days" rather than implying completeness, but a dedicated
  SQL aggregate would be the correct fix.
- **No library-wide dashboard.** Stats are per game; there is no "total hours
  across all games" or "most played this month" view.
- **No sorting or filtering of session history** — newest first, capped at 100.
- **The activity chart buckets by local day** using the session's *start* time,
  so a session spanning midnight counts entirely on the day it began.
- **No deep linking.** Navigation is Redux state, so the open game is not
  restored on restart and there is no back/forward history. This is the
  no-router tradeoff from step 1; a router is the fix if it starts to matter.

---

## 8. Settings screen — Done

Editable preferences, storage reporting, and the cleanup tool for the leftovers
flagged in steps 3 and 6.

### What it exposes

| Setting | Effect |
|---|---|
| Backups folder | Where new snapshots are written (picker + "Open" in the file manager) |
| Backups to keep per game | Rotation limit; pinned snapshots are exempt and do not consume it |
| Back up before launching | Captures the state you are about to change |
| Back up after playing | Captures the progress you just made |
| Minimum session length | Sessions shorter than this are discarded rather than recorded |

Plus **storage**: total snapshot count and size, and a scan for unreferenced
backup folders with one-click cleanup.

### Validation rejects rather than silently clamping

The settings repository already clamps nonsense on read, but clamping a value
the user just typed is a poor experience — they set `0` and see `10` with no
explanation. Main now rejects with a message they can act on
("Keep at least 1 backup per game."), and the repository's clamp stays as the
last line of defence for values that arrive some other way.

Numeric fields **commit on blur or Enter**, not per keystroke. Saving on every
keystroke would send `1`, `12`, `120` while someone types "120" — and for the
minimum-session field those intermediate values briefly change app behaviour.

### Changing the backups folder is safe

It affects **new snapshots only**. Existing ones keep working because every
backup row stores an absolute path, so older snapshots stay listed and
restorable from wherever they were written. Moving them would mean copying
potentially gigabytes with a real chance of failing partway, to solve a problem
the absolute paths already avoid.

### A latent bug this exposed

`assertInsideBackupsRoot()` validated snapshot paths against the **current**
backups root. That was fine until a root change became possible: afterwards,
every pre-existing snapshot would sit outside the configured root, and rotation
and deletion would refuse to touch them — silently, and permanently.

Replaced with `assertLooksLikeSnapshotFolder()`, a **structural** check: the
final path segment must match the snapshot timestamp naming scheme and be nested
at least two levels deep. That still blocks the case the guard exists for (a
hand-edited database pointing `backup_path` at `C:\Windows`) while staying
correct across a root change. Directly verified: a snapshot written under the old
root is still deletable after the root moves.

### Orphan cleanup

Two ways unreferenced folders accumulate, both by design:

- **Deleting a game keeps its backups by default** (step 3) — deliberate, but
  the folders outlive every row that pointed at them.
- **Rotation deletes the folder before the row** (step 5) — a kill between the
  two leaves a folder with no row.

The scan reports; nothing is deleted until asked. **Cleanup re-scans rather than
trusting the paths the renderer sends**: the renderer is the untrusted side of
the boundary and this deletes directories, so only paths a fresh scan still
considers orphaned are removed.

### Verified — 61 assertions

| Suite | Count | Covers |
|---|---|---|
| Settings IPC | 42 | Read/update round trips, 8 distinct validation rejections each with a usable message, a rejected update changing nothing, root change + **the old-root deletion regression**, orphan scan/cleanup precision |
| UI | 19 | Commit-on-blur (and *not* on keystroke), rejection surfaced in-page, toggles persisting, orphan scan → delete → rescan-clean, settings surviving a reload |

Critically: **referenced snapshots are never flagged or deleted** by the orphan
tooling, and a rescan after cleanup finds nothing.

Full suite across all 8 steps: **323 assertions, all passing.**

### Theme was deliberately absent from the UI — since resolved

*Superseded by the [Themes](#themes--done) section below. Kept because the
reasoning is the reason that feature took the shape it did.*

At step 8, `theme` existed in the schema but was not offered, and main rejected
attempts to set it. The UI used Tailwind's default `slate` text scale rather than
tokens, so flipping the background variables alone would have produced
light-on-light text. Shipping a toggle that half-works would have been worse than
not shipping one.

That blocker was cleared later by renaming all 152 `text-slate-*` classes to
`text-content-*`, which is what made the four-theme picker possible. The setting
is now honoured. A **light** theme is still absent, for a different reason that
survived the rename — the status banners are not tokenised.

### Known limitations

- **No per-game setting overrides.** Retention and the automatic-backup toggles
  are global.
- **Lowering the retention limit does not reclaim space immediately** — rotation
  runs after the next backup for a game.
- **The orphan scan only covers the current backups root.** Folders left in a
  previous root after a root change are not found; the referenced ones still work
  from their stored paths, but stale ones there are invisible to the tool.
- **No import/export of settings**, and no way to reset to defaults.

---

## Window chrome — custom title bar + fullscreen

Added after the eight planned features. The default Windows frame painted a
bright system-coloured strip above a near-black app, which made the title bar
the most eye-catching thing on screen.

### The title bar

`titleBarStyle: 'hidden'` removes the system strip and hands the whole 34px band
to the page as a drag region (`surface-950`). `'hidden'` rather than
`frame: false` keeps the OS resize borders and drop shadow.

**Window controls are drawn by the page, not the OS.** This reverses the first
implementation, and the reason is worth recording.

The first version used `titleBarOverlay`, which keeps the *real* system buttons
while recolouring them — preserving Snap Layouts, the hover previews and the
system menu. That is the better arrangement on paper, and it shipped. But
Chromium owns those buttons' hover rendering completely: on a near-black bar the
feedback was reported as invisible, there is no API to restyle it, and because
they are not DOM elements it can be neither inspected nor tested.

Drawing them here trades Snap Layouts for hover states that are ordinary CSS —
tunable, and *verifiable*: the step10 suite moves the real pointer over each
button and asserts the computed background changes, and that close specifically
turns red.

Sizing follows the Windows convention (46x34, full-bleed to the corner so the
close button stays easy to hit when maximised).

**The trade-off, stated plainly:** hovering maximise no longer opens the Windows
11 Snap Layouts menu. If that matters more than hover feedback, reverting is a
small change — restore `titleBarOverlay` in `createWindow()` and drop the
`ControlButton` block from `TitleBar.tsx`.

### Fullscreen

- The icon in the title bar, **F11**, or **Escape** (fullscreen only).
- In fullscreen the title bar unmounts entirely and the app takes the whole
  screen; a faint exit affordance sits top-right so the way out is discoverable
  without knowing the shortcuts.
- Escape leaves fullscreen *only when fullscreen* — it must stay available for
  closing dialogs otherwise, which is verified.
- F11 is bound per-window via `before-input-event`, not `globalShortcut`, which
  would steal F11 from every other app while LaunchPad merely happens to run.

### A race the tests caught

The first version broadcast window state by re-reading the window inside the
event handler. On Windows, **`enter-full-screen` fires before `isFullScreen()`
flips**, so every push arrived one transition behind — entering fullscreen
broadcast `isFullScreen: false`. The UI happened to look right because the
thunk's return value was correct, so only asserting the *pushed payload*
exposed it.

Fixed by treating the event name as the truth: handlers pass the outcome
explicitly rather than asking the window to describe itself mid-transition. The
`setFullScreen` / `toggleFullScreen` handlers do the same, returning the state
being transitioned to.

### Verified — 62 assertions across two suites

**Window chrome (22):** overlay confirmed *not* in use, bar spans the full width
at `rgb(7, 10, 18)` and is draggable, the fullscreen button opts out of the drag
region and sits left of the controls, content starts below the bar, fullscreen
via button / F11 / Escape all work and push correct state, Escape still closes
dialogs when windowed, and a reload re-syncs rather than showing a stale bar.

**Controls and hover (part of the 40-assertion step10 suite):** each control
rests transparent, gains a visible background under a real pointer move, returns
to rest when the pointer leaves, and close turns red specifically. Maximise
toggles the window and the glyph relabels to Restore.

Full suite: **385 assertions across all features.**

### Known limitations

- **Snap Layouts are gone**, as described above — the deliberate cost of
  controllable hover feedback.
- **Window size, position and maximised state are not persisted** across
  restarts, and neither is fullscreen. `isMaximized` is already tracked and
  pushed, so persisting it is a small addition.
- **No menu bar.** `autoHideMenuBar` was already set and the custom title bar
  makes it fully invisible; there is no File/Edit menu and no in-app way to
  reach one. Fine for this app, but worth knowing.
- **The macOS traffic-light inset is a fixed 78px**, not measured. Correct for
  current macOS, but it would need revisiting if Apple changes the spacing.
- **The drag strip has no window title.** Deliberate — the sidebar already
  brands the app — but it means the OS window title is only visible in the
  taskbar and Alt-Tab.

---

## Collapsible sidebar

Collapses to a 56px icon rail and back, via the control in the sidebar header,
beside the logo.

**Placement was a fix, not a preference.** The control first sat at the bottom of
the rail in `slate-600`; it was reported as missing. It was rendering — just dim
and far from where the eye lands. A control that changes the whole layout needs
to be findable more than it needs to be tucked away, so it moved to the header
and gained a border and a normal foreground colour.

**The state is persisted in settings, not just `uiSlice`.** A sidebar that
silently re-expands on every launch is worse than one that never collapsed,
because the preference has to be re-applied every single time. It rides on the
existing key/value settings table, so it needed no migration —
`seedDefaultSettings()` uses `INSERT OR IGNORE`, which adds the new key on the
next start.

Labels are hidden visually but each nav button keeps its `aria-label`, so screen
readers and tests are unaffected by the visual state, and collapsed buttons gain
a `title` tooltip since that becomes the only way to read them.

Settings are now fetched at app level rather than only when the settings page
mounts, because the sidebar reads from them.

**Verified:** starts at 224px, narrows to 56px, labels disappear while the
accessible names survive, the control relabels Collapse/Expand, the choice
persists to settings, and it survives a reload.

---

## Game metadata — Done

Fills in cover art, genres, a summary and a release date, so adding a game does
not mean hunting for box art by hand.

### Three providers, and why

| Provider | Role | Sign-up | Why it exists |
|---|---|---|---|
| **IGDB** | metadata | Twitch app + SMS 2FA | Richest: genres, summary AND portrait box art from one query |
| **RAWG** | metadata | Email only | The no-phone path. Twitch's SMS 2FA fails outright in some countries |
| **SteamGridDB** | art only | Steam login | Portrait box art, which is what makes RAWG usable in a 3:4 grid |

IGDB was built first because one query returns everything. It turned out to have
a hard gate: registering a Twitch application requires two-factor authentication,
and Twitch's SMS delivery fails in a number of countries — the observed error is
*"We weren't able to register two-factor authentication for your phone number"*,
with no workaround, because Twitch only unlocks its authenticator-app option
after a phone number has been verified.

RAWG needs an email address and nothing else. Its weakness is artwork:
`background_image` is a landscape screenshot, and the library grid draws portrait
3:4 cards, so it crops to a useless middle sliver. SteamGridDB supplies community
box art at 600x900 and closes exactly that gap. **RAWG + SteamGridDB is the
recommended pair**, and neither asks for a phone number.

Search priority is `['igdb', 'rawg']`, and the settings screen **states which
provider is in use** rather than leaving it to be inferred from the results.

### How it works end to end

1. **Settings → Game metadata** takes whichever keys you have. Saving verifies
   them against the live service **before storing anything** — a bad key fails at
   the moment it is entered, not later as a search that looks broken.
2. In the add/edit dialog, **the Name field itself is a searchable dropdown**.
   Typing two or more characters searches the provider after a 350 ms debounce
   and lists matches beneath the field, each with a thumbnail, year and genres.
   Arrow keys move, Enter selects, Escape closes the list without closing the
   form. This replaced a separate "Find game info…" panel — looking a game up
   was a deliberate second step when the user is already typing its name.
3. The search runs in main (`electron/services/metadata.ts`), which posts an
   Apicalypse query to IGDB, maps the response, and fetches each result's
   thumbnail.
4. Choosing a result fills the Name field immediately — visible and still
   editable — and records the match.
5. Saving writes genres, summary, release date and provenance, then downloads
   the full-size cover into the managed covers folder.

### The renderer still opens no sockets

This is the constraint that shaped the design. The renderer's CSP sets
`connect-src 'none'` and the point was to keep it that way, so:

- **Search thumbnails are `data:` URIs produced in main**, not remote URLs.
  `img-src` already allowed `data:`, so adding this entire feature **changed the
  CSP by nothing**.
- Only the full-size cover touches the disk, and only when a match is applied.
  It goes through the same managed-covers pipeline as a hand-picked image, so it
  is served by the existing `lpasset://` handler with its existing containment
  check.

### The credentials are not a setting

`settings:get` returns the whole `AppSettings` object to the renderer, so a
secret placed there would sit in the Redux store and be readable from devtools.
Credentials live in `db/repositories/credentials.ts` instead — same table,
deliberately not the same surface, under derived `cred_<provider>_<field>` keys
so adding a provider needs no change there at all. The renderer only ever
receives `{configured, maskedKey, hasCachedToken}`, and the suite asserts the key
appears in neither that payload nor `settings:get`.

The settings screen renders each provider from a `ProviderDescriptor` that main
supplies — name, blurb, sign-up URL and field list. Nothing in the UI names a
provider, so adding a fourth is a main-process change plus a union member.

The OAuth token is cached in SQLite, not memory: IGDB tokens last around sixty
days, so re-authenticating per app start would waste a request against a
rate-limited endpoint and would fail the session's first search whenever the
network happened to be down at launch.

### Ordering, and why a failed cover is not a failed apply

`metadata:apply` writes the local fields first and downloads the cover last.
A download failure therefore leaves the genres and summary applied and returns
`coverError` — a partial success — rather than discarding work that succeeded.
The dialog stays open and says exactly that. Closing silently would be the app
claiming a result it did not achieve.

The dialog also remembers that it already created the row, so retrying after a
metadata failure updates that game rather than adding a second copy of it.

### A cover the user picked always wins

If the user chose their own image *and* a match, the downloaded art is skipped
and the dialog says so before saving. They made that choice deliberately;
replacing it with a guess would discard an explicit decision.

### Injection was a real consideration

Apicalypse is a query language and the search term is interpolated into it — the
same shape of problem as SQL injection. `escapeApicalypse()` escapes backslashes
and quotes so a term cannot close the string literal, and strips `;` and newlines
so it cannot append a clause. The suite asserts a crafted term produces exactly
one `search` clause in the outgoing body.

### Two bugs the suite caught

Both compiled cleanly and would have shipped:

1. **`verify()` cached IGDB's token, then storing the credentials wiped it.**
   Writing credentials deliberately clears any cached token, because one minted
   by the old pair cannot authenticate the new one — so the token proven good
   during verification was destroyed moments later and the next search silently
   re-authenticated. `verify()` now *returns* the token and the registry persists
   it after the credentials land.
2. **Adding `'rawg'` to `MetadataSource` did not force the enum lists to update.**
   `readonly MetadataSource[]` accepts a short array happily, so
   `const METADATA_SOURCES: readonly MetadataSource[] = ['igdb']` still compiled,
   then threw `Column "metadata_source": rawg is not one of igdb` the first time
   RAWG metadata was applied. Both lists are now `Record<MetadataSource, true>`
   plus `Object.keys()`, which makes a missing member a compile error — the
   outcome the union was supposed to guarantee in the first place.

### Header presentation

The header is `clamp(420px, 58vh, 600px)` and shows its backdrop **unblurred**,
including when the cover is standing in for missing wide art. The blur it used to
carry hid the only artwork the game had; `object-cover` centre-crops instead,
which reads as a zoom rather than a claim, and the fallback stays distinguishable
in the DOM for the tests that guard it. Removing the blur required re-tuning all
the scrims — values tuned over a blur crushed real key art to near-black, and
every assertion still passed while it did, because a testid proves an image is
present, not that it is visible.

Genres are **pills under the play controls**. They were previously one row of a
translucent six-row panel on the right, which duplicated four tiles of the stat
grid immediately below it and covered the artwork the header exists to show. The
panel is gone; its one unique row (Backups) became a sixth stat tile, so nothing
was lost. The null-versus-empty wording survives — pills are skipped for both
cases and `formatGenres()` renders "Not looked up" or "None listed" instead.

Provider summaries run long enough to push the stats and the activity chart off
the first screen, so the synopsis clamps to three lines behind a **Read more**
toggle. The toggle appears only when the text actually exceeds the threshold,
so it never offers a click that changes nothing.

### Viewing artwork, and admitting when there is none

Cover art is drawn at 80-128px. Real box art carries a title and small print that
is unreadable at that size, so every cover — in the form, on the detail header —
opens full size on click. The viewer is deliberately not part of `uiSlice`'s
modal union: it is a detail *of* the game form, not a second dialog competing
with it, and registering it there would either close the form underneath or break
the "one modal at a time" invariant. It sits at `z-[60]`, and both it and the
combobox stop Escape from propagating to `Modal`'s document listener — otherwise
one keypress would discard everything the user had typed.

Absent artwork is **stated in words**. A bare placeholder is ambiguous: it reads
equally as "this game has no art" and "the art failed to load". Cards and the
detail header show the game's initials plus "No cover", the form says "No cover
image" (or "None yet — one will be downloaded when you save" when a match is
pending), and a suggestion row with no thumbnail says "No art".

### Verified — 110 assertions

Run against a **local stub HTTP server**, not the real IGDB: live credentials
should not be committed, the rate limit is shared with whatever the developer is
doing, and a network round trip makes a suite fail for reasons unrelated to the
code. Every base URL in the service is overridable through the environment
precisely so the suite can redirect it, and `tests/run.mjs` grew a `setup()` hook
so a suite can stand the stub up before the app spawns.

Covered: not-configured messaging, rejected keys not being stored, the secret not
crossing back, search mapping for two providers, empty-vs-missing genres,
thumbnails arriving as data URIs, lazy enrichment costing exactly one request,
SteamGridDB replacing a landscape cover with a portrait one, provider priority
when several are configured, token reuse, query injection, apply with and without
a cover, the row on disk matching what was reported, nine malformed-input cases,
and credential removal taking the cached token with it.

### Known limitations

- **The user must register their own key.** There is no shared one and should not
  be: a key committed to a public repository is a key that gets revoked.
- **IGDB is unreachable without SMS two-factor on a Twitch account**, which fails
  in some countries. RAWG exists for that reason and is a first-class source, not
  a fallback.
- **RAWG artwork is landscape** and crops badly without SteamGridDB alongside it.
- **Art matching is by name.** SteamGridDB is queried with the game's title and
  the first autocomplete hit is used, so an oddly-named entry can match the wrong
  game's art. A manual override is the obvious next step.
- **Only one art provider is consulted**, at apply time only.
- **No bulk matching.** One game at a time, from its edit dialog. Matching a
  whole library needs rate limiting, partial-failure reporting and a review step
  before applying — a feature in its own right.
- **Nothing re-fetches.** `metadata_id` and `metadata_updated_at` are stored so
  a refresh can re-query the exact entry rather than re-searching by name, but
  no code calls it yet.
- **The summary is stored but never displayed** outside the picker. Showing it
  on the detail page is pure UI work with no backend left to do.
- **Genres are not filterable or shown in the library.** They are stored as a
  JSON array precisely because nothing queries them individually yet; filtering
  is what would justify a join table and an index.
- **`MetadataSource` is a union** rather than a free string so adding a provider
  forces every switch over it to be revisited — but note the enum-list trap
  recorded above: an array literal typed as the union is *not* checked for
  exhaustiveness.
- **Credentials are stored in plaintext.** On a single-user desktop app the
  database is already readable by anyone who can read the user's profile, so
  encrypting it with a key stored beside it would be theatre.

## Game detail header — Done

The per-game page opens with full-bleed key art: the game's wide artwork
behind the title, the cover thumbnail, the action buttons and a translucent
information panel. Modelled on a console store page, which is the layout that
answers "what is this game and do I want to open it" in one screen.

### Where the artwork comes from

All three providers can supply it, and two of them for free:

| Provider | Source | Cost |
|---|---|---|
| **SteamGridDB** | `/heroes/game/{id}` | One extra request at apply time |
| **RAWG** | `background_image` | **Nothing** — already in the search response |
| **IGDB** | `artworks.image_id` at `t_1080p` | **Nothing** — one more field on the same query |

SteamGridDB wins when configured, because its heroes are *composed* as banners:
subject off to one side, room for a title. RAWG's and IGDB's wide images are
screenshots and concept art that merely happen to be landscape.

**RAWG's case is the neat one.** Its `background_image` is a landscape
screenshot — the exact reason it makes a poor 3:4 cover and the reason
SteamGridDB exists in this project. As a backdrop it is the right shape, so the
field that fails one job does the other well, at zero extra cost.

### The backdrop degrades in three visible steps

1. **Wide art** — what the feature is for.
2. **The cover, blurred and scaled** — a colour wash. Not a claim: the
   unblurred original sits a few pixels away in the thumbnail, so nothing
   suggests the game has key art it does not have.
3. **A plain gradient, with the absence stated** — "No artwork". A bare gradient
   reads equally as "no art" and "the image failed to load", the same ambiguity
   the grid cards avoid by saying "No cover".

Each state carries its own `data-testid`, because the failure worth guarding is
the header rendering the *cover* as though it were wide art — which looks
entirely plausible and is wrong.

### Design decisions worth knowing

- **A separate column, not a reused `cover_image_path`.** A game can have box
  art and no hero; SteamGridDB carries grids for far more titles than heroes.
  Collapsing them would mean stretching portrait art across the header or
  emptying the grid card.
- **The file lives in the existing covers folder.** Same `lpasset://` handler,
  same download guards, same `deleteCoversForGame()` prefix sweep. A second
  directory would have duplicated all three for no gain — the namespace names
  the directory, not the shape of what is in it.
- **Cover and hero download independently and report separate errors.** They
  fail for different reasons with different consequences: no cover leaves a
  blank grid card, no hero only drops the page to fallback. One combined error
  could not say which happened.
- **`swapArtwork()` takes a `keep` argument.** Cover and hero can be the *same
  file* — a RAWG-only setup writes one landscape image to both columns — so
  replacing the cover would otherwise delete the file the hero still points at.
- **Applying twice from RAWG downloads its image once.** Content hashing means a
  second fetch produces the identical file, so the repeat costs only the round
  trip. The e2e suite asserts the count, because that waste is invisible
  otherwise.
- **Four scrim layers, not one gradient.** A flat wash, a bottom fade into the
  page, a left darkening under the text, and a top darkening under the back
  control. Tuned independently; one many-stop expression stops being editable by
  anyone but its author.
- **A `glass` Button variant** rather than extra classes at the call site. Two
  `bg-*` utilities on one element resolve by their order in the generated
  stylesheet, not in the class attribute, so "override it inline" works or does
  not depending on what Tailwind emitted last.

### Verified — 14 assertions in `detail-view`, 9 in `metadata`

The detail suite walks all three backdrop states in order and checks the
transitions, not just the end state. The metadata suite asserts that RAWG writes
one file to both columns and fetches it once, and that with SteamGridDB
configured the two columns hold **different** files — storing one image in both
is the failure that looks right on one screen and wrong on the other.

The stub server serves genuinely different bytes for the grid and the hero. It
had to: managed artwork is named by a hash of its content, so a stub returning
the same pixels for both would collapse them into one file and make the whole
assertion vacuous.

### Known limitations

- **Nothing back-fills existing games.** `hero_image_path` is written only when
  metadata is applied, so a library matched before this change shows the blurred
  cover until each game is re-matched. A refresh action is the fix and does not
  exist yet — the same gap `metadata_id` was stored to close.
- **No way to set wide art by hand.** There is no picker, and the field is
  deliberately not part of `NewGame`, so a game the providers do not carry can
  only fall back.
- **The blurred-cover fallback is soft**, because it is a 300x400 image scaled
  across a full-width header. Acceptable as a colour wash; it is not artwork.
- **Hero coverage is thinner than box art** even on SteamGridDB, so a
  correctly-matched game can still have no wide image.
- **One image, no art direction.** The first entry the provider returns is used;
  IGDB orders `artworks` by upload rather than quality, and inventing a ranking
  would be guesswork dressed as selection.
- **The header is not responsive below roughly 900px** — the info panel wraps
  under the title rather than collapsing. The window has a minimum size that
  keeps it above that, so this has not bitten yet.

## Themes — Done

**Settings → Appearance** offers four palettes. The original is preserved
unchanged as the default; three were added alongside it.

| id | Label | Look |
|---|---|---|
| `dark` | Midnight | The original — cool blue-black surfaces, blue accent |
| `nebula` | Nebula | Neutral near-black, violet accent |
| `ember` | Ember | Warm charcoal, orange accent |
| `verdant` | Verdant | Deep green-black, teal accent |

### How it works

Tailwind v4 compiles `bg-surface-900` to `background-color:
var(--color-surface-900)` — a live custom-property reference, not an inlined
hex. So a theme is a block that redefines sixteen variables, and switching one
repaints the entire app through the cascade: no component re-renders for colour,
no class names change, and a new theme touches exactly one file.

Three ramps cover everything themed: `surface-*` (backgrounds, 950→600),
`content-*` (text, 100→700) and `accent-*` (the one interactive hue).

### The prerequisite this needed

The theme setting existed in the schema from the beginning and main **refused to
set it**, because the UI hardcoded 152 `text-slate-*` classes. Flipping the
background variables alone would have produced light-on-light text — so the
setting was honestly rejected rather than stored-and-ignored.

Making themes possible was that rename: `text-slate-N` → `text-content-N`, all
152 of them. Backgrounds and borders were already tokenised, which is why the
change was mechanical.

**`content-*` is a lightness ramp, not semantic names** (`fg-primary`,
`fg-muted`). Deliberate: retrofitting semantics onto 152 call sites means judging
the intent of each one and getting some silently wrong. A ramp maps 1:1 onto what
the code already said, so the migration was reviewable — and a theme still
defines all seven steps however it likes.

### Design decisions worth knowing

- **`dark` keeps its id** rather than being renamed to `midnight`. Existing
  databases store the string `dark`, and the parser falls back to the default
  for anything unrecognised — a rename would silently reset the theme of every
  upgrading install. A display label costs nothing.
- **The override selector is `[data-theme=…]`, unanchored.** `:root[data-theme]`
  matches `<html>` only, which would make the picker's swatches all render in
  the active theme. Unanchored, a swatch previews its own palette by nesting the
  attribute — so **the picker contains no colour values at all** and cannot
  drift from the palettes.
- **The attribute goes on `<html>`.** `body` and the scrollbar rules live outside
  the React tree and would otherwise keep the old colours.
- **The active theme is stated in words** ("Active"), not signalled only by a
  ring. Which of four similar dark swatches is selected is exactly what a
  colour-only cue fails to answer.
- **`ThemeId` is enumerated as `Record<ThemeId, true>`**, per the trap recorded
  in the metadata section: an array literal typed as the union accepts a short
  list and fails at runtime.

### Verified — 29 assertions (`tests/suites/themes.mjs`), plus 3 in `settings`

The assertions read `getComputedStyle` and compare real `rgb()` output, not the
attribute. A theme that sets `data-theme` correctly while every utility keeps its
previous colour is a passing attribute test and a broken feature — which is what
would happen if Tailwind ever inlined theme values, or if the override blocks
landed in a cascade layer that loses to `:root`.

Also covered: persistence across reload and restart, rejection of unknown themes
(including the removed `light`), that all four swatches paint differently, and
that the `@theme` defaults still match the `[data-theme='dark']` block — the two
copies of the default palette that exist for reasons explained in `index.css`.

### Known limitations

- **There is no light theme, and the union no longer contains one.** Status
  banners (`bg-red-950`, `text-emerald-200`, `bg-amber-950`) are fixed dark-mode
  colours outside every ramp, so a light surface would render them dark-on-dark.
  Tokenising those is the work a light theme needs. It is absent rather than
  present-and-broken — the same call the setting has carried since it was added.
- **Themes change colour only, not shape or density.** Corner radii, spacing and
  the sidebar layout are the same in all four.
- **A stored theme that is later removed from the union resets to `dark`** rather
  than being migrated to a near equivalent. Correct for `light`, which had no
  equivalent; worth revisiting if a palette is ever renamed.
- **One frame of default palette on a cold start.** The renderer paints before
  the settings round trip resolves, so a non-default theme technically arrives a
  frame late. Not observable in practice against a local SQLite read, and the
  fix (caching the id outside the store for first paint) would add a second
  source of truth for a problem nobody has reported.

## Sample data (development only)

Settings gains a **Developer** section with "Add sample data": eight games with
generated cover art, session history spread across the last 30 days, real save
folders, and four snapshots (one pinned).

Everything it creates is real — the executables and save folders exist on disk
under `<userData>/demo/`, and the covers are genuine PNGs written by a ~40-line
encoder using `node:zlib`. Fake paths would make the library *look* right while
every action on it failed, which is less useful than an empty library for
judging the UI. Demo games are fully backup- and restore-capable; only launching
them fails, since the executables are inert placeholders.

**Gated in main, not just the UI.** `import.meta.env.DEV` removes the section
from the production bundle, and the handler independently refuses when
`app.isPackaged`. The renderer decides what to render; it does not decide what
capabilities exist.

Re-running adds nothing — it skips games already present by name, so it is safe
against a database in use.

### A bug the tests caught

The seeder first wrote the generated cover path straight into the game row,
bypassing `importCover()`. The files therefore lived outside the managed covers
folder that the `lpasset://` handler serves, so every demo cover was a broken
image. Every generated file was also literally named `cover.png`, so they would
have collided in the URL space regardless. Fixed by routing through
`importCover()` exactly as the `games:create` handler does.

**Verified:** 8 games, 40+ sessions and 4 backups created; covers decode in the
renderer at 300x400; playtime accumulates; one game is deliberately never played
so the empty state stays visible; a second run adds nothing; and a demo game can
be backed up through the normal path.

---

# Packaging status

Flagged as unverified since step 1 and finally exercised at step 8. The result
is mixed, and the reasons are environmental rather than defects in the project.

## What works

**`npm run build` and the packaged application both work.** `npm run dist`
produces `release/0.1.0/win-unpacked/LaunchPad.exe` with the app in `app.asar`,
and that executable was launched and driven through the IPC test suite:
8/8 passing, with the database created correctly under its own `userData`. This
is the first confirmation that the production build works outside `electron-vite`
— in particular that asar path resolution for the preload script and the renderer
`index.html` is correct.

## What does not work here

**The NSIS installer step fails on this machine.**

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
  ...winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

electron-builder downloads a `winCodeSign` bundle that contains macOS symlinks.
Creating symlinks on Windows requires either **Developer Mode** or an elevated
shell. Enable Developer Mode (Settings → System → For developers) or run the
build from an admin terminal, and the installer step should complete.

## Why electron-builder is pinned to 25.x

electron-builder **26.x cannot run at all on this machine.** Its dependency
collector invokes npm through `powershell.exe -EncodedCommand`, and that
invocation is blocked here:

```
Program 'npm.CMD' failed to run: Access is denied
```

Reproduced directly, outside the build and outside any sandbox, so it is a
machine policy (AppLocker / EDR / software-restriction policy blocking batch
execution from PowerShell) rather than anything about this project. The npm
command itself runs fine when invoked normally — only the PowerShell-wrapped
spawn is denied.

The failure mode is unhelpful: the collector writes npm's stdout to a temp file,
gets zero bytes, and reports `No JSON content found in output`. It also *throws*
rather than returning empty, which skips electron-builder's own `TRAVERSAL`
fallback that would otherwise have handled this.

Version **25.1.8** uses a different spawn path and gets through. It is pinned in
`package.json` for that reason alone. **Move back to 26.x once the PowerShell
policy allows it** — nothing in this project depends on staying on 25.

Worth noting: LaunchPad has **zero production dependencies** (Vite bundles
everything into `out/`), so the dependency-collection step that fails is pure
overhead for this project. `"npmRebuild": false` is set in
`electron-builder.json` for the same reason — there are no native modules to
rebuild.

## Before shipping

- Add `build/icon.ico`, or the app ships with the default Electron icon.
- Set `author` in `package.json` — electron-builder warns it is missing.
- Code signing is not configured; unsigned installers trigger SmartScreen.
