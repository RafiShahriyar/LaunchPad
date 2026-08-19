import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { closeDatabase, initDatabase, sessionsRepo } from '@db/index'
import { registerAppHandlers } from './ipc/app'
import { registerGamesHandlers } from './ipc/games'
import { registerSessionHandlers } from './ipc/sessions'
import { registerSavesHandlers } from './ipc/saves'
import { registerSettingsHandlers } from './ipc/settings'
import { registerMetadataHandlers } from './ipc/metadata'
import { broadcastWindowState, needsCustomControls, registerWindowHandlers } from './ipc/window'
import { cleanupAbandonedTempFolders } from './services/backups'
import { cleanupAbandonedRestoreFolders } from './services/restore'
import { registerAssetProtocol, registerAssetSchemePrivileged } from './services/assetProtocol'
import { closeAllSessionsOnQuit } from './services/launcher'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

/** Resolved once at startup and reused by the app:getInfo handler. */
export interface DatabaseLocation {
  dbPath: string
  schemaVersion: number
}
let databaseLocation: DatabaseLocation = { dbPath: '', schemaVersion: 0 }

export function getDatabaseLocation(): DatabaseLocation {
  return databaseLocation
}

/**
 * Opens the database before the first window exists.
 *
 * Everything lives under userData, which is per-user and survives app updates.
 * A failure here is fatal and is reported rather than swallowed: continuing
 * would give the user an empty-looking library and, worse, let them "re-add"
 * games that are already stored in a database the app just failed to open.
 */
function setupDatabase(): void {
  const userData = app.getPath('userData')
  const dbPath = join(userData, 'launchpad.db')

  try {
    const result = initDatabase({
      dbPath,
      defaultBackupsRoot: join(userData, 'backups')
    })
    databaseLocation = { dbPath: result.dbPath, schemaVersion: result.schemaVersion }

    if (result.migratedFrom !== result.schemaVersion) {
      console.log(`[db] migrated schema ${result.migratedFrom} -> ${result.schemaVersion}`)
    }

    /*
     * Close sessions left open by an unclean shutdown (app crash, machine
     * power-off, force-quit). They are recorded with duration 0 and reason
     * 'app_closed' -- see db/repositories/sessions.ts for why an unobserved
     * session must not have a duration invented for it.
     *
     * Runs on every start, before any window can read the session list, so the
     * renderer never sees a stale "currently playing" row.
     */
    const reconciled = sessionsRepo.reconcileOpenSessions()
    if (reconciled > 0) {
      console.log(`[db] closed ${reconciled} session(s) orphaned by an unclean shutdown`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox(
      'LaunchPad could not open its database',
      `${message}\n\nDatabase location:\n${dbPath}`
    )
    app.exit(1)
  }
}

/**
 * Height of the custom title bar, shared with the renderer's CSS.
 * Kept modest: it exists to be draggable, not to be looked at.
 */
const TITLE_BAR_HEIGHT = 34

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    // Avoid a white flash before React paints: start hidden, show on ready.
    show: false,
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,

    /*
     * Custom title bar.
     *
     * The default Windows frame paints a bright system-coloured strip above a
     * very dark app, which is the most eye-catching thing on screen. 'hidden'
     * removes that strip and hands the whole strip to the page.
     *
     * No `titleBarOverlay`: the renderer draws its own minimise/maximise/close.
     * See electron/ipc/window.ts for why that reversal was made -- the short
     * version is that Chromium owns the overlay buttons' hover rendering, it was
     * invisible on a near-black bar, and it can be neither restyled nor tested.
     *
     * 'hidden' rather than `frame: false` keeps the OS resize borders and shadow.
     * macOS is unaffected: it keeps its traffic lights, positioned to sit
     * centred in our bar.
     */
    titleBarStyle: 'hidden',
    ...(needsCustomControls()
      ? {}
      : { trafficLightPosition: { x: 12, y: (TITLE_BAR_HEIGHT - 16) / 2 } }),

    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // --- Security posture (all three matter, see docs/ARCHITECTURE.md) ---
      contextIsolation: true, // renderer JS and preload JS get separate contexts
      nodeIntegration: false, // no require() / process / fs in the renderer
      sandbox: true // renderer runs in the OS sandbox; preload gets only ipcRenderer
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /*
   * Keep the renderer's idea of the window in sync. Fullscreen and maximise can
   * both change without the renderer asking -- F11, the OS gesture, a window
   * manager, or double-clicking the drag region -- so the state is pushed
   * rather than polled.
   */
  // The event name carries the truth -- see broadcastWindowState() for why the
  // window itself cannot be trusted to describe its state mid-transition.
  mainWindow.on('enter-full-screen', () => broadcastWindowState(mainWindow, { isFullScreen: true }))
  mainWindow.on('leave-full-screen', () => broadcastWindowState(mainWindow, { isFullScreen: false }))
  mainWindow.on('maximize', () => broadcastWindowState(mainWindow, { isMaximized: true }))
  mainWindow.on('unmaximize', () => broadcastWindowState(mainWindow, { isMaximized: false }))

  /*
   * F11 toggles fullscreen, matching every browser and most desktop apps.
   *
   * Registered on this window's input rather than as a globalShortcut: a global
   * one would steal F11 from every other application while LaunchPad merely
   * happens to be running.
   */
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    if (input.key === 'F11' && !input.control && !input.alt && !input.meta) {
      event.preventDefault()
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
      return
    }

    // Escape leaves fullscreen only -- it must stay available to close dialogs
    // when the window is not fullscreen.
    if (input.key === 'Escape' && mainWindow?.isFullScreen()) {
      event.preventDefault()
      mainWindow.setFullScreen(false)
    }
  })

  // Anything that tries to open a new window (target=_blank, window.open) goes
  // to the user's real browser instead of spawning an un-sandboxed Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Must run before app.whenReady(): privileged schemes cannot be registered
