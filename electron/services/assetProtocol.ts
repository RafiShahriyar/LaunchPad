import { net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCoversDir } from './covers'

/**
 * Serves cover images to the renderer over a custom `lpasset://` scheme.
 *
 * Why a protocol at all: the renderer cannot load `file://` URLs. In dev it is
 * served from `http://localhost:5173`, and Chromium blocks file:// subresources
 * from an http origin regardless of CSP. Loading covers as base64 data URLs
 * would work but puts the full bytes of every image into IPC payloads and into
 * Redux state, which is wasteful for something the browser can stream and cache.
 *
 * Why it is safe: the handler resolves the requested name against the covers
 * directory and refuses anything that escapes it. A request for
 * `lpasset://cover/..%2F..%2Fid_rsa` resolves outside the directory and is
 * rejected with 403. Only the basename is ever used, so nested paths cannot be
 * expressed in the first place.
 *
 * URL shape: `lpasset://cover/<filename>`
 */

const SCHEME = 'lpasset'

/**
 * Must be called BEFORE app.whenReady().
 *
 * `standard` makes the scheme URL-parseable with a host component; `secure`
 * stops Chromium treating it as mixed content on the https-like renderer origin;
 * `supportFetchAPI` and `stream` let Electron's net module serve it efficiently.
 */
export function registerAssetSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Must be called AFTER app.whenReady(). */
export function registerAssetProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (url.hostname !== 'cover') {
      return new Response('Unknown asset namespace', { status: 404 })
    }

    // decodeURIComponent + basename together defeat traversal: any directory
    // separators or `..` segments are stripped before the join.
    let requested: string
    try {
      requested = basename(decodeURIComponent(url.pathname))
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (!requested || requested === '.' || requested === '..') {
      return new Response('Not found', { status: 404 })
    }

    const coversDir = resolve(getCoversDir())
    const filePath = resolve(join(coversDir, requested))

    // Defence in depth: even after basename(), verify containment explicitly.
    if (!filePath.startsWith(coversDir)) {
      return new Response('Forbidden', { status: 403 })
    }

    if (!existsSync(filePath)) {
      return new Response('Not found', { status: 404 })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  })
}
