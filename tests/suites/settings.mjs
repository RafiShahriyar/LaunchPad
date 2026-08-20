/**
 * Settings validation, the backups-root change, and orphan cleanup.
 *
 * The root-change section is the important one: it covers a latent bug where the
 * destructive-path guard was root-relative, which silently made every existing
 * snapshot un-deletable the moment a user moved their backups folder.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'settings'

const REJECTIONS = [
  ['zero backups', '{maxBackupsPerGame: 0}', /at least 1/i],
  ['negative backups', '{maxBackupsPerGame: -5}', /at least 1/i],
  ['absurd backups', '{maxBackupsPerGame: 99999}', /maximum is 500/i],
  ['fractional backups', '{maxBackupsPerGame: 2.5}', /at least 1/i],
  ['negative session minimum', '{minSessionSeconds: -1}', /negative/i],
  ['hour-long session minimum', '{minSessionSeconds: 99999}', /longer than an hour/i],
  ['empty backups path', "{backupsRootPath: '   '}", /cannot be empty/i],
  ['non-boolean toggle', "{backupBeforeLaunch: 'yes'}", /boolean/i],
  // 'light' was a member of the theme union once and is not any more, so this
  // doubles as the check that a removed value cannot be written back in.
  ['retired theme', "{theme: 'light'}", /unknown theme/i],
  ['nonexistent theme', "{theme: 'chartreuse'}", /unknown theme/i]
]

export async function run({ ev, check, section, fixtures, app }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const saveDir = fixtures.posix(fixtures.saveFolder('settings-saves', { 'slot.sav': 'settings-state' }))
  const altRoot = join(fixtures.root, 'alt-backups')

  section('Reading settings')
  let result = await ev('window.api.settings.get()')
  check('settings readable', result?.ok === true, result)
  check('defaults present', result?.data?.maxBackupsPerGame === 10 && result?.data?.minSessionSeconds === 30)
  check('backups root resolved under userData', /backups/.test(result?.data?.backupsRootPath ?? ''))

  section('Updating')
  result = await ev(
    'window.api.settings.update({maxBackupsPerGame: 3, minSessionSeconds: 1, backupAfterSession: false})'
  )
  check('update accepted', result?.ok === true, result)
  check('returns the full canonical object', result?.data?.maxBackupsPerGame === 3 && result.data.minSessionSeconds === 1)
  check('boolean persisted', result?.data?.backupAfterSession === false)
  check('untouched keys preserved', result?.data?.backupBeforeLaunch === true)
  check('re-reading agrees', (await ev('window.api.settings.get()'))?.data?.maxBackupsPerGame === 3)

  section('Validation rejects rather than silently clamping')
  for (const [label, patch, pattern] of REJECTIONS) {
    const rejected = await ev(`window.api.settings.update(${patch})`)
    check(`${label} rejected with a usable message`, rejected?.ok === false && pattern.test(rejected.error ?? ''), rejected)
  }
  check('a rejected update changed nothing', (await ev('window.api.settings.get()'))?.data?.maxBackupsPerGame === 3)

  /*
   * Theme used to be dropped silently -- update() returned ok with the value
   * unchanged, because no palette existed to honour it. It is a real setting
   * now, so it validates and persists like every other one. The palettes
   * themselves are covered in suites/themes.mjs; this is only the settings
   * contract.
   */
  section('Theme persists like any other setting')
  result = await ev("window.api.settings.update({theme: 'nebula'})")
  check('a valid theme is accepted', result?.ok === true && result.data.theme === 'nebula', result?.data)
  check('and survives a re-read', (await ev('window.api.settings.get()'))?.data?.theme === 'nebula')
  await ev("window.api.settings.update({theme: 'dark'})")

  section('Backups keep working after the root moves')
  const made = await ev(
    `window.api.games.create({name:'Settings Game', executablePath:'${exe}', saveFolderPath:'${saveDir}'})`
  )
  const gameId = made?.data?.id
  const first = await ev(`window.api.saves.backupNow(${gameId})`)
  const originalPath = first?.data?.backup?.backupPath
  check('snapshot written to the original root', originalPath?.includes('backups'), originalPath)

  result = await ev(`window.api.settings.update({backupsRootPath: ${JSON.stringify(altRoot)}})`)
  check('root change accepted', result?.ok === true, result)
  check('the new root is created on disk', existsSync(altRoot))

  writeFileSync(join(fixtures.root, 'settings-saves', 'slot.sav'), 'changed-after-move')
  const second = await ev(`window.api.saves.backupNow(${gameId})`)
  check('new snapshots go to the new root', (second?.data?.backup?.backupPath ?? '').includes('alt-backups'), second?.data?.backup?.backupPath)
  check(
    'the old snapshot is still listed',
    (await ev(`window.api.saves.listForGame(${gameId})`))?.data?.some((b) => b.backupPath === originalPath) === true
  )
  check('the old snapshot is still on disk', existsSync(originalPath))

  // The regression the structural guard fixes: a snapshot under the OLD root
  // must still be deletable once the root has moved.
  check(
    'a snapshot under the old root can still be deleted',
    (await ev(`window.api.saves.remove(${first?.data?.backup?.id})`))?.ok === true
  )
  check('its folder is gone', !existsSync(originalPath))

  await ev(`window.api.settings.update({backupsRootPath: ${JSON.stringify(app.backupsRoot)}})`)

  section('The orphan scan finds unreferenced folders')
  const ghostDir = join(app.backupsRoot, '999-deleted-game')
  mkdirSync(join(ghostDir, '2026-01-01T00-00-00-000Z'), { recursive: true })
  writeFileSync(join(ghostDir, '2026-01-01T00-00-00-000Z', 'old.sav'), 'orphaned data')

  const liveDir = join(app.backupsRoot, `${gameId}-settings-game`)
  mkdirSync(join(liveDir, '2026-01-02T00-00-00-000Z'), { recursive: true })
  writeFileSync(join(liveDir, '2026-01-02T00-00-00-000Z', 'stray.sav'), 'stray')

  result = await ev('window.api.settings.scanOrphans()')
  check('scan succeeded', result?.ok === true, result)
  const found = result?.data?.folders ?? []
  check('the deleted-game folder is found', found.some((f) => f.reason === 'deleted_game'), found)
  check('an unreferenced snapshot is found', found.some((f) => f.reason === 'unreferenced_snapshot'), found)
  check('sizes measured', found.every((f) => f.sizeBytes > 0))
  check('reclaimable total reported', result?.data?.totalBytes > 0)
  check('the scanned root is reported', typeof result?.data?.scannedRoot === 'string')

  const referenced = (await ev(`window.api.saves.listForGame(${gameId})`))?.data ?? []
  check(
    'referenced snapshots are NOT flagged',
    !found.some((f) => referenced.some((b) => b.backupPath === f.path)),
    found.map((f) => f.path)
  )

  section('Cleanup removes only what the scan reported')
  result = await ev('window.api.settings.cleanupOrphans()')
  check('cleanup succeeded', result?.ok === true, result)
  check('both folders deleted', result?.data?.deletedCount === 2, result?.data)
  check('freed bytes reported', result?.data?.freedBytes > 0)
  check('no failures', result?.data?.failed?.length === 0)
  check('the deleted-game folder is gone', !existsSync(ghostDir))
  check('the stray snapshot is gone', !existsSync(join(liveDir, '2026-01-02T00-00-00-000Z')))
  check('referenced snapshots untouched', referenced.every((b) => existsSync(b.backupPath)))
  check('a rescan finds nothing', (await ev('window.api.settings.scanOrphans()'))?.data?.folders?.length === 0)

  section('Usage reporting')
  check('library-wide usage available', (await ev('window.api.saves.getUsage()'))?.data?.backupCount >= 1)
}
