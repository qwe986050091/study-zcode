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
const fams = [
  ['A 保存X', /^保存\s*[A-Za-z_][\w.]*。$/],
  ['B 返回X', /^返回\s*[A-Za-z_][\w.]*( 对象)?。$/],
  ['C X置空', /^[A-Za-z_][\w.]*\s*置(空|undefined)。$/],
  ['D 同步读快照', /^同步读一次快照。$/],
  ['E 一次性写回', /^一次性写回。$/],
  ['F 快照为底', /^以现有快照为底(写入)?。$/],
  ['G 直接返回', /^直接返回[^，]{0,14}。$/],
  ['H 日志空话', /^日志(只记录动作|说明缺失|说明原因)。$/],
  ['I 取槽位', /^取[^，]{0,12}槽位。$/],
  ['J 等待结果', /^等待 .{0,20} 的结果。$/],
  ['K 事件名', /^(成功|失败)事件名。$/],
  ['L 记录X', /^记录\s*[^，]{0,12}。$/],
  ['M X原样回传', /^[A-Za-z_][\w.]*\s*原样(回传|保存|返回)。$/],
  ['N X一并写入', /^[A-Za-z_][\w.]*\s*一并写入。$/],
  ['O 返回undefined', /^返回 undefined[^，]{0,10}。$/],
]
const out = new Map(fams.map(f => [f[0], []]))
for (const [n, t] of added) {
  for (const [name, re] of fams) { if (re.test(t)) { out.get(name).push(n + '\t' + t); break } }
}
let sum = 0
for (const [k, v] of out) { sum += v.length; console.log('### ' + k + ' = ' + v.length); if (v.length) console.log(v.join('\n')) }
console.log('TOTAL', added.length, 'HIT', sum, 'RATIO', (sum / added.length * 100).toFixed(1) + '%')
