import { isThemeId, type AppSettings } from '@shared/types'
import { getDb, transaction } from '../client'
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '../defaults'
import { readString } from '../row'

/**
 * Settings are stored as text key/value pairs and parsed on read.
 *
 * Key/value rather than a one-row typed table so that adding a setting is an
 * INSERT with a default, not a schema migration. The cost is that types live in
 * code rather than in the schema -- handled by parsing through the typed
 * AppSettings shape below, with the default used as the fallback whenever a
 * value is missing or unparseable (a hand-edited DB, or a downgrade that wrote
 * a value this build cannot read).
 */

function readRawSettings(): Map<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all()
  return new Map(rows.map((row) => [readString(row, 'key'), readString(row, 'value')]))
}

function parseInteger(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  return raw === 'true' || raw === '1'
}

export function getSettings(): AppSettings {
  const raw = readRawSettings()

  const backupsRoot = raw.get(SETTINGS_KEYS.backupsRootPath)
  const theme = raw.get(SETTINGS_KEYS.theme)

  return {
    // An empty backups root would send backups to a relative path, so fall back
    // to the seeded default rather than trusting a blank value.
    backupsRootPath:
      backupsRoot && backupsRoot.length > 0 ? backupsRoot : DEFAULT_SETTINGS.backupsRootPath,
    // Floor of 1: a limit of 0 would delete every backup immediately after
    // taking it, which is never what a user means by "keep 0".
    maxBackupsPerGame: parseInteger(
      raw.get(SETTINGS_KEYS.maxBackupsPerGame),
      DEFAULT_SETTINGS.maxBackupsPerGame,
      1
    ),
    backupBeforeLaunch: parseBoolean(
      raw.get(SETTINGS_KEYS.backupBeforeLaunch),
      DEFAULT_SETTINGS.backupBeforeLaunch
    ),
    backupAfterSession: parseBoolean(
      raw.get(SETTINGS_KEYS.backupAfterSession),
      DEFAULT_SETTINGS.backupAfterSession
    ),
    minSessionSeconds: parseInteger(
      raw.get(SETTINGS_KEYS.minSessionSeconds),
      DEFAULT_SETTINGS.minSessionSeconds,
      0
    ),
    theme: isThemeId(theme) ? theme : DEFAULT_SETTINGS.theme,
    sidebarCollapsed: parseBoolean(
      raw.get(SETTINGS_KEYS.sidebarCollapsed),
      DEFAULT_SETTINGS.sidebarCollapsed
    )
  }
}

/**
 * Writes only the provided keys, then returns the full parsed settings.
 *
 * Returning the whole object (rather than nothing, or just the patch) means the
 * renderer's settings slice always replaces its state with the canonical parsed
 * result -- including any value the parser clamped or rejected. Without that,
 * the UI could show `maxBackupsPerGame: 0` while the app actually used 10.
 */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return transaction(() => {
    const stmt = getDb().prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )

    for (const [camelKey, sqlKey] of Object.entries(SETTINGS_KEYS)) {
      const value = patch[camelKey as keyof AppSettings]
      if (value === undefined) continue
      stmt.run(sqlKey, String(value))
    }

    return getSettings()
  })
}
