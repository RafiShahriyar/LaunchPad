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
  /**
   * Absolute path to wide key art used as the detail page's backdrop.
   *
   * Deliberately not the same field as `coverImagePath`: the cover is portrait
   * 3:4 for the grid card, this is roughly 16:6 and only ever drawn full-bleed
   * behind text. A game can have one without the other — SteamGridDB carries
   * grids for many more titles than it carries heroes — so collapsing them
   * would mean stretching box art across the header or emptying the grid card.
   *
   * Null means no wide art, which the detail page states rather than hides.
   */
  heroImagePath: string | null
  /**
   * Genres reported by the metadata provider.
   *
   * `null` and `[]` mean different things and the UI renders them differently:
   * null is "never looked up", `[]` is "looked up, and the provider listed
   * none". Collapsing them would make the app claim a game has no genres when
   * it has simply never been asked about.
   */
  genres: string[] | null
  /** Short description from the provider, or null if never looked up. */
  summary: string | null
  /** Provider release date as YYYY-MM-DD. Not a timestamp: the source has no time. */
  releaseDate: string | null
  /** Which provider supplied the fields above. Null when none has. */
  metadataSource: MetadataSource | null
  /** The provider's own id, so a refresh re-queries the same entry, not a new search. */
  metadataId: string | null
  metadataUpdatedAt: IsoTimestamp | null
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

/**
 * Providers of the text metadata: genres, summary and release date.
 *
 * A union rather than a bare string so that adding one forces every switch over
 * it to be revisited at compile time.
 */
export type MetadataSource = 'igdb' | 'rawg'

/**
 * Providers of cover art only.
 *
 * Separate from MetadataSource because these supply no genres or descriptions —
 * they exist to solve one problem, that the library grid draws portrait 3:4
 * cards and most catalogue APIs return landscape screenshots.
 */
export type CoverArtSource = 'steamgriddb'

/** Anything that needs credentials stored on this machine. */
export type CredentialProvider = MetadataSource | CoverArtSource

/**
 * Colour themes.
 *
 * `dark` keeps its original id rather than being renamed to something prettier
 * like `midnight`. Existing databases already store the string `dark`, and the
 * settings parser falls back to the default for any value it does not
 * recognise — so a rename would silently reset the theme of every install that
 * upgrades. A display label costs nothing; a migration for a cosmetic id is not
 * worth writing.
 *
 * Every theme is dark. See the note in src/index.css: status banners are not
 * part of any ramp, so a light surface would render them dark-on-dark. `light`
 * is absent rather than present-and-broken.
 */
export type ThemeId = 'dark' | 'nebula' | 'ember' | 'verdant'

/**
 * The runtime enumeration of ThemeId.
 *
 * A Record rather than a `readonly ThemeId[]`, because an array literal happily
 * accepts a SHORT list: adding a member to the union and forgetting to list it
 * compiles clean and fails at runtime. That exact mistake shipped once already
 * (`metadata_source: rawg is not one of igdb`) and was caught only by the e2e
 * suite. As a Record, a missing member is a compile error.
 */
export const THEME_IDS: Record<ThemeId, true> = {
  dark: true,
  nebula: true,
  ember: true,
  verdant: true
}

export const ALL_THEME_IDS = Object.keys(THEME_IDS) as ThemeId[]

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEME_IDS
}

export interface AppSettings {
  /** Root folder that per-game backup folders live under. */
  backupsRootPath: string
  /** Rotation limit: how many unpinned snapshots to retain per game. */
  maxBackupsPerGame: number
  backupBeforeLaunch: boolean
  backupAfterSession: boolean
  /** Sessions shorter than this are discarded (misclicks, failed launches). */
  minSessionSeconds: number
  theme: ThemeId
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

/**
 * Provider-supplied fields, written as one unit by the metadata flow.
 *
 * Deliberately separate from NewGame/GameUpdate, which model what a *user*
 * authors. Keeping them apart means the games:create and games:update handlers
 * cannot be talked into writing a metadata provenance that never happened —
 * the same reason the database owns id and the timestamps.
 */
export interface GameMetadataPatch {
  genres: string[]
  summary: string | null
  releaseDate: string | null
  metadataSource: MetadataSource
  metadataId: string
}

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
