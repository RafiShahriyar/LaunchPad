/**
 * Game metadata: credentials, search, applying a match, and provider selection.
 *
 * Runs against a local stub rather than the real IGDB / RAWG / SteamGridDB.
 * Three reasons: the real services need live keys nobody should commit, they are
 * rate limited and those limits are shared with whatever the developer is doing
 * at the time, and a network round trip makes the suite fail for reasons that
 * have nothing to do with this code. The stub is reachable because every base
 * URL in the provider clients is overridable through the environment.
 *
 * What this proves that a unit test could not: the whole path across the process
 * boundary — preload whitelist, handler validation, the token cache in SQLite,
 * provider priority, the cover landing in the managed covers folder, and the row
 * that comes back.
 */
import { createServer } from 'node:http'

export const name = 'metadata'

/** Two distinguishable 1x1 PNGs, so which provider supplied the art is provable. */
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * A 2x1 PNG, standing in for wide key art.
 *
 * Distinct bytes matter here, not just a distinct URL: managed artwork is named
 * by a hash of its CONTENT, so a stub serving the same pixels for the grid and
 * the hero would collapse them into one file and make "cover and hero are
 * different images" untestable. Being genuinely landscape is a bonus that keeps
 * the fixture honest about what it represents.
 */
const PNG_WIDE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGOI0lgQpbEAAAdpAkU2M6luAAAAAElFTkSuQmCC',
  'base64'
)

const IGDB_GAMES = [
  {
    id: 1029,
    name: 'Hollow Knight',
    summary: 'A bug knight explores a ruined kingdom.',
    first_release_date: 1487894400, // 2017-02-24 UTC
    genres: [{ name: 'Platform' }, { name: 'Adventure' }],
    cover: { image_id: 'co1rbi' },
    // Wide key art. IGDB returns a list here, unlike the single `cover` object.
    artworks: [{ image_id: 'ar9zzz' }]
  }
]

const RAWG_GAMES = [
  {
    id: 9767,
    name: 'Hollow Knight',
    released: '2017-02-24',
    background_image: '/media/games/hollow.jpg',
    genres: [{ name: 'Action' }, { name: 'Indie' }],
    description_raw: 'Forge your own path in Hollow Knight, an epic action adventure.'
  },
  {
    id: 4242,
    name: 'Hollow Knight: Silksong',
    // No date, no genres, no image: the UI must cope with all three, and an
    // empty genre list must survive as "none listed" rather than "unknown".
    released: null,
    background_image: null,
    genres: []
  }
]

let server = null
let tokenRequests = 0
let lastIgdbBody = ''
/**
 * Every image path the app has fetched, in order.
 *
 * An array rather than a single `last`, because one apply now downloads two
 * images (cover and hero) and "the last one" cannot say whether the right
 * cover was chosen -- nor catch the same URL being fetched twice.
 */
const imagePaths = []
let rawgDetailRequests = 0
let sgdbSearches = 0
let sgdbHeroRequests = 0

