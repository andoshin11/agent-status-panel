// Reads the settings. Each file can send messages to the phone, so none may be readable by others.
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const DEFAULT_STALE_MINUTES = 120

export function configPath(home = homedir()) {
  return join(home, '.config', 'agent-status-panel', 'config.json')
}

export function statePath(home = homedir()) {
  return join(home, '.local', 'state', 'agent-status-panel', 'state.json')
}

/** The iPhones that asked for notifications. */
export function apnsDevicesPath(home = homedir()) {
  return join(home, '.local', 'state', 'agent-status-panel', 'apns-devices.json')
}

async function readPrivate(path, label) {
  const { mode } = await stat(path).catch(() => {
    throw new Error(`${label} not found at ${path}`)
  })
  if (mode & 0o077) throw new Error(`${label} at ${path} must be readable only by its owner (chmod 600)`)
  return readFile(path, 'utf8')
}

async function readPrivateJson(path, label) {
  const text = await readPrivate(path, label)
  try {
    return JSON.parse(text)
  } catch {
    // The parse error can quote the file, which holds secrets.
    throw new Error(`${label} at ${path} is not valid JSON`)
  }
}

export async function loadConfig(path = configPath()) {
  const config = await readPrivateJson(path, 'config')
  if (!Array.isArray(config.deviceTokens) || config.deviceTokens.length === 0 || !config.deviceTokens.every((token) => typeof token === 'string' && token)) {
    throw new Error('config.deviceTokens must be a non-empty list of FCM registration tokens')
  }
  // launchd starts the daemon in /, and ~ is not expanded.
  if (typeof config.serviceAccountFile !== 'string' || !isAbsolute(config.serviceAccountFile)) {
    throw new Error('config.serviceAccountFile must be an absolute path')
  }
  const staleMinutes = config.staleMinutes ?? DEFAULT_STALE_MINUTES
  if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) throw new Error('config.staleMinutes must be a positive number')
  const httpPort = config.httpPort ?? null
  if (httpPort !== null && !(Number.isInteger(httpPort) && httpPort > 0 && httpPort < 65536)) {
    throw new Error('config.httpPort must be a port number')
  }
  const allowedLogin = config.allowedLogin ?? null
  if (allowedLogin !== null && (typeof allowedLogin !== 'string' || !allowedLogin)) {
    throw new Error('config.allowedLogin must be a Tailscale login name')
  }
  // The Milestone plugin's launch hook, which says what a Claude session is told now.
  const launchHookFile = config.launchHookFile ?? null
  if (launchHookFile !== null && (typeof launchHookFile !== 'string' || !isAbsolute(launchHookFile))) {
    throw new Error('config.launchHookFile must be an absolute path')
  }
  return {
    allowedLogin,
    launchHookFile,
    deviceTokens: config.deviceTokens,
    apns: config.apns === undefined ? null : apnsOf(config.apns),
    serviceAccountFile: config.serviceAccountFile,
    sendText: config.sendText !== false,
    staleMinutes,
    httpPort
  }
}

const APPLE_ID = /^[A-Z0-9]{10}$/

function apnsOf(apns) {
  if (typeof apns?.keyFile !== 'string' || !isAbsolute(apns.keyFile)) throw new Error('config.apns.keyFile must be an absolute path')
  if (!APPLE_ID.test(apns.keyId ?? '')) throw new Error('config.apns.keyId must be the 10 character key ID')
  if (!APPLE_ID.test(apns.teamId ?? '')) throw new Error('config.apns.teamId must be the 10 character team ID')
  if (typeof apns.topic !== 'string' || !apns.topic) throw new Error('config.apns.topic must be the bundle ID of the app')
  return { keyFile: apns.keyFile, keyId: apns.keyId, teamId: apns.teamId, topic: apns.topic }
}

/** The .p8 key from Apple. Its text is never part of an error. */
export async function loadApnsKey(path) {
  const key = await readPrivate(path, 'APNs key')
  if (!key.includes('BEGIN PRIVATE KEY')) throw new Error(`APNs key at ${path} is not a .p8 key`)
  return key
}

export async function loadServiceAccount(path) {
  const account = await readPrivateJson(path, 'service account key')
  for (const key of ['project_id', 'client_email', 'private_key']) {
    if (typeof account[key] !== 'string') throw new Error(`service account key has no ${key}`)
  }
  return account
}
