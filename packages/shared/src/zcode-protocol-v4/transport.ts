// transport.ts —— ZCode v4 传输外壳（zcode-protocol-v4）的协议面：握手 / 订阅 / 帧信封 / RPC 出入口。
//
// 职责边界：本文件只回答“线上长什么样”——zod schema、方法名与通知名、topic 键编解码；
// 不建立连接、不读 socket、不排队、不重传、不维护订阅注册表；连接与收发都在 host 通道层。
// 本文件是两端共同契约：任一侧改 shape 而不改这里，帧就会在对方解析处整条失败。
//
// 帧格式：复用既有 JSON-RPC 载体（stdio NDJSON 单行一帧 / socket），v4/ 前缀与旧 session/* 并存。
// topic 帧 = {topic, subscriptionId, fromSeq, toSeq, sentAt, payload}，区间记账为左开右闭 (fromSeq, toSeq]，
// snapshot 帧 fromSeq 恒 0；fromSeq 是“已确认的最后一条”，toSeq 是本帧最后一条，二者不可互换。
//
// INV 表（可被测试或外部观察推翻的断言，不是愿望清单）：
// INV-01 断言：deliveryProfile 必须与 clientMode 成对（desktop-continuous↔continuous、web-remote-replayable↔replayable）—— 守住它的位置：helloMessageSchema.superRefine —— 改错故障：弱一致客户端拿到可重放水位，重连按 base.seq 续传出空洞。
// INV-02 断言：clientHello.capabilities 是 .strict()，且 workflowRunDeltas 仅在 Host hello 已声明时才可携带 —— 守住它的位置：clientHelloSchema.capabilities —— 改错故障：老 Host 遇到陌生键整条解析失败，连接直接握不上手。
// INV-03 断言：所有能力位判真一律 === true，缺省等价 false —— 守住它的位置：hostSupports* / clientSupports* 四个谓词 —— 改错故障：把 undefined 当真会让旧端走增量路径，收到整键 patch 时状态机不认。
// INV-04 断言：帧区间是左开右闭 (fromSeq, toSeq]，snapshot 帧 fromSeq 恒为 0 —— 守住它的位置：createTopicFrameSchema —— 改错故障：按闭区间记账会重放或漏掉边界那条 delta，projection 与 rows 分叉。
// INV-05 断言：同一 subscriptionId 只属于一个 logEpoch 代际，重订阅必换新 id —— 守住它的位置：subscribeAckSchema.subscriptionId/logEpoch —— 改错故障：旧代际迟到帧被当新增量合并，前端状态回退。
// INV-06 断言：subscribe/resync 的公共 response 严格 ACK-only，首帧必须晚于 ACK 作为 owned notification 发出 —— 守住它的位置：v4ConversationSubscribeResultSchema 的 .strict() —— 改错故障：首屏空白直到超时，按通知注册的处理器永远收不到。
// INV-07 断言：resync 的 topic/connectionId 只能由 host 从 owned registry 注入 —— 守住它的位置：conversationResyncParamsSchema 与 v4ConversationResyncParamsSchema 的字段分工 —— 改错故障：客户端自造 topic 即可越权读他人会话。
// INV-08 断言：journal cursor（runId, sequence）永久有效，sequence 只追加、跨 resume 不复用 —— 守住它的位置：afterSequence 语义与 events result 刻意不带 atSeq/atLogEpoch —— 改错故障：无关 rewind 丢弃合法页，或 cursor 指向别的 run。
// INV-09 断言：同一 subscriptionId 的帧按 toSeq 单调递增，缺口只能靠 resync/snapshot 补齐 —— 守住它的位置：createTopicFrameSchema 与订阅 ack.mode —— 改错故障：静默接受跳跃会让中间变更永久丢失。
// INV-10 断言：连接关闭时该连接所有未决请求（subscribe ACK、resync、只读 query）统一 reject 一次 —— 守住它的位置：连接层与帧表共用的 pending 表 —— 改错故障：逐条超时会让客户端在重连后重复订阅，产生双份帧。
// INV-11 断言：单帧字节不得超过 logicalFrameAssemblyMaxBytes，背压以 saturated→drained 表达而非丢帧 —— 守住它的位置：wire 帧与 v4ConnectionFlowState —— 改错故障：超限被静默截断会让 JSON 半行进入解码器，丢帧则制造序号缺口。
// INV-12 断言：wire 解码失败即关闭连接，不得跳过该行继续读 —— 守住它的位置：topicWireFrameCandidateSchema 的失败处置 —— 改错故障：跳行会留下永久 seq 缺口，且对端永远等不到对应 ACK。
// INV-13 断言：附件每块解码后 ≤ attachmentChunkMaxBytes 且 base64 严格合法，事务只有 begin/chunk/commit/abort —— 守住它的位置：decodedBase64ByteLength、各 superRefine 与 V4_METHODS —— 改错故障：畸形 base64 直到 commit 才炸，或 full-data put 绕过归属校验。
// INV-14 断言：read 的 target 与 attachmentIndex 必须同时出现或同时缺席 —— 守住它的位置：v4AttachmentReadParamsSchema / previewSource 的 superRefine —— 改错故障：只带 ref 会在同路径跨轮时指向旧附件。
//
// 阅读顺序：握手(hostCapabilities/hello/clientHello) → 订阅(subscribe/ack/resync) → 帧工厂与三 topic 实例化 →
// 路由面 union → 方法名/通知名表 → 各只读 query 的 params/result → 附件四段事务与分块读取 →
// 末尾 topic 键编解码。
// 注意：本文件刻意保留 schema 与 z.infer 的双份定义，改一边不报错，只能靠上面的断言提醒两边同改。
import { localTtftFactsSchema } from "../localTtft.js";
/* eslint-disable max-lines -- 三个 topic 的 logical/physical/candidate schema 必须共享同一通用传输声明，避免跨文件分叉。 */
// 传输外壳：连接握手 / 订阅 / 帧信封。
// 阶段为类型占位（后半接通道层时启用），数据形状已按规范定稿。
import { z } from "zod";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import {
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  conversationRowTargetSchema,
  timestampSchema,
} from "./core.js";
import { conversationDeltaSchema } from "./delta.js";
import { conversationRowSchema, toolCallRowSchema } from "./rows.js";
import { sessionsIndexDeltaSchema, sessionsIndexSnapshotSchema } from "./sessions-index.js";
import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import { conversationSnapshotSchema } from "./snapshot.js";
import { workspaceConfigDeltaSchema, workspaceConfigSnapshotSchema } from "./workspace-config.js";
import { createTopicWireFrameSchema, topicWireFrameCandidateSchema } from "./wire.js";

