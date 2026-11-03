// Turns a session into what the phone receives. This is the contract with agent-status-panel-android.
// An FCM data message holds at most 4 KB, so it carries the counts and a short part of the list.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

export const SCHEMA_VERSION = '1'
const TEXT_MAX = 120
const SUBJECT_MAX = 60
const LIST_BYTES = 2400
const STATUS_CODES = { completed: 'c', in_progress: 'i', pending: 'p' }

function shorten(text, max = TEXT_MAX) {
  if (typeof text !== 'string') return ''
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

function fitsList(list) {
  return Buffer.byteLength(JSON.stringify(list)) <= LIST_BYTES
}

/**
 * The tasks as a JSON list of [status code, subject]: all of them when they fit. Otherwise those
 * from one before the first unfinished task, or the last ones of a finished list.
 */
function compactList(tasks) {
  const all = tasks.map((task) => {
    const subject = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
    return [STATUS_CODES[task.status] ?? 'p', shorten(subject, SUBJECT_MAX)]
  })
  if (fitsList(all)) return JSON.stringify(all)
  const unfinished = tasks.findIndex((task) => task.status !== 'completed')
  const list = []
  if (unfinished === -1) {
    for (const row of all.toReversed()) {
      if (!fitsList([row, ...list])) break
      list.unshift(row)
    }
  } else {
    for (const row of all.slice(Math.max(0, unfinished - 1))) {
      if (!fitsList([...list, row])) break
      list.push(row)
    }
  }
  return JSON.stringify(list)
}

/** A stable id for a list that does not reveal the session id. */
export function sessionKey(listId) {
  return createHash('sha256').update(listId).digest('hex').slice(0, 16)
}

/**
 * Only the name of the working directory leaves the machine, never its path. Prompts and task
 * descriptions are never included. With sendText off, goal, step and task list are left empty too.
 */
export function buildProgress(session, { sendText = true } = {}) {
  const tasks = session.tasks.filter((task) => task.status !== 'deleted')
  const done = tasks.filter((task) => task.status === 'completed').length
  const current = tasks.find((task) => task.status === 'in_progress')
  return {
    v: SCHEMA_VERSION,
    id: sessionKey(session.listId),
    agent: session.agent,
    state: tasks.length > 0 && done === tasks.length ? 'finished' : 'active',
    workspace: sendText ? shorten(basename(session.cwd ?? '')) : '',
    goal: sendText ? shorten(session.goal) : '',
    step: sendText ? shorten(current?.activeForm ?? current?.subject) : '',
    tasks: sendText ? compactList(tasks) : '[]',
    done: String(done),
    total: String(tasks.length)
  }
}

/** Tells the phone that a session it was showing is gone. */
export function buildEnded(id) {
  return { v: SCHEMA_VERSION, id, state: 'ended' }
}

/** What decides whether something changed. */
export function fingerprint(payload) {
  return JSON.stringify(payload)
}
