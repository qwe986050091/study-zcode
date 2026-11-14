import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [3624, '#[cfg(windows)]', [
    'Windows 下安装未处理异常处理器。',
    '[不变量] 仅在 Windows 编译，其它平台不引入该依赖。',
    '[边界] 处理器只影响崩溃时的展示，不改变正常流程。',
    '[维护] 该调用必须早于任何可能崩溃的初始化。',
  ]],
  [3627, '// Set the `UV` variable to the current executable so it is implicitly propagated to all child', [
    '把当前可执行文件路径写入 UV 环境变量。',
    '[不变量] 子进程可通过该变量找到同一个 uv 可执行文件。',
    '[边界] 获取当前路径失败时静默跳过，不阻断启动。',
    '[维护] 写入环境变量在 Rust 2024 中属于 unsafe 操作，需保留说明。',
    '[权衡] 用环境变量传播而非参数传递，兼容任意子进程启动方式。',
  ]],
  [3652, '// Configure a printer for failures that escape command execution. The resolved `no_progress`', [
    '为逃逸出命令执行的错误构造输出器。',
    '[不变量] 此处直接读取原始 CLI 参数，因为设置尚未解析。',
    '[边界] no_progress 只影响进度，不影响错误文本。',
    '[维护] 该输出器与 run 内部构造的相互独立，参数口径需保持一致。',
    '[权衡] 提前构造是为了让解析失败也能带样式输出。',
  ]],
];

const items = blocks.map(([line, expect, lines]) => {
  const actual = src[line - 1];
  const prefix = expect.trim().split(' {')[0];
  if (!actual || !actual.trim().startsWith(prefix)) {
    throw new Error(`line ${line} mismatch: ${JSON.stringify(actual)} !~ ${prefix}`);
  }
  return { line, anchor: actual, lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-7.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