// ── 连接与握手 ──
// [契约] 能力表是连接建立前唯一的“我们能聊什么”声明：布尔位只增不减，未知键一律 optional() 兼容。
// [失败路径] 新增能力写成 required 会让旧 Host 的 hello 整条解析失败——用 optional 才能偏斜安全。
// [权衡] binaryFrames/compression 描述链路本身（ws 探测），其余描述语义；两者不要合并成一个位。
// [契约] 判真统一走下方四个谓词（=== true），undefined 与 false 等价；不要就地写 if (cap.x)。
export const hostCapabilitiesSchema = z.object({
  nativeDialogs: z.boolean(),
  localTerminal: z.boolean(),
  // ws binary（relay 链路探测用）。
  binaryFrames: z.boolean(),
  compression: z.enum(["none", "permessage-deflate"]),
  // Wire-compatible：旧 Host 缺失等价于 false；调用方必须用 === true 判断。
  workspaceHookReview: z.boolean().optional(),
  independentPlanState: z.boolean().optional(),
  /**
   * 本 Host 会发 `workflowRun.*` 键级增量（delta.ts 的两条 op），因而 `workflowRuns` 的
   * actors / nodes 可以到 1024 而不是旧界的 256。没有这个位的消费者收到的仍是整键
   * `state.updated`，并且先经 `clampWorkflowRunsForLegacy` 裁到旧界。
   */
  workflowRunDeltas: z.boolean().optional(),
  historyFirst: z.boolean().optional(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

// [契约] Host 的第一帧：superRefine 把 deliveryProfile 钉死在 clientMode 上，二者不允许自由组合。
// [失败路径] 不匹配即握手失败并由连接层断开，不要“降级成 continuous”继续跑，降级会隐藏客户端实现错误。
// [事务] serverTime 是首次时钟校准的唯一来源，客户端据此推算 clockOffset，帧里的 sentAt 只做后续校正。
// [契约] .strict() 让陌生键整条失败：宁可握不上手，也不要带着理解不了的能力位跑下去。
export const helloMessageSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    connectionId: z.string(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    deliveryProfile: z.enum(["continuous", "replayable"]),
    // 首次时钟校准。
    serverTime: timestampSchema,
    capabilities: hostCapabilitiesSchema,
    // 此处只留位。
    auth: z.object({ userId: z.string().optional() }),
  })
  .strict()
  .superRefine((hello, context) => {
    const expectedProfile = hello.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    if (hello.deliveryProfile !== expectedProfile) {
      context.addIssue({
        code: "custom",
        message: "trusted clientMode and deliveryProfile must match",
        path: ["deliveryProfile"],
      });
    }
  });
export type HelloMessage = z.infer<typeof helloMessageSchema>;

// clientMode 连接级注册一次，不进 command 信封。
// [契约] clientMode 连接级注册一次，之后同连接所有 command 信封继承它，不再进信封体。
// [契约] capabilities 是 .strict() 且单向协商：只有 Host hello 里 workflowRunDeltas === true 才允许带同名键。
// [失败路径] 客户端抢跑带键会让老 Host 整条 clientHello 解析失败，表现为“连不上”而不是“降级”。
// [资源] 握手帧同样走 NDJSON 单行：按换行切帧，半行必须留在缓冲里等下一 chunk，超长行则撑爆读缓冲直至断开。
export const clientHelloSchema = z
  .object({
    kind: z.literal("clientHello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    clientId: z.string(),
    clientKind: z.enum(["desktop", "web", "mobileRemote", "mobileApp"]).optional(),
    appVersion: z.string(),
    // 缺失代表旧客户端，不具备 Settings-centered review UI。
    capabilities: z
      .object({
        workspaceHookReviewUi: z.boolean().optional(),
        /**
         * 本客户端认得 `workflowRun.*` 增量。⚠ 声明规则是**单向**的：客户端只有在 Host 的
         * hello 里见到 `workflowRunDeltas === true` 时才能带上这个键——这个 capabilities 对象
         * 是 `.strict()` 的，老 Host 见到不认识的键会整条 clientHello 解析失败、连接握不上手。
         */
        workflowRunDeltas: z.boolean().optional(),
        historyFirst: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ClientHello = z.infer<typeof clientHelloSchema>;

export function hostSupportsWorkspaceHookReview(capabilities: HostCapabilities): boolean {
  return capabilities.workspaceHookReview === true;
}

export function clientSupportsWorkspaceHookReview(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workspaceHookReviewUi === true;
}

export function hostSupportsWorkflowRunDeltas(capabilities: HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

export function clientSupportsWorkflowRunDeltas(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workflowRunDeltas === true;
}

// ── §3.1 订阅 ──
// [契约] 订阅参数只有四件：topic、可选水位 base、可选重试 token、QoS hint。
// [事务] base 是“我确实持有该 logEpoch 到 seq 的一致状态”的断言，不是“我想从 seq 开始”的请求。
// [契约] subscribe 与 resync 共用同一水位语义：base 有效 → resume，否则 → snapshot。
// [失败路径] base 的 logEpoch 与当前 epoch 不符时必须回落 snapshot，禁止拼接两代序列。
export const subscribeParamsSchema = z
  .object({
    // "conversation/<sessionId>" | "sessions-index/<workspaceId>" | ...
    topic: z.string(),
    // 水位不变量：仅当客户端真持有该时刻一致状态才允许带。
    base: z.object({ logEpoch: z.string(), seq: z.number() }).optional(),
    // 手动重试仅消费当前 failed attempt；普通重连不重跑 hook。
    retryInitialization: z.string().min(1).optional(),
    // QoS hint，只影响调度，不影响语义。
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;

// [契约] ACK 只回 subscriptionId / mode / logEpoch 三件，帧永远不进 ACK。
// [并发] subscriptionId 是代际令牌：重订阅生成新 id，旧 id 的迟到帧必须整条丢弃，不得并入新代际。
// [资源] 背压由 connection/flow 的 saturated→drained 表达；缓冲达上限时暂停推送，而不是丢帧让序号出洞。
// [失败路径] 连接关闭时所有未决请求（subscribe/resync/只读 query）统一 reject 一次，不逐条回 error。
export const subscribeAckSchema = z.object({
  subscriptionId: z.string(),
  // resume = base 有效，从 base.seq 续传增量；否则 snapshot。
  mode: z.enum(["snapshot", "resume"]),
  logEpoch: z.string(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

const openTimingMsSchema = z.number().int().nonnegative().optional();
const openTimingCountSchema = z.number().int().nonnegative().optional();

/**
 * Desktop session 首次打开的低频诊断 timing；只挂在 conversation subscribe ACK，
 * 不进入 snapshot、delta、sessions-index 或 workspace-config。
 */
export const conversationOpenTimingSchema = z
  .object({
    version: z.literal(1),
    hostPrepareMs: openTimingMsSchema,
    providerRegistrySyncMs: openTimingMsSchema,
    taskMetaReadMs: openTimingMsSchema,
    cliRequestMs: openTimingMsSchema,
    cliBootstrapMs: openTimingMsSchema,
    cliSessionRestoreMs: openTimingMsSchema,
    historyReadyMs: openTimingMsSchema,
    initialFrameEncodeMs: openTimingMsSchema,
    cliProcessState: z.enum(["spawned", "reused"]).optional(),
    sessionRuntimeState: z.enum(["cold", "warm"]).optional(),
    snapshotRowCount: openTimingCountSchema,
  })
  .strict();
export type ConversationOpenTiming = z.infer<typeof conversationOpenTimingSchema>;

const conversationSubscribeAckSchema = subscribeAckSchema.extend({
  openTiming: conversationOpenTimingSchema.optional(),
});
export type ConversationSubscribeAck = z.infer<typeof conversationSubscribeAckSchema>;

// ── 帧信封（泛型帧用工厂构造具体 topic 的 schema）──
// [契约] 帧工厂：三个生产 topic 只差 snapshot/delta 的 shape，信封字段一字不差。
// [契约] 区间左开右闭 (fromSeq, toSeq]：fromSeq 是已确认的最后一条，toSeq 是本帧最后一条。
// [并发] 同一 subscriptionId 的帧必须按 toSeq 单调递增投递；乱序或重叠只能丢弃并触发 resync。
// [资源] deltas 数组本身无长度上界，字节上限由 wire 层 logicalFrameAssemblyMaxBytes 兜底，超限断开。
export function createTopicFrameSchema<S extends z.ZodTypeAny, D extends z.ZodTypeAny>(
  snapshotSchema: S,
  deltaSchema: D,
) {
  return z.object({
    topic: z.string(),
    // 代际标识，防旧流交错。
    subscriptionId: z.string(),
    // 区间记账 (fromSeq, toSeq]；snapshot 帧 fromSeq 固定为 0。
    fromSeq: z.number(),
    toSeq: z.number(),
    // CLI 时钟，供 clockOffset 估计。
    sentAt: timestampSchema,
    payload: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("snapshot"), snapshot: snapshotSchema }),
      z.object({ kind: z.literal("deltas"), deltas: z.array(deltaSchema) }),
    ]),
  });
}

// [契约] 手写接口与上面的 zod 工厂必须逐字段同形；TS 不校验两者一致，只能靠黄金测试兜住。
// [失败路径] 只改 schema 不改接口，编译期全绿而运行时字段已多/少，消费端在窄类型下静默读到 undefined。
// [权衡] payload 用 kind 判别联合而非 nullable 字段：snapshot 与 deltas 两支在类型上互斥。
// [契约] Timestamp 从 zod schema 反推，不要在此另写 string，否则两处别名必然漂移。
export interface TopicFrame<S, D> {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: Timestamp;
  payload: { kind: "snapshot"; snapshot: S } | { kind: "deltas"; deltas: D[] };
}
type Timestamp = z.infer<typeof timestampSchema>;

// conversation topic 的具体帧 schema（五件套实例化）。
// 传输外壳/黄金测试用它做帧合法性校验；host 通道层 复用。
// [契约] 五件套实例化之 conversation：logical / wire / candidate 三个变体共享同一 topic 前缀校验。
// [契约] topic 必须以 “conversation/” 开头且后缀非空——“conversation/” 本身不是合法 topic。
// [失败路径] 前缀错配不是“路由到别处”而是整条解析失败；路由面靠 shape 分流，不靠字符串预判。
// [权衡] ttft/ttftRelated 只挂 logical 帧，不进 wire 高频路径；上界 16 条防单帧膨胀。
export const conversationTopicFrameSchema = createTopicFrameSchema(
  conversationSnapshotSchema,
  conversationDeltaSchema,
)
  .extend({
    ttft: localTtftFactsSchema.optional(),
    ttftRelated: z.array(localTtftFactsSchema).max(16).optional(),
  })
  .superRefine((frame, context) => {
    if (!frame.topic.startsWith("conversation/") || frame.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  });
export type ConversationTopicFrame = z.infer<typeof conversationTopicFrameSchema>;
export const conversationTopicWireFrameSchema = createTopicWireFrameSchema(
  conversationTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
    context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
  }
});
export type ConversationTopicWireFrame = z.infer<typeof conversationTopicWireFrameSchema>;
export const conversationTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  },
);
export type ConversationTopicWireCandidate = z.infer<typeof conversationTopicWireCandidateSchema>;

// sessions-index topic 的具体帧 schema（五件套实例化；侧栏列表活性数据源）。
export const sessionsIndexTopicFrameSchema = createTopicFrameSchema(
  sessionsIndexSnapshotSchema,
  sessionsIndexDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("sessions-index/") ||
    frame.topic.length === "sessions-index/".length
  ) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicFrame = z.infer<typeof sessionsIndexTopicFrameSchema>;
export const sessionsIndexTopicWireFrameSchema = createTopicWireFrameSchema(
  sessionsIndexTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("sessions-index/") || wire.topic.length === "sessions-index/".length) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicWireFrame = z.infer<typeof sessionsIndexTopicWireFrameSchema>;
export const sessionsIndexTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("sessions-index/") ||
      wire.topic.length === "sessions-index/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid sessions-index topic",
        path: ["topic"],
      });
    }
  },
);
export type SessionsIndexTopicWireCandidate = z.infer<typeof sessionsIndexTopicWireCandidateSchema>;

// workspace-config topic 的具体帧 schema（additive 变更；配置目录活性数据源）。
export const workspaceConfigTopicFrameSchema = createTopicFrameSchema(
  workspaceConfigSnapshotSchema,
  workspaceConfigDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("workspace-config/") ||
    frame.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicFrame = z.infer<typeof workspaceConfigTopicFrameSchema>;
export const workspaceConfigTopicWireFrameSchema = createTopicWireFrameSchema(
  workspaceConfigTopicFrameSchema,
).superRefine((wire, context) => {
  if (
    !wire.topic.startsWith("workspace-config/") ||
    wire.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicWireFrame = z.infer<typeof workspaceConfigTopicWireFrameSchema>;
export const workspaceConfigTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("workspace-config/") ||
      wire.topic.length === "workspace-config/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid workspace-config topic",
        path: ["topic"],
      });
    }
  },
);
export type WorkspaceConfigTopicWireCandidate = z.infer<
  typeof workspaceConfigTopicWireCandidateSchema
