// Sends an action an agent proposed, or the answer to its question, when the user presses a button.
// The phone says only which button: what to send comes from what the agent wrote, read again now,
// so a phone cannot send anything else and a button from an earlier turn does nothing.
import { answerKeys, isCodexPermissionMenu, isPane, isPermissionMenu, listTerminals, offersOf, readPaneScreen, readScreen, readWorktrees, resolveOrcaCli, runOrca, settleAgents } from './orca-agents.mjs'

export { isPermissionMenu }

const USED_MAX = 256
const SUBMIT_WAIT_SECONDS = '8'
const SEND_TIMEOUT_MS = 20_000
// Claude Code's "stash": it takes what is in the input box and puts it back after the next submit.
const STASH_KEY = '\u0013'
const STASH_WAIT_MS = 400
// Codex shows this while its input box is empty. Text in the box does not show on a screen read.
const CODEX_EMPTY_HINT = '? for shortcuts'
const KEY_WAIT_MS = 250
const REVIEW_WAIT_MS = 800
const SUBMIT_KEY = '\r'
const ESCAPE_KEY = '\u001b'
const ALLOW_ONCE_KEY = '1'
// On the review page the menu shows after the last question.
const REVIEW_PAGE = 'Submit answers'

async function sendPrompt(cli, handle, prompt) {
  const result = await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', SUBMIT_WAIT_SECONDS, '--json'], SEND_TIMEOUT_MS)
  if (!result.send?.accepted) throw new Error('the terminal did not accept the prompt')
}

/** A prompt pasted over a draft would join it, so the draft is set aside and comes back afterwards. */
async function stashDraft(cli, handle) {
  await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', STASH_KEY, '--json'])
  await new Promise((resolve) => setTimeout(resolve, STASH_WAIT_MS))
}

/** Without Enter: the menu takes a number as one key press, and Enter would go on to the next one. */
async function sendKeys(cli, handle, keys) {
  const result = await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', keys, '--json'])
  if (!result.send?.accepted) throw new Error('the terminal did not accept the key')
}

/**
 * @returns a function that takes `{ offer, index }` and resolves to true once the agent has the
 *   prompt, false when that button is no longer on offer, 'typing' when a draft in Codex's
 *   input box would be sent along with it, 'confirm' to allow a dangerous command unconfirmed, or
 *   'draft' when a restart would lose what is typed in Claude Code's input box. It throws when sending fails.
 * @param restart  starts a Claude session again, see restart.mjs
 * @param grantRest  allows the rest of the turn of a Claude session id, through the Milestone plugin
 */
export function createNextSender({ cli = resolveOrcaCli(), read = readWorktrees, readQuestion = async () => null, readSuggestions, readCall, readTurnEnded = async () => null, readLaunch, readGrants, restart = async () => false, grantRest = async () => { throw new Error('cannot allow the rest of a turn') }, terminals = listTerminals, send = sendPrompt, pressKeys = sendKeys, stash = stashDraft, screen = readScreen, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onSent = () => {}, log = () => {} } = {}) {
  const used = new Set()

  function take(offer) {
    used.add(offer)
    if (used.size > USED_MAX) used.delete(used.values().next().value)
  }

  /** Submits only from the review page, so that keys gone astray never answer on their own. */
  async function answerForm(handle, keys) {
    for (const key of keys) {
      await pressKeys(cli, handle, key)
      await wait(KEY_WAIT_MS)
    }
    await wait(REVIEW_WAIT_MS)
    if (!(await screen(cli, handle)).includes(REVIEW_PAGE)) throw new Error('the menu did not reach its review page')
    await pressKeys(cli, handle, SUBMIT_KEY)
  }

  return async function next({ offer, index, answers, confirmed = false }) {
    if (used.has(offer)) return false
    const found = (await offersOf(await settleAgents(await read(cli), readTurnEnded), readQuestion, readSuggestions, readCall, (paneKey) => readPaneScreen(cli, paneKey, terminals, screen), readLaunch, readGrants)).find((candidate) => candidate.id === offer)
    const keys = answers ? answerKeys(found?.questions, answers) : null
    const suggestion = answers ? null : found?.suggestions[index]
    if (!keys && !suggestion) return false
    if (suggestion?.action === 'allow' && found.dangerous && !confirmed) return 'confirm'
    const terminal = (await terminals(cli)).find((candidate) => isPane(candidate, found.paneKey) && candidate.writable)
    if (!terminal) return false
    if (suggestion?.action === 'restart') {
      if (used.has(offer)) return false
      take(offer)
      try {
        const result = await restart(found, terminal)
        if (result !== true) used.delete(offer)
        if (result === true) log('restarted a claude session under the newest instructions')
        return result
      } catch (error) {
        used.delete(offer)
        throw error
      }
    }
    const onMenu = found.agent === 'codex' ? isCodexPermissionMenu : isPermissionMenu
    if (suggestion?.action && !onMenu(await screen(cli, terminal.handle), found.menuHint)) return false
    // A menu key goes to the menu and leaves a draft alone, so only a typed prompt could join one.
    if (found.agent === 'codex' && suggestion && !suggestion.keys && !suggestion.action && !(await screen(cli, terminal.handle)).includes(CODEX_EMPTY_HINT)) return 'typing'
    // Checked again here, right before the send: a second press may have arrived during the reads.
    if (used.has(offer)) return false
    take(offer)
    try {
      if (keys) await answerForm(terminal.handle, keys)
      else if (suggestion.action === 'allow-rest') {
        // The grant first: the next call asks the hook as soon as this one is allowed.
        await grantRest(found.sessionId)
        await pressKeys(cli, terminal.handle, ALLOW_ONCE_KEY)
      } else if (suggestion.action) await pressKeys(cli, terminal.handle, suggestion.action === 'allow' ? ALLOW_ONCE_KEY : ESCAPE_KEY)
      else if (suggestion.keys) await pressKeys(cli, terminal.handle, suggestion.keys)
      else {
        if (found.agent === 'claude') await stash(cli, terminal.handle)
        await send(cli, terminal.handle, suggestion.prompt)
      }
    } catch (error) {
      // A form stopped halfway has options ticked, so pressing the same keys again would untick them.
      if (!keys) used.delete(offer)
      throw error
    }
    log(`sent ${suggestion?.action ? `a permission decision (${suggestion.action})` : keys || suggestion.keys ? 'an answer' : 'a proposed action'} to a ${found.agent} session`)
    onSent()
    return true
  }
}
