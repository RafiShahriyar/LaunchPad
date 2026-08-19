import type { PlaySession, SessionExitReason } from '@shared/types'
import { formatDateTime, formatSessionDuration } from '@/lib/format'
import { useAppSelector } from '@/store/hooks'

/**
 * How each exit reason is presented.
 *
 * `crashed` is shown as "Ended unexpectedly" rather than "Crashed", because the
 * underlying signal is a non-zero exit code and plenty of games return one on a
 * perfectly normal quit. Naming it "Crashed" would state something the app
 * cannot actually know (see docs/FEATURES.md, step 4).
 */
const EXIT_REASONS: Record<SessionExitReason, { label: string; className: string; hint: string }> =
  {
    exited: { label: 'Finished', className: 'text-slate-500', hint: 'The game closed normally' },
    crashed: {
      label: 'Ended unexpectedly',
      className: 'text-amber-500',
      hint: 'The game exited with a non-zero code. Some games do this even on a normal quit.'
    },
    app_closed: {
      label: 'Interrupted',
      className: 'text-slate-500',
      hint: 'LaunchPad closed while this session was running, so the length may be incomplete'
    },
    unknown: { label: 'Unknown', className: 'text-slate-600', hint: 'The outcome was not recorded' }
  }

export function SessionList({ gameId, limit }: { gameId: number; limit?: number }) {
  const sessions = useAppSelector((state) => state.sessions.byGameId[gameId] ?? [])
  const activeSession = useAppSelector((state) => state.sessions.activeByGameId[gameId])

  // The in-progress session has no row in history yet, so it is prepended for
  // display. Without this, launching a game makes the detail view look unchanged.
  const rows: PlaySession[] = activeSession
    ? [activeSession, ...sessions.filter((s) => s.id !== activeSession.id)]
    : sessions

  const visible = limit ? rows.slice(0, limit) : rows

  if (visible.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-600 p-8 text-center">
        <p className="text-sm text-slate-300">No sessions yet</p>
        <p className="mx-auto mt-2 max-w-sm text-xs text-slate-500">
          Press Play and LaunchPad will time the session automatically.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {visible.map((session) => {
        const isActive = session.endedAt === null
        const reason = session.exitReason ? EXIT_REASONS[session.exitReason] : null

        return (
          <li
            key={session.id}
            className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 ${
              isActive
                ? 'border-emerald-600/50 bg-emerald-950/20'
                : 'border-surface-700 bg-surface-900'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-200">{formatDateTime(session.startedAt)}</p>
              {reason && !isActive && (
                <p className={`mt-0.5 text-xs ${reason.className}`} title={reason.hint}>
                  {reason.label}
                </p>
              )}
            </div>

            <span
              className={`shrink-0 text-sm tabular-nums ${
                isActive ? 'text-emerald-400' : 'text-slate-300'
              }`}
            >
              {isActive ? 'Playing now' : formatSessionDuration(session.durationSeconds)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
