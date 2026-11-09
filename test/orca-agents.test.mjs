import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerKeys, attentionFrom, createAgentReader, isDangerous, linksFrom, offerId, offersFrom, offersOf, parseSuggestions, questionButtons, questionForm, resolveOrcaCli } from '../src/orca-agents.mjs'

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

const single = (labels = ['Red', 'Blue']) => ({ question: 'Color?', multiSelect: false, options: labels.map(option) })
const multi = (labels = ['Apple', 'Orange', 'Grape']) => ({ question: 'Fruit?', multiSelect: true, options: labels.map(option) })

test('questionForm carries every question with its descriptions', () => {
  assert.deepEqual(questionForm({ questions: [multi(['A']), single(['B'])] }), [
    { question: 'Fruit?', multiSelect: true, options: [{ label: 'A', detail: 'about A' }] },
    { question: 'Color?', multiSelect: false, options: [{ label: 'B', detail: 'about B' }] }
  ])
})

test('questionForm refuses what the phone could not answer', () => {
  assert.equal(questionForm(null), null)
  assert.equal(questionForm({ questions: [] }), null)
  assert.equal(questionForm({ questions: Array(5).fill(single()) }), null)
  assert.equal(questionForm({ questions: [{ question: '', options: [option('A')] }] }), null)
  assert.equal(questionForm({ questions: [{ question: 'Q', options: Array(10).fill(option('A')) }] }), null)
})

test('offersOf makes a form for several questions or several choices, and buttons for one choice', async () => {
  const offer = async (questions) => (await offersOf([{ path: '/a', agents: [waiting()] }], async () => ({ toolUseId: 'toolu_1', questions })))[0]
  const form = await offer([multi(), single()])
  assert.equal(form.questions.length, 2)
  assert.deepEqual(form.suggestions, [])
  assert.equal((await offer([multi()])).questions.length, 1)
  const buttons = await offer([single()])
  assert.equal(buttons.questions, undefined)
  assert.equal(buttons.suggestions.length, 2)
})

const form = [{ multiSelect: true, options: [1, 2, 3] }, { multiSelect: false, options: [1, 2] }]

test('answerKeys ticks several and moves on with Tab, and a single answer moves on by itself', () => {
  assert.deepEqual(answerKeys(form, [[1, 2], [1]]), ['2', '3', '\t', '2'])
  assert.deepEqual(answerKeys([form[1], form[1]], [[0], [1]]), ['1', '2'])
  assert.deepEqual(answerKeys([form[0]], [[0]]), ['1', '\t'])
})

test('answerKeys refuses answers that do not fit the form', () => {
  for (const answers of [[[0]], [[], [0]], [[0, 0], [0]], [[0], [0, 1]], [[3], [0]], [[0], [2]], [[-1], [0]], [[0.5], [0]], 'x', null]) {
    assert.equal(answerKeys(form, answers), null, JSON.stringify(answers))
  }
  assert.equal(answerKeys(null, []), null)
})

const bash = (command) => ({ toolUseId: 'toolu_b', name: 'Bash', input: { command } })
const permissionAgent = (extra = {}) => waiting({ toolName: 'Bash', ...extra })

test('isDangerous catches the commands that deserve a second look', () => {
  for (const command of ['rm -rf x', 'cd a && rm b', 'sudo ls', 'git push --force', 'git push origin main -f', 'git push --force-with-lease', 'git reset --hard', 'git clean -fd', 'kubectl delete pod a', 'terraform apply', 'psql -c "DROP TABLE x"']) {
    assert.equal(isDangerous(bash(command)), true, command)
  }
})

test('isDangerous leaves ordinary commands to one tap', () => {
  for (const command of ['ls', 'git push origin main', 'npm run format', 'cat firmware.txt', 'git status']) {
    assert.equal(isDangerous(bash(command)), false, command)
  }
  assert.equal(isDangerous({ name: 'Write', input: { file_path: 'rm' } }), false)
})

