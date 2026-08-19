/**
 * Shared network plumbing for metadata providers.
 *
 * Extracted so every provider reports failures the same way. `fetch` collapses
 * almost everything into a bare "fetch failed", which tells a user nothing about
 * whether to check their internet, their firewall or their key — and three
 * providers each inventing their own wording would be worse than one.
 */

export const REQUEST_TIMEOUT_MS = 15_000

/** Turns a network-layer failure into a sentence a user can act on. */
export function describeNetworkError(err: unknown, providerName: string): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return `${providerName} did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
    }
    const code = (err as { cause?: { code?: string } }).cause?.code
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return `Could not reach ${providerName} — no internet connection, or DNS is unavailable.`
    }
    if (code === 'ECONNREFUSED') return `${providerName} refused the connection.`
    if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      return `The TLS certificate for ${providerName} could not be verified.`
    }
    return err.message
  }
  return String(err)
}

/**
 * Serialises outbound requests to a minimum interval.
 *
 * Each provider gets its own throttle: their limits are independent, and a
 * shared one would make a slow search against one provider delay a request to
 * another for no reason.
 */
export function createThrottle(minIntervalMs: number): () => Promise<void> {
  let lastAt = 0
  return async () => {
    const waitMs = lastAt + minIntervalMs - Date.now()
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    lastAt = Date.now()
  }
}

export async function getJson(
  url: string | URL,
  init: RequestInit,
  providerName: string
): Promise<{ status: number; body: unknown }> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(describeNetworkError(err, providerName))
  }

  if (!response.ok) return { status: response.status, body: null }

  try {
    return { status: response.status, body: await response.json() }
  } catch {
    throw new Error(`${providerName} returned a response that was not valid JSON.`)
  }
}

/** Guards against a CDN serving something unexpectedly large into an IPC payload. */
const MAX_THUMBNAIL_BYTES = 200 * 1024
const THUMBNAIL_TIMEOUT_MS = 8_000

/**
 * Fetches one thumbnail and inlines it as a data URI.
 *
 * This is what keeps the renderer's `connect-src 'none'` intact: the page never
 * loads a remote image, main hands it the bytes. `img-src` already allowed
 * `data:`, so the whole metadata feature changed the CSP by nothing.
 *
 * Best-effort by design — a missing thumbnail must never fail a search. The user
 * asked "which of these is my game", and a list with some art missing still
 * answers that, while an error banner does not.
 */
export async function fetchThumbnailDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) })
    if (!response.ok) return null

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!contentType.startsWith('image/')) return null

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return null

    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * Fills in thumbnails for a whole result page at once.
 *
 * Deliberately NOT throttled. A provider's rate limit governs its API; these hit
 * plain image CDNs, and serialising a dozen would add seconds to every search.
 */
export async function attachThumbnails(
  rows: { result: { thumbnailDataUri: string | null }; thumbUrl: string | null }[]
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      if (row.thumbUrl === null) return
      row.result.thumbnailDataUri = await fetchThumbnailDataUri(row.thumbUrl)
    })
  )
}
