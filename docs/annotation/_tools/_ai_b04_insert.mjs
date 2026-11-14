// AI-deep-b04：单次模型调用内核 + 小工具文件。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

const plan = [
  {
    rel: 'packages/ai/src/generate-text/stream-language-model-call.ts',
    edits: [
      {
        at: 1,
        expect: 'import {',
        text: [
          '// streamLanguageModelCall：一次模型调用的完整前端——标准化提示、准备工具、',
          '// 发起 doStream、把 provider 的原生 part 翻译成 SDK 内部 part。',
          '//',
          '// 链路位置：streamText 的 callLanguageModel 直接调用它；',
          '// 下游是 executeToolsFromStream / eventProcessor。',
          '// 它不负责重试、超时与多 step：这些由调用方在更外层编排。',
          '//',
          '// STEP-1 提示归一：standardizePrompt → convertToLanguageModelPrompt（含 URL 下载，只做一次）。',
          '// STEP-2 工具归一：prepareTools 处理 schema 与顺序，prepareToolChoice 归一选择策略。',
          '// STEP-3 回调与遥测：onStart 先拿到完整 prompt，随后 onLanguageModelCallStart。',
          '// STEP-4 翻译流：provider part 逐个映射，补齐类型化 tool-call、计时与结束校验。',
          '//',
          '// INV-01：convertToLanguageModelPrompt 每个 step 只能成功执行一次：',
          '// 它会下载 URL 资源，重复执行既浪费也可能造成同一文件下载两次。',
          '// INV-02：model-call-end 必须无条件下发，即使随后因工具选择违约而下发 error；',
          '// 否则下游拿不到 usage 与 finishReason，step 会退化成空结果。',
          '// INV-03：tool-call 先登记到 toolCallsByToolCallId，再决定是否外发；',
          '// provider 的审批请求与结果都靠这个表找到对应的调用。',
          '// INV-04：toolChoice=none 时工具类 part 一律扣留（withholdToolParts），',
          '// 防止客户端工具在被判定违约之前就已经执行。',
        ],
      },
      {
        at: 91,
        expect: 'export type LanguageModelStreamPart<',
        text: [
          '// 内部流协议：比用户可见的 TextStreamPart 更窄、更贴近 provider。',
          '// 刻意排除 finish / stream-start / start-step 等 step 级与终态 part：',
          '// 这些由 streamText 的状态机产生，不属于"一次模型调用"的输出。',
          '// 额外加入 model-call-start / model-call-end / model-call-response-metadata，',
          '// 让调用方能在不解析内容的情况下拿到本次调用的元数据。',
        ],
      },
      {
        at: 203,
        expect: 'export async function streamLanguageModelCall<',
        text: [
          '// 单次调用入口：返回 { stream, request, response }，',
          '// 其中 stream 是 AsyncIterableStream，可多次读取（内部已做缓冲）。',
          '// 注意 request / response 是"调用建立后"的元数据，流本身仍可能中途报错。',
          '// 所有 callSettings 通过剩余参数透传，避免每加一个采样参数就改签名。',
        ],
      },
      {
        at: 302,
        expect: 'const resolvedModel = resolveLanguageModel(model);',
        text: [
          '// 模型可能是字符串 id，先统一解析成 LanguageModel 实例；之后只使用 resolvedModel。',
          '// callId 由调用方传入（同一次 streamText 共用），没有时生成一个独立 id。',
        ],
      },
      {
        at: 305,
        expect: 'const standardizedPrompt = await standardizePrompt({',
        text: [
          '// 归一提示：把 instructions / system / prompt / messages 四种入口收敛成统一形状。',
          '// 互斥校验也在这里完成，因此下面的代码不需要再判断"用户到底传了哪种"。',
        ],
      },
      {
        at: 313,
        expect: 'const promptMessages = await convertToLanguageModelPrompt({',
        text: [
          '// 转成 provider 可用的 prompt：这一步会下载远程文件，因此必须只执行一次（见 INV-01）。',
          '// supportedUrls 是异步的：部分 provider 需要运行时才能确定支持的 URL 形态。',
          '// provider 名取点号前缀：网关型 provider 常是 "gateway.openai" 这类复合名。',
          '// download 与 abortSignal 一起下发，保证中途取消能打断下载。',
        ],
      },
      {
        at: 324,
        expect: 'const stepTools = await prepareTools({',
        text: [
          '// 工具归一（异步）：可能触发 schema 转换，结果直接进入请求体。',
          '// toolOrder 决定声明顺序，部分 provider 对顺序敏感（影响缓存命中）。',
        ],
      },
      {
        at: 331,
        expect: 'const stepToolChoice = prepareToolChoice({',
        text: [
          '// 选择策略归一成 provider 可识别的形状；none 会在翻译阶段触发扣留逻辑。',
        ],
      },
      {
        at: 335,
        expect: 'await notify({',
        text: [
          '// onStart 在请求发出前触发，且只带 promptMessages：',
          '// 此时还没有 response，调用方适合在这里做请求前的最后检查或日志。',
          '// notify 会吞掉单个回调的错误，不影响本次调用（见 streamText 的回调约定）。',
        ],
      },
      {
        at: 358,
        expect: 'const callStartTimestampMs = now();',
        text: [
          '// 计时基准放在请求发出前一刻：性能指标要包含建连时间，而不只是首包之后。',
          '// now 可注入，测试里用固定时钟验证 token/s 的计算。',
        ],
      },
      {
        at: 360,
        expect: 'const {',
        text: [
          '// 遥测包装只负责建立 span 与记录耗时，返回值原样透传；',
          '// 因此它不改变控制流，异常仍按普通 throw 处理。',
          '// request 在这里做一次脱敏：只保留 origin，避免把密钥写进遥测。',
        ],
      },
      {
        at: 367,
        expect: 'const result = await resolvedModel.doStream({',
        text: [
          '// 真正的 provider 调用：responseFormat 是 Promise（Output 规范可能需要异步构造）。',
          '// 所有 callSettings 先展开再覆盖 tools / prompt 等关键字段：',
          '// 防止调用方通过剩余参数意外覆盖它们。',
          '// abortSignal 继续向下传，provider 应据此中断底层 HTTP 请求。',
        ],
      },
      {
        at: 387,
        expect: 'const standardizedStream = languageModelStream.pipeThrough(',
        text: [
          '// 翻译层用 TransformStream 而不是手动循环：背压可以自然传递到 provider。',
          '// 传入 request 只为在 onLanguageModelCallEnd 事件里附带 origin，不参与内容处理。',
          '// collectContent 由内存策略控制：false 时不累积内容，只做翻译与计时。',
        ],
      },
      {
        at: 455,
        expect: 'const toolCallsByToolCallId = new Map<string, TypedToolCall<TOOLS>>();',
        text: [
          '// 三张索引表各司其职：toolCallsByToolCallId 供审批/结果回查，',
          '// textPartIndexes / reasoningPartIndexes 让增量写入不依赖 provider 的分片顺序。',
          '// raw* 系列保存 provider 原始内容，用于错误诊断与 tool 违约时的证据。',
          '// [资源] 索引在 end 时删除，避免长流中无限增长。',
        ],
      },
      {
        at: 462,
        expect: 'let responseId = generateId();',
        text: [
          '// 响应元数据可被 provider 覆盖：先给本地生成的兜底值，收到 response-metadata 后再替换。',
          '// responseModelId 单独维护：finish 事件要用最终模型 id，而不是请求时的 id。',
          '// 三个计时变量只服务性能统计，collectContent=false 时仍保留（开销很小）。',
        ],
      },
      {
        at: 472,
        expect: "const withholdToolParts = toolChoice.type === 'none';",
        text: [
          '// [权衡] toolChoice=none 时仍然解析工具调用（为了在 finish 时判定违约），',
          '// 但所有工具类 part 一律不外发：',
          '// 若先外发再报错，客户端工具可能已经执行了副作用，违背 none 的语义。',
          '// 因此修复/精炼回调也不传入：不允许"帮助"一个本不该出现的调用通过校验。',
          '// 内容仍会进入 modelCallContent，供违约错误携带证据。',
        ],
      },
      {
        at: 478,
        expect: 'async transform(chunk, controller) {',
        text: [
          '// 翻译顺序固定：计时 → 扣留判断 → 分派 → 入账。',
          '// [并发] transform 由流规范串行调用，Map 与累加数组无需同步。',
          '// 这里可以 await（下载文件、解析工具调用），背压会让 provider 暂停读取。',
          '// 任何异常都应转成 error part，而不是 throw：throw 会直接终止整条流，',
          '// 让调用方失去"部分结果已经可用"的机会。',
        ],
      },
      {
        at: 479,
        expect: 'if (isOutputChunk(chunk)) {',
        text: [
          '// 只有"语义输出"参与计时：空 delta、start/end、ping 都不算。',
          '// 首个输出时间用于计算 inputTokensPerSecond（首包前的输入处理速度），',
          '// 之后的间隔序列用于 p10/median/p90，帮助定位卡顿是偶发还是持续。',
          '// 记录发生在分派之前：即使该 part 因扣留不外发，它依然是真实产出。',
        ],
      },
      {
        at: 502,
        expect: 'switch (chunk.type) {',
        text: [
          '// 按 provider part 类型分派，每个分支都要同时处理两件事：',
          '// 1) 写入内容账本（受 collectContent 控制）；2) 决定是否/如何外发。',
          '// text / reasoning 走 upsert，其余多为直接映射或加元数据。',
          '// 缺省分支只处理 custom / source：未知类型不应出现，出现则原样透传。',
        ],
      },
      {
        at: 503,
        expect: "case 'error':",
        text: [
          '// provider 错误先归一化成 SDK 错误：保留 statusCode / responseBody 等诊断字段。',
          '// 注意这里只是外发 error part，流不会因此关闭，是否重试由外层决定。',
        ],
      },
      {
        at: 524,
        expect: "case 'text-delta':",
        text: [
          '// 累积用 delta，外发用 text：内部字段名与 provider 对齐，外部协议保持稳定。',
          '// 空 delta 也会外发：它可能携带 providerMetadata 更新，丢弃会丢失元数据。',
        ],
      },
      {
        at: 544,
        expect: "case 'text-end':",
        text: [
          '// 结束时删除索引：既释放内存，也让"结束后再来 delta"变成一次新的 upsert。',
        ],
      },
      {
        at: 610,
        expect: "case 'file':",
        text: [
          '// 文件数据可能是 URL 或 base64，统一解析成可读取的 GeneratedFile。',
          '// [资源] 解析会 await 下载，abortSignal 确保取消能打断；',
          '// 因此这个分支可能显著慢于文本分支，属于正常的背压点。',
        ],
      },
      {
        at: 638,
        expect: "case 'finish': {",
        text: [
          '// finish 同时是"统计点"和"校验点"：先算性能指标并触发 onLanguageModelCallEnd，',
          '// 再做工具选择校验，最后才下发 model-call-end。',
          '// 回调放在校验之前：即使这次调用违约，调用方也需要看到真实的 usage 与耗时。',
          '// effective* 以整段耗时计，非 effective 的 outputTokensPerSecond 以首包后耗时计，',
          '// 两者刻意不同：前者反映端到端吞吐，后者反映解码速度。',
          '// timeBetweenOutputChunksMs 为空数组时给 undefined，避免报告无意义的统计量。',
        ],
      },
      {
        at: 692,
        expect: 'const enforcedToolChoice =',
        text: [
          '// auto 不构成约束，只有 none / required / 指定工具需要校验。',
          '// none：出现过任何工具调用即违约；',
          '// required：必须至少有一个调用；指定工具：必须出现该工具的调用。',
          '// interrupted 例外：模型被打断时不应因"没来得及调用"而判违约。',
          '// [权衡] 违约判定使用统一 finishReason，而不是 provider 原始值：',
          '// 各 provider 对"无工具"的表达不一致，只有统一值才可跨 provider 比较。',
        ],
      },
      {
        at: 719,
        expect: "type: 'model-call-end',",
        text: [
          '// 即使违约也先发 model-call-end（见 INV-02），但把 finishReason 改成 error：',
          '// 下游据此既拿到用量，又知道这一步不能算作正常完成。',
          '// 随后单独发 error part：两者顺序不可颠倒，否则下游可能先看到错误就丢弃用量。',
        ],
      },
      {
        at: 740,
        expect: "case 'tool-call': {",
        text: [
          '// 工具调用要经过解析、修复、精炼三道关，全部在 parseToolCall 内完成。',
          '// 先登记再外发（见 INV-03）：审批请求可能紧随其后，需要按 id 找到完整调用。',
          '// 无效调用只对非 provider 执行的情况补发 tool-error：',
          '// provider 自己执行的工具由 provider 负责报错，框架重复报错会污染历史。',
          '// [失败路径] 解析抛错转成 error part：单个坏调用不应杀死整条流。',
        ],
      },
      {
        at: 787,
        expect: "case 'tool-approval-request': {",
        text: [
          '// 审批请求不携带完整调用，只带 toolCallId；必须能查到对应调用才可外发。',
          '// 查不到说明 provider 乱序或 id 不一致：发 ToolCallNotFoundForApprovalError，',
          '// 让问题在协议层暴露，而不是让 UI 拿到一个无法展示的审批。',
        ],
      },
      {
        at: 818,
        expect: "case 'tool-result': {",
        text: [
          '// 这里处理的是 provider 侧执行的结果（providerExecuted=true），',
          '// 本地工具的结果由执行器产生，不经过这个分支。',
          '// isError 为真时映射成 tool-error：对消费者而言"失败的结果"不是结果，',
          '// 混在同一种 part 里会让 UI 与统计都难以区分。',
          '// 调用信息（input / toolMetadata）从登记表回填，保证结果与调用可配对。',
        ],
      },
      {
        at: 862,
        expect: "case 'tool-input-start': {",
        text: [
          '// 输入开始时补齐工具静态元数据（dynamic / title / metadata）：',
          '// 这些信息来自本地工具定义，provider 不会发送。',
        ],
      },
      {
        at: 874,
        expect: "case 'stream-start': {",
        text: [
          '// provider 的 stream-start 转成 model-call-start：warnings 在这里首次可得。',
          '// 不转发原始类型，避免内部协议泄漏 provider 概念。',
        ],
      },
      {
        at: 882,
        expect: "case 'response-metadata': {",
        text: [
          '// 元数据既外发也内部留存：finish 事件要用最终的 responseModelId，',
          '// 而不是请求时解析出的 modelId（网关可能路由到别的模型）。',
        ],
      },
      {
        at: 913,
        expect: 'function isOutputChunk(',
        text: [
          '// "输出"的定义：非空文本/推理/工具输入增量，以及文件与完整工具调用。',
          '// 空 delta 不算：provider 常发空串占位，计时会严重低估首包延迟。',
          '// 这个判定同时被超时检测复用，因此必须与语义保持一致。',
        ],
      },
      {
        at: 924,
        expect: 'function calculateOutputChunkTimingStats(',
        text: [
          '// 最近秩百分位：对小样本比插值更稳健，也不需要额外依赖。',
          '// 入参已保证非空（调用点判过 length），因此这里不处理空数组。',
          '// 排序用副本：调用方可能还要按时间序使用原数组。',
        ],
      },
      {
        at: 950,
        expect: 'function upsertTextContentPart<TOOLS extends ToolSet>({',
        text: [
          '// text / reasoning 共用的累积器：第一次见到 id 时创建空 part 并记录下标，',
          '// 之后按下标原地追加，避免每次 delta 都线性查找。',
          '// [权衡] 用下标而不是对象引用：数组可能因其他 part 插入而移动，下标更稳定。',
          '// content 与 rawContent 同步维护：前者是 SDK 形状，后者保留 provider 原貌。',
          '// enabled=false 时直接返回：低内存模式不保留任何内容。',
          '// providerMetadata 采用覆盖而不是合并：以最后一次更新为准。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/stream-text-single-consumer-result.ts',
    edits: [
      {
        at: 1,
        expect: 'import type',
        text: [
          '// 单消费者结果视图：低内存模式下 streamText 返回的门面类型。',
          '// 只暴露流与完成元数据，刻意隐藏文本/工具等"最终内容" getter，',
          '// 因为这些内容在该模式下不保留（retention.collectContent=false）。',
          '// 目的不是限制能力，而是把"读不到"从运行时异常提前成编译期错误。',
        ],
      },
      {
        at: 30,
        expect: 'export function createSingleConsumerStreamTextResult<',
        text: [
          '// 用 Pick 收窄接口，再以对象字面量逐项转发：',
          '// 显式列表能保证新增 getter 不会被自动暴露，必须人工确认是否适合单消费者模式。',
        ],
      },
      {
        at: 39,
        expect: 'return {',
        text: [
          '// 流类属性用 getter 转发：保持惰性，读取时才建立投影，避免提前 tee 出多余分支。',
          '// [并发] 这些 getter 共享同一个底层流，因此只能有一个消费者（见 INV-05）。',
        ],
      },
      {
        at: 67,
        expect: 'consumeStream: result.consumeStream.bind(result),',
        text: [
          '// 方法类转发必须 bind：否则调用时 this 丢失，内部访问不到 result 的私有字段。',
          '// 与 getter 不同，这里绑定的是函数本身，调用几次都指向同一个 result。',
        ],
      },
      {
        at: 71,
        expect: 'pipeUIMessageStreamToResponse:',
        text: [
          '// 传输层方法原样转发：单消费者模式仍然可以直接写响应，',
          '// 因为协议转换只需要流，不需要保留最终内容。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/stream-retry-attempt-boundary.ts',
    edits: [
      {
        at: 1,
        expect: 'import type',
        text: [
          '// 流重试边界的内部标记 part。',
          '// 它不承载内容，只告诉下游"上一条尝试作废，从这里开始是新尝试"。',
          '// 用 Symbol 作键：普通消费者遍历 part 时看不到它，避免污染公开协议。',
        ],
      },
      {
        at: 3,
        expect: 'const streamRetryAttemptBoundarySymbol',
        text: [
          '// 模块私有 Symbol：即使别的包构造出同形状对象，也无法伪装成边界 part。',
        ],
      },
      {
        at: 21,
        expect: 'export function isStreamRetryAttemptBoundaryPart(',
        text: [
          '// 结构化判断必须容忍非对象输入：流里的 part 来自外部，不能假设形状。',
          '// 用 in 而不是读属性值：标记为 true 的语义由存在性表达，读取值没有意义。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/is-output-chunk.ts',
    edits: [
      {
        at: 8,
        expect: 'const isOutputChunkType = {',
        text: [
          '// 先按类型建白名单表，再对需要看内容的类型做二次判断。',
          '// satisfies 保证这里的键覆盖所有 part 类型：新增 part 时编译期就会报错，',
          '// 强制作者显式决定它算不算"输出"，避免默认值悄悄改变超时行为。',
          '// [权衡] 用对象常量而不是 Set：查表更快，且类型可以精确到字面量键。',
        ],
      },
      {
        at: 35,
        expect: '} as const satisfies Record<',
        text: [
          '// 这里的 Exclude 排除重试边界：它是控制信号，永远不算输出。',
          '// 表里的布尔值只是"候选"，最终还要看增量是否为空。',
        ],
      },
      {
        at: 40,
        expect: 'export function isOutputChunk(',
        text: [
          '// 两层判定：先查表快速排除，再对增量类 part 检查内容长度。',
          '// 该函数被超时检测与空流判定共用，因此必须对同一 part 给出稳定答案。',
        ],
      },
      {
        at: 47,
        expect: 'switch (chunk.type) {',
        text: [
          '// 只有增量类需要看长度：start/end 是边界事件，文件与 tool-call 是完整对象。',
          '// default 分支理论上不可达（表已过滤），保留是为了让类型收窄成立。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/util/create-stitchable-stream.ts',
    edits: [
      {
        at: 21,
        expect: 'let innerStreams: Array<{',
        text: [
          '// 队列语义：同一时刻只有队首流被读取，读完自动切到下一条。',
          '// 每条内层流单独保存 reader 与回调：错误与取消要能精确归因到某一条。',
          '// [资源] 外层被取消时必须逐条 cancel，否则内层流会继续运行并占住句柄。',
          '// [并发] addStream 可以在任意时刻调用，但 pull 本身不会并发执行。',
        ],
      },
      {
        at: 31,
        expect: 'const terminate = () => {',
        text: [
          '// terminate 是"立即终止"：关外层、取消所有内层、清空队列。',
          '// 与 close 的区别：close 会等内层流自然读完，terminate 不等。',
          '// 先 resolve 等待中的 pull，避免它永远挂在 waitForNewStream 上。',
        ],
      },
      {
        at: 47,
        expect: 'const processPull = async () => {',
        text: [
          '// pull 的四种状态在这里穷举：',
          '// 1) 已关闭且无内层流 → close；2) 无内层流 → 等待新增；',
          '// 3) 当前流读完 → 出队并继续；4) 读到值 → 直接入队。',
          '// 递归调用 processPull 而不是循环：逻辑更直观，但深度受内层流数量限制，',
          '// 实际使用中每次 addStream 都是一条独立流，深度很小。',
          '// [失败路径] 任一内层流报错都会终止整条外层流：拼接流不提供"跳过坏流"的语义。',
        ],
      },
      {
        at: 104,
        expect: 'stream: new ReadableStream<T>({',
        text: [
          '// start 只保存 controller：所有入队都由 processPull 驱动，符合背压模型。',
          '// cancel 不抛错：取消是正常路径，内层流的 cancel 失败不应反过来影响外层。',
        ],
      },
      {
        at: 121,
        expect: 'addStream: (',
        text: [
          '// 已取消时新流立即 cancel 并回调 onCancel：调用方据此释放自己的资源。',
          '// 已关闭时抛错而不是静默丢弃：这是调用方的时序 bug，应尽早暴露。',
          '// 入队后 resolve waitForNewStream，唤醒可能正在等待的 pull。',
        ],
      },
    ],
  },
];

let totalAdded = 0;
for (const { rel, edits } of plan) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let added = 0;
  for (const e of sorted) {
    const idx = e.at - 1;
    if (!lines[idx] || !lines[idx].includes(e.expect)) {
      console.error(`MISS ${rel} ${e.at} :: ${e.expect}`);
      console.error('  actual: ' + JSON.stringify(lines[idx]));
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    added += e.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`ADDED ${rel} +${added}`);
  totalAdded += added;
}
console.log('TOTAL ' + totalAdded);