>;

/** 三个生产 topic 的公共 logical / physical 路由面。 */
// [契约] 路由面是三个 logical 帧的 union，按 shape 匹配；新增 topic 必须同时进 logical/wire/candidate 三个 union。
// [失败路径] union 失败只报“没有任何分支匹配”，排障顺序：先看 topic 前缀，再看 payload.kind。
// [并发] 路由无状态：同一连接上多 topic 交错到达是常态，帧序约束只对同一 subscriptionId 成立。
// [契约] wire 解码失败即关闭连接，不跳过该行——跳过会让该 subscriptionId 的序号永久缺口。
export const routedTopicFrameSchema = z.union([
  conversationTopicFrameSchema,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
]);
export type RoutedTopicFrame = z.infer<typeof routedTopicFrameSchema>;
export const routedTopicWireFrameSchema = z.union([
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
]);
export type RoutedTopicWireFrame = z.infer<typeof routedTopicWireFrameSchema>;
export const routedTopicWireCandidateSchema = z.union([
  conversationTopicWireCandidateSchema,
  sessionsIndexTopicWireCandidateSchema,
  workspaceConfigTopicWireCandidateSchema,
]);
export type RoutedTopicWireCandidate = z.infer<typeof routedTopicWireCandidateSchema>;

// ── v4 RPC 出入口（host 通道层）──
// 载体复用现有 JSON-RPC（stdio NDJSON / socket），方法名带 v4/ 前缀与旧协议并存；
// 旧 session/* 方法删除后，这里就是唯一协议面。
// [契约] 方法名表是 v4 唯一协议面：三段式 v4/<域>/<动作>，旧 session/* 删除后这里即全部。
// [契约] query 一律只读、无状态、超时重发安全；只有 command 带幂等与 revision 语义，命名上不得混用。
// [并发] request id 由 JSON-RPC 层分配，本表不携带序号，方法名不是幂等键。
// [失败路径] 未知方法返回 method not found，不得回落到旧方法——回落会让偏斜两端语义不同。
export const V4_METHODS = {
  connectionFlow: "v4/connection/flow",
  controllerSubscribe: "v4/controller/subscribe",
  controllerResync: "v4/controller/resync",
  controllerUnsubscribe: "v4/controller/unsubscribe",
  conversationSubscribe: "v4/conversation/subscribe",
  sessionsIndexReconcile: "v4/sessionsIndex/reconcile",
  conversationResync: "v4/conversation/resync",
  conversationUnsubscribe: "v4/conversation/unsubscribe",
  // 行分页 query（rows/range）：只读、无状态、超时重发安全。
  conversationRowsRange: "v4/conversation/rowsRange",
  // 当前有效分支的终态 ExitPlanMode 目录；只读、无状态、超时重发安全。
  conversationPlans: "v4/conversation/plans",
  conversationFileChanges: "v4/conversation/fileChanges",
  backgroundBashOutput: "v4/conversation/backgroundBashOutput",
  offPeakControl: "v4/conversation/offPeakControl",
  conversationFileRewindPreview: "v4/conversation/fileRewindPreview",
  // workflow run 的事件日志分页（详情页审计面）：只读、无状态、超时重发安全。
  // 新方法天然偏斜安全——旧桌面根本不会调用它。
  conversationWorkflowRunEvents: "v4/conversation/workflowRunEvents",
  conversationWorkflowRuns: "v4/conversation/workflowRuns",
  // workflow run 的用户面产物。三条同族：
  // 只读、无状态、超时重发安全；schema 在 workflow-artifacts.ts（那边还有术语消歧）。
  //   Artifacts    产物清单（冷恢复与中枢详情的 durable 读法）
  //   ArtifactData 预置看板的条目分页（cursor = journal sequence）
  //   ArtifactRead 内容产物的字节，≤ 512 KiB 一块，形状逐字照 attachmentRead
  conversationWorkflowRunArtifacts: "v4/conversation/workflowRunArtifacts",
  conversationWorkflowRunArtifactData: "v4/conversation/workflowRunArtifactData",
  conversationWorkflowRunArtifactRead: "v4/conversation/workflowRunArtifactRead",
  // workflow run 的工作区 transcript。两条同族，
  // 照产物的 ①/③ 拆法：Workspace 是轻行清单（不带正文），NodeResult 是一个节点的有界正文。
  conversationWorkflowRunWorkspace: "v4/conversation/workflowRunWorkspace",
  conversationWorkflowRunNodeResult: "v4/conversation/workflowRunNodeResult",
  // usage query（模式同 rows/range：只读、无状态、超时重发安全）。
  // usage 事实源在 CLI 的 session 库（model_usage/turn_usage 聚合），host 侧无副本，
  // 故收敛为 v4 query 而非 host 直连；旧词 usage/stats、session/usage 就此消费清零。
  usageStats: "v4/usage/stats",
  conversationUsage: "v4/conversation/usage",
  // 附件事务：禁止 full-data RPC。每个 chunk 的 decoded bytes <=512KiB，
  // renderer->host Channel 与 host->CLI NDJSON 都必须逐 request 证明 <=1MiB。
  attachmentBegin: "v4/attachment/begin",
  attachmentChunk: "v4/attachment/chunk",
  attachmentCommit: "v4/attachment/commit",
  attachmentAbort: "v4/attachment/abort",
  // 已发送图片预览：只读、按 session row 授权，响应仍按 512KiB 分块。
  attachmentRead: "v4/attachment/read",
  // Share 读取 userInput 附件：允许 text/plain 等非媒体类型，仍按 row/index 授权并分块返回。
  conversationAttachmentRead: "v4/conversation/attachmentRead",
  // Share 预检 userInput 附件元数据：只做 row/index 授权和 stat，不读取完整文件。
  conversationAttachmentStat: "v4/conversation/attachmentStat",
  // Desktop local 已发送视频：只返回经过同一 row/index 授权的本地播放源。
  attachmentPreviewSource: "v4/attachment/previewSource",
  commandsQuery: "v4/commands/query",
  command: "v4/command",
} as const;
export type V4Method = (typeof V4_METHODS)[keyof typeof V4_METHODS];

