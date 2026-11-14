// ============================================================
// Tool Contract - shared tool declaration surface
// ============================================================

import type { RiskLevel } from "../interfaces/session.port.js";

/**
 * 工具副作用域枚举，是权限、sandbox、审计与工作流缓存的共同词汇表。
 * 生产者是各工具契约的静态声明（core 侧另有 resolvePermissionCapability 按入参覆盖）；
 * 消费者是 executor 的权限判定、ToolCallStarted 的副作用旗标与 bootstrap 的 driver。
 * 跨进程/模型边界的不变量：`none` 表示不碰外部世界，`workspace`/`git`/`system` 可能改写
 * 工作区，`network`/`session`/`userInteraction` 不碰文件系统；声明缺席一律按不可信处理。
 */
export type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

/**
 * 会改写工作区的副作用范围：文件系统、git、
 * 以及无法证明只读的 shell / 宿主执行。`network`、`session`、`userInteraction`、`none` 不碰工作区。
 * dynamic-workflow 的导入缓存据此判「第一笔写入」——一次工具调用在解析后的能力上 `readOnly !== true`
 * 且范围落在这个集合里，就是一笔写入。判定放在 contracts 是因为产生标记的执行器（core）与消费它的
 * driver（bootstrap）都要用同一条规则。
 */
export const WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> = new Set<ToolSideEffectScope>([
  "workspace",
  "git",
  "system",
]);

/** 一次工具调用（按解析后的能力）是否会改写工作区。缺席的范围按会改写处理（保守：未声明即不可信）。 */
/**
 * 判定一次调用（按解析后的能力）是否会改写工作区：`readOnly === true` 直接判否，
 * 否则看 sideEffectScope 是否落在 {@link WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES}。
 * 生产者在 executor 的 permission-capability 解析结果，消费者是 dynamic-workflow 的
 * 导入缓存与 driver（第一笔写入后不再复用 amend-resume 缓存）。
 * 不变量：范围缺席按“会改写”处理，因为未声明的能力不可信；此函数不读入参、不做 I/O。
 */
