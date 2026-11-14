import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';

function apply(rel, anchors) {
  const file = path.join(ROOT, rel);
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');

  for (const a of anchors) {
    const idx = a.at - 1;
    const actual = lines[idx];
    if (idx < 0 || idx >= lines.length || !actual.includes(a.expect)) {
      console.error(`MISS ${rel} @${a.at} expect=${a.expect} actual=${actual}`);
      process.exit(1);
    }
  }

  for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
    lines.splice(a.at - 1, 0, ...a.text);
  }

  fs.writeFileSync(file, lines.join('\r\n'));
  console.log(`OK ${rel} +${anchors.reduce((s, a) => s + a.text.length, 0)}`);
}

apply('packages/ai/src/generate-text/smooth-stream.ts', [
  {
    at: 1,
    expect: 'import { delay as originalDelay',
    text: [
      '// ============================================================================',
      '// 流式平滑器 smoothStream：把 text-delta / reasoning-delta 重新切块并按节奏下发。',
      '// 链路位置：streamText({ experimental_transform: smoothStream() }) 的 TransformStream 阶段，',
      '//   位于 provider chunk 解析之后、UI 消费之前；只重切文本，不改变语义与顺序。',
      '// 不变量：INV-01 输出文本拼接必须与输入完全一致（守住 173 与 187 的 buffer 截取）；',
      '//   INV-02 一个输出 part 只能携带一份 providerMetadata（守住 163-171 的边界 flush）。',
      '// ============================================================================',
    ],
  },
  {
    at: 13,
    expect: 'function isDocumentHidden()',
    text: [
      '// 浏览器隐藏页会强节流定时器，delay 会通过背压拖住整条流；此时平滑没有视觉意义。',
      '// 因此仅在可见文档中等待延迟（见 189 行）。',
    ],
  },
  {
    at: 36,
    expect: 'export function smoothStream<TOOLS extends ToolSet>({',
    text: [
      '// 工厂：先按形态解析 chunking（Intl.Segmenter / 自定义函数 / 内置或自定义正则），',
      '// 再返回 "按 tools 生成 TransformStream" 的函数，让调用方拿到正确的 part 类型。',
      '// [权衡] 用鸭子类型识别 Intl.Segmenter，避免依赖具体运行时的构造器。',
    ],
  },
  {
    at: 68,
    expect: "} else if (typeof chunking === 'function') {",
    text: [
      '// 自定义 detector：必须返回非空且为 buffer 前缀的串。',
      '// [失败路径] 返回非前缀会让 buffer.slice 错位，宁可立即抛错也不静默产出错文本。',
    ],
  },
  {
    at: 89,
    expect: 'const chunkingRegex =',
    text: [
      '// 正则分支：保存并恢复 lastIndex，避免全局正则的游标泄漏到调用方。',
      '// 匹配空串视为契约违规——那会让 while 循环无法推进。',
    ],
  },
  {
    at: 123,
    expect: 'function flushBuffer(',
    text: [
      '// 把缓冲作为一个 part 发出，并清空文本与 metadata；无内容时不产生空 part。',
      '// [事务] 这里是 "提交当前 part" 的唯一出口，切块与边界变更都复用它。',
    ],
  },
  {
    at: 149,
    expect: "if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {",
    text: ['// 非文本 chunk 先 flush 再透传，保证输出顺序与输入一致。'],
  },
  {
    at: 164,
    expect: 'buffer.length > 0 &&',
    text: [
      '// 边界 flush：type/id 变化或 metadata 出现/变化时必须先提交旧 part，',
      '// 因为一个输出 part 只有一份 providerMetadata，合并会丢信息。',
    ],
  },
  {
    at: 180,
    expect: 'while ((match = detectChunk(buffer)) != null) {',
    text: [
      '// 循环切块：null 表示还凑不出一块，保留 buffer 等下一轮；每发一块就推进并等待延迟。',
    ],
  },
]);

