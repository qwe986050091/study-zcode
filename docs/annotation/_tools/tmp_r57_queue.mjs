// R57 队列口径改造：给 R55-claim-queue.csv 加 layer_status / source 两列，
// 回填 orm 76 行，追加 kit 107 行（60 抽样 + 47 全核），按 R57/R58/R59 分批。
import fs from 'node:fs';

const B = 'D:/code/_annot_baseline/';
const csvPath = B + 'R55-claim-queue.csv';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { q = false; }
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}

const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
const rows = parseCsv(raw);
const head = rows.shift();
const H = Object.fromEntries(head.map((h, i) => [h, i]));

// R52 层结论：一律@orm 58/58 全核、5 不成立；必然@orm 16/16、6 不成立；从不@orm 2/2、0 不成立。
// 逐条结论此前只落了失败点，其余按层结论转录为「成立（R52 全核）」。
const YILV_ORM_FAIL = new Set(['5dba5d34', 'a263f222', 'cedb5d54', '3c4524c0', 'f5724315']);

const out = [];
let backfilled = 0;
for (const r of rows) {
  const o = Object.fromEntries(head.map((h) => [h, r[H[h]] ?? '']));
  o.layer_status = '已全核';
  o.source = 'recheck';
  if (!o.conclusion) {
    if (o.keyword === '一律' && YILV_ORM_FAIL.has(o.key)) o.conclusion = '不成立（R52 全核，修正行见 R52c）';
    else o.conclusion = '成立（R52 全核）';
    o.batch = o.batch || 'R52';
    backfilled++;
  }
  out.push(o);
}
const ormRows = out.length;

const sample = JSON.parse(fs.readFileSync(B + 'R52-claim-sample.json', 'utf8').replace(/^\uFEFF/, '')).sample;
const yilvKit = JSON.parse(fs.readFileSync(B + 'R52-layer-yilv-kit.json', 'utf8').replace(/^\uFEFF/, ''));
const biranKit = JSON.parse(fs.readFileSync(B + 'R52-layer-biran.json', 'utf8').replace(/^\uFEFF/, ''))
  .filter((x) => x.file.startsWith('drizzle-kit'));

const kit = [];
const push = (x, keyword, batch, full) => kit.push({
  key: x.key, file: x.file, line: String(x.line), keyword,
  segment: x.seg ?? x.segment ?? '', conclusion: '', batch,
  layer_status: '未核', source: 'recheck', _full: full,
});

for (const x of yilvKit) push(x, '一律', 'R57', true);
for (const x of biranKit) push(x, '必然', 'R57', true);
for (const x of sample.filter((s) => s.dir === 'kit' && s.kw === '从不')) push(x, '从不', 'R58', true);
for (const kw of ['都', '唯一', '只有']) {
  for (const x of sample.filter((s) => s.dir === 'kit' && s.kw === kw)) push(x, kw, 'R58', false);
}
for (const kw of ['全部', '只会', '始终']) {
  for (const x of sample.filter((s) => s.dir === 'kit' && s.kw === kw)) push(x, kw, 'R59', false);
}

// 去重：同一 key 同文件同行只留一条
const seen = new Set();
const kitUniq = kit.filter((x) => {
  const k = x.key + '|' + x.file + '|' + x.line;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const cols = ['key', 'file', 'line', 'keyword', 'segment', 'conclusion', 'batch', 'layer_status', 'source'];
const all = [...out, ...kitUniq].map((o) => cols.map((c) => o[c] ?? ''));
fs.writeFileSync(csvPath, toCsv([cols, ...all]), 'utf8');

const stat = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log('orm rows', ormRows, 'backfilled', backfilled);
console.log('kit rows', kitUniq.length, stat(kitUniq, (x) => x.batch));
console.log('kit layer_status', stat(kitUniq, (x) => x.layer_status), 'source', stat(kitUniq, (x) => x.source));
console.log('kit dup removed', kit.length - kitUniq.length);
