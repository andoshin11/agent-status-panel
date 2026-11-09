import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSuggestionReader, suggestionFrom, terminalHistoryRoot } from '../src/prompt-suggestions.mjs'

const latin1 = (text) => Buffer.from(text, 'utf8').toString('latin1')
// As Claude Code 2.1 paints it, taken from a real terminal log.
const painted = (text, row = 69) => `\x1b[?2026h\x1b[?25l\x1b[H\r\x1b[2C\x1b[${row}B\x1b[2m${latin1(text)}\x1b[22m\x1b[73;1H\x1b[${row + 1};3H\x1b[?25h\x1b[?2026l`

test('reads the suggestion on screen', () => {
  assert.equal(suggestionFrom(painted('ステップ3に着手してください')), 'ステップ3に着手してください')
})

test('takes the newest one', () => {
  assert.equal(suggestionFrom(painted('古い') + painted('新しい')), '新しい')
})

test('a letter typed on that row means it is gone', () => {
  assert.equal(suggestionFrom(`${painted('候補')}\x1b[H\r\x1b[4C\x1b[69B\x1b[K`), null)
  assert.equal(suggestionFrom(`${painted('候補')}\x1b[H\r\x1b[2C\x1b[69Babc`), null)
})

test('output elsewhere on screen leaves it in place', () => {
  assert.equal(suggestionFrom(`${painted('候補')}\x1b[H\r\x1b[2C\x1b[71Bstatus`), '候補')
})

test('other dim text is not a suggestion', () => {
  assert.equal(suggestionFrom('\x1b[H\r\x1b[2C\x1b[1B\x1b[2mnext\x1b[22m\x1b[73;1H\x1b[5;3H'), null)
  assert.equal(suggestionFrom('\x1b[2mCooked for 2s\x1b[22m'), null)
  assert.equal(suggestionFrom(''), null)
})

const PTY = 'repo::/w/app@@3cb058c9'

test('finds each pane through its terminal, on screen or not', async () => {
  const paths = []
  const read = createSuggestionReader({
    home: '/home',
    terminals: async () => [
      { tabId: 'tab', leafId: 'a', ptyId: PTY },
      { tabId: 'pty:x', leafId: 'pty:x', recordedPaneKey: 'tab:b', ptyId: 'other@@1' }
    ],
    read: async (path) => (paths.push(path), painted(path.includes('other') ? '二' : '一'))
  })
  const shown = await read(['tab:a', 'tab:b', 'tab:none'])
  assert.deepEqual([...shown], [['tab:a', '一'], ['tab:b', '二']])
  assert.equal(paths[0], join(terminalHistoryRoot('/home'), 'repo%3A%3A%2Fw%2Fapp%40%403cb058c9', 'output.log'))
})

test('a terminal with no log has no suggestion', async () => {
  const read = createSuggestionReader({
    home: '/home',
    terminals: async () => [{ tabId: 'tab', leafId: 'a', ptyId: PTY }],
    read: async () => { throw new Error('missing') }
  })
  assert.equal((await read(['tab:a'])).size, 0)
})
