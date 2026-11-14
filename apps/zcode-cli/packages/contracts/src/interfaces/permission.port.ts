// ============================================================
// Permission Broker Port - async client permission boundary
// ============================================================
// 定位：core 的 tool executor 只表达"这次调用需要一次审批"，弹窗、Hook 代答、
// TUI/GUI 呈现与 V4 交互全部由宿主侧 broker 实现；contracts 不感知任何具体前端。
// 不变量：权限只能收紧不能放宽。deny 恒先于 ask 与 allow，broker 给出的 allow 仍要
// 经过 executor 的规则、memory 边界与能力声明重判，任何响应都不能把已 deny 翻回允许。
// 持久化：permissionUpdates 落项目规则（scope="session" 时落会话记录），
// sessionPermissionUpdates 只进 runtime 内存的会话 ruleset，不跨进程、冷恢复即失效。

import type { PermissionDecision } from "../events/session.events.js";
import type { ModelToolSideEffectScope } from "../model/index.js";
import type { CollaborationMode, RiskLevel } from "./session.port.js";
import type { InteractionRequestOrigin, SessionId, ToolCallId, TraceId, TurnId } from "./shared.js";

// 规则三种行为。合成与匹配顺序固定为 deny → ask → allow：deny 是硬阻断，
// ask 只在没有 deny 命中时触发，allow 只对显式命中的规则生效；数组顺序不是优先级。
// 生产者：broker 建议、会话规则、项目规则文件；消费者：core PermissionService
// 的 matchesProjectRules 与 applyPermissionUpdates，新增取值必须同步这两处分支。
export type PermissionRuleBehavior = "allow" | "deny" | "ask";

// 权限能力组常量对象，目前只有一个取值：官方 CUA（Computer Use）工具。
// 由 tool entry 携带、经宿主校验后写入 capability.permissionCapabilityGroup；规则里
// 同名 key 只有在该能力组命中时才匹配，第三方同名 MCP 无法把存储字符串升级成可信能力。
// 该对象是 typeof 类型推导的唯一来源，新增组必须同时扩展下方联合类型。
export const PermissionCapabilityGroup = {
  OfficialCua: "official_cua",
} as const;

// 能力组取值的联合类型，由上方常量对象派生；不要在此手写字符串，
// 否则新增组时类型与运行值会分叉。
export type PermissionCapabilityGroup =
  (typeof PermissionCapabilityGroup)[keyof typeof PermissionCapabilityGroup];

// 单条权限规则：toolName 必填，ruleContent 可选。
// ruleContent 的匹配口径由 PermissionService.matchesRuleContent 定义（精确、`:*` 前缀、
// `*` 通配），不是本契约约定的；内容通常取自输入里的 command/url/file_path/path/pattern。
// 该结构会被序列化进 session/project 存储并跨进程读取，因此只能承载纯数据，
// 读取方不得再附加解释或按工具名重写规则。
export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

// 权限规则集：allow/deny/ask 三组规则 + 可选 mode。
// scope="session" 表示整套规则只活在当前 session（群协作的记忆授权），读写都走 session
// 记录而不是 project 记录；version 目前恒为 1，留给未来迁移判定。
// 合成顺序由 PermissionService 固定：disallowedTools/auto → project deny → project ask →
// （plan / 预批分支）→ project allow → session allow → ask 兜底；重排数组改变不了这个优先级。
// 该结构同时出现在存储与 broker wire 上，扩展字段必须保持向后兼容。
export interface PermissionRuleset {
  /** 群协作任务的记忆授权仅在当前 session 内生效。 */
  scope?: "session";
  version?: 1;
  allow?: PermissionRuleValue[];
  deny?: PermissionRuleValue[];
  ask?: PermissionRuleValue[];
  mode?: CollaborationMode;
  [key: string]: unknown;
}

// 一次"记住这个决定"的规则增量。type 目前只有 addRules：向指定 behavior 组追加规则，
// 由 applyPermissionUpdates 以 toolName + \0 + ruleContent 去重后合并，只增不删。
// 持久化范围由持有者决定：permissionUpdates 写项目规则（scope="session" 时写会话记录），
// sessionPermissionUpdates 只写 PermissionService 内存里的 sessionRules，重启即失效。
// 因此调用方不得把 session 语义塞进 permissionUpdates，也不得假定写入必然跨会话可见。
export type PermissionUpdate = {
  type: "addRules";
  behavior: PermissionRuleBehavior;
  rules: PermissionRuleValue[];
};

// 修改原因：workflow Refine 与 plan 反馈同构——
// deny + reason 只有携带专用 source 才允许被升级为真实 user message。
// deny 的 reason 允许被当成真实 user message 的唯一两种来源。
// plan 审批反馈与 workflow Refine 反馈同构到同一条通道；其他 deny 的 reason 是系统文案，
// 不能被升级成用户发言，否则模型会把工具拒绝误读成用户下达的新指令。
// preserveReasonFormatting 与它配对使用：只有来源可信时才保留 provider-visible 原文格式。
export type PermissionBrokerReasonSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * Narrows the option set a permission ask may offer. `no-always-allow` drops the
 * persistent project rule option: some tools carry different code on every call
 * (CreateWorkflow scripts), so "always allow" would permanently disable the gate
 * rather than remember a comparable decision. `session-always-allow` replaces the
 * persistent rule with a session-scoped one that lives only in the runtime's memory.
 */
