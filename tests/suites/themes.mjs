/**
 * Colour themes: the picker, persistence, and the mechanism itself.
 *
 * The interesting assertions here are not "does the attribute change" but "does
 * the pixel change". A theme that sets `data-theme` correctly while every
 * utility keeps its previous colour is a passing attribute test and a broken
 * feature -- and that failure mode is entirely plausible. It is what happens if
 * Tailwind ever inlines theme values instead of emitting var() references, or
 * if the override blocks land in a cascade layer that loses to `:root`.
 *
 * So every check here reads getComputedStyle and compares real rgb() output.
 */
export const name = 'themes'

const HELPERS = `
window.__theme = () => document.documentElement.dataset.theme;
window.__bg = () => getComputedStyle(document.body).backgroundColor;
window.__token = (n, el) => getComputedStyle(el || document.documentElement).getPropertyValue(n).trim();
window.__swatch = (id) => document.querySelector('[data-testid=theme-' + id + ']');
window.__nav = (label) => [...document.querySelectorAll('button')].find(b => ((b.getAttribute('aria-label') || '') + ' ' + b.innerText).toLowerCase().includes(label));
'ready'`

const TOKENS = [
  '--color-surface-950',
  '--color-surface-900',
  '--color-surface-850',
  '--color-surface-800',
  '--color-surface-700',
  '--color-surface-600',
  '--color-content-100',
  '--color-content-200',
  '--color-content-300',
  '--color-content-400',
  '--color-content-500',
  '--color-content-600',
  '--color-content-700',
  '--color-accent-400',
  '--color-accent-500',
  '--color-accent-600'
]

const THEMES = [
  ['dark', 'Midnight'],
  ['nebula', 'Nebula'],
  ['ember', 'Ember'],
  ['verdant', 'Verdant']
]

export async function run({ ev, reload, text, check, section, app, delay, restart }) {
  const setup = () => ev(HELPERS)
  let client = { ev, text }

  await reload()
  await setup()
  await delay(500)

  section('The default')
  const initial = await ev('window.__theme()')
  check('a theme is always declared on <html>', initial === 'dark', initial)
  const darkBg = await ev('window.__bg()')
  check('body paints the dark surface', darkBg === 'rgb(11, 15, 25)', darkBg)

  /*
   * The @theme block and the [data-theme='dark'] block hold the same sixteen
   * values in two places. That is unavoidable: @theme has to declare every token
   * or Tailwind generates no utility for it, while a nested swatch needs a
   * selector it can reset to. This is the check that keeps the copies honest --
   * the comment in index.css promises it exists.
   */
  section('The two copies of the default palette agree')
  const drift = await ev(
    `(() => {
      const names = ${JSON.stringify(TOKENS)};
      const root = document.documentElement;
      const previous = root.dataset.theme;
      delete root.dataset.theme;
      const fallback = names.map(n => getComputedStyle(root).getPropertyValue(n).trim());
      root.dataset.theme = 'dark';
      const explicit = names.map(n => getComputedStyle(root).getPropertyValue(n).trim());
      if (previous === undefined) { delete root.dataset.theme; } else { root.dataset.theme = previous; }
      return names.filter((n, i) => fallback[i] !== explicit[i]);
    })()`
  )
  check(
    'every @theme default matches its [data-theme=dark] counterpart',
    Array.isArray(drift) && drift.length === 0,
    drift
  )

  section('The picker is on the settings screen')
  await ev("window.__nav('settings')?.click()")
  await delay(700)
  await setup()
  const settingsText = await text()
  check('an Appearance section exists', /appearance/i.test(settingsText), settingsText.slice(0, 160))
  for (const [id, label] of THEMES) {
    check(`${label} is offered`, (await ev(`!!window.__swatch('${id}')`)) === true)
  }
  check('the active theme is stated in words, not only by a ring', /active/i.test(settingsText))
  check(
    'the active swatch is marked for assistive tech too',
    (await ev("window.__swatch('dark')?.getAttribute('aria-pressed')")) === 'true'
  )

  /*
   * Each swatch previews its own palette by nesting `data-theme`. That works
   * only because the override selector is unanchored: `:root[data-theme=...]`
   * matches <html> alone, so every preview would silently render in the ACTIVE
   * theme and the picker would show four identical boxes.
   */
  section('Swatches paint themselves, not the active theme')
  const swatchColours = await ev(
    `(() => ['dark','nebula','ember','verdant'].map(id => {
      const preview = window.__swatch(id).querySelector('[data-theme]');
      return getComputedStyle(preview).backgroundColor;
    }))()`
  )
  check('all four previews differ from each other', new Set(swatchColours).size === 4, swatchColours)

  section('Choosing a theme repaints the app')
  await ev("window.__swatch('nebula').click()")
  await delay(900)
  await setup()
  check('the attribute follows the choice', (await ev('window.__theme()')) === 'nebula')
  const nebulaBg = await ev('window.__bg()')
  check('the body colour actually changed', nebulaBg !== darkBg, `${darkBg} -> ${nebulaBg}`)
  check('and is the nebula surface', nebulaBg === 'rgb(12, 12, 16)', nebulaBg)
  const accent = await ev("window.__token('--color-accent-500')")
  check('the accent hue changed too', accent === '#8b5cf6', accent)
  check('the new choice is marked active', /active/i.test(await text()))

  section('It survives a reload')
  await reload()
  await setup()
  await delay(600)
  check('still nebula after a reload', (await ev('window.__theme()')) === 'nebula')
  check('and still painted that way', (await ev('window.__bg()')) === 'rgb(12, 12, 16)')

  section('It survives a restart, because it is in the database')
  const stored = app.withDb((db) =>
    db.prepare("SELECT value FROM settings WHERE key='theme'").get()?.value
  )
  check('the row is written, not just held in the store', stored === 'nebula', stored)

  client = await restart()
  await client.ev(HELPERS)
  await delay(600)
  check('still nebula after a restart', (await client.ev('window.__theme()')) === 'nebula')

  section('Unknown themes are refused rather than stored')
  for (const bad of ["'light'", "'midnight'", "''", '42', 'null']) {
    const result = await client.ev(`window.api.settings.update({theme: ${bad}})`)
    check(
      `rejects ${bad}`,
      result?.ok === false && /unknown theme/i.test(result.error ?? ''),
      result
    )
  }
  check(
    'a refused theme leaves the stored one untouched',
    (await client.ev('window.api.settings.get()'))?.data?.theme === 'nebula'
  )
  check('and the app is still painted with it', (await client.ev('window.__bg()')) === 'rgb(12, 12, 16)')

  section('Every theme in the contract actually paints')
  const painted = await client.ev(
    `(async () => {
      const seen = {};
      for (const id of ['dark','nebula','ember','verdant']) {
        const r = await window.api.settings.update({ theme: id });
        if (!r.ok) return { error: id + ': ' + r.error };
        document.documentElement.dataset.theme = id;
        seen[id] = getComputedStyle(document.body).backgroundColor;
      }
      return seen;
    })()`
  )
  check('all four were accepted by main', painted?.error === undefined, painted)
  check(
    'and all four produce a distinct background',
    new Set(Object.values(painted ?? {})).size === 4,
    painted
  )
}
