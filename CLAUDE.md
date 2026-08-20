# LaunchPad — working notes

Desktop game library manager: add games, launch them, track playtime, and back
up / restore their save files. Electron + React + TypeScript + Redux Toolkit,
SQLite via `node:sqlite`.

All 8 planned features are built, plus custom window chrome (dark title bar,
self-drawn window controls, fullscreen), a collapsible sidebar, game-metadata
lookup (cover art, genres, summaries) from IGDB or RAWG with optional
SteamGridDB artwork, four colour themes, and a dev-only sample-data seeder.
**626 assertions pass** — 106 in the data-layer suite and 520 end-to-end against a
live Electron window. Both are committed and runnable with `npm test`.

Repository: <https://github.com/RafiShahriyar/LaunchPad>

Detailed docs live in `docs/` — `docs/ARCHITECTURE.md` (structure and why),
`docs/DATA_MODEL.md` (schema, every column justified), `docs/FEATURES.md` (what works, how,
and every known limitation), `docs/CODE_FLOW.md` (step-by-step traces of each user
action). **Update the relevant doc in the same change that alters behaviour** —
that convention has held for the whole project.

---

## Commit authorship — do not credit AI as a contributor

**No commit in this repository may carry an AI co-author trailer.** No
`Co-authored-by:` line naming Claude, Copilot, ChatGPT, Gemini or similar, and
no commit authored as one.

This is not a style preference. GitHub parses `Co-authored-by:` trailers and
credits the named account in the repository's **contributor list** — so a
trailer added out of habit changes who GitHub says wrote this project. Undoing it
after the fact means rewriting history and force-pushing, which invalidates every
existing clone, link and PR reference.

It has already cost that once: the first two commits carried
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, both had to be rebuilt
with `commit-tree` and force-pushed, and the trailer then came back on the
themes commit and had to be amended out again.

**Enforced by a hook, not by memory.** `.githooks/commit-msg` strips matching
trailers and reports what it removed, and refuses outright if the commit's own
author looks like an AI. Hooks are not copied by `git clone`, so enable it once
per clone:

```bash
git config core.hooksPath .githooks
```

Check it is on with `git config --get core.hooksPath` — it should print
`.githooks`. Human co-authors are deliberately left alone; pair programming is
worth crediting.

**Auditing history:**

```bash
git log --format='%h %s | %(trailers:only)' --all
```

Any output with a trailer on it is a commit to fix. `%an`/`%ae` should be a
person on every line.

**If one does slip through**, fix it before merging rather than after — an amend
on an unmerged branch costs nothing, whereas the same fix on `main` is a forced
rewrite of published history.

### The GitHub contributor cache is separate, and slower

Removing the trailers fixes the data; the sidebar on the repository page is a
**cached view** and lags well behind. Two sources disagree during that window:

| Source | Reflects |
|---|---|
| `GET /repos/:owner/:repo/contributors` | Current history — updates promptly |
| The repo page's Contributors box (`/_sidebar`) | A precomputed cache — can lag a day or more |

At the time of writing the REST API reports one contributor while the sidebar
still lists `claude`. That is expected and is not a sign the rewrite failed.
Pushing a new commit does **not** reliably flush it. If it persists, a GitHub
Support request to purge the contributors cache is the only remaining lever.

---

## Commands

```bash
npm run dev        # electron-vite dev --watch : renderer HMR + main/preload restart
npm run build      # typecheck both projects, then build all three targets to out/
npm start          # run the production build unpackaged
npm run typecheck  # both tsconfig projects
npm run verify:db  # 106-assertion data-layer suite (plain Node, ~1s)
npm run test:e2e   # 520 assertions against a real Electron window (~3 min)
npm test           # both
npm run dist       # build + electron-builder → Windows (see Packaging below)
```

Full setup instructions for a fresh clone are in `README.md`.

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

