/**
 * The add/edit/delete form, driven through the real React components.
 *
 * Selectors are scoped to `[role=dialog]` throughout. Two collisions make that
 * necessary: the page header's "+ Add game" button also contains the text
 * "Add game", and the library's search box is the first <input> in the document,
 * ahead of the modal's fields.
 */
export const name = 'games-ui'

/**
 * React tracks input values internally, so assigning `.value` is discarded on
 * the next render. Going through the native setter and firing `input` is what
 * React's onChange actually listens for.
 */
const HELPERS = `
window.__set = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
window.__dlg = () => document.querySelector('[role=dialog]');
window.__dlgBtn = (t) => [...(window.__dlg()?.querySelectorAll('button') || [])].find(b => b.innerText.trim() === t);
window.__pageBtn = (t) => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === t);
window.__dlgInputs = () => [...(window.__dlg()?.querySelectorAll('input') || [])];
window.__search = () => [...document.querySelectorAll('input')].find(i => i.placeholder === 'Search…');
'ready'`

export async function run({ ev, send, reload, text, check, section, fixtures, delay }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const setup = () => ev(HELPERS)

  await reload()
  await setup()

  section('Empty state')
  let rendered = await text()
  check('empty library prompt shown', /library is empty/i.test(rendered), rendered.slice(0, 120))
  check('primary call to action offered', /Add your first game/i.test(rendered))

  section('Add dialog')
  await ev("[...document.querySelectorAll('button')].find(b => /Add your first game/.test(b.innerText))?.click()")
  await delay(700)
  await setup()
  check('dialog opened', (await ev('!!window.__dlg()')) === true)
  check('dialog is labelled', (await ev("window.__dlg()?.getAttribute('aria-label')")) === 'Add game')
  check('submit disabled while empty', (await ev("window.__dlgBtn('Add game')?.disabled")) === true)
  check('name field takes focus', (await ev('document.activeElement === window.__dlgInputs()[0]')) === true)

  section('Filling the form')
  await ev("window.__set(window.__dlgInputs()[0], 'Celeste')")
  await ev(`window.__set(window.__dlgInputs()[1], '${exe}')`)
  await delay(300)
  check('submit enables once required fields are set', (await ev("window.__dlgBtn('Add game')?.disabled")) === false)

  section('Submitting through Redux')
  await ev("window.__dlgBtn('Add game').click()")
  await delay(1400)
  await setup()
  check('dialog closed on success', (await ev('!!window.__dlg()')) === false)
  rendered = await text()
  check('game appears without a reload', /Celeste/.test(rendered), rendered.slice(0, 200))
  check('count updated', /1 game\b/.test(rendered), rendered.slice(0, 160))
  check('never-played state rendered', /Never played/.test(rendered))

  section('A validation error keeps the user’s input')
  await ev("window.__pageBtn('+ Add game').click()")
  await delay(600)
  await setup()
  await ev("window.__set(window.__dlgInputs()[0], 'Bogus')")
  await ev(`window.__set(window.__dlgInputs()[1], '${exe}.missing')`)
  await delay(300)
  await ev("window.__dlgBtn('Add game').click()")
  await delay(1200)
  await setup()
  check('dialog stays open on error', (await ev('!!window.__dlg()')) === true)
  const errorText = await ev("window.__dlg()?.innerText || ''")
  check('the real reason is shown', /not found/i.test(errorText), errorText.slice(-160))
  check('typed input preserved', (await ev('window.__dlgInputs()[0]?.value')) === 'Bogus')
  check('no phantom game created', !/Bogus/.test(await text()))
  await ev("window.__dlgBtn('Cancel').click()")
  await delay(400)

  section('Duplicate executable warns without blocking')
  await ev("window.__pageBtn('+ Add game').click()")
  await delay(600)
  await setup()
  await ev(`window.__set(window.__dlgInputs()[1], '${exe}')`)
  await delay(400)
  check(
    'warns that another entry uses this exe',
    /already uses this executable/i.test(await ev("window.__dlg()?.innerText || ''"))
  )
  await ev("window.__dlgBtn('Cancel').click()")
  await delay(400)

  section('Escape dismisses')
  await ev("window.__pageBtn('+ Add game').click()")
  await delay(500)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(500)
  await setup()
  check('Escape closes the dialog', (await ev('!!window.__dlg()')) === false)

  section('Edit')
  await ev(`document.querySelector('[aria-label^="Edit game"]')?.click()`)
  await delay(700)
  await setup()
  check('edit dialog opened', (await ev("window.__dlg()?.getAttribute('aria-label')")) === 'Edit game')
  check('prefilled with the name', (await ev('window.__dlgInputs()[0]?.value')) === 'Celeste')
  check('prefilled with the executable', /game\.cmd$/.test(await ev('window.__dlgInputs()[1]?.value')))
  await ev("window.__set(window.__dlgInputs()[0], 'Celeste: Farewell')")
  await delay(200)
  await ev("window.__dlgBtn('Save changes').click()")
  await delay(1200)
  await setup()
  check('rename reflected in the grid', /Celeste: Farewell/.test(await text()))

  section('Search')
  await ev("window.__set(window.__search(), 'zzz')")
  await delay(400)
  check('no-match message shown', /No games match/.test(await text()))
  await ev("window.__set(window.__search(), '')")
  await delay(300)

  section('List view')
  await ev(`document.querySelector('[aria-label="list view"]')?.click()`)
  await delay(400)
  check('list view shows the executable path', /game\.cmd/.test(await text()))
  await ev(`document.querySelector('[aria-label="grid view"]')?.click()`)
  await delay(300)

  section('Delete defaults to keeping backups')
  await setup()
  await ev(`document.querySelector('[aria-label^="Delete game"]')?.click()`)
  await delay(700)
  await setup()
  const deleteText = await ev("window.__dlg()?.innerText || ''")
  check('explains the game stays installed', /stays installed/i.test(deleteText), deleteText.slice(0, 200))
  check(
    'backups kept by default',
    (await ev("window.__dlg()?.querySelector('input[type=checkbox]')?.checked")) === false
  )
  await ev("window.__dlg().querySelector('input[type=checkbox]').click()")
  await delay(300)
  check(
    'checking it warns the action is irreversible',
    /cannot be undone/i.test(await ev("window.__dlg()?.innerText || ''"))
  )
  await ev("window.__dlg().querySelector('input[type=checkbox]').click()")
  await delay(200)
  await ev("window.__dlgBtn('Delete game').click()")
  await delay(1500)
  rendered = await text()
  check('game removed from the grid', !/Celeste/.test(rendered))
  check('back to the empty state', /library is empty/i.test(rendered))

  /*
   * Cover art at card size is 80-128px wide. Real box art carries a title and
   * often small print that is simply unreadable at that scale, so it has to be
   * openable. And a placeholder with no words is ambiguous — it reads equally
   * as "this game has no art" and as "the art failed to load".
   */
  section('Missing artwork says so, present artwork can be opened')

  const noArt = await ev(
    `window.api.games.create({name:'Artless', executablePath:'${exe}'})`
  )
  check('a game with no cover was created', noArt?.ok === true, noArt)
  await reload()
  await setup()
  await delay(600)

  check(
    'the card names the empty state rather than only drawing a glyph',
    (await ev('!!document.querySelector("[data-testid=no-cover]")')) === true
  )
  check('and says it in words', /No cover/i.test(await text()))

  await ev(`window.__pageBtn('Artless') ? null : null`)
  // Open the edit dialog through the card's own control.
  await ev(`document.querySelector('[aria-label^="Edit game"]')?.click()`)
  await delay(500)
  const artlessDialog = await ev("window.__dlg()?.innerText || ''")
  check(
    'the form spells out that there is no cover',
    /No cover image/i.test(artlessDialog),
    artlessDialog.slice(0, 400)
  )
  check(
    'and offers no "view" action for artwork that does not exist',
    (await ev(`!window.__dlgBtn('View full size')`)) === true
  )
  await ev("window.__dlgBtn('Cancel').click()")
  await delay(400)

  section('A cover can be opened full size, and closing it keeps the form')

  const withArt = await ev(
    `window.api.games.update(${noArt?.data?.id}, { coverImagePath: '${fixtures.posix(fixtures.coverPng)}' })`
  )
  check('a cover was attached', withArt?.ok === true, withArt)
  await reload()
  await setup()
  await delay(600)

  check(
    'the card no longer reports a missing cover',
    (await ev('!!document.querySelector("[data-testid=no-cover]")')) === false
  )

  await ev(`document.querySelector('[aria-label^="Edit game"]')?.click()`)
  await delay(500)
  check('the form offers to view it', (await ev(`!!window.__dlgBtn('View full size')`)) === true)

  await ev("window.__dlgBtn('View full size').click()")
  await delay(400)
  check(
    'the viewer opened',
    (await ev(`!!document.querySelector('[aria-label^="Cover image for"]')`)) === true
  )
  check(
    'it renders the image at full size, not cropped to a card',
    (await ev(`!!document.querySelector('[aria-label^="Cover image for"] img')`)) === true
  )

  // The viewer sits above the form and both listen for Escape on document. One
  // keypress must dismiss only the viewer, or the user loses everything typed.
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await delay(400)
  check(
    'Escape closed the viewer',
    (await ev(`!document.querySelector('[aria-label^="Cover image for"]')`)) === true
  )
  check('the form underneath survived', (await ev('!!window.__dlg()')) === true)

  await ev("window.__dlgBtn('Cancel').click()")
  await delay(300)
}