/** 按任务授权的有界输出查询，不接受任意路径或调用方扩大的读取预算。 */
export const v4BackgroundBashOutputParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
  workId: z.string().min(1),
});
export type V4BackgroundBashOutputParams = z.infer<typeof v4BackgroundBashOutputParamsSchema>;

export const v4ConnectionFlowStateSchema = z.enum(["saturated", "drained", "closed"]);
export type V4ConnectionFlowState = z.infer<typeof v4ConnectionFlowStateSchema>;

export const v4ConnectionFlowParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    state: v4ConnectionFlowStateSchema,
  })
  .strict();
export type V4ConnectionFlowParams = z.infer<typeof v4ConnectionFlowParamsSchema>;

export const v4ConnectionFlowResultSchema = z.object({}).strict();

// [契约] 通知无 request id、不期望响应；初始 snapshot 与后续 deltas 都经 conversationFrame 下发。
// [事务] 通知与 ACK 分属两条时序：ACK 先、帧后，不可把首帧塞进 subscribe 的 result。
// [并发] 同一 subscriptionId 的通知必须保持 toSeq 递增；跨 subscription 无全序，消费者不得假设全局顺序。
// [资源] telemetry 类通知只承载 live 事实，不进入 snapshot/recovery；重放链路不得补造。
export const V4_NOTIFICATIONS = {
  offPeakLifecycle: "v4/offPeak/lifecycle",
  // 下行帧（snapshot / deltas），params = ConversationTopicFrame。
  conversationFrame: "v4/conversation/frame",
  // 仅 live ingest 的无正文事实；不进入 topic snapshot/recovery。
  conversationTelemetryFact: "v4/telemetry/event",
  localTtftFacts: "v4/telemetry/local-ttft",
  // 仅当前进程 live ToolCallResult 产生；历史与 replayable 链路不得补造。
  cuaPermissionObservation: "v4/cua/permission-observation",
  pluginUiToolResult: "v4/plugin-ui/tool-result",
} as const;