**Metadata thumbnails are `data:` URIs, not remote URLs.** The renderer's CSP
sets `connect-src 'none'` and must keep doing so — the page opens no sockets of
its own. So the provider clients fetch thumbnails in **main** and inline them as
base64 in the search result. `img-src` already allowed `data:`, so **adding the
whole metadata feature changed the CSP by nothing**. The full-size cover stays a
URL and is only downloaded when a match is applied.
- Thumbnail fetches deliberately bypass each provider's `throttle()`. That budget
  exists for the documented API limit; thumbnails hit a plain image CDN, and
  serialising a dozen would add ~3s to every search.
- `apply` **discards** the thumbnail the renderer sends back and re-resolves the
  cover. Trusting bytes returned by the untrusted side buys nothing.

**Three providers, one registry.** `electron/services/providers/` holds one
client per service; `electron/services/metadata.ts` is the registry and the only
file that knows which exist. Everything above it — IPC contract, repository,
schema, settings screen — is provider-agnostic, and the settings screen renders
each provider from its own `ProviderDescriptor` rather than a hard-coded branch.
- `igdb` and `rawg` supply text (`MetadataSource`); `steamgriddb` supplies art
  only (`CoverArtSource`) because it has no genres or descriptions.
- Search priority is `['igdb', 'rawg']` — IGDB is complete from one query. The
  settings screen **states which one is in use** rather than leaving it inferred.
- The art provider runs at **apply** time only, never per search result: twelve
  results would be twenty-four requests for artwork about to be discarded.
- RAWG's list endpoint carries no description, so `enrich()` fetches it for the
  single chosen entry. Doing it per row would be 13 requests against a monthly
  quota.

**Enumerating a union as an array literal is a trap.** `readonly MetadataSource[]`
happily accepts a SHORT list, so adding `'rawg'` and forgetting one array
compiled fine and then failed at runtime with
`Column "metadata_source": rawg is not one of igdb`. That was a real bug, caught
only by the e2e suite. Both lists are now
`Record<MetadataSource, true>` with `Object.keys()`, which makes a missing member
a compile error. Do the same for any new union enumerated this way.

**Provider credentials are NOT in `AppSettings`.** `settings:get` hands the whole
settings object to the renderer, so a secret there would sit in the Redux store
and be readable from devtools. They live in `db/repositories/credentials.ts`
under derived `cred_<provider>_<field>` keys — same settings table, deliberately
not the same surface. The renderer only ever receives
`{configured, maskedKey, hasCachedToken}`. **This is why the four-place "adding a
setting" recipe below does not apply to them.**
- Credentials are verified against the live service *before* being stored, so a
  bad key fails at the action that caused it rather than as a broken search.
- `verify()` **returns** a token rather than caching it. Storing credentials
  deliberately clears any cached token, so a token written during verification
  was wiped moments later — another real bug the suite caught. The registry
  persists it after the credentials land.
- IGDB's OAuth token is cached in SQLite because tokens last ~60 days;
  re-authenticating per app start would be a pointless request and would fail
  the session's first search whenever the network is briefly down at launch.
- A 401 mid-session triggers exactly one retry with a freshly minted token. A
  revoked token and a bad secret are otherwise indistinguishable, and without
  the retry the feature would stay broken until credentials were re-entered.

**The name field is a combobox, not an input plus a search button.** Typing in
it searches the metadata provider directly (`src/components/NameCombobox.tsx`).
It replaced a separate "Find game info…" panel, which made looking a game up a
deliberate second step when the user is already typing the name into a box.
- **Debounced 350 ms, minimum 2 characters.** Not cosmetic: RAWG's free tier is
  a monthly request quota, so a request per keystroke spends it on prefixes
  nobody wanted results for, and a single letter matches thousands of games.
- **Escape must `stopPropagation()`.** `Modal` listens for Escape on `document`
  to dismiss the whole form, so without it one keypress closes the suggestions
  *and* discards everything the user typed. Same trap in `CoverViewer`, which
  additionally registers in the **capture** phase — Modal's listener is attached
  first, so a bubble-phase handler runs after the form has already closed.
- Selecting an entry sets a `justSelected` ref so the programmatic name change
  does not immediately re-open the list over the answer just chosen.
- Options are chosen on **mousedown**, not click: the input's blur would
  otherwise close the list before the click landed.

