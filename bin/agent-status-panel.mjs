#!/usr/bin/env node
// Sends the progress of the running Claude Code and Codex sessions to a phone through FCM, and says
// when one of them needs the user. It can also serve them to a phone that reads them, and tell an
// iPhone through APNs when an agent needs the user.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudePaths, createPendingCallReader, createQuestionReader, createTurnReader } from '../src/claude-sessions.mjs'
import { createApnsSender, createDeviceRegistry, ENVIRONMENTS, isDeviceToken } from '../src/apns.mjs'
import { apnsDevicesPath, configPath, DEFAULT_STALE_MINUTES, loadApnsKey, loadConfig, loadServiceAccount, statePath } from '../src/config.mjs'
import { startDaemon } from '../src/daemon.mjs'
import { createFcmSender } from '../src/fcm.mjs'
import { buildPlist, LABEL } from '../src/launchd.mjs'
import { createNextSender } from '../src/next-actions.mjs'
import { createAgentReader, readScreen, resolveOrcaCli, runOrca } from '../src/orca-agents.mjs'
import { createHookReader, createLaunchReader, createRestarter } from '../src/restart.mjs'
import { createSuggestionReader } from '../src/prompt-suggestions.mjs'
import { createPublisher, loadState } from '../src/publisher.mjs'
import { startStatusServer, STATUS_PATH } from '../src/server.mjs'
import { createSessionReader, progressDir } from '../src/sessions.mjs'

const BOOTSTRAP_ATTEMPTS = 10
const BOOTSTRAP_RETRY_MS = 1000
const home = homedir()
const log = (message) => console.log(`${new Date().toISOString()} ${message}`)
const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)

/** launchd can refuse for a moment after a bootout, which would leave the daemon stopped. */
function bootstrap(domain) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' })
      return
    } catch (error) {
      if (attempt === BOOTSTRAP_ATTEMPTS) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BOOTSTRAP_RETRY_MS)
    }
  }
}

/** Sends to Android through FCM and, when configured, to iPhones through APNs. */
async function makeSender() {
  const config = await loadConfig(configPath(home))
  const serviceAccount = await loadServiceAccount(config.serviceAccountFile)
  const fcm = createFcmSender({ serviceAccount, tokens: config.deviceTokens, log })
  if (!config.apns) return { config, send: (data) => (data.id.startsWith('proposal-') ? undefined : fcm(data)), apns: null, register: null, close: () => {} }
  const devices = await createDeviceRegistry(apnsDevicesPath(home))
  const apns = createApnsSender({ ...config.apns, key: await loadApnsKey(config.apns.keyFile), devices, log })
  async function register({ token, environment }) {
    if (!isDeviceToken(token) || !Object.hasOwn(ENVIRONMENTS, environment)) throw new TypeError('not an APNs device')
    if (await devices.add(token, environment)) log(`registered an iPhone for notifications; ${devices.list().length} in all`)
  }
  return {
    config,
    // Proposals are notified on the iPhone only: the Android app has no buttons for them.
    send: (data) => Promise.all([data.id.startsWith('proposal-') ? null : fcm(data), apns(data)]),
    apns,
    register,
    close: apns.close
  }
}

const commands = {
  async run() {
    const { config, send, register } = await makeSender()
    const file = statePath(home)
    const readQuestion = createQuestionReader(home)
    const readSuggestions = createSuggestionReader({ home })
    const readCall = createPendingCallReader(home)
    const readTurnEnded = createTurnReader(home)
    const readHook = createHookReader(config.launchHookFile)
    const readLaunch = createLaunchReader(home, readHook)
    const { publish, snapshot } = createPublisher({
      readSessions: createSessionReader({ home }),
      ...createAgentReader({ readQuestion, readSuggestions, readCall, readTurnEnded, readLaunch, log }),
      send,
      statePath: file,
      sent: await loadState(file),
      staleMs: config.staleMinutes * 60_000,
      sendText: config.sendText,
      log
    })
    const daemon = startDaemon({ publish, dirs: [claudePaths(home).tasksRoot, progressDir(home)], log })
    await daemon.ready
    log('watching the task lists')
    if (config.httpPort !== null) {
      // The agent is at work once it has the prompt, so the buttons leave the board right away.
      const cli = resolveOrcaCli()
      const restart = createRestarter({
        home,
        readHook,
        readLaunch,
        readScreen: (handle) => readScreen(cli, handle),
        send: async (handle, text, enter) => {
          const result = await runOrca(cli, ['terminal', 'send', '--terminal', handle, '--text', text, ...(enter ? ['--enter'] : []), '--json'])
          if (!result.send?.accepted) throw new Error('the terminal did not accept the text')
        },
        create: (path, title, command) => runOrca(cli, ['terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command, '--json']),
        log
      })
      const next = createNextSender({ readQuestion, readSuggestions, readCall, readTurnEnded, readLaunch, restart, onSent: () => void daemon.run(), log })
      await startStatusServer({ port: config.httpPort, snapshot, register, next, allowedLogin: config.allowedLogin })
      log(`serving the sessions at http://127.0.0.1:${config.httpPort}${STATUS_PATH}`)
    }
  },

  /** Prints what would be sent if nothing had been sent yet. It needs no settings and sends nothing. */
  async 'dry-run'() {
    const { publish } = createPublisher({
      readSessions: createSessionReader({ home }),
      ...createAgentReader({ log }),
      send: async () => {},
      statePath: null,
      sent: new Map(),
      staleMs: DEFAULT_STALE_MINUTES * 60_000,
      sendText: true
    })
    console.log(JSON.stringify(await publish(), null, 2))
  },

  async 'send-test'() {
    const { send, close } = await makeSender()
    await send({ v: '1', id: 'test', agent: 'claude', state: 'finished', at: String(Date.now()), workspace: 'test', goal: 'Test from agent-status-panel', step: 'Checking delivery', done: '1', total: '1' })
    log('sent a test message')
    close()
  },

  /** Shows the notification an iPhone gets when an agent waits for the user. */
  async 'send-test-ios'() {
    const { apns, close } = await makeSender()
    if (!apns) throw new Error('config.apns is not set')
    await apns({ v: '1', id: 'attention-test', state: 'attention', reason: 'waiting', workspace: 'test', at: String(Date.now()) })
    log('sent a test notification to the iPhones')
    close()
  },

  install() {
    const logFile = join(home, 'Library', 'Logs', 'agent-status-panel.log')
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath, buildPlist({ node: process.execPath, script: fileURLToPath(import.meta.url), log: logFile }))
    const domain = `gui/${process.getuid()}`
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' })
    } catch {
      // It was not loaded yet.
    }
    bootstrap(domain)
    log(`installed ${LABEL}; logs are in ${logFile}`)
  },

  uninstall() {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' })
    } catch {}
    rmSync(plistPath, { force: true })
    log(`removed ${LABEL}`)
  }
}

const command = commands[process.argv[2]]
if (!command) {
  console.error(`usage: agent-status-panel <${Object.keys(commands).join('|')}>`)
  process.exit(2)
}
try {
  await command()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
