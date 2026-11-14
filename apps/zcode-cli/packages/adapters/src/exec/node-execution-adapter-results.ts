// INV-01 状态优先级：守住位置 statusFromExit 的判断顺序；改错故障：启动错误被退出码分支掩盖。
// INV-02 终态事件：守住位置 emitResult 的分支；改错故障：启动错误被当成正常完成。
// INV-03 诊断有门：守住位置 空输出与非零判断；改错故障：正常无输出命令被报成输出丢失。
// INV-04 前后台口径：守住位置 readBashResult 的条件；改错故障：后台化输出按前台规则截断。
// INV-05 预建占位：守住位置 ensureBackgroundOutputFiles；改错故障：并发任务争抢创建输出文件。
// INV-06 路径去重：守住位置 集合去重；改错故障：同一路径被重复打开。
// INV-07 保留策略：守住位置 shouldKeepArtifact 的两分支；改错故障：按错误策略保留或丢弃 artifact。
// INV-08 直写不截断：守住位置 上限为空即返回；改错故障：完整原始文件被管道预算误截。
// INV-09 清理尽力：守住位置 删除的捕获；改错故障：清理异常让结果永久悬空。
// INV-10 元数据全去：守住位置 三字段的成组清除；改错故障：暴露半套 artifact 路径。
// INV-11 截断保真：守住位置 字节数回写；改错故障：声称截断但大小未变。
// INV-12 上限即取消：守住位置 硬上限改写；改错故障：写满上限被误判成超时。
// INV-13 失败文案：守住位置 statusFailure 的分支；改错故障：正常结束也带失败描述。
// INV-14 默认超时：守住位置 默认参数；改错故障：超时文案缺少可读时长。
// INV-15 未执行结果：守住位置 createStoppedResult；改错故障：伪造出非零输出。
// INV-16 时长计算：守住位置 起止时间差；改错故障：时长为负或缺失。
// INV-17 异常归一：守住位置 toFailure；改错故障：非错误对象丢失原始信息。
// INV-18 事件隔离：守住位置 emit 的捕获；改错故障：监听方异常打断执行主流程。
//
// 模块职责：把退出态、流结果与生命周期上下文装配成契约化的执行结果。
// 状态所有权：结果对象由本层构造；进程与 IO 归上层适配器。
// 阅读顺序：终态事件 → Bash 读取与预建 → 后台还原 → artifact 结算 → 状态映射 → 结果构造。
// ============================================================
// 文件定位：执行结果装配层：状态映射、失败文案、Bash 结果读取与 artifact 预算结算。
// 输入输出：输入退出态/流结果/生命周期上下文，输出契约化的 ExecutionResult / ExecutionStreamResult。
// 副作用：mkdir+open 预建输出文件、rm 删除冗余 artifact、r+ truncate 截断文件。
// 失败语义：清理/截断失败一律吞掉（best effort），不改变已确定的退出码；未知 pid 情况返回 undefined。
// 不变量：status 优先级 error>timedOut>cancelled>outputLimit>code===0；artifact 元数据要么完整要么全去。
// ============================================================
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BashFileOutput, diagnoseLostBashOutput } from "./bash-file-output.js";
import { NodeExecutionAdapterBase } from "./node-execution-adapter-base.js";
import { DEFAULT_TIMEOUT_MS, formatTimeoutDuration } from "./execution-utils.js";
import type {
  ExecutionOutputPaths,
  InternalExecutionRunOptions,
  ExitState,
  OutputPersistenceMode,
} from "./execution-adapter-types.js";
import type {
  ExecutionEvent,
  ExecutionFailure,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionStatus,
  ExecutionStreamResult,
} from "@zcode/contracts";

// 结果装配层：只做“把过程状态翻译成契约结果”，不 spawn、不等待进程。
// 所有 artifact 清理与截断都在这里结算，确保 run 层只关心进程与 IO。
// 只把过程状态翻译成契约结果，不启动进程也不等待。
// artifact 清理与截断都在本层结算。
// 调用方因此只关心进程与输入输出。
//
export class NodeExecutionAdapterResults extends NodeExecutionAdapterBase {
  // 向前端发终态事件：spawn_error 带 error 走 failed，其余（含非零退出）一律 completed + result。
  // 错误带 error 才发失败事件。
  // 其余情况一律发完成事件，退出码放在结果里。
  //
  protected emitResult(options: ExecutionRunOptions, result: ExecutionResult): void {
    if (result.status === "spawn_error" && result.error) {
      this.emit(options, { type: "failed", error: result.error, timestamp: result.completedAt });
    } else {
      this.emit(options, { type: "completed", result, timestamp: result.completedAt });
    }
  }