// 审批弹窗可提供选项的收窄策略，由工具在权限请求里声明，只影响选项集合、不改变判定。
// no-always-allow：裁掉"永久允许"。CreateWorkflow 一类工具每次调用携带的脚本都不同，
//   持久规则不是"记住一次可比的决定"，而是永久关掉这道确认。
// session-always-allow：把持久规则换成只活在 runtime 内存的会话规则；wire 的
//   zcodePermissionUpdateSchema 是 strict，响应里不带 permissionUpdates，会话语义由
//   broker 在应答侧合成为 sessionPermissionUpdates（纯内存，绝不落项目规则）。
// legacy v3 客户端认不出会话语义，两种策略都降级为"裁掉 always allow"。
export type PermissionOptionsPolicy = "no-always-allow" | "session-always-allow";

// 一次待审批请求的全部事实，由 core executor 组装、broker 实现消费。
// requestId 每轮新建（perm_ 前缀）：rewrite 后必须换新 id，迟到响应不得套用到新输入。
// sessionId 决定规则落盘归属，turnId/toolCallId 让结果回挂到具体工具行，traceId 贯穿日志。
// input 是当前待执行（可能已被 Hook/用户改写）的输入；suggestedPermissionUpdates 只是候选项，
// 真正落盘要等 allow；riskLevel/sideEffectScope 来自工具静态声明，供 UI 展示而非运行时探测。
// approvalMode="user-once" 时只允许 allow_once/deny 两个选项，且 Hook 不得代答。
export interface PermissionBrokerRequest {
  approvalMode?: "user-once";
  requestId: string;
  sessionId: SessionId;
  turnId?: TurnId;
  traceId: TraceId;
  toolCallId: ToolCallId;
  toolName: string;
  input: unknown;
  mode: CollaborationMode;
  ruleId: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
  origin?: InteractionRequestOrigin;
}

// 审批结果。decision 是终态四态（allow/deny/ask/modify）之一，deny 一旦产生不能被下游放宽。
// permissionUpdates 与 sessionPermissionUpdates 是两条互斥通道：前者持久化、后者仅内存。
// inputAdjustments 只在 allow 且工具声明 applyInputAdjustments 时生效，字段名用工具自己的
// 输入键，值为 null 表示回到该字段默认值。
// preserveReasonFormatting/reasonSource 决定 reason 是否按 provider-visible 原文保留。
export interface PermissionBrokerResult {
  decision: PermissionDecision;
  reason?: string;
  /** V4 permission feedback 需要保留 provider-visible 原文；只由 broker 结果携带。 */
  preserveReasonFormatting?: boolean;
  reasonSource?: PermissionBrokerReasonSource;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
  /**
   * Session-scoped grants ("Always allow in this session"). Applied to the runtime's
   * in-memory session ruleset only; never persisted with `permissionUpdates`. Synthesized
   * by the broker on the answer side because the wire option schema is strict.
   */
  sessionPermissionUpdates?: PermissionUpdate[];
  /**
   * Fields the user changed in the confirmation window before approving, keyed by the tool's own
   * input field names; `null` means "back to the field's default". Carried only on an allow and
   * applied only by a tool that declares `applyInputAdjustments` (CreateWorkflow and
   * AmendWorkflow: docs/dynamic-workflow/launch.md「Adjusting the settings in the window」).
   * Synthesized by the broker from the v4 answer's `content`.
   */
  inputAdjustments?: Readonly<Record<string, unknown>>;
  resolvedAt?: Date;
}

// 请求级控制。claimResponse 让带提交副作用的应答先抢唯一胜者：返回 false 时调用方不得再裁决，
// 保证 Hook 与用户不会同时产出两个终态；signal 取消只结束等待，不撤销已提交的授权；
// timeoutMs 是等待用户的上限，与工具自身执行超时无关，超时按 deny 收口而非抛异常。
export interface PermissionBrokerRequestOptions {
  /** 带提交副作用的应答先取得唯一胜者；失败保留用户审批，Hook 不再竞争。 */
  claimResponse?: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// broker 端口：唯一入口 requestPermission，返回 Promise 且可携带 registered。
// registered 只在"异步登记"实现里存在（先答复已收到再等待），仅表示请求可被响应，
// 不持有授权状态；调用方不得把它当成"用户已同意"。
// 实现必须保证每次请求只产生一个终态，与 executor 发出的 PermissionResolved 一对一，
// 且不得在未取得 claimResponse 胜出的情况下自行批准。
export interface PermissionBrokerPort {
  requestPermission(
    request: PermissionBrokerRequest,
    options?: PermissionBrokerRequestOptions,
  ): Promise<PermissionBrokerResult> & {
    /** 异步登记时必须提供；缺省表示调用内同步登记。仅表示可响应，不持有授权状态。 */
    readonly registered?: Promise<void>;
  };
}
