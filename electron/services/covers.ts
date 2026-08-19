import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
  try {
    for (const entry of readdirSync(coversDir)) {
      if (entry.startsWith(prefix)) {
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