**`CoverViewer` is deliberately NOT in `uiSlice`'s modal union.** That union
exists to make two simultaneously-open dialogs unrepresentable; the viewer is a
detail *of* the game form, not a competitor to it. Registering it would either
close the form underneath or break the invariant. It renders at `z-[60]`, one
layer above `Modal`'s `z-50`.
- **Use `z-[60]`, not `z-60`.** Tailwind's default z-index scale stops at 50, so
  `z-60` is silently dropped and the viewer renders *under* the dialog it was
  opened from.

**Two `bg-*` utilities on one element resolve by STYLESHEET order, not class
order.** So "set the variant, then override the background at the call site"
works or does not depending on which utility Tailwind happened to emit last —
and it can differ between the dev server and a production build. Add a real
variant instead; `Button`'s `glass` (translucent, for controls sitting on
artwork rather than on a surface) is the worked example. The same trap applies
to any pair of utilities setting one property.

**Wide art is a SEPARATE column from the cover, and they can be the same file.**
`hero_image_path` (schema v4) holds the detail page's backdrop. Both live in the
managed covers folder, so the `lpasset://` handler, the download guards and
`deleteCoversForGame()`'s prefix sweep all cover them unchanged.
- **`swapArtwork()` takes a `keep` argument, and removing it reintroduces a real
  bug.** A RAWG-only setup writes ONE landscape image to both columns — its
  `background_image` is a screenshot, which is exactly why it makes a poor 3:4
  cover and a fine backdrop. Replacing the cover would then delete the file the
  hero still points at. `keep` is the other artwork path and suppresses the
  delete when they match.
- **Cover and hero report separate errors** (`coverError` / `heroError`). They
  fail for different reasons with different consequences, and one combined field
  could not say which happened.
- The art provider is asked for each shape separately, so **SteamGridDB costs two
  name lookups per apply**. Deliberate: caching the id across them would save one
  request on a path nobody runs in a loop, in exchange for a cache to invalidate.
- **The three-step backdrop fallback lives in the renderer, not the row.** Wide
  art → blurred cover → stated absence. Writing "use the cover" into the database
  would make the row claim something no provider said.

**Themes are CSS variables, and that is load-bearing.** Tailwind v4 compiles
`bg-surface-900` to `var(--color-surface-900)` rather than inlining the hex, so a
theme is sixteen redefined variables under `[data-theme='…']` and switching one
repaints the app through the cascade. Three ramps: `surface-*` (backgrounds),
`content-*` (text), `accent-*` (the interactive hue).
- **Never hardcode a `slate-*` (or any palette) class for text.** Use
  `text-content-*`. The 152 hardcoded ones were what blocked theming for the
  whole project until they were renamed; adding one back silently un-themes that
  element.
- **The selector is `[data-theme=…]`, deliberately NOT `:root[data-theme=…]`.**
  `:root` matches `<html>` alone, so the settings picker — which previews each
  palette by nesting the attribute — would render four identical swatches. The
  unanchored form also sidesteps a specificity race: these blocks are unlayered
  and beat everything Tailwind puts in `@layer theme`.
- **The attribute goes on `<html>`**, because `body` and the scrollbar rules sit
  outside the React tree.
- `@theme` and `[data-theme='dark']` hold the same sixteen values, unavoidably —
  `@theme` must declare every token for Tailwind to generate the utility at all,
  while a nested swatch needs somewhere to reset to. `themes.mjs` asserts they
  match rather than trusting the comment.
- **`dark` keeps its id** rather than becoming `midnight`: stored settings say
  `dark`, and unknown values fall back to the default, so a cosmetic rename would
  reset every upgrading install.

**`db/verify.ts` bundles with no path aliases unless told.** It is built by a bare
`esbuild` call, which for a long time needed no alias config because `db/`
imported only *types* from `@shared` — and type imports erase before bundling.
The first runtime import (`isThemeId`) broke it with
`Could not resolve "@shared/types"`. Fixed by adding `--tsconfig=tsconfig.node.json`
so esbuild reads the `paths` already declared there, rather than duplicating the
mapping on the command line. Expect this again if `db/` gains another runtime
import from a new alias.

