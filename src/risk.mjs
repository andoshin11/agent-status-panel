// What a tool call waiting for permission would do, in one word, and where a shell command runs,
// so that the card can be decided on without opening the terminal. A heuristic read of the command:
// a call is "read only" when every part of it is known to only read, "outside" when a part reaches
// past this machine, and "write" otherwise, so an unknown command is never called harmless.
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative } from 'node:path'

export const RISK_LABELS = { read: '読むだけ', write: '書き換える', outside: '外に出る' }
const DANGER_LABEL = '危険'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TaskList', 'TaskGet', 'TaskOutput'])
const OUTSIDE_TOOLS = new Set(['WebFetch', 'WebSearch'])
// The name of an MCP tool says whether it only reads, as `slack_read_channel` does.
const MCP_READ = /(^|_)(read|get|list|search|fetch|query|view|whoami|describe)(_|$)/i

const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'egrep', 'fgrep', 'wc', 'pwd', 'echo', 'printf', 'which', 'type', 'file', 'stat',
  'du', 'df', 'tree', 'jq', 'sort', 'uniq', 'cut', 'tr', 'diff', 'date', 'true', 'false', 'sleep', 'ps', 'lsof', 'basename',
  'dirname', 'realpath', 'readlink', 'test', '[', 'less', 'column', 'awk', 'nl', 'cmp', 'md5', 'shasum', 'whoami', 'id',
  'uname', 'hostname', 'sw_vers', 'pgrep', 'command', 'cd'
])
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'grep', 'fetch', 'shortlog', 'cat-file', 'merge-base', 'reflog', 'rev-list', 'name-rev', 'for-each-ref', 'show-ref', 'check-ignore'])
const GH_READ = /^gh\s+(pr\s+(view|list|checks|diff|status)|issue\s+(view|list|status)|run\s+(view|list|watch)|repo\s+view|release\s+(view|list)|auth\s+status|search\s|workflow\s+(view|list)|browse\s+--no-browser|label\s+list)\b/
const KUBECTL_READ = /^kubectl\b.*\s(get|describe|logs|top|explain|version|api-resources|cluster-info|auth\s+can-i|config\s+(get-contexts|current-context|view))\b/
const AWS_READ = /^aws\s+\S+\s+(describe-|list-|get-|ls\b)|^aws\s+sts\s+get-caller-identity\b/
const VERSION_ONLY = /^\S+\s+(--version|-v|-V|--help|-h|version|help)\s*$/

const GH_API_WRITE = /^gh\s+api\b.*(\s(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)\b)/i
const SENDS_DATA = /^(curl|wget|http|https)\b.*(\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data\S*|-F|--form|-T|--upload-file|--json)\b)/i
const OUTSIDE = [
  /^git\s+push\b/,
  /^gh\s+(pr\s+(create|merge|close|edit|comment|review|ready|reopen)|issue\s+(create|close|edit|comment|reopen|delete)|release\s+(create|delete|edit|upload)|repo\s+(create|delete|edit|fork|archive)|workflow\s+(run|enable|disable)|run\s+(rerun|cancel|delete)|secret|variable|label\s+(create|edit|delete))\b/,
  GH_API_WRITE,
  SENDS_DATA,
  /^(ssh|scp|sftp|rsync|ftp|telnet|nc)\b/,
  /^kubectl\b/,
  /^aws\b/,
  /^(terraform|tofu)\s+(apply|destroy|import|state|taint|untaint)\b/,
  /^(npm|pnpm|yarn)\s+publish\b/,
  /^docker\s+(push|login)\b/,
  /^helm\s+(install|upgrade|uninstall|rollback)\b/,
  /^(psql|mysql|redis-cli|mongosh|mongo)\b/,
  /^tailscale\s+(funnel|serve|up|down|set)\b/,
  /^osascript\b/
]

