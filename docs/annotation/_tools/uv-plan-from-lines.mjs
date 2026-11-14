// 由「目标行号 + 注释文本」生成 uv-apply-comments.mjs 可用的计划。
// 用法：node uv-plan-from-lines.mjs <entries.json> <out-plan.json>
// entries.json: [{ "line": 204, "comments": ["..."] }, ...]（line 为当前文件行号，需升序）
import fs from 'node:fs';

const FILE = 'd:\\code\\opensource\\uv\\crates\\uv-python-discovery\\src\\lib.rs';
const [inPath, outPath] = process.argv.slice(2);
const entries = JSON.parse(fs.readFileSync(inPath, 'utf8').replace(/^\uFEFF/, ''));
const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);

let cursor = -1;
const edits = [];
const problems = [];
let prevLine = 0;
for (const [i, e] of entries.entries()) {
  const target = Number(e.line) - 1;
  if (!(target >= 0 && target < lines.length)) {
    problems.push(`#${i} 行号越界 ${e.line}`);
    continue;
  }
  if (e.line < prevLine) problems.push(`#${i} 行号未升序 ${e.line} < ${prevLine}`);
  prevLine = e.line;
  const anchor = lines[target].trim();
  if (!anchor) {
    problems.push(`#${i} 目标行为空 ${e.line}`);
    continue;
  }
  if (/^\s*\/\//.test(lines[target])) {
    problems.push(`#${i} 目标行本身是注释 ${e.line}`);
    continue;
  }
  // 已在上方有注释则 apply 会拒绝
  let k = target - 1;
  while (k >= 0 && lines[k].trim() === '') k--;
  if (k >= 0 && /^\s*\/\//.test(lines[k])) problems.push(`#${i} 上方已有注释 ${e.line}: ${anchor.slice(0, 40)}`);
  let occurrence = 0;
  for (let j = cursor + 1; j <= target; j++) if (lines[j].trim() === anchor) occurrence++;
  if (!occurrence) {
    problems.push(`#${i} 游标之后找不到锚点 ${e.line}`);
    continue;
  }
  edits.push({ anchor, comments: e.comments, occurrence });
  cursor = target;
}

fs.writeFileSync(outPath, JSON.stringify({ file: 'crates/uv-python-discovery/src/lib.rs', edits }, null, 1), 'utf8');
console.log(`PLAN edits=${edits.length} problems=${problems.length} out=${outPath}`);
for (const p of problems) console.log('  ! ' + p);
