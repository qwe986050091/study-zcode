// ============================================================
// Bash Tool - Shell Execution Tool
// ============================================================
// Reference: shell tool input / output shape

import { z } from "zod";
import { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

/**
 * 模型可申请的 timeout 上限（毫秒）。契约层用它生成描述，core 的
 * bash-timeout-policy 用它做最终 clamp；改这里必须同步两侧，否则模型看到的上限会撒谎。
 */
const MAX_BASH_TIMEOUT_MS = 600_000;
const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);
const BASH_DESCRIPTION_FIELD_PROMPT = [
  'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.',
  "",
  "For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):",
  '- ls → "List files in current directory"',
  '- git status → "Show working tree status"',
  '- npm install → "Install package dependencies"',
  "",
  "For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:",
  '- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"',
  '- git reset --hard origin/main → "Discard all local changes and match remote main"',
  "- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
].join("\n");

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

/**
 * Bash 入参 schema：模型面唯一可填 command / timeout / description /
 * run_in_background / dangerouslyDisableSandbox，`.strict()` 拒绝任何额外字段。
 * timeout 经 semanticNumber 接受数字字符串，但真正的 600s 上限由 core 的
 * bash-timeout-policy 再按 policy 解析（本文件常量只用于向模型描述）。
 * 只读与否**不**在此声明：core 的 resolvePermissionCapability 按命令内容判定。
 */
export const BashInputSchema = z
  .object({
    command: z.string().describe("The command to execute"),
    /**
     * Optional timeout in milliseconds (max 600000)
     */
    timeout: semanticNumber(z.number())
      .optional()
      .describe(`Optional timeout in milliseconds (max ${MAX_BASH_TIMEOUT_MS})`),
    /**
     * Clear, concise description of what this command does in active voice.
     * Never use words like "complex" or "risk" in the description - just describe what it does.
     *
     * For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
     * - ls → "List files in current directory"
     * - git status → "Show working tree status"
     * - npm install → "Install package dependencies"
     *
     * For commands that are harder to parse at a glance (piped commands, obscure flags, etc.),
     * add enough context to clarify what it does:
     * - find . -name "*.tmp" -exec rm {} \; → "Find and delete all .tmp files recursively"
     * - git reset --hard origin/main → "Discard all local changes and match remote main"
     * - curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"
     */
    description: z.string().optional().describe(BASH_DESCRIPTION_FIELD_PROMPT),
    /**
     * Set to true to run this command in the background. Use Read to read the output later.
     */
    run_in_background: semanticBoolean()
      .optional()
      .describe("Set to true to run this command in the background."),
    /**
     * Set this to true to dangerously override sandbox mode and run commands without sandboxing.
     */
    dangerouslyDisableSandbox: semanticBoolean()
      .optional()
      .describe(
        "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
      ),
  })
  .strict();

/** 从 zod 推得的执行入参；执行器已把字符串布尔/数字归一成真实类型后再交给 handler。 */
export type BashInput = z.infer<typeof BashInputSchema>;

/** 交给 provider/模型的 JSON schema；timeout 的描述由 core 按实际 policy 再覆盖一次。 */
export const BashInputJsonSchema = toToolJsonSchema(BashInputSchema);

function semanticNumber(schema: z.ZodNumber): z.ZodEffects<z.ZodNumber, number, unknown> {
  // 用 preprocess 在 schema 校验之前做形状归一：模型面经常把数字写成字符串（"30000"），
  // 必须在类型判定前转成 number，否则合法的超时值会被判成类型错误。
  return z.preprocess((value) => {
    // 非字符串原样透传：number / null / undefined 交给 schema 自己判类型，
    // 这里提前报错会丢掉 zod 的字段路径，上层无法把错误定位到具体入参。
    if (typeof value !== "string") return value;
    // 先 trim 再判空：模型偶尔发纯空白串；空串必须原样透传，让 schema 报"值非法"，
    // 而不是被 Number("")=0 悄悄变成 0 毫秒（等价于立刻超时）。
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    // 只接受能转成有限数字的字符串；Number("1e3")=1000、"0x10"=16 也放行，
    // 这是 JS 语义，且 core 侧还会按 policy clamp 到 600000，不会越界。
    const parsed = Number(trimmed);
    // 转不成有限数（"abc"、Infinity）时回退原始字符串：让 schema 报错时展示模型
    // 实际发送的内容，便于区分"模型笔误"与"字段拼错"。
    return Number.isFinite(parsed) ? parsed : value;
  }, schema);
}

