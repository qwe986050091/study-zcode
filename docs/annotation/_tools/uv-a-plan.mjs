// 对 a-spans.json 里每处字符串，找它所属语句/属性的起始行，并判断其上方 3 行内是否已有注释（含 ///）。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'd:/code/opensource/uv';
const spans = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/a-spans.json', 'utf8')).filter((x) => !x.orphan);
const cache = new Map();
const getLines = (f) => {
  if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(repo, f), 'utf8').replace(/\r\n/g, '\n').split('\n'));
  return cache.get(f);
};
const indent = (s) => s.length - s.replace(/^\s+/, '').length;
const isStart = (t) => /^\s*(#\[|\/\/|let\b|const\b|static\b|pub\b|fn\b|async\b|return\b|assert|insta|format!|\w+!|[\w:]+\(|\w+::)/.test(t);

const rows = [];
for (const g of spans) {
  const lines = getLines(g.file);
  const first = lines[g.startLine - 1];
  const baseIndent = indent(first);
  let at = g.startLine;
  for (let k = g.startLine - 2; k >= Math.max(0, g.startLine - 16); k--) {
    const t = lines[k];
    if (!t.trim()) break;
    if (indent(t) < baseIndent && isStart(t)) { at = k + 1; break; }
  }
  const above = lines.slice(Math.max(0, at - 4), at - 1).map((s) => s.trim()).filter(Boolean);
  const hasComment = above.some((s) => s.startsWith('//'));
  rows.push({ ...g, insertAt: at, hasComment, above: above.join(' | ').slice(0, 100) });
}
fs.writeFileSync('d:/code/_annot_baseline/uv-rework/a-plan.json', JSON.stringify(rows, null, 1), 'utf8');
const no = rows.filter((r) => !r.hasComment);
console.log(`spans=${rows.length} hasComment=${rows.length - no.length} needComment=${no.length} linesInNeed=${no.reduce((n, r) => n + r.count, 0)}`);
for (const r of no.sort((a, b) => (a.file < b.file ? -1 : 1))) console.log(`${r.count}\t${r.file}:${r.startLine}-${r.endLine}\tins=${r.insertAt}\t${linesOf(r)}`);
function linesOf(r) {
  const lines = getLines(r.file);
  return (lines[r.insertAt - 1] || '').trim().slice(0, 80);
}
