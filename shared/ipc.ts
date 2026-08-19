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
  CredentialProvider,
  Game,
  GameUpdate,
  MetadataSource,
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
  metadata: {
    search: 'metadata:search',
    apply: 'metadata:apply',
    getStatus: 'metadata:getStatus',
    setCredentials: 'metadata:setCredentials',
    clearCredentials: 'metadata:clearCredentials'
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
  /** True when the session was too short to record, or never started at all. */
  discarded: boolean
  exitReason: SessionExitReason
  /** Process exit code, or null when terminated by a signal. */
  exitCode: number | null
  /**
   * Set when the process could not be STARTED, as opposed to having run and
   * exited.
   *
   * These two are wildly different to a user — "you quit after two seconds" and
   * "Windows refused to run this" — but they arrive on the same channel, because
   * on Windows `spawn()` reports a failure to start asynchronously through the
   * child's `error` event rather than by throwing. The launch IPC call has
   * already resolved successfully by then, so this field is the only route the
   * reason has back to the renderer. Without it a failed launch is silent, and
   * the UI simply flips from "Playing" back to "Play" as though nothing
   * happened. That was a real bug.
   */
  launchError: string | null
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

// --- Game metadata -----------------------------------------------------------

/**
 * One candidate returned by a provider search.
 *
 * `id` is a string even though IGDB's ids are numeric: it is an opaque handle
 * that only ever travels back to the provider, and typing it as a number would
 * invite arithmetic on it and lose precision on a provider that uses large or
 * non-numeric ids.
 */
export interface MetadataSearchResult {
  id: string
  /**
   * Which provider produced this entry.
   *
   * Carried on the result rather than inferred at apply time so the provenance
   * stored on the game is the provider that actually supplied the values, even
   * if the active provider changed between searching and saving.
   */
  source: MetadataSource
  name: string
  /** YYYY-MM-DD, or null when the provider lists no release date. */
  releaseDate: string | null
  /** Empty array means the provider listed none — not "unknown". */
  genres: string[]
  summary: string | null
  /** Remote URL of full-size portrait box art, downloaded only when applied. */
  coverUrl: string | null
  /**
   * A tiny preview of the box art, inlined as a `data:` URI by main.
   *
   * The picker is unusable without thumbnails — several editions of a game look
   * identical by name alone. It is a data URI rather than a remote URL because
   * the renderer's CSP sets `connect-src 'none'` and must keep doing so: the
   * page opens no sockets of its own, and main already allows `img-src data:`.
   * Fetching these in main costs one round trip per result against a CDN and
   * keeps the sandbox exactly as tight as it was.
   *
   * Null when the entry has no cover, or when the thumbnail fetch failed —
   * which is never treated as a failed search.
   */
  thumbnailDataUri: string | null
}

export interface MetadataSearchResponse {
  /** The provider that answered, so the UI can attribute results. */
  source: MetadataSource
  /**
   * Echoed back so the renderer can discard a slow response that arrives after
   * the user has already retyped. Without it, an earlier request finishing last
   * would overwrite the results for the query actually on screen.
   */
  query: string
  results: MetadataSearchResult[]
}

export interface MetadataApplyOptions {
  /** Overwrite the game's name with the provider's. */
  applyName: boolean
  /** Download the provider's cover art into the managed covers folder. */
  applyCover: boolean
}

export interface MetadataApplyResult {
  game: Game
  /** The managed cover path, or null when none was requested or available. */
  coverImagePath: string | null
  /**
   * Set when the metadata was written but the cover download failed. Reported
   * rather than thrown: the text fields did apply, so this is a partial
   * success, and failing the whole operation would discard work that succeeded.
   */
  coverError: string | null
}

/** One credential input a provider needs. */
export interface ProviderField {
  key: string
  label: string
  /** Rendered as a password box and never echoed back to the renderer. */
  secret: boolean
  placeholder: string
}

/**
 * Everything the settings screen needs to render a provider it has never heard
 * of.
 *
 * Declared in the contract rather than hard-coded in the UI so that adding a
 * provider is a main-process change plus a union member — the settings screen
 * does not grow a third branch each time.
 */
export interface ProviderDescriptor {
  id: CredentialProvider
  name: string
  /** `metadata` supplies genres/summary/date; `art` supplies cover images only. */
  role: 'metadata' | 'art'
  fields: ProviderField[]
  signupUrl: string
  blurb: string
}

/**
 * What the renderer is allowed to know about stored credentials.
 *
 * Deliberately excludes every secret and gives only a masked identifier. The
 * renderer never needs the real values — main is the only side that talks to
 * any provider.
 */
export interface ProviderCredentialStatus {
  provider: CredentialProvider
  configured: boolean
  /** e.g. "abcd…wxyz", or null when nothing is stored. Never a secret. */
  maskedKey: string | null
  /** Whether a cached OAuth token is held. Only IGDB uses one. */
  hasCachedToken: boolean
}

export interface MetadataStatus {
  providers: ProviderDescriptor[]
  credentials: ProviderCredentialStatus[]
  /**
   * The provider searches will actually use, or null when none is configured.
   *
   * Reported rather than inferred in the renderer so the settings screen can
   * state which one is in use when more than one is set up, instead of leaving
   * the user to guess.
   */
  activeSource: MetadataSource | null
  /**
   * True when an art provider is configured and can upgrade a landscape
   * catalogue image to portrait box art at apply time.
   */
  artConfigured: boolean
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
  metadata: {
    /**
     * Searches the provider by name. Rejects (as an envelope) when no
     * credentials are configured, rather than returning zero results — "not
     * set up" and "no such game" must not look the same to the user.
     */
    search: (query: string) => Promise<IpcResult<MetadataSearchResponse>>
    /** Writes the chosen entry onto the game, optionally fetching its cover. */
    apply: (
      gameId: number,
      result: MetadataSearchResult,
      options: MetadataApplyOptions
    ) => Promise<IpcResult<MetadataApplyResult>>
    /** Descriptors plus what is configured. One call drives the whole screen. */
    getStatus: () => Promise<IpcResult<MetadataStatus>>
    /**
     * Verifies the values against the provider before storing them, so a bad
     * key fails at the action that caused it rather than as a broken search.
     * `values` is keyed by `ProviderField.key`.
     */
    setCredentials: (
      provider: CredentialProvider,
      values: Record<string, string>
    ) => Promise<IpcResult<MetadataStatus>>
    clearCredentials: (provider: CredentialProvider) => Promise<IpcResult<MetadataStatus>>
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