**Hooks go above the early return in `GameDetailPage`.** It returns early when
the game is gone, so a `useState` declared next to the markup that uses it
changes the hook count the moment a game is deleted while its detail view is
open — React then throws instead of showing the library. That was a real
regression, caught by `detail-view`.

**Scrim opacity is coupled to whether the backdrop is blurred.** The detail
header's gradients were originally tuned over a *blurred* cover, where crushing
the image cost nothing because there was nothing to see. Removing the blur made
those same values flatten real key art to near-black — the header looked broken
while every assertion still passed, because a testid proves the image is in the
DOM, not that anyone can make it out. **If you touch the blur, re-tune the
scrims, and look at a screenshot.**

**The detail header has no info panel.** A translucent six-row panel used to sit
on the right; four of its rows duplicated tiles in the stat grid immediately
below, and it covered the artwork the header exists to show. Genres are now pills
under the play controls, and the panel's one unique row (Backups) became a sixth
stat tile. `formatGenres()` still distinguishes null from `[]` — the pills are
skipped entirely for those cases so the wording survives.

**Values in a `Stat` tile are `truncate`d.** "Off for this game" rendered as
"Off for this g…", so it says "Off". A clipped value is worse than a terse one
when the label above it already carries the noun.

**Buttons get their pointer cursor from one rule in `index.css`.** Tailwind v4's
Preflight leaves buttons at the browser default of `cursor: default`, so every
control in the app looked inert. Set globally rather than per-component, with
`:disabled` excluded — a pointer on a dead control is a lie about what a click
will do.

**Long provider summaries are clamped, not truncated in the data.** `Synopsis`
clamps to three lines and offers "Read more" only when the text actually exceeds
`SYNOPSIS_CLAMP_CHARS`, so the toggle never invites a click that changes nothing.
The threshold is a character count rather than a measured element: measuring
means a layout read every render plus a resize listener, for a decision that only
needs to be roughly right.

**Missing artwork is stated, never implied.** A bare placeholder reads equally as
"this game has no art" and "the art failed to load". Cards, the detail header and
the form all say "No cover" / "No cover image" and carry `data-testid="no-cover"`;
suggestion rows with no thumbnail say "No art".

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

**`spawn()` has two failure paths, and they behave differently.** Some failures
throw **synchronously** (`EFTYPE`, a file that is not a program). Others arrive
**asynchronously** through the child's `error` event (`EACCES`, observed with a
game Defender refused to start) — and by then `sessions:launch` has *already
resolved successfully*, so the launch thunk cannot report them.
- `SessionEndedEvent.launchError` exists solely to carry that reason back. Before
  it, the message was `console.error`'d in main and dropped: the UI flipped from
  "Playing" back to "Play" and said nothing, indistinguishable from a session the
  user quit instantly. **"Nothing happens when I press Play" was the bug report.**
- `describeSpawnFailure()` must stay wired to **both** paths. It is easy to fix
  one and leave the other leaking a raw `spawn EFTYPE` into the banner.
- Only the synchronous path can be provoked in a test. Producing a real `EACCES`
  needs a locked binary or antivirus interference, so the async path is covered
  by asserting the contract (`launchError` present, null on a normal exit) rather
  than by faking the OS.

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
- **`genres` distinguishes `null` from `[]`.** Null is "never looked up"; `[]` is
  "looked up, and the provider listed none". Collapsing them would make the app
  state that a game has no genres when it has simply never been asked about. The
  repository returns null for a column that will not parse, too — a corrupt
  value is not evidence for the positive claim that there are no genres.
- **"Not configured" never looks like "no results."** A search with no
  credentials fails with a message naming Settings, rather than returning an
  empty list that reads as "your game isn't in the database".
- **A failed cover download is reported as a partial success.** The genres and
  summary did apply, so the dialog stays open and says exactly that instead of
  closing silently and implying everything worked.
- **A missing release year renders as "Year unknown"**, not omitted, so a row
  never implies the provider has no date on record.

---

