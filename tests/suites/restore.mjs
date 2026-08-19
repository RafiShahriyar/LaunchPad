/**
 * Restore: the only operation that destroys user data on purpose.
 *
 * The assertions worth reading are the ones about what does NOT happen — a
 * refused restore must leave the save folder byte-for-byte untouched, and the
 * undo snapshot must actually undo.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'restore'

export async function run({ ev, check, section, fixtures, app, delay }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const saveDir = fixtures.saveFolder('restore-saves', {
    'slot1.sav': 'STATE-A',
    'profile/cfg.ini': 'cfg-A'
  })
  const readSave = (file = 'slot1.sav') =>
    existsSync(join(saveDir, file)) ? readFileSync(join(saveDir, file), 'utf8') : null
  const listSaves = () => (existsSync(saveDir) ? readdirSync(saveDir).sort() : [])

  app.setSetting('min_session_seconds', 1)
  app.setSetting('max_backups_per_game', 20)

  section('Three distinct save states, each snapshotted')
  const stop = fixtures.stopFile('rstop')
  const made = await ev(
    `window.api.games.create({name:'Restore Game', executablePath:'${exe}', saveFolderPath:'${fixtures.posix(saveDir)}', launchArgs:'"${fixtures.posix(stop)}" 0'})`
  )
  const gameId = made?.data?.id
  const snapA = (await ev(`window.api.saves.backupNow(${gameId})`))?.data?.backup

  writeFileSync(join(saveDir, 'slot1.sav'), 'STATE-B')
  writeFileSync(join(saveDir, 'extra.sav'), 'ONLY-IN-B')
  const snapB = (await ev(`window.api.saves.backupNow(${gameId})`))?.data?.backup

  writeFileSync(join(saveDir, 'slot1.sav'), 'STATE-C')
  check('three states captured', snapA?.id > 0 && snapB?.id > snapA?.id, { a: snapA?.id, b: snapB?.id })
  check('current state is C', readSave() === 'STATE-C')

  section('Restore replaces the folder contents')
  let result = await ev(`window.api.saves.restore(${snapA.id})`)
  check('restore succeeded', result?.ok === true, result)
  check('content rolled back to A', readSave() === 'STATE-A', readSave())
  check('nested file restored', readFileSync(join(saveDir, 'profile', 'cfg.ini'), 'utf8') === 'cfg-A')
  check('the save folder was not recreated (it existed)', result?.data?.recreatedSaveFolder === false)

  section('The safety snapshot is the undo button')
  const safety = result?.data?.safetyBackup
  check('a safety backup was taken', safety?.id > 0, safety)
  check('tagged pre_restore', safety?.trigger === 'pre_restore')
  check('pinned, so rotation cannot remove it', safety?.isPinned === true)

  result = await ev(`window.api.saves.restore(${safety.id})`)
  check('restoring it undoes the restore', result?.ok === true, result)
  check('content is back to C', readSave() === 'STATE-C', readSave())

  section('Restore is a replacement, not a merge')
  writeFileSync(join(saveDir, 'brand-new.sav'), 'ADDED-LATER')
  await ev(`window.api.saves.restore(${snapA.id})`)
  check('files added after the snapshot are removed', !existsSync(join(saveDir, 'brand-new.sav')))
  check('files absent from the snapshot are removed', !existsSync(join(saveDir, 'extra.sav')))
  check(
    'what remains is exactly the snapshot',
    JSON.stringify(listSaves()) === JSON.stringify(['profile', 'slot1.sav']),
    listSaves()
  )

  await ev(`window.api.saves.restore(${snapB.id})`)
  check('restoring B brings its extra file back', readSave('extra.sav') === 'ONLY-IN-B')
  check('slot content matches B', readSave() === 'STATE-B')

  section('No staging folders are left behind')
  const staging = readdirSync(fixtures.root).filter((e) => e.startsWith('.lp-'))
  check('no .lp-restore / .lp-replaced folders remain', staging.length === 0, staging)

  section('Restore after the save folder is deleted (the reinstall case)')
  rmSync(saveDir, { recursive: true, force: true })
  check('save folder really gone', !existsSync(saveDir))
  result = await ev(`window.api.saves.restore(${snapA.id})`)
  check('restore recreates a missing save folder', result?.ok === true, result)
  check('the recreated flag is reported', result?.data?.recreatedSaveFolder === true)
  check('files are back', readSave() === 'STATE-A')
  check('no safety backup when there was nothing to protect', result?.data?.safetyBackup === null)

  section('Refusals happen before anything is written')
  await ev(`window.api.sessions.launch(${gameId})`)
  await delay(1400)
  const before = readSave()
  result = await ev(`window.api.saves.restore(${snapB.id})`)
  check('refused while the game is running', result?.ok === false && /is running/i.test(result.error), result)
  check('the refusal names the game and says what to do', /Close the game/i.test(result?.error ?? ''))
  check('saves untouched by the refused restore', readSave() === before)
  fixtures.stop('rstop')
  await delay(3000)

  check(
    'an unknown backup id is rejected',
    (await ev('window.api.saves.restore(999999)'))?.ok === false
  )
  check('a malformed backup id is rejected', (await ev("window.api.saves.restore('abc')"))?.ok === false)

  section('A snapshot whose folder vanished is refused, not half-applied')
  const orphan = (await ev(`window.api.saves.backupNow(${gameId})`))?.data?.backup
  rmSync(orphan.backupPath, { recursive: true, force: true })
  const contentBefore = readSave()
  result = await ev(`window.api.saves.restore(${orphan.id})`)
  check('missing snapshot folder refused', result?.ok === false && /missing from disk/i.test(result.error), result)
  check('saves untouched', readSave() === contentBefore)

  section('A game with no save folder has nowhere to restore to')
  await ev(`window.api.games.update(${gameId}, {saveFolderPath: null})`)
  result = await ev(`window.api.saves.restore(${snapA.id})`)
  check('refused when no save folder is set', result?.ok === false && /no save folder/i.test(result.error), result)
}
