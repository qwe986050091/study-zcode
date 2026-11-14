// 第七件候选：同注释块内近重复行检测（char-bigram Jaccard）。
// 用法：node _check-comment-dups.mjs <repo> <file-list> [--json out] [--sample 20] [--threshold 0.5]
// 判据：同一连续注释块内、行距 ≤ 2、两行均为 OWN（HEAD 中不存在该行文本）、
//      且两端都不是结构标记行 / POEM 合并行，char-bigram Jaccard ≥ 阈值即命中。
// 退出码：命中数 > 0 时为 1（门禁语义）；带 --json 仍写报告。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [repo, listFile] = process.argv.slice(2);
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const THRESHOLD = Number(arg('--threshold', '0.5'));
const JSON_OUT = arg('--json', '');
const SAMPLE = Number(arg('--sample', '0'));
const EXEMPT = arg('--exempt', '');
const DIST = Number(arg('--distance', '2'));
const NO_EXCLUDE = process.argv.includes('--no-exclude');

const body = (l) => l.trim().replace(/^\/\/\s?/, '').trim();
// 结构标记行：契约/权衡/失败路径这类成对出现且用词天然接近，排除
const STRUCT = /^(?:\[[^\]]{1,8}\]|INV-\d+|STEP\b|TODO\b|FIXME\b|NOTE\b|HACK\b|XXX\b)/;
// 结构配对的第二行（“守住：…”）本身不是结构标记，但承接上一条 INV/契约，同样排除
const GUARD = /^(?:守住(?:位置|它)?|位置)[：:]/;
// 纯装饰分隔线（==== / ---- / ────），不承载语义
const DECOR = /^[=\-_*#~─═·\s]{6,}$/;
// POEM 合并行：多句被压进同一行时天然与相邻行相似，排除。
// 口径（2026-11-10 修正）：只认「≥3 个句末/分句终止符」，不认 2 个。
// 原口径 ≥2 会把大量正常的两句长注释一起排除，实测吞掉了已知真阳性（index.ts:372/2507/2510）。
const POEM_MERGED = (t) => (t.match(/[。；]/g) || []).length >= 3;

const bigrams = (s) => {
  const out = new Set();
  const t = s.replace(/[\s“”"'`]/g, '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
const sim = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

const exempt = new Set();
if (EXEMPT && fs.existsSync(EXEMPT)) {
  for (const l of fs.readFileSync(EXEMPT, 'utf8').split(/\r?\n/)) {
    const v = l.trim();
    if (v && !v.startsWith('#')) exempt.add(v);
  }
}

const headCache = new Map();
const headSet = (rel) => {
  if (headCache.has(rel)) return headCache.get(rel);
  let set = new Set();
  try {
    const txt = execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    set = new Set(txt.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()));
  } catch {
    set = null; // 新文件：全部视为 OWN
  }
  headCache.set(rel, set);
  return set;
};

const rels = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const pairs = [];
const fileHits = new Map();
const byKind = { verbatim: 0, prefix: 0, paraphrase: 0 };

for (const rel of rels) {
  const abs = path.resolve(repo, rel);
  if (!fs.existsSync(abs)) continue;
  const raw = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  const head = headSet(rel);
  const isOwn = (text) => head === null || !head.has(text.trim());

  let block = [];
  let lastIndent = null;
  const flush = () => {
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length && j <= i + DIST; j++) {
        const a = block[i], b = block[j];
        const ta = body(a.text), tb = body(b.text);
        if (!ta || !tb) continue;
        if (!NO_EXCLUDE && (STRUCT.test(ta) || STRUCT.test(tb))) continue;
        if (!NO_EXCLUDE && (GUARD.test(ta) || GUARD.test(tb))) continue;
        if (!NO_EXCLUDE && (DECOR.test(ta) || DECOR.test(tb))) continue;
        if (!NO_EXCLUDE && (POEM_MERGED(ta) || POEM_MERGED(tb))) continue;
        if (!isOwn(a.text) || !isOwn(b.text)) continue;
        if (exempt.has(`${rel}:${a.ln}`) || exempt.has(`${rel}:${b.ln}`)) continue;
        const s = sim(ta, tb);
        if (s < THRESHOLD) continue;
        let kind = 'paraphrase';
        const na = ta.replace(/[\s“”"'`]/g, ''), nb = tb.replace(/[\s“”"'`]/g, '');
        if (na === nb) kind = 'verbatim';
        else if (na.length >= 8 && nb.length >= 8 && (na.startsWith(nb) || nb.startsWith(na))) kind = 'prefix';
        byKind[kind]++;
        pairs.push({ file: rel, a: a.ln, b: b.ln, sim: Number(s.toFixed(3)), kind, textA: ta, textB: tb });
        fileHits.set(rel, (fileHits.get(rel) || new Set()).add(a.ln).add(b.ln));
      }
    }
    block = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('//')) {
      const ind = /^[ \t]*/.exec(lines[i])[0];
      if (lastIndent !== null && ind !== lastIndent) flush();
      lastIndent = ind;
      block.push({ ln: i + 1, text: lines[i] });
    } else {
      flush();
      lastIndent = null;
    }
  }
  flush();
}

const hitLines = [...fileHits.values()].reduce((n, s) => n + s.size, 0);
const top = [...fileHits.entries()]
  .map(([f, s]) => ({ file: f, lines: s.size }))
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 10);

const sample = [];
if (SAMPLE > 0 && pairs.length) {
  const step = Math.max(1, Math.floor(pairs.length / SAMPLE));
  for (let i = 0; i < pairs.length && sample.length < SAMPLE; i += step) sample.push(pairs[i]);
}

const report = {
  metric: 'comment-dups',
  threshold: THRESHOLD,
  distance: DIST,
  exclude: !NO_EXCLUDE,
  files: rels.length,
  pairs: pairs.length,
  hitLines,
  byKind,
  top10: top,
  sample,
  pairs,
};
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

console.log(`SUMMARY files=${rels.length} pairs=${pairs.length} hitLines=${hitLines} verbatim=${byKind.verbatim} prefix=${byKind.prefix} paraphrase=${byKind.paraphrase}`);
if (top.length) for (const t of top) console.log(`TOP ${t.lines}\t${t.file}`);
if (sample.length) for (const p of sample) console.log(`SAMPLE ${p.kind} ${p.sim}\t${p.file}:${p.a}/${p.b}\n  A: ${p.textA}\n  B: ${p.textB}`);
process.exit(pairs.length > 0 ? 1 : 0);
