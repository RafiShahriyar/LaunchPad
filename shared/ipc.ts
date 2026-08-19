/**
 * The IPC contract.
 *
 * This file is the SINGLE SOURCE OF TRUTH for everything that crosses the
 * main <-> renderer boundary. It is imported by all three layers:
 *
 *   electron/main    - to type the handler implementations
 *   electron/preload - to type the contextBridge surface
 *   src/             - to type window.api in the renderer
 *
 * Because all three compile against this one file, adding a channel without
 * implementing it (or changing a payload shape on one side only) is a
 * compile-time error rather than a runtime `undefined`.
 */
import type {
  AppSettings,
  BackupTrigger,
  Game,
  GameUpdate,
  NewGame,
  PlaySession,
  SaveBackup,
  SessionExitReason
} from './types'

/** Channel names, grouped by domain. Values are the literal IPC channel strings. */
export const Channels = {
  app: {
    getInfo: 'app:getInfo'
  },
  games: {
    list: 'games:list',
    get: 'games:get',
    create: 'games:create',
    update: 'games:update',
    remove: 'games:delete',
    pickExecutable: 'games:pickExecutable',
    pickDirectory: 'games:pickDirectory',
    pickCoverImage: 'games:pickCoverImage'
  },
  sessions: {
    launch: 'sessions:launch',
    listForGame: 'sessions:listForGame',
    getStats: 'sessions:getStats',
    getRunning: 'sessions:getRunning',
    // --- Push channels (main -> renderer). Not invokable; see RendererApi. ---
    started: 'sessions:started',
    ended: 'sessions:ended'
  },
  saves: {
    listForGame: 'saves:listForGame',
    backupNow: 'saves:backupNow',
    setPinned: 'saves:setPinned',
    remove: 'saves:delete',
    getUsage: 'saves:getUsage',
    restore: 'saves:restore',
    // --- Push channel (main -> renderer) ---
    backupFinished: 'saves:backupFinished'
  },
  window: {
    getState: 'window:getState',
    setFullScreen: 'window:setFullScreen',
    toggleFullScreen: 'window:toggleFullScreen',
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggleMaximize',
    close: 'window:close',
    // --- Push channel (main -> renderer) ---
    stateChanged: 'window:stateChanged'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    pickBackupsFolder: 'settings:pickBackupsFolder',
    openBackupsFolder: 'settings:openBackupsFolder',
    scanOrphans: 'settings:scanOrphans',
    cleanupOrphans: 'settings:cleanupOrphans',
    seedDemoData: 'settings:seedDemoData'
  }
} as const

/**
 * Mirrors NodeJS.Platform without depending on @types/node.
 *
 * Shared code is compiled by BOTH tsconfigs, and the renderer's config
 * deliberately excludes Node types so that a stray `fs` import fails to
 * compile. Referencing the NodeJS namespace here would break that guarantee.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

export interface AppInfo {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: Platform
  /** Where userData (db + backups) lives. Useful for debugging and the settings screen. */
  userDataPath: string
  /** Absolute path to the SQLite file. */
  dbPath: string
  /** Applied schema version, from PRAGMA user_version. */
  schemaVersion: number
}

/** Which kind of folder a directory picker is being opened for. */
export type DirectoryPurpose = 'workingDirectory' | 'saveFolder'

export interface DeleteGameOptions {
  /**
   * Whether to also delete this game's backup FOLDERS from disk.
   * Defaults to false everywhere: removing a game from the library must not
   * silently destroy the saves the app exists to protect.
   */
  deleteBackups: boolean
}

export interface DeleteGameResult {
  deleted: boolean
  /** Backup folders successfully removed (0 when deleteBackups was false). */
  backupFoldersDeleted: number
  /**
   * Folders that could not be removed (locked, permissions). Reported rather
   * than thrown: the game row is already gone, so this is a partial success.
   */
  backupFoldersFailed: string[]
  /** Backup folders left on disk because the user chose to keep them. */
  backupFoldersKept: string[]
}

