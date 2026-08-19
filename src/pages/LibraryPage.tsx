import type { LibrarySortKey } from '@shared/types'
import { GameCard, GameRow } from '@/components/GameCard'
import { Button } from '@/components/Modal'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { selectGameCount, selectVisibleGames } from '@/store/slices/gamesSlice'
import {
  modalOpened,
  searchQueryChanged,
  sortChanged,
  viewModeChanged
} from '@/store/slices/uiSlice'

const SORT_OPTIONS: { key: LibrarySortKey; label: string }[] = [
  { key: 'lastPlayed', label: 'Last played' },
  { key: 'name', label: 'Name' },
  { key: 'playtime', label: 'Playtime' },
  { key: 'dateAdded', label: 'Date added' }
]

export function LibraryPage() {
  const dispatch = useAppDispatch()
  const { viewMode, sortKey, sortDirection, searchQuery } = useAppSelector((state) => state.ui)
  const { status, error } = useAppSelector((state) => state.games)

  // Sorting and filtering happen in a memoised selector, not here.
  const games = useAppSelector(selectVisibleGames)
  const totalGames = useAppSelector(selectGameCount)

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold text-slate-100">Library</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {totalGames === 0
              ? 'No games yet'
              : `${totalGames} game${totalGames === 1 ? '' : 's'}${
                  games.length !== totalGames ? ` · ${games.length} matching` : ''
                }`}
          </p>
        </div>

        <input
          value={searchQuery}
          onChange={(event) => dispatch(searchQueryChanged(event.target.value))}
          placeholder="Search…"
          className="w-48 rounded-lg border border-surface-600 bg-surface-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-accent-500 focus:outline-none"
        />

        <select
          value={sortKey}
          onChange={(event) =>
            dispatch(
              sortChanged({ key: event.target.value as LibrarySortKey, direction: sortDirection })
            )
          }
          className="rounded-lg border border-surface-600 bg-surface-900 px-3 py-1.5 text-sm text-slate-200 focus:border-accent-500 focus:outline-none"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          onClick={() =>
            dispatch(
              sortChanged({ key: sortKey, direction: sortDirection === 'asc' ? 'desc' : 'asc' })
            )
          }
          aria-label={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
          className="rounded-lg border border-surface-600 bg-surface-900 px-2.5 py-1.5 text-sm text-slate-300 hover:bg-surface-800"
        >
          {sortDirection === 'asc' ? '↑' : '↓'}
        </button>

        <div className="flex overflow-hidden rounded-lg border border-surface-600">
          {(['grid', 'list'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => dispatch(viewModeChanged(mode))}
              aria-label={`${mode} view`}
              className={`px-2.5 py-1.5 text-sm transition-colors ${
                viewMode === mode
                  ? 'bg-surface-700 text-slate-100'
                  : 'bg-surface-900 text-slate-500 hover:text-slate-300'
              }`}
            >
              {mode === 'grid' ? '▦' : '☰'}
            </button>
          ))}
        </div>

        <Button variant="primary" onClick={() => dispatch(modalOpened({ kind: 'addGame' }))}>
          + Add game
        </Button>
      </header>

      {status === 'loading' && <p className="text-sm text-slate-500">Loading library…</p>}

      {status === 'failed' && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          Could not load the library: {error}
        </div>
      )}

      {status === 'succeeded' && totalGames === 0 && <EmptyLibrary />}

      {status === 'succeeded' && totalGames > 0 && games.length === 0 && (
        <p className="text-sm text-slate-500">No games match “{searchQuery}”.</p>
      )}

      {games.length > 0 &&
        (viewMode === 'grid' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
            {games.map((game) => (
              <GameCard key={game.id} game={game} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {games.map((game) => (
              <GameRow key={game.id} game={game} />
            ))}
          </div>
        ))}
    </div>
  )
}

function EmptyLibrary() {
  const dispatch = useAppDispatch()
  return (
    <div className="rounded-xl border border-dashed border-surface-600 bg-surface-850/50 p-12 text-center">
      <p className="text-lg text-slate-300">Your library is empty</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        Add a game by pointing LaunchPad at its executable. Set a save folder too and LaunchPad
        will back it up automatically every time you play.
      </p>
      <Button
        variant="primary"
        className="mt-6"
        onClick={() => dispatch(modalOpened({ kind: 'addGame' }))}
      >
        + Add your first game
      </Button>
    </div>
  )
}
