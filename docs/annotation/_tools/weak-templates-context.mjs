// 为 top30 × 3 抽样条目导出上下文，供逐条核事实
import fs from 'node:fs';

const REPO = 'd:/code/opensource/valkey';
const md = fs.readFileSync('d:/code/_annot_baseline/weak-templates-22aa802.md', 'utf8');
const json = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-templates-22aa802.json', 'utf8'));

// 从 md 的表格里取样本 (模板编号, path, line)
const samples = [];
const re = /^\| (T\d+) \| [^|]+ \| (\d+) \| `([^`:]+):(\d+)`<br>注：([^<]*)<br>码：/gm;
let m;
while ((m = re.exec(md))) samples.push({ tpl: m[1], n: Number(m[2]), path: m[3], line: Number(m[4]), text: m[5] });
console.error('samples=' + samples.length);

const cache = new Map();
const lines = (p) => {
  if (!cache.has(p)) cache.set(p, fs.readFileSync(REPO + '/' + p, 'utf8').split('\n'));
  return cache.get(p);
};

const out = [];
for (const s of samples) {
  const L = lines(s.path);
  const t = json.find((x) => x.tpl === s.tpl) || null;
  out.push(`=== ${s.tpl} n=${s.n} ${s.path}:${s.line}  ${s.text}`);
  for (let i = Math.max(1, s.line - 6); i <= Math.min(L.length, s.line + 8); i++) {
    out.push(`${i === s.line ? '>>' : '  '}${i}\t${L[i - 1]}`);
  }
  out.push('');
}
fs.writeFileSync('d:/code/_annot_baseline/weak-templates-context.txt', out.join('\n'));
console.error('ctx lines=' + out.length);
