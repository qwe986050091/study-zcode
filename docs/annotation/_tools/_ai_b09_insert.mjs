import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';

function apply(rel, anchors) {
  const file = path.join(ROOT, rel);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\r\n');

  for (const a of anchors) {
    const idx = a.at - 1;
    const actual = lines[idx];
    if (idx < 0 || idx >= lines.length || !actual.includes(a.expect)) {
      console.error(`MISS ${rel} @${a.at} expect=${a.expect} actual=${actual}`);
      process.exit(1);
    }
  }

  const sorted = [...anchors].sort((x, y) => y.at - x.at);
  for (const a of sorted) {
    lines.splice(a.at - 1, 0, ...a.text);
  }

  fs.writeFileSync(file, lines.join('\r\n'));
  console.log(`OK ${rel} +${anchors.reduce((s, a) => s + a.text.length, 0)}`);
}

apply('packages/ai/src/generate-object/output-strategy.ts', [
  {
    at: 1,
    expect: "import {",
    text: [
      '// ============================================================================',
      '// 输出策略（output strategy）—— generateObject / streamObject 的 "Schema -> 校验/流" 适配层。',
      '// 链路位置：streamObject / generateObject -> getOutputStrategy -> 本文件策略对象 ->',
      '//   validatePartialResult/validateFinalResult（每个 JSON 分片）与 createElementStream（数组流）。',
      '// 设计要点：把 object/array/enum/no-schema 四种输出模式的差异收敛到同一接口，',
      '//   上层只依赖 OutputStrategy，不感知 JSON Schema 的包装细节。',
      '// 不变量：',
      '//   INV-01 jsonSchema() 的返回必须与 validateFinalResult 接受的输入形状一致（守住 152、319 的包装）。',
      '//   INV-02 数组模式在非 final delta 时必须丢弃最后一个元素（守住 194）。',
      '//   INV-03 enum 模式只做前缀匹配，不把不完整值判为失败（守住 370-374）。',
      '// ============================================================================',
    ],
  },
  {
    at: 30,
    expect: 'export interface OutputStrategy<',
    text: [
      '// 策略接口：上层只依赖这四件事，四种模式各自实现。',
      '// jsonSchema 用于构造发给模型的 JSON Schema；validatePartialResult 处理逐步到达的 JSON；',
      '// validateFinalResult 处理最终完整 JSON；createElementStream 只对数组模式有意义。',
      '// PARTIAL/RESULT/ELEMENT_STREAM 三个泛型分别约束 "中间对象 / 最终结果 / 元素流" 的类型。',
    ],
  },
  {
    at: 33,
    expect: 'jsonSchema(): Promise<JSONSchema7 | undefined>;',
    text: [
      '// 返回 undefined 表示该模式无需向模型声明 schema（no-schema 模式）。',
      '// 其余模式必须返回可序列化的 draft-07 schema，供 provider 的 structured output 能力使用。',
    ],
  },
  {
    at: 35,
    expect: 'validatePartialResult({',
    text: [
      '// 部分结果校验：value 是当前累计解析出的 JSON，textDelta 是本次新增的原始文本。',
      '// 返回的 partial 会替换上一轮的 partial，textDelta 会以流事件下发给调用方。',
      '// 注意：这里不重新校验 textDelta 与 partial 的一致性，一致性由 JSON 解析器的单调性保证。',
    ],
  },
  {
    at: 51,
    expect: 'validateFinalResult(',
    text: [
      '// 最终结果校验：value 为 undefined 表示模型没有产出可解析的 JSON。',
      '// context 携带原始文本、响应元数据与 usage，用于构造 NoObjectGeneratedError。',
    ],
  },
  {
    at: 60,
    expect: 'createElementStream(',
    text: [
      '// 元素流：把 ObjectStreamPart 流转换为逐元素流，仅数组模式支持。',
      '// 之所以放在策略里，是因为 "哪些 chunk 算新元素" 依赖各模式的 partial 语义。',
    ],
  },
  {
    at: 65,
    expect: 'const noSchemaOutputStrategy',
    text: [
      '// no-schema 模式：模型返回什么就用什么，不做类型校验；输出类型为 JSONValue。',
      '// 该模式没有元素流概念，createElementStream 一律抛错。',
    ],
  },
  {
    at: 69,
    expect: 'async validatePartialResult({ value, textDelta }) {',
    text: ['// 原样透传 partial，等价于 "信任模型输出"。'],
  },
  {
    at: 73,
    expect: 'async validateFinalResult(',
    text: [
      '// 只区分 "是否产出过内容"：undefined 视为失败，其余原样返回。',
      '// 错误里带上 text/response/usage/finishReason，方便定位是模型空响应还是解析失败。',
    ],
  },
  {
    at: 82,
    expect: 'return value === undefined',
    text: [
      '// 失败路径需要构造 NoObjectGeneratedError；',
      '// 成功路径不做任何转换，保持 JSONValue 原样。',
    ],
  },
  {
    at: 96,
    expect: 'createElementStream() {',
    text: [
      '// no-schema 没有 "元素" 概念，元素流属于未支持功能。',
      '// 抛 UnsupportedFunctionalityError 而不是返回空流，避免调用方静默拿到空结果。',
    ],
  },
  {
    at: 103,
    expect: 'const objectOutputStrategy',
    text: [
      '// object 模式：最终结果交给 schema 校验，partial 阶段不做校验（JSON 尚不完整）。',
      '// 泛型 OBJECT 由 schema 推导；partial 类型是 DeepPartial<OBJECT>，允许流式阶段字段缺失。',
      '// 该模式没有元素流，ELEMENT_STREAM 为 never。',
    ],
  },
  {
    at: 109,
    expect: 'async validatePartialResult({ value, textDelta }) {',
    text: [
      '// partial 直接做 DeepPartial 断言返回：这里刻意不校验。',
      '// 原因：逐个 delta 校验既昂贵，又会把 "合法的不完整 JSON" 误判为错误；',
      '// 真正的类型约束留到 validateFinalResult 一次性完成。',
    ],
  },
  {
    at: 120,
    expect: 'async validateFinalResult(',
    text: [
      '// 最终校验委托给 safeValidateTypes，失败时返回 ValidationResult 而非抛异常。',
    ],
  },
  {
    at: 133,
    expect: 'const arrayOutputStrategy',
    text: [
      '// array 模式：把 "顶层数组" 包装成 { elements: [...] } 对象，兼容大多数模型的 structured output。',
      '// 相比 object 模式多出两件事：jsonSchema 里剥离并上提 definitions；',
      '// 以及基于游标（publishedElements）的增量元素流。',
    ],
  },
  {
    at: 142,
    expect: 'jsonSchema: async () => {',
    text: [
      '// 先把 items 自身的 $schema/definitions/$defs 剥掉，避免嵌套 schema 出现两个根；',
      '// 再把 definitions/$defs 上提到包装后的根对象，保证 #/definitions/... 引用仍可解析。',
      '// [权衡] 只支持 draft-07 的 definitions 与 2020-12 的 $defs，其它方言不迁移。',
      '// 包装体固定 required:[elements] 且 additionalProperties:false，减少模型跑偏。',
    ],
  },
  {
    at: 166,
    expect: 'async validatePartialResult({',
    text: [
      '// STEP 1 形状检查：value 必须是含 elements 数组的对象，否则直接失败。',
      '// STEP 2 逐元素用 schema 校验，收集已确定的元素。',
      '// STEP 3 丢弃最后一个元素（除非 isFinalDelta），因为它很可能只解析了一半。',
      '// STEP 4 依据 latestObject 的长度计算 "新增了多少元素"，拼出与之一致的 textDelta。',
      '// [权衡] textDelta 是重新序列化得到的，不保证与模型原始文本逐字相同，但能保证 JSON 合法。',
    ],
  },
  {
    at: 186,
    expect: 'for (let i = 0; i < inputArray.length; i++) {',
    text: [
      '// 顺序校验：safeValidateTypes 可能是 async（如需要异步 refine），',
      '// 因此这里用 for + await 而不是 Promise.all，保证失败短路且不浪费并发。',
    ],
  },
  {
    at: 194,
    expect: 'if (i === inputArray.length - 1 && !isFinalDelta) {',
    text: [
      '// 非 final delta 时跳过最后一个元素：它是 "正在生成中" 的不完整值。',
      '// [失败路径] 若把它纳入结果，partial 会在下一步被覆盖，元素流也可能提前吐出错值。',
      '// isFinalDelta 为 true 才说明该元素已完整，可以参与校验。',
    ],
  },
  {
    at: 205,
    expect: '// calculate delta:',
    text: [
      '// 增量文本：把 resultArray 中 "尚未发布" 的部分序列化后拼接。',
      '// publishedElementCount 来自上一轮 partial 的长度，天然充当游标。',
      '// 首轮补 [、末轮补 ]，中间用逗号分隔，保证拼出的文本始终是合法 JSON 数组片段。',
    ],
  },
  {
    at: 218,
    expect: 'textDelta += resultArray',
    text: [
      '// 只取 slice(publishedElementCount) 之后的新元素，避免重复下发；',
      '// 序列化保证元素内部不会出现破坏流式拼接的裸换行。',
    ],
  },
  {
    at: 236,
    expect: 'async validateFinalResult(',
    text: [
      '// 最终校验：结构与 partial 相同（elements 数组），但对每个元素都要求通过 schema。',
      '// 与 partial 的区别只有一点：不再跳过最后一个元素。',
    ],
  },
  {
    at: 265,
    expect: 'createElementStream(',
    text: [
      '// 元素流实现：用 TransformStream 把对象流 "拆开"，逐元素 enqueue。',
      '// 游标 publishedElements 是本次调用的闭包变量，每次 createElementStream 都会重置，',
      '// 因此同一个策略对象可以被多次消费而不会串游标。',
      '// [并发] 该 TransformStream 是有状态的，不能被两个消费者同时 pipe。',
    ],
  },
  {
    at: 268,
    expect: 'let publishedElements = 0;',
    text: [
      '// 已发布元素计数，只增不减，是判断 "哪些元素是新的" 的唯一依据。',
      '// [并发] 单消费者模型：若流被 tee 成两支，这个游标会被两个分支共享而错乱。',
    ],
  },
  {
    at: 279,
    expect: 'for (',
    text: [
      '// 从游标位置一直 enqueue 到数组末尾；循环结束游标停在 array.length，',
      '// 下一轮 object chunk 到达时只会发布新增部分。',
    ],
  },
  {
    at: 290,
    expect: "case 'text-delta':",
    text: [
      '// 这些 chunk 不产生新元素：text-delta 是原始文本、finish 是收尾、error 交给 onError。',
      '// 刻意在此吞掉 error，避免元素流被错误中断——错误语义由上层 streamObject 结果承载。',
    ],
  },
  {
    at: 310,
    expect: 'const enumOutputStrategy',
    text: [
      '// enum 模式：把枚举包装成 { result: string } 对象，最终值必须是 enumValues 之一。',
      '// 之所以包装，是因为多数模型无法直接产出顶层 enum。',
      '// [权衡] 前缀匹配在 partial 阶段可能给出多个候选，此时保留原始输入而非猜测。',
    ],
  },
  {
    at: 319,
    expect: 'jsonSchema: async () => ({',
    text: [
      '// 固定 draft-07 包装：result 字段的 enum 即调用方传入的枚举集合。',
      '// additionalProperties:false 阻止模型自造字段；required:[result] 保证结构完整。',
      '// 该包装与 validateFinalResult 的形状检查一一对应（INV-01）。',
    ],
  },
  {
    at: 329,
    expect: 'async validateFinalResult(',
    text: [
      '// 最终校验：先查形状（对象且 result 为 string），再查枚举成员资格。',
      '// 两步分开是为了给出不同错误信息，便于定位是 "结构错" 还是 "值不在枚举内"。',
    ],
  },
  {
    at: 357,
    expect: 'async validatePartialResult({ value, textDelta }) {',
    text: [
      '// partial 校验：只做形状检查 + 前缀匹配，不做成员资格判定。',
      '// 原因：流式阶段 result 可能只到达 "po"，此时尚不能确定是 "positive" 还是 "post"。',
      '// [失败路径] 空串或没有任何候选前缀时判失败，避免把无意义中间态下发给调用方。',
      '// 有唯一候选时直接采用该候选，否则保留原始输入，等后续字符到达再收敛。',
    ],
  },
  {
    at: 370,
    expect: 'const possibleEnumValues',
    text: [
      '// 前缀过滤：enumValues.filter(startsWith(result))，全量扫描即可（枚举通常很小）。',
      '// 不做大小写归一化，避免改变调用方声明的枚举字面量。',
      '// 候选只剩一个时说明已经收敛，可以提前把 partial 确定为该值。',
    ],
  },
  {
    at: 374,
    expect: 'if (value.result.length === 0 || possibleEnumValues.length === 0) {',
    text: [
      '// 空串没有信息量；无候选说明当前输入不在任何枚举前缀路径上，二者都判失败。',
    ],
  },
  {
    at: 394,
    expect: 'createElementStream() {',
    text: [
      '// enum 模式没有元素概念，元素流抛未支持功能。',
      '// 与 no-schema 一致：显式抛错优于返回空流，避免调用方误以为 "流正常结束"。',
    ],
  },
  {
    at: 403,
    expect: 'export function getOutputStrategy',
    text: [
      '// 工厂：把 output 字符串分派到具体策略，并在此处完成 schema 的 asSchema 归一化。',
      '// 四种模式互斥，default 分支用 never 做穷尽性检查，新增模式时编译器会强制补全。',
      '// [权衡] schema!/enumValues! 使用非空断言，因为调用方已按 output 类型约定传参。',
    ],
  },
  {
    at: 412,
    expect: 'switch (output) {',
    text: [
      '// 分派表：object/array 需要 schema，enum 需要 enumValues，no-schema 无需任何输入。',
      '// 注意 asSchema 只做一次，策略对象内部不再重复归一化，避免每次 delta 都付出转换成本。',
    ],
  },
]);

