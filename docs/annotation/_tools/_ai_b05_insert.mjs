// AI-deep-b05：UI 消息流协议层（TextStreamPart → UIMessageChunk → SSE）。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

const plan = [
  {
    rel: 'packages/ai/src/ui-message-stream/to-ui-message-stream.ts',
    edits: [
      {
        at: 13,
        expect: '/**',
        text: [
          '// toUIMessageStream：服务端内部 part 流到浏览器协议的投影层。',
          '//',
          '// 链路位置：streamText.toUIMessageStream 调用它；',
          '// 下游 handleUIMessageStreamFinish 负责收尾（持久化回调与 outcome）。',
          '// 本文件只做三件事：转移流的所有权、逐 part 转换、维护 outcome 状态。',
          '//',
          '// INV-01：源流的 reader 只能有一个，且必须 releaseLock；',
          '// 否则取消后底层流仍被锁住，streamText 的结果 Promise 无法收口。',
          '// INV-02：outcome 一旦进入 completed / aborted 或 fatal failed 就不可被覆盖，',
          '// 它决定 onEnd 拿到的是成功、中止还是失败。',
          '// INV-03：finish-step 的转换结果必须晚于 message-metadata 入队：',
          '// UI 在 step 边界做快照，元数据必须先落地。',
        ],
      },
      {
        at: 43,
        expect: 'let outcome: UIMessageStreamOutcome',
        text: [
          '// outcome 是"整条流的结局"，不是单条消息的状态：',
          '// unknown 表示还没看到终态信号，后续可被 completed / aborted / failed 取代。',
          '// 单独用 hasFatalFailure 标记不可逆失败：一旦数据损坏，',
          '// 后续即使收到 finish 也不能把结局改成成功。',
        ],
      },
      {
        at: 46,
        expect: 'const setSourceOutcome =',
        text: [
          '// 优先级：fatal > completed/aborted > failed(可被成功覆盖) > unknown。',
          '// 具体规则：已有终态时不覆盖；新值为 unknown 时忽略；',
          '// 已有 failed 时只允许 completed/aborted 覆盖它（失败后仍可能正常收尾）。',
          '// [权衡] 这套规则宁可保留"成功"，也不让一个迟到的小错误把整条流判死。',
        ],
      },
      {
        at: 58,
        expect: 'const failOutcome =',
        text: [
          '// fatal 失败直接覆盖一切：转换器抛错意味着协议已不可信，',
          '// 此时任何"成功"信号都不应再被采纳。',
        ],
      },
      {
        at: 63,
        expect: 'const responseMessageId =',
        text: [
          '// 只有调用方给了 generateMessageId 才计算响应消息 id：',
          '// 生成策略依赖 originalMessages（续写时要复用最后一条 assistant 消息的 id）。',
          '// 未提供时保持 undefined，转换器不会给 start chunk 塞 messageId。',
        ],
      },
      {
        at: 71,
        expect: 'const sourceReader = stream.getReader();',
        text: [
          '// 先取 reader 再包一层 ReadableStream，是为了接管生命周期：',
          '// 中间层能在结束时 releaseLock，并把错误转成 outcome（见 INV-01）。',
        ],
      },
      {
        at: 82,
        expect: 'const sourceStream = new ReadableStream<TextStreamPart<TOOLS>>({',
        text: [
          '// 包装流的唯一职责是"读源流 + 记录结局"，不做任何内容转换。',
          '// done 时 releaseLock：让上游的 finally 能正常执行。',
          '// [失败路径] 读失败先 failOutcome 再 controller.error：',
          '// 顺序反了会让下游在收尾时读不到失败原因。',
        ],
      },
      {
        at: 104,
        expect: 'async cancel(reason) {',
        text: [
          '// 取消要向下传播：否则浏览器断开后服务端仍在生成并计费。',
          '// finally 里 releaseLock 是必须的：cancel 抛错也不能让 reader 泄漏。',
        ],
      },
      {
        at: 118,
        expect: 'const uiMessageChunkStream = sourceStream.pipeThrough(',
        text: [
          '// 转换层保持逐 part 同步映射，唯一例外是 message-metadata 的插入顺序。',
          '// pipeThrough 让背压从浏览器一路传回 provider，无需额外缓冲。',
          '// [失败路径] 转换抛错时先 failOutcome 再 rethrow：',
          '// 让 outcome 与流的错误状态保持一致。',
        ],
      },
      {
        at: 122,
        expect: 'const messageMetadataValue = messageMetadata?.({ part });',
        text: [
          '// 元数据按 part 计算，而不是整条消息只算一次：',
          '// 调用方可以据此把 token 用量、耗时等增量信息随时间推给 UI。',
          '// 返回值同时用于 start / finish chunk 与独立的 message-metadata chunk。',
        ],
      },
      {
        at: 135,
        expect: "if (uiMessageChunk != null && part.type !== 'finish-step') {",
        text: [
          '// finish-step 延后发送：先让 message-metadata 入队，再发 step 边界（见 INV-03）。',
          '// 其余 part 的转换结果为 undefined 时（如 sendReasoning=false）直接跳过。',
        ],
      },
      {
        at: 157,
        expect: "if (part.type === 'finish') {",
        text: [
          '// 三个终态信号在这里归约：finish → completed，abort → aborted，error → failed。',
          '// 只是记录，不关闭流：真正的关闭由 handleUIMessageStreamFinish 负责。',
          '// error 只是"数据里出现错误"，不代表流损坏，因此走 setSourceOutcome 而非 failOutcome。',
        ],
      },
      {
        at: 172,
        expect: 'return handleUIMessageStreamFinish({',
        text: [
          '// 收尾层统一处理：持久化回调、错误格式化、messageId 兜底。',
          '// onStepEnd / onEnd 优先：旧名只在新名缺失时生效。',
          '// getOutcome 传函数而不是值：收尾发生在流关闭后，必须读最新结局。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/ui-message-stream/to-ui-message-chunk.ts',
    edits: [
      {
        at: 39,
        expect: '/**',
        text: [
          '// 单个 part 的协议映射表：把 SDK 内部形状翻成浏览器的 UIMessageChunk。',
          '//',
          '// 链路位置：toUIMessageStream 的 transform 里逐 part 调用它；',
          '// 下游是 SSE 序列化与客户端的 useChat / UIMessage 解析器。',
          '// 它是纯函数：不做 I/O、不改入参，方便单测覆盖每个分支。',
          '//',
          '// INV-01：每个 case 必须显式处理，default 用 never 兜底：',
          '// 新增内部 part 时编译器会强制作者决定它的 UI 表达。',
          '// INV-02：tool 结果的 output 为 undefined 时必须转成 null：',
          '// JSON 序列化会丢弃 undefined 字段，导致客户端拿不到 output 键。',
          '// INV-03：provider 执行的工具错误绕过 onError：',
          '// 原始错误数据要回灌模型，格式化会破坏它。',
          '// INV-04：所有可选字段用条件展开，不能写 undefined：',
          '// 协议是 JSON，undefined 与缺失在客户端语义不同。',
          '//',
          '// 阅读建议：先看 isDynamic 与 dynamic 字段的约定，再看 tool-* 系列分支。',
          '// dynamic 的含义是"工具定义不在本地 tools 表里"，客户端据此放宽校验。',
        ],
      },
      {
        at: 61,
        expect: '// TODO simplify once dynamic is no longer needed for invalid tool inputs',
        text: [
          '// dynamic 的三种来源：本地工具表显式声明、provider 执行的未知工具、无效调用。',
          '// provider 执行的工具不在 tools 里，此时只能沿用 part 自带的 dynamic；',
          '// 本地已知工具返回 undefined 而不是 false：让协议层可以省略该字段。',
        ],
      },
      {
        at: 73,
        expect: 'const partType = part.type;',
        text: [
          '// 先取类型再 switch：default 的 never 检查需要这个局部变量。',
          '// 整个函数只做形状转换，不判断"该不该发"（sendXxx 除外），',
          '// 是否入流由调用方决定，职责边界清晰。',
        ],
      },
      {
        at: 75,
        expect: "case 'text-start': {",
        text: [
          '// 文本的 start / delta / end 三段式与内部协议一一对应，',
          '// 客户端据此增量拼接，不需要等整段结束。',
        ],
      },
      {
        at: 85,
        expect: "case 'text-delta': {",
        text: [
          '// 字段名从 text 改成 delta：UI 协议明确这是增量，避免被当成全量覆盖。',
        ],
      },
      {
        at: 96,
        expect: "case 'text-end': {",
        text: [
          '// citations 只在结束时下发：引用信息依赖完整文本，提前发没有意义。',
          '// 三个可选字段都用条件展开，协议里不会出现 null 占位。',
        ],
      },
      {
        at: 107,
        expect: "case 'reasoning-start':",
        text: [
          '// reasoning 受 sendReasoning 开关控制：默认开启，但调用方可整体关闭，',
          '// 用于隐藏模型内部推理（合规或产品选择）。',
          '// start / end 共用一个分支：两者形状相同，只有 type 不同。',
        ],
      },
      {
        at: 122,
        expect: "case 'reasoning-delta': {",
        text: [
          '// 关闭 reasoning 时 delta 也必须丢弃，否则客户端会收到无 start 的增量。',
        ],
      },
      {
        at: 137,
        expect: "case 'file':",
        text: [
          '// 文件一律转成 data URL：UI 协议不假设客户端能访问服务端存储。',
          '// [资源] base64 会放大约 33%，大文件会显著增加传输量；',
          '// 需要直链时应改用自定义 part 或自行上传后再传 URL。',
          '// reasoning-file 继承 sendReasoning 的开关，普通文件不受影响。',
        ],
      },
      {
        at: 153,
        expect: "case 'source': {",
        text: [
          '// 引用来源默认不发送（sendSources=false）：多数聊天 UI 不展示，',
          '// 但开启后会作为独立的 source-url / source-document chunk 呈现。',
          '// 两种 sourceType 对应不同的客户端组件，字段也不完全一致。',
        ],
      },
      {
        at: 186,
        expect: "case 'custom': {",
        text: [
          '// custom 是给业务自定义 UI 用的透传通道，kind 用于客户端分派组件。',
        ],
      },
      {
        at: 196,
        expect: "case 'tool-input-start': {",
        text: [
          '// start / delta / end / call 四段共同描述一次工具调用，',
          '// start 里带工具身份与展示元数据，供 UI 先渲染占位。',
          '// inputEncoding 透传：客户端需要按同样编码解析后续增量。',
        ],
      },
      {
        at: 220,
        expect: "case 'tool-input-delta': {",
        text: [
          '// delta 只带文本增量，不带工具名：客户端按 toolCallId 归并。',
        ],
      },
      {
        at: 228,
        expect: "case 'tool-call': {",
        text: [
          '// 无效调用转成 tool-input-error 而不是 tool-input-available：',
          '// 客户端据此展示"参数不合法"，并且不会触发本地工具执行。',
          '// 错误文本过 onError：默认实现会把细节替换成通用文案，避免泄漏服务端信息。',
          '// 有效调用转成 tool-input-available，dynamic 决定客户端是否做 schema 校验。',
        ],
      },
      {
        at: 271,
        expect: "case 'tool-approval-request': {",
        text: [
          '// inputSchemaInput 只在"解析后的值与原输入不同"时下发：',
          '// 它代表 schema 转换后的规范化输入，UI 需要在审批弹窗里展示真实参数。',
          '// 用深比较而不是引用比较：同一个值可能来自不同的对象实例。',
          '// signature / isAutomatic 用于自动审批与防篡改，原样透传。',
        ],
      },
      {
        at: 287,
        expect: "case 'tool-approval-response': {",
        text: [
          '// 审批响应只回传结论与原因；providerExecuted 用于 provider 侧审批的场景。',
        ],
      },
      {
        at: 299,
        expect: "case 'tool-result': {",
        text: [
          '// output 显式把 undefined 转成 null（见 INV-02）：',
          '// 无返回值的工具也必须让客户端看到 output 键，否则 UI 会卡在 pending。',
          '// preliminary 标记流式中间结果：客户端应覆盖展示而不是追加。',
        ],
      },
      {
        at: 322,
        expect: "case 'tool-error': {",
        text: [
          '// provider 执行的错误直接序列化原始值（见 INV-03）：',
          '// 它要作为 tool 消息回灌给模型，格式化会丢失 provider 专有字段。',
          '// 本地工具的错误才走 onError：那里是面向用户的展示文本。',
          '// [权衡] 字符串错误不再 JSON 包装，避免出现双重引号。',
        ],
      },
      {
        at: 349,
        expect: "case 'tool-output-denied': {",
        text: [
          '// 拒绝执行只需要 toolCallId：客户端据此把对应调用标记为已拒绝。',
          '// 不下发原因：拒绝理由属于客户端本地交互，回传没有协议价值。',
        ],
      },
      {
        at: 356,
        expect: "case 'error': {",
        text: [
          '// 流级错误统一过 onError 脱敏；错误对象本身不外发，避免泄漏堆栈与密钥。',
        ],
      },
      {
        at: 363,
        expect: "case 'steering-message': {",
        text: [
          '// steering 是运行中插入的用户消息，需要转成 UI part 才能被聊天界面渲染。',
          '// 只保留 text 与 file 两类：其他内容类型对 UI 没有意义。',
        ],
      },
      {
        at: 371,
        expect: "case 'start-step': {",
        text: [
          '// step 边界不带负载：客户端只用它切分消息或触发快照。',
        ],
      },
      {
        at: 375,
        expect: "case 'finish-step': {",
        text: [
          '// finish-step 与 start-step 成对出现，用于多步 agent 的中间态渲染。',
        ],
      },
      {
        at: 379,
        expect: "case 'start': {",
        text: [
          '// start 携带消息级元数据与响应 id：这是客户端创建消息对象的时机。',
          '// sendStart=false 时整个 chunk 省略，适合"续写到已有消息"的场景。',
        ],
      },
      {
        at: 394,
        expect: "case 'finish': {",
        text: [
          '// finish 带 finishReason 与最终元数据：客户端据此结束 loading 状态。',
          '// 与 start 一样受 sendFinish 开关控制。',
        ],
      },
      {
        at: 409,
        expect: "case 'abort': {",
        text: [
          '// abort 直接透传：它的形状在两侧协议中一致，无需转换。',
        ],
      },
      {
        at: 413,
        expect: "case 'tool-input-end':",
        text: [
          '// 这三类刻意不下发：tool-input-end 对 UI 无信息量（可用 tool-call 判定），',
          '// ping 是传输层保活，raw 仅供服务端调试。',
        ],
      },
      {
        at: 419,
        expect: 'default: {',
        text: [
          '// never 兜底：新增 part 类型而忘记映射时，这里编译失败而不是运行时静默丢弃。',
        ],
      },
      {
        at: 426,
        expect: 'function convertUserMessageToUIParts(',
        text: [
          '// steering 消息的模型形状 → UI 形状。',
          '// 字符串内容直接包成单个 text part；数组内容逐项映射。',
          '// 只支持 text / image / file：其余类型（如 tool 消息）不会作为 steering 出现。',
        ],
      },
      {
        at: 443,
        expect: 'const { data, mediaType: dataUrlMediaType } =',
        text: [
          '// 文件数据的来源可能是 data URL、base64 或 URL，统一解析后再构造 UI part。',
          '// mediaType 三级回退：解析出的 data URL 类型 > 显式声明 > "image" 兜底。',
          '// filename 只对 file 类型保留：图片没有文件名语义。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/ui-message-stream/create-ui-message-stream.ts',
    edits: [
      {
        at: 75,
        expect: 'const ongoingStreamPromises',
        text: [
          '// 两套生命周期跟踪：ongoingStreamPromises 决定何时关流，',
          '// activeReaders 决定取消时要取消哪些合并流（二者不是同一集合）。',
          '// [并发] merge 可被多次调用，所有写入都经由同一个 controller，天然串行。',
          '// [资源] 合并流结束后必须从 activeReaders 删除并 releaseLock。',
        ],
      },
      {
        at: 83,
        expect: 'const stream = new ReadableStream({',
        text: [
          '// 外层流只负责取消传播：数据由 writer / merge 主动写入。',
          '// cancel 等待所有 reader 取消完成，确保调用方能观察到清理结束。',
          '// [失败路径] cancel 期间的错误被 Promise.all 吸收，不影响外层流状态。',
          '// 注意 start 只是保存 controller，此时还没有任何数据。',
        ],
      },
      {
        at: 97,
        expect: 'function safeEnqueue(data:',
        text: [
          '// 写入可能发生在流已关闭之后（例如滞后的合并流），此时 enqueue 会抛错，',
          '// 吞掉是刻意的：关闭后继续写属于正常的竞态收尾。',
        ],
      },
      {
        at: 141,
        expect: 'try {',
        text: [
          '// execute 可以同步抛错也可以返回 rejected Promise，两条路径都归到 handleError。',
        ],
      },
      {
        at: 178,
        expect: 'if (result) {',
        text: [
          '// execute 返回 Promise 时纳入等待集合：流要等它完成才关闭。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/ui-message-stream/create-sse-stream-with-keep-alive.ts',
    edits: [
      {
        at: 1,
        expect: 'const STREAM_OPEN_COMMENT',
        text: [
          '// SSE 注释行：以冒号开头的行会被客户端忽略，但能立即刷出响应头。',
          '// stream-open 用于尽早解除代理/浏览器的缓冲等待（首字节时间）。',
          '// keep-alive 用于空闲期维持连接，避免网关按超时断开长连接。',
        ],
      },
      {
        at: 4,
        expect: 'export function createSseStreamWithKeepAlive({',
        text: [
          '// 给字符串流加保活包装：不改变数据，只在外层按空闲间隔插入注释行。',
          '// 不配置 keepAliveMs 时原样返回：不做任何包装，零额外开销。',
        ],
      },
      {
        at: 11,
        expect: 'if (keepAliveMs == null) {',
        text: [
          '// 直接返回原流：调用方可以无条件使用本函数，不必在外部判断。',
        ],
      },
      {
        at: 15,
        expect: 'if (',
        text: [
          '// 校验放在包装前：非法间隔会让 setTimeout 静默变成 0 或溢出为 1ms，',
          '// 造成忙循环。上限 2^31-1 是 setTimeout 能表示的最大值。',
          '// 抛错而不是回退默认值：配置错误应尽早暴露。',
        ],
      },
      {
        at: 25,
        expect: 'const reader = stream.getReader();',
        text: [
          '// 持有唯一 reader，并把取消向下传播；isCancelled 用于阻止已排队的定时器再写入。',
        ],
      },
      {
        at: 34,
        expect: 'const scheduleKeepAlive = (',
        text: [
          '// 每次调度前先清旧定时器：保证同一时刻最多一个保活任务。',
          '// desiredSize > 0 才写：消费端没准备好时宁可跳过，避免把背压顶破。',
          '// 写完后递归重排：保活是持续行为，直到有真实数据或取消。',
        ],
      },
      {
        at: 51,
        expect: 'return new ReadableStream<string>({',
        text: [
          '// start 里立刻发 stream-open 并启动保活计时。',
        ],
      },
      {
        at: 57,
        expect: 'pull(controller) {',
        text: [
          '// 读到真实数据就取消当前保活并重新计时：空闲间隔从最后一个数据算起。',
          '// [失败路径] 出错时清定时器后再决定是否上抛：已取消则静默结束。',
        ],
      },
      {
        at: 83,
        expect: 'async cancel(reason) {',
        text: [
          '// 取消顺序：先置标志（挡住定时器回调），再清定时器，最后取消上游。',
          '// 这个顺序避免在 await 期间定时器又入队一条保活数据。',
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
