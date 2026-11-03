import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { buildMessage, createFcmSender, signAssertion } from '../src/fcm.mjs'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = {
  project_id: 'demo',
  client_email: 'sender@demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
}
const DATA = { v: '1', id: 'abc', state: 'active' }

function respond(status, body = {}) {
  return { ok: status < 400, status, json: async () => body }
}

function fakeFetch(sendStatus = () => 200, unregistered = true) {
  const calls = { token: 0, sends: [] }
  const fetch = async (url, init) => {
    if (String(url).includes('oauth2')) {
      calls.token += 1
      return respond(200, { access_token: `access-${calls.token}`, expires_in: 3600 })
    }
    calls.sends.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) })
    const status = sendStatus(calls.sends.length)
    return respond(status, status === 404 ? { error: { details: [{ errorCode: unregistered ? 'UNREGISTERED' : 'OTHER' }] } } : {})
  }
  return { fetch, calls }
}

test('the assertion is a JWT signed with the key and asks for the FCM scope', () => {
  const [header, claims, signature] = signAssertion(account, 1000).split('.')
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'))
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString())
  assert.equal(decoded.iss, account.client_email)
  assert.equal(decoded.scope, 'https://www.googleapis.com/auth/firebase.messaging')
  assert.equal(decoded.exp, 4600)
})

test('a message is high priority and collapses per session while the phone is offline', () => {
  assert.deepEqual(buildMessage('device', DATA), {
    token: 'device',
    data: DATA,
    android: { priority: 'HIGH', ttl: '604800s', collapse_key: 'abc' }
  })
})

test('sends to every device with one sign-in until it expires', async () => {
  const { fetch, calls } = fakeFetch()
  let time = 0
  const send = createFcmSender({ serviceAccount: account, tokens: ['one', 'two'], fetch, now: () => time })
  await send(DATA)
  assert.deepEqual(calls.sends.map((call) => call.body.message.token), ['one', 'two'])
  assert.equal(calls.sends[0].url, 'https://fcm.googleapis.com/v1/projects/demo/messages:send')
  assert.equal(calls.sends[0].auth, 'Bearer access-1')
  await send(DATA)
  assert.equal(calls.token, 1)
  time = 3600 * 1000
  await send(DATA)
  assert.equal(calls.token, 2)
  await send(DATA)
  assert.equal(calls.token, 2)
  assert.equal(calls.sends.at(-1).auth, 'Bearer access-2')
})

test('a token FCM no longer knows is dropped; other failures reject so the caller retries', async () => {
  const { fetch, calls } = fakeFetch(() => 404)
  const send = createFcmSender({ serviceAccount: account, tokens: ['gone'], fetch })
  await send(DATA)
  await assert.rejects(send(DATA), /no device tokens/)
  assert.equal(calls.sends.length, 1)

  const busy = fakeFetch(() => 503)
  await assert.rejects(createFcmSender({ serviceAccount: account, tokens: ['one'], fetch: busy.fetch })(DATA), /HTTP 503/)
})

test('a 404 for another reason, such as a wrong project, keeps the token', async () => {
  const { fetch, calls } = fakeFetch(() => 404, false)
  const send = createFcmSender({ serviceAccount: account, tokens: ['one'], fetch })
  await assert.rejects(send(DATA), /HTTP 404/)
  await assert.rejects(send(DATA), /HTTP 404/)
  assert.equal(calls.sends.length, 2)
})

test('an expired sign-in is renewed on the next send', async () => {
  const { fetch, calls } = fakeFetch((count) => (count === 1 ? 401 : 200))
  const send = createFcmSender({ serviceAccount: account, tokens: ['one'], fetch })
  await assert.rejects(send(DATA), /HTTP 401/)
  await send(DATA)
  assert.equal(calls.token, 2)
})

test('a failed sign-in reports only the status', async () => {
  const fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'SECRET' }) })
  await assert.rejects(createFcmSender({ serviceAccount: account, tokens: ['one'], fetch })(DATA), (error) => {
    assert.ok(!error.message.includes('SECRET'))
    return /HTTP 400/.test(error.message)
  })
})
