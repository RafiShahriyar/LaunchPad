# LaunchPad — working notes

Desktop game library manager: add games, launch them, track playtime, and back
up / restore their save files. Electron + React + TypeScript + Redux Toolkit,
SQLite via `node:sqlite`.

All 8 planned features are built, plus custom window chrome (dark title bar,
self-drawn window controls, fullscreen), a collapsible sidebar, and a dev-only
sample-data seeder. **385 assertions pass** across the data-layer, IPC and UI
suites.

Repository: <https://github.com/RafiShahriyar/LaunchPad>

Detailed docs live in `docs/` — `docs/ARCHITECTURE.md` (structure and why),
`docs/DATA_MODEL.md` (schema, every column justified), `docs/FEATURES.md` (what works, how,
and every known limitation), `docs/CODE_FLOW.md` (step-by-step traces of each user
action). **Update the relevant doc in the same change that alters behaviour** —
that convention has held for the whole project.

---

## Commands

```bash
npm run dev        # electron-vite dev --watch : renderer HMR + main/preload restart
npm run build      # typecheck both projects, then build all three targets to out/
npm start          # run the production build unpackaged
npm run typecheck  # both tsconfig projects
npm run verify:db  # 76-assertion data-layer suite (plain Node, ~1s)
npm run dist       # build + electron-builder → Windows (see Packaging below)
```

`npm run verify:db` is the only test suite committed to the repo. See
**Testing** below — this matters.

---

## Architecture in 30 seconds

Three layers, three privilege levels:

| Layer | Path | Can touch disk? |
|---|---|---|
| Main | `electron/` | Yes — the only one that can |
| Preload | `electron/preload.ts` | No — forwards messages only |
| Renderer | `src/` | **No** — no `fs`, no `require`, no `process` |

`shared/` is compiled by **both** tsconfigs and holds the IPC contract
(`shared/ipc.ts`) and domain models (`shared/types.ts`). Adding a channel without
implementing it on both sides is a compile error, by design.

`db/` **imports nothing from Electron** — the database path is injected. That is
what lets `db/verify.ts` run the real repositories under plain Node in a second.
Don't break this.

**The pattern every feature follows:**

```
component → thunk → unwrap(window.api.<domain>.<method>()) → preload whitelist
          → handle() → domain handler → repository → IpcResult envelope
          → slice pending/fulfilled/rejected
```

No component calls IPC directly. No handler throws across the boundary —
`handle()` wraps everything into `{ok: true, data}` / `{ok: false, error}`,
because a thrown error loses its message crossing the process boundary.

Main also **pushes** events (`sessions:started/ended`, `saves:backupFinished`)
because a game exits on its own schedule. `src/store/eventBridge.ts` wires those
to the store at module level — deliberately *not* a React hook, since a game can
exit while the library is unmounted.

---

## Non-obvious constraints that will bite you

**`node:sqlite`, not better-sqlite3.** better-sqlite3 v13 ships no prebuilds and
no release covers Electron 43's ABI 148, so it needs VS Build Tools. `node:sqlite`
is built into Electron's Node 24. Consequences:

- **`true`/`false` cannot be bound** as parameters — they throw. Use
  `bindBoolean()` from `db/row.ts`.
- **`undefined` cannot be bound** either. Use `bindNullable()`.
- **There is no `db.transaction()`** helper. Use `transaction()` from
  `db/client.ts`; it uses SAVEPOINTs so it nests correctly.
- `changes` / `lastInsertRowid` are `number | bigint` — normalise with
  `toNumber()`.
- It prints an `ExperimentalWarning` at startup. Cosmetic, deliberately not
  suppressed (silencing process warnings globally would hide real ones).

**TypeScript 7 removed `baseUrl`.** Path aliases must be relative (`./src/*`).

**Version pins are load-bearing:**
- `vite@^7` — electron-vite 5 peer-caps at 7; Vite 8 breaks the peer range.
- `@vitejs/plugin-react@5.2.0` — v6 requires Vite 8.
- `@types/node@^24` — matches Electron's bundled Node, not the newer standalone.
- `electron-builder@25.1.8` — pinned for an environment reason, see Packaging.

