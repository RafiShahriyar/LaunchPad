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
npm run dev
```

`npm install` downloads the Electron binary (~350 MB), so the first run takes a
few minutes. If it finishes suspiciously fast and `npm run dev` then fails with a
missing `electron.exe`, Electron's own postinstall was skipped — run
`node node_modules/electron/install.js` to fetch it.

`npm run dev` opens the app with renderer hot reload and automatic main/preload
restarts.

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
npm run verify:db  # data-layer suite under plain Node (~1s)
npm run test:e2e   # end-to-end suites against a real Electron window
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
tracks dies seconds after launch. `docs/FEATURES.md` carries the full list.

## Licence

MIT
