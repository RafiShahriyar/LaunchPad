import { useEffect, useState } from 'react'
import type { DirectoryPurpose } from '@shared/ipc'
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
import { modalClosed } from '@/store/slices/uiSlice'
import { coverUrl, suggestNameFromExecutable } from '@/lib/format'
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

  // A failed submit from a previous open would otherwise still be showing.
  useEffect(() => {
    dispatch(mutationErrorCleared())
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

  const canSubmit =
    form.name.trim().length > 0 &&
    form.executablePath.trim().length > 0 &&
    mutationStatus !== 'loading'

  const submit = async () => {
    const payload: NewGame = {
      name: form.name.trim(),
      executablePath: form.executablePath.trim(),
      saveFolderPath: form.saveFolderPath.trim() || null,
      workingDirectory: form.workingDirectory.trim() || null,
      launchArgs: form.launchArgs.trim() || null,
      coverImagePath: form.coverImagePath.trim() || null
    }

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
      } else {
        await dispatch(createGame(payload)).unwrap()
      }
      dispatch(modalClosed())
    } catch {
      // The rejection is already in state.games.mutationError; keep the dialog
      // open so the user can correct the field rather than losing their input.
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
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {mutationStatus === 'loading' ? 'Saving…' : isEdit ? 'Save changes' : 'Add game'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" required>
          <input
            className={inputClass}
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            placeholder="Hollow Knight"
          />
        </Field>

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
                <img src={previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-2xl text-slate-700">
                  ▦
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
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
      </div>
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