## Setup gotchas hit on this machine (August 2026)

All four cost real debugging time. None are project bugs; all are recorded so the
next person does not rediscover them.

**Electron 43 ships NO `postinstall` script.** Its `package.json` has no
`scripts` field at all — `install.js` is published as a bin
(`install-electron`). `npm install` therefore finishes in ~40s and **never**
downloads the ~235 MB `electron.exe`, and `npm run dev` then fails on the missing
binary. The fix is to run it explicitly, once:

```bash
node node_modules/electron/install.js
```

README used to claim `npm install` downloads it and that a fast install meant a
"skipped postinstall". Both were false and have been corrected.

**PowerShell blocks `npm` by default.** Execution policy `Restricted` refuses
`npm.ps1` with *"running scripts is disabled on this system"*. This is **not** a
permissions problem and running as Administrator does **not** help — the policy
applies to administrators too. Either use `npm.cmd`, or allow local scripts for
the current user (no admin needed):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Git Bash and `cmd.exe` are unaffected. On this machine every scope was
`Undefined`, i.e. the Windows default — nothing had been locked down.

**Node must be 22+.** The machine started on v20.16.0, which is below *every*
floor in this project — including Vite's `^20.19.0`, by three patch versions.
`npm run verify:db` also runs under the system Node and needs `node:sqlite`,
which landed in 22.5. Now on v24.19.0 / npm 11.17.0, where all 544 assertions
pass.

**npm 11 gates install scripts.** It reports `allow-scripts` warnings for
esbuild. Harmless here — esbuild's binary ships as the `@esbuild/win32-x64`
platform package, so nothing needs the postinstall.

---

## Environment blockers (machine-specific — re-test after a move)

**Everything in this section was diagnosed on one specific Windows machine and
may not apply elsewhere.** Both blockers below are caused by that machine's
security policy, not by anything in this project. On a different PC, re-test
before assuming either still holds — the fixes are cheap to undo.

**`npm run dist` could not produce an installer there.** The app itself packages
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

### Re-testing on a new machine

```bash
npm install
npm run build && npm test      # should pass everywhere
npm run dist                   # the machine-specific part
```

If `npm run dist` completes and produces an installer, both blockers are gone.
In that case, try moving back to the current electron-builder:

```bash
npm install --save-dev electron-builder@latest
npm run dist
```

If that also works, delete the pin note above. If it fails with
`No JSON content found in output`, the PowerShell/batch execution policy is the
same as on the original machine — stay on 25.x.

The symlink error (`A required privilege is not held by the client`) is fixed by
enabling **Windows Developer Mode**, and is unrelated to the version pin.

---

## Before shipping

- [ ] Add `build/icon.ico` — otherwise it ships with the default Electron icon.
- [x] Set `author` in `package.json`. It doubles as electron-builder's NSIS
      publisher name — `electron-builder.json` sets no `publisherName`, so it
      falls back to this.
- [ ] Configure code signing — unsigned installers trigger SmartScreen.
- [ ] Resolve the two packaging blockers above.
- [ ] Consider code-splitting: the renderer bundle is ~793 kB, **~146 kB gzipped** (measured, not estimated — Vite reports decimal kB).
      Fine for a desktop app loading from disk, but it has grown steadily.

---

## Testing

```bash
npm test              # both suites
npm run verify:db     # data layer, plain Node, ~1s
npm run test:e2e      # end-to-end, ~3 min
npm run test:e2e -- backups   # one suite while debugging
```

**`db/verify.ts` (106 assertions)** runs the real repositories against a temp
database under plain Node — possible only because `db/` imports nothing from
Electron. It includes **hand-built v1→v2 and v2→v3 migration tests**; migrations
are the one thing that cannot be fixed after release. Each builds its legacy
database by hand rather than replaying the project's own migration list, which
would only prove the list is self-consistent.

**`tests/` (520 assertions across 13 suites)** drives a real Electron window over
the Chrome DevTools Protocol. Most of what matters here only exists across the
process boundary — IPC validation, push events, file copies, window chrome — so
mounting components in isolation would exercise none of it.

