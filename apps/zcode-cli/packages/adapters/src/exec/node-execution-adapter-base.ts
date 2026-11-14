// INV-01 两张表回收语义不同：守住位置 前台删后台留；改错故障 已完成任务凭空消失。
// INV-02 前台收尾只兑现一次：守住位置 completion 的 resolve；改错故障 重复结算导致监听错乱。
// INV-03 关闭幂等：守住位置 首个 promise 缓存；改错故障 二次关闭重复取消任务。
// INV-04 关闭顺序固定：守住位置 取消、停止、结算、清理的次序；改错故障 结算前进程退出。
// INV-05 单个清理失败不阻断：守住位置 全部落定聚合；改错故障 一个异常跳过后面的收尾。
// INV-06 进程树清理要保活：守住位置 关闭前的引用；改错故障 强杀前 Node 提前退出。
// INV-07 输出路径按请求缓存：守住位置 弱映射；改错故障 同一请求两条流路径不一致。
// INV-08 不落盘请求提前返回空：守住位置 早退分支；改错故障 无谓创建目录。
// INV-09 路径段统一消毒：守住位置 片段清洗；改错故障 标识里的分隔符穿越目录。
// INV-10 合并输出只有单一路径：守住位置 请求判定；改错故障 错误产出两份日志。
// INV-11 内联上限三级回退：守住位置 空值合并链；改错故障 老字段被忽略后额度骤降。
// INV-12 落盘上限按请求优先：守住位置 优先级链；改错故障 适配器配置覆盖单次请求。
// INV-13 后台快照只收摘要：守住位置 事件类型过滤；改错故障 大段文本常驻内存。
// INV-14 终态写入后不再变化：守住位置 收尾函数；改错故障 状态在完成后被回写成运行中。
// INV-15 对外快照不含句柄：守住位置 字段白名单；改错故障 控制器与承诺泄漏到调用方。
// INV-16 进度参数有下限：守住位置 取大值；改错故障 零周期造成忙轮询。
// INV-17 平台与环境可注入：守住位置 两个 getter；改错故障 测试无法模拟目标平台。
// INV-18 构造不阻塞：守住位置 清理快照的异步启动；改错故障 启动被磁盘扫描拖慢。
//
// 模块职责：执行适配器的状态与预算基类，统一前台执行、后台任务与输出路径。
// 状态所有权：三张表与路径缓存都在实例内，关闭承诺按实例缓存一次。
// 阅读顺序：先看表与构造，再看路径与限额解析，最后看后台记录与关停。
// ============================================================
// 文件定位：执行适配器的状态与预算基类：活动执行表、后台任务表、输出路径与限额解析。
// 输入输出：内部方法供 lifecycle/run/process/results 使用；对外仅暴露 close()。
// 副作用：构造时触发一次过期快照清理（后台、失败被吞）；输出路径延迟到首次使用才计算。
// 失败语义：close 幂等；清理失败不影响关闭；不存在的执行 id 静默忽略。
// 不变量：activeExecutions 的 completion 只 resolve 一次；WeakMap 保证请求对象释放后路径随之回收。
// ============================================================
import { join } from "node:path";
import { resolveBashMaxOutputLength } from "./bash-output-policy.js";
import { ShellInitSnapshotManager, cleanupStaleShellInitSnapshots } from "./shell-init-snapshot.js";
import { OutputCollector, type AggregatePersistedOutputBudget } from "./output-collector.js";
import {
  DEFAULT_INLINE_OUTPUT_BYTES,
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_PROGRESS_TAIL_BYTES,
  DEFAULT_PROGRESS_THRESHOLD_MS,
  isBashMergedOutputRequest,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
} from "./execution-utils.js";
import type {
  ActiveExecutionRecord,
  BackgroundTaskRecord,
  ExecutionOutputPaths,
  NodeExecutionAdapterOptions,
  StopReason,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
} from "@zcode/contracts";

