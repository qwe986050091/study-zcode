// 把误插在 #[error(...)] 属性参数内部的注释块整体上移到属性上一行。
// 只移动本批新增的注释行，不触碰任何原有代码行。
import fs from 'node:fs';

const target = 'd:\\code\\opensource\\uv\\crates\\uv-resolver\\src\\error.rs';
const text = fs.readFileSync(target, 'utf8');
const hadTrailingNewline = text.endsWith('\n');
let lines = text.split('\n');
if (hadTrailingNewline) lines.pop();
const before = lines.length;

const blocks = [
  [
    '// 同一个包被指向多个不同的 URL，解析器无法替用户做出选择。',
    '// 环境信息一并输出，因为这类冲突常常只在某个 fork 下才暴露。',
    '// 可编辑安装单独标注，提醒它指向本地目录而不是可下载的归档。',
  ],
  [
    '// 同一包在不同索引上对应不同来源，且差异与环境相关。',
    '// 索引逐条列出而不是拼成一行，便于用户直接核对是哪个源配置错了。',
  ],
];

for (const block of blocks) {
  const start = lines.findIndex((l) => l.replace(/\r$/, '') === `        ${block[0]}`);
  if (start < 0) throw new Error(`block not found: ${block[0]}`);
  // 校验整块内容
  for (let k = 0; k < block.length; k++) {
    if (lines[start + k].replace(/\r$/, '') !== `        ${block[k]}`) {
      throw new Error(`block mismatch at ${start + k}`);
    }
  }
  // 向上找最近的 #[error( 行
  let attr = -1;
  for (let i = start - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('#[error(')) {
      attr = i;
      break;
    }
  }
  if (attr < 0) throw new Error('attribute not found');
  if (lines[attr - 1] !== undefined && lines[attr - 1].trim() === block[0]) {
    throw new Error('already moved');
  }
  // 先删除原块，再在属性行前插入
  lines.splice(start, block.length);
  lines.splice(attr, 0, ...block.map((l) => `    ${l}`));
}

if (lines.length !== before) throw new Error(`line count changed: ${before} -> ${lines.length}`);
fs.writeFileSync(target, lines.join('\n') + (hadTrailingNewline ? '\n' : ''));
console.log(`MOVED blocks=${blocks.length} lines=${before}`);
