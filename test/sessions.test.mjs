import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCodexProgress } from '../src/codex-progress.mjs'
import { createSessionReader, progressDir } from '../src/sessions.mjs'
import { SESSION_A, SESSION_B, makeHome, markRunning, task, taskCalls, writeTasks, writeTranscript } from './helpers.mjs'

test('reads running Claude sessions with the goal Claude wrote, and leaves out ended ones', async () => {
  const home = await makeHome()
  const goal = { metadata: { goal: 'Ship it' } }
  await writeTasks(home, SESSION_A, [task(1, 'One', 'in_progress', goal)])
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'A secret prompt' })
  await writeTasks(home, SESSION_B, [task(1, 'Two', 'pending')])
  await writeTranscript(home, SESSION_B, { cwd: '/work/other', prompt: 'x', running: false })
  const sessions = await createSessionReader({ home })()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].listId, SESSION_A)
  assert.equal(sessions[0].agent, 'claude')
  assert.equal(sessions[0].cwd, '/work/app')
  assert.equal(sessions[0].goal, 'Ship it')
  assert.ok(!JSON.stringify(sessions).includes('secret prompt'))
})

test('never falls back to a prompt when no goal was written', async () => {
  const home = await makeHome()
  await writeTasks(home, SESSION_A, [task(1, 'One', 'in_progress')])
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'A secret prompt' })
  const [session] = await createSessionReader({ home })()
  assert.equal(session.goal, null)
})

test('keeps a finished list after Claude deletes its files, and drops one cleared early', async () => {
  const home = await makeHome()
  const dir = await writeTasks(home, SESSION_A, [task(1, 'One', 'completed')])
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'x' })
  const read = createSessionReader({ home })
  await read()
  await rm(join(dir, '1.json'))
  assert.equal((await read())[0].tasks[0].status, 'completed')

  const other = await makeHome()
  const otherDir = await writeTasks(other, SESSION_A, [task(1, 'One', 'pending')])
  await writeTranscript(other, SESSION_A, { cwd: '/work/app', prompt: 'x' })
  const readOther = createSessionReader({ home: other })
  await readOther()
  await rm(join(otherDir, '1.json'))
  assert.deepEqual(await readOther(), [])
})

test('replays a list that finished before this process started', async () => {
  const home = await makeHome()
  const dir = await writeTasks(home, SESSION_A, [])
  await writeFile(join(dir, '.highwatermark'), '1')
  await writeTranscript(home, SESSION_A, {
    cwd: '/work/app',
    prompt: 'x',
    extra: taskCalls([{ subject: 'One' }], [{ taskId: '1', status: 'completed' }])
  })
  const [session] = await createSessionReader({ home })()
  assert.equal(session.tasks[0].status, 'completed')
})

test('reads Codex progress, and leaves the file of a finished session for its owner', async () => {
  const home = await makeHome()
  const dir = progressDir(home)
  await mkdir(dir, { recursive: true })
  const body = { pid: 42, cwd: '/work/codex', goal: 'Port it', updatedAt: 5, tasks: [task(1, 'One', 'in_progress')] }
  await writeFile(join(dir, 'codex-42.json'), JSON.stringify(body))
  const [session] = await readCodexProgress(dir, { running: () => true })
  assert.deepEqual([session.agent, session.listId, session.goal], ['codex', 'codex-42', 'Port it'])
  assert.deepEqual(await readCodexProgress(dir, { running: () => false }), [])
  assert.equal((await readCodexProgress(dir, { running: () => true })).length, 1)
})
