import { z } from "zod";
import type { ModelToolSideEffectScope } from "../model/index.js";
import type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";
import type { PermissionUpdate } from "../interfaces/permission.port.js";
import type { SessionId, ToolCallId, TraceId, TurnId } from "../interfaces/shared.js";

/**
 * hook 可订阅的生命周期事件闭集，与 runner 的分发点一一对应。
 *
 * 生产者是配置校验（未知事件名在读取配置时即拒绝）；消费者是 runner 与
 * 事件 schema。跨进程不变量：这些字符串会落进配置、审查快照与事件 payload，
 * 属于稳定协议值，不能改名；新增事件必须同步 workspace-hook-trust 的白名单，
 * 否则用户配置了却永远不触发（静默失效比报错更危险）。
 */
export const HookEventName = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PermissionRequest: "PermissionRequest",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  Stop: "Stop",
} as const;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

/**
 * 单次 hook 执行的终态。
 *
 * 生产者是 runner（按进程退出码、超时、取消归一化后写入）；消费者是
 * 事件投影、遥测与准入判断。blocked 表示 hook 主动拦截（可带 blockReason），
 * 与 failed（hook 自身执行失败）必须区分：前者影响被守护的动作，后者默认
 * 不能放宽权限。cancelled/timed_out 都不能当成 success。
 */
export const HookOutcome = {
  Success: "success",
  Blocked: "blocked",
  Failed: "failed",
  Cancelled: "cancelled",
  TimedOut: "timed_out",
} as const;

export type HookOutcome = (typeof HookOutcome)[keyof typeof HookOutcome];

/**
 * hook 声明的来源层级，用于信任与展示口径。
 *
 * producer：配置发现器按 user/plugin/project/internal 归类；consumer：
 * UI 展示来源、信任评估与日志。项目级 hook 必须经过工作区信任审查；
 * internal 是内置 hook，不来自用户可写文件，不能与 project 混为一谈。
 */
export const HookSourceKind = {
  User: "user",
  Plugin: "plugin",
  Project: "project",
  Internal: "internal",
} as const;

export type HookSourceKind = (typeof HookSourceKind)[keyof typeof HookSourceKind];

/**
 * 单个 hook 配置在运行时的来源标注（只存在于 runtime，不写回公共配置）。
 *
 * 生产者是配置合流/校验阶段，把"这条规则从哪个文件来"附到已校验对象上；
 * 消费者是审查与遥测。path 只用于诊断与信任绑定，不能进入模型上下文；
 * 公共 schema 会刻意剥离它，避免把本地路径泄露给插件或模型。
 */
/** Runtime-only provenance attached after user/plugin config validation. */
export interface HookConfigSource {
  kind: "user" | "project" | "internal";
  path?: string;
}

/**
 * 可安全下发给客户端的 hook 执行描述（脱敏后的元数据）。
 *
 * 生产者是 runner，在真正执行前组装；消费者是 UI 事件与远程投影。
 * 不变量：绝不能包含未脱敏 command、stdin/stdout 或环境变量——这里只允许
 * commandDisplay（展示用）、超时与来源。executionType 决定 UI 画进程卡还是
 * shell 卡，executionMode=background 表示不阻塞当前工具链。
 */
/** Client-safe metadata. Unredacted commands and execution IO must never be added here. */
export interface HookExecutionDescriptor {
  clientVisible: boolean;
  sourceKind: HookSourceKind;
  sourcePath?: string;
  pluginId?: string;
  pluginName?: string;
  statusMessage?: string;
  executionType: "process" | "command";
  executionMode: "foreground" | "background";
  commandDisplay: string;
  timeoutMs: number;
}

/**
 * hook 对权限请求给出的裁决词表（PreToolUse/PermissionRequest）。
 *
 * 生产者是 hook 进程输出经 schema 归一化；消费者是权限流。
 * 安全不变量：hook 只能收紧，不能放宽——allow 仍要经过权限系统与用户审批，
 * deny 则是硬拒绝；ask 表示强制弹窗。三者都不能绕过 guarded 输入冻结。
 */
export const HookPermissionDecision = {
  Allow: "allow",
  Ask: "ask",
  Deny: "deny",
} as const;

export type HookPermissionDecision =
  (typeof HookPermissionDecision)[keyof typeof HookPermissionDecision];

