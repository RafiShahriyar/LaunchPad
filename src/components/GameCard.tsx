import type { Game } from '@shared/types'
import { coverUrl, formatPlaytime, formatRelativeDate } from '@/lib/format'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { gameOpened, modalOpened } from '@/store/slices/uiSlice'
import { selectIsGameRunning } from '@/store/slices/sessionsSlice'
import { selectIsBackupBusy } from '@/store/slices/savesSlice'
import { PlayButton } from './PlayButton'

/**
 * Cover art is user-supplied and arbitrarily proportioned. `object-cover` on a
 * fixed 3:4 box keeps the grid aligned regardless of what the user picks;
 * cropping is preferable to a ragged grid of mixed aspect ratios.
 */
export function GameCard({ game }: { game: Game }) {
  const dispatch = useAppDispatch()
  const cover = coverUrl(game)
  const isRunning = useAppSelector((state) => selectIsGameRunning(state, game.id))

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border bg-surface-850 transition-colors ${
        isRunning ? 'border-emerald-600/60' : 'border-surface-700 hover:border-surface-600'
      }`}
    >
      {/*
        A real <button> wrapping the cover, rather than an onClick on the card
        div: the card contains other buttons, and nesting interactive elements
        inside a clickable div gives keyboard users no way to reach the card
        itself. This keeps it tabbable and announced correctly, while Play and
        the hover actions stop propagation so they never trigger navigation.
      */}
      <button
        onClick={() => dispatch(gameOpened(game.id))}
        aria-label={`Open ${game.name}`}
        className="block w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
      <div className="aspect-[3/4] w-full overflow-hidden bg-surface-900">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center bg-gradient-to-br from-surface-800 to-surface-900">
            <span className="px-4 text-center text-3xl font-bold text-surface-600">
              {game.name.slice(0, 2).toUpperCase()}
            </span>
          </div>
        )}
      </div>

      <div className="px-3 pt-3">
        <h3 className="truncate text-sm font-medium text-slate-100" title={game.name}>
          {game.name}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          {formatPlaytime(game.totalPlaytimeSeconds)}
          {game.lastPlayedAt && ` · ${formatRelativeDate(game.lastPlayedAt)}`}
        </p>
      </div>
      </button>

      <div className="px-3 pb-3 pt-2.5">
        <PlayButton gameId={game.id} />
      </div>

      <CardActions
        game={game}
        onEdit={() => dispatch(modalOpened({ kind: 'editGame', gameId: game.id }))}
        onDelete={() => dispatch(modalOpened({ kind: 'deleteGame', gameId: game.id }))}
      />
    </div>
  )
}

/**
 * Actions appear on hover to keep the grid clean. They are also focusable, so
 * keyboard users reach them by tabbing even though they are visually hidden --
 * `opacity-0` still leaves them in the tab order, and focus-within reveals them.
 */
function CardActions({
  game,
  onEdit,
  onDelete
}: {
  game: Game
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <BackupButton game={game} />
      <IconButton label={`Edit game ${game.id}`} onClick={onEdit}>
        ✎
      </IconButton>
      <IconButton label={`Delete game ${game.id}`} onClick={onDelete} danger>
        🗑
      </IconButton>
    </div>
  )
}

/**
 * Opens the backup history, where "Back up now" and Restore live.
 *
 * Opening a list rather than backing up directly: with restore now available,
 * the snapshot history is the thing users need to reach, and a one-click
 * destructive-adjacent action next to Delete would be easy to hit by accident.
 *
 * Disabled with an explanatory tooltip when no save folder is configured,
 * rather than hidden: a missing button would read as "this game cannot be
 * backed up" instead of "you have not told me where the saves are".
 */
function BackupButton({ game }: { game: Game }) {
  const dispatch = useAppDispatch()
  const isBusy = useAppSelector((state) => selectIsBackupBusy(state, game.id))
  const hasSaveFolder = Boolean(game.saveFolderPath)

  return (
    <IconButton
      label={`Save backups for ${game.name}`}
      title={
        hasSaveFolder ? 'Save backups and restore' : 'Set a save folder in Edit to enable backups'
      }
      disabled={!hasSaveFolder}
      onClick={() => dispatch(modalOpened({ kind: 'backupHistory', gameId: game.id }))}
    >
      {isBusy ? '…' : '⭳'}
    </IconButton>
  )
}

function IconButton({
  label,
  title,
  onClick,
  danger,
  disabled,
  children
}: {
  label: string
  title?: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`grid h-7 w-7 place-items-center rounded-md bg-surface-900/90 text-xs backdrop-blur transition-colors disabled:cursor-not-allowed disabled:text-slate-600 ${
        danger ? 'text-slate-300 hover:bg-red-600 hover:text-white' : 'text-slate-300 hover:bg-surface-700'
      }`}
    >
      {children}
    </button>
  )
}

/** Row variant used by the list view. Same data, denser presentation. */
export function GameRow({ game }: { game: Game }) {
  const dispatch = useAppDispatch()
  const cover = coverUrl(game)

  return (
    <div className="group flex items-center gap-4 rounded-lg border border-surface-700 bg-surface-850 px-4 py-2.5 transition-colors hover:border-surface-600">
      <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-surface-900">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center text-[10px] font-bold text-surface-600">
            {game.name.slice(0, 2).toUpperCase()}
          </div>
        )}
      </div>

      <button
        onClick={() => dispatch(gameOpened(game.id))}
        aria-label={`Open ${game.name}`}
        className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        <h3 className="truncate text-sm font-medium text-slate-100">{game.name}</h3>
        <p className="truncate font-mono text-[11px] text-slate-600">{game.executablePath}</p>
      </button>

      <div className="w-28 shrink-0 text-right text-xs text-slate-400">
        {formatPlaytime(game.totalPlaytimeSeconds)}
      </div>
      <div className="w-24 shrink-0 text-right text-xs text-slate-500">
        {formatRelativeDate(game.lastPlayedAt)}
      </div>
      <div className="w-24 shrink-0">
        <PlayButton gameId={game.id} />
      </div>

      <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <BackupButton game={game} />
        <IconButton
          label={`Edit ${game.name}`}
          onClick={() => dispatch(modalOpened({ kind: 'editGame', gameId: game.id }))}
        >
          ✎
        </IconButton>
        <IconButton
          label={`Delete ${game.name}`}
          onClick={() => dispatch(modalOpened({ kind: 'deleteGame', gameId: game.id }))}
          danger
        >
          🗑
        </IconButton>
      </div>
    </div>
  )
}
