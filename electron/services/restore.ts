import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SaveBackup } from '@shared/types'
import { gamesRepo, savesRepo } from '@db/index'
import { isRunning } from './launcher'

/**
 * Restores a snapshot back over a game's save folder.
 *
 * This is the only operation in the app that destroys user data on purpose, so
 * it is built around two ideas:
 *
 *   1. **Always take a safety snapshot first.** Before anything is overwritten,
 *      the current saves are captured as a `pre_restore` backup. That snapshot
 *      IS the undo button, so it is pinned -- rotating away the undo for a
 *      destructive action would defeat the point.
 *   2. **Swap, never overwrite in place.** The snapshot is staged beside the
 *      save folder, then swapped in with two renames. A copy that fails partway
 *      through would otherwise leave the save folder as a mixture of old and new
 *      files -- the worst possible outcome, because it looks intact and is not.
 */

export interface RestoreResult {
  restoredFrom: SaveBackup
  /** The pre_restore snapshot, or null when there were no saves to protect. */
  safetyBackup: SaveBackup | null
  saveFolderPath: string
  /** True when the save folder did not exist and was recreated (post-reinstall). */
  recreatedSaveFolder: boolean
}

/** Prepared context, so the caller can take the safety backup between checks and work. */
export interface RestorePlan {
  backup: SaveBackup
  gameId: number
  saveFolderPath: string
  saveFolderExists: boolean
}

/**
 * Validates everything that can be checked before touching the disk.
 *
 * Separated from the copy so the caller can take the safety backup in between,
 * and so every refusal happens before any destructive step has begun.
 */
export function planRestore(backupId: number): RestorePlan {
  const backup = savesRepo.getBackup(backupId)
  if (!backup) throw new Error(`Backup ${backupId} not found`)

  const game = gamesRepo.getGame(backup.gameId)
  if (!game) throw new Error(`The game for this backup no longer exists`)

  // Restoring under a running game would have the game overwrite the restored
  // files from memory on exit, or worse, read a half-swapped folder.
  if (isRunning(game.id)) {
    throw new Error(
      `${game.name} is running. Close the game before restoring, or the restored saves will be overwritten when it exits.`
    )
  }

  if (!game.saveFolderPath) {
    throw new Error(
      `${game.name} has no save folder set, so there is nowhere to restore to. Set one in Edit first.`
    )
  }

  if (!existsSync(backup.backupPath)) {
    throw new Error(
      `This snapshot's folder is missing from disk: ${backup.backupPath}. It may have been deleted outside LaunchPad.`
    )
  }
  if (!statSync(backup.backupPath).isDirectory()) {
    throw new Error(`Snapshot path is not a folder: ${backup.backupPath}`)
  }

  return {
    backup,
    gameId: game.id,
    saveFolderPath: game.saveFolderPath,
    saveFolderExists: existsSync(game.saveFolderPath)
  }
}

/**
 * Performs the swap. Call only after planRestore() has passed and the safety
 * backup has been taken.
 *
 * The staging folder is created in the save folder's PARENT so that the two
 * renames stay within one filesystem -- `rename` across volumes fails, and a
 * cross-volume fallback would reintroduce the partial-copy risk this design
 * exists to avoid.
 */
export async function performRestore(
  plan: RestorePlan,
  safetyBackup: SaveBackup | null
): Promise<RestoreResult> {
  const { backup, saveFolderPath } = plan
  const parent = dirname(saveFolderPath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const stagePath = join(parent, `.lp-restore-${stamp}`)
  const replacedPath = join(parent, `.lp-replaced-${stamp}`)

  // The game may have been uninstalled and its save tree removed entirely --
  // restoring after a reinstall is the headline use case for this feature.
  await mkdir(parent, { recursive: true })

  const recreatedSaveFolder = !existsSync(saveFolderPath)

  await rm(stagePath, { recursive: true, force: true })
  await cp(backup.backupPath, stagePath, { recursive: true, dereference: false, force: true })

  let movedAside = false
  try {
    if (existsSync(saveFolderPath)) {
      // Move the current saves aside rather than deleting them: if the next
      // rename fails, this is what gets put back.
      await rename(saveFolderPath, replacedPath)
      movedAside = true
    }
    await rename(stagePath, saveFolderPath)
  } catch (err) {
    // Roll back to the pre-restore state as far as possible.
    if (movedAside && !existsSync(saveFolderPath)) {
      await rename(replacedPath, saveFolderPath).catch(() => {})
    }
    await rm(stagePath, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  // Only once the new folder is in place is the old one disposable. A failure
  // here leaves a stray folder, not data loss, so it must not fail the restore.
  await rm(replacedPath, { recursive: true, force: true }).catch(() => {})

  return {
    restoredFrom: backup,
    safetyBackup,
    saveFolderPath,
    recreatedSaveFolder
  }
}

/**
 * Removes staging folders left beside a save folder by an interrupted restore.
 *
 * Only ever touches directories matching the app's own `.lp-restore-` /
 * `.lp-replaced-` prefixes, since this runs in the user's real save directory
 * rather than a folder the app owns.
 */
export async function cleanupAbandonedRestoreFolders(): Promise<number> {
  let removed = 0

  for (const game of gamesRepo.listGames()) {
    if (!game.saveFolderPath) continue
    const parent = dirname(game.saveFolderPath)
    if (!existsSync(parent)) continue

    try {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith('.lp-restore-') && !entry.name.startsWith('.lp-replaced-')) {
          continue
        }
        await rm(join(parent, entry.name), { recursive: true, force: true })
        removed++
      }
    } catch (err) {
      console.error(`[restore] cleanup failed near ${parent}:`, err)
    }
  }

  return removed
}
