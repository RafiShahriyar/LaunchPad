/**
 * The per-game detail view: stats, activity chart, and live updates.
 *
 * Sessions are seeded straight into the database so the aggregates have a known
 * shape — 1h + 30m + 10m + one unmeasurable = 1h 40m total, longest 1h,
 * average 25m. Playing four real sessions to assert the same thing would take
 * hours and prove less.
 */
export const name = 'detail-view'

export async function run({ ev, reload, text, check, section, fixtures, app, delay }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const saveDir = fixtures.posix(fixtures.saveFolder('detail-saves', { 'slot.sav': 'detail-state' }))
  const stop = fixtures.stopFile('dstop')

  app.setSetting('min_session_seconds', 1)

  const made = await ev(
    `window.api.games.create({name:'Detail Game', executablePath:'${exe}', saveFolderPath:'${saveDir}', launchArgs:'"${fixtures.posix(stop)}" 0'})`
  )
  const gameId = made?.data?.id
  check('game created', gameId > 0, made)

  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString()
  app.withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO play_sessions (game_id, started_at, ended_at, duration_seconds, exit_reason)
       VALUES (?, ?, ?, ?, ?)`
    )
    insert.run(gameId, iso(now - 2 * 86400000), iso(now - 2 * 86400000 + 3600000), 3600, 'exited')
    insert.run(gameId, iso(now - 86400000), iso(now - 86400000 + 1800000), 1800, 'crashed')
    insert.run(gameId, iso(now - 3600000), iso(now - 3000000), 600, 'exited')
    // duration 0 = the app was not alive to measure it (crash recovery).
    insert.run(gameId, iso(now - 7200000), iso(now - 7200000), 0, 'app_closed')
    db.prepare('UPDATE games SET total_playtime_seconds = 6000, last_played_at = ? WHERE id = ?').run(
      iso(now - 3000000),
      gameId
    )
  })
  await ev(`window.api.saves.backupNow(${gameId})`)

  await reload()

  section('Navigating from the grid')
  check(
    'the card exposes an accessible open control',
    (await ev(`!!document.querySelector('[aria-label="Open Detail Game"]')`)) === true
  )
  await ev(`document.querySelector('[aria-label="Open Detail Game"]').click()`)
  await delay(1800)
  let rendered = await text()
  check('detail view opened', /Detail Game/.test(rendered) && /Session history/.test(rendered))
  check('back link offered', /← Library/.test(rendered))
  check('executable path shown', /game\.cmd/.test(rendered))

  section('Stats')
  // Stat labels render through `uppercase`, and innerText applies it.
  check('total playtime', /1h 40m/.test(rendered), rendered.slice(0, 700))
  check('session count', /sessions/i.test(rendered) && /\b4\b/.test(rendered))
  check('longest session', /1h\b/.test(rendered))
  check('average session', /25m/.test(rendered))
  check('last played', /last played/i.test(rendered))

  section('Session history says only what the app can know')
  check('sessions listed', /Finished/.test(rendered))
  check(
    'a non-zero exit reads "Ended unexpectedly", not "Crashed"',
    /Ended unexpectedly/.test(rendered) && !/Crashed/.test(rendered)
  )
  check('an interrupted session is labelled', /Interrupted/.test(rendered))
  check('an unmeasurable duration reads "Unknown", not 0s', /Unknown/.test(rendered) && !/\b0s\b/.test(rendered))
  check('durations formatted', /1h\b/.test(rendered) && /30m/.test(rendered) && /10m/.test(rendered))

  section('Activity chart')
  const chart = '[aria-label="Playtime over the last 30 days"]'
  check('chart rendered', (await ev(`!!document.querySelector('${chart}')`)) === true)
  check('one bar per day', (await ev(`document.querySelector('${chart}').children.length`)) === 30)
  const active = await ev(
    `[...document.querySelector('${chart}').children].filter(d => d.title && !/no play/.test(d.title)).length`
  )
  check('only days with sessions are filled', active === 3, active)

  section('Backups panel')
  check('backup listed', /Save backups/.test(rendered) && /manual/i.test(rendered))
  check('save folder path shown', /detail-saves/.test(rendered))
  check(
    'restore reachable from here',
    (await ev("[...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Restore')")) === true
  )

  section('Live updates while the page is open')
  await ev("[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '▶ Play').click()")
  await delay(2000)
  check('the in-progress session appears immediately', /Playing now/.test(await text()))
  fixtures.stop('dstop')
  await delay(4000)
  rendered = await text()
  check('the badge clears when the game exits', !/Playing now/.test(rendered))
  check('the new session lands in history without a reload', /sessions/i.test(rendered) && /\b5\b/.test(rendered))

  /*
   * The backdrop has three states and they must be distinguishable on screen,
   * not merely in the row. The failure this guards is the header quietly
   * rendering the COVER as though it were wide key art -- which looks entirely
   * plausible and is wrong -- so each state carries its own testid.
   *
   * Walked in order, because the interesting part is the transitions: this game
   * starts with no artwork at all.
   */
  section('The header backdrop: no artwork')

  check(
    'a game with no artwork gets the plain gradient',
    (await ev(`!!document.querySelector('[data-testid=hero-none]')`)) === true
  )
  check('and the absence is stated in words', /no artwork/i.test(await text()))

  /*
   * Asserted BEFORE anything is applied. `genres` is null here -- never looked
   * up -- which must not read the same as a provider that listed none. Once
   * apply runs below it becomes `[]` and the wording has to change.
   */
  section('The header distinguishes never-asked from nothing-found')

  rendered = await text()
  check('an unlooked-up game says so', /not looked up/i.test(rendered), rendered.slice(0, 260))
  check('a missing release year is stated, not omitted', /year unknown/i.test(rendered))

  const applied = await ev(
    `window.api.metadata.apply(${gameId}, {id:'x',source:'rawg',name:'Detail Game',genres:[],releaseDate:null,summary:null,coverUrl:null,heroUrl:null}, {applyName:false,applyCover:false})`
  )
  check('apply with no artwork requested succeeds', applied?.ok === true, applied?.error)
  check('and reports no hero', applied?.data?.heroImagePath === null)
  check('nor a hero error, since none was asked for', applied?.data?.heroError === null)
  // Applied over IPC, so the store has not seen it -- the same reload rule the
  // grid assertions follow.
  await reload()
  await delay(900)
  await ev(`document.querySelector('[aria-label="Open Detail Game"]').click()`)
  await delay(1200)
  check(
    'a provider that listed no genres reads differently from never asking',
    /none listed/i.test(await text())
  )

  section('The header backdrop: cover stands in for missing wide art')

  await ev(
    `window.api.games.update(${gameId}, { coverImagePath: '${fixtures.posix(fixtures.coverPng)}' })`
  )
  await reload()
  await delay(900)
  await ev(`document.querySelector('[aria-label="Open Detail Game"]').click()`)
  await delay(1200)

  check(
    'the cover is used as a fallback wash',
    (await ev(`!!document.querySelector('[data-testid=hero-fallback]')`)) === true
  )
  check(
    'and the page does not claim to have wide art',
    (await ev(`!!document.querySelector('[data-testid=hero-art]')`)) === false
  )
  check('the no-artwork notice is gone', !/no artwork/i.test(await text()))

  section('The header backdrop: real wide art wins')

  app.withDb((db) =>
    db
      .prepare('UPDATE games SET hero_image_path = ? WHERE id = ?')
      .run(fixtures.posix(fixtures.coverPng), gameId)
  )
  await reload()
  await delay(900)
  await ev(`document.querySelector('[aria-label="Open Detail Game"]').click()`)
  await delay(1200)

  check(
    'wide art is used when the game has it',
    (await ev(`!!document.querySelector('[data-testid=hero-art]')`)) === true
  )
  check(
    'the cover stops standing in',
    (await ev(`!!document.querySelector('[data-testid=hero-fallback]')`)) === false
  )
  check(
    'the cover thumbnail is still shown beside the title',
    (await ev(`!!document.querySelector('[aria-label="View cover image full size"]')`)) === true
  )

  section('Navigation back, and deleting the open game')
  await ev("[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '← Library').click()")
  await delay(800)
  rendered = await text()
  check('returns to the library grid', /Library/.test(rendered) && /Add game/.test(rendered))
  check('detail sections gone', !/Session history/.test(rendered))

  await ev(`document.querySelector('[aria-label="Open Detail Game"]').click()`)
  await delay(1200)
  await ev("[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Delete').click()")
  await delay(800)
  await ev(
    "[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(b => b.innerText.trim() === 'Delete game').click()"
  )
  await delay(2000)
  rendered = await text()
  check('back on the library after deleting', /library is empty|Add game/.test(rendered))
  check('no crash from the removed game', !/no longer in your library/.test(rendered))
}
