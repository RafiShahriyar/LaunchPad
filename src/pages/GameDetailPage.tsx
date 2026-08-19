import { useEffect } from 'react'
import { ActivityChart } from '@/components/ActivityChart'
import { BackupList } from '@/components/BackupList'
import { Button } from '@/components/Modal'
import { PlayButton } from '@/components/PlayButton'
import { SessionList } from '@/components/SessionList'
import {
  coverUrl,
  formatBytes,
  formatDateTime,
  formatPlaytime,
  formatSessionDuration
} from '@/lib/format'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { selectGameById } from '@/store/slices/gamesSlice'
import { backupNow, fetchBackups, selectIsBackupBusy } from '@/store/slices/savesSlice'
import { fetchSessionStats, fetchSessionsForGame } from '@/store/slices/sessionsSlice'
import { libraryOpened, modalOpened } from '@/store/slices/uiSlice'

export function GameDetailPage({ gameId }: { gameId: number }) {
  const dispatch = useAppDispatch()
  const game = useAppSelector((state) => selectGameById(state, gameId))
  const stats = useAppSelector((state) => state.sessions.statsByGameId[gameId])
  const backups = useAppSelector((state) => state.saves.byGameId[gameId] ?? [])
  const isBackupBusy = useAppSelector((state) => selectIsBackupBusy(state, gameId))

  /*
   * Session history, stats and backups are fetched per game rather than loaded
   * with the library: holding every game's history in memory would cost far
   * more than the one round trip on open.
   *
   * `stats` is re-fetched whenever the cached entry is cleared, which the
   * session-ended reducer does deliberately so a finished session cannot leave
   * a stale average on screen.
   */
  useEffect(() => {
    void dispatch(fetchSessionsForGame(gameId))
    void dispatch(fetchBackups(gameId))
  }, [dispatch, gameId])

  useEffect(() => {
    if (!stats) void dispatch(fetchSessionStats(gameId))
  }, [dispatch, gameId, stats])

  // The game can vanish while this view is open (deleted from another window).
  if (!game) {
    return (
      <div className="p-8">
        <p className="text-sm text-slate-400">This game is no longer in your library.</p>
        <Button className="mt-4" onClick={() => dispatch(libraryOpened())}>
          Back to library
        </Button>
      </div>
    )
  }

  const cover = coverUrl(game)
  const backupBytes = backups.reduce((sum, backup) => sum + backup.sizeBytes, 0)

  return (
    <div className="p-8">
      <button
        onClick={() => dispatch(libraryOpened())}
        className="mb-6 text-sm text-slate-400 transition-colors hover:text-slate-200"
      >
        ← Library
      </button>

      <header className="flex flex-wrap items-start gap-6">
        <div className="h-44 w-32 shrink-0 overflow-hidden rounded-xl border border-surface-700 bg-surface-900">
          {cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center bg-gradient-to-br from-surface-800 to-surface-900 text-4xl font-bold text-surface-600">
              {game.name.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-slate-100">{game.name}</h1>
          <p className="mt-1 truncate font-mono text-xs text-slate-600" title={game.executablePath}>
            {game.executablePath}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <PlayButton gameId={game.id} size="lg" />
            <Button onClick={() => dispatch(modalOpened({ kind: 'editGame', gameId: game.id }))}>
              Edit
            </Button>
            <Button
              disabled={!game.saveFolderPath || isBackupBusy}
              title={
                game.saveFolderPath
                  ? 'Take a snapshot of the save folder now'
                  : 'Set a save folder in Edit to enable backups'
              }
              onClick={() => void dispatch(backupNow(game.id))}
            >
              {isBackupBusy ? 'Backing up…' : 'Back up now'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => dispatch(modalOpened({ kind: 'deleteGame', gameId: game.id }))}
            >
              Delete
            </Button>
          </div>
        </div>
      </header>

      <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Stat label="Total playtime" value={formatPlaytime(game.totalPlaytimeSeconds)} />
        <Stat label="Sessions" value={stats ? String(stats.sessionCount) : '—'} />
        <Stat
          label="Longest session"
          value={stats && stats.longestSeconds > 0 ? formatSessionDuration(stats.longestSeconds) : '—'}
        />
        <Stat
          label="Average session"
          value={stats && stats.averageSeconds > 0 ? formatSessionDuration(stats.averageSeconds) : '—'}
        />
        <Stat label="Last played" value={formatDateTime(game.lastPlayedAt)} />
      </div>

      <div className="mt-8 rounded-xl border border-surface-700 bg-surface-850 p-5">
        <ActivityChart gameId={gameId} />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Session history</h2>
          <SessionList gameId={gameId} />
        </section>

        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Save backups</h2>
            {backups.length > 0 && (
              <span className="text-xs text-slate-500">
                {backups.length} · {formatBytes(backupBytes)}
              </span>
            )}
          </div>

          {game.saveFolderPath ? (
            <>
              <p
                className="mb-3 truncate font-mono text-[11px] text-slate-600"
                title={game.saveFolderPath}
              >
                {game.saveFolderPath}
              </p>
              <BackupList
                gameId={gameId}
                emptyHint="LaunchPad takes one automatically before each launch and after each session, or you can take one now."
              />
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-surface-600 p-8 text-center">
              <p className="text-sm text-slate-300">Backups are off for this game</p>
              <p className="mx-auto mt-2 max-w-sm text-xs text-slate-500">
                Set a save folder in Edit and LaunchPad will start protecting your progress.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-surface-700 bg-surface-850 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-slate-100" title={value}>
        {value}
      </p>
    </div>
  )
}