apply('packages/ai/src/generate-text/restricted-telemetry-dispatcher.ts', [
  {
    at: 1,
    expect: 'import type { Context, ToolSet }',
    text: [
      '// ============================================================================',
      '// 受限 telemetry 分派器：generateText / streamText 的事件出口，按 include 白名单裁剪上下文。',
      '// 链路位置：generate-text / stream-text -> createRestrictedTelemetryDispatcher',
      '//   -> createTelemetryDispatcher（真正的用户回调与 tracing）。',
      '// 为什么需要 "受限"：runtimeContext 与 toolsContext 可能包含用户密钥或大对象，',
      '//   只有显式 include 的顶层字段才允许进入遥测，其余在事件发出前被过滤。',
      '// 不变量：INV-01 所有 step 事件必须经过 restrictStepResult（守住 134-140、161-205）；',
      '//   INV-02 onStepFinish 必须转发到 onStepEnd（守住 171-178）；',
      '//   INV-03 onEnd.finalStep 必须取自裁剪后的 steps（守住 191）。',
      '// ============================================================================',
    ],
  },
  {
    at: 39,
    expect: '> = Omit<',
    text: [
      '// 先移除需要改签名的 9 个回调，再以交叉类型补回；',
      '// 这样底层 TelemetryDispatcher 新增字段时会自动继承，不会漏掉。',
    ],
  },
  {
    at: 54,
    expect: 'deprecated Use',
    text: ['// 兼容旧名：onStepFinish 等价于 onStepEnd，迁移完成前继续可用。'],
  },
  {
    at: 67,
    expect: 'function restrictStepResult<',
    text: [
      '// 复制一份 StepResult，只保留白名单内的 runtimeContext / toolsContext。',
      '// 不直接改原对象：同一 step 可能同时被用户回调与 tracing 使用，原地裁剪会污染真实状态。',
      '// [事务] 这里构造的是 "快照"，后续步骤对原 context 的修改不会回流到已发出的事件。',
      '// 该函数被 step-start、step-end、step-error、end、abort 五处复用。',
    ],
  },
  {
    at: 79,
    expect: 'return new DefaultStepResult({',
    text: [
      '// 逐字段拷贝（而非展开）：StepResult 是类实例，展开会丢掉原型语义。',
      '// steeringMessages 需要显式映射回 experimental_steeringMessages。',
      '// 这样消费方拿到的仍是完整 StepResult 形状，可直接读取 usage/content。',
    ],
  },
  {
    at: 109,
    expect: 'export function createRestrictedTelemetryDispatcher<',
    text: [
      '// 工厂：先建通用 dispatcher，再逐个包装需要裁剪的事件。',
      '// onStart/onStepStart/onStepError/onEnd/onAbort 都携带 context，必须过滤；',
      '// onToolExecutionStart/End 只裁剪单个工具的 context。',
      '// [权衡] 采用 "包装而非继承"，避免把裁剪逻辑分散到 dispatcher 内部。',
      '// 返回对象与 TelemetryDispatcher 结构兼容，可直接作为 telemetry 选项传入。',
    ],
  },
  {
    at: 122,
    expect: 'const telemetryDispatcher = createTelemetryDispatcher({ telemetry });',
    text: [
      '// 底层 dispatcher 负责真正的用户回调、OpenTelemetry 与 tracing span；',
      '// 本文件只在事件进入它之前做数据裁剪，不做任何 I/O。',
      '// [失败路径] 裁剪本身不吞异常；用户回调抛错由底层语义决定如何上抛。',
    ],
  },
  {
    at: 124,
    expect: 'const restrictStepStartEvent = <',
    text: [
      '// step-start / step-error 共用的事件形态：顶层 context + steps 数组 + toolsContext。',
      '// 三者都要裁剪，且 steps 内每个 step 也要走 restrictStepResult。',
      '// 泛型 EVENT 保留子类型，避免把 step-error 的特有字段擦掉。',
      '// [资源] 只做浅层过滤与新对象构造，不深克隆被 include 的值。',
    ],
  },
  {
    at: 128,
    expect: ') => ({',
    text: ['// 展开保留 callId/provider/modelId 等字段，只替换需要裁剪的部分。'],
  },
  {
    at: 149,
    expect: 'onStart: event =>',
    text: [
      '// 顶层 start：裁剪 runtimeContext 与 toolsContext，其余字段原样透传。',
      '// 事件对象是只读输入，函数返回新对象，不修改入参。',
      '// toolsContext 在未配置时过滤为空对象，等同不暴露。',
    ],
  },
  {
    at: 161,
    expect: 'onStepStart: event =>',
    text: ['// step-start 走统一的事件裁剪函数（顶层 + steps + toolsContext）。'],
  },
  {
    at: 163,
    expect: 'onStepEnd: event =>',
    text: ['// step-end 的 event 本身就是 StepResult，可直接交给 restrictStepResult。'],
  },
  {
    at: 171,
    expect: 'onStepFinish: event =>',
    text: ['// 旧名转发到 onStepEnd；两者指向同一底层回调，不会触发两次。'],
  },
  {
    at: 179,
    expect: 'onStepError: event =>',
    text: ['// step-error 与 step-start 同形，复用同一裁剪函数。'],
  },
  {
    at: 181,
    expect: 'onEnd: event =>',
    text: [
      '// end 事件：先裁剪 steps，再重算 finalStep。',
      '// 关键点：finalStep 必须取裁剪后数组的末位（191 行），',
      '// 否则会把含完整 context 的原始 step 泄漏出去（INV-03）。',
      '// [失败路径] steps 为空时 finalStep 为 undefined，调用方需自行判空。',
      '// steps.map 的顺序与执行顺序一致，末位即最后一步。',
    ],
  },
  {
    at: 207,
    expect: 'onAbort: event =>',
    text: ['// abort 事件只带 steps，逐项裁剪；该事件不包含 runtimeContext。'],
  },
  {
    at: 218,
    expect: 'onToolExecutionStart: event =>',
    text: [
      '// 工具执行事件：只裁剪该工具自己的 toolContext，不触碰参数与结果。',
      '// toolName 用于在 includeToolsContext 中定位白名单。',
      '// start 与 end 的裁剪规则完全一致。',
      '// 未配置 includeToolsContext 时 filterToolContext 返回空对象，等同不暴露。',
      '// 工具的输入输出可能很大，这里刻意不复制，只过滤 context。',
    ],
  },
  {
    at: 227,
    expect: 'onToolExecutionEnd: event =>',
    text: ['// end 与 start 使用同一套裁剪逻辑。'],
  },
]);

