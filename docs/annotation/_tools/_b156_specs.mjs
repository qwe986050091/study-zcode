import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx',
    target: 40,
    header: [
      '// INV-01 卡片自身即按钮：守住位置 role 与 tabIndex；改错故障 键盘无法打开详情。',
      '// INV-02 只拦真实子控件：守住位置 interactive !== card；改错故障 整卡点击从未生效。',
      '// INV-03 点击与键盘共用判定：守住位置 isInteractiveDescendant；改错故障 两条路径行为分叉。',
      '// INV-04 键盘只认回车与空格：守住位置 key 判断；改错故障 任意键都打开详情。',
      '// INV-05 子控件键盘事件不重复：守住位置 提前返回；改错故障 一次按键打开两次。',
      '// INV-06 空格需阻止默认滚动：守住位置 preventDefault；改错故障 页面随空格滚动。',
      '// INV-07 无 markdown 时用通用输出：守住位置 hasMarkdown 分支；改错故障 卡片空白。',
      '// INV-08 失败态优先展示错误：守住位置 toolCall.output 判断；改错故障 错误被成功内容掩盖。',
      '// INV-09 复制前确认能力存在：守住位置 clipboard 判断；改错故障 无剪贴板环境抛错。',
      '// INV-10 复制成功才切换图标：守住位置 then 两支；改错故障 图标先于写入变化。',
      '// INV-11 复制按钮阻止冒泡：守住位置 stopPropagation；改错故障 点复制同时打开详情。',
      '// INV-12 查看全部同样阻止冒泡：守住位置 事件处理；改错故障 重复打开面板。',
      '// INV-13 正文与渐隐同节点：守住位置 max-height 与 mask；改错故障 底部渐隐失效。',
      '// INV-14 快照提示始终附带：守住位置 snapshotNotice；改错故障 部分字段缺失无提示。',
      '// INV-15 计划文件路径可选：守住位置 planFilePath 判断；改错故障 无路径时渲染空标签。',
      '// INV-16 标题与图标走国际化：守住位置 formatMessage；改错故障 硬编码文案。',
      '// INV-17 无输出时只回快照提示：守住位置 末尾返回；改错故障 渲染空容器。',
      '// INV-18 卡片样式集中在 section：守住位置 className；改错故障 悬浮与聚焦态不一致。',
      '//',
      '// 模块职责：渲染 switch_mode 工具调用的计划卡片，并处理复制、打开详情与降级输出。',
      '// 状态所有权：仅复制态为本地状态；计划正文与回调均来自工具调用上下文。',
      '// 阅读顺序：先看交互判定，再看事件处理，最后看两种渲染分支。',
    ],
    blocks: [
      {
        anchor: 'function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {',
        lines: [
          '非元素目标直接返回否。',
          '命中自身不算子控件。',
          '只拦真实子控件。',
        ],
      },
      {
        anchor: 'export function SwitchModeToolCallBlock(context: ToolCallBlockRenderContext) {',
        lines: [
          '卡片自身承担按钮语义。',
          '点击与键盘共用同一判定。',
          '快照提示始终附带。',
        ],
      },
      {
        anchor: '  const openDetail = () => {',
        lines: [
          '缺正文或回调则不打开。',
          '计划路径可选附带。',
          '只传必要字段。',
        ],
      },
      {
        anchor: '  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {',
        lines: [
          '只认回车与空格。',
          '子控件按键不重复处理。',
          '阻止默认滚动。',
        ],
      },
      {
        anchor: '  const handleCopy = () => {',
        lines: [
          '无剪贴板能力直接返回。',
          '成功才切换图标。',
          '失败复位复制态。',
        ],
      },
      {
        anchor: '  if (hasMarkdown) {',
        lines: [
          '正文优先渲染卡片。',
          '失败态回退通用输出。',
          '无输出只留提示。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/composer/useConversationSelectionReferences.ts',
    target: 38,
    header: [
      '// INV-01 初始值即读取当前作用域：守住位置 useState 惰性初始化；改错故障 切换会话后闪现旧引用。',
      '// INV-02 作用域由会话与工作区共同决定：守住位置 组合键；改错故障 跨会话串引用。',
      '// INV-03 草稿作用域单独参与：守住位置 draftScopeKey；改错故障 两个草稿互相覆盖。',
      '// INV-04 作用域变化立即重读：守住位置 useEffect 依赖；改错故障 切换后仍显示旧数据。',
      '// INV-05 写入同时更新外部作用域：守住位置 setConversationSelectionReferenceScope；改错故障 刷新后引用丢失。',
      '// INV-06 支持函数式更新：守住位置 typeof update；改错故障 并发更新互相覆盖。',
      '// INV-07 只订阅本作用域事件：守住位置 三个字段比对；改错故障 其它会话的添加触发重渲染。',
      '// INV-08 草稿会话用空值判定：守住位置 sessionId === null；改错故障 草稿事件串到正式会话。',
      '// INV-09 事件监听在卸载时移除：守住位置 清理函数；改错故障 重复注册导致泄漏。',
      '// INV-10 移除引用只按 id：守住位置 filter；改错故障 误删同名引用。',
      '// INV-11 移除后清空上限提示：守住位置 setLimitReason(null)；改错故障 提示残留。',
      '// INV-12 清空引用同时清提示：守住位置 clearReferences；改错故障 列表空但提示仍在。',
      '// INV-13 关闭提示要写回存储：守住位置 clearConversationSelectionReferenceLimitReason；改错故障 刷新后提示复现。',
      '// INV-14 上限原因单独存放：守住位置 limitReason 状态；改错故障 与引用混在一起。',
      '// INV-15 回调依赖保持稳定：守住位置 useCallback 依赖；改错故障 每渲染重建引用。',
      '// INV-16 返回值面收敛：守住位置 末尾对象；改错故障 外部依赖内部实现细节。',
      '// INV-17 读取与订阅共用选择器：守住位置 getConversationSelectionReferenceScope；改错故障 两个入口数据不一致。',
      '// INV-18 清空只影响当前作用域：守住位置 键参数；改错故障 清空其它会话的引用。',
      '//',
      '// 模块职责：把会话选择引用与上限提示接到 React 状态，并同步回作用域存储。',
      '// 状态所有权：引用与上限原因以外部作用域存储为准，本地状态只是镜像。',
      '// 阅读顺序：先看初始化，再看两个 effect，最后看三个动作。',
    ],
    blocks: [
      {
        anchor: 'export function useConversationSelectionReferences(options: {',
        lines: [
          '初始值即读当前作用域。',
          '会话与工作区共同决定键。',
          '草稿作用域单独参与。',
          '作用域变化立即重读。',
        ],
      },
      {
        anchor: '  useEffect(() => {',
        nth: 1,
        lines: [
          '切换作用域时重读引用。',
          '同时重读上限原因。',
          '依赖只列三个键。',
        ],
      },
      {
        anchor: '  useEffect(() => {',
        nth: 2,
        lines: [
          '只订阅本作用域事件。',
          '草稿会话用空值判定。',
          '卸载时移除监听。',
        ],
      },
      {
        anchor: '  const setReferences = useCallback(',
        lines: [
          '支持函数式更新。',
          '写入同时更新外部作用域。',
          '回调依赖保持稳定。',
        ],
      },
      {
        anchor: '  const removeReference = useCallback(',
        lines: [
          '只按 id 删除。',
          '删除后清空上限提示。',
          '清空只影响当前作用域。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/v4/telemetry/localTtftRecord.ts',
    target: 39,
    header: [
      '// INV-01 记录版本固定为一：守住位置 version 字段；改错故障 消费方无法判别结构。',
      '// INV-02 时钟漂移即时标坏：守住位置 偏差阈值；改错故障 跨进程时间被当真。',
      '// INV-03 checkpoint 取首字节时间：守住位置 kind 判断；改错故障 检查点延迟被算入生成耗时。',
      '// INV-04 校准需同实例且未过期：守住位置 四项条件；改错故障 用别的实例偏移校正。',
      '// INV-05 未对齐只记缺失：守住位置 quality 三元；改错故障 可靠排队样本被当成坏时钟。',
      '// INV-06 间隔逆序即判无效：守住位置 stop < start；改错故障 负时长进入看板。',
      '// INV-07 非有限时长同样判无效：守住位置 Number.isFinite；改错故障 出现 NaN 间隔。',
      '// INV-08 间隔按阶段命名：守住位置 stage 参数；改错故障 前端无法区分阶段。',
      '// INV-09 仅对齐时补命令准入：守住位置 aligned 判断；改错故障 跨进程阶段错位。',
      '// INV-10 执行等待与请求准备走 CLI 时钟：守住位置 source 参数；改错故障 混用时钟导致失真。',
      '// INV-11 输出返回需要首字节时间：守住位置 firstAt 判断；改错故障 生成阶段缺失。',
      '// INV-12 确认等待累加：守住位置 reduce；改错故障 用户等待时间偏小。',
      '// INV-13 详情上限统一截断：守住位置 LOCAL_TTFT_MAX_DETAILS；改错故障 单条记录无限增长。',
      '// INV-14 超限同时打标：守住位置 truncated；改错故障 消费方不知道被截断。',
      '// INV-15 时钟可靠性分两路：守住位置 timingReliable 与 cliTimingReliable；改错故障 前端与 CLI 混淆。',
      '// INV-16 执行耗时仅在可算时给出：守住位置 条件展开；改错故障 出现负执行时长。',
      '// INV-17 校准误差随记录带出：守住位置 clockErrorMs；改错故障 看板无法评估偏移质量。',
      '// INV-18 行类型映射只保留标识：守住位置 rows 字段；改错故障 复制整行正文。',
      '//',
      '// 模块职责：把待定 TTFT 采样结算成一条含阶段区间与质量标记的不可变记录。',
      '// 状态所有权：pending 由调用方持有，本函数只读并回写少量标记。',
      '// 阅读顺序：先看 pending 结构，再看对齐与区间构造，最后看返回记录。',
    ],
    blocks: [
      {
        anchor: 'export interface LocalTtftPending {',
        lines: [
          '状态按会话隔离。',
          '确认等待逐条累积。',
          '行映射只保留标识。',
        ],
      },
      {
        anchor: 'export function buildLocalTtftRecord(',
        lines: [
          '时钟漂移即时标坏。',
          'checkpoint 取首字节时间。',
          '校准需同实例且未过期。',
          '未对齐只记缺失。',
        ],
      },
      {
        anchor: '  const interval = (',
        lines: [
          '缺端点直接跳过。',
          '逆序或非有限即判无效。',
          '按阶段命名。',
          '来源区分渲染器与 CLI。',
        ],
      },
      {
        anchor: '    if (aligned) interval("command_admission", pending.dispatch, at(facts.admittedAt), "aligned");',
        lines: [
          '仅对齐时补命令准入。',
          '执行等待与请求准备走 CLI 时钟。',
          '输出返回需要首字节时间。',
        ],
      },
      {
        anchor: '  return {',
        lines: [
          '详情统一截断。',
          '超限同时打标。',
          '校准误差随记录带出。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts',
    target: 38,
    firstNth: 1,
    header: [
      '// INV-01 只处理网络状态事件：守住位置 事件类型判断；改错故障 其它事件污染调试面。',
      '// INV-02 会话标识必须一致：守住位置 sessionId 比对；改错故障 串会话数据显示。',
      '// INV-03 映射失败直接跳过：守住位置 mapped 判断；改错故障 半成品条目入表。',
      '// INV-04 观察状态惰性创建：守住位置 WeakMap；改错故障 无事件会话也占内存。',
      '// INV-05 事件去重有界：守住位置 remember；改错故障 去重集合无限增长。',
      '// INV-06 去重集合按上限淘汰最旧：守住位置 size 判断；改错故障 内存随请求数增长。',
      '// INV-07 请求头有界化：守住位置 boundedHeaders；改错故障 超大响应头撑爆快照。',
      '// INV-08 消息截断：守住位置 MAX_MESSAGE_LENGTH；改错故障 调试响应体积失控。',
      '// INV-09 无限重试必须保留：守住位置 maxAttempts 透传；改错故障 旧映射器丢字段。',
      '// INV-10 条目按上限滑窗：守住位置 尾部裁剪；改错故障 网络表无限增长。',
      '// INV-11 只统计主回合完成：守住位置 三个条件；改错故障 子查询混入命中率。',
      '// INV-12 完成请求也去重：守住位置 completedRequests；改错故障 同一请求重复累计。',
      '// INV-13 未知缓存用量标记：守住位置 hasUnknownCacheUsage；改错故障 命中率被低估。',
      '// INV-14 命中率有未知即置空：守住位置 三元；改错故障 展示虚假命中率。',
      '// INV-15 输出速率需有效时长：守住位置 calculateOutputTps；改错故障 除零或负值。',
      '// INV-16 轮次表按上限滑窗：守住位置 尾部裁剪；改错故障 轮次无限增长。',
      '// INV-17 快照只读不落库：守住位置 readSessionDebug；改错故障 调试读取触发持久化。',
      '// INV-18 协议入口先校验参数：守住位置 schema parse；改错故障 非法参数进入运行时。',
      '//',
      '// 模块职责：旁路观察模型网络事件，维护有界的会话调试快照。',
      '// 状态所有权：快照挂在 WeakMap 上随会话记录回收，不进入聊天投影。',
      '// 阅读顺序：先看观察入口，再看有界工具，最后看读取与协议入口。',
    ],
    blocks: [
      {
        anchor: 'export function observeSessionDebug(record: SessionRecord, event: SessionEvent): void {',
        lines: [
          '只处理网络状态事件。',
          '会话标识必须一致。',
          '映射失败直接跳过。',
          '观察状态惰性创建。',
        ],
      },
      {
        anchor: '  const payload = event.payload as ModelNetworkStatusPayload;',
        lines: [
          '负载按契约断言。',
          '时间戳失败回退事件时间。',
          '调试面不保存正文。',
        ],
      },
      {
        anchor: '  if (!remember(observation.seenEvents, String(event.id))) return;',
        lines: [
          '事件去重有界。',
          '集合超限淘汰最旧。',
          '重复事件不再入表。',
        ],
      },
      {
        anchor: '  const usage = payload.usage;',
        lines: [
          '只统计主回合完成。',
          '完成请求也去重。',
          '未知缓存用量标记。',
        ],
      },
      {
        anchor: 'export function readSessionDebug(record: SessionRecord): SessionDebugSnapshot {',
        lines: [
          '无观察记录返回空骨架。',
          '调试读取不落库。',
          '只读不触发运行时恢复。',
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
    `ZC-deep-b156-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
