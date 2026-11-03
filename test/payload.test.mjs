import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEnded, buildProgress, sessionKey } from '../src/payload.mjs'
import { task } from './helpers.mjs'

const session = {
  agent: 'claude',
  listId: 'list-1',
  cwd: '/Users/someone/secret-client/app',
  goal: 'Ship it',
  updatedAt: 1,
  tasks: [
    task(1, 'First', 'completed', { description: 'A secret description' }),
    task(2, 'Second', 'in_progress', { activeForm: 'Doing the second' }),
    task(3, 'Third', 'pending'),
    task(4, 'Gone', 'deleted')
  ]
}

test('a payload has counts, the current step and only strings, as FCM requires', () => {
  const payload = buildProgress(session)
  assert.deepEqual(payload, {
    v: '1',
    id: sessionKey('list-1'),
    agent: 'claude',
    state: 'active',
    workspace: 'app',
    goal: 'Ship it',
    step: 'Doing the second',
    done: '1',
    total: '3'
  })
  assert.ok(Object.values(payload).every((value) => typeof value === 'string'))
})

test('the path, the session id and task descriptions stay on the machine', () => {
  const text = JSON.stringify(buildProgress(session))
  for (const secret of ['secret-client', 'Users', 'list-1', 'secret description']) assert.ok(!text.includes(secret), secret)
})

test('sendText off sends only counts and state', () => {
  const payload = buildProgress(session, { sendText: false })
  assert.deepEqual([payload.workspace, payload.goal, payload.step], ['', '', ''])
  assert.deepEqual([payload.done, payload.total], ['1', '3'])
})

test('a finished list and an ended session', () => {
  const finished = buildProgress({ ...session, tasks: [task(1, 'First', 'completed')] })
  assert.equal(finished.state, 'finished')
  assert.equal(finished.step, '')
  assert.deepEqual(buildEnded('abc'), { v: '1', id: 'abc', state: 'ended' })
})

test('long text is cut by characters and fits one FCM message', () => {
  const long = '進'.repeat(5000)
  const payload = buildProgress({ ...session, goal: long, tasks: [task(1, long, 'in_progress')] })
  assert.equal([...payload.goal].length, 120)
  assert.ok(payload.goal.endsWith('…'))
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096)
})
