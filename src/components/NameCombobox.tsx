import { useEffect, useId, useRef, useState } from 'react'
import type { MetadataSearchResult } from '@shared/ipc'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { fetchMetadataStatus, searchMetadata, searchReset } from '@/store/slices/metadataSlice'

interface NameComboboxProps {
  value: string
  onChange: (value: string) => void
  /** Fired when the user picks a provider entry, not on every keystroke. */
  onSelect: (result: MetadataSearchResult) => void
  inputClass: string
}

/**
 * Debounce before searching.
 *
 * Not cosmetic: RAWG's free tier is a monthly request quota, so a request per
 * keystroke would spend it on prefixes nobody wanted results for. 350 ms is
 * long enough to swallow a burst of typing and short enough that a pause feels
 * like it triggered the search.
 */
const DEBOUNCE_MS = 350

/**
 * Two characters is the floor.
 *
 * A single letter matches thousands of games and ranks them by popularity, so
 * the list is noise while costing a full request.
 */
const MIN_QUERY_LENGTH = 2

/**
 * The game name field, with provider suggestions inline.
 *
 * This replaced a separate "Find game info…" panel. The panel made looking a
 * game up a deliberate second step, when the user is already typing the name
 * into a box — the search belongs on that box.
 *
 * Every thumbnail is a `data:` URI produced in main. The renderer's CSP still
 * sets `connect-src 'none'`; this component opens no sockets.
 */
export function NameCombobox({ value, onChange, onSelect, inputClass }: NameComboboxProps) {
  const dispatch = useAppDispatch()
  const { status, results, searchStatus, searchError, searched, query, resultSource } =
    useAppSelector((state) => state.metadata)

  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  /** Suppresses the search that the programmatic name change would trigger. */
  const justSelected = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const configured = status?.activeSource != null
  const sourceName = status?.providers.find((entry) => entry.id === resultSource)?.name ?? null

  useEffect(() => {
    dispatch(searchReset())
    void dispatch(fetchMetadataStatus())
  }, [dispatch])

  // Debounced search on the typed value.
  useEffect(() => {
    if (!configured) return
    if (justSelected.current) {
      // Choosing an entry rewrites the field; searching for what we just filled
      // in would reopen the list over the answer the user already picked.
      justSelected.current = false
      return
    }
    const term = value.trim()
    if (term.length < MIN_QUERY_LENGTH) return

    const timer = setTimeout(() => {
      void dispatch(searchMetadata(term))
      setOpen(true)
      setHighlight(-1)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value, configured, dispatch])

  // A click anywhere else dismisses the list.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const choose = (result: MetadataSearchResult) => {
    justSelected.current = true
    onSelect(result)
    setOpen(false)
    setHighlight(-1)
  }

  const listOpen = open && (results.length > 0 || searchStatus === 'loading' || Boolean(searchError) || searched)

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && listOpen) {
      /*
       * Closes the list only. Modal listens for Escape on `document` to dismiss
       * the whole form, so without stopping propagation one keypress would throw
       * away everything the user had typed.
       */
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (!listOpen || results.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((index) => (index <= 0 ? results.length - 1 : index - 1))
    } else if (event.key === 'Enter' && highlight >= 0) {
      event.preventDefault()
      const picked = results[highlight]
      if (picked) choose(picked)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (results.length > 0) setOpen(true)
        }}
        placeholder="Hollow Knight"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? `${listboxId}-${highlight}` : undefined}
        autoComplete="off"
        spellCheck={false}
      />

      {!configured && (
        <p className="mt-1.5 text-xs text-slate-500">
          Add a provider in Settings → Game metadata to search for cover art and genres as you
          type.
        </p>
      )}

      {configured && searchStatus === 'loading' && (
        <p className="mt-1.5 text-xs text-slate-500">Searching…</p>
      )}

      {listOpen && (
        <div
          className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-600 bg-surface-850 shadow-2xl"
          data-testid="name-suggestions"
        >
          {searchError && (
            <p className="px-3 py-2 text-sm text-red-300">{searchError}</p>
          )}

          {!searchError && searched && results.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-400">
              No matches for “{query}”. Keep typing, or just use the name as written.
            </p>
          )}

          {results.length > 0 && (
            <>
              <ul id={listboxId} role="listbox" className="max-h-72 overflow-y-auto">
                {results.map((result, index) => (
                  <li
                    key={result.id}
                    id={`${listboxId}-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                  >
                    <button
                      type="button"
                      // mousedown, not click: the input's blur would otherwise
                      // close the list before the click landed.
                      onMouseDown={(event) => {
                        event.preventDefault()
                        choose(result)
                      }}
                      onMouseEnter={() => setHighlight(index)}
                      className={`flex w-full items-start gap-3 p-2 text-left ${
                        index === highlight ? 'bg-surface-700' : 'hover:bg-surface-800'
                      }`}
                    >
                      <span className="h-14 w-10 shrink-0 overflow-hidden rounded border border-surface-600 bg-surface-900">
                        {result.thumbnailDataUri ? (
                          <img
                            src={result.thumbnailDataUri}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          // Says so rather than showing a blank box, so an entry
                          // with no art is distinguishable from one still loading.
                          <span className="grid h-full w-full place-items-center text-[9px] leading-tight text-slate-600">
                            No art
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-200">{result.name}</span>
                        <span className="block text-xs text-slate-500">
                          {/*
                            "Year unknown" rather than omitting it, so a row never
                            implies the provider has no date on record.
                          */}
                          {result.releaseDate ? result.releaseDate.slice(0, 4) : 'Year unknown'}
                          {result.genres.length > 0 && ` · ${result.genres.join(', ')}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {sourceName && (
                <p className="border-t border-surface-700 px-3 py-1.5 text-[11px] text-slate-600">
                  Results from {sourceName}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
