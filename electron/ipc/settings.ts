import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import {
  Channels,
  type DemoDataResult,
  type OrphanCleanupResult,
  type OrphanScanResult
} from '@shared/ipc'
import { isThemeId, type AppSettings } from '@shared/types'
import { settingsRepo } from '@db/index'
import { cleanupOrphanedBackups, scanForOrphanedBackups } from '../services/maintenance'
import { seedDemoData } from '../services/demoData'
import { handle } from './handle'

/**
 * Validates a settings patch before it reaches the database.
 *
 * The repository already clamps nonsensical values on read (see
 * db/repositories/settings.ts), but silently clamping a value the user just
 * typed is a poor experience: they would set 0 and see 10 with no explanation.
 * Rejecting here produces a message they can act on, and the repository's clamp
 * remains the last line of defence for values that arrive some other way.
 */
function validatePatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const validated: Partial<AppSettings> = {}

  if (patch.backupsRootPath !== undefined) {
    const path = String(patch.backupsRootPath).trim()
    if (path.length === 0) throw new Error('Backups folder cannot be empty')
    if (existsSync(path) && !statSync(path).isDirectory()) {
      throw new Error(`Backups path is a file, not a folder: ${path}`)
    }
    validated.backupsRootPath = path
  }

  if (patch.maxBackupsPerGame !== undefined) {
    const value = Number(patch.maxBackupsPerGame)
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('Keep at least 1 backup per game.')
    }
    if (value > 500) {
      throw new Error('That is more backups than is useful — the maximum is 500.')
    }
    validated.maxBackupsPerGame = value
  }

  if (patch.minSessionSeconds !== undefined) {
    const value = Number(patch.minSessionSeconds)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('Minimum session length cannot be negative.')
    }
    if (value > 3600) {
      throw new Error('A minimum session longer than an hour would discard almost everything.')
    }
    validated.minSessionSeconds = value
  }

  if (patch.backupBeforeLaunch !== undefined) {
    if (typeof patch.backupBeforeLaunch !== 'boolean') throw new Error('Expected a boolean')
    validated.backupBeforeLaunch = patch.backupBeforeLaunch
  }

  if (patch.backupAfterSession !== undefined) {
    if (typeof patch.backupAfterSession !== 'boolean') throw new Error('Expected a boolean')
    validated.backupAfterSession = patch.backupAfterSession
  }

  if (patch.sidebarCollapsed !== undefined) {
    if (typeof patch.sidebarCollapsed !== 'boolean') throw new Error('Expected a boolean')
    validated.sidebarCollapsed = patch.sidebarCollapsed
  }

  /*
   * `theme` used to be refused outright, because nothing in the renderer
   * honoured it and persisting a value the UI ignores is a lie the settings
   * screen would then have to tell.
   *
   * It is accepted now that every id in ThemeId maps to a real palette. The
   * check is the shared type guard rather than a list written out here: a list
   * would be a second place to update, and the one that gets forgotten.
   */
  if (patch.theme !== undefined) {
    if (!isThemeId(patch.theme)) {
      throw new Error(`Unknown theme: ${JSON.stringify(patch.theme)}`)
    }
    validated.theme = patch.theme
  }

  return validated
}

function focusedWindow(): BrowserWindow {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) throw new Error('No application window is open')
  return window
}

export function registerSettingsHandlers(): void {
  handle(Channels.settings.get, (): AppSettings => settingsRepo.getSettings())

  /**
   * Changing the backups folder affects only FUTURE snapshots.
   *
   * Existing ones keep working: every backup row stores an absolute path, so
   * older snapshots stay listed and restorable from wherever they were written.
   * Moving them would mean copying potentially gigabytes with a real chance of
   * failing partway, to solve a problem the absolute paths already avoid.
   */
  handle(Channels.settings.update, async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const validated = validatePatch(patch ?? {})

    // Create the folder now rather than at the first backup, so a bad path
    // fails here — while the user is looking at the setting — instead of
    // silently at some later launch.
    if (validated.backupsRootPath) {
      await mkdir(validated.backupsRootPath, { recursive: true })
    }

    return settingsRepo.updateSettings(validated)
  })

  handle(Channels.settings.pickBackupsFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(focusedWindow(), {
      title: 'Choose where LaunchPad stores save backups',
      defaultPath: settingsRepo.getSettings().backupsRootPath,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  /**
   * Opens the backups folder in the OS file manager.
   *
   * The path comes from settings rather than from the renderer: `openPath` will
   * happily open anything, so accepting a caller-supplied path would turn this
   * into a general "open any file on this machine" capability.
   */
  handle(Channels.settings.openBackupsFolder, async (): Promise<null> => {
    const root = settingsRepo.getSettings().backupsRootPath
    await mkdir(root, { recursive: true })
    const error = await shell.openPath(root)
    if (error) throw new Error(error)
    return null
  })

  handle(Channels.settings.scanOrphans, (): Promise<OrphanScanResult> => scanForOrphanedBackups())

  handle(
    Channels.settings.cleanupOrphans,
    (): Promise<OrphanCleanupResult> => cleanupOrphanedBackups()
  )

  /*
   * Sample data, for development only.
   *
   * Gated in MAIN rather than only hidden in the UI: the renderer decides what
   * to render, but it does not get to decide what capabilities exist. Hiding a
   * button while leaving the channel live would still expose it to anything
   * running in the page.
   */
  handle(Channels.settings.seedDemoData, (): Promise<DemoDataResult> => {
    if (app.isPackaged) {
      throw new Error('Demo data is only available in development builds.')
    }
    return seedDemoData()
  })
}
