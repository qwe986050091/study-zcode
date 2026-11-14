// 只判「相对本批 orig 快照新增」的注释行，避免把历史遗留命中算进本批。
// usage: node zc-gate-new.mjs <batchDir>
import fs from 'node:fs';
import path from 'node:path';
import { gateInsertion, judgeEntries, addedCommentEntries } from './zc-gate.mjs';

const batchDir = process.argv[2];
if (!batchDir) {
  console.error('usage: node zc-gate-new.mjs <batchDir>');
  process.exit(2);
}
const repo = 'D:/code/ZCode';
const rels = fs
  .readFileSync(path.join(batchDir, '_files.txt'), 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

let totalAdded = 0;
let totalHits = 0;
for (const rel of rels) {
  const origFile = path.join(batchDir, 'orig', rel);
  const curFile = path.join(repo, rel);
  const before = fs.readFileSync(origFile, 'utf8').split(/\r?\n/);
  const after = fs.readFileSync(curFile, 'utf8').split(/\r?\n/);
  const findings = gateInsertion(before, after, rel);
  const added = addedCommentEntries(before, after);
  totalAdded += added.length;
  totalHits += findings.length;
  for (const f of findings) {
    console.log(`${f.kind} ${rel}:${f.line} ${f.reason} :: ${f.lines.join(' | ')}`);
  }
}
console.log(`SUMMARY files=${rels.length} newCommentLines=${totalAdded} newHits=${totalHits}`);
process.exit(totalHits ? 1 : 0);
