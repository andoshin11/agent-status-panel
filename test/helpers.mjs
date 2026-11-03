import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SESSION_A = '11111111-1111-4111-8111-111111111111'
export const SESSION_B = '22222222-2222-4222-8222-222222222222'

export async function makeHome() {
  return mkdtemp(join(tmpdir(), 'agent-status-panel-'))
}

export async function writeTasks(home, sessionId, tasks) {
  const dir = join(home, '.claude', 'tasks', sessionId)
  await mkdir(dir, { recursive: true })
  for (const task of tasks) {
    await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task))
  }
  return dir
}

let fakePid = 1000

/** Registers a session as running the way Claude does, with this test process as its pid. */
export async function markRunning(home, sessionId) {
  const dir = join(home, '.claude', 'sessions')
  await mkdir(dir, { recursive: true })
  fakePid += 1
  const file = join(dir, `${fakePid}.json`)
  await writeFile(file, JSON.stringify({ pid: process.pid, sessionId }))
  return file
}

export async function writeTranscript(home, sessionId, { cwd, gitBranch = 'main', prompt, running = true, extra = [] }) {
  if (running) await markRunning(home, sessionId)
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  const lines = [
    { type: 'mode', sessionId },
    { type: 'user', cwd, gitBranch, sessionId, isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } },
    { type: 'user', cwd, gitBranch, sessionId, message: { role: 'user', content: prompt } },
    { type: 'assistant', cwd, gitBranch, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ...extra
  ]
  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

export function task(id, subject, status, extra = {}) {
  return { id: String(id), subject, description: subject, status, blocks: [], blockedBy: [], ...extra }
}

/** Transcript entries for Claude creating tasks, then updating them. */
export function taskCalls(creates, updates = [], firstId = 1) {
  const entries = []
  creates.forEach((input, index) => {
    const toolId = `create-${firstId + index}`
    entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'TaskCreate', input }] } })
    entries.push({
      type: 'user',
      toolUseResult: { task: { id: String(firstId + index), subject: input.subject } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Task created' }] }
    })
  })
  for (const input of updates) {
    entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'TaskUpdate', input }] } })
  }
  return entries
}
