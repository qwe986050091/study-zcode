// B17 insert: packages/ai/src/realtime/realtime-session.ts
import fs from 'node:fs';

const FILE = 'D:/code/opensource/ai/packages/ai/src/realtime/realtime-session.ts';
const raw = fs.readFileSync(FILE, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(eol);

const blocks = [
  {
    at: 1,
    expect: "import {",
    lines: [
      '// ============================================================================',
      '// RealtimeSession：实时语音/多模态会话的应用侧门面',
      '// ----------------------------------------------------------------------------',
      '// 职责',
      '//   1. 把一次实时会话的生命周期（连接、上行事件、下行事件、收尾）封装为',
      '//      命令式 API：connect / sendEvent / sendTextMessage / addToolOutput /',
      '//      startAudioCapture / stopPlayback / close / disconnect / dispose。',
      '//   2. 抹平四条物理链路：provider 自有传输、WebRTC、连续 PCM WebSocket',
      '//      中继、普通 WebSocket（client-secret 或 server relay）。',
      '//   3. 把服务端事件归约成 RealtimeState，并叠加会话级状态后推给子类',
      '//      的 setState（React 侧再映射为渲染状态）。',
      '//',
      '// 在链路中的位置',
      '//   上游：ai/src/realtime/index.ts / React hooks / 应用代码。',
      '//   下游：RealtimeAttempt（一次连接的取消与结算）、',
      '//         RealtimeCommandTracker（eventId 与 ACK 关联）、',
      '//         BrowserRealtimeTransport / BrowserRealtimeWebRTC /',
      '//         BrowserRealtimeLiveWebSocket / RealtimeModelTransport、',
      '//         BrowserRealtimeAudio、realtime-event-reducer、',
      '//         realtime-session-state。',
      '//',
      '// 最容易踩的坑',
      '//   - 所有异步回调都要先过 current() / attempt 比对，否则上一代连接的',
      '//     迟到事件会写进新会话。',
      '//   - disconnect 必须先清引用再 dispose，顺序颠倒会让 dispose 回调',
      '//     再次触发发送或状态更新。',
      '//   - applyState 的 publication 序号用于拒绝旧归约结果覆盖新状态。',
      '// ============================================================================',
    ],
  },
  {
    at: 32,
    expect: 'export type RealtimeSessionOptions = {',
    lines: [
      '// 会话选项。api 是四选一的判别联合：',
      '//   token     浏览器用一次性 client secret 直连 provider WebSocket；',
      '//   session   WebRTC，经服务端交换 SDP；',
      '//   provider  由 model.createTransport 提供的自有浏览器传输；',
      '//   websocket 应用自建中继（continuous 时为 PCM 中继）。',
      '// 联合用 never 互斥，运行期仍由 validateConnection 兜底。',
      '// 超时三件套分别约束：建连就绪、close 后等用量、WebRTC 断线宽限。',
      '// maxPlaybackBufferSeconds 只对连续 PCM 生效，用于播放背压暂停。',
    ],
  },
  {
    at: 82,
    expect: 'export abstract class AbstractRealtimeSession {',
    lines: [
      '// ---------------------------------------------------------------------------',
      '// 不变量（每条都写明守住它的位置，改动前先看这里）',
      '//   INV-01 同一时刻只有一个活动 attempt。',
      '//          守住它：connect 开头的 attempt?.active 检查、current() 闭包。',
      '//   INV-02 事件只作用于产生它的 attempt。',
      '//          守住它：所有回调里的 current()/attempt 比对与 fail 的幂等判断。',
      '//   INV-03 一次连接对应一个新的 reducer 与空的工具集合。',
      '//          守住它：connect 中重建 reducer 并清空 toolCallsInResponse。',
      '//   INV-04 上行命令的 eventId 在一次 attempt 内不可复用。',
      '//          守住它：RealtimeCommandTracker.validateId 与 pending/recent。',
      '//   INV-05 close 的 Promise 只结算一次。',
      '//          守住它：RealtimeAttempt.beginClose 的 closePromise ??=。',
      '//   INV-06 终态之后不再接受提交。',
      '//          守住它：sendEvent 对 error/closing/非 active 的守卫。',
      '//   INV-07 工具输出必须全部回填后才发起下一轮 response。',
      '//          守住它：submittedToolOutputs 与 maybeRequestToolResponse。',
      '//   INV-08 状态发布是单调的，旧发布不得覆盖新发布。',
      '//          守住它：applyState 的 publication 序号与逐字段 diff。',
      '//   INV-09 资源释放是幂等的，且先摘引用后 dispose。',
      '//          守住它：disconnect 的局部暂存与 this.x = undefined。',
      '//   INV-10 应用回调抛错不得中断清理链路。',
      '//          守住它：reportError / notifyEvent 的 try-catch 与 Promise 兜底。',
      '//   INV-11 音频采集的所有权与代际绑定，旧代结果不得回灌。',
      '//          守住它：captureGeneration 与 ownsStream 的计算位置。',
      '//',
      '// 五类标记在本文件的分布',
      '//   [并发] current() 守卫、captureGeneration、publication、微任务时序；',
      '//   [事务] 状态机 connecting → connected → closing/disconnected/error；',
      '//   [资源] 定时器、AbortController、MediaStream、WebSocket/RTCPeerConnection；',
      '//   [失败路径] fail / closeFailed / drainAttempt / reportError 四条出口；',
      '//   [权衡] 分支顺序固定、允许 fire-and-forget、保留双份流所有权。',
      '//',
      '// 主流程 STEP（以 connect 为轴）',
      '//   STEP-1 抢占 attempt 并发布 connecting；',
      '//   STEP-2 校验连接方式与能力声明；',
      '//   STEP-3 重置 reducer、会话状态与工具集合；',
      '//   STEP-4 安装命令跟踪器与启动超时；',
      '//   STEP-5 组装五个传输回调；',
      '//   STEP-6 按 api 形态选择物理链路并发起连接；',
      '//   STEP-7 就绪事件到达后置 connected 并启动采集；',
      '//   STEP-8 关闭时先关闭上行，再等用量/确认，最后 disconnect；',
      '//   STEP-9 断连后由 disconnect 统一回收，失败路径复用同一出口。',
      '// [权衡] 以命令式门面承载四种链路，换取调用方无感知的传输替换。',
      '// ---------------------------------------------------------------------------',
    ],
  },
  {
    at: 107,
    expect: 'protected abstract setState<K extends keyof RealtimeState>(',
    lines: [
      '// 子类实现：把 RealtimeState 的单个字段映射到框架状态（如 React setState）。',
      '// 抽象成逐字段回调，是为了让 applyState 只推送真正变化的键，避免整对象重渲染。',
    ],
  },
  {
    at: 112,
    expect: 'constructor(private readonly options: RealtimeSessionOptions) {',
    lines: [
      '// 构造期只做三件事：推导语义分叉、数值校验、装配归约器。',
      '//   sessionLifecycle：startup 用 session-start 或收尾用 session-close，',
      '//     表示会话生命周期由显式命令驱动，而不是靠传输层开关。',
      '//   continuous：连续 PCM 会话，音频由 audio-chunk 驱动、无轮次概念。',
      '// 所有超时必须是正有限且不超过 setTimeout 上限，否则直接抛错，',
      '// 避免运行到一半才出现 0ms 定时器风暴。',
    ],
  },
  {
    at: 140,
    expect: 'private validateConnection(): void {',
    lines: [
      '// 连接方式推导：provider > session > token > websocket，顺序即优先级。',
      '// 校验分三层，任何一层不满足都直接抛错，不发网络请求：',
      '//   1. 能力声明：connections 未声明时按历史默认 client-secret-websocket；',
      '//      声明了 transports 时，WebRTC/WebSocket 必须被包含。',
      '//   2. 传输工厂：provider 需要 createTransport，WebRTC 需要 getWebRTCConfig。',
      '//   3. 形态约束：连续 PCM 必须由应用提供 websocket 中继；',
      '//      token 模式需要 model.getWebSocketConfig 完成鉴权改写。',
      '// [权衡] 能力缺省走最保守的旧行为，保证未升级的 provider 不被破坏。',
      '// [失败路径] 这里抛出的错误由 connect 的 catch 统一转成 error 状态。',
    ],
  },
  {
    at: 188,
    expect: 'connect(): Promise<void>;',
    lines: [
      '// connect 重载：允许传入外部 MediaStream，或关闭自动采集。',
      '// 并发语义：attempt.active 为真时再次 connect 直接抛错，不排队不覆盖。',
      '// 每次连接生成独立 attempt，后续所有回调与定时器都挂在它上面；',
      '// attempt 一旦被 retire/替换，旧回调即使到达也会被 current() 丢弃。',
      '// [事务] 先发布 connecting 再做任何 I/O，保证订阅方看到的第一个状态正确。',
      '// [失败路径] validateConnection 与后续网络错误都收敛到 fail()。',
    ],
  },
  {
    at: 199,
    expect: 'try {',
    lines: [
      '// [并发] 每个 await 前后都要重新检查 current()：',
      '// 该函数同时校验引用相等与 active，双重条件缺一不可——',
      '// 仅比对引用可能漏掉已 retire 的同一对象，仅看 active 可能误认新一代。',
      '// 因此每个 await 之后都重新调用 current()，而不是复用进入时的布尔值。',
    ],
  },
  {
    at: 221,
    expect: 'this.reducer = new RealtimeEventReducer(this.maxEvents);',
    lines: [
      '// [事务] 新连接必须从干净归约器开始：',
      '// 旧事件、工具调用集合、工具输出集合、response 收口标记全部重置，',
      '// 否则上一轮未完成的工具调用会让新会话误判可以发起 response。',
      '// sessionLifecycle 模式下同时置空会话状态，等待 session-started 填充。',
    ],
  },
  {
    at: 229,
    expect: 'this.commands = new RealtimeCommandTracker(event => {',
    lines: [
      '// 命令跟踪器把每个带 eventId 的上行命令挂起，等 command-acknowledged 或',
      '// error 事件回来才释放；writable 闭包在发送瞬间再校验一次连接可用性。',
      '// [失败路径] session-close 是唯一允许在 closing 期间发送的命令，',
      '// 因此它不是被拒绝，而是走 sendTransport 的写权限判断。',
      '// 启动超时只在一代 attempt 内有效，就绪后由 clearTimer(startup) 撤销。',
    ],
  },
  {
    at: 242,
    expect: 'const reportedTransportErrors = attempt.reportedTransportErrors;',
    lines: [
      '// 五个传输回调是传输层与会话层之间唯一的契约：',
      '//   onEvent       解析后的服务端事件，串行 await，异常转 fail；',
      '//   onError       可恢复错误（连接未死），去重后上报应用；',
      '//   onFatalError  传输判定不可恢复，附带 drain Promise；',
      '//   onClosing     传输开始关闭：停采集、清启动定时器、置 closing/error；',
      '//   onClose       物理关闭：按是否已确认收尾决定 fail 还是 disconnect。',
      '// [并发] onEvent 内 await handleServerEvent 期间连接可能已换代，',
      '// 因此 catch 里再次判断 current() 才决定是否 fail。',
      '// [资源] reportedTransportErrors 用 WeakSet 去重同一 Error 实例。',
    ],
  },
  {
    at: 317,
    expect: 'if (api.provider != null) {',
    lines: [
      '// 四条物理链路的顺序是固定的，不能重排：',
      '// provider 自有传输 > WebRTC > 连续 PCM > 普通 WebSocket。',
      '// 原因：api 联合在运行期已被 validateConnection 收敛过，',
      '// 这里的 if/else 只是把已确定的形态落到具体实现上；',
      '// 顺序变化会让 provider 和 WebRTC 同时可用时选错实现。',
    ],
  },
  {
    at: 331,
    expect: '} else if (api.session != null) {',
    lines: [
      '// WebRTC：连接由服务端 SDP 交换完成，事件走 DataChannel。',
      '// 断线宽限交给 BrowserRealtimeWebRTC 内部计时，避免瞬时抖动直接失败。',
    ],
  },
  {
    at: 343,
    expect: '} else if (',
    lines: [
      '// 连续 PCM 中继：音频以 audio-chunk 双向流动，没有会话生命周期命令。',
      '// 这里不 await connect，就绪由 session-started/session-updated 驱动。',
    ],
  },
  {
    at: 359,
    expect: '} else {',
    lines: [
      '// 普通 WebSocket：先确保音频与播放上下文就绪，再按 token/relay 模式建连。',
      '// onOpen 时补发启动命令（session-start 或 session-update），完成协议握手。',
    ],
  },
  {
    at: 364,
    expect: 'if (api.token != null) {',
    lines: [
      '// [失败路径] token 端点是一次性换取：POST 当前 sessionConfig，',
      '// 期望返回 { token, url, tools? }；三种失败都要显式处理：',
      '//   HTTP 非 2xx 抛带状态码的错误；',
      '//   JSON 解析失败抛固定文案，避免把响应体带进日志；',
      '//   结构不合法由 validateRealtimeSetup 抛错。',
      '// [并发] fetch 与 json 解析之后都要复检 current()/closing，',
      '// 因为用户可能在这期间主动 close，迟到的 setup 不得再建连。',
      '// [事务] 服务端下发的 tools 覆盖本地配置，这是服务端对能力的最终裁定。',
    ],
  },
  {
    at: 388,
    expect: "if (url == null) throw new Error('Realtime WebSocket URL is missing');",
    lines: [
      '// token 模式必须同时拿到 url 与 token；relay 模式只看 url。',
      '// 缺少任一项都在建连前失败，避免半初始化连接泄漏。',
    ],
  },
  {
    at: 391,
    expect: 'this.ensureAudio().ensurePlaybackContext();',
    lines: [
      '// [资源] 播放上下文必须在用户手势的调用栈内创建，浏览器才允许出声；',
      '// 这一步失败由 ensureAudio 的错误回调上报，不在此处抛出。',
    ],
  },
  {
    at: 416,
    expect: '} catch (error) {',
    lines: [
      '// 统一失败出口：无论是校验、fetch 还是 connect 抛错，都走 fail()。',
      '// fail 内部再做幂等判断，因此重复进入不会重复上报。',
    ],
  },
  {
    at: 421,
    expect: 'private fail(error: unknown, drain?: Promise<void>, report = true): void {',
    lines: [
      '// fail：把一次 attempt 收敛到 error 终态。顺序很重要：',
      '//   1. 先认领 cause（首个错误生效，后续错误被忽略）；',
      '//   2. 发布 error 状态，让订阅方立即看到；',
      '//   3. 停采集；',
      '//   4. 有 drain 时等传输收尾，否则直接 disconnect；',
      '//   5. 最后上报应用错误。',
      '// [并发] 每一步之间都复检 attempt 身份与 active，',
      '// 因为 applyState/stopAudioCapture 可能触发用户回调间接引发重入。',
      '// [失败路径] drain 失败不影响 disconnect，只会以未确认收尾结束。',
      '// [事务] cause 一旦设置即代表本代终结，后续错误只用于上下文补充。',
      '// 因此第一次进入 fail 的线程赢，其余并发错误都必须被静默丢弃。',
    ],
  },
  {
    at: 435,
    expect: 'private async drainAttempt(',
    lines: [
      '// drainAttempt：等待传输层的收尾 Promise，但最多 1 秒。',
      '// [资源] 定时器兜底防止 provider 永不 resolve 导致会话卡在 closing；',
      '// finishAttempt 幂等，定时器与 drain 正常返回谁先到谁生效。',
    ],
  },
  {
    at: 449,
    expect: 'private finishAttempt(attempt: RealtimeAttempt): void {',
    lines: [
      '// 收尾唯一动作是 disconnect；disconnect 抛错也只上报，不再改状态机。',
    ],
  },
  {
    at: 458,
    expect: 'private closeFailed(attempt: RealtimeAttempt, error: unknown): void {',
    lines: [
      '// close 路径上的错误：先走 drain，再上报；已在 transportClosing 时忽略，',
      '// 避免物理关闭与主动关闭互相触发二次失败。',
    ],
  },
  {
    at: 472,
    expect: 'disconnect(): void {',
    lines: [
      '// disconnect：同步、幂等、无 await 的资源回收。',
      '// STEP-1 递增 captureGeneration，使在途的 getUserMedia 结果失效；',
      '// STEP-2 清空采集意图与外部流引用；',
      '// STEP-3 把所有传输/音频句柄暂存到局部变量并立即置空字段，',
      '//        防止 dispose 回调重入时读到旧句柄再次发送；',
      '// STEP-4 retire attempt（abort + 清定时器 + 结算 closePromise）；',
      '// STEP-5 逐个 dispose；STEP-6 若期间被新一代替换则不再发布状态。',
      '// [事务] session.finalization 未确认时降级为 unconfirmed，',
      '// 让调用方能区分「服务端确认关闭」与「本地强制断开」。',
    ],
  },
  {
    at: 512,
    expect: '/** Wait for provider cleanup or supported session-close finalization. */',
    lines: [
      '// close 有三条路径，必须按顺序判断：',
      '//   1. provider 传输在活动：走 transport.close()，配合 close 超时与 drain；',
      '//   2. 不具备 session-close 收尾能力（或未连接）：直接 disconnect；',
      '//   3. 具备 session-close：发送 session-close 命令，等 session-closed 事件',
      '//      或超时兜底后 disconnect。',
      '// [事务] beginClose 只结算一次，重复调用返回同一个 Promise；',
      '// 提前返回的分支说明 attempt 已被替换，调用方拿到的仍是旧 Promise。',
      '// [并发] 每次 await/回调后重新检查 active 与 transportClosing，',
      '// 因为关闭可能由对端先发起。',
      '// [权衡] eventId 允许外部指定，是为了让调用方把关闭与既有命令关联；',
      '// 未指定时由命令跟踪器生成。',
      '// [资源] close 超时只触发 finishAttempt 而不直接 fail，',
      '// 因为此时错误语义已由 cause 表达，重复置错会掩盖首个根因。',
      '// 超时定时器在 attempt.retire 时统一清除，不会泄漏到下一代。',
    ],
  },
  {
    at: 564,
    expect: 'private sendTransport(',
    lines: [
      '// 上行发送的唯一出口，按同一优先级选择传输：',
      '// provider > rtc > pcm > 普通 websocket。',
      '// guard 在真正写入前执行，把「发送瞬间连接已关闭」变成拒绝而非脏写。',
      '// [失败路径] provider 传输的 sendEvent 是异步的，这里额外挂 catch 上报，',
      '// 避免调用方忘记处理导致未捕获的 Promise 拒绝；',
      '// 其余传输把错误原样返回给调用方。',
    ],
  },
  {
    at: 586,
    expect: 'sendEvent(event: RealtimeClientEvent): Promise<void> {',
    lines: [
      '// 公共提交入口，先过一组守卫矩阵，再决定走命令跟踪器还是直发：',
      '//   - error/closing/非 active → 拒绝；',
      '//   - sessionLifecycle 且未 connected → 拒绝（会话未真正开始）；',
      '//   - WebRTC/连续会话下的 JSON 音频命令 → 不支持（音频走 MediaStream）；',
      '//   - session-close → 转 close()，统一收尾流程；',
      '//   - 重复 session-start → 拒绝。',
      '// 无 sessionLifecycle 且尚无会话状态时，直发并附带身份守卫，',
      '// 这是为了兼容「先发 session-update、后收 session-created」的旧协议。',
      '// [事务] 有命令跟踪器时一律经由它发送，保证 eventId 去重与 ACK 关联。',
      '// [失败路径] 跟踪器发送失败会同步抛出并自行清理 pending，',
      '// 因此这里不做补偿重试，避免同一 eventId 被重复提交。',
    ],
  },
  {
    at: 624,
    expect: 'sendTextMessage(text: string): void {',
    lines: [
      '// 文本轮次：连续会话不支持（文本上下文归应用所有，应走 context-append）。',
      '// 普通会话按「先建会话项、再请求响应」两步发送，',
      '// 随后立即在本地归约用户消息，保证 UI 不必等服务端回显。',
      '// [权衡] 本地先行是有意的乐观更新；服务端若拒绝，由错误事件纠正。',
    ],
  },
  {
    at: 638,
    expect: 'sendAudio(audio: string): void {',
    lines: [
      '// 音频与响应控制的薄封装。',
      '// sendAudio 是 fire-and-forget：内部吞掉 Promise，只把错误转上报，',
      '// 因为音频帧是高频率路径，调用方无法为每一帧等待。',
      '// commit/clear/request/cancel 直接透传为对应客户端事件。',
    ],
  },
  {
    at: 661,
    expect: 'private sendAutomaticAudio(audio: string): void {',
    lines: [
      '// 自动上行音频：仅在 connected 且未关闭时发送，并标记 automaticAudio，',
      '// 让传输层可以把它与用户显式事件区分（例如做节流或优先级）。',
      '// [并发] 发送失败时只有仍是同一 attempt 且未在关闭，才升级为 fail。',
    ],
  },
  {
    at: 684,
    expect: 'addToolOutput(callId: string, result: unknown): void {',
    lines: [
      '// 工具结果回填：先归约本地状态并发布，再向服务端创建 function-call-output。',
      '// 顺序不能反：本地先落地，UI 才能在网络往返期间展示结果。',
      '// [事务] 发布后再复检 attempt，若期间换代则不再发送，避免跨代污染。',
      '// submittedToolOutputs 记录已回填的 callId，供收口判定使用。',
      '// [失败路径] 无活动 attempt 或正在关闭时直接拒绝，不排队。',
      '// [权衡] 不做离线重放：工具结果带 callId，跨会话重放会污染上下文。',
    ],
  },
  {
    at: 708,
    expect: 'private maybeRequestToolResponse(): void {',
    lines: [
      '// 工具轮次收口判定，六个条件全部满足才发起下一轮 response：',
      '//   1. 不是 provider 自有传输（它自己管工具循环）；',
      '//   2. 状态已 connected；3. 不在关闭中；',
      '//   4. 本轮 response 已结束（responseToolCallsClosed）；',
      '//   5. 至少有一个工具调用；6. 所有 callId 都已回填输出。',
      '// [事务] 发起后立即清空三个集合，防止重复触发；',
      '// 任何一条不满足都直接返回，因此本函数可安全地在多个时机重复调用。',
      '// [权衡] 判定放在会话层而非 reducer，是因为它依赖传输形态与在途输出。',
    ],
  },
  {
    at: 726,
    expect: 'startAudioCapture(stream: MediaStream): void {',
    lines: [
      '// 开始采集有两种语义：',
      '//   legacy（无会话生命周期、非连续、非 WebRTC/provider）：同步启动，',
      '//     用 captureGeneration 记录代际，供后续停止/替换判断；',
      '//   其余：异步走 resumeAudioCapture，失败只上报不抛出。',
      '// 非 legacy 且未 connected 时拒绝，避免在握手完成前占用麦克风。',
    ],
  },
  {
    at: 752,
    expect: 'async resumeAudioCapture(): Promise<void> {',
    lines: [
      '// 恢复采集：按传输优先级委派；只有普通 WebSocket 需要在会话层',
      '// 自行 getUserMedia 并做所有权判定。',
      '// [资源] 若没有外部提供的 stream，本层申请的流由 audio 负责停止',
      '// （ownsStream 为真）；外部流只解绑不停止，避免误停应用自己的轨道。',
      '// [并发] captureGeneration 在 await 前后比对：',
      '// 若期间 stopAudioCapture 或再次 resume 发生，旧结果必须丢弃，',
      '// 且自建流要立即 stop，否则麦克风会一直亮着。',
    ],
  },
  {
    at: 791,
    expect: 'stopAudioCapture(): void {',
    lines: [
      '// 停止采集：先递增代际并清采集意图，再逐个通知传输。',
      '// [资源] 只停止本层拥有的流（sessionLifecycle 或 token 模式下的自建流），',
      '// 外部传入的流仅解绑；所有 stopCapture 的拒绝都只上报，不改变状态机。',
    ],
  },
  {
    at: 817,
    expect: 'stopPlayback(): void {',
    lines: [
      '// 播放控制与生命周期收尾：都按同一优先级选择实现。',
      '// 连续 PCM 的 stopPlayback 表现为「暂停在缓冲预算处」，',
      '// 由 maxPlaybackBufferSeconds 与 resumePlayback 配合形成背压。',
      '// dispose 等价于 disconnect，保留别名是为了符合资源释放惯例。',
    ],
  },
  {
    at: 833,
    expect: 'dispose(): void {',
    lines: [
      '// 资源释放别名：与 disconnect 同义，供调用方在 finally 中统一使用。',
    ],
  },
  {
    at: 837,
    expect: 'private ensureAudio(): BrowserRealtimeAudio {',
    lines: [
      '// 懒创建音频引擎，采样率优先级：',
      '//   sessionConfig 输入/输出格式 > options.sampleRate > 24000。',
      '// [并发] 三个回调都先比对 this.audio === audio：',
      '// 若期间已重建或断连，旧引擎的迟到回调必须丢弃，',
      '// 否则会把上一代的采集/播放状态写到当前会话。',
      '// [失败路径] onError 统一转 reportError，音频错误不直接 fail 会话。',
    ],
  },
  {
    at: 864,
    expect: 'private applyState(nextState: RealtimeState): void {',
    lines: [
      '// 状态发布：先落地 this.state，再逐字段比较后调用子类 setState。',
      '// [并发] publication 序号解决「归约是异步的」问题：',
      '// 较旧的 reduce 结果晚到时其序号已过期，update 直接跳过，',
      '// 从而保证外部观察到的状态永远来自最新一次归约。',
      '// 只推变化字段，避免 React 侧无谓重渲染。',
      '// [权衡] 逐字段回调而非整体 setState，换取更细的重渲染边界。',
    ],
  },
  {
    at: 880,
    expect: 'private async executeTool(',
    lines: [
      '// 执行一次工具调用。前置条件：非连续会话、attempt 仍活动、未关闭、无错误。',
      '// [失败路径] 没有 onToolCall 时上报错误但不中断会话；工具抛错同样只上报。',
      '// [事务] 结果返回后必须仍是同一 attempt 且状态为 connected 才回填，',
      '// 因为工具可能耗时很久，期间会话可能已关闭或重建。',
      '// 返回 undefined 视为「应用选择不回填」，不再发送 function-call-output。',
    ],
  },
  {
    at: 917,
    expect: 'private async handleServerEvent(',
    lines: [
      '// 服务端事件主处理流程：',
      '// STEP-1 身份校验，过期 attempt 直接丢弃；',
      '// STEP-2 拒绝本实现不支持的模式（provider 委派、连续会话里的 audio-delta）；',
      '// STEP-3 先把事件交给命令跟踪器做 ACK 关联，再归约；',
      '// STEP-4 归约会话级状态（transcripts/usage/finalization/muted）；',
      '// STEP-5 合并发布：状态字段来自 reducer，status 保留当前值',
      '//        （状态机由连接层驱动，不由事件改写）；',
      '// STEP-6 串行执行 effects，每个之后复检身份；',
      '// STEP-7 处理音频播放、工具收口、关闭通知、就绪转换，最后通知应用。',
      '// [并发] 每个 await 与回调处分段复检，保证长流程不会跨代写状态。',
      '// [失败路径] 归约或 effect 抛错由调用方（onEvent 包装）统一转 fail。',
    ],
  },
  {
    at: 928,
    expect: "if (this.continuous && event.type === 'audio-delta')",
    lines: [
      '// [事务] 连续会话用 audio-chunk 表达增量音频，轮次会话才用 audio-delta；',
      '// 两者混用说明 provider 能力声明与事件流不一致，直接判为错误。',
    ],
  },
  {
    at: 933,
    expect: 'const command = this.commands?.receive(event);',
    lines: [
      '// ACK 必须先于归约处理：command-acknowledged 携带的 muted 会参与',
      '// session 状态归约，顺序颠倒会读到旧值。',
      '// session 兜底：非 lifecycle 协议可能先收到事件后收到 session-started，',
      '// 此时临时创建会话状态，避免事件被丢弃。',
    ],
  },
  {
    at: 954,
    expect: 'for (const effect of result.effects) {',
    lines: [
      '// [并发] effects 必须串行执行：其中可能触发 sendEvent（截断上报），',
      '// 并行会让事件顺序与 reducer 的记录顺序不一致；',
      '// 每条 effect 后复检 current()，连接换代立即停止后续处理。',
    ],
  },
  {
    at: 958,
    expect: "if (event.type === 'audio-chunk')",
    lines: [
      '// 连续 PCM 优先交给 pcm 播放；轮次会话交给 audio。',
      '// 二选一而非叠加，避免同一段音频被播放两次。',
    ],
  },
  {
    at: 961,
    expect: "if (event.type === 'response-done' && this.toolCallsInResponse.size > 0) {",
    lines: [
      '// 本轮 response 结束且存在工具调用时，标记工具集合已封闭并尝试收口。',
      '// [事务] 标记与判定分开：response-done 可能早于工具结果回填，',
      '// 因此收口真正发生在 addToolOutput 之后的再次调用。',
    ],
  },
  {
    at: 966,
    expect: "if (event.type === 'session-closed' && session != null) {",
    lines: [
      '// 服务端确认关闭：先本地回收，再以 terminal 方式通知应用，',
      '// 保证 onEvent 看到 session-closed 时资源已经释放。',
    ],
  },
  {
    at: 971,
    expect: 'if (',
    lines: [
      '// 就绪判定随 startup 能力而变：',
      '//   session-start：必须等到 session-started；',
      '//   session-update：session-created/updated 即视为就绪。',
      '// 就绪后撤销启动超时、发布 connected；连续 PCM 此时才允许开始采集。',
    ],
  },
  {
    at: 994,
    expect: 'private handleReducerEffect(',
    lines: [
      '// 归约器产出的副作用只有四类，全部由会话层落地：',
      '//   play-audio     记录当前响应项并播放；',
      '//   speech-started 用户开始说话，可能触发对模型输出的截断；',
      '//   tool-call      登记 callId 并异步执行工具；',
      '//   error          转应用错误通道。',
      '// 新增 effect 类型时必须同步这里，否则归约会静默丢副作用。',
    ],
  },
  {
    at: 1003,
    expect: "case 'speech-started':",
    lines: [
      '// [事务] 打断：按已播放时长截断当前响应项，偏移取整后上报。',
      '// 必须在 stopPlayback 之后、且确认 attempt 仍有效才发送，',
      '// 否则会把截断命令发给已经换代的会话。',
    ],
  },
  {
    at: 1018,
    expect: "case 'tool-call':",
    lines: [
      '// 连续会话不执行工具（工具委派归应用）；普通会话先登记 callId 再执行，',
      '// 登记早于执行，保证执行期间收口判定能看到这个未完成调用。',
    ],
  },
  {
    at: 1029,
    expect: 'private async reportError(',
    lines: [
      '// 错误上报只认当前 attempt，避免旧连接的迟到错误污染新会话。',
      '// [失败路径] 应用回调自身抛错必须吞掉，清理链路不能被二次异常打断。',
    ],
  },
  {
    at: 1043,
    expect: 'private notifyEvent(',
    lines: [
      '// 事件通知：非活动 attempt 默认静默丢弃，terminal 为真时例外',
      '// （session-closed 需要送达）。同步抛错与异步拒绝都转 reportError。',
      '// [并发] 不 await 应用回调，避免慢订阅者阻塞事件处理主循环。',
    ],
  },
];

// ---- 校验阶段（全部通过才写）----
let total = 0;
for (const b of blocks) {
  const idx = b.at - 1;
  const actual = (lines[idx] ?? '').trim();
  if (actual !== b.expect) {
    console.error(`ANCHOR MISMATCH at ${b.at}: expected [${b.expect}] actual [${actual}]`);
    process.exit(1);
  }
  total += b.lines.length;
}
const LO = 306;
const HI = 325;
if (total < LO || total > HI) {
  console.error(`COUNT OUT OF RANGE: ${total} (want ${LO}..${HI})`);
  process.exit(1);
}

// ---- 按位置降序插入 ----
const sorted = [...blocks].sort((a, b) => b.at - a.at);
for (const b of sorted) {
  lines.splice(b.at - 1, 0, ...b.lines);
}

fs.writeFileSync(FILE, lines.join(eol), 'utf8');
console.log('ADDED', total);
