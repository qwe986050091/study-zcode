// 按注释块原文替换（只改注释，不动代码）。用于“只写做什么”的回补。
// 用法：node uv-apply-rewrites.mjs <plan.json> [--dry]
// plan.json: { "file": "crates/.../x.rs", "edits": [ { "old": ["旧注释1", "旧注释2"], "new": ["新注释1"] } ] }
// 规则：old 必须能在文件中唯一匹配（按 trim 后的连续行）；只允许匹配 `//` 注释行；
//       new 自动沿用 old 首行的缩进并补 `// ` 前缀；不允许 `*/`。
import fs from 'node:fs';
import path from 'node:path';

const [planPath, ...flags] = process.argv.slice(2);
if (!planPath) {
  console.error('usage: node uv-apply-rewrites.mjs <plan.json> [--dry]');
  process.exit(2);
}
const dry = flags.includes('--dry');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''));
const file = path.isAbsolute(plan.file) ? plan.file : path.join('d:\\code\\opensource\\uv', plan.file.split('/').join(path.sep));
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);
const isLineComment = (l) => /^\s*\/\//.test(l);

let replaced = 0;
let added = 0;
let removed = 0;
const errors = [];
for (const [i, edit] of plan.edits.entries()) {
  const oldLines = (edit.old || []).map((s) => String(s).trim());
  const newLines = (edit.new || []).map((s) => String(s).trim());
  const tag = `#${i} ${oldLines[0]?.slice(0, 40) || ''}`;
  if (!oldLines.length || !newLines.length) {
    errors.push(`${tag} old/new 为空`);
    continue;
  }
  if (newLines.some((s) => s.includes('*/'))) {
    errors.push(`${tag} 新注释含 */`);
    continue;
  }
  const hits = [];
  for (let j = 0; j + oldLines.length <= lines.length; j++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (lines[j + k].trim() !== oldLines[k] || !isLineComment(lines[j + k])) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(j);
  }
  if (hits.length !== 1) {
    errors.push(`${tag} 匹配数=${hits.length}（要求唯一）`);
    continue;
  }
  const at = hits[0];
  const indent = (lines[at].match(/^\s*/) || [''])[0];
  const block = newLines.map((t) => indent + (t.startsWith('//') ? t : '// ' + t));
  lines.splice(at, oldLines.length, ...block);
  replaced++;
  removed += oldLines.length;
  added += block.length;
}

if (!dry && replaced > 0) fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(
  `REWRITE file=${path.relative('d:\\code\\opensource\\uv', file)} replaced=${replaced} oldLines=${removed} newLines=${added} errors=${errors.length}${dry ? ' (dry)' : ''}`,
);
for (const e of errors) console.log('  ! ' + e);
process.exit(errors.length ? 1 : 0);
