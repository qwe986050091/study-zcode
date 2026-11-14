// ============================================================
// Plan Mode Tools - plan approval flow
// ============================================================
// 本文件只声明进入/退出计划模式的契约：两个空/有入参 schema、输出快照、以及会话模式端口
// 的接口形状。真正的状态切换与计划落盘在 core 的 handlers/plan-mode.ts。
// 进入（EnterPlanMode）：只把会话切到 plan 模式并收紧后续权限，本身不产生写副作用，因此
// needsApproval=false；进入后的只读约束由权限层按 planEnabled 生效，不在契约层实现。
// 退出（ExitPlanMode）：必须携带已批准的计划正文；handler 的顺序不变量是"先写计划文件，
// 再切模式"——反过来会让写盘失败时用户已离开 plan 模式、计划只剩在上下文里。
// 模式词汇表：plan/build/edit/yolo/guarded/auto；退出后不可能是 plan，这一限制写在
// ExitPlanModeTransitionResult 的类型里，而不只写在文案里。

import { z } from "zod";
import type { CollaborationMode } from "../interfaces/session.port.js";
import type { TraceContext } from "../tracing/tracer.js";
import { toToolJsonSchema } from "./json-schema.js";

// 两个工具注册名，同时是权限规则、事件与 UI 投影的判别键；必须与 core handler 注册项的
// metadata.name 一致，改名会让已保存的权限规则失配。
export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
// 退出工具的注册名；它本身是一次用户审批动作，注册项 needsApproval=true。
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

// 计划正文的字符上限。空白校验只看 trim 后的内容，但 schema 不做 transform——计划文件需要
// 保存最终批准的原始字符串，任何改写都会让用户看到的与落盘的文本不一致。
export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

// EnterPlanMode 没有业务入参：strict 让任何多余字段成为可见错误，避免模型误把它当成
// "顺带带上模式/权限"的入口。
export const EnterPlanModeInputSchema = z.object({}).strict();
// 空入参类型；handler 仍 parse 一次以走统一运行时校验。
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;
// provider 可见的空入参 schema。
export const EnterPlanModeInputJsonSchema = toToolJsonSchema(EnterPlanModeInputSchema);

// 进入计划的输出快照：一句话确认 + 切换前后的 mode/planEnabled 四元组。四元组让 UI 与事件
// 投影能回答"从哪来到哪去"，而不是只看到最终模式；planEnabled 是"当前是否处于计划约束下"
// 的权威口径，可能比 mode 更精确，因此两者都保留。
export const EnterPlanModeOutputSchema = z
  .object({
    // 给模型的确认文案；非空，避免空白结果。
    message: z.string().min(1).describe("Confirmation that plan mode was entered."),
    // 进入前的模式；可能与 planEnabled 不一致（模式被临时覆盖时）。
    previousMode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto"])
      .describe("Session mode before EnterPlanMode ran."),
    // 进入后的模式，正常情况下恒为 "plan"；枚举完整保留是为了与端口返回值对齐而不裁剪。
    mode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto"])
      .describe("Current permission mode."),
    // 进入后的计划约束开关；旧端口可能不提供，因此可选。
    planEnabled: z.boolean().optional(),
    // 进入前的计划约束开关；用于回滚/展示前后差异，旧端口可能不提供。
    previousPlanEnabled: z.boolean().optional(),
  })
  .strict();
// 输出类型；handler 用 satisfies 构造，可选字段由端口透传决定是否在场。
export type EnterPlanModeOutput = z.infer<typeof EnterPlanModeOutputSchema>;
// provider 可见的进入输出 schema，用于跨进程回放校验。
export const EnterPlanModeOutputJsonSchema = toToolJsonSchema(EnterPlanModeOutputSchema);

// 随计划批准一起回传给下游的预设授权范围。它描述"类别"而不是具体命令（"run tests" 而不是
// `npm test`），这样批准一次计划不会把某条命令永久钉死。当前只对 Bash 开放。
export const ExitPlanModeAllowedPromptSchema = z
  .object({
    // 授权适用的工具；只允许 Bash，防止把语义化授权扩散到任意工具。
    tool: z.enum(["Bash"]).describe("The tool this prompt applies to"),
    // 动作的语义描述；由下游权限层解释，本契约层不解析、不执行。
    prompt: z
      .string()
      .describe('Semantic description of the action, e.g. "run tests", "install dependencies"'),
  })
  .strict();
// 单项授权类型；批准后原样回显露给模型与 UI。
export type ExitPlanModeAllowedPrompt = z.infer<typeof ExitPlanModeAllowedPromptSchema>;

// plan file 需要保存最终批准的原始字符串；空白校验只看 trim 后内容，不在 schema transform 阶段改写 plan。
const ExitPlanModePlanSchema = z
  .string()
  .min(1)
  .max(PLAN_MODE_MAX_PLAN_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "String must contain at least 1 character(s)",
  })
  .describe("The implementation plan to present to the user for approval.");

// 退出计划模式的入参。用 catchall 而不是 strict：旧客户端可能携带额外字段（如历史版本
// 的 display 元数据），这里要容忍它们进入回放，而不是让一次已经发生的批准在校验时失败。
export const ExitPlanModeInputSchema = z
  .object({
    // 完整计划正文；1 起、上限 20k 字符，且 trim 后必须非空（纯空白不算计划）。
    plan: ExitPlanModePlanSchema,
    // 可选预设授权；只是随批准回传给下游，本层不据此执行任何操作。
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
  })
  .catchall(z.unknown());
