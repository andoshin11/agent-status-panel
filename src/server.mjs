// Lets a phone read the sessions instead of receiving them, for the iOS widget, which cannot take
// data from a push. The iOS app also registers here for its notifications. It listens only on this
// machine; `tailscale serve` passes it to the tailnet.
import { createServer } from 'node:http'

export const STATUS_PATH = '/status.json'
export const DEVICES_PATH = '/apns/devices'
const BODY_LIMIT = 1024

/**
 * @param snapshot  returns what to serve, or null before the sessions were first read
 * @param register  takes `{ token, environment }` from the iOS app and resolves once it is kept;
 *   throws a TypeError for a body it refuses. Without it, there is nothing to register with.
 * @returns the listening server
 */
export function startStatusServer({ port, host = '127.0.0.1', snapshot, register = null }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === DEVICES_PATH && register) return registerDevice(request, response, register)
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

async function registerDevice(request, response, register) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    return reply(response, 405, { error: 'method not allowed' })
  }
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > BODY_LIMIT) return reply(response, 413, { error: 'too large' })
  }
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
