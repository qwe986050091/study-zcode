// ============================================================
// Tool 结果展示投影（display）与完成元数据契约
// ============================================================
// display 是工具结果的**可选展示投影**：生产者是 core 的 executor/result-display.ts 与
// executor/workflow-observation-display.ts，消费者是实时事件与 tool part 的
// `metadata.display`（UI 渲染），以及持久化后的冷恢复/会话回放。
// 它与模型可见结果（modelContent / formatModelContent）是两条独立通道：display 永不进入
// 模型上下文，因此不受 resultBudget 约束，所有文本与数组界都在本文件独立声明。
// 全部 payload 都 `.strict()`，且 packages/shared 有逐帧镜像 schema；字段集是冻结的——
// 多出/改名一个键不是"旧客户端少读一个字段"，而是整条工具结果卡被拒、会话恢复 fail-closed。
// 落库后的读取必须先过 parseCompletedToolPartMetadata / parseToolResultDisplayPayload，
// 它们在 strict 解析前剥离历史字段（providerStop、已撤回的 refinedName/refinedLabel）。
// ============================================================

import { z } from "zod";
import { PersistedToolSearchContentSchema } from "./tool-search.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "@zcode/shared";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_WIDGET_META_MAX_BYTES,
} from "@zcode/shared/mcp-apps";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CreateWorkflowCausalityGraphSchema,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
} from "./workflow-observation-display.js";

// 完成元数据的 schema 版本（当前 1）：冷恢复据此决定能否按本结构解析；只在破坏性变更时递增。
// 其余是 display 通道的独立界，逐项口径：
// - TASK_OUTPUT 状态 64 字符、输出 2_000 字符：任务状态行与输出正文各自限长（取头部）；
// - MCP 名字 256 字符、描述 4 KiB：MCP discovery 来自外部进程，进 display 前必须限长并做
//   surrogate 安全截断；
// - CUA_TARGET_APP_DISPLAY_META_KEY 是官方 CUA 结果 `_meta` 里的应用身份键；带 `-v1` 后缀
//   是为了让 UI 能按版本拒绝旧形状，只有官方扩展置位，第三方 MCP 塞同名键会被忽略。
export const COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION = 1;
export const TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS = 64;
export const TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS = 2_000;
export const MCP_TOOL_DISPLAY_MAX_NAME_CHARS = 256;
export const MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS = 4 * 1024;
export const CUA_TARGET_APP_DISPLAY_META_KEY = "zcode.cua/target-app-display-v1" as const;

// 应用图标的定位方式（按 `kind` 判别），UI 据此向平台服务解析图标，协议本身不承载图标字节：
// - `darwin-bundle-id`：macOS bundle identifier；
// - `windows-executable-path`：Windows 可执行文件绝对路径（上限 32_768 字符）；
// - `windows-aumid`：Windows AppUserModelID。
// 三个分支各自 strict；未知 kind 会让整个 targetApp 块被拒，而不是静默降级成一个空图标。
export const applicationIconLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("darwin-bundle-id"), value: z.string().trim().min(1).max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("windows-executable-path"),
      value: z.string().trim().min(1).max(32_768),
    })
    .strict(),
  z.object({ kind: z.literal("windows-aumid"), value: z.string().trim().min(1).max(512) }).strict(),
]);

// 官方 Computer Use 结果卡上的目标应用身份（来自 `_meta` 的 CUA_TARGET_APP_DISPLAY_META_KEY）。
// `schemaVersion` 固定 1；`displayName` 可缺席（系统只给 bundle/aumid 时 UI 回退到进程名）；
// `iconLocators` 最多 3 个，数组顺序即 UI 的解析尝试顺序。仅官方 CUA 投影该块，整块 strict。
export const cuaTargetAppDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(512).optional(),
    iconLocators: z.array(applicationIconLocatorSchema).max(3),
  })
  .strict();

// request_access 工具的权限状态卡（仅 darwin）。逐字段口径：`grantOwner` 是被授权的应用/进程名；
// `accessibility` 三态 granted / stale / denied；`screenRecording` 三态 granted / denied /
// unknown——unknown 是"尚未探测"，不能当作拒绝展示。只对官方 CUA 的 request_access 投影。
export const cuaRequestAccessStatusDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("darwin"),
    grantOwner: z.string().trim().min(1).max(512),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();

// CreateWorkflow display 诊断的限长常量与条目 schema 已移至 create-workflow.ts
// （被 create_workflow 与 eval_workflow_snippet 两个 display payload 复用，放这里会成环）。

