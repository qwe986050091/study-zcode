// 职责边界（agentConversationTransport.ts）：把 v4 conversation 协议面桥接到 IZCodeAgentService，
// 负责 workspace 定位、握手、topic 订阅所有权、帧解码后的投递、本地 TTFT 校准与 runtime 失效。
// 做：subscribe/resync/unsubscribe 的本地簿记、ACK 暂存屏障接线、attachment 分片读取与取消。
// 不做：不解析消息语义、不落盘、不改 store、不做重试与超时策略（由 host 与 RPC 层负责）。
// 依赖：IZCodeAgentService 的 Pick 子集、zcode-protocol-v4 的 schema / assembler、ackActivationBarrier。
// 边界：一个实例 = 一个 host 连接（= 一个 workspace）；connectionId 由 host 补齐，这里不生成。
// 失败语义：协议错误以 fault.* 文案抛出；帧装配失败走 onAssemblyFault，不打断调用方。
// 取舍：本地 TTFT 只对非远程 workspace 启用；有 workspaceIdentity 时整段校准必须静默跳过。
// 顺序：handshake → barrier.begin → RPC → bind → activate，任何一步提前都会改变帧的归属。
//
// INV-01 断言：无法解析的 topic 必须返回 rejected Promise，不能同步 throw —— 守住它的位置：subscribe 开头 —— 改错故障：同步异常绕过调用方的 await 包装，变成未处理的 Promise rejection。
// INV-02 断言：barrier.begin 必须在 ensureHandshake 之后 —— 守住它的位置：subscribe 的 try 块 —— 改错故障：握手期间到达的帧会被暂存给一个尚未发出的订阅，ACK 后投递出不属于它的旧帧。
// INV-03 断言：runtimeGeneration 快照在 await 之前取，mismatch 时只 cancel 本地 pending、绝不调 unsubscribe —— 守住它的位置：subscribe 的 stale_ack 分支 —— 改错故障：向新 runtime 退订同名 subId，杀掉别人的活跃订阅。
// INV-04 断言：barrier.bind 失败（初始帧暂存溢出）时必须先撤销 host subscription 再原样抛出 —— 守住它的位置：subscribe 内层 try —— 改错故障：返回可 activate 的 ACK 会让缺片的批被当成完整快照。
// INV-05 断言：topicBySubscriptionId 只在 bind 成功后写入 —— 守住它的位置：bind 之后的 set —— 改错故障：登记了未真正建立的订阅，unsubscribe/discard 会作用到别人的 subId。
// INV-06 断言：activate 替换旧订阅时先 decoder.discard(topic, previous) 再删映射，顺序不可换 —— 守住它的位置：activate 的 previousSubscriptionId 分支 —— 改错故障：先删映射就取不到 topic，旧订阅残片污染新订阅。
// INV-07 断言：resync 必须先 decoder.recover 再发 RPC —— 守住它的位置：resync 的注释之后 —— 改错故障：同一次 read 里先到的 recovery 帧被 fail-closed 门吞掉，resync 永久无效。
// INV-08 断言：resync 只接受本实例登记过的 subscriptionId，否则抛 fault.subscription.notOwned —— 守住它的位置：resync 的 topic 查找 —— 改错故障：未知 subId 透传给 host，远端按越权订阅处理。
// INV-09 断言：unsubscribe 必须先释放本地 ownership（forget + discard + 删映射）再 await RPC —— 守住它的位置：unsubscribe 开头 —— 改错故障：RPC 挂起期间仍在投帧，已卸载的会话继续收到数据。
// INV-10 断言：unsubscribe 的 RPC 失败要抛出，但本地 ownership 不回滚 —— 守住它的位置：unsubscribe 的 catch —— 改错故障：回滚会重建幽灵订阅，之后没人能再退订它。
// INV-11 断言：sendCommand 的能力检查（independentPlanState）必须在发命令之前 —— 守住它的位置：伪造 payload 之后的分支 —— 改错故障：旧 Host 剥掉未知字段，yolo+Plan 静默降级为完全访问执行。
// INV-12 断言：每条 RPC 都必须展开 { ...workspace } 定位参数 —— 守住它的位置：每个 service 调用 —— 改错故障：漏传 workspaceIdentity 会让远程会话按路径落到本地 host。
// INV-13 断言：attachmentRead 的每个 signal 检查点都要保留 —— 守住它的位置：循环首尾与拼装前 —— 改错故障：对话框关闭后仍继续拉取最多 30MiB，取消语义失效。
// INV-14 断言：预览分片上限用 attachmentPreviewMaxChunks，不是上传事务的 64 —— 守住它的位置：chunkIndex 判断 —— 改错故障：20MiB 以上视频无法预览（曾发生的回归）。
// INV-15 断言：totalBytes/mediaType 首次赋值后即锁定，中途变化必须报 previewChangedDuringRead —— 守住它的位置：??= 与紧随其后的比较 —— 改错故障：把两个版本的字节拼成一个文件，损坏但不报错。
// INV-16 断言：nextOffset 必须等于 offset+chunk.byteLength，结束帧还要求等于 totalBytes —— 守住它的位置：循环内两处校验 —— 改错故障：截断或空洞被当作完整文件交付给渲染层。
// INV-17 断言：上游 attach 必须幂等（if (!upstream)），且 listener 归零才 dispose —— 守住它的位置：onFrame 与返回的 unsubscribe —— 改错故障：重复 attach 造成双份投递；提前 dispose 让仍在的监听者静默断流。
// INV-18 断言：onRuntimeRestart 只处理本 workspaceKey，且先 clear barrier/decoder/映射再通知监听者 —— 守住它的位置：restart 回调 —— 改错故障：复用 subId/ordinal 的旧 ownership 未失效，新 runtime 的首帧被吞掉。
// INV-19 断言：onRuntimeLifecycle 的 unavailable 绝不递增 generation、不动 barrier/decoder —— 守住它的位置：lifecycle 回调 —— 改错故障：随后 restart 的 ownership 判定错位，订阅永久 stale。
// INV-20 断言：本地 TTFT 校准只在没有 workspaceIdentity 时执行 —— 守住它的位置：calibrate 与两个 observer 回调 —— 改错故障：远程 workspace 用本地时钟，TTFT 统计被系统性偏移。
//
import { sendWithConversationDelayE2E } from "@/v4/conversationTransportDelayE2E.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import { calibrateLocalTtftClock, localTtftNow } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- transport 将上传、分块读取和 runtime 生命周期保持在同一 host 边界。 */
// ConversationTransport 的 desktop/host 实现：桥到 IZCodeAgentService 的 v4 转发面
// （依赖注入原则——数据层不感知 host 细节，
// web 直连 ws relay 时换一个实现即可）。
import type { IZCodeAgentService } from "@zcode/services";
import {
  conversationTopicFrameSchema,
  PROTOCOL_V4_LIMITS,
  parseConversationTopic,
  TopicWireFrameAssembler,
  type CommandAck,
  type CommandEnvelope,
  type CommandsQueryParams,
  type CommandsQueryResult,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type ConversationResyncParams,
  type SubscribeParams,
  type TopicFrameDeliveryKind,
  type V4AttachmentPutParams,
  type V4AttachmentPutResult,
  type V4ConversationFileChangesParams,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewParams,
  type V4ConversationFileRewindPreviewResult,
  type V4ConversationPlansParams,
  type V4ConversationPlansResult,
  type V4ConversationRowsRangeParams,
  type V4ConversationRowsRangeResult,
  type V4ConversationSubscribeResult,
  type V4ConversationResyncResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createWorkflowRunTransportMethods } from "@/v4/agentConversationTransportWorkflowRuns.js";
