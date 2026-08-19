/**
 * Disposable files the suites act on: a controllable "game", save folders, and
 * a real cover image.
 *
 * Everything is generated rather than committed. Binaries in a repository go
 * stale silently, and the generator doubles as documentation of what each
 * fixture actually is.
 */
import { execPath } from 'node:process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A stand-in game that runs until the test tells it to stop.
 *
 * Real games exit on their own schedule, which makes "did we detect the exit?"
 * untestable. This one polls for a sentinel file, so a suite decides exactly
 * when the session ends and with what exit code.
 */
const FAKE_GAME = `const fs = require('fs')
const stopFile = process.argv[2]
const exitCode = Number(process.argv[3] ?? 0)
fs.writeFileSync(stopFile + '.started', process.argv.slice(2).join('|'))
const tick = setInterval(() => {
  if (fs.existsSync(stopFile)) { clearInterval(tick); process.exit(exitCode) }
}, 100)
`

/** A 1x1 PNG, for exercising the cover pipeline without shipping an asset. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

export class Fixtures {
  constructor(root) {
    this.root = root
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })

    this.gameScript = join(root, 'fakegame.js')
    writeFileSync(this.gameScript, FAKE_GAME)

    // A .cmd wrapper, so the launcher's cmd.exe path is what actually runs.
    this.gameCmd = join(root, 'game.cmd')
    this.writeGameCmd()

    this.coverPng = join(root, 'cover.png')
    writeFileSync(this.coverPng, TINY_PNG)

    // An internet shortcut, which the launcher must refuse.
    this.urlShortcut = join(root, 'shortcut.url')
    writeFileSync(this.urlShortcut, '[InternetShortcut]\r\nURL=steam://rungameid/367520\r\n')

    this.notAnImage = join(root, 'notes.txt')
    writeFileSync(this.notAnImage, 'definitely not a png')
  }

  /** Recreated by suites that delete it to test a missing executable. */
  writeGameCmd() {
    writeFileSync(this.gameCmd, `@echo off\r\n"${execPath}" "${this.gameScript}" %*\r\n`)
  }

  removeGameCmd() {
    rmSync(this.gameCmd, { force: true })
  }

  /** POSIX-style path, safe to embed in the JS string literals sent over CDP. */
  posix(path) {
    return path.replace(/\\/g, '/')
  }

  saveFolder(name, files = { 'slot1.sav': 'progress' }) {
    const dir = join(this.root, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (const [file, contents] of Object.entries(files)) {
      const full = join(dir, file)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, contents)
    }
    return dir
  }

  emptyFolder(name) {
    const dir = join(this.root, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Sentinel path a running fake game watches for. */
  stopFile(name) {
    const file = join(this.root, name)
    rmSync(file, { force: true })
    rmSync(`${file}.started`, { force: true })
    return file
  }

  stop(name) {
    writeFileSync(join(this.root, name), 'stop')
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true })
  }
}
