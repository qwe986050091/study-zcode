// 辅助核对脚本（不是权威账本，不对外报数）。
// 权威账本：_annot_baseline/pronoun-ledger-v3.1.mjs（v3.1，S 注释多重集差集，10 字）。
// 两者差异：
//   1) 范围：本脚本匹配 git diff 的所有新增行（含代码与字符串）；账本只算含中文的整行注释。
//   2) 词表：本脚本 7 字（它|其|该|此|这里|上述|相关）；账本多 因此|应该|据此。
//   3) 方法：本脚本逐行正则匹配；账本先扣掉 S 中已存在的同名注释再判。
// 用途：单文件插入后快速确认「本轮新增行有没有引入禁用代词」，差集解释以账本为准。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const base = process.argv[3] || 'd:/code/_backup_claude-code-main_20261102'
const repo = 'd:/code/claude-code-main'
const list = process.argv[2]
for (const rel of fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean)) {
  let diff = ''
  try {
    diff = execFileSync('git', ['diff', '--no-index', '--unified=0', base + '/' + rel, repo + '/' + rel], { encoding: 'utf8' })
  } catch (e) { diff = e.stdout || '' }
  const added = diff.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++'))
  const bad = added.filter(l => /(它|其|该|此|这里|上述|相关)/.test(l))
  console.log(rel + ' added=' + added.length + ' bad=' + bad.length)
  for (const b of bad) console.log('  ' + b)
}
