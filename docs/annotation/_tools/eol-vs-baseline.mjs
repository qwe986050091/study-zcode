import fs from 'node:fs'
import path from 'node:path'

// 与基线快照逐文件比较行尾风格：只要求「当前文件与 S 同为 LF 或同为 CRLF」，
// 不做「LF 一律视为污染」的判断（claude-code-main 的基线 S 本身是 LF）。
const [repoArg, baseArg, listArg] = process.argv.slice(2)
const files = fs.readFileSync(listArg, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
let bad = 0
for (const rel of files) {
  const cur = fs.readFileSync(path.join(repoArg, rel), 'utf8')
  const base = fs.readFileSync(path.join(baseArg, rel), 'utf8')
  const stat = (s) => ({ crlf: (s.match(/\r\n/g) || []).length, lf: (s.match(/(?<!\r)\n/g) || []).length })
  const a = stat(cur)
  const b = stat(base)
  const style = (x) => (x.crlf === 0 ? 'LF' : x.lf === 0 ? 'CRLF' : 'MIXED')
  const ok = style(a) === style(b)
  if (!ok) bad++
  console.log(`${ok ? 'OK' : 'EOL-MISMATCH'}\t${rel}\tbase=${style(b)} cur=${style(a)}`)
}
console.log(`SUMMARY files=${files.length} eolMismatch=${bad}`)
process.exit(bad ? 1 : 0)