// --- Sessions ----------------------------------------------------------------

export interface LaunchResult {
  session: PlaySession
  /** The game as stored, after any launch-time bookkeeping. */
  game: Game
}

/** Aggregates for the per-game detail view, computed in SQL. */
export interface SessionStats {
  sessionCount: number
  totalSeconds: number
  longestSeconds: number
  averageSeconds: number
  firstPlayedAt: string | null
  lastPlayedAt: string | null
}

export interface SessionStartedEvent {
  session: PlaySession
  game: Game
}

export interface SessionEndedEvent {
  gameId: number
  /** null when the session was discarded for falling under minSessionSeconds. */
  session: PlaySession | null
  /**
   * The game carrying its updated playtime roll-up. Sent with the event so the
   * renderer never has to re-fetch just to refresh a number it was already told
   * about. null only if the game was deleted while it was running.
   */
  game: Game | null
  /** True when the session was too short to record. */
  discarded: boolean
  exitReason: SessionExitReason
  /** Process exit code, or null when terminated by a signal. */
  exitCode: number | null
}

// --- Saves -------------------------------------------------------------------

/**
 * Why a backup did nothing. These are ordinary outcomes, not failures: a game
 * with no save folder configured, or one whose saves do not exist yet, must not
 * produce an error banner every single launch.
 */
export type BackupSkipReason =
  | 'no_save_folder_configured'
  | 'save_folder_missing'
  | 'save_folder_empty'
  | 'unchanged_since_last_backup'

export type BackupOutcome =
  | {
      status: 'created'
      backup: SaveBackup
      /**
       * Ids of snapshots rotation deleted as part of this backup. Sent as ids
       * rather than a count so the renderer can drop exactly those rows from
       * its cached history; a count would leave it stale until the next fetch.
       */
      rotatedIds: number[]
    }
  | { status: 'skipped'; reason: BackupSkipReason }

export interface BackupUsage {
  backupCount: number
  totalSizeBytes: number
}

/**
 * Pushed after any backup, including the automatic pre-launch and post-session
 * ones the renderer never asked for.
 */
export interface BackupFinishedEvent {
  gameId: number
  trigger: BackupTrigger
  outcome: BackupOutcome
  /** Present when the backup failed outright, as opposed to being skipped. */
  error: string | null
}

export interface RestoreResult {
  restoredFrom: SaveBackup
  /**
   * The pre_restore snapshot taken before anything was overwritten -- the undo
   * button. Null only when there were no existing saves to protect.
   */
  safetyBackup: SaveBackup | null
  saveFolderPath: string
  /** True when the save folder did not exist and was recreated (post-reinstall). */
  recreatedSaveFolder: boolean
}

// --- Settings and maintenance ------------------------------------------------

export type OrphanReason = 'deleted_game' | 'unreferenced_snapshot'

export interface OrphanFolder {
  path: string
  sizeBytes: number
  reason: OrphanReason
  label: string
}

export interface OrphanScanResult {
  folders: OrphanFolder[]
  totalBytes: number
  scannedRoot: string
}

export interface DemoDataResult {
  gamesCreated: number
  sessionsCreated: number
  backupsCreated: number
  demoRoot: string
}

export interface OrphanCleanupResult {
  deletedCount: number
  freedBytes: number
  failed: string[]
}

// --- Window chrome -----------------------------------------------------------

export interface WindowState {
  isFullScreen: boolean
  isMaximized: boolean
  /**
   * True when the renderer must draw its own minimise/maximise/close buttons
   * (Windows and Linux). False on macOS, where the system traffic lights are
   * floated over the page instead.
   */
  needsCustomControls: boolean
  platform: Platform
}

/** Cancels an event subscription. Returned by every on* method. */
export type Unsubscribe = () => void

/**
 * Every IPC handler returns this envelope instead of throwing across the
 * boundary. Electron serialises a thrown Error into an opaque string that
 * loses the stack and any structured detail, so we normalise errors into
 * data. Redux thunks can then reject with a real message.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** The exact shape exposed on `window.api` by the preload script. */
