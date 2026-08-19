import { app } from 'electron'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gamesRepo, savesRepo, sessionsRepo, transaction } from '@db/index'
import { createBackup } from './backups'
import { importCover } from './covers'

/**
 * Populates the library with believable sample data, for development only.
 *
 * Existing rows are left alone — this adds, it never resets — so it is safe to
 * run against a database you are already using.
 *
 * Everything it creates is real: the executables and save folders exist on disk
 * under `<userData>/demo/`, and the cover images are genuine PNGs. That matters
 * because fake paths would make the demo library look right while every action
 * on it failed, which is worse than an empty library for judging the UI.
 */

interface DemoGame {
  name: string
  /** Two colours for the generated cover gradient. */
  colors: [string, string]
  /** Roughly how many sessions to fabricate over the last 30 days. */
  sessions: number
  /** Typical session length in minutes; actual lengths vary around it. */
  typicalMinutes: number
}

const DEMO_GAMES: DemoGame[] = [
  { name: 'Hollow Knight', colors: ['#1e293b', '#0ea5e9'], sessions: 14, typicalMinutes: 95 },
  { name: 'Celeste', colors: ['#7c2d12', '#f97316'], sessions: 9, typicalMinutes: 42 },
  { name: 'Stardew Valley', colors: ['#14532d', '#84cc16'], sessions: 18, typicalMinutes: 140 },
  { name: 'Hades', colors: ['#450a0a', '#ef4444'], sessions: 11, typicalMinutes: 65 },
  { name: 'Outer Wilds', colors: ['#1e1b4b', '#a78bfa'], sessions: 6, typicalMinutes: 110 },
  { name: 'Factorio', colors: ['#292524', '#eab308'], sessions: 4, typicalMinutes: 240 },
  { name: 'Return of the Obra Dinn', colors: ['#0c0a09', '#d6d3d1'], sessions: 3, typicalMinutes: 75 },
  { name: 'Slay the Spire', colors: ['#3b0764', '#c084fc'], sessions: 0, typicalMinutes: 0 }
]

/**
 * Writes a minimal PNG by hand.
 *
 * A vertical two-colour gradient is enough to make the grid look like a real
 * library, and hand-rolling ~40 lines of PNG is cheaper than adding an image
 * dependency that ships in production for the sake of a dev-only feature.
 */
function makeGradientPng(width: number, height: number, from: string, to: string): Buffer {
  const parse = (hex: string): [number, number, number] => {
    const n = Number.parseInt(hex.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const [r1, g1, b1] = parse(from)
  const [r2, g2, b2] = parse(to)

  // Raw scanlines: each row is a filter byte (0 = none) followed by RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3))
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0
    const t = y / (height - 1)
    const r = Math.round(r1 + (r2 - r1) * t)
    const g = Math.round(g1 + (g2 - g1) * t)
    const b = Math.round(b1 + (b2 - b1) * t)
    for (let x = 0; x < width; x++) {
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
    }
  }

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export interface DemoDataResult {
  gamesCreated: number
  sessionsCreated: number
  backupsCreated: number
  demoRoot: string
}

export async function seedDemoData(): Promise<DemoDataResult> {
  const demoRoot = join(app.getPath('userData'), 'demo')
  mkdirSync(demoRoot, { recursive: true })

  const now = Date.now()
  const iso = (ms: number): string => new Date(ms).toISOString()
  const existing = new Set(gamesRepo.listGames().map((game) => game.name))

  let gamesCreated = 0
  let sessionsCreated = 0
  let backupsCreated = 0
  const backupTargets: number[] = []

  for (const demo of DEMO_GAMES) {
    if (existing.has(demo.name)) continue

    const slug = slugify(demo.name)
    const gameDir = join(demoRoot, slug)
    const saveDir = join(gameDir, 'saves')
    mkdirSync(saveDir, { recursive: true })

    // A real (if inert) executable path, so validation and the UI behave
    // normally. Launching it will fail cleanly — these are not real games.
    const exePath = join(gameDir, `${slug}.exe`)
    writeFileSync(exePath, '')
    writeFileSync(join(saveDir, 'slot1.sav'), `${demo.name} save data\n`)
    writeFileSync(join(saveDir, 'settings.cfg'), 'volume=8\nfullscreen=1\n')

    const coverPath = join(gameDir, 'cover.png')
    writeFileSync(coverPath, makeGradientPng(300, 400, demo.colors[0], demo.colors[1]))

    // Deterministic pseudo-randomness keyed off the name, so repeated seeds on
    // different machines produce the same believable spread.
    let seed = [...demo.name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    const createdAt = iso(now - 45 * 86_400_000)
    const game = gamesRepo.createGame(
      {
        name: demo.name,
        executablePath: exePath,
        saveFolderPath: saveDir,
        coverImagePath: null
      },
      createdAt
    )

    /*
     * Covers must go through importCover, exactly as the games:create handler
     * does. Writing the generated path straight into the row would leave the
     * file outside the managed covers folder, and the lpasset:// handler only
     * serves from there -- the grid would show broken images. Every demo cover
     * is also literally named cover.png, so they would collide in the URL space
     * too; importCover's <gameId>-<hash> naming avoids both problems.
     */
    gamesRepo.updateGame(game.id, { coverImagePath: importCover(coverPath, game.id) }, createdAt)
    gamesCreated++

    // Sessions spread over the last 30 days so the activity chart has shape.
    transaction(() => {
      for (let i = 0; i < demo.sessions; i++) {
        const daysAgo = Math.floor(rand() * 30)
        const startedMs = now - daysAgo * 86_400_000 - Math.floor(rand() * 12) * 3_600_000
        // Vary length between 40% and 160% of typical.
        const duration = Math.round(demo.typicalMinutes * 60 * (0.4 + rand() * 1.2))
        const session = sessionsRepo.startSession(game.id, iso(startedMs))
        sessionsRepo.endSession(
          session.id,
          iso(startedMs + duration * 1000),
          duration,
          rand() > 0.9 ? 'crashed' : 'exited'
        )
        sessionsCreated++
      }
    })

    if (demo.sessions > 0) backupTargets.push(game.id)
  }

  // Real snapshots, taken through the normal path so they exercise the same
  // code the app uses. Sequential rather than parallel: concurrent backups of
  // different games would still contend on disk for no benefit here.
  for (const gameId of backupTargets.slice(0, 4)) {
    const game = gamesRepo.getGame(gameId)
    if (!game) continue
    const outcome = await createBackup(game, 'manual', { force: true })
    if (outcome.status === 'created') backupsCreated++
  }

  // Pin one snapshot so the pinned state is visible without hunting for it.
  const firstBackup = backupTargets[0] ? savesRepo.listBackupsForGame(backupTargets[0])[0] : null
  if (firstBackup) savesRepo.setBackupPinned(firstBackup.id, true)

  return { gamesCreated, sessionsCreated, backupsCreated, demoRoot }
}
