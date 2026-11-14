import type { BackgroundBashOutputResult } from "@zcode/shared";
// ============================================================
// Execution Port - subprocess execution boundary
// ============================================================
// 定位：CLI 内所有子进程执行（Bash 工具、hook、shell 展开、后台任务）的唯一出口，
// core 只构造请求，adapter 负责 env、sandbox、超时、取消、输出截断与退出码归一化。
// 不变量：超时/取消/输出超限都必须收敛成 ExecutionResult 的 status + error，
// 不允许把平台信号或 Node 错误原样抛给业务层。
// 输出不变量：inline 文本可以截断，完整字节必须落 artifact 或输出文件并通过
// artifactPath/outputPath 可追踪，调用方不得声称拿到了全量内容。

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

// 命令形态二选一。argv 走参数数组、不经过 shell，从根上杜绝拼接注入；
// shell 走字符串，由 adapter 按 shell/dialect 选择解释器并负责转义边界。
// shellProfile/shellOverride 是 Bash 工具内部专用：hooks 与通用命令执行不得设置，
// 否则会把内部 shell 选择（posix-bash 等）泄露到用户可配置面。
export type ExecutionCommand =
  | {
      mode: "argv";
      file: string;
      args?: string[];
    }
  | {
      mode: "shell";
      command: string;
      shell?: true | string;
      /**
       * Internal Bash tool shell selection profile. This must not be exposed through hooks,
       * user config, or generic shell execution.
       */
      shellProfile?: "posix-bash";
      /**
       * ZCode runtime-provided Bash shell selection. Current consumers must only use
       * this when shellProfile === "posix-bash"; generic shell execution must ignore it.
       */
      shellOverride?: ExecutionShellSelection;
    };

// shell 方言，决定语法与 cwd 捕获包装：cmd 用 Windows 语义，posix 用 POSIX 语义，
// git-bash 是 Windows 上的 POSIX 兼容层。判定由 adapter 依据平台、配置与探测结果给出，
// 调用方不得自造；"legacy-shell" 只出现在 Selection 中，表示未解析到具体解释器。
export type ExecutionShellDialect = "cmd" | "posix" | "git-bash";

// 选择来源，仅用于诊断与"是否 legacy 兜底"判断：auto-detected 由 resolver 探测，
// user-config 来自显式配置，legacy-fallback 表示没解析到具体可执行文件、沿用旧路径。
export type ExecutionShellSource = "auto-detected" | "user-config" | "legacy-fallback";

// provider 可见的稳定 shell 名，必须与绝对路径无关：同一份配置在不同机器上要得到
// 同一字符串，否则模型提示与缓存会漂移。路径信息只能出现在 label/path，不能进 name。
export interface ExecutionShellDisplay {
  /**
   * Stable provider-visible shell name. Never include absolute paths here.
   * Examples: "bash", "zsh", "Git Bash", "CMD", "system shell".
   */
  name: string;
}

// 一次 shell 选择的完整快照。id 是稳定标识（UI/设置或 resolver 生成），
// path 仅在解析到具体可执行文件时存在，legacy-shell 方言表示旧兜底路径；
// display 是 provider 可见名，label 是给人看的诊断名。该结构跨进程传递，只能承载纯数据。
export interface ExecutionShellSelection {
  /** Stable id from UI/settings or resolver-generated auto id. */
  id?: string;
  /** Human-readable diagnostic label. This can include more detail than display.name. */
  label?: string;
  /** Executable path when ZCode resolved a concrete shell. Omitted for legacy shell fallback. */
  path?: string;
  /** Shell syntax and cwd capture wrapper semantics. */
  dialect: ExecutionShellDialect | "legacy-shell";
  /** Why this selection exists. */
  source: ExecutionShellSource;
  /** Provider-visible stable name. */
  display: ExecutionShellDisplay;
}

// 覆盖别名：语义与 ExecutionShellSelection 完全相同，仅表达"调用方显式覆盖"的意图，
// 便于后续给覆盖路径加约束而不影响普通选择。
export type ExecutionShellOverride = ExecutionShellSelection;

// 环境变量基线：inherit 继承当前进程环境，empty 从空表开始（用于可复现的受限执行）。
export type ExecutionEnvBase = "inherit" | "empty";

