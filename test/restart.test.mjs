import assert from 'node:assert/strict'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createNextSender } from '../src/next-actions.mjs'
import { offersFrom, offersOf } from '../src/orca-agents.mjs'
import { createHookReader, createLaunchReader, createRestarter, inputText, isInputEmpty, resumeCommand } from '../src/restart.mjs'

const SESSION = '5f67451a-058b-4e44-98fa-349658ba37bf'
const NEW_WORDS = 'Record your work as tasks, newest.'
const withTaskInstructions = (command) => command.replace(/^(claude|orca claude-teams)/, `$1 --append-system-prompt '${NEW_WORDS}'`)
const hook = { instructions: NEW_WORDS, withTaskInstructions }
const PLUGIN = '/Users/u/Library/Application Support/orca/claude-agent-view/d533/orca-agent-view'
const OLD_ARGS = `claude --append-system-prompt Old words. --plugin-dir ${PLUGIN} --dangerously-skip-permissions --resume ${SESSION}`
const RULE = '─'.repeat(40)
const screen = (typed = '') => `● できました\n${RULE}\n❯ ${typed}\n${RULE}\n  ⏵⏵ bypass permissions on`

test('the launch hook is read again once it changes, and a missing one gives no restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-'))
  const path = join(dir, 'launch-hook.mjs')
  const write = async (words, time) => {
    await writeFile(path, `export const claudeInstructions = () => ${JSON.stringify(words)}\nexport const withTaskInstructions = (c) => c\n`)
    await utimes(path, time, time)
  }
  await write('first', 1000)
  const read = createHookReader(path)
  assert.equal((await read()).instructions, 'first')
  await write('second', 2000)
  assert.equal((await read()).instructions, 'second')
  assert.equal(await createHookReader(join(dir, 'none.mjs'))(), null)
  assert.equal(await createHookReader(null)(), null)
})

test('the resumed command keeps permissions, the model and the plugin folder, with the new words', () => {
  const shell = resumeCommand(OLD_ARGS, SESSION, withTaskInstructions)
  assert.equal(shell, `env CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude --append-system-prompt '${NEW_WORDS}' --dangerously-skip-permissions --plugin-dir '${PLUGIN}' --resume ${SESSION}`)
  const teams = resumeCommand(`claude --teammate-mode auto --append-system-prompt Old --dangerously-skip-permissions --model opus --resume ${SESSION}`, SESSION, withTaskInstructions)
  assert.equal(teams, `env CLAUDE_CODE_ENABLE_TODO_TOOLS=1 orca claude-teams --append-system-prompt '${NEW_WORDS}' --dangerously-skip-permissions --model opus --resume ${SESSION}`)
})

test('the input box is read from the screen, and its gray suggestion counts as empty', () => {
  assert.equal(inputText(screen()), '')
  assert.equal(inputText(screen('half a thought')), 'half a thought')
  assert.equal(inputText('no box'), null)
  assert.equal(isInputEmpty('PR を作って', 'PR を作ってください'), true)
  assert.equal(isInputEmpty('ほかのこと', 'PR を作ってください'), false)
})

const reply = 'できました\n```next\n[{"label":"A","prompt":"do a"}]\n```'
const claude = (extra = {}) => ({ agentType: 'claude', state: 'done', paneKey: 'tab:leaf', hasLivePty: true, stateStartedAt: 5, lastAssistantMessage: reply, ...extra })

test('a waiting session told something older gets a restart card after its proposals', async () => {
  const launches = new Map([['/w', { sessionId: SESSION }]])
  const [offer] = offersFrom([{ path: '/w', agents: [claude()] }], new Map(), launches)
  assert.deepEqual(offer.suggestions.map((s) => [s.label, s.action]), [['A', undefined], ['最新の指示で再開', 'restart']])
  assert.equal(offer.sessionId, SESSION)
  assert.notEqual(offer.id, offersFrom([{ path: '/w', agents: [claude()] }])[0].id)
  assert.deepEqual(offersFrom([{ path: '/w', agents: [claude({ lastAssistantMessage: 'hi' })] }], new Map(), launches)[0].suggestions.map((s) => s.action), ['restart'])
  assert.deepEqual(offersFrom([{ path: '/w', agents: [claude({ lastAssistantMessage: 'hi', background: true })] }], new Map(), launches), [], 'not with shells in the background')
  const read = []
  const offers = await offersOf([{ path: '/w', agents: [claude()] }, { path: '/x', agents: [claude({ state: 'working' })] }], async () => null, undefined, undefined, undefined, async (path) => (read.push(path), { sessionId: SESSION }))
  assert.deepEqual(read, ['/w'], 'only a waiting Claude is looked at')
  assert.equal(offers[0].suggestions.at(-1).action, 'restart')
})

function setup({ typed = '', parent = '-/opt/homebrew/bin/fish -l', exits = true, launch = { sessionId: SESSION, pid: 41, args: OLD_ARGS }, readHook = async () => hook } = {}) {
  const calls = []
  const logged = []
  let alive = true
  let time = 0
  const restart = createRestarter({
    home: '/h',
    readHook,
    readLaunch: async () => launch,
    readScreen: async () => screen(typed),
    send: async (handle, text, enter) => {
      calls.push(['send', handle, text, enter])
      if (text === '/exit' && exits) alive = false
    },
    create: async (path, title, command) => calls.push(['create', path, title, command]),
    readOutput: async () => '',
    parentArgs: async () => parent,
    running: () => alive,
    sessions: async () => [{ sessionId: SESSION, pid: alive ? 41 : 99 }],
    wait: async (ms) => { time += ms },
    now: () => time,
    log: (line) => logged.push(line)
  })
  return { calls, logged, go: () => restart({ path: '/w', sessionId: SESSION }, { handle: 'h1', ptyId: 'p1', title: 'Claude Tag 相当機能' }) }
}

