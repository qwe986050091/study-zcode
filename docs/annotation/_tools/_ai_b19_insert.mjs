// B19 insert: realtime audio / live websocket / small realtime helpers
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/realtime/';
const files = [
  {
    name: 'browser-realtime-audio.ts',
    want: [70, 76],
    blocks: [
      {
        at: 1,
        expect: "import {\n  decodeRealtimeAudio,".split('\n')[0],
        lines: [
          '// ============================================================================',
          '// BrowserRealtimeAudio：浏览器音频采集与播放引擎',
          '// 链路位置：由 realtime-session / WebRTC / LiveWebSocket 复用；',
          '// 采集侧 AudioContext + ScriptProcessor 重采样后回调 base64 PCM，',
          '// 播放侧把 PCM 解码成 AudioBuffer 排队调度。',
          '// ============================================================================',
        ],
      },
      {
        at: 7,
        expect: 'export type BrowserRealtimeAudioOptions = {',
        lines: [
          '// 两个采样率分别对应上行采集与下行播放，允许 provider 输入输出不同；',
          '// [资源] maxPlaybackSeconds 是背压阈值，超限暂停播放并等待 resumePlayback。',
        ],
      },
      {
        at: 17,
        expect: 'export class BrowserRealtimeAudio {',
        lines: [
          '// ---------------------------------------------------------------------------',
          '// 不变量',
          '//   INV-01 captureGeneration 决定采集回调是否仍有效。',
          '//   INV-02 ownsCaptureStream 决定停止时是否真的 stop 轨道。',
          '//   INV-03 playbackQueue / activeSources 是播放状态的唯一事实来源。',
          '//   INV-04 setPlaying 只在布尔值变化时通知外部。',
          '//   INV-05 每个 onended 都必须把 source 从 activeSources 移除。',
          '// ---------------------------------------------------------------------------',
        ],
      },
      {
        at: 24,
        expect: 'private captureContext: AudioContext | null = null;',
        lines: [
          '// [资源] 采集侧六个句柄成组创建、成组销毁；',
          '// captureCleanup 保存轨道事件监听，stopCapture 时统一移除。',
        ],
      },
      {
        at: 32,
        expect: 'private playbackContext: AudioContext | null = null;',
        lines: [
          '// 播放侧用 playbackTime 维护「下一段应开始的时间」，',
          '// 从而在 schedulePlayback 中无缝衔接多段音频。',
        ],
      },
      {
        at: 52,
        expect: 'ensurePlaybackContext(): void {',
        lines: [
          '// [资源] 懒创建播放上下文；onstatechange 把浏览器挂起/恢复',
          '// 同步为 isPlaying，避免 UI 与实际出声不一致。',
        ],
      },
      {
        at: 67,
        expect: 'async resumePlayback(): Promise<void> {',
        lines: [
          '// resume 必须在用户手势内调用；若此前因缓冲满而暂停，',
          '// 先 stopPlayback 清队列，再从当前时间重新开始。',
          '// [并发] resume 前后比对 context 身份，防止 await 期间被 dispose。',
        ],
      },
      {
        at: 80,
        expect: 'startCapture(stream: MediaStream, options?: { ownsStream?: boolean }): void {',
        lines: [
          '// 启动采集：先递增代际并停止旧采集，再建上下文与处理器。',
          '// [资源] 旧采集被替换时，若旧流是本层拥有的，必须在 stopCapture 里停止。',
          '// [并发] stopCapture 之后重新校验代际，若已被再次替换则停止传入流并返回。',
        ],
      },
      {
        at: 90,
        expect: 'const ctx = new AudioContext({ sampleRate: this.captureSampleRate });',
        lines: [
          '// [失败路径] ctx.resume 可能被自动播放策略拒绝，只上报不抛；',
          '// 回调里比对 context 身份，避免旧上下文的错误写到新采集。',
        ],
      },
      {
        at: 102,
        expect: 'processor.onaudioprocess = event => {',
        lines: [
          '// 每个音频块：取单声道数据 → 重采样到目标采样率 → 编码 base64 → 回调。',
          '// [资源] 复制一份 Float32Array，避免回调异步使用已被复用的输入缓冲。',
          '// [失败路径] 编码或回调抛错转 onError，不中断音频处理循环。',
        ],
      },
      {
        at: 121,
        expect: 'const updateCapturing = () =>',
        lines: [
          '// 采集状态 = 至少一条 live 且启用且未静音的轨道；',
          '// [资源] 监听器登记到 captureCleanup，停止时逐个移除。',
        ],
      },
      {
        at: 141,
        expect: 'stopCapture(): void {',
        lines: [
          '// [资源] 停止顺序：递增代际 → 摘处理器回调 → 移除监听 → 断开节点',
          '// → 关上下文 → 仅停止自有流 → 清字段 → 通知采集结束。',
        ],
      },
      {
        at: 160,
        expect: 'playAudio(base64Audio: string): void {',
        lines: [
          '// 播放一段音频：先检查背压，再解码入队。',
          '// [权衡] 超过 maxPlaybackSeconds 时暂停而不是丢帧，',
          '// 保证用户 resume 后仍能听到完整内容；暂停状态由 playbackPaused 表达。',
        ],
      },
      {
        at: 185,
        expect: 'stopPlayback(): void {',
        lines: [
          '// 清空队列并停止所有在播 source；playbackTime 对齐当前时钟，',
          '// 使下一次播放从「现在」开始而不是追赶过去的时间线。',
        ],
      },
      {
        at: 205,
        expect: 'getPlaybackOffsetMs(): number {',
        lines: [
          '// 已播放时长用于语音打断截断：从首次开始播放计时，',
          '// 返回毫秒整数由调用方决定取整方式。',
        ],
      },
      {
        at: 211,
        expect: 'dispose(): void {',
        lines: [
          '// [资源] 释放采集与播放两套上下文，并清空播放状态；',
          '// 关闭上下文失败被忽略，因为资源已经不可用。',
        ],
      },
      {
        at: 221,
        expect: 'private setPlaying(isPlaying: boolean): void {',
        lines: [
          '// 首次进入播放时记录 playbackStartTime，作为偏移计算基准；',
          '// 仅在布尔值变化时回调，避免高频重复通知。',
        ],
      },
      {
        at: 231,
        expect: 'private schedulePlayback(): void {',
        lines: [
          '// 调度循环：每段创建 buffer source，起点取 playbackTime 与当前时钟的较大者，',
          '// 保证既不重叠也不留空隙；onended 负责回收并判断是否全部播完。',
          '// [并发] 每次迭代后比对 context，dispose/重建时立即停止调度。',
        ],
      },
      {
        at: 42,
        expect: 'constructor(options: BrowserRealtimeAudioOptions) {',
        lines: [
          '// 构造期只保存配置与回调，不创建任何 AudioContext；',
          '// [资源] 上下文必须懒创建，才能在用户手势内 resume。',
        ],
      },
      {
        at: 92,
        expect: 'void ctx.resume().catch(error => {',
        lines: [
          '// [失败路径] resume 失败通常是被自动播放策略拦截，',
          '// 只上报给会话层，采集仍可继续（只是可能没有声音）。',
        ],
      },
      {
        at: 96,
        expect: 'const source = ctx.createMediaStreamSource(stream);',
        lines: [
          '// 采集图：MediaStreamSource → ScriptProcessor → destination；',
          '// 处理器固定 1024 帧、单声道，输出重采样后的 PCM。',
        ],
      },
      {
        at: 99,
        expect: 'const processor = ctx.createScriptProcessor(1024, 1, 1);',
        lines: [
          '// [权衡] 使用已废弃的 ScriptProcessor 是为了兼容性；',
          '// 若改用 AudioWorklet，需要额外的模块加载与跨线程传输。',
        ],
      },
      {
        at: 110,
        expect: 'try {',
        lines: [
          '// [失败路径] 编码或 onAudio 抛错都可能由应用代码引起，',
          '// 这里必须捕获，否则异常会从音频线程冒泡并中断采集。',
        ],
      },
      {
        at: 119,
        expect: 'source.connect(processor);',
        lines: [
          '// 处理器必须接到 destination 才会被浏览器驱动，',
          '// 即使不播放也要连接一个零增益出口。',
        ],
      },
      {
        at: 130,
        expect: 'for (const track of stream.getAudioTracks()) {',
        lines: [
          '// 只监听音频轨道；ended/mute/unmute 三种变化都会影响采集状态。',
        ],
      },
      {
        at: 143,
        expect: 'if (this.captureProcessor != null)',
        lines: [
          '// 先摘 onaudioprocess：断连过程中仍可能有最后一个音频块回调。',
        ],
      },
      {
        at: 188,
        expect: 'for (const source of this.activeSources) {',
        lines: [
          '// [资源] stop 可能因浏览器已自动结束而抛错，逐个吞掉，',
          '// 关键是保证 activeSources 一定被清空。',
        ],
      },
      {
        at: 199,
        expect: 'if (this.playbackContext != null) {',
        lines: [
          '// 停止后把时间基准推到当前时钟，下一段音频不会被排到过去。',
        ],
      },
      {
        at: 235,
        expect: 'while (this.playbackQueue.length > 0) {',
        lines: [
          '// [并发] while 内每次 shift 一段并立即调度，',
          '// 让连续到达的音频块保持首尾相接的播放时间线。',
        ],
      },
    ],
  },
  {
    name: 'browser-realtime-live-websocket.ts',
    want: [69, 73],
    blocks: [
      {
        at: 11,
        expect: '/** Continuous PCM16 audio-chunk media for an application-owned WebSocket relay. */',
        lines: [
          '// ============================================================================',
          '// BrowserRealtimeLiveWebSocket：连续 PCM 会话的应用中继适配层',
          '// 组合 BrowserRealtimeTransport（事件）与 BrowserRealtimeAudio（音频），',
          '// 把单向音频帧与无轮次协议拼成一个可用的实时会话传输。',
          '// ============================================================================',
        ],
      },
      {
        at: 12,
        expect: 'export class BrowserRealtimeLiveWebSocket {',
        lines: [
          '// ---------------------------------------------------------------------------',
          '// 不变量',
          '//   INV-01 generation 绑定整条会话，dispose 后所有迟到回调失效。',
          '//   INV-02 captureGeneration 绑定一次采集，切换流必须递增。',
          '//   INV-03 ready 只在启动命令发出后为真，未 ready 不发音频。',
          '//   INV-04 pendingAudio 限制在途音频帧数量。',
          '//   INV-05 音频格式在会话内不可变，变更必须重连。',
          '// ---------------------------------------------------------------------------',
        ],
      },
      {
        at: 24,
        expect: 'constructor(',
        lines: [
          '// 构造时只装配两个子系统，不发起连接；连接由 connect 触发。',
        ],
      },
      {
        at: 39,
        expect: 'const input = options.sessionConfig?.inputAudioFormat;',
        lines: [
          '// 采样率优先级：输入格式 > 输出格式 > 显式 sampleRate > 24000；',
          '// 输入输出共享同一 PCM 假设，缺省类型为 audio/pcm。',
        ],
      },
      {
        at: 47,
        expect: 'this.config = {',
        lines: [
          '// 合并策略：先用输入/输出各自字段覆盖公共 format，',
          '// 保证未声明的一侧也拿到完整格式，而不是半截配置。',
        ],
      },
      {
        at: 58,
        expect: 'this.transport = new BrowserRealtimeTransport({',
        lines: [
          '// [事务] onClosing 先转发给上层，再在同代内主动停采集，',
          '// 避免传输关闭后仍持续产生音频帧。',
        ],
      },
      {
        at: 70,
        expect: 'this.audio = new BrowserRealtimeAudio({',
        lines: [
          '// 音频引擎的采样率来自已合并配置，播放缓冲默认 2 秒，',
          '// onAudio 直接驱动上行发送，形成「采集 → 中继」闭环。',
        ],
      },
      {
        at: 81,
        expect: 'connect(options: {',
        lines: [
          '// 连接前先 dispose 旧会话，再校验音频格式。',
          '// 只支持 PCM16：其他编码需要中继侧转码，不在本层处理。',
        ],
      },
      {
        at: 90,
        expect: 'for (const format of [',
        lines: [
          '// [失败路径] 格式校验覆盖类型与采样率范围（8000~96000），',
          '// 任一不合法都在建连前抛出，避免协商后才失败。',
        ],
      },
      {
        at: 107,
        expect: 'this.stream = options.stream;',
        lines: [
          '// [资源] capture 缺省为 true；playback 上下文必须在此创建，',
          '// 因为 connect 仍处于调用方的用户手势栈内。',
        ],
      },
      {
        at: 114,
        expect: 'this.transport.connect({',
        lines: [
          '// relay 模式：URL 与子协议由应用提供；',
          '// onOpen 时补发启动命令（session-start 或 session-update）。',
        ],
      },
      {
        at: 127,
        expect: 'startCapture(): void {',
        lines: [
          '// 就绪后才允许采集；重复调用由 capturingStarted 短路。',
        ],
      },
      {
        at: 133,
        expect: 'async resumeCapture(suppliedStream?: MediaStream): Promise<void> {',
        lines: [
          '// 切换采集源：递增代际 → 停旧 → 置 ready → 取流或复用外部流。',
          '// [资源] 自建流在代际失效或缺少 live 轨道时必须停止。',
          '// [并发] await getUserMedia 之后重新校验代际与 ready。',
        ],
      },
      {
        at: 155,
        expect: 'private sendAudio(audio: string): void {',
        lines: [
          '// 上行音频：未 ready 或 socket 未开则静默丢弃；',
          '// [资源] 在途帧超过 8 个视为队列打满，直接 fail 传输；',
          '// 失败回调只有仍同代、ready 且仍打开时才升级为致命错误。',
        ],
      },
      {
        at: 189,
        expect: 'sendEvent(',
        lines: [
          '// 上行事件透传，但拦截 session-update 中的音频格式变更：',
          '// 运行中换采样率会让已排队音频错位，因此要求重连。',
        ],
      },
      {
        at: 209,
        expect: 'playAudio(audio: string): void {',
        lines: [
          '// 下行音频解码失败只上报，不影响事件通道。',
        ],
      },
      {
        at: 225,
        expect: 'stopCapture(): void {',
        lines: [
          '// [事务] 停采集同时撤销 ready：未就绪状态不再允许发音频。',
        ],
      },
      {
        at: 233,
        expect: 'finish(): Promise<void> {',
        lines: [
          '// 只排空事件通道；物理断连由 dispose 完成。',
        ],
      },
      {
        at: 237,
        expect: 'dispose(): void {',
        lines: [
          '// [资源] 先递增代际 → 停采集 → 清在途计数与流引用 → 断传输 → 释放音频。',
        ],
      },
      {
        at: 63,
        expect: 'onClosing: () => {',
        lines: [
          '// [事务] 先通知上层，再在同代内停采集，避免关闭后继续上行音频。',
        ],
      },
      {
        at: 88,
        expect: 'this.dispose();',
        lines: [
          '// [资源] 重连前彻底释放旧会话；dispose 会递增 generation，',
          '// 因此这里记录的 generation 已经过期，用于检测重入。',
        ],
      },
      {
        at: 94,
        expect: "if (format?.type !== 'audio/pcm')",
        lines: [
          '// [失败路径] 连续 PCM 中继只接受 audio/pcm，',
          '// 其他编码需要应用侧转码，不在浏览器层隐式处理。',
        ],
      },
      {
        at: 99,
        expect: 'if (',
        lines: [
          '// 采样率必须有限且落在 8000~96000：',
          '// 过低无法承载语音，过高会让 AudioContext 直接失败。',
          '// 校验在建连前完成，避免协商成功后才发现格式不可用。',
          '// 两侧格式都要校验，不能只信输入侧声明。',
          '// [权衡] 不做自动重采样：重采样会引入额外延迟与音质损失。',
        ],
      },
      {
        at: 108,
        expect: 'this.captureEnabled = options.capture !== false;',
        lines: [
          '// capture 缺省开启；显式 false 用于只接收不发送的场景。',
        ],
      },
      {
        at: 118,
        expect: 'onOpen: () => {',
        lines: [
          '// 握手：按能力声明发送 session-start 或 session-update；',
          '// 返回的 Promise 让传输层等待启动命令写完再上报 onOpen 完成。',
          '// [失败路径] 启动命令发送失败会走传输层的 onOpen 失败分支。',
          '// 这里不 await，因为 onOpen 的返回值由传输层统一 await。',
          '// [事务] 启动命令必须在任何音频帧之前写出，否则服务端会拒绝。',
        ],
      },
      {
        at: 128,
        expect: 'this.ready = true;',
        lines: [
          '// 会话层在收到就绪事件后调用；重复调用由 capturingStarted 短路。',
        ],
      },
      {
        at: 140,
        expect: 'if (suppliedStream != null) this.stream = suppliedStream;',
        lines: [
          '// 外部流优先：显式传入则复用，否则才申请麦克风。',
        ],
      },
      {
        at: 144,
        expect: 'if (generation !== this.captureGeneration || !this.ready) {',
        lines: [
          '// [并发] getUserMedia 期间可能被 stop/dispose，',
          '// 自建流必须立即停止，外部流只放弃引用。',
        ],
      },
      {
        at: 156,
        expect: 'if (!this.ready || !this.transport.isOpen) return;',
        lines: [
          '// [失败路径] 未就绪或通道未开时静默丢弃音频帧：',
          '// 高频路径不能为每帧抛错，否则会淹没真正的会话错误。',
          '// 若在途帧达到上限，则升级为致命错误，说明消费端已严重滞后。',
          '// 8 帧约等于数百毫秒的音频，超过即视为背压不可恢复。',
          '// [权衡] 丢帧优先于阻塞采集线程，保证 UI 与事件循环不被拖死。',
        ],
      },
      {
        at: 174,
        expect: 'void sent.then(',
        lines: [
          '// [并发] 只在同一代内回收计数与升级错误，',
          '// 避免旧连接的发送结果影响新会话的队列水位。',
          '// [失败路径] 发送被拒后不再重试：音频帧已过期，重发只会增加延迟。',
        ],
      },
      {
        at: 238,
        expect: 'this.generation++;',
        lines: [
          '// [资源] dispose 先让整代会话失效，再回收子系统的资源。',
        ],
      },
    ],
  },
  {
    name: 'realtime-command-tracker.ts',
    want: [21, 23],
    blocks: [
      {
        at: 7,
        expect: '/** Attempt-local ACK correlation; unresolved commands are never evicted. */',
        lines: [
          '// ============================================================================',
          '// RealtimeCommandTracker：一代连接内的事件 ID 与 ACK 关联器',
          '// pending 记录已发送未确认的命令，recent 记录已完成的 ID 以防止复用；',
          '// [资源] 未确认的命令永不淘汰，pending 上限 512，recent 上限 4096。',
          '// ============================================================================',
        ],
      },
      {
        at: 8,
        expect: 'export class RealtimeCommandTracker {',
        lines: [
          '// [事务] 发送成功不等于完成：context-append/session-update/静音命令',
          '// 必须等服务端 command-acknowledged 或 error 才能释放 ID。',
        ],
      },
      {
        at: 16,
        expect: 'validateId(id: string): void {',
        lines: [
          '// 拒绝重复 ID 与超量 pending；调用方需换新 eventId 重试。',
        ],
      },
      {
        at: 25,
        expect: 'private complete(id: string): { muted?: boolean } | undefined {',
        lines: [
          '// 完成时移入 recent，并按插入顺序淘汰最旧的一条，',
          '// 用 Set 的迭代顺序实现近似 LRU 的 ID 去重窗口。',
        ],
      },
      {
        at: 37,
        expect: 'send(event: RealtimeClientEvent): Promise<void> {',
        lines: [
          '// 静音命令自动补 eventId，并记录 mute 状态供 ACK 归约使用；',
          '// [失败路径] 同步抛错或 Promise 拒绝都要清理 pending，避免 ID 泄漏。',
        ],
      },
      {
        at: 75,
        expect: 'receive(event: RealtimeServerEvent): { muted?: boolean } | undefined {',
        lines: [
          '// ACK 与 error 都可能终结一条命令；返回的 muted 交给会话状态归约。',
        ],
      },
      {
        at: 12,
        expect: 'constructor(',
        lines: [
          '// sendCommand 由会话层注入，测试时可替换为内存实现。',
        ],
      },
      {
        at: 21,
        expect: 'if (this.pending.size >= 512)',
        lines: [
          '// 上限只约束未确认命令；达到上限说明服务端长时间不 ACK。',
        ],
      },
      {
        at: 30,
        expect: 'if (this.recent.size > 4096) {',
        lines: [
          '// [资源] recent 是防重放窗口：超限移除最旧 ID，',
          '// 窗口大小需远大于一次会话可能产生的命令数。',
        ],
      },
      {
        at: 48,
        expect: 'event = { ...event, eventId: event.eventId ?? generateId() };',
        lines: [
          '// 静音命令必须带 ID 才能等 ACK；调用方未给时补一个。',
        ],
      },
      {
        at: 54,
        expect: 'const awaitsAcknowledgement =',
        lines: [
          '// [事务] 只有这三类命令需要等服务端确认；',
          '// 其余命令发送成功即完成，避免无谓占用 pending 名额。',
        ],
      },
      {
        at: 44,
        expect: 'if (',
        lines: [
          '// 静音命令无论是否带 ID 都要参与 muted 归约；',
          '// 无 ID 时立即完成，不进入 pending。',
        ],
      },
    ],
  },
  {
    name: 'realtime-session-state.ts',
    want: [19, 20],
    blocks: [
      {
        at: 1,
        expect: "import type { RealtimeServerEvent } from '../types/realtime-model';",
        lines: [
          '// ============================================================================',
          '// realtime-session-state：会话级状态的纯函数归约',
          '// 与消息归约（realtime-event-reducer）分离：这里只关心会话 ID、',
          '// 计费用量、转写片段、委派记录与收尾确认。',
          '// ============================================================================',
        ],
      },
      {
        at: 3,
        expect: 'export type RealtimeSessionState = {',
        lines: [
          '// finalization 是收尾三态：pending 未开始、confirmed 服务端确认、',
          '// unconfirmed 本地强制断开；调用方据此区分正常结束与异常中断。',
        ],
      },
      {
        at: 14,
        expect: 'export function createSessionState(): RealtimeSessionState {',
        lines: [
          '// 初始状态只含空集合与 pending，其余字段由事件填充。',
        ],
      },
      {
        at: 23,
        expect: 'export function reduceSessionState(',
        lines: [
          '// [事务] 每个 case 都返回新对象，不就地修改入参；',
          '// transcripts/delegations 用 slice(-limit) 截断，防止长会话无界增长。',
        ],
      },
      {
        at: 30,
        expect: "case 'session-started':",
        lines: [
          '// session-started 建立会话身份与委派模式，后续事件以它为前提。',
        ],
      },
      {
        at: 38,
        expect: "case 'session-closed':",
        lines: [
          '// 收到 session-closed 即视为服务端确认收尾，finalization 置 confirmed。',
        ],
      },
      {
        at: 46,
        expect: "case 'transcript-fragment':",
        lines: [
          '// 转写片段按到达顺序追加并截断；只保留最近 limit 条。',
        ],
      },
      {
        at: 60,
        expect: "case 'command-acknowledged':",
        lines: [
          '// muted 由命令跟踪器从 ACK 中还原，这里只负责落到会话状态。',
        ],
      },
      {
        at: 36,
        expect: "case 'session-usage':",
        lines: [
          '// 用量事件只更新计费字段，不影响会话身份与收尾状态。',
        ],
      },
      {
        at: 51,
        expect: "case 'delegation-created':",
        lines: [
          '// 委派记录按 delegationId 去重，重复事件不重复入表；',
          '// 同样按 limit 截断，保留最近的 N 条。',
        ],
      },
      {
        at: 62,
        expect: 'default:',
        lines: [
          '// 未知事件原样返回同一个对象引用，让上层可以用 === 判断无需发布。',
          '// [权衡] 不做 exhaustive 检查，是为了兼容服务端新增事件类型。',
        ],
      },
    ],
  },
  {
    name: 'get-realtime-tool-definitions.ts',
    want: [18, 19],
    blocks: [
      {
        at: 1,
        expect: "import {",
        lines: [
          '// ============================================================================',
          '// getRealtimeToolDefinitions：把 AI SDK 的 ToolSet 转成实时模型工具定义',
          '// 只保留 function/dynamic 工具；provider 工具由 provider 自行处理，',
          '// 其余类型在编译期穷尽检查、运行期显式抛错。',
          '// ============================================================================',
        ],
      },
      {
        at: 9,
        expect: 'export async function getRealtimeToolDefinitions<TOOLS extends ToolSet>({',
        lines: [
          '// [失败路径] inputSchema 可能是 Schema 对象或懒加载函数，',
          '// 统一经 asSchema 解析为 JSON Schema；解析失败向上抛出。',
        ],
      },
      {
        at: 18,
        expect: 'for (const [name, tool] of Object.entries(tools)) {',
        lines: [
          '// 工具名直接作为实时协议里的 function name，不做重命名。',
        ],
      },
      {
        at: 21,
        expect: 'switch (toolType) {',
        lines: [
          '// 类型分派：undefined 视为普通 function，兼容旧写法；',
          '// dynamic 工具同样按 function 下发，运行时再决定实现。',
        ],
      },
      {
        at: 30,
        expect: 'definitions.push({',
        lines: [
          '// description 支持字符串或依赖上下文的函数，由下方统一求值。',
        ],
      },
      {
        at: 38,
        expect: "case 'provider':",
        lines: [
          '// provider 工具不进入实时工具表，避免重复声明。',
        ],
      },
      {
        at: 40,
        expect: 'default: {',
        lines: [
          '// [事务] never 穷尽检查：新增工具类型时这里会编译失败，',
          '// 强制开发者显式决定如何下发。',
        ],
      },
      {
        at: 50,
        expect: 'function resolveRealtimeToolDescription<TOOLS extends ToolSet>({',
        lines: [
          '// 描述求值：字符串直接用，函数则传入对应工具的 context；',
          '// 未提供描述时返回 undefined，由 provider 决定默认文案。',
        ],
      },
      {
        at: 59,
        expect: 'return tool.description === undefined',
        lines: [
          '// 三态求值：undefined 表示未提供；字符串原样返回；',
          '// 函数则按工具名取 context，允许不同工具看到不同上下文。',
          '// context 缺失时传入 undefined，由使用方自行决定降级行为。',
        ],
      },
    ],
  },
  {
    name: 'realtime-attempt.ts',
    want: [11, 12],
    blocks: [
      {
        at: 1,
        expect: '/** Cancellation and settlement belong to one connection attempt. */',
        lines: [
          '// ============================================================================',
          '// RealtimeAttempt：一次连接尝试的取消、定时器与关闭结算载体',
          '// 会话层每次 connect 新建一个实例，retire 后旧实例的回调全部失效。',
          '// ============================================================================',
        ],
      },
      {
        at: 2,
        expect: 'export class RealtimeAttempt {',
        lines: [
          '// [事务] active/ready/closing/transportClosing/cause 共同描述连接阶段；',
          '// closePromise 由 beginClose 惰性创建，保证只结算一次。',
        ],
      },
      {
        at: 14,
        expect: 'timer(name: string, duration: number, callback: () => void): void {',
        lines: [
          '// 同名定时器覆盖旧的；[资源] 触发前先删除登记，retire 时统一清理。',
        ],
      },
      {
        at: 30,
        expect: 'beginClose(): Promise<void> {',
        lines: [
          '// 幂等：重复调用返回同一个 Promise，直到 retire 时结算。',
        ],
      },
      {
        at: 37,
        expect: 'retire(): void {',
        lines: [
          '// [资源] 终结一代：置 active=false、abort 在途请求、清定时器、',
          '// 结算 closePromise；重复调用直接返回。',
        ],
      },
      {
        at: 25,
        expect: 'clearTimer(name: string): void {',
        lines: [
          '// 清除并移除登记；不存在时 clearTimeout 为无害的空操作。',
        ],
      },
      {
        at: 40,
        expect: 'this.abort.abort();',
        lines: [
          '// [并发] abort 放在清定时器之前：先让网络层感知取消，再拆计时器。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (
    f.name === 'browser-realtime-audio.ts' ||
    f.name === 'browser-realtime-live-websocket.ts' ||
    f.name === 'realtime-command-tracker.ts' ||
    f.name === 'realtime-session-state.ts' ||
    f.name === 'get-realtime-tool-definitions.ts'
  ) {
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
