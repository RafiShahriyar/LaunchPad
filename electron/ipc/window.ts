import { BrowserWindow } from 'electron'
import { Channels, type Platform, type WindowState } from '@shared/ipc'
import { broadcast } from './broadcast'
import { handle } from './handle'

/**
 * Window chrome: fullscreen, the minimise/maximise/close actions, and the state
 * the custom title bar renders from.
 *
 * The window uses `titleBarStyle: 'hidden'` with NO `titleBarOverlay`, so the
 * page draws its own controls on Windows and Linux.
 *
 * That is a reversal, and the reason is worth recording. The overlay approach
 * keeps the real system buttons — which preserves Snap Layouts, the hover
 * previews and the system menu — but Chromium owns their hover rendering
 * entirely, and on a near-black title bar that feedback was reported as
 * invisible. There is no API to restyle it, and it cannot be inspected from the
 * page, so it can be neither tuned nor tested.
 *
 * Drawing them here trades Snap Layouts for hover states that are ours to
 * control and, just as importantly, ours to verify: the buttons are real DOM
 * elements, so a test can hover one and assert the computed background.
 *
 * `titleBarStyle: 'hidden'` rather than `frame: false` keeps the OS resize
 * borders and drop shadow.
 *
 * macOS is unaffected — it keeps its traffic lights, floated over the page.
 */

/** macOS supplies its own traffic lights; every other platform needs ours. */
export function needsCustomControls(): boolean {
  return process.platform !== 'darwin'
}

export function readWindowState(window: BrowserWindow | null): WindowState {
  return {
    isFullScreen: window?.isFullScreen() ?? false,
    isMaximized: window?.isMaximized() ?? false,
    needsCustomControls: needsCustomControls(),
    platform: process.platform as Platform
  }
}

/**
 * Pushes the current state to every window.
 *
 * Needed because fullscreen and maximise can change without the renderer
 * asking: F11, the OS-level gesture, Aero Snap, or double-clicking the drag
 * region. Polling would be the alternative and it would lag the transition.
 *
 * `overrides` exists because of a real race. On Windows, `enter-full-screen`
 * fires BEFORE `isFullScreen()` flips, so a handler that simply re-reads the
 * window broadcasts the state it is leaving — every push arrives one transition
 * behind, and a renderer trusting it would render the exact inverse.
 *
 * The event name is unambiguous about what just happened, so callers pass it in
 * rather than asking the window to describe itself mid-transition.
 */
export function broadcastWindowState(
  window: BrowserWindow | null,
  overrides: Partial<WindowState> = {}
): void {
  broadcast(Channels.window.stateChanged, { ...readWindowState(window), ...overrides })
}

export function registerWindowHandlers(getWindow: () => BrowserWindow | null): void {
  handle(Channels.window.getState, (): WindowState => readWindowState(getWindow()))

  /*
   * Both fullscreen handlers return the state the window is transitioning TO,
   * not a fresh read. Same race as above: `isFullScreen()` may not have flipped
   * by the time this returns, and the caller asked for a specific outcome —
   * reporting anything else would be reporting a value about to be wrong.
   */
  handle(Channels.window.setFullScreen, (value: unknown): WindowState => {
    if (typeof value !== 'boolean') throw new Error('Expected a boolean')
    const window = getWindow()
    window?.setFullScreen(value)
    return { ...readWindowState(window), isFullScreen: value }
  })

  handle(Channels.window.toggleFullScreen, (): WindowState => {
    const window = getWindow()
    const target = !(window?.isFullScreen() ?? false)
    window?.setFullScreen(target)
    return { ...readWindowState(window), isFullScreen: target }
  })

  handle(Channels.window.minimize, (): null => {
    getWindow()?.minimize()
    return null
  })

  handle(Channels.window.toggleMaximize, (): WindowState => {
    const window = getWindow()
    if (!window) return readWindowState(null)

    const target = !window.isMaximized()
    if (target) window.maximize()
    else window.unmaximize()
    return { ...readWindowState(window), isMaximized: target }
  })

  /*
   * `close()` rather than `destroy()`: it runs the normal quit path, so
   * 'before-quit' still writes any open play sessions and 'will-quit' still
   * checkpoints and closes the database. destroy() would skip both.
   */
  handle(Channels.window.close, (): null => {
    getWindow()?.close()
    return null
  })
}
