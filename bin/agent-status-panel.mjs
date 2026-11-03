#!/usr/bin/env node
// Sends the progress of the running Claude Code and Codex sessions to a phone through FCM.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudePaths } from '../src/claude-sessions.mjs'
import { configPath, DEFAULT_STALE_MINUTES, loadConfig, loadServiceAccount, statePath } from '../src/config.mjs'
import { startDaemon } from '../src/daemon.mjs'
import { createFcmSender } from '../src/fcm.mjs'
import { buildPlist, LABEL } from '../src/launchd.mjs'
import { createPublisher, loadState } from '../src/publisher.mjs'
import { createSessionReader, progressDir } from '../src/sessions.mjs'

const home = homedir()
const log = (message) => console.log(`${new Date().toISOString()} ${message}`)
const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)

async function makeSender() {
  const config = await loadConfig(configPath(home))
  const serviceAccount = await loadServiceAccount(config.serviceAccountFile)
  return { config, send: createFcmSender({ serviceAccount, tokens: config.deviceTokens, log }) }
}

const commands = {
  async run() {
    const { config, send } = await makeSender()
    const file = statePath(home)
    const { publish } = createPublisher({
      readSessions: createSessionReader({ home }),
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
  },

  /** Prints what would be sent if nothing had been sent yet. It needs no settings and sends nothing. */
  async 'dry-run'() {
    const { publish } = createPublisher({
      readSessions: createSessionReader({ home }),
      send: async () => {},
      statePath: null,
      sent: new Map(),
      staleMs: DEFAULT_STALE_MINUTES * 60_000,
      sendText: true
    })
    console.log(JSON.stringify(await publish(), null, 2))
  },

  async 'send-test'() {
    const { send } = await makeSender()
    await send({ v: '1', id: 'test', agent: 'claude', state: 'finished', at: String(Date.now()), workspace: 'test', goal: 'Test from agent-status-panel', step: 'Checking delivery', done: '1', total: '1' })
    log('sent a test message')
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
    execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' })
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
