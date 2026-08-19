import type {
  BackupFinishedEvent,
  SessionEndedEvent,
  SessionStartedEvent,
  WindowState
} from '@shared/ipc'
import { gameUpdatedExternally } from './slices/gamesSlice'
import { backupFinished } from './slices/savesSlice'
import { sessionEnded, sessionStarted } from './slices/sessionsSlice'
import { windowStateChanged } from './slices/uiSlice'
import type { store as Store } from './store'

/**
 * Connects main-process push events to the Redux store.
 *
 * Deliberately NOT a React hook. These subscriptions must outlive any
 * component: a game can exit while the user is on the settings screen, or with
 * the library unmounted entirely, and the resulting playtime update must still
 * land. Wiring it at module level, once, also sidesteps StrictMode's
 * double-invoked effects in development.
 *
 * Called once from src/main.tsx, before React renders.
 */
export function startEventBridge(store: typeof Store): () => void {
  const unsubscribeStarted = window.api.sessions.onSessionStarted(
    (event: SessionStartedEvent) => {
      store.dispatch(sessionStarted(event))
    }
  )

  const unsubscribeEnded = window.api.sessions.onSessionEnded((event: SessionEndedEvent) => {
    store.dispatch(sessionEnded(event))

    /*
     * The event carries the game with its refreshed playtime roll-up, so the
     * grid updates from the push alone -- no refetch. This is the one place a
     * game is written to the store without a thunk, which is why it uses a
     * clearly named action rather than reusing an update thunk's fulfilled case.
     */
    if (event.game) store.dispatch(gameUpdatedExternally(event.game))
  })

  /*
   * Backups fire without the renderer asking: automatically before every launch
   * and after every session. This is the only way the UI learns about them.
   */
  const unsubscribeBackup = window.api.saves.onBackupFinished((event: BackupFinishedEvent) => {
    store.dispatch(backupFinished(event))
  })

  /*
   * Fullscreen can change without the renderer asking -- F11, the OS gesture,
   * a window manager -- so the chrome state is pushed too.
   */
  const unsubscribeWindow = window.api.window.onStateChanged((state: WindowState) => {
    store.dispatch(windowStateChanged(state))
  })

  return () => {
    unsubscribeStarted()
    unsubscribeEnded()
    unsubscribeBackup()
    unsubscribeWindow()
  }
}