// once the protocol system has initialised.
registerAssetSchemePrivileged()

// Only one copy of the app may run: a second instance would open a second
// SQLite connection and could double-count play sessions.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    // Order matters: the database must be open before handlers can serve a
    // query, and handlers must be registered before a window can invoke one.
    setupDatabase()
    registerAssetProtocol()
    registerAppHandlers()
    registerGamesHandlers()
    registerSessionHandlers()
    registerSavesHandlers()
    registerSettingsHandlers()
    registerMetadataHandlers()
    registerWindowHandlers(() => mainWindow)

    /*
     * Remove `.tmp-` folders left by a backup interrupted mid-copy. They are
     * already invisible to the app (nothing without a database row is listed),
     * but a crash during a backup would otherwise leak a full copy of a save
     * folder that nothing ever cleans up. Fire-and-forget: startup must not
     * wait on disk cleanup.
     */
    void cleanupAbandonedTempFolders().then((removed) => {
      if (removed > 0) console.log(`[saves] removed ${removed} abandoned temp folder(s)`)
    })

    /*
     * Same idea for restore staging folders, but these sit in the user's real
     * save directory rather than a folder the app owns, so the cleanup only
     * ever matches the app's own `.lp-restore-` / `.lp-replaced-` prefixes.
     */
    void cleanupAbandonedRestoreFolders().then((removed) => {
      if (removed > 0) console.log(`[restore] removed ${removed} abandoned staging folder(s)`)
    })

    createWindow()

    app.on('activate', () => {
      // macOS: clicking the dock icon with no windows open re-creates one.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // macOS apps conventionally stay alive with no windows; Windows/Linux quit.
    if (process.platform !== 'darwin') app.quit()
  })

  /*
   * Shutdown order matters: sessions must be written while the database is
   * still open, so this runs on 'before-quit' and the close runs on 'will-quit'.
   * Both are synchronous -- Electron does not await promises during quit, so a
   * promise-based version here would silently lose the final writes.
   */
  app.on('before-quit', () => {
    closeAllSessionsOnQuit()
  })

  // Checkpoints the WAL and closes the connection cleanly. Without this the
  // most recent writes stay in the -wal sidecar until the next open.
  app.on('will-quit', () => {
    closeDatabase()
  })
}
