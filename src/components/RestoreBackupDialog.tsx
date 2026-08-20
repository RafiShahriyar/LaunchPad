import { useMemo, useState } from 'react'
import { formatBytes, formatDate } from '@/lib/format'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { selectGameById } from '@/store/slices/gamesSlice'
import { restoreBackup, restoreErrorCleared } from '@/store/slices/savesSlice'
import { selectIsGameRunning } from '@/store/slices/sessionsSlice'
import { modalClosed, modalOpened } from '@/store/slices/uiSlice'
import { Button, Modal } from './Modal'

/**
 * Confirmation for the only operation in the app that destroys user data.
 *
 * Three things it does deliberately:
 *
 *   1. **States exactly what will be overwritten** — the target folder path, in
 *      full. "Are you sure?" without naming the target is not informed consent.
 *   2. **Requires a typed confirmation.** A misclicked Restore on the wrong
 *      snapshot is unrecoverable in the user's mental model, even though the
 *      safety backup makes it technically recoverable.
 *   3. **Promises the undo up front**, so the user knows the safety net exists
 *      before deciding rather than discovering it afterwards.
 */
export function RestoreBackupDialog({ backupId }: { backupId: number }) {
  const dispatch = useAppDispatch()
  const [typed, setTyped] = useState('')

  const backup = useAppSelector((state) =>
    Object.values(state.saves.byGameId)
      .flat()
      .find((candidate) => candidate.id === backupId)
  )
  const game = useAppSelector((state) =>
    backup ? selectGameById(state, backup.gameId) : undefined
  )
  const isRunning = useAppSelector((state) =>
    backup ? selectIsGameRunning(state, backup.gameId) : false
  )
  const { restoringBackupId, restoreError, lastRestore } = useAppSelector((state) => state.saves)

  const isRestoring = restoringBackupId === backupId
  const confirmWord = useMemo(() => 'restore', [])
  const canConfirm = typed.trim().toLowerCase() === confirmWord && !isRunning && !isRestoring

  if (!backup || !game) return null

  // Success view: the restore completed, so show what happened and where the undo is.
  if (lastRestore && lastRestore.restoredFrom.id === backupId) {
    return (
      <Modal
        title="Saves restored"
        onClose={() => dispatch(modalClosed())}
        footer={
          <Button variant="primary" onClick={() => dispatch(modalClosed())}>
            Done
          </Button>
        }
      >
        <div className="space-y-4 text-sm text-content-300">
          <p>
            {game.name} has been restored from the snapshot taken{' '}
            <strong>{formatDate(backup.createdAt)}</strong>.
          </p>
          {lastRestore.recreatedSaveFolder && (
            <p className="rounded-lg border border-surface-600 bg-surface-900 px-4 py-3 text-xs text-content-400">
              The save folder did not exist and was recreated at
              <span className="mt-1 block font-mono text-content-300">
                {lastRestore.saveFolderPath}
              </span>
            </p>
          )}
          {lastRestore.safetyBackup && (
            <p className="rounded-lg border border-emerald-900 bg-emerald-950/40 px-4 py-3 text-xs text-emerald-200">
              Your previous saves were kept as a pinned <strong>Before restore</strong> snapshot.
              Restore that one to undo this.
            </p>
          )}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Restore these saves?"
      onClose={() => dispatch(modalClosed())}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              dispatch(restoreErrorCleared())
              dispatch(modalOpened({ kind: 'backupHistory', gameId: game.id }))
            }}
          >
            Back
          </Button>
          <Button
            variant="danger"
            disabled={!canConfirm}
            onClick={() => void dispatch(restoreBackup(backupId))}
          >
            {isRestoring ? 'Restoring…' : 'Restore saves'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-content-300">
        <div className="rounded-lg border border-surface-600 bg-surface-900 p-4">
          <p className="text-xs uppercase tracking-wide text-content-500">Restoring</p>
          <p className="mt-1 text-content-200">
            {formatDate(backup.createdAt)} · {backup.fileCount} file
            {backup.fileCount === 1 ? '' : 's'} · {formatBytes(backup.sizeBytes)}
          </p>
        </div>

        <div className="rounded-lg border border-red-900 bg-red-950/40 p-4">
          <p className="text-xs uppercase tracking-wide text-red-300">This overwrites</p>
          <p className="mt-1 break-all font-mono text-xs text-red-100">{game.saveFolderPath}</p>
          <p className="mt-2 text-xs text-red-200/80">
            Everything currently in that folder is replaced. Files added since this snapshot was
            taken will be gone.
          </p>
        </div>

        <p className="rounded-lg border border-emerald-900 bg-emerald-950/40 px-4 py-3 text-xs text-emerald-200">
          Before overwriting anything, LaunchPad saves your current files as a pinned
          <strong> Before restore</strong> snapshot, so this can be undone.
        </p>

        {isRunning && (
          <p className="rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 text-xs text-amber-200">
            {game.name} is running. Close it first — a running game would overwrite the restored
            saves when it exits.
          </p>
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs text-content-400">
            Type <span className="font-mono text-content-200">{confirmWord}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={isRunning || isRestoring}
            aria-label="Restore confirmation"
            className="w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-sm text-content-200 placeholder:text-content-600 focus:border-accent-500 focus:outline-none disabled:opacity-50"
            placeholder={confirmWord}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {restoreError && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {restoreError}
          </div>
        )}
      </div>
    </Modal>
  )
}
