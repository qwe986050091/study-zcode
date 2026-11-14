// 通用整行插入器：按原始行号降序插入 `//` 注释，只增行不改代码。
// 用法：node cc-insert.mjs <target-file> <data.json> [--dry]
// data.json: { "edits": [ { "line": 47, "anchor": "getHookEnvFilePath,", "comments": ["..."] } ] }
// anchor 与目标行 trim 后比较，防止行号漂移时插错位置。
import fs from 'node:fs';

const [file, dataPath, ...flags] = process.argv.slice(2);
if (!file || !dataPath) {
  console.error('usage: node cc-insert.mjs <target-file> <data.json> [--dry]');
  process.exit(2);
}
const dry = flags.includes('--dry');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8').replace(/^\uFEFF/, ''));
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const errors = [];
const seen = new Set();
const edits = [...data.edits].sort((a, b) => b.line - a.line);
let inserted = 0;
for (const e of edits) {
  if (seen.has(e.line)) { errors.push(`#${e.line} 重复 edit`); continue; }
  seen.add(e.line);
  const idx = e.line - 1;
  const actual = lines[idx];
  const comments = e.comments || [];
  if (!comments.length) { errors.push(`#${e.line} comments 为空`); continue; }
  if (comments.some(c => String(c).includes('*/'))) { errors.push(`#${e.line} 注释含 */`); continue; }
  if (comments.some(c => /(它|其|该|此|这里|上述|相关)/.test(String(c)))) { errors.push(`#${e.line} 注释含禁用代词`); continue; }
  if (actual === undefined || actual.trim() !== String(e.anchor).trim()) {
    errors.push(`#${e.line} 锚点不匹配：实际=${JSON.stringify(actual)} 期望=${JSON.stringify(e.anchor)}`);
    continue;
  }
  const indent = (actual.match(/^\s*/) || [''])[0];
  const block = comments.map(c => {
    const text = String(c).trim();
    return indent + (text.startsWith('//') ? text : '// ' + text);
  });
  lines.splice(idx, 0, ...block);
  inserted += block.length;
}
if (!dry && inserted > 0) fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(`INSERT inserted=${inserted} edits=${edits.length} errors=${errors.length}${dry ? ' (dry)' : ''}`);
for (const e of errors) console.log('  ! ' + e);
process.exit(errors.length ? 1 : 0);
