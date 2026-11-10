// Reads Claude Code's task lists (~/.claude/tasks/<list-id>/<n>.json) and the session
// transcripts (~/.claude/projects/<project>/<session-id>.jsonl) they belong to.
//
// A plain session names its list by its session id. A session that leads an agent team
// (`claude --teammate-mode`, which Orca's Agent Teams launch uses) names it after the team,
// `session-<first 8 hex of the session id>`.
//
// Taken from orca-milestone (src/claude-sessions.mjs), without the parts that read user prompts.
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TEAM_LIST_ID = /^session-([0-9a-f]{8})$/
// The working directory sits near the top; big transcripts are not read whole to find it.
const TRANSCRIPT_HEAD_BYTES = 512 * 1024
// A question being asked is at the very end, so a long transcript is not read whole to find it.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024

export function claudePaths(home) {
  return {
    tasksRoot: join(home, '.claude', 'tasks'),
    projectsRoot: join(home, '.claude', 'projects'),
    teamsRoot: join(home, '.claude', 'teams'),
    sessionsRoot: join(home, '.claude', 'sessions')
  }
}

export function isSessionId(name) {
  return SESSION_ID.test(name)
}

export function isTaskListId(name) {
  return SESSION_ID.test(name) || TEAM_LIST_ID.test(name)
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM'
  }
}

/**
 * Ids of the Claude sessions running now. Each running session keeps
 * ~/.claude/sessions/<pid>.json, removed when it exits; the pid is checked in case it crashed.
 */
export async function readRunningSessionIds(sessionsRoot) {
  return new Set((await readRunningSessions(sessionsRoot)).map((entry) => entry.sessionId))
}

/** The running Claude sessions as Claude Code records them: sessionId, pid, cwd. */
export async function readRunningSessions(sessionsRoot) {
  let names
  try {
    names = await readdir(sessionsRoot)
  } catch {
    return []
  }
  const running = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    const entry = await readJson(join(sessionsRoot, name))
    if (entry && isSessionId(entry.sessionId) && Number.isInteger(entry.pid) && isRunning(entry.pid)) running.push(entry)
  }
  return running
}

/** Whether the session that owns a task list (by its id, or a team's id prefix) is running. */
export function isListRunning(listId, runningIds) {
  if (isSessionId(listId)) return runningIds.has(listId)
  const prefix = TEAM_LIST_ID.exec(listId)?.[1]
  return Boolean(prefix) && [...runningIds].some((id) => id.startsWith(`${prefix}-`))
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Tasks of one list, ordered by their numeric id. Unreadable files are skipped. */
export async function readTaskList(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const tasks = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => readJson(join(dir, name)))
  )
  return tasks
    .filter((task) => task && typeof task.subject === 'string' && typeof task.status === 'string')
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/** Task lists named by a session or a team that changed within maxAgeMs, newest first. */
export async function listRecentTaskLists(tasksRoot, { now = Date.now(), maxAgeMs }) {
  let entries
  try {
    entries = await readdir(tasksRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const lists = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isTaskListId(entry.name))
      .map(async (entry) => {
        const dir = join(tasksRoot, entry.name)
        try {
          // Claude replaces task files by rename, which bumps the directory's mtime.
          const { mtimeMs } = await stat(dir)
          return { listId: entry.name, dir, updatedAt: mtimeMs }
        } catch {
          return null
        }
      })
  )
  return lists
    .filter((list) => list && now - list.updatedAt <= maxAgeMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function findTranscript(projectsRoot, sessionId) {
  let projects
  try {
    projects = await readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const path = join(projectsRoot, project.name, `${sessionId}.jsonl`)
    try {
      await stat(path)
      return path
    } catch {}
  }
  return null
}

async function findTranscriptByPrefix(projectsRoot, prefix) {
  let projects
  try {
    projects = await readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let names
    try {
      names = await readdir(join(projectsRoot, project.name))
    } catch {
      continue
    }
    const name = names.find(
      (file) => file.startsWith(prefix) && file.endsWith('.jsonl') && isSessionId(file.slice(0, -'.jsonl'.length))
    )
    if (name) return join(projectsRoot, project.name, name)
  }
  return null
}

/** The transcript of the session that owns a task list, or null. */
export async function findListTranscript({ projectsRoot, teamsRoot }, listId) {
  if (isSessionId(listId)) return findTranscript(projectsRoot, listId)
  const prefix = TEAM_LIST_ID.exec(listId)?.[1]
  if (!prefix) return null
  // The team config names the lead session only while the team runs; afterwards only the
  // prefix in the list id is left to go on.
  const lead = (await readJson(join(teamsRoot, listId, 'config.json')))?.leadSessionId
  if (typeof lead === 'string' && isSessionId(lead) && lead.startsWith(prefix)) {
    const transcript = await findTranscript(projectsRoot, lead)
    if (transcript) return transcript
  }
  return findTranscriptByPrefix(projectsRoot, `${prefix}-`)
}

function writtenGoal(task) {
  const goal = task.metadata?.goal
  return typeof goal === 'string' && goal.trim() ? goal.trim() : null
}

/**
 * The goal Claude wrote on its tasks (metadata.goal) and the tasks that belong to it. The newest
 * task with a goal names the current one; tasks of earlier goals are left out, while tasks
 * without a goal stay once they come after the current goal's first task. Without any goal,
 * every task is kept.
 */
export function currentGoal(tasks) {
  const last = tasks.findLast((task) => writtenGoal(task))
  if (!last) return { goal: null, tasks }
  const goal = writtenGoal(last)
  const first = tasks.findIndex((task) => writtenGoal(task) === goal)
  return {
    goal,
    tasks: tasks.filter((task, index) => {
      const written = writtenGoal(task)
      return written ? written === goal : index > first
    })
  }
}

/**
 * The task list as Claude left it, replayed from the TaskCreate and TaskUpdate calls in a
 * transcript. Claude deletes a list's files once every task is completed; this brings it back.
 */
export async function readTasksFromTranscript(path) {
  const created = new Map()
  const tasks = new Map()
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"Task')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = Array.isArray(entry.message?.content) ? entry.message.content : []
    if (entry.type === 'assistant') {
      for (const part of content) {
        if (part?.type !== 'tool_use') continue
        if (part.name === 'TaskCreate') created.set(part.id, part.input ?? {})
        if (part.name === 'TaskUpdate') {
          const { taskId, status, subject, description, activeForm, metadata } = part.input ?? {}
          const task = tasks.get(String(taskId))
          if (!task) continue
          if (status === 'deleted') {
            tasks.delete(task.id)
            continue
          }
          Object.assign(task, Object.fromEntries(
            Object.entries({ status, subject, description, activeForm }).filter(([, v]) => typeof v === 'string')
          ))
          if (metadata && typeof metadata === 'object') task.metadata = { ...task.metadata, ...metadata }
        }
      }
    } else if (entry.type === 'user' && entry.toolUseResult?.task?.id) {
      const result = content.find((part) => part?.type === 'tool_result' && created.has(part.tool_use_id))
      if (!result) continue
      const input = created.get(result.tool_use_id)
      const id = String(entry.toolUseResult.task.id)
      // Claude clears a list once all of it is completed, so new tasks start a new list.
      if ([...tasks.values()].every((task) => task.status === 'completed')) tasks.clear()
      tasks.set(id, {
        id,
        subject: input.subject ?? entry.toolUseResult.task.subject ?? '',
        description: input.description ?? '',
        ...(input.activeForm ? { activeForm: input.activeForm } : {}),
        status: 'pending',
        blocks: [],
        blockedBy: [],
        ...(input.metadata ? { metadata: input.metadata } : {})
      })
    }
  }
  return [...tasks.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

/** The working directory recorded at the top of a transcript. User prompts are never returned. */
export async function readTranscriptCwd(path) {
  let text
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    text = buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
  for (const line of text.split('\n')) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry.cwd === 'string') return entry.cwd
  }
  return null
}

async function readTail(path) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, size - length)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

