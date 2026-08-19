import { app } from 'electron'
import { Channels, type AppInfo } from '@shared/ipc'
import { handle } from './handle'
import { getDatabaseLocation } from '../main'

/**
 * App-level IPC. Deliberately its own module so the domain modules that follow
 * (games, sessions, saves) each stay small and independently readable.
 */
export function registerAppHandlers(): void {
  handle(Channels.app.getInfo, (): AppInfo => {
    const { dbPath, schemaVersion } = getDatabaseLocation()

    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      dbPath,
      schemaVersion
    }
  })
}
