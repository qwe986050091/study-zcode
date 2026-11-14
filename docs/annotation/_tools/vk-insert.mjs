// VK 批次注释插入器：按「唯一锚点」在指定行前/后插入整行注释，绝不改写原行。
// 用法：node vk-insert.mjs <spec.json>
// spec: [ { file: 'src/sds.c', ops: [ { anchor: '...', pos: 'before'|'after', lines: ['...'] } ] } ]
// 约束：
//   1) 每个 anchor 必须在文件中恰好出现 1 次（不唯一直接报错退出，不写文件）；
//   2) 只插入整行，行尾统一 \n，不触碰任何既有字节；
//   3) 插入行不得以非注释形态出现（由 vk-verify.mjs 二次把关）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\valkey';
const specFile = process.argv[2];
if (!specFile) {
  console.error('usage: node vk-insert.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const only = (process.argv[3] || '').split(',').filter(Boolean);

let total = 0;
for (const item of spec) {
  if (only.length && !only.includes(item.file)) continue;
  const file = path.join(ROOT, item.file.split('/').join(path.sep));
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  let lines = text.split(/\r?\n/);
  const trailingNewline = lines.length && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  const inserts = [];
  for (const op of item.ops) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === op.anchor) hits.push(i);
    }
    if (hits.length !== 1) {
      console.error(`ANCHOR ${item.file} hits=${hits.length} :: ${op.anchor}`);
      process.exit(2);
    }
    inserts.push({ index: hits[0] + (op.pos === 'after' ? 1 : 0), lines: op.lines });
  }
  // 同一 index 保持 spec 顺序；从后往前插，避免下标漂移
  inserts.sort((a, b) => b.index - a.index);
  for (const ins of inserts) {
    for (const l of ins.lines) {
      if (l.includes('\r') || l.includes('\n')) {
        console.error('BAD LINE (multi-line) in ' + item.file);
        process.exit(2);
      }
    }
    lines.splice(ins.index, 0, ...ins.lines);
    total += ins.lines.length;
  }
  fs.writeFileSync(file, (hadBom ? '\ufeff' : '') + lines.join(eol) + (trailingNewline ? eol : ''));
  console.log(`OK ${item.file} +${inserts.reduce((n, x) => n + x.lines.length, 0)}`);
}
console.log(`TOTAL +${total}`);