test('a tool waiting for permission becomes allow and deny, with what it would do', async () => {
  const [offer] = await offersOf([{ path: '/a', agents: [permissionAgent()] }], async () => null, undefined, async () => bash('touch a'))
  assert.deepEqual(offer.suggestions.map(({ label, action }) => [label, action]), [['許可', 'allow'], ['拒否', 'deny']])
  assert.equal(offer.question, 'Bash を許可しますか？ touch a')
  assert.equal(offer.dangerous, false)
  assert.equal(offer.menuHint, 'touch a')
  assert.equal(offer.id, offerId(permissionAgent(), 'toolu_b'))
})

test('a file tool is described and found on its menu by the file', async () => {
  const call = { toolUseId: 't', name: 'Write', input: { file_path: '/w/memo.txt', content: 'secret' } }
  const [offer] = await offersOf([{ path: '/a', agents: [permissionAgent({ toolName: 'Write' })] }], async () => null, undefined, async () => call)
  assert.equal(offer.question, 'Write を許可しますか？ /w/memo.txt')
  assert.equal(offer.menuHint, 'memo.txt')
})

test('no buttons when the transcript says the call is over or is another call', async () => {
  const none = async (agents, call) => assert.deepEqual(await offersOf([{ path: '/a', agents }], async () => null, undefined, async () => call), [])
  await none([permissionAgent()], null)
  await none([permissionAgent()], { toolUseId: 't', name: 'Read', input: {} })
  await none([permissionAgent({ state: 'working' })], bash('ls'))
  await none([permissionAgent({ agentType: 'codex' })], bash('ls'))
  await none([permissionAgent(), permissionAgent({ paneKey: 'tab:other' })], bash('ls'))
})

test('a question is not treated as a permission', async () => {
  const offers = await offersOf([{ path: '/a', agents: [waiting()] }], async () => null, undefined, async () => ({ toolUseId: 't', name: 'AskUserQuestion', input: {} }))
  assert.deepEqual(offers, [])
})

const PR = (n, repo = 'app') => `https://github.com/org/${repo}/pull/${n}`
const replied = (text, extra = {}) => agent('done', { hasLivePty: true, lastAssistantMessage: text, ...extra })

test('linksFrom takes the pull requests of the last reply, newest first', () => {
  assert.deepEqual(linksFrom([{ path: '/a', agents: [replied(`見てください ${PR(1)}。あと ${PR(2, 'api')} も`)] }]), [
    { path: '/a', agent: 'claude', fromReply: true, links: [{ title: 'PR #2 · api', url: PR(2, 'api') }, { title: 'PR #1 · app', url: PR(1) }] }
  ])
})

test('linksFrom keeps three, once each, and adds the open pull request of the workspace', () => {
  const text = [1, 2, 3, 4, 3].map((n) => PR(n)).join(' ')
  assert.deepEqual(linksFrom([{ path: '/a', agents: [replied(text)] }])[0].links.map(({ url }) => url), [PR(3), PR(4), PR(2)])
  const [entry] = linksFrom([{ path: '/a', agents: [replied(PR(1))], linkedPR: { state: 'open', url: PR(9) } }])
  assert.deepEqual(entry.links.map(({ url }) => url), [PR(1), PR(9)])
})

test('a workspace with only its linked pull request says so', () => {
  const [entry] = linksFrom([{ path: '/a', agents: [], linkedPR: { state: 'open', url: PR(9) } }])
  assert.equal(entry.fromReply, false)
  assert.equal(entry.links.length, 1)
})

test('linksFrom leaves out what is not worth opening', () => {
  const none = (worktree) => assert.deepEqual(linksFrom([{ path: '/a', ...worktree }]), [])
  none({ agents: [replied(PR(1), { state: 'working' })] })
  none({ agents: [replied(PR(1), { hasLivePty: undefined })] })
  none({ agents: [replied('https://example.com/org/app/pull/1')] })
  none({ agents: [replied(PR(1))], isArchived: true })
  none({ agents: [], linkedPR: { state: 'merged', url: PR(1) } })
  none({ agents: [], linkedPR: { state: 'open', url: 'https://example.com/x' } })
})