| Suite | Covers |
|---|---|
| `games` / `games-ui` | CRUD, validation, cover pipeline, form UX, cover viewer, no-cover states |
| `ipc-validation` | Malformed input from the renderer |
| `sessions` | Launch, exit detection, discard threshold, crash recovery |
| `backups` | Copy, dedup, rotation, pinning, usage |
| `restore` / `restore-ui` | Replacement semantics, undo snapshot, refusals |
| `detail-view` | Stats, activity chart, live updates, the hero header's three backdrop states |
| `settings` | Validation, backups-root change, orphan cleanup |
| `window-chrome` | Title bar, control hover states, fullscreen |
| `sidebar-and-demo` | Sidebar collapse, sample-data seeder |
| `metadata` | Three providers, credentials, search, apply, cover **and hero** art, injection guards, the name combobox |
| `themes` | Four palettes, the picker, persistence, unknown-theme refusal, computed-colour proof |

`test:e2e` needs a current build — run `npm run build` first. Each suite gets a
freshly launched app with its own user-data directory, so suites cannot
contaminate each other and any one can be run alone.

Lessons worth keeping if you add more:
- `innerText` applies `text-transform`, so an `uppercase` label reads as
  `SESSIONS`. Match case-insensitively.
- `.blur()` only fires React's `onBlur` if the element was focused first, and
  setting `.value` directly is ignored — go through the native setter and
  dispatch `input`, as `helpers/cdp.mjs` does.
- Scope selectors to `[role=dialog]`: the page has same-named buttons, and the
  library search box is the first `<input>` in the document.
- `nativeVirtualKeyCode` is required for keys handled by main's
  `before-input-event` (F11). Renderer-handled keys work without it.
- **A test finding an element by `aria-label` proves it exists, not that anyone
  can see it.** The sidebar collapse control passed its test while being
  reported as missing. For visual work, look at a screenshot too.
- `Page.captureScreenshot` over CDP works and is the fastest way to actually look
  at the app. OS-level screen capture does **not** work on the original dev
  machine, so anything drawn by the OS rather than the page cannot be inspected
  there — which is why the window controls were moved into the page.
- Creating a game over IPC does not put it in the Redux store. Reload before
  asserting on the grid.
- `release/<version>/win-unpacked/LaunchPad.exe` does not rebuild unless
  `npm run dist` is re-run. Running a stale `.exe` has already caused one
  "the feature is missing" report.

---

## Adding a setting

The settings table is key/value, so a new setting needs **no migration** —
`seedDefaultSettings()` uses `INSERT OR IGNORE` and adds it on the next start.
Touch four places: `AppSettings` in `shared/types.ts`, `DEFAULT_SETTINGS` and
`SETTINGS_KEYS` in `db/defaults.ts`, the parser in
`db/repositories/settings.ts`, and `validatePatch()` in
`electron/ipc/settings.ts`. `sidebarCollapsed` is the worked example.

A setting whose values are a **union** needs a fifth thing: enumerate it as
`Record<Union, true>` in `shared/types.ts` with a type guard beside it, and have
both the parser and `validatePatch()` call that guard rather than writing the
list out twice. `ThemeId` / `isThemeId()` is the worked example.

## Sidebar

The collapse control lives in the sidebar **header**, beside the logo. It was
originally at the bottom of the rail in `slate-600` and got reported as missing —
it was rendering, just too dim and too far out of the way. Keep controls that
restructure the layout visually prominent.

## Sample data

`npm run dev` → Settings → Developer → **Add sample data**. Creates eight games
with generated PNG covers **and wide hero art**, ~65 sessions across the last 30
days, real save folders and four snapshots. Safe to re-run; it skips games
already present.

