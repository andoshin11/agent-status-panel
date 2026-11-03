// Reads what Codex sessions recorded through the update_progress tool of orca-milestone. The files
// belong to that plugin, so this only reads them: it never removes the file of a finished session.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return error.code === 'EPERM'
  }
}

export async function readCodexProgress(dir, { running = isRunning } = {}) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const lists = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const { pid, cwd, goal, updatedAt, tasks } = JSON.parse(await readFile(join(dir, name), 'utf8'))
          if (!running(pid) || !Array.isArray(tasks)) return null
          return { agent: 'codex', listId: name.slice(0, -'.json'.length), cwd, goal, updatedAt, tasks }
        } catch {
          return null
        }
      })
  )
  return lists.filter(Boolean)
}
