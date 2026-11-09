// Sends an action an agent proposed, or the answer to its question, when the user presses a button.
// The phone says only which button: what to send comes from what the agent wrote, read again now,
// so a phone cannot send anything else and a button from an earlier turn does nothing.
import { offersOf, readWorktrees, resolveOrcaCli, runOrca } from './orca-agents.mjs'

const USED_MAX = 256
const SUBMIT_WAIT_SECONDS = '8'
const SEND_TIMEOUT_MS = 20_000
// Claude Code's "stash": it takes what is in the input box and puts it back after the next submit.
const STASH_KEY = '\u0013'
const STASH_WAIT_MS = 400
// Codex shows this while its input box is empty. Text in the box does not show on a screen read.
const CODEX_EMPTY_HINT = '? for shortcuts'

async function listTerminals(cli) {
  return (await runOrca(cli, ['terminal', 'list', '--json'])).terminals
}

async function sendPrompt(cli, handle, prompt) {
  const result = await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', SUBMIT_WAIT_SECONDS, '--json'], SEND_TIMEOUT_MS)
  if (!result.send?.accepted) throw new Error('the terminal did not accept the prompt')
}

/** A prompt pasted over a draft would join it, so the draft is set aside and comes back afterwards. */
async function stashDraft(cli, handle) {
  await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', STASH_KEY, '--json'])
  await new Promise((resolve) => setTimeout(resolve, STASH_WAIT_MS))
}

async function readScreen(cli, handle) {
  return (await runOrca(cli, ['terminal', 'read', '--terminal', handle, '--screen', '--limit', '60', '--json'])).terminal.tail.join('\n')
}

/** Without Enter: the menu takes a number as one key press, and Enter would go on to the next one. */
async function sendKeys(cli, handle, keys) {
  const result = await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', keys, '--json'])
  if (!result.send?.accepted) throw new Error('the terminal did not accept the key')
}

/** A workspace not on screen has no tab for its pane, and its terminal only records the key. */
function isPane(terminal, paneKey) {
  return terminal.recordedPaneKey === paneKey || `${terminal.tabId}:${terminal.leafId}` === paneKey
}

/**
 * @returns a function that takes `{ offer, index }` and resolves to true once the agent has the
 *   prompt, false when that button is no longer on offer, or 'typing' when a draft in Codex's
 *   input box would be sent along with it. It throws when sending fails.
 */
export function createNextSender({ cli = resolveOrcaCli(), read = readWorktrees, readQuestion = async () => null, terminals = listTerminals, send = sendPrompt, pressKeys = sendKeys, stash = stashDraft, screen = readScreen, onSent = () => {}, log = () => {} } = {}) {
  const used = new Set()

  function take(offer) {
    used.add(offer)
    if (used.size > USED_MAX) used.delete(used.values().next().value)
  }

  return async function next({ offer, index }) {
    if (used.has(offer)) return false
    const found = (await offersOf(await read(cli), readQuestion)).find((candidate) => candidate.id === offer)
    const suggestion = found?.suggestions[index]
    if (!suggestion) return false
    const terminal = (await terminals(cli)).find((candidate) => isPane(candidate, found.paneKey) && candidate.writable)
    if (!terminal) return false
    if (found.agent === 'codex' && !suggestion.keys && !(await screen(cli, terminal.handle)).includes(CODEX_EMPTY_HINT)) return 'typing'
    // Checked again here, right before the send: a second press may have arrived during the reads.
    if (used.has(offer)) return false
    take(offer)
    try {
      if (suggestion.keys) await pressKeys(cli, terminal.handle, suggestion.keys)
      else {
        if (found.agent === 'claude') await stash(cli, terminal.handle)
        await send(cli, terminal.handle, suggestion.prompt)
      }
    } catch (error) {
      used.delete(offer)
      throw error
    }
    log(`sent ${suggestion.keys ? 'an answer' : 'a proposed action'} to a ${found.agent} session`)
    onSent()
    return true
  }
}
