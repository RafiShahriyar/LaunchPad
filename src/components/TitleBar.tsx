import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  closeWindow,
  minimizeWindow,
  toggleFullScreen,
  toggleMaximizeWindow
} from '@/store/slices/uiSlice'

/**
 * The window's title bar: a dark drag strip plus our own window controls.
 *
 * It replaces the OS title bar, which on Windows is painted in the system light
 * colour and was by far the brightest thing above a very dark app. This is
 * `surface-950`, so it reads as chrome and recedes.
 *
 * The minimise/maximise/close buttons are real DOM elements rather than the
 * native overlay ones. See electron/ipc/window.ts for the trade-off; the
 * practical upshot here is that their hover states are ordinary CSS — tunable,
 * and verifiable by a test that hovers one and reads the computed background.
 *
 * Sizing follows the Windows convention (46x34, close turns red on hover) so it
 * feels native despite being drawn by us.
 *
 * In fullscreen there is nothing to drag and no controls to show, so the whole
 * bar unmounts and the app gets the entire screen.
 */
export function TitleBar() {
  const dispatch = useAppDispatch()
  const { isFullScreen, isMaximized, needsCustomControls } = useAppSelector(
    (state) => state.ui.window
  )

  if (isFullScreen) return null

  return (
    <header
      // `.titlebar-drag` makes the strip behave like a real title bar: drag to
      // move, double-click to maximise. Chromium handles both.
      className="titlebar-drag flex h-[34px] shrink-0 select-none items-center bg-surface-950"
      // macOS floats its traffic lights over the left of the bar, so leave room.
      style={needsCustomControls ? undefined : { paddingLeft: 78 }}
    >
      <div className="flex-1" />

      <button
        onClick={() => void dispatch(toggleFullScreen())}
        aria-label="Enter fullscreen"
        title="Fullscreen (F11)"
        className="titlebar-nodrag mr-1 grid h-[26px] w-[26px] place-items-center rounded text-slate-500 transition-colors hover:bg-surface-700 hover:text-slate-200"
      >
        <FullscreenIcon />
      </button>

      {needsCustomControls && (
        <div className="titlebar-nodrag flex items-stretch self-stretch">
          <ControlButton label="Minimize" onClick={() => void dispatch(minimizeWindow())}>
            {/* A single centred line — the Windows minimise glyph. */}
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
            </svg>
          </ControlButton>

          <ControlButton
            label={isMaximized ? 'Restore' : 'Maximize'}
            onClick={() => void dispatch(toggleMaximizeWindow())}
          >
            {isMaximized ? (
              // Two offset outlines, matching the system "restore down" glyph.
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" />
                <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
              </svg>
            )}
          </ControlButton>

          <ControlButton label="Close" danger onClick={() => void dispatch(closeWindow())}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
            </svg>
          </ControlButton>
        </div>
      )}
    </header>
  )
}

/**
 * One window control.
 *
 * 46px wide and full-height to match the Windows caption buttons, with no
 * rounding and no gap — the hover fill should reach the very corner of the
 * screen, which is what makes the close button easy to hit when maximised.
 */
function ControlButton({
  label,
  onClick,
  danger,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      data-window-control={label.toLowerCase()}
      className={`grid w-[46px] place-items-center text-slate-400 transition-colors ${
        danger
          ? 'hover:bg-red-600 hover:text-white active:bg-red-700'
          : 'hover:bg-surface-700 hover:text-slate-100 active:bg-surface-600'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Shown only in fullscreen: a small affordance to get back out.
 *
 * Without it the only exits are F11 and Escape, which are discoverable to
 * keyboard users and invisible to everyone else. It sits top-right, fades until
 * hovered, and stays out of the way.
 */
export function FullscreenExitButton() {
  const dispatch = useAppDispatch()
  const isFullScreen = useAppSelector((state) => state.ui.window.isFullScreen)

  if (!isFullScreen) return null

  return (
    <button
      onClick={() => void dispatch(toggleFullScreen())}
      aria-label="Exit fullscreen"
      title="Exit fullscreen (F11 or Esc)"
      className="fixed right-3 top-3 z-40 grid h-7 w-7 place-items-center rounded-md bg-surface-900/80 text-slate-500 opacity-30 backdrop-blur transition-all hover:bg-surface-800 hover:text-slate-200 hover:opacity-100 focus-visible:opacity-100"
    >
      <FullscreenExitIcon />
    </button>
  )
}

function FullscreenIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FullscreenExitIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 1v5H1M10 1v5h5M6 15v-5H1M10 15v-5h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
