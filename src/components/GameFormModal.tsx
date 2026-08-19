import { useEffect, useState } from 'react'
import type { DirectoryPurpose, MetadataSearchResult } from '@shared/ipc'
import type { Game, NewGame } from '@shared/types'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  createGame,
  mutationErrorCleared,
  pickCoverImage,
  pickDirectory,
  pickExecutable,
  selectAllGames,
  updateGame
} from '@/store/slices/gamesSlice'
import { applyMetadata, searchReset } from '@/store/slices/metadataSlice'
import { modalClosed } from '@/store/slices/uiSlice'
import { coverUrl, suggestNameFromExecutable } from '@/lib/format'
import { CoverViewer, NoCover } from './CoverViewer'
import { NameCombobox } from './NameCombobox'
import { Button, Modal } from './Modal'

interface GameFormModalProps {
  /** Absent for "add", present for "edit". */
  game?: Game
}

interface FormState {
  name: string
  executablePath: string
  saveFolderPath: string
  workingDirectory: string
  launchArgs: string
  /** Absolute path to a NEW image the user picked, or the managed path when unchanged. */
  coverImagePath: string
}

const emptyForm: FormState = {
  name: '',
  executablePath: '',
  saveFolderPath: '',
  workingDirectory: '',
  launchArgs: '',
  coverImagePath: ''
}

