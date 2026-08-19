import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/ipc'

/**
 * Wraps ipcMain.handle so that every handler returns an IpcResult envelope
 * instead of throwing across the process boundary.
 *
 * Why: when a handler throws, Electron rejects the renderer's promise with a
 * generic `Error: Error invoking remote method '...'` whose message is a
 * flattened string. Stack traces and any structured detail (e.g. "which file
 * was missing") are lost. Turning failures into data keeps them intact and
 * lets Redux thunks surface a real message to the UI.
 *
 * Handlers therefore never need their own try/catch for unexpected errors.
 */
/**
 * Validates a row id arriving from the renderer.
 *
 * TypeScript types the IPC contract, but types are erased at runtime and the
 * renderer is the untrusted side of the boundary: a bug there (or anything
 * injected into the page) can send whatever it likes. Without this, a bad id
 * reaches node:sqlite and surfaces as
 * "Provided value cannot be bound to SQLite parameter 1" -- an error that tells
 * the user nothing and points at the wrong layer.
 */
export function requireId(value: unknown, label = 'id'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value) ?? String(value)}`)
  }
  return value
}

export function handle<Args extends unknown[], Result>(
  channel: string,
  fn: (...args: Args) => Promise<Result> | Result
): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<Result>> => {
    try {
      return { ok: true, data: await fn(...(args as Args)) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} failed:`, err)
      return { ok: false, error }
    }
  })
}
