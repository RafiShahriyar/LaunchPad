import {
  Channels,
  type BackupFinishedEvent,
  type BackupOutcome,
  type BackupUsage,
  type RestoreResult
} from '@shared/ipc'
import type { BackupTrigger, SaveBackup } from '@shared/types'
import { gamesRepo, savesRepo } from '@db/index'
import { createBackup, deleteBackup } from '../services/backups'
import { performRestore, planRestore } from '../services/restore'
import { broadcast } from './broadcast'
import { handle, requireId } from './handle'

/**
 * Runs a backup and tells every window what happened.
 *
 * Shared by the manual "Back up now" handler and by the automatic pre-launch
 * and post-session hooks, so all three report through the same channel and the
 * UI needs only one listener. Failures are reported as events too, not just
 * thrown, because the automatic ones have no caller waiting on a promise.
 */
export async function runBackup(
  gameId: number,
  trigger: BackupTrigger,
  options: { force?: boolean } = {}
): Promise<BackupOutcome> {
  const game = gamesRepo.getGame(gameId)
  if (!game) throw new Error(`Game ${gameId} not found`)

  try {
    const outcome = await createBackup(game, trigger, options)
    const event: BackupFinishedEvent = { gameId, trigger, outcome, error: null }
    broadcast(Channels.saves.backupFinished, event)
    return outcome
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const event: BackupFinishedEvent = {
      gameId,
      trigger,
      outcome: { status: 'skipped', reason: 'save_folder_missing' },
      error: message
    }
    broadcast(Channels.saves.backupFinished, event)
    throw err
  }
}

export function registerSavesHandlers(): void {
  handle(Channels.saves.listForGame, (rawGameId: unknown): SaveBackup[] =>
    savesRepo.listBackupsForGame(requireId(rawGameId, 'game id'))
  )

  /*
   * Manual backups are forced: they skip the "unchanged since last backup"
   * check. If a user explicitly presses Back up now, silently doing nothing
   * because a fingerprint matched would look like the button is broken -- and
   * the fingerprint is an mtime heuristic, not proof.
   */
  handle(
    Channels.saves.backupNow,
    (rawGameId: unknown): Promise<BackupOutcome> =>
      runBackup(requireId(rawGameId, 'game id'), 'manual', { force: true })
  )

  handle(Channels.saves.setPinned, (rawId: unknown, isPinned: unknown): SaveBackup => {
    if (typeof isPinned !== 'boolean') throw new Error('isPinned must be a boolean')
    return savesRepo.setBackupPinned(requireId(rawId, 'backup id'), isPinned)
  })

  handle(Channels.saves.remove, async (rawId: unknown): Promise<{ deleted: boolean }> => {
    await deleteBackup(requireId(rawId, 'backup id'))
    return { deleted: true }
  })

  /**
   * Restore: validate, take the undo snapshot, then swap.
   *
   * The ordering is the safety property. planRestore() performs every refusal
   * (game running, snapshot folder missing, no save folder configured) BEFORE
   * anything is written, so a rejected restore has touched nothing at all.
   *
   * The safety backup is forced and pinned:
   *   - forced, because the fingerprint check exists to avoid redundant routine
   *     backups, and this is the one snapshot that must never be skipped;
   *   - pinned, because rotating away the undo for a destructive action would
   *     defeat its purpose entirely.
   *
   * If the safety backup fails outright, the restore is abandoned. Overwriting
   * saves with no way back is exactly what this feature exists to prevent.
   */
  handle(Channels.saves.restore, async (rawBackupId: unknown): Promise<RestoreResult> => {
    const backupId = requireId(rawBackupId, 'backup id')
    const plan = planRestore(backupId)

    let safetyBackup = null
    if (plan.saveFolderExists) {
      const game = gamesRepo.getGame(plan.gameId)
      if (!game) throw new Error('Game vanished during restore')

      const outcome = await createBackup(game, 'pre_restore', { force: true })
      if (outcome.status === 'created') {
        safetyBackup = savesRepo.setBackupPinned(outcome.backup.id, true)
        broadcast(Channels.saves.backupFinished, {
          gameId: plan.gameId,
          trigger: 'pre_restore',
          outcome: { ...outcome, backup: safetyBackup },
          error: null
        } satisfies BackupFinishedEvent)
      } else if (outcome.reason !== 'save_folder_empty') {
        // An empty save folder is fine to overwrite -- there is nothing to lose.
        // Any other skip means the safety net could not be created, so stop.
        throw new Error(
          `Could not create a safety backup before restoring (${outcome.reason}). Restore aborted.`
        )
      }
    }

    return performRestore(plan, safetyBackup)
  })

  handle(Channels.saves.getUsage, (rawGameId?: unknown): BackupUsage => {
    if (rawGameId === undefined || rawGameId === null) return savesRepo.getBackupUsage()
    return savesRepo.getBackupUsage(requireId(rawGameId, 'game id'))
  })
}
