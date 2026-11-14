// 回溯审计：全部 valkey 批次的「未登记新增」= added − entries。
// 记录格式不统一，这里做归并：
//   entries : [{line, c: string[]}]
//   annot   : [{line, expect?, lines: string[]}]
//   comments: [{line, comments: string[]}]
//   spec    : [{file, ops: [{lines: string[]}]}]   —— 无行号，只能按条数计
// 每个 (批次, 文件) 只取一个优先级的记录集，避免 chunk 与 merged 重复计数：
//   out-*.json > 带 expect 的 annot > 其余行号型记录 > spec
// 同一优先级内按行号并集去重。
import fs from 'node:fs';
import path from 'node:path';
import { scanFiles } from './vk-gate.mjs';

const BASE = 'd:/code/_annot_baseline';
const REPO = 'd:/code/opensource/valkey';
const SKIP_NAME = /(quality|repo-|_dropped|check|audit|plan|before|after|tmp|uncovered|fail|result|report)/i;

const normText = (s) => String(s).replace(/\s+/g, ' ').trim();
const stripComment = (s) => {
  let t = s.trim();
  if (t.startsWith('//')) t = t.slice(2);
  else if (t.startsWith('/*')) t = t.slice(2);
  else if (t.startsWith('*')) t = t.slice(1);
  return normText(t.replace(/\*\/\s*$/, ''));
};

function parseRecords(file) {
  let o;
  try {
    o = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(o) || !o.length) return [];
  const out = [];
  if (o.every((e) => e && typeof e.line === 'number' && Array.isArray(e.c))) {
    for (const e of o) out.push({ kind: 'entries', file: e.file, line: e.line, texts: e.c, expect: e.expect });
  } else if (o.every((e) => e && typeof e.line === 'number' && Array.isArray(e.lines))) {
    for (const e of o) out.push({ kind: 'annot', file: e.file, line: e.line, texts: e.lines, expect: e.expect });
  } else if (o.every((e) => e && typeof e.line === 'number' && Array.isArray(e.comments))) {
    for (const e of o) out.push({ kind: 'comments', file: e.file, line: e.line, texts: e.comments, expect: e.expect });
  } else if (o.every((e) => e && typeof e.file === 'string' && Array.isArray(e.ops))) {
    for (const e of o) {
      for (const op of e.ops) {
        const texts = op.lines || op.c || [];
        out.push({ kind: 'spec', file: e.file, line: null, texts, expect: op.anchor });
      }
    }
  }
  return out;
}

function batchFiles(dir) {
  const p = path.join(dir, '_files.txt');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('\t')[0].replace(/\\/g, '/'))
    .filter((s) => /^src\/.*\.(c|h)$/.test(s));
}

function readAllFiles(files) {
  const m = new Map();
  for (const rel of files) {
    const cur = path.join(REPO, rel);
    const orig = path.join(BASE, 'orig-tmp');
    let s = '';
    try {
      s = fs.readFileSync(cur, 'utf8');
    } catch {}
    m.set(rel, normText(s));
  }
  return m;
}

// JSON 文件名里的缩写 → 目标文件主名。行号型记录本身不带 file，只能靠这一层。
const ALIAS = [
  [/^ae-1\b/, 'ae_epoll'],
  [/^ae-2\b/, 'ae_kqueue'],
  [/^io\d/, 'io_threads'],
  [/^mp-/, 'memory_prefetch'],
  [/^threads_mngr/, 'threads_mngr'],
  [/^bgi/, 'bgiteration'],
  [/^sds\d/, 'sds'],
  [/^forkless/, 'forkless'],
];

function attribute(rec, batch, content, jsonName) {
  const f = (rec.file || '').replace(/\\/g, '/');
  if (f && /^src\/.*\.(c|h)$/.test(f)) return batch.includes(f) ? f : null;
  const exp = rec.expect ? normText(rec.expect) : '';
  if (exp) {
    const hits = batch.filter((rel) => content.get(rel)?.includes(exp));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) hits.sort((a, b) => a.length - b.length);
    if (hits.length) return hits[0];
  }
  const stem = path.basename(jsonName).toLowerCase();
  for (const [re, want] of ALIAS) {
    if (!re.test(stem)) continue;
    const hit = batch.find((rel) => path.basename(rel).replace(/\.(c|h)$/, '') === want);
    if (hit) return hit;
  }
  const cands = batch
    .map((rel) => ({ rel, s: path.basename(rel).replace(/\.(c|h)$/, '').toLowerCase() }))
    .filter((x) => stem.replace(/^out-/, '').includes(x.s))
    .sort((a, b) => b.s.length - a.s.length);
  if (cands.length) return cands[0].rel;
  if (batch.length === 1) return batch[0];
  return null;
}

