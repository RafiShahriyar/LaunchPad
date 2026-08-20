import { useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { lastOutcomeCleared } from '@/store/slices/savesSlice'
import { selectGameById } from '@/store/slices/gamesSlice'

/**
 * Transient status line for backups.
 *
 * Backups mostly happen without the user asking — before every launch and after
 * every session — so this reports quietly rather than interrupting. It also
 * reports **skips**, not just successes: "saves have not changed since the last
 * backup" is the difference between the feature working correctly and the
 * button appearing broken.
 *
 * Successes and skips auto-dismiss; errors stay until dismissed, because a
 * failed backup is something the user may need to act on.
 */
export function BackupStatusBar() {
  const dispatch = useAppDispatch()
  const outcome = useAppSelector((state) => state.saves.lastOutcome)
  const game = useAppSelector((state) =>
    outcome ? selectGameById(state, outcome.gameId) : undefined
  )

  useEffect(() => {
    if (!outcome || outcome.tone === 'error') return
    const timer = setTimeout(() => dispatch(lastOutcomeCleared()), 6000)
    return () => clearTimeout(timer)
  }, [outcome, dispatch])

  if (!outcome) return null

  const tones = {
    success: 'border-emerald-900 bg-emerald-950/60 text-emerald-200',
    info: 'border-surface-600 bg-surface-800 text-content-300',
    error: 'border-red-900 bg-red-950/60 text-red-200'
  }

  return (
    <div
      role="status"
      className={`flex items-start gap-3 border-b px-8 py-2.5 text-sm ${tones[outcome.tone]}`}
    >
      <span className="flex-1">
        {game && <span className="font-medium">{game.name}: </span>}
        {outcome.message}
      </span>
      <button
        onClick={() => dispatch(lastOutcomeCleared())}
        aria-label="Dismiss backup status"
        className="shrink-0 rounded px-2 opacity-70 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  )
}
