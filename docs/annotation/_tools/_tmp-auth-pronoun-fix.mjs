import fs from 'node:fs'
const file = 'd:/code/claude-code-main/services/mcp/auth.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)
const pairs = [
  ["scope 由存储原样带出，SDK 侧不依赖这里做权限判断。", "scope 由存储原样带出，SDK 侧不做权限判断。"],
  ["existingData 提供 mcpOAuth 与其他 server 的既有记录。", "existingData 提供 mcpOAuth 与别的 server 的既有记录。"],
  ["existingData 可能已有上一次 step-up 写入的 scope，需要保留其他字段。", "existingData 可能已有上一次 step-up 写入的 scope，需要保留别的字段。"],
]
let n = 0
for (const [a, b] of pairs) {
  const i = lines.findIndex(l => l.trim() === '// ' + a)
  if (i < 0) { console.log('MISS', a); continue }
  const indent = (lines[i].match(/^\s*/) || [''])[0]
  lines[i] = indent + '// ' + b
  n++
}
fs.writeFileSync(file, lines.join(eol), 'utf8')
console.log('ok', n)
