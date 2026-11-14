// 质量抽查：找"连续 >=3 行、每行 <25 字符、不含任何英文标识符"的新增注释堆叠
// 用法: node dz-quality.mjs
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';

// LCS diff：返回 [{type:'same'|'add'|'del', text}]
function diffLines(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return null; // 太大跳过
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i++] }); }
  while (j < m) { out.push({ type: 'add', text: b[j++] }); }
  return out;
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{1,}/;
const MAX_LEN = parseInt(process.argv[2] || '25', 10);
const VAGUE = /该对象|这个结构|该结构|上层|调用方|此对象|该实例|这个实例/;

function isShortNoIdent(line) {
  const t = line.trim().replace(/^\/\/+/, '').trim();
  return t.length > 0 && t.length <= MAX_LEN && !IDENT.test(t);
}

// 收集所有批次里出现过的文件（同文件取最早批次的 orig）
const batches = fs.readdirSync(BASE, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^B\d+$/.test(e.name))
  .map((e) => e.name)
  .sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1)));

const seen = new Map();
for (const b of batches) {
  const listFile = path.join(BASE, b, '_files.txt');
  if (!fs.existsSync(listFile)) continue;
  const rels = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const rel of rels) {
    const orig = path.join(BASE, b, 'orig', rel);
    if (!fs.existsSync(orig) || seen.has(rel)) continue;
    seen.set(rel, { batch: b, orig });
  }
}

const hits = [];
const vague = [];
for (const [rel, { batch, orig }] of seen) {
  const cur = path.join(REPO, rel);
  if (!fs.existsSync(cur)) continue;
  const A = fs.readFileSync(orig, 'utf8').split(/\r?\n/);
  const B = fs.readFileSync(cur, 'utf8').split(/\r?\n/);
  const d = diffLines(A, B);
  if (!d) continue;
  // 找连续新增行段
  let run = [];
  const flush = () => {
    if (run.length >= 3 && run.every((r) => isShortNoIdent(r.text))) {
      hits.push({ rel, batch, lines: run.map((r) => r.text.trim()) });
    }
    run = [];
  };
  for (const item of d) {
    if (item.type === 'add') run.push(item);
    else if (item.type === 'same') flush();
    // del 不打断（删除不应出现在我们的批次里）
  }
  flush();
  // 无指代词单独统计
  for (const item of d) {
    if (item.type !== 'add') continue;
    const t = item.text.trim().replace(/^\/\/+/, '').trim();
    if (VAGUE.test(t)) vague.push({ rel, batch, text: t });
  }
}

hits.sort((a, b) => b.lines.length - a.lines.length || a.rel.localeCompare(b.rel));
const totalRuns = hits.length;
const totalLines = hits.reduce((s, h) => s + h.lines.length, 0);
const files = new Set(hits.map((h) => h.rel));

console.log(`扫描文件 ${seen.size} 个（批次 ${batches.length} 个，单行阈值<=${MAX_LEN}字符）`);
console.log(`短句堆叠命中: ${files.size} 文件 / ${totalRuns} 段 / ${totalLines} 行`);
console.log(`无指代词命中: ${new Set(vague.map((v) => v.rel)).size} 文件 / ${vague.length} 条`);
console.log('---');
for (const h of hits.slice(0, 15)) {
  console.log(`[${h.batch}] ${h.rel}  (${h.lines.length} 行)`);
  for (const l of h.lines) console.log('    ' + l);
  console.log('');
}
if (vague.length) {
  const byFile = new Map();
  for (const v of vague) byFile.set(v.rel, (byFile.get(v.rel) || 0) + 1);
  const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('--- 无指代词 文件排名 (前 12) ---');
  for (const [rel, n] of top) console.log(`${n}\t${rel}`);
  const byWord = new Map();
  for (const v of vague) {
    for (const w of ['调用方', '上层', '该对象', '这个结构', '该结构', '此对象', '该实例', '这个实例']) {
      if (v.text.includes(w)) byWord.set(w, (byWord.get(w) || 0) + 1);
    }
  }
  console.log('--- 按词命中 ---');
  for (const [w, n] of [...byWord.entries()].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${w}`);
  console.log(`--- 全量文件清单（共 ${byFile.size} 个，写入 quality-vague.txt）---`);
  const all = [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([rel, n]) => `${n}\t${rel}`).join('\n');
  fs.writeFileSync(path.join(BASE, 'quality-vague.txt'), all + '\n');
  console.log('--- 无指代词样例 (最多 15) ---');
  for (const v of vague.slice(0, 15)) console.log(`[${v.batch}] ${v.rel}\n    ${v.text}`);
}
