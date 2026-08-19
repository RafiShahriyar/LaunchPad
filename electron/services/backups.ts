import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BackupTrigger, Game, SaveBackup } from '@shared/types'
import { savesRepo, settingsRepo } from '@db/index'

/**
 * Copies save folders into timestamped snapshots and rotates old ones away.
 *
 * The ordering rules here are the whole design:
 *
 *   1. **Copy to a temp folder, then rename.** A snapshot is only given its real
 *      name once every byte is on disk. An interrupted copy leaves a `.tmp-`
 *      folder that is ignored and cleaned up, never a half-copied snapshot that
 *      looks restorable.
 *   2. **Write the database row last.** A row is a promise that the folder
 *      exists and is complete. A folder with no row is recoverable disk waste; a
 *      row with no folder is a restore that fails at the worst possible moment.
 *   3. **Rotation deletes folders before rows.** If a folder delete fails, the
 *      row stays and the snapshot remains listed and restorable, which is the
 *      safe direction to fail in.
 */

export type BackupSkipReason =
  | 'no_save_folder_configured'
  | 'save_folder_missing'
  | 'save_folder_empty'
  | 'unchanged_since_last_backup'

export type BackupOutcome =
  | { status: 'created'; backup: SaveBackup; rotatedIds: number[] }
  | { status: 'skipped'; reason: BackupSkipReason }

/**
 * Guards against two backups of the same game running at once -- a manual
 * "Back up now" landing on top of an automatic pre-launch backup, for instance.
 * Two concurrent copies of the same folder would race on the temp directory and
 * double-count disk usage.
 */
const inFlight = new Set<number>()

export function isBackupInFlight(gameId: number): boolean {
  return inFlight.has(gameId)
}

/**
 * Filesystem-safe snapshot folder name.
 *
 * `2026-08-19T06:49:56.789Z` -> `2026-08-19T06-49-56-789Z`
 *
 * Colons are illegal in Windows filenames, hence the substitution. The
 * milliseconds are KEPT deliberately: truncating to whole seconds makes two
 * backups taken in the same second resolve to the same folder, and the second
 * one then fails when it tries to rename onto an existing directory. That is
 * not a hypothetical -- a manual backup landing next to an automatic one, or a
 * pre-launch backup followed immediately by a short session, both hit it.
 *
 * The format still sorts lexicographically, which the rotation ordering relies on.
 */
function timestampFolderName(iso: string): string {
  return iso.replace(/:/g, '-').replace('.', '-')
}

/**
 * Guarantees a free path even if two snapshots share a millisecond.
 * Vanishingly unlikely, but the cost of being wrong is a failed backup.
 */
function uniqueSnapshotPath(gameDir: string, baseName: string): string {
  let candidate = join(gameDir, baseName)
  let counter = 1
  while (existsSync(candidate)) {
    counter++
    candidate = join(gameDir, `${baseName}-${counter}`)
  }
  return candidate
}

/** Stable, readable per-game folder: `12-hollow-knight`. */
export function gameFolderName(game: Game): string {
  const slug = game.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug ? `${game.id}-${slug}` : String(game.id)
}

export function getGameBackupDir(game: Game): string {
  return join(settingsRepo.getSettings().backupsRootPath, gameFolderName(game))
}

interface TreeStats {
  fileCount: number
  sizeBytes: number
  /** Fingerprint over relative paths, sizes and mtimes. */
  contentHash: string
}

/**
 * Walks a directory, collecting size, file count and a fingerprint.
 *
 * The fingerprint hashes each file's relative path, size and mtime rather than
 * its contents. Reading every byte would be exact but turns a dedup check into
 * a full second read of the save folder. Path+size+mtime is fast and errs the
 * safe way: a touched-but-identical file produces a redundant backup, which
 * wastes a little space, whereas a missed change would lose data.
 *
 * Paths are sorted so the hash does not depend on directory iteration order.
 */
