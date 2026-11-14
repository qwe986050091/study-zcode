import fs from 'node:fs'
const rel = 'services/mcp/auth.ts'
const base = fs.readFileSync('d:/code/_annot_baseline/CCC-rework/baseline/' + rel, 'utf8').split(/\r?\n/)
const cur = fs.readFileSync('d:/code/claude-code-main/' + rel, 'utf8').split(/\r?\n/)
let i = 0, j = 0
const added = []
while (j < cur.length) {
  if (i < base.length && cur[j] === base[i]) { i++; j++; continue }
  if (cur[j].trim().startsWith('//')) { added.push([j + 1, cur[j].trim().slice(3)]); j++; continue }
  i++; j++
}
const len = s => s.length
const byLen = [...added].sort((a, b) => len(b[1]) - len(a[1]))
console.log('TOTAL', added.length)
console.log('--- LONGEST 10')
for (const [n, t] of byLen.slice(0, 10)) console.log(n + '\t' + len(t) + '\t' + t)
console.log('--- SHORTEST 10')
for (const [n, t] of byLen.slice(-10)) console.log(n + '\t' + len(t) + '\t' + t)
const pats = [
  [/^保存\s*[A-Za-z_]\w*。?$/, '保存X'],
  [/^返回\s*[A-Za-z_]\w*\s*对象。?$/, '返回X对象'],
  [/^返回组装好的\s*[A-Za-z_]\w*。?$/, '返回组装好的X'],
  [/^直接返回[^，]*。$/, '直接返回X'],
  [/^一次性写回。?$/, '一次性写回'],
  [/^以现有快照为底。?$/, '以现有快照为底'],
  [/^日志只记录动作。?$/, '日志只记录动作'],
  [/^以现有快照为底写入。?$/, '以现有快照为底写入'],
  [/^[A-Za-z_]\w*\s*(参与|决定|定位|用于)/, 'X参与/决定/定位'],
]
const cnt = new Map()
const hits = new Map()
for (const [n, t] of added) {
  for (const [re, name] of pats) {
    if (re.test(t)) { cnt.set(name, (cnt.get(name) || 0) + 1); if (!hits.has(name)) hits.set(name, []); hits.get(name).push(n + ':' + t); break }
  }
}
console.log('--- TEMPLATES')
for (const [k, v] of cnt) console.log(v + '\t' + k)
console.log('sum', [...cnt.values()].reduce((a, b) => a + b, 0))
