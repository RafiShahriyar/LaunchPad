# Architecture

> Status: **All 8 steps complete, plus custom window chrome, a collapsible
> sidebar and a dev-only sample-data seeder.** 385 assertions pass across the
> data layer, IPC and UI suites. See `FEATURES.md` for per-feature detail and
> the packaging status.

## The three layers

LaunchPad is an Electron app split into three isolated layers. The split is not
cosmetic: each layer runs in a different process with different privileges.

| Layer | Location | Process | Can it touch the disk? |
|---|---|---|---|
| Main | `electron/` | Node.js (full privileges) | Yes — the only layer that can |
| Preload | `electron/preload.ts` | Isolated bridge context | No — it only forwards messages |
| Renderer | `src/` | Chromium, sandboxed | **No** — no `fs`, no `require`, no `process` |

Shared code lives in `shared/` and is compiled by *both* TypeScript projects.

## Why the renderer is locked down

The renderer is configured with:

```ts
contextIsolation: true   // renderer JS and preload JS get separate V8 contexts
nodeIntegration: false   // no require() / process / fs in renderer code
sandbox: true            // renderer runs inside the OS-level sandbox
```

This app launches **arbitrary user-supplied executables** and reads and writes
**save-file folders**. A renderer with filesystem access would mean any script
that reached the page — a malicious cover image, a compromised npm dependency in
the UI tree — could delete a save folder or spawn a process. With the settings
above, the renderer can only ask main to do things through a fixed list of
channels.

The lockdown is enforced at three levels, so a mistake has to defeat all three:

1. **Runtime** — `nodeIntegration: false` means `require` genuinely does not exist.
2. **Compile time** — `tsconfig.web.json` omits `@types/node`, so importing `fs`
   in `src/` is a build error, not a runtime surprise.
3. **API surface** — the preload exposes named methods only, never a generic
   `invoke(channel, ...)` escape hatch.

Verified in step 1: in the running app, `typeof require === 'undefined'` and
`window.ipcRenderer === undefined`, while `window.api.app.getInfo` is a function.

## The IPC flow

```
+------------------------- RENDERER (sandboxed Chromium) --------------------------+
|                                                                                  |
|   React component                                                                |
|        |  dispatch(someThunk())                                                  |
|        v                                                                         |
|   createAsyncThunk  -->  unwrap(window.api.games.list())                         |
|        ^                        |                                                |
|        | fulfilled / rejected   |                                                |
|        |                        v                                                |
|   Redux store            window.api   <- the ONLY object bridging out            |
|                                 |                                                |
+---------------------------------|------------------------------------------------+
                                  |  contextBridge (structured clone, no live objects)
+---------------------------------|------------------------------------------------+
|  PRELOAD (electron/preload.ts)  v                                                 |
|    ipcRenderer.invoke('games:list')     <- one named method per capability        |
+---------------------------------|------------------------------------------------+
                                  |  IPC channel
+---------------------------------|------------------------------------------------+
|  MAIN (Node.js, full privileges)v                                                 |
|    handle('games:list', fn)   <- electron/ipc/handle.ts wraps every handler       |
|         |                                                                         |
|         +--> SQLite  (db/)                                                        |
|         +--> filesystem (save backups)                                            |
|         +--> child_process (launching games)                                      |
|                                                                                   |
|    returns  { ok: true, data }  |  { ok: false, error }                           |
+-----------------------------------------------------------------------------------+
```

### Why a result envelope instead of throwing

Every handler returns `IpcResult<T>` (`{ ok: true, data }` or
`{ ok: false, error }`) rather than throwing. When a handler throws, Electron
rejects the renderer's promise with a flattened
`Error invoking remote method '...'` string — the stack and any structured
detail are lost. Turning failures into *data* preserves the real message, and
`unwrap()` in `src/store/asyncStatus.ts` converts the envelope back into a
thrown error at the thunk boundary, so `createAsyncThunk`'s `.rejected` case
still works normally.

