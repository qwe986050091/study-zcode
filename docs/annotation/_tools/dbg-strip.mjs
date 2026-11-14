// 临时调试：按 AST 注释范围判定整行注释，列出仍被判为代码的 // 行。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const rel = process.argv[2];
const text = fs.readFileSync(path.join(repo, rel), 'utf8');
const ts = (await import('file:///' + path.join(repo, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
const norm = text.replace(/\r\n/g, '\n');
const sf = ts.createSourceFile('x.ts', norm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const covered = new Uint8Array(norm.length);
const addRanges = (rs) => {
  if (!rs) return;
  for (const r of rs) for (let i = r.pos; i < r.end; i++) covered[i] = 1;
};
addRanges(ts.getLeadingCommentRanges(norm, 0));
const visit = (node) => {
  addRanges(ts.getLeadingCommentRanges(norm, node.getFullStart()));
  addRanges(ts.getTrailingCommentRanges(norm, node.getEnd()));
  ts.forEachChild(node, visit);
};
visit(sf);
const lineStarts = [0];
for (let i = 0; i < norm.length; i++) if (norm[i] === '\n') lineStarts.push(i + 1);
const lines = norm.split('\n');
let shown = 0;
for (let idx = 0; idx < lines.length; idx++) {
  const line = lines[idx];
  if (!line.trim().startsWith('//')) continue;
  let hasCode = false;
  let hasComment = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ' || line[i] === '\t') continue;
    if (covered[lineStarts[idx] + i]) hasComment = true;
    else hasCode = true;
  }
  if (hasCode) {
    console.log(`LINE ${idx + 1} :: ${line.trim().slice(0, 100)}`);
    if (++shown > 20) break;
  }
}
console.log('parseErrors=' + (sf.parseDiagnostics?.length ?? 0) + ' lines=' + lines.length);