/**
 * The AskUserQuestion call that has no result yet, from the lines of a transcript. Only the last
 * one counts: an earlier call without a result was abandoned.
 */
export function pendingQuestion(text) {
  const answered = new Set()
  for (const line of text.split('\n').toReversed()) {
    if (!line.includes('tool_')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // The tail can begin in the middle of a line.
      continue
    }
    const content = Array.isArray(entry.message?.content) ? entry.message.content : []
    for (const part of content.toReversed()) {
      if (part?.type === 'tool_result') answered.add(part.tool_use_id)
      if (part?.type === 'tool_use' && part.name === 'AskUserQuestion') {
        return answered.has(part.id) ? null : { toolUseId: part.id, questions: part.input?.questions ?? [] }
      }
    }
  }
  return null
}

/** The last tool call in a transcript, when it has no result yet: the one waiting for permission. */
export function pendingCall(text) {
  const answered = new Set()
  for (const line of text.split('\n').toReversed()) {
    if (!line.includes('tool_')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = Array.isArray(entry.message?.content) ? entry.message.content : []
    for (const part of content.toReversed()) {
      if (part?.type === 'tool_result') answered.add(part.tool_use_id)
      // The folder the shell was in, which a command that does not change it runs in.
      if (part?.type === 'tool_use') return answered.has(part.id) ? null : { toolUseId: part.id, name: part.name, input: part.input ?? {}, ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}) }
    }
  }
  return null
}

/**
 * Whether the last turn in a transcript is over: Claude Code writes `turn_duration` when a turn ends,
 * and a prompt or a tool result after it starts another. Orca keeps an agent "working" while shells
 * it started in the background run, even when it waits for the user.
 */
export function turnEnded(text) {
  for (const line of text.split('\n').toReversed()) {
    if (!line.includes('"type"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') return true
    if (entry.type === 'user' || entry.type === 'assistant') return null
  }
  return null
}

/** Finds whether the running Claude session in a workspace has ended its turn. */
export function createTurnReader(home) {
  return createPendingReader(home, turnEnded)
}

/** Finds the question the running Claude session in a workspace is asking now. */
export function createQuestionReader(home) {
  return createPendingReader(home, pendingQuestion)
}

/** Finds the tool call the running Claude session in a workspace has not finished. */
export function createPendingCallReader(home) {
  return createPendingReader(home, pendingCall)
}

function createPendingReader(home, pick) {
  const { projectsRoot, sessionsRoot } = claudePaths(home)
  return async function readPending(path) {
    const inside = (await readRunningSessions(sessionsRoot)).filter((entry) => entry.cwd === path || entry.cwd?.startsWith(`${path}/`))
    const pending = []
    for (const { sessionId } of inside) {
      const transcript = await findTranscript(projectsRoot, sessionId)
      const asked = transcript ? pick(await readTail(transcript).catch(() => '')) : null
      if (asked) pending.push(asked)
    }
    // Another Claude in the same folder, started outside Orca, could be the one asking.
    return pending.length === 1 ? pending[0] : null
  }
}
