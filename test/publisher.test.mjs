import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPublisher, loadState, withAttention } from '../src/publisher.mjs'
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

test('a finished list is sent once, whether or not it was seen working', async () => {
  const finished = session([task(1, 'One', 'completed')])
  const unseen = setup()
  unseen.sessions = [finished]
  await unseen.publisher.publish()
  await unseen.publisher.publish()
  assert.deepEqual(unseen.delivered.map((m) => m.state), ['finished'])

  const seen = setup()
  seen.sessions = [session([task(1, 'One', 'in_progress')])]
  await seen.publisher.publish()
  seen.sessions = [finished]
  await seen.publisher.publish()
  assert.equal(seen.delivered.at(-1).state, 'finished')
})

test('an idle session is sent as not live, and becomes live again when it moves', async () => {
  const context = setup()
  const idle = session([task(1, 'One', 'pending')], { updatedAt: NOW - STALE_MS - 1 })
  context.sessions = [idle]
  await context.publisher.publish()
  await context.publisher.publish()
  assert.deepEqual(context.delivered.map((m) => [m.state, m.live]), [['active', '0']])
  context.sessions = [session([task(1, 'One', 'pending')])]
  await context.publisher.publish()
  assert.equal(context.delivered.at(-1).live, '1')
  context.sessions = [idle]
  await context.publisher.publish()
  assert.deepEqual([context.delivered.length, context.delivered.at(-1).live], [3, '0'])
})

test('an agent that needs the user notifies once, marks its newest session, and ends when it moves on', async () => {
  const attention = { value: [{ path: '/w/app', agent: 'claude', reason: 'waiting' }] }
  const delivered = []
  const sessions = [session([task(1, 'Old', 'completed')], { listId: 'old', updatedAt: NOW - 9 }), session([task(1, 'New', 'pending')], { listId: 'new', cwd: '/w/app/sub', updatedAt: NOW - 1 }), session([task(1, 'Other', 'pending')], { listId: 'other', cwd: '/w/app2' })]
  const publisher = createPublisher({
    readSessions: async () => sessions,
    readAttention: async () => attention.value,
    send: async (message) => delivered.push(message),
    statePath: null,
    sent: new Map(),
    staleMs: STALE_MS,
    sendText: true,
    now: () => NOW
  })
  await publisher.publish()
  const alertId = `attention-${sessionKey('/w/app')}`
  const marks = () => Object.fromEntries(delivered.filter((m) => m.state !== 'attention' && m.state !== 'ended').map((m) => [m.id, m.attention]))
  assert.deepEqual(marks(), { [sessionKey('old')]: '', [sessionKey('new')]: 'waiting', [sessionKey('other')]: '' })
  assert.deepEqual(delivered.filter((m) => m.state === 'attention'), [{ v: '1', id: alertId, state: 'attention', reason: 'waiting', workspace: 'app', at: String(NOW) }])
  delivered.length = 0
  await publisher.publish()
  assert.equal(delivered.length, 0)
  attention.value = []
  await publisher.publish()
  assert.deepEqual(delivered.map((m) => [m.id, m.state, m.attention]), [[sessionKey('new'), 'active', ''], [alertId, 'ended', undefined]])
})