// display 用的 unified diff hunk 形状：只保留两段行号与行文本，不含文件名等渲染不需要的字段。
// 构造侧先过滤非法 hunk 再限长，坏数据（例如第三方 MCP 返回的畸形 patch）不进 display，
// 也不会把 additions/deletions 计数污染成 NaN。
export const toolResultDisplayDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

// 文件 diff 卡（Edit/Write 等工具的通用兜底：output 同时带 filePath 与 structuredPatch 即命中）。
// `additions` / `deletions` 由过滤后的合法 hunk 重新计数，不采信工具自报值；`structuredPatch`
// 已被构造侧限长，`truncated` 表示部分 hunk 被省略（不是文件内容被截断）。
// 该卡只给 UI；模型看到的 diff 文本仍由工具自身的 modelContent 提供，两条通道互不替代。
export const fileDiffToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(toolResultDisplayDiffHunkSchema),
    truncated: z.boolean().optional(),
  })
  .strict();

// SendMessage 的结果卡：只投影一次投递的结论，不投影收件人、messageId、delivery 等元数据。
// `status` 二态 success/failed；`message` 是端口回传的正文预览（display 侧另行限字节），
// `error` 只在失败时出现。二者都可能缺席，缺省即"没有可展示内容"，不补空串。
export const localAgentMessageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

// TaskStop 的结果卡。字段口径：`taskId` 来自输出的 `task_id`，是本次停止的关联键（与
// TaskOutput / Workflow 的 runId 不通用）；`taskType` 是后台任务类型；`command` 只在可展示时出现，
// 标准成功文案里的命令括注会被剥离，避免和独立 `command` 字段重复。
// `truncated` 表示 command 或 message 任一被 display 界截断；重复 stop 的 not_running 结论
// 仍按原 message 展示，不改写成"已停止"。
export const taskStopToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();

// TaskOutput 的结果卡。字段口径：`retrievalStatus` 三态 success/not_ready/timeout 直接来自
// 输出，决定 UI 是展示内容还是"尚未就绪/超时"；`taskStatus` 是任务的粗粒度状态（trim 后截 64 字符），
// `output` 是输出正文的**头部** 2_000 字符（trimEnd 后为空则整个字段缺席）。
// `truncated` 是 `literal(true)`：只有真的裁过输出才出现，缺席即未截断——不写 false 是为了让
// 旧持久化行与 strict 镜像保持一致。完整输出永远不进 display（禁止把 XML/结果对象塞进事件）。
export const taskOutputToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS).optional(),
    output: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

// RespondToCoordinator 的结果卡：只有一个二态 `status`。问询正文属于模型通道的
// tool_result，不在卡上重复；UI 只需要知道这次协调请求是否被接受。
export const respondToCoordinatorToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

