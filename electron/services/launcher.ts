import { shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import type { Game, SessionExitReason } from '@shared/types'
import { gamesRepo, sessionsRepo, settingsRepo } from '@db/index'

/**
 * Launches games and tracks how long they run.
 *
 * The tracking model is deliberately simple: spawn the executable as a child
 * process and treat its exit as the end of the session. That is exact for games
 * whose executable IS the game, which covers most DRM-free and standalone
 * titles. Where it breaks -- launcher-style games -- is documented in
 * docs/FEATURES.md rather than papered over, because a wrong playtime number is
 * worse than an obviously missing one.
 */

interface RunningGame {
  gameId: number
  sessionId: number
  child: ChildProcess
  /** Monotonic-ish start marker used for duration; the ISO string is for storage. */
  startedAtMs: number
  startedAtIso: string
}

const running = new Map<number, RunningGame>()

export interface SessionEndPayload {
  gameId: number
  sessionId: number
  durationSeconds: number
  exitReason: SessionExitReason
  exitCode: number | null
  discarded: boolean
}

type SessionEndListener = (payload: SessionEndPayload) => void
let onSessionEnd: SessionEndListener = () => {}

/** Registered once at startup by the sessions IPC module. */
export function setSessionEndListener(listener: SessionEndListener): void {
  onSessionEnd = listener
}

export function getRunningGameIds(): number[] {
  return [...running.keys()]
}

export function isRunning(gameId: number): boolean {
  return running.has(gameId)
}

/**
 * Splits a launch-argument string into argv entries, honouring quotes so that
 * `-path "C:\My Games\save"` stays one argument.
 *
 * Written by hand rather than passing the string to a shell: `shell: true`
 * would let characters like `&` and `|` in a path or argument execute
 * additional commands.
 */
export function parseLaunchArgs(input: string | null): string[] {
  if (!input) return []

  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasContent = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasContent || current.length > 0) {
        args.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += char
    hasContent = true
  }

  if (hasContent || current.length > 0) args.push(current)
  return args
}

interface ResolvedTarget {
  command: string
  args: string[]
  cwd: string
}

/**
 * Works out what to actually execute.
 *
 * Three cases need special handling on Windows:
 *
 *   - **.lnk** shortcuts cannot be spawned. Electron can read them, so the
 *     shortcut is resolved to its real target and that is launched instead --
 *     which keeps exit tracking working. Its stored arguments and working
 *     directory are merged in, since a shortcut often carries the only correct
 *     ones (Steam and GOG shortcuts in particular).
 *   - **.url** files are INI text, not programs. They hand off to a protocol
 *     handler (`steam://...`), so there is no process to watch. Rejected with an
 *     explanation rather than launched untracked, because a session that can
 *     never end would sit "running" forever and corrupt the playtime totals.
 *   - **.bat / .cmd** are scripts. They run through `cmd.exe /c` with the path
 *     as a separate argv entry, so no shell parsing is applied to the path.
 */
function resolveTarget(game: Game): ResolvedTarget {
  const executable = game.executablePath
  const extension = extname(executable).toLowerCase()
  const declaredArgs = parseLaunchArgs(game.launchArgs)

  if (!existsSync(executable)) {
    throw new Error(`Executable no longer exists: ${executable}`)
  }
  if (!statSync(executable).isFile()) {
    throw new Error(`Executable path is not a file: ${executable}`)
  }

  if (extension === '.url') {
    throw new Error(
      'This is an internet shortcut (.url), which hands the game off to another ' +
        'launcher. LaunchPad cannot measure playtime for it. Point this game at the ' +
        'real .exe instead.'
    )
  }

  if (extension === '.lnk') {
    if (process.platform !== 'win32') {
      throw new Error('.lnk shortcuts can only be resolved on Windows.')
    }
    // readShortcutLink throws if the file is not a valid shortcut.
    const link = shell.readShortcutLink(executable)
    if (!link.target) {
      throw new Error(`Shortcut has no target: ${executable}`)
    }
    if (!existsSync(link.target)) {
      throw new Error(`Shortcut points at a missing file: ${link.target}`)
    }
    return {
      command: link.target,
      // Shortcut args first: they are usually the ones that make the game start
      // correctly, and any the user added here are additive.
      args: [...parseLaunchArgs(link.args ?? null), ...declaredArgs],
      cwd: game.workingDirectory ?? link.cwd ?? dirname(link.target)
    }
  }

  if (extension === '.bat' || extension === '.cmd') {
    return {
      command: process.env['COMSPEC'] ?? 'cmd.exe',
      args: ['/c', executable, ...declaredArgs],
      cwd: game.workingDirectory ?? dirname(executable)
    }
  }

  return {
    command: executable,
    args: declaredArgs,
    cwd: game.workingDirectory ?? dirname(executable)
  }
}

export interface LaunchOptions {
  /** Called after the child spawns successfully, before the session row is read back. */
  onSpawned?: (gameId: number) => void
}

/**
 * Spawns the game and opens a session row.
 *
 * The session row is written BEFORE the process is confirmed running, so that a
 * LaunchPad crash during the session still leaves a detectable open row. If the
 * spawn itself fails, the row is discarded again in the error path.
 */
