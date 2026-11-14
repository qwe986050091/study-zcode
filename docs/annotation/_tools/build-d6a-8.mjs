import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [0, '// See `min_stack_size` doc comment about `main2`', [
    '根据运行环境计算主线程所需的最小栈大小。',
    '[不变量] 栈太小会在深层递归解析时溢出。',
    '[边界] 该值只影响运行时线程，不改变用户可见行为。',
    '[维护] 计算规则与平台差异集中在 min_stack_size 中。',
    '[权衡] 预留更大栈会占用更多虚拟内存，但换取稳定性。',
  ]],
  [0, 'let main2 = move || {', [
    '把运行时构造与主流程封装为可移动闭包。',
    '[不变量] 闭包捕获已解析的 Cli 与最小栈大小。',
    '[边界] 该闭包在可能更大的栈线程上执行。',
    '[维护] 新增启动期参数时应通过捕获传入，而不是读取全局。',
  ]],
];

const items = blocks.map(([line, expect, lines]) => {
  if (line === 0) {
    const hits = [];
    src.forEach((l, i) => {
      if (l.trim() === expect.trim()) hits.push(i);
    });
    if (hits.length !== 1) throw new Error(`search not unique (${hits.length}): ${expect}`);
    return { line: hits[0] + 1, anchor: src[hits[0]], lines };
  }
  const actual = src[line - 1];
  const prefix = expect.trim().split(' {')[0];
  if (!actual || !actual.trim().startsWith(prefix)) {
    throw new Error(`line ${line} mismatch: ${JSON.stringify(actual)} !~ ${prefix}`);
  }
  return { line, anchor: actual, lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-8.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
