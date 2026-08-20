import type { BackupTrigger, SaveBackup } from '@shared/types'
import { formatBytes, formatDateTime } from '@/lib/format'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { deleteBackup, selectBackupsForGame, setBackupPinned } from '@/store/slices/savesSlice'
import { modalOpened } from '@/store/slices/uiSlice'
import { Button } from './Modal'

/**
 * Shared snapshot list, used by both the detail page and the quick-access modal.
 *
 * Extracted rather than duplicated so the restore affordance — the riskiest
 * button in the app — has exactly one implementation to reason about.
 */

export const TRIGGER_LABELS: Record<BackupTrigger, { label: string; hint: string }> = {
  pre_launch: { label: 'Before launch', hint: 'Taken automatically before you played' },
  post_session: { label: 'After session', hint: 'Taken automatically when you stopped playing' },
  manual: { label: 'Manual', hint: 'You asked for this one' },
  pre_restore: { label: 'Before restore', hint: 'Safety copy taken before a restore — your undo' }
}

export function BackupList({ gameId, emptyHint }: { gameId: number; emptyHint: string }) {
  const backups = useAppSelector((state) => selectBackupsForGame(state, gameId))

  if (backups.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-600 p-8 text-center">
        <p className="text-sm text-content-300">No backups yet</p>
        <p className="mx-auto mt-2 max-w-sm text-xs text-content-500">{emptyHint}</p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {backups.map((backup) => (
        <BackupRow key={backup.id} backup={backup} gameId={gameId} />
      ))}
    </ul>
  )
}

function BackupRow({ backup, gameId }: { backup: SaveBackup; gameId: number }) {
  const dispatch = useAppDispatch()
  const trigger = TRIGGER_LABELS[backup.trigger]

  return (
    <li className="flex items-center gap-3 rounded-lg border border-surface-700 bg-surface-900 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-content-200">{formatDateTime(backup.createdAt)}</span>
          <span
            className="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-content-400"
            title={trigger.hint}
          >
            {trigger.label}
          </span>
          {backup.isPinned && (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400"
              title="Pinned snapshots are never removed by rotation"
            >
              Pinned
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-content-500">
          {backup.fileCount} file{backup.fileCount === 1 ? '' : 's'} ·{' '}
          {formatBytes(backup.sizeBytes)}
        </p>
      </div>

      <button
        onClick={() =>
          void dispatch(setBackupPinned({ backupId: backup.id, isPinned: !backup.isPinned }))
        }
        aria-label={`${backup.isPinned ? 'Unpin' : 'Pin'} backup ${backup.id}`}
        title={
          backup.isPinned
            ? 'Unpin — this snapshot can then be rotated out'
            : 'Pin — protect this snapshot from rotation'
        }
        className={`rounded-md px-2 py-1 text-sm transition-colors ${
          backup.isPinned
            ? 'text-amber-400 hover:bg-surface-700'
            : 'text-content-500 hover:bg-surface-700 hover:text-content-300'
        }`}
      >
        {backup.isPinned ? '★' : '☆'}
      </button>

      <Button
        onClick={() => dispatch(modalOpened({ kind: 'restoreBackup', backupId: backup.id }))}
        className="shrink-0"
      >
        Restore
      </Button>

      <button
        onClick={() => void dispatch(deleteBackup({ backupId: backup.id, gameId }))}
        aria-label={`Delete backup ${backup.id}`}
        title="Delete this snapshot"
        className="rounded-md px-2 py-1 text-sm text-content-500 transition-colors hover:bg-red-600 hover:text-white"
      >
        🗑
      </button>
    </li>
  )
}