export async function setup() {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // --- IGDB (Twitch OAuth + Apicalypse) ---
    if (url.pathname === '/oauth2/token') {
      tokenRequests++
      if (url.searchParams.get('client_secret') === 'bad-secret') {
        return json(403, { message: 'invalid client' })
      }
      return json(200, { access_token: 'stub-token', expires_in: 5000000 })
    }

    if (url.pathname === '/igdb/games') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        lastIgdbBody = body
        json(200, IGDB_GAMES)
      })
      return
    }

    // --- RAWG ---
    if (url.pathname === '/rawg/games') {
      if (url.searchParams.get('key') !== 'good-rawg-key') {
        return json(401, { error: 'Invalid API key' })
      }
      const term = (url.searchParams.get('search') ?? '').toLowerCase()
      const origin = `http://127.0.0.1:${server.address().port}`
      return json(200, {
        results: RAWG_GAMES.filter((game) => game.name.toLowerCase().includes(term)).map(
          (game) => ({
            ...game,
            // The port is only known once the stub is listening.
            background_image: game.background_image ? origin + game.background_image : null
          })
        )
      })
    }

    const rawgDetail = /^\/rawg\/games\/(\d+)$/.exec(url.pathname)
    if (rawgDetail) {
      rawgDetailRequests++
      const game = RAWG_GAMES.find((entry) => String(entry.id) === rawgDetail[1])
      return json(game ? 200 : 404, game ?? {})
    }

    // --- SteamGridDB ---
    if (url.pathname.startsWith('/sgdb/search/autocomplete/')) {
      sgdbSearches++
      if (req.headers.authorization !== 'Bearer good-sgdb-key') {
        return json(401, { success: false })
      }
      return json(200, { success: true, data: [{ id: 555, name: 'Hollow Knight' }] })
    }

    if (url.pathname.startsWith('/sgdb/grids/game/')) {
      if (req.headers.authorization !== 'Bearer good-sgdb-key') {
        return json(401, { success: false })
      }
      return json(200, {
        success: true,
        data: [{ url: `http://127.0.0.1:${server.address().port}/art/portrait.png` }]
      })
    }

    if (url.pathname.startsWith('/sgdb/heroes/game/')) {
      sgdbHeroRequests++
      if (req.headers.authorization !== 'Bearer good-sgdb-key') {
        return json(401, { success: false })
      }
      // A distinct filename from the grid, so an assertion can tell which shape
      // ended up in which column instead of both matching the same path.
      return json(200, {
        success: true,
        data: [{ url: `http://127.0.0.1:${server.address().port}/art/wide.png` }]
      })
    }

    // --- Images ---
    if (url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png')) {
      imagePaths.push(url.pathname)
      // Served as image/png regardless of extension on purpose: covers.ts must
      // take the extension from the declared content type, not from the URL.
      const bytes =
        url.pathname === '/art/wide.png'
          ? PNG_WIDE
          : url.pathname.startsWith('/art/')
            ? PNG_B
            : PNG_A
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length })
      return res.end(bytes)
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    env: {
      LAUNCHPAD_IGDB_AUTH_BASE: base,
      LAUNCHPAD_IGDB_API_BASE: `${base}/igdb`,
      LAUNCHPAD_IGDB_IMAGE_BASE: base,
      LAUNCHPAD_RAWG_API_BASE: `${base}/rawg`,
      LAUNCHPAD_SGDB_API_BASE: `${base}/sgdb`
    },
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve))
      server = null
    }
  }
}

const UI_HELPERS = `
window.__set = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
window.__dlg = () => document.querySelector('[role=dialog]');
window.__nameBox = () => window.__dlg()?.querySelector('input[role=combobox]');
window.__pageBtn = (t) => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === t);
window.__options = () => [...(window.__dlg()?.querySelectorAll('[role=option]') || [])];
'ready'`

