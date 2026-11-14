// 由行号+注释生成 apply 计划：自动读取锚点行文本并计算 occurrence
// 用法：node gen-plan-s3.mjs <items.json> <out-plan.json>
// items.json: { "file": "crates/...", "items": [ { "line": 118, "comments": ["..."] } ] }
import fs from 'node:fs';
import path from 'node:path';

const [itemsPath, outPath] = process.argv.slice(2);
if (!itemsPath || !outPath) {
  console.error('usage: node gen-plan-s3.mjs <items.json> <out-plan.json>');
  process.exit(2);
}
const repo = 'd:\\code\\opensource\\uv';
const spec = JSON.parse(fs.readFileSync(itemsPath, 'utf8').replace(/^\uFEFF/, ''));
const file = path.isAbsolute(spec.file) ? spec.file : path.join(repo, spec.file);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const isComment = (l) => /^\s*\/\//.test(l);

const items = [...spec.items].sort((a, b) => a.line - b.line);
const edits = [];
const errors = [];
let prev = -1; // 上一条 edit 的目标行（0 基索引）
for (const it of items) {
  const idx = it.line - 1;
  if (!(idx >= 0 && idx < lines.length)) {
    errors.push(`行号越界: ${it.line}`);
    continue;
  }
  const raw = lines[idx];
  const anchor = raw.trim();
  if (!anchor) { errors.push(`空行: ${it.line}`); continue; }
  if (isComment(raw)) { errors.push(`注释行: ${it.line}`); continue; }
  if (!Array.isArray(it.comments) || !it.comments.length) { errors.push(`无注释: ${it.line}`); continue; }
  if (it.comments.some((c) => String(c).includes('*/'))) { errors.push(`含 */: ${it.line}`); continue; }
  // 模拟 apply 的 occurrence：搜索范围 [prev, idx] 内与 anchor 相同的行数
  let occ = 0;
  for (let j = Math.max(0, prev); j <= idx; j++) {
    if (lines[j].trim() === anchor) occ++;
  }
  if (occ === 0) { errors.push(`range 内无匹配: ${it.line}`); continue; }
  edits.push({ anchor, comments: it.comments.map((c) => String(c).trim()), occurrence: occ, line: it.line });
  prev = idx;
}
const plan = { file: spec.file, edits: edits.map(({ anchor, comments, occurrence }) => ({ anchor, comments, occurrence })) };
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
console.log(`PLAN edits=${edits.length} errors=${errors.length} out=${outPath}`);
for (const e of errors) console.log('  ! ' + e);
process.exit(errors.length ? 1 : 0);
