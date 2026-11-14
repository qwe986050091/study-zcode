// 列出当前文件相对基线快照的新增行（非注释行单独标记），用于定位 nonCommentAdded。
import fs from 'node:fs';

const origRoot = 'D:/code/_annot_baseline/ZC-deep-svc-b9/orig';
const repo = 'D:/code/ZCode';
const rel = process.argv[2];
const a = fs.readFileSync(`${origRoot}/${rel}`, 'utf8').split(/\r?\n/);
const b = fs.readFileSync(`${repo}/${rel}`, 'utf8').split(/\r?\n/);
const setA = new Map();
for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
let lineNo = 0;
for (const line of b) {
  lineNo++;
  const c = setA.get(line) || 0;
  if (c > 0) { setA.set(line, c - 1); continue; }
  const t = line.trim();
  const kind = t === '' ? 'BLANK' : (t.startsWith('//') ? 'COMMENT' : 'NONCOMMENT');
  if (kind !== 'COMMENT') console.log(`${lineNo}\t${kind}\t${JSON.stringify(line)}`);
}
