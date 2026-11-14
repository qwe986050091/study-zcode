// ============================================================
// 文件定位：exec 适配器的内部共享类型（后台任务、输出路径、生命周期、adapter 构造选项）集合。
// 输入输出：纯类型声明，无运行时导出；被 node-execution-adapter-* 各实现与 core 调用方复用。
// 副作用：无。
// 失败语义：不适用（类型层；语义约束见各字段注释）。
// 不变量：StopReason 三态封闭；BackgoundTaskRecord 的 completion 只 resolve 一次；输出路径三选一可空。
// ============================================================
import type { SpawnOptions } from "node:child_process";
import type { BashFileOutput } from "./bash-file-output.js";
import type { ZCodeToolExecResource } from "@zcode/shared";
import type { NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import type { ResolvedSpawnCommand } from "./execution-command.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";

export interface ExitState {
  // 正常退出码；被杀或 spawn 失败时为 undefined。
  code?: number;
  // 终止信号名（如 SIGKILL/SIGTERM）；与 code 互斥。
  signal?: string;
  // spawn/等待阶段错误；此时 code/signal 通常都为空。
  error?: Error;
}

export interface BackgroundTaskRecord extends BackgroundExecutionSnapshot {
  // 后台任务所属会话；缺省表示跨会话/未绑定。
  sessionId?: string;
  // 是否 Bash 任务：决定输出读取方式（文件直写 vs collector）与清理策略。
  isBash: boolean;
  // Windows 旧代码页回退编码；null 表示纯 UTF-8。
  legacyOutputEncoding: string | null;
  // 任务终态快照的 promise，只 resolve 一次，供轮询/收尾方复用。
  completion: Promise<BackgroundExecutionSnapshot>;
  // 取消控制器：cancel/timeout 都通过它传播到执行层。
  controller: AbortController;
  // 外部（父级 signal）的解除订阅函数；任务结束时调用以防泄漏。
  externalAbort?: () => void;
  // 终态生成时调用，把快照交给等待方；必须与 completion 配对使用。
  resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void;
}

export interface ExecutionOutputPaths {
  // 通用合并输出文件（非 Bash 的 artifact）。
  outputPath?: string;
  // 分路的 stderr 落盘路径；与 stdout 共享预算时互斥生效。
  stderrPersistedOutputPath?: string;
  // 分路的 stdout 落盘路径。
  stdoutPersistedOutputPath?: string;
}

export interface InternalExecutionRunOptions extends ExecutionRunOptions {
  // Bash 已提前创建的文件输出与句柄状态；存在时跳过 collector 建文件。
  preparedBashOutput?: PreparedBashOutput;
  // 编码探测完成后回调（用于把 legacy 编码回写到后台任务记录）。
  onOutputEncodingResolved?: (encoding: string | null) => void;
  /** Bash 移交时停止前台预览并重启文件 watchdog；不复制进程或输出。 */
  bashLifecycle?: {
    // 查询是否已转入后台；true 时前台停止等待 exit，只等收尾。
    isBackgrounded: () => boolean;
    // 转入后台瞬间的一次性通知（用于切 UI、停前台预览）。
    onBackgrounded?: () => void;
    // 进程真正退出的回调；前台与后台都必须触发一次。
    onExit?: () => void;
  };
  // 首次触达落盘上限时调用，用于把截断原因写进结果。
  onPersistedLimit?: () => void;
  // true 时 stdout/stderr 共享一份落盘预算，避免双流各写满上限。
  sharePersistedOutputLimitAcrossStreams?: boolean;
  // 每次落盘后询问是否应提前结束命令（如 output_limit 终止）。
  shouldStopOnPersistedLimit?: () => boolean;
  // 根进程退出后是否保留执行记录，以便继续排空 pipe / 等待孤儿进程。
  shouldRetainExecutionAfterRootExit?: () => boolean;
}

export interface PreparedBashOutput {
  // 已 prepare 的文件对象；result() 从中读取最终输出。
  file: BashFileOutput;
  // 该任务解析出的旧代码页编码。
  legacyOutputEncoding: string | null;
  /** 准备与执行交接期间仍由 close() 等待，执行接管后释放准备记录。 */
  releasePreparation: () => void;
}

// 后台化模式：explicit=调用方主动要求；auto_on_timeout=超时后自动转后台而非杀进程。
export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

// 生命周期结果二选一：前台直接给结果；后台返回任务句柄（命令仍在跑）。
export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface PreparedChildSpawn {
  // 已解析的 file/args/shell/方言。
  command: ResolvedSpawnCommand;
  // 生成 cwd 时使用的路径方言；与 command.cwdDialect 必须一致。
  cwdDialect: ExecutionShellDialect;
  // 需要回写 cwd 时的临时文件路径；空表示不捕获。
  cwdFilePath?: string;
  // 最终传入 spawn 的选项（含 env、stdio、detached）。
  spawnOptions: SpawnOptions;
}

export interface ActiveExecutionRecord {
  // 执行收尾完成信号（输出关闭、进程回收后 resolve）。
  completion: Promise<void>;
  resolveCompletion: () => void;
  // 终止入口；重复调用应幂等，reason 决定结果里的终止原因。
  stop: (reason: StopReason) => void;
}

export interface NodeExecutionAdapterOptions {
  // 资源遥测采样回调（RSS/CPU/系统内存）；缺省则不上报。
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  // 输出落盘根目录；缺省用 resolveDefaultOutputRootDir。
  outputRootDir?: string;
  /** 仅 Bash 输出优先使用的临时父目录；不可用时复用 outputRootDir。 */
  bashOutputTempDir?: string;
  // 落盘总上限（字节）；缺省 DEFAULT_MAX_PERSISTED_OUTPUT_BYTES。
  maxPersistedOutputBytes?: number;
  // 网络出口策略，决定子进程代理/证书环境变量。
  network?: NetworkEgressEnvPolicy;
  // 平台覆盖（测试用）；缺省 process.platform。
  platform?: NodeJS.Platform;
  // 基础环境来源；缺省 process.env。
  processEnv?: NodeJS.ProcessEnv;
  // 进度轮询周期（毫秒）。
  progressIntervalMs?: number;
  // 进度预览回读的尾部字节数。
  progressTailBytes?: number;
  // 超过该耗时才开始发送进度事件（避免短命令刷屏）。
  progressThresholdMs?: number;
}

// 落盘策略：none=不落盘；on_truncate=超出内联预算才落盘；always=执行即落盘。
export type OutputPersistenceMode = "none" | "on_truncate" | "always";

// 终止原因封闭三态，直接进入 ExecutionResult 的错误分类。
export type StopReason = "timeout" | "cancelled" | "output_limit";
