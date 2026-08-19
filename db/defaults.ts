import type { AppSettings } from '@shared/types'

/**
 * Default settings, applied on first run and used as the fallback whenever a
 * settings row is missing or unparseable.
 *
 * Lives in its own module with no imports of its own so that both client.ts
 * (which seeds them at startup) and the settings repository (which reads them)
 * can use it without an import cycle.
 *
 * `backupsRootPath` is intentionally empty: the real value depends on the
 * Electron userData directory, which is only known at runtime. initDatabase()
 * receives it as a parameter and seeds it.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  backupsRootPath: '',
  maxBackupsPerGame: 10,
  backupBeforeLaunch: true,
  backupAfterSession: true,
  minSessionSeconds: 30,
  theme: 'dark',
  sidebarCollapsed: false
}

/**
 * Maps the camelCase AppSettings keys to the snake_case keys stored in the
 * settings table. Declared once here so reads and writes cannot drift apart.
 */
export const SETTINGS_KEYS: Record<keyof AppSettings, string> = {
  backupsRootPath: 'backups_root_path',
  maxBackupsPerGame: 'max_backups_per_game',
  backupBeforeLaunch: 'backup_before_launch',
  backupAfterSession: 'backup_after_session',
  minSessionSeconds: 'min_session_seconds',
  theme: 'theme',
  sidebarCollapsed: 'sidebar_collapsed'
}
