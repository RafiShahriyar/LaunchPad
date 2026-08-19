import type { RendererApi } from '@shared/ipc'

/**
 * Teaches TypeScript about the object the preload script attaches to `window`.
 * Without this, every call site would need a cast, and the whole point of the
 * shared contract (compile-time errors when main and renderer disagree) is lost.
 */
declare global {
  interface Window {
    api: RendererApi
  }
}