export async function run({ ev, check, section, fixtures, app, reload, delay }) {
  section('Before any provider is configured')

  let status = await ev('window.api.metadata.getStatus()')
  check('status lists every provider', status?.data?.providers?.length === 3, status?.data?.providers?.length)
  check('no active source', status?.data?.activeSource === null)
  check('no art provider', status?.data?.artConfigured === false)
  check('nothing is configured', status?.data?.credentials?.every((c) => !c.configured) === true)
  check('no key is exposed', status?.data?.credentials?.every((c) => c.maskedKey === null) === true)

  const descriptors = status?.data?.providers ?? []
  check('descriptors declare their own fields', descriptors.every((p) => p.fields.length > 0))
  check('secret fields are marked', descriptors.every((p) => p.fields.some((f) => f.secret)))

  const unconfigured = await ev('window.api.metadata.search("hollow")')
  check(
    'searching says it is not set up, rather than returning nothing',
    unconfigured?.ok === false && /no metadata provider is configured/i.test(unconfigured.error ?? ''),
    unconfigured?.error
  )

  section('Rejected keys are not stored')

  const badRawg = await ev('window.api.metadata.setCredentials("rawg", { apiKey: "nope" })')
  check('a bad RAWG key is refused', badRawg?.ok === false, badRawg?.error)
  check('the message names RAWG', /rawg rejected the api key/i.test(badRawg?.error ?? ''), badRawg?.error)

  status = await ev('window.api.metadata.getStatus()')
  check('still unconfigured after a refusal', status?.data?.activeSource === null)

  const unknown = await ev('window.api.metadata.setCredentials("mobygames", { apiKey: "x" })')
  check('an unknown provider is refused', unknown?.ok === false, unknown?.error)

  section('RAWG: saving verifies the key first')

  const savedRawg = await ev('window.api.metadata.setCredentials("rawg", { apiKey: "good-rawg-key" })')
  check('a good RAWG key is accepted', savedRawg?.ok === true, savedRawg?.error)
  check('RAWG becomes the active source', savedRawg?.data?.activeSource === 'rawg')
  check('art is still unconfigured', savedRawg?.data?.artConfigured === false)

  const rawgCred = savedRawg?.data?.credentials?.find((c) => c.provider === 'rawg')
  check('the key comes back masked', /^good…-key$/.test(rawgCred?.maskedKey ?? ''), rawgCred?.maskedKey)
  check('the key itself never crosses back', !JSON.stringify(savedRawg?.data ?? {}).includes('good-rawg-key'))

  const settingsLeak = await ev('window.api.settings.get()')
  check(
    'the key is not in AppSettings either',
    !JSON.stringify(settingsLeak?.data ?? {}).includes('good-rawg-key')
  )

  section('Searching via RAWG')

  const search = await ev('window.api.metadata.search("Hollow Knight")')
  check('search succeeds', search?.ok === true, search?.error)
  check('the response names the provider', search?.data?.source === 'rawg')
  check('the query is echoed back', search?.data?.query === 'Hollow Knight')
  check('both entries are returned', search?.data?.results?.length === 2, search?.data?.results?.length)

  const first = search?.data?.results?.[0]
  check('each result carries its source', first?.source === 'rawg')
  check('genres are mapped', first?.genres?.join(',') === 'Action,Indie')
  check('the release date is mapped', first?.releaseDate === '2017-02-24')
  check('a thumbnail is inlined as a data URI', /^data:image\/png;base64,/.test(first?.thumbnailDataUri ?? ''))
  check(
    'the list endpoint costs no detail requests',
    rawgDetailRequests === 0,
    `detail requests: ${rawgDetailRequests}`
  )
  check('summary is absent until enrichment', first?.summary === null)

  const second = search?.data?.results?.[1]
  check('an entry with no genres reports an empty list', Array.isArray(second?.genres) && second.genres.length === 0)
  check('an entry with no image reports null', second?.coverUrl === null)
  check('a missing release date is null, not a guess', second?.releaseDate === null)

  section('Applying: the description is fetched for the chosen entry only')

  const exe = fixtures.posix(fixtures.gameCmd)
  const created = await ev(
    `window.api.games.create({ name: "Placeholder", executablePath: ${JSON.stringify(exe)} })`
  )
  check('a game was created', created?.ok === true, created?.error)
  const gameId = created?.data?.id

  const applied = await ev(`
    (async () => {
      const found = await window.api.metadata.search("Hollow Knight")
      return window.api.metadata.apply(${gameId}, found.data.results[0], { applyName: true, applyCover: true })
    })()
  `)
  check('apply succeeds', applied?.ok === true, applied?.error)
  check('no cover error', applied?.data?.coverError === null, applied?.data?.coverError)
  check('the name was replaced when asked', applied?.data?.game?.name === 'Hollow Knight')
  check('genres were written', applied?.data?.game?.genres?.join(',') === 'Action,Indie')
  check('provenance records RAWG', applied?.data?.game?.metadataSource === 'rawg')
  check('the provider id was recorded', applied?.data?.game?.metadataId === '9767')
  check('enrichment fetched the description', /forge your own path/i.test(applied?.data?.game?.summary ?? ''))
  check('exactly one detail request was made', rawgDetailRequests === 1, `detail requests: ${rawgDetailRequests}`)

  check(
    'the cover came from RAWG while no art provider is set',
    imagePaths.includes('/media/games/hollow.jpg'),
    imagePaths.join(', ')
  )

  const coverPath = applied?.data?.coverImagePath ?? ''
  check('the cover landed in the managed covers folder', coverPath.includes('covers'), coverPath)
  check('named by content hash, not by URL', /[\\/]\d+-[0-9a-f]{12}\.png$/.test(coverPath), coverPath)
  check('no temp file was left behind', !coverPath.includes('.tmp-'), coverPath)

  /*
   * RAWG hands back one landscape image and it is written to BOTH columns:
   * being a poor 3:4 cover is exactly what makes it a usable wide backdrop.
   *
   * The download must happen once, not twice. Content hashing means a second
   * fetch would produce the identical file, so the only thing a repeat costs is
   * the round trip -- precisely the sort of waste that goes unnoticed without
   * an assertion.
   */
  check('a hero was stored too', (applied?.data?.heroImagePath ?? '') !== '', applied?.data?.heroImagePath)
  check('no hero error', applied?.data?.heroError === null, applied?.data?.heroError)
  check(
    'RAWG reuses its one image for both shapes',
    applied?.data?.heroImagePath === coverPath,
    `${applied?.data?.heroImagePath} vs ${coverPath}`
  )
  check(
    'and downloads it exactly once',
    imagePaths.filter((path) => path === '/media/games/hollow.jpg').length === 1,
    imagePaths.join(', ')
  )
  check('the row carries the hero', applied?.data?.game?.heroImagePath === coverPath)

  section('Adding SteamGridDB upgrades the artwork')

  const badArt = await ev('window.api.metadata.setCredentials("steamgriddb", { apiKey: "wrong" })')
  check('a bad SteamGridDB key is refused', badArt?.ok === false, badArt?.error)

  const savedArt = await ev('window.api.metadata.setCredentials("steamgriddb", { apiKey: "good-sgdb-key" })')
  check('a good SteamGridDB key is accepted', savedArt?.ok === true, savedArt?.error)
  check('art is now configured', savedArt?.data?.artConfigured === true)
  check('it does not become the metadata source', savedArt?.data?.activeSource === 'rawg')

  const beforeSearches = sgdbSearches
  const beforeHeroRequests = sgdbHeroRequests
  const beforeImages = imagePaths.length
  const reapplied = await ev(`
    (async () => {
      const found = await window.api.metadata.search("Hollow Knight")
      return window.api.metadata.apply(${gameId}, found.data.results[0], { applyName: false, applyCover: true })
    })()
  `)
  const fetchedNow = imagePaths.slice(beforeImages)
  check('apply succeeds with art configured', reapplied?.ok === true, reapplied?.error)
  check(
    'portrait art was preferred over the landscape image',
    fetchedNow.includes('/art/portrait.png'),
    fetchedNow.join(', ')
  )
  check(
    'the art provider was consulted for each shape',
    sgdbSearches === beforeSearches + 2,
    `searches: ${sgdbSearches}, was ${beforeSearches}`
  )
  check('the heroes endpoint was queried', sgdbHeroRequests === beforeHeroRequests + 1)
  check(
    'the new cover is a different file',
    (reapplied?.data?.coverImagePath ?? '') !== coverPath,
    reapplied?.data?.coverImagePath
  )

  /*
   * The point of the whole feature: with an art provider configured the two
   * columns hold DIFFERENT images -- a portrait grid for the library card and a
   * composed wide banner for the detail backdrop. Storing one file in both is
   * the failure this guards, because it looks correct on one screen and wrong
   * on the other.
   */
  check(
    'the wide art was fetched from the heroes endpoint',
    fetchedNow.includes('/art/wide.png'),
    fetchedNow.join(', ')
  )
  check(
    'cover and hero are now distinct files',
    (reapplied?.data?.heroImagePath ?? '') !== (reapplied?.data?.coverImagePath ?? ''),
    `${reapplied?.data?.heroImagePath} vs ${reapplied?.data?.coverImagePath}`
  )
  check(
    'the row agrees with what apply reported',
    (reapplied?.data?.game?.heroImagePath ?? '') === (reapplied?.data?.heroImagePath ?? '')
  )

  section('Provider priority when more than one is configured')

  const savedIgdb = await ev(
    'window.api.metadata.setCredentials("igdb", { clientId: "test-client-id-1234", clientSecret: "test-secret" })'
  )
  check('IGDB credentials are accepted', savedIgdb?.ok === true, savedIgdb?.error)
  check('IGDB takes priority as the search source', savedIgdb?.data?.activeSource === 'igdb')
  const igdbCred = savedIgdb?.data?.credentials?.find((c) => c.provider === 'igdb')
  check('its token is cached from the verification', igdbCred?.hasCachedToken === true)
  check('RAWG stays configured alongside it', savedIgdb?.data?.credentials?.find((c) => c.provider === 'rawg')?.configured === true)

  const viaIgdb = await ev('window.api.metadata.search("Hollow Knight")')
  check('searches now answer from IGDB', viaIgdb?.data?.source === 'igdb', viaIgdb?.data?.source)
  check('IGDB results carry their own source', viaIgdb?.data?.results?.[0]?.source === 'igdb')
  check('IGDB supplies a summary in the list', /bug knight/i.test(viaIgdb?.data?.results?.[0]?.summary ?? ''))
  // One mint, during verification. If storing credentials wiped that token the
  // search would have to mint a second — which is exactly the bug this catches.
  check('the verification token was reused, not re-minted', tokenRequests === 1, `token requests: ${tokenRequests}`)

  section('The search term cannot inject a second clause')

  await ev('window.api.metadata.search("knight\\"; where id = 1; //")')
  check('quotes are escaped in the outgoing query', !/"\s*;\s*where id = 1/.test(lastIgdbBody), lastIgdbBody)
  check('only one search clause is sent', (lastIgdbBody.match(/search /g) ?? []).length === 1, lastIgdbBody)

  section('The row on disk matches what was reported')

  const row = app.withDb((db) =>
    db.prepare('SELECT genres, summary, release_date, metadata_source, metadata_id FROM games WHERE id = ?').get(gameId)
  )
  check('genres persisted as JSON', row?.genres === '["Action","Indie"]', row?.genres)
  check('release date persisted', row?.release_date === '2017-02-24', row?.release_date)
  check('source persisted', row?.metadata_source === 'rawg')

  section('Malformed input from the renderer')

  const entry = '{ id: "1", source: "rawg", name: "x", genres: [], releaseDate: null, summary: null, coverUrl: null }'
  const cases = [
    ['missing entry', `window.api.metadata.apply(${gameId}, null, { applyName: false, applyCover: false })`],
    ['unknown source', `window.api.metadata.apply(${gameId}, { id: "1", source: "wikipedia", name: "x", genres: [], releaseDate: null, summary: null, coverUrl: null }, { applyName: false, applyCover: false })`],
    ['genres not a list', `window.api.metadata.apply(${gameId}, { id: "1", source: "rawg", name: "x", genres: "Platform", releaseDate: null, summary: null, coverUrl: null }, { applyName: false, applyCover: false })`],
    ['bad release date', `window.api.metadata.apply(${gameId}, { id: "1", source: "rawg", name: "x", genres: [], releaseDate: "24/02/2017", summary: null, coverUrl: null }, { applyName: false, applyCover: false })`],
    ['non-http cover url', `window.api.metadata.apply(${gameId}, { id: "1", source: "rawg", name: "x", genres: [], releaseDate: null, summary: null, coverUrl: "file:///C:/windows/system32/config/sam" }, { applyName: false, applyCover: true })`],
    ['options not booleans', `window.api.metadata.apply(${gameId}, ${entry}, { applyName: "yes", applyCover: 1 })`],
    ['empty search text', 'window.api.metadata.search("   ")'],
    ['missing credential field', 'window.api.metadata.setCredentials("igdb", { clientId: "only-one" })'],
    ['clearing an unknown provider', 'window.api.metadata.clearCredentials("nintendo")']
  ]

  for (const [label, expression] of cases) {
    const result = await ev(expression)
    check(`${label} is rejected`, result?.ok === false, result)
    check(`${label} does not leak a SQLite error`, !/bound to SQLite parameter/i.test(result?.error ?? ''), result?.error)
  }

  section('Removing credentials')

  const clearedIgdb = await ev('window.api.metadata.clearCredentials("igdb")')
  check('IGDB is removed', clearedIgdb?.data?.credentials?.find((c) => c.provider === 'igdb')?.configured === false)
  check('its cached token goes with it', clearedIgdb?.data?.credentials?.find((c) => c.provider === 'igdb')?.hasCachedToken === false)
  check('RAWG becomes the active source again', clearedIgdb?.data?.activeSource === 'rawg')

  const clearedRawg = await ev('window.api.metadata.clearCredentials("rawg")')
  check('RAWG is removed', clearedRawg?.data?.activeSource === null)
  check('the art provider is unaffected', clearedRawg?.data?.artConfigured === true)

  const afterClear = await ev('window.api.metadata.search("hollow")')
  check('searching is unavailable again', afterClear?.ok === false, afterClear?.error)

  const kept = await ev(`window.api.games.get(${gameId})`)
  check('the game keeps the metadata it already had', kept?.data?.genres?.join(',') === 'Action,Indie')

  /*
   * The name field is a combobox, not a plain input with a separate "Find game
   * info" button. Looking a game up was a deliberate second step when the user
   * is already typing its name into a box; the search belongs on that box.
   *
   * Driven through the real DOM because that is the only place the debounce,
   * the ARIA wiring and the keyboard handling actually exist.
   */
  section('The name field searches as you type')

  // Re-configure RAWG: the section above removed every credential.
  await ev('window.api.metadata.setCredentials("rawg", { apiKey: "good-rawg-key" })')
  await reload()
  await ev(UI_HELPERS)

  await ev('window.__pageBtn("+ Add game")?.click()')
  await delay(400)
  check('the add dialog opened', (await ev('!!window.__dlg()')) === true)

  const nameBox = await ev('!!window.__nameBox()')
  check('the name field is a combobox', nameBox === true)
  check('it starts collapsed', (await ev('window.__nameBox()?.getAttribute("aria-expanded")')) === 'false')

  // One character must NOT search: it matches thousands of games and spends a
  // request from a monthly quota on a prefix nobody wanted results for.
  await ev('window.__set(window.__nameBox(), "H")')
  await delay(900)
  check('a single character does not open the list', (await ev('window.__options().length')) === 0)

  await ev('window.__set(window.__nameBox(), "Hollow")')
  // Shorter than the debounce: nothing should have gone out yet.
  await delay(150)
  check('the search is debounced, not fired per keystroke', (await ev('window.__options().length')) === 0)

  await delay(1600)
  const optionCount = await ev('window.__options().length')
  check('suggestions appear after the debounce', optionCount === 2, optionCount)
  check('the combobox reports itself expanded', (await ev('window.__nameBox()?.getAttribute("aria-expanded")')) === 'true')
  check(
    'each suggestion is an ARIA option',
    (await ev('window.__options().every(o => o.getAttribute("role") === "option")')) === true
  )
  check(
    'the first suggestion shows the game name',
    /Hollow Knight/.test(await ev('window.__options()[0]?.innerText ?? ""'))
  )
  check(
    'an entry with no artwork says so rather than showing a blank box',
    /No art/.test(await ev('window.__options()[1]?.innerText ?? ""')),
    await ev('window.__options()[1]?.innerText')
  )
  check(
    'the results are attributed to the provider',
    /Results from RAWG/.test(await ev('window.__dlg()?.innerText ?? ""'))
  )

  section('Keyboard navigation')

  await ev(`(() => {
    const box = window.__nameBox();
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  })()`)
  await delay(200)
  check(
    'ArrowDown highlights the first option',
    (await ev('window.__options()[0]?.getAttribute("aria-selected")')) === 'true'
  )
  check(
    'the highlight is announced via aria-activedescendant',
    (await ev('!!window.__nameBox()?.getAttribute("aria-activedescendant")')) === true
  )

  await ev(`(() => {
    const box = window.__nameBox();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await delay(400)
  check('Enter fills the name from the highlighted option', (await ev('window.__nameBox()?.value')) === 'Hollow Knight')
  check('choosing closes the list', (await ev('window.__options().length')) === 0)
  check(
    'the chosen match is summarised before saving',
    /Action, Indie/.test(await ev('window.__dlg()?.innerText ?? ""')),
    await ev('window.__dlg()?.innerText')
  )

  section('Escape closes the list without discarding the form')

  await ev('window.__set(window.__nameBox(), "Hollow")')
  await delay(1600)
  check('the list is open again', (await ev('window.__options().length')) > 0)

  await ev(`(() => {
    const box = window.__nameBox();
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`)
  await delay(300)
  check('Escape closed the suggestions', (await ev('window.__options().length')) === 0)
  // The whole point of stopping propagation: Modal also listens for Escape.
  check('the dialog is still open', (await ev('!!window.__dlg()')) === true)
  check('the typed name survived', (await ev('window.__nameBox()?.value')) === 'Hollow')
}
