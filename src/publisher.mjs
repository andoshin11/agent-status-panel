// Decides what to send: a session's progress when it changes, and an end when it goes away. What
// was sent is saved, so a restart repeats nothing and still ends what went away while it was down.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildEnded, buildProgress, fingerprint } from './payload.mjs'

export async function loadState(path) {
  try {
    const { sent } = JSON.parse(await readFile(path, 'utf8'))
    return new Map(Object.entries(sent))
  } catch {
    return new Map()
  }
}

async function saveState(path, sent) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(`${path}.tmp`, JSON.stringify({ sent: Object.fromEntries(sent) }), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

/**
 * @param send  resolves when delivered. A failure leaves the state alone, so the next run retries.
 * @param stateFile  null keeps nothing on disk, for a dry run
 */
export function createPublisher({ readSessions, send, statePath: stateFile, sent, staleMs, sendText, now = Date.now, log = () => {} }) {
  /** The messages one reading of the sessions calls for. */
  function plan(sessions) {
    const messages = []
    const seen = new Set()
    for (const session of [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const payload = buildProgress(session, { sendText })
      const shown = sent.has(payload.id)
      // A session idle this long is left open, not at work. A list finished before anything was
      // shown is old news. Neither starts a notification, and the first ends one.
      if (now() - session.updatedAt > staleMs) continue
      if (payload.state === 'finished' && !shown) continue
      if (payload.total === '0') continue
      seen.add(payload.id)
      if (sent.get(payload.id) !== fingerprint(payload)) messages.push(payload)
    }
    for (const id of sent.keys()) {
      if (!seen.has(id)) messages.push(buildEnded(id))
    }
    return messages
  }

  async function publish() {
    const messages = plan(await readSessions())
    let failure = null
    for (const message of messages) {
      try {
        // FCM does not keep messages in order, so the phone ignores one older than what it shows.
        await send({ ...message, at: String(now()) })
        if (message.state === 'ended') sent.delete(message.id)
        else sent.set(message.id, fingerprint(message))
      } catch (error) {
        failure = error
        break
      }
    }
    if (messages.length > 0 && stateFile) await saveState(stateFile, sent)
    if (failure) throw failure
    if (messages.length > 0) log(`sent ${messages.length} message(s)`)
    return messages
  }

  return { publish, plan }
}
