import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildNotification, createApnsSender, createDeviceRegistry, isDeviceToken, signProviderToken } from '../src/apns.mjs'
import { makeHome } from './helpers.mjs'

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const key = privateKey.export({ type: 'pkcs8', format: 'pem' })
const TOKEN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const ATTENTION = { v: '1', id: 'attention-0123456789abcdef', state: 'attention', reason: 'permission', workspace: 'ios-app', at: '1' }

async function registry(devices = [[TOKEN, 'development']]) {
  const path = join(await makeHome(), 'state', 'apns-devices.json')
  const created = await createDeviceRegistry(path)
  for (const [token, environment] of devices) await created.add(token, environment)
  return { devices: created, path }
}

function fakeRequest(answer = () => ({ status: 200, body: '' })) {
  const calls = []
  const request = async (call) => {
    calls.push(call)
    return answer(calls.length, call)
  }
  return { request, calls }
}

function sender(devices, request, now = () => 0) {
  return createApnsSender({ key, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'dev.example.app', devices, request, now })
}

test('the provider token is an ES256 JWT for the team, signed with the key', () => {
  const [header, claims, signature] = signProviderToken({ keyId: 'KEY1234567', teamId: 'TEAM123456', key }, 1000).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' })
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: 'TEAM123456', iat: 1000 })
  const verified = createVerify('SHA256').update(`${header}.${claims}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, signature, 'base64url')
  assert.ok(verified)
})

test('only an agent waiting for the user, and its end, become notifications', () => {
  assert.deepEqual(buildNotification(ATTENTION, 100), {
    pushType: 'alert',
    priority: '10',
    expiration: String(100 + 86400),
    payload: {
      aps: { alert: { title: 'ios-app', body: '許可を待っています' }, sound: 'default', 'thread-id': 'attention', 'interruption-level': 'time-sensitive' },
      id: ATTENTION.id
    }
  })
  const unnamed = buildNotification({ ...ATTENTION, workspace: '', reason: 'other' }, 0)
  assert.deepEqual(unnamed.payload.aps.alert, { title: 'エージェント', body: '操作を待っています' })
  assert.deepEqual(buildNotification({ v: '1', id: ATTENTION.id, state: 'ended' }, 0).payload, { aps: { 'content-available': 1 }, ended: ATTENTION.id })
  assert.equal(buildNotification({ v: '1', id: ATTENTION.id, state: 'ended' }, 0).priority, '5')
  assert.equal(buildNotification({ v: '1', id: '0123456789abcdef', state: 'ended' }, 0), null)
  assert.equal(buildNotification({ v: '1', id: '0123456789abcdef', state: 'active' }, 0), null)
})

test('sends to each device in its environment, with one token until it is 50 minutes old', async () => {
  const { devices } = await registry([[TOKEN, 'development'], [OTHER, 'production']])
  const { request, calls } = fakeRequest()
  let time = 0
  const send = sender(devices, request, () => time)
  await send(ATTENTION)
  assert.deepEqual(calls.map((call) => call.origin), ['https://api.sandbox.push.apple.com', 'https://api.push.apple.com'])
  assert.equal(calls[0].path, `/3/device/${TOKEN}`)
  assert.equal(calls[0].headers['apns-topic'], 'dev.example.app')
  assert.equal(calls[0].headers['apns-push-type'], 'alert')
  assert.equal(calls[0].headers['apns-collapse-id'], ATTENTION.id)
  assert.equal(JSON.parse(calls[0].body).id, ATTENTION.id)
  const first = calls[0].headers.authorization
  time = 49 * 60_000
  await send(ATTENTION)
  assert.equal(calls[2].headers.authorization, first)
  time = 50 * 60_000
  await send(ATTENTION)
  assert.notEqual(calls[4].headers.authorization, first)
})

test('sends nothing for progress, and nothing when no iPhone registered', async () => {
  const { request, calls } = fakeRequest()
  await sender((await registry()).devices, request)({ v: '1', id: 'abc', state: 'active' })
  await sender((await registry([])).devices, request)(ATTENTION)
  assert.equal(calls.length, 0)
})

test('a device APNs refuses for good is dropped and forgotten on disk', async () => {
  const THIRD = 'ef'.repeat(32)
  const { devices, path } = await registry([[TOKEN, 'development'], [OTHER, 'development'], [THIRD, 'production']])
  const answers = {
    [TOKEN]: { status: 410, body: '{"reason":"Unregistered"}' },
    [OTHER]: { status: 400, body: '{"reason":"BadDeviceToken"}' },
    [THIRD]: { status: 403, body: '{"reason":"BadEnvironmentKeyInToken"}' }
  }
  const { request } = fakeRequest((count, call) => answers[call.path.split('/').at(-1)])
  await sender(devices, request)(ATTENTION)
  assert.deepEqual(devices.list(), [])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { devices: {} })
})

test('other failures reject so the caller retries, and an expired token is signed again', async () => {
  const { devices } = await registry()
  const { request, calls } = fakeRequest((count) => (count === 1 ? { status: 403, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200, body: '' }))
  const send = sender(devices, request)
  await assert.rejects(send(ATTENTION), /HTTP 403 ExpiredProviderToken/)
  await send(ATTENTION)
  assert.notEqual(calls[1].headers.authorization, calls[0].headers.authorization)
  assert.equal(devices.list().length, 1)
})

test('the registry keeps devices across restarts, only its owner can read it, and a repeat is not new', async () => {
  const { devices, path } = await registry([])
  assert.equal(await devices.add(TOKEN, 'development'), true)
  assert.equal(await devices.add(TOKEN, 'development'), false)
  assert.equal(await devices.add(TOKEN, 'production'), true)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual((await createDeviceRegistry(path)).list(), [{ token: TOKEN, environment: 'production' }])
})

test('a device token is lowercase hex', () => {
  assert.ok(isDeviceToken(TOKEN))
  assert.ok(!isDeviceToken(TOKEN.toUpperCase()))
  assert.ok(!isDeviceToken('ab'))
  assert.ok(!isDeviceToken(`${TOKEN}/../x`))
  assert.ok(!isDeviceToken(42))
})
