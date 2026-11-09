import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_STALE_MINUTES, loadApnsKey, loadConfig, loadServiceAccount } from '../src/config.mjs'
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
    allowedLogin: null,
    apns: null,
    sendText: true,
    staleMinutes: DEFAULT_STALE_MINUTES,
    httpPort: null
  })
  const custom = await loadConfig(await write({ ...valid, sendText: false, staleMinutes: 30, httpPort: 8787 }))
  assert.deepEqual([custom.sendText, custom.staleMinutes, custom.httpPort], [false, 30, 8787])
})

test('reads who may press the buttons, and refuses anything but a name', async () => {
  assert.equal((await loadConfig(await write({ ...valid, allowedLogin: 'me@example.com' }))).allowedLogin, 'me@example.com')
  for (const allowedLogin of ['', 1, true]) {
    await assert.rejects(loadConfig(await write({ ...valid, allowedLogin })), /allowedLogin/)
  }
})

test('refuses a file others can read', async () => {
  await assert.rejects(loadConfig(await write(valid, 0o644)), /chmod 600/)
})

test('refuses bad values, and a parse error does not quote the file', async () => {
  await assert.rejects(loadConfig(await write({ ...valid, deviceTokens: [] })), /deviceTokens/)
  await assert.rejects(loadConfig(await write({ ...valid, serviceAccountFile: '~/key.json' })), /absolute/)
  await assert.rejects(loadConfig(await write({ ...valid, staleMinutes: 0 })), /staleMinutes/)
  for (const httpPort of [0, 65536, 80.5, '8787']) {
    await assert.rejects(loadConfig(await write({ ...valid, httpPort })), /httpPort/)
  }
  await assert.rejects(loadConfig(join(await makeHome(), 'missing.json')), /not found/)
  await assert.rejects(loadServiceAccount(await write('{"private_key": "SECRET"')), (error) => {
    assert.ok(!error.message.includes('SECRET'))
    return /not valid JSON/.test(error.message)
  })
  await assert.rejects(loadServiceAccount(await write({ project_id: 'demo' })), /client_email/)
})

const apns = { keyFile: '/keys/AuthKey.p8', keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'dev.example.app' }

test('reads the APNs settings, and refuses incomplete ones', async () => {
  assert.deepEqual((await loadConfig(await write({ ...valid, apns: { ...apns, extra: 1 } }))).apns, apns)
  await assert.rejects(loadConfig(await write({ ...valid, apns: null })), /keyFile/)
  await assert.rejects(loadConfig(await write({ ...valid, apns: { ...apns, keyFile: '~/AuthKey.p8' } })), /keyFile/)
  await assert.rejects(loadConfig(await write({ ...valid, apns: { ...apns, keyId: 'short' } })), /keyId/)
  await assert.rejects(loadConfig(await write({ ...valid, apns: { ...apns, teamId: undefined } })), /teamId/)
  await assert.rejects(loadConfig(await write({ ...valid, apns: { ...apns, topic: '' } })), /topic/)
})

test('the APNs key must be private and a .p8 key, and is never quoted', async () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n'
  assert.equal(await loadApnsKey(await write(pem)), pem)
  await assert.rejects(loadApnsKey(await write(pem, 0o644)), /chmod 600/)
  await assert.rejects(loadApnsKey(await write('SECRET')), (error) => {
    assert.ok(!error.message.includes('SECRET'))
    return /not a \.p8 key/.test(error.message)
  })
})
