// Asks the Orca CLI what the agents are doing: which need the user, the same states the Milestone
// panel marks, and which finished with something to propose. `worktree ps` also returns prompts and
// replies. Of those, only the block an agent wrote for the buttons is kept.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

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
// One key each: the menu takes the number of an option as a single key press.
const OPTIONS_MAX = 9
const NEXT_BLOCK = /```next[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/
const CONTROL = /[\u0000-\u001f\u007f]/

/** launchd's PATH does not reach Orca's CLI. */
export function resolveOrcaCli(bundled = BUNDLED_CLI) {
  return existsSync(bundled) ? bundled : 'orca'
}

function mainAgents(worktree) {
  return (worktree.agents ?? []).filter((agent) => TRACKED_AGENTS.has(agent.agentType) && !agent.parentPaneKey)
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
    .map(({ label, prompt }) => ({ label: label.trim(), prompt: prompt.trim() }))
}

/** Changes with every turn, so a button shown for an earlier reply matches nothing. */
export function offerId(agent, extra = '') {
  return createHash('sha256').update(`${agent.paneKey}\n${agent.stateStartedAt}\n${extra}`).digest('hex').slice(0, 16)
}

function soleAgent(worktree) {
  if (worktree.isArchived) return null
  const agents = mainAgents(worktree).filter((agent) => agent.hasLivePty !== false)
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
    suggestions: options.map((option, index) => ({ label: shorten(option.label, OPTION_MAX), keys: String(index + 1) }))
  }
}

async function questionOffer(worktree, readQuestion) {
  const agent = soleAgent(worktree)
  if (agent?.agentType !== 'claude' || agent.state !== 'waiting' || agent.toolName !== 'AskUserQuestion') return null
  const asked = await readQuestion(worktree.path).catch(() => null)
  const buttons = questionButtons(asked)
  if (!buttons) return null
  return { id: offerId(agent, asked.toolUseId), path: worktree.path, agent: agent.agentType, paneKey: agent.paneKey, ...buttons }
}

/** What every agent offers now: what it proposed after finishing, and what it is asking. */
export async function offersOf(worktrees, readQuestion) {
  const offers = offersFrom(worktrees)
  for (const worktree of worktrees) {
    const offer = await questionOffer(worktree, readQuestion)
    if (offer) offers.push(offer)
  }
  return offers
}

/**
 * One entry per workspace whose agent finished and proposed something. A workspace with several
 * main agents has none: the board shows one card for it, so a button could not say which it means.
 */
export function offersFrom(worktrees) {
  const offers = []
  for (const worktree of worktrees) {
    const agent = soleAgent(worktree)
    if (agent?.state !== 'done') continue
    const suggestions = parseSuggestions(agent.lastAssistantMessage)
    if (suggestions.length === 0) continue
    offers.push({ id: offerId(agent), path: worktree.path, agent: agent.agentType, paneKey: agent.paneKey, suggestions })
  }
  return offers
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
export function createAgentReader({ cli = resolveOrcaCli(), read = readWorktrees, readQuestion = async () => null, log = () => {} } = {}) {
  let attention = []
  let offers = []
  let failing = false
  return {
    async readAttention() {
      try {
        const worktrees = await read(cli)
        attention = attentionFrom(worktrees)
        offers = await offersOf(worktrees, readQuestion)
        failing = false
      } catch (error) {
        if (!failing) log(`keeping the last agent states: ${error.message}`)
        failing = true
      }
      return attention
    },
    /** What the last `readAttention` found, so that one reading serves both. */
    readOffers: () => offers
  }
}