export function isWorkspaceMutatingToolCall(capability: {
  readOnly?: boolean | undefined;
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  if (capability.readOnly === true) return false;
  return capability.sideEffectScope === undefined
    ? true
    : WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

/**
 * 只服务于协议本身、不看也不动外部世界的副作用范围：`session` 是把结果 / 问题交回调用方
 * （dynamic-workflow 的 `submit_result`、`escalate` 就在这一档），`userInteraction` 是问用户。
 */
const PROTOCOL_ONLY_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> = new Set<ToolSideEffectScope>([
  "session",
  "userInteraction",
]);

/**
 * 一次工具调用是否**看或动了外部世界**（读文件、跑命令、访问网络……）。
 *
 * 与 `isWorkspaceMutatingToolCall` 的分工：那个判「写」，用来决定何时关掉 amend-resume 的导入缓存；
 * 这个判「碰」，用来决定一条缓存条目是不是**纯**的（纯 = 只按指令与转录前缀作答，关门后仍可命中）。
 * 读也算碰：`Read` 声明的范围是 `none`（它不产生副作用），可它的答案取决于工作区。所以判定是排除法
 * ——只把协议档（`session` / `userInteraction`）排除，其余一律算碰；范围缺席同样算碰。
 */
/**
 * 判定一次调用是否“看或动”了外部世界（读文件、跑命令、访问网络都算）。
 * 与 {@link isWorkspaceMutatingToolCall} 分工：那个判“写”，这个判“碰”，用于判断
 * 一条缓存条目是否纯（纯条目在关门后仍可命中）。实现是排除法：只排除 `session` /
 * `userInteraction` 这两个协议档，其余（含 `none` 的 Read）与缺席都算碰。
 */
export function isWorldTouchingToolCall(capability: {
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  return capability.sideEffectScope === undefined
    ? true
    : !PROTOCOL_ONLY_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

/**
 * 权限规则可以从入参的哪一部分提取匹配模式（路径 / 命令 / 网络目标等）。
 * executor 的权限规则匹配与“始终允许”持久化按它决定 pattern 来源；纯展示字段。
 * 新增来源时必须同步 core 的规则求值器，否则该来源的规则永远匹配不到。
 */
export type ToolPermissionPatternSource =
  | "none"
  | "toolName"
  | "input"
  | "path"
  | "command"
  | "network"
  | "custom";

/**
 * 结果超预算后的处理策略：`inline` 直接进模型上下文，`truncate` 截断并标注，
 * `artifact` 落盘后只回预览与路径。由 core 的 result-serialization 读取执行；
 * 契约层只声明策略，实际字节阈值来自 {@link ToolResultBudget}。
 */
export type ToolResultBudgetStrategy = "inline" | "truncate" | "artifact";

/**
 * 工具由谁执行：`client` 走本地 executor 管线（权限/hook/序列化），
 * `providerNative` 由 provider 侧直接调用。executor 据它决定是否进入权限与结果投影链，
 * 且 provider 原生工具不得再经 DeferredToolCall 包装。
 */
export type ToolExecutionMode = "client" | "providerNative";

/**
 * provider 原生执行的工具描述：模型侧看到 provider 自己的 tool 名，逻辑名仍用于
 * 事件归因、权限规则与结果配对。`fallback: "disabled"` 表示 provider 不提供时直接不可用，
 * 不允许降级成同名本地实现；`providerIds` 限定生效的 provider，缺席即全部。
 */
export interface ProviderNativeToolSpec {
  kind: "provider_native";
  logicalName: string;
  providerToolName: string;
  providerIds?: string[];
  args?: Record<string, unknown>;
  fallback: "disabled";
}

/**
 * 一个工具的权限声明，被 executor 的 permission-flow / approval-gate / hook-flow 读取。
 * `permission` 是规则匹配键，`riskLevel` 与 `sideEffectScope` 供审批提示与 sandbox 决策，
 * `needsApproval` 只是默认门（宽松模式可短路），`alwaysAsk` 才是任何模式都不可跳过的硬门。
 * `patternSources` 决定“始终允许”规则记什么，`denyPriority` 决定 deny 在询问前后生效。
 */
export interface ToolPermissionSpec {
  /** 权限规则命名空间（如 "Bash"、"Edit"）；规则持久化与匹配都以它为键。 */
  permission: string;
  /** 面向用户的审批理由；只用于展示，不参与判定。 */
  reason: string;
  /** 风险等级：审批提示与策略默认值的输入。 */
  riskLevel: RiskLevel;
  /** 副作用域：权限、sandbox 与审计按它收口，必须与 handler 真实行为一致。 */
  sideEffectScope: ToolSideEffectScope;
  /** 默认进入审批门；宽模式可短路，但不能把 deny 放宽成 allow。 */
  needsApproval: boolean;
  /** “始终允许”时记录哪些入参片段作为规则 pattern。 */
  patternSources: ToolPermissionPatternSource[];
  /** 可被“始终允许”持久化的 pattern 来源子集；缺席时沿用 `patternSources` 全集。 */
  alwaysAllowPatternSources?: ToolPermissionPatternSource[];
  /** `beforeAsk`：deny 规则先于询问生效；`afterStaticAllow`：静态 allow 之后才判 deny。 */
  denyPriority: "beforeAsk" | "afterStaticAllow";
  /**
   * Requires explicit user approval in every permission mode. Unlike `needsApproval`, which
   * the permissive modes are allowed to short-circuit, this survives yolo's pass-through and
   * plan mode's read-only pass-through: the tool's unit of work is large enough that no
   * permissiveness setting should be able to run it unattended.
   *
   * It overrides allow-granting branches only, never deny-granting ones — an explicitly
   * disallowed tool stays denied.
   */
  alwaysAsk?: true;
  /**
   * Narrows the options offered when this tool asks. `allowAlways: false` suppresses the
   * persistent project rule: a tool whose input is different code on every call cannot
   * have a decision remembered without permanently disabling its gate. `"session"` swaps
   * the persistent rule for an in-memory, session-scoped one ("Always allow in this
   * session"): the gate stays closed for the rest of this runtime only, and every new
   * session (restart, cold resume, `/new`) asks again first.
   */
  askOptions?: { allowAlways: false | "session" };
}

/**
 * 结果字节预算与降级路线的声明，被 core 的 result-serialization 读取。
 * `maxInlineBytes` 约束 UI/事件载荷，`maxModelBytes` 约束模型可见文本；两者独立，
 * 不能用一个阈值同时管两条通道。`artifact` 开启后超限内容落盘、只回预览与路径。
 */
export interface ToolResultBudget {
  /** Inline UI/event threshold before a result should be summarized, truncated, or redirected. */
  maxInlineBytes: number;
  /**
   * Provider-visible inline threshold. For artifact strategy this is the threshold that triggers
   * artifact persistence; the successful <persisted-output> preview uses its own preview budget.
   */
  maxModelBytes: number;
  strategy: ToolResultBudgetStrategy;
  preview?: {
    maxBytes?: number;
    maxLines?: number;
    direction?: "head" | "tail";
  };
  artifact?: {
    enabled: boolean;
    retention?: "session" | "project" | "temporary";
  };
}

/** 无超时策略：工具自行收口（如常驻交互），executor 不注入墙钟预算。 */
export interface NoToolTimeoutPolicy {
  kind: "none";
}

/**
 * 计时超时策略：`defaultMs` 是默认墙钟，`maxMs` 是模型可申请的上限，
 * `allowCallOverride` 决定入参 timeout 是否生效（Bash 的 600s 就在这一档）。
 * `cleanupGraceMs` 是工具超时后留给取消与 adapter 清理的额外预算，不计入用户看到的超时。
 */
export interface TimedToolTimeoutPolicy {
  kind?: "timed";
  defaultMs: number;
  maxMs?: number;
  allowCallOverride: boolean;
  /**
   * Extra wall-clock budget reserved for cancellation and adapter cleanup after the
   * tool's own timeout. The user-facing timeout still comes from defaultMs/input.
   */
  cleanupGraceMs?: number;
}

/**
 * 超时策略的联合：`none` 与 `timed` 二选一，executor 的 timeout.ts 据此挂墙钟与清理宽限。
 * handler 可用 resolveTimeoutBudgetMs 按入参算更小值，但不能突破这里的 maxMs。
 */
export type ToolTimeoutPolicy = NoToolTimeoutPolicy | TimedToolTimeoutPolicy;

/**
 * 取消语义声明：`supported` 表示可被 turn 取消/超时中断，`cleanup` 决定中断后是否必须
 * 清理外部资源，`userVisibleMessage` 是取消落终态时展示给用户的文案。
 * executor 在 timeout.ts 与后台任务收口时读取，声明与 handler 的 abortSignal 处理必须一致。
 */
export interface ToolCancellationPolicy {
  supported: boolean;
  cleanup: "none" | "bestEffort" | "required";
  userVisibleMessage: string;
}

/**
 * trace 记录策略：`required` 恒为真，所有调用必须挂在 traceId 下；`propagateToAdapters`
 * 决定把 trace 上下文传给下游 adapter，`recordInput`/`recordOutput` 控制入参/结果进
 * 观测时是全量、摘要还是不含。只有诊断与审计读它，不改写模型可见内容。
 */
export interface ToolTracePolicy {
  required: true;
  propagateToAdapters: boolean;
  recordInput: "summary" | "full" | "none";
  recordOutput: "summary" | "full" | "none";
}

/**
 * 工具契约的顶层声明：注册时由 core 的 ToolEntry 消费，executor 视其为调度/权限/预算
 * 的唯一静态事实来源。`inputSchema`/`outputSchema` 是模型面与运行时校验的同源投影，
 * `strict` 只是“有资格走 provider 约束解码”，不是命令；`requiresUserInteraction` 让
 * 流式预执行与并行分组让路。声明一旦与 handler 实现漂移，权限与截断就会错判。
 */
export interface ToolContractDeclaration {
  /** 稳定能力名，用于注册、策略分组与审计；与模型可见工具名可以不同。 */
  capability: string;
  /** 执行位置；缺席按 `client` 处理。 */
  executionMode?: ToolExecutionMode;
  /** provider 原生工具描述；仅在 `executionMode` 指明原生时生效。 */
  providerNative?: ProviderNativeToolSpec;
  /** 模型可见入参 schema，同时用于执行前校验。 */
  inputSchema: Record<string, unknown>;
  /** 输出运行时校验 schema；失败视为工具实现违约。 */
  outputSchema: Record<string, unknown>;
  /**
   * 声明 `inputSchema` **有资格**走 provider 的严格模式（Anthropic `strict: true`：constrained
   * decoding 保证 tool_use.input 恰好满足 schema）。只是资格，不是命令：adapter 按 provider /
   * model 决定是否真的下发，并负责把 strict 子集表达不了的关键字折进 description。缺席即不严格。
   * 首个使用者是 dwf mono 子代理的 typed `submit_result`。
   */
  strict?: boolean;
  /** 调用期间必须与用户交互（如确认窗/提问），流式预执行与并行分组必须让路。 */
  requiresUserInteraction?: boolean;
  /** 权限声明；executor 的规则匹配、审批门与 hook 都读这一块。 */
  permission: ToolPermissionSpec;
  /** 结果预算；core 序列化层据此截断或转 artifact。 */
  resultBudget: ToolResultBudget;
  /** 超时策略；默认值与上限的唯一来源。 */
  timeout: ToolTimeoutPolicy;
  /** 取消语义；中断时的终态文案与清理要求。 */
  cancellation: ToolCancellationPolicy;
  /** trace 记录策略；观测与审计用，不影响模型可见结果。 */
  trace: ToolTracePolicy;
}
