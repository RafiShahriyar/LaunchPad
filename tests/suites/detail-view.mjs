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
  /*
   * Header presentation. These guard decisions that are easy to undo by accident
   * while editing layout, and each one was a deliberate choice rather than a
   * default.
   */
  section('Header presentation')

  const artless = await ev(
    `window.api.games.create({name:'Presentable', executablePath:'${exe}'})`
  )
  const pid = artless?.data?.id

  // Genres and a summary long enough to need clamping.
  const longSummary =
    'A very long provider synopsis. '.repeat(20) + 'Final sentence that only appears when expanded.'
  await ev(
    `window.api.metadata.apply(${pid}, {id:'y',source:'rawg',name:'Presentable',genres:['Action','Roguelike','Indie'],releaseDate:'2024-05-06',summary:${JSON.stringify(longSummary)},coverUrl:null,heroUrl:null}, {applyName:false,applyCover:false})`
  )
  await ev(
    `window.api.games.update(${pid}, { coverImagePath: '${fixtures.posix(fixtures.coverPng)}' })`
  )
  await reload()
  await delay(900)
  await ev(`document.querySelector('[aria-label="Open Presentable"]').click()`)
  await delay(1200)

  // The cover standing in for missing wide art must NOT be blurred: the blur hid
  // the only artwork the game had.
  check(
    'the fallback backdrop is in use',
    (await ev(`!!document.querySelector('[data-testid=hero-fallback]')`)) === true
  )
  const backdropFilter = await ev(
    `getComputedStyle(document.querySelector('[data-testid=hero-fallback]')).filter`
  )
  check('and it is not blurred', backdropFilter === 'none', backdropFilter)

  // Bigger than the 520px ceiling the header used to have.
  const heroHeight = await ev(
    `Math.round(document.querySelector('[data-testid=hero-fallback]').closest('section').getBoundingClientRect().height)`
  )
  check('the header is given real height', heroHeight >= 440, heroHeight)

  section('Genres read as pills, not as one row of a stats panel')

  const pillCount = await ev(
    `[...document.querySelectorAll('span')].filter(el => ['Action','Roguelike','Indie'].includes(el.textContent.trim()) && el.className.includes('rounded-full')).length`
  )
  check('each genre gets its own pill', pillCount === 3, pillCount)

  // The panel that used to duplicate four of the stat tiles is gone.
  rendered = await text()
  check(
    'playtime is not stated twice in the header and the grid',
    (rendered.match(/total playtime/gi) ?? []).length === 1,
    (rendered.match(/total playtime/gi) ?? []).length
  )

  section('The synopsis is clamped, with a working toggle')

  check('the synopsis renders', (await ev(`!!document.querySelector('[data-testid=synopsis]')`)) === true)
  check(
    'a long synopsis is clamped rather than pushing the page down',
    (await ev(
      `getComputedStyle(document.querySelector('[data-testid=synopsis]')).webkitLineClamp`
    )) === '3'
  )

  const clampedHeight = await ev(
    `Math.round(document.querySelector('[data-testid=synopsis]').getBoundingClientRect().height)`
  )

  check('a toggle is offered', (await ev(`!!document.querySelector('[data-testid=synopsis-toggle]')`)) === true)
  check(
    'it starts collapsed',
    (await ev(`document.querySelector('[data-testid=synopsis-toggle]').getAttribute('aria-expanded')`)) === 'false'
  )
  check(
    'and reads "Read more"',
    /read more/i.test(await ev(`document.querySelector('[data-testid=synopsis-toggle]').innerText`))
  )

  await ev(`document.querySelector('[data-testid=synopsis-toggle]').click()`)
  await delay(300)
  const expandedHeight = await ev(
    `Math.round(document.querySelector('[data-testid=synopsis]').getBoundingClientRect().height)`
  )
  check('expanding actually reveals more text', expandedHeight > clampedHeight, `${clampedHeight} -> ${expandedHeight}`)
  check(
    'the end of the summary is now reachable',
    /only appears when expanded/.test(await text())
  )
  check(
    'and the toggle offers the way back',
    /show less/i.test(await ev(`document.querySelector('[data-testid=synopsis-toggle]').innerText`))
  )

  await ev(`document.querySelector('[data-testid=synopsis-toggle]').click()`)
  await delay(300)
  check(
    'collapsing restores the clamp',
    (await ev(
      `Math.round(document.querySelector('[data-testid=synopsis]').getBoundingClientRect().height)`
    )) === clampedHeight
  )

  section('A short synopsis is not given a pointless toggle')

  const shortId = (
    await ev(`window.api.games.create({name:'Terse', executablePath:'${exe}'})`)
  )?.data?.id
  await ev(
    `window.api.metadata.apply(${shortId}, {id:'z',source:'rawg',name:'Terse',genres:[],releaseDate:null,summary:'Two words.',coverUrl:null,heroUrl:null}, {applyName:false,applyCover:false})`
  )
  await reload()
  await delay(900)
  await ev(`document.querySelector('[aria-label="Open Terse"]').click()`)
  await delay(1200)
  check('the short synopsis renders', (await ev(`!!document.querySelector('[data-testid=synopsis]')`)) === true)
  check(
    'but offers no toggle, since there is nothing more to show',
    (await ev(`!document.querySelector('[data-testid=synopsis-toggle]')`)) === true
  )

  section('Buttons look clickable')

  // Tailwind v4's Preflight leaves buttons at the browser default of
  // `cursor: default`, which made every control in the app look inert.
  const playCursor = await ev(
    `getComputedStyle([...document.querySelectorAll('button')].find(b => /Play/.test(b.innerText))).cursor`
  )
  check('an enabled button shows a pointer', playCursor === 'pointer', playCursor)

  const disabledCursor = await ev(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.disabled)
      return b ? getComputedStyle(b).cursor : 'none-found'
    })()
  `)
  check(
    'a disabled one does not promise anything',
    disabledCursor === 'not-allowed' || disabledCursor === 'none-found',
    disabledCursor
  )

  // Back to the library: the section below opens a card by name and would
  // otherwise be clicking on a detail page that has no cards on it.
  await ev(`[...document.querySelectorAll('button')].find(b => /Library/.test(b.innerText))?.click()`)
  await delay(800)

  await ev(
    "[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(b => b.innerText.trim() === 'Delete game').click()"
  )
  await delay(2000)
  rendered = await text()
  check('back on the library after deleting', /library is empty|Add game/.test(rendered))
  check('no crash from the removed game', !/no longer in your library/.test(rendered))
}
