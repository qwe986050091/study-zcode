import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/ui/websocket-chat-transport.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 0,
    expect: 'import {',
    text: [
      "// 【职责】基于单条持久 WebSocket 的 ChatTransport 实现：客户端发出 send/resume/abort",
      "//   帧，服务端按 requestId 回传 start/chunk/end/error/no-active，本类负责把多路",
      "//   响应解复用成互相独立的 ReadableStream<UIMessageChunk>。",
      "//",
      "// 【在链路中的位置】上游是 Chat 状态机（ui/chat.ts）的 sendMessages /",
      "//   reconnectToStream；下游是 Chat 的流解析（ui/process-ui-message-stream.ts）。",
      "//   与 http-chat-transport 的差别只在于多路复用、顺序号与断线重连。",
      "//",
      "// 【不变量】",
      "//   INV-01 sequence 必须严格递增且连续（lastSequence + 1），乱序即终止连接。",
      "//     守住位置：handleResponseFrame 的 chunk 分支。",
      "//   INV-02 每个响应帧必须能匹配到活动请求，匹配不到就静默丢弃，不报错。",
      "//     守住位置：handleResponseFrame 开头的 activeRequests.get。",
      "//   INV-03 请求从 Map 中移除后，任何迟到帧都不得再触碰其 controller。",
      "//     守住位置：chunk 分支的 activeRequests.get(requestId) !== request 复查。",
      "//   INV-04 连接级错误必须同时失败所有活动请求，不能只失败当前请求。",
      "//     守住位置：terminateConnection 与 close 中的 failAllRequests。",
      "//   INV-05 发送串行化：所有帧按调用顺序写出，sendQueue 只增不跳。",
      "//     守住位置：sendFrame。",
    ],
  },
  {
    find: 'export type WebSocketChatTransportSendRequest<',
    text: [
      "// 客户端帧是三方判别联合：send 发起一轮生成，resume 请求重放，abort 取消。",
      "// 三种帧都必须带 requestId，它是响应侧唯一的关联键，服务端必须原样回传。",
      "// send 携带完整 messages，resume 只带序号（内容由服务端持有）。",
      "// messages 是 UI 消息而非模型消息：转换发生在服务端。",
      "// 帧结构一旦发布就是对外协议，新增字段只能可选，不能改名。",
    ],
  },
  {
    find: 'export type WebSocketChatTransportResumeRequest = {',
    text: [
      "// lastSequence 由本传输固定为 undefined，即只要求全量重放。",
      "// 原因：Chat 恢复时会新建流解析器，缺了前置 chunk 就拼不出文本。",
      "// 服务端可自行决定是否利用该字段做增量，本客户端不依赖。",
    ],
  },
  {
    find: 'export type WebSocketChatTransportResponse =',
    text: [
      "// 服务端帧：start 表示已接受请求（resume 靠它提前返回流），",
      "//   chunk 携带递增序号与一个 UI 消息 chunk，",
      "//   end 正常收尾，error 带可选错误文本，no-active 表示没有可重放的活动请求。",
      "// 每种帧都必须带 requestId；未知 type 会被当作协议错误并终止整条连接。",
      "// resume 的“无活动流”用 no-active 而非 error，以便 Chat 走新建消息分支。",
      "//   （no-active 在 handleResponseFrame 中解析为 resolveResponse(null)。）",
    ],
  },
  {
    find: 'export type WebSocketChatTransportInitOptions<UI_MESSAGE extends UIMessage> = {',
    text: [
      "// 所有 Resolvable 字段（params/headers/body）都可以是函数，在每次请求前求值，",
      "//   因此可以在其中读取最新 token；不要在模块级提前 resolve。",
      "// 浏览器 WebSocket 无法设置握手头，headers 只作用于应用层帧。",
    ],
  },
  {
    find: 'type ConnectionState = {',
    text: [
      "// 连接状态用手写 deferred 而非直接存 Promise：需要在 onopen 时兑现、",
      "//   在 onerror/onclose 时拒绝，且要防止重复 settle。",
      "// settled 是幂等开关：resolve/reject 只能生效一次，晚到的回调直接忽略。",
      "// socket 提前挂上（构造后即有值），便于在 open 之前就能 close 掉它。",
      "// promise 永远被消费（waitForConnection 会挂 then），无需额外 catch。",
      "// 该结构不持有请求集合，请求与连接是两条独立的生命周期。",
    ],
  },
  {
    find: 'type ActiveRequest = {',
    text: [
      "// 每个未完成的请求一个实例，是流与关联状态的聚合体。",
      "// lastSequence 是该请求已下发的最大序号：chunk 分支用它做严格递增检查，",
      "//   因此它是状态而非缓存，绝不能为了幂等而放宽。",
      "// stream/controller 在 createActiveRequest 中一并建立，cancel 回调会转成 abort。",
      "// resolveResponse/rejectResponse 只对 resume 有效：send 在发送成功时就已返回流，",
      "//   而 resume 需要等服务端 start 帧才知道有没有可重放的流。",
      "// responseSettled 防止 start 与 abort 竞争时重复兑现同一个 Promise。",
      "// abortSignal/abortListener 成对保存，清理时必须移除监听，否则会泄漏闭包。",
      "// 该对象在 cleanupRequest 之后即失效，迟到帧靠 activeRequests 复查识别。",
    ],
  },
  {
    find: 'const WEBSOCKET_OPEN_STATE = 1;',
    text: [
      "// 直接用数值 1，避免依赖 DOM 的 WebSocket.OPEN 常量（Node 环境可能没有）。",
      "// 其它状态（CONNECTING=0、CLOSING=2、CLOSED=3）在本文件中不需要具名。",
    ],
  },
  {
    find: 'function createAbortError(signal?: AbortSignal): Error {',
    text: [
      "// 优先沿用调用方给出的 abort reason，保留取消的原始原因（如超时错误）。",
      "// 没有 reason 时构造 name=AbortError 的 Error，供下游按名称识别。",
      "// name 是手工赋值的：Error 子类在部分编译目标下不会自动设置正确的 name。",
      "// 不缓存实例：每次 abort 都要新的 Error，避免共享栈信息误导排查。",
    ],
  },
  {
    find: 'export async function safeValidateWebSocketChatTransportRequest<',
    text: [
      "// 对不受信任的客户端帧做形状校验，返回判别联合而不是抛异常。",
      "// 校验顺序是有意的：先 type，再分支各自必填字段，最后才校验 messages。",
      "//   messages 校验最贵，放在确认帧类型之后可避免对 abort 帧做无谓遍历。",
      "// abort 帧只需 requestId：取消是最小信息量的操作，不应要求更多字段。",
      "// 通过校验后返回的是原对象（messages 除外），调用方仍需按类型断言使用。",
      "// 失败统一包装成 Error，cause 中保留原始校验错误以便日志追溯。",
      "// 该函数供服务端使用；浏览器侧不会调用它。",
    ],
  },
  {
    find: "if (value.type === 'abort') {",
    text: [
      "// abort 分支必须在通用字段检查之前返回，否则会被要求携带 id/headers/body。",
      "// 这是协议上的刻意不对称：取消动作只认 requestId。",
      "// 返回原对象而非拷贝，服务端可直接读取。",
    ],
  },
  {
    find: "if (value.type === 'resume') {",
    text: [
      "// resume 允许 lastSequence 缺失或为 0 以上的安全整数，负数与非整数都要拒绝。",
      "// headers/body 在此之前的通用检查里已确认是字符串映射与对象。",
      "// 不校验 id 是否存在于服务端，那是业务层职责。",
    ],
  },
  {
    find: "value.type !== 'send' ||",
    text: [
      "// send 是最严格的帧：trigger 只允许两个字面量，messageId 可选但必须为字符串。",
      "// 三者写在同一个 if 里是为了让失败信息统一为 Invalid send request。",
      "// trigger=regenerate 时 messageId 通常指向被重生成的消息，可为空。",
      "// 不要在此推断 trigger 与 messageId 的配对关系，由服务端决定语义。",
    ],
  },
  {
    find: 'const messages = await safeValidateUIMessages<UI_MESSAGE>({',
    text: [
      "// 复用 UI 消息校验器，保证 WebSocket 入口与 HTTP 入口的接受集合完全一致。",
      "// 校验失败时把原始错误放进 cause，不把细节泄漏到响应帧中。",
      "// 成功后用展开运算符替换 messages，其余字段原样透传。",
    ],
  },
  {
    find: 'export class WebSocketChatTransport<',
    text: [
      "// 一次连接复用给多个请求：靠 requestId 解复用，而不是一请求一连接。",
      "// 并发模型是单连接加多流：sendFrame 串行写，响应按 requestId 分发。",
      "// resumeStreamIsReplay = true 告诉 Chat：恢复得到的是从头重放的流，",
      "//   因此调用方应清掉本地已渲染的增量，而不是在其上追加。",
      "// 该标志必须是只读字面量 true，Chat 依赖它做分支判断。",
      "// 连接在无活动请求时不会自动关闭，需要调用方显式 close()。",
      "// 错误传播有两条路径：连接级错误终止所有请求，请求级错误只失败自己。",
    ],
  },
  {
    find: 'private readonly url: string;',
    text: [
      "// 构造参数全部冻结为私有只读：Resolvable 保留到请求时才求值，不能提前替换。",
      "// connection 是当前连接的单例槽位，置空即表示需要重建。",
      "// activeRequests 以 requestId 为键：它是响应分发的唯一索引。",
      "// sendQueue 是一条串行链：每次发送都接在上一发送之后，失败也不断开链。",
      "//   因此链上必须 catch 掉错误（见 sendFrame），否则一次失败会毒化后续发送。",
      "// 这三个字段都是实例级可变状态，不跨 transport 共享。",
    ],
  },
  {
    find: 'async sendMessages({',
    text: [
      "// STEP-1 解析配置：headers/body 并行 resolve，减少一次往返等待。",
      "// STEP-2 合并调用方覆盖：显式传入的 headers/body 优先于构造配置。",
      "// STEP-3 交给 prepareSendMessagesRequest 定制帧，它可改写 messages/body/headers。",
      "// STEP-4 取连接（可能触发建连）、分配 requestId、登记活动请求。",
      "// STEP-5 串行写出帧；发送失败要同时失败该请求，否则流会永远挂起。",
      "// 返回的是流而不是响应：chunk 会在后续帧中陆续入队。",
      "// 每个 await 之后都复查 abortSignal，避免等待期间被取消还继续发送。",
    ],
  },
  {
    find: 'const preparedRequest = await this.prepareSendMessagesRequest?.({',
    text: [
      "// 定制回调只允许替换 messages/body/headers 三者，不能改 requestId 与 trigger。",
      "// preparedRequest 的字段为空表示沿用原值，因此用 ?? 而不是 ||。",
      "// 该回调可以是异步的，此处 await 会推迟建连，属于预期行为。",
    ],
  },
  {
    find: 'const frame: WebSocketChatTransportSendRequest<UI_MESSAGE> = {',
    text: [
      "// 组帧时 headers 需要再规范化一次：回调可能返回 Headers 实例而非普通对象。",
      "// metadata 原样透传，本层不解释其结构。",
      "// requestId 在登记活动请求时生成，必须与帧内一致，否则响应无法关联。",
    ],
  },
  {
    find: 'async reconnectToStream(',
    text: [
      "// 与 sendMessages 的差异：这里可能没有可恢复的流，因此返回 null 是合法结果。",
      "// 契约要求先返回 Promise 形态的流，等 start 帧到达才能确定其是否存在。",
      "// lastSequence 内部传 -1 表示从 0 开始收，但帧里发 undefined 让服务端全量重放。",
      "// 若连接在发送期间断开，必须把 responsePromise 标记为已 settle 再抛出，",
      "//   否则调用方会同时收到异常与一个永不兑现的 Promise。",
    ],
  },
  {
    find: 'const responsePromise = new Promise<ReadableStream<UIMessageChunk> | null>(',
    text: [
      "// 先建 Promise 再登记请求：回调需要引用 resolve/reject，顺序不能反。",
      "// void catch 是为了在登记后立刻被 abort 的窗口期内避免未处理拒绝告警，",
      "//   真正的拒绝仍会由返回给调用方的 Promise 传递。",
      "// 该 Promise 只会被兑现一次，由 responseSettled 守护；不要在 catch 中做清理。",
    ],
  },
  {
    find: 'close(): void {',
    text: [
      "// close 是同步的：先摘掉连接槽位，再失败所有请求，最后尽力关闭 socket。",
      "// 顺序很重要：先摘槽位可让后续 onclose 回调识别为旧连接并直接返回。",
      "// socket.close 包在 try 中，因为对端可能已断开导致抛错。",
    ],
  },
  {
    find: 'private async getSocket(',
    text: [
      "// 复用已打开的连接；CONNECTING 状态不复用，仍走 waitForConnection 等待。",
      "// 首次调用时创建 ConnectionState 并异步初始化，后续调用共享同一个 promise。",
      "// 初始化是 fire-and-forget（void），失败通过 promise 拒绝与 terminate 传播。",
      "// 这里拿到的 connection 可能为 null：初始化同步失败并清空槽位时会发生，",
      "//   因此必须显式判空而不是依赖非空断言。",
      "// abortSignal 只影响等待连接这一步，不影响已建立的连接。",
    ],
  },
  {
    find: 'private async initializeConnection(',
    text: [
      "// 建连全过程：解析 params → 校验 URL → 构造 socket → 挂四个回调。",
      "// 每个回调进入时都先比对 this.connection === connection，",
      "//   因为连接可能已被 close/terminate 替换，旧 socket 的事件必须丢弃。",
      "// onopen 兑现连接 promise；onmessage/onclose 用 messageTail 串行化异步处理，",
      "//   否则并发 text 解析会让 chunk 顺序错乱（见 INV-01）。",
      "// catch 分支直接 terminate：建连阶段任何异常都意味着这条连接不可用。",
      "// params 在 resolve 之后还要复查连接身份，因为 resolve 可能是异步的。",
    ],
  },
  {
    find: 'socket.onmessage = event => {',
    text: [
      "// messageTail 是一条串行链：每个消息都接上一个的尾部，",
      "//   保证 readWebSocketMessageText（可能异步）与后续处理不会交错。",
      "// 任何一步抛错都会 terminate 整条连接：协议错误不可局部恢复。",
      "// 不能改成 Promise.all 或独立 async 函数，否则顺序号检查会失去意义。",
      "// text 解析失败同样视为协议错误，而不是丢弃该帧继续处理。",
    ],
  },
  {
    find: 'socket.onclose = event => {',
    text: [
      "// onclose 也要排进 messageTail：必须等已排队的消息处理完再判定连接结束，",
      "//   否则末尾的 chunk 会被误判为随连接一起丢失。",
      "// close code 只在为数字时展示，reason 为空时不拼接到错误文本里。",
    ],
  },
  {
    find: 'private buildUrl(params: Record<string, string> | undefined): URL {',
    text: [
      "// 相对 URL 用当前页面地址做基准；非浏览器环境没有 location，必须给绝对地址。",
      "// toWebSocketUrl 负责 http(s) 到 ws(s) 的协议转换。",
      "// 协议与主机名都要校验：只有 ws/wss 且主机非空才算合法端点。",
      "// 拒绝 fragment：它不会发给服务端，带上只会造成误解。",
      "// params 用 set 覆盖同名查询参数，保证调用方显式配置优先。",
    ],
  },
  {
    find: 'private waitForConnection(',
    text: [
      "// 无信号时直接返回原 promise，避免多余包装。",
      "// 已取消要立即拒绝，不等待连接结果。",
      "// 成功或失败都要移除 abort 监听，否则信号上的监听会随请求数累积。",
    ],
  },
  {
    find: 'private terminateConnection(',
    text: [
      "// 终止连接的唯一入口：摘槽位 → 拒绝连接 promise → 失败所有请求 → 关 socket。",
      "// 槽位比对保证只有当前连接能触发清理，旧连接的迟到事件被忽略。",
      "// 拒绝与失败都通过 settled 去重，重复调用安全。",
      "// closeSocket=false 用于已经从 onclose 走到这里的场景，避免二次关闭。",
      "// 关闭码 1011 表示服务端内部错误，便于对端日志归类。",
    ],
  },
  {
    find: 'private createActiveRequest({',
    text: [
      "// 建立请求的全部可变状态，并把取消信号与流的 cancel 都接到 abortRequest。",
      "// 流的 cancel 回调传 closeStream=false：取消方自己已放弃读取，不必再关闭。",
      "// abortSignal 在注册监听后立刻复查 aborted，覆盖注册前已取消的窗口。",
      "// lastSequence 由调用方给出，send 与 resume 都传 -1。",
      "//   resume 用 -1 是刻意的：服务端会全量重放，序号从 0 重新开始。",
      "// controller 在 start 中同步赋值，因此构造后即可安全使用。",
      "// 该函数只登记、不发送；发送失败的清理由调用方负责。",
    ],
  },
  {
    find: 'private abortRequest(requestId: string, closeStream: boolean): void {',
    text: [
      "// 取消一个请求：兑现 resume 的 reject、清理登记、按需关闭流，最后通知服务端。",
      "// resume 必须 reject 而不是 resolve(null)：取消不等于没有可恢复的流。",
      "// closeStream 区分两种来源：外部取消（true）与流自身 cancel（false），",
      "//   后者再 close 会抛错，虽然被 catch 住但属于无意义操作。",
      "// 通知服务端是 best-effort：本地已放弃，不因发送失败而抛错。",
      "// 清理必须在关闭流之前完成，避免 abort 回调重入。",
      "// 该函数对同一 requestId 幂等：第二次进入时 Map 中已无该请求。",
    ],
  },
  {
    find: 'private failRequest(request: ActiveRequest, error: Error): void {',
    text: [
      "// 与 abortRequest 的区别：这里是异常失败，错误对象原样传给流。",
      "// 已不在 Map 中说明请求已结束，直接返回，避免对已关闭流 error。",
      "// 先兑现 resume 的 reject，再清理，顺序与 abortRequest 一致。",
    ],
  },
  {
    find: 'private resolveResumeStream(request: ActiveRequest): void {',
    text: [
      "// resume 的流已就绪信号：可被 start 帧或第一个 chunk 触发，因此必须幂等。",
      "// send 请求不走这里：它在发送成功时就已经把流返回给调用方了。",
      "// 用 responseSettled 保证只兑现一次。",
    ],
  },
  {
    find: 'private async handleResponseFrame(',
    text: [
      "// 响应帧总入口：解析 JSON → 校验最小字段 → 按 requestId 找请求 → 分派。",
      "// 找不到请求的帧静默丢弃：abort 之后服务端仍可能发出一两个在途帧。",
      "// 解析失败或字段缺失属于协议错误，抛出后由 onmessage 的 catch 终止连接。",
      "// 这里的 await（解析、chunk 校验）都可能让请求在此期间被取消，",
      "//   因此 chunk 分支在使用 controller 前必须复查请求仍在 Map 中。",
      "// 帧的 requestId 必须精确匹配，不做取最近一个请求之类的猜测。",
      "// 分派是按 type 的穷尽 switch，未知类型一律抛错而不是忽略。",
    ],
  },
  {
    find: "case 'chunk': {",
    text: [
      "// 序号三重检查：合法非负整数、不得回退、必须恰好加一。",
      "//   重复帧（小于等于 lastSequence）直接丢弃，是唯一允许的静默跳过。",
      "//   跳号意味着帧丢失，无法拼接，只能终止连接。",
      "// chunk 内容需要按 UI 消息协议校验，这一步是异步的。",
      "// 校验期间请求可能已被 abort/cancel，因此入队前复查 Map 中的对象身份。",
      "// lastSequence 只在成功入队后才推进，保证入队即已投递。",
    ],
  },
  {
    find: "case 'end': {",
    text: [
      "// end 是正常收尾：先兑现 resume（可能一帧 chunk 都没有），再关闭流。",
      "// 这里不检查是否还有未完成的 part，那是 Chat 的职责，本层只做传输。",
      "// cleanup 之后再 close，保证 close 触发的回调不会重入清理。",
    ],
  },
  {
    find: "case 'no-active': {",
    text: [
      "// no-active 只对 resume 有意义：告诉调用方服务端没有可重放的流，返回 null。",
      "// 对 send 请求出现 no-active 属于协议异常，但仍按收尾处理而不是抛错。",
      "// 与 error 的区别：这不是失败，调用方应回退到新建消息路径。",
    ],
  },
  {
    find: "case 'error': {",
    text: [
      "// 服务端错误帧：errorText 可选，缺省时给一个通用文案。",
      "// 只失败该请求，不断开连接，其它请求可能仍在正常传输。",
      "// errorText 若存在必须是字符串（空串也接受），否则视为协议错误抛出。",
    ],
  },
  {
    find: 'private async sendFrame(',
    text: [
      "// 发送串行化的实现：每次发送都接在 sendQueue 之后。",
      "// sendQueue 保存的是已 catch 的版本，因此单次失败不会阻断后续发送；",
      "//   但返回给调用方的仍是原始 promise，失败照常抛出。",
      "// 写前先等待缓冲区排空，避免库层队列无限增长。",
      "// socket 身份与状态在真正写入前复查：等待期间连接可能已被替换。",
      "// JSON.stringify 抛错（如循环引用）会原样上抛，由调用方失败该请求。",
    ],
  },
];

for (const a of anchors) {
  if (a.at !== undefined) {
    if (!lines[a.at].includes(a.expect)) {
      console.error(`EXPECT FAIL at ${a.at}: ${lines[a.at]}`);
      process.exit(1);
    }
    a.idx = a.at;
  } else {
    const hits = lines.reduce((acc, line, i) => (line.includes(a.find) ? [...acc, i] : acc), []);
    if (hits.length !== 1) {
      console.error(`HITS ${hits.length} for: ${a.find}`);
      process.exit(1);
    }
    a.idx = hits[0];
  }
}

for (const a of [...anchors].sort((x, y) => y.idx - x.idx)) {
  lines.splice(a.idx, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
