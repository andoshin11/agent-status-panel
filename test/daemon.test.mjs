import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startDaemon } from '../src/daemon.mjs'
import { buildPlist } from '../src/launchd.mjs'
import { makeHome } from './helpers.mjs'

async function start(publish) {
  const home = await makeHome()
  const logs = []
  const watchers = []
  const daemon = startDaemon({
    publish,
    dirs: [join(home, 'tasks'), join(home, 'progress')],
    log: (message) => logs.push(message),
    watchDir: (_dir, onChange) => watchers.push(onChange),
    debounceMs: 5,
    syncMs: 60_000
  })
  await daemon.ready
  return { daemon, logs, watchers }
}

test('publishes at start, then once for a burst of changes, ignoring lock files', async () => {
  let runs = 0
  const { daemon, watchers } = await start(async () => {
    runs += 1
  })
  assert.equal(runs, 1)
  assert.equal(watchers.length, 2)
  watchers[0]('rename', 'a/1.json')
  watchers[0]('rename', 'a/2.json')
  watchers[1]('rename', 'codex-1.json')
  await sleep(40)
  assert.equal(runs, 2)
  watchers[0]('rename', 'a/.lock')
  await sleep(40)
  assert.equal(runs, 2)
  daemon.stop()
})

test('a change during a run starts one more afterwards', async () => {
  let runs = 0
  let release
  const { daemon } = await start(async () => {
    runs += 1
    if (runs === 2) await new Promise((resolve) => (release = resolve))
  })
  const first = daemon.run()
  await sleep(1)
  daemon.run()
  release()
  await first
  assert.equal(runs, 3)
  daemon.stop()
})

test('a long outage is logged once and keeps running', async () => {
  let healthy = false
  const { daemon, logs } = await start(async () => {
    if (!healthy) throw new Error('offline')
  })
  await daemon.run()
  await daemon.run()
  assert.equal(logs.length, 1)
  healthy = true
  await daemon.run()
  healthy = false
  await daemon.run()
  assert.equal(logs.length, 2)
  daemon.stop()
})

test('the launchd job restarts the daemon and escapes paths', () => {
  const plist = buildPlist({ node: '/bin/node', script: '/a&b/main.mjs', log: '/logs/out.log' })
  assert.match(plist, /<string>\/a&amp;b\/main\.mjs<\/string>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(plist, /<string>run<\/string>/)
})
