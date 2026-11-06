import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEVICES_PATH, startStatusServer, STATUS_PATH } from '../src/server.mjs'

async function serve(snapshot, register = null) {
  const server = await startStatusServer({ port: 0, snapshot, register })
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

test('the iOS app registers its device for notifications', async (t) => {
  const kept = []
  const register = async (device) => {
    if (device.token === 'bad') throw new TypeError('not an APNs device')
    if (device.token === 'disk') throw new Error('disk full')
    kept.push(device)
  }
  const { server, url } = await serve(() => null, register)
  t.after(() => server.close())
  const post = (body) => fetch(url(DEVICES_PATH), { method: 'POST', body })
  assert.equal((await post(JSON.stringify({ token: 'abc', environment: 'development', extra: 1 }))).status, 204)
  assert.deepEqual(kept, [{ token: 'abc', environment: 'development' }])
  assert.equal((await post(JSON.stringify({ token: 'bad' }))).status, 400)
  assert.equal((await post('{')).status, 400)
  assert.equal((await post('null')).status, 400)
  assert.equal((await post(JSON.stringify({ token: 'x'.repeat(2000) }))).status, 413)
  assert.equal((await post(JSON.stringify({ token: 'disk' }))).status, 500)
  const get = await fetch(url(DEVICES_PATH))
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
})

test('without notifications there is nothing to register with', async (t) => {
  const { server, url } = await serve(() => null)
  t.after(() => server.close())
  assert.equal((await fetch(url(DEVICES_PATH), { method: 'POST', body: '{}' })).status, 404)
})
