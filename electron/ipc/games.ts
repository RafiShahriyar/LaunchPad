import { BrowserWindow, dialog } from 'electron'
import { existsSync, rmSync, statSync } from 'node:fs'
import {
  Channels,
  type DeleteGameOptions,
  type DeleteGameResult,
  type DirectoryPurpose
} from '@shared/ipc'
import type { Game, GameUpdate, NewGame } from '@shared/types'
import { gamesRepo } from '@db/index'
import { deleteCoversForGame, importCover, validateCoverSource } from '../services/covers'
import { handle, requireId } from './handle'

const MAX_NAME_LENGTH = 200

const nowIso = (): string => new Date().toISOString()

/**
 * Validation lives in main, not in the renderer form.
 *
 * The renderer can validate for fast feedback, but it cannot be the enforcement
 * point: it has no filesystem access, so it cannot actually check that a path
 * exists. Main is also the only place that is guaranteed to run -- a renderer
 * bug or a future second UI would otherwise bypass the checks entirely.
 */
function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Game name is required')
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('Game name cannot be empty')
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Game name is too long (max ${MAX_NAME_LENGTH} characters)`)
  }
  return trimmed
}

function validateExecutable(path: unknown): string {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('Executable path is required')
  }
  const trimmed = path.trim()
  if (!existsSync(trimmed)) {
    throw new Error(`Executable not found: ${trimmed}`)
  }
  if (!statSync(trimmed).isFile()) {
    throw new Error(`Executable path is a folder, not a file: ${trimmed}`)
  }
  return trimmed
}

/** Optional directory: null clears it, a value must be an existing folder. */
function validateOptionalDirectory(
  value: string | null | undefined,
  label: string
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (!existsSync(trimmed)) {
    throw new Error(`${label} does not exist: ${trimmed}`)
  }
  if (!statSync(trimmed).isDirectory()) {
    throw new Error(`${label} is not a folder: ${trimmed}`)
  }
  return trimmed
}

/**
 * The save folder is validated more leniently than other paths: it may legitimately
 * not exist yet, because many games only create it on first run. Requiring it to
 * exist would block adding a game before ever launching it. A path that exists but
 * is a FILE is still rejected, since that is unambiguously wrong.
 */
function validateSaveFolder(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (existsSync(trimmed) && !statSync(trimmed).isDirectory()) {
    throw new Error(`Save folder is a file, not a folder: ${trimmed}`)
  }
  return trimmed
}

export function registerGamesHandlers(): void {
  handle(Channels.games.list, (): Game[] => gamesRepo.listGames())

  handle(Channels.games.get, (rawId: unknown): Game | null =>
    gamesRepo.getGame(requireId(rawId, 'game id'))
  )

  /**
   * Create must insert before it can copy the cover, because the cover filename
   * embeds the game id and SQLite only assigns that on INSERT. That ordering
   * makes atomicity the caller's problem, so this handler guarantees it in two
   * ways:
   *
   *   1. The cover is validated BEFORE the insert, so the common failures (wrong
   *      file type, missing file, oversized) never create a row at all.
   *   2. If the copy still fails afterwards -- a genuine I/O error -- the row is
   *      deleted and the error rethrown.
   *
   * Both matter because the handler reports failure to the renderer. Leaving a
   * half-created game behind after saying "failed" would put a game in the
   * library that the user was told did not save.
   */
  handle(Channels.games.create, (input: NewGame): Game => {
    const now = nowIso()

    const validated = {
      name: validateName(input.name),
      executablePath: validateExecutable(input.executablePath),
      workingDirectory: validateOptionalDirectory(input.workingDirectory, 'Working directory') ?? null,
      launchArgs: input.launchArgs?.trim() || null,
      saveFolderPath: validateSaveFolder(input.saveFolderPath) ?? null,
      coverImagePath: null
    }

    // Pre-flight: fail before touching the database.
    if (input.coverImagePath) validateCoverSource(input.coverImagePath)

    const created = gamesRepo.createGame(validated, now)
    if (!input.coverImagePath) return created

    try {
      const managedCover = importCover(input.coverImagePath, created.id)
      return gamesRepo.updateGame(created.id, { coverImagePath: managedCover }, now)
    } catch (err) {
      // Roll back so a reported failure leaves nothing behind.
      gamesRepo.deleteGame(created.id)
      deleteCoversForGame(created.id)
      throw err
    }
  })

  handle(Channels.games.update, (rawId: unknown, patch: GameUpdate): Game => {
    const id = requireId(rawId, 'game id')
    const existing = gamesRepo.getGame(id)
    if (!existing) throw new Error(`Game ${id} not found`)

    const validated: GameUpdate = {}

    if (patch.name !== undefined) validated.name = validateName(patch.name)
    if (patch.executablePath !== undefined) {
      validated.executablePath = validateExecutable(patch.executablePath)
    }
    if (patch.workingDirectory !== undefined) {
      validated.workingDirectory = validateOptionalDirectory(
        patch.workingDirectory,
        'Working directory'
      )
    }
    if (patch.saveFolderPath !== undefined) {
      validated.saveFolderPath = validateSaveFolder(patch.saveFolderPath)
    }
    if (patch.launchArgs !== undefined) {
      validated.launchArgs = patch.launchArgs?.trim() || null
    }

    if (patch.coverImagePath !== undefined) {
      if (patch.coverImagePath === null) {
        // Clearing the cover also removes the managed copies, otherwise the
        // covers folder grows every time a user swaps artwork.
        deleteCoversForGame(id)
        validated.coverImagePath = null
      } else {
        const managed = importCover(patch.coverImagePath, id)
        // Remove the previous copy only after the new one is safely written.
        if (existing.coverImagePath && existing.coverImagePath !== managed) {
          try {
            rmSync(existing.coverImagePath, { force: true })
          } catch {
            // Stale image left behind; harmless.
          }
        }
        validated.coverImagePath = managed
      }
    }

    return gamesRepo.updateGame(id, validated, nowIso())
  })

  /**
   * Deleting the game row cascades to its session and backup ROWS. Backup
   * FOLDERS are only removed when the user explicitly asks, and the result
   * reports what happened to each one rather than throwing on the first
   * failure -- by the time a folder delete fails, the row is already gone, so
   * the operation is a partial success and the UI needs the detail.
   */
  handle(Channels.games.remove, (rawId: unknown, options: DeleteGameOptions): DeleteGameResult => {
    const id = requireId(rawId, 'game id')
    const { deleted, orphanedBackupPaths } = gamesRepo.deleteGame(id)
    if (!deleted) throw new Error(`Game ${id} not found`)

    deleteCoversForGame(id)

    if (!options.deleteBackups) {
      return {
        deleted,
        backupFoldersDeleted: 0,
        backupFoldersFailed: [],
        backupFoldersKept: orphanedBackupPaths
      }
    }

    const failed: string[] = []
    let removed = 0
    for (const path of orphanedBackupPaths) {
      try {
        rmSync(path, { recursive: true, force: true })
        removed++
      } catch {
        failed.push(path)
      }
    }

    return {
      deleted,
      backupFoldersDeleted: removed,
      backupFoldersFailed: failed,
      backupFoldersKept: []
    }
  })

  // --- File pickers ---------------------------------------------------------
  // Dialogs must be opened from main: the renderer has no access to them, and
  // routing them through IPC is also what keeps the sandbox intact.

  handle(Channels.games.pickExecutable, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(focusedWindow(), {
      title: 'Select the game executable',
      properties: ['openFile', 'dontAddToRecent'],
      filters:
        process.platform === 'win32'
          ? [
              { name: 'Executables', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] },
              { name: 'All files', extensions: ['*'] }
            ]
          : [{ name: 'All files', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle(Channels.games.pickDirectory, async (purpose: DirectoryPurpose): Promise<string | null> => {
    const result = await dialog.showOpenDialog(focusedWindow(), {
      title:
        purpose === 'saveFolder'
          ? 'Select the folder containing this game’s save files'
          : 'Select the working directory',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle(Channels.games.pickCoverImage, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(focusedWindow(), {
      title: 'Select a cover image',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
}

/**
 * Dialogs are parented to the app window so they behave modally and cannot be
 * lost behind it. Falling back to the first window (rather than passing
 * undefined) keeps that true even if focus was stolen by another app.
 */
function focusedWindow(): BrowserWindow {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) throw new Error('No application window is open')
  return window
}