/**
 * 所有 hook 输入共享的会话/追踪信封。
 *
 * 生产者是 runner（在每个分发点用当前执行上下文填充）；消费者是 hook
 * 子进程（作为 JSON 输入）与审计。cwd/mode/sessionId/traceId 是身份事实：
 * hook 不能自行改写，runner 必须原样传递，否则 hook 内的日志无法归属到
 * 同一条 trace；turnId 在非 turn 事件（如 SessionStart）可为空。
 */
export interface BaseHookInput {
  agentName?: string;
  cwd: string;
  hookEventName: HookEventName;
  mode: CollaborationMode;
  sessionId: SessionId;
  timestamp: string;
  traceId: TraceId;
  turnId?: TurnId;
}

/**
 * PreToolUse 输入：工具执行前的完整调用事实。
 *
 * 生产者是工具执行器（在 handler 动手之前组装，故此时尚未产生副作用）；
 * 消费者是 hook 进程与权限流。riskLevel/sideEffectScope 是"解析后"的能力，
 * 不是静态标签——hook 据此决定是否拦截；toolInput 必须是即将执行的最终入参，
 * 不能是未经 hook 修改的旧值。
 */
export interface PreToolUseHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreToolUse;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

/**
 * PermissionRequest 输入：权限弹窗即将出现时的请求快照。
 *
 * 生产者是权限流；消费者是 hook 与 UI。requestId 是本次请求的身份（同一
 * toolCallId 可能多次重判），permissionSuggestions 是可选的持久授权建议。
 * hook 只能返回 allow/deny 与（受限的）permissionUpdates，不能自行放行
 * 未经用户确认的 guarded 输入。
 */
export interface PermissionRequestHookInput extends BaseHookInput {
  permissionSuggestions?: PermissionUpdate[];
  hookEventName: typeof HookEventName.PermissionRequest;
  reason: string;
  requestId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

/**
 * PostToolUse 输入：工具已成功返回后的事实。
 *
 * 生产者是执行器（在结果序列化后组装）；消费者是 hook（做格式化/审计）。
 * toolResultPreview 是有界预览，不是模型可见全文；artifactRefs 指向落盘
 * 大结果。此时副作用已经发生，hook 只能追加 context 或阻断后续流程，
 * 不能让本次调用"当作没执行"。
 */
export interface PostToolUseHookInput extends BaseHookInput {
  artifactRefs?: string[];
  hookEventName: typeof HookEventName.PostToolUse;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
  toolResponse: unknown;
  toolResultPreview: string;
}

/**
 * PostToolUseFailure 输入：工具执行链失败后的归因事实。
 *
 * 生产者是执行器；消费者是 hook 与遥测。isInterrupt 区分"用户取消"与
 * "真实失败"：取消不应被 hook 当成可重试错误。error.type 是稳定分类，
 * message 仅供展示，不能用于流程判断。
 */
export interface PostToolUseFailureHookInput extends BaseHookInput {
  error: {
    message: string;
    type: string;
  };
  hookEventName: typeof HookEventName.PostToolUseFailure;
  isInterrupt?: boolean;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

/**
 * UserPromptSubmit 输入：用户提交提示词后、进入模型前的拦截点。
 *
 * 生产者是 turn 输入处理；消费者是 hook（改写/补充上下文/阻断）。
 * prompt 是即将进入模型的文本，attachmentsSummary 只给摘要（不把附件内容
 * 泄露给 hook）。此处的阻断等价于拒绝本轮输入，不会产生 user message。
 */
export interface UserPromptSubmitHookInput extends BaseHookInput {
  attachmentsSummary?: string;
  hookEventName: typeof HookEventName.UserPromptSubmit;
  prompt: string;
}

/**
 * SessionStart 输入：会话创建/恢复/清空/压缩后的启动时点。
 *
 * 生产者是 resume/create 路径；消费者是 hook（注入环境提示）。
 * source 说明本次启动属于哪种语义：resume 不能假设进程内状态仍在，
 * compact 之后 hook 看到的是压缩后的上下文，而不是旧消息全集。
 */
export interface SessionStartHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.SessionStart;
  model?: string;
  source: "startup" | "resume" | "clear" | "compact";
}

/**
 * Stop 输入：一轮结束、准备把控制权交还用户时的拦截点。
 *
 * 生产者是 turn 收尾；消费者是 hook（要求继续工作或放行）。
 * stopHookActive 表示本 turn 已因 hook 续跑过一次，防止无限 Stop 循环；
 * responsePreview 有界，responseText 可选——不要把完整回复无条件塞进
 * hook 进程（大回复会拖垮执行）。
 */
export interface StopHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.Stop;
  responsePreview: string;
  responseText?: string;
  stopHookActive: boolean;
  toolCallCount: number;
}

