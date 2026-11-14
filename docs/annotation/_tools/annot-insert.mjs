// 按「原始行号 + 锚点校验」插入 `//` 注释行。只增行，不改动任何代码行。
// 用法：node annot-insert.mjs <data.json> [--dry]
// data.json: { "edits": [ { "line": 43, "anchor": "Io(#[from] io::Error),", "comments": ["..."] } ] }
// 从大到小插入，保证原始行号在插入过程中始终有效。
import fs from 'node:fs';

const [dataPath, ...flags] = process.argv.slice(2);
if (!dataPath) {
  console.error('usage: node annot-insert.mjs <data.json> [--dry]');
  process.exit(2);
}
const dry = flags.includes('--dry');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8').replace(/^\uFEFF/, ''));
const file = 'd:\\code\\opensource\\uv\\crates\\uv-cache\\src\\lib.rs';
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const errors = [];
const edits = [...data.edits].sort((a, b) => b.line - a.line);
let inserted = 0;
for (const e of edits) {
  const idx = e.line - 1;
  const actual = lines[idx];
  const comments = e.comments || [];
  if (!comments.length) {
    errors.push(`#${e.line} comments 为空`);
    continue;
  }
  if (comments.some((c) => String(c).includes('*/'))) {
    errors.push(`#${e.line} 注释含 */`);
    continue;
  }
  if (actual === undefined || actual.trim() !== String(e.anchor).trim()) {
    errors.push(`#${e.line} 锚点不匹配：实际=${JSON.stringify(actual)} 期望=${JSON.stringify(e.anchor)}`);
    continue;
  }
  const indent = (actual.match(/^\s*/) || [''])[0];
  const block = comments.map((c) => {
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
