import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createQuestionReader, pendingQuestion } from '../src/claude-sessions.mjs'
import { makeHome, SESSION_A, SESSION_B } from './helpers.mjs'

const ask = (id) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'Q' }] } }] } })
const result = (id) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } })

test('finds the question that has no result yet', () => {
  assert.deepEqual(pendingQuestion([ask('a'), result('a'), ask('b')].join('\n')), { toolUseId: 'b', questions: [{ question: 'Q' }] })
})

test('an answered question is not pending, and an older unanswered one does not count', () => {
  assert.equal(pendingQuestion([ask('a'), result('a')].join('\n')), null)
  assert.equal(pendingQuestion([ask('old'), ask('a'), result('a')].join('\n')), null)
})

test('survives a line cut in the middle and text without questions', () => {
  assert.equal(pendingQuestion('{"cut tool_use'), null)
  assert.equal(pendingQuestion(''), null)
  assert.deepEqual(pendingQuestion(['{"cut tool_use', ask('a')].join('\n')).toolUseId, 'a')
})

async function session(home, sessionId, cwd, lines, pid = process.pid) {
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
  await mkdir(join(home, '.claude', 'projects', 'p'), { recursive: true })
  await writeFile(join(home, '.claude', 'sessions', `${sessionId.slice(0, 1).charCodeAt(0)}.json`), JSON.stringify({ pid, sessionId, cwd }))
  await writeFile(join(home, '.claude', 'projects', 'p', `${sessionId}.jsonl`), lines.join('\n'))
}

test('finds the question of the session running in a workspace', async () => {
  const home = await makeHome()
  await session(home, SESSION_A, '/w/app', [ask('a')])
  const read = createQuestionReader(home)
  assert.equal((await read('/w/app')).toolUseId, 'a')
  assert.equal(await read('/w/other'), null)
})

test('two sessions asking in one workspace are not told apart', async () => {
  const home = await makeHome()
  await session(home, SESSION_A, '/w/app', [ask('a')])
  await session(home, SESSION_B, '/w/app/sub', [ask('b')])
  assert.equal(await createQuestionReader(home)('/w/app'), null)
})

test('a second session that is not asking is no obstacle', async () => {
  const home = await makeHome()
  await session(home, SESSION_A, '/w/app', [ask('a')])
  await session(home, SESSION_B, '/w/app', [ask('b'), result('b')])
  assert.equal((await createQuestionReader(home)('/w/app')).toolUseId, 'a')
})