/** 3.3.6 SSH 历史任务归属证明与 sessions-index 冷种子共享同一有界窗口。 */
export const MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE = 200;

// subscribe 请求 = 通用 SubscribeParams + connectionId（重订阅替换按
// (connectionId, topic) 判定；stdio 单管道场景由 host 为每个下游客户端分配）。
// [契约] 订阅请求 = 通用参数 + 可信连接事实（connectionId/clientMode），后者由 host attachment 注入。
// [事务] 重订阅替换按 (connectionId, topic) 判定；stdio 单管道下由 host 为每个下游客户端分配 connectionId。
// [契约] workspace 只在 cold resume 用于恢复身份，live 链路不得据此改写已有绑定。
// [并发] workflowRunDeltas/historyFirst 是连接级事实，随 clientHello 注入；单次订阅选不了它。
export const v4ConversationSubscribeParamsSchema = subscribeParamsSchema.extend({
  additionalDirectories: z.array(z.string().trim().min(1)).max(256).optional(),
  connectionId: z.string(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  // 当前可信 attachment 的 workspace；cold resume 优先使用它恢复身份，live 不消费。
  workspace: zcodeWorkspaceRefSchema.optional(),
  /** host 从当前 remote workspace 的 tasks-index 精确读取的旧任务归属 allowlist。 */
  legacyTaskIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  // 仅供 host→CLI cold resume 使用；live conversation 不消费该 hint。
  resumeThoughtLevel: z.string().trim().min(1).optional(),
  /**
   * 这条订阅收不收 `workflowRun.*` 键级增量。与 `clientMode` 同族：由**可信 host** 从该连接的
   * clientHello 注入，面向 UI 的 subscribe 选不了它——一个客户端能不能认得增量是连接的事实，
   * 不是某一次订阅可以自选的口味。缺席 = 按旧消费者处理（整键 patch + 旧界裁剪）。
   */
  workflowRunDeltas: z.boolean().optional(),
  historyFirst: z.boolean().optional(),
});
export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;

// 公共 subscribe response 严格只含 ACK。initial snapshot/resume 由 server 的
// request-scoped post-response outbox 在 response line 之后作为 owned notification 发出。
// [契约] 公共 response 严格只含 ACK；initial snapshot 由 request-scoped post-response outbox 在 response 之后发出。
// [事务] 顺序是 ACK 行先、owned notification 后；outbox 与 response 同属一次请求的生命周期。
// [失败路径] 把首帧塞进 result，客户端按通知注册的处理器永远等不到，首屏空白直到超时。
// [资源] 连接在 ACK 与首帧之间关闭时整组作废，未发出的帧不得在重连后补发。
export const v4ConversationSubscribeResultSchema = z
  .object({
    ack: conversationSubscribeAckSchema,
  })
  .strict();
export type V4ConversationSubscribeResult = z.infer<typeof v4ConversationSubscribeResultSchema>;

// sessions-index 与 conversation 共用同一 subscribe RPC；公共 response 同样 ACK-only。
export const v4SessionsIndexSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4SessionsIndexSubscribeResult = z.infer<typeof v4SessionsIndexSubscribeResultSchema>;

// workspace-config 也只回 ACK；initial frame 走同一 post-response notification 时序。
export const v4WorkspaceConfigSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4WorkspaceConfigSubscribeResult = z.infer<
  typeof v4WorkspaceConfigSubscribeResultSchema
>;

// 活跃订阅的 same-sub 恢复。topic/connection/profile 必须由 host owned registry
// 反查，客户端只能声明自己已确认的水位与是否强制 snapshot。
// [契约] same-sub 恢复：客户端只能声明已确认水位与 forceSnapshot，topic/connection 由 host 从 registry 反查。
// [失败路径] 水位超出 host 保留窗口时一律回落 snapshot；resume 只保证 (base.seq, toSeq] 连续。
// [资源] subscriptionId/logEpoch 各限 1024 字符，防止超长键把注册表撑爆。
// [并发] resync 与 unsubscribe 竞争以 host owned registry 为准：先到者生效，后到者按未知订阅拒绝。
export const conversationResyncParamsSchema = z
  .object({
    subscriptionId: z.string().trim().min(1).max(1024),
    base: z
      .object({
        logEpoch: z.string().trim().min(1).max(1024),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    forceSnapshot: z.boolean().optional(),
  })
  .strict();
export type ConversationResyncParams = z.infer<typeof conversationResyncParamsSchema>;

// CLI-facing 形状：topic/connectionId 只能由 connection facade 从 owned registry 注入。
// [契约] CLI-facing 形状：topic/connectionId 由 connection facade 从 owned registry 注入，客户端不可见。
// [失败路径] 客户端若能自造 topic 就等于越权读他人会话——这是安全边界，不是便利字段。
// [事务] 扩展后仍是 .strict()：多带一个键整条拒绝，避免“看似被忽略、实则被信任”的字段。
// [权衡] 两层 schema 看似冗余，但让“客户端可写”与“host 注入”在类型上分离，越权在编译期就不可表达。
export const v4ConversationResyncParamsSchema = conversationResyncParamsSchema
  .extend({
    topic: z.string().trim().min(1).max(2048),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationResyncParams = z.infer<typeof v4ConversationResyncParamsSchema>;

export const v4ConversationResyncResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4ConversationResyncResult = z.infer<typeof v4ConversationResyncResultSchema>;

export const v4ConversationUnsubscribeParamsSchema = z
  .object({
    topic: z.string().trim().min(1).max(2048),
    subscriptionId: z.string().trim().min(1).max(1024),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationUnsubscribeParams = z.infer<typeof v4ConversationUnsubscribeParamsSchema>;

// ── rows/range（游标制行分页，loadOlder）──
// 无 index 语义：全序 = rowId 升序；客户端按 rowId 键控合并。
export const v4ConversationRowsRangeParamsSchema = z.object({
  sessionId: z.string(),
  /** Host attachment injects this trusted value; renderer callers omit it. */
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  // 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。
  beforeRowId: z.number().optional(),
  limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
});
export type V4ConversationRowsRangeParams = z.infer<typeof v4ConversationRowsRangeParamsSchema>;

// [契约] 结果带 atSeq/atRevision/atLogEpoch：三者是“这一页取自哪个 revision”的水位凭证，缺一不可。
// [事务] 客户端必须校验 atLogEpoch 与当前 epoch 一致，不一致就丢弃整页——跨 epoch 的 rowId 不可比。
// [并发] 翻页期间若发生 rewind/fork，epoch 变化会让后续页整体作废；重新订阅是唯一正确恢复。
// [契约] hasMore 只表示 beforeRowId 方向还有更早的行，不表示“还有更新”。
export const v4ConversationRowsRangeResultSchema = z.object({
  // rowId 升序。
  rows: z.array(conversationRowSchema),
  // 服务端取值时的水位/纪元；与 fileChanges 等只读查询共用，避免跨 revision 拼接发布数据。
  atSeq: z.number(),
  atRevision: z.number().int().nonnegative(),
  atLogEpoch: z.string(),
  // beforeRowId 方向是否还有更早的行。
  hasMore: z.boolean(),
});
export type V4ConversationRowsRangeResult = z.infer<typeof v4ConversationRowsRangeResultSchema>;

// ── conversation plans directory ──
// 目录来自 CLI 完整有效 projection，不能用 renderer 的有界 tail window 推导。
export const v4ConversationPlansParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansParams = z.infer<typeof v4ConversationPlansParamsSchema>;

export const v4ConversationPlansResultSchema = z
  .object({
    // 当前有效分支的终态 ExitPlanMode，rowId 降序（最新优先）。
    plans: z.array(toolCallRowSchema),
    atSeq: z.number().int().nonnegative(),
    atLogEpoch: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansResult = z.infer<typeof v4ConversationPlansResultSchema>;

const readonlyDiffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

// [契约] 用 (target, baseRevision, baseLogEpoch) 三元组锚定读取位置，任何一项缺失都无法判定一致性。
// [事务] host 若发现新于 baseRevision 的 revision，必须拒绝或要求重新订阅，不能拿新数据冒充旧请求的答案。
// [并发] 与 rows/range 同族：只读、无状态、超时重发安全，但结果只对给定 baseRevision 有效。
// [失败路径] baseLogEpoch 为空串非法（trim().min(1)）：空纪元会让陈旧读防护形同虚设。
export const v4ConversationFileChangesParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileChangesParams = z.infer<typeof v4ConversationFileChangesParamsSchema>;

export const v4ConversationFileChangesResultSchema = z
  .object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    state: z.enum(["active", "reverted"]).optional(),
    items: z.array(
      z
        .object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          writeCount: z.number().int().nonnegative(),
          toolNames: z.array(z.string()),
          patches: z.array(readonlyDiffHunkSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type V4ConversationFileChangesResult = z.infer<typeof v4ConversationFileChangesResultSchema>;

// ── workflow run 事件日志──
// 形态与 rows/range、plans 同族：只读、无状态、超时重发安全。cursor = journal sequence
// （`appendEvent` 单调分配），在 workflowRuns[].lastEventSequence 抬升时重取。
// 刻意**不是** v4 command：command 的 ACK 结果是 commandResultSchema 那个封闭的「变更结果」
// 判别联合，把一页只读事件塞进去等于把读放进写的词汇表，还要白背 baseRevision/幂等那套机制。

/**
 * 事件日志一页的两道界，网关按它们取数（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Reading the journal」）。字节按存储里的序列化字节计、取协议单帧上限的四分之一：条数单独
 * 管不住字节，500 条带着大 report item 的事件足以顶到单帧上限。
 */
// [契约] 事件日志一页两道界：maxEvents 管条数、maxBytes 管字节，任一先到即收尾。
// [资源] 字节按存储里的序列化字节计，取协议单帧上限的四分之一；条数单独管不住字节。
// [失败路径] 超界不是截断半条事件：页只能停在事件边界，宁可少给也不给半个 JSON。
// [权衡] 限额写进协议常量而非 CLI 内部：读端要能预判一页最大体积来规划缓冲。
export const WORKFLOW_RUN_EVENTS_PAGE_LIMITS = {
  maxEvents: 500,
  maxBytes: PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes / 4,
} as const;

export const v4ConversationWorkflowRunEventsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    /** 只取 sequence 严格大于该值的事件；缺省从头取。 */
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunEventsParams = z.infer<
  typeof v4ConversationWorkflowRunEventsParamsSchema
>;

export const v4ConversationWorkflowRunEventsResultSchema = z
  .object({
    events: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative(),
          type: z.string().min(1).max(64),
          // 载荷已在 CLI 侧经 boundDynamicWorkflowRunEventPayload 有界化（同一次序列化
          // 也喂给 workflowRuns 投影）。这里不再复述引擎的事件形状：读端按种类解释。
          payload: z.record(z.string(), z.unknown()),
          truncated: z.boolean().optional(),
        })
        .strict(),
    ),
    /** 本页之后仍有事件（页可能因条数或字节上界提前收尾）。 */
    hasMore: z.boolean(),
  })
  .strict();
// **刻意不带 `atSeq` / `atLogEpoch`**，尽管同族的 rows/range 与 plans 都带。
//
// 那两个字段在同族里是**陈旧读防护**：它们读的是 conversation projection，而 projection 的
// `rowId` 只在一个 log epoch 内有意义（重建 / fork / rewind 会重新编号），所以读端的契约是
// "atLogEpoch ≠ store 当前 epoch → 整个结果丢弃"。
//
// 本 query 读的是 **journal**（`dwf_event`），它与 conversation log 无关，且 cursor 永不失效：
// journal 的 JournalStorePort 契约要求 sequence 只追加、
// 跨 resume 从既有最大值继续、既不重置也不复用，既有条目的编号不变。也就是说一个
// `(runId, sequence)` cursor 永远有效——没有任何"陈旧"可供防护。
//
// 更要紧的是：带上 `atLogEpoch` 不是无害的对称。按同族的读端契约，一次与 run 完全无关的
// 会话 rewind（epoch 变化）会让详情页把**合法的** journal 页整页丢掉。宁可少一个字段，
// 也不要携带一个在这里定义不出正确语义的字段。
export type V4ConversationWorkflowRunEventsResult = z.infer<
  typeof v4ConversationWorkflowRunEventsResultSchema
>;

// ── dwf run 枚举 ──
// journal-backed 的重启后发现面：`workflowRuns` 投影是 memory-only（冷合并归类），
// 重启后为空——工具卡 join 与 Resume 按钮的可用性只能从 dwf_run 行还原。与
// workflowRunEvents 同族（只读、无状态、超时重发安全），同样刻意不是 v4 command，
// 同样不带 atSeq/atLogEpoch（读 journal，与 conversation log 无关，见上一个 query 的论证）。
// 新方法天然偏斜安全：旧桌面永远不会调用它。
// [契约] dwf run 枚举是 journal-backed 的重启后发现面：workflowRuns 投影 memory-only，重启即空。
// [资源] limit 缺省与钳制都在 CLI 侧（上界 64），枚举面有界，绝不无界扫库。
// [失败路径] 新方法天然偏斜安全：旧桌面永远不会调用它，故无需再协商能力位。
// [契约] 与 events 同族：只读、无状态、超时重发安全，同样刻意不带 atSeq/atLogEpoch。
export const v4ConversationWorkflowRunsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    /** 返回条数上限；缺省与钳制在 CLI 侧（枚举面有界，绝不无界扫库）。 */
    limit: z.number().int().positive().max(64).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunsParams = z.infer<
  typeof v4ConversationWorkflowRunsParamsSchema
>;

export const v4ConversationWorkflowRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    /** 发起 run 的 CreateWorkflow 工具调用 id（工具卡 → 详情页/Resume 的关联键）；老 run 缺席。 */
    toolCallId: z.string().min(1).optional(),
    /**
     * 展示标签，服务端读时派生（`name` → 脚本首行 → runId）。optional 是偏斜安全：
     * 老 CLI 不发这个键，读侧回落 runId——少一个标签是退化，不是错误。
     * 上限与派生侧的 80 字符对齐后留一倍余量（用户起的 `name` 不受派生上限约束）。
     */
    label: z.string().min(1).max(160).optional(),
    /** 最后更新时间（epoch 毫秒，journal 的 `dwf_run.time_updated`）。缺席即不显示时间。 */
    updatedAt: z.number().int().nonnegative().optional(),
    // 与 workflowRuns 投影同一套五值词汇；
    // 此查询使用独立的 schema，新增查询状态不改变投影侧的状态键。
    status: z.enum(["completed", "errored", "pending", "running", "stopped"]),
    /** `status === "stopped"` 才在场。词表与观察面共用一份——这里曾各抄一遍，于是引擎多出
     * `superseded` 时这份 strict schema 把整页 run 目录拒掉（桌面端表现为
     * 「读取 run 摘要失败」，任务列表计数与目录页一起空白）。 */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    // lineage：修订出来的 run 带前驱，
    // 被替代的 run 带后继（只随 `stopReason: "superseded"`）。两者 optional：老 CLI 不发。
    resumedFrom: z.string().min(1).optional(),
    supersededBy: z.string().min(1).optional(),
    /** errored / stopped(provider|interrupted) 的结构化失败编码（`ProviderStop` / `Interrupted` …）。 */
    failureCode: z.string().min(1).max(64).optional(),
    failureMessage: z.string().max(2048).optional(),
    /** 是否可恢复。CLI 按 resume 门的同一个谓词算好——UI 绝不自行推导（两处谓词会漂移）。 */
    resumable: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunSummary = z.infer<
  typeof v4ConversationWorkflowRunSummarySchema
>;

export const v4ConversationWorkflowRunsResultSchema = z
  .object({
    /** 最近更新在前（排序在存储层）。 */
    runs: z.array(v4ConversationWorkflowRunSummarySchema),
  })
  .strict();
export type V4ConversationWorkflowRunsResult = z.infer<
  typeof v4ConversationWorkflowRunsResultSchema
>;

export const v4ConversationFileRewindPreviewParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileRewindPreviewParams = z.infer<
  typeof v4ConversationFileRewindPreviewParamsSchema
>;

const v4WorkspaceFileRewindSafeFileSchema = z
  .object({
    action: z.enum(["restore", "delete"]),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindUnsafeFileSchema = z
  .object({
    currentHash: z.string().optional(),
    expectedHash: z.string().optional(),
    message: z.string().optional(),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.enum([
      "checkpoint_missing",
      "checkpoint_unreadable",
      "external_modified",
      "file_read_failed",
      "unsupported_checkpoint",
    ]),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindIgnoredFileSchema = z
  .object({
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.literal("bash_ignored"),
    toolNames: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileRewindPreviewResultSchema = z
  .object({
    canApply: z.boolean(),
    ignoredFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
    safeFiles: z.array(v4WorkspaceFileRewindSafeFileSchema),
    unsafeFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  })
  .strict();
export type V4ConversationFileRewindPreviewResult = z.infer<
  typeof v4ConversationFileRewindPreviewResultSchema
>;

// ── usage query──
// app 级用量聚合：range/timeZone 入参与旧 usage/stats 同形（消费者语义不变），
// 结果 = AppUsageSnapshot（形状归属中性模块 usage-stats.ts，不与旧词表文件耦合）。
export const v4UsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export type V4UsageStatsParams = z.infer<typeof v4UsageStatsParamsSchema>;
export const v4UsageStatsResultSchema = appUsageSnapshotSchema;
export type V4UsageStatsResult = z.infer<typeof v4UsageStatsResultSchema>;

// 会话级 token 用量（旧 session/usage 的 v4 名字空间落位：会话是协议一等概念，
// task 是 UI 投影概念不进协议词表）。字段与旧 result 同形，旧 schema 随词一起死。
export const v4ConversationUsageParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationUsageParams = z.infer<typeof v4ConversationUsageParamsSchema>;
export const v4ConversationUsageResultSchema = z
  .object({
    sessionId: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type V4ConversationUsageResult = z.infer<typeof v4ConversationUsageResultSchema>;

// ── 附件上行事务 ──
// UI 高层仍用 put(input)->ref；这份 full-data schema 只描述 renderer 内部调用，绝不作为
// production RPC method。wire 只能用 begin/chunk/commit/abort。
// [契约] UI 高层仍用 put(input)->ref；这份 full-data schema 只描述 renderer 内部调用，绝不注册成 RPC。
// [事务] wire 面只有 begin/chunk/commit/abort 四段；绕过事务会丢失 connectionId/uploadId 归属校验与中断清理。
// [资源] dataBase64 解码后 ≤ attachmentMaxBytes；base64 膨胀 4/3，判断一律用解码后字节。
// [失败路径] put 不是幂等入口，重试必须回到 begin（同 uploadId 可重入），不要在 put 上加重试。
export const v4AttachmentPutParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    fileName: z.string().min(1),
    mime: z.string().min(1),
    // base64（不带 data: 前缀）；解码后字节数 ≤ PROTOCOL_V4_LIMITS.attachmentMaxBytes。
    dataBase64: z.string().min(1),
  })
  .strict();
export type V4AttachmentPutParams = z.infer<typeof v4AttachmentPutParamsSchema>;
export const v4AttachmentPutResultSchema = z.object({
  ref: z.string().min(1),
});
export type V4AttachmentPutResult = z.infer<typeof v4AttachmentPutResultSchema>;

const v4AttachmentUploadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const v4AttachmentChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

// [契约] 附件事务第一段：声明总量、分块数与整份 sha256，host 据此分配 staging 槽位。
// [事务] begin 可重入：同 uploadId 再次 begin 返回 staging（带 nextChunkIndex）或 committed（带 ref）。
// [资源] totalBytes/totalChunks 各有上界，且“零字节 ⇔ 零块”必须成对成立。
// [失败路径] fileName/mime 用字符类白名单拒绝 \0 与换行；checksum 固定 sha256:<64 hex>，不合规在 begin 就失败。
export const v4AttachmentBeginParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\0\r\n]+$/),
    mime: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
    totalBytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks),
    checksum: v4AttachmentChecksumSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.totalBytes === 0) !== (value.totalChunks === 0)) {
      context.addIssue({
        code: "custom",
        message: "zero-byte upload must declare zero chunks",
        path: ["totalChunks"],
      });
    }
  });
export type V4AttachmentBeginParams = z.infer<typeof v4AttachmentBeginParamsSchema>;

export const v4AttachmentBeginResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("staging"),
      nextChunkIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("committed"),
      nextChunkIndex: z.number().int().nonnegative(),
      ref: z.string().min(1),
    })
    .strict(),
]);
export type V4AttachmentBeginResult = z.infer<typeof v4AttachmentBeginResultSchema>;

// [契约] 纯函数：返回解码后字节数，非法 base64 返回 null，调用方据此 addIssue 而不是抛异常。
// [契约] 判定三件：长度必须 %4 === 0、padding 只能是结尾的 = 或 ==、正文只允许 A-Za-z0-9+/。
// [失败路径] 不做宽松解码：Buffer.from 会静默跳过非法字符，那会把畸形输入变成合法上传。
// [资源] 只算命长度、不分配缓冲——校验路径不能因为入参大小而分配 4/3 倍内存。
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return null;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
}

// [契约] 每块带 chunkIndex 与 dataBase64；host 按 (connectionId, uploadId) 定位事务槽位。
// [事务] chunkIndex 必须等于 host 记账的 nextChunkIndex；乱序或重发由结果里的 nextChunkIndex 校正。
// [资源] 解码后 ≤ attachmentChunkMaxBytes（512KiB）；base64 文本约 1.33 倍，也须低于单帧上限。
// [失败路径] 任一 chunk 校验失败即 abort 整个 upload，不保留半份 staging 数据。
export const v4AttachmentChunkParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    dataBase64: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
  });
