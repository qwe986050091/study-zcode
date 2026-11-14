import { readFileSync, writeFileSync } from 'node:fs'

const file = 'd:/code/claude-code-main/entrypoints/sdk/controlSchemas.ts'
const lines = readFileSync(file, 'utf8').split('\n')

const map = {
  361: 'path：内存文件路径。',
  369: 'name：MCP 工具名。',
  379: 'name：内建工具名。',
  396: 'agentType：子代理类型名。',
  404: 'totalCommands：可用斜杠命令总数。',
  412: 'totalSkills：可用技能总数。',
  417: 'name：技能名。',
  431: 'toolCallTokens：工具调用请求占用。',
  438: 'name：工具名。',
  451: 'input_tokens：输入 token 数（API 原始口径）。',
}

const targets = Object.keys(map).map(Number).sort((a, b) => b - a)
for (const n of targets) {
  const idx = n - 1
  const indent = lines[idx].match(/^\s*/)[0]
  lines.splice(idx, 0, `${indent}// ${map[n]}`)
}
writeFileSync(file, lines.join('\n'), 'utf8')
console.log('inserted', targets.length)