import { createAckActivationBarrier } from "@/v4/ackActivationBarrier.js";
import { createTopicWireDecoder } from "@/v4/topicWireDecoder.js";
import { logger } from "@/logger.js";
import {
  uploadAttachmentTransaction,
  type AttachmentUploadOptions,
} from "@/v4/attachmentUploadTransaction.js";

// [契约] 这个 target 是「连接身份」，不是「会话身份」：sessionId 永远走单次调用的参数，不要塞回这里。
// createLocalMediaPreviewUrl 是可选能力注入点：Desktop 注入本地媒体协议，Web/remote 不注入，因此必须保留分片读取退路。
// 新增字段时要考虑远程语义：任何「本机路径」含义的字段都必须显式标注，否则调用方会拿远端路径来查本机资源。
export interface AgentConversationTransportTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Desktop 本地媒体协议 URL；Web/remote 不注入，因此保持分片读取。 */
  // [契约] 存在即代表「能直接给 URL」，不存在时调用方必须走 attachmentRead 的分片路径；不要提供空实现来假装支持。
  // 这个函数只做 URL 拼装，不得触发文件读取或权限检查，副作用由宿主协议承担。
  // 远程 workspace 下即使注入了也不应使用：路径属于 host 的文件系统，见 INV-12。
  createLocalMediaPreviewUrl?: (path: string) => string;
}

type ConversationV4AgentService = Pick<
  IZCodeAgentService,
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "unsubscribeConversationV4"
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;

/**
 * 一条 host 连接（= 一个 workspace）上的 v4 conversation 传输面。
 * connectionId 由 host 侧补齐；这里只负责 workspace 定位与帧监听生命周期。
 */
