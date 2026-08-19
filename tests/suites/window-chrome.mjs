/**
 * Custom title bar, window controls and fullscreen.
 *
 * The hover assertions are the reason these controls are DOM elements rather
 * than the native overlay ones: Chromium owns the overlay buttons' hover
 * rendering, which can be neither restyled nor inspected. Here it is CSS, so a
 * test can move the real pointer and read the computed background.
 */
export const name = 'window-chrome'

const TAP = `
window.__wstate = [];
if (!window.__wtapped) {
  window.__wtapped = true;
  window.api.window.onStateChanged(s => window.__wstate.push(s));
}
window.__bar = () => document.querySelector('.titlebar-drag');
'ready'`

export async function run({ ev, send, key, hover, unhover, styleOf, reload, check, section, delay }) {
  await ev(TAP)

  section('No Window Controls Overlay: the page draws its own')
  check(
    'the overlay is not in use',
    (await ev('!!navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible')) === false
  )
  const barWidth = await ev('Math.round(window.__bar().getBoundingClientRect().width)')
  check('the bar spans the full window width', barWidth === (await ev('window.innerWidth')), barWidth)
  check('three controls rendered by the page', (await ev("document.querySelectorAll('[data-window-control]').length")) === 3)

  section('The bar is dark chrome, not a system-coloured strip')
  check('bar uses surface-950', (await styleOf('.titlebar-drag', 'backgroundColor')) === 'rgb(7, 10, 18)')
  check('bar is 34px', (await ev('Math.round(window.__bar().getBoundingClientRect().height)')) === 34)
  check('bar is draggable', (await styleOf('.titlebar-drag', 'webkitAppRegion')) === 'drag')
  check(
    'content starts below the bar',
    (await ev("Math.round(document.querySelector('aside').getBoundingClientRect().top)")) === 34
  )

  section('Hover feedback — the whole reason these are DOM elements')
  await unhover()
  const restMin = await styleOf('[data-window-control="minimize"]', 'backgroundColor')
  const restClose = await styleOf('[data-window-control="close"]', 'backgroundColor')
  check('minimize rests transparent', restMin === 'rgba(0, 0, 0, 0)', restMin)

  await hover('[data-window-control="minimize"]')
  const hoverMin = await styleOf('[data-window-control="minimize"]', 'backgroundColor')
  check('minimize gains a background on hover', hoverMin !== restMin && hoverMin !== 'rgba(0, 0, 0, 0)', {
    rest: restMin,
    hover: hoverMin
  })

  await hover('[data-window-control="maximize"]')
  const hoverMax = await styleOf('[data-window-control="maximize"]', 'backgroundColor')
  check('maximize gains a background on hover', hoverMax !== 'rgba(0, 0, 0, 0)', hoverMax)
  check('minimize returns to rest when the pointer leaves', (await styleOf('[data-window-control="minimize"]', 'backgroundColor')) === restMin)

  await hover('[data-window-control="close"]')
  const hoverClose = await styleOf('[data-window-control="close"]', 'backgroundColor')
  // Tailwind v4 emits oklch(); what matters is that close differs from the
  // neutral fill the other two use.
  check('close turns red, distinct from the neutral hover', hoverClose !== restClose && hoverClose !== hoverMax, {
    rest: restClose,
    hover: hoverClose,
    neutral: hoverMax
  })
  await unhover()

  section('Controls stay clickable inside the drag region')
  check(
    'controls opt out of dragging',
    (await ev(`getComputedStyle(document.querySelector('[data-window-control="close"]').parentElement).webkitAppRegion`)) === 'no-drag'
  )
  const fsRight = await ev(
    `Math.round(document.querySelector('[aria-label="Enter fullscreen"]').getBoundingClientRect().right)`
  )
  const minLeft = await ev(
    `Math.round(document.querySelector('[data-window-control="minimize"]').getBoundingClientRect().left)`
  )
  check('the fullscreen button sits left of the controls', fsRight <= minLeft, { fsRight, minLeft })

  section('Maximize toggles, and the glyph follows')
  await ev(`document.querySelector('[data-window-control="maximize"]').click()`)
  await delay(1200)
  check('window reports maximized', (await ev('window.api.window.getState()'))?.data?.isMaximized === true)
  check(
    'the button relabels to Restore',
    (await ev(`document.querySelector('[data-window-control="restore"]')?.getAttribute('aria-label')`)) === 'Restore'
  )
  await ev(`document.querySelector('[data-window-control="restore"]').click()`)
  await delay(1200)
  check('window restored', (await ev('window.api.window.getState()'))?.data?.isMaximized === false)

  section('Fullscreen')
  await ev('window.__wstate = []')
  await ev(`document.querySelector('[aria-label="Enter fullscreen"]').click()`)
  await delay(1500)
  check('window reports fullscreen', (await ev('window.api.window.getState()'))?.data?.isFullScreen === true)
  // The push must carry the state being entered. On Windows
  // 'enter-full-screen' fires BEFORE isFullScreen() flips, so a handler that
  // re-read the window would broadcast the state it was leaving.
  check('the pushed state is correct, not one transition behind', (await ev('window.__wstate.some(s => s.isFullScreen)')) === true)
  check('the title bar unmounts', (await ev('!!window.__bar()')) === false)
  check('an exit affordance is shown', (await ev(`!!document.querySelector('[aria-label="Exit fullscreen"]')`)) === true)
  check('the app uses the full height', (await ev("Math.round(document.querySelector('aside').getBoundingClientRect().top)")) === 0)

  await ev(`document.querySelector('[aria-label="Exit fullscreen"]').click()`)
  await delay(1500)
  check('back to windowed', (await ev('window.api.window.getState()'))?.data?.isFullScreen === false)
  check('the title bar is restored', (await ev('!!window.__bar()')) === true)

  section('Keyboard')
  await key('F11')
  await delay(1500)
  check('F11 enters fullscreen', (await ev('window.api.window.getState()'))?.data?.isFullScreen === true)
  await key('Escape')
  await delay(1500)
  check('Escape leaves fullscreen', (await ev('window.api.window.getState()'))?.data?.isFullScreen === false)

  section('Escape still closes dialogs when windowed')
  await ev("[...document.querySelectorAll('button')].find(b => b.innerText.includes('Add game')).click()")
  await delay(700)
  check('dialog opened', (await ev("!!document.querySelector('[role=dialog]')")) === true)
  await key('Escape')
  await delay(700)
  check('Escape closed the dialog rather than being swallowed', (await ev("!!document.querySelector('[role=dialog]')")) === false)

  section('A reload re-syncs chrome state')
  await ev('window.api.window.setFullScreen(true)')
  await delay(1200)
  await reload()
  await ev(TAP)
  check('fullscreen survives the reload', (await ev(`!!document.querySelector('[aria-label="Exit fullscreen"]')`)) === true)
  check('no stale title bar', (await ev('!!window.__bar()')) === false)
  await ev('window.api.window.setFullScreen(false)')
  await delay(1000)
}
