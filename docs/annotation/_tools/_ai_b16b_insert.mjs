import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/batch/batch.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  { at: 0, expect: 'import {', text: [
    "// 【职责】批量任务 API：startBatch 提交一批 text/image 请求，getBatchStatus 查询状态，",
    "//   getBatchResults 以流的形式取回逐条终态结果，cancelBatch/listBatches 做治理。",
    "//",
    "// 【在链路中的位置】上游是用户在服务端编排的批处理作业；下游是 provider 的",
    "//   BatchV4 接口（experimental_batch）。文本请求在这里被完整预处理成",
    "//   LanguageModelV4CallOptions，因此它复用生成链路但不走 streamText。",
    "//",
    "// 【不变量】",
    "//   INV-01 结果流只产出终态条目，未完成条目不得入流。",
    "//     守住位置：convertBatchItemResult 只处理 succeeded/failed/cancelled/expired。",
    "//   INV-02 同一批内同名工具必须定义完全一致，否则拒绝提交。",
    "//     守住位置：validateCompatibleTools。",
    "//   INV-03 请求 id 非空且批内唯一。",
    "//     守住位置：validateRequests。",
    "//   INV-04 批引用必须属于同一个 provider，不能跨 provider 复用。",
    "//     守住位置：validateBatchReference。",
    "//   INV-05 结果流取消必须传导到上游请求，不能只是停止读取。",
    "//     守住位置：transformer.cancel 中的 streamAbortController。",
  ] },
  { at: 58, expect: 'export async function cancelBatch({', text: [
    "// 取消是幂等的服务端操作：本函数只负责校验能力与透传，不改变本地状态。",
    "// 先解析出 BatchV4 再校验批引用，顺序保证错误信息指向正确的对象。",
    "// 取消不做重试：重复取消由调用方决定，避免误伤已进入终态的批。",
    "// 所有错误统一经 wrapGatewayError 包装，保持与生成链路一致的错误形状。",
    "// 超时与调用方信号合并后作为唯一的 operationAbortSignal。",
  ] },
  { at: 69, expect: 'if (batchApi.doCancelBatch == null) {', text: [
    "// 能力探测：未实现 doCancelBatch 时直接抛 UnsupportedFunctionalityError，",
    "//   而不是静默成功——静默会让调用方误以为批已取消。",
    "// 这类错误不是参数错误，不应被 wrapGatewayError 转成网关错误，故放在 try 之外。",
    "// provider 完全不支持批处理的情况由 resolveBatchApi 负责报错。",
  ] },
  { at: 81, expect: 'try {', text: [
    "// 只把 provider 调用放进 try：参数校验错误应原样抛出，不被包装成网关错误。",
    "// headers 统一附加 User-Agent 后缀，便于服务端统计 SDK 版本。",
    "// providerOptions 原样透传，本层不解释其结构。",
  ] },
  { at: 96, expect: 'export async function listBatches({', text: [
    "// 列表接口可选：不支持时抛 UnsupportedFunctionalityError。",
    "// limit/cursor 用条件展开，未提供时字段完全不出现，避免把 undefined 传给 provider。",
    "// 分页游标由 provider 定义，本层只透传。",
    "// 返回的 batchId 统一重命名为 id，与其它批处理 API 的形状对齐。",
    "// 分页信息 nextCursor/providerMetadata 也只在存在时出现。",
  ] },
  { at: 108, expect: 'const doListBatches = batchApi.doListBatches?.bind(batchApi);', text: [
    "// 先 bind 再判空：把方法取出后判空，避免后续调用时丢失 this。",
    "// 取出即固定实现，列表过程中 provider 被替换也不影响本次调用。",
    "// 不支持列表视为能力缺失，必须与空列表区分开。",
  ] },
  { at: 120, expect: 'const { retry } = prepareRetries({', text: [
    "// 列表是只读操作，可安全重试；重试次数与信号由调用方控制。",
    "// 超时同样通过 abortSignal 表达，不额外引入定时器。",
  ] },
  { at: 136, expect: 'return {', text: [
    "// provider 返回 batchId，SDK 统一暴露为 id；version 固定为 2 表示新结构。",
    "// 其余状态字段原样展开，避免逐字段列举导致新增字段被丢弃。",
    "// provider 字段来自 batchApi，保证与批引用校验用的是同一个值。",
  ] },
  { at: 154, expect: 'export async function startBatch<', text: [
    "// 提交批处理：文本请求在这里完成从用户 prompt 到 provider 调用参数的全部转换。",
    "// 没有流式路径：批处理只接受完整请求，因此统一走 convertToLanguageModelPrompt。",
    "// supportedUrls 只取一次，供所有文本请求共用（provider 维度能力）。",
    "// 转换串行执行：工具定义一致性校验依赖跨请求的累积状态 toolsByName。",
    "// 每个请求转换后都复查 abort：长批次里用户取消要尽快生效。",
    "// 图片请求不需要工具与 prompt 标准化，走独立分支。",
    "// 请求类型是穷尽联合，default 分支用 never 兜底防止漏加新类型。",
    "// 返回的 warnings 会按 requestId 归属到具体模型后逐条记录日志。",
  ] },
  { at: 166, expect: 'validateRequests(requests);', text: [
    "// 先做纯本地校验再解析 provider：尽早失败，避免无谓的 provider 调用。",
    "// 空批、空 id、重复 id 都是调用方 bug，必须立即拒绝。",
    "// 校验不做 trim 归一化：id 原样提交给 provider，改了就无法对账。",
  ] },
  { at: 173, expect: 'const supportedUrls = await batchApi.supportedUrls;', text: [
    "// supportedUrls 可能是 Promise，await 后再用；随后立即复查取消。",
    "// 该值决定 prompt 里的 URL 是直传还是下载后内联，属于 provider 能力。",
    "// 对图片分支无影响：图片按 data 传输，不走 URL 支持表。",
  ] },
  { at: 178, expect: 'for (const request of requests) {', text: [
    "// 逐请求串行转换：顺序即提交顺序，结果流的条目顺序也与之一致。",
    "// 每个请求独立标准化 prompt 与工具，互不共享可变状态。",
    "// toolsByName 是唯一跨请求状态，用于强制同名工具定义一致（INV-02）。",
  ] },
  { at: 199, expect: '...prepareLanguageModelCallOptions(request),', text: [
    "// download: undefined 表示批处理不在此处下载远程文件，由 provider 侧处理。",
    "// provider 取 batchApi.provider 的第一段（如 gateway.openai 取 gateway），",
    "//   用于选择 prompt 中 provider 专属的元数据格式。",
    "// prompt 转换是异步的（可能触发 schema 校验），因此整个循环必须串行。",
    "// tools 与 toolChoice 都在此处准备完毕，provider 只做执行。",
  ] },
  { at: 215, expect: 'const { prompt, files, mask } = normalizeImagePrompt(request.prompt);', text: [
    "// 图片请求只做 prompt 归一化：文本与图像输入被拆成 prompt/files/mask。",
    "// n 默认 1；其余参数缺省即不传，交由 provider 决定默认值。",
    "// 图片请求不支持工具，因此不参与 toolsByName 校验。",
    "// providerOptions 为空时给空对象，避免 provider 侧判空分支。",
  ] },
  { at: 233, expect: 'default: {', text: [
    "// 穷尽检查：新增请求类型时此处编译失败，强制实现者补分支。",
    "// 运行时抛 InvalidArgumentError 而非 TypeError，便于调用方归类。",
    "// 不可能到达的分支也要保持与其它参数错误一致的错误形状。",
  ] },
  { at: 250, expect: 'const result = await batchApi.doStartBatch({', text: [
    "// 提交后 provider 返回 batchId + 状态 + 警告；batchId 单独取出，其余整体展开。",
    "// webhookUrl 只在提供时传，避免显式 undefined 影响 provider 的默认行为。",
    "// 提交不做重试：重复提交会创建重复批次，风险高于收益。",
    "// 所有异常统一包装为网关错误。",
  ] },
  { at: 262, expect: 'for (const { requestId, warning } of warnings) {', text: [
    "// 警告按 requestId 归属到具体模型：批内不同请求可能用不同模型。",
    "// requestId 为空表示批次级警告，此时 model 传 undefined。",
    "// 逐条调用 logWarnings 而不是合并，保证日志里的 provider/model 归属正确。",
    "// 警告不影响提交结果，只记录不中断。",
  ] },
  { at: 282, expect: 'function validateCompatibleTools({', text: [
    "// 同名工具在批内必须定义完全一致：provider 侧通常只注册一份工具表，",
    "//   不一致会导致部分请求按错误 schema 执行，且很难从结果里看出来。",
    "// 用深比较而不是引用比较：用户可能为每个请求各自写一份等价定义。",
    "// 先比较再写入，保证第一次出现的定义成为基准。",
    "// toolsByName 的键是工具名，值是完整定义（含 inputSchema 等）。",
    "// 只在 text 请求上调用；image 请求没有工具概念。",
  ] },
  { at: 309, expect: 'export async function getBatchStatus({', text: [
    "// 状态查询是只读且可重试的：失败重试不会产生副作用。",
    "// 先校验批引用，保证 provider 与 batch.provider 匹配（INV-04）。",
    "// 返回的状态原样透传：不同 provider 的状态枚举由类型层约束。",
    "// 不做缓存：调用方需要的是最新状态。",
  ] },
  { at: 349, expect: 'export function getBatchResults<TOOLS extends ToolSet>({', text: [
    "// 结果以流形式返回：批可能很大，一次性物化会爆内存。",
    "// 返回值为 AsyncIterableStream，调用方可用 for await 消费。",
    "// 内部启动一个不被 await 的 async IIFE：把 provider 流桥接到 TransformStream，",
    "//   错误通过 abort writable 传给读取端，而不是抛到调用处。",
    "// 取消信号有两个来源：调用方 abortSignal 与流自身的 cancel。",
    "// 取消后必须让上游请求也停止，否则会继续消耗配额（INV-05）。",
    "// 该函数同步返回：流在后台建立，建立失败也通过流的错误通道报告。",
  ] },
  { at: 362, expect: 'const streamAbortController = new AbortController();', text: [
    "// 专用 controller 用于把读端取消转成 abort 信号，与调用方信号合并。",
    "// 合并后的信号同时用于：建立 provider 流、逐条转换、pipeTo。",
    "// 三个信号任一触发都会中止整条链路，这是刻意的取消即全局语义。",
    "// 该 controller 只被 cancel 回调使用，不对外暴露。",
  ] },
  { at: 372, expect: 'const transformer: Transformer<BatchV4ItemResult, BatchItemResult<TOOLS>> & {', text: [
    "// 逐条转换：provider 的结果结构转换为 SDK 的 BatchItemResult。",
    "// transform 里 await 转换，保证下游看到的条目已完成工具调用解析。",
    "// 转换失败会让流进入错误态，而不是跳过该条目。",
  ] },
  { at: 385, expect: 'cancel(reason) {', text: [
    "// 读端取消：用取消原因中止上游，未提供原因时构造一个可识别的错误。",
    "// abort 后 pipeTo 会以 AbortError 结束，进而走下面的 catch 分支。",
    "// 这里不等待上游完成，保持 cancel 同步返回。",
  ] },
  { at: 396, expect: 'void (async () => {', text: [
    "// 后台桥接：建立 provider 流，然后 pipeTo 转换器的 writable。",
    "// 用 void 明确表示不等待：错误只能通过 abort writable 传给读端。",
    "// pipeTo 传 signal，使取消能立即中断正在进行的读取。",
    "// catch 里对 writable.abort 再 catch：读端可能已关闭，此时 abort 会抛错。",
    "// 该 IIFE 不能抛出未处理拒绝，否则会变成进程级 unhandledRejection。",
    "// 成功路径不显式 close：pipeTo 结束会自动关闭 writable。",
  ] },
  { at: 418, expect: 'function resolveBatchApi(provider?: BatchProvider): BatchV4 {', text: [
    "// 三种 provider 形态都要支持，顺序不能换：",
    "//   1) 已经是 BatchV4（鸭子类型）→ 直接用；",
    "//   2) 有 experimental_batch 工厂 → 调用它拿到 BatchV4；",
    "//   3) 都没有 → 抛 UnsupportedFunctionalityError。",
    "// 未传 provider 时回退到 globalThis.AI_SDK_DEFAULT_PROVIDER，再回退到 gateway。",
    "// 工厂每次调用都会新建实例：调用方不应假设多次解析得到同一对象。",
    "// 错误信息明确提示需要 experimental_batch，降低接入成本。",
  ] },
  { at: 436, expect: 'function hasBatchFactory(', text: [
    "// 类型守卫：只检查方法存在且是函数，不检查签名。",
    "// 用 as 绕过联合类型，避免 ProviderV4 未声明该可选方法时的类型报错。",
    "// 真正的能力校验由 isBatchApi 在拿到实例后完成。",
  ] },
  { at: 445, expect: 'function isBatchApi(provider: BatchProvider): provider is BatchV4 {', text: [
    "// 鸭子类型判定：三个方法齐全即认为是 BatchV4。",
    "// 故意不检查 doCancelBatch/doListBatches，它们是可选能力。",
    "// 该判定让自定义 provider 直接实现接口也可用，无需走工厂。",
  ] },
  { at: 454, expect: 'function validateRequests(requests: ReadonlyArray<{ readonly id: string }>) {', text: [
    "// 批请求的本地校验，三条规则一次遍历完成：非空、id 非空（trim 后）、id 唯一。",
    "// 用 Set 记录已见 id，O(n) 完成唯一性检查。",
    "// 错误里带原始 requests 值，便于调用方定位是哪个批。",
    "// 不校验每个请求的 model/prompt，那属于 provider 侧或后续转换。",
    "// 空 id 用 trim 判断：纯空白 id 在 provider 侧通常会被拒绝得更晚。",
    "// 该函数不返回任何值，失败即抛错。",
  ] },
  { at: 486, expect: 'function validateBatchReference({', text: [
    "// 批引用必须与解析出的 provider 一致：批 id 只在创建它的 provider 下有效。",
    "// 不一致通常意味着调用方把不同 provider 的批混用，属于编程错误。",
    "// 错误信息同时给出两个 provider 名，便于定位。",
    "// 该校验在每个接受批引用的 API 入口都要执行一次。",
  ] },
  { at: 504, expect: 'async function convertBatchItemResult<TOOLS extends ToolSet>({', text: [
    "// 逐条结果的形状适配：provider 的 BatchV4ItemResult 转成 SDK 的 BatchItemResult。",
    "// 只有终态才被转换（INV-01）：这里没有处理中的分支，因为流只产出终态。",
    "// 外层按 type（text/image）分派，内层按 status 分派，两层都穷尽。",
    "// 失败/取消/过期三种非成功态的载荷结构相同，直接透传 error 与 providerMetadata。",
    "// 成功态的载荷差异很大，交给专门的转换函数。",
    "// cancelled 与 expired 共用分支，但 status 原样保留，调用方可区分。",
    "// 两个 switch 都没有 default：新增类型/状态时 TypeScript 会报缺少返回值。",
  ] },
  { at: 513, expect: 'switch (item.type) {', text: [
    "// text 的成功结果需要解析工具调用，因此是异步的；image 是纯同步映射。",
    "// 这里的 tools 来自调用方，用于给 tool-call 补 schema 与类型。",
    "// 解析失败会让整条结果流失败，而不是丢弃该条目。",
  ] },
  { at: 545, expect: "case 'image':", text: [
    "// 图片结果没有工具概念，直接映射 images/warnings/response/usage。",
    "// 与文本分支一样，非成功状态在上一层的 switch 里已处理。",
  ] },
  { at: 575, expect: 'function convertImageResult(', text: [
    "// 把原始字节包装成 DefaultGeneratedFile，并推断 mediaType。",
    "// 推断失败时回退 image/png：多数 provider 默认输出 PNG。",
    "// providerMetadata 按图片下标取值，支持逐图元数据。",
    "// response 只保留 timestamp/modelId/headers，剔除 provider 内部字段。",
  ] },
  { at: 603, expect: 'async function convertGenerateResult<TOOLS extends ToolSet>({', text: [
    "// 文本结果的转换分两步：先解析工具调用，再统一转换内容片段。",
    "// 与 streamText 的区别：批处理没有流式增量，也没有工具执行循环，",
    "//   因此 repairToolCall / refineToolInput / instructions 全部传 undefined，",
    "//   且 messages 传空数组——批处理不携带对话历史。",
    "// toolOutputs 与审批相关字段都为空：批处理不在本地执行工具。",
    "// 返回结构对齐 generateText 的结果形状，便于调用方复用解析逻辑。",
    "// 该函数是批处理与生成链路唯一的语义交汇点，改动需同时兼顾两边。",
    "// result.content 被遍历两次（解析与拼接文本），是刻意的可读性取舍。",
  ] },
  { at: 612, expect: 'const toolCalls = await Promise.all(', text: [
    "// 并行解析所有 tool-call：彼此独立，且 parseToolCall 可能异步（schema 校验）。",
    "// 只挑出 tool-call 片段，其余内容交给 convertLanguageModelContent 处理。",
    "// Promise.all 保序，解析结果与 content 一一对应。",
  ] },
  { at: 628, expect: 'const content = await convertLanguageModelContent<TOOLS>({', text: [
    "// 内容转换复用生成链路的实现，保证同一份 provider 输出在两条链路里形状一致。",
    "// abortSignal 透传：转换可能触发文件下载等可取消操作。",
    "// 返回的 content 已包含解析后的 tool-call 输入。",
  ] },
];

for (const a of anchors) {
  if (!lines[a.at].includes(a.expect)) {
    console.error(`EXPECT FAIL at ${a.at}: ${lines[a.at]}`);
    process.exit(1);
  }
}

for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
  lines.splice(a.at, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
