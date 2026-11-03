// Finds the task lists of the running Claude and Codex sessions. Claude deletes a list's files once
// every task is completed, so the last tasks seen per list keep a finished goal readable.
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  claudePaths,
  currentGoal,
  findListTranscript,
  isListRunning,
  listRecentTaskLists,
  readRunningSessionIds,
  readTaskList,
  readTasksFromTranscript,
  readTranscriptCwd
} from './claude-sessions.mjs'
import { readCodexProgress } from './codex-progress.mjs'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function progressDir(home = homedir()) {
  return join(home, '.orca-milestone', 'progress')
}

function isFinished(tasks) {
  return tasks.length > 0 && tasks.every((task) => task.status === 'completed')
}

export function createSessionReader({ home, now = Date.now }) {
  const paths = claudePaths(home)
  const lastTasks = new Map()
  const replayed = new Set()
  const heads = new Map()

  async function headOf(listId) {
    if (heads.has(listId)) return heads.get(listId)
    const transcript = await findListTranscript(paths, listId)
    const cwd = transcript ? await readTranscriptCwd(transcript).catch(() => null) : null
    if (cwd) heads.set(listId, { cwd, transcript })
    return heads.get(listId) ?? null
  }

  /** A finished list whose files were deleted before this process saw them. */
  async function replayFinished(list) {
    const key = `${list.listId}\n${list.updatedAt}`
    if (replayed.has(key)) return
    replayed.add(key)
    // Only a list that ever had tasks keeps a high-water mark.
    if (!(await stat(join(list.dir, '.highwatermark')).catch(() => null))) return
    const head = await headOf(list.listId)
    if (!head) return
    const tasks = await readTasksFromTranscript(head.transcript).catch(() => [])
    if (isFinished(tasks)) lastTasks.set(list.listId, tasks)
  }

  function currentTasks(listId, tasks) {
    if (tasks.length > 0) {
      lastTasks.set(listId, tasks)
      return tasks
    }
    const previous = lastTasks.get(listId) ?? []
    // A list emptied before it was finished was cleared on purpose; it has nothing to show.
    return isFinished(previous) ? previous : []
  }

  return async function readSessions() {
    const running = await readRunningSessionIds(paths.sessionsRoot)
    const lists = await listRecentTaskLists(paths.tasksRoot, { now: now(), maxAgeMs: MAX_AGE_MS })
    const sessions = []
    for (const list of lists) {
      if (!isListRunning(list.listId, running)) {
        lastTasks.delete(list.listId)
        continue
      }
      const files = await readTaskList(list.dir)
      if (files.length === 0 && !lastTasks.has(list.listId)) await replayFinished(list)
      const tasks = currentTasks(list.listId, files)
      if (tasks.length === 0) continue
      const head = await headOf(list.listId)
      if (!head) continue
      sessions.push({ agent: 'claude', listId: list.listId, cwd: head.cwd, updatedAt: list.updatedAt, ...currentGoal(tasks) })
    }
    sessions.push(...(await readCodexProgress(progressDir(home))))
    return sessions
  }
}