/**
 * 所有 hook 输入的判别联合：以 hookEventName 为判别键。
 *
 * 生产者/消费者是 runner 的分发逻辑。新增事件时若不加入此联合，
 * TypeScript 侧的分发会退化成 unknown，运行时只能靠字符串判断——这正是
 * 事件白名单与 schema 必须同步的原因。
 */
export type HookInput =
  | PreToolUseHookInput
  | PermissionRequestHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | StopHookInput;

/**
 * PermissionRequest hook 的裁决结果。
 *
 * allow 可附带 permissionUpdates/updatedPermissions（只能新增规则，且仍需
 * 经过权限系统）与 updatedInput（被 hook 改写后的入参，必须重新校验）；
 * deny 可带 interrupt 提前中止本轮。不变量：这里的 allow 不是最终放行，
 * 只是"不反对"，用户审批与 deny 规则仍然优先生效。
 */
export type PermissionRequestHookDecision =
  | {
      behavior: "allow";
      permissionUpdates?: PermissionUpdate[];
      updatedPermissions?: PermissionUpdate[];
      updatedInput?: unknown;
    }
  | {
      behavior: "deny";
      interrupt?: boolean;
      message?: string;
    };

/**
 * hook 按事件类型返回的结构化输出（hookSpecificOutput 的联合）。
 *
 * 判别键是 hookEventName，跨进程传递时必须与输入事件一致；否则 runner
 * 会忽略或报错。additionalContext 会作为额外上下文注入，不能借此注入
 * 系统提示或伪造用户消息——注入点在调用方统一处理。
 */
export type HookSpecificOutput =
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PreToolUse;
      permissionDecision?: HookPermissionDecision;
      permissionDecisionReason?: string;
      updatedInput?: unknown;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.UserPromptSubmit;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.SessionStart;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolUse;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolUseFailure;
    }
  | {
      decision?: PermissionRequestHookDecision;
      hookEventName: typeof HookEventName.PermissionRequest;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.Stop;
    };

/**
 * hook 进程 stdout 的顶层 JSON 输出契约（兼容 Claude 风格字段）。
 *
 * 生产者是第三方 hook 脚本；消费者是 runner 的 schema 解析。字段别名
 * （additionalContext/additional_context）是为兼容既有脚本，解析时归一成
 * 一个内部字段；decision 只允许 approve/block，未知字段被 schema 丢弃，
 * 不能让脚本用任意键偷偷影响权限。
 */
export interface HookJSONOutput {
  additionalContext?: string;
  additional_context?: string;
  continue?: boolean;
  decision?: "approve" | "block";
  hookSpecificOutput?: HookSpecificOutput;
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
}

const PermissionRequestHookDecisionSchema = z.union([
  z.object({
    behavior: z.literal("allow"),
    permissionUpdates: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedPermissions: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    interrupt: z.boolean().optional(),
    message: z.string().optional(),
  }),
]);

/**
 * HookSpecificOutput 的运行时校验版本，必须与上方类型联合保持同形。
 *
 * 生产者是 hook 脚本输出；消费者是 runner。为什么需要它：hook 是跨进程的
 * 不可信输入，TypeScript 类型在运行时不存在，必须逐事件判别校验后才能用于
 * 权限/上下文注入。schema 与类型漂移会让"类型上合法、运行时缺字段"。
 */
export const HookSpecificOutputSchema = z.discriminatedUnion("hookEventName", [
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PreToolUse),
    permissionDecision: z.enum(["allow", "ask", "deny"]).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.UserPromptSubmit),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.SessionStart),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolUse),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolUseFailure),
  }),
  z.object({
    decision: PermissionRequestHookDecisionSchema.optional(),
    hookEventName: z.literal(HookEventName.PermissionRequest),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.Stop),
  }),
]);

/**
 * HookJSONOutput 的运行时校验：hook 进程 stdout 的唯一解析入口。
 *
 * 消费者是 runner。未知键被 zod 默认剥离（不是拒绝整份输出），保证旧脚本
 * 新增字段不会让 hook 整体失败；但决定权限/输入的字段必须通过严格校验。
 * 解析失败应归为 failed/timed_out，而不是当成空输出继续执行。
 */
