import fs from 'node:fs'
import path from 'node:path'

// 上游注释守恒（相对快照 S 的多重集版本）
// 原 check-upstream-comments.mjs 以 git HEAD 为基线；本仓库 HEAD 已包含中文注释，
// 代词改写会把旧中文注释行从多重集里「拿走」，导致假 MISSING。
// 因此改为以快照 S 为基线：S 只有上游英文注释，多重集比对恰好只守护上游注释。
const [repo, baseDir, listFile] = process.argv.slice(2)
const norm = (s) => s.replace(/\s+/g, ' ').trim()

function extract(text) {
  const out = []
  let inBlock = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (inBlock) {
      const body = t.replace(/^\*+/, '')
      const closed = body.includes('*/')
      const piece = norm(body.replace(/\*\/.*$/, ''))
      if (piece) out.push({ line: i + 1, text: piece })
      if (closed) inBlock = false
      continue
    }
    if (t.startsWith('/*')) {
      const body = t.replace(/^\/\*+/, '')
      const closed = body.includes('*/')
      const piece = norm(body.replace(/\*\/.*$/, '').replace(/^\*+/, ''))
      if (piece) out.push({ line: i + 1, text: piece })
      if (!closed) inBlock = true
      continue
    }
    if (t.startsWith('//')) {
      const piece = norm(t.replace(/^\/\/+/, ''))
      if (piece) out.push({ line: i + 1, text: piece })
    }
  }
  return out
}

const files = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
let upstream = 0
let missingTotal = 0
for (const rel of files) {
  const basePath = path.join(baseDir, rel)
  const curPath = path.join(repo, rel)
  if (!fs.existsSync(basePath)) { console.log(`NO-BASELINE\t${rel}`); missingTotal++; continue }
  const baseCmt = extract(fs.readFileSync(basePath, 'utf8'))
  const curCmt = extract(fs.readFileSync(curPath, 'utf8'))
  const cur = new Map()
  for (const c of curCmt) cur.set(c.text, (cur.get(c.text) ?? 0) + 1)
  const need = new Map()
  for (const c of baseCmt) need.set(c.text, (need.get(c.text) ?? 0) + 1)
  upstream += baseCmt.length
  for (const [text, n] of need) {
    const have = cur.get(text) ?? 0
    if (have < n) {
      const line = baseCmt.find((c) => c.text === text)?.line ?? 0
      console.log(`MISSING\t${rel}:${line}\tneed=${n}\tfound=${have}\t${text.slice(0, 140)}`)
      missingTotal++
    }
  }
}
console.log(`SUMMARY files=${files.length} upstreamComments=${upstream} missing=${missingTotal}`)
process.exit(missingTotal ? 1 : 0)
