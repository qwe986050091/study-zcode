// A 类（字符串内不可逐行注）按「字符串字面量」归并：每个多行字符串算一处，统计其中的未覆盖单元数。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { stringSpans } = await import(pathToFileURL('d:/code/_annot_baseline/uv-string-spans.mjs').href);

const repo = 'd:/code/opensource/uv';
const all = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/audit-c.json', 'utf8'));
const A = all.filter((u) => u.cat === 'A');
const byFile = new Map();
for (const u of A) {
  if (!byFile.has(u.file)) byFile.set(u.file, []);
  byFile.get(u.file).push(u);
}

const out = [];
let total = 0;
for (const [file, arr] of byFile) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const lineOf = (off) => src.slice(0, off).split('\n').length;
  const spans = stringSpans(src).filter((s) => s.multiline).map((s) => ({ ...s, startLine: lineOf(s.start), endLine: lineOf(s.end - 1) }));
  const used = new Map();
  for (const u of arr) {
    const s = spans.find((x) => u.line >= x.startLine && u.line <= x.endLine);
    if (!s) { out.push({ file, line: u.line, orphan: true }); continue; }
    const key = `${s.startLine}-${s.endLine}`;
    if (!used.has(key)) used.set(key, { file, startLine: s.startLine, endLine: s.endLine, count: 0, firstText: lines[s.startLine - 1].trim().slice(0, 90), lastText: lines[s.endLine - 1].trim().slice(0, 60) });
    used.get(key).count++;
  }
  for (const g of used.values()) { out.push(g); total += g.count; }
}
fs.writeFileSync('d:/code/_annot_baseline/uv-rework/a-spans.json', JSON.stringify(out, null, 1), 'utf8');
const ok = out.filter((x) => !x.orphan);
console.log(`A_lines=${A.length} spans=${ok.length} coveredBySpans=${total} orphan=${out.filter((x) => x.orphan).length}`);
for (const g of ok.sort((a, b) => b.count - a.count)) console.log(`${g.count}\t${g.file}:${g.startLine}-${g.endLine}\t${g.firstText}`);