export const HookJSONOutputSchema = z.object({
  additionalContext: z.string().optional(),
  additional_context: z.string().optional(),
  continue: z.boolean().optional(),
  decision: z.enum(["approve", "block"]).optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
});

/**
 * 插件提供 hook 时的身份与路径上下文（只在运行时附加）。
 *
 * 生产者是插件加载器；消费者是 runner 与审查展示。rootPath/dataPath 是
 * 插件自己的目录，不是工作区；sourcePath 指向实际 hooks.json/manifest。
 * 这些路径不得进入模型上下文或公共事件字段（只用于执行与诊断）。
 */
export interface HookPluginContext {
  dataPath: string;
  id: string;
  name: string;
  rootPath: string;
  /** Actual hooks.json/manifest source. Other plugin consumers may omit it. */
  sourcePath?: string;
}

/**
 * command 型 hook 的配置：经 shell 执行一段命令。
 *
 * 生产者是配置文件解析；消费者是 runner。timeout 是旧字段（秒），
 * timeoutMs 是毫秒口径，runner 必须归一后再用；shell=true 表示用默认 shell，
 * 传字符串则指定 shell 路径。source 是 runtime-only，公共 schema 会剥离。
 */
export interface HookCommandConfig {
  async?: boolean;
  command: string;
  enabled?: boolean;
  plugin?: HookPluginContext;
  shell?: true | string;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command";
}

/**
 * process 型 hook 的配置：直接 spawn 可执行文件，不经过 shell。
 *
 * 与 command 型的差别是可避免 shell 注入与引号/平台差异；args 必须按
 * 参数数组传递，不能拼成命令字符串。enabled 缺省视为启用，timeoutMs
 * 由 runner 与全局上限取较小值。
 */
export interface HookProcessConfig {
  args?: string[];
  command: string;
  enabled?: boolean;
  plugin?: HookPluginContext;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  type: "process";
}

/**
 * 单个 hook 声明的判别联合（按 type 区分 command/process）。
 *
 * 生产者/消费者：配置解析与 runner 分发。新增执行形态时必须同时扩展
 * 这里与 HookConfigSchema，并让 runner 的 spawn 分支显式处理，不能落进
 * 默认 command 分支（那会把未审查的新形态当成 shell 执行）。
 */
export type HookConfig = HookCommandConfig | HookProcessConfig;

/**
 * 一个 matcher 下的一组 hook：matcher 只做"是否参与"的粗筛。
 *
 * 生产者是配置解析；消费者是 runner 的事件分发。matcher 语法属于配置
 * 契约（例如工具名匹配），不匹配时整组跳过；hooks 至少一项，空组在
 * schema 阶段即拒绝。
 */
export interface HookMatcherConfig {
  hooks: HookConfig[];
  matcher?: string;
}

/**
 * 生效后的 hook 运行时配置（已合并所有层级、已套用默认值）。
 *
 * 生产者是配置合流；消费者是 runner。enabled 是总开关，false 时任何事件
 * 都不执行（但配置本身仍可被审查）；timeoutMs/maxOutputBytes 作为单条
 * hook 的上限基线，单条配置只能更小不能更大。
 */
