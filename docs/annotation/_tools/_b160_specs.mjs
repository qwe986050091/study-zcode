import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/lib/shikiHighlighter.ts',
    target: 37,
    header: [
      '// INV-01 纯文本语言不启动高亮：守住位置 PLAIN_TEXT_CODE_LANGUAGES；改错故障 日志块进入异步状态机。',
      '// INV-02 语言名统一小写去空白：守住位置 trim 与 toLowerCase；改错故障 大小写不同判定不一致。',
      '// INV-03 别名归一到官方 id：守住位置 bundledLanguageAliases；改错故障 同一语言分裂两份缓存。',
      '// INV-04 未知语言回退兜底：守住位置 FALLBACK_CODE_LANGUAGE；改错故障 高亮器加载失败。',
      '// INV-05 高亮器按 主题加语言 缓存：守住位置 cacheKey；改错故障 重复创建实例泄漏。',
      '// INV-06 并发创建只留一个 Promise：守住位置 先读缓存；改错故障 同时发起多次加载。',
      '// INV-07 token 缓存键含长度与首尾：守住位置 getCodeTokensCacheKey；改错故障 长文碰撞串色。',
      '// INV-08 缓存命中走微任务回调：守住位置 queueMicrotask；改错故障 同步 setState 触发告警。',
      '// INV-09 未命中先登记订阅者：守住位置 subscribers.set；改错故障 高亮完成无人接收。',
      '// INV-10 加载完成后按订阅者广播：守住位置 for 循环；改错故障 同一代码块重复高亮。',
      '// INV-11 广播后立刻清空订阅：守住位置 subscribers.delete；改错故障 回调被重复调用。',
      '// INV-12 失败只记日志不抛：守住位置 catch 分支；改错故障 未捕获异常打断渲染。',
      '// INV-13 主题缺省跟随文档深色：守住位置 documentElement；改错故障 深浅主题错配。',
      '// INV-14 背景统一透明：守住位置 bg 字段；改错故障 代码块出现突兀底色。',
      '// INV-15 缺省前景继承父级：守住位置 fg 字段；改错故障 文本对比度不足。',
      '// INV-16 raw tokens 每行独立：守住位置 按换行切分；改错故障 空行被合并。',
      '// INV-17 诊断只读不写缓存：守住位置 registry 回调；改错故障 统计本身引入淘汰。',
      '// INV-18 同步返回命中值或空：守住位置 两处 return；改错故障 调用方误以为已有结果。',
      '//',
      '// 模块职责：把代码块按语言与主题分片高亮，并维护高亮器与 token 两级缓存。',
      '// 状态所有权：缓存与订阅者均为模块级单例，React 侧只订阅结果。',
      '// 阅读顺序：先看语言判定，再看缓存键，最后看订阅与失败路径。',
    ],
    blocks: [
      {
        anchor: 'export interface TokenizedCode {',
        lines: [
          '高亮结果固定三段。',
          '行内 token 保持二维结构。',
          '前后景各自兜底。',
        ],
      },
      {
        anchor: 'const bundledLanguageIds = new Set(Object.keys(bundledLanguages));',
        lines: [
          '官方 id 集合来自打包清单。',
          '别名映射扁平化后建表。',
          '两份集合都只读使用。',
        ],
      },
      {
        anchor: 'export function shouldUseSyntaxHighlighting(language: string): boolean {',
        lines: [
          '纯文本先短路。',
          '其余要求命中 id 或别名。',
          '判定与归一化保持同一套集合。',
        ],
      },
      {
        anchor: 'function normalizeCodeLanguage(language: string): BundledLanguage {',
        lines: [
          '空语言回退兜底。',
          '别名优先映射到官方 id。',
          '都未命中同样回退。',
        ],
      },
      {
        anchor: 'const highlighterCache = new Map<',
        lines: [
          '按 主题 加 语言 缓存 Promise。',
          '缓存的是创建过程而非实例。',
          '并发调用复用同一个实例。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/zcodeFileCitation.ts',
    target: 38,
    firstNth: 1,
    header: [
      '// INV-01 指令名固定单值：守住位置 DIRECTIVE_NAME；改错故障 解析不到任何引用。',
      '// INV-02 语法放宽三种冒号：守住位置 SYNTAX 常量；改错故障 模型输出变体全部失效。',
      '// INV-03 路径去空白后保留：守住位置 path 映射；改错故障 含空格路径被截断。',
      '// INV-04 目的为空也保留：守住位置 purpose 判断；改错故障 空串被当未提供。',
      '// INV-05 产物类型原样透传：守住位置 artifactKind 映射；改错故障 预览类型推断失真。',
      '// INV-06 无路径的指令不进结果：守住位置 flatMap 分支；改错故障 空路径卡片被渲染。',
      '// INV-07 仅流式尾部才隐藏：守住位置 streaming 判断；改错故障 终态正文被截短。',
      '// INV-08 空内容直接原样返回：守住位置 早退分支；改错故障 空消息被误判截断。',
      '// INV-09 代码块内样例不参与：守住位置 protectedRanges；改错故障 协议示例被吞。',
      '// INV-10 已闭合指令不移除：守住位置 unclosedStart 判断；改错故障 正常引用丢失。',
      '// INV-11 已换行的未闭合指令保留：守住位置 解析器边界；改错故障 后续回答整段消失。',
      '// INV-12 单冒号前缀长度固定：守住位置 SINGLE_COLON 常量；改错故障 前缀识别偏移。',
      '// INV-13 双指令名一起扫描：守住位置 code-comment 数组；改错故障 前缀被提前截断。',
      '// INV-14 扩展名匹配忽略大小写：守住位置 toLowerCase；改错故障 大写后缀无法预览。',
      '// INV-15 扩展名表按后缀匹配：守住位置 endsWith 循环；改错故障 相似后缀误判。',
      '// INV-16 无产物类型时用推断值：守住位置 undefined 分支；改错故障 可预览文件退回无预览。',
      '// INV-17 产物类型与推断需一致：守住位置 相等比较；改错故障 错配文件打开失败。',
      '// INV-18 不一致返回空表示不可预览：守住位置 末行返回；改错故障 错误类型传给预览器。',
      '//',
      '// 模块职责：解析正文里的文件引用指令，并决定流式阶段可见文本的截断位置。',
      '// 状态所有权：无状态；全部导出均为纯函数。',
      '// 阅读顺序：先看指令提取，再看流式投影，最后看预览类型推断。',
    ],
    blocks: [
      {
        anchor: 'export type ZCodeFileCitationPreviewKind = "docx" | "xlsx" | "pptx" | "pdf" | "video" | "audio";',
        lines: [
          '预览类型是封闭集合。',
          '新增类型需同步扩展名表。',
          '产物类型与预览类型分开映射。',
        ],
      },
      {
        anchor: 'export interface ZCodeFileCitation {',
        lines: [
          '位置区间用于正文替换。',
          '原始片段保留便于回显。',
          '路径为必填项。',
        ],
      },
      {
        anchor: 'export function extractZCodeFileCitationDirectives(content: string): ZCodeFileCitationDirective[] {',
        lines: [
          '委托通用指令解析器。',
          '只保留有意义的可选字段。',
          '空白路径视为未提供。',
        ],
      },
      {
        anchor: '  if (!options.streaming || !content) return { visibleText: content };',
        lines: [
          '终态与空内容都不截断。',
          '只有流式尾部才可能隐藏。',
          '保护区间先于截断计算。',
          '命中未闭合起点才切片。',
        ],
      },
      {
        anchor: 'function inferPreviewKindFromPath(path: string): ZCodeFileCitationPreviewKind | null {',
        lines: [
          '路径先归一化。',
          '按扩展名表逐个比对。',
          '首个命中即返回，未命中返回空。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/lib/zcodeSessionEventOrder.ts',
    target: 37,
    header: [
      '// INV-01 去重窗口有上限：守住位置 MAX_TRACKED；改错故障 长会话内存无界增长。',
      '// INV-02 超出上限只淘汰最旧：守住位置 shift；改错故障 新事件被误删。',
      '// INV-03 已投递 id 不进队列：守住位置 ids.has；改错故障 重放事件被二次渲染。',
      '// INV-04 首次事件锁定起始序号：守住位置 nextSeq 赋值；改错故障 历史事件全部丢弃。',
      '// INV-05 小于水位的序号视为重复：守住位置 比较分支；改错故障 旧事件插回正文。',
      '// INV-06 同序号只保留一份：守住位置 pendingEvents.has；改错故障 同一增量重复应用。',
      '// INV-07 连续序号才放行：守住位置 while 循环；改错故障 缺口被静默跳过。',
      '// INV-08 缺口只在有后续时报告：守住位置 currentGap；改错故障 空洞被误报重启。',
      '// INV-09 缺口取最小待处理序号：守住位置 Math.min；改错故障 报错位置偏移。',
      '// INV-10 快照水位只进不退：守住位置 Math.max；改错故障 回退导致事件重放。',
      '// INV-11 快照序号加一作为水位：守住位置 nextSnapshotSeq；改错故障 快照事件被当新事件。',
      '// INV-12 负序号快照忽略：守住位置 seq 小于零分支；改错故障 水位被置成零。',
      '// INV-13 保留模式只保留水位前的：守住位置 filter；改错故障 首段正文在切换会话时丢失。',
      '// INV-14 保留事件先删后放：守住位置 delete 调用；改错故障 同一事件被放行两次。',
      '// INV-15 非保留模式清掉旧序号：守住位置 keys 遍历；改错故障 过期事件占住水位。',
      '// INV-16 清空后水位归零：守住位置 clearPendingAfterGap；改错故障 重连后从旧水位继续。',
      '// INV-17 非正序号事件直接放行：守住位置 seq 判断；改错故障 本地事件被去重吞掉。',
      '// INV-18 缺口释放按序号排序：守住位置 sort；改错故障 乱序放行打乱正文。',
      '//',
      '// 模块职责：为会话事件流提供去重、序号排序与缺口检测闸门。',
      '// 状态所有权：每个 gate 实例独占自己的集合与水位。',
      '// 阅读顺序：先看单事件入队，再看快照水位，最后看缺口释放。',
    ],
    blocks: [
      {
        anchor: 'const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;',
        lines: [
          '窗口上限固定一万。',
          '覆盖单会话的重放跨度。',
          '超出后按先后淘汰。',
        ],
      },
      {
        anchor: 'export interface ZCodeSessionEventGap {',
        lines: [
          '缺口同时给出期望与实收。',
          '两侧都是服务端序号。',
          '仅用于诊断与续传提示。',
        ],
      },
      {
        anchor: 'export interface ZCodeSessionEventOrderGate {',
        lines: [
          '写入口只有 push 与快照标记。',
          '缺口读取与释放分离。',
          '清空用于重连后的重置。',
        ],
      },
      {
        anchor: 'function rememberBoundedId(ids: Set<string>, order: string[], id: string): boolean {',
        lines: [
          '已存在返回假。',
          '新增同时维护顺序表。',
          '超限从最旧开始删。',
        ],
      },
      {
        anchor: 'export function createZCodeSessionEventOrderGate(): ZCodeSessionEventOrderGate {',
        lines: [
          '闭包持有四份状态。',
          '水位为空表示尚未开始。',
          '返回值只暴露约定方法。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-workflow/useWorkflowRunSave.ts',
    target: 38,
    header: [
      '// INV-01 保存与再次运行同一控制器：守住位置 单一 hook；改错故障 卡片与侧板行为分叉。',
      '// INV-02 目标对象按工作区身份构造：守住位置 useMemo 依赖；改错故障 远程会话丢失身份。',
      '// INV-03 远程会话字段缺省不写：守住位置 条件展开；改错故障 本地请求带上空远程 id。',
      '// INV-04 缓存键由工作区与 run 组成：守住位置 workflowRunSavedKey；改错故障 不同 run 互相覆盖。',
      '// INV-05 rpc 未就绪不发查询：守住位置 rpcReady 判断；改错故障 启动期请求失败。',
      '// INV-06 代际变化触发重查：守住位置 generation 依赖；改错故障 删除后卡片仍显示已保存。',
      '// INV-07 查询结果写入共享缓存：守住位置 load 回调；改错故障 卡片各自请求。',
      '// INV-08 保存中状态只包住请求：守住位置 try/finally；改错故障 失败后按钮永久禁用。',
      '// INV-09 保存成功立即回填缓存：守住位置 applySaved；改错故障 卡片停留在未保存。',
      '// INV-10 回填字段与入参一致：守住位置 meta 展开；改错故障 描述与保存值不符。',
      '// INV-11 覆盖写出参原样透传：守住位置 overwrite 展开；改错故障 用户选择被忽略。',
      '// INV-12 重名探测失败不阻断：守住位置 catch 返回假；改错故障 网络抖动挡住保存。',
      '// INV-13 启动器统一构造：守住位置 useSavedWorkflowLauncher；改错故障 两条启动路径参数不同。',
      '// INV-14 显式目标优先于默认：守住位置 launchTarget 判断；改错故障 从历史运行启动跑错工作区。',
      '// INV-15 有会话才解析项目绑定：守住位置 sessionId 判断；改错故障 无会话时多余请求。',
      '// INV-16 项目服务缺失显式报错：守住位置 throw；改错故障 静默回退到错误目录。',
      '// INV-17 启动结果收敛为判别联合：守住位置 ok 三元；改错故障 调用方拿到未定义错误。',
      '// INV-18 对外字段全部来自缓存快照：守住位置 返回值展开；改错故障 展示态与实际不一致。',
      '//',
      '// 模块职责：把完成卡与侧板的保存、重名探测与再次运行收敛成一套动作。',
      '// 状态所有权：保存结果归 workflowRunSavedStore；本 hook 只做编排与瞬时态。',
      '// 阅读顺序：先看目标与缓存键，再看查询与保存，最后看启动器接线。',
    ],
    blocks: [
      {
        anchor: 'export function useWorkflowRunSave(host: WorkflowRunSaveHost): WorkflowRunSaveController {',
        lines: [
          '入参只带工作区与 run 线索。',
          '服务解析统一走工作区 hook。',
          '远程标记决定作用域是否锁定。',
        ],
      },
      {
        anchor: '  const target = useMemo<WorkflowRunSaveTarget>(',
        lines: [
          '目标对象按依赖缓存。',
          '身份与远程 id 缺省不落字段。',
          '同一 run 复用同一引用。',
        ],
      },
      {
        anchor: '  useEffect(() => {',
        lines: [
          'rpc 未就绪先跳过。',
          '代际变化强制重查。',
          '结果交由 store 幂等写入。',
        ],
      },
      {
        anchor: '  const save = useCallback(',
        lines: [
          '进入即置为保存中。',
          '成功后立刻回填缓存。',
          '回填字段与入参保持一致。',
          '无论成败都复位标记。',
        ],
      },
      {
        anchor: '  const launch = useCallback(',
        lines: [
          '显式目标优先于默认目标。',
          '有会话时补项目绑定。',
          '结果收敛为成功或带错误的判别值。',
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
    `ZC-deep-b160-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
