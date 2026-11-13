// Asks the Orca CLI what the agents are doing: which need the user, the same states the Milestone
// panel marks, and which finished with something to propose. `worktree ps` also returns prompts and
// replies. Of those, only the block an agent wrote for the buttons and the opening of its reply,
// which says what the buttons follow from, are kept.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { riskLabel, riskOf, whereOf } from './risk.mjs'

const BUNDLED_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const TRACKED_AGENTS = new Set(['claude', 'codex'])
// Most specific first: the reason a workspace shows when several of its agents need the user.
const REASONS = ['permission', 'blocked', 'waiting']
const SUGGESTIONS_MAX = 3
const LABEL_MAX = 30
const PROMPT_MAX = 300
// The last thing in the reply, as the agents are told to write it.
const QUESTION_MAX = 300
const OPTION_MAX = 60
const DETAIL_MAX = 200
// One key each: the menu takes the number of an option as a single key press.
const OPTIONS_MAX = 9
const QUESTIONS_MAX = 4
const TAB_KEY = '\t'
// Commands that ask for a second look before the phone may allow them. A heuristic: it can miss one.
const DANGEROUS_COMMANDS = [
  /(^|[\s;&|(])rm(\s|$)/,
  /(^|[\s;&|(])sudo(\s|$)/,
  /\bgit\s+push\b[^;&|]*\s(--force(-with-lease)?|-f)(\s|$)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bchmod\s+-R\b/,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+(destroy|apply)\b/,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i
]
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g
const LINKS_MAX = 3
// An agent at work has moved on from what its last reply linked to.
const LINKING_STATES = new Set(['done', 'waiting', 'blocked', 'permission'])
const NEXT_BLOCK = /```next[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/
const CONTROL = /[\u0000-\u001f\u007f]/
const SCREEN_LINES = '60'
const CONTEXT_MAX = 160
const REASON_MAX = 80
const PROPOSAL_NOTE = '次の作業を選べます（選ばなくても構いません）'
// For a Claude session told something older than the Milestone plugin says now, see restart.mjs.
const RESTART_CARD = { label: '最新の指示で再開', action: 'restart', detail: '同じ会話のまま、いまの plugin の指示で起動し直します' }
// Not prose: a heading, a table, a list, a fenced block or a quote says little on its own.
const NOT_PROSE = /^(#|\||```|>|[-*+] |\d+\. )/
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g
const MARKDOWN_EMPHASIS = /\*\*|`/g
const PERMISSION_STATES = ['waiting', 'permission']
// Codex's permission menu. Its second option stops asking for good, so only the first is ever pressed.
// The first option differs from nothing else on the menu: the other numbers change with the tool.
const ALLOW_ONCE_LINE = /^\s*(?:❯\s*)?1\. Yes\s*$/m
const PERMISSION_FOOTER = 'Esc to cancel'
const CODEX_ALLOW_ONCE_LINE = /^\s*(?:›\s*)?1\. Yes, proceed \(y\)\s*$/m
const CODEX_PERMISSION_FOOTER = 'Press enter to confirm or esc to cancel'
const CODEX_EDIT_MENU = 'Would you like to make the following edits?'
const CODEX_DESTINATION = 'Destination:'

/** launchd's PATH does not reach Orca's CLI. */
export function resolveOrcaCli(bundled = BUNDLED_CLI) {
  return existsSync(bundled) ? bundled : 'orca'
}

/** A workspace not on screen has no tab for its pane, and its terminal only records the key. */
export function isPane(terminal, paneKey) {
  return terminal.recordedPaneKey === paneKey || `${terminal.tabId}:${terminal.leafId}` === paneKey
}

export async function listTerminals(cli) {
  return (await runOrca(cli, ['terminal', 'list', '--json'])).terminals
}

export async function readScreen(cli, handle) {
  return (await runOrca(cli, ['terminal', 'read', '--terminal', handle, '--screen', '--limit', SCREEN_LINES, '--json'])).terminal.tail.join('\n')
}

/** What a pane shows now, or null when no terminal has it. */
export async function readPaneScreen(cli, paneKey, terminals = listTerminals, screen = readScreen) {
  const terminal = (await terminals(cli)).find((candidate) => isPane(candidate, paneKey))
  return terminal ? screen(cli, terminal.handle) : null
}

function mainAgents(worktree) {
  return (worktree.agents ?? []).filter((agent) => TRACKED_AGENTS.has(agent.agentType) && !agent.parentPaneKey)
}

/**
 * Whether a workspace may hold a Claude agent team: several Claude agents in one tab. The teammates
 * of Agent Teams run in panes beside their lead, and Orca lists each as an agent of its own.
 */
export function mayHoldTeam(worktrees) {
  return worktrees.some((worktree) => {
    const tabs = mainAgents(worktree).filter((agent) => agent.agentType === 'claude').map((agent) => agent.paneKey?.split(':')[0])
    return new Set(tabs).size < tabs.length
  })
}

/**
 * The workspaces with each teammate under its lead, as `parentPaneKey`, so that the lead alone
 * stands for the team: its cards, its state. Orca marks the terminal of a lead with the agent
 * identity `claude-agent-teams`; the other Claude agents in its tab are its teammates.
 * @param terminals the terminals of `orca terminal list`
 */
export function joinTeams(worktrees, terminals) {
  const leads = new Set(
    (terminals ?? []).filter((terminal) => terminal.agentIdentity === 'claude-agent-teams' && terminal.tabId && terminal.leafId).map((terminal) => `${terminal.tabId}:${terminal.leafId}`)
  )
  if (leads.size === 0) return worktrees
  return worktrees.map((worktree) => {
    const lead = mainAgents(worktree).find((agent) => leads.has(agent.paneKey))
    if (!lead) return worktree
    const tab = lead.paneKey.split(':')[0]
    const isTeammate = (agent) => agent !== lead && !agent.parentPaneKey && agent.agentType === 'claude' && agent.paneKey?.split(':')[0] === tab
    if (!worktree.agents.some(isTeammate)) return worktree
    return { ...worktree, agents: worktree.agents.map((agent) => (isTeammate(agent) ? { ...agent, parentPaneKey: lead.paneKey } : agent)) }
  })
}

/**
 * When the agent itself finished its turn, as Orca reports it apart from the shells it left running
 * (`mainAgent`, seen in Orca 1.4.257), or null when Orca does not say.
 */
function mainAgentDone(agent) {
  const main = agent.mainAgent
  return main?.state === 'done' && Number.isFinite(main.stateStartedAt) ? main.stateStartedAt : null
}

/**
 * The workspaces with each Claude agent that Orca calls working but whose turn is over marked as
 * done, and `background`: shells it started go on running, and it waits for the user. Its proposals
 * then show as for any agent that finished. Its `stateStartedAt` becomes the end of the turn: Orca's
 * stays where the shells began, and the cards of every later turn would get the ids of the first.
 * @param readTurnEnded  resolves a workspace path to when its Claude session ended its turn (true when
 *   the time is unknown), or null
 */
export async function settleAgents(worktrees, readTurnEnded) {
  const settled = []
  for (const worktree of worktrees) {
    const working = mainAgents(worktree).filter((agent) => agent.agentType === 'claude' && agent.state === 'working' && agent.hasLivePty === true)
    const ended = worktree.isArchived || working.length !== 1 ? null : (mainAgentDone(working[0]) ?? (await readTurnEnded(worktree.path).catch(() => null)))
    if (!ended) {
      settled.push(worktree)
      continue
    }
    settled.push({ ...worktree, agents: worktree.agents.map((agent) => (agent === working[0] ? { ...agent, state: 'done', background: true, ...(typeof ended === 'number' ? { stateStartedAt: ended } : {}) } : agent)) })
  }
  return settled
}

/** One entry per workspace with a main agent that needs the user. */
export function attentionFrom(worktrees) {
  const attention = []
  for (const worktree of worktrees) {
    if (worktree.isArchived) continue
    const agents = mainAgents(worktree)
    const reason = REASONS.find((candidate) => agents.some((agent) => agent.state === candidate))
    if (!reason) continue
    const agent = agents.find((candidate) => candidate.state === reason)
    attention.push({ path: worktree.path, agent: agent.agentType, reason })
  }
  return attention
}

function isSuggestion(value) {
  if (typeof value?.label !== 'string' || typeof value?.prompt !== 'string') return false
  const label = value.label.trim()
  const prompt = value.prompt.trim()
  if (!label || !prompt || CONTROL.test(label) || CONTROL.test(prompt)) return false
  // The prompt goes on a command line as the value of an option.
  return [...label].length <= LABEL_MAX && [...prompt].length <= PROMPT_MAX && !prompt.startsWith('-')
}

/** The actions an agent proposed at the end of its reply. A bad block is the same as none. */
export function parseSuggestions(message) {
  const block = NEXT_BLOCK.exec(message ?? '')
  if (!block) return []
  let list
  try {
    list = JSON.parse(block[1])
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list
    .filter(isSuggestion)
    .slice(0, SUGGESTIONS_MAX)
    .map(({ label, prompt, reason }) => ({ label: label.trim(), prompt: prompt.trim(), ...reasonField(reason) }))
}

/** Optional, and only shown: a bad one costs the reason, not the button. */
function reasonField(reason) {
  if (typeof reason !== 'string' || !reason.trim() || CONTROL.test(reason)) return {}
  return { reason: shorten(reason, REASON_MAX) }
}

/** Changes with every turn, so a button shown for an earlier reply matches nothing. */
export function offerId(agent, extra = '') {
  return createHash('sha256').update(`${agent.paneKey}\n${agent.stateStartedAt}\n${extra}`).digest('hex').slice(0, 16)
}

function soleAgent(worktree) {
  if (worktree.isArchived) return null
  // Orca keeps the record of a pane that has closed, without this field.
  const agents = mainAgents(worktree).filter((agent) => agent.hasLivePty === true)
  return agents.length === 1 ? agents[0] : null
}

function shorten(text, max) {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

/**
 * The buttons for one question that has one answer. The options keep their order and none is left
 * out, since the key to press is the position. Anything else is answered at the terminal.
 */
export function questionButtons(asked) {
  if (asked?.questions?.length !== 1) return null
  const [{ question, multiSelect, options }] = asked.questions
  if (typeof question !== 'string' || !question.trim() || multiSelect) return null
  if (!Array.isArray(options) || options.length === 0 || options.length > OPTIONS_MAX) return null
  if (!options.every((option) => typeof option?.label === 'string' && option.label.trim())) return null
  return {
    question: shorten(question, QUESTION_MAX),
    suggestions: options.map((option, index) => ({
      label: shorten(option.label, OPTION_MAX),
      keys: String(index + 1),
      detail: typeof option.description === 'string' ? shorten(option.description, DETAIL_MAX) : ''
    }))
  }
}

/** What the phone shows for questions a single key cannot answer: several, or several choices. */
export function questionForm(asked) {
  const questions = asked?.questions
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > QUESTIONS_MAX) return null
  const valid = questions.every(
    ({ question, options } = {}) =>
      typeof question === 'string' && question.trim() &&
      Array.isArray(options) && options.length > 0 && options.length <= OPTIONS_MAX &&
      options.every((option) => typeof option?.label === 'string' && option.label.trim())
  )
  if (!valid) return null
  return questions.map(({ question, multiSelect, options }) => ({
    question: shorten(question, QUESTION_MAX),
    multiSelect: multiSelect === true,
    options: options.map((option) => ({
      label: shorten(option.label, OPTION_MAX),
      detail: typeof option.description === 'string' ? shorten(option.description, DETAIL_MAX) : ''
    }))
  }))
}

/**
 * The keys that answer a form, or null for answers that do not fit it. A number on a question with
 * one answer moves to the next question by itself; with several answers it only ticks the option,
 * and Tab moves on. After the last question the menu shows a review page, left for the caller.
 */
export function answerKeys(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) return null
  const keys = []
  for (const [position, { multiSelect, options }] of questions.entries()) {
    const chosen = answers[position]
    if (!Array.isArray(chosen) || chosen.length === 0 || new Set(chosen).size !== chosen.length) return null
    if (!multiSelect && chosen.length !== 1) return null
    if (!chosen.every((index) => Number.isInteger(index) && index >= 0 && index < options.length)) return null
    keys.push(...chosen.map((index) => String(index + 1)))
    if (multiSelect) keys.push(TAB_KEY)
  }
  return keys
}

export function isDangerous(call) {
  return call.name === 'Bash' && typeof call.input?.command === 'string' && DANGEROUS_COMMANDS.some((pattern) => pattern.test(call.input.command))
}

/** What a tool call would do, in a line, and a piece of it that its permission menu shows. */
function describeCall({ name, input }) {
  if (typeof input.command === 'string') {
    return { summary: shorten(input.command, QUESTION_MAX), menuHint: input.command.trim().split('\n')[0].slice(0, 24) }
  }
  if (typeof input.file_path === 'string') {
    return { summary: shorten(input.file_path, QUESTION_MAX), menuHint: basename(input.file_path) }
  }
  return { summary: shorten(JSON.stringify(input), QUESTION_MAX), menuHint: '' }
}

/** Keys are pressed only on the menu for this very call, read from the screen just before. */
export function isPermissionMenu(screen, menuHint) {
  return ALLOW_ONCE_LINE.test(screen) && screen.includes(PERMISSION_FOOTER) && screen.includes(menuHint)
}

/**
 * The call a Claude Code menu asks about. The transcript says best, and it cannot say "waiting" after
 * the user answered at the terminal, as Orca can. But while several calls of one turn wait, Claude
 * Code has written none of them yet: then a shell command is taken from Orca, and only while its
 * menu is on the screen.
 */
async function claudeCall(worktree, agent, readCall, readPane) {
  const call = await readCall(worktree.path).catch(() => null)
  if (call) return call.name === agent.toolName ? call : null
  if (agent.toolName !== 'Bash' || typeof agent.toolInput !== 'string' || !agent.toolInput.trim()) return null
  const fromOrca = { toolUseId: agent.toolInput, name: 'Bash', input: { command: agent.toolInput } }
  const shown = await readPane(agent.paneKey).catch(() => null)
  return shown && isPermissionMenu(shown, describeCall(fromOrca).menuHint) ? fromOrca : null
}

/**
 * The line a permission card asks with: what kind of call it is, the call, and where a shell command
 * runs when that is not the workspace itself. The phone shows it as it is.
 */
export function permissionQuestion({ what, summary, risk, dangerous, where }) {
  return `［${riskLabel(risk, dangerous)}］${what} を許可しますか？ ${summary}${where ? `\n場所: ${where}` : ''}`
}

const REST_CARD = { label: 'このターンの残りも許可', action: 'allow-rest', detail: '今回を許可し、このターンの残りも、書き換えるまでのものは自動で許可します' }
const ALLOWED_SHOWN = 5

/**
 * A session started with the Milestone plugin's PermissionRequest hook can allow the rest of its
 * turn: one more button, never for a dangerous command, since the grant would not cover the next.
 */
async function permissionOffer(worktree, readCall, readPane, readRest) {
  const agent = soleAgent(worktree)
  if (agent?.agentType !== 'claude' || !PERMISSION_STATES.includes(agent.state) || !agent.toolName || agent.toolName === 'AskUserQuestion') return null
  const call = await claudeCall(worktree, agent, readCall, readPane)
  if (!call) return null
  const { summary, menuHint } = describeCall(call)
  const risk = riskOf(call)
  const dangerous = isDangerous(call)
  const where = whereOf(call, worktree.path)
  const rest = dangerous ? null : await readRest(worktree.path).catch(() => null)
  return {
    id: offerId(agent, call.toolUseId),
    path: worktree.path,
    agent: agent.agentType,
    paneKey: agent.paneKey,
    question: permissionQuestion({ what: call.name, summary, risk, dangerous, where }),
    menuHint,
    risk,
    where,
    dangerous,
    suggestions: [
      { label: '許可', action: 'allow', detail: '今回だけ実行します' },
      { label: '拒否', action: 'deny', detail: '実行しません' },
      ...(rest ? [REST_CARD] : [])
    ],
    ...(rest ? { sessionId: rest.sessionId } : {})
  }
}

/** What the rest of this turn allowed without a button, after what an offer says, to read later. */
function withAllowed(offer, allowed) {
  if (!allowed?.length || typeof offer.question !== 'string') return offer
  const shown = allowed.slice(-ALLOWED_SHOWN).map((line) => shorten(line, OPTION_MAX))
  const more = allowed.length > shown.length ? `（ほか ${allowed.length - shown.length} 件）` : ''
  return { ...offer, allowed, question: `${offer.question}\nこのターンでまとめて許可: ${shown.join(' / ')}${more}` }
}

/** Keys are pressed only on Codex's menu for this very call, read from the screen just before. */
export function isCodexPermissionMenu(screen, menuHint) {
  return CODEX_ALLOW_ONCE_LINE.test(screen) && screen.includes(CODEX_PERMISSION_FOOTER) && screen.includes(menuHint)
}

/** The file a Codex edit would change. A long path is wrapped over several lines of the screen. */
function codexEditTarget(screen) {
  const lines = screen.split('\n')
  const start = lines.findLastIndex((line) => line.trim() === CODEX_DESTINATION)
  const end = lines.findLastIndex((line) => CODEX_ALLOW_ONCE_LINE.test(line))
  return start >= 0 && end > start ? lines.slice(start + 1, end).map((line) => line.trim()).join('') : ''
}

/** Only a shell command and a file edit: the menus of other tools have not been seen. */
function describeCodexCall(worktree, agent, shown) {
  if (agent.toolName === 'apply_patch') {
    const target = codexEditTarget(shown)
    return target ? { what: 'ファイルの編集', summary: shorten(target, QUESTION_MAX), menuHint: CODEX_EDIT_MENU, risk: 'write', dangerous: false, where: '' } : null
  }
  if (agent.toolName !== 'Bash' || typeof agent.toolInput !== 'string' || !agent.toolInput.trim()) return null
  const call = { name: 'Bash', input: { command: agent.toolInput } }
  return { what: 'Bash', ...describeCall(call), risk: riskOf(call), dangerous: isDangerous(call), where: whereOf(call, worktree.path) }
}

async function codexPermissionOffer(worktree, readPane) {
  const agent = soleAgent(worktree)
  if (agent?.agentType !== 'codex' || !PERMISSION_STATES.includes(agent.state) || !agent.toolName) return null
  // Orca keeps the last toolName after the call, and other prompts also read as waiting. The menu cannot.
  const shown = await readPane(agent.paneKey).catch(() => null)
  const call = shown ? describeCodexCall(worktree, agent, shown) : null
  if (!call || !isCodexPermissionMenu(shown, call.menuHint)) return null
  return {
    id: offerId(agent, call.summary),
    path: worktree.path,
    agent: agent.agentType,
    paneKey: agent.paneKey,
    question: permissionQuestion(call),
    menuHint: call.menuHint,
    risk: call.risk,
    where: call.where,
    dangerous: call.dangerous,
    suggestions: [
      { label: '許可', action: 'allow', detail: '今回だけ実行します' },
      // Esc ends Codex's turn: unlike Claude Code, it does not go on without the call.
      { label: '中止', action: 'deny', detail: '実行せず、このターンを止めます' }
    ]
  }
}

async function questionOffer(worktree, readQuestion) {
  const agent = soleAgent(worktree)
  if (agent?.agentType !== 'claude' || agent.state !== 'waiting' || agent.toolName !== 'AskUserQuestion') return null
  const asked = await readQuestion(worktree.path).catch(() => null)
  const buttons = questionButtons(asked)
  const questions = buttons ? null : questionForm(asked)
  if (!buttons && !questions) return null
  return {
    id: offerId(agent, asked.toolUseId),
    path: worktree.path,
    agent: agent.agentType,
    paneKey: agent.paneKey,
    ...(buttons ?? { suggestions: [], questions })
  }
}

/**
 * What every agent offers now: what it proposed after finishing, and what it is asking.
 * @param readLaunch  resolves a workspace path to its Claude session told something older than the
 *   Milestone plugin says now, see restart.mjs
 * @param readRest  resolves a workspace path to `{ sessionId }` when its Claude session can allow
 *   the rest of a turn, else null
 * @param readAllowed  resolves a workspace path to what the rest of its Claude session's turn allowed
 */
export async function offersOf(worktrees, readQuestion, readSuggestions = async () => new Map(), readCall = async () => null, readPane = async () => null, readLaunch = async () => null, { readRest = async () => null, readAllowed = async () => [] } = {}) {
  const finished = worktrees.map(soleAgent).filter((agent) => agent?.agentType === 'claude' && agent.state === 'done')
  const shown = finished.length > 0 ? await readSuggestions(finished.map((agent) => agent.paneKey)).catch(() => new Map()) : new Map()
  const launches = new Map()
  for (const worktree of worktrees) {
    const agent = soleAgent(worktree)
    if (agent?.agentType !== 'claude' || agent.state !== 'done' || agent.background) continue
    const launch = await readLaunch(worktree.path).catch(() => null)
    if (launch) launches.set(worktree.path, launch)
  }
  const offers = offersFrom(worktrees, shown, launches)
  for (const worktree of worktrees) {
    const offer = (await questionOffer(worktree, readQuestion)) ?? (await permissionOffer(worktree, readCall, readPane, readRest)) ?? (await codexPermissionOffer(worktree, readPane))
    if (offer) offers.push(offer)
  }
  const listed = []
  for (const offer of offers) {
    listed.push(offer.agent === 'claude' && (offer.kind === 'proposal' || offer.menuHint) ? withAllowed(offer, await readAllowed(offer.path).catch(() => [])) : offer)
  }
  return listed
}

/** The opening of the reply, then why cards follow it: on their own they do not say. */
function proposalContext(reply) {
  const opening = (reply ?? '').replace(NEXT_BLOCK, '').split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !NOT_PROSE.test(part))
  const summary = opening ? shorten(opening.replace(MARKDOWN_LINK, '$1').replace(MARKDOWN_EMPHASIS, ''), CONTEXT_MAX) : ''
  return summary ? `${summary}\n${PROPOSAL_NOTE}` : PROPOSAL_NOTE
}

/**
 * One entry per workspace whose agent finished and proposed something. A workspace with several
 * main agents has none: the board shows one card for it, so a button could not say which it means.
 * @param shown  the suggestion Claude Code shows in the input box of each pane, as one more button
 */
export function offersFrom(worktrees, shown = new Map(), launches = new Map()) {
  const offers = []
  for (const worktree of worktrees) {
    const agent = soleAgent(worktree)
    if (agent?.state !== 'done') continue
    const suggestions = parseSuggestions(agent.lastAssistantMessage)
    const text = shown.get(agent.paneKey)
    const extra = text ? { label: shorten(text, LABEL_MAX), prompt: text, detail: '' } : null
    if (extra && isSuggestion(extra) && !suggestions.some(({ prompt }) => prompt === text)) suggestions.push(extra)
    const launch = agent.agentType === 'claude' && !agent.background ? launches.get(worktree.path) : null
    if (launch) suggestions.push(RESTART_CARD)
    if (suggestions.length === 0) continue
    offers.push({
      id: offerId(agent, `${text ?? ''}${launch ? `\n${launch.sessionId}` : ''}`),
      kind: 'proposal',
      // When the turn ended, so that a notification is sent only for a proposal that is new.
      since: agent.stateStartedAt ?? 0,
      path: worktree.path,
      agent: agent.agentType,
      paneKey: agent.paneKey,
      question: proposalContext(agent.lastAssistantMessage),
      suggestions,
      ...(launch ? { sessionId: launch.sessionId } : {})
    })
  }
  return offers
}

function pullLinks(text) {
  return [...(text ?? '').matchAll(PR_URL)].map(([url, repository, number]) => ({ title: `PR #${number} · ${repository}`, url }))
}

