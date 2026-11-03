import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPublisher, loadState } from '../src/publisher.mjs'
import { sessionKey } from '../src/payload.mjs'
import { makeHome, task } from './helpers.mjs'

const NOW = 1_000_000_000
const STALE_MS = 60_000

function setup({ sent = new Map(), send, statePath = null } = {}) {
  const context = { sessions: [], delivered: [] }
  context.publisher = createPublisher({
    readSessions: async () => context.sessions,
    send: send ?? (async (message) => context.delivered.push(message)),
    statePath,
    sent,
    staleMs: STALE_MS,
    sendText: true,
    now: () => NOW
  })
  return context
}

const session = (tasks, extra = {}) => ({ agent: 'claude', listId: 'a', cwd: '/w/app', goal: 'G', updatedAt: NOW, tasks, ...extra })

test('sends on a change and repeats nothing', async () => {
  const context = setup()
  context.sessions = [session([task(1, 'One', 'in_progress'), task(2, 'Two', 'pending')])]
  await context.publisher.publish()
  await context.publisher.publish()
  assert.equal(context.delivered.length, 1)
  assert.equal(context.delivered[0].at, String(NOW))
  context.sessions = [session([task(1, 'One', 'completed'), task(2, 'Two', 'in_progress')])]
  await context.publisher.publish()
  assert.equal(context.delivered.length, 2)
  assert.equal(context.delivered[1].done, '1')
})

test('a touched file with the same progress sends nothing', async () => {
  const context = setup()
  context.sessions = [session([task(1, 'One', 'pending')], { updatedAt: NOW - 5 })]
  await context.publisher.publish()
  context.sessions = [session([task(1, 'One', 'pending')], { updatedAt: NOW })]
  await context.publisher.publish()
  assert.equal(context.delivered.length, 1)
})

test('a session that goes away is ended once', async () => {
  const context = setup()
  context.sessions = [session([task(1, 'One', 'pending')])]
  await context.publisher.publish()
  context.sessions = []
  await context.publisher.publish()
  await context.publisher.publish()
  assert.equal(context.delivered.length, 2)
  assert.deepEqual(context.delivered[1], { v: '1', id: sessionKey('a'), state: 'ended', at: String(NOW) })
})

test('a list finished before it was ever shown starts nothing, but a shown one reports finishing', async () => {
  const finished = session([task(1, 'One', 'completed')])
  const unseen = setup()
  unseen.sessions = [finished]
  await unseen.publisher.publish()
  assert.equal(unseen.delivered.length, 0)

  const seen = setup()
  seen.sessions = [session([task(1, 'One', 'in_progress')])]
  await seen.publisher.publish()
  seen.sessions = [finished]
  await seen.publisher.publish()
  assert.equal(seen.delivered.at(-1).state, 'finished')
})

test('an idle session starts nothing and ends what was showing', async () => {
  const context = setup()
  context.sessions = [session([task(1, 'One', 'pending')], { updatedAt: NOW - STALE_MS - 1 })]
  await context.publisher.publish()
  assert.equal(context.delivered.length, 0)
  context.sessions = [session([task(1, 'One', 'pending')])]
  await context.publisher.publish()
  context.sessions = [session([task(1, 'One', 'pending')], { updatedAt: NOW - STALE_MS - 1 })]
  await context.publisher.publish()
  assert.equal(context.delivered.at(-1).state, 'ended')
})

test('a list of only deleted tasks shows nothing', async () => {
  const context = setup()
  context.sessions = [session([task(1, 'One', 'deleted')])]
  await context.publisher.publish()
  assert.equal(context.delivered.length, 0)
})

test('a failed send is retried on the next run, keeping what already went out', async () => {
  const delivered = []
  let fail = true
  const context = setup({
    send: async (message) => {
      if (fail && message.id === sessionKey('b')) throw new Error('offline')
      delivered.push(message.id)
    }
  })
  context.sessions = [session([task(1, 'One', 'pending')], { updatedAt: NOW - 2 }), session([task(1, 'Two', 'pending')], { listId: 'b', updatedAt: NOW - 1 })]
  await assert.rejects(context.publisher.publish(), /offline/)
  fail = false
  await context.publisher.publish()
  assert.deepEqual(delivered, [sessionKey('a'), sessionKey('b')])
})

test('a restart repeats nothing and still ends what went away while it was down', async () => {
  const home = await makeHome()
  const statePath = join(home, 'state', 'state.json')
  const first = setup({ statePath })
  first.sessions = [session([task(1, 'One', 'pending')]), session([task(1, 'Two', 'pending')], { listId: 'b' })]
  await first.publisher.publish()
  assert.equal(first.delivered.length, 2)
  assert.equal((await stat(statePath)).mode & 0o077, 0)
  assert.ok(!(await readFile(statePath, 'utf8')).includes('undefined'))

  const second = setup({ statePath, sent: await loadState(statePath) })
  second.sessions = [session([task(1, 'One', 'pending')])]
  await second.publisher.publish()
  assert.deepEqual(second.delivered, [{ v: '1', id: sessionKey('b'), state: 'ended', at: String(NOW) }])
})