export type V4AttachmentChunkParams = z.infer<typeof v4AttachmentChunkParamsSchema>;

export const v4AttachmentChunkResultSchema = z
  .object({
    uploadId: v4AttachmentUploadIdSchema,
    nextChunkIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4AttachmentChunkResult = z.infer<typeof v4AttachmentChunkResultSchema>;

const v4AttachmentTerminalParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
  })
  .strict();
export const v4AttachmentCommitParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentCommitParams = z.infer<typeof v4AttachmentCommitParamsSchema>;
export const v4AttachmentCommitResultSchema = v4AttachmentPutResultSchema.strict();
export type V4AttachmentCommitResult = z.infer<typeof v4AttachmentCommitResultSchema>;
export const v4AttachmentAbortParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentAbortParams = z.infer<typeof v4AttachmentAbortParamsSchema>;
export const v4AttachmentAbortResultSchema = z.object({}).strict();

/** 已发送 image/video/PDF 预览 query；ref 必须由 CLI 对当前 session projection 再授权。 */
export const v4AttachmentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    // 新 renderer 用稳定 row 身份 + 附件序号消除同一路径跨轮歧义；两者必须成对出现。
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentReadParams = z.infer<typeof v4AttachmentReadParamsSchema>;

/** Desktop local 已发送视频 source query；远端与 Web 必须返回 chunked。PDF 始终走 chunked。 */
export const v4AttachmentPreviewSourceParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentPreviewSourceParams = z.infer<typeof v4AttachmentPreviewSourceParamsSchema>;

