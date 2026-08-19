import { useEffect, useState } from 'react'
import { fetchGames } from '@/store/slices/gamesSlice'
import type { AppSettings } from '@shared/types'
import { Button } from '@/components/Modal'
import { formatBytes } from '@/lib/format'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { fetchBackupUsage } from '@/store/slices/savesSlice'
import type { ProviderDescriptor } from '@shared/ipc'
import {
  clearCredentials,
  credentialsErrorCleared,
  fetchMetadataStatus,
  saveCredentials
} from '@/store/slices/metadataSlice'
import {
  cleanupOrphans,
  fetchAppInfo,
  fetchSettings,
  openBackupsFolder,
  pickBackupsFolder,
  scanOrphans,
  seedDemoData,
  updateSettings
} from '@/store/slices/settingsSlice'

export function SettingsPage() {
  const dispatch = useAppDispatch()
  const { settings, appInfo, saveStatus, saveError, orphanScan, orphanStatus, lastCleanup } =
    useAppSelector((state) => state.settings)
  const totalUsage = useAppSelector((state) => state.saves.totalUsage)

  useEffect(() => {
    void dispatch(fetchSettings())
    void dispatch(fetchAppInfo())
    void dispatch(fetchBackupUsage(undefined))
  }, [dispatch])

  if (!settings) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-100">Settings</h1>
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      </div>
    )
  }

  const save = (patch: Partial<AppSettings>) => void dispatch(updateSettings(patch))

  return (
    <div className="max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-slate-100">Settings</h1>
      <p className="mt-1 text-sm text-slate-500">
        Changes save immediately. Values the app rejects are reported below the field.
      </p>

      {saveError && (
        <div className="mt-4 rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {saveError}
        </div>
      )}

      <Section title="Backups" description="Where snapshots live and how many are kept.">
        <Field
          label="Backups folder"
          hint="Changing this affects new snapshots only. Existing ones keep working from where they already are."
        >
          <div className="flex gap-2">
            <input
              readOnly
              value={settings.backupsRootPath}
              aria-label="Backups folder"
              className="w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 font-mono text-xs text-slate-300"
            />
            <Button
              className="shrink-0"
              onClick={async () => {
                const path = await dispatch(pickBackupsFolder()).unwrap()
                if (path) save({ backupsRootPath: path })
              }}
            >
              Change…
            </Button>
            <Button className="shrink-0" onClick={() => void dispatch(openBackupsFolder())}>
              Open
            </Button>
          </div>
        </Field>

        <NumberField
          label="Backups to keep per game"
          hint="Older snapshots are removed once a game exceeds this. Pinned snapshots are never removed and do not count toward the limit."
          value={settings.maxBackupsPerGame}
          min={1}
          max={500}
          onCommit={(value) => save({ maxBackupsPerGame: value })}
        />

        <ToggleField
          label="Back up before launching"
          hint="Captures the save state you are about to change, so a bad session can be undone."
          checked={settings.backupBeforeLaunch}
          onChange={(checked) => save({ backupBeforeLaunch: checked })}
        />

        <ToggleField
          label="Back up after playing"
          hint="Captures the progress you just made. This is the one that preserves your session."
          checked={settings.backupAfterSession}
          onChange={(checked) => save({ backupAfterSession: checked })}
        />
      </Section>

      <Section title="Playtime" description="How sessions are recorded.">
        <NumberField
          label="Minimum session length (seconds)"
          hint="Sessions shorter than this are discarded rather than recorded. Filters out misclicks and failed launches that would otherwise skew your averages."
          value={settings.minSessionSeconds}
          min={0}
          max={3600}
          onCommit={(value) => save({ minSessionSeconds: value })}
        />
      </Section>

      <Section
        title="Storage"
        description="How much disk space backups are using, and what can be reclaimed."
      >
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label="Snapshots"
            value={totalUsage ? String(totalUsage.backupCount) : '—'}
          />
          <Stat
            label="Total size"
            value={totalUsage ? formatBytes(totalUsage.totalSizeBytes) : '—'}
          />
        </div>

        <div className="mt-4 rounded-xl border border-surface-700 bg-surface-900 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <p className="text-sm font-medium text-slate-200">Unreferenced backup folders</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Left behind when a game is deleted with “keep backups”. Nothing is removed until
                you say so.
              </p>
            </div>
            <Button
              disabled={orphanStatus === 'loading'}
              onClick={() => void dispatch(scanOrphans())}
            >
              {orphanStatus === 'loading' ? 'Scanning…' : 'Scan'}
            </Button>
          </div>

          {lastCleanup && (
            <p className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
              Removed {lastCleanup.deletedCount} folder
              {lastCleanup.deletedCount === 1 ? '' : 's'}, freeing{' '}
              {formatBytes(lastCleanup.freedBytes)}.
              {lastCleanup.failed.length > 0 &&
                ` ${lastCleanup.failed.length} could not be deleted.`}
            </p>
          )}

          {orphanScan && orphanScan.folders.length === 0 && (
            <p className="mt-3 text-xs text-slate-500">
              Nothing unreferenced in {orphanScan.scannedRoot}
            </p>
          )}

          {orphanScan && orphanScan.folders.length > 0 && (
            <div className="mt-3">
              <ul className="flex max-h-52 flex-col gap-1.5 overflow-y-auto">
                {orphanScan.folders.map((folder) => (
                  <li
                    key={folder.path}
                    className="flex items-center gap-3 rounded-lg border border-surface-700 bg-surface-850 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-slate-300" title={folder.path}>
                        {folder.label}
                      </p>
                      <p className="text-[11px] text-slate-600">
                        {folder.reason === 'deleted_game'
                          ? 'Game no longer in your library'
                          : 'Snapshot not referenced by any record'}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatBytes(folder.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-center gap-3">
                <span className="mr-auto text-xs text-slate-400">
                  {orphanScan.folders.length} folder
                  {orphanScan.folders.length === 1 ? '' : 's'} ·{' '}
                  {formatBytes(orphanScan.totalBytes)} reclaimable
                </span>
                <Button
                  variant="danger"
                  disabled={orphanStatus === 'loading'}
                  onClick={async () => {
                    await dispatch(cleanupOrphans())
                    void dispatch(fetchBackupUsage(undefined))
                  }}
                >
                  Delete all
                </Button>
              </div>
            </div>
          )}
        </div>
      </Section>

      <MetadataSection />

      <DeveloperSection />

      <Section title="About" description="Runtime information, useful when reporting a problem.">
        {appInfo && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {[
              ['App', appInfo.appVersion],
              ['Electron', appInfo.electronVersion],
              ['Chromium', appInfo.chromeVersion],
              ['Node', appInfo.nodeVersion],
              ['Platform', appInfo.platform],
              ['Database', appInfo.dbPath],
              ['Schema version', String(appInfo.schemaVersion)],
              ['User data', appInfo.userDataPath]
            ].map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-slate-500">{label}</dt>
                <dd className="truncate font-mono text-xs text-slate-300" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      <p className="mt-8 text-xs text-slate-600">
        {saveStatus === 'loading' ? 'Saving…' : 'All changes saved automatically.'}
      </p>
    </div>
  )
}

/**
 * Development-only tools.
 *
 * `import.meta.env.DEV` is compile-time, so this block is removed from the
 * production bundle entirely rather than merely hidden. Main refuses the channel
 * when packaged regardless — the renderer decides what to show, not what exists.
 */
/**
 * Metadata provider credentials.
 *
 * Every provider is rendered from its own `ProviderDescriptor`, supplied by
 * main. Nothing here names IGDB, RAWG or SteamGridDB, so adding a fourth
 * provider is a main-process change plus a union member — this screen does not
 * grow another branch each time.
 *
 * Secrets are write-only from the renderer's point of view: sent to main once
 * and never returned. All this screen gets back is a boolean and a masked
 * identifier, so a secret never lands in the Redux store where devtools would
 * show it. That is also why these values are not part of AppSettings — see
 * db/repositories/credentials.ts.
 */
function MetadataSection() {
  const dispatch = useAppDispatch()
  const { status } = useAppSelector((state) => state.metadata)

  useEffect(() => {
    void dispatch(fetchMetadataStatus())
  }, [dispatch])

  const metadataProviders = status?.providers.filter((entry) => entry.role === 'metadata') ?? []
  const artProviders = status?.providers.filter((entry) => entry.role === 'art') ?? []
  const activeName = status?.providers.find((entry) => entry.id === status.activeSource)?.name ?? null

  return (
    <Section
      title="Game metadata"
      description="Optional. Lets LaunchPad fill in cover art, genres and descriptions."
    >
      {/*
        States which provider searches actually use. With more than one
        configured that choice would otherwise be invisible, leaving the user to
        infer it from the results.
      */}
      {activeName ? (
        <p className="text-sm text-slate-300">
          Searches use <span className="text-slate-100">{activeName}</span>
          <span className="text-slate-500">
            {status?.artConfigured
              ? ' · covers upgraded to portrait box art'
              : ' · covers come from the same source'}
          </span>
        </p>
      ) : (
        <p className="text-sm text-slate-400">
          No provider configured. Game info search is unavailable until you add one below.
        </p>
      )}

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Metadata — genres, descriptions, dates
        </h3>
        <p className="mb-3 text-xs text-slate-600">
          Configure one. If both are set, the first listed is used.
        </p>
        <div className="flex flex-col gap-4">
          {metadataProviders.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Cover art
        </h3>
        <p className="mb-3 text-xs text-slate-600">
          Optional. The library grid draws portrait 3:4 cards, and most catalogue APIs return
          landscape screenshots that crop badly into that shape.
        </p>
        <div className="flex flex-col gap-4">
          {artProviders.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      </div>
    </Section>
  )
}

function ProviderCard({ provider }: { provider: ProviderDescriptor }) {
  const dispatch = useAppDispatch()
  const { status, credentialsStatus, credentialsError, credentialsProvider } = useAppSelector(
    (state) => state.metadata
  )
  const [values, setValues] = useState<Record<string, string>>({})

  const credentials = status?.credentials.find((entry) => entry.provider === provider.id)
  const configured = credentials?.configured ?? false

  // Progress and errors belong to the card that caused them, not to every card.
  const mine = credentialsProvider === provider.id
  const busy = mine && credentialsStatus === 'loading'
  const error = mine ? credentialsError : null
  const justSaved = mine && credentialsStatus === 'succeeded' && !credentialsError

  const complete = provider.fields.every((field) => (values[field.key] ?? '').trim().length > 0)

  const save = async () => {
    try {
      const trimmed = Object.fromEntries(
        provider.fields.map((field) => [field.key, (values[field.key] ?? '').trim()])
      )
      await dispatch(saveCredentials({ provider: provider.id, values: trimmed })).unwrap()
      // Only clear the inputs once the values have been accepted, so a rejected
      // key does not have to be typed out again.
      setValues({})
    } catch {
      // credentialsError already holds the reason.
    }
  }

  return (
    <div className="rounded-lg border border-surface-700 bg-surface-900/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-200">{provider.name}</p>
          <p className="mt-0.5 text-xs text-slate-500">{provider.blurb}</p>
          <p className="mt-1 break-all text-xs text-slate-600">
            Get a key at <span className="text-slate-500">{provider.signupUrl}</span>
          </p>
        </div>
        {configured && (
          <Button
            variant="ghost"
            onClick={() => {
              void dispatch(clearCredentials(provider.id))
            }}
          >
            Remove
          </Button>
        )}
      </div>

      {configured && (
        <p className="mt-3 font-mono text-xs text-emerald-500">
          Connected · {credentials?.maskedKey}
          {/*
            Saying whether a token is held explains why searching keeps working
            without re-authenticating, rather than it looking like chance.
          */}
          {credentials?.hasCachedToken ? ' · access token cached' : ''}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {provider.fields.map((field) => (
          <input
            key={field.key}
            className={settingsInputClass}
            type={field.secret ? 'password' : 'text'}
            value={values[field.key] ?? ''}
            onChange={(event) => {
              const next = event.target.value
              setValues((previous) => ({ ...previous, [field.key]: next }))
              if (error) dispatch(credentialsErrorCleared())
            }}
            placeholder={configured ? `Replace ${field.label.toLowerCase()}` : field.placeholder}
            spellCheck={false}
            aria-label={`${provider.name} ${field.label}`}
          />
        ))}
        <div>
          <Button onClick={save} disabled={!complete || busy}>
            {busy ? 'Checking…' : configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {justSaved && (
        <p className="mt-3 text-sm text-emerald-400">Verified with {provider.name} and saved.</p>
      )}
    </div>
  )
}

const settingsInputClass =
  'w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-accent-500 focus:outline-none'

function DeveloperSection() {
  const dispatch = useAppDispatch()
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!import.meta.env.DEV) return null

  const seed = async () => {
    setBusy(true)
    try {
      const data = await dispatch(seedDemoData()).unwrap()
      // The library is stale now, so refresh it rather than making the user reload.
      await dispatch(fetchGames())
      setResult(
        data.gamesCreated === 0
          ? 'Sample games already present — nothing added.'
          : `Added ${data.gamesCreated} games, ${data.sessionsCreated} sessions and ${data.backupsCreated} backups.`
      )
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Failed to add sample data')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Developer"
      description="Only shown in development builds. Not included in the production bundle."
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="text-sm font-medium text-slate-300">Sample library</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Adds eight games with cover art, session history across the last 30 days, and real
            save folders you can back up and restore. Existing games are left untouched.
          </p>
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void seed()}>
          {busy ? 'Adding…' : 'Add sample data'}
        </Button>
      </div>

      {result && (
        <p className="rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-xs text-slate-300">
          {result}
        </p>
      )}
    </Section>
  )
}

function Section({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-8 rounded-xl border border-surface-700 bg-surface-850 p-6">
      <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
      <p className="mt-0.5 mb-5 text-xs text-slate-500">{description}</p>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>}
    </div>
  )
}

/**
 * Commits on blur or Enter rather than on every keystroke.
 *
 * Saving per keystroke would send `1`, `12`, `120` while the user types "120",
 * and the intermediate values are both wrong and (for the minimum-session
 * field) briefly change how the app behaves.
 */
function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onCommit
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    if (Number.isNaN(parsed)) {
      setDraft(String(value))
      return
    }
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        className="w-32 rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 text-sm text-slate-200 focus:border-accent-500 focus:outline-none"
      />
    </Field>
  )
}

function ToggleField({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-accent-500"
      />
      <span>
        <span className="block text-sm font-medium text-slate-300">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-surface-700 bg-surface-900 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{value}</p>
    </div>
  )
}