**No `"type": "module"` in package.json.** ESM preload scripts require
`sandbox: false`. Keeping main/preload as CJS is what allows `sandbox: true`.

**The production CSP is injected by a Vite plugin**, not written in
`index.html`. It can't be in the HTML (Vite's inline react-refresh preamble would
be blocked, killing HMR) and can't be an HTTP header (the packaged app loads over
`file://`). See `injectCsp()` in `electron.vite.config.ts`.

**Cover images are served over a custom `lpasset://` protocol**, not `file://` —
the renderer can't load `file://` from the dev server's http origin. The handler
is confined to the managed covers folder and rejects traversal.

**The title bar AND the window buttons are ours.** `titleBarStyle: 'hidden'`
with **no** `titleBarOverlay`; `TitleBar.tsx` draws minimise/maximise/close.
- This was a reversal. The overlay keeps the real system buttons (and Snap
  Layouts), but Chromium owns their hover rendering — it was invisible on a
  near-black bar, cannot be restyled, and cannot be tested. Custom controls
  trade Snap Layouts for hover that is CSS and therefore verifiable.
- Clickable things inside the drag strip need `.titlebar-nodrag`, or the window
  drag swallows the click.
- `titleBarStyle: 'hidden'` rather than `frame: false` keeps resize borders.
- Window close goes through `window.close()`, not `destroy()`, so `before-quit`
  still writes open sessions and `will-quit` still closes the database.

---

## Invariants — do not break these

These encode failures that were actually hit and fixed. Changing them
reintroduces real bugs.

**Backups (`electron/services/backups.ts`):**
1. Copy to `.tmp-…`, then **rename** — rename is the commit point. An
   interrupted copy must never look like a complete snapshot.
2. Write the database row **last**. A row is a promise the folder is complete.
   A folder with no row is recoverable waste; a row with no folder is a restore
   that fails at the worst moment.
3. Rotation deletes **folders before rows**. A failed folder delete leaves the
   snapshot listed and restorable — the safe direction.

**Snapshot folder names keep milliseconds.** Truncating to whole seconds was a
real bug: two backups in the same second resolved to the same path and the
second failed on rename. A manual backup next to an automatic one hits this.

**The destructive-path guard is structural, not root-relative.**
`assertLooksLikeSnapshotFolder()` checks the folder name matches the timestamp
scheme and is nested ≥2 deep. An earlier root-relative version silently made
every pre-existing snapshot un-deletable after a backups-root change.

**Restore (`electron/services/restore.ts`):** validate everything *before*
writing anything; take a **pinned** `pre_restore` snapshot; then swap with two
renames (move current aside, move new in). Abort the whole restore if the safety
backup fails.

**Shutdown hooks are synchronous.** Electron does not await promises during
quit. Sessions are written on `before-quit`, the DB closes on `will-quit`. A
promise-based version silently loses the final writes.

**Preload strips `IpcRendererEvent`** before invoking renderer callbacks — it
carries a live `sender` that would let renderer code send on arbitrary channels.

**Window state is reported from the event, not read from the window.** On
Windows `enter-full-screen` fires *before* `isFullScreen()` flips, so re-reading
the window inside the handler broadcasts the state being left — every push lands
one transition behind. `broadcastWindowState()` takes an explicit override and
the handlers return the state being transitioned *to*. This was a real bug: the
UI looked correct because the thunk's return value was right, so only asserting
the pushed payload caught it.

---

## The honesty principle

The app never states something it cannot know. This shows up in several places
and is worth preserving:

- A session interrupted by an app **crash** records duration **0**, because the
  app wasn't alive to measure it. A session interrupted by a **graceful quit**
  records the real elapsed time. Never invent a duration.
- A non-zero exit code renders as **"Ended unexpectedly"**, not "Crashed" — many
  games exit non-zero on a normal quit. The raw code travels with the event.
- Zero-duration sessions render as **"Unknown"**, not "0s".
- Backup **skips are surfaced** ("Saves have not changed since the last backup"),
  not silently swallowed — otherwise the button looks broken.