apply('packages/ai/src/transcribe/stream-transcribe.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// 流式转写 streamTranscribe：把音频 chunk 流交给支持流式转写的模型，边转写边下发。',
      '// 链路位置：streamTranscribe -> resolveTranscriptionModel -> doStream（provider 流）',
      '//   -> TransformStream 归一化 -> fullStream（TranscriptionStreamPart）。',
      '// 结果读取模型：文本/分段/语言等通过 DelayedPromise 暴露，与 fullStream 互斥消费。',
      '// 不变量：INV-01 结果 promise 与 fullStream 只能二选一（守住 383-413 的 streamOwner）；',
      '//   INV-02 finish 缺 text 视为失败（守住 260-264）；INV-03 未 finish 即结束必须在 flush 抛错（守住 308-314）；',
      '//   INV-04 取消必须带明确 reason，避免 Node 26 的 unhandled rejection（守住 316-320）。',
      '// ============================================================================',
    ],
  },
  {
    at: 58,
    expect: 'export function streamTranscribe({',
    text: [
      '// 工厂式入口：立即返回结果对象，内部用 pipeTo 驱动 provider 流。',
      '// 因此本函数不 await，调用方拿到 fullStream 后可以立刻消费。',
    ],
  },
  {
    at: 120,
    expect: 'const resolvedModel = resolveTranscriptionModel(model);',
    text: ['// 先解析模型：字符串 id 会走全局 provider（默认 AI Gateway）。'],
  },
  {
    at: 125,
    expect: 'const doStream = resolvedModel.doStream?.bind(resolvedModel);',
    text: [
      '// 能力检查：不支持流式转写时给出可操作的信息（换模型实例或升级 gateway）。',
      '// bind 一次，后续调用不必再关心 this 绑定。',
    ],
  },
  {
    at: 145,
    expect: 'const callId = generateCallId();',
    text: ['// 每个调用一个 callId，用于把 start/end/error 事件串起来。'],
  },
  {
    at: 151,
    expect: 'let audioByteLength = 0;',
    text: [
      '// 仅当配置了 streamTranscribe 的 end 遥测时才包一层计数流；',
      '// 计数发生在 pull 时，因此只统计真正被模型读取的字节。',
    ],
  },
  {
    at: 158,
    expect: 'const startEvent: StreamTranscriptionStartEvent = {',
    text: [
      '// start 事件在音频尚未读取时发出，byteLength 只能留空，最终值在 end 事件补上。',
      '// mediaType 来自调用方声明的 inputAudioFormat。',
    ],
  },
  {
    at: 173,
    expect: 'const textPromise = new DelayedPromise<string>();',
    text: [
      '// 结果 promise 组：每个字段一个 DelayedPromise，由 finish chunk 一次性 resolve。',
      '// 这样调用方可以只 await 关心的字段，同时保持与流式消费的互斥。',
      '// [事务] finish 是唯一提交点；错误路径通过 rejectPendingPromises 统一回滚。',
    ],
  },
  {
    at: 187,
    expect: 'const rejectPendingPromises = (error: unknown) => {',
    text: [
      '// 只 reject 仍处于 pending 的 promise：已 settle 的字段不被后续错误覆盖。',
      '// 遍历固定数组而不是反射，保证顺序稳定、无隐藏成本。',
    ],
  },
  {
    at: 208,
    expect: 'const resolveWarnings = (resolvedWarnings: Array<Warning>) => {',
    text: [
      '// 首次 stream-start 即确定 warnings；finish 时若仍未收到则补空数组，',
      '// 保证 warningsPromise 一定 settle，不会让调用方永久挂起。',
    ],
  },
  {
    at: 218,
    expect: 'When the consumer cancels',
    text: [
      '// 消费者提前 cancel fullStream 时，用这个 controller 以明确 reason 中止 pipe。',
      '// 若依赖默认 cancel 级联，reason 会是 undefined，在 Node 26 上可能表现为未处理 rejection。',
    ],
  },
  {
    at: 226,
    expect: 'const transformer: Transformer<',
    text: [
      '// provider part -> 对外 part 的归一化器。',
      '// cancel 是 Streams 规范的一部分，但当前 Transformer 类型未声明，用交叉类型放宽。',
    ],
  },
  {
    at: 232,
    expect: "case 'stream-start': {",
    text: ['// stream-start 只承担 warnings，不向下游透传。'],
  },
  {
    at: 237,
    expect: "case 'response-metadata': {",
    text: ['// response-metadata 逐字段合并：后到的值覆盖先到的，缺失字段保留旧值。'],
  },
  {
    at: 246,
    expect: "case 'transcript-delta':",
    text: ['// 转写内容与 raw/error 原样透传；error 不在此终止流，由 finish/flush 决定收尾。'],
  },
  {
    at: 255,
    expect: "case 'finish': {",
    text: [
      '// finish 是唯一提交点：',
      '// STEP-1 补齐 warnings；STEP-2 无 text 直接判失败；STEP-3 一次性 settle 全部结果 promise。',
      '// [事务] resolve 顺序固定，保证消费方看到的是同一份结果快照。',
    ],
  },
  {
    at: 277,
    expect: 'const endEvent: StreamTranscriptionEndEvent = {',
    text: ['// end 事件只在显式配置时发送，byteLength 使用计数流的累计值。'],
  },
  {
    at: 308,
    expect: 'flush() {',
    text: [
      '// flush 在 writable 正常关闭时触发：若 text 仍未 resolve，说明 provider 没发 finish，',
      '// 必须抛错让 fullStream 消费方感知失败，而不是静默结束。',
    ],
  },
  {
    at: 316,
    expect: 'cancel(reason) {',
    text: ['// cancel 用明确 reason 中止 pipe；reason 为空时构造默认错误（INV-04）。'],
  },
  {
    at: 323,
    expect: 'const transform = new TransformStream<',
    text: ['// TransformStream 只创建一次，readable 随后由唯一 owner 消费。'],
  },
  {
    at: 328,
    expect: 'Piping (instead of an eager read loop)',
    text: [
      '// 用 pipeTo 而不是主动 read 循环：保留背压，并把 fullStream 的 cancel 传导到模型流。',
      '// 通过 void 启动，错误统一由下方 catch 处理。',
    ],
  },
  {
    at: 340,
    expect: 'const result = await doStream({',
    text: ['// 合并两个 signal：调用方 abort 与内部 pipeAbortController 任一触发都会中止 doStream。'],
  },
  {
    at: 361,
    expect: '}).catch(async error => {',
    text: [
      '// [失败路径] 任何未捕获错误（doStream 拒绝、pipe 失败、取消）都汇聚到这里：',
      '// 先 reject 所有 pending promise，再在未发送 end 的情况下补发 onError，',
      '// 最后清理 countedAudio 与 writable，避免悬挂的 reader。清理失败被吞掉，因为主错误更重要。',
    ],
  },
  {
    at: 379,
    expect: 'Transcription streams can be unbounded',
    text: [
      '// 单所有权模型：转写流可能是无界的（实时麦克风），不能像 streamText 那样',
      '// 保留未读的 tee 分支用于重放，因此输出流只能有一个消费者。',
      '// [并发] 这不是线程安全，而是 "读一次就没了" 的流语义约束。',
    ],
  },
  {
    at: 386,
    expect: 'function consumeStream() {',
    text: [
      '// 结果 promise 被读取时，后台把流排空：数据通过 promise 呈现，',
      '// 同时保证 provider 流不会因无人读取而卡住。',
    ],
  },
  {
    at: 401,
    expect: 'function getFullStream() {',
    text: [
      '// fullStream 与结果 promise 互斥；重复获取或先读 promise 都会抛错。',
      '// 直接返回 readable 以保留背压与 cancel 语义。',
    ],
  },
  {
    at: 415,
    expect: 'return {',
    text: ['// 每个 getter 都先 consumeStream：无论用户读哪个字段，底层流都在推进。'],
  },
  {
    at: 450,
    expect: 'function createByteCountingStream(',
    text: [
      '// 字节计数包装：pull 时累计字节数；字符串按 base64 解码后的字节数计。',
      '// [资源] cancel 时优先取消已创建的 reader，否则直接 cancel 上游。',
    ],
  },
  {
    at: 482,
    expect: 'function getBase64ByteLength(',
    text: ['// base64 字节数 = 有效字符数 * 3/4 - padding；忽略空白以兼容带换行的 base64。'],
  },
]);

