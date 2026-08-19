import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { gamesRepo, savesRepo, settingsRepo } from '@db/index'
import { assertLooksLikeSnapshotFolder, gameFolderName } from './backups'

/**
 * Finds backup folders on disk that nothing in the database references.
 *
 * Two ways they accumulate, both by design:
 *
 *   - **Deleting a game keeps its backups by default.** That is deliberate --
 *     removing a library entry must not destroy the saves the app exists to
 *     protect -- but it means the folders outlive every row that pointed at
 *     them, and until now nothing surfaced them again.
 *   - **Rotation deletes the folder before the row.** If the folder delete
 *     fails, the row survives (the safe direction). The reverse can happen if
 *     the app is killed between the two.
 *
 * Nothing is deleted here. The scan reports; the user decides.
 */

export type OrphanReason = 'deleted_game' | 'unreferenced_snapshot'

export interface OrphanFolder {
  path: string
  sizeBytes: number
  reason: OrphanReason
  /** Best-effort label for the UI, from the folder name. */
  label: string
}

export interface OrphanScanResult {
  folders: OrphanFolder[]
  totalBytes: number
  /** The root that was scanned, so the UI can say where it looked. */
  scannedRoot: string
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) total += await directorySize(full)
      else if (entry.isFile()) total += (await stat(full)).size
    }
  } catch {
    // Unreadable subtree: report what was measurable rather than failing the scan.
  }
  return total
}

export async function scanForOrphanedBackups(): Promise<OrphanScanResult> {
  const scannedRoot = settingsRepo.getSettings().backupsRootPath
  const result: OrphanScanResult = { folders: [], totalBytes: 0, scannedRoot }

  if (!existsSync(scannedRoot)) return result

  // Folder names the current library expects to own.
  const expectedGameDirs = new Map(
    gamesRepo.listGames().map((game) => [gameFolderName(game), game])
  )

  let gameDirs: string[]
  try {
    gameDirs = (await readdir(scannedRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return result
  }

  for (const dirName of gameDirs) {
    const fullGameDir = join(scannedRoot, dirName)
    const game = expectedGameDirs.get(dirName)

    // No game owns this folder: the game was deleted with "keep backups".
    if (!game) {
      result.folders.push({
        path: fullGameDir,
        sizeBytes: await directorySize(fullGameDir),
        reason: 'deleted_game',
        label: dirName
      })
      continue
    }

    // The game exists, so check each snapshot folder against its rows.
    const knownPaths = new Set(
      savesRepo.listBackupsForGame(game.id).map((backup) => backup.backupPath.toLowerCase())
    )

    let snapshots: string[]
    try {
      snapshots = (await readdir(fullGameDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }

    for (const snapshotName of snapshots) {
      // `.tmp-` folders are handled by the backup service's own cleanup.
      if (snapshotName.startsWith('.tmp-')) continue

      const fullPath = join(fullGameDir, snapshotName)
      if (knownPaths.has(fullPath.toLowerCase())) continue

      result.folders.push({
        path: fullPath,
        sizeBytes: await directorySize(fullPath),
        reason: 'unreferenced_snapshot',
        label: `${game.name} · ${snapshotName}`
      })
    }
  }

  result.totalBytes = result.folders.reduce((sum, folder) => sum + folder.sizeBytes, 0)
  return result
}

export interface OrphanCleanupResult {
  deletedCount: number
  freedBytes: number
  failed: string[]
}

/**
 * Deletes the folders a scan reported.
 *
 * Re-scans rather than trusting paths sent from the renderer: the renderer is
 * the untrusted side of the boundary, and this deletes directories. Only paths
 * the fresh scan still considers orphaned are removed, so a stale or forged
 * list cannot widen the blast radius.
 */
export async function cleanupOrphanedBackups(): Promise<OrphanCleanupResult> {
  const scan = await scanForOrphanedBackups()
  const result: OrphanCleanupResult = { deletedCount: 0, freedBytes: 0, failed: [] }

  for (const folder of scan.folders) {
    try {
      // Per-game folders sit one level above snapshots, so the snapshot-shaped
      // guard does not apply to them; their own check is that no game claims
      // the name and that they live directly under the backups root.
      if (folder.reason === 'unreferenced_snapshot') {
        assertLooksLikeSnapshotFolder(folder.path)
      }
      await rm(folder.path, { recursive: true, force: true })
      result.deletedCount++
      result.freedBytes += folder.sizeBytes
    } catch (err) {
      console.error(`[maintenance] could not delete ${folder.path}:`, err)
      result.failed.push(folder.path)
    }
  }

  return result
}
