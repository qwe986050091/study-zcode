// 按「原始行号」在指定行前插入整行注释，用于锚点不唯一（如 #endif、UNUSED(x);）的文件。
// 用法：node vk-insert-lines.mjs <spec.json>
// spec: [ { file: 'src/x.c', ops: [ { line: 18, expect: '#ifdef HAVE_ZSTD', lines: ['/* ... */'] } ] } ]
// 约束：
//   1) line 指插入前的原始行号；每批 ops 按行号降序应用，避免下标漂移；
//   2) expect 与当前行 trim 后必须完全相等，防止基线与行号错位；
//   3) 只插入整行，行尾沿用文件既有 EOL，不触碰任何既有字节。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\valkey';
const specFile = process.argv[2];
if (!specFile) {
  console.error('usage: node vk-insert-lines.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));

let total = 0;
for (const item of spec) {
  const file = path.join(ROOT, item.file.split('/').join(path.sep));
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  const ops = [...item.ops].sort((a, b) => b.line - a.line);
  for (const op of ops) {
    const cur = lines[op.line - 1];
    if (cur === undefined || cur.trim() !== op.expect) {
      console.error(`MISMATCH ${item.file}:${op.line}\n  expect: ${op.expect}\n  actual: ${cur}`);
      process.exit(2);
    }
    for (const l of op.lines) {
      if (l.includes('\r') || l.includes('\n')) {
        console.error('BAD LINE (multi-line) in ' + item.file);
        process.exit(2);
      }
    }
    lines.splice(op.line - 1, 0, ...op.lines);
    total += op.lines.length;
  }
  fs.writeFileSync(file, (hadBom ? '\ufeff' : '') + lines.join(eol) + (trailingNewline ? eol : ''));
  console.log(`OK ${item.file} +${ops.reduce((n, x) => n + x.lines.length, 0)}`);
}
console.log(`TOTAL +${total}`);