/** The parts of a shell command, split where another command starts. Quoting is ignored, so a quoted `&&` splits too: it can only make a part look less harmless. */
function partsOf(command) {
  return command
    .split(/&&|\|\||[;|\n]|\$\(|`|\(|\)/)
    .map((part) => part.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^(?:time|nohup|exec|command)\s+/, ''))
    .filter(Boolean)
}

/** A redirect into a file writes it. Into /dev/null or another descriptor it does not. */
const WRITES_FILE = />>?\s*(?!&|\/dev\/null\b)[^\s>&]/

function partReads(part) {
  if (WRITES_FILE.test(part.replace(/\d?>&\d/g, ''))) return false
  const [word, sub] = part.split(/\s+/)
  if (VERSION_ONLY.test(part)) return true
  if (word === 'sed') return !/\s-i\b|\s--in-place\b/.test(part)
  if (word === 'find') return !/\s-(delete|exec|execdir|ok|okdir|fprint\S*)\b/.test(part)
  if (word === 'git') {
    if (sub === 'branch') return !/\s-(d|D|m|M|c|C|f)\b|--(delete|move|copy|force|set-upstream-to|unset-upstream)\b/.test(part) && /^git\s+branch(\s+(-a|-r|-v|-vv|--list|--show-current|--contains\s+\S+|--merged|--no-merged))*\s*$/.test(part)
    if (sub === 'remote') return /^git\s+remote(\s+(-v|show\s+\S+|get-url\s+\S+))?\s*$/.test(part)
    if (sub === 'stash') return /^git\s+stash\s+(list|show)\b/.test(part)
    if (sub === 'worktree') return /^git\s+worktree\s+list\b/.test(part)
    if (sub === 'config') return /\s--(get|get-all|list|l)\b|\s-l\b/.test(part)
    return GIT_READ.has(sub)
  }
  if (word === 'gh') return GH_READ.test(part) || (/^gh\s+api\b/.test(part) && !GH_API_WRITE.test(part))
  if (word === 'kubectl') return KUBECTL_READ.test(part)
  if (word === 'aws') return AWS_READ.test(part)
  if (word === 'curl' || word === 'wget') return !SENDS_DATA.test(part) && !/\s(-o|-O|--output|--remote-name)\b/.test(part)
  return READ_COMMANDS.has(word)
}

function commandRisk(command) {
  const parts = partsOf(command)
  if (parts.some((part) => OUTSIDE.some((pattern) => pattern.test(part)) && !partReads(part))) return 'outside'
  return parts.length > 0 && parts.every(partReads) ? 'read' : 'write'
}

/** 'read', 'write' or 'outside'. */
export function riskOf({ name, input = {} }) {
  if (typeof input.command === 'string' && (name === 'Bash' || name === 'exec_command')) return commandRisk(input.command)
  if (READ_TOOLS.has(name)) return 'read'
  if (OUTSIDE_TOOLS.has(name)) return 'outside'
  if (name?.startsWith('mcp__')) return MCP_READ.test(name.split('__').at(-1)) ? 'read' : 'outside'
  return 'write'
}

/** The word a card shows for a call. */
export function riskLabel(risk, dangerous = false) {
  return dangerous ? DANGER_LABEL : RISK_LABELS[risk] ?? RISK_LABELS.write
}

function unquote(text) {
  return text.replace(/^(['"])(.*)\1$/, '$2')
}

function shown(dir, workspace, home) {
  const inside = relative(workspace, dir)
  if (inside === '') return ''
  if (!inside.startsWith('..') && !isAbsolute(inside)) return inside
  return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
}

/**
 * Where a shell command runs, as the card says it: '' in the workspace itself, a path inside it, or
 * a path elsewhere. A command that starts with `cd <dir> &&` runs there.
 * @param cwd  the folder Claude Code's shell was in, from the transcript, when known
 */
export function whereOf(call, workspace, { cwd = call.cwd, home = homedir() } = {}) {
  const command = call.input?.command
  if (typeof command !== 'string' || !workspace) return ''
  let dir = typeof cwd === 'string' && cwd ? cwd : workspace
  const leading = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)/.exec(command)
  if (leading) {
    const target = unquote(leading[1]).replace(/^~(?=\/|$)/, home)
    dir = isAbsolute(target) ? normalize(target) : join(dir, target)
  }
  return shown(dir, workspace, home)
}
