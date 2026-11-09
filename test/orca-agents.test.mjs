import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attentionFrom, createAgentReader, offerId, offersFrom, offersOf, parseSuggestions, questionButtons, resolveOrcaCli } from '../src/orca-agents.mjs'

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
  const { readAttention } = createAgentReader({ cli: 'orca', read, log: (message) => logs.push(message) })
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

const reply = (json) => `done\n\n\`\`\`next\n${json}\n\`\`\`\n`
const proposal = (label = 'PR を作る', prompt = 'PR を作ってください') => ({ label, prompt })

test('parseSuggestions reads the block at the end of a reply', () => {
  assert.deepEqual(parseSuggestions(reply(JSON.stringify([proposal(' PR を作る ', ' PR を作ってください ')]))), [proposal()])
})

test('parseSuggestions takes three and drops what cannot be a button', () => {
  const good = proposal()
  const list = [good, proposal('', 'x'), proposal('x', ''), proposal('あ'.repeat(31)), proposal('x', 'あ'.repeat(301)), proposal('x', '--flag'), proposal('x', 'a\u001b[2J'), { label: 1, prompt: 'x' }, good, good, good]
  assert.deepEqual(parseSuggestions(reply(JSON.stringify(list))), [good, good, good])
})

test('parseSuggestions finds nothing without a well-formed block at the very end', () => {
  for (const message of [null, '', 'plain', reply('{'), reply('{"label":"x"}'), `${reply('[]')}and more`, '```json\n[]\n```']) {
    assert.deepEqual(parseSuggestions(message), [])
  }
})

const finished = (extra = {}) => agent('done', { paneKey: 'tab:leaf', hasLivePty: true, stateStartedAt: 5, lastAssistantMessage: reply(JSON.stringify([proposal()])), ...extra })

test('offersFrom keeps a workspace with one finished agent that proposed something', () => {
  assert.deepEqual(offersFrom([{ path: '/a', agents: [finished()] }]), [
    { id: offerId(finished()), path: '/a', agent: 'claude', paneKey: 'tab:leaf', suggestions: [proposal()] }
  ])
})

test('an offer changes with every turn', () => {
  assert.notEqual(offerId(finished()), offerId(finished({ stateStartedAt: 6 })))
})

test('offersFrom leaves out what a button could not reach safely', () => {
  const none = (agents, extra = {}) => assert.deepEqual(offersFrom([{ path: '/a', agents, ...extra }]), [])
  none([finished({ state: 'working' })])
  none([finished({ state: 'waiting' })])
  none([finished({ lastAssistantMessage: 'plain' })])
  none([finished({ hasLivePty: false })])
  none([finished({ hasLivePty: undefined })])
  none([finished()], { isArchived: true })
  none([finished({ parentPaneKey: 'p' })])
  none([finished(), finished({ paneKey: 'tab:other' })])
})

test('a subagent or a closed pane does not count as a second agent', () => {
  const agents = [finished(), finished({ paneKey: 'x', parentPaneKey: 'tab:leaf' }), finished({ paneKey: 'y', hasLivePty: false })]
  assert.equal(offersFrom([{ path: '/a', agents }]).length, 1)
})

test('the record of a closed pane does not count as a second agent', () => {
  const agents = [finished({ paneKey: 'old', hasLivePty: undefined, lastAssistantMessage: null }), finished()]
  assert.deepEqual(offersFrom([{ path: '/a', agents }]).map((offer) => offer.paneKey), ['tab:leaf'])
})

test('one reading gives both the attention and the offers, and a failure keeps them', async () => {
  let fail = false
  const read = async () => {
    if (fail) throw new Error('not running')
    return [{ path: '/a', agents: [finished()] }]
  }
  const { readAttention, readOffers } = createAgentReader({ cli: 'orca', read })
  assert.deepEqual(readOffers(), [])
  await readAttention()
  assert.equal(readOffers().length, 1)
  fail = true
  await readAttention()
  assert.equal(readOffers().length, 1)
})

const option = (label) => ({ label, description: `about ${label}` })
const asked = (extra = {}, options = [option('Red'), option('Blue')]) => ({ toolUseId: 'toolu_1', questions: [{ question: ' Which  one? ', header: 'h', multiSelect: false, options, ...extra }] })

test('questionButtons numbers every option in its place', () => {
  assert.deepEqual(questionButtons(asked()), {
    question: 'Which one?',
    suggestions: [{ label: 'Red', keys: '1', detail: 'about Red' }, { label: 'Blue', keys: '2', detail: 'about Blue' }]
  })
})