test('a session started from a shell exits and starts again in the same terminal', async () => {
  const { calls, logged, go } = setup()
  assert.equal(await go(), true)
  assert.deepEqual(calls, [['send', 'h1', '/exit', true], ['send', 'h1', resumeCommand(OLD_ARGS, SESSION, withTaskInstructions), true]])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(logged, ['a Claude session runs again under the newest instructions'])
})

test('a session Orca started gets a new terminal with the same title', async () => {
  const { calls, go } = setup({ parent: '/Applications/Orca.app/Contents/MacOS/Orca' })
  assert.equal(await go(), true)
  assert.deepEqual(calls[1].slice(0, 3), ['create', '/w', 'Claude Tag 相当機能'])
})

test('nothing is sent over a draft, to another session, without a hook, or to a session that will not exit', async () => {
  const draft = setup({ typed: 'half a thought' })
  assert.equal(await draft.go(), 'draft')
  assert.deepEqual(draft.calls, [])
  assert.equal(await setup({ launch: null }).go(), false)
  assert.equal(await setup({ launch: { sessionId: 'other', pid: 41, args: OLD_ARGS } }).go(), false)
  assert.equal(await setup({ readHook: async () => null }).go(), false)
  const stuck = setup({ exits: false })
  await assert.rejects(stuck.go(), /did not exit/)
  assert.deepEqual(stuck.calls.at(-1), ['send', 'h1', '\u001b', false], 'closes a dialog that kept it open')
})

test('the sender hands a restart card to the restarter once, and again after a refusal', async () => {
  const worktrees = [{ path: '/w', agents: [claude()] }]
  const launch = { sessionId: SESSION }
  const answers = ['draft', true]
  const pressed = []
  const next = createNextSender({
    cli: 'orca',
    read: async () => worktrees,
    readLaunch: async () => launch,
    terminals: async () => [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: true }],
    restart: async (found, terminal) => (pressed.push([found.sessionId, terminal.handle]), answers.shift())
  })
  const [offer] = offersFrom(worktrees, new Map(), new Map([['/w', launch]]))
  assert.equal(await next({ offer: offer.id, index: 1 }), 'draft')
  assert.equal(await next({ offer: offer.id, index: 1 }), true)
  assert.equal(await next({ offer: offer.id, index: 1 }), false)
  assert.deepEqual(pressed, [[SESSION, 'h1'], [SESSION, 'h1']])
})

test('the hook reader also loads the grants next to the launch hook, and the signature tells a stale session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-'))
  await writeFile(join(dir, 'launch-hook.mjs'), 'export const claudeInstructions = () => "words"\nexport const withTaskInstructions = (c) => c\nexport const launchSignature = () => ["words", "permission-hook.mjs"]\n')
  await writeFile(join(dir, 'turn-grant.mjs'), 'export const createGrantAccess = () => ({})\n')
  const hook = await createHookReader(join(dir, 'launch-hook.mjs'))()
  assert.deepEqual(hook.signature, ['words', 'permission-hook.mjs'])
  assert.equal(typeof hook.grants.createGrantAccess, 'function')
  const readLaunch = createLaunchReader('/h', async () => hook, { readLaunchInfo: async (path) => ({ sessionId: SESSION, pid: 1, args: path === '/old' ? 'claude words' : 'claude words --settings permission-hook.mjs' }) })
  assert.equal((await readLaunch('/old')).sessionId, SESSION, 'without the hook it is stale')
  assert.equal(await readLaunch('/new'), null)
})

test('a permission in a hooked session offers the rest of its turn, lists what it allowed, and grants before the key', async () => {
  const MENU = 'Bash command\n touch a\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow\n   4. No\n Esc to cancel · Tab to amend'
  const worktrees = [{ path: '/w', agents: [claude({ state: 'waiting', toolName: 'Bash' })] }]
  const readCall = async () => ({ toolUseId: 't1', name: 'Bash', input: { command: 'touch a' } })
  const readGrants = { readRest: async () => ({ sessionId: SESSION }), readAllowed: async () => ['touch b', 'touch c'] }
  const [offer] = await offersOf(worktrees, async () => null, undefined, readCall, async () => MENU, undefined, readGrants)
  assert.deepEqual(offer.suggestions.map((s) => s.action), ['allow', 'deny', 'allow-rest'])
  assert.ok(offer.question.endsWith('\nこのターンでまとめて許可: touch b / touch c'), offer.question)
  const [risky] = await offersOf(worktrees, async () => null, undefined, async () => ({ toolUseId: 't2', name: 'Bash', input: { command: 'rm -rf x' } }), async () => MENU.replace('touch a', 'rm -rf x'), undefined, readGrants)
  assert.deepEqual(risky.suggestions.map((s) => s.action), ['allow', 'deny'], 'not for a dangerous command')
  const order = []
  const next = createNextSender({
    cli: 'orca',
    read: async () => worktrees,
    readCall,
    readGrants,
    terminals: async () => [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: true }],
    screen: async () => MENU,
    readPane: async () => MENU,
    pressKeys: async (_cli, _handle, keys) => order.push(['key', keys]),
    grantRest: async (sessionId) => order.push(['grant', sessionId])
  })
  assert.equal(await next({ offer: offer.id, index: 2 }), true)
  assert.deepEqual(order, [['grant', SESSION], ['key', '1']])
})
