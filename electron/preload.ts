import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channels, type RendererApi, type Unsubscribe } from '@shared/ipc'

/**
 * The ONLY bridge between the renderer and Node.
 *
 * Note what is NOT here: no `ipcRenderer` itself, no generic `invoke(channel)`
 * escape hatch, no `fs`, no `require`. Exposing a generic invoke would defeat
 * the whole point of contextIsolation, because renderer code (or anything
 * injected into it) could then reach any channel in the app. Each capability
 * is whitelisted explicitly.
 */

/**
 * Wraps a main -> renderer push channel as a subscribe function.
 *
 * Two things matter here:
 *
 *   1. **The IpcRendererEvent is stripped.** It carries `sender`, a live handle
 *      to the IPC pipe. Passing it through contextBridge would hand renderer
 *      code a way to send on arbitrary channels, undoing the whitelist above.
 *      Only the plain payload is forwarded.
 *   2. **An unsubscribe function is returned.** Without one, every React effect
 *      re-run would stack another listener on the same channel, and Electron
 *      would warn about a leak after eleven of them.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: RendererApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(Channels.app.getInfo)
  },
  games: {
    list: () => ipcRenderer.invoke(Channels.games.list),
    get: (id) => ipcRenderer.invoke(Channels.games.get, id),
    create: (input) => ipcRenderer.invoke(Channels.games.create, input),
    update: (id, patch) => ipcRenderer.invoke(Channels.games.update, id, patch),
    remove: (id, options) => ipcRenderer.invoke(Channels.games.remove, id, options),
    pickExecutable: () => ipcRenderer.invoke(Channels.games.pickExecutable),
    pickDirectory: (purpose) => ipcRenderer.invoke(Channels.games.pickDirectory, purpose),
    pickCoverImage: () => ipcRenderer.invoke(Channels.games.pickCoverImage)
  },
  sessions: {
    launch: (gameId) => ipcRenderer.invoke(Channels.sessions.launch, gameId),
    listForGame: (gameId, limit) => ipcRenderer.invoke(Channels.sessions.listForGame, gameId, limit),
    getStats: (gameId) => ipcRenderer.invoke(Channels.sessions.getStats, gameId),
    getRunning: () => ipcRenderer.invoke(Channels.sessions.getRunning),
    onSessionStarted: (callback) => subscribe(Channels.sessions.started, callback),
    onSessionEnded: (callback) => subscribe(Channels.sessions.ended, callback)
  },
  saves: {
    listForGame: (gameId) => ipcRenderer.invoke(Channels.saves.listForGame, gameId),
    backupNow: (gameId) => ipcRenderer.invoke(Channels.saves.backupNow, gameId),
    setPinned: (backupId, isPinned) =>
      ipcRenderer.invoke(Channels.saves.setPinned, backupId, isPinned),
    remove: (backupId) => ipcRenderer.invoke(Channels.saves.remove, backupId),
    getUsage: (gameId) => ipcRenderer.invoke(Channels.saves.getUsage, gameId),
    restore: (backupId) => ipcRenderer.invoke(Channels.saves.restore, backupId),
    onBackupFinished: (callback) => subscribe(Channels.saves.backupFinished, callback)
  },
  window: {
    getState: () => ipcRenderer.invoke(Channels.window.getState),
    setFullScreen: (value) => ipcRenderer.invoke(Channels.window.setFullScreen, value),
    toggleFullScreen: () => ipcRenderer.invoke(Channels.window.toggleFullScreen),
    minimize: () => ipcRenderer.invoke(Channels.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(Channels.window.toggleMaximize),
    close: () => ipcRenderer.invoke(Channels.window.close),
    onStateChanged: (callback) => subscribe(Channels.window.stateChanged, callback)
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.settings.get),
    update: (patch) => ipcRenderer.invoke(Channels.settings.update, patch),
    pickBackupsFolder: () => ipcRenderer.invoke(Channels.settings.pickBackupsFolder),
    openBackupsFolder: () => ipcRenderer.invoke(Channels.settings.openBackupsFolder),
    scanOrphans: () => ipcRenderer.invoke(Channels.settings.scanOrphans),
    cleanupOrphans: () => ipcRenderer.invoke(Channels.settings.cleanupOrphans),
    seedDemoData: () => ipcRenderer.invoke(Channels.settings.seedDemoData)
  }
}

contextBridge.exposeInMainWorld('api', api)