// activeExecutions 前台必删，backgroundTasks 后台留到显式清理。
// 两张表的键都是随机标识（executionId / taskId），天然跨请求隔离。
// ActiveExecutionRecord 的 close 句柄只做一次性承诺，不做状态机。
// outputPathsByRequest 以 request 对象为键，避免串流污染。
// NodeExecutionAdapterBase 不启动进程，只提供状态字段与公共口径。
export class NodeExecutionAdapterBase {
  // 前台执行记录：executionId → 收尾 promise 与 stop 句柄，用于 close/cancel 统一回收。
  protected readonly activeExecutions = new Map<string, ActiveExecutionRecord>();

  // 后台任务记录：taskId → 可变快照与完成 promise；任务结束后仍保留直至显式清理。
  protected readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();

  // 尚未完成的 Bash 进程树清理：value.ref() 用来在关停时让 Node 保持事件循环。
  protected readonly pendingBashProcessTreeKills = new Map<Promise<void>, { ref(): unknown }>();

  // 构造时启动的过期快照清理；shutdown 会等待它结束，失败已被吞。
  protected readonly shellInitRetentionCleanup: Promise<unknown>;

  protected readonly shellInitSnapshots = new ShellInitSnapshotManager();

  // 以请求对象为键缓存输出路径，避免同一请求在多条流上算出不一致的路径。
  protected readonly outputPathsByRequest = new WeakMap<ExecutionRequest, ExecutionOutputPaths>();

  // close 的幂等缓存：重复调用返回同一 promise。
  protected closePromise?: Promise<void>;

  protected readonly options: NodeExecutionAdapterOptions;

  // 保存 options 并异步清理过期 shell 快照；不阻塞构造，也不让清理错误冒泡。
  constructor(options: NodeExecutionAdapterOptions = {}) {
    this.options = options;
    const rootDir = options.outputRootDir ?? resolveDefaultOutputRootDir(options.processEnv);
    this.shellInitRetentionCleanup = cleanupStaleShellInitSnapshots({ rootDir }).catch(
      () => undefined,
    );
  }

  // 为某一路流创建 collector：内联/落盘预算、尾部大小与持久化模式都按请求解析。
  // stdout/stderr 可选择共享 aggregatePersistedBudget，避免两条流各自写满上限。
  protected createOutputCollector(
    request: ExecutionRequest,
    streamName: "stdout" | "stderr",
    legacyOutputEncoding: string | null,
    onPersistedLimit?: () => void,
    aggregatePersistedBudget?: AggregatePersistedOutputBudget,
  ): OutputCollector {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    const outputPath = this.outputPathForRequest(request, streamName);
    return new OutputCollector({
      maxInlineBytes: this.inlineLimit(request),
      maxPersistedBytes: this.persistedOutputLimit(request),
      legacyOutputEncoding,
      maxTailBytes: this.progressTailBytes,
      onPersistedLimit,
      outputPath,
      persistOutput,
      aggregatePersistedBudget,
    });
  }

  // 按流名取落盘路径；Bash 合并输出时 stdout 路径即唯一 artifact 路径。
  protected outputPathForRequest(
    request: ExecutionRequest,
    streamName: "stdout" | "stderr",
  ): string | undefined {
    const paths = this.outputPathsForRequest(request);
    return streamName === "stdout"
      ? paths.stdoutPersistedOutputPath
      : paths.stderrPersistedOutputPath;
  }

