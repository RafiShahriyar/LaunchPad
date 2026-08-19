/**
 * Malformed input from the renderer.
 *
 * TypeScript types the IPC contract, but types are erased at runtime and the
 * renderer is the untrusted side of the boundary. Without these guards a bad id
 * reaches node:sqlite and surfaces as "Provided value cannot be bound to SQLite
 * parameter 1" — an error that names the wrong layer and tells the user nothing.
 * That was a real bug; this suite is the regression net for it.
 */
export const name = 'ipc-validation'

const CASES = [
  ['undefined game id', 'window.api.sessions.launch(undefined)'],
  ['null game id', 'window.api.sessions.launch(null)'],
  ['string game id', 'window.api.sessions.launch("1; DROP TABLE games")'],
  ['negative game id', 'window.api.games.get(-5)'],
  ['fractional game id', 'window.api.games.get(1.5)'],
  ['object game id', 'window.api.sessions.getStats({})']
]

export async function run({ ev, check, section }) {
  section('Malformed ids produce a clear message, not a database error')
  for (const [label, expression] of CASES) {
    const result = await ev(expression)
    check(
      `${label} rejected clearly`,
      result?.ok === false && /invalid game id/i.test(result.error ?? ''),
      result
    )
  }

  const leak = await ev('window.api.sessions.launch(undefined)')
  check(
    'no raw SQLite error reaches the user',
    !/bound to SQLite parameter/i.test(leak?.error ?? ''),
    leak?.error
  )

  section('Handlers stay usable afterwards')
  check('a valid call still works', (await ev('window.api.games.list()'))?.ok === true)
}
