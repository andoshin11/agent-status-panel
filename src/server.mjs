// Lets a phone read the sessions instead of receiving them, for the iOS widget, which cannot take
// data from a push. It listens only on this machine; `tailscale serve` passes it to the tailnet.
import { createServer } from 'node:http'

export const STATUS_PATH = '/status.json'

/**
 * @param snapshot  returns what to serve, or null before the sessions were first read
 * @returns the listening server
 */
export function startStatusServer({ port, host = '127.0.0.1', snapshot }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
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

function reply(response, status, body, headOnly = false) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Every read has to see the sessions as they are now.
    'cache-control': 'no-store'
  })
  response.end(headOnly ? undefined : text)
}
