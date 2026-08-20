import { useMemo } from 'react'
import type { PlaySession } from '@shared/types'
import { formatSessionDuration, toLocalDayKey } from '@/lib/format'
import { useAppSelector } from '@/store/hooks'

const DAYS = 30

/**
 * Playtime per day over the last 30 days.
 *
 * Built from the session rows already in the store rather than a new query: the
 * detail view has just fetched them, and a dedicated SQL aggregate would be a
 * second round trip for data already in memory. If session history ever grows
 * beyond the fetch limit this would under-report, which is why the caption says
 * "last 30 days" rather than implying completeness.
 *
 * Rendered with divs instead of a chart library — one bar per day, no axes, no
 * interaction beyond a tooltip. Pulling in a charting dependency for this would
 * cost more than it returns.
 */
export function ActivityChart({ gameId }: { gameId: number }) {
  const sessions = useAppSelector((state) => state.sessions.byGameId[gameId] ?? [])

  const days = useMemo(() => buildDays(sessions), [sessions])
  const peak = Math.max(...days.map((day) => day.seconds), 1)
  const total = days.reduce((sum, day) => sum + day.seconds, 0)

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-content-200">Last 30 days</h2>
        <span className="text-xs text-content-500">
          {total > 0 ? formatSessionDuration(total) : 'No activity'}
        </span>
      </div>

      <div className="flex h-24 items-end gap-1" role="img" aria-label="Playtime over the last 30 days">
        {days.map((day) => (
          <div
            key={day.key}
            className="group relative flex-1"
            title={`${day.label}: ${day.seconds > 0 ? formatSessionDuration(day.seconds) : 'no play'}`}
          >
            <div
              className={`w-full rounded-sm transition-colors ${
                day.seconds > 0 ? 'bg-accent-600 group-hover:bg-accent-400' : 'bg-surface-800'
              }`}
              // Floor of 2px so days with no play still read as a baseline
              // rather than vanishing, which would make the axis ambiguous.
              style={{
                height:
                  day.seconds > 0 ? `${Math.max(8, (day.seconds / peak) * 96)}px` : '2px'
              }}
            />
          </div>
        ))}
      </div>

      <div className="mt-1.5 flex justify-between text-[10px] text-content-600">
        <span>{days[0]?.label}</span>
        <span>Today</span>
      </div>
    </section>
  )
}

interface DayBucket {
  key: string
  label: string
  seconds: number
}

function buildDays(sessions: PlaySession[]): DayBucket[] {
  const totals = new Map<string, number>()
  for (const session of sessions) {
    if (!session.durationSeconds) continue
    const key = toLocalDayKey(session.startedAt)
    totals.set(key, (totals.get(key) ?? 0) + session.durationSeconds)
  }

  const buckets: DayBucket[] = []
  const today = new Date()

  for (let offset = DAYS - 1; offset >= 0; offset--) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const key = toLocalDayKey(date.toISOString())
    buckets.push({
      key,
      label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      seconds: totals.get(key) ?? 0
    })
  }

  return buckets
}
