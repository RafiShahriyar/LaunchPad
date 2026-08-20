import { useEffect } from 'react'
import { formatBytes } from '@/lib/format'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { selectGameById } from '@/store/slices/gamesSlice'
import {
  backupNow,
  fetchBackups,
  selectBackupsForGame,
  selectIsBackupBusy
} from '@/store/slices/savesSlice'
import { modalClosed } from '@/store/slices/uiSlice'
import { BackupList } from './BackupList'
import { Button, Modal } from './Modal'

/**
 * Quick access to snapshots from the library grid, without navigating away.
 * The list itself is the same component the detail page renders -- restore is
 * the riskiest action in the app, so it has exactly one implementation.
 */

export function BackupHistoryModal({ gameId }: { gameId: number }) {
  const dispatch = useAppDispatch()
  const game = useAppSelector((state) => selectGameById(state, gameId))
  const backups = useAppSelector((state) => selectBackupsForGame(state, gameId))
  const isBusy = useAppSelector((state) => selectIsBackupBusy(state, gameId))
  const { status, error } = useAppSelector((state) => state.saves)

  useEffect(() => {
    void dispatch(fetchBackups(gameId))
  }, [dispatch, gameId])

  if (!game) return null

  const totalBytes = backups.reduce((sum, backup) => sum + backup.sizeBytes, 0)

  return (
    <Modal
      title={`Save backups — ${game.name}`}
      description={
        game.saveFolderPath
          ? `Snapshots of ${game.saveFolderPath}`
          : 'No save folder is set for this game.'
      }
      size="lg"
      onClose={() => dispatch(modalClosed())}
      footer={
        <>
          <span className="mr-auto text-xs text-content-500">
            {backups.length} snapshot{backups.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </span>
          <Button variant="ghost" onClick={() => dispatch(modalClosed())}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={!game.saveFolderPath || isBusy}
            onClick={() => void dispatch(backupNow(gameId))}
          >
            {isBusy ? 'Backing up…' : 'Back up now'}
          </Button>
        </>
      }
    >
      {status === 'loading' && backups.length === 0 && (
        <p className="text-sm text-content-500">Loading…</p>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <BackupList
        gameId={gameId}
        emptyHint={
          game.saveFolderPath
            ? 'LaunchPad takes one automatically before each launch and after each session, or you can take one now.'
            : 'Set a save folder in Edit to enable backups for this game.'
        }
      />
    </Modal>
  )
}
