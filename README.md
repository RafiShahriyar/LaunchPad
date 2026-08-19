# LaunchPad

Desktop game library manager for Windows: add games, launch them, track playtime,
and automatically back up and restore their save files.

Electron + React + TypeScript + Redux Toolkit, with SQLite via Node's built-in
`node:sqlite`.

---

## Getting started

Requires **Node 22 or newer** (Node 24 recommended — it matches the runtime
Electron bundles).

```bash
npm install
node node_modules/electron/install.js
npm run dev
```

**The second command is not optional.** Electron 43 ships **no `postinstall`
script** — its `package.json` has no `scripts` field at all, and `install.js` is
published as a bin (`install-electron`) instead. So `npm install` finishes in
well under a minute and never downloads the ~235 MB `electron.exe`; running
`npm run dev` at that point fails on the missing binary. Fetching it explicitly
is the whole fix, and it only has to be done once.

You can confirm it worked: `node_modules/electron/dist/electron.exe` should
exist.

`npm run dev` opens the app with renderer hot reload and automatic main/preload
restarts.

### If PowerShell refuses to run npm

On a default Windows install PowerShell's execution policy is `Restricted`,
which blocks `npm.ps1`:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
scripts is disabled on this system.
```

This is not a permissions problem and running as Administrator does **not** fix
it — the policy applies to administrators too. Either use `npm.cmd run dev`,
which skips the PowerShell shim, or allow local scripts for your own account
(no admin needed):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Git Bash and `cmd.exe` are unaffected.

### Where your data lives

Everything is stored under Electron's per-user data directory, which on Windows
is `%APPDATA%\launchpad`:

```
launchpad.db     SQLite database (games, sessions, backups, settings)
covers/          managed cover art
backups/         save-file snapshots, one folder per game
```

Nothing is written into the project directory, and nothing leaves the machine.
To move a library between computers, copy that whole folder.

### Filling in cover art and genres

**Settings → Game metadata** connects LaunchPad to a games database so it can
fill in cover art, genres, a summary and a release date instead of you hunting
for box art. Entirely optional — everything else works without it.

You supply your own free key. Pick whichever suits you:

| Provider | What it gives | Sign-up |
|---|---|---|
| **RAWG** | Genres, descriptions, dates. Huge catalogue. | Email only — [rawg.io/apidocs](https://rawg.io/apidocs) |
| **SteamGridDB** | Portrait box art, the shape the grid draws | Steam login — [steamgriddb.com](https://www.steamgriddb.com/profile/preferences/api) |
| **IGDB** | All of the above from one source | Twitch app — [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) |

**RAWG + SteamGridDB is the recommended pair.** RAWG's own images are landscape
screenshots that crop badly into the 3:4 cards, and SteamGridDB fixes exactly
that. Neither needs a phone number.

**IGDB alone** is the fewest moving parts, but registering a Twitch application
requires two-factor authentication on your Twitch account, and Twitch's SMS
delivery fails outright in some countries. If you hit
*"We weren't able to register two-factor authentication for your phone number"*,
use RAWG instead — that is what it is there for.

Keys are verified against the service before they are stored, kept on this
machine, and never displayed again.

Then just **start typing a game's name** in the add/edit dialog — the Name field
is a searchable dropdown. Matches appear beneath it with cover thumbnails, year
and genres; pick one and LaunchPad fills in the rest when you save. Covers open
full size on click, and a game with no artwork says so rather than showing a
blank box.

### Trying it without real games

In development builds only: **Settings → Developer → Add sample data**. It
creates eight games with generated cover art, session history across the last 30
days, real save folders and a few snapshots. It is safe to re-run — it skips
games already present — and it is stripped from production builds.

---

## Commands

```bash
npm run dev        # dev server: renderer HMR + main/preload restart
npm run build      # typecheck both projects, then build all three targets
npm start          # run the production build unpackaged
npm run typecheck  # both tsconfig projects
npm run verify:db  # 97-assertion data-layer suite under plain Node (~1s)
npm run test:e2e   # 447 end-to-end assertions against a real Electron window
npm test           # both suites
npm run dist       # package a Windows build
```

`npm run test:e2e` needs a current build — run `npm run build` first. Pass a
filter to run one suite: `npm run test:e2e -- backups`.

---

## Layout

```
electron/     main process — the only layer that can touch the disk
  ipc/        one module per domain; every handler returns a result envelope
  services/   launching, backups, restore, covers, maintenance
db/           SQLite schema, migrations and repositories (no Electron imports)
shared/       the IPC contract and domain types, compiled into both projects
src/          renderer — React + Redux, fully sandboxed
tests/        end-to-end suites driven over the DevTools Protocol
docs/         architecture, data model, features, code flow
```

---

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — start here. Constraints that will bite you,
  invariants that must not be broken, environment blockers, known limitations.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the three-layer split and why
  each decision went the way it did.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — schema, with every column justified.
- [docs/FEATURES.md](docs/FEATURES.md) — what works, how, and every known
  limitation.
- [docs/CODE_FLOW.md](docs/CODE_FLOW.md) — step-by-step traces of each user
  action, file by file.

---

## Known limitations

The significant one: **games that launch through another launcher (many Steam
titles, Ubisoft Connect, Battle.net) report almost no playtime.** They spawn the
real game as a separate process and exit immediately, so the process LaunchPad
tracks dies seconds after launch.

Also worth knowing: **antivirus can refuse the launch outright.** If a game does
nothing when you press Play, LaunchPad now shows the reason in a red banner
rather than failing silently. A message about Windows refusing to start the
executable usually means Defender is blocking it — adding an exclusion for that
game's folder is the fix, and it is your call to make.

`docs/FEATURES.md` carries the full list.

## Licence

MIT
