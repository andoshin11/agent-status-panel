// Reads the next-prompt suggestion Claude Code shows in gray in its input box. Claude Code gives it
// to no hook or file in an interactive session, so it comes from the terminal output Orca keeps
// (terminal-history/<pty id>/output.log). This depends on how Claude Code paints the box: if that
// changes, nothing matches and the buttons simply go without the suggestion.
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isPane, resolveOrcaCli, runOrca } from './orca-agents.mjs'

const TAIL_BYTES = 256 * 1024
// Move to the start of the input row, dim on, the text, dim off, and the cursor back to that row.
const SUGGESTION = /\x1b\[H\r\x1b\[2C\x1b\[(\d+)B\x1b\[2m([^\x1b]{1,1200})\x1b\[22m\x1b\[\d+;1H\x1b\[(\d+);3H/g

export function terminalHistoryRoot(home) {
  return join(home, 'Library', 'Application Support', 'orca', 'terminal-history')
}

/**
 * The suggestion on screen at the end of a terminal's output, or null. Output is binary-safe text
 * here (latin1), and only the suggestion itself is decoded. Anything drawn on that row afterwards,
 * such as a typed letter, means it is gone.
 */
export function suggestionFrom(output) {
  let last = null
  for (const match of output.matchAll(SUGGESTION)) {
    if (Number(match[3]) === Number(match[1]) + 1) last = match
  }
  if (!last) return null
  const row = last[1]
  const after = output.slice(last.index + last[0].length)
  if (new RegExp(`\\x1b\\[H\\r(?:\\x1b\\[\\d+C)?\\x1b\\[${row}B`).test(after)) return null
  return Buffer.from(last[2], 'latin1').toString('utf8').trim() || null
}

async function readTail(path) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, size - length)
    return buffer.subarray(0, bytesRead).toString('latin1')
  } finally {
    await file.close()
  }
}

/** @returns a function from pane keys to a Map of the suggestion each pane shows now */
export function createSuggestionReader({
  home,
  cli = resolveOrcaCli(),
  terminals = async (command) => (await runOrca(command, ['terminal', 'list', '--json'])).terminals,
  read = readTail
}) {
  const root = terminalHistoryRoot(home)
  return async function readSuggestions(paneKeys) {
    const shown = new Map()
    const all = await terminals(cli)
    for (const paneKey of paneKeys) {
      const terminal = all.find((candidate) => isPane(candidate, paneKey))
      if (!terminal?.ptyId) continue
      const output = await read(join(root, encodeURIComponent(terminal.ptyId), 'output.log')).catch(() => null)
      const suggestion = output === null ? null : suggestionFrom(output)
      if (suggestion) shown.set(paneKey, suggestion)
    }
    return shown
  }
}
