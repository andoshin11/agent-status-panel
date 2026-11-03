// Runs the publisher when the task files change, and on a timer for what files do not tell: a
// session that ended, or one that went idle. Rapid changes are sent together.
import { watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'

const DEBOUNCE_MS = 2_000
// Also how late a notification that an agent needs the user can be.
const SYNC_MS = 15_000

export function startDaemon({ publish, dirs, log, watchDir = (dir, onChange) => watch(dir, { recursive: true }, onChange), debounceMs = DEBOUNCE_MS, syncMs = SYNC_MS }) {
  let timer = null
  let running = null
  let rerun = false
  let lastFailure = null

  async function run() {
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        try {
          await publish()
          lastFailure = null
        } catch (error) {
          // A long outage retries every sync but logs once.
          if (error.message !== lastFailure) log(`publish failed, trying again later: ${error.message}`)
          lastFailure = error.message
        }
      } while (rerun)
    })()
    try {
      await running
    } finally {
      running = null
    }
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(run, debounceMs)
  }

  const ready = (async () => {
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true })
      watchDir(dir, (_event, name) => {
        if (!name || !String(name).endsWith('.lock')) schedule()
      })
    }
    await run()
  })()
  const interval = setInterval(run, syncMs)

  return { ready, run, stop: () => (clearInterval(interval), clearTimeout(timer)) }
}
