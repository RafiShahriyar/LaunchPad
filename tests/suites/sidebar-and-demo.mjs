/**
 * The collapsible sidebar and the dev-only sample-data seeder.
 *
 * Note the lesson embedded here: an `aria-label` lookup proves an element
 * exists, not that anyone can see it. The collapse control passed its test while
 * being reported as missing, because it was dim and at the bottom of the rail.
 * These assertions cover behaviour; placement still needs a human eye.
 */
export const name = 'sidebar-and-demo'

export async function run({ ev, reload, check, section, delay }) {
  const sidebarWidth = () =>
    ev(`Math.round(document.querySelector('aside').getBoundingClientRect().width)`)

  section('Collapsible sidebar')
  check('starts expanded', (await sidebarWidth()) === 224)
  check('the collapse control is present', (await ev(`!!document.querySelector('[aria-label="Collapse sidebar"]')`)) === true)
  check('nav labels visible when expanded', (await ev("document.querySelector('aside').innerText.includes('Library')")) === true)

  await ev(`document.querySelector('[aria-label="Collapse sidebar"]').click()`)
  await delay(900)
  check('narrows to an icon rail', (await sidebarWidth()) === 56, await sidebarWidth())
  check('labels hidden when collapsed', (await ev("document.querySelector('aside').innerText.includes('Library')")) === false)
  check(
    'nav is still reachable by accessible name',
    (await ev(`!!document.querySelector('aside [aria-label="Library"]')`)) === true
  )
  check(
    'collapsed nav keeps a tooltip, the only way left to read it',
    (await ev(`document.querySelector('aside [aria-label="Library"]').title`)) === 'Library'
  )
  check('the control flips to Expand', (await ev(`!!document.querySelector('[aria-label="Expand sidebar"]')`)) === true)
  check('the choice is persisted to settings', (await ev('window.api.settings.get()'))?.data?.sidebarCollapsed === true)

  section('Collapse survives a reload')
  await reload()
  check('still collapsed', (await sidebarWidth()) === 56)
  await ev(`document.querySelector('[aria-label="Expand sidebar"]').click()`)
  await delay(900)
  check('expands again', (await sidebarWidth()) === 224)
  check('expansion persisted', (await ev('window.api.settings.get()'))?.data?.sidebarCollapsed === false)

  section('Sample data')
  const before = (await ev('window.api.games.list()'))?.data?.length ?? 0
  const seeded = await ev('window.api.settings.seedDemoData()')
  check('seed succeeded', seeded?.ok === true, seeded)
  check('eight games created', seeded?.data?.gamesCreated === 8, seeded?.data)
  check('sessions created across the last 30 days', seeded?.data?.sessionsCreated > 40, seeded?.data?.sessionsCreated)
  check('backups created', seeded?.data?.backupsCreated === 4, seeded?.data?.backupsCreated)

  const games = (await ev('window.api.games.list()'))?.data ?? []
  check('the library grew', games.length === before + 8, { before, after: games.length })
  check('every game has a cover', games.filter((g) => g.coverImagePath).length === 8)
  check('every game has a save folder', games.every((g) => g.saveFolderPath))
  check('playtime accumulated from the seeded sessions', games.some((g) => g.totalPlaytimeSeconds > 3600))
  check('one game is deliberately never played', games.some((g) => g.totalPlaytimeSeconds === 0))

  const played = games.find((g) => g.totalPlaytimeSeconds > 3600)
  check('session stats populated', (await ev(`window.api.sessions.getStats(${played?.id})`))?.data?.sessionCount > 0)

  section('Generated covers are real images the renderer can display')
  // The seeder must route covers through importCover(); writing the generated
  // path straight into the row leaves them outside the folder lpasset:// serves,
  // and every generated file is named cover.png so they would collide too.
  const coverName = (played?.coverImagePath ?? '').split(/[\\/]/).pop()
  const decoded = await ev(
    `(async()=>{const i=new Image();i.src='lpasset://cover/${coverName}';try{await i.decode();return i.naturalWidth+'x'+i.naturalHeight}catch(e){return 'ERR '+e.message}})()`
  )
  check('a generated cover decodes at its real size', decoded === '300x400', decoded)

  section('Seeding twice does not duplicate')
  check('a second run adds nothing', (await ev('window.api.settings.seedDemoData()'))?.data?.gamesCreated === 0)
  check('the library is unchanged', (await ev('window.api.games.list()'))?.data?.length === games.length)

  section('Demo games are genuinely backup-capable')
  check(
    'a demo game can be backed up through the normal path',
    (await ev(`window.api.saves.backupNow(${played?.id})`))?.data?.status === 'created'
  )
}
