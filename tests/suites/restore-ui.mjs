/**
 * The restore confirmation flow.
 *
 * The confirmation IS the safety mechanism, so these assertions are about
 * informed consent: does it name the folder it will overwrite, does it say what
 * will be lost, does it promise the undo before the user commits, and does it
 * refuse while the game is running.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'restore-ui'

const HELPERS = `
window.__set = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
window.__dlg = () => document.querySelector('[role=dialog]');
window.__dlgBtn = (t) => [...(window.__dlg()?.querySelectorAll('button') || [])].find(b => b.innerText.trim() === t);
window.__dlgText = () => window.__dlg()?.innerText || '';
'ready'`

export async function run({ ev, reload, check, section, fixtures, app, delay }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const saveDir = fixtures.saveFolder('restore-ui-saves', { 'slot.sav': 'OLD-STATE' })
  const readSave = () =>
    existsSync(join(saveDir, 'slot.sav')) ? readFileSync(join(saveDir, 'slot.sav'), 'utf8') : null
  const setup = () => ev(HELPERS)

  app.setSetting('min_session_seconds', 1)

  const stop = fixtures.stopFile('ruistop')
  const made = await ev(
    `window.api.games.create({name:'Restore UI', executablePath:'${exe}', saveFolderPath:'${fixtures.posix(saveDir)}', launchArgs:'"${fixtures.posix(stop)}" 0'})`
  )
  const gameId = made?.data?.id
  await ev(`window.api.saves.backupNow(${gameId})`)
  writeFileSync(join(saveDir, 'slot.sav'), 'NEW-STATE')

  await reload()
  await setup()

  section('Opening backup history from the card')
  await ev(`document.querySelector('[aria-label="Save backups for Restore UI"]').click()`)
  await delay(1200)
  await setup()
  check('history dialog opened', (await ev('!!window.__dlg()')) === true)
  let dialogText = await ev('window.__dlgText()')
  check('shows the save folder path', /restore-ui-saves/.test(dialogText), dialogText.slice(0, 200))
  // innerText applies text-transform, so the badge reads "MANUAL".
  check('snapshot listed with its trigger', /manual/i.test(dialogText))
  check('shows size and file count', /1 file/.test(dialogText))
  check('Restore offered', (await ev("!!window.__dlgBtn('Restore')")) === true)

  section('The confirmation is informed consent')
  await ev("window.__dlgBtn('Restore').click()")
  await delay(800)
  await setup()
  dialogText = await ev('window.__dlgText()')
  check('names the exact folder being overwritten', /restore-ui-saves/.test(dialogText), dialogText.slice(0, 400))
  check('warns newer files will be lost', /will be gone|replaced/i.test(dialogText))
  check('promises the undo snapshot up front', /Before restore/i.test(dialogText) && /undone/i.test(dialogText))
  check('confirm disabled until the word is typed', (await ev("window.__dlgBtn('Restore saves')?.disabled")) === true)

  await ev(`window.__set(window.__dlg().querySelector('[aria-label="Restore confirmation"]'), 'wrong')`)
  await delay(300)
  check('a wrong word keeps it disabled', (await ev("window.__dlgBtn('Restore saves')?.disabled")) === true)

  await ev(`window.__set(window.__dlg().querySelector('[aria-label="Restore confirmation"]'), 'restore')`)
  await delay(300)
  check('the correct word enables it', (await ev("window.__dlgBtn('Restore saves')?.disabled")) === false)

  section('Performing the restore')
  check('saves are still the new state before confirming', readSave() === 'NEW-STATE')
  await ev("window.__dlgBtn('Restore saves').click()")
  await delay(3000)
  await setup()
  check('files actually rolled back on disk', readSave() === 'OLD-STATE', readSave())
  dialogText = await ev('window.__dlgText()')
  check('success view shown', /Saves restored/i.test(dialogText), dialogText.slice(0, 300))
  check('it points at the undo snapshot', /pinned/i.test(dialogText) && /undo/i.test(dialogText))
  await ev("window.__dlgBtn('Done').click()")
  await delay(500)

  section('The undo snapshot is listed and pinned')
  await setup()
  await ev(`document.querySelector('[aria-label="Save backups for Restore UI"]').click()`)
  await delay(1200)
  await setup()
  dialogText = await ev('window.__dlgText()')
  check('the pre_restore snapshot appears', /Before restore/i.test(dialogText), dialogText.slice(0, 400))
  check('marked pinned', /Pinned/i.test(dialogText))
  await ev("window.__dlgBtn('Close').click()")
  await delay(400)

  section('A running game blocks restore in the UI too')
  await ev(`window.api.sessions.launch(${gameId})`)
  await delay(1500)
  await setup()
  await ev(`document.querySelector('[aria-label="Save backups for Restore UI"]').click()`)
  await delay(1000)
  await setup()
  await ev("window.__dlgBtn('Restore').click()")
  await delay(800)
  await setup()
  dialogText = await ev('window.__dlgText()')
  check('the dialog warns the game is running', /is running/i.test(dialogText), dialogText.slice(0, 400))
  check('confirm stays disabled', (await ev("window.__dlgBtn('Restore saves')?.disabled")) === true)
  check(
    'the confirmation input is disabled too',
    (await ev(`window.__dlg().querySelector('[aria-label="Restore confirmation"]')?.disabled`)) === true
  )
  fixtures.stop('ruistop')
  await delay(3000)
}