// 叠加式环境变量：base 决定起点，set 覆盖/新增，unset 删除。
// Windows 下键名大小写不敏感、Linux 下敏感，归一化只在 adapter 内做；业务层不直接读
// process.env，所有环境注入都必须经这里表达。
export interface ExecutionEnvOverlay {
  base?: ExecutionEnvBase;
  set?: Record<string, string>;
  unset?: string[];
}

interface EmbeddedSearchCommandBackend {
  /**
   * Execution strategy for Bash-level embedded find/grep/rg. This is deliberately
   * below provider-visible policy so the runtime can swap the implementation later.
   */
  command: string;
  args?: string[];
  /**
   * backend 调用需要的环境变量。桌面端 Electron Helper 执行
   * zcode.cjs 时必须带 ELECTRON_RUN_AS_NODE=1，否则会按 Electron 子进程启动。
   */
  env?: Record<string, string>;
}

// 内嵌搜索后端之一：通过本项目 CLI 的隐藏入口执行 find/grep/rg。
// kind 是判别键；command/args 由运行时注入，env 只在需要时提供（如桌面端以
// Electron helper 运行 zcode.cjs 必须带 ELECTRON_RUN_AS_NODE=1）。
export interface EmbeddedSearchInternalCliBackend extends EmbeddedSearchCommandBackend {
  kind: "internal-cli";
}

// 内嵌搜索后端之一：argv[0] 分发，同一个可执行文件按第一个参数切换成 find/grep/rg 实现，
// env 同样用于跨平台的运行环境修正。
export interface EmbeddedSearchArgv0DispatchBackend extends EmbeddedSearchCommandBackend {
  kind: "argv0-dispatch";
}

// 内嵌搜索后端之一：使用随包分发的原生二进制，三个命令各一条路径，不依赖系统 PATH，
// 也不经过 shell，避免 Windows 上 .cmd 解析问题。
export interface EmbeddedSearchNativeBinariesBackend {
  kind: "native-binaries";
  findCommand: string;
  grepCommand: string;
  rgCommand: string;
}

// 内嵌搜索后端的判别联合；新增 kind 必须同步 Bash prelude 的注入与清理逻辑，
// 以及"不把内部实现暴露给用户配置"的校验。
export type EmbeddedSearchBackend =
  | EmbeddedSearchInternalCliBackend
  | EmbeddedSearchArgv0DispatchBackend
  | EmbeddedSearchNativeBinariesBackend;

// Bash 工具的前置定义：在脚本前注入 find/grep/rg 包装，让搜索走内嵌后端而不是系统命令。
// findAndGrepEnabled=false 时只定义 rg，保留与原契约一致的 fallback；
// 该 prelude 只能由 Bash 工具设置（见 ExecutionRequest.bashPrelude），通用执行必须忽略。
export interface ExecutionEmbeddedSearchPrelude {
  kind: "embedded-search";
  backend: EmbeddedSearchBackend;
  /** false 时不定义 find/grep，只保留与原契约一致的 rg fallback。 */
  findAndGrepEnabled?: boolean;
}

// 沙箱策略。enabled 是总开关，profile 选实现档位，dangerouslyDisableSandbox 是显式降级，
// 只允许受信调用方置位；metadata 原样透传给 sandbox adapter，端口层不做解释也不做校验。
export interface ExecutionSandboxPolicy {
  enabled: boolean;
  profile?: string;
  dangerouslyDisableSandbox?: boolean;
  metadata?: Record<string, unknown>;
}