// Computer Use 的结果卡（`schemaVersion` 固定 1）。逐字段口径：
// - `toolName` 是归一化后的 action（如 `screenshot`/`left_click`），不是完整 MCP 工具名；
// - `status` 由 `isError` 推导，二态 success/failed；
// - `structuredContent` / `text` 是展平前的独立有界投影（各 32 KiB），`input` 仅为回放兼容保留；
// - `errorCode` / `suggestedAction` 取自 structuredContent.error，缺失即不展示；
// - `targetApp` / `permissionStatus` 仅官方 CUA 且 `_meta` 命中时才投影；
// - `media` 是最多 4 张可直接渲染的内联图片（单张 ≤256 KiB、累计 ≤512 KiB），artifact URI
//   不进 display（多端 UI 无法读取本地路径）；被裁的图记在 `truncated` 上。
export const cuaToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // 旧 v1 历史记录曾重复携带 ToolCallRow.input；只为回放兼容继续接受，新 producer 不再写入。
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    targetApp: cuaTargetAppDisplaySchema.optional(),
    permissionStatus: cuaRequestAccessStatusDisplaySchema.optional(),
    media: z
      .array(
        z
          .object({
            mimeType: z.string().min(1),
            // 256 KiB 原始图片编码后的最大 base64 长度；总预算由投影器执行。
            data: z.string().min(1).max(349_528).optional(),
            artifactUri: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * node_repl cell 的目标应用身份（Computer Use）。`appKey` 是 producer 的形态：
 * `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；
 * UI 按前缀派生 `ApplicationIconLocator` 再交给平台服务解析，协议不承载图标字节。
 */
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

// node_repl cell 的图片/应用卡。口径：`images` 最多 2 张，每张纯 base64 ≤200 KiB（`data:` 前缀
// 由构造侧剥掉），`mimeType` 必须匹配 `image/*`；`images` 可缺席——CUA 的纯动作 cell 没有截图，
// 但仍要投影 `app` 身份给卡上的 leading icon。`kind` 名保留 `node_repl_images`：改名会让已持久化
// 的行在 strict 联合里整段被剥掉。`source: "browser_turn_end"` 标记图片来自浏览器回合结束的快照。
export const nodeReplImageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images 可选而不是 min(1)：CUA 的纯动作 cell（点击、输入）没有截图，但仍要投影 app 身份。
    // kind 名保留为 node_repl_images —— 改名会让已持久化的 row 在 strict union 里整段被剥掉。
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

/**
 * 插件 UI 元数据。
 * contracts 仍在 zod v3，无法直接复用 `@zcode/shared/mcp-apps` 的 zod v4 schema 对象，这里按同一常量
 * 手写一份；字段集合与 `mcpToolDisplayUiSchema` 必须一致，由 core/tests/mcp-ui-display.test.ts 用同一
 * fixture 双侧 parse 锁住。
 */
export const mcpToolDisplayUiPayloadSchema = z
  .object({
    pluginId: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    preferredDisplayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
    prefersBorder: z.boolean().optional(),
    csp: z
      .object({
        connectDomains: z.array(z.string().min(1).max(512)).optional(),
        resourceDomains: z.array(z.string().min(1).max(512)).optional(),
      })
      .strict()
      .optional(),
    structuredContent: z.string().max(MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES).optional(),
    widgetMeta: z.string().max(MCP_APPS_WIDGET_META_MAX_BYTES).optional(),
    // 原始 content 数组 JSON（≤ 32 KiB）与被省略字节数；与 shared mcpToolDisplayUiSchema 同步。
    content: z.string().max(MCP_APPS_CONTENT_MAX_BYTES).optional(),
    truncated: z.boolean().optional(),
    truncatedBytes: z.number().int().nonnegative().optional(),
    // MCP isError 结果（调用完成但工具报错），与 shared 同步。
    isError: z.literal(true).optional(),
    // 工具级强制常驻，与 shared 同步。
    showInline: z.literal(true).optional(),
    // 与 shared mcpToolDisplayUiSchema 同步；已删 widgetStateVisibility。
    surface: z
      .string()
      .min(1)
      .max(MCP_APPS_SURFACE_ID_MAX_CHARS)
      .regex(MCP_APPS_SURFACE_ID_PATTERN)
      .optional(),
  })
  .strict();

// MCP 工具调用的结果卡。`serverName` / `toolName` 各 ≤256 字符、`description` ≤4 KiB（都来自
// 外部 discovery，必须限长）；`unavailable` 只在"官方 HTTP MCP + isError"时出现，用于在输入框
// 上方提示额度/套餐问题，code 与 shared 的 OFFICIAL_MCP_TOOL_ERROR_CODES 同源。
// `ui` 是插件 UI 元数据，与 `@zcode/shared` v4 的 mcp_tool.ui 逐字段同步；两侧都 strict，
// 缺一处会被 zod 静默 strip，因此改动必须双侧一起改。
export const mcpToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    toolName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    description: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS).optional(),
    /**
     * 官方 Server MCP 判定本次调用不可用时下发的结构化标识（额度耗尽 / 无 Coding Plan）。
     * 只在 tool result 为 isError 且该 MCP 为官方来源时出现，UI 据此在输入框上方提示。
     * 与 code 同源：`@zcode/shared` 的 OFFICIAL_MCP_TOOL_ERROR_CODES。
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // 与 `@zcode/shared` v4 toolDisplay 的 mcp_tool.ui 同步；两侧都是 strict，缺一处会被 zod 静默 strip。
    ui: mcpToolDisplayUiPayloadSchema.optional(),
  })
  .strict();

/**
 * ⚠ 这个字段集合是**冻结**的。既有 kind 上多出来的键不是「旧客户端少读一个字段」，而是整块 display
 * 校验不过：两个真实的 strict 解析点（packages/ui 的 create-workflow renderer safeParse，
 * 与 legacy v3 的按 kind 查表）会连带把整条工具结果丢掉。gate 专属的事实一律走**工具入参**
 * 通道（那一侧对所有版本都无 schema），可复用工作流的 saved 来源就是这么做的。
 */
export const createWorkflowToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    // 工具输出边界已限长（见 create-workflow.ts 的图 schema），display 直接复用同一契约。
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

// contracts 使用 zod v3，App 使用 v4；与 shared/bash-output-display.ts 保持同一严格契约。
const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();

// 全部 display payload 的判别联合（按 `kind`）。口径：任一分支 strict，未知 `kind` 或已知 kind
// 上多一个键都会让**整个 union** 解析失败；因此新增 kind 必须同时更新 packages/shared 的镜像
// 与 UI 的按 kind 查表，且历史行只能靠 scrub 清洗兼容，不能靠"宽松解析"。
// 数组顺序不影响判别（discriminatedUnion 按 kind 分发），但新增项应追加在末尾便于对照。
export const toolResultDisplayPayloadSchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  fileDiffToolResultDisplayPayloadSchema,
  localAgentMessageToolResultDisplayPayloadSchema,
  taskStopToolResultDisplayPayloadSchema,
  taskOutputToolResultDisplayPayloadSchema,
  respondToCoordinatorToolResultDisplayPayloadSchema,
  cuaToolResultDisplayPayloadSchema,
  nodeReplImageToolResultDisplayPayloadSchema,
  mcpToolResultDisplayPayloadSchema,
  createWorkflowToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
]);

