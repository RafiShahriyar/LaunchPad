import {
  Channels,
  type LaunchResult,
  type SessionEndedEvent,
  type SessionStartedEvent,
  type SessionStats
} from '@shared/ipc'
import type { PlaySession } from '@shared/types'
import { gamesRepo, sessionsRepo, settingsRepo } from '@db/index'
import { getRunningGameIds, launchGame, setSessionEndListener } from '../services/launcher'
import { broadcast } from './broadcast'
import { handle, requireId } from './handle'
import { runBackup } from './saves'

export function registerSessionHandlers(): void {
  /*
   * The launcher owns process lifetime but knows nothing about IPC or backups.
   * Wiring both here keeps that separation: services/launcher.ts has no
   * dependency on Electron windows, which is what lets it be reasoned about on
   * its own.
   */
  setSessionEndListener((payload) => {
    const session = payload.discarded ? null : sessionsRepo.getSession(payload.sessionId)
    const game = gamesRepo.getGame(payload.gameId)

    const event: SessionEndedEvent = {
      gameId: payload.gameId,
      session,
      game,
      discarded: payload.discarded,
      exitReason: payload.exitReason,
      exitCode: payload.exitCode,
      launchError: payload.launchError ?? null
    }
    broadcast(Channels.sessions.ended, event)

    /*
     * Post-session backup: this is the one that captures what the player just
     * did. The pre-launch backup protects the state they are about to change;
     * this one preserves the progress they just made.
     *
     * Deliberately fire-and-forget. The exit handler is synchronous (it is
     * driven by a process event), and blocking it on a folder copy would delay
     * the UI update that clears the "Playing" badge. Failures surface through
     * the backupFinished event rather than a rejected promise, since nothing is
     * awaiting this.
     *
     * Skipped for discarded sessions: those are failed launches, so the saves
     * cannot have changed and a snapshot would just consume a rotation slot.
     */
    if (!payload.discarded && game?.saveFolderPath) {
      const settings = settingsRepo.getSettings()
      if (settings.backupAfterSession) {
        void runBackup(payload.gameId, 'post_session').catch((err: unknown) => {
          console.error(`[saves] post-session backup failed for game ${payload.gameId}:`, err)
        })
      }
    }
  })

  /**
   * Launch, preceded by a pre-launch backup when enabled.
   *
   * The backup is awaited so the snapshot captures the save state *before* the
   * session can modify it -- that is the entire point of a pre-launch backup,
   * and starting the game first would race the copy against the game's own
   * writes.
   *
   * A backup FAILURE does not block the launch. The user asked to play; refusing
   * because a copy failed would be a worse outcome than playing with one fewer
   * restore point. The failure is broadcast so the UI can warn, and the launch
   * continues.
   */
  handle(Channels.sessions.launch, async (rawGameId: unknown): Promise<LaunchResult> => {
    const gameId = requireId(rawGameId, 'game id')

    const game = gamesRepo.getGame(gameId)
    if (!game) throw new Error(`Game ${gameId} not found`)

    if (settingsRepo.getSettings().backupBeforeLaunch && game.saveFolderPath) {
      try {
        await runBackup(gameId, 'pre_launch')
      } catch (err) {
        console.error(`[saves] pre-launch backup failed for game ${gameId}:`, err)
      }
    }

    const { sessionId } = launchGame(gameId)

    const session = sessionsRepo.getSession(sessionId)
    const launched = gamesRepo.getGame(gameId)
    if (!session || !launched) throw new Error('Game vanished during launch')

    const event: SessionStartedEvent = { session, game: launched }
    broadcast(Channels.sessions.started, event)

    return { session, game: launched }
  })

  handle(
    Channels.sessions.listForGame,
    (rawGameId: unknown, limit?: number): PlaySession[] =>
      sessionsRepo.listSessionsForGame(requireId(rawGameId, 'game id'), limit ?? 100)
  )

  handle(Channels.sessions.getStats, (rawGameId: unknown): SessionStats =>
    sessionsRepo.getSessionStats(requireId(rawGameId, 'game id'))
  )

  /**
   * Lets the renderer resync after a reload. The store's idea of what is
   * running lives only in renderer memory, so a refresh (or a dev hot reload)
   * would otherwise lose the "Playing" state of a game that is still running.
   */
  handle(Channels.sessions.getRunning, (): number[] => getRunningGameIds())
}
