// diffsets：解释「zc-gate 的 water 行数」与「deep-quality 的 weak 行数」两个集合的差。
//
// 两个数都被叫作「待改写的 weak 行」，但尺子不同：
//   A = zc-gate --scan <批次 _files.txt> --base <该批改写前 HEAD>
//       集合 = 该批 diff 里新增的全部注释行（无豁免），命中 W/L/POEM 的那些。
//   B = deep-quality 整文件口径（v3）
//       集合 = 1,726 个文件里全部非结构性注释行，命中 weak 的那些；再按
//       「是否本线新增」拆成 own / upstream（基线 8f7daaf0）。
// 本脚本只做集合运算与归因，不改判据。
//
// 用法: node diffsets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'D:/code/ZCode';
const HEAD_WT = 'D:/code/_annot_head';
const SNAP = 'D:/code/_annot_baseline/snapshot';
const BASE = '8f7daaf0';
const BATCHES = [];
for (let n = 207; n <= 226; n++) if (n !== 224) BATCHES.push('b' + n);

// ---- A：water 行（19 批） ----
const A = new Map(); // path -> Map(line -> {kind, content, batch})
let aTotal = 0;
for (const b of BATCHES) {
  const f = path.join(SNAP, `water-${b}.txt`);
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(POEM|B|W|L)\s+(\S+?):(\d+)\s+(\S+)\s+::\s?(.*)$/);
    if (!m) continue;
    const [, kind, p, ln, , content] = m;
    if (!A.has(p)) A.set(p, new Map());
    A.get(p).set(Number(ln), { kind, content, batch: b });
    aTotal++;
  }
}

// ---- B：deep-quality 整文件 weak / filler ----
const q = JSON.parse(fs.readFileSync(path.join(SNAP, 'q-main-head.json'), 'utf8'));
const qRows = new Map(q.rows.map((r) => [r.path.replace(/\\/g, '/'), r]));

// 本线新增行集合（HEAD 坐标）
const own = new Map();
const diff = execFileSync('git', ['-C', REPO, '--no-pager', 'diff', '-U0', '--no-color', '--no-ext-diff', BASE, 'HEAD'], {
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});
let cur = null;
for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith('diff --git ')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    cur = m ? m[2] : null;
    if (cur && !own.has(cur)) own.set(cur, new Set());
    continue;
  }
  if (!cur) continue;
  const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!h) continue;
  const start = Number(h[1]);
  const count = h[2] === undefined ? 1 : Number(h[2]);
  for (let i = 0; i < count; i++) own.get(cur).add(start + i);
}

const isOwn = (p, line) => own.get(p)?.has(line) ?? false;

let bOwnAll = 0;
let bUpAll = 0;
let fOwnAll = 0;
let fUpAll = 0;
const bOwnByPath = new Map();
for (const r of q.rows) {
  const p = r.path.replace(/\\/g, '/');
  for (const w of r.weakLines ?? []) {
    if (isOwn(p, w.line)) {
      bOwnAll++;
      bOwnByPath.set(p, (bOwnByPath.get(p) ?? 0) + 1);
    } else bUpAll++;
  }
  for (const f of r.fillerLines ?? []) {
    if (isOwn(p, f.line)) fOwnAll++;
    else fUpAll++;
  }
}

// ---- 集合运算：以 A 涉及的 19 批文件为范围 ----
const weakIndex = new Map(); // path -> Map(line -> reasons)
const fillerIndex = new Map();
for (const r of q.rows) {
  const p = r.path.replace(/\\/g, '/');
  const wm = new Map();
  for (const w of r.weakLines ?? []) wm.set(w.line, w.reasons.join(','));
  weakIndex.set(p, wm);
  const fm = new Map();
  for (const f of r.fillerLines ?? []) fm.set(f.line, f.reasons.join(','));
  fillerIndex.set(p, fm);
}