  // 读取 Bash 输出文件并按前台/后台口径结算内联与 artifact。
  // 仅当“空输出 + 非零且非 137 退出”时才做文件系统诊断，避免把正常无输出误报为输出丢失。
  // 前台与后台口径分别结算内联文本与 artifact。
  // 空输出加异常退出才做文件诊断，正常无输出不误报。
  //
  protected async readBashResult(
    file: BashFileOutput,
    request: ExecutionRequest,
    options: InternalExecutionRunOptions,
    exit: ExitState,
    outputLimitExceeded: boolean,
  ): Promise<ExecutionStreamResult> {
    let result = await file.result(this.bashInlineLimit(request));
    if (
      !options.bashLifecycle?.isBackgrounded() &&
      (outputLimitExceeded || !options.bashLifecycle)
    ) {
      result = await this.normalizeBashBackgroundLifecycleForegroundStream(
        result,
        file.path,
        undefined,
        outputLimitExceeded ? "none" : (request.outputLimit?.persistOutput ?? "none"),
      );
    }
    // 仅对空输出且非零退出进行文件系统诊断，不把正常无输出命令误报为丢失。
    if (result.text === "" && exit.code !== undefined && exit.code !== 0 && exit.code !== 137) {
      const diagnostic = await diagnoseLostBashOutput(file.path);
      if (diagnostic) result = { ...result, text: diagnostic };
    }
    return result;
  }

  // 预建后台输出文件：去重后逐个 mkdir 并以 0600 追加方式打开再关闭。
  // 先占位可让后续写流直接 append，也避免并发任务之间发生“谁先创建”的竞争。
  // 路径去重后逐个建目录并占位。
  // 预建可让写流直接追加，避免并发创建竞争。
  //
  protected async ensureBackgroundOutputFiles(paths: ExecutionOutputPaths): Promise<void> {
    for (const path of new Set([
      paths.outputPath,
      paths.stdoutPersistedOutputPath,
      paths.stderrPersistedOutputPath,
    ])) {
      if (!path) continue;
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a", 0o600);
      await handle.close();
    }
  }

  // Bash 后台化后回到前台的结果还原：两条流分别按“原始 persistOutput + 原始 artifact 上限”结算。
  // 结算读 originalPersistOutput 与 originalMaxArtifactBytes 两个入参，不重新拼默认值：后台阶段改过的上限不能带回前台。
  // 顺序固定先错误流后标准流，便于比对。
  //
  protected async normalizeBashBackgroundLifecycleForegroundResult(
    result: ExecutionResult,
    paths: ExecutionOutputPaths,
    originalMaxArtifactBytes: number | undefined,
    originalPersistOutput: OutputPersistenceMode,
  ): Promise<ExecutionResult> {
    return {
      ...result,
      stderr: await this.normalizeBashBackgroundLifecycleForegroundStream(
        result.stderr,
        paths.stderrPersistedOutputPath,
        originalMaxArtifactBytes,
        originalPersistOutput,
      ),
      stdout: await this.normalizeBashBackgroundLifecycleForegroundStream(
        result.stdout,
        paths.stdoutPersistedOutputPath,
        originalMaxArtifactBytes,
        originalPersistOutput,
      ),
    };
  }

  // 单路结算：总是保留 artifact（always/none）或仅截断时保留（on_truncate）；
  // 不保留时删除文件并清空 artifact 元数据，保证前台契约里不暴露多余路径。
  // 保留策略只认两种：始终保留或仅截断时保留。
  // 直写保留完整文件，只有管道执行才应用预算。
  //
  protected async normalizeBashBackgroundLifecycleForegroundStream(
    stream: ExecutionStreamResult,
    path: string | undefined,
    originalMaxArtifactBytes: number | undefined,
    originalPersistOutput: OutputPersistenceMode,
  ): Promise<ExecutionStreamResult> {
    const shouldKeepArtifact =
      originalPersistOutput === "always"
        ? stream.artifactPath !== undefined
        : originalPersistOutput === "on_truncate" && stream.truncated;
    // Bash 直写保留完整原始文件；仅通用 pipe 执行在结算时应用 artifact 预算。
    if (shouldKeepArtifact && originalMaxArtifactBytes === undefined) return stream;
    if (
      shouldKeepArtifact &&
      originalMaxArtifactBytes !== undefined &&
      originalMaxArtifactBytes > 0
    ) {
      return await this.capForegroundArtifactStream(stream, path, originalMaxArtifactBytes);
    }

    if (path) {
      try {
        await rm(path, { force: true });
      } catch {
        // foreground lifecycle 的主结算曾与 artifact 清理耦合，删除异常会让
        // outcome 永久悬空。清理仅是 best-effort；结果仍按 foreground 契约隐藏冗余路径。
      }
    }
    if (
      stream.artifactPath === undefined &&
      stream.artifactBytes === undefined &&
      stream.artifactTruncated === undefined
    ) {
      return stream;
    }
    return {
      ...stream,
      artifactBytes: undefined,
      artifactPath: undefined,
      artifactTruncated: undefined,
    };
  }