// Edit/Write 等工具的文件 diff 卡投影。`additions` / `deletions` 是过滤后重新计数的行数，
// `structuredPatch` 已被构造侧限长；`truncated` 只描述展示裁剪，不表示文件内容被截断。
// 读取侧按 `kind: "file_diff"` 收窄后即可拿到渲染所需的全部字段。
export type FileDiffToolResultDisplayPayload = z.infer<
  typeof fileDiffToolResultDisplayPayloadSchema
>;
// SendMessage 投递卡投影：只有二态状态与可选 message/error，不携带收件人、messageId、delivery。
// `status` 与工具输出同源，失败时 `error` 才是诊断正文；该卡只进 UI，不回流到父代理上下文。
export type LocalAgentMessageToolResultDisplayPayload = z.infer<
  typeof localAgentMessageToolResultDisplayPayloadSchema
>;
// TaskStop 卡投影。`taskId` 是本次停止的关联键（与 TaskOutput 的 task_id 同域）；
// `command` 可缺席，`message` 已剥离标准文案里的命令括注；`truncated` 只标记展示裁剪。
// 重复 stop 的 not_running 仍以原 message 呈现，不伪造"已停止"。
export type TaskStopToolResultDisplayPayload = z.infer<
  typeof taskStopToolResultDisplayPayloadSchema
>;
// TaskOutput 卡投影。`retrievalStatus` 决定 UI 的三态展示；`taskStatus` / `output` 是截断后的
// 展示值（output 取头部 2_000 字符），`truncated: true` 只在真的裁过时出现。
// 完整输出永不进入该卡，模型侧仍读工具自身的 result。
export type TaskOutputToolResultDisplayPayload = z.infer<
  typeof taskOutputToolResultDisplayPayloadSchema
>;
// RespondToCoordinator 卡投影：只有 `status`，问询正文属于模型通道，不在卡上重复。
// 读取侧无需区分更多字段，避免 UI 依赖协调协议的内部细节。
export type RespondToCoordinatorToolResultDisplayPayload = z.infer<
  typeof respondToCoordinatorToolResultDisplayPayloadSchema
>;
// CUA 卡投影。`schemaVersion` 固定 1，`toolName` 是归一化 action；`structuredContent` / `text`
// 为独立有界投影，`targetApp` / `permissionStatus` 仅官方扩展可得；`media` 是可内联渲染的图，
// 超界由 `truncated` 标记；artifact URI 刻意不在投影内。
export type CuaToolResultDisplayPayload = z.infer<typeof cuaToolResultDisplayPayloadSchema>;
// 图标定位子结构投影：UI 按 `kind` 调平台服务解析，协议只传标识、不传图标字节。
// 三种形态互斥，未知 `kind` 的载荷在 strict 解析阶段就已被拒，不会进入该类型。
export type ApplicationIconLocator = z.infer<typeof applicationIconLocatorSchema>;
// 官方 CUA 的目标应用身份投影：`schemaVersion` 固定 1，`iconLocators` 顺序即 UI 尝试顺序，
// `displayName` 可缺席。只有官方扩展的结果会投影该子结构，第三方 MCP 的同名元数据被丢弃。
export type CuaTargetAppDisplay = z.infer<typeof cuaTargetAppDisplaySchema>;
// request_access 权限状态投影：`grantOwner` 是被授权应用，`accessibility` / `screenRecording`
// 各自三态；`unknown` 表示未探测、不能当作拒绝。仅 darwin 且官方 CUA 可得。
export type CuaRequestAccessStatusDisplay = z.infer<typeof cuaRequestAccessStatusDisplaySchema>;
// node_repl 图片/应用卡投影：`images` 可缺席（纯动作 cell 无截图），最多 2 张且只含可直接
// 渲染的 base64；`app` 用于卡上 leading icon。`kind` 保持 `node_repl_images` 以兼容历史行。
export type NodeReplImageToolResultDisplayPayload = z.infer<
  typeof nodeReplImageToolResultDisplayPayloadSchema
