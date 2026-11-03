import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attentionFrom, createAttentionReader, resolveOrcaCli } from '../src/orca-agents.mjs'

const agent = (state, extra = {}) => ({ agentType: 'claude', state, prompt: 'secret', ...extra })

test('attentionFrom keeps workspaces whose main agent needs the user, with the most specific reason', () => {
  assert.deepEqual(
    attentionFrom([
      { path: '/a', agents: [agent('waiting'), agent('permission', { agentType: 'codex' }), agent('working')] },
      { path: '/b', agents: [agent('blocked')] },
      { path: '/c', agents: [agent('working'), agent('done'), agent('idle')] },
      { path: '/d', agents: [agent('waiting', { parentPaneKey: 'p' })] },
      { path: '/e', agents: [agent('waiting', { agentType: 'other' })] },
      { path: '/f', isArchived: true, agents: [agent('waiting')] },
      { path: '/g' }
    ]),
    [
      { path: '/a', agent: 'codex', reason: 'permission' },
      { path: '/b', agent: 'claude', reason: 'blocked' }
    ]
  )
})

test('the reader keeps the last answer while Orca cannot answer, and logs that once', async () => {
  const logs = []
  let fail = false
  const read = async () => {
    if (fail) throw new Error('not running')
    return [{ path: '/a', agents: [agent('waiting')] }]
  }
  const readAttention = createAttentionReader({ cli: 'orca', read, log: (message) => logs.push(message) })
  const first = await readAttention()
  assert.equal(first.length, 1)
  fail = true
  assert.deepEqual(await readAttention(), first)
  assert.deepEqual(await readAttention(), first)
  assert.equal(logs.length, 1)
})

test('resolveOrcaCli falls back to PATH', () => {
  assert.equal(resolveOrcaCli('/no/such/orca'), 'orca')
})
