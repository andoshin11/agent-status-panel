// Decides what to send: a session's progress when it changes, and an end when it goes away. What
// was sent is saved, so a restart repeats nothing and still ends what went away while it was down.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildAttention, buildEnded, buildProgress, fingerprint, SCHEMA_VERSION } from './payload.mjs'

function isInside(cwd, path) {
  return cwd === path || (cwd ?? '').startsWith(`${path}/`)
}

/**
 * Marks the newest session of each workspace that needs the user. A workspace with no task list
 * gets a session with no tasks, so the widget can still show it.
 */
export function withAttention(sessions, attention, now) {
  const marked = [...sessions]
  for (const { path, agent, reason } of attention) {
    const inside = marked.filter((session) => isInside(session.cwd, path))
    if (inside.length === 0) {
      marked.push({ agent, listId: `worktree:${path}`, cwd: path, updatedAt: now, goal: null, tasks: [], attention: reason })
      continue
    }
    const newest = inside.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    marked[marked.indexOf(newest)] = { ...newest, attention: reason }
  }
  return marked
}

/**
 * Puts what an agent proposed on the newest session of its workspace, or on a session with no
 * tasks when the workspace has none, as `withAttention` does.
 */
export function withOffers(sessions, offers, now) {
  const marked = [...sessions]
  for (const offer of offers) {
    const inside = marked.filter((session) => isInside(session.cwd, offer.path))
    if (inside.length === 0) {
      marked.push({ agent: offer.agent, listId: `worktree:${offer.path}`, cwd: offer.path, updatedAt: now, goal: null, tasks: [], offer })
      continue
    }
    const newest = inside.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    marked[marked.indexOf(newest)] = { ...newest, offer }
  }
  return marked
}

/** The labels only: the prompts stay on this machine until a button is pressed. */
function offerFields(offer) {
  return offer ? { offer: offer.id, suggestions: JSON.stringify(offer.suggestions.map(({ label }) => label)) } : {}
}

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
 * @param readAttention  resolves to the workspaces whose agents need the user
 * @param readOffers  returns what the agents proposed. It reaches the phones that read, never a push.
 * @param send  resolves when delivered. A failure leaves the state alone, so the next run retries.
 * @param stateFile  null keeps nothing on disk, for a dry run
 */
export function createPublisher({ readSessions, readAttention = async () => [], readOffers = () => [], send, statePath: stateFile, sent, staleMs, sendText, now = Date.now, log = () => {} }) {
  const firstSeen = new Map()
  let order = 0
  let board = null

  /** The progress of every session worth showing, before deciding what to send. */
  function progressOf(sessions) {
    const list = []
    for (const session of [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const progress = buildProgress(session, { sendText })
      if (progress.total === '0' && !session.attention && !session.offer) continue
      // A session idle this long is left open, not at work. The widget lists it below the others.
      list.push({ ...progress, live: now() - session.updatedAt > staleMs ? '0' : '1', ...offerFields(session.offer) })
    }
    return list
  }

  function planFrom(progress, attention) {
    const messages = []
    const seen = new Set()
    for (const payload of progress) {
      seen.add(payload.id)
      if (sent.get(payload.id) !== fingerprint(payload)) messages.push(payload)
    }
    for (const entry of attention) {
      const payload = buildAttention(entry, { sendText })
      seen.add(payload.id)
      if (sent.get(payload.id) !== fingerprint(payload)) messages.push(payload)
    }
    for (const id of sent.keys()) {
      if (!seen.has(id)) messages.push(buildEnded(id))
    }
    return messages
  }

  /** The messages one reading of the sessions calls for. */
  function plan(sessions, attention = []) {
    return planFrom(progressOf(sessions), attention)
  }

  /**
   * Keeps the sessions for the phones that read them instead of receiving messages, in the order
   * they appeared, so that a list does not jump while it is being read.
   */
  function remember(progress) {
    const ids = new Set(progress.map((payload) => payload.id))
    for (const id of firstSeen.keys()) {
      if (!ids.has(id)) firstSeen.delete(id)
    }
    for (const payload of progress) {
      if (!firstSeen.has(payload.id)) firstSeen.set(payload.id, order++)
    }
    board = {
      v: SCHEMA_VERSION,
      at: String(now()),
      sessions: progress.toSorted((a, b) => firstSeen.get(a.id) - firstSeen.get(b.id))
    }
  }

  async function publish() {
    const attention = await readAttention()
    const sessions = withAttention(await readSessions(), attention, now())
    const progress = progressOf(sessions)
    // Before sending, so that a phone that reads does not wait on one that FCM cannot reach.
    remember(sendText ? progressOf(withOffers(sessions, readOffers(), now())) : progress)
    const messages = planFrom(progress, attention)
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

  /** What the last reading found, or null before the first one. */
  const snapshot = () => board

  return { publish, plan, snapshot }
}