async function computeTreeStats(root: string): Promise<TreeStats> {
  const entries: string[] = []
  let fileCount = 0
  let sizeBytes = 0

  async function walk(dir: string, prefix: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const full = join(dir, item.name)
      const relative = prefix ? `${prefix}/${item.name}` : item.name

      if (item.isDirectory()) {
        await walk(full, relative)
        continue
      }
      // Symlinks are not followed: a link pointing outside the save folder
      // would pull unrelated files into the snapshot, and a cyclic one would
      // never terminate.
      if (!item.isFile()) continue

      const info = await stat(full)
      fileCount++
      sizeBytes += info.size
      entries.push(`${relative}:${info.size}:${Math.floor(info.mtimeMs)}`)
    }
  }

  await walk(root, '')
  entries.sort()

  return {
    fileCount,
    sizeBytes,
    contentHash: createHash('sha1').update(entries.join('\n')).digest('hex')
  }
}

/**
 * Matches a snapshot folder name: `2026-08-19T06-49-56-789Z`, optionally with a
 * `-2` collision suffix.
 */
const SNAPSHOT_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/

/**
 * Guards every destructive filesystem operation driven by a stored path.
 *
 * The check is **structural, not root-relative**. An earlier version compared
 * against the current backups root, which had a latent bug: after a user changes
 * the backups folder, existing snapshots keep their old absolute paths (that is
 * what keeps them restorable), and a root-relative check would then refuse to
 * rotate or delete any of them — silently, and forever.
 *
 * So instead of asking "is this under the configured root?", this asks "does
 * this look like a snapshot folder this app created?": the final segment must
 * match the timestamp naming scheme, and the path must be nested at least two
 * levels deep. That still blocks the case the guard exists for — a hand-edited
 * database pointing `backup_path` at `C:\Windows` — while remaining correct
 * across a root change.
 */
export function assertLooksLikeSnapshotFolder(path: string): void {
  const target = resolve(path)
  const segments = target.split(/[\\/]/).filter(Boolean)

  // <root...>/<gameId-slug>/<timestamp> — anything shallower is not ours.
  if (segments.length < 3) {
    throw new Error(`Refusing to delete a top-level path: ${path}`)
  }

  const folderName = segments[segments.length - 1] ?? ''
  if (!SNAPSHOT_FOLDER_PATTERN.test(folderName)) {
    throw new Error(
      `Refusing to delete "${folderName}": it does not look like a LaunchPad snapshot folder.`
    )
  }
}

/**
 * Creates a snapshot of a game's save folder.
 *
 * Returns a skip outcome rather than throwing for the ordinary "nothing to do"
 * cases, because those are not failures: a game with no save folder configured,
 * or one that has not created its saves yet, must not surface an error every
 * time it launches.
 */