// 输出上限的一组旋钮。maxInlineBytes 决定回给模型的文本长度，maxBufferBytes 是内存缓冲上限，
// persistOutput 控制是否落盘（none/on_truncate/always），maxPersistedBytes 是写盘硬上限，
// maxArtifactBytes 是 artifact 上限。
// 两类执行语义不同：通用 pipe 执行在 inline 截断后才开始写盘，Bash 从 spawn 起直接写文件，
// maxPersistedBytes 对 Bash 只是"每 5 秒检查的软阈值"，killProcessOnPersistedLimit 仅对
// 通用 collector 生效，Bash 的前后台都按文件阈值终止。
export interface ExecutionOutputLimit {
  maxInlineBytes?: number;
  maxBufferBytes?: number;
  /**
   * Controls whether stdout/stderr should be persisted to execution output files.
   * 通用执行的 on_truncate 在 inline 截断后开始写盘；Bash 从 spawn 起直接写盘，
   * 此选项只控制结算后的文件保留。
   */
  persistOutput?: "none" | "on_truncate" | "always";
  /** 通用执行为每路写盘硬上限；Bash 为合并文件的软阈值，每 5 秒检查，严格超出后终止。 */
  maxPersistedBytes?: number;
  /** 通用 pipe 执行的 artifact 上限；Bash 直写保留完整文件，不使用此上限。 */
  maxArtifactBytes?: number;
  /**
   * Stop the process tree when a persisted stream reaches maxPersistedBytes.
   * 仅控制通用 collector 执行。Bash 的文件软阈值在前后台都生效，不受此开关影响。
   */
  killProcessOnPersistedLimit?: boolean;
}

// 一次执行请求。cwd 必须是规范化绝对路径（Bash 允许缺省或相对值，由 session cwd 解析）；
// timeoutMs 缺省取 adapter 默认值；stdin 支持文本或字节；trace 贯穿日志与 span。
// bashPrelude/captureCwdAfterSuccess 仅 Bash 工具可用，禁止来自 hooks 或用户配置：
// 它们改变的是执行语义（注入包装、回写 cwd），不是普通参数。
export interface ExecutionRequest {
  command: ExecutionCommand;
  /** Normalized absolute cwd. Bash resolves omitted or relative cwd values from the session cwd. */
  cwd?: string;
  /**
   * Internal Bash prelude used by the Bash tool only. This must never be accepted from
   * user hooks or generic command runners.
   */
  bashPrelude?: ExecutionEmbeddedSearchPrelude;
  /**
   * Internal state capture. Defaults to false and must only be enabled by the Bash tool for
   * foreground executions. This must not be used for hooks or generic shell commands.
   */
  captureCwdAfterSuccess?: boolean;
  env?: ExecutionEnvOverlay;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  outputLimit?: ExecutionOutputLimit;
  sandbox?: ExecutionSandboxPolicy;
  trace?: TraceContext;
}

// 执行终态。spawn_error 表示进程根本没起来；timed_out/cancelled 是外部停止；
// failed 覆盖非零退出与输出超限。adapter 负责把平台信号、shell 退出码归一化到这里，
// 调用方不得解析 signal 文本或退出码含义来自行推断。
export type ExecutionStatus = "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error";

// 失败分类，与 status 正交：timeout/cancelled 可能对应 timed_out/cancelled 状态，
// output_limit 与 sandbox_violation 属于执行策略而非进程退出，unknown 兜底。
// 分支判断只看 type，不看 message 文案。
export type ExecutionFailureType =
  | "spawn_error"
  | "timeout"
  | "cancelled"
  | "sandbox_violation"
  | "output_limit"
  | "unknown";

// 结构化失败事实：type 用于分支，message 面向用户，cause 保留原始错误对象供日志展开。
// 该对象会跨进程/事件边界传递，因此 cause 只能是可序列化或已在边界内处理的错误。
export interface ExecutionFailure {
  type: ExecutionFailureType;
  message: string;
  cause?: unknown;
}

// 单路输出结果。text 是给模型/内联展示的（可能已被截断），bytes 是实际读到的字节数，
// truncated 标记 inline 截断；artifactPath/artifactBytes/artifactTruncated 指向落盘副本，
// 只作为可追踪引用，调用方不得把 artifact 内容整体回灌模型上下文。
export interface ExecutionStreamResult {
  text: string;
  bytes: number;
  truncated: boolean;
  artifactPath?: string;
  artifactBytes?: number;
  artifactTruncated?: boolean;
}

// 一次执行的完整结算。exitCode 仅在进程正常退出时存在；signal 是终止信号名；
// durationMs 是墙钟耗时而非 CPU 时间；resolvedCwd 是内部状态捕获（Bash 成功后回写），
// 永不进入 provider 可见输出。status、timedOut、cancelled 三者必须自洽。
export interface ExecutionResult {
  status: ExecutionStatus;
  exitCode?: number;
  signal?: string;
  stdout: ExecutionStreamResult;
  stderr: ExecutionStreamResult;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: Date;
  completedAt: Date;
  pid?: number;
  error?: ExecutionFailure;
  /** Internal runtime state captured after a successful command; never provider-visible output. */
  resolvedCwd?: string;
}

