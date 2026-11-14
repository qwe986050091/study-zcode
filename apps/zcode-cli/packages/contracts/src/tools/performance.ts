// ============================================================
// 工具执行遥测（performance telemetry）契约
// ============================================================
// 本文件只声明遥测的形状，不产生也不读取任何计时数据。生产者是 core 的
// tool/handlers/tool-perf.ts 与各 handler；消费者是本地落盘的 ToolCallResult、Trace Exporter
// 与性能面板。
// 采样口径：所有时长字段都是"非负整数毫秒"（roundNonNegativeMs 归一，NaN/负值→0）；
// 遥测以不可枚举属性挂在 output 上，不进入模型可见内容与 JSON 序列化。
// 隐私边界：command 的 name 只允许公开 Registry 白名单或固定低桶，hash 是 16 位 hex 的本地
// 诊断指纹，远端 Trace 必须显式忽略它，不能成为高基数远端维度。
// 结构边界：命令专属字段只能进入 detail 的 command 分支，避免非命令工具伪造 exitCode 之类
// 不适用的事实。

import { z } from "zod";

// 命令执行结果的状态词汇表：completed/failed/timed_out/cancelled/spawn_error/backgrounded。
// 它描述"命令怎么结束的"，与工具整体成败是两件事——后台化的命令工具仍可成功返回。
export const ToolCommandStatusSchema = z.enum([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "backgrounded",
]);

// 状态类型；统一由 classify/遥测装箱侧写入，不在契约层做枚举到文案的映射。
export type ToolCommandStatus = z.infer<typeof ToolCommandStatusSchema>;

// 命令类工具的遥测明细。所有时长都是可选：埋点不能因为某个阶段没测到就让整条遥测无效；
// 缺失表示"未采样"，不表示 0。exitCode 只在真拿到进程退出码时在场，后台化的工具没有它。
export const CommandExecutionTelemetrySchema = z
  .object({
    // 命令从派生到结束的总时长；与工具 totalMs 不同，它不含权限等待等外层开销。
    runMs: z.number().int().nonnegative().optional(),
    // 首个输出到达的时间点（相对于启动），用于判断命令是否"卡住没动静"。
    firstOutputMs: z.number().int().nonnegative().optional(),
    // 完全没有输出的持续时长；与 firstOutputMs 互补，用于诊断静默命令。
    noOutputMs: z.number().int().nonnegative().optional(),
    // 进程退出码；负数表示被信号终止，缺省表示未拿到（仍运行/后台化/派生失败）。
    exitCode: z.number().int().optional(),
    // 是否因超时结束；与 status=timed_out 冗余但便于独立过滤，缺省表示未判定。
    timedOut: z.boolean().optional(),
    // 命令产出的输出字节数（UTF-8）；用于评估预算与截断频率。
    outputBytes: z.number().int().nonnegative().optional(),
    // 粗分类（test/package/git/search/build/network/other/empty 等），有界 64 字符，
    // 由 classifyCommand 从有界前缀推导，不含原始命令内容。
    category: z.string().max(64).optional(),
    /**
     * 只允许公开 Registry 中的可执行文件名或固定低基数桶；禁止放入原始命令或参数。
     */
    name: z.string().max(128).optional(),
    // 解析出的顶层命令数；0 表示空命令，多命令时为 N。count 不泄露命令内容，可安全上报。
    count: z.number().int().nonnegative().optional(),
    // 命令结束状态；必填，因为一条命令遥测必须能回答"它怎么结束的"。
    status: ToolCommandStatusSchema,
    /**
     * 本地诊断字段；远端 Trace Exporter 必须显式忽略，避免成为高基数远端维度。
     */
    hash: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .optional(),
  })
  .strict();

// 命令遥测的类型；readToolExecutionTelemetry 读取时只保留 totalMs/permissionWaitMs/detail，
// 所以 detail.command 是这里唯一进入持久化输出的通道。
export type CommandExecutionTelemetry = z.infer<typeof CommandExecutionTelemetrySchema>;

// 文件系统类工具的遥测明细：读/写耗时、文件数与字节量。workspaceKind 由
// tool-perf.ts 的 workspaceKind() 判定——subagent 一律 unknown，不能冒充 local；
// "remote" 不由该函数产生，需要时由端口事实补充。
export const FileSystemExecutionTelemetrySchema = z
  .object({
    // 读取阶段耗时（毫秒）；只统计真正落到文件系统上的读。
    readMs: z.number().int().nonnegative().optional(),
    // 写入阶段耗时（毫秒）；与 readMs 分开，用于识别"读快写慢"的瓶颈。
    writeMs: z.number().int().nonnegative().optional(),
    // 涉及的文件数；与 totalBytes 一起描述工作量规模。
    fileCount: z.number().int().nonnegative().optional(),
    // 读写总字节数（UTF-8），不等于文件逻辑大小，符号链接/稀疏文件可能有差异。
    totalBytes: z.number().int().nonnegative().optional(),
    // 单文件最大字节数；用于发现"一个超大文件拖垮整次调用"。
    maxFileBytes: z.number().int().nonnegative().optional(),
    // 工作区种类：local/remote/unknown；subagent 固定 unknown，避免误报本地。
    workspaceKind: z.enum(["local", "remote", "unknown"]).optional(),
  })
  .strict();

