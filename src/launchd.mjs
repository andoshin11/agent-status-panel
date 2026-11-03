// Writes the launchd job that keeps the daemon running on the Mac mini.
export const LABEL = 'dev.andoshin11.agent-status-panel'

function escape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildPlist({ node, script, log }) {
  const argument = (value) => `    <string>${escape(value)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, script, 'run'].map(argument).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${escape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(log)}</string>
</dict>
</plist>
`
}
