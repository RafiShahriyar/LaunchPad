/**
 * Games domain: validation, the cover pipeline, and CRUD across IPC.
 *
 * Drives `window.api.games.*` directly rather than the form, because the point
 * here is what MAIN accepts and rejects — the form is covered by games-ui.
 */
export const name = 'games'

export async function run({ ev, reload, text, check, section, fixtures }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const cover = fixtures.posix(fixtures.coverPng)
  const saves = fixtures.posix(fixtures.saveFolder('games-saves'))
  const notImage = fixtures.posix(fixtures.notAnImage)

  section('Validation rejects as envelopes, never as crashes')
  const missing = await ev(`window.api.games.create({name:'Ghost', executablePath:'${exe}.nope'})`)
  check('missing executable rejected', missing?.ok === false && /not found/i.test(missing.error), missing)

  const blank = await ev(`window.api.games.create({name:'   ', executablePath:'${exe}'})`)
  check('blank name rejected', blank?.ok === false && /empty/i.test(blank.error), blank)

  const folderAsExe = await ev(
    `window.api.games.create({name:'Dir', executablePath:'${fixtures.posix(fixtures.root)}'})`
  )
  check('folder-as-executable rejected', folderAsExe?.ok === false && /folder/i.test(folderAsExe.error), folderAsExe)

  const fileAsSaves = await ev(
    `window.api.games.create({name:'S', executablePath:'${exe}', saveFolderPath:'${notImage}'})`
  )
  check('file-as-save-folder rejected', fileAsSaves?.ok === false && /not a folder/i.test(fileAsSaves.error), fileAsSaves)

  const badCover = await ev(
    `window.api.games.create({name:'C', executablePath:'${exe}', coverImagePath:'${notImage}'})`
  )
  check('non-image cover rejected', badCover?.ok === false && /unsupported image/i.test(badCover.error), badCover)

  section('Create')
  const created = await ev(
    `window.api.games.create({name:'Hollow Knight', executablePath:'${exe}', saveFolderPath:'${saves}', coverImagePath:'${cover}', launchArgs:' -windowed '})`
  )
  check('create succeeded', created?.ok === true, created)
  const game = created?.data
  check('id assigned', game?.id > 0)
  check('launch args trimmed', game?.launchArgs === '-windowed', game?.launchArgs)
  check(
    'cover copied into the managed folder',
    /covers[\\/]\d+-[0-9a-f]{12}\.png$/.test(game?.coverImagePath ?? ''),
    game?.coverImagePath
  )
  check('save folder stored', (game?.saveFolderPath ?? '').includes('games-saves'))
  check('playtime starts at zero', game?.totalPlaytimeSeconds === 0)

  section('Covers are served over lpasset://, and only from that folder')
  const coverName = (game?.coverImagePath ?? '').split(/[\\/]/).pop()
  const decoded = await ev(
    `(async()=>{const i=new Image();i.src='lpasset://cover/${coverName}';try{await i.decode();return i.naturalWidth+'x'+i.naturalHeight}catch(e){return 'ERR '+e.message}})()`
  )
  check('cover decodes in the renderer', decoded === '1x1', decoded)

  const traversal = await ev(
    `fetch('lpasset://cover/..%2F..%2Flaunchpad.db').then(r=>r.status).catch(() => 'REJECTED')`
  )
  check('path traversal is blocked', traversal === 404 || traversal === 403 || traversal === 'REJECTED', traversal)

  section('A duplicate executable is allowed (the warning is UI-only)')
  const duplicate = await ev(`window.api.games.create({name:'HK Modded', executablePath:'${exe}'})`)
  check('second entry with the same exe allowed', duplicate?.ok === true, duplicate)

  section('Update writes only what it is given')
  const renamed = await ev(`window.api.games.update(${game?.id}, {name:'Hollow Knight: Voidheart'})`)
  check('rename applied', renamed?.data?.name === 'Hollow Knight: Voidheart', renamed)
  check('omitted fields preserved', renamed?.data?.saveFolderPath === game?.saveFolderPath)
  check('cover preserved when not sent', renamed?.data?.coverImagePath === game?.coverImagePath)

  const clearedCover = await ev(`window.api.games.update(${game?.id}, {coverImagePath:null})`)
  check('cover cleared', clearedCover?.data?.coverImagePath === null, clearedCover)
  const goneCover = await ev(`fetch('lpasset://cover/${coverName}').then(r=>r.status).catch(() => 'REJECTED')`)
  check('cleared cover no longer served', goneCover === 404 || goneCover === 'REJECTED', goneCover)

  section('The UI reflects it after a reload')
  await reload()
  const rendered = await text()
  check('both games listed', /Hollow Knight: Voidheart/.test(rendered) && /HK Modded/.test(rendered), rendered.slice(0, 200))
  check('count rendered', /2 games/.test(rendered), rendered.slice(0, 160))

  section('Delete')
  const deleted = await ev(`window.api.games.remove(${duplicate?.data?.id}, {deleteBackups:false})`)
  check('delete succeeded', deleted?.data?.deleted === true, deleted)
  check('backups kept by default', Array.isArray(deleted?.data?.backupFoldersKept))
  check('one game remains', (await ev('window.api.games.list()'))?.data?.length === 1)
  check(
    'deleting a missing game errors cleanly',
    (await ev('window.api.games.remove(99999, {deleteBackups:false})'))?.ok === false
  )

  section('Security surface')
  check(
    'no generic invoke or require is exposed',
    (await ev("typeof window.api.invoke === 'undefined' && typeof window.require === 'undefined'")) === true
  )
}