export function GameFormModal({ game }: GameFormModalProps) {
  const dispatch = useAppDispatch()
  const allGames = useAppSelector(selectAllGames)
  const { mutationStatus, mutationError } = useAppSelector((state) => state.games)

  const isEdit = game !== undefined
  const [form, setForm] = useState<FormState>(() =>
    game
      ? {
          name: game.name,
          executablePath: game.executablePath,
          saveFolderPath: game.saveFolderPath ?? '',
          workingDirectory: game.workingDirectory ?? '',
          launchArgs: game.launchArgs ?? '',
          coverImagePath: game.coverImagePath ?? ''
        }
      : emptyForm
  )
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(game?.workingDirectory || game?.launchArgs)
  )

  /** The entry chosen from the provider, applied after the game itself saves. */
  const [match, setMatch] = useState<MetadataSearchResult | null>(null)
  const [viewingCover, setViewingCover] = useState(false)
  /**
   * Set once the game row exists, so a retry after a failed metadata step
   * updates that row instead of creating a second copy of the same game.
   */
  const [savedGameId, setSavedGameId] = useState<number | null>(game?.id ?? null)

  const { applyStatus, applyError, coverError } = useAppSelector((state) => state.metadata)

  // A failed submit from a previous open would otherwise still be showing.
  useEffect(() => {
    dispatch(mutationErrorCleared())
    dispatch(searchReset())
  }, [dispatch])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }))

  const browseExecutable = async () => {
    const path = await dispatch(pickExecutable()).unwrap()
    if (!path) return
    set('executablePath', path)
    // Only fill a name the user has not already typed.
    if (!form.name.trim()) set('name', suggestNameFromExecutable(path))
  }

  const browseDirectory = async (purpose: DirectoryPurpose, field: keyof FormState) => {
    const path = await dispatch(pickDirectory(purpose)).unwrap()
    if (path) set(field, path)
  }

  const browseCover = async () => {
    const path = await dispatch(pickCoverImage()).unwrap()
    if (path) set('coverImagePath', path)
  }

  /**
   * The DB deliberately has no UNIQUE constraint on executable_path, because
   * separate mod profiles or save slots of one game are a legitimate reason to
   * add the same exe twice. So this is a warning, not a validation error.
   */
  const duplicateOf = allGames.find(
    (candidate) =>
      candidate.id !== game?.id &&
      candidate.executablePath.toLowerCase() === form.executablePath.trim().toLowerCase()
  )

  /**
   * The chosen entry fills the name field immediately so the change is visible
   * and still editable. The rest (genres, summary, release date, cover art) is
   * written by main after the game row exists.
   */
  const selectMatch = (result: MetadataSearchResult) => {
    setMatch(result)
    setForm((previous) => ({ ...previous, name: result.name }))
  }

  /**
   * A cover the user picked by hand wins over the provider's.
   *
   * They chose that file deliberately; silently replacing it with downloaded
   * art would discard an explicit decision in favour of a guess.
   */
  const willDownloadCover = Boolean(match?.coverUrl) && form.coverImagePath.trim().length === 0

  const busy = mutationStatus === 'loading' || applyStatus === 'loading'

  const canSubmit =
    form.name.trim().length > 0 && form.executablePath.trim().length > 0 && !busy

  /** The game is saved; only the metadata step is outstanding or reported. */
  const savedButIncomplete = savedGameId !== null && !isEdit && Boolean(applyError || coverError)

  const submit = async () => {
    const payload: NewGame = {
      name: form.name.trim(),
      executablePath: form.executablePath.trim(),
      saveFolderPath: form.saveFolderPath.trim() || null,
      workingDirectory: form.workingDirectory.trim() || null,
      launchArgs: form.launchArgs.trim() || null,
      coverImagePath: form.coverImagePath.trim() || null
    }

    let gameId: number
    try {
      if (isEdit) {
        // Send the cover only when it actually changed: re-sending the managed
        // path is harmless but makes main re-hash the file for nothing.
        const coverChanged = (game.coverImagePath ?? '') !== form.coverImagePath
        await dispatch(
          updateGame({
            id: game.id,
            patch: coverChanged ? payload : { ...payload, coverImagePath: undefined }
          })
        ).unwrap()
        gameId = game.id
      } else if (savedGameId !== null) {
        // A previous attempt already created the row and only the metadata
        // step failed. Update it rather than adding the game twice.
        await dispatch(updateGame({ id: savedGameId, patch: payload })).unwrap()
        gameId = savedGameId
      } else {
        const created = await dispatch(createGame(payload)).unwrap()
        gameId = created.id
        setSavedGameId(created.id)
      }
    } catch {
      // The rejection is already in state.games.mutationError; keep the dialog
      // open so the user can correct the field rather than losing their input.
      return
    }

    if (!match) {
      dispatch(modalClosed())
      return
    }

    try {
      const applied = await dispatch(
        applyMetadata({
          gameId,
          result: match,
          // The name is already in the form, and main would only rewrite it to
          // the same value — or overwrite an edit the user made after choosing.
          options: { applyName: false, applyCover: willDownloadCover }
        })
      ).unwrap()

      /*
       * A cover that failed to download is a PARTIAL success: the genres and
       * description did apply. Closing silently would be the app claiming a
       * result it did not achieve, so the dialog stays open to report it and
       * the primary button becomes "Done" — the game is already saved.
       */
      if (applied.coverError) return

      dispatch(modalClosed())
    } catch {
      // applyError is in state.metadata; the game itself is saved either way.
    }
  }

  const previewUrl = form.coverImagePath
    ? coverUrl({ coverImagePath: form.coverImagePath } as Game)
    : null

  return (
    <Modal
      title={isEdit ? 'Edit game' : 'Add game'}
      description={
        isEdit ? undefined : 'Point LaunchPad at the executable. Everything else is optional.'
      }
      size="lg"
      onClose={() => dispatch(modalClosed())}
      footer={
        <>
          <Button variant="ghost" onClick={() => dispatch(modalClosed())}>
            Cancel
          </Button>
          {coverError && !applyError ? (
            // The work is done and reported; the only thing left is to dismiss.
            <Button variant="primary" onClick={() => dispatch(modalClosed())}>
              Done
            </Button>
          ) : (
            <Button variant="primary" onClick={submit} disabled={!canSubmit}>
              {applyStatus === 'loading'
                ? 'Fetching game info…'
                : mutationStatus === 'loading'
                  ? 'Saving…'
                  : isEdit
                    ? 'Save changes'
                    : savedGameId !== null
                      ? 'Retry'
                      : 'Add game'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <Field
          label="Name"
          required
          hint="Start typing and pick a match to fill in cover art, genres and a description."
        >
          <NameCombobox
            value={form.name}
            onChange={(next) => set('name', next)}
            onSelect={selectMatch}
            inputClass={inputClass}
          />
        </Field>

        {match && (
          <div className="flex items-start gap-3 rounded-lg border border-surface-600 bg-surface-900/60 p-3">
            {match.thumbnailDataUri && (
              <img
                src={match.thumbnailDataUri}
                alt=""
                className="h-16 w-12 shrink-0 rounded border border-surface-600 object-cover"
              />
            )}
            <div className="min-w-0 flex-1 text-xs text-slate-400">
              <p className="text-sm text-slate-200">{match.name}</p>
              <p className="mt-0.5">
                {match.genres.length > 0
                  ? match.genres.join(', ')
                  : 'The provider lists no genres for this entry'}
              </p>
              <p className="mt-1 text-slate-500">
                {/*
                  Says exactly what pressing save will do, including when it
                  will NOT replace artwork the user picked themselves.
                */}
                {willDownloadCover
                  ? 'Cover art will be downloaded when you save.'
                  : match.coverUrl
                    ? 'Your chosen image will be kept instead of the downloaded cover.'
                    : 'This entry has no cover art.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMatch(null)}
              className="shrink-0 text-xs text-slate-500 hover:text-slate-300"
              aria-label="Discard the selected match"
            >
              ✕
            </button>
          </div>
        )}

        <Field label="Executable" required hint="The .exe LaunchPad runs when you press Play.">
          <PathInput
            value={form.executablePath}
            onChange={(value) => set('executablePath', value)}
            onBrowse={browseExecutable}
            placeholder="C:\Games\HollowKnight\hollow_knight.exe"
          />
          {duplicateOf && (
            <p className="mt-2 text-xs text-amber-400">
              “{duplicateOf.name}” already uses this executable. That is allowed — separate
              profiles are a valid reason — but check you did not add it twice.
            </p>
          )}
        </Field>

        <Field
          label="Save folder"
          hint="Needed for backups. It is fine if the folder does not exist yet — many games create it on first run."
        >
          <PathInput
            value={form.saveFolderPath}
            onChange={(value) => set('saveFolderPath', value)}
            onBrowse={() => browseDirectory('saveFolder', 'saveFolderPath')}
            onClear={() => set('saveFolderPath', '')}
            placeholder="C:\Users\you\AppData\LocalLow\Team Cherry\Hollow Knight"
          />
        </Field>

        <Field label="Cover image">
          <div className="flex items-start gap-4">
            <div className="h-28 w-20 shrink-0 overflow-hidden rounded-lg border border-surface-600 bg-surface-900">
              {previewUrl ? (
                // The thumbnail is 80px wide; cover art has text on it that is
                // unreadable at that size, so it opens full size on click.
                <button
                  type="button"
                  onClick={() => setViewingCover(true)}
                  aria-label="View cover image full size"
                  className="h-full w-full cursor-zoom-in"
                >
                  <img src={previewUrl} alt="" className="h-full w-full object-cover" />
                </button>
              ) : (
                <NoCover />
              )}
            </div>
            <div className="flex flex-col items-start gap-2">
              {previewUrl ? (
                <Button onClick={() => setViewingCover(true)}>View full size</Button>
              ) : (
                <p className="text-xs text-slate-500">
                  {/*
                    Distinguishes "none chosen" from "one is coming", so the
                    empty box never looks like something that failed to load.
                  */}
                  {willDownloadCover
                    ? 'None yet — one will be downloaded when you save.'
                    : 'No cover image. Choose one, or pick a match above.'}
                </p>
              )}
              <Button onClick={browseCover}>Choose image…</Button>
              {form.coverImagePath && (
                <Button variant="ghost" onClick={() => set('coverImagePath', '')}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        </Field>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((open) => !open)}
            className="text-sm text-slate-400 hover:text-slate-200"
          >
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>

          {showAdvanced && (
            <div className="mt-4 space-y-5 border-l border-surface-700 pl-4">
              <Field
                label="Working directory"
                hint="Defaults to the executable's own folder. Some games only find their data files when started from a specific directory."
              >
                <PathInput
                  value={form.workingDirectory}
                  onChange={(value) => set('workingDirectory', value)}
                  onBrowse={() => browseDirectory('workingDirectory', 'workingDirectory')}
                  onClear={() => set('workingDirectory', '')}
                  placeholder="Defaults to the executable's folder"
                />
              </Field>

              <Field label="Launch arguments" hint="Passed to the executable on start.">
                <input
                  className={inputClass}
                  value={form.launchArgs}
                  onChange={(event) => set('launchArgs', event.target.value)}
                  placeholder="-windowed -novid"
                />
              </Field>
            </div>
          )}
        </div>

        {mutationError && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {mutationError}
          </div>
        )}

        {applyError && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {applyError}
            {savedButIncomplete && (
              <span className="mt-1 block text-red-200/70">
                The game itself was saved. Only the downloaded information failed.
              </span>
            )}
          </div>
        )}

        {/*
          Amber, not red: the metadata did apply and the game is saved. Only the
          artwork is missing, and the message says precisely that rather than
          letting a silent close imply everything worked.
        */}
        {coverError && !applyError && (
          <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            Genres and description were saved, but the cover art could not be downloaded:{' '}
            {coverError}
          </div>
        )}
      </div>

      {viewingCover && previewUrl && (
        <CoverViewer
          src={previewUrl}
          title={form.name.trim() || 'this game'}
          onClose={() => setViewingCover(false)}
        />
      )}
    </Modal>
  )
}

const inputClass =
  'w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-accent-500 focus:outline-none'

function Field({
  label,
  hint,
  required,
  children
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-300">
        {label}
        {required && <span className="ml-1 text-accent-400">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

/**
 * Path fields stay editable by hand as well as browsable. The picker is the
 * normal route, but typing or pasting a path is faster for anyone who already
 * knows it, and main validates either way.
 */
function PathInput({
  value,
  onChange,
  onBrowse,
  onClear,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  onBrowse: () => void
  onClear?: () => void
  placeholder?: string
}) {
  return (
    <div className="flex gap-2">
      <input
        className={`${inputClass} font-mono text-xs`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      <Button onClick={onBrowse} className="shrink-0">
        Browse…
      </Button>
      {onClear && value && (
        <Button variant="ghost" onClick={onClear} className="shrink-0 px-2">
          ✕
        </Button>
      )}
    </div>
  )
}
