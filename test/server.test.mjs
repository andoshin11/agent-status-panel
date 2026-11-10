import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEVICES_PATH, NEXT_PATH, startStatusServer, STATUS_PATH } from '../src/server.mjs'

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

const LOGIN = 'me@example.com'

async function serveNext(next, allowedLogin = LOGIN) {
  const server = await startStatusServer({ port: 0, snapshot: () => null, next, allowedLogin })
  const { address, port } = server.address()
  const press = (body, login = LOGIN) =>
    fetch(`http://${address}:${port}${NEXT_PATH}`, { method: 'POST', body, headers: login ? { 'tailscale-user-login': login } : {} })
  return { server, press, url: `http://${address}:${port}${NEXT_PATH}` }
}

test('a button press reaches the agent and says whether it was still on offer', async (t) => {
  const pressed = []
  const { server, press } = await serveNext(async (button) => (pressed.push(button), button.offer === 'live'))
  t.after(() => server.close())
  assert.equal((await press(JSON.stringify({ offer: 'live', index: 1, extra: 'ignored' }))).status, 204)
  assert.deepEqual(pressed, [{ offer: 'live', index: 1, confirmed: false }])
  assert.equal((await press(JSON.stringify({ offer: 'old', index: 0 }))).status, 409)
})

test('a press says when a draft is in the way', async (t) => {
  const { server, press } = await serveNext(async () => 'typing')
  t.after(() => server.close())
  assert.equal((await press(JSON.stringify({ offer: 'a', index: 0 }))).status, 423)
  const restart = await serveNext(async () => 'draft')
  t.after(() => restart.server.close())
  assert.equal((await restart.press(JSON.stringify({ offer: 'a', index: 0 }))).status, 423, 'also before a restart')
})

test('a press can carry the answers of a form', async (t) => {
  const pressed = []
  const { server, press } = await serveNext(async (button) => (pressed.push(button), true))
  t.after(() => server.close())
  assert.equal((await press(JSON.stringify({ offer: 'a', answers: [[0, 1], [2]] }))).status, 204)
  assert.deepEqual(pressed, [{ offer: 'a', answers: [[0, 1], [2]] }])
  for (const answers of ['x', [0], [['a']], [[0.5]]]) {
    assert.equal((await press(JSON.stringify({ offer: 'a', answers }))).status, 400, JSON.stringify(answers))
  }
})

test('a press passes on a confirmation, and says when one is needed', async (t) => {
  const pressed = []
  const { server, press } = await serveNext(async (button) => (pressed.push(button), button.confirmed ? true : 'confirm'))
  t.after(() => server.close())
  assert.equal((await press(JSON.stringify({ offer: 'a', index: 0 }))).status, 428)
  assert.equal((await press(JSON.stringify({ offer: 'a', index: 0, confirmed: true }))).status, 204)
  assert.equal((await press(JSON.stringify({ offer: 'a', index: 0, confirmed: 'yes' }))).status, 428)
  assert.deepEqual(pressed.map((button) => button.confirmed), [false, true, false])
})

test('only the allowed login can press a button', async (t) => {
  let calls = 0
  const { server, press } = await serveNext(async () => ++calls > 0)
  t.after(() => server.close())
  const body = JSON.stringify({ offer: 'a', index: 0 })
  assert.equal((await press(body, null)).status, 403)
  assert.equal((await press(body, 'other@example.com')).status, 403)
  assert.equal(calls, 0)
})

test('a press refuses a bad body, another method, and a failed send', async (t) => {
  const { server, press, url } = await serveNext(async ({ offer }) => {
    if (offer === 'broken') throw new Error('orca is down')
    return true
  })
  t.after(() => server.close())
  for (const body of ['{', 'null', '{"offer":1,"index":0}', '{"offer":"a"}', '{"offer":"a","index":0.5}']) {
    assert.equal((await press(body)).status, 400, body)
  }
  assert.equal((await press(JSON.stringify({ offer: 'x'.repeat(2000), index: 0 }))).status, 413)
  assert.equal((await press(JSON.stringify({ offer: 'broken', index: 0 }))).status, 502)
  const get = await fetch(url)
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
})

test('without an allowed login there are no buttons', async (t) => {
  const { server, press } = await serveNext(async () => true, null)
  t.after(() => server.close())
  assert.equal((await press(JSON.stringify({ offer: 'a', index: 0 }))).status, 404)
})