apply('packages/ai/src/generate-speech/stream-speech.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// 流式语音合成 streamSpeech：把文本（字符串/迭代器/流）持续送入语音模型，边合成边下发音频。',
      '// 链路位置：streamSpeech -> resolveSpeechModel -> isStreamingSpeechModel 能力检查',
      '//   -> doStream -> TransformStream 归一化 -> fullStream / audioStream。',
      '// 与 streamTranscribe 相同的单所有权模型：流可能无界，不能缓存或重放。',
      '// 不变量：INV-01 audioStream 与 fullStream 只能取其一（守住 389-420）；',
      '//   INV-02 finish 前必须有音频，否则 NoSpeechGeneratedError（守住 295-300）；',
      '//   INV-03 未 finish 即结束要区分 "有音频/provider 错误" 与 "完全无声"（守住 219-228）。',
      '// ============================================================================',
    ],
  },
  {
    at: 53,
    expect: 'export function streamSpeech({',
    text: ['// 入口同步返回结果对象；provider 流由后台 IIFE 驱动，不会阻塞调用方。'],
  },
  {
    at: 173,
    expect: 'const usagePromise = new DelayedPromise<SpeechStreamUsage>();',
    text: [
      '// 结果 promise 组：usage/warnings/responses/providerMetadata，由 finish 统一 resolve。',
      '// [事务] finish 是唯一提交点；cancel/abort 通过 rejectPendingPromises 统一回滚。',
    ],
  },
  {
    at: 211,
    expect: 'const pipeAbortController = new AbortController();',
    text: [
      '// 输出流 cancel 时以明确 reason 中止 pipe；undefined reason 在 Node 26 会变成',
      '// 未处理的 rejection，因此必须显式构造错误。',
    ],
  },
  {
    at: 219,
    expect: 'const incompleteStreamError = () =>',
    text: [
      '// 流结束却没有 finish 时的错误选择：',
      '// 有音频 -> 暴露 provider 的最后错误（或 StreamProviderError）；无音频 -> NoSpeechGeneratedError。',
    ],
  },
  {
    at: 253,
    expect: "case 'audio': {",
    text: [
      '// audio 分支：base64 字符串先解码为字节；',
      '// 空块仅在携带 providerMetadata（如 end-of-turn 标记）时保留，',
      '// 且空块不计入 hasAudio。',
    ],
  },
  {
    at: 281,
    expect: "case 'error': {",
    text: [
      '// error part 非致命：记录 lastError、异步通知 onError（不 await、吞掉其异常），',
      '// 并把错误 part 透传给 fullStream；audioStream 会跳过它。',
    ],
  },
  {
    at: 290,
    expect: "case 'finish': {",
    text: [
      '// finish 提交：补齐 warnings、检查是否真的产出过音频、settle 全部结果 promise。',
      '// [事务] finished 标记供 flush 判断流是否正常收尾。',
    ],
  },
  {
    at: 311,
    expect: 'flush() {',
    text: ['// 未 finish 就关闭 -> 抛 incompleteStreamError，让消费方感知未完成。'],
  },
  {
    at: 333,
    expect: 'if (abortSignal != null) {',
    text: [
      '// 外部 abort 独立处理：即使 doStream 还在 pending 或 provider 忽略 signal，',
      '// 也要立刻让结果 promise 与输出流失败。',
    ],
  },
  {
    at: 389,
    expect: 'let streamOwner:',
    text: [
      '// 单所有权：语音流可能无界（长文本 LLM 流），输出只允许一个消费者且不缓存。',
      '// 三种 owner 互斥，第二个消费者直接抛错。',
    ],
  },
  {
    at: 450,
    expect: 'function createAudioByteStream(',
    text: [
      '// 用 pull 型 ReadableStream 投影音频字节，而不是再 pipeThrough 一次：',
      '// 这样提前 cancel 会直接取消上游 part 流，避免链式 pipe 产生未处理 rejection。',
    ],
  },
  {
    at: 517,
    expect: 'function toSourceStream(',
    text: [
      '// 三种来源归一：ReadableStream 直接用；AsyncIterable 取其 asyncIterator；',
      '// 同步 Iterable 包成 async generator，避免阻塞调用栈。',
    ],
  },
]);
