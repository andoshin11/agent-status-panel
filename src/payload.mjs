// Turns a session into what the phone receives. This is the contract with agent-status-panel-app.
// An FCM data message holds at most 4 KB, so it carries counts and the current step, not the list.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

export const SCHEMA_VERSION = '1'
const TEXT_MAX = 120

function shorten(text) {
  if (typeof text !== 'string') return ''
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : line
}

/** A stable id for a list that does not reveal the session id. */
export function sessionKey(listId) {
  return createHash('sha256').update(listId).digest('hex').slice(0, 16)
}

/**
 * Only the name of the working directory leaves the machine, never its path. Prompts and task
 * descriptions are never included. With sendText off, goal and step are left empty too.
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
