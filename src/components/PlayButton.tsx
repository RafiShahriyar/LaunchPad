import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { launchGame, selectIsGameRunning } from '@/store/slices/sessionsSlice'

/**
 * Play / Playing control.
 *
 * The running state comes from sessionsSlice, which is fed by main's push
 * events -- so the button flips back to "Play" the moment the game process
 * exits, with no polling and no user action.
 */
export function PlayButton({
  gameId,
  size = 'sm'
}: {
  gameId: number
  size?: 'sm' | 'lg'
}) {
  const dispatch = useAppDispatch()
  const isRunning = useAppSelector((state) => selectIsGameRunning(state, gameId))
  const launchingGameId = useAppSelector((state) => state.sessions.launchingGameId)
  const isLaunching = launchingGameId === gameId

  const classes =
    size === 'lg'
      ? 'px-5 py-2.5 text-sm rounded-xl'
      : 'w-full px-3 py-1.5 text-xs rounded-lg'

  if (isRunning) {
    return (
      <div
        className={`flex items-center justify-center gap-2 bg-emerald-600/15 font-medium text-emerald-400 ${classes}`}
        title="LaunchPad is tracking this session"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        Playing
      </div>
    )
  }

  return (
    <button
      onClick={(event) => {
        // The card itself is clickable in later steps; do not let Play bubble.
        event.stopPropagation()
        void dispatch(launchGame(gameId))
      }}
      disabled={isLaunching}
      className={`bg-accent-600 font-medium text-white transition-colors hover:bg-accent-500 disabled:bg-accent-600/40 ${classes}`}
    >
      {isLaunching ? 'Starting…' : '▶ Play'}
    </button>
  )
}