// 退出入参类型；handler 用它取值，plan 保持原始字符串。
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;
// provider 可见的退出入参 schema；catchall 的宽松面在投影中体现为不禁止额外键。
export const ExitPlanModeInputJsonSchema = toToolJsonSchema(ExitPlanModeInputSchema);

// 退出计划的输出快照：已批准计划原文 + 切换前后模式 + 授权回显。approved 是字面量 true，
// 因为"未批准"不是成功输出的一部分——用户拒绝会走另一条路径，本 schema 只描述成功形。
export const ExitPlanModeOutputSchema = z
  .object({
    // 已批准的计划原文（可能为 null，来自旧客户端/空计划）；用于回灌给模型，避免它回翻上下文。
    plan: z.string().nullable().describe("The plan that was approved by the user."),
    // 恒为 true；本 schema 只表达"批准并退出成功"这一种结果。
    approved: z.literal(true).describe("True when the user approved exiting plan mode."),
    // 退出前的模式（正常为 plan，但用完整枚举与端口对齐）。
    previousMode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto"])
      .describe("Previous permission mode."),
    // 退出后的计划约束开关；旧端口可能不提供。
    planEnabled: z.boolean().optional(),
    // 退出前的计划约束开关；用于展示前后差异。
    previousPlanEnabled: z.boolean().optional(),
    // 退出后的模式；刻意排除 "plan"——退出后不可能仍处于 plan。
    mode: z
      .enum(["build", "edit", "yolo", "guarded", "auto"])
      .describe("Current session mode after exiting plan mode."),
    // 随批准回传的预设授权；入参有则原样回显，缺席表示未申请。
    allowedPrompts: z.array(ExitPlanModeAllowedPromptSchema).optional(),
  })
  .strict();
// 退出输出类型；handler 用 satisfies 构造，可选字段由入参与端口决定。
export type ExitPlanModeOutput = z.infer<typeof ExitPlanModeOutputSchema>;
// provider 可见的退出输出 schema，用于跨进程回放校验。
export const ExitPlanModeOutputJsonSchema = toToolJsonSchema(ExitPlanModeOutputSchema);

// 模式切换的调用上下文：toolCallId 用于把这次切换关联到产生它的工具调用（事件/审计），
// traceContext 让状态切换的 span 能挂到当前 turn 的链路。两者都可选——端口实现可以只关心模式。
export interface SessionModeTransitionInput {
  // 触发本次切换的 tool_call id；用于事件归因与 UI 关联。
  toolCallId?: string;
  // 本次切换的追踪上下文；缺失时端口不应自行编造，按无追踪处理。
  traceContext?: TraceContext;
}

// 进入计划模式的转换结果：端口只回事实（切换前后模式与 planEnabled），不返回文案或 UI 指令，
// 文案由 handler 生成。planEnabled 可选以兼容尚未提供该开关的旧端口。
export interface EnterPlanModeTransitionResult {
  // 进入后的模式；正常为 "plan"，但类型保留完整集合以与端口实现对齐。
  mode: CollaborationMode;
  // 进入前的模式；用于展示"从哪来"。
  previousMode: CollaborationMode;
  // 进入后的计划约束开关；旧端口可能不提供。
  planEnabled?: boolean;
  // 进入前的计划约束开关；旧端口可能不提供。
  previousPlanEnabled?: boolean;
}

// 退出计划模式的转换结果：mode 用 Exclude 把 "plan" 从类型层排除，退出后仍处于 plan 在编译期
// 就是错误，而不是等到运行时才被 UI 发现。
export interface ExitPlanModeTransitionResult {
  // 退出后的模式，类型上不可能为 "plan"。
  mode: Exclude<CollaborationMode, "plan">;
  // 退出前的模式（正常为 "plan"）。
  previousMode: CollaborationMode;
  // 退出后的计划约束开关；旧端口可能不提供。
  planEnabled?: boolean;
  // 退出前的计划约束开关。
  previousPlanEnabled?: boolean;
}

// 会话模式端口：计划模式工具唯一的模式写入口。契约要求副作用集中在 enter/exit 两个方法上，
// 工具 handler 不得直接改内存态或发事件——否则会出现"工具返回了 next 快照、execution-state
// 却没更新"的第二真相源。getPrePlanMode 用于退出时恢复进入前的模式；isPlanEnabled 是判断
// "是否处于计划约束"的优先口径，缺省时才退回 mode 比较。
export interface SessionModePort {
  // 可选能力查询：宿主是否支持"权限完全放行"档；只用于 UI/能力协商，不改变模式。
  supportsPermissionFullAccess?(): boolean;
  // 可选：当前的计划约束开关。它是比 getMode()==="plan" 更权威的口径（模式可能被临时覆盖）。
  isPlanEnabled?(): boolean;
  // 读取当前模式；这是只读快照，不做切换。
  getMode(): CollaborationMode;
  // 读取进入 plan 之前的模式；从未进入过时为 undefined，退出时用它恢复。
  getPrePlanMode(): Exclude<CollaborationMode, "plan"> | undefined;
  // 进入计划模式：唯一写入口，返回切换前后快照；失败由端口抛错，handler 原样上抛。
  enterPlanMode(input?: SessionModeTransitionInput): Promise<EnterPlanModeTransitionResult>;
  // 退出计划模式：唯一写入口；调用方必须先完成计划落盘，端口本身不负责文件。
  exitPlanMode(input?: SessionModeTransitionInput): Promise<ExitPlanModeTransitionResult>;
}