  // 把 artifact 截断到 maxBytes（就地 r+ truncate）并回写真实字节数；打不开/截断失败原样返回。
  // 仅在已有字节数超过上限时就地截断。
  // 打不开或截断失败原样返回，不伪报已截断。
  //
  protected async capForegroundArtifactStream(
    stream: ExecutionStreamResult,
    path: string | undefined,
    maxBytes: number,
  ): Promise<ExecutionStreamResult> {
    if (!path || stream.artifactBytes === undefined || stream.artifactBytes <= maxBytes) {
      return stream;
    }
    try {
      const handle = await open(path, "r+");
      try {
        await handle.truncate(maxBytes);
      } finally {
        await handle.close();
      }
    } catch {
      // 截断失败不能阻塞已经完成的命令；保留真实 artifact 元数据，避免伪报已截断。
      return stream;
    }
    return {
      ...stream,
      artifactBytes: maxBytes,
      artifactTruncated: true,
    };
  }

  // 后台任务触达 5GB 硬上限时改写结果：状态 cancelled、exitCode 137、error.type=output_limit。
  // 与超时区分开，避免调用方把“写满上限”误判为 timeout。
  // 未触达上限直接返回原结果。
  // 触达后改写为取消态，退出码固定一百三十七。
  //
  protected normalizeBashBackgroundOutputLimitResult(
    result: ExecutionResult,
    persistedLimitReached: boolean,
  ): ExecutionResult {
    if (!persistedLimitReached) return result;
    return {
      ...result,
      status: "cancelled",
      exitCode: 137,
      timedOut: false,
      cancelled: true,
      error: {
        type: "output_limit",
        message: "Background command killed: output file exceeded 5GB",
      },
    };
  }

  // 退出态 → 状态：spawn 错误 > 超时 > 取消 > 输出限额失败 > 按退出码 completed/failed。
  // 优先级固定：启动错误优先于超时。
  // 超时优先于取消，取消优先于输出限额。
  //
  protected statusFromExit(
    exitState: ExitState,
    timedOut: boolean,
    cancelled: boolean,
    outputLimitExceeded = false,
  ): ExecutionStatus {
    if (exitState.error) return "spawn_error";
    if (timedOut) return "timed_out";
    if (cancelled) return "cancelled";
    if (outputLimitExceeded) return "failed";
    return exitState.code === 0 ? "completed" : "failed";
  }

  // 终止原因 → 失败描述：超时带可读时长；取消/输出限额用固定文案；正常结束返回 undefined。
  // 超时文案带可读时长，默认取全局超时。
  // 正常结束返回空，不制造失败描述。
  //
  protected statusFailure(
    timedOut: boolean,
    cancelled: boolean,
    outputLimitExceeded = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): ExecutionFailure | undefined {
    if (timedOut) {
      return {
        type: "timeout",
        message: `Command timed out after ${formatTimeoutDuration(timeoutMs)}`,
      };
    }
    if (cancelled) {
      return { type: "cancelled", message: "Execution cancelled" };
    }
    if (outputLimitExceeded) {
      return {
        type: "output_limit",
        message: "Execution output exceeded the persisted output limit",
      };
    }
    return undefined;
  }

  // 构造“未真正执行”的终态结果：空双流、零字节，并把状态映射成对应 failure type。
  protected createStoppedResult(
    startedAt: Date,
    status: ExecutionStatus,
    message: string,
  ): ExecutionResult {
    const completedAt = new Date();
    const failureType =
      status === "cancelled" ? "cancelled" : status === "timed_out" ? "timeout" : "spawn_error";
    return this.createResult({
      status,
      startedAt,
      completedAt,
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      timedOut: status === "timed_out",
      cancelled: status === "cancelled",
      error: { type: failureType, message },
    });
  }

  // 结果统一装配点：durationMs 由 completedAt-startedAt 计算，未提供的可选字段保持 undefined。
  protected createResult(args: {
    status: ExecutionStatus;
    startedAt: Date;
    completedAt: Date;
    stdout: ExecutionStreamResult;
    stderr: ExecutionStreamResult;
    timedOut: boolean;
    cancelled: boolean;
    pid?: number;
    exitCode?: number;
    signal?: string;
    error?: ExecutionFailure;
    resolvedCwd?: string;
  }): ExecutionResult {
    return {
      status: args.status,
      exitCode: args.exitCode,
      signal: args.signal,
      stdout: args.stdout,
      stderr: args.stderr,
      durationMs: args.completedAt.getTime() - args.startedAt.getTime(),
      timedOut: args.timedOut,
      cancelled: args.cancelled,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      pid: args.pid,
      error: args.error,
      resolvedCwd: args.resolvedCwd,
    };
  }

  // 任意异常 → ExecutionFailure：保留原始错误为 cause，非 Error 用 String() 兜底。
  protected toFailure(type: ExecutionFailure["type"], error: unknown): ExecutionFailure {
    if (error instanceof Error) {
      return {
        type,
        message: error.message,
        cause: error,
      };
    }

    return {
      type,
      message: String(error),
      cause: error,
    };
  }

  // 事件出口：无回调直接丢弃；回调异常吞掉，避免监听方 bug 打断执行主流程。
  protected emit(options: ExecutionRunOptions, event: ExecutionEvent): void {
    if (!options.onEvent) return;
    void Promise.resolve(options.onEvent(event)).catch(() => undefined);
  }
}
