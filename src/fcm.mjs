// Sends data messages through the FCM HTTP v1 API, signing in with a service account key. It needs
// no dependencies: the OAuth 2 assertion is a JWT signed with node:crypto.
import { createSign } from 'node:crypto'

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ASSERTION_SECONDS = 3600
const REFRESH_MARGIN_MS = 60_000
const TIMEOUT_MS = 15_000
// A phone that was offline gets the newest message per session, up to this long afterwards.
// A session can stay unchanged for days, so its one message has to outlast the phone being offline.
// collapse_key leaves only the newest message per session waiting.
const TTL = '604800s'

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function signAssertion({ client_email, private_key }, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + ASSERTION_SECONDS
    })
  )
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(private_key, 'base64url')
  return `${header}.${claims}.${signature}`
}

/** The message for one device. Later a Live Activity would add its `apns` part here. */
export function buildMessage(token, data) {
  return {
    token,
    data,
    android: { priority: 'HIGH', ttl: TTL, collapse_key: data.id }
  }
}

async function isUnregistered(response) {
  const body = await response.json().catch(() => null)
  return Boolean(body?.error?.details?.some((detail) => detail?.errorCode === 'UNREGISTERED'))
}

export function createFcmSender({ serviceAccount, tokens, fetch = globalThis.fetch, now = Date.now, log = () => {} }) {
  const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`
  const live = new Set(tokens)
  let access = null
  let pending = null

  async function signIn() {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signAssertion(serviceAccount, Math.floor(now() / 1000))
      })
    })
    // The body of a failed sign-in is not logged; only the status is needed.
    if (!response.ok) throw new Error(`FCM sign-in failed with HTTP ${response.status}`)
    const { access_token: token, expires_in: seconds } = await response.json()
    return { token, expiresAt: now() + seconds * 1000 }
  }

  /** Devices are sent to at once, so they share one sign-in. A failed one is not kept. */
  function accessToken() {
    if (access && now() < access.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(access.token)
    pending ??= signIn()
      .then((result) => {
        access = result
        return result.token
      })
      .finally(() => {
        pending = null
      })
    return pending
  }

  async function sendOne(token, data) {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: buildMessage(token, data) })
    })
    if (response.ok) return
    if (response.status === 401) access = null
    // The app was removed or its token changed; asking again would never succeed. A wrong project
    // is also a 404, and must not cost the tokens.
    if (response.status === 404 && (await isUnregistered(response))) {
      live.delete(token)
      log(`dropped a device token that FCM no longer knows; ${live.size} left`)
      return
    }
    throw new Error(`FCM send failed with HTTP ${response.status}`)
  }

  /** Resolves once every known device has the message; rejects so the caller tries again later. */
  return async function send(data) {
    if (live.size === 0) throw new Error('no device tokens left')
    await Promise.all([...live].map((token) => sendOne(token, data)))
  }
}
