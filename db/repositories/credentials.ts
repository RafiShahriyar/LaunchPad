import type { CredentialProvider } from '@shared/types'
import { getDb, transaction } from '../client'
import { readString } from '../row'

/**
 * Metadata-provider credentials and any cached OAuth token.
 *
 * These live in the settings table but deliberately NOT in `AppSettings`.
 * `settings:get` hands the whole AppSettings object to the renderer, so a
 * client secret placed there would sit in the Redux store and be readable from
 * devtools. The renderer never needs a secret — only main talks to a provider —
 * so they are stored here and exposed to the UI only as a presence flag plus a
 * masked identifier.
 *
 * This is why the four-place "adding a setting" recipe in CLAUDE.md does not
 * apply to these keys: they are not application settings, they are secrets.
 *
 * They are stored in plaintext. On a single-user desktop app the database is
 * already readable by anyone who can read the user's profile, so encrypting it
 * with a key stored beside it would be theatre. What this does buy is not
 * leaking secrets into a second, more exposed place.
 */

/**
 * Storage keys are derived, not enumerated.
 *
 * `<provider>_<field>` means adding a provider needs no change here at all —
 * the field names come from the provider's own descriptor.
 */
function storageKey(provider: CredentialProvider, field: string): string {
  return `cred_${provider}_${field}`
}

const TOKEN_FIELD = 'access_token'
const TOKEN_EXPIRY_FIELD = 'access_token_expires_at'

export interface CachedToken {
  accessToken: string
  /** ISO-8601 UTC instant after which the token must be re-fetched. */
  expiresAt: string
}

function readValues(keys: readonly string[]): Map<string, string> {
  if (keys.length === 0) return new Map()
  const placeholders = keys.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .all(...keys)
  return new Map(rows.map((row) => [readString(row, 'key'), readString(row, 'value')]))
}

function writeValues(entries: readonly (readonly [string, string])[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const [key, value] of entries) stmt.run(key, value)
}

function deleteValues(keys: readonly string[]): void {
  if (keys.length === 0) return
  const placeholders = keys.map(() => '?').join(', ')
  getDb().prepare(`DELETE FROM settings WHERE key IN (${placeholders})`).run(...keys)
}

/**
 * Reads a provider's stored fields.
 *
 * Returns null unless EVERY requested field is present: a client id without its
 * secret cannot authenticate, and returning a half-filled record would push
 * that discovery to whichever request failed first.
 */
export function getCredentials(
  provider: CredentialProvider,
  fields: readonly string[]
): Record<string, string> | null {
  const raw = readValues(fields.map((field) => storageKey(provider, field)))
  const result: Record<string, string> = {}
  for (const field of fields) {
    const value = raw.get(storageKey(provider, field))
    if (!value) return null
    result[field] = value
  }
  return result
}

/**
 * Replacing credentials discards any cached token in the same transaction.
 *
 * A token minted by the previous credentials is useless against the new ones,
 * and leaving it behind would produce a 401 on the next search that looks like
 * bad new credentials rather than a stale cache.
 */
export function setCredentials(
  provider: CredentialProvider,
  values: Record<string, string>
): void {
  transaction(() => {
    writeValues(Object.entries(values).map(([field, value]) => [storageKey(provider, field), value]))
    clearCachedToken(provider)
  })
}

export function clearCredentials(provider: CredentialProvider, fields: readonly string[]): void {
  transaction(() => {
    deleteValues(fields.map((field) => storageKey(provider, field)))
    clearCachedToken(provider)
  })
}

/**
 * The cached client-credentials token, for providers that use OAuth.
 *
 * Cached in the database rather than in memory because IGDB tokens last around
 * sixty days: re-authenticating on every app start would be a pointless request
 * against a rate-limited endpoint, and would fail the first search of the
 * session whenever the network is briefly unavailable at launch.
 */
export function getCachedToken(provider: CredentialProvider): CachedToken | null {
  const raw = readValues([
    storageKey(provider, TOKEN_FIELD),
    storageKey(provider, TOKEN_EXPIRY_FIELD)
  ])
  const accessToken = raw.get(storageKey(provider, TOKEN_FIELD))
  const expiresAt = raw.get(storageKey(provider, TOKEN_EXPIRY_FIELD))
  if (!accessToken || !expiresAt) return null
  return { accessToken, expiresAt }
}

export function setCachedToken(provider: CredentialProvider, token: CachedToken): void {
  writeValues([
    [storageKey(provider, TOKEN_FIELD), token.accessToken],
    [storageKey(provider, TOKEN_EXPIRY_FIELD), token.expiresAt]
  ])
}

export function clearCachedToken(provider: CredentialProvider): void {
  deleteValues([storageKey(provider, TOKEN_FIELD), storageKey(provider, TOKEN_EXPIRY_FIELD)])
}