function semanticBoolean(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
  // 同样是 preprocess 归一：布尔字段常被模型写成 "true"/"1"，直接交给 z.boolean()
  // 会被拒绝，而这里只放宽"字符串/数字的字面表达"，不放宽语义。
  return z.preprocess((value) => {
    // 真布尔直接返回，保持原始值语义，避免二次转换引入歧义。
    if (typeof value === "boolean") return value;
    // 数字只认 1/0：其它数字必须在下方原样返回，让 schema 报类型错误，
    // 不能把 2 之类的值猜成 true（会让"关闭沙箱"这类危险开关被误开）。
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    // 非字符串（对象、数组、null）原样透传，由 schema 产出类型错误与字段路径。
    if (typeof value !== "string") return value;

    // 大小写与空白都归一：模型输出 " TRUE "、"Yes" 都应视为 true，
    // 否则同一个意图会因排版差异被拒绝。
    const normalized = value.trim().toLowerCase();
    // 白名单而非"非空即真"：只有明确列举的字面量才算 true，
    // 防止 "no"、"off" 这类否定词被真值判断误判成开启。
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    // 白名单外原样返回：让 schema 报错并回显原始字符串，而不是静默变成 false。
    return value;
  }, z.boolean());
}

// -----------------------------------------------
// Output Types
// -----------------------------------------------

/**
 * Bash 输出（handler 产出、executor 投影）：stdout/stderr 是已按预算截断的文本，
 * `stdoutBytes`/`stderrBytes` 是观测到的原始总量，截断位与持久化路径成对出现。
 * `status` 是结构化终态（非零退出不是异常），`exitCode`/`signal` 保留进程事实；
 * `backgroundTaskId` 是后台命令与 TaskOutput/任务通知的关联键。
 * `interrupted` 恒在场，表示命令被取消/超时打断；`persistedOutputPath` 只在大输出落盘时出现。
 */
export interface BashOutput {
  /**
   * The standard output of the command
   */
  stdout: string;
  /**
   * The standard error output of the command
   */
  stderr: string;
  /**
   * Structured execution status
   */
  status?: "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error" | "backgrounded";
  /**
   * Process exit code. Non-zero exits are represented here instead of thrown.
   */
  exitCode?: number;
  /**
   * Process exit signal, when available
   */
  signal?: string;
  /**
   * Whether timeout policy stopped the command
   */
  timedOut?: boolean;
  /**
   * Whether cancellation stopped the command
   */
  cancelled?: boolean;
  /**
   * Whether stdout was truncated for inline return
   */
  stdoutTruncated?: boolean;
  /**
   * Whether stderr was truncated for inline return
   */
  stderrTruncated?: boolean;
  /**
   * Total stdout bytes observed
   */
  stdoutBytes?: number;
  /**
   * Total stderr bytes observed
   */
  stderrBytes?: number;
  /**
   * Path to raw output file for large MCP tool outputs
   */
  rawOutputPath?: string;
  /**
   * Whether the command was interrupted
   */
  interrupted: boolean;
  /**
   * Flag to indicate if stdout contains image data
   */
  isImage?: boolean;
  /**
   * ID of the background task if command is running in background
   */
  backgroundTaskId?: string;
  /**
   * True if the user manually backgrounded the command with Ctrl+B
   */
  backgroundedByUser?: boolean;
  /**
   * True if assistant-mode auto-backgrounded a long-running blocking command
   */
  assistantAutoBackgrounded?: boolean;
  /**
   * Flag to indicate if sandbox mode was overridden
   */
  dangerouslyDisableSandbox?: boolean;
  /**
   * Semantic interpretation for non-error exit codes with special meaning
   */
  returnCodeInterpretation?: string;
  /**
   * Whether the command is expected to produce no output on success
   */
  noOutputExpected?: boolean;
  /**
   * Structured content blocks
   */
  structuredContent?: unknown[];
  /**
   * Path to the persisted full output in tool-results dir (set when output is too large for inline)
   */
  persistedOutputPath?: string;
  /**
   * Path to the persisted stdout stream, when stdout was written to an execution artifact.
   */
  stdoutPersistedOutputPath?: string;
  /**
   * Path to the persisted stderr stream, when stderr was written to an execution artifact.
   */
  stderrPersistedOutputPath?: string;
  /**
   * Total size of the output in bytes (set when output is too large for inline)
   */
  persistedOutputSize?: number;
  /**
   * Persisted stdout artifact bytes, when stdout was written to an execution artifact.
   */
  stdoutPersistedOutputSize?: number;
  /**
   * Persisted stderr artifact bytes, when stderr was written to an execution artifact.
   */
  stderrPersistedOutputSize?: number;
  /**
   * Model-facing note listing readFileState entries whose mtime bumped during this command
   */
  staleReadFileStateHint?: string;
  /**
   * gh 命令触发 GitHub API rate limit 时，追加给模型的 system-reminder。
   */
  ghRateLimitHint?: string;
}

/**
 * Bash 输出的运行时校验 schema；`perf` 是 executor 追加的执行遥测，不属于 handler 返回值。
 * `.strict()` 保证形状变更必须显式提交，避免适配层夹带未声明字段。
 */
