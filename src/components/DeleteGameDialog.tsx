import { useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { deleteGame, selectGameById } from '@/store/slices/gamesSlice'
import { modalClosed } from '@/store/slices/uiSlice'
import { libraryOpened } from '@/store/slices/uiSlice'
import { Button, Modal } from './Modal'

/**
 * Deleting a game is the one destructive action in the library, and it has two
 * separable consequences: the library entry disappears, and the save backups
 * may or may not survive. Those are asked about separately, and backups are
 * KEPT by default -- the whole point of the app is that a deleted game does not
 * mean lost saves.
 */
export function DeleteGameDialog({ gameId }: { gameId: number }) {
  const dispatch = useAppDispatch()
  const game = useAppSelector((state) => selectGameById(state, gameId))
  const { mutationStatus, mutationError } = useAppSelector((state) => state.games)
  const [deleteBackups, setDeleteBackups] = useState(false)

  if (!game) return null

  const confirm = async () => {
    try {
      await dispatch(deleteGame({ id: game.id, options: { deleteBackups } })).unwrap()
      dispatch(modalClosed())
      // The detail view for a deleted game cannot render, so step back to the library.
      dispatch(libraryOpened())
    } catch {
      // Error surfaced below; keep the dialog open.
    }
  }

  return (
    <Modal
      title={`Delete “${game.name}”?`}
      onClose={() => dispatch(modalClosed())}
      footer={
        <>
          <Button variant="ghost" onClick={() => dispatch(modalClosed())}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={mutationStatus === 'loading'}>
            {mutationStatus === 'loading' ? 'Deleting…' : 'Delete game'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-content-300">
        <p>
          This removes the library entry and its play history. The game itself stays installed —
          LaunchPad never touches the executable or its folder.
        </p>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-600 bg-surface-900 p-4">
          <input
            type="checkbox"
            checked={deleteBackups}
            onChange={(event) => setDeleteBackups(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-red-500"
          />
          <span>
            <span className="font-medium text-content-200">Also delete save backups</span>
            <span className="mt-1 block text-xs text-content-500">
              Leave this unchecked to keep the backup folders on disk. You can restore them by
              hand, or by re-adding the game later.
            </span>
          </span>
        </label>

        {deleteBackups && (
          <p className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-xs text-red-300">
            Save backups for this game will be permanently deleted. This cannot be undone.
          </p>
        )}

        {mutationError && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {mutationError}
          </div>
        )}
      </div>
    </Modal>
  )
}
