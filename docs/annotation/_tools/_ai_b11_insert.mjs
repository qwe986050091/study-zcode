import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';
const rel = 'packages/ai/src/generate-object/stream-object.ts';
const file = path.join(ROOT, rel);
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 1,
    expect: 'import { sanitizeRequestMetadata }',
    text: [
      '// ============================================================================',
      '// 流式结构化输出 streamObject：边生成 JSON 边解析，产出 partial object / text / element 多条投影流。',
      '// 链路位置：streamObject -> getOutputStrategy -> DefaultStreamObjectResult（本文件下半部分）',
      '//   -> model.doStream -> 文本拼接 + parsePartialJson -> outputStrategy.validatePartialResult',
      '//   -> baseStream（object/text-delta/finish/error）-> 各 getter 投影。',
      '// 与 generateObject 的分工：本文件只做单步结构化流，不含工具调用/多步；已标记 deprecated，',
      '//   新代码应使用 streamText + output 设置。',
      '// 不变量：INV-01 partial 必须在 JSON 变化且校验成功后才下发（守住 728-763）；',
      '//   INV-02 finish 是结果 promise 的唯一满足点（守住 822-845）；INV-03 终态错误只认第一个（守住 780-786）。',
      '// ============================================================================',
    ],
  },
  {
    at: 72,
    expect: 'markPromiseAsHandled',
    text: [
      '// 把已 reject 的 promise 标记为 handled，避免调用方未及时 catch 时触发 unhandledRejection。',
      '// 这不是吞错：错误仍会通过 promise 本身与 onError/onFinish 暴露。',
    ],
  },
  {
    at: 193,
    expect: 'export function streamObject<',
    text: [
      '// @deprecated 入口：保留旧 API 形状，内部转换为 DefaultStreamObjectResult。',
      '// output 默认 object；enum 需要显式传 enum 数组，no-schema 不需要 schema。',
      '// 本函数同步返回，真正的模型调用在构造函数内的 IIFE 中异步启动。',
    ],
  },
  {
    at: 402,
    expect: 'const enumValues =',
    text: ['// 只有 enum 模式才读取 enum 数组；用 in 判断兼容联合类型。'],
  },
  {
    at: 411,
    expect: 'validateObjectGenerationInput({',
    text: ['// 参数一致性校验：output/schema/enum 组合非法时在创建流之前失败。'],
  },
  {
    at: 419,
    expect: 'const outputStrategy = getOutputStrategy({',
    text: ['// 按 output 选择策略；此处已完成 schema 归一化，后续只面向 OutputStrategy 接口。'],
  },
  {
    at: 454,
    expect: 'class DefaultStreamObjectResult<',
    text: [
      '// 结果对象：持有 7 个 DelayedPromise（object/usage/.../finishReason）与一条 baseStream。',
      '// 所有 getter 都是同一条 baseStream 的不同投影，重复消费会因流已锁定而失败。',
    ],
  },
  {
    at: 459,
    expect: 'private readonly _object = new DelayedPromise<RESULT>();',
    text: [
      '// 每个字段一个 DelayedPromise：finish 时统一 resolve，错误时统一 reject。',
      '// [事务] 这些 promise 是 "最终结果" 的提交点，与 partial 流解耦：partial 可以无限发，',
      '// 但最终对象只在完整校验后 settle 一次。',
    ],
  },
  {
    at: 473,
    expect: 'private readonly baseStream: ReadableStream<ObjectStreamPart<PARTIAL>>;',
    text: [
      '// baseStream 是所有投影流的共同源头，由 stitchableStream 与 eventProcessor 组合而成。',
      '// [资源] 一旦被某个 getter pipe，流即被锁定，其他 getter 再读会抛错。',
    ],
  },
  {
    at: 549,
    expect: 'const stitchableStream =',
    text: [
      '// stitchableStream 允许在结束前追加一段错误流，保证消费方一定看到终止信号。',
      '// [并发] addStream/close 与读取异步协作，但同一时刻只允许构造函数这一个写者。',
    ],
  },
  {
    at: 552,
    expect: 'const eventProcessor = new TransformStream<',
    text: [
      '// 事件处理器：原样透传每个 chunk，仅在 error 时额外触发 onError。',
      '// 刻意不改变 chunk 内容，错误语义仍由 fullStream/结果 promise 承担。',
    ],
  },
  {
    at: 572,
    expect: '(async () => {',
    text: [
      '// 后台启动整条链路：从 jsonSchema 到 doStream 再到流转换都在这里串行执行。',
      '// 用 IIFE + catch + finally 保证任何阶段失败都能关闭 stitchableStream。',
    ],
  },
  {
    at: 614,
    expect: 'const callOptions = {',
    text: [
      '// 请求参数：responseFormat 固定为 json + schema，这是结构化输出的协议基础；',
      '// prompt 由 standardizePrompt/convertToLanguageModelPrompt 统一转换，includeRawChunks 关闭。',
    ],
  },
  {
    at: 648,
    expect: 'const transformer: Transformer<',
    text: [
      '// 第一层过滤：只保留文本增量、response-metadata、finish、error、stream-start，',
      '// 其余 chunk（reasoning/tool 等）在结构化输出场景没有意义，直接丢弃。',
    ],
  },
  {
    at: 672,
    expect: '} = await retry(() => model.doStream(callOptions));',
    text: [
      '// doStream 本身可重试；重试成功后才把 request/response 元数据落到 promise。',
      '// [失败路径] 重试耗尽会走外层 catch，统一 reject 并补发错误流。',
    ],
  },
  {
    at: 677,
    expect: 'let warnings: SharedV4Warning[] | undefined;',
    text: [
      '// 可变状态集中在 IIFE 作用域内，由单个 transform 串行写入；',
      '// 结果 promise 只读取这些状态，因此不需要额外同步。',
    ],
  },
  {
    at: 686,
    expect: "let accumulatedText = '';",
    text: [
      '// accumulatedText 是完整原文，供最终校验；textDelta 是自上次下发以来的增量。',
      '// 两者分离是为了让 partial 校验拿到 "本次新增"，同时保留全文用于 repair。',
    ],
  },
  {
    at: 698,
    expect: 'let latestObjectJson: JSONValue | undefined = undefined;',
    text: [
      '// latestObjectJson 用于去重（JSON 未变则不下发），latestObject 是已下发的 partial；',
      '// isFirstChunk/isFirstDelta 用于时间统计与 textDelta 的首轮语义。',
    ],
  },
  {
    at: 721,
    expect: "if (typeof chunk === 'string') {",
    text: [
      '// 文本分支：累积原文后立即尝试部分解析。',
      '// STEP-1 accumulatedText += chunk；STEP-2 parsePartialJson 得到当前 JSON 与解析状态；',
      '// STEP-3 与上次 JSON 深比较，变化才进入校验；STEP-4 校验成功且 partial 变化才下发。',
      '// [权衡] 每个 delta 都做一次部分解析，CPU 成本随文本增长，但换来最低的感知延迟。',
    ],
  },
  {
    at: 729,
    expect: 'currentObjectJson !== undefined',
    text: ['// JSON 未变化时跳过校验与下发：过滤掉只影响转义/空白的 delta，减少下游抖动。'],
  },
  {
    at: 732,
    expect: 'const validationResult =',
    text: [
      '// isFinalDelta 由解析状态推断（successful-parse）：只有完整可解析时才允许不丢弃末元素。',
      '// textDelta 传的是 "自上次下发以来" 的增量，与 outputStrategy 的契约一致。',
    ],
  },
  {
    at: 742,
    expect: 'validationResult.success &&',
    text: ['// 双重去重：校验成功且 partial 与上次不同才提交，避免相同对象重复入流。'],
  },
  {
    at: 779,
    expect: "case 'error': {",
    text: [
      '// 终态错误只认第一个：后续 error chunk 仍透传，但不再覆盖 finishReason 与结果 promise。',
      '// [失败路径] 这里调用 rejectResultPromises，让所有等待结果的调用方立刻失败。',
    ],
  },
  {
    at: 792,
    expect: "case 'finish': {",
    text: [
      '// finish 分支：STEP-1 补发未下发的 textDelta；STEP-2 记录 finishReason/usage/metadata；',
      '// STEP-3 无终态错误时 settle 结果 promise，并对完整原文做最终校验。',
      '// [事务] 一旦进入终态错误路径，只发 chunk 不 settle，避免与 catch 中的 reject 竞争。',
    ],
  },
  {
    at: 832,
    expect: 'object = await parseAndValidateObjectResultWithRepair(',
    text: [
      '// 最终校验可能触发 repairText（模型输出非法 JSON 时的兜底）；',
      '// 成功后 resolve _object，失败则保留 error 供 onFinish 使用。',
    ],
  },
  {
    at: 857,
    expect: 'async flush(controller) {',
    text: [
      '// writable 关闭时发 step-end 与 end 事件；即使前面发生错误也会执行，',
      '// 保证 onStepFinish/onFinish 与 telemetry 一定收到收尾事件。',
    ],
  },
  {
    at: 915,
    expect: 'stitchableStream.addStream(transformedStream, {',
    text: [
      '// 把转换后的流接入 stitchableStream；onError 把模型流错误转成终态错误。',
      '// [失败路径] onError 与 transform 内 error 分支可能重复触发，reject/track 都是幂等的。',
    ],
  },
  {
    at: 926,
    expect: '.catch(async error => {',
    text: [
      '// 外层兜底：jsonSchema/prompt 转换/doStream 任一失败都会到这里。',
      '// 先 reject 全部结果 promise，再补一段只含 error 的流，finally 中关闭 stitchableStream。',
    ],
  },
  {
    at: 946,
    expect: 'private rejectResultPromises(error: unknown) {',
    text: [
      '// 统一 reject 七个结果 promise；每个都先判 isPending，避免覆盖已提交的值。',
      '// markPromiseAsHandled 防止未 await 的 promise 触发 unhandledRejection。',
    ],
  },
  {
    at: 997,
    expect: 'get partialObjectStream(): AsyncIterableStream<PARTIAL> {',
    text: [
      '// 投影 1：只保留 object chunk，丢弃 text-delta/finish/error。',
      '// 因此 partialObjectStream 不会因错误而 reject，错误请通过 onError 或 fullStream 获取。',
    ],
  },
  {
    at: 1023,
    expect: 'get elementStream(): ELEMENT_STREAM {',
    text: ['// 投影 2：委托给策略的 createElementStream，仅 array 模式有实际元素。'],
  },
  {
    at: 1073,
    expect: 'export type ObjectStreamInputPart =',
    text: [
      '// 内部输入 part 联合：文本增量用裸 string 表示，其余复用 provider 的元数据/结束/错误形状。',
      '// 这样第一层 transformer 可以把 text-delta 降维成 string，简化下游判断。',
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