export const v4AttachmentPreviewSourceResultSchema = z.union([
  z
    .object({
      kind: z.literal("local_path"),
      path: z.string().min(1),
      mediaType: z.string().refine((value) => value.startsWith("video/"), {
        message: "local attachment preview only supports video media types",
      }),
    })
    .strict(),
  z.object({ kind: z.literal("chunked") }).strict(),
]);
export type V4AttachmentPreviewSourceResult = z.infer<typeof v4AttachmentPreviewSourceResultSchema>;

// [契约] 一块预览数据：dataBase64 + mediaType + totalBytes + nextOffset，nextOffset 为 null 表示读完。
// [资源] 三层上限并存：image/text 用 attachmentMaxBytes，其余用 attachmentPreviewMaxBytes，单块 ≤ chunkMaxBytes。
// [失败路径] nextOffset 必须 ≤ totalBytes：越界游标会让客户端无限续读，故解析期直接拒绝。
// [权衡] mediaType 用 refine 白名单（image/*、video/*、pdf、text/plain），不做完整 MIME 解析。
export const v4AttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z
      .string()
      .refine(
        (value) =>
          value.startsWith("image/") ||
          value.startsWith("video/") ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf" ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "text/plain",
        "attachment preview only supports image/video/pdf/plain text types",
      ),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      // 根因：运行时已支持材料文本，响应 schema 仍只接受媒体，导致跨进程预览失败。
      (value.mediaType.startsWith("image/") ||
        value.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain") &&
      value.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        origin: "number",
        inclusive: true,
        message: "image/text preview exceeds total byte limit",
        path: ["totalBytes"],
      });
    }
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4AttachmentReadResult = z.infer<typeof v4AttachmentReadResultSchema>;

