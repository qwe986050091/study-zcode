// B18 insert: realtime WebRTC / WebSocket transport / event channel
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/realtime/';
const files = [
  {
    name: 'browser-realtime-webrtc.ts',
    want: [167, 177],
    blocks: [
      {
        at: 1,
        expect: "import { safeParseJSON } from '@ai-sdk/provider-utils';",
        lines: [
          '// ============================================================================',
          '// BrowserRealtimeWebRTC：浏览器侧 WebRTC 传输实现',
          '// ----------------------------------------------------------------------------',
          '// 职责：用 RTCPeerConnection 建立音频通道，用 DataChannel 承载实时事件流。',
          '// 链路位置：AbstractRealtimeSession.connect 的 api.session 分支在此落地；',
          '// 事件编解码复用 RealtimeEventChannel，模型提供 SDP 与 DataChannel 标签。',
          '// 与 WebSocket 传输的最大差异：媒体走 SRTP，事件走 SCTP，两条通道各自关闭，',
          '// 因此本文件必须自己维护「媒体关闭」与「事件关闭」两个独立状态。',
          '// [资源] 这里的每个句柄（pc / dc / audio / track / timer）都要在 dispose 清空。',
          '// ============================================================================',
        ],
      },
      {
        at: 10,
        expect: 'const MAX_SESSION_ANSWER_BYTES = 1024 * 1024;',
        lines: [
          '// [资源] SDP answer 上限 1 MiB：既防超大响应打爆内存，',
          '// 也防服务端被恶意构造的长连接拖住；content-length 与实际字节数双检。',
        ],
      },
      {
        at: 12,
        expect: 'async function readSessionAnswer(response: Response): Promise<string> {',
        lines: [
          '// 流式读取 SDP answer，边读边计数，超限即中止。',
          '// [资源] 失败路径必须 cancel reader，finally 里 releaseLock，',
          '// 否则 fetch 的响应体会一直占用底层连接。',
        ],
      },
      {
        at: 39,
        expect: 'function selectAudioTrack(stream: MediaStream): MediaStreamTrack | undefined {',
        lines: [
          '// 选择可用音轨：先过滤 readyState 为 live 的轨道，',
          '// 再优先取已启用且未被静音的；都不可用时退回第一条 live 轨道。',
        ],
      },
      {
        at: 46,
        expect: 'export class BrowserRealtimeWebRTC {',
        lines: [
          '// ---------------------------------------------------------------------------',
          '// 不变量',
          '//   INV-01 generation 是连接代际；任何异步回调都要先比对它。',
          '//   INV-02 captureGeneration 是采集代际，与连接代际独立。',
          '//   INV-03 finishing 只能从 undefined 迁移一次（close 或 failure）。',
          '//   INV-04 onClosing 只通知一次（closingNotified）。',
          '//   INV-05 sender 操作串行化，禁止并发 replaceTrack。',
          '//   INV-06 只有 ownsStream 为真时才停止轨道。',
          '//   INV-07 启动被取消时必须停止自建流，外部流不动。',
          '// ---------------------------------------------------------------------------',
        ],
      },
      {
        at: 65,
        expect: 'constructor(',
        lines: [
          '// 依赖注入：模型负责协议映射，会话层提供五个回调，',
          '// disconnectTimeoutMs 是 WebRTC 断线宽限（默认由会话层给 5s）。',
        ],
      },
      {
        at: 79,
        expect: 'async connect({',
        lines: [
          '// STEP-1 递增代际并清理上一代（dispose 会 abort、关 pc、停轨道）；',
          '// STEP-2 取 DataChannel 标签，缺配置直接失败；',
          '// STEP-3 建 AbortController 与启动超时，用竞速 Promise 统一取消；',
          '// STEP-4 取流、建 PeerConnection、绑定 audio 与 DataChannel；',
          '// STEP-5 发 offer、等 ICE 收集、POST SDP、setRemoteDescription；',
          '// STEP-6 等 DataChannel open 才算握手完成。',
        ],
      },
      {
        at: 93,
        expect: 'const generation = this.generation + 1;',
        lines: [
          '// [并发] 先取新代际再 dispose：dispose 会把 generation 再加一，',
          '// 两者相减后本代立即过期，任何旧回调都会在 current() 处被丢弃。',
        ],
      },
      {
        at: 97,
        expect: 'const config = this.options.model.getWebRTCConfig?.();',
        lines: [
          '// 能力缺省视为不支持 WebRTC：宁可显式报错，也不猜一个 DataChannel 标签。',
        ],
      },
      {
        at: 101,
        expect: 'const abort = new AbortController();',
        lines: [
          '// [资源] 启动超时与主动取消共用一个 AbortSignal：',
          '// fetch、ICE 等待、DataChannel 等待都可以被同一次 abort 打断。',
        ],
      },
      {
        at: 107,
        expect: 'const cancelled = new Promise<never>((_, reject) => {',
        lines: [
          '// 把 abort 事件转成永远 reject 的 Promise，供 Promise.race 使用；',
          '// [资源] once 保证监听器只触发一次，不会随代际累积泄漏。',
        ],
      },
      {
        at: 114,
        expect: 'const start = async () => {',
        lines: [
          '// start 内所有 await 之后都要复检 current() 与 aborted，',
          '// 因为 dispose 可能发生在任意一步之间。',
        ],
      },
      {
        at: 116,
        expect: 'let media = capture',
        lines: [
          '// capture 为 false 时完全不申请麦克风，只建接收方向；',
          '// [资源] 无论走哪条路，自建流失败或取消都必须逐条 stop。',
        ],
      },
      {
        at: 134,
        expect: 'const pc = new RTCPeerConnection();',
        lines: [
          '// PeerConnection 与隐藏 audio 元素成对创建：',
          '// ontrack 到达后把远端流挂到 audio.srcObject，播放状态回传给会话层。',
        ],
      },
      {
        at: 148,
        expect: 'pc.ontrack = event => {',
        lines: [
          '// [失败路径] play() 可能因自动播放策略被拒；',
          '// 这里只上报 onError，不 fail 整条连接，因为用户手势后仍可恢复。',
        ],
      },
      {
        at: 155,
        expect: 'pc.onconnectionstatechange = () => {',
        lines: [
          '// 连接状态机：connected 清断线计时；disconnected 起宽限计时；',
          '// closed 走正常收尾；failed 立即失败。',
          '// [权衡] disconnected 不立刻失败，是给蜂窝/WiFi 切换留恢复窗口。',
        ],
      },
      {
        at: 177,
        expect: 'pc.oniceconnectionstatechange = () => {',
        lines: [
          '// ICE failed 与 connectionState failed 可能先后到达，',
          '// fail 内部幂等，因此重复触发不会重复清理。',
        ],
      },
      {
        at: 181,
        expect: 'const dc = pc.createDataChannel(config.dataChannelLabel);',
        lines: [
          '// DataChannel 是事件通道，编码交给 RealtimeEventChannel；',
          '// send 回调里做三重校验：代际、finishing、readyState。',
          '// [资源] bufferedAmount 超过 1 MiB 视为背压失败，避免内存无界增长。',
        ],
      },
      {
        at: 207,
        expect: 'dc.onmessage = event => {',
        lines: [
          '// DataChannel 回调统一先比对 current()，再交给 codec 解析；',
          '// onclose 走 drainClose（正常收尾），onerror 直接 fail。',
        ],
      },
      {
        at: 217,
        expect: 'const opened = new Promise<void>((resolve, reject) => {',
        lines: [
          '// [资源] opened 的 reject 被暂存到 rejectStartup，',
          '// 使 fail 能在启动阶段直接把错误注入等待方，而不是静默超时。',
        ],
      },
      {
        at: 225,
        expect: 'const gathered = new Promise<void>(resolve => {',
        lines: [
          '// 等 ICE 收集完成再发 SDP，避免 trickle 场景下 offer 不完整；',
          '// 与 cancelled 竞速，超时/取消时不再等待。',
        ],
      },
      {
        at: 230,
        expect: 'this.sender =',
        lines: [
          '// 有音轨时 addTrack，无音轨时建 sendrecv transceiver 占位；',
          '// 两种路径都要拿到 sender，供后续 replaceTrack 切换采集源。',
        ],
      },
      {
        at: 236,
        expect: 'const offer = await pc.createOffer();',
        lines: [
          '// 发 offer → setLocalDescription → 等 ICE → POST 换取 answer。',
          '// 每步之间复检代际，任何一步被 dispose 都直接返回，不再发请求。',
        ],
      },
      {
        at: 244,
        expect: 'const response = await fetch(api, {',
        lines: [
          '// [失败路径] 非 2xx 抛带状态码错误；响应体必须走 readSessionAnswer 限流读取。',
        ],
      },
      {
        at: 254,
        expect: 'const parsed = await safeParseJSON({',
        lines: [
          '// 结构校验逐字段进行：sdp 与 sessionId 都必须是非空字符串；',
          '// 任何缺失都视为协议错误，不尝试猜测或修补。',
        ],
      },
      {
        at: 271,
        expect: 'await pc.setRemoteDescription({ type: \'answer\', sdp: parsed.value.sdp });',
        lines: [
          '// setRemoteDescription 之后仍要等 DataChannel open，',
          '// 因为 SDP 完成不代表事件通道可用；两者都完成才算连接成功。',
        ],
      },
      {
        at: 274,
        expect: 'try {',
        lines: [
          '// 整个启动过程与 cancelled 竞速；失败时若仍是本代则 dispose 再抛，',
          '// [资源] finally 一定清启动定时器与 rejectStartup，避免悬挂。',
        ],
      },
      {
        at: 285,
        expect: 'sendEvent(',
        lines: [
          '// 上行入口：DataChannel 未 open 或正在收尾时同步抛错；',
          '// shouldSend 透传给 codec，让调用方在序列化前后各拒绝一次。',
        ],
      },
      {
        at: 294,
        expect: 'async resumePlayback(): Promise<void> {',
        lines: [
          '// 播放控制直接操作 audio 元素：resume 需要在用户手势内调用，',
          '// stop 只是 pause，保留缓冲区以便继续。',
        ],
      },
      {
        at: 304,
        expect: 'finish(): Promise<void> {',
        lines: [
          '// finish 只排空事件通道，不关 PeerConnection；',
          '// 物理关闭由后续 dispose 完成，两者分离便于「先等终态、再断资源」。',
        ],
      },
      {
        at: 308,
        expect: 'private fail(error: Error): void {',
        lines: [
          '// [事务] failure 只能进入一次；启动阶段的错误先注入 rejectStartup，',
          '// 让 connect 的 await 直接抛出，不再走 onFatalError 分支。',
          '// [并发] 已有 drain 时先通知 onFatalError 交给会话层统一收尾，',
          '// 否则本地跑 1 秒兜底定时器 + awaitDrain，避免 provider 永不结算。',
        ],
      },
      {
        at: 345,
        expect: 'private drainClose(error: Error): void {',
        lines: [
          '// 对端正常关闭：停止写、等 codec 排空、再回调 onClose；',
          '// [资源] 1 秒定时器与 awaitDrain 竞速，先到者生效，after 清理 generation。',
        ],
      },
      {
        at: 371,
        expect: 'private notifyClosing(): void {',
        lines: [
          '// onClosing 去重：媒体关闭与事件关闭可能各触发一次，',
          '// 会话层只应看到一次「开始关闭」。',
        ],
      },
      {
        at: 381,
        expect: 'private async stopCaptureForShutdown(generation: number): Promise<void> {',
        lines: [
          '// 收尾阶段停采集；若停采集本身抛错且仍在同一代，升级为 fail。',
          '// [失败路径] fail 也可能抛（回调），这里再吞一层，保证清理不中断。',
        ],
      },
      {
        at: 394,
        expect: 'private async awaitDrain(',
        lines: [
          '// 等待排空的公共封装：drain 的拒绝只表示传输已断，仍需 complete；',
          '// complete 内部的回调异常统一转 reportCallbackError。',
        ],
      },
      {
        at: 410,
        expect: 'private reportCallbackError(error: unknown): void {',
        lines: [
          '// [失败路径] 应用回调自身抛错不得打断 teardown，因此这里无条件吞掉。',
        ],
      },
      {
        at: 420,
        expect: 'async stopCapture(): Promise<void> {',
        lines: [
          '// [并发] 先递增采集代际，使在途 startCapture 的结果失效；',
          '// 清事件监听 → 仅停自有轨道 → 在串行队列里解绑 sender。',
          '// [事务] 解绑完成后才回调 onCapturing(false)，且要求代际未变。',
        ],
      },
      {
        at: 437,
        expect: 'async startCapture(supplied?: MediaStream): Promise<void> {',
        lines: [
          '// 切采集源 = 先停旧源，再取新流，再在串行队列里 replaceTrack。',
          '// [资源] 自建流在任一失败分支都要 stop；外部流只解绑不停止。',
          '// [并发] 队列内 current() 同时校验采集代际、pc/sender 身份与连接状态。',
        ],
      },
      {
        at: 489,
        expect: 'private queueSenderOperation(operation: () => Promise<void>): Promise<void> {',
        lines: [
          '// [并发] sender 操作必须串行：replaceTrack 并发会让轨道归属错乱；',
          '// 队列自身吞掉拒绝，但不影响返回给调用方的 Promise。',
        ],
      },
      {
        at: 495,
        expect: 'private async detachSender(',
        lines: [
          '// [失败路径] 解绑失败可能意味着旧音轨仍在发送，属于隐私风险；',
          '// 因此先关 PeerConnection 再 fail，优先保证不再传输。',
        ],
      },
      {
        at: 510,
        expect: 'private closePeer(pc: RTCPeerConnection): void {',
        lines: [
          '// 关 pc 前先摘掉四个回调，避免 close 事件再次进入状态机。',
        ],
      },
      {
        at: 518,
        expect: 'private observeCapture(): void {',
        lines: [
          '// 监听轨道的 ended/mute/unmute，把真实采集状态推给上层；',
          '// [资源] 监听器登记到 trackCleanups，切换轨道或 dispose 时统一移除。',
        ],
      },
      {
        at: 540,
        expect: 'dispose(): void {',
        lines: [
          '// [资源] 释放顺序：先让代际失效 → 清定时器 → abort → 关 codec →',
          '// 摘 dc/pc 回调并关闭 → 移除轨道监听 → 停自有流 → 清 audio → 复位状态。',
          '// 先递增代际再释放，保证释放过程中触发的回调不会重新进入。',
        ],
      },
      {
        at: 31,
        expect: '} catch (error) {',
        lines: [
          '// [资源] 读取中断时先把错误传给 cancel，让底层流知道取消原因；',
          '// cancel 自身失败不再覆盖原始错误。',
        ],
      },
      {
        at: 43,
        expect: 'return live.find(track => track.enabled && !track.muted) ?? live[0];',
        lines: [
          '// 优先可用轨，退而求其次取任意 live 轨：静音仍可发送静音帧，',
          '// 但没有 live 轨道就无法建立发送方向。',
        ],
      },
      {
        at: 94,
        expect: 'this.dispose();',
        lines: [
          '// [资源] 重建前彻底释放上一代：abort 进行中的 fetch、关 pc、停自建流。',
          '// 若不 dispose 直接覆盖字段，旧 pc 会一直保持连接直到页面卸载。',
        ],
      },
      {
        at: 120,
        expect: 'if (!current() || abort.signal.aborted) {',
        lines: [
          '// [资源] 只有自建流才 stop；外部传入的流由调用方负责生命周期。',
        ],
      },
      {
        at: 128,
        expect: 'this.stream = media;',
        lines: [
          '// ownsStream 是所有权标记，决定 stopCapture/dispose 是否停止轨道；',
          '// 这一行与 stream 赋值必须成对出现，否则会出现停错或漏停。',
        ],
      },
      {
        at: 142,
        expect: 'const stopped = () => {',
        lines: [
          '// 播放停止的三个来源（pause/ended/waiting）统一收敛为 isPlaying=false。',
        ],
      },
      {
        at: 158,
        expect: 'clearTimeout(this.disconnectTimer);',
        lines: [
          '// [资源] 每次状态变化都先清旧计时器，避免多个宽限计时器叠加。',
        ],
      },
      {
        at: 169,
        expect: "} else if (pc.connectionState === 'closed') {",
        lines: [
          '// closed 是对端已关闭，走 drainClose 正常收尾而不是 fail。',
        ],
      },
      {
        at: 193,
        expect: 'if (dc.bufferedAmount > 1024 * 1024)',
        lines: [
          '// [资源] 缓冲上限是硬背压信号：继续写只会让延迟无限增长。',
        ],
      },
      {
        at: 202,
        expect: 'if (!current()) {',
        lines: [
          '// [资源] codec 创建后连接可能已换代，此处必须显式 dispose 再返回。',
        ],
      },
      {
        at: 219,
        expect: 'dc.onopen = () => {',
        lines: [
          '// open 后清掉 rejectStartup，后续错误改走 fail 的常规分支。',
        ],
      },
      {
        at: 235,
        expect: 'if (!current() || abort.signal.aborted) return;',
        lines: [
          '// [并发] 建 offer 前后各校验一次，避免在已取消的连接上继续协商。',
        ],
      },
      {
        at: 239,
        expect: "if (pc.iceGatheringState !== 'complete')",
        lines: [
          '// 若 ICE 已收集完成则无需等待；否则与 cancelled 竞速，二者都不会悬挂。',
        ],
      },
      {
        at: 257,
        expect: 'if (!current() || abort.signal.aborted) return;',
        lines: [
          '// [并发] 响应读取是长耗时操作，返回时连接可能已被用户关闭。',
        ],
      },
      {
        at: 272,
        expect: 'await Promise.race([opened, cancelled]);',
        lines: [
          '// 最后一道门：SDP 完成不等于事件通道可用，必须等 DataChannel open。',
          '// rejectStartup 让 fail 能在此处注入错误，而不是干等启动超时。',
        ],
      },
      {
        at: 289,
        expect: "if (this.finishing || this.dc?.readyState !== 'open')",
        lines: [
          '// 同步抛错而非返回 rejected Promise：调用方可在发送前用 try 捕获。',
        ],
      },
      {
        at: 312,
        expect: 'if (this.rejectStartup != null) {',
        lines: [
          '// [事务] 启动期失败走 reject 通道：让 connect 的 await 直接抛出，',
          '// 不再触发 onFatalError，避免同一错误被两条路径各处理一次。',
        ],
      },
      {
        at: 327,
        expect: 'const complete = () => {',
        lines: [
          '// [资源] 兜底完成：dispose 后回调 onClose；回调异常只上报。',
        ],
      },
      {
        at: 352,
        expect: 'const generation = this.generation;',
        lines: [
          '// [并发] 记录代际，complete 与定时器都以它为门槛，防止旧代收尾新代。',
        ],
      },
      {
        at: 384,
        expect: '} catch (cause) {',
        lines: [
          '// 停采集失败只有在仍在同一代且仍是 close 语义时才升级为 fail。',
        ],
      },
      {
        at: 421,
        expect: 'const generation = ++this.captureGeneration;',
        lines: [
          '// [并发] 递增放在最前：清监听与停轨道期间到达的采集回调立即失效。',
        ],
      },
      {
        at: 446,
        expect: 'const media =',
        lines: [
          '// [资源] 这里申请的新流在后续每个失败分支都要逐条 stop。',
        ],
      },
      {
        at: 461,
        expect: 'const pc = this.pc;',
        lines: [
          '// 捕获 pc/sender 快照，队列执行时用它们与当前字段比对，',
          '// 任何一项变化都说明连接或发送端已被替换，本次操作应放弃。',
        ],
      },
      {
        at: 500,
        expect: 'try {',
        lines: [
          '// [失败路径] replaceTrack(null) 被拒说明旧音轨可能仍在发送，',
          '// 因此先关 pc 切断传输，再 fail 让上层重建。',
        ],
      },
      {
        at: 531,
        expect: 'if (track != null) {',
        lines: [
          '// [资源] 监听器与 trackCleanups 一一对应，切换轨道时必须先清空。',
        ],
      },
      {
        at: 552,
        expect: 'if (this.dc != null) {',
        lines: [
          '// 关 dc 前先摘回调，避免 close 事件再次进入 drainClose。',
        ],
      },
      {
        at: 103,
        expect: 'const timeout = setTimeout(',
        lines: [
          '// [资源] 启动超时不是 reject 一个 Promise，而是 abort 整个控制器，',
          '// 这样 fetch、ICE 等待、DataChannel 等待会同时结束，',
          '// 不需要为每一步单独写超时逻辑。',
          '// abort 的 reason 会被 cancelled 原样抛出，保留可读的错误信息。',
          '// finally 中清定时器，避免成功路径留下悬挂计时器。',
          '// [权衡] 超时值由会话层传入而不是本类默认，便于统一配置。',
        ],
      },
      {
        at: 233,
        expect: ": pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;",
        lines: [
          '// 无音轨但仍需接收时，用 sendrecv transceiver 占位，',
          '// 保证 SDP 里音频 m-line 的方向与后续 replaceTrack 兼容。',
          '// [资源] 这条 sender 与 addTrack 得到的 sender 在后续处理上完全等价，',
          '// 因此 stopCapture/startCapture 不需要区分两种来源。',
          '// 若之后要开始采集，直接 replaceTrack 即可，无需重建协商。',
        ],
      },
      {
        at: 259,
        expect: '!parsed.success ||',
        lines: [
          '// [失败路径] 逐字段校验而不是整体断言：',
          '// 空字符串、非对象、缺字段都归为同一个协议错误，',
          '// 避免把服务端返回的原始内容拼进错误信息。',
          '// 校验通过后才 setRemoteDescription，防止用非法 SDP 污染 pc 状态。',
          '// 这里的严格性与 readSessionAnswer 的限流共同构成外部输入边界。',
        ],
      },
      {
        at: 318,
        expect: 'const drain = this.finish();',
        lines: [
          '// [事务] 失败时先排空已受理事件，再通知 closing：',
          '// 顺序颠倒会让最后几个下行事件丢失。',
          '// drain 与本地兜底定时器竞速，保证 provider 不结算时也能收尾。',
          '// onError 放在最后，确保错误上报不会先于清理逻辑。',
          '// [权衡] 有 onFatalError 时把 drain 交给会话层，避免双重收尾。',
        ],
      },
      {
        at: 491,
        expect: 'this.senderOperations = pending.catch(() => {});',
        lines: [
          '// [并发] 队列尾部吞掉拒绝，只是为了防止链断裂；',
          '// 原始 Promise 仍然返回给调用方，错误不会被隐藏。',
          '// dispose 时把队列重置为已解决，丢弃上一代未完成的操作。',
          '// 这样即使旧操作晚到，也不会作用到新 pc/sender 上。',
          '// 队列与 captureGeneration 是两层保护，缺一不可。',
        ],
      },
    ],
  },
  {
    name: 'browser-realtime-transport.ts',
    want: [81, 86],
    blocks: [
      {
        at: 1,
        expect: "import { RealtimeEventChannel } from './realtime-event-channel';",
        lines: [
          '// ============================================================================',
          '// BrowserRealtimeTransport：浏览器侧 WebSocket 传输',
          '// ----------------------------------------------------------------------------',
          '// 职责：维护一条 WebSocket，把上行事件交给 RealtimeEventChannel 序列化，',
          '// 把下行原始消息交给同一 channel 解析，并把关闭语义转成会话层回调。',
          '// 链路位置：AbstractRealtimeSession 的普通 WebSocket 分支使用本类；',
          '// 连续 PCM 中继（BrowserRealtimeLiveWebSocket）内部也复用它。',
          '// [资源] epoch 是本类的代际号：每建连/断开都递增，旧 socket 的回调全部作废。',
          '// ============================================================================',
        ],
      },
      {
        at: 12,
        expect: 'export type BrowserRealtimeTransportOptions = {',
        lines: [
          '// 与 WebRTC 传输保持同一组回调契约，方便会话层无差别替换传输实现。',
        ],
      },
      {
        at: 21,
        expect: 'function getCloseError(event: CloseEvent): Error | undefined {',
        lines: [
          '// 只有 code 1000 且 wasClean 才算正常关闭；其余都构造带 code/reason 的错误。',
        ],
      },
      {
        at: 30,
        expect: 'export class BrowserRealtimeTransport {',
        lines: [
          '// ---------------------------------------------------------------------------',
          '// 不变量',
          '//   INV-01 epoch 单调递增，回调必须同时校验 epoch 与 socket 身份。',
          '//   INV-02 socket 在 new 之后立即登记，不能等 onopen。',
          '//   INV-03 onClosing 只通知一次（closing 标志）。',
          '//   INV-04 fail 只进入一次（failing 标志）。',
          '//   INV-05 关闭时先 stopWriting，再排空已接收事件。',
          '//   INV-06 发送前必须校验 isOpen，不能在已关闭的 socket 上写。',
          '// ---------------------------------------------------------------------------',
        ],
      },
      {
        at: 43,
        expect: 'constructor(private readonly options: BrowserRealtimeTransportOptions) {',
        lines: [
          '// continuous 决定是否对帧做预算校验（连续 PCM 有音频速率约束）。',
        ],
      },
      {
        at: 51,
        expect: 'get isOpen(): boolean {',
        lines: [
          '// 三个条件同时成立才算可写：未在关闭、未失败、底层 readyState 为 OPEN。',
        ],
      },
      {
        at: 57,
        expect: 'connect({',
        lines: [
          '// connect 是同步的：只负责建 socket 与挂回调，就绪由 onOpen 通知。',
          '// 两条模式：client-secret（浏览器拿短期 token 直连）与 relay（应用自建中继）。',
        ],
      },
      {
        at: 70,
        expect: 'this.disconnect();',
        lines: [
          '// 重连前先断开旧 socket；[并发] 随后记录 epoch，',
          '// 任何在 disconnect 之后到达的迟到回调都会因 epoch 不符被丢弃。',
        ],
      },
      {
        at: 82,
        expect: 'const wsConfig =',
        lines: [
          '// 模型负责把 token 与 url 改写成最终连接参数（如放进子协议）；',
          '// 返回空表示该 provider 不支持 client-secret 直连。',
        ],
      },
      {
        at: 92,
        expect: 'try {',
        lines: [
          '// [失败路径] URL 必须是绝对 ws/wss、带 host、不含 fragment；',
          '// 校验统一包成一条可读错误，避免把 URL 解析细节暴露给调用方。',
        ],
      },
      {
        at: 108,
        expect: 'const ws = new WebSocket(finalUrl, finalProtocols);',
        lines: [
          '// [并发] socket 在 new 之后立即登记（而不是等 onopen）：',
          '// 否则连接中的 socket 无法被 disconnect 关闭，可能在断连后触发 onOpen。',
        ],
      },
      {
        at: 117,
        expect: 'const codec = new RealtimeEventChannel({',
        lines: [
          '// codec 的 send 回调绑定当前 socket 与 epoch，写前再校验一次；',
          '// onError 在启动阶段（starting）被抑制，由 onOpen 的失败分支统一处理。',
        ],
      },
      {
        at: 136,
        expect: 'ws.onopen = () => {',
        lines: [
          '// onOpen 可能返回 Promise（例如先发 session-update）；',
          '// starting 标记期间的可恢复错误延后到 onOpen 完成后再上报。',
        ],
      },
      {
        at: 157,
        expect: 'ws.onmessage = messageEvent => {',
        lines: [
          '// 只接收当前 socket 的消息，其余（旧 socket 迟到帧）静默丢弃。',
        ],
      },
      {
        at: 161,
        expect: 'ws.onerror = () => {',
        lines: [
          '// onerror 不直接上报：浏览器不提供细节，先记下错误并置 failing，',
          '// 等 onclose 时结合关闭码决定是正常结束还是异常。',
        ],
      },
      {
        at: 168,
        expect: 'ws.onclose = event => {',
        lines: [
          '// [事务] 关闭流程：摘 socket → 计算 closeError → 停止写 → 通知 closing',
          '// → 排空 codec → 立刻上报（若已无待处理下行）→ 1 秒兜底 → onClose。',
          '// [权衡] 有待处理下行时先不报错，避免错误信号抢在最后几个事件之前。',
        ],
      },
      {
        at: 203,
        expect: 'disconnect(): void {',
        lines: [
          '// [资源] 先递增 epoch 使所有在途回调失效，再清定时器、清 codec、',
          '// 最后 close socket；顺序颠倒会让 close 事件重新进入状态机。',
        ],
      },
      {
        at: 215,
        expect: 'sendEvent(',
        lines: [
          '// 上行入口：failing/closing 时同步抛错；codec 未就绪时静默成功。',
          '// [失败路径] 自动音频失败要升级为 fail（音频丢帧意味着协议连续性已断），',
          '// 手动发送只把拒绝返回给调用方。',
        ],
      },
      {
        at: 238,
        expect: 'finish(): Promise<void> {',
        lines: [
          '// 只排空事件通道；不断开 socket，由 disconnect 负责物理关闭。',
        ],
      },
      {
        at: 243,
        expect: 'fail(error: Error): void {',
        lines: [
          '// [事务] 失败收尾：置 failing → 摘 socket → stopWriting → close →',
          '// 通知 closing → 有 onFatalError 就交给它，否则本地排空后自行收尾。',
          '// [资源] 1 秒兜底定时器防止 codec.finish 永不结算。',
        ],
      },
      {
        at: 272,
        expect: 'private notifyClosing(): void {',
        lines: [
          '// onClosing 去重，保证会话层只处理一次「开始关闭」。',
        ],
      },
      {
        at: 282,
        expect: 'private async awaitDrain(',
        lines: [
          '// 排空等待：drain 失败仍要 complete，complete 异常再兜底上报。',
        ],
      },
      {
        at: 298,
        expect: 'private reportCallbackError(error: unknown): void {',
        lines: [
          '// [失败路径] 应用回调异常不得中断 teardown，直接吞掉。',
        ],
      },
      {
        at: 306,
        expect: 'sendRaw(data: unknown): void {',
        lines: [
          '// 原始帧发送：编码后再次校验 epoch/socket/isOpen，防止编码期间断连；',
          '// [资源] 连续 PCM 额外做帧预算校验，超预算即拒绝，避免缓冲膨胀。',
        ],
      },
      {
        at: 317,
        expect: 'dispose(): void {',
        lines: [
          '// 资源释放别名，语义与 disconnect 相同。',
        ],
      },
      {
        at: 45,
        expect: "this.continuous = options.model.capabilities?.conversation === 'continuous';",
        lines: [
          '// [权衡] continuous 只在构造时求值一次：能力声明属于模型静态属性，',
          '// 运行期不会变化；缓存成字段可避免每个音频帧都做可选链判断。',
          '// 它唯一的作用是决定 sendRaw 是否执行帧预算校验。',
          '// 若未来出现可热切换会话类型的 provider，这里需要改成动态读取。',
        ],
      },
      {
        at: 73,
        expect: 'if (',
        lines: [
          '// [失败路径] client-secret 模式必须提供非空 token，',
          '// relay 模式反而禁止 token（联合类型已约束，这里做运行期兜底）。',
          '// 空字符串与纯空白都视为缺失，避免把无效凭证发给模型改写。',
          '// 校验在建 socket 之前完成，失败不会产生任何网络副作用。',
        ],
      },
      {
        at: 95,
        expect: 'const parsed = new URL(finalUrl);',
        lines: [
          '// 用 URL 解析做二次校验：协议、hostname、fragment 三项都要查；',
          '// 只看正则可能放过 wss:// 加空 host 之类的畸形串。',
        ],
      },
      {
        at: 141,
        expect: 'void Promise.resolve(onOpen())',
        lines: [
          '// [失败路径] onOpen 同步抛错与异步拒绝统一走 fail；',
          '// finally 复位 starting，保证后续可恢复错误能正常上报。',
        ],
      },
      {
        at: 172,
        expect: 'const reportCloseErrorImmediately =',
        lines: [
          '// [事务] 若还有待处理下行，则推迟错误上报，',
          '// 让最后一批事件先完成交付，避免错误信号打断终态事件。',
        ],
      },
      {
        at: 249,
        expect: 'this.codec?.stopWriting();',
        lines: [
          '// 先停止写方向：失败后不再接受上行，但已接收的下行继续排空。',
        ],
      },
      {
        at: 186,
        expect: 'const complete = () => {',
        lines: [
          '// [资源] 完成回调同时承担三件事：',
          '//   1. 再次校验 epoch，避免旧 socket 的关闭事件收尾新连接；',
          '//   2. 递增 epoch 并 dispose codec，使迟到帧失效；',
          '//   3. 回调 onClose，把关闭原因交给会话层。',
          '// 定时器与 awaitDrain 谁先到谁执行，complete 本身不再做幂等保护，',
          '// 因此 epoch 校验是唯一的重复进入屏障。',
        ],
      },
      {
        at: 220,
        expect: 'if (this.failing || this.closing)',
        lines: [
          '// [事务] 关闭中与失败中都不接受上行，直接抛错让调用方感知；',
          '// 成功路径返回的 Promise 与写入顺序一致。',
        ],
      },
      {
        at: 254,
        expect: 'if (this.options.onFatalError != null)',
        lines: [
          '// 有 onFatalError 时把 drain 交出去，由会话层决定何时断资源；',
          '// 否则本地兜底并自行 disconnect。',
        ],
      },
    ],
  },
  {
    name: 'realtime-event-channel.ts',
    want: [46, 48],
    blocks: [
      {
        at: 1,
        expect: "import { safeParseJSON } from '@ai-sdk/provider-utils';",
        lines: [
          '// ============================================================================',
          '// RealtimeEventChannel：每条连接独占的事件编解码队列',
          '// ----------------------------------------------------------------------------',
          '// 职责：下行把原始帧解析成归一化事件并串行交付；上行把客户端事件序列化后',
          '// 交给传输层写入。所有解析/交付/发送都按到达顺序串行。',
          '// 链路位置：WebRTC 的 DataChannel 与 WebSocket 传输都各自 new 一个实例；',
          '// 连接被替换时旧实例 dispose，从而保证旧连接无法再投递迟到事件。',
          '// [并发] incoming/outgoing 两条 Promise 链是唯一的排序保证。',
          '// ============================================================================',
        ],
      },
      {
        at: 9,
        expect: 'export class RealtimeEventChannel {',
        lines: [
          '// ---------------------------------------------------------------------------',
          '// 不变量',
          '//   INV-01 active 为假后不再解析、不再交付、不再发送。',
          '//   INV-02 finishing 表示停止写入，但已接收的下行仍要交付完。',
          '//   INV-03 下行按到达顺序串行处理，不允许并发 onEvent。',
          '//   INV-04 上行按调用顺序串行序列化，计数与字节数同步回收。',
          '//   INV-05 队列超限是致命错误，必须停止写入以保住协议连续性。',
          '// ---------------------------------------------------------------------------',
        ],
      },
      {
        at: 21,
        expect: 'constructor(',
        lines: [
          '// 解析器优先用 createServerEventParser（每连接隔离状态），',
          '// 否则退回共享的 parseServerEvent；二者签名一致。',
        ],
      },
      {
        at: 37,
        expect: 'get hasPendingIncoming(): boolean {',
        lines: [
          '// 传输层用它判断关闭时是否还有下行在途，从而决定错误上报时机。',
        ],
      },
      {
        at: 41,
        expect: 'dispose(): void {',
        lines: [
          '// 只置 active=false；不做异步等待，调用方负责在需要时先 finish。',
        ],
      },
      {
        at: 46,
        expect: 'async finish(): Promise<void> {',
        lines: [
          '// [事务] 先停止写入，再等待已接收的下行处理完，最后 dispose；',
          '// 顺序保证终止事件（如 session-closed）不会因为关闭而被截断。',
        ],
      },
      {
        at: 52,
        expect: 'stopWriting(): void {',
        lines: [
          '// 只关闭写方向，读方向继续，直到 finish 完成排空。',
        ],
      },
      {
        at: 56,
        expect: 'send(event: RealtimeClientEvent, shouldSend?: () => boolean): Promise<void> {',
        lines: [
          '// [并发] 发送进入 outgoing 串行链；计数在入队时增加、在 finally 减少，',
          '// 因此上限约束的是「已受理但未完成」的数量，而不是瞬时并发。',
          '// shouldSend 在两个时机各调一次：序列化前与真正写入前。',
        ],
      },
      {
        at: 77,
        expect: 'this.outgoing = operation',
        lines: [
          '// [失败路径] 失败只上报，不打断后续队列；自动音频与 session-close',
          '// 的失败交给拥有者升级（它们有自己的重试/收尾语义），避免重复报错。',
        ],
      },
      {
        at: 94,
        expect: 'receive(data: unknown): void {',
        lines: [
          '// 下行入口：先估字节数并做双重限额（条数 + 字节），再入队。',
          '// [资源] 超限立即置 finishing 并报致命错误，防止内存被慢消费者拖爆。',
        ],
      },
      {
        at: 115,
        expect: 'this.incomingCount++;',
        lines: [
          '// [并发] incoming 链按到达顺序串行：解码 → JSON 解析 → 健康检查回包',
          '// → 解析成事件数组 → 逐个 await onEvent。',
          '// 每个 await 之后复检 active，dispose 后剩余事件全部丢弃。',
        ],
      },
      {
        at: 148,
        expect: '.catch(error => {',
        lines: [
          '// 任一环节失败都视为协议连续性丢失：停止写入并升级为致命错误；',
          '// finally 里回收计数与字节，保证限额统计不会泄漏。',
        ],
      },
      {
        at: 158,
        expect: 'private fatal(error: Error): void {',
        lines: [
          '// 有 onFatalError 时交给传输层统一收尾，否则降级为普通上报。',
        ],
      },
      {
        at: 164,
        expect: 'private report(error: unknown): void {',
        lines: [
          '// [失败路径] 应用回调异常不得打断编解码队列，直接吞掉。',
        ],
      },
      {
        at: 63,
        expect: 'const operation = this.outgoing.then(async () => {',
        lines: [
          '// 串行化的核心：后一个发送接在前一个之后，天然保证顺序；',
          '// 每个 await 之后复检 active/finishing，关闭后立即短路。',
        ],
      },
      {
        at: 75,
        expect: 'if (data != null) this.options.send(data);',
        lines: [
          '// serialize 返回 null 表示该事件在当前形态下无需下发（如纯本地事件）。',
        ],
      },
      {
        at: 96,
        expect: 'const bytes =',
        lines: [
          '// 字节估算按最坏情况：字符串按 UTF-16 计两倍，Blob 用 size，',
          '// 这样限额判断只会偏保守，不会因估算偏低而提前耗尽内存。',
        ],
      },
      {
        at: 136,
        expect: 'if (health != null && !this.finishing) this.options.send(health);',
        lines: [
          '// 健康检查回包必须先于业务解析（如 ping/pong），',
          '// 且收尾阶段不再回包，避免关闭后仍向 socket 写入。',
          '// 回包失败由 send 抛错路径处理，这里不额外捕获。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'browser-realtime-webrtc.ts' || f.name === 'browser-realtime-transport.ts') {
    console.log('SKIP already inserted', f.name);
    continue;
  }
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      process.exit(1);
    }
    total += b.lines.length;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
