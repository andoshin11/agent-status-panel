// Sends an action an agent proposed to that agent, when the user presses its button. The phone says
// only which button: the text comes from what the agent wrote, read again now, so a phone cannot
// send anything else and a button from an earlier reply does nothing.
import { offersFrom, readWorktrees, resolveOrcaCli, runOrca } from './orca-agents.mjs'

const USED_MAX = 256
const SUBMIT_WAIT_SECONDS = '8'
const SEND_TIMEOUT_MS = 20_000

async function listTerminals(cli) {
  return (await runOrca(cli, ['terminal', 'list', '--json'])).terminals
}

async function sendPrompt(cli, handle, prompt) {
  const result = await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', SUBMIT_WAIT_SECONDS, '--json'], SEND_TIMEOUT_MS)
  if (!result.send?.accepted) throw new Error('the terminal did not accept the prompt')
}

/**
 * @returns a function that takes `{ offer, index }` and resolves to true once the agent has the
 *   prompt, or false when that button is no longer on offer. It throws when sending fails.
 */
export function createNextSender({ cli = resolveOrcaCli(), read = readWorktrees, terminals = listTerminals, send = sendPrompt, onSent = () => {}, log = () => {} } = {}) {
  const used = new Set()

  function take(offer) {
    used.add(offer)
    if (used.size > USED_MAX) used.delete(used.values().next().value)
  }

  return async function next({ offer, index }) {
    if (used.has(offer)) return false
    const found = offersFrom(await read(cli)).find((candidate) => candidate.id === offer)
    const suggestion = found?.suggestions[index]
    if (!suggestion) return false
    const terminal = (await terminals(cli)).find((candidate) => `${candidate.tabId}:${candidate.leafId}` === found.paneKey && candidate.writable)
    if (!terminal) return false
    // Checked again here, right before the send: a second press may have arrived during the reads.
    if (used.has(offer)) return false
    take(offer)
    try {
      await send(cli, terminal.handle, suggestion.prompt)
    } catch (error) {
      used.delete(offer)
      throw error
    }
    log(`sent a proposed action to a ${found.agent} session`)
    onSent()
    return true
  }
}