// 预览口径：每次只做一次有界尾读，text 是末尾 5 行，fullText 是末尾最多 100 行，
// totalLines 在只读到部分字节时按字节比例估算（linesEstimated=true，需与上次行数取大），
// totalBytes 是文件当前总字节。该结构刻意不持有完整输出，消费方不得据此认为拿到了全部内容。
// 生产者是 Bash 直写路径的 progress 事件组装，消费者是 TUI/V4 进度投影。
/** 单次有界尾读计算的 Bash 进度，不持有完整命令输出。 */
export interface ExecutionOutputPreview {
  text: string;
  fullText: string;
  totalLines: number;
  totalBytes: number;
  linesEstimated: boolean;
}

/** Bash 只发送 started/progress/completed/failed；逐 chunk 输出事件仅用于 pipe 执行。 */
// 流式事件。started 与 completed/failed 是每次执行的边界；stdout/stderr chunk 只用于
// pipe 执行，Bash 只发 started/progress/completed/failed（其输出直写文件）。
// progress 携带累计字节与可选预览/tail，timestamp 均为本地时间，不参与排序判断。
export type ExecutionEvent =
  | {
      type: "started";
      pid?: number;
      timestamp: Date;
    }
  | {
      type: "stdout" | "stderr";
      chunk: Uint8Array;
      text: string;
      timestamp: Date;
    }
  | {
      type: "progress";
      elapsedMs: number;
      pid?: number;
      stdoutBytes: number;
      stderrBytes: number;
      outputPreview?: ExecutionOutputPreview;
      stdoutTail?: string;
      stderrTail?: string;
      timestamp: Date;
    }
  | {
      type: "completed";
      result: ExecutionResult;
      timestamp: Date;
    }
  | {
      type: "failed";
      error: ExecutionFailure;
      timestamp: Date;
    };

// run 的调用侧控制。signal 取消会终止进程树并返回 cancelled（不抛异常）；
// onEvent 抛出的错误被 adapter 吞掉——事件只是观测，不能反向中断执行；
// context 提供 trace 之外的执行上下文。
export interface ExecutionRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  context?: ExecutionContext;
}

// 后台任务状态：running 是唯一的非结算态，其余复用 ExecutionStatus 表示已结算。
export type BackgroundExecutionStatus = "running" | ExecutionStatus;

// start 的返回。taskId 是后续 get/cancel/read 的唯一键；outputPath 系列是落盘位置，
// 可能在启动初期尚未确定而缺席；pid 同样存在 spawn 前后竞态。
export interface BackgroundExecutionStartResult {
  taskId: string;
  status: "running";
  startedAt: Date;
  pid?: number;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
}

// 后台任务快照。tail 字段是有界尾部而非全量；result 在结算后才出现；
// status=running 时其余结算字段均缺席。调用方不得把快照当成实时流，
// 也不得把 tail 当成完整输出。
export interface BackgroundExecutionSnapshot {
  taskId: string;
  status: BackgroundExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  pid?: number;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  result?: ExecutionResult;
  error?: ExecutionFailure;
}

// 执行端口。run 是同步语义（Promise 结算才返回）；start/getBackgroundTask/
// cancelBackgroundTask/readBackgroundBashOutput/close 均为可选，缺失表示 adapter 不支持后台任务。
// readBackgroundBashOutput 固定只读已登记后台 Bash 的尾 8 KiB，且必须带 sessionId 做归属校验；
// close 释放所有进程与临时文件，关闭后任何新请求都按 cancelled 返回。
export interface ExecutionPort {
  run(request: ExecutionRequest, options?: ExecutionRunOptions): Promise<ExecutionResult>;
  start?(
    request: ExecutionRequest,
    options?: ExecutionRunOptions,
  ): Promise<BackgroundExecutionStartResult>;
  getBackgroundTask?(taskId: string): Promise<BackgroundExecutionSnapshot | undefined>;
  /** 只读已登记的后台 Bash，固定读取文件尾部 8 KiB。 */
  readBackgroundBashOutput?(taskId: string, sessionId: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(taskId: string): Promise<BackgroundExecutionSnapshot | undefined>;
  close?(): Promise<void>;
}
