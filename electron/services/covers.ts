import { app } from 'electron'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

/**
 * Cover images are COPIED into a managed folder rather than referenced in place.
 *
 * Three reasons, in order of importance:
 *
 *   1. **Security.** The renderer needs to display these, which means something
 *      has to serve arbitrary disk paths to a web page. Confining every servable
 *      image to one directory turns "can read any file" into "can read files in
 *      this folder", so the asset protocol has a containment check to enforce
 *      rather than a blanket allowance.
 *   2. **Durability.** Users point at images inside game install folders or
 *      Downloads. Uninstalling the game or clearing Downloads would otherwise
 *      leave the library full of broken images.
 *   3. **Cache correctness.** The filename embeds a hash of the file's contents,
 *      so replacing a cover always produces a new URL. Chromium therefore never
 *      shows a stale cached image, which a fixed name like `12.png` would cause.
 *
 * The cost is a duplicated copy of each image, which for cover art is a few
 * hundred KB at most.
 */

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])

/** Guards against a user picking a 4K wallpaper (or a video renamed to .png). */
const MAX_COVER_BYTES = 20 * 1024 * 1024

export function getCoversDir(): string {
  const dir = join(app.getPath('userData'), 'covers')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** True if `path` already points inside the managed covers folder. */
export function isManagedCover(path: string): boolean {
  const coversDir = resolve(getCoversDir())
  const resolved = resolve(path)
  return resolved.startsWith(coversDir + '\\') || resolved.startsWith(coversDir + '/')
}

/**
 * Checks a candidate cover WITHOUT copying anything.
 *
 * Separated from importCover so callers can reject a bad image before doing any
 * other work. The games:create handler needs this: it must assign a game id
 * (which requires an INSERT) before it can name the cover file, so without a
 * pre-flight check an invalid image would only be caught after the row existed.
 */
export function validateCoverSource(sourcePath: string): void {
  if (isManagedCover(sourcePath)) return

  if (!existsSync(sourcePath)) {
    throw new Error(`Cover image not found: ${sourcePath}`)
  }

  const stats = statSync(sourcePath)
  if (!stats.isFile()) {
    throw new Error(`Cover image is not a file: ${sourcePath}`)
  }
  if (stats.size > MAX_COVER_BYTES) {
    const mb = (stats.size / 1024 / 1024).toFixed(1)
    throw new Error(`Cover image is ${mb} MB; the limit is 20 MB.`)
  }

  const ext = extname(sourcePath).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported image type "${ext || basename(sourcePath)}". ` +
        `Use one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`
    )
  }
}

/**
 * Copies `sourcePath` into the covers folder and returns the new absolute path.
 * If the file is already a managed cover it is returned unchanged, so repeated
 * saves of an unedited game do not pile up duplicates.
 */
export function importCover(sourcePath: string, gameId: number): string {
  if (isManagedCover(sourcePath)) return sourcePath

  validateCoverSource(sourcePath)

  const ext = extname(sourcePath).toLowerCase()

  // Hash the contents, not the path: the same image picked twice yields the
  // same filename, and an edited image yields a different one.
  const hash = createHash('sha1').update(readFileSync(sourcePath)).digest('hex').slice(0, 12)
  const targetPath = join(getCoversDir(), `${gameId}-${hash}${ext}`)

  if (!existsSync(targetPath)) copyFileSync(sourcePath, targetPath)
  return targetPath
}

// --- Remote covers -----------------------------------------------------------

/**
 * Content types accepted from a remote cover, mapped to the extension written.
 *
 * The extension comes from the declared type rather than from the URL: a
 * provider CDN commonly serves an image from a path with no extension at all,
 * and trusting the URL would write a file Chromium then refuses to decode.
 */
const REMOTE_CONTENT_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
}

const REMOTE_FETCH_TIMEOUT_MS = 20_000

/**
 * Verifies the bytes actually start like the image type that was declared.
 *
 * A `Content-Type` header is a claim by the server, not evidence. This is a
 * cheap structural check in the same spirit as the asset protocol's containment
 * check: the file lands in a folder the renderer can load from, so it should
 * be what it says it is before it gets there.
 */
function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte)

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return true // PNG
  if (startsWith(0xff, 0xd8, 0xff)) return true // JPEG
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return true // GIF
  if (startsWith(0x42, 0x4d)) return true // BMP

  // RIFF....WEBP and ....ftyp (AVIF) both carry their tag at a fixed offset.
  const tag = String.fromCharCode(...bytes.slice(8, 12))
  if (startsWith(0x52, 0x49, 0x46, 0x46) && tag === 'WEBP') return true
  if (tag === 'ftyp') return true

  return false
}

/**
 * Downloads a cover from a remote URL into the managed covers folder.
 *
 * Mirrors importCover's guarantees -- content-hashed filename, confined to the
 * covers directory -- with two additions the local path does not need:
 *
 *   1. **Write to `.tmp-…` then rename.** The rename is the commit point, the
 *      same rule the backup writer follows. A connection dropped mid-download
 *      must never leave a truncated file sitting under a name the library will
 *      later treat as valid artwork.
 *   2. **The response is checked before it is trusted.** Declared type, actual
 *      size and leading bytes are all verified, because unlike a file the user
 *      picked, this one was chosen by a remote server.
 */
export async function importCoverFromUrl(url: string, gameId: number): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Cover URL is not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing to download a cover over ${parsed.protocol}`)
  }

  let response: Response
  try {
    response = await fetch(parsed, { signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not download the cover image: ${reason}`)
  }

  if (!response.ok) {
    throw new Error(`Cover image download failed with HTTP ${response.status}.`)
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const ext = REMOTE_CONTENT_TYPES[contentType]
  if (!ext) {
    throw new Error(`Cover image has an unsupported content type: ${contentType || 'unknown'}`)
  }

  // Reject an oversized image from its declared length before downloading it.
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COVER_BYTES) {
    const mb = (declaredLength / 1024 / 1024).toFixed(1)
    throw new Error(`Cover image is ${mb} MB; the limit is 20 MB.`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('Cover image download returned no data.')
  if (bytes.byteLength > MAX_COVER_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1)
    throw new Error(`Cover image is ${mb} MB; the limit is 20 MB.`)
  }
  if (!looksLikeImage(bytes)) {
    throw new Error(`Downloaded cover is not a recognisable ${contentType} image.`)
  }

  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
  const targetPath = join(getCoversDir(), `${gameId}-${hash}${ext}`)
  if (existsSync(targetPath)) return targetPath

  const tempPath = join(getCoversDir(), `.tmp-${gameId}-${hash}${ext}`)
  writeFileSync(tempPath, bytes)
  try {
    renameSync(tempPath, targetPath)
  } catch (err) {
    rmSync(tempPath, { force: true })
    throw err
  }
  return targetPath
}

/**
 * Removes every managed cover belonging to a game.
 *
 * Matches on the `<gameId>-` filename prefix. Failures are swallowed: a locked
 * image file must not prevent the game from being deleted, and the leftover is
 * a few hundred KB of dead space rather than a correctness problem.
 */
export function deleteCoversForGame(gameId: number): void {
  const coversDir = getCoversDir()
  const prefix = `${gameId}-`
  // Also sweeps `.tmp-<id>-…` left by a download interrupted before its rename.
  const tempPrefix = `.tmp-${gameId}-`
  try {
    for (const entry of readdirSync(coversDir)) {
      if (entry.startsWith(prefix) || entry.startsWith(tempPrefix)) {
        try {
          rmSync(join(coversDir, entry), { force: true })
        } catch {
          // Leftover file; not worth failing the delete over.
        }
      }
    }
  } catch {
    // Covers directory missing entirely -- nothing to clean up.
  }
}