>;
// MCP 卡投影：server/tool 名与描述已限长，`unavailable` 是官方服务下发的不可用标识，
// `ui` 与 shared 的 mcp_tool.ui 逐字段同步。字段集合冻结，新增字段必须两侧一起改。
export type McpToolResultDisplayPayload = z.infer<typeof mcpToolResultDisplayPayloadSchema>;
// CreateWorkflow 卡投影：`ok` / `errorCount` 是校验结论，`diagnostics` 有独立上限，
// `causalityGraph` 直接复用工具输出的图 schema；`truncated` 只标记诊断/图被裁。
export type CreateWorkflowToolResultDisplayPayload = z.infer<
  typeof createWorkflowToolResultDisplayPayloadSchema
>;
// node_repl 的目标应用身份投影：`appKey` 为 `darwin:<bundleId>` / `windows-aumid:<id>` /
// `windows-exe:<path>` / `linux-exe:<path>`，UI 按前缀派生图标定位；协议不承载图标字节。
export type NodeReplCuaAppDisplay = z.infer<typeof nodeReplCuaAppDisplaySchema>;

// 全部 display 载荷的判别联合投影。读取侧必须先按 `kind` 收窄；未知 `kind` 在解析阶段就已
// 失败，不会以"部分字段"的形式进入类型。它是渲染端唯一应接受的 payload 类型。
export type ToolResultDisplayPayload = z.infer<typeof toolResultDisplayPayloadSchema>;

// 结果序列化的预算事实（不变量 4：必须记录真实预算与实际回传字节）。逐字段口径：
// - `truncated` 表示本次确实发生了裁剪；
// - `originalBytes` 是裁剪前的原始结果字节；
// - `returnedBytes` 是**真实发给模型**的字节数，不是估算值；
// - `budgetStrategy` 是本次采用的内联策略（inline / truncate / artifact）；
// - `artifactPath` 只在有落盘产物时出现（省略而非写 undefined）。
// 该对象落进 tool part metadata，冷恢复据此判断结果是否完整、原文是否还能回读。
export const toolResultSerializationMetadataSchema = z
  .object({
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    budgetStrategy: z.enum(["inline", "truncate", "artifact"]),
    artifactPath: z.string().min(1).optional(),
  })
  .strict();

// 序列化事实的 TS 投影；`returnedBytes` 与 `originalBytes` 单位均为字节，不可与字符上限混用。
export type ToolResultSerializationMetadata = z.infer<typeof toolResultSerializationMetadataSchema>;

// 一个已完成 tool part 的持久化 metadata。逐字段口径：
// - `modelContent` 是模型实际读到的内容，联合 `string | PersistedToolSearchContentSchema`：
//   错误结果沿用字符串，正常结果是有序内容块数组；只接受数组会让 V4 冷恢复丢掉整份 metadata；
// - `schemaVersion` 固定当前版本，冷恢复据此决定解析路径；
// - `display` 是可选展示投影（不进模型上下文），`serialization` 是可选预算事实；
// - `.passthrough()` 是刻意的：`readFileState` 等字段由运行期另行写入并必须原样保留，改 strict
//   会让冷恢复丢掉文件快照，使 Write/Edit 的 stale 判定失去依据。
export const completedToolPartMetadataSchema = z
  .object({
    // 错误结果沿用字符串内容；仅接受数组会使 V4 冷恢复丢弃整份 metadata，包括 display。
    modelContent: z.union([z.string(), PersistedToolSearchContentSchema]).optional(),
    schemaVersion: z.literal(COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION),
    display: toolResultDisplayPayloadSchema.optional(),
    serialization: toolResultSerializationMetadataSchema.optional(),
  })
  .passthrough();

// 持久化 metadata 的 TS 投影；因为 schema 透传，这里只列出已知字段，未知键在运行期仍会保留。
export type CompletedToolPartMetadata = z.infer<typeof completedToolPartMetadataSchema>;

