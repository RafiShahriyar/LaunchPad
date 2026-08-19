import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const r = (p: string) => resolve(__dirname, p)

/**
 * Injects a strict Content-Security-Policy into index.html for production
 * builds only.
 *
 * It cannot live in index.html directly: the Vite dev server injects an inline
 * react-refresh preamble script, which `script-src 'self'` would block, killing
 * hot reload. It also cannot be an HTTP header, because the packaged app loads
 * the renderer over file:// where response headers do not exist. A build-time
 * meta tag is the one mechanism that covers the shipped app.
 */
function injectCsp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // Tailwind ships a real stylesheet, but React still sets inline style
    // attributes, which style-src governs.
    "style-src 'self' 'unsafe-inline'",
    // Cover art is served by the lpasset:// handler in
    // electron/services/assetProtocol.ts, which is confined to the covers folder.
    "img-src 'self' data: lpasset:",
    "font-src 'self' data:",
    // The renderer must never open a socket of its own; all I/O goes via IPC.
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  return {
    name: 'launchpad:inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${policy}" />
  </head>`
      )
    }
  }
}

export default defineConfig({
  // ---------------------------------------------------------------------------
  // MAIN PROCESS — Node environment. Owns the DB, filesystem and child processes.
  // externalizeDepsPlugin() keeps `dependencies` (better-sqlite3) out of the
  // bundle: native .node addons cannot be bundled by rollup, they must be
  // require()'d at runtime from node_modules.
  // ---------------------------------------------------------------------------
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@db': r('db'), '@shared': r('shared') }
    },
    build: {
      outDir: 'out/main',
      lib: { entry: r('electron/main.ts') },
      rollupOptions: { output: { entryFileNames: 'index.js' } }
    }
  },

  // ---------------------------------------------------------------------------
  // PRELOAD — the only bridge between main and renderer. Emitted as CommonJS
  // (see the note in package.json about not setting "type": "module") because
  // ESM preload scripts require sandbox:false and a .mjs extension.
  // ---------------------------------------------------------------------------
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('shared') }
    },
    build: {
      outDir: 'out/preload',
      lib: { entry: r('electron/preload.ts') },
      rollupOptions: { output: { entryFileNames: 'index.js' } }
    }
  },

  // ---------------------------------------------------------------------------
  // RENDERER — plain browser environment. No Node APIs available at all.
  // ---------------------------------------------------------------------------
  renderer: {
    root: '.',
    resolve: {
      alias: { '@': r('src'), '@shared': r('shared') }
    },
    plugins: [react(), tailwindcss(), injectCsp()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: r('index.html') }
    }
  }
})
