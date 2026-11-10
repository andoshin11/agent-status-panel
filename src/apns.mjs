// Tells the iOS app through APNs when an agent needs the user, and when it no longer does. The
// widget reads the sessions itself, so nothing else is sent. It needs no dependencies: the provider
// token is a JWT signed with node:crypto, and node:http2 carries the requests.
import { createSign } from 'node:crypto'
import { connect, constants } from 'node:http2'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ENVIRONMENTS = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com'
}
// Apple refuses a token older than an hour, and one renewed more often than every 20 minutes.
const TOKEN_MS = 50 * 60_000
const TIMEOUT_MS = 15_000
// An agent that waits a day for the user is no longer worth a banner.
const ATTENTION_SECONDS = 24 * 3600
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/
const PERMANENT = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'BadEnvironmentKeyInToken'])
const REASONS = {
  permission: '許可を待っています',
  blocked: 'ブロックされています',
  waiting: '入力を待っています'
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function signProviderToken({ keyId, teamId, key }, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64url(JSON.stringify({ iss: teamId, iat: nowSeconds }))
  const signature = createSign('SHA256').update(`${header}.${claims}`).sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url')
  return `${header}.${claims}.${signature}`
}

export function isDeviceToken(token) {
  return typeof token === 'string' && DEVICE_TOKEN.test(token)
}

/**
 * The notification one message calls for, or null. Only the attention and proposal messages and
 * their ends reach the phone: a banner when an agent starts waiting or proposes what to do next, and
 * a silent push that removes it.
 */
export function buildNotification(data, nowSeconds) {
  // With an offer, the app's notification service reads its choices from the Mac mini and adds them
  // as buttons; the text never passes through Apple. Without one, or when it cannot, the banner
  // stays as sent.
  const choices = data.offer ? { 'mutable-content': 1 } : {}
  const extra = data.offer ? { offer: data.offer } : {}
  if (data.state === 'attention') {
    return {
      pushType: 'alert',
      priority: '10',
      expiration: String(nowSeconds + ATTENTION_SECONDS),
      payload: {
        aps: {
          alert: { title: data.workspace || 'エージェント', body: REASONS[data.reason] ?? '操作を待っています' },
          sound: 'default',
          'thread-id': 'attention',
          'interruption-level': 'time-sensitive',
          ...choices
        },
        id: data.id,
        ...extra
      }
    }
  }
  if (data.state === 'proposal') {
    return {
      pushType: 'alert',
      priority: '10',
      expiration: String(nowSeconds + ATTENTION_SECONDS),
      payload: {
        // Nothing waits for it, so it does not break through a focus.
        aps: { alert: { title: data.workspace || 'エージェント', body: '次の作業を選べます' }, sound: 'default', 'thread-id': 'proposal', ...choices },
        id: data.id,
        ...extra
      }
    }
  }
  if (data.state === 'ended' && (data.id.startsWith('attention-') || data.id.startsWith('proposal-'))) {
    return {
      pushType: 'background',
      // Apple drops a background push sent at priority 10.
      priority: '5',
      expiration: String(nowSeconds + ATTENTION_SECONDS),
      payload: { aps: { 'content-available': 1 }, ended: data.id }
    }
  }
  return null
}

/** One HTTP/2 connection per APNs host, opened again when Apple closes it. */
export function createHttp2Request() {
  const sessions = new Map()
  function session(origin) {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const created = connect(origin)
    // A failed connection fails its requests, which reject on their own.
    created.on('error', () => {})
    created.on('close', () => sessions.delete(origin))
    sessions.set(origin, created)
    return created
  }
  function request({ origin, path, headers, body }) {
    return new Promise((resolve, reject) => {
      const stream = session(origin).request({ ':method': 'POST', ':path': path, ...headers })
      let status = null
      const chunks = []
      stream.setTimeout(TIMEOUT_MS, () => stream.close(constants.NGHTTP2_CANCEL))
      stream.on('response', (response) => {
        status = response[':status']
      })
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => {
        if (status === null) reject(new Error('APNs did not answer'))
        else resolve({ status, body: Buffer.concat(chunks).toString() })
      })
      stream.on('error', reject)
      stream.end(body)
    })
  }
  request.close = () => {
    for (const open of sessions.values()) open.close()
  }
  return request
}

/** The devices that asked for notifications, kept on disk so a restart does not forget them. */
export async function createDeviceRegistry(path) {
  let devices = {}
  try {
    devices = JSON.parse(await readFile(path, 'utf8')).devices ?? {}
  } catch {
    // None registered yet.
  }
  let saving = Promise.resolve()
  /** One at a time, since they share the temporary file. Each writes the devices as they are then. */
  function save() {
    saving = saving
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(`${path}.tmp`, JSON.stringify({ devices }), { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      })
    return saving
  }
  return {
    list: () => Object.entries(devices).map(([token, { environment }]) => ({ token, environment })),
    /** Resolves to whether the device is new. */
    async add(token, environment) {
      if (devices[token]?.environment === environment) return false
      devices[token] = { environment }
      await save()
      return true
    },
    async remove(token) {
      delete devices[token]
      await save()
    }
  }
}

function reasonOf(body) {
  try {
    return JSON.parse(body).reason ?? ''
  } catch {
    return ''
  }
}

/**
 * @param key  the .p8 key from Apple, as PEM text
 * @param topic  the bundle id of the app
 */
export function createApnsSender({ key, keyId, teamId, topic, devices, request = createHttp2Request(), now = Date.now, log = () => {} }) {
  let token = null

  function providerToken() {
    if (!token || now() - token.at >= TOKEN_MS) token = { at: now(), value: signProviderToken({ keyId, teamId, key }, Math.floor(now() / 1000)) }
    return token.value
  }

  async function sendOne(device, notification, id) {
    const { status, body } = await request({
      origin: ENVIRONMENTS[device.environment],
      path: `/3/device/${device.token}`,
      headers: {
        authorization: `bearer ${providerToken()}`,
        'apns-topic': topic,
        'apns-push-type': notification.pushType,
        'apns-priority': notification.priority,
        'apns-expiration': notification.expiration,
        // A later banner for the same workspace replaces the earlier one.
        'apns-collapse-id': id,
        'content-type': 'application/json'
      },
      body: JSON.stringify(notification.payload)
    })
    if (status === 200) return
    const reason = reasonOf(body)
    if (reason === 'ExpiredProviderToken') token = null
    // The app was removed, the token belongs to the other environment, or the key is not allowed in
    // the device's environment. Asking again would never succeed, and would hold up every message.
    if (status === 410 || PERMANENT.has(reason)) {
      await devices.remove(device.token)
      log(`dropped a device that APNs refused (${reason || status}); ${devices.list().length} left`)
      return
    }
    throw new Error(`APNs send failed with HTTP ${status} ${reason}`.trim())
  }

  /** Resolves once every device has the notification; rejects so the caller tries again later. */
  async function send(data) {
    const notification = buildNotification(data, Math.floor(now() / 1000))
    if (!notification) return
    await Promise.all(devices.list().map((device) => sendOne(device, notification, data.id)))
  }
  send.close = () => request.close?.()
  return send
}
