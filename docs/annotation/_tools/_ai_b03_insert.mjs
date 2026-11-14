// AI-deep-b03：stream-text.ts 深度注释（单文件批次）。
import fs from 'node:fs';

const REL = 'packages/ai/src/generate-text/stream-text.ts';
const FILE = 'D:/code/opensource/ai/' + REL;

const edits = [
  {
    at: 1,
    expect: 'import',
    text: [
      '// streamText：多步、可工具调用、可重试的流式生成引擎（本文件是全库最核心的入口）。',
      '//',
      '// 链路（从外到内）：',
      '//   streamText / streamTextLowMemory → startStreamText → streamTextInternal（归一选项、合并超时与 abort）',
      '//   → DefaultStreamTextResult 构造函数（装配流与事件处理器）→ 消费者读取各种投影。',
      '//',
      '// STEP-1 选项归一：超时拆成 total / step / firstChunk / chunk 四类，合并成一个 abortSignal。',
      '// STEP-2 装配：stitchableStream（可追加模型调用）→ abort 包装 → stopStream 闸门 → 用户 transform',
      '//        → output 转换（partialOutput）→ eventProcessor（聚合 step 结果与回调）。',
      '// STEP-3 运行：异步 IIFE 中 standardizePrompt → onStart → 处理历史审批 → 逐步调用模型',
      '//        → 收集 tool-call → 执行工具/审批 → 判断停止条件 → 决定是否进入下一步。',
      '// STEP-4 收口：写入 steps / usage / finishReason / responseMessages，触发 onEnd，关闭流。',
      '//',
      '// INV-01：流一旦被消费就必须能结束。任何抛错路径都要 reject 结果 Promise 并 error/close 流，',
      '// 否则 await result.text 会永久挂起（守住它的位置：rejectResultPromises 与 pull 的 catch）。',
      '// INV-02：provider 分配的 text / reasoning id 只在单次模型调用内唯一，跨 step 必须重映射，',
      '// 否则消费者会把两段内容当成同一段（守住它的位置：createPartIdReserver）。',
      '// INV-03：重试边界之前的 part 已经发给消费者，无法撤回；重试后只重建当前 step，',
      '// 已完成的 step 与工具结果必须保留（守住它的位置：applyStreamTextTransforms 的分段读取）。',
      '// INV-04：stopStream 之后不得再向消费者发 part；闸门必须在用户 transform 之外，',
      '// 否则 transform 内部的缓冲会漏出（守住它的位置：isRunning 闸门）。',
      '// INV-05：retention.replay=false 时只能有一个流消费者，且结果内容可能被丢弃；',
      '// 任何新 getter 都必须先检查 retention 再决定是否可读。',
      '// INV-06：abort 与"真实错误"必须分开处理：abort 走 onAbort + type:abort part，',
      '// 不能伪装成普通错误（守住它的位置：pull 里的 isAbortError 分支）。',
      '// INV-07：DelayedPromise 只允许 settle 一次；重复 resolve / reject 会静默丢值。',
      '// INV-08：回调（onChunk / onStepEnd / onToolExecutionEnd）抛错不能阻断流，',
      '// 但也不能被静默吞掉——统一交给协商后的错误通道。',
      '//',
      '// 阅读建议：先看 340~460（入口与装配），再看 1641 起的 eventProcessor（状态机），',
      '// 最后看 2261 起的历史审批处理与 2448 起的单 step 超时管理。',
    ],
  },
  {
    at: 191,
    expect: 'type StreamTextRetention',
    text: [
      '// 内存保留策略：replay 决定能否多次消费流，collectContent 决定是否记录结果内容。',
      '// 二者独立：低内存模式可能仍需回调（collectContent=true），但不需要重放。',
    ],
  },
  {
    at: 311,
    expect: 'type StreamTextOptions',
    text: [
      '// 选项类型：用户可见配置 + 内部 _internal 测试钩子。',
      '// 这里的 JSDoc 是公开 API 文档，新增注释以"行为契约与默认值原因"为主，不复述字段类型。',
    ],
  },
  {
    at: 387,
    expect: 'export function streamText<',
    text: [
      '// 公开入口一：完整能力版。返回对象支持多次 tee 与全部结果 getter。',
      '// 真正的装配在 startStreamText；本函数只做转发，便于两套入口共享同一引擎。',
    ],
  },
  {
    at: 401,
    expect: 'export function streamTextLowMemory<',
    text: [
      '// 公开入口二：单消费者、低内存版。共享同一执行引擎，关闭 replay 与内容收集，',
      '// 适合边缘运行时或长会话；代价是流只能消费一次、部分结果字段不可用。',
    ],
  },
  {
    at: 414,
    expect: '// Decide before execution so getter access cannot change collection.',
    text: [
      '  // 在创建流之前就决定是否收集内容：创建后再判断会让 getter 访问顺序影响内存行为，',
      '  // 也会让同一份代码在不同调用路径下表现不一致。',
    ],
  },
  {
    at: 430,
    expect: 'return createSingleConsumerStreamTextResult(',
    text: ['  // retention 通过 _internal 注入：这是内部契约，用户传入的同名字段不会覆盖它。'],
  },
  {
    at: 441,
    expect: 'function startStreamText<',
    text: [
      '// 两套入口的公共装配点：steering 运行状态必须在这里创建，',
      '// 因为后续任何一步失败都需要把它标记为结束，避免悬挂。',
    ],
  },
  {
    at: 448,
    expect: 'const steeringRun = startSteeringRun(',
    text: ['  // steering 只影响"后续 step 是否继续"，不参与本次模型调用参数。'],
  },
  {
    at: 456,
    expect: '// the call can fail before the stream starts',
    text: ['    // 同步抛错（例如非法设置）也要结束 steering：否则调用方拿不到结果却留下活跃状态。'],
  },
  {
    at: 924,
    expect: 'const resolvedToolCallConcurrency',
    text: [
      '  // [资源] 超时拆成四个层级：总时长、单 step、首 chunk、chunk 间隔。',
      '  // 拆开是因为故障含义不同：首 chunk 超时通常是网络或鉴权，',
      '  // chunk 间隔超时通常是 provider 卡住，总时长是兜底。',
    ],
  },
  {
    at: 930,
    expect: 'const stepAbortController',
    text: [
      '  // 每类超时一个独立 AbortController：都会 merge 进总 abortSignal，',
      '  // 但保留单独引用，便于错误归因时判断是哪个层级先触发。',
    ],
  },
  {
    at: 936,
    expect: 'const onError: StreamTextOnErrorHandler =',
    text: [
      '  // onError 必须有默认实现：未配置时打印到 console 而不是静默丢弃，',
      '  // 否则流中错误会表现为"没有输出"且没有任何线索。',
    ],
  },
  {
    at: 941,
    expect: 'const resolvedOnStart',
    text: [
      '  // 所有 onXxx 与 experimental_onXxx 在这里统一解析：后面引擎只认一个名字，',
      '  // 避免每个调用点重复写兜底、也避免新旧别名行为分叉。',
    ],
  },
  {
    at: 952,
    expect: 'return new DefaultStreamTextResult',
    text: [
      '  // [并发] abortSignal 在构造前已合并全部超时信号：引擎内部只监听一个信号，',
      '  // 不需要知道当前是哪种超时触发的取消。',
      '  // 构造是同步的：真正的模型请求在构造函数里的异步 IIFE 中启动，',
      '  // 因此这里返回时流已就绪，但第一步可能尚未发出。',
    ],
  },
  {
    at: 1016,
    expect: '// assign default values to include:',
    text: ['  // include 的三个开关在这里落默认值：引擎内部可假定它们都是 boolean，不必每次读时再判断 undefined。'],
  },
  {
    at: 1030,
    expect: 'type StreamRetryBoundaryMetadata',
    text: ['// 重试边界是内部哨兵 part：它不进入公开流，只用于告诉下游"上一次 attempt 到此结束"。'],
  },
  {
    at: 1035,
    expect: 'const streamRetryBoundarySymbol',
    text: ['// 用 Symbol 而不是字符串 type：避免与未来的 part 类型或用户 transform 的字段冲突。'],
  },
  {
    at: 1049,
    expect: 'function isStreamRetryBoundaryPart(',
    text: ['// 判定只检查 Symbol 是否存在，不检查结构：边界由本文件唯一构造，无需防御性校验。'],
  },
  {
    at: 1055,
    expect: 'async function markPromiseAsHandled',
    text: [
      '// 把 Promise 标记为已处理：避免 reject 后无人 await 触发 unhandledRejection。',
      '// 吞掉错误是有意的——错误已通过流或主结果 Promise 传播。',
    ],
  },
  {
    at: 1061,
    expect: 'function createOutputTransformStream<',
    text: [
      '// output 转换流：把文本增量喂给 Output 规范，产出 partialOutput（结构化输出的半成品）。',
      '//',
      '// [事务] 每个 step 开始时重置累积文本（start-step），finish-step 前必须把最后一段',
      '// 未提交的文本 chunk 发出去，否则结构化解析会少最后几个字符。',
      '// 只有能 parsePartialOutput 的前缀才会发布，避免把非法 JSON 片段交给消费者。',
    ],
  },
  {
    at: 1071,
    expect: 'let firstTextChunkId',
    text: [
      '  // 累积状态：text 是完整文本，textChunk 是尚未发布的增量，',
      '  // lastPublishedValue 用来避免重复发布同一个 partial 值。',
    ],
  },
  {
    at: 1078,
    expect: 'function resetOutputState',
    text: [
      '  // 每个 step 重置：partialOutput 是"当前 step 的解析进度"，',
      '  // 跨 step 累积会把上一步的文本也算进来。',
    ],
  },
  {
    at: 1087,
    expect: 'function enqueueChunk',
    text: ['  // 统一发布出口：只在这里做 flush 与状态更新，保证所有路径的发布语义一致。'],
  },
  {
    at: 1099,
    expect: 'function publishTextChunk',
    text: [
      '  // 发布 partialOutput：text 可能为空（例如刚 start），空值不发布；',
      '  // 但合法 JSON 的 null 必须发布，所以判据是 undefined 而不是 falsy。',
    ],
  },
  {
    at: 1123,
    expect: 'return new TransformStream<',
    text: ['  // 注意 highWaterMark 保持默认：结构化解析需要看到连续文本，过早背压会把增量拆散。'],
  },
  {
    at: 1127,
    expect: 'async transform(chunk, controller)',
    text: [
      '    // transform 对所有 part 串行执行；结构化解析是异步的，会带来背压，',
      '    // 这是可接受的：partialOutput 的消费者本来就按解析速度消费。',
    ],
  },
  {
    at: 1136,
    expect: 'if (isStreamRetryBoundaryPart(chunk))',
    text: [
      '    // 重试边界：清空本 attempt 的累积状态，但不发布任何东西；',
      '    // 边界本身原样透传，外层用它切分 attempt。',
    ],
  },
  {
    at: 1146,
    expect: '// ensure that we publish the last text chunk before the step finish:',
    text: ['    // 这里补发最后一段：finish-step 之后不会再有 text-delta，漏发会让结构化输出丢尾部。'],
  },
  {
    at: 1151,
    expect: 'if (',
    text: [
      '    // 只有"当前 step 的首个 text chunk"才决定结构化输出的起点；',
      '    // 后续 chunk 复用同一个 id，避免把同一次输出拆成多段。',
    ],
  },
  {
    at: 1175,
    expect: "if (chunk.type === 'text-start')",
    text: [
      '    // text-start 记录当前文本段 id：provider 可能并行发多段文本，',
      '    // 只有与 id 匹配的增量才进入结构化解析。',
    ],
  },
  {
    at: 1183,
    expect: "if (chunk.type === 'text-end')",
    text: ['    // text-end 结束当前段：清掉 id，下一个 text-start 会重新选择。'],
  },
  {
    at: 1198,
    expect: 'if (chunk.text.length === 0 && chunk.providerMetadata != null)',
    text: [
      '    // 空文本但带 providerMetadata 的 part 不参与结构化解析：它承载的是元数据，',
      '    // 强行拼进 text 会污染 JSON。',
    ],
  },
  {
    at: 1206,
    expect: '// only publish if partial json can be parsed:',
    text: [
      '    // 解析失败返回 undefined：表示"当前前缀还不是合法 JSON"，静默跳过即可，',
      '    // 这不是错误——流式解析本来就会经过大量非法前缀。',
    ],
  },
  {
    at: 1209,
    expect: '// null should be allowed',
    text: ['    // null 是合法 JSON 值，必须发布；undefined 表示解析不出，不能发布。'],
  },
  {
    at: 1227,
    expect: 'function applyStreamTextTransforms',
    text: [
      '// 应用用户 transform，但保证重试边界不被 transform 看到或吞掉。',
      '// 做法：按边界把源流切成多段，每段独立 pipe 过全部 transform，再拼回一条流。',
    ],
  },
  {
    at: 1238,
    expect: 'const sourceReader = stream.getReader();',
    text: ['  // 手动持有源 reader：需要精确控制"读到边界就停"，pipeThrough 无法表达这个语义。'],
  },
  {
    at: 1245,
    expect: 'const createTransformedSegmentReader = () => {',
    text: [
      '  // 为当前 attempt 建一条段流：pull 时从源读，遇到边界就关闭本段并暂存边界。',
      '  // highWaterMark: 0 是必须的，否则会预取到下一次 attempt 的 chunk。',
    ],
  },
  {
    at: 1269,
    expect: '// Do not prefetch the next source chunk.',
    text: ['  // 不预取：stopStream 由用户 transform 触发，必须在下一个 chunk 进入闸门前生效。'],
  },
  {
    at: 1286,
    expect: 'return new ReadableStream<InternalTextStreamPart<TOOLS>>({',
    text: ['  // 外层流负责段与段之间的衔接：上一段读完后先发暂存的边界，再为下一段新建 reader。'],
  },
  {
    at: 1297,
    expect: 'transformedSegmentReader = undefined;',
    text: ['      // 段结束：丢弃 reader，下一次 pull 按 pendingBoundary / sourceDone 决定收尾或开新段。'],
  },
  {
    at: 1309,
    expect: 'async cancel(reason)',
    text: ['    // [资源] 取消要同时取消当前段与源：只取消段会留下源 reader 的锁。'],
  },
  {
    at: 1316,
    expect: 'class DefaultStreamTextResult<',
    text: [
      '// 流式结果对象：把"一条可多次追加的模型调用流"包装成消费者友好的多种投影，',
      '// 同时用 DelayedPromise 暴露最终结果（steps / usage / finishReason / responseMessages）。',
    ],
  },
  {
    at: 1321,
    expect: 'private readonly _totalUsage',
    text: [
      '  // 结果 Promise 用 DelayedPromise：构造时还没有值，流结束后统一 resolve；',
      '  // 流中途失败则 reject（见 rejectResultPromises）。',
    ],
  },
  {
    at: 1337,
    expect: 'private outputPromise',
    text: ['  // output 只解析一次并缓存：多次读取 output 不应重复跑结构化解析。'],
  },
  {
    at: 1339,
    expect: 'private readonly addStream',
    text: ['  // addStream / closeStream 由 stitchableStream 注入：让引擎可以在多步之间追加新的模型调用流。'],
  },
  {
    at: 1349,
    expect: 'private baseStream',
    text: ['  // baseStream 会被 tee 替换：每次投影都从当前 baseStream 分叉，旧引用不保留。'],
  },
  {
    at: 1353,
    expect: 'private outputSpecification',
    text: ['  // outputSpecification 保存用户传入的 Output：elementStream 与 parseOutput 都依赖它。'],
  },
  {
    at: 1357,
    expect: 'private readonly retention',
    text: ['  // retention 决定能力边界：replay=false 时禁止第二次消费，且部分 getter 不可用。'],
  },
  {
    at: 1358,
    expect: 'private streamClaimed = false;',
    text: ['  // streamClaimed 只用于单消费者模式：防止两个投影同时读同一条流导致数据错乱。'],
  },
  {
    at: 1516,
    expect: 'this.retention = retention;',
    text: [
      '    // [事务] 构造顺序：先固定不可变配置，再建流，最后启动异步运行。',
      '    // 任何一步同步抛错都要让构造函数失败，不能留下"半初始化"的结果对象。',
    ],
  },
  {
    at: 1519,
    expect: 'const resolvedToolCallers',
    text: ['    // tool caller 配置一次性解析：执行时会反复查询"谁能调用我"，提前建表避免每次字符串匹配。'],
  },
  {
    at: 1528,
    expect: 'const telemetryDispatcher',
    text: [
      '    // telemetry dispatcher 做访问控制：runtimeContext / toolsContext 只在显式开启时才进入 span，',
      '    // 避免默认把用户上下文写进追踪系统。',
    ],
  },
  {
    at: 1541,
    expect: 'let stepFinish!: DelayedPromise<void>;',
    text: [
      '    // [并发] 用于"等上一步事件处理完成后再开始下一步"：停止条件需要看到已更新的 steps，',
      '    // 如果不等，连续两步之间可能读到过期的 steps 而提前或延后停止。',
    ],
  },
  {
    at: 1543,
    expect: 'let recordedContent:',
    text: [
      '    // 记录型状态：这些变量在整条流生命周期内被事件处理器写入、被 getter 读取。',
      '    // 低内存模式（retention.replay=false）会在结束时清空，释放大对象。',
    ],
  },
  {
    at: 1555,
    expect: 'let isAborted = false;',
    text: ['    // isAborted 是"用户取消"的单向标记：只置 true 不回落，用于抑制后续回调。'],
  },
  {
    at: 1558,
    expect: '// provider-assigned text/reasoning part IDs',
    text: [
      '    // 两个独立的 id 预订器：text 与 reasoning 的 id 空间互不影响，',
      '    // 共用一个会让跨类型的 id 冲突被误判为重名。',
    ],
  },
  {
    at: 1587,
    expect: '// Track provider-executed tool calls that support deferred results',
    text: ['    // 延迟结果表：provider 执行且支持 deferred 的工具，结果可能后续轮次才到；这里只记 toolName 以便补齐元数据。'],
  },
  {
    at: 1592,
    expect: 'let activeTextContent:',
    text: [
      '    // 每个进行中的文本/推理段用 id 索引：provider 的增量不带完整上下文，',
      '    // 必须按 id 找到累积缓冲。createIdMap 避免原型链污染。',
    ],
  },
  {
    at: 1610,
    expect: 'let recordedNoOutputError',
    text: ['    // 记录 NoOutputGeneratedError：end 时若既没有 output 也没有真实错误，用它给出可诊断的失败原因。'],
  },
  {
    at: 1613,
    expect: '// the step that has started but not ended',
    text: ['    // openStep 追踪"已开始但未结束"的 step：流提前结束时用它补发 onStepError。'],
  },
  {
    at: 1623,
    expect: 'const notifyStepError = async',
    text: [
      '    // [失败路径] 只在没有 abort 时补发 onStepError：用户取消不是错误，',
      '    // 补发会让监控把正常取消统计成故障。openStep 置空保证最多报一次。',
    ],
  },
  {
    at: 1637,
    expect: 'const eventProcessor = new TransformStream<',
    text: [
      '    // eventProcessor 是整条流的状态机核心：每个 enriched part 在这里',
      '    // 1) 累积到当前 step 的 content / text / reasoning / tool-call；',
      '    // 2) 触发 onChunk、onStepEnd、onToolExecution* 等回调；',
      '    // 3) 在 finish-step 时构造 StepResult 并决定是否继续下一步。',
      '    // 它同时是输出流的唯一上游：任何 part 必须先经过这里再到达消费者。',
      '    // [事务] 状态更新与回调触发顺序不可交换：回调里读取的 steps 必须已包含当前 step。',
    ],
  },
  {
    at: 1641,
    expect: 'async transform(chunk, controller)',
    text: ['      // 串行处理：状态机不允许两个 part 并发改写同一份累积状态。'],
  },
  {
    at: 1642,
    expect: 'if (isStreamRetryBoundaryPart(chunk))',
    text: [
      '        // 重试边界：丢弃本 attempt 已累积的内容与请求元数据，换成边界的请求信息；',
      '        // 不转发边界本身，消费者不应看到内部重试机制。',
    ],
  },
  {
    at: 1654,
    expect: 'controller.enqueue(chunk); // forward the chunk to the next stream',
    text: [
      '        // 先转发再处理：保证消费者的 part 顺序与模型输出一致；',
      '        // 后面的 await 回调可能很慢，放在转发之后才不会阻塞数据到达。',
    ],
  },
  {
    at: 1656,
    expect: 'const callbacksHandledForStreamRetry',
    text: ['        // 已被流重试消费过的错误不再触发 onChunk / onError，避免同一个错误被上报两次。'],
  },
  {
    at: 1666,
    expect: "if (part.type === 'error')",
    text: [
      '        // [失败路径] 错误 part 不终止流：它只是数据，是否中断由外层的 pull catch 决定。',
      '        // 这里负责记录可诊断原因并通知 onError。',
    ],
  },
  {
    at: 1676,
    expect: 'if (openStep != null)',
    text: ['          // 挂到 openStep 上：若流在此后结束，notifyStepError 会带着这个错误补发。'],
  },
  {
    at: 1688,
    expect: "if (",
    text: [
      '        // 离散 part（custom / source / tool-call / 审批 / tool-error）直接入账，',
      '        // 它们没有增量累积语义，不需要 active 表。',
    ],
  },
  {
    at: 1699,
    expect: "if (part.type === 'text-start')",
    text: [
      '        // text-start 建立累积缓冲，并立即把同一个对象放入 recordedContent：',
      '        // 后续 delta 修改这个对象，最终结果自然包含完整文本（引用共享，不拷贝）。',
    ],
  },
  {
    at: 1710,
    expect: "if (part.type === 'text-delta')",
    text: ['        // delta 只追加文本与元数据；providerMetadata 用 ?? 保留旧值，避免被 undefined 覆盖。'],
  },
  {
    at: 1713,
    expect: 'if (activeText == null)',
    text: [
      '          // [失败路径] 找不到 start 说明 provider 乱序或 id 被重映射错误：',
      '          // 发一个 error part 而不是抛错，让消费者能看到问题但流继续。',
    ],
  },
  {
    at: 1729,
    expect: "if (part.type === 'text-end')",
    text: ['        // text-end 收口：补 citations、刷新元数据后删除缓冲，防止长会话内存增长。'],
  },
  {
    at: 1732,
    expect: 'if (activeText == null)',
    text: ['          // 与 delta 同样的降级策略：结束事件找不到起点时只报错，不中断整条流。'],
  },
  {
    at: 1753,
    expect: "if (part.type === 'reasoning-start')",
    text: ['        // reasoning 与 text 是平行的两条累积链路，规则完全一致，但 id 空间独立（见 id 预订器）。'],
  },
  {
    at: 1767,
    expect: 'if (activeReasoning == null)',
    text: ['          // reasoning 的乱序降级与 text 一致：保留流，暴露错误 part。'],
  },
  {
    at: 1783,
    expect: "if (part.type === 'reasoning-end')",
    text: ['        // reasoning-end 只刷新元数据并清理缓冲；结构化 reasoning 的形状转换在结果 getter 里做。'],
  },
  {
    at: 1803,
    expect: "if (part.type === 'file' || part.type === 'reasoning-file')",
    text: [
      '        // 文件 part 直接入账：它没有增量形态，providerMetadata 只在存在时附加，',
      '        // 避免产出 { providerMetadata: undefined } 这种多余字段。',
    ],
  },
  {
    at: 1814,
    expect: "if (part.type === 'tool-result' && !part.preliminary)",
    text: [
      '        // 只记录最终 tool-result：preliminary 是过程输出，写进 content 会让消息历史',
      '        // 出现同一调用的多条结果，回灌时 provider 会拒绝。',
    ],
  },
  {
    at: 1818,
    expect: "if (part.type === 'start-step')",
    text: [
      '        // 新 step 开始：清空上一 step 的内容与 active 表，换成这一 step 的请求元数据；',
      '        // 这是"状态机每个 step 一次复位"的唯一入口。',
    ],
  },
  {
    at: 1828,
    expect: "if (part.type === 'finish-step')",
    text: [
      '        // finish-step 是收口点：先把累积内容转成可回灌的消息，再构造 StepResult，',
      '        // 最后根据停止条件决定是否继续。toResponseMessages 必须在这里调用，',
      '        // 不能延后到整条流结束——下一步的 prompt 依赖它。',
    ],
  },
  {
    at: 2048,
    expect: '// initialize the stitchable stream and the transformed stream:',
    text: [
      '    // stitchableStream 是"可追加的流"：每个 step 结束时追加一条新的模型调用流，',
      '    // 消费者只看到一条连续流；closeStream 表示不再有下一步。',
    ],
  },
  {
    at: 2054,
    expect: '// resilient stream that handles abort signals and errors:',
    text: [
      '    // 这层包装负责三件事：首帧发 start part、把 abort 转成 abort part、把错误转成流错误。',
      '    // [资源] abort 监听器用 once:true，且在每个出口移除，避免长生命周期的 signal 持有流。',
    ],
  },
  {
    at: 2065,
    expect: 'let stream = new ReadableStream<InternalTextStreamPart<TOOLS>>({',
    text: [
      '    // start 阶段就检查一次 aborted：信号可能在构造与消费之间已经触发，',
      '    // addEventListener 不会补发历史事件。',
    ],
  },
  {
    at: 2075,
    expect: 'async pull(controller) {',
    text: [
      '      // pull 是唯一读取 stitchableStream 的地方：所有 abort / 错误 / 结束分支都在这里收口，',
      '      // 保证消费者看到的最后一条一定是 finish / abort / error 之一。',
    ],
  },
  {
    at: 2077,
    expect: 'async function abort() {',
    text: [
      '          // [事务] abort 序列：标记 isAborted → 移除监听 → 结束 steering → 通知 onAbort',
      '          // → 发 abort part → 关闭流。顺序固定：回调里可能读 isAborted，关闭后不能再 enqueue。',
      '          // reason 用 getErrorMessage 序列化：AbortSignal.reason 可能是任意类型。',
    ],
  },
  {
    at: 2112,
    expect: 'if (done) {',
    text: ['          // 正常结束：移除监听后关闭；不在这里补发 finish，finish part 由 eventProcessor 负责。'],
  },
  {
    at: 2119,
    expect: '} catch (error) {',
    text: [
      '          // [失败路径] 区分 abort 错误与真实错误：前者走 abort 序列，',
      '          // 后者通知 onStepError / telemetry 并让流 error（消费者 await 会 reject）。',
    ],
  },
  {
    at: 2133,
    expect: 'cancel(reason) {',
    text: ['      // 消费者取消：视为 abort，向源传播取消并结束 steering。'],
  },
  {
    at: 2140,
    expect: '// introduce a gate that prevent further tokens from',
    text: [
      '    // 闸门：stopStream 之后 isRunning=false，后续 chunk 直接丢弃。',
      '    // 放在用户 transform 之外，保证 transform 内部缓冲也无法漏出（见 INV-04）。',
    ],
  },
  {
    at: 2153,
    expect: '// Transform each retry attempt independently.',
    text: [
      '    // 每个重试 attempt 独立过 transform：边界被外层拦截，transform 看不到，',
      '    // 因此用户可以放心 filter / 重建 part 而不破坏 attempt 隔离。',
    ],
  },
  {
    at: 2166,
    expect: 'this.baseStream = stream',
    text: [
      '    // 最终链路：源流 → output 转换（产生 partialOutput）→ eventProcessor（聚合 + 回调）。',
      '    // retention.replay=false 且未配置 output 时不收集输出，避免无谓的文本累积。',
    ],
  },
  {
    at: 2175,
    expect: 'const { maxRetries } = prepareRetries({',
    text: [
      '    // maxRetries 与 streamRetries 分别校验：流式重试默认关闭（0），',
      '    // 显式配置才启用，避免改变既有 onError 观察者的行为。',
    ],
  },
  {
    at: 2192,
    expect: '(async () => {',
    text: [
      '    // 异步运行体：构造函数同步返回，真正的请求在这里启动。',
      '    // 结构：标准化 prompt → onStart → 处理历史审批 → 逐步循环（prepareStep → 模型调用',
      '    // → 工具执行 → 停止条件）→ 收口（写最终结果、onEnd、关闭流）。',
      '    // [失败路径] 这个 IIFE 不能向外抛：所有错误必须通过 rejectResultPromises 与流错误传播。',
    ],
  },
  {
    at: 2193,
    expect: 'const initialPrompt = await standardizePrompt({',
    text: [
      '      // prompt 标准化是第一步且必须 await：onStart 回调需要看到最终 instructions / messages，',
      '      // 同时非法 prompt 要在发出任何 part 之前失败。',
    ],
  },
  {
    at: 2261,
    expect: 'const { approvedToolApprovals, deniedToolApprovals } =',
    text: [
      '      // 消息历史里可能已经带着上一轮的审批结果：在发起模型调用之前先执行它们，',
      '      // 否则模型会看到"已批准的调用没有结果"而重复请求。',
    ],
  },
  {
    at: 2264,
    expect: '// initial tool execution step stream',
    text: [
      '      // 这个 step 不对应模型调用，只产生工具 part；它作为独立流追加进 stitchableStream，',
      '      // 让消费者看到的顺序是"（无）→ 工具结果 → 后续模型输出"。',
    ],
  },
  {
    at: 2270,
    expect: '} = await validateApprovedToolApprovals',
    text: [
      '        // 重新校验：审批可能来自上一次请求，工具定义与 input 可能已变化；',
      '        // 已失效的审批转为 invalid，不能直接执行（否则等于执行未经校验的参数）。',
    ],
  },
  {
    at: 2289,
    expect: 'const localDeniedToolApprovalsWithoutResults',
    text: ['        // 已有结果的拒绝不再补 execution-denied：重放历史时会造成重复结果。'],
  },
  {
    at: 2298,
    expect: 'let toolExecutionStepStreamController',
    text: [
      '        // 用 controller 直接推送工具 part（不进 TransformStream）：',
      '        // 这一 step 没有模型流可管道化，手动控制是最直接的形状。',
    ],
  },
  {
    at: 2312,
    expect: 'for (const toolApproval of [',
    text: ['          // 拒绝的审批先统一发 tool-output-denied：保证每个被拒绝的调用都有结果，历史才能闭合。'],
  },
  {
    at: 2323,
    expect: 'for (const toolApproval of invalidToolApprovals)',
    text: [
      '          // 审批通过但 input 失效：发 tool-error 而不是执行，也不尝试修复——',
      '          // 修复会改变用户已经授权的操作内容（见下方注释）。',
    ],
  },
  {
    at: 2342,
    expect: 'await mapWithConcurrency({',
    text: [
      '          // [并发] 已批准的本地工具按配置并发执行；每个结果完成即 enqueue，',
      '          // 顺序不保证与审批顺序一致，下游必须按 toolCallId 关联。',
    ],
  },
  {
    at: 2366,
    expect: 'onPreliminaryToolResult: result => {',
    text: ['                // preliminary 结果直接流向消费者，用于进度展示；它不进入 toolOutputs，也不写消息历史。'],
  },
  {
    at: 2378,
    expect: '// Local tool results (approved + denied) are sent as tool results:',
    text: [
      '          // 本地工具结果统一组装成一条 tool 消息：批准结果、无效调用错误、拒绝原因',
      '          // 必须放在同一条消息里，provider 侧才能看到完整的调用-结果配对。',
    ],
  },
  {
    at: 2405,
    expect: '// Report invalid approved tool calls to the model without',
    text: ['          // 无效调用报错但不执行：修复 input 会改变用户授权的操作对象，这是安全边界。'],
  },
  {
    at: 2423,
    expect: '// add execution denied tool results for denied local tool approvals:',
    text: ['          // 拒绝的调用补 execution-denied：reason 来自审批响应，原样回灌便于模型理解。'],
  },
  {
    at: 2436,
    expect: 'initialResponseMessages.push({',
    text: [
      '          // 这条 tool 消息是"初始历史的一部分"，之后每个 step 的消息会追加在它后面；',
      '          // 它决定了 responseMessages 的起始顺序。',
    ],
  },
  {
    at: 2446,
    expect: 'self._initialResponseMessages.resolve(initialResponseMessages);',
    text: ['      // 初始审批 step 到此结束：resolve 后 responseMessages getter 可以拿到这段历史。'],
  },
  {
    at: 2448,
    expect: 'async function streamStep({',
    text: [
      '      // 单个 step 的执行单元：内部管理该 step 的超时、模型调用、工具执行与收口，',
      '      // 返回后由外层决定是否继续下一步。',
    ],
  },
  {
    at: 2455,
    expect: '// Set up step timeout if configured',
    text: [
      '        // [资源] 四类超时在这里开始生效：step 超时覆盖整个 step，',
      '        // 首 chunk 与 chunk 间隔超时只覆盖模型输出阶段。',
    ],
  },
  {
    at: 2462,
    expect: '// The first-content timeout is armed when the provider response stream',
    text: [
      '        // 首 chunk 超时在请求发出后才启动：请求前的时间由 step 超时覆盖，',
      '        // 两者同时启动会让"排队等 provider"被误判成"首包丢失"。',
    ],
  },
  {
    at: 2486,
    expect: '// Chunk timeout tracking starts after semantic output begins',
    text: [
      '        // chunk 间隔超时只由"语义输出"重置：心跳或 usage 之类的非内容 part',
      '        // 不应让一个已经卡住的生成看起来还活着。',
    ],
  },
  {
    at: 2512,
    expect: 'function clearModelOutputTimeouts()',
    text: ['        // 模型输出结束（finish / error）后立刻清掉输出类超时，避免工具执行阶段被误杀。'],
  },
  {
    at: 2523,
    expect: 'function clearStepTimeouts()',
    text: ['        // step 收尾统一清理：任何一条路径（成功、失败、abort）都必须调用，防止 timer 泄漏。'],
  },
  {
    at: 2528,
    expect: 'function cleanupStepTimeouts()',
    text: ['        // 同时移除 abort 监听：step 结束后再触发清理属于无效工作，也会让 signal 持有闭包。'],
  },
  {
    at: 3523,
    expect: 'get steps()',
    text: ['  // steps 是最终结果的核心：多数 getter 都从它派生，await 它等于 await 整次生成。'],
  },
  {
    at: 3531,
    expect: 'get finalStep()',
    text: ['  // finalStep 在流结束前是 undefined：调用方必须先 await steps 再读取。'],
  },
  {
    at: 3535,
    expect: 'get content()',
    text: ['  // content 跨 step 聚合，包含文本、推理、工具调用等全部 part。'],
  },
  {
    at: 3547,
    expect: 'get text()',
    text: ['  // text 只取最后一步：多步拼接会把中间草稿也带出来。'],
  },
  {
    at: 3551,
    expect: 'get reasoningText()',
    text: ['  // reasoningText 只取最后一步的推理文本，不含结构化 reasoning。'],
  },
  {
    at: 3555,
    expect: 'get reasoning()',
    text: ['  // reasoning 做格式转换后再暴露，保证对外形状稳定。'],
  },
  {
    at: 3561,
    expect: 'get sources()',
    text: ['  // sources 跨 step 聚合；引用信息只增不减。'],
  },
  {
    at: 3569,
    expect: 'get toolCalls()',
    text: ['  // toolCalls 跨 step 聚合：调用与结果按 toolCallId 关联，数组内不保证唯一。'],
  },
  {
    at: 3573,
    expect: 'get staticToolCalls()',
    text: ['  // staticToolCalls 只含类型已知的调用，供需要窄化类型的调用方使用。'],
  },
  {
    at: 3585,
    expect: 'get toolResults()',
    text: ['  // toolResults 跨 step 聚合，包含静态与动态工具的结果。'],
  },
  {
    at: 3601,
    expect: 'get usage()',
    text: ['  // usage 是最后一步的用量，不是累计值；累计值用 totalUsage。'],
  },
  {
    at: 3605,
    expect: 'get request()',
    text: ['  // request 取最后一步：对应最终生效的请求参数。'],
  },
  {
    at: 3609,
    expect: 'get response()',
    text: ['  // response 取最后一步的原始 provider 响应。'],
  },
  {
    at: 3613,
    expect: 'get responseMessages()',
    text: ['  // responseMessages 含初始消息与各 step 新增消息，可直接作为下一轮 messages。'],
  },
  {
    at: 3623,
    expect: 'get totalUsage()',
    text: ['  // totalUsage 是全部 step 的累计用量，计费与配额判断应使用它。'],
  },
  {
    at: 3631,
    expect: 'get finishReason()',
    text: ['  // finishReason 取最后一步：描述整次生成如何结束。'],
  },
  {
    at: 3639,
    expect: 'get rawFinishReason()',
    text: ['  // rawFinishReason 是 provider 原始字符串，便于排查未映射的结束原因。'],
  },
  {
    at: 3655,
    expect: 'private teeStream()',
    text: [
      '  // 分叉出一条新流，原 baseStream 被替换成另一半，从而支持任意次数的投影。',
      '  // [资源] tee 会在内存缓冲未被消费的一侧；LLM 输出通常不大，但仍应及时消费或取消。',
    ],
  },
  {
    at: 3666,
    expect: 'const rejectResults =',
    text: ['      // 流失败或取消时把错误同步给结果 Promise：否则 getter 会永久挂起（见 INV-01）。'],
  },
  {
    at: 3705,
    expect: 'get textStream()',
    text: ['  // textStream 是 stream 的文本投影，只保留 text-delta 的内容。'],
  },
  {
    at: 3709,
    expect: 'private asIterableStream<T>(',
    text: ['  // 两种迭代器实现：replay 模式支持多次迭代，单消费者模式只能迭代一次且不缓存。'],
  },
  {
    at: 3717,
    expect: 'get stream()',
    text: ['  // stream 是面向用户的 part 流（不含 partialOutput 与重试边界）。'],
  },
  {
    at: 3736,
    expect: 'private rejectResultPromises(error: unknown)',
    text: ['  // 流失败或取消时统一 reject 全部结果 Promise：漏掉一个就会让对应 getter 永久挂起。'],
  },
  {
    at: 3747,
    expect: 'private rejectResultPromise<T>({',
    text: ['  // 只 reject 仍处于 pending 的 Promise：已 settle 的不能被覆盖（见 INV-07）。'],
  },
  {
    at: 3760,
    expect: 'async consumeStream(options?: ConsumeStreamOptions)',
    text: [
      '  // 主动消费整条流（丢弃 part），用于"只关心最终结果"的场景；',
      '  // 错误会同时 reject 结果 Promise 并转交调用方的 onError。',
    ],
  },
  {
    at: 3783,
    expect: 'get partialOutputStream()',
    text: ['  // partialOutputStream 需要 Output 规范；低内存模式下没有规范就无法增量解析。'],
  },
  {
    at: 3806,
    expect: 'get elementStream()',
    text: ['  // elementStream 需要 Output 提供元素级 transform，text 模式不支持。'],
  },
  {
    at: 3820,
    expect: 'private getOutputPromise()',
    text: ['  // 解析只做一次并缓存：多次读 output 不重复解析。'],
  },
  {
    at: 3828,
    expect: 'private parseOutput(',
    text: ['  // 解析失败会 reject：output 是"要么完整要么失败"的语义，不返回半成品。'],
  },
  {
    at: 3842,
    expect: 'get output()',
    text: ['  // output 是 Promise 而不是同步值：调用方必须 await 到流结束。'],
  },
];

const lines = fs.readFileSync(FILE, 'utf8').split('\r\n');
const sorted = [...edits].sort((a, b) => b.at - a.at);
let added = 0;
for (const e of sorted) {
  const idx = e.at - 1;
  if (!lines[idx] || !lines[idx].includes(e.expect)) {
    console.error(`MISS ${e.at} :: ${e.expect}`);
    console.error('  actual: ' + JSON.stringify(lines[idx]));
    process.exit(1);
  }
  lines.splice(idx, 0, ...e.text);
  added += e.text.length;
}
fs.writeFileSync(FILE, lines.join('\r\n'), 'utf8');
console.log('ADDED ' + added);
