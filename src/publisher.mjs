// Decides what to send: a session's progress when it changes, and an end when it goes away. What
// was sent is saved, so a restart repeats nothing and still ends what went away while it was down.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildAttention, buildEnded, buildProgress, buildProposal, fingerprint, SCHEMA_VERSION } from './payload.mjs'

// A proposal found later than this after its turn ended is not notified.
const PROPOSAL_FRESH_MS = 10 * 60_000

function kindsOf(messages) {
  const counts = new Map()
  for (const { id, state } of messages) {
    const kind = state === 'ended' && /^(attention|proposal)-/.test(id) ? `${id.split('-')[0]} ended` : state
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')
}

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

/**
 * Puts the pull requests on the newest session of their workspace. A workspace without a card gets
 * one only for a link an agent just gave: Orca links a pull request to many a quiet workspace.
 */
export function withLinks(sessions, entries, now) {
  const marked = [...sessions]
  for (const { path, agent, links, fromReply } of entries) {
    const inside = marked.filter((session) => isInside(session.cwd, path))
    if (inside.length === 0) {
      if (fromReply) marked.push({ agent, listId: `worktree:${path}`, cwd: path, updatedAt: now, goal: null, tasks: [], links })
      continue
    }
    const newest = inside.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    marked[marked.indexOf(newest)] = { ...newest, links }
  }
  return marked
}

/**
 * What the buttons show. A proposal is described by the prompt it would send, so the user can read
 * it before pressing; the press itself still says only which button.
 */
function offerFields(offer) {
  if (!offer) return {}
  return {
    offer: offer.id,
    suggestions: JSON.stringify(offer.suggestions.map(({ label }) => label)),
    details: JSON.stringify(offer.suggestions.map(({ detail, prompt }) => detail ?? prompt ?? '')),
    ...(offer.suggestions.some(({ reason }) => reason) ? { reasons: JSON.stringify(offer.suggestions.map(({ reason }) => reason ?? '')) } : {}),
    ...(offer.question ? { question: offer.question } : {}),
    ...(offer.questions ? { questions: JSON.stringify(offer.questions) } : {}),
    ...(offer.dangerous ? { dangerous: '1' } : {})
  }
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
 * @param readLinks  returns the pull requests of each workspace, also only for the phones that read
 * @param send  resolves when delivered. A failure leaves the state alone, so the next run retries.
 * @param stateFile  null keeps nothing on disk, for a dry run
 */
export function createPublisher({ readSessions, readAttention = async () => [], readOffers = () => [], readLinks = () => [], send, statePath: stateFile, sent, staleMs, sendText, now = Date.now, log = () => {} }) {
  const firstSeen = new Map()
  let order = 0
  let board = null

  /** The progress of every session worth showing, before deciding what to send. */
  function progressOf(sessions) {
    const list = []
    for (const session of [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const progress = buildProgress(session, { sendText })
      if (progress.total === '0' && !session.attention && !session.offer && !session.links) continue
      // A session idle this long is left open, not at work. The widget lists it below the others.
      list.push({ ...progress, live: now() - session.updatedAt > staleMs ? '0' : '1', ...offerFields(session.offer), ...(session.links ? { links: JSON.stringify(session.links) } : {}) })
    }
    return list
  }

  /**
   * The proposals worth a notification: an agent that finished a turn just now. One found when the
   * daemon starts, after waiting for hours, is not news; one already notified stays until it goes.
   */
  function proposalsOf(offers, attention) {
    const needing = new Set(attention.map(({ path }) => path))
    return offers
      .filter((offer) => offer.kind === 'proposal' && !needing.has(offer.path))
      .map((offer) => buildProposal({ path: offer.path, offer: offer.id }, { sendText }))
      .filter((payload, index, all) => all.findIndex((other) => other.id === payload.id) === index)
  }

  function planFrom(progress, attention, offers = []) {
    const messages = []
    const seen = new Set()
    for (const payload of progress) {
      seen.add(payload.id)
      if (sent.get(payload.id) !== fingerprint(payload)) messages.push(payload)
    }
    for (const entry of attention) {
      // The iPhone shows the choices on the notification, read again from here by this id.
      const payload = buildAttention({ ...entry, offer: offers.find((offer) => offer.path === entry.path)?.id }, { sendText })
      seen.add(payload.id)
      if (sent.get(payload.id) !== fingerprint(payload)) messages.push(payload)
    }
    for (const payload of proposalsOf(offers, attention)) {
      const offer = offers.find((candidate) => candidate.id === payload.offer)
      if (!sent.has(payload.id) && !(now() - (offer.since ?? 0) < PROPOSAL_FRESH_MS)) continue
      seen.add(payload.id)
      if (sent.get(payload.id) !== fingerprint(payload)) messages.push(payload)
    }
    for (const id of sent.keys()) {
      if (!seen.has(id)) messages.push(buildEnded(id))
    }
    return messages
  }

  /** The messages one reading of the sessions calls for. */
  function plan(sessions, attention = [], offers = []) {
    return planFrom(progressOf(sessions), attention, offers)
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
    const offers = sendText ? readOffers() : []
    remember(sendText ? progressOf(withLinks(withOffers(sessions, offers, now()), readLinks(), now())) : progress)
    const messages = planFrom(progress, attention, offers)
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
    // Which kinds went out, so that a notification can be traced. No ids or text.
    if (messages.length > 0) log(`sent ${messages.length} message(s): ${kindsOf(messages)}`)
    return messages
  }

  /** What the last reading found, or null before the first one. */
  const snapshot = () => board

  return { publish, plan, snapshot }
}
