# Code Flow

Step-by-step traces of each major user action: which file, which function, in
order. Flows are added as their features land.

Currently traced:

- [Startup](#startup) — done
- [Database open and migration](#database-open-and-migration) — done
- [Load app info (the reference IPC round trip)](#load-app-info) — done
- [Navigate between views](#navigate-between-views) — done
- [Add game](#add-game) — done
- [Edit game](#edit-game) — done
- [Delete game](#delete-game) — done
- [Launch game and track a session](#launch-game-and-track-a-session) — done
- [Game exits](#game-exits) — done
- [Shutdown and crash recovery](#shutdown-and-crash-recovery) — done
- [Back up saves](#back-up-saves) — done
- [Restore saves](#restore-saves) — done
- [Open a game's detail view](#open-a-games-detail-view) — done
- [Change a setting](#change-a-setting) — done
- [Reclaim orphaned backup folders](#reclaim-orphaned-backup-folders) — done
- [Toggle fullscreen](#toggle-fullscreen) — done
- [Look up game info from a metadata provider](#look-up-game-info-from-a-metadata-provider) — done

---

## Startup

What happens between double-clicking the app and seeing a window.

| # | File | Function / line | What happens |
|---|---|---|---|
| 1 | `electron/main.ts` | `app.requestSingleInstanceLock()` | Fails fast if another copy is running. A second instance would open a second SQLite connection and could double-count sessions; instead it focuses the existing window via the `second-instance` handler. |
| 2 | `electron/main.ts` | `app.whenReady()` | Waits for Electron to initialise. |
| 3 | `electron/main.ts` | `setupDatabase()` | Opens and migrates the database — see the next flow. Runs **before** handler registration, so no query can arrive before the connection exists. |
| 4 | `electron/ipc/app.ts` | `registerAppHandlers()` | Registers `app:getInfo`. **Runs before any window is created**, so the renderer can never invoke a channel that is not yet listening. |
| 5 | `electron/main.ts` | `createWindow()` | Creates the `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `show: false`. |
| 6 | `electron/preload.ts` | module body | Runs in the isolated bridge context before page scripts. Calls `contextBridge.exposeInMainWorld('api', api)`. |
| 7 | `electron/main.ts` | `loadURL` / `loadFile` | Dev: loads `process.env.ELECTRON_RENDERER_URL` (Vite server) and opens detached devtools. Prod: loads `out/renderer/index.html` from disk. |
| 8 | `index.html` | `<script src="/src/main.tsx">` | Renderer entry. |
| 9 | `src/main.tsx` | `ReactDOM.createRoot(...).render()` | Mounts React inside `<Provider store={store}>`. |
| 10 | `src/store/store.ts` | `configureStore()` | Combines the five slice reducers. |
| 11 | `src/App.tsx` | `useEffect` | Dispatches `fetchAppInfo()` — see the next flow. |
| 12 | `electron/main.ts` | `'ready-to-show'` handler | Shows the window only once the renderer has painted, avoiding a white flash against the dark UI. |

---

## Database open and migration

Runs once at startup, before any window or IPC handler exists.

| # | File | Function | What happens |
|---|---|---|---|
| 1 | `electron/main.ts` | `setupDatabase()` | Resolves `<userData>/launchpad.db` and `<userData>/backups`. Wrapped in try/catch: a failure shows an error dialog and calls `app.exit(1)` rather than opening an empty-looking library. |
| 2 | `db/client.ts` | `initDatabase()` | Creates parent directories, then opens `DatabaseSync` with `enableForeignKeyConstraints: true`. |
| 3 | `db/client.ts` | pragma block | Sets `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`. |
| 4 | `db/schema.ts` | `runMigrations()` | Reads `PRAGMA user_version`. Refuses to continue if the DB is newer than this build. Applies each pending migration inside a transaction that also bumps `user_version`. |
| 5 | `db/client.ts` | `seedDefaultSettings()` | `INSERT OR IGNORE` for every key in `SETTINGS_KEYS`, so an existing user value is never reset. `backups_root_path` gets the runtime-resolved path. |
| 6 | `electron/main.ts` | `setupDatabase()` | Stores `{ dbPath, schemaVersion }` in a module-level variable that `app:getInfo` reads. |
| 7 | `electron/main.ts` | `'will-quit'` | `closeDatabase()` runs `wal_checkpoint(TRUNCATE)` and closes, so the `.db` is self-contained on disk. |

**Repository call shape.** Every future data operation follows the same path
inside main: an IPC handler calls a repository function from `db/index.ts`,
which calls `getDb()` and runs prepared statements synchronously. Writes that
touch more than one table are wrapped in `transaction()`. Rows are converted to
domain objects by the mappers in each repository, using the typed readers in
`db/row.ts` — so a column mismatch throws with the column name at the point of
mapping, not as an `undefined` three layers later.

---

## Load app info

The reference IPC round trip. **Every later async feature follows this exact
shape**, so it is worth reading once in full.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/App.tsx` | `useEffect` dispatches `fetchAppInfo()` on mount. |
| 2 | Renderer | `src/store/slices/settingsSlice.ts` | `createAsyncThunk('settings/fetchAppInfo')` fires. RTK immediately dispatches `fetchAppInfo.pending`. |
| 3 | Renderer | `src/store/slices/settingsSlice.ts` | Reducer sets `status = 'loading'`, clears `error`. |
| 4 | Renderer | `src/store/asyncStatus.ts` | `unwrap()` calls `window.api.app.getInfo()` and awaits the envelope. |
| 5 | Bridge | `electron/preload.ts` | The whitelisted `app.getInfo` method calls `ipcRenderer.invoke(Channels.app.getInfo)`. Arguments and return values are structured-cloned — no live objects cross. |
| 6 | Main | `electron/ipc/handle.ts` | The `handle()` wrapper receives the call inside a try/catch. |
| 7 | Main | `electron/ipc/app.ts` | The handler reads `app.getVersion()`, `process.versions.*`, `process.platform`, `app.getPath('userData')` and returns an `AppInfo`. |
| 8 | Main | `electron/ipc/handle.ts` | Wraps it as `{ ok: true, data }`. On a throw it would log server-side and return `{ ok: false, error: message }` instead. |
| 9 | Renderer | `src/store/asyncStatus.ts` | `unwrap()` sees `ok: true` and returns `data`. Had it been `ok: false`, it would `throw new Error(result.error)` here — which is what routes failures into the thunk's rejected case. |
| 10 | Renderer | `src/store/slices/settingsSlice.ts` | `.fulfilled` sets `status = 'succeeded'` and `appInfo = payload`. (`.rejected` would set `status = 'failed'` and `error = action.error.message`.) |
| 11 | Renderer | `src/pages/SettingsPage.tsx` | `useAppSelector((s) => s.settings)` re-renders with the live values. |

**The pattern to copy:** thunk → `unwrap(window.api.<domain>.<method>())` →
preload whitelist → `handle()` → domain handler → envelope → slice
`pending/fulfilled/rejected`. No component ever calls IPC directly, and no
handler ever throws across the boundary.

---

## Add game

The first flow that writes data. Everything after this follows the same shape.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/pages/LibraryPage.tsx` | `+ Add game` dispatches `modalOpened({ kind: 'addGame' })`. |
| 2 | Renderer | `src/App.tsx` | `ModalHost` reads `ui.modal` and renders `GameFormModal` with no `game` prop (add mode). |
| 3 | Renderer | `src/components/GameFormModal.tsx` | `Browse…` dispatches the `pickExecutable` thunk. |
| 4 | Bridge → Main | `preload.ts` → `ipc/games.ts` | `games:pickExecutable` opens a native `dialog.showOpenDialog`, parented to the app window. Returns the path or `null` if cancelled. |
| 5 | Renderer | `GameFormModal.tsx` | Fills the path field. If the name box is still empty, `suggestNameFromExecutable()` derives one (`hollow_knight.exe` → "Hollow Knight"). Runs locally so there is no IPC round trip for a string transform. |
| 6 | Renderer | `GameFormModal.tsx` | On submit, dispatches `createGame(payload)`. |
| 7 | Renderer | `src/store/slices/gamesSlice.ts` | A matcher sets `mutationStatus = 'loading'`, disabling the submit button. |
| 8 | Renderer | `src/store/asyncStatus.ts` | `unwrap()` calls `window.api.games.create(input)`. |
| 9 | Main | `electron/ipc/games.ts` | Validates name, executable (exists + is a file), working directory, save folder (may not exist yet, but must not be a file), and pre-validates the cover. |
| 10 | Main | `db/repositories/games.ts` | `createGame()` inserts and returns the row, with the id SQLite assigned. |
| 11 | Main | `electron/services/covers.ts` | `importCover()` hashes the file, copies it to `<userData>/covers/<id>-<hash>.<ext>`, returns the managed path. On failure the row is deleted and the error rethrown, so a reported failure leaves nothing behind. |
| 12 | Main | `electron/ipc/games.ts` | `updateGame()` writes the managed cover path; the complete `Game` is returned. |
| 13 | Renderer | `gamesSlice.ts` | `createGame.fulfilled` → `gamesAdapter.addOne`. |
| 14 | Renderer | `GameFormModal.tsx` | `.unwrap()` resolved, so the modal dispatches `modalClosed()`. On rejection it stays open with the user's input intact and shows `mutationError`. |
| 15 | Renderer | `LibraryPage.tsx` | `selectVisibleGames` recomputes and the grid renders the new card. |

**Cover rendering:** `GameCard` calls `coverUrl(game)`, which returns
`lpasset://cover/<basename>`. The `lpasset` handler in
`electron/services/assetProtocol.ts` resolves that name inside the covers folder
and streams the file back with `net.fetch`. Only the basename is sent, because
the handler rejects anything that escapes the directory.

---

## Edit game

Differs from add in three places.

| # | File | What happens |
|---|---|---|
| 1 | `src/components/GameCard.tsx` | The hover ✎ button dispatches `modalOpened({ kind: 'editGame', gameId })`. |
| 2 | `src/App.tsx` | `ModalHost` looks the game up with `selectGameById` and passes it in. If it is missing (deleted elsewhere) it renders nothing rather than crashing. |
| 3 | `GameFormModal.tsx` | Initial form state comes from the game. |
| 4 | `GameFormModal.tsx` | On submit, the cover is sent **only if it changed** — otherwise `coverImagePath: undefined` omits it, so main does not re-hash an unchanged file. |
| 5 | `electron/ipc/games.ts` | Only keys present on the patch are validated and written; omitted fields are untouched. A replaced cover is imported first, and the old file removed only after the new one is safely written. |
| 6 | `gamesSlice.ts` | `updateGame.fulfilled` → `gamesAdapter.setOne`. |

---

## Look up game info from a metadata provider

The only flow that reaches the network. Every network hop happens in main: the
renderer sends a string and receives mapped results. Which provider answers is
decided by `electron/services/metadata.ts`, the registry — the steps below are
the same whichever one it picks.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/GameFormModal.tsx` | The Name field is a `NameCombobox`, not a plain input — there is no separate "search" step to take. |
| 2 | Renderer | `src/components/NameCombobox.tsx` | Dispatches `fetchMetadataStatus`. If no provider is configured it says so and names Settings — it does **not** render an empty result list, because "not set up" and "no matches" must not look alike. |
| 2b | Renderer | `NameCombobox.tsx` | Typing schedules a search 350 ms later, and only from 2 characters. A request per keystroke would spend RAWG's monthly quota on prefixes nobody wanted results for. |
| 3 | Renderer | `src/store/slices/metadataSlice.ts` | `searchMetadata(term)` stores the term in `state.query` so a stale response can be recognised later. |
| 4 | Main | `electron/ipc/metadata.ts` | Validates the query as text within length limits. |
| 5 | Main | `electron/services/metadata.ts` | The registry picks the active provider by `SEARCH_PRIORITY` (`igdb`, then `rawg`) and hands it the stored credentials. |
| 6 | Main | `providers/igdb.ts` | *IGDB path:* reads the cached token from SQLite — unexpired with 60 s of slack → reuse, else mint one from Twitch. `escapeApicalypse()` escapes quotes and strips `;`/newlines, then `POST /v4/games` behind a 260 ms throttle (4 req/sec). A `401` clears the token and retries **once**, distinguishing a revoked token from a bad secret. |
| 6b | Main | `providers/rawg.ts` | *RAWG path:* a keyed `GET /games`. No description is requested here — fetching one per row would make a single search thirteen requests against a monthly quota. |
| 7 | Main | provider | Maps each entry to the same `MetadataSearchResult`, tagged with its `source`. Release dates normalise to `YYYY-MM-DD`; genre objects become names. |
| 8 | Main | `providers/http.ts` | `attachThumbnails()` fetches every thumbnail **concurrently** and inlines it as a `data:` URI. Concurrent because these hit an image CDN, not the rate-limited API; serialising a dozen would add ~3 s per search. A failure yields `null` and never fails the search. |
| 9 | Renderer | `metadataSlice.ts` | `fulfilled` compares the echoed `query` against `state.query` and **discards** the response if they differ, so a slow earlier search cannot overwrite the results on screen. |
| 10 | Renderer | `GameFormModal.tsx` | Choosing a result fills the Name field immediately (visible and still editable) and stores the match. Nothing is written yet. |
| 11 | Renderer | `GameFormModal.tsx` | On submit the game is created or updated **first**, by the ordinary `games:create` / `games:update` path. `savedGameId` is recorded so a retry cannot create the game twice. |
| 12 | Renderer | `GameFormModal.tsx` | Then dispatches `applyMetadata`. `applyCover` is false if the user picked their own image — an explicit choice outranks a downloaded guess. |
| 13 | Main | `electron/ipc/metadata.ts` | Re-validates the entry. It did a round trip through the renderer, so it is now untrusted input: `source` must be a known provider, genres must be a list, the release date must match `YYYY-MM-DD`, the cover URL must be `http(s)`. The thumbnail is discarded rather than trusted. |
| 13b | Main | `services/metadata.ts` | `enrichResult()` asks the originating provider for anything its list endpoint omitted — for RAWG, the description. One request, for the one entry chosen. A failure returns the result unchanged. |
| 14 | Main | `db/repositories/games.ts` | `applyMetadata()` writes genres, summary, release date and provenance in one statement. `genres` is written as `[]` when the provider listed none — a real answer, distinct from the NULL of a game never looked up. |
| 14b | Main | `services/metadata.ts` | `resolveCoverUrl()` asks the art provider (SteamGridDB) for portrait box art by name, falling back to the metadata provider's own image. Run **once, here** — never per search result, which would be two extra requests for each of twelve rows about to be discarded. |
| 15 | Main | `electron/services/covers.ts` | `importCoverFromUrl()` checks the declared type, the length, and the **leading bytes**, writes to `.tmp-…`, then renames. The rename is the commit point, the same rule the backup writer follows. |
| 16 | Main | `electron/ipc/metadata.ts` | The old cover is deleted only after the row points at the new one. A download failure returns `coverError` instead of throwing — the text fields already applied, so it is a partial success. |
| 17 | Renderer | `GameFormModal.tsx` | On full success the dialog closes. On `coverError` it stays open, says genres and description were saved but the art was not, and the primary button becomes **Done**. |

**Why the local writes come before the network one:** so a failed download
cannot discard work that succeeded. Reversing the order would mean a dropped
connection loses the genres too.

---

## Delete game

The one destructive action in the library, so it separates two consequences.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/GameCard.tsx` | The 🗑 button dispatches `modalOpened({ kind: 'deleteGame', gameId })`. |
| 2 | Renderer | `src/components/DeleteGameDialog.tsx` | Explains that the game stays installed. Offers "Also delete save backups", **unchecked by default**; checking it reveals an irreversible-action warning. |
| 3 | Renderer | `gamesSlice.ts` | `deleteGame({ id, options })`. |
| 4 | Main | `electron/ipc/games.ts` | `gamesRepo.deleteGame(id)` removes the row; `ON DELETE CASCADE` takes the session and backup rows with it, and the backup folder paths are returned. |
| 5 | Main | `electron/services/covers.ts` | `deleteCoversForGame(id)` removes managed cover files. |
| 6 | Main | `electron/ipc/games.ts` | If `deleteBackups` is set, each folder is removed individually; failures are collected into `backupFoldersFailed` rather than thrown, because the row is already gone and the operation is a partial success. Otherwise every path is returned as `backupFoldersKept`. |
| 7 | Renderer | `gamesSlice.ts` | `deleteGame.fulfilled` → `gamesAdapter.removeOne`, and the result is stored in `lastDeleteResult` so the UI can report kept or failed folders. |
| 8 | Renderer | `DeleteGameDialog.tsx` | Closes the modal and dispatches `libraryOpened()`, since a detail view for a deleted game cannot render. |

**Why the row is deleted before the folders:** the database is the index. If
folders were removed first and the row delete then failed, the library would
list a game whose backups had silently vanished — the failure mode the app
exists to prevent.

---

## Launch game and track a session

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/PlayButton.tsx` | Play dispatches `launchGame(gameId)`. `event.stopPropagation()` keeps the click off the card. |
| 2 | Renderer | `src/store/slices/sessionsSlice.ts` | `.pending` sets `launchingGameId`, so the button reads "Starting…" and cannot be double-clicked. |
| 3 | Main | `electron/ipc/sessions.ts` | `requireId()` validates the id before anything touches the database. |
| 4 | Main | `electron/services/launcher.ts` | `launchGame()` refuses if the game is already running. |
| 5 | Main | `launcher.ts` | `resolveTarget()` decides what to execute: `.lnk` is resolved via `shell.readShortcutLink()`, `.bat`/`.cmd` go through `cmd.exe /c`, `.url` is refused. `parseLaunchArgs()` splits arguments quote-aware, so no shell is involved. |
| 6 | Main | `db/repositories/sessions.ts` | `startSession()` writes the row **before** the process starts, so a crash still leaves a detectable open session. |
| 7 | Main | `launcher.ts` | `spawn()` with `detached: true`, `stdio: 'ignore'`, then `unref()`. On a spawn error the session row is discarded again. |
| 8 | Main | `launcher.ts` | `exit` and `error` listeners are attached, and the entry is added to the `running` map. |
| 9 | Main | `electron/ipc/sessions.ts` | Broadcasts `sessions:started` to every window, then returns the `LaunchResult`. |
| 10 | Renderer | `sessionsSlice.ts` | `.fulfilled` records the active session immediately, so the badge flips without waiting for the broadcast. |
| 11 | Renderer | `PlayButton.tsx` | `selectIsGameRunning` is now true; the button becomes the pulsing "Playing" indicator. |

---

## Game exits

Nothing in the renderer asked for this — it is a push.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | OS | — | The game process ends; Node emits `exit` on the child. |
| 2 | Main | `electron/services/launcher.ts` | `handleExit()` removes the entry (ignoring a duplicate if shutdown already handled it) and computes the elapsed seconds. |
| 3 | Main | `launcher.ts` | Reads `minSessionSeconds` live from settings. Sessions under it are **discarded**, not stored with a tiny duration — they are almost always a failed launch, and would skew the average. |
| 4 | Main | `db/repositories/sessions.ts` | `endSession()` closes the row and folds the duration into the game's roll-up **in one transaction**, so the two can never disagree. |
| 5 | Main | `electron/ipc/sessions.ts` | The listener re-reads the session and game, then broadcasts `sessions:ended` carrying the updated game. |
| 6 | Bridge | `electron/preload.ts` | `subscribe()` strips the `IpcRendererEvent` — it holds a live `sender` that would let renderer code send on arbitrary channels — and calls the renderer callback with the payload only. |
| 7 | Renderer | `src/store/eventBridge.ts` | Dispatches `sessionEnded`, then `gameUpdatedExternally` with the refreshed game. |
| 8 | Renderer | `sessionsSlice.ts` | Clears the active marker; prepends the finished session to cached history; drops stale cached stats. |
| 9 | Renderer | `gamesSlice.ts` | `gameUpdatedExternally` writes the new playtime — no refetch, since main already sent the row. |
| 10 | Renderer | `GameCard.tsx` | Badge returns to "Play" and the playtime label updates. |

---

## Shutdown and crash recovery

Three distinct paths, kept distinct on purpose.

**Graceful quit with a game running** — `before-quit` →
`closeAllSessionsOnQuit()` → each open session is closed with its **real elapsed
duration** and reason `app_closed`, because the app was alive to measure it.
Then `will-quit` → `closeDatabase()`. Both hooks are synchronous: Electron does
not await promises during quit, so async writes here would be lost.

**Unclean shutdown (crash, power loss, force-kill)** — `before-quit` never runs,
so the session row stays open. At the next start, `setupDatabase()` calls
`reconcileOpenSessions()`, which closes each orphan with **duration 0** and
reason `app_closed`. Zero rather than a guess: the app was not running to
observe the exit, so any duration would be invented. Because it is zero, the
playtime roll-up needs no adjustment.

**Renderer reload** — main-process state survives, renderer state does not.
`App` dispatches `syncRunningGames()` on every mount, so a game still running
after a refresh (or a dev hot reload) keeps its "Playing" badge.

---

## Back up saves

One code path serves all three triggers. The only difference is `force` and who
initiates it.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/GameCard.tsx` | "Back up now" dispatches `backupNow(gameId)`. (Automatic backups skip straight to step 4.) |
| 2 | Renderer | `src/store/slices/savesSlice.ts` | `.pending` adds the id to `busyGameIds`, so the button shows `…` and cannot be re-clicked. |
| 3 | Main | `electron/ipc/saves.ts` | `runBackup()` — shared by the manual handler and the automatic hooks, so all three report through one channel. Manual passes `force: true`. |
| 4 | Main | `electron/services/backups.ts` | Skip checks first: no save folder, folder missing, then (after the walk) folder empty. These return a skip outcome, not a throw. |
| 5 | Main | `backups.ts` | `computeTreeStats()` walks the folder for size, file count and a path+size+mtime fingerprint. Symlinks are not followed. |
| 6 | Main | `backups.ts` | Unless forced, compares the fingerprint with `getLatestBackup()`. A match skips the copy entirely. A **null** stored hash means "cannot prove unchanged", so the backup proceeds. |
| 7 | Main | `backups.ts` | Copies into `.tmp-<stamp>-<pid>` inside the game's backup folder. |
| 8 | Main | `backups.ts` | **`rename()` — the commit point.** The snapshot only now has its real name. On any failure the temp folder is removed and the error rethrown. |
| 9 | Main | `db/repositories/saves.ts` | `createBackup()` writes the row **last**, so a row never exists without a complete folder. |
| 10 | Main | `backups.ts` | `rotateBackups()` deletes folders beyond the limit, then their rows, returning the deleted ids. |
| 11 | Main | `electron/ipc/saves.ts` | Broadcasts `saves:backupFinished` with the outcome — including skips and failures. |
| 12 | Renderer | `src/store/eventBridge.ts` | Dispatches `backupFinished`. |
| 13 | Renderer | `savesSlice.ts` | Prepends the new snapshot, removes the rotated ids from cached history, clears the busy flag, sets the status message. |
| 14 | Renderer | `src/components/BackupStatusBar.tsx` | Shows it. Successes and skips auto-dismiss after 6s; errors stay until dismissed. |

**Automatic pre-launch** (`electron/ipc/sessions.ts`) runs at step 3 *before*
`launchGame()`, and is **awaited** — the snapshot must capture the save state
before the session can modify it. A failure is logged and the launch continues.

**Automatic post-session** runs in the `setSessionEndListener` callback, and is
deliberately **not** awaited: that callback is synchronous and blocking it would
delay the UI update clearing the "Playing" badge. It is skipped for discarded
sessions (failed launches cannot have changed the saves).

**On startup**, `cleanupAbandonedTempFolders()` removes any `.tmp-` folder left
by a backup interrupted mid-copy.

---

## Restore saves

The only flow that destroys user data. Read the ordering carefully — it is the
safety property.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/GameCard.tsx` | The ⭳ action opens `{ kind: 'backupHistory', gameId }`. |
| 2 | Renderer | `src/components/BackupHistoryModal.tsx` | Fetches snapshots, lists them with trigger, size and pin state. "Restore" opens `{ kind: 'restoreBackup', backupId }`. |
| 3 | Renderer | `src/components/RestoreBackupDialog.tsx` | Shows the **full target path**, warns that newer files will be lost, promises the undo snapshot, and keeps the confirm button disabled until the user types `restore`. Disabled entirely while the game is running. |
| 4 | Renderer | `src/store/slices/savesSlice.ts` | `restoreBackup(backupId)` → `.pending` sets `restoringBackupId`. |
| 5 | Main | `electron/services/restore.ts` | **`planRestore()` — every refusal happens here, before anything is written:** game running, no save folder configured, snapshot folder missing or not a directory. |
| 6 | Main | `electron/ipc/saves.ts` | If the save folder exists, takes a `pre_restore` backup — **forced** (never skipped by the dedup check) and then **pinned** (rotation must never remove the undo). A failure here **aborts the restore**. |
| 7 | Main | `electron/ipc/saves.ts` | Broadcasts `saves:backupFinished` so the undo snapshot appears in the history list immediately. |
| 8 | Main | `restore.ts` | `performRestore()` copies the snapshot to `.lp-restore-<stamp>` **in the save folder's parent**, so both renames stay on one filesystem. |
| 9 | Main | `restore.ts` | `rename(saveFolder → .lp-replaced-<stamp>)` moves the current saves aside rather than deleting them — this is what gets put back if the next step fails. |
| 10 | Main | `restore.ts` | `rename(.lp-restore-… → saveFolder)` — **the commit point.** On failure, the moved-aside folder is renamed back and the staging copy removed. |
| 11 | Main | `restore.ts` | Deletes `.lp-replaced-…`. A failure here leaves a stray folder, not data loss, so it never fails the restore. |
| 12 | Renderer | `savesSlice.ts` | `.fulfilled` stores `lastRestore`. |
| 13 | Renderer | `RestoreBackupDialog.tsx` | Switches to the success view, naming the recreated folder (if any) and pointing at the pinned undo snapshot. |

**Why the current saves are moved aside rather than deleted:** if the commit
rename failed after a delete, the saves would simply be gone. Moving them aside
makes step 10 reversible.

**Why staging is in the parent directory:** `rename` cannot cross filesystems.
Staging inside a temp directory elsewhere would force a copy-and-delete
fallback, reintroducing exactly the partial-write risk this design avoids.

**On startup**, `cleanupAbandonedRestoreFolders()` removes `.lp-restore-` and
`.lp-replaced-` folders left by an interrupted restore. It only matches those
two prefixes, because unlike the backups root this runs inside the user's real
save directory.

---

## Open a game's detail view

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/GameCard.tsx` | The cover/title button dispatches `gameOpened(game.id)`. It is a real `<button>`, not a click handler on the card div, so keyboard users can reach it; Play and the hover actions call `stopPropagation()` so they never navigate. |
| 2 | Renderer | `src/store/slices/uiSlice.ts` | Sets `selectedGameId` and `activeView = 'gameDetail'`. |
| 3 | Renderer | `src/App.tsx` | Renders `GameDetailPage` with the selected id. |
| 4 | Renderer | `src/pages/GameDetailPage.tsx` | On mount, dispatches `fetchSessionsForGame` and `fetchBackups`; a second effect dispatches `fetchSessionStats` only when the cached entry is absent. |
| 5 | Main | `electron/ipc/sessions.ts` | `sessions:getStats` runs one SQL aggregate (`COUNT`, `SUM`, `MAX`, `MIN`) rather than summing in JS. |
| 6 | Renderer | `src/components/ActivityChart.tsx` | Buckets the fetched sessions into 30 local-day totals with `toLocalDayKey()`. No extra query — the rows are already in the store. |
| 7 | Renderer | `src/components/SessionList.tsx` | Prepends the in-progress session from `activeByGameId`, since it has no history row yet. |
| 8 | Renderer | `src/components/BackupList.tsx` | Same component the quick-access modal renders. |

**While the page is open**, the push events from step 4 keep it live:
`sessions:started` adds "Playing now", and `sessions:ended` clears it, prepends
the finished session, drops the cached stats (forcing the effect in step 4 to
re-fetch) and updates the playtime via `gameUpdatedExternally`. No polling and
no reload.

---

## Change a setting

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/pages/SettingsPage.tsx` | Numeric fields commit on **blur or Enter**, not per keystroke — saving mid-typing would send `1`, `12`, `120` for "120". Toggles commit immediately. |
| 2 | Renderer | `src/store/slices/settingsSlice.ts` | `updateSettings(patch)` sends only the changed keys. |
| 3 | Main | `electron/ipc/settings.ts` | `validatePatch()` **rejects** out-of-range values with a message rather than clamping, so the user learns why. `theme` is dropped: the light theme is unimplemented, so persisting it would store a value nothing honours. |
| 4 | Main | `electron/ipc/settings.ts` | A new backups root is `mkdir`-ed immediately, so a bad path fails while the user is looking at the field rather than silently at some later launch. |
| 5 | Main | `db/repositories/settings.ts` | `updateSettings()` writes the changed keys and returns the **full parsed settings**. |
| 6 | Renderer | `settingsSlice.ts` | `.fulfilled` replaces state with what main returned — never with what was sent, since the canonical result may differ and showing the request would misreport what the app uses. |

**Changing the backups root affects new snapshots only.** Existing snapshots keep
absolute paths, so they stay listed and restorable from where they were written.
This is also why the destructive-path guard is structural rather than
root-relative — see `assertLooksLikeSnapshotFolder()` in
`electron/services/backups.ts`.

---

## Reclaim orphaned backup folders

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/pages/SettingsPage.tsx` | "Scan" dispatches `scanOrphans()`. |
| 2 | Main | `electron/services/maintenance.ts` | Lists the backups root. A per-game folder whose name matches no current game is `deleted_game`; a snapshot folder inside a live game's folder with no matching row is `unreferenced_snapshot`. `.tmp-` folders are skipped — the backup service owns those. |
| 3 | Main | `maintenance.ts` | Measures each folder's size. **Nothing is deleted.** |
| 4 | Renderer | `SettingsPage.tsx` | Lists each folder with its reason and size, plus the reclaimable total. |
| 5 | Renderer | — | "Delete all" dispatches `cleanupOrphans()`. |
| 6 | Main | `maintenance.ts` | **Re-scans rather than trusting the renderer's list.** The renderer is the untrusted side of the boundary and this deletes directories, so only paths a fresh scan still considers orphaned are removed — a stale or forged list cannot widen the blast radius. Snapshot-shaped paths additionally pass `assertLooksLikeSnapshotFolder()`. |
| 7 | Renderer | `SettingsPage.tsx` | Reports how much was freed, then re-fetches usage. |

---

## Toggle fullscreen

Four entry points, one path.

| # | Layer | File | What happens |
|---|---|---|---|
| 1 | Renderer | `src/components/TitleBar.tsx` | The icon dispatches `toggleFullScreen()`. (F11 and Escape skip to step 4; the OS gesture skips to step 5.) |
| 2 | Main | `electron/ipc/window.ts` | Computes the target, calls `setFullScreen(target)`, and returns the state being transitioned **to** — not a fresh read. |
| 3 | Renderer | `src/store/slices/uiSlice.ts` | `.fulfilled` writes `ui.window`, so the bar reacts immediately. |
| 4 | Main | `electron/main.ts` | `before-input-event` handles **F11** (toggle) and **Escape** (leave fullscreen only, so Escape still closes dialogs when windowed). Bound per-window, not globally. |
| 5 | Main | `electron/main.ts` | `enter-full-screen` / `leave-full-screen` fire — including for OS-initiated changes — and push state with the outcome passed explicitly. |
| 6 | Bridge | `electron/preload.ts` | Same `subscribe()` helper as the session and backup channels; strips the `IpcRendererEvent`. |
| 7 | Renderer | `src/store/eventBridge.ts` | Dispatches `windowStateChanged`. |
| 8 | Renderer | `TitleBar.tsx` | Windowed: renders the 34px drag strip, sized by the `titlebar-area-*` env vars so it never overlaps the native buttons. Fullscreen: returns `null`, and `FullscreenExitButton` provides the way out. |

**Why the outcome is passed explicitly at steps 2 and 5:** on Windows,
`enter-full-screen` fires *before* `isFullScreen()` flips. Re-reading the window
inside the handler broadcasts the state being left, so every push lands one
transition behind. The event name is unambiguous; the window mid-transition is
not.

**On reload**, `App` dispatches `fetchWindowState()` — window chrome lives in
the main process, so the renderer must re-sync or it would guess wrong about
fullscreen and about whether native controls overlay the page.

---

## Navigate between views

Deliberately trivial, but it shows the no-router decision in practice.

| # | File | What happens |
|---|---|---|
| 1 | `src/components/Sidebar.tsx` | Button `onClick` dispatches `libraryOpened()` or `viewChanged('settings')`. |
| 2 | `src/store/slices/uiSlice.ts` | Reducer sets `activeView` (and clears `selectedGameId` when returning to the library). |
| 3 | `src/App.tsx` | `useAppSelector((s) => s.ui.activeView)` picks the page component. |
| 4 | `src/components/Sidebar.tsx` | Re-reads `activeView` for the highlight. Note it treats `gameDetail` as "Library" being active, since the detail view is a child of the library. |

Because navigation is Redux state, it shows up in devtools as an action and
survives hot reload — the open view does not reset on every edit.