apply('packages/ai/src/generate-image/generate-image.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// 图像生成入口 generateImage：把一次逻辑请求拆成 N 个模型调用，并聚合结果。',
      '// 链路位置：generateImage -> resolveImageModel -> retry(model.doGenerate)',
      '//   -> 结果归一化（DefaultGeneratedFile / providerMetadata / usage）-> DefaultGenerateImageResult。',
      '// 不变量：',
      '//   INV-01 n 张图必须被拆成 ceil(n / maxImagesPerCall) 次调用（守住 callCount 计算）。',
      '//   INV-02 空图响应仅在 provider 未标记 isRetryable=false 时重试（守住 224）。',
      '// ============================================================================',
    ],
  },
  {
    at: 40,
    expect: 'const gatewayCostMetadataKeys = [',
    text: [
      '// gateway 成本字段白名单：只有这些键在多次调用合并时需要做十进制累加。',
      '// 其余键走普通覆盖，避免把非数值字段当成金额处理。',
    ],
  },
  {
    at: 54,
    expect: 'class RetryableNoImageResultError',
    text: [
      '// 内部错误：把 "空图但可重试" 与 "调用失败" 区分开，',
      '// 通过 prepareRetries 的 additionalRetryableError 交给重试器处理。',
    ],
  },
  {
    at: 87,
    expect: 'export async function generateImage({',
    text: [
      '// 公共入口：n 张图可能被拆成多次调用；所有调用并发执行，任一调用失败即整体失败。',
    ],
  },
  {
    at: 171,
    expect: 'const model = resolveImageModel(modelArg);',
    text: [
      '// 解析模型（字符串 id 或实例），后续都通过 model.* 访问能力与元数据。',
    ],
  },
  {
    at: 178,
    expect: 'const { retry } = prepareRetries({',
    text: [
      '// 重试器：除常规网络/限流错误外，额外把 RetryableNoImageResultError 视为可重试。',
    ],
  },
  {
    at: 187,
    expect: 'const maxImagesPerCallWithDefault =',
    text: [
      '// 单次调用上限：优先用调用方参数，其次问模型，最后兜底 1。',
    ],
  },
  {
    at: 191,
    expect: 'const callCount = Math.ceil(',
    text: [
      '// 分片：前 callCount-1 次都取满 maxImagesPerCall，',
      '// 最后一次取余数（整除时同样取满），保证总数恰好为 n。',
      '// [权衡] 不做负载均衡，避免 provider 侧计费/去重逻辑因调用大小不一致而行为不同。',
    ],
  },
  {
    at: 201,
    expect: 'const resultGroups = await Promise.all(',
    text: [
      '// [并发] 所有分片并发执行；每个分片内部用 retry 包裹，失败会重试整个分片而非单张图。',
      '// 返回值是 "分片 -> 该分片所有成功调用的结果数组"，稍后 flat 展平。',
      '// [资源] 并发度等于 callCount，调用方需自行通过 n/maxImagesPerCall 控制规模。',
    ],
  },
  {
    at: 224,
    expect: 'if (result.images.length === 0 && result.isRetryable !== false) {',
    text: [
      '// 空图视为可重试；provider 显式标记 isRetryable=false 时尊重其判定，不重试。',
    ],
  },
  {
    at: 233,
    expect: 'const noImageResultError =',
    text: [
      '// 重试耗尽后 RetryError 包裹最后一次错误，需要拆包识别 "空图" 这种软失败；',
      '// 软失败不抛出，而是返回已收集到的结果（可能为空），最终由 343 行统一判错。',
    ],
  },
  {
    at: 252,
    expect: 'const images: Array<GeneratedFile> = [];',
    text: [
      '// 聚合容器：images/calls/warnings/responses/providerMetadata/usage 按调用顺序累积。',
    ],
  },
  {
    at: 262,
    expect: 'for (const result of results) {',
    text: [
      '// 逐调用归一化：原始字节包成 GeneratedFile，并补上按图片索引提取的 provider metadata。',
    ],
  },
  {
    at: 296,
    expect: "if (providerName === 'gateway') {",
    text: [
      '// gateway 元数据特殊处理：成本字段跨调用累加（十进制字符串），',
      '// 空的 images 数组要删除，避免下游把 "占位空数组" 误当成真实数据。',
    ],
  },
  {
    at: 343,
    expect: 'if (!images.length) {',
    text: [
      '// 全部调用都没产出图片时统一抛 NoImageGeneratedError，并带上所有调用的诊断信息。',
    ],
  },
  {
    at: 389,
    expect: 'export function getImageProviderMetadata(',
    text: [
      '// 兼容旧的 providerMetadata.<provider>.images[index] 形状，抽取单张图的元数据。',
    ],
  },
  {
    at: 410,
    expect: 'async function invokeModelMaxImagesPerCall(',
    text: [
      '// maxImagesPerCall 允许是函数（依赖 modelId 动态计算），这里统一求值。',
    ],
  },
  {
    at: 422,
    expect: 'function addDecimalStrings(',
    text: [
      '// 十进制字符串加法：先按小数点对齐补零，再用 BigInt 求和，最后还原小数点。',
      '// [权衡] 不用 Number 是为了避免浮点误差；非法输入直接返回 undefined 而非抛错。',
      '// 末尾去掉多余的尾零，保持与 provider 返回值风格一致。',
    ],
  },
  {
    at: 450,
    expect: 'export function normalizePrompt(',
    text: [
      '// 统一 prompt 形状：字符串直传，对象则把 images/mask 转成 ImageModelV4File。',
    ],
  },
  {
    at: 464,
    expect: 'function toImageModelV4File(',
    text: [
      '// DataContent -> ImageModelV4File：http(s) 走 url，data: 走 base64 解码，其余按字节处理。',
      '// mediaType 优先用 data URL 自带类型，其次嗅探，最后兜底 image/png。',
    ],
  },
]);

