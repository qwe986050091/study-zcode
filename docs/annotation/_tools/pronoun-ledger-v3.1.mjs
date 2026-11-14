// 禁用代词唯一权威账本 v3.1（2026-11-10）
// 定义：S 注释多重集差集——先扣掉基线 S 中已存在的同名注释行，再对剩余中文整行注释匹配禁用词。
// 词表：它|其|该|此|这里|上述|相关|因此|应该|据此（10 字）
// 统计范围：只算整行注释（// * /*），且行内必须含中文；代码行、字符串、英文注释不计。
// 输出：ALL=… KEY=… OTHER=… FILES=… + TOP20 文件 + TOP20 目录；报告只报 ALL/KEY/OTHER 这一行。
// 复跑：node _annot_baseline/pronoun-ledger-v3.1.mjs；跨轮只与同一脚本的相邻两次运行比较。
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'd:/code/claude-code-main'
const BASE = 'd:/code/_backup_claude-code-main_20261102'
const RE = /(它|其|该|此|这里|上述|相关|因此|应该|据此)/
const CJK = /[\u4e00-\u9fff]/
const KEY = new Set([
  'QueryEngine.ts',
  'utils/permissions/permissions.ts',
  'utils/permissions/permissionSetup.ts',
  'utils/sandbox/sandbox-adapter.ts',
  'utils/Shell.ts',
  'utils/ShellCommand.ts',
  'utils/sessionRestore.ts',
  'utils/sessionStoragePortable.ts',
  'services/compact/autoCompact.ts',
  'services/compact/microCompact.ts',
  'utils/hooks/sessionHooks.ts',
  'utils/hooks/hooksConfigManager.ts',
  'hooks/useExitOnCtrlCD.ts',
  'services/mcp/MCPConnectionManager.tsx',
  'services/mcp/useManageMCPConnections.ts',
])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'docs') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}
const isComment = (t) => t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
const files = []
let keyTotal = 0
for (const f of walk(REPO)) {
  const rel = path.relative(REPO, f).replace(/\\/g, '/')
  const cur = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  const bp = path.join(BASE, rel)
  const bl = fs.existsSync(bp) ? fs.readFileSync(bp, 'utf8').split(/\r?\n/) : []
  const pool = new Map()
  for (const l of bl) {
    const t = l.trim()
    if (isComment(t)) pool.set(t, (pool.get(t) ?? 0) + 1)
  }
  let bad = 0
  for (const l of cur) {
    const t = l.trim()
    if (!isComment(t) || !CJK.test(t)) continue
    const n = pool.get(t) ?? 0
    if (n > 0) { pool.set(t, n - 1); continue }
    if (RE.test(t)) bad++
  }
  if (bad) files.push([rel, bad])
  if (bad && KEY.has(rel)) keyTotal += bad
}
const all = files.reduce((s, x) => s + x[1], 0)
const dirs = new Map()
for (const [f, n] of files) {
  const d = path.dirname(f)
  dirs.set(d, (dirs.get(d) ?? 0) + n)
}
const top = (arr, k) => arr.sort((a, b) => b[1] - a[1]).slice(0, k)
console.log(`ALL=${all} KEY=${keyTotal} OTHER=${all - keyTotal} FILES=${files.length}`)
console.log('--- TOP20 FILES')
for (const [f, n] of top([...files], 20)) console.log(`${n}\t${f}`)
console.log('--- TOP20 DIRS')
for (const [d, n] of top([...dirs], 20)) console.log(`${n}\t${d}`)
