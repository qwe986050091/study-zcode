import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';

// 1) restricted-telemetry 补 3 行达到 31%
{
  const file = path.join(ROOT, 'packages/ai/src/generate-text/restricted-telemetry-dispatcher.ts');
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const idx = lines.findIndex(l => l.includes('onAbort: event =>'));
  if (idx < 0) {
    console.error('MISS onAbort');
    process.exit(1);
  }
  lines.splice(idx, 0,
    '// abort 事件在流式调用被取消时发出，可能一步都没完成，因此 steps 允许为空数组。',
    '// 这里不做 finalStep 之类的派生字段，避免为空数组时产生 undefined 访问。',
    '// 与 onEnd 一样，只暴露裁剪后的 context，不暴露原始 runtimeContext。',
  );
  fs.writeFileSync(file, lines.join('\r\n'));
  console.log('OK restricted +3');
}

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
    at: 341,
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
