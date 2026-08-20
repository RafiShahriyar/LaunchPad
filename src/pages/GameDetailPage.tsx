import { useEffect, useState } from 'react'
import { ActivityChart } from '@/components/ActivityChart'
import { CoverViewer } from '@/components/CoverViewer'
import { BackupList } from '@/components/BackupList'
import { Button } from '@/components/Modal'
import { PlayButton } from '@/components/PlayButton'
import { SessionList } from '@/components/SessionList'
import {
  coverUrl,
  formatBytes,
  formatDateTime,
  formatPlaytime,
  formatSessionDuration,
  heroUrl
} from '@/lib/format'
import type { Game } from '@shared/types'
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

  /*
   * Declared above the early return below, not beside the markup that uses it.
   * Hooks must run in the same order on every render, and this component
   * returns early when the game is gone — a useState after that point changes
   * the hook count the moment a game is deleted while its detail view is open,
   * which crashes the page instead of showing the library. The e2e suite caught
   * exactly that.
   */
  const [viewingCover, setViewingCover] = useState(false)

  // The game can vanish while this view is open (deleted from another window).
  if (!game) {
    return (
      <div className="p-8">
        <p className="text-sm text-content-400">This game is no longer in your library.</p>
        <Button className="mt-4" onClick={() => dispatch(libraryOpened())}>
          Back to library
        </Button>
      </div>
    )
  }

  const cover = coverUrl(game)
  const backupBytes = backups.reduce((sum, backup) => sum + backup.sizeBytes, 0)

  return (
    <div className="pb-8">
      <HeroHeader
        game={game}
        cover={cover}
        onBack={() => dispatch(libraryOpened())}
        onViewCover={() => setViewingCover(true)}
        actions={
          <>
            <PlayButton gameId={game.id} size="lg" />
            <Button
              variant="glass"
              onClick={() => dispatch(modalOpened({ kind: 'editGame', gameId: game.id }))}
            >
              Edit
            </Button>
            <Button
              variant="glass"
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
              variant="glass"
              onClick={() => dispatch(modalOpened({ kind: 'deleteGame', gameId: game.id }))}
            >
              Delete
            </Button>
          </>
        }
        info={
          <>
            <InfoRow icon={<CalendarIcon />} label="Released" value={formatReleaseDate(game)} />
            <InfoRow icon={<TagIcon />} label="Genres" value={formatGenres(game)} />
            <InfoRow
              icon={<ClockIcon />}
              label="Playtime"
              value={formatPlaytime(game.totalPlaytimeSeconds)}
            />
            <InfoRow
              icon={<PlayIcon />}
              label="Sessions"
              value={stats ? String(stats.sessionCount) : '—'}
            />
            <InfoRow icon={<SaveIcon />} label="Last played" value={formatDateTime(game.lastPlayedAt)} />
            <InfoRow
              icon={<ArchiveIcon />}
              label="Backups"
              value={
                game.saveFolderPath
                  ? backups.length > 0
                    ? `${backups.length} · ${formatBytes(backupBytes)}`
                    : 'None yet'
                  : 'Off for this game'
              }
            />
          </>
        }
      />

      <div className="px-8">
        <p
          className="mt-6 truncate font-mono text-xs text-content-600"
          title={game.executablePath}
        >
          {game.executablePath}
        </p>

        {/*
          * The summary is provider text and can be several paragraphs, so it is
          * clamped rather than allowed to push the stats off screen. It renders
          * only when a provider actually supplied one -- an empty box would
          * imply the lookup failed rather than that it was never made.
          */}
        {game.summary && (
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-content-400">{game.summary}</p>
        )}

        <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          <Stat label="Total playtime" value={formatPlaytime(game.totalPlaytimeSeconds)} />
          <Stat label="Sessions" value={stats ? String(stats.sessionCount) : '—'} />
          <Stat
            label="Longest session"
            value={
              stats && stats.longestSeconds > 0 ? formatSessionDuration(stats.longestSeconds) : '—'
            }
          />
          <Stat
            label="Average session"
            value={
              stats && stats.averageSeconds > 0 ? formatSessionDuration(stats.averageSeconds) : '—'
            }
          />
          <Stat label="Last played" value={formatDateTime(game.lastPlayedAt)} />
        </div>

        <div className="mt-8 rounded-xl border border-surface-700 bg-surface-850 p-5">
          <ActivityChart gameId={gameId} />
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-content-200">Session history</h2>
            <SessionList gameId={gameId} />
          </section>

          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-content-200">Save backups</h2>
              {backups.length > 0 && (
                <span className="text-xs text-content-500">
                  {backups.length} · {formatBytes(backupBytes)}
                </span>
              )}
            </div>

            {game.saveFolderPath ? (
              <>
                <p
                  className="mb-3 truncate font-mono text-[11px] text-content-600"
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
                <p className="text-sm text-content-300">Backups are off for this game</p>
                <p className="mx-auto mt-2 max-w-sm text-xs text-content-500">
                  Set a save folder in Edit and LaunchPad will start protecting your progress.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>

      {viewingCover && cover && (
        <CoverViewer src={cover} title={game.name} onClose={() => setViewingCover(false)} />
      )}
    </div>
  )
}

/**
 * Full-bleed artwork header.
 *
 * The backdrop falls back in three steps, and which one is in use is visible
 * rather than disguised:
 *
 *   1. `heroImagePath` — wide key art from a provider. What this is designed for.
 *   2. the cover, blurred and scaled — a colour wash, not a claim. The unblurred
 *      original sits a few pixels away in the thumbnail, so nothing about it
 *      suggests the game has key art it does not have.
 *   3. a plain gradient, with the absence STATED. A bare gradient reads equally
 *      as "no artwork" and as "the image failed to load", which is the same
 *      ambiguity the grid cards avoid by saying "No cover".
 *
 * Two scrims rather than one. The upward gradient stops the page from ending in
 * a hard horizontal edge, and the rightward one darkens the side the text sits
 * on — a single overlay dark enough for legibility would flatten the whole
 * image, which is the thing worth looking at.
 */
function HeroHeader({
  game,
  cover,
  actions,
  info,
  onBack,
  onViewCover
}: {
  game: Game
  cover: string | null
  actions: React.ReactNode
  info: React.ReactNode
  onBack: () => void
  onViewCover: () => void
}) {
  const hero = heroUrl(game)
  const backdrop = hero ?? cover
  const usingCoverAsBackdrop = !hero && cover !== null

  return (
    <section className="relative isolate h-[clamp(360px,50vh,520px)] w-full overflow-hidden">
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          aria-hidden="true"
          data-testid={hero ? 'hero-art' : 'hero-fallback'}
          className={`absolute inset-0 h-full w-full object-cover object-center ${
            usingCoverAsBackdrop ? 'scale-125 blur-2xl' : ''
          }`}
        />
      ) : (
        <div
          data-testid="hero-none"
          className="absolute inset-0 bg-gradient-to-br from-surface-800 to-surface-950"
        />
      )}

      {/*
        * Four scrims, each doing one job. Separate layers rather than one
        * many-stop gradient because they are tuned independently and a single
        * combined expression stops being editable by anyone but its author.
        */}
      {/* Flat wash — stops bright key art from overpowering the app's chrome. */}
      <div className="absolute inset-0 bg-surface-950/30" />
      {/* Bottom — dissolves the hard horizontal edge into the page below. */}
      <div className="absolute inset-0 bg-gradient-to-t from-surface-900 via-surface-900/55 to-transparent" />
      {/* Left — darkens the side the title and buttons sit on. */}
      <div className="absolute inset-0 bg-gradient-to-r from-surface-900/90 via-surface-900/25 to-transparent" />
      {/* Top — the back control sits up here, over whatever the art happens to be. */}
      <div className="absolute inset-0 bg-gradient-to-b from-surface-950/70 via-transparent to-transparent" />

      <div className="relative flex h-full flex-col justify-between p-8">
        <div className="flex items-start justify-between gap-4">
          <Button variant="glass" className="!px-3 !py-1.5 text-xs" onClick={onBack}>
            ← Library
          </Button>
          {!backdrop && (
            <span className="rounded-lg bg-surface-950/60 px-2.5 py-1 text-[11px] uppercase tracking-wide text-content-500 backdrop-blur-md">
              No artwork
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0 max-w-2xl">
            <div className="flex items-end gap-4">
              <div className="h-32 w-24 shrink-0 overflow-hidden rounded-xl border border-surface-600/70 bg-surface-900 shadow-2xl shadow-black/50">
                {cover ? (
                  // Box art carries a title and small print that is illegible at
                  // 96px, so it stays openable at full size.
                  <button
                    type="button"
                    onClick={onViewCover}
                    aria-label="View cover image full size"
                    className="h-full w-full cursor-zoom-in"
                  >
                    <img src={cover} alt="" className="h-full w-full object-cover" />
                  </button>
                ) : (
                  <div
                    className="grid h-full w-full place-items-center bg-gradient-to-br from-surface-800 to-surface-900 text-center"
                    data-testid="no-cover"
                    title="No cover image"
                  >
                    <span>
                      <span className="block text-2xl font-bold text-surface-600">
                        {game.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="mt-1 block text-[9px] uppercase tracking-wide text-surface-600">
                        No cover
                      </span>
                    </span>
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <h1 className="truncate text-4xl font-bold tracking-tight text-content-100 drop-shadow-lg">
                  {game.name}
                </h1>
                <p className="mt-1.5 text-sm text-content-300 drop-shadow">
                  {formatReleaseDate(game)}
                  {game.genres && game.genres.length > 0 && ` · ${game.genres.join(', ')}`}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div>
          </div>

          {/*
            * The panel is translucent so the artwork stays visible behind it,
            * which is the whole reason the header is worth having. It is opaque
            * enough for small text to survive a bright image underneath.
            */}
          <aside className="w-full max-w-xs shrink-0 rounded-2xl border border-surface-600/60 bg-surface-950/65 p-4 backdrop-blur-md">
            <div className="flex flex-col gap-2.5">{info}</div>
          </aside>
        </div>
      </div>
    </section>
  )
}

function InfoRow({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span className="shrink-0 text-content-500">{icon}</span>
      <span className="shrink-0 text-content-500">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right text-content-200" title={value}>
        {value}
      </span>
    </div>
  )
}

/**
 * "Year unknown" rather than an omitted row.
 *
 * A missing date must not read as though the provider has no record — the same
 * rule the search picker follows.
 */
function formatReleaseDate(game: Game): string {
  if (!game.releaseDate) return 'Year unknown'
  const year = game.releaseDate.slice(0, 4)
  return /^\d{4}$/.test(year) ? year : game.releaseDate
}

/**
 * Distinguishes "never looked up" from "looked up, none listed".
 *
 * `genres` is null in the first case and `[]` in the second, and collapsing them
 * would make the app state that a game has no genres when it has simply never
 * been asked.
 */
function formatGenres(game: Game): string {
  if (game.genres === null) return 'Not looked up'
  if (game.genres.length === 0) return 'None listed'
  return game.genres.join(', ')
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-surface-700 bg-surface-850 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-content-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-content-100" title={value}>
        {value}
      </p>
    </div>
  )
}

// --- Icons -------------------------------------------------------------------
// Inline rather than from a package: six 12px glyphs are not worth a dependency,
// and `currentColor` makes them theme-aware for free.

const ICON = { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true } as const

function CalendarIcon() {
  return (
    <svg {...ICON} fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" />
      <path d="M2 6.5h12M5.5 2v3M10.5 2v3" />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg {...ICON} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7.5 2H2v5.5L9 14.5 14.5 9 7.5 2Z" strokeLinejoin="round" />
      <circle cx="5" cy="5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg {...ICON} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg {...ICON} fill="currentColor">
      <path d="M5 3.5v9l7.5-4.5L5 3.5Z" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg {...ICON} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.2L10 10" strokeLinecap="round" />
      <path d="M2.5 8a5.5 5.5 0 0 1 .6-2.5" strokeLinecap="round" />
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg {...ICON} fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3.5 6.5v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6M6.5 9h3" strokeLinecap="round" />
    </svg>
  )
}