/** Share 读取用户输入附件，允许任意已授权 MIME，不改变媒体预览 read 的语义。 */
export const v4ConversationAttachmentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationAttachmentReadParams = z.infer<
  typeof v4ConversationAttachmentReadParamsSchema
>;

export const v4ConversationAttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z.string().min(1),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationAttachmentReadResult = z.infer<
  typeof v4ConversationAttachmentReadResultSchema
>;

/** Share 选择阶段的 metadata-only 附件检查。 */
export const v4ConversationAttachmentStatParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationAttachmentStatParams = z.infer<
  typeof v4ConversationAttachmentStatParamsSchema
>;

export const v4ConversationAttachmentStatResultSchema = z
  .object({
    mediaType: z.string().min(1),
    // stat 是 metadata-only 探测，必须能表达超过传输上限的真实大小，否则
    // 「已知容量超限」无法在选择阶段作为阻断项呈现（见 attachmentStatMaxBytes 注释）。
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentStatMaxBytes),
    mtimeMs: z.number().finite().optional(),
  })
  .strict();
export type V4ConversationAttachmentStatResult = z.infer<
  typeof v4ConversationAttachmentStatResultSchema
>;

/** conversation topic key 构造（与 parseConversationTopic 对偶）。 */
// [契约] topic 键构造与末尾 parseConversationTopic 互逆：conversation/<sessionId>，sessionId 不得为空。
// [失败路径] parse 对 “conversation/” 与不匹配前缀都返回 null——空 sessionId 不是合法会话。
// [并发] 键本身无状态；同 session 的多订阅靠 subscriptionId 区分，不靠 topic 字符串后缀。
// [权衡] 相信 sessionId 已在上游校验，这里不再加字符白名单，避免两处规则漂移。
export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

/** conversation topic key 解析（"conversation/<sessionId>"）。 */
export function parseConversationTopic(topic: string): string | null {
  if (!topic.startsWith("conversation/")) return null;
  const sessionId = topic.slice("conversation/".length);
  return sessionId.length > 0 ? sessionId : null;
}