export interface HooksRuntimeConfig {
  enabled: boolean;
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

/**
 * hook 配置的增量补丁（UI/设置写入用），语义是"只改列出的字段"。
 *
 * 与 HooksRuntimeConfig 的区别：这里是 partial，缺失 = 不改；events 若出现
 * 则按事件覆盖该事件的 matcher 列表，而不是与旧列表深合并（深合并会让
 * 用户无法删除某条 hook）。写入后仍要重新走信任审查。
 */
export interface HooksRuntimeConfigPatch {
  enabled?: boolean;
  events?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

/**
 * 单次 hook 运行的生命周期事件载荷（started/progress/completed/failed/blocked）。
 *
 * 生产者是 runner；消费者是事件投影、UI 时间线与遥测。hookRunId 是本次
 * 执行的身份，hookInvocationId 关联同一分发批次；descriptor 是脱敏展示
 * 信息（新事件必带，旧事件可缺）；stdoutPreview/stderrPreview 有界，
 * outputBytes/truncated 说明是否被截断。outcome 只在终态事件出现。
 */
export interface HookRunLifecyclePayload {
  agentName?: string;
  /** New events always carry this; optional keeps old persisted events replayable. */
  descriptor?: HookExecutionDescriptor;
  /** Sanitized human-readable reason when the Hook itself blocked execution. */
  blockReason?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hookEventName: HookEventName;
  hookIndex: number;
  hookCount?: number;
  hookInvocationId?: string;
  hookRunId: string;
  hookSource?: string;
  matcher?: string;
  outcome?: HookOutcome;
  outputBytes?: number;
  requestId?: string;
  startedAt?: number;
  stderrPreview?: string;
  stdoutPreview?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  truncated?: boolean;
}

/**
 * process 型 hook 的落盘 schema（直接 spawn 可执行文件，不经 shell）。
 *
 * 生产者是用户/插件配置；消费者是配置校验与 workspace 信任的字段白名单。
 * 不变量：args 是参数数组而非拼接字符串，command 不得含 shell 语法；
 * timeoutMs 只能是正整数（0/负数会让 runner 无法建立超时边界）；
 * enabled 缺省视为继承父层，不是"已启用"。
 */
export const HookProcessConfigSchema = z.object({
  type: z.literal("process"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

/**
 * command 型 hook 的落盘 schema（经 shell 执行一条命令）。
 *
 * 与 process 的差异是引入了 shell 语义：shell=true 用系统默认 shell，
 * 传字符串则指定解释器；async=true 表示不阻塞主工具链（结果只能事后观察）。
 * 注意 timeout（秒级兼容旧配置）与 timeoutMs（毫秒）并存：解析时须归一，
 * 不能让两者同时生效导致"两个超时"互相矛盾。
 */
export const HookCommandConfigSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  async: z.boolean().optional(),
  shell: z.union([z.literal(true), z.string().min(1)]).optional(),
  timeout: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

/**
 * 单条 hook 声明的运行时可校验判别联合（type=process/command）。
 *
 * 判别键 type 决定 runner 走 spawn 还是 shell 分支，必须是闭集：新增形态
 * 若只加进联合而没在 runner 显式处理，会被静默当成 command 执行，等于
 * 绕过该形态的安全审查。配置读取端与 workspace 信任审查共用本 schema。
 */
export const HookConfigSchema = z.discriminatedUnion("type", [
  HookProcessConfigSchema,
  HookCommandConfigSchema,
]);

/**
 * matcher 分组的落盘 schema：一个可选的匹配表达式 + 至少一条 hook。
 *
 * 生产者是配置解析；消费者是 runner 的事件分发。hooks 的 min(1) 是硬约束——
 * 空分组没有任何执行项却仍会参与审查，属于自相矛盾的配置，必须在读取阶段
 * 拒绝而不是运行时跳过。matcher 为空表示"无条件参与"，不是"匹配所有工具名"
 * 的另一种写法。
 */
export const HookMatcherConfigSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookConfigSchema).min(1),
});

/**
 * 增量补丁的落盘 schema：只描述"要改的字段"，缺失即不改。
 *
 * 与 HooksRuntimeConfig 的关键差异是 events 用 strict 对象逐事件列出，
 * 未知事件键直接拒绝（防止拼错事件名后静默无效）；且每个事件的数组是
 * 整体替换语义，不与旧列表深合并——深合并会让用户无法删除已有 hook。
 * 落盘写入后必须重新走工作区信任审查，补丁本身不携带信任结论。
 */
export const HooksRuntimeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  events: z
    .object({
      SessionStart: z.array(HookMatcherConfigSchema).optional(),
      UserPromptSubmit: z.array(HookMatcherConfigSchema).optional(),
      PreToolUse: z.array(HookMatcherConfigSchema).optional(),
      PermissionRequest: z.array(HookMatcherConfigSchema).optional(),
      PostToolUse: z.array(HookMatcherConfigSchema).optional(),
      PostToolUseFailure: z.array(HookMatcherConfigSchema).optional(),
      Stop: z.array(HookMatcherConfigSchema).optional(),
    })
    .strict()
    .optional(),
});

/**
 * 无任何配置时的运行时兜底值（也是安全默认：默认全关）。
 *
 * enabled=false 表示"没配置就不执行"，用户必须显式启用并接受信任审查。
 * maxOutputBytes/timeoutMs 是可被单条 hook 收紧、不可放宽的基线上限：
 * 单条配置超过基线应按基线截断，而不是信任配置里的更大值。
 */
export const DefaultHooksRuntimeConfig: HooksRuntimeConfig = {
  enabled: false,
  events: {},
  maxOutputBytes: 32768,
  timeoutMs: 60000,
};

export * from "./workspace-hook-trust.js";
export * from "./workspace-hook-trust-store.js";
