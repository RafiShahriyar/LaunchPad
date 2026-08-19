/**
 * Chrome DevTools Protocol client for driving a live Electron window.
 *
 * These suites test the real app rather than mounting components in isolation,
 * because most of what is worth testing here only exists across the process
 * boundary: IPC validation, push events, file copies, window chrome. A jsdom
 * render would exercise none of it.
 */
import { setTimeout as delay } from 'node:timers/promises'

const DEBUG_URL = 'http://127.0.0.1:9222'

/** Waits for the renderer's debugging target to appear after app launch. */
async function findPage(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`${DEBUG_URL}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // The app is still starting; the debug port is not listening yet.
    }
    await delay(300)
  }
  throw new Error('Renderer debug target never appeared')
}

export async function connect() {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('Could not open the DevTools socket'))
  })

  let nextId = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  }

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  /**
   * Evaluates an expression in the page and returns its value.
   *
   * `awaitPromise` matters: nearly every call here is an IPC round trip, and
   * without it the test would see a pending Promise rather than the result.
   */
  const ev = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (response.result?.exceptionDetails) {
      return { __threw: response.result.exceptionDetails.text }
    }
    return response.result?.result?.value
  }

  /**
   * Moves the real pointer over an element's centre so `:hover` applies.
   *
   * Setting a class or calling `.focus()` would not do: hover styling is what
   * is under test, and only a genuine mouse move produces it.
   */
  const hover = async (selector) => {
    const box = await ev(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`)
    if (!box) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box, buttons: 0 })
    await delay(300)
    return true
  }

  /** Parks the pointer away from any control, to read a resting style. */
  const unhover = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 500, buttons: 0 })
    await delay(250)
  }

  /**
   * `nativeVirtualKeyCode` is not optional here. Keys handled in the renderer
   * (Escape closing a dialog) work without it, but keys handled by main's
   * `before-input-event` — F11 — do not see the event unless the native code is
   * set as well.
   */
  const key = async (name, code) => {
    const virtualKeyCode = KEY_CODES[name] ?? 0
    const params = {
      key: name,
      code: code ?? name,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode
    }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }

  const styleOf = (selector, property) =>
    ev(
      `getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`
    )

  /** Reloads and waits for the store to refill from IPC. */
  const reload = async () => {
    await ev('location.reload()')
    await delay(2500)
  }

  return {
    ev,
    send,
    hover,
    unhover,
    key,
    styleOf,
    reload,
    text: () => ev("document.getElementById('root')?.innerText ?? ''"),
    bodyText: () => ev('document.body.innerText'),
    close: () => ws.close()
  }
}

const KEY_CODES = { F11: 122, Escape: 27, Enter: 13 }

/**
 * Collects assertions for one suite.
 *
 * Deliberately not an assertion library that throws: a failing check should not
 * abort the rest of the suite, because the later checks usually explain *why*
 * the first one failed.
 */
export function createRecorder(suiteName) {
  const failures = []
  let passed = 0

  return {
    section(title) {
      console.log(`\n  ${title}`)
    },
    check(label, condition, detail) {
      if (condition) {
        passed++
        console.log(`    ok   ${label}`)
      } else {
        failures.push(label)
        const extra = detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`
        console.log(`    FAIL ${label}${extra}`)
      }
    },
    result: () => ({ suite: suiteName, passed, failures })
  }
}
