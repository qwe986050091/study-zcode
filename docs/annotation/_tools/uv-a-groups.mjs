// A 类（字符串内不可逐行注）按「连续行段」归并为字符串处，输出每处的文件/行号区间/行数/所属语句起始行与上下文。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { linesInsideStrings } = await import(pathToFileURL('d:/code/_annot_baseline/uv-string-spans.mjs').href);

const repo = 'd:/code/opensource/uv';
const all = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/audit-c.json', 'utf8'));
const A = all.filter((u) => u.cat === 'A').sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

const byFile = new Map();
for (const u of A) {
  if (!byFile.has(u.file)) byFile.set(u.file, []);
  byFile.get(u.file).push(u);
}

const groups = [];
for (const [file, arr] of byFile) {
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const inside = new Set(linesInsideStrings(lines.join('\n')).map((v, i) => (v ? i + 1 : 0)).filter(Boolean));
  let cur = null;
  for (const u of arr) {
    if (cur && u.line === cur.end + 1) cur.end = u.line;
    else { if (cur) groups.push(cur); cur = { file, start: u.line, end: u.line }; }
  }
  if (cur) groups.push(cur);
  for (const g of groups.filter((x) => x.file === file)) {
    // 插入点：组首行之上，第一个「行首不在字符串内」的行；通常就是语句起始或字符串起始行。
    let ins = g.start - 1;
    while (ins > 1 && inside.has(ins)) ins--;
    // 语句起始：从 ins 往上找缩进更浅、或以 let/const/static/pub/fn/self./return 开头的行，最多 12 行
    let stmt = ins;
    const indent = (s) => s.length - s.replace(/^\s+/, '').length;
    const base = indent(lines[ins - 1] || '');
    for (let k = ins - 1; k >= Math.max(0, ins - 12); k--) {
      const t = lines[k];
      if (!t.trim()) break;
      if (indent(t) < base && /^\s*(let|const|static|pub|fn|async fn|return|assert|insta|format!|\w+!?\()/.test(t)) { stmt = k + 1; break; }
    }
    g.insertAt = stmt;
    g.opener = lines[stmt - 1].trim();
    groups[groups.length - 1] = g;
  }
}
// 上面的循环里 groups 每次都在增长，修正：重建
const grouped = [];
for (const [file, arr] of byFile) {
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const inside = new Set(linesInsideStrings(lines.join('\n')).map((v, i) => (v ? i + 1 : 0)).filter(Boolean));
  let cur = null;
  const local = [];
  for (const u of arr) {
    if (cur && u.line === cur.end + 1) cur.end = u.line;
    else { if (cur) local.push(cur); cur = { file, start: u.line, end: u.line }; }
  }
  if (cur) local.push(cur);
  for (const g of local) {
    let ins = g.start - 1;
    while (ins > 1 && inside.has(ins)) ins--;
    const indent = (s) => s.length - s.replace(/^\s+/, '').length;
    const base = indent(lines[ins - 1] || '');
    let stmt = ins;
    for (let k = ins - 1; k >= Math.max(0, ins - 12); k--) {
      const t = lines[k];
      if (!t.trim()) break;
      if (indent(t) < base && /^\s*(let|const|static|pub|fn|async fn|return|assert|insta|format!|\w+!?\()/.test(t)) { stmt = k + 1; break; }
    }
    g.insertAt = stmt;
    g.opener = lines[stmt - 1].trim();
    g.count = g.end - g.start + 1;
    grouped.push(g);
  }
}

fs.writeFileSync('d:/code/_annot_baseline/uv-rework/a-groups.json', JSON.stringify(grouped, null, 1), 'utf8');
console.log(`A_lines=${A.length} groups=${grouped.length}`);
const byFileCount = {};
for (const g of grouped) byFileCount[g.file] = (byFileCount[g.file] || 0) + g.count;
for (const [f, n] of Object.entries(byFileCount).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${f}`);
