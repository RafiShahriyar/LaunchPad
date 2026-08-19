/**
 * Domain models shared by main and renderer.
 *
 * These mirror the SQLite tables defined in db/schema.ts. Rows cross the IPC
 * boundary as plain JSON, so every field here must be structured-cloneable:
 * no Date objects, no class instances, no undefined-valued keys. Timestamps
 * are stored and transported as ISO-8601 UTC strings.
 */

/** ISO-8601 UTC timestamp, e.g. "2026-08-19T04:58:29.820Z". */
export type IsoTimestamp = string

export interface Game {
  id: number
  name: string
  /** Absolute path to the executable that gets spawned on launch. */
  executablePath: string
  /** Optional working directory for the spawned process; defaults to the exe's folder. */
  workingDirectory: string | null
  /** Extra CLI args passed to the executable, stored as a single string. */
  launchArgs: string | null
  /** Absolute path to the folder holding this game's save files. Null = backups disabled. */
  saveFolderPath: string | null
  /** Absolute path to a cover image on disk, or null for the generated placeholder. */
  coverImagePath: string | null
  /** Denormalised roll-up of play_sessions, kept current so the grid doesn't N+1 query. */
  totalPlaytimeSeconds: number
  lastPlayedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface PlaySession {
  id: number
  gameId: number
  startedAt: IsoTimestamp
  /** Null while the session is still running. */
  endedAt: IsoTimestamp | null
  durationSeconds: number | null
  /** How the session ended — distinguishes a clean exit from a crash or an app restart. */
  exitReason: SessionExitReason | null
}

export type SessionExitReason = 'exited' | 'crashed' | 'app_closed' | 'unknown'

export interface SaveBackup {
  id: number
  gameId: number
  /** Absolute path to this snapshot's folder inside the backups root. */
  backupPath: string
  createdAt: IsoTimestamp
  sizeBytes: number
  fileCount: number
  /** What caused this snapshot — used by the rotation policy and shown in the UI. */
  trigger: BackupTrigger
  /** Snapshots the user pins are exempt from rotation. */
  isPinned: boolean
  /**
   * Fingerprint of the save folder when this snapshot was taken, used to skip
   * duplicate backups. Null for rows written before the fingerprint existed,
   * which is treated as "cannot prove unchanged".
   */
  contentHash: string | null
}

export type BackupTrigger = 'pre_launch' | 'post_session' | 'manual' | 'pre_restore'

export interface AppSettings {
  /** Root folder that per-game backup folders live under. */
  backupsRootPath: string
  /** Rotation limit: how many unpinned snapshots to retain per game. */
  maxBackupsPerGame: number
  backupBeforeLaunch: boolean
  backupAfterSession: boolean
  /** Sessions shorter than this are discarded (misclicks, failed launches). */
  minSessionSeconds: number
  theme: 'dark' | 'light'
  /** Sidebar collapsed to icons only. Persisted so it survives a restart. */
  sidebarCollapsed: boolean
}

// --- Write payloads ----------------------------------------------------------
// Separate from the entity types above because the database owns id, timestamps
// and the playtime roll-up: callers must not be able to pass them in.

export interface NewGame {
  name: string
  executablePath: string
  workingDirectory?: string | null
  launchArgs?: string | null
  saveFolderPath?: string | null
  coverImagePath?: string | null
}

/** Every field optional — only the keys present are written. */
export type GameUpdate = Partial<NewGame>

export interface NewSaveBackup {
  gameId: number
  backupPath: string
  createdAt: IsoTimestamp
  sizeBytes: number
  fileCount: number
  trigger: BackupTrigger
  isPinned?: boolean
  contentHash?: string | null
}

// --- View-model types (renderer only, never persisted) -----------------------

export type LibraryViewMode = 'grid' | 'list'
export type LibrarySortKey = 'name' | 'playtime' | 'lastPlayed' | 'dateAdded'
export type SortDirection = 'asc' | 'desc'
