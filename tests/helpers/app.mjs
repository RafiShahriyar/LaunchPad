/**
 * Launches the built app under test with a throwaway user-data directory.
 *
 * Every suite gets its own profile, so suites cannot see each other's games,
 * settings or backups. That is what lets them run in any order, and it is why a
 * failure in one suite never cascades into the next.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(import.meta.dirname, '..', '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DEBUG_PORT = 9222

export function assertBuilt() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('No build found in out/. Run `npm run build` first.')
  }
  if (!existsSync(ELECTRON)) {
    throw new Error(`Electron binary missing at ${ELECTRON}. Run \`npm install\`.`)
  }
}

/** Kills any stray instance so a previous crash cannot hold the debug port. */
export function killStrays() {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' })
  } catch {
    // Nothing running, which is the normal case.
  }
}

export class AppInstance {
  constructor(profileDir) {
    this.profileDir = profileDir
    this.child = null
  }

  get dbPath() {
    return join(this.profileDir, 'launchpad.db')
  }

  get backupsRoot() {
    return join(this.profileDir, 'backups')
  }

  start() {
    this.child = spawn(
      ELECTRON,
      ['.', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${this.profileDir}`],
      { cwd: ROOT, stdio: 'ignore', detached: false }
    )
  }

  /**
   * Force-kills the process, which is what an OS-level crash looks like:
   * 'before-quit' never runs, so open sessions are left for startup
   * reconciliation to close. Suites testing crash recovery depend on this.
   */
  kill() {
    killStrays()
    this.child = null
  }

  async restart() {
    this.kill()
    await delay(1500)
    this.start()
    await delay(1000)
  }

  /**
   * Edits a setting directly, for values with no IPC path or that would need a
   * 30-second wait otherwise (minSessionSeconds, chiefly). WAL mode makes a
   * second writer safe while the app holds the database open.
   */
  setSetting(key, value) {
    const db = new DatabaseSync(this.dbPath, { enableForeignKeyConstraints: true })
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key)
    db.close()
  }

  withDb(fn) {
    const db = new DatabaseSync(this.dbPath, { enableForeignKeyConstraints: true })
    db.exec('PRAGMA busy_timeout = 5000')
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }
}

export async function launchApp(profileDir) {
  killStrays()
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  const app = new AppInstance(profileDir)
  app.start()
  await delay(1200)
  return app
}