  // 解析并缓存请求的输出路径：persistOutput=none 且非 Bash 时直接返回 {}（不落盘）。
  // 路径口径：<root>/<消毒后的 sessionId>/<消毒后的 toolCallId>-stdout.log（stderr 同构）。
  // 不落盘请求提前返回，省掉 mkdir 与目录计算。
  // 先查 outputPathsByRequest 缓存，再算 sessionId 与 toolCallId。
  // usesBashMergedOutput 为 true 时 stdout/stderr 合并为单一路径。
  // toolCallId 缺失时用随机值兜底，仍占一段路径。
  // 路径段由 sanitizePathSegment 统一消毒，杜绝目录穿越。
  protected outputPathsForRequest(request: ExecutionRequest): ExecutionOutputPaths {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    const usesBashMergedOutput = isBashMergedOutputRequest(request);
    if (persistOutput === "none" && !usesBashMergedOutput) return {};

    const existing = this.outputPathsByRequest.get(request);
    if (existing) return existing;

    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const toolCallId = sanitizePathSegment(
      String(request.trace?.attributes?.toolCallId ?? crypto.randomUUID()),
    );
    const stdoutPersistedOutputPath = join(rootDir, sessionId, `${toolCallId}-stdout.log`);
    if (usesBashMergedOutput) {
      const paths = {
        outputPath: stdoutPersistedOutputPath,
        stdoutPersistedOutputPath,
      };
      this.outputPathsByRequest.set(request, paths);
      return paths;
    }
    const stderrPersistedOutputPath = join(rootDir, sessionId, `${toolCallId}-stderr.log`);
    const paths = {
      outputPath: stdoutPersistedOutputPath,
      stderrPersistedOutputPath,
      stdoutPersistedOutputPath,
    };
    this.outputPathsByRequest.set(request, paths);
    return paths;
  }

  // 内联上限：maxInlineBytes 优先，其次兼容旧字段 maxBufferBytes，最后 10MB 默认。
  protected inlineLimit(request: ExecutionRequest): number {
    return (
      request.outputLimit?.maxInlineBytes ??
      request.outputLimit?.maxBufferBytes ??
      DEFAULT_INLINE_OUTPUT_BYTES
    );
  }

  // Bash 内联上限：在请求内联额度之上再经 BASH_MAX_OUTPUT_LENGTH 收窄（默认 30k、硬顶 150k）。
  protected bashInlineLimit(request: ExecutionRequest): number {
    return resolveBashMaxOutputLength(this.processEnv, this.inlineLimit(request));
  }

  // 落盘上限优先级：请求 → adapter 选项 → Bash 5GB / 通用 50MB 默认。
  protected persistedOutputLimit(request: ExecutionRequest): number {
    return (
      request.outputLimit?.maxPersistedBytes ??
      this.options.maxPersistedOutputBytes ??
      (isBashMergedOutputRequest(request)
        ? BASH_RUNTIME_OUTPUT_LIMIT_BYTES
        : DEFAULT_MAX_PERSISTED_OUTPUT_BYTES)
    );
  }

  // 建后台任务记录：先造一个只 resolve 一次的 completion，再填初始快照字段。
  // 初始 legacyOutputEncoding 为 null，探测完成后由 onOutputEncodingResolved 回写。
  // completion 只由收尾函数兑现，外部不得提前 resolve。
  // status 初值即 running，后续由事件推进。
  // sessionId 允许缺失，记录里保留 undefined。
  // outputPaths 整体展开进记录，不复制字段。
  // outputEncoding 在探测完成前保持 null。
  protected createBackgroundTaskRecord(args: {
    controller: AbortController;
    outputPaths: ExecutionOutputPaths;
    startedAt: Date;
    taskId: string;
    request: ExecutionRequest;
  }): BackgroundTaskRecord {
    let resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void = () => undefined;
    const completion = new Promise<BackgroundExecutionSnapshot>((resolve) => {
      resolveCompletion = resolve;
    });
    return {
      completion,
      controller: args.controller,
      resolveCompletion,
      startedAt: args.startedAt,
      status: "running",
      taskId: args.taskId,
      sessionId: args.request.trace?.sessionId,
      isBash: isBashMergedOutputRequest(args.request),
      legacyOutputEncoding: null,
      ...args.outputPaths,
    };
  }

  // 从事件更新任务快照：started 只补 pid；progress 更新 pid 与双流字节/尾部。
  // 其他事件（stdout/stderr 片段等）不进入后台快照，避免记录持有大块文本。
  protected updateBackgroundTaskRecordFromEvent(
    record: BackgroundTaskRecord,
    event: ExecutionEvent,
  ): void {
    if (event.type === "started") {
      record.pid = event.pid;
      return;
    }
    if (event.type !== "progress") return;
    record.pid = event.pid ?? record.pid;
    record.stderrBytes = event.stderrBytes;
    record.stderrTail = event.stderrTail;
    record.stdoutBytes = event.stdoutBytes;
    record.stdoutTail = event.stdoutTail;
  }

