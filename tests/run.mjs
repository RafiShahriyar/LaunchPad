/**
 * End-to-end suite runner.
 *
 *   npm run test:e2e            all suites
 *   npm run test:e2e games      only suites whose name contains "games"
 *
 * Each suite gets a freshly launched app with its own user-data directory, so
 * suites cannot contaminate each other and can be run individually while
 * debugging. The cost is a few seconds of startup per suite, which is worth
 * paying for the isolation.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertBuilt, killStrays, launchApp } from './helpers/app.mjs'
import { connect, createRecorder } from './helpers/cdp.mjs'
import { Fixtures } from './helpers/fixtures.mjs'

const SUITES_DIR = resolve(import.meta.dirname, 'suites')
const WORK_DIR = join(tmpdir(), 'launchpad-e2e')

async function main() {
  assertBuilt()

  const filter = process.argv[2]
  const files = (await readdir(SUITES_DIR)).filter((f) => f.endsWith('.mjs')).sort()
  const selected = filter ? files.filter((f) => f.includes(filter)) : files

  if (selected.length === 0) {
    console.error(`No suites match "${filter}". Available: ${files.join(', ')}`)
    process.exit(1)
  }

  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })

  const results = []
  const startedAt = Date.now()

  for (const file of selected) {
    const suite = await import(new URL(`suites/${file}`, import.meta.url))
    const suiteName = suite.name ?? file.replace('.mjs', '')
    console.log(`\n${'='.repeat(60)}\n${suiteName}\n${'='.repeat(60)}`)

    const profileDir = join(WORK_DIR, `profile-${suiteName}`)
    const fixtures = new Fixtures(join(WORK_DIR, `fixtures-${suiteName}`))
    const recorder = createRecorder(suiteName)

    let app
    let client
    let setup = null
    try {
      /*
       * A suite may stand something up (a stub server, say) before the app
       * launches and hand back environment overrides pointing at it. Done here
       * rather than inside run() because the environment must be set at spawn
       * time, and the runner owns the spawn.
       */
      setup = suite.setup ? await suite.setup() : null
      app = await launchApp(profileDir, setup?.env)
      client = await connect()
      // Let the renderer mount and finish its initial IPC round trips.
      await delay(2200)

      await suite.run({
        ...client,
        check: recorder.check,
        section: recorder.section,
        fixtures,
        app,
        delay,
        /** Reconnects after a deliberate kill+restart (crash-recovery suites). */
        restart: async () => {
          client.close()
          await app.restart()
          client = await connect()
          await delay(2200)
          return client
        }
      })
    } catch (error) {
      recorder.check(`suite crashed: ${error.message}`, false)
    } finally {
      client?.close()
      app?.kill()
      await setup?.teardown?.()
      fixtures.cleanup()
      await delay(600)
    }

    results.push(recorder.result())
  }

  killStrays()

  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0)
  const totalFailed = results.reduce((sum, r) => sum + r.failures.length, 0)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0)

  console.log(`\n${'='.repeat(60)}\nSummary (${seconds}s)\n${'='.repeat(60)}`)
  for (const result of results) {
    const status = result.failures.length === 0 ? 'PASS' : 'FAIL'
    console.log(`  ${status}  ${result.suite.padEnd(20)} ${result.passed} passed, ${result.failures.length} failed`)
    for (const failure of result.failures) console.log(`          - ${failure}`)
  }
  console.log(`\n${totalPassed} passed, ${totalFailed} failed across ${results.length} suite(s)`)

  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  killStrays()
  process.exit(1)
})