apply('packages/ai/src/embed/embed-many.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// 批量向量化 embedMany：按模型的 "每次调用上限" 切分输入，并发调用后按序合并。',
      '// 链路位置：embedMany -> 能力探测（maxEmbeddingsPerCall / maxInputBytes / parallel）',
      '//   -> 无限制快路径 或 分片并发路径 -> validateEmbeddingCount -> DefaultEmbedManyResult。',
      '// 不变量：',
      '//   INV-01 输出 embeddings 的顺序必须与输入 values 完全一致（守住 438-457 的顺序合并）。',
      '//   INV-02 每个分片的结果数必须等于该分片输入数（守住 validateEmbeddingCount）。',
      '//   INV-03 分片的 startIndex 必须在 await 之前捕获（守住 367-369）。',
      '// ============================================================================',
    ],
  },
  {
    at: 182,
    expect: 'validateEmbeddingDimensions(dimensions);',
    text: [
      '// 先校验 dimensions 再解析模型：非法参数应在任何网络调用之前失败。',
      '// 允许为 undefined（表示使用模型默认维度）。',
    ],
  },
  {
    at: 186,
    expect: 'const { maxRetries, retry } = prepareRetries({',
    text: [
      '// 每个分片独立重试；maxRetries 同时会写入 startEvent 供观测。',
    ],
  },
  {
    at: 200,
    expect: 'const telemetryDispatcher = createRestrictedTelemetryDispatcher({',
    text: [
      '// embedMany 使用受限 telemetry（不含敏感字段），与 generateText 的完整 dispatcher 不同。',
    ],
  },
  {
    at: 209,
    expect: 'const startEvent = {',
    text: [
      '// 顶层 start 事件：携带全部输入（values 完整列表），只发一次。',
      '// 分片级事件由后续的 doEmbed start/end 单独发出。',
    ],
  },
  {
    at: 222,
    expect: 'return await runInTracingChannelSpan({',
    text: [
      '// 整个操作包在一个 tracing span 内，onStart 在 span 内、try 之前发出。',
    ],
  },
  {
    at: 242,
    expect: 'const hasEmbeddingLimit =',
    text: [
      '// 能力探测结果转成布尔：null/Infinity 都表示 "无上限"。',
      '// 两条上限（条数、UTF-8 字节数）任一存在就必须走分片路径。',
    ],
  },
  {
    at: 247,
    expect: 'if (!hasEmbeddingLimit && !hasInputByteLimit) {',
    text: [
      '// 快路径：只有一次模型调用，不需要切分，也不需要保序合并。',
      '// [权衡] 保留这条分支是为了避免给最常见场景引入分片/合并的复杂度与额外校验开销。',
    ],
  },
  {
    at: 249,
    expect: 'await retry(async () => {',
    text: [
      '// 快路径的重试体：内部发送 doEmbed 的 start/end 事件，失败时由 retry 统一重放。',
    ],
  },
  {
    at: 334,
    expect: 'const valueChunks = splitByEmbeddingLimits({',
    text: [
      '// 分片路径：按条数与字节数双重上限切分，返回值保持输入顺序。',
    ],
  },
  {
    at: 358,
    expect: 'const parallelChunks = splitArray(',
    text: [
      '// 再把分片按并发度分组：不支持并行的模型强制并发度为 1，退化为串行。',
    ],
  },
  {
    at: 363,
    expect: 'let nextChunkStartIndex = 0;',
    text: [
      '// 全局游标：按 "组内分片顺序" 推进，用于给 providerOptionsTransformer 提供原始下标范围。',
    ],
  },
  {
    at: 367,
    expect: '// Capture the range before awaiting transformations or retrying.',
    text: [
      '// [并发] startIndex 必须在任何 await 之前同步捕获：',
      '// 若在 await 之后读取 nextChunkStartIndex，其他并发分支可能已把它推进，导致下标错位。',
    ],
  },
  {
    at: 438,
    expect: 'for (const result of results) {',
    text: [
      '// 按组内顺序合并（Promise.all 保序），因此最终 embeddings 与 values 顺序一致（INV-01）。',
      '// providerMetadata 按 provider 浅合并，同名字段后者覆盖前者。',
    ],
  },
  {
    at: 499,
    expect: 'function validateEmbeddingCount({',
    text: [
      '// 防御 provider 少返/多返：数量不符直接抛 InvalidResponseDataError，绝不静默截断。',
    ],
  },
  {
    at: 516,
    expect: 'function splitByEmbeddingLimits({',
    text: [
      '// 单遍贪心切分：尽量把 value 塞进当前分片，超限才开新分片。',
      '// 不做回溯，因为单个 value 超限时无论怎么切都无法满足，交由 provider 报错更清晰。',
    ],
  },
  {
    at: 541,
    expect: 'for (const value of values) {',
    text: [
      '// [资源] 用 TextEncoder 计算 UTF-8 字节数，与 provider 的计费口径保持一致。',
      '// 每次只保留 currentChunk，峰值内存与输入规模线性相关。',
    ],
  },
  {
    at: 563,
    expect: 'class DefaultEmbedManyResult implements EmbedManyResult {',
    text: [
      '// 结果对象：纯数据容器，不做校验，字段顺序与公共 API 一致。',
    ],
  },
]);