// 顶层 vk-spec-*.json 是早期批次的声明记录（{file, ops:[{lines}]}），按文件计条数。
const specByFile = new Map();
for (const f of fs.readdirSync(BASE)) {
  if (!/^vk-spec-.*\.json$/.test(f)) continue;
  let o;
  try {
    o = JSON.parse(fs.readFileSync(path.join(BASE, f), 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(o)) continue;
  for (const e of o) {
    if (!e || typeof e.file !== 'string' || !Array.isArray(e.ops)) continue;
    const rel = e.file.replace(/\\/g, '/');
    const n = e.ops.reduce((s, op) => s + ((op.lines || op.c || []).length), 0);
    specByFile.set(rel, (specByFile.get(rel) || 0) + n);
  }
}

const dirs = fs
  .readdirSync(BASE)
  .filter((d) => /^VK-/.test(d) && fs.statSync(path.join(BASE, d)).isDirectory())
  .filter((d) => batchFiles(path.join(BASE, d)).length)
  .sort();

const fileTouchedBy = new Map(); // rel -> Set(batch)
const perBatch = [];
const perFile = new Map(); // rel -> {added, water, entries, hasRecord, batches:Set}

for (const b of dirs) {
  const dir = path.join(BASE, b);
  const files = batchFiles(dir);
  for (const rel of files) {
    if (!fileTouchedBy.has(rel)) fileTouchedBy.set(rel, new Set());
    fileTouchedBy.get(rel).add(b);
  }
  const scan = scanFiles(REPO, files);
  const scanByFile = new Map(scan.map((r) => [r.file, r]));
  const content = readAllFiles(files);

  const jsons = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !SKIP_NAME.test(f));
  const recs = [];
  for (const j of jsons) {
    for (const r of parseRecords(path.join(dir, j))) recs.push({ ...r, json: j });
  }
  // 归属到文件
  for (const r of recs) {
    r.attr = attribute(r, files, content, r.json);
  }

  // 每个文件选一个优先级：out > annot(expect) > line型 > spec
  const byFile = new Map();
  for (const r of recs) {
    if (!r.attr) continue;
    if (!byFile.has(r.attr)) byFile.set(r.attr, []);
    byFile.get(r.attr).push(r);
  }
  const entriesByFile = new Map();
  for (const [rel, rs] of byFile) {
    const out = rs.filter((r) => /^out-/.test(r.json));
    const annot = rs.filter((r) => r.kind === 'annot' && r.expect);
    const line = rs.filter((r) => r.line !== null && r.kind !== 'spec');
    const spec = rs.filter((r) => r.kind === 'spec');
    let chosen = null;
    if (out.length) chosen = out;
    else if (annot.length) chosen = annot;
    else if (line.length) chosen = line;
    else if (spec.length) chosen = spec;
    if (!chosen) continue;
    if (chosen.every((r) => r.line === null)) {
      entriesByFile.set(rel, chosen.reduce((s, r) => s + r.texts.length, 0));
      continue;
    }
    // 行号并集；同一行多段只算一次
    const lines = new Set();
    for (const r of chosen) lines.add(r.line);
    // 一行可能写入多段文字，按段数折算：取该行 texts 长度的最大值
    const maxPerLine = new Map();
    for (const r of chosen) {
      const n = r.texts.length;
      maxPerLine.set(r.line, Math.max(maxPerLine.get(r.line) || 0, n));
    }
    let n = 0;
    for (const l of lines) n += maxPerLine.get(l) || 1;
    entriesByFile.set(rel, n);
  }

  let addedSum = 0;
  let waterSum = 0;
  let entriesSum = 0;
  let noRecFiles = 0;
  for (const rel of files) {
    const s = scanByFile.get(rel) || { added: 0, water: 0 };
    const e = entriesByFile.get(rel) || 0;
    addedSum += s.added;
    waterSum += s.water;
    entriesSum += e;
    if (!entriesByFile.has(rel)) noRecFiles++;
    if (!perFile.has(rel)) perFile.set(rel, { added: s.added, water: s.water, entries: 0, hasRecord: false, batches: new Set() });
    const pf = perFile.get(rel);
    pf.added = s.added;
    pf.water = s.water;
    pf.entries += e;
    if (entriesByFile.has(rel)) pf.hasRecord = true;
    pf.batches.add(b);
  }
  perBatch.push({
    batch: b,
    files: files.length,
    added: addedSum,
    entries: entriesSum,
    extra: addedSum - entriesSum,
    water: waterSum,
    rate: addedSum ? +((waterSum / addedSum) * 100).toFixed(2) : 0,
    noRecFiles,
    recordJson: jsons.filter((j) => recs.some((r) => r.json === j)).length,
  });
}

// spec 记录并入文件级总账：同一文件优先取「批次记录 / spec 记录」的较大值，避免互相覆盖。
for (const [rel, n] of specByFile) {
  if (!perFile.has(rel)) {
    const s = scanFiles(REPO, [rel])[0] || { added: 0, water: 0 };
    perFile.set(rel, { added: s.added, water: s.water, entries: 0, hasRecord: false, batches: new Set(['vk-spec']) });
  }
  const pf = perFile.get(rel);
  pf.entries = Math.max(pf.entries, n);
  pf.hasRecord = true;
}

const fmt = (n) => (n >= 0 ? '+' + n : String(n));
const lines = [];
lines.push('# valkey 全批次 added / entries / extra 回溯');
lines.push('');
lines.push('口径：added = 当前工作区相对 git HEAD 的新增整行注释数；entries = 该批记录 JSON 声明的插入行数；extra = added − entries。');
lines.push('同一文件被多个批次顺序注释时，per-batch 的 added 含前序批次，故另给文件级总账作为权威口径。');
lines.push('');
lines.push('## 批次表（extra 降序）');
lines.push('');
lines.push('| 批次 | 文件数 | added | entries | extra | W | W率 | 无记录文件 | 备注 |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of [...perBatch].sort((a, b) => b.extra - a.extra)) {
  const note = r.batch === 'VK-A5H' ? 'A5 的保留副本，非独立批次' : '';
  lines.push(`| ${r.batch} | ${r.files} | ${r.added} | ${r.entries} | ${fmt(r.extra)} | ${r.water} | ${r.rate}% | ${r.noRecFiles} | ${note} |`);
}
const tAdd = perBatch.reduce((s, r) => s + r.added, 0);
const tEnt = perBatch.reduce((s, r) => s + r.entries, 0);
lines.push(`| **合计(含重复)** | | ${tAdd} | ${tEnt} | ${fmt(tAdd - tEnt)} | | | | 顺序批次与副本会重复计 |`);
lines.push('');
lines.push('## 文件级总账（extra 降序，权威口径）');
lines.push('');
lines.push('| 文件 | added | entries | extra | W | W率 | 批次 | 记录 |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
const fileRows = [...perFile.entries()].map(([rel, v]) => ({
  rel,
  ...v,
  extra: v.added - v.entries,
  rate: v.added ? +((v.water / v.added) * 100).toFixed(2) : 0,
  shared: v.batches.size > 1,
}));
for (const r of fileRows.sort((a, b) => b.extra - a.extra)) {
  lines.push(
    `| ${r.rel} | ${r.added} | ${r.entries} | ${fmt(r.extra)} | ${r.water} | ${r.rate}% | ${[...r.batches].join('+')} | ${r.hasRecord ? '有' : '无'} |`,
  );
}
const fAdd = fileRows.reduce((s, r) => s + r.added, 0);
const fEnt = fileRows.reduce((s, r) => s + r.entries, 0);
lines.push(`| **合计(去重)** | ${fAdd} | ${fEnt} | ${fmt(fAdd - fEnt)} | ${fileRows.reduce((s, r) => s + r.water, 0)} | | | |`);
lines.push('');
lines.push(`files=${fileRows.length} sharedFiles=${fileRows.filter((r) => r.shared).length} noRecordFiles=${fileRows.filter((r) => !r.hasRecord).length}`);

const out = lines.join('\n');
fs.writeFileSync(path.join(BASE, 'vk-extra-audit.md'), out, 'utf8');
fs.writeFileSync(
  path.join(BASE, 'vk-extra-audit.json'),
  JSON.stringify({ perBatch, perFile: fileRows.map(({ batches, ...r }) => ({ ...r, batches: [...batches] })) }, null, 2),
  'utf8',
);
console.log(out);