---

## Environment blockers (this machine)

**`npm run dist` cannot produce an installer here.** The app itself packages
fine and the resulting `.exe` was verified working, but:

1. **electron-builder 26 cannot run at all.** Its dependency collector invokes
   npm via `powershell.exe -EncodedCommand`, which is blocked:
   `Program 'npm.CMD' failed to run: Access is denied`. Reproduced outside the
   build and outside any sandbox — a machine policy (AppLocker / EDR blocking
   batch execution from PowerShell). It surfaces unhelpfully as
   `No JSON content found in output`, and it *throws* rather than falling back
   to electron-builder's own traversal collector.
   → **Pinned to `electron-builder@25.1.8`**, which uses a different spawn path.
   Move back to 26.x once that policy allows it; nothing depends on staying on 25.

2. **The NSIS installer step needs symlink privileges:**
   `Cannot create symbolic link : A required privilege is not held by the client`
   — electron-builder's `winCodeSign` bundle contains macOS symlinks.
   → Enable **Windows Developer Mode** (Settings → System → For developers) or
   run the build from an **admin terminal**.

What *does* work: `npm run dist` produces
`release/<version>/win-unpacked/LaunchPad.exe` with the app in `app.asar`, and
that executable was launched and driven through the IPC suite (8/8 passing, DB
created correctly). That confirms asar path resolution for preload and renderer.

LaunchPad has **zero production dependencies** — Vite bundles everything into
`out/` — so the dependency-collection step that fails is pure overhead here.
`"npmRebuild": false` is set for the same reason (no native modules).

---

## Before shipping

- [ ] Add `build/icon.ico` — otherwise it ships with the default Electron icon.
- [ ] Set `author` in `package.json` (electron-builder warns it is missing).
- [ ] Configure code signing — unsigned installers trigger SmartScreen.
- [ ] Resolve the two packaging blockers above.
- [ ] Consider code-splitting: the renderer bundle is ~740 kB (~230 kB gzipped).
      Fine for a desktop app loading from disk, but it has grown steadily.

---

## Testing

**`npm run verify:db` (76 assertions) is the only suite in the repo.** It runs
the real repositories against a temp database under plain Node, including a
**hand-built v1 → v2 migration test** — migrations are the one thing that cannot
be fixed after release.

**The other 309 are not committed.** They were driven through the Chrome
DevTools Protocol against a real Electron instance, and those harnesses lived in
a session scratchpad that is temporary. The regularly re-run sweep totals **385**:

| Suite | Assertions | Covers |
|---|---|---|
| verify:db | 76 | Data layer + v1→v2 migration (the only one in the repo) |
| step3 / step3ui | 26 / 28 | Games CRUD, validation, cover pipeline, form UX |
| idcheck | 8 | Malformed IPC input |
| step5 | 42 | Backup copy, dedup, rotation, pinning |
| step6 / step6ui | 32 / 20 | Restore, undo snapshot, refusals |
| step7 | 30 | Detail view, stats, activity chart, live updates |
| step8 / step8ui | 42 / 19 | Settings validation, root change, orphan cleanup |
| step9 | 22 | Title bar geometry, fullscreen via button/F11/Escape |
| step10 | 40 | Window-control hover states, sidebar collapse, sample data |

A further **63** exist for step 4 (`step4` 39, `step4b` 7, `step4quit` 6,
`step4ui` 11 — launch, exit detection, crash recovery, graceful quit). They are
**not** in the sweep above because they require force-killing and restarting the
app mid-suite, so they were run on their own.

**Recommendation: rewrite these into the repo** (e.g. `tests/` with a runner
script). The pattern is straightforward — launch `electron.exe` with
`--remote-debugging-port`, connect over WebSocket, drive `Runtime.evaluate`.

Two lessons if you write more of them:
- `innerText` applies `text-transform`, so a `uppercase` label reads as
  `SESSIONS`. Use case-insensitive matching.
