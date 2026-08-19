import { BrowserWindow } from 'electron'

/**
 * Sends an event to every open window.
 *
 * Broadcast rather than reply-to-sender because these events are not responses
 * to anything: a game exits, or an automatic backup finishes, on their own
 * schedule. By then the window that triggered the work may have reloaded, so
 * its `webContents` id would be stale. There is normally exactly one window;
 * iterating keeps this correct if that ever changes.
 *
 * Destroyed windows are skipped -- sending to one throws.
 */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
