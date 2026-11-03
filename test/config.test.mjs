import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_STALE_MINUTES, loadConfig, loadServiceAccount } from '../src/config.mjs'
import { makeHome } from './helpers.mjs'

async function write(value, mode = 0o600) {
  const path = join(await makeHome(), 'file.json')
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  await chmod(path, mode)
  return path
}

const valid = { deviceTokens: ['device'], serviceAccountFile: '/keys/account.json' }

test('reads the settings and fills the defaults', async () => {
  assert.deepEqual(await loadConfig(await write(valid)), {
    ...valid,
    sendText: true,
    staleMinutes: DEFAULT_STALE_MINUTES
  })
  const custom = await loadConfig(await write({ ...valid, sendText: false, staleMinutes: 30 }))
  assert.deepEqual([custom.sendText, custom.staleMinutes], [false, 30])
})

test('refuses a file others can read', async () => {
  await assert.rejects(loadConfig(await write(valid, 0o644)), /chmod 600/)
})

test('refuses bad values, and a parse error does not quote the file', async () => {
  await assert.rejects(loadConfig(await write({ ...valid, deviceTokens: [] })), /deviceTokens/)
  await assert.rejects(loadConfig(await write({ ...valid, serviceAccountFile: '~/key.json' })), /absolute/)
  await assert.rejects(loadConfig(await write({ ...valid, staleMinutes: 0 })), /staleMinutes/)
  await assert.rejects(loadConfig(join(await makeHome(), 'missing.json')), /not found/)
  await assert.rejects(loadServiceAccount(await write('{"private_key": "SECRET"')), (error) => {
    assert.ok(!error.message.includes('SECRET'))
    return /not valid JSON/.test(error.message)
  })
  await assert.rejects(loadServiceAccount(await write({ project_id: 'demo' })), /client_email/)
})
