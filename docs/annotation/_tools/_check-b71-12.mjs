import fs from 'node:fs'

const specPath = 'd:/code/_annot_baseline/ZC-deep-b71-spec-12.json'
const repoRoot = 'd:/code/ZCode/'
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))

const FORBIDDEN = new Set([
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
])
const CALL_RE = /[A-Za-z0-9_$]\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/

let totalInserts = 0
let blocks = 0
const errors = []

for (const entry of spec.files) {
  const abs = repoRoot + entry.file
  const src = fs.readFileSync(abs, 'utf8')
  const lines = src.split(/\r?\n/)
  const insertMap = new Map() // index -> array of inserted lines

  entry.items.forEach((item, itemIdx) => {
    blocks++
    const anchorTrim = item.anchor.trim()
    const hits = []
    lines.forEach((line, i) => {
      if (line.trim() === anchorTrim) hits.push(i)
    })
    let idx
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        errors.push(`item#${itemIdx} nth=${item.nth} 越界，命中 ${hits.length} 处：${anchorTrim}`)
        return
      }
      idx = hits[item.nth - 1]
    } else {
      if (hits.length !== 1) {
        errors.push(`item#${itemIdx} anchor 命中 ${hits.length} 处（需唯一）：${anchorTrim}`)
        return
      }
      idx = hits[0]
    }

    const indent = (lines[idx].match(/^\s*/) || [''])[0]
    let out = []
    if (Array.isArray(item.raw)) {
      out = item.raw.slice()
    } else if (Array.isArray(item.lines)) {
      out = item.lines.map((t) => (t === '' ? indent + '//' : indent + '// ' + t))
    } else {
      errors.push(`item#${itemIdx} 既无 raw 也无 lines`)
      return
    }
    if (out.length < 1) {
      errors.push(`item#${itemIdx} 插入行数为 0`)
      return
    }
    if (insertMap.has(idx)) {
      errors.push(`item#${itemIdx} 与其他 item 重复插入下标 ${idx}`)
      return
    }
    insertMap.set(idx, out)
    totalInserts += out.length
  })

  // (c)(d) 逐行静态检查
  for (const [idx, outLines] of insertMap) {
    outLines.forEach((rawLine, k) => {
      const t = rawLine.trim()
      const where = `insert@${idx}[${k}]`
      if (!t.startsWith('//')) errors.push(`${where} 不以 // 开头: ${t}`)
      if (t.includes('*/')) errors.push(`${where} 含 */: ${t}`)
      const text = t.slice(2).trimStart()
      const m = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
      if (m && FORBIDDEN.has(m[0])) errors.push(`${where} 注释正文以禁用词 ${m[0]} 开头: ${t}`)
      if (t.endsWith(';')) errors.push(`${where} 以分号结尾: ${t}`)
      if (t.includes('=>')) errors.push(`${where} 含箭头: ${t}`)
      if (CALL_RE.test(text)) errors.push(`${where} 含调用表达式: ${t}`)
    })
  }

  // 文件头专项
  const header = entry.items[0]
  if (!Array.isArray(header.raw)) {
    errors.push('文件头 item 必须使用 raw')
  } else {
    const raw = header.raw
    if (raw.length !== 22) errors.push(`文件头 raw 长度 ${raw.length} != 22`)
    if (!raw[0] || !raw[0].startsWith('// INV-01')) errors.push(`文件头首行不是 // INV-01: ${raw[0]}`)
    if (raw[18] !== '//') errors.push(`文件头第 19 行不是 //: ${raw[18]}`)
    for (let i = 1; i <= 18; i++) {
      const tag = '// INV-' + String(i).padStart(2, '0')
      if (!raw[i - 1] || !raw[i - 1].startsWith(tag)) errors.push(`第 ${i} 条不变量标题不符: ${raw[i - 1]}`)
    }
  }
}

if (totalInserts !== 64) errors.push(`新增行数 ${totalInserts} != 64`)

if (errors.length) {
  console.error('FAIL')
  for (const e of errors) console.error(' - ' + e)
  process.exit(1)
}
console.log(`OK blocks=${blocks} lines=${totalInserts}`)
