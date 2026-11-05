import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startStatusServer, STATUS_PATH } from '../src/server.mjs'

async function serve(snapshot) {
  const server = await startStatusServer({ port: 0, snapshot })
  const { address, port } = server.address()
  return { server, url: (path) => `http://${address}:${port}${path}` }
}

test('serves the sessions as they are now', async (t) => {
  let board = { v: '1', at: '1', sessions: [] }
  const { server, url } = await serve(() => board)
  t.after(() => server.close())
  let response = await fetch(url(STATUS_PATH))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), board)
  board = { v: '1', at: '2', sessions: [{ id: 'a' }] }
  response = await fetch(url(STATUS_PATH))
  assert.deepEqual(await response.json(), board)
})

test('listens only on this machine', async (t) => {
  const { server } = await serve(() => null)
  t.after(() => server.close())
  assert.equal(server.address().address, '127.0.0.1')
})

test('says when the sessions were not read yet', async (t) => {
  const { server, url } = await serve(() => null)
  t.after(() => server.close())
  assert.equal((await fetch(url(STATUS_PATH))).status, 503)
})

test('serves nothing else', async (t) => {
  const { server, url } = await serve(() => ({ v: '1', at: '1', sessions: [] }))
  t.after(() => server.close())
  assert.equal((await fetch(url('/'))).status, 404)
  assert.equal((await fetch(url('/status.json/x'))).status, 404)
  const post = await fetch(url(STATUS_PATH), { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  const head = await fetch(url(STATUS_PATH), { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})
