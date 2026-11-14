import fs from 'node:fs';

function patch(file, ops) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of ops) {
    const idx = text.indexOf(from);
    if (idx < 0) throw new Error('NOT_FOUND in ' + file + ': ' + from);
    if (text.indexOf(from, idx + 1) >= 0) throw new Error('AMBIGUOUS in ' + file + ': ' + from);
    text = text.slice(0, idx) + to + text.slice(idx + from.length);
  }
  fs.writeFileSync(file, text);
  console.log('PATCHED ' + file);
}

const session = 'd:\\code\\ZCode\\packages\\services\\src\\session\\';

// 清理误插入到块注释内部的单行注释，并在函数头补两条说明，净增 1 行。
patch(session + 'taskChangeSummary.ts', [
  [
    '/**\r\n// 每个轮次独立计算，互不影响。\r\n * 按轮次分组构建文件变更摘要。',
    '/**\r\n * 按轮次分组构建文件变更摘要。',
  ],
  [
    '// 只读入参，不修改快照数组本身。\r\n',
    '// 只读入参，不修改快照数组本身。\r\n// 每轮独立计算，轮次之间互不影响。\r\n// 快照先按路径聚合再算 diff，同文件只产出一条。\r\n',
  ],
]);

// 30.00% 贴线，补一条说明避免恰好压线。
patch(session + 'continuousStreamCoalescer.ts', [
  [
    '  let disposed = false;\r\n',
    '// disposed 之后 accept 静默丢弃，flush 仍可安全调用。\r\n  let disposed = false;\r\n',
  ],
]);
