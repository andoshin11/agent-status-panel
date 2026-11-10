// Starts a Claude session again under what the Milestone plugin tells a session now, in the same
// conversation, as the Milestone panel's restart card does. A session keeps the instructions it was
// started with, so one started before the plugin changed, or outside Orca, goes on without the newer
// ones. The card is offered only to a session that waits for the user with no shells in the
// background, and pressed only with nothing typed in its input box: `/exit` would lose both.
// What a session is told now comes from the plugin's launch hook, read again whenever it changes.
import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudePaths, readRunningSessions } from './claude-sessions.mjs'
import { suggestionFrom, terminalHistoryRoot } from './prompt-suggestions.mjs'

const TAIL_BYTES = 256 * 1024
const RULE = /^─{10,}\s*$/
const PROMPT = /^❯\s?/
const SHELLS = /(^|\/|-)(fish|zsh|bash|sh)$/
// Values the resumed session keeps. Others are left out rather than taken apart from a command line
// that has lost its quotes.
const KEPT_VALUE = /^[\w.:/@=-]+$/
// The phone stops waiting after 25 s, so the press is answered once the new command is sent.
const EXIT_WAIT_MS = 15_000
const START_WAIT_MS = 30_000
const POLL_MS = 500
const SHELL_WAIT_MS = 1_000

/**
 * @param path  the plugin's src/launch-hook.mjs, or null
 * @returns a function resolving to `{ instructions, withTaskInstructions }`, or null without one
 */
export function createHookReader(path) {
  let loaded = null
  let version = null
  return async function readHook() {
    if (!path) return null
    try {
      const { mtimeMs } = await stat(path)
      if (mtimeMs !== version) {
        // A new URL each time, as an import is cached by its URL.
        const hook = await import(`${pathToFileURL(path).href}?v=${mtimeMs}`)
        loaded = typeof hook.claudeInstructions === 'function' && typeof hook.withTaskInstructions === 'function'
          ? { instructions: hook.claudeInstructions(), withTaskInstructions: hook.withTaskInstructions }
          : null
        version = mtimeMs
      }
    } catch {
      loaded = null
      version = null
    }
    return loaded
  }
}

/** The command line a process was started with, or null once it is gone. */
export function readArgs(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'args=', '-p', String(pid)], (error, stdout) => resolve(error ? null : stdout.trim() || null))
  })
}

/** The command line of the process that started it: a shell when the user typed `claude`. */
async function readParentArgs(pid) {
  const ppid = await new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (error, stdout) => resolve(error ? null : stdout.trim()))
  })
  return ppid ? readArgs(ppid) : null
}

/**
 * The one running Claude session in a workspace when it was told something older than the hook
 * says now, or null. @returns { sessionId, pid, args }
 */
export function createLaunchReader(home, readHook, { readArgsOf = readArgs } = {}) {
  const { sessionsRoot } = claudePaths(home)
  // A process keeps its command line, so it is read once.
  const known = new Map()
  return async function readLaunch(path) {
    const hook = await readHook()
    if (!hook) return null
    const inside = (await readRunningSessions(sessionsRoot)).filter((entry) => entry.cwd === path || entry.cwd?.startsWith(`${path}/`))
    if (inside.length !== 1) return null
    const [{ sessionId, pid }] = inside
    if (!known.has(pid)) known.set(pid, await readArgsOf(pid))
    const args = known.get(pid)
    return args && !args.includes(hook.instructions) ? { sessionId, pid, args } : null
  }
}

/**
 * The command that starts the session again: `orca claude-teams` for Agent Teams, which adds its
 * own flags, else `claude`. Permissions, the model and a plugin folder carry over.
 */
