import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [2628, '// Write out any resolved settings.', [
    '项目命令内部的设置展示宏。',
    '[不变量] 与顶层宏语义一致，只保留「打印并成功返回」一种形态。',
    '[边界] 项目命令不需要「打印后继续」的场景。',
    '[维护] 两个宏需保持输出格式一致，避免出现两种风格。',
    '[权衡] 复制宏而非共享，是为了避免跨函数作用域的参数传递。',
  ]],
  [2638, '// Load environment variables not handled by Clap', [
    '项目命令同样需要自行加载未由 Clap 处理的环境变量。',
    '[不变量] 加载结果在任何设置解析之前就绪。',
    '[边界] 该环境对象与顶层 run 中的相互独立。',
    '[维护] 新增环境变量时应同时更新两处加载逻辑。',
  ]],
  [2641, 'match *project_command {', [
    '按项目子命令分派。',
    '[不变量] 所有分支共享同一份环境与文件系统配置。',
    '[边界] 每个分支自行决定是否初始化缓存。',
    '[维护] 新增分支时需同时补充设置解析与命令调用。',
  ]],
  [2670, '// Initialize the cache.', [
    '按需初始化缓存。',
    '[不变量] 只读命令也常需要缓存来存放解析中间结果。',
    '[边界] 初始化失败会直接终止当前命令。',
    '[维护] 缓存初始化应尽量靠后，避免无谓的目录创建。',
  ]],
  [3468, '// Unwrap the script.', [
    '把脚本项转换为审计所需的脚本形态。',
    '[不变量] 标准输入与远程文件在审计中不可达，使用 unreachable 断言。',
    '[边界] 该转换不读取脚本内容，只做形态收窄。',
    '[维护] 若未来支持远程脚本审计，需要替换这两个断言。',
  ]],
  [3617, '// `std::env::args` is not `Send` so we parse before passing to our runtime', [
    '参数解析必须在进入异步运行时之前完成。',
    '[不变量] std::env::args 不实现 Send，不能跨线程传递。',
    '[边界] 解析结果是 Send 的 Cli，可安全移入运行时。',
    '[维护] 该顺序不可颠倒，否则编译期即失败。',
  ]],
  [3638, 'let runtime = tokio::runtime::Builder::new_current_thread()', [
    '构造单线程异步运行时。',
    '[不变量] CLI 场景以 IO 为主，单线程足以覆盖并发需求。',
    '[边界] 阻塞型工作在内部通过专用线程池卸载。',
    '[权衡] 单线程运行时启动更快、资源占用更低。',
    '[维护] 若引入需要多线程调度的特性，需重新评估此选择。',
  ]],
  [3644, 'let result = runtime.block_on(Box::pin(run(cli, GlobalInitialization::Initialize)));', [
    '在运行时内驱动主流程直到完成。',
    '[不变量] run 的所有异步操作都在此运行时中执行。',
    '[边界] Box::pin 用于控制 Future 大小，避免栈溢出。',
    '[维护] 该调用是唯一的顶层驱动点。',
    '[不变量] 返回结果保留原始错误类型，供后续统一渲染。',
  ]],
  [3650, 'runtime.shutdown_background();', [
    '后台关闭运行时，不等待残留任务。',
    '[不变量] 进程即将退出，无需等待清理。',
    '[边界] 未完成的阻塞任务会被直接丢弃。',
    '[维护] 该选择避免退出时卡在悬挂的 IO 上。',
    '[权衡] 以「快速退出」换取向运行时保证优雅收尾。',
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

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-6.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
