/**
 * Snapshot creation, deduplication, rotation and pinning.
 *
 * Asserts against the real filesystem as well as the database, because the
 * invariants that matter here are about the two agreeing: a row without a folder
 * is a restore that fails at the worst moment.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'backups'

const TAP = `
window.__events = [];
if (!window.__tapped) {
  window.__tapped = true;
  window.api.saves.onBackupFinished(e => window.__events.push(e));
}
'tapped'`

export async function run({ ev, check, section, fixtures, app, delay }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const saveDir = fixtures.saveFolder('backup-saves', {
    'slot1.sav': 'progress-1',
    'profile/settings.cfg': 'volume=8'
  })
  const emptyDir = fixtures.emptyFolder('backup-empty')
  const snapshotDirs = (dirName) => {
    const dir = join(app.backupsRoot, dirName)
    return existsSync(dir) ? readdirSync(dir).sort() : []
  }

  await ev(TAP)
  app.setSetting('min_session_seconds', 1)

  section('Skips are outcomes, not errors')
  const noFolder = await ev(`window.api.games.create({name:'No Saves', executablePath:'${exe}'})`)
  let result = await ev(`window.api.saves.backupNow(${noFolder?.data?.id})`)
  check('no save folder skips rather than failing', result?.ok === true && result.data.status === 'skipped', result)
  check('reason is no_save_folder_configured', result?.data?.reason === 'no_save_folder_configured')

  const missing = await ev(
    `window.api.games.create({name:'Missing Saves', executablePath:'${exe}', saveFolderPath:'${fixtures.posix(fixtures.root)}/not-created-yet'})`
  )
  result = await ev(`window.api.saves.backupNow(${missing?.data?.id})`)
  check('a folder the game has not created yet skips', result?.data?.reason === 'save_folder_missing', result?.data)

  const emptyGame = await ev(
    `window.api.games.create({name:'Empty Saves', executablePath:'${exe}', saveFolderPath:'${fixtures.posix(emptyDir)}'})`
  )
  result = await ev(`window.api.saves.backupNow(${emptyGame?.data?.id})`)
  // An empty snapshot is worse than none: restoring it would wipe real saves
  // while looking like a legitimate recovery point.
  check('an empty folder skips', result?.data?.reason === 'save_folder_empty', result?.data)
  check('skips write no rows', (await ev(`window.api.saves.listForGame(${emptyGame?.data?.id})`))?.data?.length === 0)

  section('Manual backup')
  const stop = fixtures.stopFile('bstop')
  const made = await ev(
    `window.api.games.create({name:'Save Game', executablePath:'${exe}', saveFolderPath:'${fixtures.posix(saveDir)}', launchArgs:'"${fixtures.posix(stop)}" 0'})`
  )
  const gameId = made?.data?.id
  result = await ev(`window.api.saves.backupNow(${gameId})`)
  check('backup created', result?.data?.status === 'created', result?.data)
  const backup = result?.data?.backup
  check('nested files are counted', backup?.fileCount === 2, backup?.fileCount)
  check('size measured', backup?.sizeBytes > 0)
  check('trigger recorded as manual', backup?.trigger === 'manual')
  check('content hash stored', typeof backup?.contentHash === 'string' && backup.contentHash.length === 40)

  const gameDirName = `${gameId}-save-game`
  let dirs = snapshotDirs(gameDirName)
  check('snapshot folder created on disk', dirs.length === 1, dirs)
  check('folder name has no illegal colons', !(dirs[0] ?? ':').includes(':'), dirs[0])
  check('no temp folder left behind', !dirs.some((d) => d.startsWith('.tmp-')), dirs)

  const snapRoot = join(app.backupsRoot, gameDirName, dirs[0])
  check('save file copied', readFileSync(join(snapRoot, 'slot1.sav'), 'utf8') === 'progress-1')
  check('nested file copied', readFileSync(join(snapRoot, 'profile', 'settings.cfg'), 'utf8') === 'volume=8')

  section('Deduplication')
  // Two backups in one second used to collide on the folder name; milliseconds
  // in the timestamp are what prevent it.
  result = await ev(`window.api.saves.backupNow(${gameId})`)
  check('a manual backup is forced even when unchanged', result?.data?.status === 'created', result?.data)
  check('two snapshots on disk', snapshotDirs(gameDirName).length === 2)

  await ev('window.__events = []')
  await ev(`window.api.sessions.launch(${gameId})`)
  await delay(1500)
  const preLaunch = await ev("window.__events.filter(e => e.trigger === 'pre_launch')")
  check('a pre-launch backup ran automatically', preLaunch?.length === 1, preLaunch)
  check(
    'unchanged saves are skipped rather than re-copied',
    preLaunch?.[0]?.outcome?.status === 'skipped' &&
      preLaunch[0].outcome.reason === 'unchanged_since_last_backup',
    preLaunch?.[0]?.outcome
  )
  check('still only two snapshots', snapshotDirs(gameDirName).length === 2)

  section('Changed saves are captured after the session')
  writeFileSync(join(saveDir, 'slot1.sav'), 'progress-2-CHANGED')
  fixtures.stop('bstop')
  await delay(3500)
  const postSession = await ev("window.__events.filter(e => e.trigger === 'post_session')")
  check('a post-session backup ran automatically', postSession?.length === 1, postSession)
  check('changed saves produce a new snapshot', postSession?.[0]?.outcome?.status === 'created')
  dirs = snapshotDirs(gameDirName)
  check('three snapshots on disk', dirs.length === 3, dirs)
  check(
    'the newest snapshot holds the changed content',
    readFileSync(join(app.backupsRoot, gameDirName, dirs[dirs.length - 1], 'slot1.sav'), 'utf8') ===
      'progress-2-CHANGED'
  )
  check('the older snapshot still holds the original', readFileSync(join(snapRoot, 'slot1.sav'), 'utf8') === 'progress-1')

  section('Rotation')
  app.setSetting('max_backups_per_game', 2)
  writeFileSync(join(saveDir, 'slot1.sav'), 'progress-3')
  result = await ev(`window.api.saves.backupNow(${gameId})`)
  check('backup created with rotation', result?.data?.status === 'created', result?.data)
  check(
    'rotation reports the ids it deleted',
    Array.isArray(result?.data?.rotatedIds) && result.data.rotatedIds.length === 2,
    result?.data?.rotatedIds
  )
  check('only the retention limit remains on disk', snapshotDirs(gameDirName).length === 2)
  const rows = await ev(`window.api.saves.listForGame(${gameId})`)
  check('the database matches disk', rows?.data?.length === 2, rows?.data?.length)

  section('Pinning survives rotation and does not consume quota')
  const toPin = rows?.data?.[rows.data.length - 1]
  check('pin applied', (await ev(`window.api.saves.setPinned(${toPin?.id}, true)`))?.data?.isPinned === true)
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(saveDir, 'slot1.sav'), `progress-rot-${i}`)
    await ev(`window.api.saves.backupNow(${gameId})`)
    await delay(250)
  }
  const afterRotation = (await ev(`window.api.saves.listForGame(${gameId})`))?.data ?? []
  check('the pinned snapshot survived', afterRotation.some((b) => b.id === toPin?.id), afterRotation.map((b) => b.id))
  check('it does not consume a retention slot', afterRotation.length === 3, afterRotation.length)
  check('its folder is still on disk', existsSync(toPin?.backupPath ?? 'x'))

  section('Usage reporting')
  const usage = await ev(`window.api.saves.getUsage(${gameId})`)
  check('per-game usage counts snapshots', usage?.data?.backupCount === 3, usage?.data)
  check('per-game usage sums bytes', usage?.data?.totalSizeBytes > 0)
  check('library-wide usage available', (await ev('window.api.saves.getUsage()'))?.data?.backupCount >= 3)

  section('Deleting a snapshot removes folder and row together')
  const victim = afterRotation.find((b) => !b.isPinned)
  check('delete succeeded', (await ev(`window.api.saves.remove(${victim?.id})`))?.data?.deleted === true)
  check('folder removed', !existsSync(victim?.backupPath ?? ''))
  check(
    'row removed',
    (await ev(`window.api.saves.listForGame(${gameId})`))?.data?.some((b) => b.id === victim?.id) === false
  )

  section('Input validation')
  check('a bad backup id is rejected', (await ev("window.api.saves.remove('x')"))?.ok === false)
  check('a non-boolean pin is rejected', (await ev(`window.api.saves.setPinned(${toPin?.id}, 'yes')`))?.ok === false)
}