export function resumeCommand(args, sessionId, withTaskInstructions) {
  const teams = /\s--teammate-mode\s/.test(args)
  const kept = []
  if (/\s--dangerously-skip-permissions(\s|$)/.test(args)) kept.push('--dangerously-skip-permissions')
  for (const flag of ['--permission-mode', '--model']) {
    const value = new RegExp(`\\s${flag}[ =](\\S+)`).exec(args)?.[1]
    if (value && KEPT_VALUE.test(value)) kept.push(`${flag} ${value}`)
  }
  // Orca's own plugin for its agent view. The folder has a space, and no option comes inside it.
  const pluginDir = /\s--plugin-dir (.+?)(?= --|$)/.exec(args)?.[1]?.trim()
  if (!teams && pluginDir && !pluginDir.includes("'")) kept.push(`--plugin-dir '${pluginDir}'`)
  const command = `${teams ? 'orca claude-teams' : 'claude'} ${[...kept, '--resume', sessionId].join(' ')}`
  return `env CLAUDE_CODE_ENABLE_TODO_TOOLS=1 ${withTaskInstructions(command)}`
}

/** What is typed in Claude Code's input box on a screen, '' when nothing, or null when no box shows. */
export function inputText(screen) {
  const lines = screen.split('\n')
  const start = lines.findLastIndex((line) => PROMPT.test(line))
  if (start < 1 || !RULE.test(lines[start - 1])) return null
  const end = lines.findIndex((line, index) => index > start && RULE.test(line))
  if (end < 0) return null
  return lines.slice(start, end).map((line, index) => (index === 0 ? line.replace(PROMPT, '') : line).trim()).join(' ').trim()
}

/** Whether the input box holds only Claude Code's gray suggestion, or nothing. */
export function isInputEmpty(typed, suggestion) {
  if (typed === '') return true
  const flat = (text) => text.replace(/\s+/g, '')
  return Boolean(suggestion) && flat(suggestion).startsWith(flat(typed))
}

async function readOutputTail(home, ptyId) {
  const file = await open(join(terminalHistoryRoot(home), encodeURIComponent(ptyId), 'output.log'), 'r')
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

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * @param send       sends text to a terminal handle, with Enter when asked
 * @param create     opens a terminal in a workspace with a title and a command
 * @returns a function that takes the offer and the terminal of its pane, and resolves to true once
 *   the command that starts the session again is sent, false when there is nothing to restart, or
 *   'draft' when the input box has text. It throws when a step fails. Whether the session came
 *   back is only logged: the phone stops waiting before it would know.
 */
export function createRestarter({ home, readHook, readLaunch, readScreen, send, create, readOutput = readOutputTail, parentArgs = readParentArgs, running = isRunning, sessions = () => readRunningSessions(claudePaths(home).sessionsRoot), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = () => {} }) {
  async function until(check, ms) {
    const end = now() + ms
    while (now() < end) {
      if (await check()) return true
      await wait(POLL_MS)
    }
    return check()
  }

  return async function restart(found, terminal) {
    const hook = await readHook()
    const launch = hook ? await readLaunch(found.path) : null
    if (!launch || launch.sessionId !== found.sessionId) return false
    const typed = inputText(await readScreen(terminal.handle))
    if (typed === null) return false
    const suggestion = typed && terminal.ptyId ? suggestionFrom(await readOutput(home, terminal.ptyId).catch(() => '')) : null
    if (!isInputEmpty(typed, suggestion)) return 'draft'
    const inShell = SHELLS.test(((await parentArgs(launch.pid)) ?? '').split(/\s/)[0])
    const command = resumeCommand(launch.args, launch.sessionId, hook.withTaskInstructions)

    await send(terminal.handle, '/exit', true)
    if (!(await until(() => !running(launch.pid), EXIT_WAIT_MS))) {
      // A dialog, such as the one for work in the background, keeps it open: leave it as it was.
      await send(terminal.handle, '\u001b', false).catch(() => {})
      throw new Error('the session did not exit')
    }
    if (inShell) {
      await wait(SHELL_WAIT_MS)
      await send(terminal.handle, command, true)
    } else {
      // Orca closes the pane of an agent it started once the agent exits, so it gets a new one.
      const title = typeof terminal.title === 'string' && terminal.title.trim() ? terminal.title.trim() : 'Claude'
      await create(found.path, title, command)
    }
    const back = until(async () => (await sessions()).some((entry) => entry.sessionId === launch.sessionId && entry.pid !== launch.pid), START_WAIT_MS)
    void back.then((ok) => log(ok ? 'a Claude session runs again under the newest instructions' : 'a restarted Claude session did not come back'), () => {})
    return true
  }
}
