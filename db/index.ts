/**
 * Public surface of the data layer.
 *
 * Everything outside `db/` imports from here, never from a repository file
 * directly. That keeps the SQLite binding an implementation detail: switching
 * from node:sqlite to better-sqlite3 (or anything else) means rewriting
 * client.ts and the mappers, with no changes above this line.
 */

export { initDatabase, getDb, closeDatabase, transaction } from './client'
export type { InitDatabaseOptions, InitDatabaseResult } from './client'
export { LATEST_SCHEMA_VERSION, getSchemaVersion } from './schema'
export { DEFAULT_SETTINGS } from './defaults'

export * as gamesRepo from './repositories/games'
export * as sessionsRepo from './repositories/sessions'
export * as savesRepo from './repositories/saves'
export * as settingsRepo from './repositories/settings'
export * as credentialsRepo from './repositories/credentials'

export type { GameSessionStats } from './repositories/sessions'
export type { BackupUsage } from './repositories/saves'
export type { CachedToken } from './repositories/credentials'