  // 任务收尾：写入终态字段后 resolve completion；之后记录仍可读，但状态不再变化。
  protected finalizeBackgroundTaskRecord(
    record: BackgroundTaskRecord,
    result: ExecutionResult,
  ): void {
    record.status = result.status;
    record.completedAt = result.completedAt;
    record.pid = result.pid ?? record.pid;
    record.result = result;
    record.error = result.error;
    record.resolveCompletion(this.snapshot(record));
  }

  // 生成对外快照的浅拷贝：只暴露契约字段，内部 controller/completion 不外泄。
  protected snapshot(record: BackgroundTaskRecord): BackgroundExecutionSnapshot {
    return {
      taskId: record.taskId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      pid: record.pid,
      stderrBytes: record.stderrBytes,
      stderrTail: record.stderrTail,
      stdoutBytes: record.stdoutBytes,
      stdoutTail: record.stdoutTail,
      outputPath: record.outputPath,
      stderrPersistedOutputPath: record.stderrPersistedOutputPath,
      stdoutPersistedOutputPath: record.stdoutPersistedOutputPath,
      result: record.result,
      error: record.error,
    };
  }

  // 平台 getter：支持测试注入，缺省为当前进程平台。
  protected get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  // 环境 getter：测试可注入自定义 env；缺省 process.env（只读使用，不修改）。
  protected get processEnv(): NodeJS.ProcessEnv {
    return this.options.processEnv ?? process.env;
  }

  // 进度轮询周期（毫秒），下限 1ms 防止 0 造成忙轮询。
  protected get progressIntervalMs(): number {
    return Math.max(1, this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  }

  // 进度预览尾部字节数，下限 0（0 表示不保留预览）。
  protected get progressTailBytes(): number {
    return Math.max(0, this.options.progressTailBytes ?? DEFAULT_PROGRESS_TAIL_BYTES);
  }

  // 开始发进度事件的耗时阈值，下限 0（0 表示立即发）。
  protected get progressThresholdMs(): number {
    return Math.max(0, this.options.progressThresholdMs ?? DEFAULT_PROGRESS_THRESHOLD_MS);
  }

  // 结束一次前台执行：resolve 其 completion 并从表中移除；未知 id 静默返回。
  protected completeActiveExecution(executionId: string): void {
    const record = this.activeExecutions.get(executionId);
    if (!record) return;
    record.resolveCompletion();
    this.activeExecutions.delete(executionId);
  }

  // 登记一次前台执行并返回随机 executionId；completion 由 completeActiveExecution 触发。
  protected registerActiveExecution(stop: (reason: StopReason) => void): string {
    const executionId = crypto.randomUUID();
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeExecutions.set(executionId, {
      completion,
      resolveCompletion,
      stop,
    });
    return executionId;
  }

  // 幂等关闭：首次调用执行 shutdown，后续调用复用同一 promise。
  async close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return await this.closePromise;
  }

  // 关停顺序：取消运行中后台任务 → 停止所有前台执行 → 等它们结算 → 等进程树清理 →
  // 等过期快照清理与当前快照删除。全程 allSettled，单个清理失败不阻断关闭。
  protected async shutdown(): Promise<void> {
    for (const record of this.backgroundTasks.values()) {
      if (record.status === "running") {
        record.status = "cancelled";
        record.controller.abort();
      }
    }

    const activeExecutions = Array.from(this.activeExecutions.values());
    for (const record of activeExecutions) {
      record.stop("cancelled");
    }

    await Promise.allSettled(activeExecutions.map((record) => record.completion));
    // 直写后没有 pipe 保活，仅 await Promise 会让 Node 在 SIGKILL 前退出。
    // active execution 已结算，所有主动终止均已登记；只在 shutdown 引用既有清理句柄。
    for (const handle of this.pendingBashProcessTreeKills.values()) handle.ref();
    await Promise.allSettled(Array.from(this.pendingBashProcessTreeKills.keys()));
    await this.shellInitRetentionCleanup;
    await this.shellInitSnapshots.cleanup();
  }
}