export function launchGame(gameId: number): { sessionId: number; startedAt: string } {
  if (running.has(gameId)) {
    throw new Error('That game is already running.')
  }

  const game = gamesRepo.getGame(gameId)
  if (!game) throw new Error(`Game ${gameId} not found`)

  const target = resolveTarget(game)

  if (!existsSync(target.cwd)) {
    throw new Error(`Working directory does not exist: ${target.cwd}`)
  }

  const startedAtIso = new Date().toISOString()
  const session = sessionsRepo.startSession(gameId, startedAtIso)

  let child: ChildProcess
  try {
    child = spawn(target.command, target.args, {
      cwd: target.cwd,
      // 'ignore' rather than 'pipe': nothing reads the game's output, and an
      // unread pipe fills its buffer and can block the game once it is full.
      stdio: 'ignore',
      // The game is a sibling, not a dependent: it must survive LaunchPad
      // closing. detached also stops Ctrl+C in a dev terminal killing the game.
      detached: true,
      windowsHide: false
    })
  } catch (err) {
    sessionsRepo.discardSession(session.id)
    throw err
  }

  // Let LaunchPad exit without waiting on the child, while still receiving its
  // exit event for as long as LaunchPad is alive.
  child.unref()

  const entry: RunningGame = {
    gameId,
    sessionId: session.id,
    child,
    startedAtMs: Date.now(),
    startedAtIso
  }

  // 'spawn' fires only once the process is actually created; 'error' fires
  // instead when the executable cannot be started (ENOENT, EACCES). Without the
  // error branch a failed launch would leave a session open forever.
  child.once('error', (err) => {
    running.delete(gameId)
    sessionsRepo.discardSession(session.id)
    console.error(`[launcher] failed to start game ${gameId}:`, err)
    onSessionEnd({
      gameId,
      sessionId: session.id,
      durationSeconds: 0,
      exitReason: 'unknown',
      exitCode: null,
      discarded: true
    })
  })

  child.once('exit', (code, signal) => {
    handleExit(entry, code, signal)
  })

  running.set(gameId, entry)
  return { sessionId: session.id, startedAt: startedAtIso }
}

function handleExit(
  entry: RunningGame,
  code: number | null,
  signal: NodeJS.Signals | null
): void {
  // An exit can arrive after closeAllSessions() already recorded this session
  // during shutdown; ignore the duplicate.
  if (!running.has(entry.gameId)) return
  running.delete(entry.gameId)

  const durationSeconds = Math.max(0, Math.round((Date.now() - entry.startedAtMs) / 1000))
  const minSessionSeconds = settingsRepo.getSettings().minSessionSeconds

  /*
   * Exit-reason heuristic. A signal means the process was killed. A non-zero
   * exit code USUALLY means a crash, but plenty of games return non-zero on a
   * perfectly normal quit, so this label is a hint, not a fact -- the raw code
   * travels with the event so the UI can show it.
   */
  const exitReason: SessionExitReason =
    signal !== null ? 'crashed' : code !== null && code !== 0 ? 'crashed' : 'exited'

  // Sessions below the threshold are discarded rather than stored with a tiny
  // duration: they are almost always a failed launch or an immediate re-quit,
  // and they would otherwise clutter the history and skew the average.
  if (durationSeconds < minSessionSeconds) {
    sessionsRepo.discardSession(entry.sessionId)
    onSessionEnd({
      gameId: entry.gameId,
      sessionId: entry.sessionId,
      durationSeconds,
      exitReason,
      exitCode: code,
      discarded: true
    })
    return
  }

  const endedAt = new Date().toISOString()
  try {
    sessionsRepo.endSession(entry.sessionId, endedAt, durationSeconds, exitReason)
  } catch (err) {
    // The game row may have been deleted mid-session, cascading the session
    // away. Nothing to record, but the UI still needs to stop showing "Playing".
    console.error(`[launcher] could not close session ${entry.sessionId}:`, err)
  }

  onSessionEnd({
    gameId: entry.gameId,
    sessionId: entry.sessionId,
    durationSeconds,
    exitReason,
    exitCode: code,
    discarded: false
  })
}

/**
 * Closes every open session because LaunchPad itself is quitting.
 *
 * Unlike a crash (handled by reconcileOpenSessions at startup, which records
 * duration 0 because the elapsed time was never observed), the app IS alive
 * here, so the real elapsed time is known and recorded. The caveat is that the
 * game may keep running afterwards -- LaunchPad is detached from it -- so this
 * duration is a lower bound, which `app_closed` marks it as.
 *
 * Runs synchronously: 'before-quit' does not wait for promises.
 */
export function closeAllSessionsOnQuit(): void {
  const entries = [...running.values()]
  running.clear()

  const minSessionSeconds = settingsRepo.getSettings().minSessionSeconds

  for (const entry of entries) {
    const durationSeconds = Math.max(0, Math.round((Date.now() - entry.startedAtMs) / 1000))
    try {
      if (durationSeconds < minSessionSeconds) {
        sessionsRepo.discardSession(entry.sessionId)
      } else {
        sessionsRepo.endSession(
          entry.sessionId,
          new Date().toISOString(),
          durationSeconds,
          'app_closed'
        )
      }
    } catch (err) {
      console.error(`[launcher] shutdown could not close session ${entry.sessionId}:`, err)
    }
  }
}
