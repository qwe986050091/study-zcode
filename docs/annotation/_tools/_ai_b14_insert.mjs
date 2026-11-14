import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';
const rel = 'packages/ai/src/ui/process-ui-message-stream.ts';
const file = path.join(ROOT, rel);
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 1,
    expect: "import type { JSONObject } from '@ai-sdk/provider';",
    text: [
      '// ============================================================================',
      '// UI 消息流处理器：把协议层 UIMessageChunk 累积成可渲染的 UIMessage.parts。',
      '// 链路位置：transport（HTTP/SSE/WebSocket）-> 本文件 -> Chat.state.messages',
      '//   -> React/Svelte 等渲染层；上游调用方是 Chat.makeRequestImpl。',
      '// 职责边界：只解协议、维护 parts 状态；不发请求、不重试，error chunk 仅转交 onError。',
      '// 并发模型：每个 chunk 的处理都包在 runUpdateMessageJob 内，由调用方串行化，',
      '//   因此内部函数可以安全地原地 mutate parts。',
      '// 不变量（守住它的位置）：',
      '//   INV-01 生命周期有序 start->delta->end，缺失即抛错（守住 504 与 569 的缺失分支）；',
      '//   INV-02 所有写入必须在 update job 内（守住 152 的 transform 包裹）；',
      '//   INV-03 同一 step 内 toolCallId 唯一（守住 261 的 existingPart 查找）；',
      '//   INV-04 providerExecuted 一旦为 true 不再回落（守住 291 与 412）；',
      '//   INV-05 step 边界只由最近 step-start 划分（守住 154 的 getCurrentStepParts）；',
      '//   INV-06 reset-step 只回滚当前 step（守住 986 的 splice 长度计算）。',
      '// 不要改：updateToolPart 里的 any 强转与显式 delete 是刻意为之，见 272 分支说明。',
      '// ============================================================================',
    ],
  },
  {
    at: 34,
    expect: 'export type StreamingUIMessageState<UI_MESSAGE extends UIMessage> = {',
    text: [
      '// 一次流式响应的可变状态。message 是原地修改的引用，调用方把它挂在',
      '//   activeResponse 上，每次 write() 触发一次 UI 重渲染。',
      '// activeTextParts / activeReasoningParts：按 chunk.id 索引的未收尾 part，',
      '//   delta 据此增量拼接；end 时移除，集合大小即在途 part 数。',
      '// partialToolCalls：工具参数分片累加器。text 保留原始 JSON 文本而非解析结果，',
      '//   解析失败时仍可降级展示（见 tool-input-delta）。',
      '// finishReason：只有 finish chunk 写入，供 Chat 判断是否中断/自动续跑。',
    ],
  },
  {
    at: 53,
    expect: 'export type UIMessageStreamWriteOptions = {',
    text: [
      '// write() 的选项。updateStatus=false 用于"只改 id/metadata、内容未变"的场景，',
      '//   避免把 Chat 状态从 submitted 提前推进到 streaming。',
    ],
  },
  {
    at: 57,
    expect: 'export function createStreamingUIMessageState<UI_MESSAGE extends UIMessage>({',
    text: [
      '// 从已有消息恢复流式状态，是断线续流与响应重放的入口。',
      '// 关键设计：上一条若已是 assistant 消息就直接复用其引用（而非克隆），',
      '//   续流时已渲染的 parts 不会闪断；否则新建一条空 assistant 消息。',
      '// partialToolCalls 需要从 parts 反推：只有 state 仍为 input-streaming 的工具',
      '//   才继续接收参数分片，已经 input-available/output-* 的不再登记。',
      '// 恢复时必须跳过"最后一个 step 之前"的工具，否则迟到的 delta 会把',
      '//   已完成的历史工具覆盖回流式态。',
    ],
  },
  {
    at: 64,
    expect: 'const message =',
    text: [
      '// 复用条件只看 role；id 是否更换留给 start chunk 的 reset 逻辑处理，',
      '//   因为 resume 场景下新响应可能带全新的 messageId。',
    ],
  },
  {
    at: 76,
    expect: 'const partialToolCalls:',
    text: [
      '// createIdMap 使用 null 原型对象，避免外部传入的 toolCallId 命中',
      '//   Object.prototype 上的键（如 "constructor"）。',
    ],
  },
  {
    at: 78,
    expect: 'const lastStepStartIndex = message.parts.findLastIndex(',
    text: [
      '// 只恢复最后一步之后的工具调用：更早 step 的工具必然已终结，无需再累积。',
    ],
  },
  {
    at: 83,
    expect: 'for (const part of message.parts.slice(lastStepStartIndex + 1)) {',
    text: [
      '// index 采用"静态工具顺序号"而非 parts 下标：dynamic-tool 不占号，',
      '//   保证与 tool-input-start 里的 index 计算口径一致。',
      '// 非 input-streaming 的 part 直接跳过，不进入活动表。',
    ],
  },
  {
    at: 117,
    expect: 'export function processUIMessageStream<UI_MESSAGE extends UIMessage>({',
    text: [
      '// 入口：返回 TransformStream，边处理边把 chunk 透传给下游做细粒度渲染。',
      '// 本函数是纯累积器，不捕获异常：任一 chunk 处理抛错都会让整条流进入 error，',
      '//   由 Chat 的 catch 统一分类（abort / disconnect / error）。',
    ],
  },
  {
    at: 128,
    expect: '// input stream is not fully typed yet:',
    text: [
      '// 输入用宽松的 UIMessageChunk（覆盖全部已定义协议分支），',
      '//   输出按 UI_MESSAGE 泛型收窄为 InferUIMessageChunk，对外类型更精确。',
    ],
  },
  {
    at: 143,
    expect: '// During resume, a different message ID identifies a separate response.',
    text: [
      '// resetStateOnMessageIdChange：resume 拿到新 id 说明是另一段响应，',
      '//   必须清空旧内容，否则两段响应会拼进同一条消息。',
      '// resetStateOnFirstMessageStart：传输层重放时可能沿用同一 id 从头再发一次，',
      '//   只能靠"是否首个 start"判定重置，且只重置一次（合并流会发多个 start）。',
    ],
  },
  {
    at: 148,
    expect: 'let isFirstMessageStart = true;',
    text: [
      '// 消费过首个 start 后置 false，避免合并流的后续 start 再次触发清空。',
    ],
  },
  {
    at: 150,
    expect: 'return stream.pipeThrough(',
    text: [
      '// 用 TransformStream 而非自建 ReadableStream：保留背压，下游不消费时上游自然暂停。',
    ],
  },
  {
    at: 152,
    expect: 'async transform(chunk, controller) {',
    text: [
      '// 每个 chunk 一个 job，且 await 完成才 enqueue：保证下游看到的 chunk 顺序与',
      '//   parts 变更顺序一致，不会先渲染后到的 delta。',
      '// enqueue 在 job 之后（见 1128），因此透传时状态一定已应用。',
    ],
  },
  {
    at: 154,
    expect: 'function getCurrentStepParts() {',
    text: [
      '// 从后向前找最近一个 step-start，返回其后的 parts。',
      '// 没有 step-start 时下标停在 -1，slice(0) 返回整条消息——这是兼容',
      '//   不发 start-step 的旧协议的退化路径。',
    ],
  },
  {
    at: 168,
    expect: 'function getCurrentStepToolInvocations() {',
    text: ['// 当前 step 的工具调用视图，供去重与 index 计算使用。'],
  },
  {
    at: 172,
    expect: 'function getToolInvocation(toolCallId: string) {',
    text: [
      '// 按 toolCallId 定位工具 part：先查当前 step，再回退整条消息。',
      '// 两步查找是必要的：审批/输出 chunk 可能跨 step 到达（用户在上一步之后才点允许），',
      '//   而 updateToolPart 只在当前 step 内去重，找不到会新建重复 part。',
      '// 都找不到说明协议乱序，直接抛错而不是静默忽略。',
      '// 回退时倒序扫描，取最近出现的同 id part，与"后写覆盖"的语义一致。',
    ],
  },
  {
    at: 191,
    expect: 'if (toolInvocation == null) {',
    text: [
      '// 抛 UIMessageStreamError 便于上层区分协议错误与 provider 错误；',
      '//   chunkType/chunkId 一并带上，用于定位是哪条流、哪个工具。',
    ],
  },
  {
    at: 202,
    expect: 'function getToolInvocationByApprovalId(approvalId: string) {',
    text: [
      '// 审批响应只带 approvalId、不带 toolCallId，因此必须全量扫 parts。',
      '// 用 approval.id 匹配而非下标：一次审批可能跨多轮工具调用，id 才是稳定键。',
    ],
  },
  {
    at: 220,
    expect: 'function updateToolPart(',
    text: [
      '// 静态工具 part 的 upsert：找到就原地更新，找不到就 push 新 part。',
      '// state 迁移合法性不在此校验，由协议上游保证顺序。',
      '// 之所以用 any：四种 state 变体的字段集合不同，逐分支写会膨胀成四份重复代码；',
      '//   代价是新增字段时必须同步"更新分支"与"新建分支"两处。',
      '// 需要重点理解：本函数负责"未提供的字段要真正消失"，见 272 分支。',
    ],
  },
  {
    at: 261,
    expect: 'const part =',
    text: [
      '// 优先用调用方传入的 existingPart（tool-output-* 已自行定位）；',
      '// 否则在当前 step 内按 toolCallId + 静态工具类型查找，',
      '//   加 isStaticToolUIPart 是为了不误命中同 id 的 dynamic-tool。',
    ],
  },
  {
    at: 272,
    expect: 'if (part != null) {',
    text: [
      '// 更新分支：逐字段覆盖，未提供的字段必须被清掉而不是残留。',
      '// inputEncoding 显式 delete：上一帧若为 text、这一帧为 json，残留会让解析走错分支。',
      '// providerExecuted 用 ?? 合并：它是粘性的，一旦标记为 provider 执行，',
      '//   后续 delta 不带该字段也不能清掉（INV-04）。',
      '// providerMetadata 按 state 分流：终结态写 resultProviderMetadata，',
      '//   中间态写 callProviderMetadata，UI 需要区分调用元数据与结果元数据。',
      '// title/toolMetadata 用 !== undefined 判断，允许显式传空来清除旧值。',
      '// 这里的 anyPart 赋值故意绕开联合类型：字段集合随 state 变化，',
      '//   类型系统无法表达"按 state 收窄后的可写集合"，强转是唯一简洁写法。',
    ],
  },
  {
    at: 312,
    expect: '} else {',
    text: [
      '// 新建分支：字段顺序与类型定义保持一致，便于 diff 与快照比对。',
      '// 用条件展开而非先赋 undefined，避免留下值为 undefined 的自有属性，',
      '//   否则 JSON 序列化与快照断言会出现噪声差异。',
      '// providerMetadata 同样按终结态/中间态二选一写入。',
      '// inputEncoding/output/rawInput 等字段可能来自不同 state 变体，',
      '//   这里统一写入，配合类型断言生成 part，由协议保证不冲突。',
    ],
  },
  {
    at: 346,
    expect: 'function updateDynamicToolPart(',
    text: [
      '// 动态工具版本：与 updateToolPart 同构，差异只有两点——',
      '//   1) type 固定为 dynamic-tool，工具名放在 toolName 字段而非 type 后缀；',
      '//   2) 匹配条件用 toolName 类型无法推导，只能按 type + toolCallId 找。',
      '// 两份实现刻意不合并：合并需要大量条件分支，反而更难读。',
    ],
  },
  {
    at: 382,
    expect: 'const part =',
    text: ['// 查找同样限定当前 step，防止跨 step 误更新同名工具。'],
  },
  {
    at: 467,
    expect: 'async function updateMessageMetadata(metadata: unknown) {',
    text: [
      '// message.metadata 是累积合并的：同一响应可能多次下发（如分步统计）。',
      '// 顺序很重要：先 merge、再校验、最后写回。校验失败会抛错且 state 保持原值，',
      '//   不会留下"半合并"的脏数据。',
      '// mergeObjects 只做浅合并，后到的键覆盖先到的；嵌套对象由协议约定不做深合并。',
      '// entityId 传 message.id，让校验错误能定位到具体消息。',
    ],
  },
  {
    at: 490,
    expect: 'switch (chunk.type) {',
    text: [
      '// 单一 switch 分发所有协议分支，不设抛错式 default：未知 type 落到 default',
      '//   交给 isDataUIMessageChunk 判断，从而允许新协议对旧 SDK 向前兼容。',
    ],
  },
  {
    at: 491,
    expect: "case 'text-start': {",
    text: [
      '// 新建空 text part，先登记活动表再 push，保证 UI 立刻看到占位。',
      '// state=streaming 是显示光标的依据，text-end 时才改为 done。',
      '// 同一 id 重复 start 会覆盖活动表但留下两个 part，协议层应避免。',
    ],
  },
  {
    at: 504,
    expect: "case 'text-delta': {",
    text: [
      '// 缺失 start 视为协议违规：直接抛错，避免文本拼到错误位置。',
      '// providerMetadata 用 ?? 合并：delta 可选择携带更新的元数据（如引用来源）。',
      '// 字符串 += 的潜在 O(n^2) 由 V8 rope 吸收，不能改成数组 join，',
      '//   否则下游持有的 part 引用会失效。',
    ],
  },
  {
    at: 522,
    expect: "case 'text-end': {",
    text: [
      '// 收尾三件事：标记 done、接收 citations、从活动表移除。',
      '// citations 只在 end chunk 携带，且仅非空时写入，避免覆盖已累积值。',
      '// 移除后迟到的 delta 会命中缺失分支抛错，这是期望行为。',
    ],
  },
  {
    at: 544,
    expect: "case 'custom': {",
    text: ['// 自定义内容片段：无 id、无状态机，一次性 push，故不登记活动表。'],
  },
  {
    at: 555,
    expect: "case 'reasoning-start': {",
    text: [
      '// 推理片段单独建表：同一响应里 reasoning 与 text 会交错，',
      '//   共用活动表会串流。',
    ],
  },
  {
    at: 569,
    expect: "case 'reasoning-delta': {",
    text: [
      '// 与 text-delta 同构。reasoning 的 providerMetadata 常携带签名/加密内容，',
      '//   必须逐 chunk 合并，不能整体覆盖。',
    ],
  },
  {
    at: 587,
    expect: "case 'reasoning-end': {",
    text: [
      '// 先合并元数据再置 done：部分 UI 在 state 变化的回调里读取元数据做解密展示，',
      '//   顺序反了会读到旧值。',
    ],
  },
  {
    at: 607,
    expect: "case 'file':",
    text: [
      '// file 与 reasoning-file 结构一致，仅 type 不同，故共用分支。',
      '// url 已由上游解析为可用地址（data: 或 https:），本层不做抓取与校验。',
      '// providerMetadata 为空时不写入，保持 part 形状最小。',
    ],
  },
  {
    at: 622,
    expect: "case 'source-url': {",
    text: [
      '// 来源引用：一次性 part，不参与状态机。',
      '// 同一 sourceId 可能重复出现，本层不去重（去重属于渲染层策略）。',
    ],
  },
  {
    at: 635,
    expect: "case 'source-document': {",
    text: ['// 文档来源：比 source-url 多 mediaType/filename，同样不参与状态机。'],
  },
  {
    at: 649,
    expect: "case 'tool-input-start': {",
    text: [
      '// 工具调用开始：登记分片累加器并立即建 part，让 UI 能显示"参数生成中"。',
      '// index 取当前 step 内已存在的静态工具数，dynamic-tool 不占号；',
      '//   该口径必须与 createStreamingUIMessageState 恢复时一致。',
      '// dynamic 只能由 chunk 决定：首个 chunk 时 part 尚不存在，无法反推。',
    ],
  },
  {
    at: 664,
    expect: 'if (chunk.dynamic) {',
    text: [
      '// 只有后续 chunk（如 tool-input-error）才用 existingPart 反推类型，',
      '//   首个 chunk 必须信任 chunk.dynamic，否则会新建出类型不一致的 part。',
    ],
  },
  {
    at: 694,
    expect: "case 'tool-input-delta': {",
    text: [
      '// 工具参数分片：先把原始文本拼进累加器，再尝试解析成部分对象。',
      '// inputEncoding=text 表示参数本身就是字符串（非 JSON），原样使用；',
      '//   其余走 parsePartialJson，对未闭合 JSON 容错，value 可能不完整。',
      '// 解析失败不抛错（返回 undefined），此时 input 为 undefined、rawInput 仍保留原文，',
      '//   UI 可降级显示输入过程。',
      '// 每次 delta 都全量重建 part 字段而非只 patch input：部分解析结果可能回退。',
    ],
  },
  {
    at: 741,
    expect: "case 'tool-input-available': {",
    text: [
      '// 参数生成完成：写入最终 input，state 转 input-available。',
      '// input 直接整体替换而非合并，以服务端最终值为准（键顺序、补全字段都可能变）。',
      '// providerExecuted 透传，供后续判断是否跳过本地 onToolCall。',
    ],
  },
  {
    at: 768,
    expect: '// invoke the onToolCall callback if it exists. This is blocking.',
    text: [
      '// 顺序关键：先 write() 再 await onToolCall，让 UI 先看到 input-available，',
      '//   再执行副作用（例如发本地请求）。',
      '// 阻塞是已知取舍：并发执行需要额外的错误归集与顺序保证，暂不实现。',
      '// provider 已执行的工具不再回调，否则会重复执行。',
    ],
  },
  {
    at: 780,
    expect: "case 'tool-input-error': {",
    text: [
      '// 参数生成失败：part 置为 output-error，但 type 必须保持不变。',
      '// 先找 existingPart 再用它的 type 判定 dynamic：若直接用 chunk.dynamic，',
      '//   可能与 tool-input-start 建立的 part 类型不一致，产生同 id 两个 part。',
    ],
  },
  {
    at: 820,
    expect: "case 'tool-approval-request': {",
    text: [
      '// 审批请求：工具 part 推进到 approval-requested 并挂 approval 对象。',
      '// 必须已有 part（getToolInvocation 会抛错），审批不能凭空出现。',
      '// 可选字段逐个条件展开：inputSchemaInput 用 hasOwnProperty 判断，',
      '//   因为它允许显式传 undefined 表示"无 schema 输入"；',
      '//   reason/signature 仅在非空时写入，避免 UI 误判为存在；isAutomatic 仅 true 时写。',
    ],
  },
  {
    at: 846,
    expect: "case 'tool-approval-response': {",
    text: [
      '// 审批结果：按 approvalId 定位而非 toolCallId，因为响应 chunk 只带前者。',
      '// approved/reason 合并进原 approval 对象，保留 descriptor/signature 等请求时信息。',
      '// providerExecuted 与 callProviderMetadata 是可选刷新：审批后工具可能改由 provider 执行。',
    ],
  },
  {
    at: 872,
    expect: "case 'tool-output-denied': {",
    text: ['// 用户拒绝执行：只改 state，不写 output/errorText；denied 是终结态。'],
  },
  {
    at: 879,
    expect: "case 'tool-output-available': {",
    text: [
      '// 工具输出：按 part 类型分流两套 upsert，并传入现有 part 保证是更新而非新建。',
      '// input 取自现有 part，使输出 part 仍携带原始参数。',
      '// preliminary=true 表示流式中间结果，UI 可继续等待最终值。',
      '// toolMetadata 允许 output chunk 覆盖调用时元数据。',
    ],
  },
  {
    at: 922,
    expect: "case 'tool-output-error': {",
    text: [
      '// 工具执行失败：结构同上，但写 errorText 而非 output。',
      '// 静态工具额外回传 rawInput，便于 UI 展示出错时的原始参数文本。',
    ],
  },
  {
    at: 964,
    expect: "case 'steering-message': {",
    text: ['// 用户插话：作为独立 part 插入并携带内部 parts，本层只透传与记录位置。'],
  },
  {
    at: 974,
    expect: "case 'start-step': {",
    text: [
      '// step 边界标记：push 一个只有 type 的轻量 part。',
      '// 这是唯一不 write 的分支：step-start 无可见内容，随后必然跟一个产生内容的',
      '//   chunk，那时统一写，减少一次无意义渲染。',
    ],
  },
  {
    at: 980,
    expect: "case 'finish-step': {",
    text: [
      '// 故意空实现：活动 part 由各自 end chunk 关闭，不能在此统一收尾。',
      '// 合并流里 A 流 finish-step 时，B 流的 text part 可能仍在流式中，',
      '//   清空活动表会截断 B 的输出。',
    ],
  },
  {
    at: 986,
    expect: "case 'reset-step': {",
    text: [
      '// 步骤回滚（重试/分支切换）：丢弃当前 step 的全部 part 与活动状态。',
      '// splice 只删当前 step 长度，更早的 step-start 与内容保持不变。',
      '// 三个活动表整体换新对象而非 clear()：旧对象可能被已发出的快照引用，',
      '//   原地 clear 会连带清掉历史快照。',
    ],
  },
  {
    at: 1003,
    expect: "case 'start': {",
    text: [
      '// 响应开始。重置有两个独立触发条件（见参数注释）：',
      '//   resetStateOnFirstMessageStart 且首个 start -> 传输层重放整段响应；',
      '//   resetStateOnMessageIdChange 且 id 变化 -> resume 拿到另一段响应。',
      '// 重置用 Object.assign 而非替换 state 变量：调用方持有该引用，替换会让它读旧对象。',
      '// messageId 兜底沿用现值：重放可能不带 id，避免 UI key 抖动。',
      '// finishReason 显式置 undefined：Object.assign 不会删除已有属性。',
      '// 末尾 write 带 updateStatus=false：仅元信息变化，不应把 submitted 提前推到 streaming。',
    ],
  },
  {
    at: 1042,
    expect: "case 'finish': {",
    text: [
      '// 结束：记录 finishReason（可能为空，部分 provider 不返回）并合并最终 metadata。',
      '// metadata 为空时不 write，避免空渲染。',
    ],
  },
  {
    at: 1053,
    expect: "case 'message-metadata': {",
    text: ['// 独立的元数据更新 chunk：用于响应中途追加统计，与 finish 共用合并逻辑。'],
  },
  {
    at: 1061,
    expect: "case 'error': {",
    text: [
      '// 错误 chunk 不平抛，交给 onError：流本身仍正常关闭，',
      '//   Chat 据此置状态为 error 并保留已收到的部分内容。',
    ],
  },
  {
    at: 1066,
    expect: 'default: {',
    text: [
      '// data-* 分支。schema 键是去掉 data- 前缀的 part 名（slice(5)）。',
      '// 校验在写入之前：失败即抛错，整条流进入 error，不留非法 part。',
      '// 报错下标：已存在则用真实下标，否则用即将追加的下标，',
      '//   保证 message.parts[i] 与最终数组位置一致。',
      '// transient 表示只通知不落库：交给 onData 后返回，不写 parts；',
      '//   典型用途是临时状态（如"正在搜索"），刷新后不应重放。',
    ],
  },
  {
    at: 1099,
    expect: 'if (dataChunk.transient) {',
    text: ['// transient 仍会走上方 schema 校验，保证回调拿到的数据形状可信。'],
  },
  {
    at: 1128,
    expect: 'controller.enqueue(chunk as InferUIMessageChunk<UI_MESSAGE>);',
    text: [
      '// 状态更新完成后才透传 chunk。write() 的 UI 更新是同步的，',
      '//   enqueue 才触发下游异步读取，因此下游永远看到"状态已应用"的 chunk。',
      '// 全文件唯一的类型断言：协议层 tools 为 unknown，输出按 UI_MESSAGE 收窄。',
    ],
  },
];

for (const a of anchors) {
  const idx = a.at - 1;
  if (idx < 0 || idx >= lines.length || !lines[idx].includes(a.expect)) {
    console.error(`MISS @${a.at} expect=${a.expect} actual=${lines[idx]}`);
    process.exit(1);
  }
}

for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
  lines.splice(a.at - 1, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