// 文件头块范围（与 deep-quality 的 headerEnd 同口径）
const headerEndCache = new Map();
function headerEndOf(p) {
  if (headerEndCache.has(p)) return headerEndCache.get(p);
  const abs = path.join(HEAD_WT, p);
  let end = -1;
  if (fs.existsSync(abs)) {
    const lines = fs.readFileSync(abs, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
    const kind = (t) => {
      const s = t.trim();
      if (s === '') return 'blank';
      if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) return 'comment';
      return 'code';
    };
    for (let i = 0; i < lines.length; i++) {
      const k = kind(lines[i]);
      if (k === 'blank') continue;
      if (k !== 'comment') break;
      let j = i;
      while (j + 1 < lines.length && kind(lines[j + 1]) === 'comment') j++;
      end = j;
      break;
    }
  }
  headerEndCache.set(p, end);
  return end;
}

// 与 deep-quality.mjs 第 482 行同一表达式，逐字复制，避免出现第二套口径
const CN_NOUN =
  /(缓冲区|边界|残行|换行|指针|计数|位置|偏移|目录|文件|路径|参数|配置|规则|权限|窗口|阈值|消息|会话|连接|进程|线程|缓存|索引|映射|集合|节点|字段|标记|长度|队列|句柄|状态|数组|对象|字节|摘要|快照|分段|视图|正则|转义|扫描|字符串|字符|引号|文本|枚举|事件|任务|标识|文案)/;

