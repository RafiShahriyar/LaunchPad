/**
 * Launching, exit detection, and the three shutdown paths.
 *
 * The fake game runs until a sentinel file appears, so this suite controls
 * exactly when a session ends and with what exit code — something real games
 * make impossible to test.
 *
 * `minSessionSeconds` is dropped to 1 partway through: at its default of 30
 * every session here would be discarded, and waiting 30s per assertion is not a
 * trade worth making.
 */
export const name = 'sessions'

const TAP = `
window.__events = [];
if (!window.__tapped) {
  window.__tapped = true;
  window.api.sessions.onSessionStarted(e => window.__events.push({ type: 'started', e }));
  window.api.sessions.onSessionEnded(e => window.__events.push({ type: 'ended', e }));
}
'tapped'`

export async function run({ ev, reload, text, check, section, fixtures, app, delay, restart }) {
  const exe = fixtures.posix(fixtures.gameCmd)
  const urlShortcut = fixtures.posix(fixtures.urlShortcut)
  const saves = fixtures.posix(fixtures.saveFolder('session-saves'))
  let client = { ev, text }

  await ev(TAP)

  section('Refusing what cannot be tracked')
  const urlGame = await ev(`window.api.games.create({name:'Steam Shortcut', executablePath:'${urlShortcut}'})`)
  check('a .url game can be added', urlGame?.ok === true, urlGame)
  const urlLaunch = await ev(`window.api.sessions.launch(${urlGame?.data?.id})`)
  check('.url launch refused', urlLaunch?.ok === false, urlLaunch)
  check(
    'the refusal explains why and what to do',
    /cannot measure playtime/i.test(urlLaunch?.error ?? '') && /real \.exe/i.test(urlLaunch?.error ?? ''),
    urlLaunch?.error
  )
  check(
    'a refused launch leaves no session row',
    (await ev(`window.api.sessions.listForGame(${urlGame?.data?.id})`))?.data?.length === 0
  )

  section('Launching a real process')
  const stop1 = fixtures.stopFile('stop1')
  const made = await ev(
    `window.api.games.create({name:'Fake Game', executablePath:'${exe}', saveFolderPath:'${saves}', launchArgs:'"${fixtures.posix(stop1)}" 0'})`
  )
  const gameId = made?.data?.id
  check('game created', gameId > 0, made)

  // The game was created over IPC, so the store has not seen it. Reload before
  // asserting on the grid, or the "Playing" badge has no card to appear on.
  await reload()
  await ev(TAP)

  const launched = await ev(`window.api.sessions.launch(${gameId})`)
  check('launch succeeded', launched?.ok === true, launched)
  check('session row opened', launched?.data?.session?.id > 0)
  check('session starts unfinished', launched?.data?.session?.endedAt === null)
  await delay(1500)
  check('reported as running', (await ev('window.api.sessions.getRunning()'))?.data?.includes(gameId) === true)
  check('sessionStarted pushed to the renderer', (await ev("window.__events.filter(x=>x.type==='started').length")) === 1)
  check('card shows Playing', /Playing/.test(await text()))

  const again = await ev(`window.api.sessions.launch(${gameId})`)
  check('double launch refused', again?.ok === false && /already running/i.test(again.error), again)

  section('A short session is discarded, not recorded as a tiny one')
  fixtures.stop('stop1')
  await delay(2500)
  check('no longer running', (await ev('window.api.sessions.getRunning()'))?.data?.includes(gameId) === false)
  let ended = await ev("window.__events.filter(x=>x.type==='ended')")
  check('sessionEnded pushed', ended?.length === 1, ended?.length)
  check('marked discarded', ended?.[0]?.e?.discarded === true, ended?.[0]?.e)
  check('a clean exit reads as exited', ended?.[0]?.e?.exitReason === 'exited', ended?.[0]?.e?.exitReason)
  check('the raw exit code travels with it', ended?.[0]?.e?.exitCode === 0)
  check('no session row written', (await ev(`window.api.sessions.listForGame(${gameId})`))?.data?.length === 0)
  check('playtime unchanged', (await ev(`window.api.games.get(${gameId})`))?.data?.totalPlaytimeSeconds === 0)
  check('card returns to Play with no refresh', !/Playing/.test(await text()))

  section('A session long enough to record')
  app.setSetting('min_session_seconds', 1)
  const stop2 = fixtures.stopFile('stop2')
  await ev('window.__events = []')
  await ev(`window.api.games.update(${gameId}, {launchArgs:'"${fixtures.posix(stop2)}" 0'})`)
  await ev(`window.api.sessions.launch(${gameId})`)
  await delay(3000)
  fixtures.stop('stop2')
  await delay(2500)
  ended = await ev("window.__events.filter(x=>x.type==='ended')")
  check('recorded, not discarded', ended?.[0]?.e?.discarded === false, ended?.[0]?.e)
  const recorded = ended?.[0]?.e?.session
  check('session row closed', typeof recorded?.endedAt === 'string', recorded)
  check('duration measured', recorded?.durationSeconds >= 2 && recorded?.durationSeconds <= 8, recorded?.durationSeconds)
  check('playtime roll-up rides along with the event', ended?.[0]?.e?.game?.totalPlaytimeSeconds === recorded?.durationSeconds)
  check('lastPlayedAt set', typeof ended?.[0]?.e?.game?.lastPlayedAt === 'string')
  check('history has one row', (await ev(`window.api.sessions.listForGame(${gameId})`))?.data?.length === 1)

  const stats = await ev(`window.api.sessions.getStats(${gameId})`)
  check('stats count the session', stats?.data?.sessionCount === 1, stats?.data)
  check('stats total matches', stats?.data?.totalSeconds === recorded?.durationSeconds)

  section('A non-zero exit is flagged, with the code preserved')
  const stop3 = fixtures.stopFile('stop3')
  await ev('window.__events = []')
  await ev(`window.api.games.update(${gameId}, {launchArgs:'"${fixtures.posix(stop3)}" 3'})`)
  await ev(`window.api.sessions.launch(${gameId})`)
  await delay(2500)
  fixtures.stop('stop3')
  await delay(2500)
  ended = await ev("window.__events.filter(x=>x.type==='ended')")
  check('non-zero exit reported as crashed', ended?.[0]?.e?.exitReason === 'crashed', ended?.[0]?.e)
  check('raw exit code preserved', ended?.[0]?.e?.exitCode === 3)

  section('A missing executable is refused at launch')
  const ghost = await ev(`window.api.games.create({name:'Ghost', executablePath:'${exe}'})`)
  fixtures.removeGameCmd()
  const ghostLaunch = await ev(`window.api.sessions.launch(${ghost?.data?.id})`)
  check('missing exe refused', ghostLaunch?.ok === false && /no longer exists/i.test(ghostLaunch.error), ghostLaunch)
  check(
    'a failed launch leaves no session row',
    (await ev(`window.api.sessions.listForGame(${ghost?.data?.id})`))?.data?.length === 0
  )
  fixtures.writeGameCmd()

  /*
   * Regression net for a real bug: pressing Play did nothing at all.
   *
   * `spawn()` has TWO failure paths and they behave differently. Some failures
   * throw synchronously (EFTYPE, a non-program). Others arrive through the
   * child's asynchronous `error` event (EACCES, observed with a game whose exe
   * was locked by an already-running copy) — and by then `sessions:launch` has
   * already resolved SUCCESSFULLY, so the reason used to be console.error'd in
   * main and dropped on the floor. The UI flipped from "Playing" straight back
   * to "Play" and said nothing at all.
   *
   * Only the synchronous path can be provoked portably: producing a real EACCES
   * needs a locked binary or security software, neither of which a test can
   * conjure. So the async path is covered by asserting the CONTRACT it depends
   * on — that `launchError` exists on the event and is null for a normal exit —
   * rather than by faking the operating system.
   */
  section('An unrunnable file reports why, in words')

  const notAProgram = fixtures.posix(fixtures.notAnImage)
  const dud = await ev(`window.api.games.create({name:'Dud', executablePath:'${notAProgram}'})`)
  const dudId = dud?.data?.id

  const dudLaunch = await ev(`window.api.sessions.launch(${dudId})`)
  check('an unrunnable file is refused', dudLaunch?.ok === false, dudLaunch)
  check(
    'the message is words, not a raw errno',
    !/EFTYPE|ENOEXEC|EACCES|^spawn /i.test(dudLaunch?.error ?? ''),
    dudLaunch?.error
  )
  check(
    'it says what to do instead',
    /not a program|point this game at/i.test(dudLaunch?.error ?? ''),
    dudLaunch?.error
  )
  check('it names the file', (dudLaunch?.error ?? '').includes('notes.txt'), dudLaunch?.error)
  check('no session row is left behind', (await ev(`window.api.sessions.listForGame(${dudId})`))?.data?.length === 0)
  check('the game is not left marked as running', (await ev('window.api.sessions.getRunning()'))?.data?.includes(dudId) === false)

  // The contract the asynchronous path rides on.
  check(
    'session-ended events carry a launchError field',
    ended?.[0]?.e !== undefined && 'launchError' in ended[0].e,
    Object.keys(ended?.[0]?.e ?? {})
  )
  check('a genuinely ended session reports no launch error', ended?.[0]?.e?.launchError === null, ended?.[0]?.e?.launchError)

  section('Crash recovery: force-kill with a game still running')
  const stop4 = fixtures.stopFile('stop4')
  await ev(`window.api.games.update(${gameId}, {launchArgs:'"${fixtures.posix(stop4)}" 0'})`)
  await ev(`window.api.sessions.launch(${gameId})`)
  await delay(1500)
  check('running before the plug is pulled', (await ev('window.api.sessions.getRunning()'))?.data?.includes(gameId) === true)

  // A force-kill means 'before-quit' never runs, so the session row is left
  // open — exactly what an app crash or power loss looks like.
  client = await restart()
  fixtures.stop('stop4')

  const history = (await client.ev(`window.api.sessions.listForGame(${gameId})`))?.data ?? []
  const orphan = history.find((s) => s.exitReason === 'app_closed')
  check('the orphaned session was closed at startup', orphan !== undefined, history.map((s) => s.exitReason))
  check('it has an end time', orphan?.endedAt !== null)
  check('it records duration 0 rather than an invented length', orphan?.durationSeconds === 0, orphan?.durationSeconds)
  check('nothing is reported as running after the restart', (await client.ev('window.api.sessions.getRunning()'))?.data?.length === 0)
  check('no stale Playing badge', !/Playing/.test(await client.text()))
}