Net effect: handlers need no boilerplate try/catch, and the UI gets a real
message like `ENOENT: save folder no longer exists` instead of noise.

### The second IPC direction: push events

Everything above is renderer-initiated request/response. Step 4 added the
opposite direction, because a game process exits on its own schedule with no
renderer request outstanding:

```
  game process exits
        |
        v
  launcher.ts  handleExit()          electron/services/launcher.ts
        |  writes the session + playtime roll-up in one transaction
        v
  ipc/sessions.ts  broadcast()       webContents.send('sessions:ended', ...)
        |
        v
  preload.ts  subscribe()            strips IpcRendererEvent, forwards payload
        |
        v
  eventBridge.ts                     store.dispatch(sessionEnded(...))
        |
        v
  Redux store -> badge clears, playtime updates
```

Three decisions make this safe and correct:

- **The `IpcRendererEvent` is stripped in preload.** It carries `sender`, a live
  handle to the IPC pipe. Forwarding it through `contextBridge` would hand
  renderer code a way to send on arbitrary channels, undoing the whitelist.
- **Subscriptions return an unsubscribe function.** Without one, every effect
  re-run stacks another listener, and Electron warns about a leak after eleven.
- **Events are broadcast, not replied to a sender.** By the time a game exits,
  the window that launched it may have reloaded, making its `webContents` id
  stale.

The bridge is wired at module level in `main.tsx`, **not** in a React hook: a
game can exit while the library is unmounted, and that playtime update must
still land.

### Why no generic `invoke()` on the bridge

A bridge like `window.api.invoke(channel, ...args)` would be far less code, but
it re-opens everything `contextIsolation` closes: any code running in the page
could then call *any* channel, including destructive ones like `saves:restore`.
Each capability is therefore whitelisted by name in `electron/preload.ts`.

### Why IPC handlers are split by domain

`electron/ipc/` has one module per domain (`app.ts`, and later `games.ts`,
`sessions.ts`, `saves.ts`) instead of one registration file. Handler modules
grow to include validation and filesystem logic; a single file would become the
merge-conflict hotspot of the project. Each module exports one
`registerXHandlers()` function called once from `main.ts` at startup — before
any window exists, so the renderer can never invoke a channel that is not yet
listening.

## Serving local files to the renderer

The renderer displays user-chosen cover images, which is harder than it sounds:
**the renderer cannot load `file://` URLs**. In dev it is served from
`http://localhost:5173`, and Chromium blocks `file://` subresources from an http
origin regardless of CSP.

The solution is a custom `lpasset://` scheme, registered as privileged before
`app.whenReady()` and handled in `electron/services/assetProtocol.ts`:

```
<img src="lpasset://cover/7-a1b2c3d4e5f6.png">
        |
        v
  protocol.handle('lpasset')          electron/services/assetProtocol.ts
        |  basename() the request, then verify it resolves inside <userData>/covers
        v
  net.fetch(file:///.../covers/7-a1b2c3d4e5f6.png)
```

Two properties make this safe to expose to a web page:

- **It serves one directory, not the disk.** The handler takes only the
  basename, then re-checks containment. `lpasset://cover/..%2F..%2Flaunchpad.db`
  is rejected (verified in the step 3 test suite).
- **Images are copied in, not referenced in place.** Anything servable has
  already been vetted by `importCover()`. A cover left pointing into a game's
  install folder would also break on uninstall.

The filename embeds a SHA-1 of the file contents so a replaced cover always gets
a new URL, which is what stops Chromium serving a stale cached image.

The production CSP therefore lists `img-src 'self' data: lpasset:`.

## Why Redux Toolkit

The requirement that makes a real store worthwhile: **the same game data appears
in several places at once** (library grid, detail view, "currently playing"
badge, session list), and it changes from *outside* React — a game process can
exit at any moment, and main pushes that event in. With component-local state,
the "game exited, playtime is now 4.2h" update would have to be threaded
through every view holding a copy.

Specific choices:

- **`createAsyncThunk` for all IPC** — every filesystem/DB call is async and can
  fail. Thunks give a uniform `pending / fulfilled / rejected` lifecycle, so
  loading spinners and error banners work the same way everywhere.
- **`createEntityAdapter` for games** — games are looked up by id from several
  views. Normalised storage makes "update game 7's playtime" a single keyed
  write instead of an array scan and rebuild.
- **Sessions and saves keyed by game id** — they are only ever read one game at
  a time, so a global normalised index would cost memory for no lookup benefit.
- **Default middleware left on** — RTK's serializability check is what catches a
  `Date` or a Node `Buffer` crossing IPC into the store. Non-cloneable values
  fail at the process boundary, and the check surfaces that immediately rather
  than at packaging time. This is why all timestamps are ISO strings, never
  `Date` objects.

## Why SQLite

Playtime tracking is inherently relational and query-shaped: "total hours per
game", "sessions in the last 30 days", "backups older than N for game X". Doing
that over a JSON file means loading and rewriting the whole file on every
session end, with no crash-safety — and a crash mid-write during a game session
is exactly when it would happen. SQLite gives atomic transactions, real
aggregation (`SUM(duration_seconds) GROUP BY game_id`), and indexed lookups, in
a single file that is trivial to back up.

**Binding: `node:sqlite`** (Node 24's built-in module, bundled with Electron 43).
`better-sqlite3` v13 ships no prebuilt binaries, and no release of it covers
Electron 43's ABI 148, so it would have to be compiled from source — requiring
Visual Studio Build Tools on every developer machine and CI runner. `node:sqlite`
needs no native build at all, which also removes `electron-rebuild` from the
packaging path and the ABI-breakage risk from every future Electron upgrade.
Full comparison and the verification output are in `DATA_MODEL.md`.

## Build pipeline

`electron-vite` builds all three layers from one config
(`electron.vite.config.ts`):

- **main** and **preload** are bundled as CommonJS into `out/main`, `out/preload`
- **renderer** is a standard Vite React build into `out/renderer`

### Why CommonJS for main/preload, ESM for the renderer

`package.json` deliberately has **no `"type": "module"`**. ESM preload scripts
require `sandbox: false` and a `.mjs` extension — that is, they force a
weakening of the security posture described above. CJS output for main and
preload keeps `sandbox: true` available. The renderer is unaffected and is
modern ESM, because Vite serves and bundles it independently.

### Why the CSP is injected at build time

The production Content-Security-Policy lives in a small Vite plugin
(`injectCsp()`), not in `index.html`. It cannot go in the HTML directly, because
Vite's dev server injects an inline react-refresh preamble that
`script-src 'self'` would block — hot reload would break. It also cannot be an
HTTP header, because the packaged app loads the renderer over `file://`, where
response headers do not exist. A build-time meta tag is the only mechanism that
covers the shipped app without crippling development.

Note `connect-src 'none'`: the renderer is forbidden from opening network
connections of its own. Everything goes through IPC.

This survived the metadata feature intact, which is the point worth recording.
Fetching cover art and genres from IGDB is inherently a network feature, and the
obvious implementation -- let the picker load thumbnails straight from the
provider's CDN -- would have meant widening `connect-src` and `img-src` and
giving the page its own network reach. Instead `electron/services/metadata.ts`
fetches the thumbnails in main and inlines them as `data:` URIs, which `img-src`
already permitted. **The CSP is byte-for-byte what it was before the feature
existed.** The renderer sends a query string and receives mapped results; it
never sees a URL, a token or a secret.

### Pinned versions and why

| Package | Version | Reason |
|---|---|---|
| `vite` | `^7.3.6` | electron-vite 5 peer-caps at Vite 7; Vite 8 would break the peer range |
| `@vitejs/plugin-react` | `^5.2.0` | v6 requires Vite 8; 5.2.0 is the last line spanning Vite 7 and 8 |
| `@types/node` | `^24` | Matches the Node 24.18.1 that Electron 43 bundles, not the newer standalone release |
| `typescript` | `^7` | Note: TS 7 **removed `baseUrl`**; path aliases must be relative (`./src/*`) |

## Folder layout

```
electron/           main process - the only layer with real privileges
  main.ts           window lifecycle, single-instance lock, startup
  preload.ts        contextBridge whitelist
  ipc/
    handle.ts       shared wrapper: envelopes + error logging
    app.ts          app:* channels
    games.ts        games:* channels - CRUD, validation, native file pickers
    sessions.ts     sessions:* channels + push broadcasts
    saves.ts        saves:* channels; runBackup() shared by manual and auto paths
    settings.ts     settings:* channels, validation, maintenance
    window.ts       window:* channels - fullscreen + title bar state
    broadcast.ts    send an event to every window
  services/
    covers.ts       copies cover art into a managed folder
    assetProtocol.ts  lpasset:// handler, confined to that folder
    launcher.ts     spawns games, tracks process lifetime, records sessions
    backups.ts      snapshot copy, fingerprinting, rotation
    restore.ts      validation, safety snapshot, atomic folder swap
    maintenance.ts  finds and reclaims unreferenced backup folders
    metadata.ts     provider registry: selection, enrichment, cover resolution
    providers/      one client per service, all provider-specific code
      http.ts         shared fetch/throttle/thumbnail helpers
      types.ts        the interface a provider implements
      igdb.ts         OAuth token, Apicalypse query, response mapping
      rawg.ts         keyed REST, lazy description enrichment
      steamgriddb.ts  portrait box art only
    demoData.ts     dev-only sample library (generates real PNG covers)
db/                 SQLite data layer - imports NOTHING from Electron
  client.ts         connection, pragmas, transaction() helper
  schema.ts         migrations, user_version runner
  defaults.ts       default settings (no imports, avoids a cycle)
  row.ts            typed row readers + parameter binding
  repositories/     games.ts, sessions.ts, saves.ts, settings.ts
  index.ts          the only module the rest of the app imports
  verify.ts         63-assertion harness (npm run verify:db)
shared/             types compiled into BOTH main and renderer
  ipc.ts            channel names + payload types - the IPC contract
  types.ts          domain models (Game, PlaySession, SaveBackup, AppSettings)
src/                renderer (React + Redux)
  components/       reusable UI (Modal, GameCard, TitleBar, BackupList, ...)
  pages/            LibraryPage, GameDetailPage, SettingsPage
  store/            Redux store, typed hooks, slices per domain
    eventBridge.ts  subscribes to main's push events, dispatches to the store
  lib/              renderer-only helpers (formatting, cover URLs)
  types/            global.d.ts (window.api), re-export of shared types
docs/               this folder
```

### Deviations from the originally proposed structure

1. **Project root is `LaunchPad/`, not a nested `game-launcher/`.** The working
   directory is already the project root; nesting would add a redundant path
   segment.
2. **`shared/` was added.** The original plan put types in `src/types/`, but the
   IPC contract is used by main, preload *and* renderer. Had it lived under
   `src/`, the main process would import from the renderer's folder — implying a
   dependency direction that does not exist. `src/types/index.ts` re-exports
   `shared/types.ts`, so renderer code still imports from `@/types`.
3. **`electron/ipc/handle.ts` was added** — the envelope wrapper described above.
4. **`main.ts` and `preload.ts` stayed flat** (rather than `main/index.ts`), as
   originally specified. Domain logic goes in `electron/ipc/` and, later,
   `electron/services/`, so these two files stay short.
5. **`db/` gained `repositories/`, `row.ts` and `defaults.ts`.** The plan listed
   only `schema.ts` and `client.ts`. Repositories are split per domain to mirror
   the IPC domain split; `row.ts` holds the typed row mapping that node:sqlite's
   `Record<string, SQLOutputValue>` returns make necessary; `defaults.ts` is
   import-free so both the client (seeding) and the settings repository
   (fallbacks) can use it without a cycle.
