// R51 注释插入：按「原始行号 + 锚点校验」在函数体首行之前插入整行 // 注释。
// 只增行、不改行；沿用文件自身的换行符（CRLF），避免 crlfMixed。
// 用法：node tmp_r51_insert.mjs <data.json> [--dry]
import fs from 'node:fs';

const [dataPath, ...flags] = process.argv.slice(2);
if (!dataPath) { console.error('usage: node tmp_r51_insert.mjs <data.json> [--dry]'); process.exit(2); }
const dry = flags.includes('--dry');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8').replace(/^\uFEFF/, ''));

let inserted = 0, errors = 0;
for (const f of data.files) {
  const file = f.path;
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const edits = [...f.edits].sort((a, b) => b.line - a.line);
  let n = 0;
  for (const e of edits) {
    const idx = e.line - 1;
    const actual = lines[idx];
    if (actual === undefined || actual.trim() !== String(e.anchor).trim()) {
      console.log(`  ! ${file}#${e.line} 锚点不匹配：实际=${JSON.stringify(actual)} 期望=${JSON.stringify(e.anchor)}`);
      errors++; continue;
    }
    const indent = (actual.match(/^\s*/) || [''])[0];
    const block = (e.comments || []).map((c) => {
      const t = String(c).trim();
      return indent + (t.startsWith('//') ? t : '// ' + t);
    });
    if (!block.length) { console.log(`  ! ${file}#${e.line} comments 为空`); errors++; continue; }
    lines.splice(idx, 0, ...block);
    n += block.length; inserted += block.length;
  }
  if (!dry && n > 0) fs.writeFileSync(file, lines.join(eol), 'utf8');
  console.log(`${file}: inserted=${n}`);
}
console.log(`TOTAL inserted=${inserted} errors=${errors}${dry ? ' (dry)' : ''}`);
process.exit(errors ? 1 : 0);
