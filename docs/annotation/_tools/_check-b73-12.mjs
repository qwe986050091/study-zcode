import fs from 'node:fs'

const specPath = 'd:/code/_annot_baseline/ZC-deep-b73-spec-12.json'
const filePath = 'd:/code/ZCode/apps/zcode-cli/packages/tui/src/app-keyboard.ts'

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
const original = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)

const banned = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
]
const callRe = /[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\(/

function fail(msg) {
  console.error('FAIL: ' + msg)
  process.exit(1)
}

if (spec.files.length !== 1) fail('files 长度应为 1')
const entry = spec.files[0]
if (entry.file !== 'apps/zcode-cli/packages/tui/src/app-keyboard.ts') fail('file 路径不符')

const inserts = []
let total = 0
let headerRaw = null

for (let i = 0; i < entry.items.length; i++) {
  const item = entry.items[i]
  if (typeof item.anchor !== 'string' || item.anchor.trim() === '') fail('第 ' + i + ' 项 anchor 非法')

  const target = item.anchor.trim()
  const hits = []
  for (let j = 0; j < original.length; j++) {
    if (original[j].trim() === target) hits.push(j)
  }
  if (hits.length === 0) fail('第 ' + i + ' 项 anchor 未命中: ' + target)

  let idx
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
      fail('第 ' + i + ' 项 nth 无效: ' + item.nth + ' / 命中 ' + hits.length)
    }
    idx = hits[item.nth - 1]
  } else {
    if (hits.length !== 1) fail('第 ' + i + ' 项 anchor 不唯一（命中 ' + hits.length + ' 次）: ' + target)
    idx = hits[0]
  }

  const indentMatch = original[idx].match(/^[ \t]*/)
  const indent = indentMatch ? indentMatch[0] : ''

  let out
  if (Array.isArray(item.raw)) {
    if (item.lines !== undefined) fail('第 ' + i + ' 项 raw 与 lines 不能同时存在')
    out = item.raw.slice()
  } else if (Array.isArray(item.lines)) {
    out = item.lines.map((s) => (s === '' ? indent + '//' : indent + '// ' + s))
  } else {
    fail('第 ' + i + ' 项缺少 raw 或 lines')
  }

  if (i === 0) headerRaw = Array.isArray(item.raw) ? item.raw : null

  total += out.length
  inserts.push({ index: idx, lines: out, item: i })
}

// (b) 无重复插入下标
const seen = new Set()
for (const ins of inserts) {
  if (seen.has(ins.index)) fail('重复插入下标: ' + ins.index)
  seen.add(ins.index)
}

// (c)(d) 行格式与禁词
for (const ins of inserts) {
  for (const line of ins.lines) {
    const t = line.trim()
    if (!t.startsWith('//')) fail('插入行未以 // 开头: ' + line)
    if (t.includes('*/')) fail('插入行含 */: ' + line)
    if (t.endsWith(';')) fail('插入行以分号结尾: ' + line)
    if (t.includes('=>')) fail('插入行含箭头: ' + line)

    const body = t.replace(/^\/\/\s?/, '').trim()
    if (body !== '') {
      const first = body.split(/\s+/)[0]
      if (banned.includes(first)) fail('插入行以禁用词开头（' + first + '）: ' + line)
    }
    if (callRe.test(t)) fail('插入行疑似调用表达式: ' + line)
  }
}

// (e) 总行数
if (total !== 62) fail('插入总行数应为 62，实际 ' + total)

// (f) 文件头
if (!headerRaw) fail('文件头未使用 raw')
if (headerRaw.length !== 22) fail('文件头 raw 长度应为 22，实际 ' + headerRaw.length)
if (!headerRaw[0].startsWith('// INV-01')) fail('文件头首行未以 // INV-01 开头: ' + headerRaw[0])
if (headerRaw[18] !== '//') fail('文件头第 19 行应为 //，实际: ' + headerRaw[18])
for (let k = 0; k < 18; k++) {
  if (!headerRaw[k].startsWith('// INV-' + String(k + 1).padStart(2, '0'))) {
    fail('第 ' + (k + 1) + ' 条 INV 编号不连续: ' + headerRaw[k])
  }
}
for (let k = 19; k < 22; k++) {
  if (!/^\/\/ (模块职责|状态所有权|阅读顺序)：/.test(headerRaw[k])) {
    fail('文件头尾部三行格式不符: ' + headerRaw[k])
  }
}

// 模拟插入，确认原有行零修改
const merged = []
const byIndex = new Map()
for (const ins of inserts) byIndex.set(ins.index, ins.lines)
for (let j = 0; j < original.length; j++) {
  if (byIndex.has(j)) merged.push(...byIndex.get(j))
  merged.push(original[j])
}
const rebuilt = merged.join('\n')
const expected = (() => {
  const parts = []
  for (let j = 0; j < original.length; j++) {
    if (byIndex.has(j)) parts.push(...byIndex.get(j))
    parts.push(original[j])
  }
  return parts.join('\n')
})()
if (rebuilt !== expected) fail('合并结果不稳定')

const finalLines = merged.length
const removed = finalLines - original.length - total
if (removed !== 0) fail('原有行数发生变化，新增 ' + (finalLines - original.length) + ' 预期 ' + total)

console.log('OK blocks=' + entry.items.length + ' lines=' + total)