// 文件系统遥测类型；与 command 分支并列存在于 detail 的 discriminatedUnion 中。
export type FileSystemExecutionTelemetry = z.infer<
  typeof FileSystemExecutionTelemetrySchema
>;

// 补丁类工具的遥测明细：匹配/应用 hunk 的耗时与尝试次数。matchAttempts 大于 hunkCount
// 通常意味着模糊匹配重试，是诊断"补丁难落"的关键指标。
export const PatchExecutionTelemetrySchema = z
  .object({
    // hunk 定位与匹配阶段的耗时（毫秒）。
    matchMs: z.number().int().nonnegative().optional(),
    // 补丁包含的 hunk 数；0 或缺失表示没有可应用内容。
    hunkCount: z.number().int().nonnegative().optional(),
    // 匹配尝试次数（含失败重试）；与 hunkCount 比较可发现模糊匹配成本。
    matchAttempts: z.number().int().nonnegative().optional(),
  })
  .strict();

// 补丁遥测类型；patch 分支同时携带 filesystem 与 patch 两组事实。
export type PatchExecutionTelemetry = z.infer<typeof PatchExecutionTelemetrySchema>;

// 遥测明细的判别联合，按 kind 分三种：command（命令事实）、filesystem（纯文件操作）、
// patch（文件操作 + 补丁匹配）。用 discriminatedUnion 而不是可选字段袋，是为了让"exitCode
// 出现在非命令工具上"成为校验失败，而不是一条无法解释的脏数据。
export const ToolExecutionTelemetryDetailSchema = z.discriminatedUnion("kind", [
  z
    .object({
      // 命令类工具（Bash 等）的明细判别值。
      kind: z.literal("command"),
      // 命令执行事实：耗时、退出码、输出量、分类与状态。
      command: CommandExecutionTelemetrySchema,
    })
    .strict(),
  z
    .object({
      // 纯文件系统工具（Read/Glob/Grep 等）的明细判别值。
      kind: z.literal("filesystem"),
      // 文件操作事实：读/写耗时、文件数、字节量与工作区种类。
      filesystem: FileSystemExecutionTelemetrySchema,
    })
    .strict(),
  z
    .object({
      // 补丁工具（Edit/ApplyPatch 等）的明细判别值。
      kind: z.literal("patch"),
      // 补丁工具同样有文件读写阶段，因此携带 filesystem。
      filesystem: FileSystemExecutionTelemetrySchema,
      // 补丁独有的匹配事实：hunk 数、匹配耗时与尝试次数。
      patch: PatchExecutionTelemetrySchema,
    })
    .strict(),
]);

// 明细类型；消费者按 kind 窄化后读取对应分支，不能跨分支取字段。
export type ToolExecutionTelemetryDetail = z.infer<
  typeof ToolExecutionTelemetryDetailSchema
>;

// 顶层遥测载荷，只允许三个字段：总耗时、权限等待、结构化明细。刻意保持小集合——它会进入
// 远端 Trace，字段随工具增长会让遥测无界膨胀。全部字段缺失时调用方应视为"没有遥测"而丢弃
// 整个对象，而不是写一个空壳。
/**
 * 工具执行结果摘要，随 ToolCallResult 事件落本地存储；命令专属字段只能进入判别 detail，
 * 避免非命令工具伪造 exitCode 等不适用事实。
 */
export const ToolExecutionTelemetrySchema = z
  .object({
    // 工具调用从开始到结果产出的总时长（毫秒），含权限等待；与 permissionWaitMs 相减可得纯执行时长。
    totalMs: z.number().int().nonnegative().optional(),
    // 花在权限确认/等待审批上的时长（毫秒）；用于区分"工具慢"与"等用户慢"。
    permissionWaitMs: z.number().int().nonnegative().optional(),
    // 按工具类别分化的结构化明细；缺席表示该工具没有可采样细节，而不是没有遥测。
    detail: ToolExecutionTelemetryDetailSchema.optional(),
  })
  .strict();

// 遥测类型；readToolExecutionTelemetry/compactToolExecutionTelemetry 在读取与挂载时都按它裁剪，
// 任何新增顶层字段都必须同步更新这两处的白名单。
export type ToolExecutionTelemetry = z.infer<typeof ToolExecutionTelemetrySchema>;
