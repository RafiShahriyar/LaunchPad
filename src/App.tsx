import { useEffect } from 'react'
import { BackupHistoryModal } from '@/components/BackupHistoryModal'
import { BackupStatusBar } from '@/components/BackupStatusBar'
import { DeleteGameDialog } from '@/components/DeleteGameDialog'
import { GameFormModal } from '@/components/GameFormModal'
import { RestoreBackupDialog } from '@/components/RestoreBackupDialog'
import { Sidebar } from '@/components/Sidebar'
import { FullscreenExitButton, TitleBar } from '@/components/TitleBar'
import { GameDetailPage } from '@/pages/GameDetailPage'
import { LibraryPage } from '@/pages/LibraryPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { fetchGames, selectGameById } from '@/store/slices/gamesSlice'
import { launchErrorCleared, syncRunningGames } from '@/store/slices/sessionsSlice'
import { fetchAppInfo, fetchSettings } from '@/store/slices/settingsSlice'
import { fetchWindowState } from '@/store/slices/uiSlice'

export default function App() {
  const dispatch = useAppDispatch()
  const activeView = useAppSelector((state) => state.ui.activeView)
  const selectedGameId = useAppSelector((state) => state.ui.selectedGameId)

  // Initial load. All three are independent, so they run concurrently.
  // syncRunningGames matters on every mount, not just the first: which games are
  // running lives in main-process memory, so a reload (or a dev hot reload)
  // would otherwise lose the "Playing" state of a game that is still open.
  useEffect(() => {
    void dispatch(fetchAppInfo())
    // Settings are needed app-wide now, not just on the settings page: the
    // sidebar reads its collapsed state from them.
    void dispatch(fetchSettings())
    void dispatch(fetchGames())
    void dispatch(syncRunningGames())
    // Window chrome lives in the main process, so a reload must re-sync it or
    // the title bar would guess wrong about fullscreen and native controls.
    void dispatch(fetchWindowState())
  }, [dispatch])

  return (
    // Column layout: the title bar spans the full width above the sidebar, so
    // the whole top edge is draggable rather than just the content area.
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <LaunchErrorBanner />
          <BackupStatusBar />
          {activeView === 'settings' && <SettingsPage />}
          {activeView === 'gameDetail' && selectedGameId !== null && (
            <GameDetailPage gameId={selectedGameId} />
          )}
          {activeView === 'library' && <LibraryPage />}
        </main>
      </div>
      <FullscreenExitButton />
      <ModalHost />
    </div>
  )
}

/**
 * Launch failures are shown as a banner rather than a modal.
 *
 * A failed launch is informational -- the user's next action is to fix the path
 * in the edit dialog, not to acknowledge a dialog first. A modal would also be
 * wrong for an event that can arrive while the user is doing something else.
 */
function LaunchErrorBanner() {
  const dispatch = useAppDispatch()
  const launchError = useAppSelector((state) => state.sessions.launchError)
  if (!launchError) return null

  return (
    <div className="flex items-start gap-3 border-b border-red-900 bg-red-950/60 px-8 py-3 text-sm text-red-200">
      <span className="flex-1">{launchError}</span>
      <button
        onClick={() => dispatch(launchErrorCleared())}
        aria-label="Dismiss launch error"
        className="shrink-0 rounded px-2 text-red-300 hover:bg-red-900/60 hover:text-red-100"
      >
        ✕
      </button>
    </div>
  )
}

/**
 * Renders whichever modal `ui.modal` names.
 *
 * Centralised here rather than scattered through the pages so that exactly one
 * modal can exist at a time -- the discriminated union in uiSlice makes two
 * simultaneously-open dialogs unrepresentable, and this is the single place
 * that decision is applied.
 */
function ModalHost() {
  const modal = useAppSelector((state) => state.ui.modal)
  const editingGame = useAppSelector((state) =>
    modal.kind === 'editGame' ? selectGameById(state, modal.gameId) : undefined
  )

  switch (modal.kind) {
    case 'addGame':
      return <GameFormModal />
    case 'editGame':
      // The game can be missing if it was deleted in another window while this
      // dialog was open; rendering nothing is better than crashing.
      return editingGame ? <GameFormModal game={editingGame} /> : null
    case 'deleteGame':
      return <DeleteGameDialog gameId={modal.gameId} />
    case 'backupHistory':
      return <BackupHistoryModal gameId={modal.gameId} />
    case 'restoreBackup':
      return <RestoreBackupDialog backupId={modal.backupId} />
    default:
      return null
  }
}
