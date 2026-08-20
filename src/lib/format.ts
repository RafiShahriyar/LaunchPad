import type { Game } from '@shared/types'

/**
 * Renderer-side formatting and path helpers.
 *
 * These are deliberately string-only: the renderer has no `path` module, so
 * anything resembling path handling here works on the string form and does the
 * minimum needed for display.
 */

/** "4h 32m", "18m", "45s", or "Never played" for zero. */
export function formatPlaytime(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Never played'

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${totalSeconds}s`
}

/** Compact absolute date, e.g. "19 Aug 2026". */
export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "Today", "Yesterday", "3 days ago", then falls back to an absolute date. */
export function formatRelativeDate(iso: string | null): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Never'

  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return formatDate(iso)
}

/**
 * Duration of a single session.
 *
 * Distinct from formatPlaytime because zero means something different here: a
 * session with duration 0 is one the app could not measure (it was closed by
 * startup reconciliation after a crash), not one that never happened. Showing
 * "Never played" there would be wrong, and "0s" would imply it was measured.
 */
export function formatSessionDuration(seconds: number | null): string {
  if (seconds === null) return 'In progress'
  if (seconds === 0) return 'Unknown'

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/** "19 Aug 2026, 14:32" */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Local YYYY-MM-DD key, used to bucket sessions by day. */
export function toLocalDayKey(iso: string): string {
  const date = new Date(iso)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/** Last path segment, handling both Windows and POSIX separators. */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}

/**
 * Builds the URL that renders a game's cover.
 *
 * Covers are served by the `lpasset://` handler in
 * electron/services/assetProtocol.ts, which resolves names against the managed
 * covers folder. Only the basename is sent, because that handler intentionally
 * accepts nothing else -- passing a full path would be rejected as a traversal
 * attempt. Returns null when the game has no cover, so callers render the
 * placeholder instead.
 */
export function coverUrl(game: Game): string | null {
  if (!game.coverImagePath) return null
  return `lpasset://cover/${encodeURIComponent(basename(game.coverImagePath))}`
}

/**
 * URL for the wide backdrop art, or null when the game has none.
 *
 * Uses the same `cover` namespace rather than a new one: hero files live in the
 * same managed folder, so the protocol handler already serves them and a second
 * namespace would be a second containment check to keep correct for no benefit.
 * The namespace names the directory, not the shape of what is in it.
 */
export function heroUrl(game: Game): string | null {
  if (!game.heroImagePath) return null
  return `lpasset://cover/${encodeURIComponent(basename(game.heroImagePath))}`
}

/**
 * Derives a display name from an executable path:
 * "hollow_knight.exe" -> "Hollow Knight".
 *
 * Runs in the renderer rather than main so the name appears the instant the
 * file picker closes, with no extra IPC round trip.
 */
export function suggestNameFromExecutable(executablePath: string): string {
  const file = basename(executablePath)
  const withoutExtension = file.replace(/\.[^.]+$/, '')
  const cleaned = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.replace(/\b\w/g, (character) => character.toUpperCase())
}
