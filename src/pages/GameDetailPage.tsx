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
      />

      <div className="px-8">
        <p
          className="mt-6 truncate font-mono text-xs text-content-600"
          title={game.executablePath}
        >
          {game.executablePath}
        </p>

        {/*
          * Renders only when a provider actually supplied a summary -- an empty
          * box would imply the lookup failed rather than that it was never made.
          */}
        {game.summary && <Synopsis text={game.summary} />}

        <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          <Stat
            icon={<ClockIcon />}
            label="Total playtime"
            value={formatPlaytime(game.totalPlaytimeSeconds)}
          />
          <Stat
            icon={<PlayIcon />}
            label="Sessions"
            value={stats ? String(stats.sessionCount) : '—'}
          />
          <Stat
            icon={<ClockIcon />}
            label="Longest session"
            value={
              stats && stats.longestSeconds > 0 ? formatSessionDuration(stats.longestSeconds) : '—'
            }
          />
          <Stat
            icon={<ClockIcon />}
            label="Average session"
            value={
              stats && stats.averageSeconds > 0 ? formatSessionDuration(stats.averageSeconds) : '—'
            }
          />
          <Stat
            icon={<CalendarIcon />}
            label="Last played"
            value={formatDateTime(game.lastPlayedAt)}
          />
          {/* Carried over from the header panel this replaced, so nothing was lost. */}
          <Stat
            icon={<ArchiveIcon />}
            label="Backups"
            value={
              game.saveFolderPath
                ? backups.length > 0
                  ? `${backups.length} · ${formatBytes(backupBytes)}`
                  : 'None yet'
                : // Short enough to fit the tile. "Off for this game" truncated to
                  // "Off for this g…", and a clipped value is worse than a terse
                  // one when the label above it already says Backups.
                  'Off'
            }
          />
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
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-content-200">
                <span className="text-content-500">
                  <SaveIcon />
                </span>
                Save backups
              </h2>
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
 *   2. the cover, centre-cropped to the wide frame. Deliberately NOT blurred:
 *      the blur it used to carry hid the only artwork the game had, and the
 *      unblurred original sits a few pixels away in the thumbnail anyway. The
 *      state stays distinguishable through `data-testid`, which is what the
 *      suite guards.
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
  onBack,
  onViewCover
}: {
  game: Game
  cover: string | null
  actions: React.ReactNode
  onBack: () => void
  onViewCover: () => void
}) {
  const hero = heroUrl(game)
  const backdrop = hero ?? cover

  return (
    <section className="relative isolate h-[clamp(420px,58vh,600px)] w-full overflow-hidden">
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          aria-hidden="true"
          data-testid={hero ? 'hero-art' : 'hero-fallback'}
          /*
           * Shown unblurred, including when it is the cover standing in for
           * missing wide art. The blur was there to keep a portrait cover from
           * passing as key art, but it cost the artwork itself -- a wash of
           * colour is not what anyone opened the page to look at. `object-cover`
           * centre-crops instead, which reads as a zoom rather than a claim, and
           * the fallback is still distinguishable in the DOM for the tests that
           * guard it.
           */
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
      ) : (
        <div
          data-testid="hero-none"
          className="absolute inset-0 bg-gradient-to-br from-surface-800 to-surface-950"
        />
      )}

      {/*
        * Scrims, each doing one job. Separate layers rather than one many-stop
        * gradient because they are tuned independently and a single combined
        * expression stops being editable by anyone but its author.
        *
        * Retuned when the backdrop stopped being blurred. The previous values
        * were set against a blur, where crushing the image cost nothing because
        * there was nothing to see; over real artwork they flattened it to
        * near-black, which defeats having a key-art header at all. Each layer is
        * now the lightest value that still keeps the text over it legible.
        */}
      {/* Bottom — dissolves the hard horizontal edge into the page below. */}
      <div className="absolute inset-0 bg-gradient-to-t from-surface-900 via-surface-900/40 to-transparent" />
      {/* Left — darkens the side the title and buttons sit on, and only that side. */}
      <div className="absolute inset-0 bg-gradient-to-r from-surface-900/85 via-surface-900/20 to-transparent" />
      {/* Top — the back control sits up here, over whatever the art happens to be. */}
      <div className="absolute inset-0 bg-gradient-to-b from-surface-950/55 via-transparent to-transparent" />

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
              <div className="h-40 w-28 shrink-0 overflow-hidden rounded-xl border border-surface-600/70 bg-surface-900 shadow-2xl shadow-black/50">
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
                <p className="mt-1.5 flex items-center gap-1.5 text-sm text-content-300 drop-shadow">
                  <CalendarIcon />
                  {formatReleaseDate(game)}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div>

            {/*
              * Genres sit directly under the controls as pills.
              *
              * They were previously one row of a six-row translucent panel over
              * on the right, which duplicated four stats that the grid below the
              * header already showed, and covered the artwork the header exists
              * to display. Pills read at a glance, cost no vertical space and
              * leave the art visible.
              */}
            <div className="mt-4">
              <GenreList game={game} />
            </div>
          </div>
        </div>
      </div>
    </section>
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

function Stat({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl border border-surface-700 bg-surface-850 px-4 py-3">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-content-500">
        <span className="shrink-0">{icon}</span>
        {label}
      </p>
      <p className="mt-1 truncate text-lg font-semibold text-content-100" title={value}>
        {value}
      </p>
    </div>
  )
}

/**
 * Genres as pills, with the null/empty distinction intact.
 *
 * `genres` is null when the game has never been looked up and `[]` when a
 * provider looked and listed none. Those are different claims and the wording
 * differs, which the detail-view suite asserts -- pills alone would collapse
 * both into "no pills".
 */
function GenreList({ game }: { game: Game }) {
  if (game.genres === null || game.genres.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-content-500 drop-shadow">
        <TagIcon />
        {formatGenres(game)}
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-content-400 drop-shadow">
        <TagIcon />
      </span>
      {game.genres.map((genre) => (
        <span
          key={genre}
          className="rounded-full border border-surface-500/60 bg-surface-950/60 px-2.5 py-1 text-xs font-medium text-content-200 backdrop-blur-md"
        >
          {genre}
        </span>
      ))}
    </div>
  )
}

/**
 * Length beyond which the summary is clamped and offered a "Read more".
 *
 * A character count rather than measuring the rendered element: measuring means
 * a layout read on every render plus a resize listener to stay correct, for a
 * decision that only needs to be roughly right. Three lines of this column is
 * about this many characters.
 */
const SYNOPSIS_CLAMP_CHARS = 260

/**
 * Provider summaries run to several paragraphs, which pushed the stats and the
 * activity chart off the first screen. Clamped to three lines with an explicit
 * toggle -- and the toggle appears only when there is actually more to show, so
 * it never invites a click that changes nothing.
 */
function Synopsis({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > SYNOPSIS_CLAMP_CHARS

  return (
    <div className="mt-5 max-w-3xl">
      <h2 className="mb-2 text-sm font-semibold text-content-200">About</h2>
      <p
        data-testid="synopsis"
        className={`text-sm leading-relaxed text-content-400 ${
          isLong && !expanded ? 'line-clamp-3' : ''
        }`}
      >
        {text}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          data-testid="synopsis-toggle"
          className="mt-1.5 text-xs font-medium text-accent-400 hover:text-accent-300"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
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
