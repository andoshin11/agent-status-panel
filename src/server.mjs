// Lets a phone read the sessions instead of receiving them, for the iOS widget, which cannot take
// data from a push. The iOS app also registers here for its notifications and presses the buttons
// for what an agent proposed. It listens only on this machine; `tailscale serve` passes it to the
// tailnet.
import { createServer } from 'node:http'

export const STATUS_PATH = '/status.json'
export const DEVICES_PATH = '/apns/devices'
export const NEXT_PATH = '/next'
const BODY_LIMIT = 1024

/**
 * @param snapshot  returns what to serve, or null before the sessions were first read
 * @param register  takes `{ token, environment }` from the iOS app and resolves once it is kept;
 *   throws a TypeError for a body it refuses. Without it, there is nothing to register with.
 * @param next  takes `{ offer, index }` and resolves to whether that button was still on offer, or
 *   to 'typing' when it cannot be sent now
 * @param allowedLogin  the Tailscale login that may press the buttons. Without it there are none.
 * @returns the listening server
 */
export function startStatusServer({ port, host = '127.0.0.1', snapshot, register = null, next = null, allowedLogin = null }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === DEVICES_PATH && register) return registerDevice(request, response, register)
    if (path === NEXT_PATH && next && allowedLogin) return pressNext(request, response, next, allowedLogin)
    if (path !== STATUS_PATH) return reply(response, 404, { error: 'not found' })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD')
      return reply(response, 405, { error: 'method not allowed' })
    }
    const body = snapshot()
    if (!body) return reply(response, 503, { error: 'not read yet' })
    reply(response, 200, body, request.method === 'HEAD')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/** Null when the body is over the limit. */
async function readBody(request) {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > BODY_LIMIT) return null
  }
  return text
}

/** This one makes an agent act, so unlike reading it is open to one person only. */
async function pressNext(request, response, next, allowedLogin) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    return reply(response, 405, { error: 'method not allowed' })
  }
  // `tailscale serve` sets this from who is connecting, and removes what the client sent.
  if (request.headers['tailscale-user-login'] !== allowedLogin) return reply(response, 403, { error: 'forbidden' })
  const text = await readBody(request)
  if (text === null) return reply(response, 413, { error: 'too large' })
  let press
  try {
    const { offer, index } = JSON.parse(text)
    if (typeof offer !== 'string' || !Number.isInteger(index)) throw new TypeError('not a button')
    press = { offer, index }
  } catch {
    return reply(response, 400, { error: 'bad button' })
  }
  try {
    const result = await next(press)
    if (result === 'typing') return reply(response, 423, { error: 'the input box has a draft' })
    if (result) return reply(response, 204)
    reply(response, 409, { error: 'no longer on offer' })
  } catch {
    reply(response, 502, { error: 'not sent' })
  }
}

async function registerDevice(request, response, register) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    return reply(response, 405, { error: 'method not allowed' })
  }
  const text = await readBody(request)
  if (text === null) return reply(response, 413, { error: 'too large' })
  try {
    const { token, environment } = JSON.parse(text)
    await register({ token, environment })
    reply(response, 204)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return reply(response, 400, { error: 'bad device' })
    reply(response, 500, { error: 'not kept' })
  }
}

function reply(response, status, body, headOnly = false) {
  if (status === 204) {
    response.writeHead(204, { 'cache-control': 'no-store' })
    return response.end()
  }
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Every read has to see the sessions as they are now.
    'cache-control': 'no-store'
  })
  response.end(headOnly ? undefined : text)
}