The hero is the same two colours as the cover **in the opposite order**, on
purpose. Identical artwork in both slots would hide the bug where the detail
header reads `coverImagePath` instead of `heroImagePath` — reversing the
gradient makes that mistake obvious on screen instead of invisible.

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
- **There is no light theme, and `ThemeId` no longer contains one.** Four dark
  palettes ship (Midnight / Nebula / Ember / Verdant). The blocker is no longer
  the text scale — that was tokenised — but the status banners: `bg-red-950`,
  `text-emerald-200` and `bg-amber-950` are fixed dark-mode colours outside every
  ramp, so a light surface renders them dark-on-dark. Tokenising those is the
  work a light theme needs. Installs that stored `theme = 'light'` before the
  union changed fall back to `dark` on read, which `db/verify.ts` asserts.
- **Themes change colour only** — not radii, spacing or layout density.
- **Nothing back-fills hero art.** `hero_image_path` is written only when
  metadata is applied, so a library matched before schema v4 shows the blurred
  cover until each game is re-matched. A refresh action is the fix and still does
  not exist — the same gap `metadata_id` was stored to close.
- **Wide art cannot be set by hand.** No picker, and the field is deliberately
  outside `NewGame`, so a game the providers do not carry can only fall back.
- **A game launched outside LaunchPad is invisible** — the running-game checks
  rely on LaunchPad having spawned the process.
- **Antivirus can block the spawn entirely.** Confirmed on the dev machine with
  Hades II: `CreateProcess` on `Hades2.exe` returns `EACCES` from Node/Electron
  while `Start-Process` (ShellExecute) launches it fine, and a byte-identical
  copy under a different name spawns without complaint. ACLs, attributes,
  manifest (`asInvoker`) and Mark-of-the-Web were all identical to a sibling exe
  that works, and Defender logged cloud-protection activity at the moment of the
  attempt. Nothing in LaunchPad can fix that — a Defender exclusion for the game
  folder is the user's call. What LaunchPad *can* do, and now does, is say so.
- **No router**, so no deep linking and the open game is not restored on restart.
- **Window size, position, maximised and fullscreen state are not persisted**
  across restarts. `isMaximized` is already tracked and pushed, so persisting it
  is a small addition. (The *sidebar* collapse state IS persisted, in settings.)
- **Snap Layouts are unavailable** — the deliberate cost of self-drawn window
  controls. Reverting is small: restore `titleBarOverlay` in `createWindow()`
  and drop the `ControlButton` block from `TitleBar.tsx`.
- **The activity chart** is built from the fetched session list (capped at 100
  rows) and buckets by the session's *start* day.

**Metadata, specifically:**

- **It needs credentials the user registers themselves.** There is no shared key,
  and there should not be: a key committed to a public repo is a key that gets
  revoked.
- **IGDB requires a Twitch account with SMS two-factor**, which fails outright in
  some countries — Twitch's SMS delivery to Bangladesh, for one, returns
  "We weren't able to register two-factor authentication for your phone number".
  That is why RAWG (email only) and SteamGridDB (Steam login) exist as the
  no-phone path, and why RAWG is not merely a fallback but a first-class source.
- **RAWG's images are landscape screenshots**, which crop badly into the 3:4
  grid. SteamGridDB is what makes RAWG's artwork usable; without it a
  RAWG-sourced cover is a letterboxed screenshot.
- **Genres are stored as a JSON array in one TEXT column**, not a join table.
  Nothing queries by individual genre yet. Genre *filtering* in the library is
  the migration that would justify a real table and an index — it was
  deliberately left out of the first change.
- **No bulk matching.** Each game is matched one at a time from its edit dialog.
  A "match everything" action needs rate limiting, partial-failure reporting and
  a review step before applying, which is a feature of its own.
- **Nothing re-fetches.** `metadata_id` and `metadata_updated_at` are stored so
  a refresh *can* re-query the same entry rather than re-searching by name, but
  no code calls it yet. That was the point of storing the provenance.
- **The summary is stored but not displayed anywhere.** It is written by
  `apply` and shown only in the picker. Surfacing it on the detail page is a
  UI change with no backend work left to do.
- **Credentials are stored in plaintext** in the settings table. On a
  single-user desktop app the database is already readable by anyone who can
  read the user's profile, so encrypting it with a key stored beside it would
  be theatre. Worth revisiting only if the app ever gains multi-user profiles.

The per-feature sections in `docs/FEATURES.md` carry the full list.