export function createAgentConversationTransport(
  agentService: ConversationV4AgentService,
  target: AgentConversationTransportTarget,
): ConversationTransport {
  // [契约] workspaceIdentity 只在有值时展开，不能写成 workspaceIdentity: undefined：协议侧按字段存在性做校验。
  // 这个对象会被展开进每条 RPC，字段形状必须与 host 的 workspace 参数完全一致，多一个未知字段会被旧 Host 拒绝。
  // 不要在这里加入 sessionId 或 connectionId，二者不属于 workspace 定位。
  const workspace = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
  // [并发] calibrationFlight 是单航班锁：没有它时 content 帧与 checkpoint 会同时发起校准 RPC。
  // 锁必须在 finally 里清空，且清空发生在 then/catch 之后，保证下一次帧到达能重新校准。
  // 不要把它改成 boolean：Promise 本身既是锁也是「在途结果」，await 它可避免重复请求。
  let calibrationFlight: Promise<void> | undefined;
  const calibrate = () => {
    const observer = getLocalTtftObserver();
    if (
      target.workspaceIdentity?.trim() ||
      !observer?.needsCalibration(target.workspacePath) ||
      calibrationFlight
    )
      return;
    // [契约] start 必须在发 RPC 之前取，它是往返时延减半的锚点；放到 then 里会让时钟偏移恒为正。
    // localTtftNow 是进程内单调时钟，不能换成 Date.now：系统时间跳变会污染校准结果。
    // 校准结果只在 observer 存在且需要校准的 workspace 上写入，失败一律吞掉。
    const start = localTtftNow();
    calibrationFlight = agentService
      .queryConversationCommandsV4({
        ...workspace,
        commands: [{ sessionId: null, commandId: `ttft-clock-${crypto.randomUUID()}` }],
        clock: true,
      })
      .then((result) => {
        const clock = result.clock && calibrateLocalTtftClock(start, localTtftNow(), result.clock);
        // [失败路径] 校准失败不重试、不告警：它只是统计精度优化，不能影响任何用户可见流程。
        // 写入用的是 workspacePath 而不是 identity；远程 workspace 已在上游提前返回，这里不会误用。
        if (clock) observer.calibrate(target.workspacePath, clock);
      })
      .catch(() => {})
      .finally(() => {
        calibrationFlight = undefined;
      });
  };
  const ensureHandshake = async () => {
    // [契约] 每次 RPC 前都经过这里，握手结果被调用方用来读 capabilities；不要把它缓存成模块级变量，runtime 重启后能力集会变。
    // calibrate 放在握手之后调用：握手失败时不应消耗一次校准 RPC。
    // 返回值必须原样透传，sendCommand 依赖 hello.capabilities 做 Plan 能力门禁。
    const hello = await ensureAgentV4ConnectionHandshake(agentService);
    calibrate();
    return hello;
  };
  // [并发] 用 Set 而不是数组：同一 listener 重复注册必须幂等，否则 dispose 后仍留一份引用。
  // 投递时直接遍历 Set，不在回调里增删成员；监听者若在回调中退订，下一帧才会生效。
  // 注册顺序即投递顺序，不要排序或去重成 Map，顺序敏感的是 UI 渲染批次。
  const listeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  // [契约] 装配故障与正常帧走两条独立通道：故障不能混进帧监听者，否则 UI 会把错误当成消息。
  // 故障回调必须同步执行且不抛出，抛出的异常会打断同一批其余 listener。
  // Set 的清理由返回的 unsubscribe 负责，不要在这里做「只保留最后一个」的优化。
  const faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void
  >();
  // [契约] 这里只转发「已重启」事实，不做状态推断；监听者自行决定是否重订阅。
  // 回调参数固定为 runtimeRestart 字符串，不要扩展成事件对象，否则每个监听者都要处理版本差异。
  // 监听集合为空时必须 dispose 上游，见 INV-17 的同类约束。
  const runtimeRestartListeners = new Set<
    Parameters<ConversationTransport["onRuntimeRestart"]>[0]
  >();
  // [契约] lifecycle 只有 available/unavailable 两态，不带 generation，也不代表订阅失效。
  // 绝不能把它和 runtimeRestartListeners 合并：两者失效语义完全不同，见 INV-19。
  // 这里的 Set 只承载 UI 展示（连接状态点），不承载任何重连决策。
  const runtimeLifecycleListeners = new Set<(state: "available" | "unavailable") => void>();
  // [契约] decoder 是 physical → logical 的唯一入口，barrier 只负责按订阅暂存 physical wire。
  // deliver 回调里先做 TTFT 观察再做业务投递：观察在 try 内，异常不得阻断业务监听者。
  // fault 回调只转发，不要在 decoder 内部做退订；退订需要 subscriptionId 与 topic 的所有权信息。
  // 把 decoder 挪到 barrier 之外会改变「先暂存后装配」的语义。
  const decoder = createTopicWireDecoder(
    new TopicWireFrameAssembler(conversationTopicFrameSchema),
    (frame: ConversationTopicFrame, deliveryKind) => {
      try {
        if (!target.workspaceIdentity?.trim()) {
          getLocalTtftObserver()?.receive(target.workspacePath, frame, deliveryKind);
          // Bug 原因：校准只在 ensureHandshake 顺带刷新，排队/慢发送等待期间没有传输调用，
          // 首输出时校准已超过 60 秒有效期，跨进程阶段被整体丢弃。内容帧到达即刷新过期校准。
          calibrate();
        }
      } catch (error) {
        logger.debug("[local-ttft] observation failed", { error });
      }
      // [失败路径] 这里是业务投递点，单个 listener 抛错会中断其余监听者；不要包 try/catch 静默，定位问题需要暴露。
      // deliveryKind 必须透传：recovery 与 online 在 UI 侧重置策略不同。
      // 遍历期间的增删由 Set 语义兜底，不要先 Array.from 复制，避免投递到已退订的监听者。
      for (const listener of listeners) listener(frame, { deliveryKind });
    },
    (fault) => {
      for (const listener of faultListeners) listener(fault);
    },
  );
  // [契约] barrier 的 deliver 是唯一把 physical wire 交给 decoder 的地方；绕过它直接 attach 会跳过 ACK 前的暂存。
  // 同 topic 允许多个 pending 订阅并存，activate 时由 subscriptionId 决定归属，不能按 topic 去重。
  // 暂存溢出会以异常形式从 bind 抛出，这里不预先检查，见 INV-04。
  // runtime 重启后必须 barrier.clear()，且顺序在 decoder.clear() 之前或之后都行，但两组必须都清。
  const barrier = createAckActivationBarrier<ConversationTopicWireCandidate>((wire) => {
    decoder.accept(wire);
  });
  // [契约] 这张表是「我拥有哪些订阅」的唯一事实来源，resync/unsubscribe/discard 都据此取 topic。
  // 只能在 bind 成功后写入，见 INV-05；删除则要在 decoder.discard 之后或同时进行。
  // 不要用它反查「当前活跃订阅」：活跃语义在 barrier 里，这里只表示登记过。
  const topicBySubscriptionId = new Map<string, string>();
  // [资源] TTFT 上游与帧上游是两条独立订阅，生命周期必须一起管，否则会漏一个导致 observer 常驻。
  // 远程 workspace 时它恒为 undefined，dispose 分支要保持空安全。
  // 不要在 onFrame 之外提前订阅：没有监听者时订阅只会空转。
  let ttftUpstream: { dispose(): void } | undefined;
  let upstream: { dispose(): void } | null = null;
  let runtimeRestartUpstream: { dispose(): void } | null = null;
  let runtimeLifecycleUpstream: { dispose(): void } | null = null;
  // [并发] generation 是「ownership 有效性」的代数：每次 restart 自增，stale ACK 靠它识别。
  // 只在 onRuntimeRestart 里自增，unavailable 事件不能动它，见 INV-19。
  // 比较必须用 !== 而不是 <：跨实例注入的错误 generation 也要判为 stale。
  let runtimeGeneration = 0;
  // [契约] 这是 workspace 身份 key 的统一写法，与仓库其它模块一致；不要改成只用 path。
  // 事件过滤必须用它比较，不能比较 workspacePath：同一路径可能对应不同远程身份。
  // trim 是必要的，空串 identity 要回落到 path。
  const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const lifecycleContext = {
    workspaceKey: targetWorkspaceKey,
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };

  // [契约] 只用 atob 解码，不做 UTF-8 解释：附件是二进制，任何文本转换都会破坏字节。
  // charCodeAt 逐字节复制是必要的，atob 的结果每个字符代表 1 字节。
  // 空串会得到长度 0 的数组，调用方负责把它当作协议错误（previewEmptyChunk）。
  // 不要在循环里做边界检查裁剪，长度不匹配由上层 nextOffset 校验负责。
  const decodeBase64Chunk = (value: string): Uint8Array => {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  };
  return {
    // [契约] 返回的 result 必须原样交给 store，由 store 调 activate；本函数不替代调用方激活。
    // 订阅的唯一键是 topic，subId 由 host 分配；不要在本地生成 subId 去对齐乐观 UI。
    // 这里不缓存订阅意图，重复订阅由 barrier 的多 pending 语义处理，不要加本地去重。
    // 调用方在 activate 之前不应假设能收到帧，物理批次还压在 barrier 里。
    async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
      // [契约] topic → sessionId 只认这一个解析函数，其它地方不要手写前缀判断。
      // 解析失败必须早退，且不能 begin barrier：否则会留下一个永远等不到 ACK 的 pending。
      // sessionId 是本地推导值，不要用它替代 host 返回的会话信息。
      const sessionId = parseConversationTopic(params.topic);
      if (!sessionId) {
        return Promise.reject(new Error(`Unsupported v4 topic: ${params.topic}`));
      }
      // [契约] startedAt 只用于日志 durationMs，不参与任何协议判定。
      // 用 Date.now 而不是 monotonic：日志需要与外部时间线对齐。
      // 不要把它复用到 resync/attachment 的耗时统计，各自有独立的起点。
      const startedAt = Date.now();
      logger.lifecycle.info("v4 conversation subscription started", {
        ...lifecycleContext,
        event: "v4.conversation.subscribe.started",
        module: "ui.v4.conversation_transport",
        runtimeGeneration,
        sessionId,
        status: "started",
        topic: params.topic,
      });
      // [契约] pending 的声明必须在 try 之外：catch 里要靠它判断是否需要 cancel。
      // 不要用 boolean 标记「已 begin」，cancel 需要 token 本身。
      // bind 成功后仍保留引用是安全的，barrier 侧已 removePending。
      let pending: ReturnType<typeof barrier.begin> | undefined;
      try {
        await ensureHandshake();
        pending = barrier.begin(params.topic);
        // [并发] 快照必须在 await RPC 之前取，见 INV-03。
        // 比较点有两个：ACK 返回后、以及后续任何需要判定 ownership 的地方。
        // 不要用闭包里的实时 runtimeGeneration 比较，那会让所有迟到的 ACK 都判为有效。
        const subscribeRuntimeGeneration = runtimeGeneration;
        // [契约] 只有 base/visibility/retryInitialization 三个可选参数按存在性展开，undefined 不能透传。
        // sessionId 来自 topic 解析，不是 caller 传入，避免 topic 与 sessionId 不一致。
        // 这个 await 期间可能发生 runtime 重启，因此返回后必须立刻做 generation 检查。
        const result = await agentService.subscribeConversationV4({
          ...workspace,
          sessionId,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
          ...(params.retryInitialization
            ? { retryInitialization: params.retryInitialization }
            : {}),
        });
        // [并发] 进入这个分支后只允许 cancel 本地 pending 并抛错，见 INV-03。
        // 抛出的文案是稳定契约 fault.subscription.runtimeRestarted，调用方按它触发重订阅。
        // 日志级别用 lifecycle.warn，不是 error：重启是预期事件。
        if (subscribeRuntimeGeneration !== runtimeGeneration) {
          // 旧 runtime 的迟到 ACK 可能复用新 runtime 的 subId；此处只能
          // 丢本地 pending，不能向新 runtime 盲退订同名 subscription。
          barrier.cancel(pending);
          logger.lifecycle.warn("v4 conversation subscription ACK became stale", {
            ...lifecycleContext,
            durationMs: Date.now() - startedAt,
            event: "v4.conversation.subscribe.stale_ack",
            module: "ui.v4.conversation_transport",
            runtimeGeneration,
            sessionId,
            status: "failed",
            topic: params.topic,
          });
          throw new Error("fault.subscription.runtimeRestarted");
        }
        try {
          // [失败路径] bind 抛出暂存溢出时，必须先用 result.ack.subscriptionId 撤销 host 订阅，再抛出原错误。
          // 撤销失败只记 warn，不要用清理错误覆盖原始错误，否则调用方看不到真实原因。
          // bind 之前不能写 topicBySubscriptionId，见 INV-05。
          // 这里不能用 try/finally 简化：撤销是条件性的，且需要保留原异常对象。
          barrier.bind(pending, result.ack.subscriptionId);
        } catch (error) {
          // ACK 前 physical batch 一旦越界就已经不完整，必须撤销 host
          // subscription 并把明确 fault 交给调用方，不能返回一个可 activate 的 ACK。
          try {
            await agentService.unsubscribeConversationV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
            });
          } catch (cleanupError) {
            logger.warn("[v4-conversation] failed to undo rejected subscription", cleanupError);
          }
          throw error;
        }
        // [契约] 登记发生在此刻，意味着「host 已确认、本地已绑定」；两者缺一都不能登记。
        // 同一 subId 理论上不会重复出现，若出现则覆盖为最新 topic，不报错。
        // 后续 resync/unsubscribe 依赖这条记录，失败时不要留下半登记的中间态。
        topicBySubscriptionId.set(result.ack.subscriptionId, params.topic);
        logger.lifecycle.info("v4 conversation subscription acknowledged", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          event: "v4.conversation.subscribe.acknowledged",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          sessionId,
          status: "completed",
          subscriptionId: result.ack.subscriptionId,
          topic: params.topic,
        });
        return result;
      } catch (error) {
        if (pending) barrier.cancel(pending);
        logger.lifecycle.warn("v4 conversation subscription failed", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.subscribe.failed",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          sessionId,
          status: "failed",
          topic: params.topic,
        });
        throw error;
      }
    },
    // [契约] activate 是同步的：它只搬运已暂存帧，不做任何 RPC。
    // 返回 undefined 表示没有对应 pending（已 cancel 或不属于本次订阅），静默忽略。
    // [契约] activate 由 store 在拿到 ACK 后调用一次；重复调用只会拿到 undefined，不会重复投递同一批帧。
    activate(subscriptionId: string): void {
      // [契约] 这里会同步投递被暂存的帧，因此 UI 可能在 activate 返回前就收到数据。
      // previousSubscriptionId 非空表示同 topic 换订阅，必须清旧路由，见 INV-06。
      // 不要在投递前后加 await，否则帧顺序可能与 store 的 activate 写入交错。
      const activation = barrier.activate(subscriptionId);
      if (activation?.previousSubscriptionId) {
        decoder.discard(activation.topic, activation.previousSubscriptionId);
        topicBySubscriptionId.delete(activation.previousSubscriptionId);
      }
      logger.lifecycle.info("v4 conversation subscription activated", {
        ...lifecycleContext,
        event: "v4.conversation.subscribe.activated",
        module: "ui.v4.conversation_transport",
        runtimeGeneration,
        status: "completed",
        subscriptionId,
        ...(activation?.topic ? { topic: activation.topic } : {}),
      });
    },
    async resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult> {
      await ensureHandshake();
      // [契约] resync 必须能反查到 topic；查不到说明不是本实例拥有的订阅，直接抛 notOwned。
      // 不要用 params.topic 之类的入参替代：resync 的入参里没有 topic，只有 subId。
      // 这条查找是只读的，resync 成功后映射保持不变。
      const topic = topicBySubscriptionId.get(params.subscriptionId);
      if (!topic) throw new Error("fault.subscription.notOwned");
      // 必须在 RPC 前解开 decoder fail-closed 门；assembler ordinal tombstone 仍保留，
      // 因此同 read 中早于 Promise continuation 到达的 K+1 recovery 可进入，<=K 仍丢。
      // [契约] 必须先解 fail-closed 门再发 RPC，见 INV-07。
      // recover 不清理 assembler 的 ordinal tombstone，因此旧片仍会被丢弃，这是刻意的。
      // 不要在 recover 之后补一次 discard：那会把刚恢复的路由又清掉。
      decoder.recover(topic, params.subscriptionId);
      return agentService.resyncConversationV4({
        ...workspace,
        subscriptionId: params.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      });
    },
    async unsubscribe(subscriptionId: string): Promise<void> {
      // 本地 ownership 先释放；旧 service proxy 的 handshake/RPC 已失败时也不能继续投帧。
      const startedAt = Date.now();
      // [事务] 本地 ownership 的释放顺序：barrier.forget → 查 topic → 删映射 → decoder.discard。
      // 这个顺序保证即使后续 RPC 失败，也不会再有帧进入 decoder 或业务监听者。
      // forget 只清 pending 与 active 记录，不碰 decoder；两步都必须做。
      // 不要把它挪到 await 之后，见 INV-09。
      barrier.forget(subscriptionId);
      const subscriptionTopic = topicBySubscriptionId.get(subscriptionId);
      topicBySubscriptionId.delete(subscriptionId);
      if (subscriptionTopic) decoder.discard(subscriptionTopic, subscriptionId);
      logger.lifecycle.info("v4 conversation unsubscription started", {
        ...lifecycleContext,
        event: "v4.conversation.unsubscribe.started",
        module: "ui.v4.conversation_transport",
        runtimeGeneration,
        status: "started",
        subscriptionId,
        ...(subscriptionTopic ? { topic: subscriptionTopic } : {}),
      });
      try {
        await ensureHandshake();
        await agentService.unsubscribeConversationV4({
          ...workspace,
          subscriptionId,
        });
        logger.lifecycle.info("v4 conversation unsubscription completed", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          event: "v4.conversation.unsubscribe.completed",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          status: "completed",
          subscriptionId,
          ...(subscriptionTopic ? { topic: subscriptionTopic } : {}),
        });
      } catch (error) {
        logger.lifecycle.warn("v4 conversation unsubscription failed", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.unsubscribe.failed",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          status: "failed",
          subscriptionId,
          ...(subscriptionTopic ? { topic: subscriptionTopic } : {}),
        });
        throw error;
      }
    },
    async sendCommand(
      envelope: CommandEnvelope,
      context?: { projectId?: string | null },
    ): Promise<CommandAck> {
      const hello = await ensureHandshake();
      // [契约] 这是对未知 payload 的最小结构探测，只读 planEnabled 的三处位置。
      // 不要把它升级成 schema 校验：payload 的实际形状由 contracts 负责。
      // 三处都查是因为不同命令把 plan 开关放在不同层级，漏一处就会放过旧 Host。
      const payload = envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      // 旧 Host 会剥掉未知字段；不能把 yolo + Plan 错发成完全访问执行。
      if (
        hello.capabilities.independentPlanState !== true &&
        (payload.planEnabled || payload.config?.planEnabled || payload.firstInput?.planEnabled)
      ) {
        throw new Error("proto.independentPlanUnsupported");
      }
      // [权衡] 延迟注入只包住发送，不影响能力检查与握手顺序。
      // 回调必须保持单次调用，不要在内部加重试；重试语义属于 RPC 层。
      // 返回值直接透传 CommandAck，不要在这里补字段。
      return sendWithConversationDelayE2E(envelope, () =>
        agentService.sendConversationCommandV4({ ...workspace, ...context, envelope }),
      );
    },
    async queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
      await ensureHandshake();
      return agentService.queryConversationCommandsV4({
        ...workspace,
        commands: params.commands,
      });
    },
    async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      await ensureHandshake();
      return agentService.conversationRowsRangeV4({
        ...workspace,
        sessionId: params.sessionId,
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      });
    },
    async plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult> {
      await ensureHandshake();
      return agentService.conversationPlansV4({
        ...workspace,
        sessionId: params.sessionId,
      });
    },
    // dwf journal 的两个只读查询拆在 agentConversationTransportWorkflowRuns.ts（max-lines 边界）。
    ...createWorkflowRunTransportMethods({ agentService, ensureHandshake, workspace }),
    async fileChanges(
      params: V4ConversationFileChangesParams,
    ): Promise<V4ConversationFileChangesResult> {
      await ensureHandshake();
      return agentService.conversationFileChangesV4({
        ...workspace,
        sessionId: params.sessionId,
        target: params.target,
        baseRevision: params.baseRevision,
        baseLogEpoch: params.baseLogEpoch,
      });
    },
    async fileRewindPreview(
      params: V4ConversationFileRewindPreviewParams,
    ): Promise<V4ConversationFileRewindPreviewResult> {
      await ensureHandshake();
      return agentService.conversationFileRewindPreviewV4({
        ...workspace,
        sessionId: params.sessionId,
        target: params.target,
        baseRevision: params.baseRevision,
        baseLogEpoch: params.baseLogEpoch,
      });
    },
    async attachmentPut(
      params: V4AttachmentPutParams,
      options?: AttachmentUploadOptions,
    ): Promise<V4AttachmentPutResult> {
      await ensureHandshake();
      return uploadAttachmentTransaction(agentService, workspace, params, options);
    },
    // [契约] 这是媒体预览的完整读取路径，返回的是整块 bytes；大文件请用 attachmentReadRange。
    // 第一个 throwIfAborted 在握手之前：已取消的请求不应再消耗一次握手。
    // 只有在注入了 createLocalMediaPreviewUrl 且是 video 时才尝试直链，其余一律走分片。
    async attachmentRead(params) {
      params.signal?.throwIfAborted();
      await ensureHandshake();
      params.signal?.throwIfAborted();
      if (target.createLocalMediaPreviewUrl && params.mediaType?.startsWith("video/")) {
        const source = await agentService.attachmentPreviewSourceV4({
          ...workspace,
          sessionId: params.sessionId,
          ref: params.ref,
          ...(params.target ? { target: params.target } : {}),
          ...(params.attachmentIndex !== undefined
            ? { attachmentIndex: params.attachmentIndex }
            : {}),
        });
        params.signal?.throwIfAborted();
        if (source.kind === "local_path") {
          return {
            url: target.createLocalMediaPreviewUrl(source.path),
            mediaType: source.mediaType,
          };
        }
      }
      // [资源] 分片全部暂存在内存里再拼接，因此这里隐含 30MiB 量级的内存峰值；不要改成长期持有的缓存。
      // offset 从 0 开始，由下一次 RPC 的 nextOffset 推进，不要用 chunk 数量推导偏移。
      // mediaType/totalBytes 用 let 而不是 const，是因为它们来自首帧响应。
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let totalBytes: number | null = null;
      let mediaType: string | null = null;

      for (let chunkIndex = 0; ; chunkIndex += 1) {
        params.signal?.throwIfAborted();
        // 已发送视频读取曾误用上传事务的 64-chunk 上限，导致 20MiB 以上视频无法预览。
        // [失败路径] 上限必须用协议常量，不要写死数字；上传事务的 64 片上限不适用于预览，见 INV-14。
        // 超限抛 fault.attachment.previewTooManyChunks，调用方据此提示文件过大。
        // 检查放在发 RPC 之前，避免多发一个必然被丢弃的分片。
        if (chunkIndex >= PROTOCOL_V4_LIMITS.attachmentPreviewMaxChunks) {
          throw new Error("fault.attachment.previewTooManyChunks");
        }
        const result = await agentService.attachmentReadV4({
          ...workspace,
          sessionId: params.sessionId,
          ref: params.ref,
          ...(params.target ? { target: params.target } : {}),
          ...(params.attachmentIndex !== undefined
            ? { attachmentIndex: params.attachmentIndex }
            : {}),
          offset,
          limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        });
        // 旧的 request-id 保护只会忽略晚到结果，Dialog 关闭后仍会继续拉取
        // 最多 30MiB 视频。高层读取拥有取消语义，在每个在途 chunk 返回后立即停住。
        params.signal?.throwIfAborted();
        // [契约] 首帧锁定 totalBytes 与 mediaType，后续帧不一致即视为文件被替换，见 INV-15。
        // 用 ??= 而不是 =，是因为首帧可能返回 0（空文件）而 0 也是有效值。
        // 锁定之后仍要逐帧比较，不要只在首帧校验。
        totalBytes ??= result.totalBytes;
        mediaType ??= result.mediaType;
        if (result.totalBytes !== totalBytes || result.mediaType !== mediaType) {
          throw new Error("fault.attachment.previewChangedDuringRead");
        }
        // [失败路径] 这里之后有四处校验：越界、nextOffset 不一致、结束帧长度、空分片，缺一个都会静默交付坏数据。
        // chunks.push 必须在所有校验通过之后，避免把已判定非法的分片留在数组里。
        // byteLength 是解码后长度，不要用 base64 字符串长度近似。
        const chunk = decodeBase64Chunk(result.dataBase64);
        const nextOffset = offset + chunk.byteLength;
        if (nextOffset > totalBytes) {
          throw new Error("fault.attachment.previewSizeMismatch");
        }
        if (result.nextOffset !== null && result.nextOffset !== nextOffset) {
          throw new Error("fault.attachment.previewOffsetMismatch");
        }
        chunks.push(chunk);
        if (result.nextOffset === null) {
          if (nextOffset !== totalBytes) {
            throw new Error("fault.attachment.previewTruncated");
          }
          params.signal?.throwIfAborted();
          const bytes = new Uint8Array(totalBytes);
          let writeOffset = 0;
          for (const part of chunks) {
            bytes.set(part, writeOffset);
            writeOffset += part.byteLength;
          }
          return { bytes, mediaType };
        }
        if (chunk.byteLength === 0) {
          throw new Error("fault.attachment.previewEmptyChunk");
        }
        // [契约] 只有 nextOffset 非 null 才会走到这里；null 表示结束，已在上面拼装返回。
        // 下一轮的 offset 必须用服务端回报值而不是本地累加，见 INV-16。
        // 这个赋值是循环唯一的推进点，删掉它会造成死循环。
        offset = result.nextOffset;
      }
    },
    async attachmentReadRange(params) {
      params.signal?.throwIfAborted();
      await ensureHandshake();
      params.signal?.throwIfAborted();
      const result = await agentService.attachmentReadV4({
        ...workspace,
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      params.signal?.throwIfAborted();
      return {
        bytes: decodeBase64Chunk(result.dataBase64),
        mediaType: result.mediaType,
        totalBytes: result.totalBytes,
        nextOffset: result.nextOffset,
      };
    },
    onFrame(
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: TopicFrameDeliveryKind },
      ) => void,
    ): () => void {
      listeners.add(listener);
      if (!upstream) {
        if (!target.workspaceIdentity?.trim())
          ttftUpstream = agentService.onDynamicLocalTtftFacts?.(workspace)((facts) => {
            try {
              getLocalTtftObserver()?.checkpoint(target.workspacePath, facts);
              // CLI 在 admitted/execution/各准备阶段都会发检查点：排队输入开始执行时
              // 就能在首输出前拿到 60 秒内的新校准，不需要额外定时器或协议。
              calibrate();
            } catch (error) {
              logger.debug("[local-ttft] checkpoint failed", { error });
            }
          });
        upstream = agentService.onDynamicConversationFrame(workspace)((frame) =>
          barrier.accept(frame),
        );
        logger.lifecycle.info("v4 conversation frame upstream attached", {
          ...lifecycleContext,
          event: "v4.conversation.frames.upstream_attached",
          listenerCount: listeners.size,
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          status: "completed",
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          upstream?.dispose();
          ttftUpstream?.dispose();
          ttftUpstream = undefined;
          upstream = null;
          logger.lifecycle.info("v4 conversation frame upstream detached", {
            ...lifecycleContext,
            event: "v4.conversation.frames.upstream_detached",
            listenerCount: 0,
            module: "ui.v4.conversation_transport",
            runtimeGeneration,
            status: "completed",
          });
        }
      };
    },
    onAssemblyFault(listener) {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    onRuntimeRestart(listener) {
      runtimeRestartListeners.add(listener);
      runtimeRestartUpstream ??= agentService.onAgentRuntimeRestarted((event) => {
        if (event.workspaceKey !== targetWorkspaceKey) return;
        if (!target.workspaceIdentity?.trim())
          getLocalTtftObserver()?.interrupt(target.workspacePath);
        runtimeGeneration += 1;
        // runtime generation 可复用 subId/ordinal；ownership 与 assembler 必须原子失效。
        barrier.clear();
        decoder.clear();
        topicBySubscriptionId.clear();
        for (const restartListener of runtimeRestartListeners) restartListener("runtimeRestart");
      });
      return () => {
        runtimeRestartListeners.delete(listener);
        if (runtimeRestartListeners.size === 0) {
          runtimeRestartUpstream?.dispose();
          runtimeRestartUpstream = null;
        }
      };
    },
    ...(agentService.onAgentRuntimeLifecycle
      ? {
          onRuntimeLifecycle(listener: (state: "available" | "unavailable") => void) {
            runtimeLifecycleListeners.add(listener);
            runtimeLifecycleUpstream ??=
              agentService.onAgentRuntimeLifecycle?.((event) => {
                if (event.workspaceKey !== targetWorkspaceKey) return;
                if (event.state === "unavailable" && !target.workspaceIdentity?.trim())
                  getLocalTtftObserver()?.interrupt(target.workspacePath);
                // 只转发、不动 runtimeGeneration/barrier/decoder/topicBySubscriptionId：那是
                // onRuntimeRestart 的语义（新 runtime 已存在、可安全重订阅）。unavailable 时
                // 旧 CLI 已死不会再有帧到达，而提前递增 generation 会让随后 restart 的
                // ownership 判定错位。available 与 restart 同刻到达，清理由那一路完成。
                for (const lifecycleListener of runtimeLifecycleListeners) {
                  lifecycleListener(event.state);
                }
              }) ?? null;
            return () => {
              runtimeLifecycleListeners.delete(listener);
              if (runtimeLifecycleListeners.size === 0) {
                runtimeLifecycleUpstream?.dispose();
                runtimeLifecycleUpstream = null;
              }
            };
          },
        }
      : {}),
  };
}
