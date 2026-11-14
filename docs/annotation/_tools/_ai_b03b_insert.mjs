// AI-deep-b03 补插：stream-text.ts 单 step 生命周期、重试、收口与 UI 投影。
import fs from 'node:fs';

const REL = 'packages/ai/src/generate-text/stream-text.ts';
const FILE = 'D:/code/opensource/ai/' + REL;

const edits = [
  // ---------- streamStep 入口 ----------
  {
    at: 2668,
    expect: 'async function streamStep({',
    text: [
      '        // 一次 streamStep 调用 = 一个 step 的完整生命周期，顺序不可交换：',
      '        // 建计时器 → 应用 prepareStep 覆盖 → 发 steering 消息 → 调模型',
      '        // → 工具回调与执行 → 收口 finish-step → 判断是否进入下一步。',
      '        // [事务] 本函数不写入 recordedSteps：eventProcessor 收到 finish-step 才记账，',
      '        // 因此这里任何提前 return 都不会留下半个 step。',
      '        // [失败路径] 抛出的错误由外层 run 的 catch 转成 error part 并 reject 结果 Promise。',
    ],
  },
  // ---------- prepareStep 覆盖项 ----------
  {
    at: 2823,
    expect: 'const stepModel = resolveLanguageModel(',
    text: [
      '          // prepareStep 可以逐 step 换模型：解析后立刻写入 currentStepModel，',
      '          // 让 getter 与后续错误信息都能看到"本 step 实际用了哪个模型"。',
      '          // [权衡] 换模型不重建 abortSignal：超时属于整次生成，不随模型变化。',
      '          // 注意当前的 stepModel 已在调用模型时被 prepareStep 结果覆盖使用。',
    ],
  },
  {
    at: 2828,
    expect: 'const stepActiveTools = filterActiveTools({',
    text: [
      '          // activeTools 在 step 级再过滤一次：prepareStep 可以在中途开启/关闭工具，',
      '          // 但过滤结果只影响本 step，不写回全局 activeTools。',
      '          // 这与 model 切换同属"单步配置"，避免上一步的临时决定污染下一步。',
      '          // 过滤发生在 toolOrder 之前，保证顺序只作用于实际启用的工具。',
    ],
  },
  {
    at: 2836,
    expect: '} = prepareToolsForToolCallers({',
    text: [
      '          // 工具准备拆成三份产物，用途严格区分：',
      '          // executionTools 供本地执行（含 tool-caller 注入的工具）；',
      '          // modelTools 是真正发给 provider 的声明；toolCallerMessages 是随请求附加的说明消息。',
      '           // [权衡] 三者在同一处派生，避免"声明里有、执行时找不到"的错配。',
      '          // toolSearch 在传给 provider 前展开，provider 永远看不到搜索占位工具。',
    ],
  },
  {
    at: 2845,
    expect: 'const stepTools = await prepareTools({',
    text: [
      '          // prepareTools 只处理 modelTools：这些才是要序列化进请求的工具定义。',
      '          // 它可能触发 schema 转换（如 zod → JSON Schema），因此是异步的，',
      '          // 且结果只在本 step 复用，不跨 step 缓存（prepareStep 可能换工具集）。',
      '          // toolsContext 做一次 cast：这里的泛型已被 ActiveToolSubset 窄化。',
    ],
  },
  {
    at: 2860,
    expect: 'const stepToolChoice = prepareToolChoice({',
    text: [
      '          // toolChoice 归一成内部形状后立刻判断 none：',
      '          // 为 none 时连 executionTools 都不保留，确保工具绝不会被误执行。',
      '          // 这是"模型不选工具"与"框架不执行工具"的双重保险。',
    ],
  },
  {
    at: 2866,
    expect: 'const stepMessages = appendToolCallerMessages({',
    text: [
      '          // tool-caller 消息追加在 prepareStep 之后的 messages 上，',
      '          // 顺序保证：用户消息在前、工具调用方说明在后，provider 看到的历史与执行侧一致。',
      '          // currentStepMessages 同步更新，供下一步继承与 responseMessages 组装。',
      '          // [事务] 这里只读不写用户传入的 messages 原数组。',
    ],
  },
  {
    at: 2874,
    expect: 'const deliveredSteeringMessages =',
    text: [
      '          // steering 消息是否"已投递"由 resolveTakenMessages 判定：',
      '          // 只有真正出现在本次请求 messages 里的才算投递成功，',
      '          // 否则下一 step 还要再试。判定的依据是消息对象，而不是下标。',
      '          // [权衡] 用对象身份匹配而非 id：steering 消息可能被用户在 prepareStep 中改写。',
      '          // 返回值同时用于流式下发与 step 级统计，二者必须来自同一次判定。',
    ],
  },
  {
    at: 2884,
    expect: 'if (deliveredSteeringMessages.length > 0) {',
    text: [
      '          // steering 消息必须在 step 输出之前入流：',
      '          // 消费者的 UI 需要先看到"用户插话"再看到模型回应，顺序反了会看起来像应答错位。',
      '          // 这里新建一条一次性流并 addStream，复用同一套拼接机制，不特殊化消费者路径。',
    ],
  },
  {
    at: 2901,
    expect: 'const stepInstructions =',
    text: [
      '          // instructions 的优先级：prepareStep 显式覆盖 > 上一步继承值。',
      '          // system 是旧字段名，保留兼容；两者同时存在时 instructions 生效。',
      '          // 继承是为了让"只改一次系统提示"在后续 step 持续有效，而不是每步都要重设。',
    ],
  },
  {
    at: 2907,
    expect: 'const stepProviderOptions = mergeObjects(',
    text: [
      '          // providerOptions 用浅合并：step 级键覆盖全局同名键，未提及的键保留。',
      '          // [权衡] 不做深合并：provider 选项的嵌套语义由 provider 自己定义，',
      '          // 框架层深合可能会把数组错误地拼在一起。',
    ],
  },
  {
    at: 2912,
    expect: 'const stepCallSettings = prepareStepCallSettings({',
    text: [
      '          // 采样参数（temperature / topP / maxOutputTokens 等）按 step 覆盖，',
      '          // 与 providerOptions 分开处理：它们是跨 provider 的通用字段。',
      '          // 未指定时沿用全局 callSettings，保证不传就不会出现空值覆盖。',
    ],
  },
  // ---------- 模型调用与重试 ----------
  {
    at: 2919,
    expect: 'const { retry } = prepareRetries({ maxRetries, abortSignal });',
    text: [
      '          // retry 只负责"请求建立阶段"的重试（连接失败、非流式错误）：',
      '          // 一旦流开始产出，重试完全交给下面的 pull 内状态机，两者不叠加。',
      '          // [权衡] 分开的原因：流已消费的 part 无法撤回，请求级重试没有这个负担。',
      '          // abortSignal 传入后，重试之间的退避等待也会被中止打断。',
      '          // maxRetries 为 undefined 时由 prepareRetries 提供默认值，这里不重复兜底。',
    ],
  },
  {
    at: 2922,
    expect: 'const callLanguageModel = () =>',
    text: [
      '          // callLanguageModel 是"发起一次模型调用"的工厂：',
      '          // 每次调用都会新建 stream、重新走 retry 包装，因此可以安全地用于流重试。',
      '          // 之所以包成函数而不是直接 await 一次：重试时必须拿到全新的 reader。',
      '          // runInStepTracingChannelContext 保证遥测 span 始终挂在当前 step 下。',
      '          // [并发] 调用方必须 await 完成后再替换 reader，不允许两个调用并存。',
      '          // [失败路径] 抛错时不会产生半初始化的 stream，调用方负责收口。',
    ],
  },
  {
    at: 3001,
    expect: 'const initialLanguageModelCall = await callLanguageModel();',
    text: [
      '          // 首次调用在装配 pull 之前完成：request / response 元数据此时已确定，',
      '          // 首 chunk 超时也从这里之后才开始计时。',
      '          // [并发] 该 Promise 只 await 一次；后续重试复用同一工厂但各自新建 reader。',
      '          // [失败路径] 这里抛错会跳过整段流装配，由外层 catch 统一收口（见 INV-01）。',
      '          // 注意 request 是 let：流重试后会更新为最后一次尝试的请求信息。',
    ],
  },
  {
    at: 3006,
    expect: 'let automaticStreamRetryCount = 0;',
    text: [
      '          // 两个独立计数：automatic 由 streamRetries 派生，callback 由 onError 返回 retry 触发。',
      '          // 分开计数是为了让自动额度耗尽后仍允许一次显式回调重试，而不是互相挤占。',
      '          // [权衡] 回调重试上限写死为 1，避免 onError 无脑返回 retry 造成死循环。',
      '          // 已处理的错误会进入 errorsHandledForStreamRetry，防止重复上报。',
    ],
  },
  {
    at: 3012,
    expect: 'const shouldBufferToolParts =',
    text: [
      '          // 只有"可能重试"时才缓冲工具类 part：',
      '          // tool-input-* 与 tool-call 一旦发给消费者就无法撤回，重试会制造重复调用。',
      '          // [权衡] 关闭重试时直接透传，省掉数组拷贝与延迟发射，降低首包延迟。',
    ],
  },
  {
    at: 3015,
    expect: 'const languageModelStream = new ReadableStream<',
    text: [
      '          // 这是对 provider 流的"可重试包装"：pull 驱动、按需拉取。',
      '          // 用 ReadableStream 而非 async generator 的原因：需要把 cancel(reason)',
      '          // 传播给底层 reader，并能在同一个流里插入重试边界 part。',
      '          // [资源] 每次重试都 cancel 旧 reader 并新建一个，旧请求不会继续被拉取。',
      '          // [并发] 流规范保证 pull 不会并发调用，因此计数器与缓冲数组无需加锁。',
    ],
  },
  {
    at: 3019,
    expect: 'const enqueueAttemptPart = (',
    text: [
      '              // 所有发给消费者的 part 都从这一个出口走，',
      '              // 顺带维护 openTextParts / openReasoningParts，用于重试时补发 end。',
      '              // 这里不做 id 重映射：映射在下游 eventProcessor，职责分离。',
    ],
  },
  {
    at: 3040,
    expect: 'const flushBufferedAttemptParts = () => {',
    text: [
      '              // 确认本次尝试不会再重试后才一次性放行缓冲：',
      '              // 顺序必须保持原样，tool-input-start 必须早于对应的 tool-call。',
    ],
  },
  {
    at: 3047,
    expect: 'const closeOpenAttemptParts = () => {',
    text: [
      '              // 重试前给所有未闭合的 text / reasoning 补 end：',
      '              // 否则消费者会看到永不结束的增量段，UI 打字机效果会卡住。',
      '              // [权衡] 补发的 end 不带 providerMetadata：这段内容实际被丢弃，',
      '              // 元数据已无意义，但事件形状必须完整，否则下游状态机会认为协议损坏。',
    ],
  },
  {
    at: 3071,
    expect: 'if (enqueueStreamRetryAttemptBoundary) {',
    text: [
      '                // 重试边界必须排在新尝试的第一个 part 之前：',
      '                // 下游据此知道前面的内容作废并重置累积状态（见 INV-03）。',
      '                // 新尝试的 warnings 随边界下发，避免消费者漏掉这一轮告警。',
    ],
  },
  {
    at: 3100,
    expect: "if (value.type === 'model-call-end') {",
    text: [
      '                // model-call-end 是正常终止信号：先清输出类超时（工具执行阶段不受其约束），',
      '                // 放行缓冲后原样转发；pull 还会再被调用一次，读到 done 才 close。',
      '                // [资源] 此处只清输出类超时，step 超时仍覆盖后续工具执行。',
    ],
  },
  {
    at: 3109,
    expect: 'if (isOutputChunk(value)) {',
    text: [
      '                // 计时必须在"观测到输出"之后做，且放在缓冲判断之前：',
      '                // 回放缓冲不能重新武装已经清掉的定时器。',
    ],
  },
  {
    at: 3115,
    expect: 'shouldBufferToolParts &&',
    text: [
      '                // 工具类 part 在可能重试时进入缓冲：它们描述"已经发生的外部动作"，',
      '                // 泄漏给消费者就无法撤回。error / ping 不缓冲：',
      '                // error 要立刻进入重试判定，ping 只是保活、不改变语义。',
      '                // 缓冲非空后继续累积：保证同一次尝试的 part 不被拆成两段发射。',
    ],
  },
  {
    at: 3134,
    expect: 'const error = wrapGatewayError(value.error);',
    text: [
      '                // 先过网关包装：网关错误需要保留原始状态码与请求 id，',
      '                // 否则调用方无法区分"模型拒答"与"网关 5xx"。',
      '                // [失败路径] 工具选择违约不重试：同样的 messages 再发一次仍会被拒。',
    ],
  },
  {
    at: 3147,
    expect: 'const automaticRetry =',
    text: [
      '                // 重试优先级：自动重试 > 回调重试，二者互斥且都被工具选择违约拦截。',
      '                // [权衡] 自动额度耗尽后仍给一次回调机会：调用方可能更了解 provider 的瞬时故障，',
      '                // 但只允许一次，防止 onError 恒返回 retry 造成死循环。',
    ],
  },
  {
    at: 3169,
    expect: 'await languageModelStreamReader.cancel(error);',
    text: [
      '                // [资源] cancel 旧 reader 是重试的前置条件：',
      '                // 不取消会让旧请求继续消耗连接与 token，晚到的 part 还可能混进新尝试。',
      '                // 缓冲与未闭合段在这里一起清空/补 end，新尝试从干净状态开始。',
      '                // [失败路径] 重试调用失败时直接下发 error 并 close：此时已无额度。',
    ],
  },
  {
    at: 3194,
    expect: 'cancel(reason) {',
    text: [
      '            // 消费者取消时同步取消底层 reader：这是唯一能真正中断 provider 请求的路径，',
      '            // 只 close 不 cancel 会让上游继续生成，计费仍在继续。',
    ],
  },
  {
    at: 3226,
    expect: 'const streamWithToolResults = executeToolsFromStream({',
    text: [
      '          // 工具执行链分两段：invokeToolCallbacksFromStream 负责通知与审批请求，',
      '          // executeToolsFromStream 负责真正执行并产出 tool-result / tool-error。',
      '          // 拆开是为了让 onToolExecutionStart 严格早于 execute（见下方参数注释）。',
      '          // [事务] 结果按 toolCallId 回填；preliminary 结果不进入 stepToolOutputs。',
    ],
  },
  {
    at: 3258,
    expect: 'const getStepRequest = (): LanguageModelRequestMetadata => ({',
    text: [
      '          // [资源] request.body 与 messages 默认不保留：',
      '          // 含图片/文件时 body 可达数十 MB，留在 step result 里会拖住整条链路的内存。',
      '          // 需要排查时用 include.requestBody / include.requestMessages 显式打开。',
      '          // recordedRequestMessages 仍记录消息（不含 body），供 onStepEnd 与重试边界使用。',
    ],
  },
  {
    at: 3267,
    expect: 'const stepToolCalls: TypedToolCall<TOOLS>[] = [];',
    text: [
      '          // step 级累加器：只在本 step 内有效，flush 时汇总成 StepResult。',
      '          // 与 recordedContent 的区别：这里保留类型化的工具调用/输出，便于后续步骤消费。',
      '          // [事务] 只有 finish-step 成功入流后这些累积才有意义（见 flush 的提交顺序）。',
    ],
  },
  // ---------- step transform ----------
  {
    at: 3331,
    expect: 'async transform(chunk, controller): Promise<void> {',
    text: [
      '                // 这里是"模型 part → 用户 part"的转换层：',
      '                // 负责 id 重映射、start-step 注入、累积器写入与缓冲放行。',
      '                // [事务] 每个 chunk 都先处理重试边界再处理普通 part，',
      '                // 保证边界之后的 part 一定落在重置后的状态里。',
      '                // 不做 async 等待（除 enqueue 外无挂起点），因此不会乱序。',
    ],
  },
  {
    at: 3332,
    expect: 'if (isStreamRetryAttemptBoundaryPart(chunk)) {',
    text: [
      '                // 收到重试边界：把本 step 的"模型产出部分"整体复位，但保留 step 身份。',
      '                // 必须重置 hasReceivedTerminalChunk / OutputChunk，否则上一次尝试的',
      '                // 终止信号会让新尝试的 flush 走错分支。',
      '                // [权衡] 只清模型相关状态，工具累积器不清：工具调用属于 step，不属于某次尝试。',
      '                // 边界 part 本身以符号键入流，不暴露给普通消费者。',
    ],
  },
  {
    at: 3354,
    expect: "if (chunk.type === 'model-call-start') {",
    text: [
      '                // model-call-start 只更新 warnings，不转发也不当作首包：',
      '                // 它出现在 provider 建连时，此时还没有任何语义输出。',
      '                // 若把它算作首包，会把"连接成功但模型未响应"误判为已开始输出。',
    ],
  },
  {
    at: 3359,
    expect: 'if (stepFirstChunk) {',
    text: [
      '                // 第一个真正的 part 到达时补发 start-step：',
      '                // 这样 request / warnings 已经确定，消费者拿到的 step 头信息是完整的。',
      '                // 空流（无任何 part）不会发 start-step，flush 会直接报错收口。',
    ],
  },
  {
    at: 3372,
    expect: 'if (isOutputChunk(chunk)) {',
    text: [
      '                // 只要出现语义输出就标记，供 flush 区分"空截断"与"部分结果"。',
    ],
  },
  {
    at: 3376,
    expect: 'switch (chunkType) {',
    text: [
      '                // 分派规则只有三类：',
      '                // 1) 无需改写的 part 直接透传；',
      '                // 2) text / reasoning 需要重映射 id 并维护映射表；',
      '                // 3) 工具与终止类 part 需要写进 step 累加器。',
      '                // default 分支用 never 兜底：新增 part 类型时编译器强制在这里处理。',
      '                // 注意透传分支不做任何对象拷贝，避免每个 delta 都产生垃圾。',
    ],
  },
  {
    at: 3377,
    expect: "case 'file':",
    text: [
      '                  // 这些 part 没有跨 step 的 id 语义，也没有累积过程，原样转发即可。',
      '                  // 它们的顺序即产生顺序，消费者按到达顺序渲染。',
    ],
  },
  {
    at: 3398,
    expect: "case 'text-delta': {",
    text: [
      '                  // 空 delta 且没有元数据时直接丢弃：',
      '                  // provider 偶尔会发空增量（例如仅更新 citation），丢弃可避免无谓渲染。',
      '                  // id 用映射表回填；映射缺失时退回原 id，保证流不中断。',
      '                  // [失败路径] 映射缺失通常意味着乱序 start，降级比抛错更安全。',
    ],
  },
  // ---------- 收口 ----------
  {
    at: 3501,
    expect: "case 'error': {",
    text: [
      '                    // error 也是终止 chunk：step 会照常收口（finishReason=error），',
      '                    // 只是不再进入下一步（见 shouldStartNextStep 的 error 分支）。',
    ],
  },
  {
    at: 3523,
    expect: 'async flush(controller) {',
    text: [
      '                // flush 是 step 的提交点：流关闭前必须完成记账，',
      '                // 否则消费者拿到 finish-step 后读 steps 会读到不完整数据。',
      '                // [事务] 顺序固定：判空流 → 发 finish-step → await stepFinish → 清计时器',
      '                // → 判断是否下一步。任何提前 return 都必须先 cleanupStepTimeouts。',
    ],
  },
  {
    at: 3527,
    expect: 'if (!hasReceivedTerminalChunk && !hasReceivedOutputChunk) {',
    text: [
      '                  // [失败路径] 既无终止 chunk 又无任何输出 = 模型流被截断：',
      '                  // 报 NoOutputGeneratedError，而不是记一个空 step，',
      '                  // 否则调用方会把"请求失败"误读成"模型返回空字符串"。',
      '                  // 有部分输出时保留部分结果：对流式 UI 而言比整段丢弃更有价值。',
    ],
  },
  {
    at: 3543,
    expect: 'const finishStepPart: TextStreamPart<TOOLS> = {',
    text: [
      '                  // finish-step 是消费者可见的"本步完成"信号，字段必须一次给全：',
      '                  // 分多次发会让中间态读到 undefined 的 usage / finishReason。',
    ],
  },
  {
    at: 3566,
    expect: 'await stepFinish.promise;',
    text: [
      '                  // [事务] 等 eventProcessor 把 step 记入 recordedSteps 再继续：',
      '                  // 下一步的 prepareStep 与 stopCondition 都依赖完整历史。',
    ],
  },
  {
    at: 3584,
    expect: 'for (const toolCall of stepToolCalls) {',
    text: [
      '                  // provider 执行的工具可能延迟产出结果（例如服务端代码执行器触发客户端工具）：',
      '                  // 没有结果的调用先挂起，下一步带客户端结果回灌后才会闭合。',
      '                  // [失败路径] 若调用方始终不回灌，这个 id 会一直留在 pending 集合，',
      '                  // 导致流无法自然结束——这是协议要求，不是泄漏。',
    ],
  },
  {
    at: 3599,
    expect: 'pendingDeferredToolCalls.set(toolCall.toolCallId, {',
    text: [
      '                      // 只登记"本 step 内没有结果"的调用：已有结果说明是同步完成的，',
      '                      // 再登记会让下一步误以为还欠一个结果。',
    ],
  },
  {
    at: 3624,
    expect: 'const shouldStartNextStep = async () => {',
    text: [
      '                  // 是否继续下一步的唯一判定点，顺序即优先级：',
      '                  // 1) interrupted 直接停；2) 客户端工具未执行完则等下一轮；',
      '                  // 3) 无工具、无延迟结果、无 steering 时停；4) 触发 stopCondition 时停。',
      '                  // [事务] 这里只判断不改状态：真正推进由外层循环负责，',
      '                  // 避免判定过程中产生副作用导致重入。',
      '                  // [失败路径] error 步骤不会被 steering 消息"救活"：',
      '                  // 失败后继续调用只会把错误放大成多步失败。',
    ],
  },
  {
    at: 3678,
    expect: 'if (await shouldStartNextStep()) {',
    text: [
      '                  // 进入下一步会重新执行 streamStep：计时器、缓冲、累加器全部重建，',
      '                  // 只有 steps / usage / recordedContent 这些跨 step 状态被保留。',
    ],
  },
  // ---------- onEnd 收口 ----------
  {
    at: 2104,
    expect: 'self._finishReason.resolve(finishReason);',
    text: [
      '          // 先 settle 结果 Promise，再跑回调（见下方 onEnd）：',
      '          // 回调可能很慢或抛错，若先跑回调，await result.text 会被无谓拖住。',
      '          // [事务] steps 在 replay=false 时 resolve 空数组：低内存模式不保留历史，',
      '          // 这是契约而不是 bug，读取方必须先用 retention 判断。',
      '          // 三个 Promise 各自 settle 一次（见 INV-07），这里不加锁因为它们同属一个执行流。',
    ],
  },
  {
    at: 2111,
    expect: 'if (isAborted) {',
    text: [
      '          // abort 与正常结束分开：中止时不触发 onEnd，也不构造 onEndEvent。',
      '          // [权衡] 中止的语义是"调用方主动放弃"，不属于一次生成的结束，',
      '          // 交给 onAbort 处理；若这里也发 onEnd，调用方会重复记账。',
      '          // 结果 Promise 已在上面 settle，因此消费者不会挂起（见 INV-01）。',
    ],
  },
  {
    at: 2116,
    expect: 'const finalStep = recordedSteps[recordedSteps.length - 1];',
    text: [
      '          // onEnd 的字段是"全量聚合 + 最后一步的单值字段"：',
      '          // text / finishReason / response 描述最终产出，其余数组跨 step 拼接。',
      '          // [事务] finalStep 必须先取出来，避免下面多次访问同一数组下标。',
      '          // 这里的聚合是 O(steps × parts)，只在结束跑一次，不做缓存。',
    ],
  },
  {
    at: 2135,
    expect: 'const onEndWithOutput =',
    text: [
      '          // output 只在配置了 output 规范时才解析，且解析失败不阻断 onEnd：',
      '          // 回调的价值在于拿到结束事件本身，输出解析失败只影响 output 字段。',
      '          // [权衡] replay 模式复用 getOutputPromise（只解析一次并缓存），',
      '          // 低内存模式没有缓存，只能就地解析最后一步。',
      '          // catch 返回 undefined 是刻意的：不让解析错误掩盖真正的结束原因。',
    ],
  },
  {
    at: 2154,
    expect: 'const onEndEvent = {',
    text: [
      '          // 事件对象在调用前一次性构造完：回调拿到的是快照，',
      '          // 不应在回调里依赖"之后还会被填充"的字段。',
      '          // responseMessages 含初始消息：这是下一轮请求最常直接复用的字段。',
    ],
  },
  {
    at: 2188,
    expect: 'await Promise.all([',
    text: [
      '          // 用户回调和遥测并行执行：二者互不依赖，串行只会延长收尾时间。',
      '          // [失败路径] Promise.all 会在任一失败时立刻拒绝，随后进入 catch 让流 error；',
      '          // 另一侧的回调仍会跑完，因此回调实现必须自行保证幂等。',
      '          // 顺序上 callbacks 在前只是为了可读性，执行顺序并无保证。',
      '          // 两处共用同一个 onEndEvent 对象：回调不得修改它，否则会互相污染。',
    ],
  },
  {
    at: 2198,
    expect: '} catch (error) {',
    text: [
      '          // 收尾阶段的任何抛错都转成流错误：',
      '          // 此时结果 Promise 已 settle，消费者只能通过 error part 感知问题。',
    ],
  },
  {
    at: 2200,
    expect: '} finally {',
    text: [
      '          // [资源] 低内存模式在这里释放所有累积引用：',
      '          // 注意是"替换引用"而不是原地清空，因为已经交给回调的数组不能被改动。',
      '          // 这段代码即使抛错也必须执行，因此放在 finally 而不是 try 末尾。',
      '          // replay 模式保留引用：结果对象仍需要它们来支撑后续 getter。',
      '          // 释放后任何延迟读取都会得到空结果，这是低内存模式的已知取舍。',
    ],
  },
  // ---------- UI 投影 ----------
  {
    at: 4107,
    expect: 'toUIMessageStream<UI_MESSAGE extends UIMessage>({',
    text: [
      '  // 把内部 part 流投影成 UI 消息协议（UIMessageChunk）：',
      '  // 这是服务端到浏览器之间的传输层边界，React 的 useChat 消费的就是它。',
      '  // [权衡] onStepEnd / onEnd 保留旧名别名：API 重命名期间两套名字都要能用，',
      '  // 新名优先，旧名仅在没有新名时生效。',
      '  // sendReasoning / sendSources 默认由协议层决定，这里只做透传。',
      '  // 该 getter 每次调用都会新建一条投影流，因此必须通过 teeStream 分叉。',
    ],
  },
  {
    at: 4141,
    expect: 'pipeUIMessageStreamToResponse<UI_MESSAGE extends UIMessage>(',
    text: [
      '  // 直接写入 Node ServerResponse：省掉调用方手动拼 header 与 flush 的样板代码。',
      '  // 与 toUIMessageStreamResponse 的区别只在传输目标：这里是流式写入，不构造 Response。',
      '  // [资源] 调用方负责在连接断开时取消，pipe 本身不持有 abort 逻辑。',
      '  // 其余 init 原样透传给底层 pipe 实现（状态码、headers 等）。',
    ],
  },
  {
    at: 4177,
    expect: 'pipeTextStreamToResponse(response: ServerResponse, init?: ResponseInit) {',
    text: [
      '  // 纯文本投影的响应写入：不带 UI 协议包装，适合非浏览器客户端或简单 SSE。',
      '  // 只取 textStream，因此工具调用等 part 会被丢弃。',
    ],
  },
  {
    at: 4185,
    expect: 'toUIMessageStreamResponse<UI_MESSAGE extends UIMessage>({',
    text: [
      '  // 构造标准 Response：供 Next.js / Hono 等框架直接返回。',
      '  // 每次都新建投影流，因此不能与 toUIMessageStream 的返回值共用（见 INV-05）。',
      '  // init 会覆盖默认 header，调用方可用它设置自定义缓存或 CORS 策略。',
      '  // [失败路径] 流中错误如何呈现由协议层的 onError 决定，不在这里抛。',
    ],
  },
  {
    at: 4218,
    expect: 'toTextStreamResponse(init?: ResponseInit): Response {',
    text: [
      '  // 最简响应：只有文本增量，没有 UI 协议、没有工具事件。',
      '  // 适合 CLI、日志回放等只关心最终文本的场景。',
    ],
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
