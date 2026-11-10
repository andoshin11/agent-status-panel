import assert from 'node:assert/strict'
import { test } from 'node:test'
import { riskLabel, riskOf, whereOf } from '../src/risk.mjs'

const bash = (command) => ({ name: 'Bash', input: { command } })

test('a command that only reads is told apart', () => {
  for (const command of ['ls -la', 'git status && git diff', 'cat a | grep b', 'gh pr view 3', 'gh api repos/x/y', 'curl -s http://127.0.0.1:3000', 'kubectl get pods', 'aws ec2 describe-instances', 'sed -n 1p f', 'find . -name x', 'cd apps/web && ls', 'node --version', 'git branch', 'FOO=1 ls', 'ls 2>&1 >/dev/null']) {
    assert.equal(riskOf(bash(command)), 'read', command)
  }
})

test('a command that reaches past this machine is outside', () => {
  for (const command of ['git push origin main', 'gh pr create --title x', 'gh pr merge 3', 'gh api -X POST repos/x', 'gh api repos/x -f a=b', 'curl -d a=b http://x', 'kubectl apply -f x', 'aws s3 cp a s3://b', 'ssh host', 'psql -c "select 1"', 'ls && git push']) {
    assert.equal(riskOf(bash(command)), 'outside', command)
  }
})

test('anything else is taken to write, unknown commands too', () => {
  for (const command of ['touch a', 'echo hi > a.txt', 'sed -i s/a/b/ f', 'find . -delete', 'pnpm test', 'git branch -D x', 'git commit -m x', 'ls $(touch a)', 'my-tool']) {
    assert.equal(riskOf(bash(command)), 'write', command)
  }
})

test('other tools by their name', () => {
  assert.equal(riskOf({ name: 'Read', input: {} }), 'read')
  assert.equal(riskOf({ name: 'Edit', input: {} }), 'write')
  assert.equal(riskOf({ name: 'WebFetch', input: {} }), 'outside')
  assert.equal(riskOf({ name: 'mcp__claude_ai_Slack__slack_send_message', input: {} }), 'outside')
  assert.equal(riskOf({ name: 'mcp__claude_ai_Slack__slack_read_channel', input: {} }), 'read')
  assert.equal(riskOf({ name: 'Unknown', input: {} }), 'write')
  assert.equal(riskLabel('read'), '読むだけ')
  assert.equal(riskLabel('read', true), '危険')
})

test('where a command runs, shown from the workspace', () => {
  const where = (command, extra) => whereOf(bash(command), '/w/a', { home: '/h', ...extra })
  assert.equal(where('ls'), '')
  assert.equal(where('cd apps/web && ls'), 'apps/web')
  assert.equal(where('ls', { cwd: '/h/dev/Juiz' }), '~/dev/Juiz')
  assert.equal(where('cd ~/x; ls'), '~/x')
  assert.equal(where('cd /w/a && ls', { cwd: '/w/a/b' }), '')
  assert.equal(where('cd "/tmp/a b" && ls'), '/tmp/a b')
  assert.equal(whereOf({ name: 'Write', input: { file_path: '/x' } }, '/w/a'), '')
})