// 冷恢复/回放的唯一 metadata 入口。先对 `display` 做历史字段清洗（providerStop、已撤回的
// refinedName/refinedLabel），再整体 safeParse；清洗必须发生在 strict 解析之前，否则旧会话
// 的 display 会整块被拒。输入不是普通对象、或解析失败时返回 undefined——调用方退回纯文本，
// 而不是抛错中断恢复。副作用无：清洗返回新对象，不修改传入值。
export function parseCompletedToolPartMetadata(
  input: unknown,
): CompletedToolPartMetadata | undefined {
  const scrubbed =
    isPlainRecord(input) && "display" in input
      ? { ...input, display: scrubPersistedDisplay(input.display) }
      : input;
  const result = completedToolPartMetadataSchema.safeParse(scrubbed);
  return result.success ? result.data : undefined;
}

// 单帧 display 的解析入口（不包 metadata 外壳）：同样先 scrub 再 strict 解析。
// 返回 undefined 表示这一帧不可信（未知 kind / 多键 / 历史字段未被清洗），渲染端应丢弃该卡；
// 不抛错，避免一条坏帧让整段会话回放中断。与 parseCompletedToolPartMetadata 共用同一清洗顺序。
export function parseToolResultDisplayPayload(
  input: unknown,
): ToolResultDisplayPayload | undefined {
  const result = toolResultDisplayPayloadSchema.safeParse(scrubPersistedDisplay(input));
  return result.success ? result.data : undefined;
}

/**
 * 解析前的统一清洗。
 *
 * display 是**落库**的：它写进 tool part 的 `metadata.display`，此后每次读取都要重新过
 * 一遍严格解析，而渲染端对每一帧同样有一份严格的镜像 schema。所以剥离必须发生在 CLI 侧、
 * 解析之前——上面两个入口就是唯一的卡点，v4 冷启动水合与 session-transcript 回放都经过它。
 *
 * 每个 stripper 只认自己那一个 kind，只改在场的键，别的 kind 原样进入解析。
 */
function scrubPersistedDisplay(display: unknown): unknown {
  return stripProviderStopFromGetWorkflowRunError(stripWithdrawnRefinedNames(display));
}

/**
 * 剥掉持久化 get_workflow_run 卡上的 `providerStop`。
 *
 * 早期构造侧曾把只属于模型通道的 `providerStop` 一并写进 display，而渲染端的
 * 镜像 schema 从来只认 `{code, message}`，那些帧一律被拒。构造侧已经改成只带
 * code / message，但历史持久化的 part 每次冷启动都会被重新读一遍，只能在这里剥。
 *
 * 只认 kind 为 get_workflow_run、且 error 是普通对象、且 `providerStop` 在场的载荷；不带
 * 该键的 error 与缺席的 error 原样返回，不凭空添一个 undefined。
 */
function stripProviderStopFromGetWorkflowRunError(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "get_workflow_run") return display;
  const error = display.error;
  if (!isPlainRecord(error) || !("providerStop" in error)) return display;
  const { providerStop: _dropped, ...rest } = error;
  return { ...display, error: rest };
}

/**
 * 剥掉已撤回的模型精炼字段。
 *
 * 之前持久化的 create_workflow display 里，车道与阶段可能带 `refinedName`、
 * step 可能带 `refinedLabel`。这三个字段已从 schema 删除，而两个入口都是 `.strict()`
 * 解析：不先剥掉，旧会话的整个 display（连同图）会在这里被拒掉，而不只是丢一个名字。
 *
 * 只认 create_workflow 且带 causalityGraph 的载荷；别的 kind 原样进入解析。只改在场的
 * 键，不给缺席的 `phases` 之类凭空添一个 undefined。
 */
function stripWithdrawnRefinedNames(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return display;
  const graph = display.causalityGraph;
  if (!isPlainRecord(graph)) return display;
  return {
    ...display,
    causalityGraph: {
      ...graph,
      ...("lanes" in graph ? { lanes: withoutKey(graph.lanes, "refinedName") } : {}),
      ...("steps" in graph ? { steps: withoutKey(graph.steps, "refinedLabel") } : {}),
      ...("phases" in graph ? { phases: withoutKey(graph.phases, "refinedName") } : {}),
    },
  };
}

function withoutKey(items: unknown, key: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isPlainRecord(item) || !(key in item)) return item;
    const { [key]: _dropped, ...rest } = item;
    return rest;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
