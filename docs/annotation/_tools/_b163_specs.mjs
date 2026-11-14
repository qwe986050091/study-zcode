import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/deps.ts',
    target: 39,
    firstNth: 1,
    header: [
      '// INV-01 runtime 的外部依赖只走本门面：守住位置 全部 re-export；改错故障 深引内部模块导致替换点扩散。',
      '// INV-02 本文件不持有状态：守住位置 仅导出与三个纯函数；改错故障 模块级缓存污染多次运行。',
      '// INV-03 本文件不做 I/O：守住位置 无文件与网络调用；改错故障 导入即产生副作用。',
      '// INV-04 queryId 前缀固定：守住位置 模板字符串；改错故障 日志检索规则失效。',
      '// INV-05 queryId 用随机 UUID：守住位置 crypto.randomUUID；改错故障 并发查询标识碰撞。',
      '// INV-06 子上下文强制继承父 queryId：守住位置 queryId 覆盖表达式；改错故障 同一查询的子步骤断链。',
      '// INV-07 显式覆盖优先于继承：守住位置 空值合并顺序；改错故障 调用方无法纠正上下文。',
      '// INV-08 子上下文其余字段原样派生：守住位置 契约层实现；改错故障 会话与回合标识丢失。',
      '// INV-09 属性覆盖保持浅合并：守住位置 options 透传；改错故障 深度合并引入意外键。',
      '// INV-10 日志投影只搬运标识：守住位置 字段展开；改错故障 用户内容进入日志。',
      '// INV-11 日志投影补齐 queryId：守住位置 显式赋值；改错故障 按查询过滤失效。',
      '// INV-12 缺字段保持未定义：守住位置 不补默认值；改错故障 日志出现虚假空值。',
      '// INV-13 契约值只从契约包转出：守住位置 export 列表；改错故障 本地另造同义实现。',
      '// INV-14 契约类型与值分区转出：守住位置 两个 export 块；改错故障 类型被当运行时而报错。',
      '// INV-15 core 内部实现不承诺对外稳定：守住位置 第二段说明；改错故障 外部直接被内部签名绑定。',
      '// INV-16 新增依赖先在此登记：守住位置 文件说明；改错故障 依赖清单与实际引用漂移。',
      '// INV-17 转出顺序按来源分组：守住位置 三段导出；改错故障 审查时无法区分契约与实现。',
      '// INV-18 本文件不定义 runtime 私有类型：守住位置 纯转出；改错故障 私有类型泄漏成公共契约。',
      '//',
      '// 模块职责：runtime 层唯一依赖门面，集中转出契约包与 core 内部实现。',
      '// 状态所有权：无状态；三个本地函数均为纯构造。',
      '// 阅读顺序：先看文件头定位说明，再看三个工具函数，最后看两段转出清单。',
    ],
    blocks: [
      {
        anchor: 'export function createQueryId(): ContractQueryId {',
        lines: [
          '格式固定为 query 前缀加 UUID。',
          '不使用全局计数器。',
          '不读取任何外部配置。',
          '同一进程内多次调用互不相关。',
        ],
      },
      {
        anchor: 'export function createChildTraceContext(',
        lines: [
          '父上下文是必填入参。',
          '覆盖项全部可选。',
          '默认值落在空对象上。',
          '先交给契约层派生。',
          '再用覆盖值修正 queryId。',
        ],
      },
      {
        anchor: 'export function traceContextToLogContext(context: ContractTraceContext): ContractLogContext {',
        lines: [
          '先取契约层投影。',
          '再补上 queryId。',
          '不写入用户内容。',
          '缺字段保持原样。',
        ],
      },
      {
        anchor: 'export type { ToolCall, TurnAttachment, TurnState } from "../agent/turn-state.js";',
        lines: [
          '内部实现的转出从这里开始。',
          '类型与值分开声明。',
          '签名变化需要 runtime 同步评审。',
          '这里不额外包装实现。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/executor/result-display.ts',
    target: 41,
    firstNth: 1,
    header: [
      '// INV-01 display 与 modelContent 两条通道：守住位置 文件头说明；改错故障 展示约束反过来压缩模型上下文。',
      '// INV-02 display 每个字段自带上限：守住位置 各常量；改错故障 单条事件携带数百 KB。',
      '// INV-03 分派按专用到通用：守住位置 createToolResultDisplay 顺序；改错故障 文件 diff 抢走 Bash 结果。',
      '// INV-04 MCP 先于本地工具名：守住位置 mcp 分支位置；改错故障 同名工具显示成错误卡片。',
      '// INV-05 解析失败一律返回未定义：守住位置 safeParse 分支；改错故障 展示构造失败拖垮工具执行。',
      '// INV-06 MCP 元数据缺失直接放弃：守住位置 metadata 判空；改错故障 空工具卡占用界面。',
      '// INV-07 服务器名与工具名都必需：守住位置 双字段判空；改错故障 工具卡无法归因。',
      '// INV-08 官方不可用标识仅官方通道可读：守住位置 official 判断；改错故障 第三方伪造提示诱导购买。',
      '// INV-09 错误标识必须 isError 且 content 为数组：守住位置 三条件与判断；改错故障 正常结果被误判。',
      '// INV-10 JSON 投影超限整体省略：守住位置 boundJsonText；改错故障 半截 JSON 进入持久化。',
      '// INV-11 截断字节数累加记录：守住位置 dropped 归约；改错故障 界面无法判断省略规模。',
      '// INV-12 布尔字段只投影真值：守住位置 展开条件；改错故障 metadata 出现大量假值键。',
      '// INV-13 文本边界避开代理对：守住位置 boundMcpDisplayText；改错故障 持久化出现孤立代理项。',
      '// INV-14 CUA 名称归一化后再识别：守住位置 小写与替换；改错故障 插件命名空间工具不被识别。',
      '// INV-15 媒体按解码后字节计配额：守住位置 base64 长度；改错故障 实际传输体积被低估。',
      '// INV-16 媒体数量有硬上限：守住位置 长度判断；改错故障 一次事件塞入过多截图。',
      '// INV-17 diff 行数与块数双上限：守住位置 两个常量；改错故障 大补丁撑爆历史快照。',
      '// INV-18 半截块后立即停止：守住位置 截断后 break；改错故障 UI 混排完整与残缺块。',
      '//',
      '// 模块职责：把工具输出投影成前端可渲染的有界展示载荷。',
      '// 状态所有权：无状态；全部为纯构造，失败即返回未定义。',
      '// 阅读顺序：先看分派顺序，再看 MCP 与 CUA 投影，最后看 diff 限量。',
    ],
    blocks: [
      {
        anchor: 'const MAX_DISPLAY_DIFF_HUNKS = 8;',
        lines: [
          'diff 块数上限八。',
          '总行数上限一百六十。',
          '两个上限独立生效。',
          '上限只约束展示通道。',
          '与模型上下文预算无关。',
        ],
      },
      {
        anchor: 'export function createToolResultDisplay(',
        lines: [
          'Bash 分支最先短路。',
          'CUA 按名字子串识别。',
          'node_repl 与工作流依次尝试。',
          'MCP 分支优先于本地工具名。',
          '全部未命中才走通用 diff。',
        ],
      },
      {
        anchor: 'function boundMcpDisplayText(value: string, maxChars: number): string | undefined {',
        lines: [
          '先裁剪首尾空白。',
          '空串视为未提供。',
          '按字符数截断。',
          '截断点落在高位代理时回退一位。',
          '保证字符串可安全序列化。',
        ],
      },
      {
        anchor: 'function boundDiffHunks(hunks: DiffHunk[]): { patch: DiffHunk[]; truncated: boolean } {',
        lines: [
          '先按块数切分。',
          '再按剩余行数分配。',
          '行配额耗尽立即标记截断。',
          '遇到半截块就停止追加。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts',
    target: 37,
    header: [
      '// INV-01 本层只做展示映射：守住位置 toBashOutput 职责；改错故障 命令语义被展示逻辑改写。',
      '// INV-02 provider 错误不识别图片：守住位置 providerError 分支；改错故障 错误输出被当截图展示。',
      '// INV-03 provider 错误不加限流提示：守住位置 三元分支；改错故障 错误文案里的字样误触发提示。',
      '// INV-04 正常路径先剥离提示行：守住位置 stripClaudeCodeHintLines；改错故障 模型看到注入残留。',
      '// INV-05 持久化大小用截断前字节：守住位置 bytes 字段；改错故障 展示值与真实观测不符。',
      '// INV-06 持久化路径优先取标准输出：守住位置 空值合并；改错故障 双流时路径指向错误一侧。',
      '// INV-07 标准错误回退到错误消息：守住位置 逻辑或链；改错故障 失败信息丢失。',
      '// INV-08 工作目录提示追加在尾部：守住位置 appendBashCwdStderrSuffix；改错故障 提示混入正文开头。',
      '// INV-09 超时与取消都标中断：守住位置 interrupted 表达式；改错故障 前端显示为失败而非未完成。',
      '// INV-10 静默命令不提示无输出：守住位置 isSilentBashCommand；改错故障 cd 也被标记为空结果。',
      '// INV-11 图片存在才标记图片：守住位置 isImage 判断；改错故障 空图卡占用界面。',
      '// INV-12 退出码解释随结果下发：守住位置 returnCodeInterpretation；改错故障 前端自行猜测语义。',
      '// INV-13 限流提示只在命中时占字段：守住位置 条件展开；改错故障 空字段污染输出契约。',
      '// INV-14 遥测不记录命令原文：守住位置 只取分类与哈希；改错故障 敏感参数进入遥测。',
      '// INV-15 耗时统一取非负整数：守住位置 roundNonNegativeMs；改错故障 出现负耗时。',
      '// INV-16 首输出耗时缺省回落总耗时：守住位置 noOutputMs；改错故障 指标出现空值断层。',
      '// INV-17 后台任务单独标记状态：守住位置 backgrounded 常量；改错故障 后台命令显示为已完成。',
      '// INV-18 状态映射超时优先于取消：守住位置 判断顺序；改错故障 同时发生时报错归因错误。',
      '//',
      '// 模块职责：把执行结果映射成 BashOutput 契约，并附加图片、提示与遥测。',
      '// 状态所有权：无状态；所有派生值都在单次调用内计算。',
      '// 阅读顺序：先看主映射，再看遥测构造，最后看状态归一。',
    ],
    blocks: [
      {
        anchor: 'export async function toBashOutput(',
        lines: [
          '两条输出流的路径分别保留。',
          '合并路径只取先命中一侧。',
          '标准错误空时回退到错误消息。',
          '图片识别只在正常路径执行。',
          '返回前统一挂上遥测。',
        ],
      },
      {
        anchor: 'function createBashPerformanceTelemetry(',
        lines: [
          '字节数取两流之和。',
          '首输出耗时来自进度回调。',
          '分类与哈希代替命令原文。',
          '状态经归一函数产出。',
          '遥测可为空表示不采集。',
        ],
      },
      {
        anchor: 'function resolveBashCommandStatus(',
        lines: [
          '超时优先判定。',
          '其次判定取消。',
          '完成但退出码非零记为失败。',
          '其余直接沿用执行层状态。',
          '未知状态不做额外推断。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts',
    target: 36,
    header: [
      '// INV-01 前置参数只跳过不解释：守住位置 FRONT 表；改错故障 配置内容被当作命令解析。',
      '// INV-02 前置不支持即整条放弃：守住位置 front.unsupported；改错故障 误判为安全命令。',
      '// INV-03 前置操作数动态即放弃：守住位置 dynamic 判断；改错故障 变量拼出的命令被放行。',
      '// INV-04 未识别子命令返回未定义：守住位置 default 分支；改错故障 未知命令默认安全。',
      '// INV-05 帮助标志视为查询退出：守住位置 hasHelp 判断；改错故障 帮助请求被当成危险操作。',
      '// INV-06 干扰项取反优先：守住位置 enabled 第三参；改错故障 --no-force 仍判强推。',
      '// INV-07 试运行抑制破坏判定：守住位置 dryRun 合取；改错故障 dry-run 被拦截。',
      '// INV-08 reset 只认硬重置：守住位置 hard 标志；改错故障 软重置也被要求确认。',
      '// INV-09 clean 需强制且非试运行：守住位置 合取条件；改错故障 预演被拦或真删被放。',
      '// INV-10 push 证据三选一：守住位置 析取条件；改错故障 漏判镜像或租约强推。',
      '// INV-11 repo 参数改变操作数含义：守住位置 refspecs 分支；改错故障 首个操作数被误当远端。',
      '// INV-12 加号前缀即强推证据：守住位置 startsWith；改错故障 glob 场景漏判。',
      '// INV-13 checkout 命中工作树即破坏：守住位置 TREE 集合；改错故障 覆盖未提交修改。',
      '// INV-14 restore 仅暂存区不判破坏：守住位置 stagedOnly；改错故障 常规暂存被误拦。',
      '// INV-15 stash 只处理 clear：守住位置 子命令判断；改错故障 保存操作被当成删除。',
      '// INV-16 worktree 只处理强制删除：守住位置 remove 判断；改错故障 新建工作树被误拦。',
      '// INV-17 规则标识即契约键：守住位置 字符串常量；改错故障 审批文案与规则错配。',
      '// INV-18 解析器只读不改词：守住位置 words 入参；改错故障 调用方观察到被改写的参数。',
      '//',
      '// 模块职责：判定 git 子命令是否属于需要确认的破坏性操作。',
      '// 状态所有权：无状态；选项表为模块级只读常量。',
      '// 阅读顺序：先看前置参数处理，再看子命令分派，最后看各规则条件。',
    ],
    blocks: [
      {
        anchor: 'export function matchGit(words: CommandWord[]): RuleMatch {',
        lines: [
          '先剥离前置参数。',
          '前置不支持或动态即放弃判断。',
          '无子命令返回未命中。',
          '按子命令选择剩余选项表。',
          '最终结果交给结算函数。',
        ],
      },
      {
        anchor: 'const FRONT = optionTable(',
        lines: [
          '大表为无取值开关。',
          '第二组为必须取值的选项。',
          '第三组为可选取值。',
          '这里只描述文法不解释含义。',
        ],
      },
      {
        anchor: 'const dryRun = enabled(flags, ["-n", "--dry-run"], ["--no-dry-run"]);',
        lines: [
          '试运行可被显式取反。',
          '取反优先于肯定形式。',
          '该值参与多条规则合取。',
          '帮助标志在此前已短路。',
          '强推判定与试运行互相独立。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b163-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
