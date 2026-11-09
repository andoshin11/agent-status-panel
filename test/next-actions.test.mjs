import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNextSender } from '../src/next-actions.mjs'
import { offerId } from '../src/orca-agents.mjs'

const reply = '```next\n[{"label":"A","prompt":"do a"},{"label":"B","prompt":"do b"}]\n```'
const agent = { agentType: 'claude', state: 'done', paneKey: 'tab:leaf', hasLivePty: true, stateStartedAt: 5, lastAssistantMessage: reply }
const OFFER = offerId(agent)

function setup({ worktrees = [{ path: '/a', agents: [agent] }], terminals = [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: true }], send, screen = async () => '? for shortcuts' } = {}) {
  const context = { sent: [], notified: 0, order: [] }
  context.next = createNextSender({
    cli: 'orca',
    read: async () => context.worktrees ?? worktrees,
    terminals: async () => terminals,
    send: send ?? (async (_cli, handle, prompt) => (context.order.push('send'), context.sent.push({ handle, prompt }))),
    stash: async () => context.order.push('stash'),
    screen,
    onSent: () => (context.notified += 1)
  })
  return context
}

test('sends the prompt the agent wrote to its own terminal', async () => {
  const context = setup()
  assert.equal(await context.next({ offer: OFFER, index: 1 }), true)
  assert.deepEqual(context.sent, [{ handle: 'h1', prompt: 'do b' }])
  assert.equal(context.notified, 1)
})

test('a button works once, also when pressed twice at the same moment', async () => {
  const context = setup()
  const results = await Promise.all([context.next({ offer: OFFER, index: 0 }), context.next({ offer: OFFER, index: 1 })])
  assert.deepEqual(results.toSorted(), [false, true])
  assert.equal(context.sent.length, 1)
  assert.equal(await context.next({ offer: OFFER, index: 0 }), false)
})

test('a button from an earlier reply sends nothing', async () => {
  const context = setup()
  context.worktrees = [{ path: '/a', agents: [{ ...agent, stateStartedAt: 6 }] }]
  assert.equal(await context.next({ offer: OFFER, index: 0 }), false)
  context.worktrees = [{ path: '/a', agents: [{ ...agent, state: 'working' }] }]
  assert.equal(await context.next({ offer: OFFER, index: 0 }), false)
  assert.deepEqual(context.sent, [])
})

test('a number outside the list sends nothing', async () => {
  const context = setup()
  for (const index of [2, -1]) assert.equal(await context.next({ offer: OFFER, index }), false)
  assert.deepEqual(context.sent, [])
})

test('without a writable terminal for that pane nothing is sent', async () => {
  for (const terminals of [[], [{ handle: 'h', tabId: 'tab', leafId: 'other', writable: true }], [{ handle: 'h', tabId: 'tab', leafId: 'leaf', writable: false }]]) {
    const context = setup({ terminals })
    assert.equal(await context.next({ offer: OFFER, index: 0 }), false)
    assert.deepEqual(context.sent, [])
  }
})

test('finds the terminal of a workspace that is not on screen', async () => {
  const context = setup({ terminals: [{ handle: 'other', tabId: 'pty:x', leafId: 'pty:x', recordedPaneKey: 'tab:else', writable: true }, { handle: 'h2', tabId: 'pty:y', leafId: 'pty:y', recordedPaneKey: 'tab:leaf', writable: true }] })
  assert.equal(await context.next({ offer: OFFER, index: 0 }), true)
  assert.deepEqual(context.sent, [{ handle: 'h2', prompt: 'do a' }])
})

test('a draft in Claude is set aside before the prompt', async () => {
  const context = setup()
  await context.next({ offer: OFFER, index: 0 })
  assert.deepEqual(context.order, ['stash', 'send'])
})

const codex = { ...agent, agentType: 'codex' }
const CODEX_OFFER = offerId(codex)

test('Codex with an empty box gets the prompt, and no stash it does not have', async () => {
  const context = setup({ worktrees: [{ path: '/a', agents: [codex] }] })
  assert.equal(await context.next({ offer: CODEX_OFFER, index: 0 }), true)
  assert.deepEqual(context.order, ['send'])
})

test('a draft in Codex stops the prompt, and the button still works afterwards', async () => {
  let shown = 'a draft hides the hint'
  const context = setup({ worktrees: [{ path: '/a', agents: [codex] }], screen: async () => shown })
  assert.equal(await context.next({ offer: CODEX_OFFER, index: 0 }), 'typing')
  assert.deepEqual(context.sent, [])
  shown = '? for shortcuts'
  assert.equal(await context.next({ offer: CODEX_OFFER, index: 0 }), true)
})

test('a failed send can be tried again', async () => {
  let fail = true
  const sent = []
  const context = setup({
    send: async (_cli, _handle, prompt) => {
      if (fail) throw new Error('orca is down')
      sent.push(prompt)
    }
  })
  await assert.rejects(context.next({ offer: OFFER, index: 0 }), /orca is down/)
  assert.equal(context.notified, 0)
  fail = false
  assert.equal(await context.next({ offer: OFFER, index: 0 }), true)
  assert.deepEqual(sent, ['do a'])
})

const question = { toolUseId: 'toolu_1', questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
const asking = { agentType: 'claude', state: 'waiting', toolName: 'AskUserQuestion', paneKey: 'tab:leaf', hasLivePty: true, stateStartedAt: 7 }
const ASKED = offerId(asking, 'toolu_1')

function setupQuestion({ read = async () => question } = {}) {
  const context = { keys: [], prompts: [] }
  context.next = createNextSender({
    cli: 'orca',
    read: async () => context.worktrees ?? [{ path: '/a', agents: [asking] }],
    readQuestion: read,
    terminals: async () => [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: true }],
    send: async (_cli, _handle, prompt) => context.prompts.push(prompt),
    stash: async () => assert.fail('a menu has no draft to set aside'),
    pressKeys: async (_cli, handle, keys) => context.keys.push({ handle, keys })
  })
  return context
}

test('an answer presses the number of the option and sends no prompt', async () => {
  const context = setupQuestion()
  assert.equal(await context.next({ offer: ASKED, index: 1 }), true)
  assert.deepEqual(context.keys, [{ handle: 'h1', keys: '2' }])
  assert.deepEqual(context.prompts, [])
})

test('an answer works once', async () => {
  const context = setupQuestion()
  assert.equal(await context.next({ offer: ASKED, index: 0 }), true)
  assert.equal(await context.next({ offer: ASKED, index: 1 }), false)
  assert.equal(context.keys.length, 1)
})

test('a button for another question presses nothing, even at the same moment of the agent', async () => {
  const context = setupQuestion({ read: async () => ({ ...question, toolUseId: 'toolu_2' }) })
  assert.equal(await context.next({ offer: ASKED, index: 0 }), false)
  assert.deepEqual(context.keys, [])
})

test('a button for a question already answered presses nothing', async () => {
  const context = setupQuestion()
  context.worktrees = [{ path: '/a', agents: [{ ...asking, state: 'working' }] }]
  assert.equal(await context.next({ offer: ASKED, index: 0 }), false)
  assert.deepEqual(context.keys, [])
})