/**
 * The pull requests to open from each workspace: those the last reply of an agent links to, newest
 * first, then the one Orca has linked to the workspace.
 */
export function linksFrom(worktrees) {
  const entries = []
  for (const worktree of worktrees) {
    if (worktree.isArchived) continue
    const agents = mainAgents(worktree).filter((agent) => agent.hasLivePty === true)
    const replied = agents.filter((agent) => LINKING_STATES.has(agent.state)).flatMap((agent) => pullLinks(agent.lastAssistantMessage).reverse())
    const linked = worktree.linkedPR?.state === 'open' ? pullLinks(worktree.linkedPR.url) : []
    const links = [...new Map([...replied, ...linked].map((link) => [link.url, link])).values()].slice(0, LINKS_MAX)
    if (links.length === 0) continue
    entries.push({ path: worktree.path, agent: agents[0]?.agentType ?? 'claude', links, fromReply: replied.length > 0 })
  }
  return entries
}

export function runOrca(cli, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`could not run the Orca CLI (exit ${error.code ?? 'unknown'})`))
        return
      }
      try {
        const response = JSON.parse(stdout)
        if (!response?.ok) throw new Error('the Orca CLI reported a failure')
        resolve(response.result)
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

export async function readWorktrees(cli) {
  return (await runOrca(cli, ['worktree', 'ps', '--limit', '1000', '--json'])).worktrees
}

/**
 * While Orca cannot answer, the last answer stands: nothing is known to have changed, and clearing
 * it would send a notification again when Orca comes back.
 */
export function createAgentReader({ cli = resolveOrcaCli(), read = readWorktrees, readQuestion = async () => null, readSuggestions, readCall, readTurnEnded = async () => null, readTerminals = () => listTerminals(cli), readLaunch, readGrants, readPane = (paneKey) => readPaneScreen(cli, paneKey), log = () => {} } = {}) {
  let attention = []
  let offers = []
  let links = []
  let failing = false
  return {
    async readAttention() {
      try {
        let listed = await read(cli)
        if (mayHoldTeam(listed)) listed = joinTeams(listed, await readTerminals().catch(() => []))
        const worktrees = await settleAgents(listed, readTurnEnded)
        attention = attentionFrom(worktrees)
        offers = await offersOf(worktrees, readQuestion, readSuggestions, readCall, readPane, readLaunch, readGrants)
        links = linksFrom(worktrees)
        failing = false
      } catch (error) {
        if (!failing) log(`keeping the last agent states: ${error.message}`)
        failing = true
      }
      return attention
    },
    /** What the last `readAttention` found, so that one reading serves both. */
    readOffers: () => offers,
    readLinks: () => links
  }
}