export const BashOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    status: z
      .enum(["completed", "failed", "timed_out", "cancelled", "spawn_error", "backgrounded"])
      .optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    rawOutputPath: z.string().optional(),
    interrupted: z.boolean(),
    isImage: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    backgroundedByUser: z.boolean().optional(),
    assistantAutoBackgrounded: z.boolean().optional(),
    dangerouslyDisableSandbox: z.boolean().optional(),
    returnCodeInterpretation: z.string().optional(),
    noOutputExpected: z.boolean().optional(),
    structuredContent: z.array(z.unknown()).optional(),
    persistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    persistedOutputSize: z.number().int().nonnegative().optional(),
    stdoutPersistedOutputSize: z.number().int().nonnegative().optional(),
    stderrPersistedOutputSize: z.number().int().nonnegative().optional(),
    staleReadFileStateHint: z.string().optional(),
    ghRateLimitHint: z.string().optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

/** 交给模型/客户端的 JSON schema；字段与 BashOutputSchema 同源，只是投影格式不同。 */
export const BashOutputJsonSchema = toToolJsonSchema(BashOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

/**
 * 一次 Bash 调用的身份：`id` 是 toolCallId，`traceId` 必须原样来自调用上下文，
 * 事件、日志、结果配对与后台任务都靠这两个键关联；`startedAt` 只用于时长与展示。
 */
export interface BashToolCall {
  id: ToolCallId;
  name: "Bash";
  input: BashInput;
  traceId: TraceId;
  startedAt: Date;
}

/**
 * 一次 Bash 调用的结算：`toolCallId` 必须回指调用行的 id，`output` 已过输出 schema，
 * `durationMs` 是墙钟耗时（含等待审批与后台启动，不含后台运行时间）。
 */
export interface BashToolResult {
  toolCallId: ToolCallId;
  output: BashOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Background Task
// -----------------------------------------------

/**
 * 后台任务登记表的一行：`id` 与 BashOutput.backgroundTaskId 同键，TaskOutput/TaskStop
 * 以它取输出与停任务；`outputPath` 是原始输出落点。`status` 是后台生命周期，
 * 与前台 BashOutput.status 不共享枚举；`completedAt` 只在终态出现。
 */
export interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startedAt: Date;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  completedAt?: Date;
}

// -----------------------------------------------
// Bash Errors
// -----------------------------------------------

/**
 * 稳定的 Bash 错误码：core 的 readonly policy、command parser、执行 adapter 与
 * 权限层各自产出，model-facing 文案不得依赖字符串比较，只认这些码。
 * 它们描述“为什么拒绝/失败”，与 BashOutput.status 的进程终态是两个维度。
 */
export const BashErrorCode = {
  COMMAND_NOT_PARSABLE: "bash_command_not_parsable",
  COMMAND_TOO_COMPLEX: "bash_command_too_complex",
  COMMAND_INJECTION_RISK: "bash_command_injection_risk",
  READONLY_CHECK_FAILED: "bash_readonly_check_failed",
  UNC_PATH_BLOCKED: "bash_unc_path_blocked",
  HIGH_RISK_COMBINATION: "bash_high_risk_combination",
  SANDBOX_VIOLATION: "bash_sandbox_violation",
  TIMEOUT: "bash_timeout",
  USER_INTERRUPTED: "bash_user_interrupted",
  PROCESS_START_FAILED: "bash_process_start_failed",
  NON_ZERO_EXIT: "bash_non_zero_exit",
  OUTPUT_TOO_LARGE: "bash_output_too_large",
  PERMISSION_DENIED: "bash_permission_denied",
} as const;

/** BashErrorCode 的值联合；持久化/跨进程传递时按字符串保留，不折叠成枚举序号。 */
export type BashErrorCode = (typeof BashErrorCode)[keyof typeof BashErrorCode];

// -----------------------------------------------
// Shell Permission Types
// -----------------------------------------------

/**
 * 一条 shell 权限规则：`pattern` 与命令/argv 比对，`type` 决定 allow 或 deny。
 * 只由权限服务与规则持久化读写；`description` 仅用于审批面板展示，不参与匹配。
 */
export type ShellPermissionRule = {
  type: "allow" | "deny";
  pattern: string;
  description?: string;
};

/**
 * Bash 的权限策略快照：`allowReadonly` 控制只读命令免确认，`sandboxEnabled` 是
 * sandbox 总开关，`dangerousDisableSandboxAllowed` 决定模型能否用入参绕过 sandbox。
 * 由设置/会话配置生产，core 的 bash-background-policy 与 permission-capability 消费；
 * 三项都是“收紧”方向，不能被单次调用入参放大。
 */
export interface ShellPermissionPolicy {
  rules: ShellPermissionRule[];
  allowReadonly: boolean;
  sandboxEnabled: boolean;
  dangerousDisableSandboxAllowed: boolean;
}