const buckets = { inHeader: 0, cnNoun: 0, digitAnchor: 0, backtick: 0, other: 0, fillerOnly: 0 };
const samples = { inHeader: [], cnNoun: [], digitAnchor: [], backtick: [], other: [] };
const aFiles = new Set(A.keys());
let interWeak = 0;
let interFiller = 0;
let aMinusB = 0;
for (const [p, lines] of A) {
  const wm = weakIndex.get(p) ?? new Map();
  const fm = fillerIndex.get(p) ?? new Map();
  const hEnd = headerEndOf(p);
  for (const [ln, info] of lines) {
    if (wm.has(ln)) {
      interWeak++;
      continue;
    }
    if (fm.has(ln)) {
      interFiller++;
      continue;
    }
    aMinusB++;
    let key;
    if (ln <= hEnd + 1 && hEnd >= 0) key = 'inHeader';
    else if (new RegExp(CN_NOUN).test(info.content)) key = 'cnNoun';
    else if (/\d/.test(info.content)) key = 'digitAnchor';
    else if (/`[^`]+`/.test(info.content)) key = 'backtick';
    else key = 'other';
    buckets[key]++;
    if (samples[key].length < 5) samples[key].push(`${p}:${ln} ${info.kind} :: ${info.content}`);
  }
}

// 19 批文件的 own weak 总量（说明「清 A 之后账上还剩多少」）
let bOwnInBatches = 0;
let bFilesInBatches = 0;
for (const p of aFiles) {
  const n = bOwnByPath.get(p);
  if (n) {
    bOwnInBatches += n;
    bFilesInBatches++;
  }
}

const pct = (a, b) => (b === 0 ? 'n/a' : ((a / b) * 100).toFixed(2) + '%');
console.log('=== 集合定义 ===');
console.log(`A zc-gate diff 口径：批次 = ${BATCHES.length} 批（b207–b226，跳过 b224），判 = 该批 diff 新增注释行，无豁免`);
console.log(`B deep-quality 整文件口径：文件 = ${q.rows.length}，基线 = ${BASE}→HEAD 的 + 行算 own`);
console.log('');
console.log('=== 总量 ===');
console.log(`A 命中行            = ${aTotal}（涉及 ${aFiles.size} 个文件）`);
console.log(`B weak  own/upstream= ${bOwnAll} / ${bUpAll}`);
console.log(`B filler own/upstream= ${fOwnAll} / ${fUpAll}`);
console.log(`B own weak 占 B weak  = ${pct(bOwnAll, bOwnAll + bUpAll)}`);
console.log('');
console.log('=== 交集（以 A 的 19 批文件为范围）===');
console.log(`A ∩ B(weak)    = ${interWeak}`);
console.log(`A ∩ B(filler)  = ${interFiller}`);
console.log(`A − B          = ${aMinusB}`);
console.log(`重合率 A∩B/|A| = ${pct(interWeak + interFiller, aTotal)}`);
console.log(`--- A − B 归因 ---`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(12)} = ${v}`);
console.log('');
console.log('=== 19 批文件在整文件口径下的 own weak 存量 ===');
console.log(`files=${bFilesInBatches} ownWeak=${bOwnInBatches}（zc-gate 只看到 ${aTotal} 行，差 ${bOwnInBatches - interWeak - interFiller} 行从未被 diff 尺子看见）`);
console.log('');
console.log('=== 样例（A − B 每类前 5）===');
for (const [k, arr] of Object.entries(samples)) {
  if (!arr.length) continue;
  console.log(`[${k}]`);
  for (const s of arr) console.log('  ' + s);
}

// ---- 改写工作清单：own weak 按文件分布 + 贪心分批（每批 ≤60 行，整文件不拆） ----
const dist = [...bOwnByPath.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
fs.writeFileSync(
  path.join(SNAP, 'weak-own-by-file.tsv'),
  dist.map(([p, n]) => `${n}\t${p}`).join('\n') + '\n',
  'utf8',
);
const CAP = 60;
const plans = [];
let curBatch = [];
let curSum = 0;
for (const [p, n] of dist) {
  if (curSum + n > CAP && curBatch.length) {
    plans.push({ files: curBatch, lines: curSum });
    curBatch = [];
    curSum = 0;
  }
  curBatch.push(p);
  curSum += n;
}
if (curBatch.length) plans.push({ files: curBatch, lines: curSum });

console.log('');
console.log('=== 改写工作清单 ===');
console.log(`own weak 文件数 = ${dist.length}；行数 = ${bOwnAll}；own filler = ${fOwnAll}（单独口径，不并入 weak）`);
console.log('--- 存量最重的 15 个文件 ---');
for (const [p, n] of dist.slice(0, 15)) console.log(`  ${String(n).padStart(3)}  ${p}`);
console.log(`--- 若按每批 ≤${CAP} 行、整文件不拆：${plans.length} 批 ---`);
const sizes = plans.map((x) => x.lines);
console.log(`  每批行数: 最大 ${Math.max(...sizes)}，最小 ${Math.min(...sizes)}，均值 ${(bOwnAll / plans.length).toFixed(1)}`);
console.log(`  清单已写 weak-own-by-file.tsv`);

// ---- own weak 与 own filler 的重叠，以及逐行工作清单 ----
let both = 0;
const ownWeakLines = [];
const ownFillerLines = [];
for (const r of q.rows) {
  const p = r.path.replace(/\\/g, '/');
  const wSet = new Set();
  for (const w of r.weakLines ?? []) {
    if (!isOwn(p, w.line)) continue;
    wSet.add(w.line);
    ownWeakLines.push({ p, line: w.line, reasons: w.reasons.join(','), content: w.content });
  }
  for (const f of r.fillerLines ?? []) {
    if (!isOwn(p, f.line)) continue;
    ownFillerLines.push({ p, line: f.line, reasons: f.reasons.join(','), content: f.content });
    if (wSet.has(f.line)) both++;
  }
}
ownWeakLines.sort((a, b) => a.p.localeCompare(b.p) || a.line - b.line);
ownFillerLines.sort((a, b) => a.p.localeCompare(b.p) || a.line - b.line);
fs.writeFileSync(
  path.join(SNAP, 'weak-own-lines.tsv'),
  ownWeakLines.map((x) => `${x.p}\t${x.line}\t${x.reasons}\t${x.content}`).join('\n') + '\n',
  'utf8',
);
fs.writeFileSync(
  path.join(SNAP, 'filler-own-lines.tsv'),
  ownFillerLines.map((x) => `${x.p}\t${x.line}\t${x.reasons}\t${x.content}`).join('\n') + '\n',
  'utf8',
);
console.log('');
console.log(`own weak ∩ own filler = ${both}；并集 = ${bOwnAll + fOwnAll - both} 行（weak ${bOwnAll} + filler ${fOwnAll}）`);
console.log('逐行清单已写 weak-own-lines.tsv / filler-own-lines.tsv');