- `.blur()` only fires React's `onBlur` if the element was actually focused
  first. Same for scoping selectors inside `[role=dialog]` — the page has
  same-named buttons.
- A test finding an element by `aria-label` proves it exists, **not** that a
  person can see it. The sidebar collapse control passed its test while being
  reported as missing, because it was `slate-600` at the bottom of the rail.
  For anything visual, look at a screenshot too.

**Verifying UI changes.** `Page.captureScreenshot` over CDP works and is the
fastest way to actually look at the app. OS-level screen capture does **not**
work on this machine (the window is not composited into the captured desktop,
and `Add-Type` is blocked by the same policy that breaks electron-builder 26),
so anything drawn by the OS rather than the page cannot be inspected here. That
is precisely why the window controls were moved into the page.

**Watch for stale builds.** `release/<version>/win-unpacked/LaunchPad.exe` does
not rebuild unless `npm run dist` is re-run. Running a stale `.exe` while
developing has already caused one "the feature is missing" report — the feature
was present in `out/`, just not in the packaged app.

---

## Adding a setting

The settings table is key/value, so a new setting needs **no migration** —
`seedDefaultSettings()` uses `INSERT OR IGNORE` and adds it on the next start.
Touch four places: `AppSettings` in `shared/types.ts`, `DEFAULT_SETTINGS` and
`SETTINGS_KEYS` in `db/defaults.ts`, the parser in
`db/repositories/settings.ts`, and `validatePatch()` in
`electron/ipc/settings.ts`. `sidebarCollapsed` is the worked example.

## Sidebar

The collapse control lives in the sidebar **header**, beside the logo. It was
originally at the bottom of the rail in `slate-600` and got reported as missing —
it was rendering, just too dim and too far out of the way. Keep controls that
restructure the layout visually prominent.

## Sample data

`npm run dev` → Settings → Developer → **Add sample data**. Creates eight games
with generated PNG covers, ~65 sessions across the last 30 days, real save
folders and four snapshots. Safe to re-run; it skips games already present.

Dev-only in two independent ways: `import.meta.env.DEV` strips the UI from
production builds, and the handler refuses when `app.isPackaged`.

## Known limitations worth remembering

**The big one: launcher-style games report near-zero playtime.** Games that
start through a launcher (many Steam titles, Ubisoft Connect, Battle.net) spawn
the real game as a *separate* process and exit immediately, so the tracked child
dies seconds after launch — often short enough to be discarded by the
minimum-session filter. Fixing this properly means watching for a process by
name or polling the process table. It is a feature in its own right, not a tweak.

Others, in rough priority order:

- **`.url` shortcuts are refused** at launch (they hand off to a protocol
  handler, leaving no process to watch). `.lnk` files *are* resolved to their
  real target and tracked.
- **No compression or incremental storage for backups** — ten snapshots of a
  mostly-unchanged folder store ten full copies. Hard-linking unchanged files is
  the natural next optimisation.
- **`pre_restore` snapshots accumulate** — they are pinned so rotation never
  removes them. Deliberate (losing an undo is worse), but frequent restorers
  collect them.
- **The light theme is not implemented.** `theme` exists in the schema but the
  UI does not offer it and main rejects setting it: the UI uses Tailwind's
  default `slate` text scale rather than semantic tokens, so flipping background
  variables alone gives light-on-light text.
- **A game launched outside LaunchPad is invisible** — the running-game checks
  rely on LaunchPad having spawned the process.
- **No router**, so no deep linking and the open game is not restored on restart.
- **Window size, position, maximised and fullscreen state are not persisted**
  across restarts. `isMaximized` is already tracked and pushed, so persisting it
  is a small addition. (The *sidebar* collapse state IS persisted, in settings.)
- **Snap Layouts are unavailable** — the deliberate cost of self-drawn window
  controls. Reverting is small: restore `titleBarOverlay` in `createWindow()`
  and drop the `ControlButton` block from `TitleBar.tsx`.
- **The activity chart** is built from the fetched session list (capped at 100
  rows) and buckets by the session's *start* day.

The per-feature sections in `docs/FEATURES.md` carry the full list.
