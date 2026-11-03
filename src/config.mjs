// Reads the settings. Both files can send messages to the phone, so neither may be readable by others.
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

async function readPrivateJson(path, label) {
  const { mode } = await stat(path).catch(() => {
    throw new Error(`${label} not found at ${path}`)
  })
  if (mode & 0o077) throw new Error(`${label} at ${path} must be readable only by its owner (chmod 600)`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
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
  return {
    deviceTokens: config.deviceTokens,
    serviceAccountFile: config.serviceAccountFile,
    sendText: config.sendText !== false,
    staleMinutes
  }
}

export async function loadServiceAccount(path) {
  const account = await readPrivateJson(path, 'service account key')
  for (const key of ['project_id', 'client_email', 'private_key']) {
    if (typeof account[key] !== 'string') throw new Error(`service account key has no ${key}`)
  }
  return account
}