export interface RendererApi {
  app: {
    getInfo: () => Promise<IpcResult<AppInfo>>
  }
  games: {
    list: () => Promise<IpcResult<Game[]>>
    get: (id: number) => Promise<IpcResult<Game | null>>
    create: (input: NewGame) => Promise<IpcResult<Game>>
    update: (id: number, patch: GameUpdate) => Promise<IpcResult<Game>>
    remove: (id: number, options: DeleteGameOptions) => Promise<IpcResult<DeleteGameResult>>
    /** Returns the chosen path, or null if the user cancelled. */
    pickExecutable: () => Promise<IpcResult<string | null>>
    pickDirectory: (purpose: DirectoryPurpose) => Promise<IpcResult<string | null>>
    pickCoverImage: () => Promise<IpcResult<string | null>>
  }
  sessions: {
    launch: (gameId: number) => Promise<IpcResult<LaunchResult>>
    listForGame: (gameId: number, limit?: number) => Promise<IpcResult<PlaySession[]>>
    getStats: (gameId: number) => Promise<IpcResult<SessionStats>>
    /** Game ids with a live process right now. Used to resync after a reload. */
    getRunning: () => Promise<IpcResult<number[]>>

    /*
     * Push subscriptions (main -> renderer).
     *
     * These take a callback rather than returning a promise because a game can
     * exit at any moment, with no renderer request to respond to. The preload
     * strips Electron's IpcRendererEvent before calling back, so the renderer
     * never receives a live object holding a reference to the sender.
     */
    onSessionStarted: (callback: (event: SessionStartedEvent) => void) => Unsubscribe
    onSessionEnded: (callback: (event: SessionEndedEvent) => void) => Unsubscribe
  }
  saves: {
    listForGame: (gameId: number) => Promise<IpcResult<SaveBackup[]>>
    /** Manual "Back up now". Forced, so it runs even if nothing changed. */
    backupNow: (gameId: number) => Promise<IpcResult<BackupOutcome>>
    setPinned: (backupId: number, isPinned: boolean) => Promise<IpcResult<SaveBackup>>
    remove: (backupId: number) => Promise<IpcResult<{ deleted: boolean }>>
    /** Omit gameId for a library-wide total. */
    getUsage: (gameId?: number) => Promise<IpcResult<BackupUsage>>
    /**
     * Overwrites the game's save folder with a snapshot. Destructive, and gated
     * behind a confirmation in the UI. Takes a pinned pre_restore backup first.
     */
    restore: (backupId: number) => Promise<IpcResult<RestoreResult>>
    onBackupFinished: (callback: (event: BackupFinishedEvent) => void) => Unsubscribe
  }
  window: {
    getState: () => Promise<IpcResult<WindowState>>
    setFullScreen: (value: boolean) => Promise<IpcResult<WindowState>>
    toggleFullScreen: () => Promise<IpcResult<WindowState>>
    minimize: () => Promise<IpcResult<null>>
    toggleMaximize: () => Promise<IpcResult<WindowState>>
    close: () => Promise<IpcResult<null>>
    /** Fires for F11, the OS fullscreen gesture, and maximise/restore alike. */
    onStateChanged: (callback: (state: WindowState) => void) => Unsubscribe
  }
  settings: {
    get: () => Promise<IpcResult<AppSettings>>
    /** Returns the full canonical settings, including any clamped values. */
    update: (patch: Partial<AppSettings>) => Promise<IpcResult<AppSettings>>
    pickBackupsFolder: () => Promise<IpcResult<string | null>>
    openBackupsFolder: () => Promise<IpcResult<null>>
    scanOrphans: () => Promise<IpcResult<OrphanScanResult>>
    cleanupOrphans: () => Promise<IpcResult<OrphanCleanupResult>>
    /** Development builds only; the handler refuses when packaged. */
    seedDemoData: () => Promise<IpcResult<DemoDataResult>>
  }
}
