// B223 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts',
    target: 30,
    header: [
      '// INV-01 能力先行探测：守住位置 readTarget/setTarget/updateTargetStatus/clearTarget 四方法检查；改错故障 精简客户端上直接抛错。',
      '// INV-02 无参即摘要：守住位置 trimmed.length 判断；改错故障 空 /goal 被当成目标文本写入。',
      '// INV-03 子命令只认首词：守住位置 splitArgs 取 action；改错故障 目标正文含 pause 被误判为子命令。',
      '// INV-04 pause 幂等：守住位置 updateTargetStatus 返回空；改错故障 无目标时报错而非提示。',
      '// INV-05 resume 失败不续跑：守住位置 !target 早退；改错故障 无目标也触发一次空续跑。',
      '// INV-06 clear 如实回报：守住位置 cleared 布尔；改错故障 清空失败仍显示已清除。',
      '// INV-07 replace 前缀剥离：守住位置 replace 正则；改错故障 目标正文残留 "replace"。',
      '// INV-08 replace 空目标拒绝：守住位置 objective.length 判断；改错故障 用空串覆盖既有目标。',
      '// INV-09 覆盖必须二次确认：守住位置 existing 分支；改错故障 误覆盖长程目标与预算。',
      '// INV-10 确认项携带原目标：守住位置 buildTargetReplaceSelection；改错故障 确认界面上看不到将被替换的内容。',
      '// INV-11 变更统一出口：守住位置 continueTargetAfterChange；改错故障 设置与恢复两条路径行为分叉。',
      '// INV-12 续跑透传取消与事件：守住位置 abortSignal / onEvent；改错故障 用户无法中断续跑，UI 收不到流。',
      '// INV-13 Plan 模式不续跑并说明：守住位置 appendPlanModeGoalContinuationNote；改错故障 用户以为已继续。',
      '// INV-14 只做格式化：守住位置 formatTargetChanged；改错故障 展示层做单位换算导致数据失真。',
      '//',
      '// 模块职责：/goal 命令的解析与分发，把目标状态变更收敛到一条统一续跑出口。',
      '// 阅读顺序：先看能力探测与无参摘要，再看四个子命令，最后看覆盖确认与格式化。',
    ],
    blocks: [
      {
        anchor: 'export async function handleTargetCommand(',
        lines: [
          '入口先拿 app，再做能力探测。',
        ],
      },
      {
        anchor: 'const trimmed = args.trim();',
        lines: [
          '首尾空白不参与命令判定。',
        ],
      },
      {
        anchor: 'if (!app.readTarget || !app.setTarget || !app.updateTargetStatus || !app.clearTarget) {',
        lines: [
          '四方法缺一即整体降级为提示。',
        ],
      },
      {
        anchor: 'if (trimmed.length === 0) {',
        lines: [
          '无参数只读摘要，不改状态。',
        ],
      },
      {
        anchor: 'const [action] = splitArgs(trimmed);',
        lines: [
          '只取首个词判断是否子命令。',
        ],
      },
      {
        anchor: 'if (action === "pause") {',
        lines: [
          '暂停不触发续跑。',
        ],
      },
      {
        anchor: 'if (action === "resume") {',
        lines: [
          '恢复后才走统一续跑出口。',
        ],
      },
      {
        anchor: 'if (action === "clear") {',
        lines: [
          '清除结果按布尔如实回报。',
        ],
      },
      {
        anchor: 'const forceReplace = action === "replace";',
        lines: [
          'replace 是唯一跳过确认的路径。',
        ],
      },
      {
        anchor: 'if (!forceReplace) {',
        lines: [
          '普通写入需先检查是否已有目标。',
        ],
      },
      {
        anchor: 'const target = await app.setTarget({ objective, status: "active" });',
        lines: [
          '落库后立刻进入统一续跑出口。',
        ],
      },
      {
        anchor: 'async function continueTargetAfterChange(',
        lines: [
          '目标变更后的唯一收尾函数。',
        ],
      },
      {
        anchor: 'function formatTargetChanged(title: string, target: CommandCenterTarget): string {',
        lines: [
          '用量行只在有 token 事实时出现。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/helpers/attachment-media-resolver.ts',
    target: 30,
    header: [
      '// INV-01 按类型分派：守住位置 attachment.type 三个分支；改错故障 其它类型被本文件误接管。',
      '// INV-02 非本职责返回 undefined：守住位置 video 之后的 return；改错故障 文本/引用附件被吞掉。',
      '// INV-03 降级不抛错：守住位置 各占位返回；改错故障 单个坏附件让整轮请求失败。',
      '// INV-04 图片缩放失败有专码：守住位置 attachment_image_resize_failed；改错故障 与格式非法混为一谈。',
      '// INV-05 PDF 不做文本解码：守住位置 结构化 file 分支；改错故障 二进制被当文本读取。',
      '// INV-06 PDF 零字节与超限同拒：守住位置 sizeBytes 判断；改错故障 截断出非法 PDF 发给 provider。',
      '// INV-07 视频超限降级为路径：守住位置 video_too_large 分支；改错故障 用户不知道该文件在哪。',
      '// INV-08 id 同轮稳定：守住位置 turn-attachment-${index+1}；改错故障 事件与投影无法对齐附件。',
      '// INV-09 复用 artifact 时 mime 分开：守住位置 source.mimeType 三元；改错故障 把缩放后的类型写成原始类型。',
      '// INV-10 本地路径以会话 cwd 解析：守住位置 resolvePath(workingDirectory)；改错故障 相对路径按进程 cwd 解析。',
      '// INV-11 本地 I/O 只走 fileSystemPort：守住位置 stat / read；改错故障 绕过权限与取消。',
      '// INV-12 stat 失败与不是文件分开：守住位置 read_failed 与 not_file；改错故障 排障时无法区分原因。',
      '// INV-13 读端二次限流：守住位置 readBinaryFile 的 maxBytes；改错故障 stat 后文件变大仍被整读。',
      '// INV-14 原始相对路径保留在 source：守住位置 text / placeholder；改错故障 UI 回显变成绝对路径。',
      '//',
      '// 模块职责：把 inline 与本地文件两类媒体附件解析成 provider 可用的 contentBlock。',
      '// 阅读顺序：先看 inline 三分支，再看本地解析与 stat 校验，最后看三条本地子链路。',
    ],
    blocks: [
      {
        anchor: 'export async function resolveInlineMediaAttachment(',
        lines: [
          '内存媒体按类型分三条子链路。',
        ],
      },
      {
        anchor: 'if (attachment.type === "image" && attachment.content && parsedMediaType?.startsWith("image/")) {',
        lines: [
          '图片分支要求真 data URL 头。',
        ],
      },
      {
        anchor: 'prepared = await prepareImageDataUrl(attachment.content, parsedMediaType, options);',
        lines: [
          '缩放是可选优化，失败不进主错。',
        ],
      },
      {
        anchor: 'const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {',
        nth: 1,
        lines: [
          '落盘能力全部透传，缺席则 inline。',
        ],
      },
      {
        anchor: 'mimeType: options.existingArtifactUri ? parsedMediaType : prepared.mediaType,',
        lines: [
          '复用 artifact 时类型描述存储原文。',
        ],
      },
      {
        anchor: 'if (attachment.type === "pdf" && attachment.content) {',
        lines: [
          'PDF 只走结构化 file 形态。',
        ],
      },
      {
        anchor: 'if (pdfData.sizeBytes === 0 || pdfData.sizeBytes > PDF_INPUT_MAX_BYTES) {',
        lines: [
          '空与超限都拒绝，不做截断。',
        ],
      },
      {
        anchor: 'if (attachment.type !== "video" || !attachment.content) return undefined;',
        lines: [
          '其余类型交回上层继续分派。',
        ],
      },
      {
        anchor: 'if (videoData.sizeBytes > VIDEO_INPUT_MAX_BYTES) {',
        lines: [
          '超限视频转路径引用而非报错。',
        ],
      },
      {
        anchor: 'export async function resolveLocalMediaAttachment(',
        lines: [
          '本地媒体先解析路径再 stat。',
        ],
      },
      {
        anchor: 'if (stat.kind !== "file") {',
        lines: [
          '目录与特殊文件统一拒绝。',
        ],
      },
      {
        anchor: 'async function resolveLocalPdfAttachment(',
        lines: [
          '先按 stat 挡超限，再看读取端。',
        ],
      },
      {
        anchor: 'async function resolveLocalImageAttachment(',
        lines: [
          '图片用 base64 读文本端口。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 旁路写入：守住位置 三个 try/catch；改错故障 用量库故障导致用户任务失败。',
      '// INV-02 只记事实不估算：守住位置 result.usage ?? 失败事件 usage；改错故障 本地猜测冒充 provider 数据。',
      '// INV-03 能力探测而非断言：守住位置 usageStoreFor；改错故障 精简 store 上直接崩溃。',
      '// INV-04 四方法齐备才启用：守住位置 pruneUsage 检查；改错故障 半套写入造成口径不一致。',
      '// INV-05 主键含 attemptIndex：守住位置 modelUsageId；改错故障 重试覆盖首次请求的用量。',
      '// INV-06 逻辑 id 有降级链：守住位置 messageId → spanId → 合成键；改错故障 流式中断时无稳定主键。',
      '// INV-07 TTFT 只认可见增量：守住位置 text_delta / reasoning_delta；改错故障 结构化增量拉低首 token 时间。',
      '// INV-08 空增量不算首 token：守住位置 delta.length 判断；改错故障 占位 chunk 让 TTFT 系统性偏小。',
      '// INV-09 turn 级按事件汇总：守住位置 createModelUsageSummaryFromEvents；改错故障 两条口径对不上。',
      '// INV-10 工具调用单行 upsert：守住位置 sessionID + toolCallId 主键；改错故障 多阶段产生多行。',
      '// INV-11 scheduled 不预设放行：守住位置 approvalStatus: "none"；改错故障 统计低估权限拦截。',
      '// INV-12 取消与失败分开：守住位置 errorType.includes("cancel")；改错故障 用户取消被计入错误率。',
      '// INV-13 错误归因按可信度：守住位置 errorInfoFor 的四段；改错故障 用错误文案分类导致统计漂移。',
      '// INV-14 计数保守收敛：守住位置 numberValue；改错故障 负数与非有限值污染统计。',
      '//',
      '// 模块职责：把会话事件流投影成模型请求、turn 与工具调用三张用量事实表。',
      '// 阅读顺序：先看 model 事实，再看 turn 汇总，最后看工具状态机与几个取值工具。',
    ],
    blocks: [
      {
        anchor: 'export async function recordModelUsageFact(',
        lines: [
          '请求级事实：成功与失败都记。',
        ],
      },
      {
        anchor: 'const usage = input.result?.usage ?? failedNetworkEvent?.usage;',
        lines: [
          '权威用量优先，其次失败前上报。',
        ],
      },
      {
        anchor: 'await usageStore.recordModelUsage({',
        lines: [
          '主键、归因与用量一次写入。',
        ],
      },
      {
        anchor: 'export async function recordTurnUsageFact(',
        lines: [
          'turn 级事实由本 turn 事件汇总。',
        ],
      },
      {
        anchor: 'const usage = createModelUsageSummaryFromEvents(input.events);',
        lines: [
          '汇总口径复用共享实现。',
        ],
      },
      {
        anchor: 'await usageStore.upsertTurnUsage({',
        lines: [
          'upsert 保证同一 turn 只有一行。',
        ],
      },
      {
        anchor: 'export async function recordToolUsageFromEvent(',
        lines: [
          '工具事实按事件阶段增量更新。',
        ],
      },
      {
        anchor: 'const toolCallId = stringValue(payload.toolCallId);',
        lines: [
          '没有调用 id 的事件无法归组。',
        ],
      },
      {
        anchor: 'if (event.type === SessionEventType.ToolCallScheduled) {',
        nth: 2,
        lines: [
          '调度阶段只说明开始运行。',
        ],
      },
      {
        anchor: 'if (event.type === SessionEventType.ToolCallResult) {',
        lines: [
          '结果阶段记录退出码与真实输出字节。',
        ],
      },
      {
        anchor: 'status: errorType.includes("cancel") ? "cancelled" : "error",',
        lines: [
          '取消单列，不混入错误率。',
        ],
      },
      {
        anchor: 'function usageStoreFor(runtime: AgentRuntimeInternal): UsageStorePort | undefined {',
        lines: [
          '四个方法齐备才当作用量端口。',
        ],
      },
      {
        anchor: 'function modelUsageId(input: RecordModelUsageInput): string {',
        lines: [
          '重试是独立事实，必须进主键。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/session-context/topic-archive.ts',
    target: 30,
    header: [
      '// INV-01 检索范围只来自可信输入：守住位置 conversationInputIntent 读取；改错故障 从消息正文里捞档案。',
      '// INV-02 新协议优先：守住位置 Object.hasOwn 判断；改错故障 旧字段覆盖新记录。',
      '// INV-03 schema 校验后才采信：守住位置 safeParse；改错故障 脏数据进入检索集合。',
      '// INV-04 只收用户消息：守住位置 role / synthetic 过滤；改错故障 助手自述被当历史证据。',
      '// INV-05 作用域取最后一条：守住位置 sources.at(-1)；改错故障 跨群/跨话题串档。',
      '// INV-06 同作用域才参与：守住位置 botId/chatId/threadId 三段比较；改错故障 别的会话记录混入。',
      '// INV-07 按 id 去重：守住位置 Map.set(record.id)；改错故障 重复档案重复计数。',
      '// INV-08 缺口语义向上传递：守住位置 hasGap 累积；改错故障 结果谎称历史完整。',
      '// INV-09 匹配支持 id 精确命中：守住位置 record.id === query.query；改错故障 按 id 查不到。',
      '// INV-10 预算双重封顶：守住位置 Math.min(maxTokens, 12000)；改错故障 调用方传大值撑爆上下文。',
      '// INV-11 预算下限显式失败：守住位置 256 判断；改错故障 预算过小静默返回空结果。',
      '// INV-12 单条超长保留预览：守住位置 0.8 收缩循环；改错故障 首条就把预算吃光或返回空。',
      '// INV-13 截断三种来源合并：守住位置 hasGap || clipped || next；改错故障 还有剩余却不给游标。',
      '// INV-14 引用只给 messageId：守住位置 references 映射；改错故障 把正文再塞进引用放大载荷。',
      '//',
      '// 模块职责：从会话输入事实里检索已归档的话题原文，按 token 预算分页返回。',
      '// 阅读顺序：先看来源收集与作用域收敛，再看匹配与预算裁剪，最后看返回结构。',
    ],
    blocks: [
      {
        anchor: 'export function readTopicArchive(',
        lines: [
          '纯读：只消费已保存的输入事实。',
        ],
      },
      {
        anchor: 'if (info.role !== "user" || info.synthetic) return [];',
        lines: [
          '合成用户消息不是真实输入。',
        ],
      },
      {
        anchor: 'const intent =',
        lines: [
          '新字段存在时不再回退旧字段。',
        ],
      },
      {
        anchor: 'const parsed = sourceSchema.safeParse(',
        lines: [
          '来源结构不合法就直接丢弃。',
        ],
      },
      {
        anchor: 'const scope = sources.at(-1);',
        lines: [
          '最近一次来源决定本次检索作用域。',
        ],
      },
      {
        anchor: 'const records = new Map<string, z.infer<typeof recordSchema>>();',
        lines: [
          '按记录 id 去重，后写覆盖先写。',
        ],
      },
      {
        anchor: 'const needle = query.query.toLocaleLowerCase();',
        lines: [
          '大小写不敏感匹配，降低地区差异。',
        ],
      },
      {
        anchor: 'const budget = Math.min(query.maxTokens ?? 6000, 12000);',
        lines: [
          '调用方预算不得突破硬上限。',
        ],
      },
      {
        anchor: 'if (budget < 256) throw new Error("Topic retrieval budget must be at least 256 tokens");',
        lines: [
          '预算过小是调用方错误，显式抛出。',
        ],
      },
      {
        anchor: 'for (const record of matches.slice(offset, offset + 20)) {',
        lines: [
          '单页最多二十条，控制扫描成本。',
        ],
      },
      {
        anchor: 'if (consumed + cost > budget - 100) {',
        lines: [
          '预留一百 token 余量再判超预算。',
        ],
      },
      {
        anchor: 'while (estimateTokens(JSON.stringify({ ...record, text })) > budget - 100 && text.length)',
        lines: [
          '逐次收缩正文直到可容纳。',
        ],
      },
      {
        anchor: 'const next = offset + selected.length;',
        lines: [
          '游标只推进已选中的条数。',
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
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b223-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