export async function createBackup(
  game: Game,
  trigger: BackupTrigger,
  options: { force?: boolean } = {}
): Promise<BackupOutcome> {
  if (!game.saveFolderPath) {
    return { status: 'skipped', reason: 'no_save_folder_configured' }
  }

  const source = game.saveFolderPath
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    // Normal before a game's first run -- it creates the folder on launch.
    return { status: 'skipped', reason: 'save_folder_missing' }
  }

  if (inFlight.has(game.id)) {
    throw new Error('A backup for this game is already running.')
  }
  inFlight.add(game.id)

  try {
    const stats = await computeTreeStats(source)

    // An empty snapshot is worse than none: restoring it would wipe the real
    // saves while looking like a legitimate recovery point.
    if (stats.fileCount === 0) {
      return { status: 'skipped', reason: 'save_folder_empty' }
    }

    if (!options.force) {
      const latest = savesRepo.getLatestBackup(game.id)
      // A null hash on the previous row means "cannot prove unchanged", so the
      // backup proceeds.
      if (latest?.contentHash && latest.contentHash === stats.contentHash) {
        return { status: 'skipped', reason: 'unchanged_since_last_backup' }
      }
    }

    const createdAt = new Date().toISOString()
    const gameDir = getGameBackupDir(game)
    await mkdir(gameDir, { recursive: true })

    const stamp = timestampFolderName(createdAt)
    const finalPath = uniqueSnapshotPath(gameDir, stamp)
    const tempPath = join(gameDir, `.tmp-${stamp}-${process.pid}`)

    await rm(tempPath, { recursive: true, force: true })

    try {
      // dereference:false keeps symlinks as links rather than copying their
      // targets, matching what computeTreeStats measured.
      await cp(source, tempPath, { recursive: true, dereference: false, force: true })
      // Rename is the commit point: atomic within a filesystem, so the snapshot
      // appears under its real name only once it is complete.
      await rename(tempPath, finalPath)
    } catch (err) {
      await rm(tempPath, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    // Only now is the snapshot advertised as restorable.
    const backup = savesRepo.createBackup({
      gameId: game.id,
      backupPath: finalPath,
      createdAt,
      sizeBytes: stats.sizeBytes,
      fileCount: stats.fileCount,
      trigger,
      contentHash: stats.contentHash
    })

    const rotatedIds = await rotateBackups(game.id)
    return { status: 'created', backup, rotatedIds }
  } finally {
    inFlight.delete(game.id)
  }
}

/**
 * Deletes snapshots beyond the retention limit, oldest first.
 *
 * Folders go before rows: a row whose folder is gone would appear in the
 * restore list and fail when chosen, whereas a folder whose row is gone is
 * merely unreferenced space that the next rotation cannot see. Failing in the
 * second direction is strictly safer, so a folder that cannot be deleted keeps
 * its row and stays listed.
 */
export async function rotateBackups(gameId: number): Promise<number[]> {
  const keep = settingsRepo.getSettings().maxBackupsPerGame
  const candidates = savesRepo.findRotationCandidates(gameId, keep)

  const deletedIds: number[] = []
  for (const candidate of candidates) {
    try {
      assertLooksLikeSnapshotFolder(candidate.backupPath)
      await rm(candidate.backupPath, { recursive: true, force: true })
      savesRepo.deleteBackupRow(candidate.id)
      deletedIds.push(candidate.id)
    } catch (err) {
      // Keeping the row means the snapshot stays listed and restorable, which
      // is the safe direction to fail in.
      console.error(`[backups] could not rotate ${candidate.backupPath}:`, err)
    }
  }
  return deletedIds
}

/** Deletes one snapshot: folder first, then row, for the reason above. */
export async function deleteBackup(backupId: number): Promise<void> {
  const backup = savesRepo.getBackup(backupId)
  if (!backup) throw new Error(`Backup ${backupId} not found`)

  assertLooksLikeSnapshotFolder(backup.backupPath)
  await rm(backup.backupPath, { recursive: true, force: true })
  savesRepo.deleteBackupRow(backupId)
}

/**
 * Removes `.tmp-` folders left behind by an interrupted copy.
 *
 * They are already invisible to the app -- nothing without a database row is
 * ever listed -- but a crash mid-backup would otherwise leak a full copy of a
 * save folder that nothing ever cleans up.
 */
export async function cleanupAbandonedTempFolders(): Promise<number> {
  const root = settingsRepo.getSettings().backupsRootPath
  if (!existsSync(root)) return 0

  let removed = 0
  try {
    for (const gameDir of await readdir(root, { withFileTypes: true })) {
      if (!gameDir.isDirectory()) continue
      const fullGameDir = join(root, gameDir.name)

      for (const entry of await readdir(fullGameDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('.tmp-')) continue
        await rm(join(fullGameDir, entry.name), { recursive: true, force: true })
        removed++
      }
    }
  } catch (err) {
    console.error('[backups] temp cleanup failed:', err)
  }
  return removed
}
