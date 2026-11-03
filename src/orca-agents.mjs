// Asks the Orca CLI which agents need the user, the same states the Milestone panel marks. Only the
// state and the path are kept: `worktree ps` also returns prompts and replies, which stay here.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const BUNDLED_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const TRACKED_AGENTS = new Set(['claude', 'codex'])
// Most specific first: the reason a workspace shows when several of its agents need the user.
const REASONS = ['permission', 'blocked', 'waiting']

/** launchd's PATH does not reach Orca's CLI. */
export function resolveOrcaCli(bundled = BUNDLED_CLI) {
  return existsSync(bundled) ? bundled : 'orca'
}

/** One entry per workspace with a main agent that needs the user. */
export function attentionFrom(worktrees) {
  const attention = []
  for (const worktree of worktrees) {
    if (worktree.isArchived) continue
    const agents = (worktree.agents ?? []).filter((agent) => TRACKED_AGENTS.has(agent.agentType) && !agent.parentPaneKey)
    const reason = REASONS.find((candidate) => agents.some((agent) => agent.state === candidate))
    if (!reason) continue
    const agent = agents.find((candidate) => candidate.state === reason)
    attention.push({ path: worktree.path, agent: agent.agentType, reason })
  }
  return attention
}

function readWorktrees(cli) {
  return new Promise((resolve, reject) => {
    execFile(cli, ['worktree', 'ps', '--limit', '1000', '--json'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`could not run the Orca CLI (exit ${error.code ?? 'unknown'})`))
        return
      }
      try {
        const response = JSON.parse(stdout)
        if (!response?.ok) throw new Error('the Orca CLI reported a failure')
        resolve(response.result.worktrees)
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

/**
 * While Orca cannot answer, the last answer stands: nothing is known to have changed, and clearing
 * it would send a notification again when Orca comes back.
 */
export function createAttentionReader({ cli = resolveOrcaCli(), read = readWorktrees, log = () => {} } = {}) {
  let last = []
  let failing = false
  return async function readAttention() {
    try {
      last = attentionFrom(await read(cli))
      failing = false
    } catch (error) {
      if (!failing) log(`keeping the last agent states: ${error.message}`)
      failing = true
    }
    return last
  }
}
