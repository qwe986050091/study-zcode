// ZCode Protocol v4 —— CLI 权威投影（M2）。
// schema/纯函数在 @zcode/shared/zcode-protocol-v4；本目录是事件日志 → 投影的 reducer 宿主。
//
// 这是 bootstrap 内 v4 能力的唯一公共出口（barrel），只允许导出“跨模块稳定契约”：
// 投影器、命令准入、publisher、cold resume 与 gateway。它不是目录清单，未列出的文件
// （facts/index/registry 等内部协作模块）属于实现细节，调用方不得据本文件反推其存在。
// 导出边界原则：内部 helper、状态容器与测试钩子不从这里暴露；新增导出前先确认确有
// 跨包/跨层调用方，否则直接从具体文件导入会给下游制造第二依赖面。
export { ProductProjection } from "./product-projection.js";
export type { SessionConfigSeed } from "./product-projection.js";
// 事件 → canonical fact 的唯一归一化入口；live 与 cold 事件都必须先经过它再进 reducer。
export { normalizeConversationEvent } from "./event-normalizer.js";
export type {
  CanonicalAssistantSegmentFact,
  CanonicalConversationFact,
  CanonicalConversationOrigin,
  CanonicalOpenSegmentIdentity,
  CanonicalConversationPlacement,
  CanonicalConversationVisibility,
  CanonicalPassthroughFact,
  CanonicalUserIntentFact,
  ConversationNormalizationDiagnostic,
  NormalizeConversationEventContext,
} from "./event-normalizer.js";
// 命令准入网关：幂等、CAS、per-session FIFO 的唯一实现；gateway 只负责转交。
export { CommandInbox } from "./command-inbox.js";
export type { CommandInboxHost, CommandInboxOutcome, GuardDecision } from "./command-inbox.js";
// 投影纯函数：初始状态、availability/inputRouting 计算与 revision 计数规则。
export {
  createInitialConversationSnapshot,
  computeAvailability,
  computeInputRouting,
  deltaBumpsRevision,
} from "./projection-state.js";
export type { AvailabilityContext } from "./projection-state.js";
// row 构造与 origin 映射：把 canonical fact 转成产品行，不承担 delta 定序。
export {
  buildToolOutput,
  mapTurnHeaderOrigin,
  mapUserInputOrigin,
  mapTurnResultToHeaderState,
} from "./projection-rows.js";
// conversation topic publisher 与其背压缓冲；terminal reserve 是帧大小预算常量。
export {
  ConversationTopicPublisher,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  ProjectionPayloadTooLargeError,
  appendConversationSubscriberBuffer,
  conversationSubscriberBufferByteLimit,
} from "./conversation-topic-publisher.js";
// legacy 客户端的 delta 编码适配；仅做协议形状转换，不改投影语义。
export {
  encodeConversationDeltasForLegacy,
  workflowRunDeltaGrowthUpperBound,
} from "./conversation-workflow-run-deltas.js";
export type {
  ConversationSubscriberBufferLimits,
  ConversationSubscriberBufferResult,
  ConversationSubscribeParams,
  ConversationSubscribeResult,
  ConversationTopicPublisherOptions,
} from "./conversation-topic-publisher.js";
// 会话列表（sessions-index）的第二投影面：只维护摘要字段，不承载 conversation 正文。
export { SessionsIndexProjection, deriveSessionSummary } from "./sessions-index-projection.js";
export type { SessionSummaryDeriveExtra } from "./sessions-index-projection.js";
export { SessionsIndexPublisher } from "./sessions-index-publisher.js";
export type { SessionsIndexSubscribeResult } from "./sessions-index-publisher.js";
// workspace 级配置 topic 的订阅/发布；与 session conversation topic 各自独立。
export { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
export type { WorkspaceConfigSubscribeResult } from "./workspace-config-publisher.js";
// publisher 的两阶段提交句柄：只导出类型，实现由 publisher 私有构造，禁止外部 new。
export type { TopicFrameReservation } from "./topic-frame-reservation.js";
// 冷会话恢复：单飞 per-session，结构化区分 sessionNotFound 与 resumeFailed。
export {
  ColdSessionResumeCoordinator,
  V4SubscribeSessionUnavailableError,
} from "./cold-session-resume.js";
export type {
  ColdSessionResumeHost,
  ColdSessionResumeOutcome,
} from "./cold-session-resume.js";
// 对外网关：READY 水位、订阅转交、query 转发；业务裁决仍在 inbox 与 publisher。
export {
  ConversationV4Gateway,
  V4CommandNoopError,
  V4CommandNotImplementedError,
} from "./v4-gateway.js";
export type { ConversationV4GatewayOptions, V4GatewayHost } from "./v4-gateway.js";