test('a workspace with no task list gets a card while it needs the user', async () => {
  const context = setup()
  const attention = [{ path: '/w/none', agent: 'codex', reason: 'permission' }]
  const messages = context.publisher.plan(withAttention([], attention, NOW), attention)
  assert.deepEqual(messages.map((m) => [m.state, m.total, m.attention, m.workspace]), [['active', '0', 'permission', 'none'], ['attention', undefined, undefined, 'none']])
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

test('keeps the sessions for reading, in the order they appeared', async () => {
  const context = setup()
  assert.equal(context.publisher.snapshot(), null)
  context.sessions = [session([task(1, 'One', 'pending')], { listId: 'a', updatedAt: NOW - 10 }), session([task(1, 'One', 'pending')], { listId: 'b', updatedAt: NOW - 20 })]
  await context.publisher.publish()
  const ids = () => context.publisher.snapshot().sessions.map((s) => s.id)
  assert.deepEqual(ids(), [sessionKey('b'), sessionKey('a')])
  assert.deepEqual([context.publisher.snapshot().v, context.publisher.snapshot().at], ['1', String(NOW)])
  // Work on the older one does not move it.
  context.sessions = [session([task(1, 'One', 'completed')], { listId: 'a', updatedAt: NOW - 10 }), session([task(1, 'One', 'in_progress')], { listId: 'b', updatedAt: NOW })]
  await context.publisher.publish()
  assert.deepEqual(ids(), [sessionKey('b'), sessionKey('a')])
  assert.equal(context.publisher.snapshot().sessions[1].done, '1')
  // A session that went away and came back comes last.
  context.sessions = [session([task(1, 'One', 'pending')], { listId: 'a' })]
  await context.publisher.publish()
  context.sessions = [session([task(1, 'One', 'pending')], { listId: 'a' }), session([task(1, 'One', 'pending')], { listId: 'b', updatedAt: NOW - 30 })]
  await context.publisher.publish()
  assert.deepEqual(ids(), [sessionKey('a'), sessionKey('b')])
})

test('a failed send still updates what is read', async () => {
  const context = setup({ send: async () => { throw new Error('offline') } })
  context.sessions = [session([task(1, 'One', 'pending')])]
  await assert.rejects(context.publisher.publish(), /offline/)
  assert.deepEqual(context.publisher.snapshot().sessions.map((s) => s.id), [sessionKey('a')])
})

const OFFER = { id: 'o1', path: '/w/app', agent: 'claude', paneKey: 't:l', suggestions: [{ label: 'PR を作る', prompt: 'secret prompt' }] }

function setupOffers({ sendText = true } = {}) {
  const context = { sessions: [], offers: [OFFER], delivered: [] }
  context.publisher = createPublisher({
    readSessions: async () => context.sessions,
    readOffers: () => context.offers,
    send: async (message) => context.delivered.push(message),
    statePath: null,
    sent: new Map(),
    staleMs: STALE_MS,
    sendText,
    now: () => NOW
  })
  return context
}

test('an offer goes on the board with what its buttons show, and never into a push', async () => {
  const context = setupOffers()
  context.sessions = [session([task(1, 'One', 'completed')])]
  await context.publisher.publish()
  const [card] = context.publisher.snapshot().sessions
  assert.equal(card.offer, 'o1')
  assert.equal(card.suggestions, '["PR を作る"]')
  assert.equal(card.details, '["secret prompt"]')
  assert.equal(context.delivered.length, 1)
  assert.equal(context.delivered[0].offer, undefined)
  assert.equal(context.delivered[0].suggestions, undefined)
  assert.equal(context.delivered[0].details, undefined)
})

test('an offer shows a workspace without tasks on the board, and pushes nothing for it', async () => {
  const context = setupOffers()
  await context.publisher.publish()
  const { sessions } = context.publisher.snapshot()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].offer, 'o1')
  assert.equal(sessions[0].total, '0')
  assert.equal(context.delivered.length, 0)
})

test('an offer leaves the board when the agent moves on, without a push', async () => {
  const context = setupOffers()
  context.sessions = [session([task(1, 'One', 'completed')])]
  await context.publisher.publish()
  context.offers = []
  await context.publisher.publish()
  assert.equal(context.publisher.snapshot().sessions[0].offer, undefined)
  assert.equal(context.delivered.length, 1)
})

test('with sendText off there are no offers', async () => {
  const context = setupOffers({ sendText: false })
  context.sessions = [session([task(1, 'One', 'completed')])]
  await context.publisher.publish()
  assert.equal(context.publisher.snapshot().sessions[0].offer, undefined)
})

test('a question goes on the board with its text, and never into a push', async () => {
  const context = setupOffers()
  context.offers = [{ ...OFFER, question: 'Which?', suggestions: [{ label: 'Red', keys: '1', detail: 'A warm color' }] }]
  context.sessions = [session([task(1, 'One', 'in_progress')])]
  await context.publisher.publish()
  const [card] = context.publisher.snapshot().sessions
  assert.equal(card.question, 'Which?')
  assert.equal(card.suggestions, '["Red"]')
  assert.equal(card.details, '["A warm color"]')
  assert.equal(context.delivered[0].question, undefined)
})