apply('packages/ai/src/transcribe/transcribe.ts', [
  {
    at: 1,
    expect: 'import type {',
    text: [
      '// ============================================================================',
      '// 语音转写入口 transcribe：把 DataContent 或 URL 统一成可发送的音频，再调用转写模型。',
      '// 链路位置：transcribe -> 音频准备（直传 URL / 下载 / 字节化）-> retry(doGenerateFromUrl|doGenerate)',
      '//   -> 校验 text -> 发送 end 事件 -> DefaultTranscriptionResult。',
      '// 不变量：INV-01 准备阶段失败也必须发 start 事件（守住 235-252）；INV-02 URL 直传失败可回退下载（守住 282-300）。',
      '// ============================================================================',
    ],
  },
  {
    at: 144,
    expect: 'const resolvedModel = resolveTranscriptionModel(model);',
    text: ['// 解析模型；失败直接抛错，此时还没有 callId，不产生任何 telemetry 事件。'],
  },
  {
    at: 149,
    expect: 'const { maxRetries, retry } = prepareRetries({',
    text: ['// 重试器覆盖 "下载回退后的 doGenerate" 整段逻辑。'],
  },
  {
    at: 160,
    expect: 'const telemetryDispatcher = createTelemetryDispatcher({ telemetry });',
    text: ['// telemetry dispatcher 负责 onStart/onEnd/onError 与 tracing span 的桥接。'],
  },
  {
    at: 166,
    expect: 'const createStartEvent = ({',
    text: [
      '// start 事件工厂：音频元信息在准备阶段之后才可知，因此用工厂延迟构造。',
      '// callId/operationId 固定，byteLength 与 mediaType 允许为 undefined（URL 直传时）。',
    ],
  },
  {
    at: 188,
    expect: 'const executeWithStartEvent = async <T>({',
    text: ['// 统一包装：在 tracing span 内先发 onStart，再执行真正的调用，保证事件顺序稳定。'],
  },
  {
    at: 208,
    expect: 'let preparationError: unknown;',
    text: [
      '// 准备阶段错误先捕获不抛，等 start 事件发出后再以同一错误结束，避免 telemetry 缺头。',
      '// 这两个变量只在准备阶段写入，之后只读，因此不需要额外同步。',
    ],
  },
  {
    at: 213,
    expect: 'try {',
    text: [
      '// 准备策略三选一：模型支持原生 URL 且使用默认下载器时直传 URL；',
      '// 否则下载为字节（自定义 download 强制下载，便于调用方控制大小/鉴权）；',
      '// DataContent 直接转 Uint8Array。',
    ],
  },
  {
    at: 235,
    expect: 'if (preparationFailed) {',
    text: [
      '// [失败路径] 准备失败仍走 executeWithStartEvent：span 与 onStart 正常发出，',
      '// 随后抛出原错误，由外层 catch 触发 onError。',
    ],
  },
  {
    at: 254,
    expect: 'let mediaType =',
    text: ['// mediaType 优先级：下载响应头 > 字节嗅探 > audio/wav 兜底。'],
  },
  {
    at: 273,
    expect: 'const result = await retry(async () => {',
    text: [
      '// 重试体内每次都会重新判断 audioData 类型：',
      '// 回退下载后就地改写为字节，后续重试走文件路径。',
    ],
  },
  {
    at: 282,
    expect: 'if (audioData instanceof URL) {',
    text: ['// 原生 URL 转写失败（provider 返回 null）时不报错，而是下载后走 doGenerate 重试。'],
  },
  {
    at: 291,
    expect: 'const downloaded = await downloadFn({',
    text: ['// [资源] 回退下载复用同一个 downloadFn 与 abortSignal，下载后同步刷新 mediaType/byteLength。'],
  },
  {
    at: 315,
    expect: 'if (result.text == null) {',
    text: ['// text 为 null 视为 "没有产出转写"，抛 NoTranscriptGeneratedError 并带上响应。'],
  },
  {
    at: 371,
    expect: 'function getAudioMediaType(',
    text: ['// 只接受完整的 audio/* 类型；application/octet-stream 等交给字节嗅探。'],
  },
  {
    at: 382,
    expect: 'class DefaultTranscriptionResult implements TranscriptionResult {',
    text: ['// 结果容器：providerMetadata 缺省为 {}，避免调用方到处判空。'],
  },
]);

console.log('DONE');