test('questionButtons shortens long text without dropping an option', () => {
  const buttons = questionButtons(asked({}, [option('あ'.repeat(100)), option('B')]))
  assert.equal([...buttons.suggestions[0].label].length, 60)
  assert.equal(buttons.suggestions[1].keys, '2')
})

test('questionButtons keeps an option without a description, with an empty one', () => {
  assert.equal(questionButtons(asked({}, [{ label: 'Red' }])).suggestions[0].detail, '')
})

test('questionButtons leaves to the terminal what one key cannot answer', () => {
  assert.equal(questionButtons(null), null)
  assert.equal(questionButtons({ questions: [] }), null)
  assert.equal(questionButtons({ questions: [asked().questions[0], asked().questions[0]] }), null)
  assert.equal(questionButtons(asked({ multiSelect: true })), null)
  assert.equal(questionButtons(asked({ question: '' })), null)
  assert.equal(questionButtons(asked({}, [])), null)
  assert.equal(questionButtons(asked({}, Array(10).fill(option('x')))), null)
  assert.equal(questionButtons(asked({}, [option('x'), { label: '' }])), null)
})

const waiting = (extra = {}) => agent('waiting', { toolName: 'AskUserQuestion', paneKey: 'tab:leaf', hasLivePty: true, stateStartedAt: 7, ...extra })

test('offersOf turns the question of the only agent into buttons', async () => {
  const offers = await offersOf([{ path: '/a', agents: [waiting()] }], async (path) => (assert.equal(path, '/a'), asked()))
  assert.equal(offers.length, 1)
  assert.equal(offers[0].id, offerId(waiting(), 'toolu_1'))
  assert.equal(offers[0].question, 'Which one?')
})

test('offersOf reads no question where a button could not answer it', async () => {
  const none = async (agents) => assert.deepEqual(await offersOf([{ path: '/a', agents }], async () => asked()), [])
  await none([waiting({ toolName: 'Bash' })])
  await none([waiting({ state: 'permission' })])
  await none([waiting({ agentType: 'codex' })])
  await none([waiting(), waiting({ paneKey: 'tab:other' })])
})

test('a transcript that cannot be read costs only the buttons', async () => {
  assert.deepEqual(await offersOf([{ path: '/a', agents: [waiting()] }], async () => { throw new Error('gone') }), [])
})

test('the suggestion in the input box becomes one more button', () => {
  const shown = new Map([['tab:leaf', '続きを調べてください']])
  const [offer] = offersFrom([{ path: '/a', agents: [finished()] }], shown)
  assert.deepEqual(offer.suggestions.at(-1), { label: '続きを調べてください', prompt: '続きを調べてください', detail: '' })
  assert.equal(offer.suggestions.length, 2)
})

test('a suggestion alone is enough for buttons, and changes the offer', () => {
  const plain = finished({ lastAssistantMessage: 'done' })
  const shown = new Map([['tab:leaf', '次へ']])
  const [offer] = offersFrom([{ path: '/a', agents: [plain] }], shown)
  assert.deepEqual(offer.suggestions.map(({ prompt }) => prompt), ['次へ'])
  assert.notEqual(offer.id, offerId(plain))
})

test('a suggestion the agent also proposed is shown once, and a bad one is left out', () => {
  assert.equal(offersFrom([{ path: '/a', agents: [finished()] }], new Map([['tab:leaf', 'PR を作ってください']]))[0].suggestions.length, 1)
  assert.equal(offersFrom([{ path: '/a', agents: [finished()] }], new Map([['tab:leaf', '-x']]))[0].suggestions.length, 1)
  assert.equal(offersFrom([{ path: '/a', agents: [finished()] }], new Map([['tab:leaf', 'あ'.repeat(301)]]))[0].suggestions.length, 1)
})

test('offersOf asks only about the only agent of a workspace, once it has finished', async () => {
  const asked = []
  const read = async (panes) => (asked.push(panes), new Map())
  await offersOf([
    { path: '/a', agents: [finished()] },
    { path: '/b', agents: [finished({ paneKey: 'codex', agentType: 'codex' })] },
    { path: '/c', agents: [finished({ paneKey: 'busy', state: 'working' })] }
  ], async () => null, read)
  assert.deepEqual(asked, [['tab:leaf']])
})

test('a failed suggestion read costs only that button', async () => {
  const offers = await offersOf([{ path: '/a', agents: [finished()] }], async () => null, async () => { throw new Error('no log') })
  assert.equal(offers[0].suggestions.length, 1)
})
