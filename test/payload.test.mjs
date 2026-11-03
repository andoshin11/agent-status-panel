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
    tasks: JSON.stringify([['c', 'First'], ['i', 'Doing the second'], ['p', 'Third']]),
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
  assert.deepEqual([payload.workspace, payload.goal, payload.step, payload.tasks], ['', '', '', '[]'])
  assert.deepEqual([payload.done, payload.total], ['1', '3'])
})

test('a finished list and an ended session', () => {
  const finished = buildProgress({ ...session, tasks: [task(1, 'First', 'completed')] })
  assert.equal(finished.state, 'finished')
  assert.equal(finished.step, '')
  assert.deepEqual(buildEnded('abc'), { v: '1', id: 'abc', state: 'ended' })
})

test('long text is cut by characters and the worst case fits one FCM message', () => {
  const long = '進'.repeat(5000)
  const tasks = Array.from({ length: 30 }, (_, index) => task(index + 1, long, index === 0 ? 'in_progress' : 'pending'))
  const payload = buildProgress({ ...session, cwd: `/w/${long}`, goal: long, tasks })
  assert.equal([...payload.goal].length, 120)
  assert.ok(payload.goal.endsWith('…'))
  assert.equal([...JSON.parse(payload.tasks)[0][1]].length, 60)
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096)
})

test('a list that fits is sent whole', () => {
  const tasks = Array.from({ length: 30 }, (_, index) => task(index + 1, `T${index + 1}`, index < 20 ? 'completed' : 'pending'))
  assert.equal(JSON.parse(buildProgress({ ...session, tasks }).tasks).length, 30)
})

const longTasks = (count, status) => Array.from({ length: count }, (_, index) => task(index + 1, `T${index + 1} ${'進'.repeat(80)}`, status(index)))

test('a list too long to fit shows the tasks around the current one and keeps the whole counts', () => {
  const tasks = longTasks(30, (index) => (index < 20 ? 'completed' : index === 20 ? 'in_progress' : 'pending'))
  const payload = buildProgress({ ...session, tasks })
  const list = JSON.parse(payload.tasks)
  assert.ok(list[0][1].startsWith('T20 '))
  assert.deepEqual([list[0][0], list[1][0]], ['c', 'i'])
  assert.ok(list.length < 30)
  assert.deepEqual([payload.done, payload.total], ['20', '30'])
})

test('a finished list too long to fit ends with its last tasks', () => {
  const list = JSON.parse(buildProgress({ ...session, tasks: longTasks(30, () => 'completed') }).tasks)
  assert.ok(list.at(-1)[1].startsWith('T30 '))
  assert.ok(list.length < 30)
})
