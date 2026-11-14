// ============================================================
// 深度注释（INV-01..INV-20）：本文件是「一次执行」的完整状态机，每条给出不变量、守卫位置与破坏后果。
//   修改 spawn/停止/超时/限额相关代码前，请按守卫位置逐条核对，这些约束都没有类型系统保护。
// ------------------------------------------------------------
// INV-01 全文件只有一个 spawn 调用点（守卫：run 内 const spawnedChild = spawn 处）。
//   若在别处新建子进程，exit/close 监听与取消登记会脱钩，孤儿进程无人收尸。
// INV-02 退出态只写一次（守卫：finishExit 开头的 if (exited) return）。
//   去掉幂等判断后 error/exit/强杀三路重复 resolve，资源遥测被重复上报。
// INV-03 停止请求只接受第一次（守卫：requestStop 对 executionSettled 与 stopRequested 的早退）。
//   多次 stop 会把 timeout 覆盖成 cancelled，最终状态与真实原因错位。
// INV-04 取消必须能命中尚未 spawn 的窗口（守卫：stoppedBeforeSpawn 与 prepareBashOutput 的 isStopped）。
//   缺失该窗口时取消后仍起进程，产生无法归属到任何请求的 shell。
// INV-05 停止后已开文件必须丢弃（守卫：closePromise 与 aborted 分支里的 file.discard）。
//   不丢弃会留下 tmpdir 孤儿文件，后续读取读到半截内容。
// INV-06 活动执行登记必须成对（守卫：registerActiveExecution 与 finally 的 completeActiveExecution）。
//   漏掉释放会让 close 永远等不齐，适配器关停表现为卡死。
// INV-07 输出路径在 spawn 前确定并发布一次（守卫：outputPathsByRequest.set 调用点）。
//   若 spawn 后还能降级路径，后台记录与实际写入文件会指向两个不同文件。
// INV-08 准备阶段的取消返回 cancelled 空结果（守卫：prepareBashOutput 内的 cancelled 闭包）。
//   改成抛错会让上层把用户取消当成 spawn_error 展示。
// INV-09 tmp 目录降级只对白名单 errno 生效（守卫：BASH_TEMP_UNAVAILABLE_CODES 集合判断）。
//   放宽白名单会吞掉真实配置错误，命令看似成功但输出落到意外路径。
// INV-10 落盘上限回调只触发一次（守卫：persistedLimitNotified 标志）。
//   重复触发会重复 requestStop，第二次撞早退后状态位与事件语义不一致。
// INV-11 stdin 写失败默认不算失败（守卫：isExpectedChildStdinClosureError 过滤）。
//   一律升级为 failed 会把子进程提前关管道的正常情况误报成命令失败。
// INV-12 Bash 合并输出下 stderr 恒为空（守卫：stderrResult 的三元常量分支）。
//   改成读 collector 会在文件模式拿到 undefined 而抛空引用。
// INV-13 只有 completed 且退出码为 0 才回读 cwd（守卫：resolvedCwd 的条件赋值）。
//   失败命令回读 cwd 会把半途写入的垃圾值当成新工作目录向下传播。
// INV-14 timeout 只覆盖子进程运行期（守卫：timeoutTimer 在 spawn 之后才创建）。
//   提前启动计时会让慢 shell 初始化被误判 timed_out，命令一次都没跑。
// INV-15 计时器与监听必须释放（守卫：finally 的 clearTimeout、clearInterval、removeEventListener）。
//   漏掉清理会挂住事件循环，CLI 退出被拖到超时。
// INV-16 强杀之后必须释放读端（守卫：forceExitTimer 回调里的 destroyChildOutputStreams）。
//   不释放则脱离进程组仍持有 pipe，ZCode 进程被未知后代保活。
// INV-17 进程树清理与根进程退出解耦（守卫：terminateProcessTree 在 exit 之后仍可调用）。
//   绑定 root exit 会漏杀继承 pipe 的后代，形成跨执行残留。
// INV-18 落盘预算双流共享（守卫：aggregatePersistedBudget 被两个 collector 共同引用）。
//   各建一份预算会让 stdout 与 stderr 合计超出配置上限一倍。
// INV-19 输出文件句柄由本层关闭（守卫：finally 中统一的 file.close）。
//   依赖 GC 关闭句柄在 Windows 上会因文件被占用导致后续重命名失败。
// INV-20 Bash 生命周期钩子必须可撤销（守卫：finally 把 onBackgrounded 置回 undefined）。
//   不撤销会让已结束执行在后台化回调里再次武装限额监听，形成幽灵监听。
// ============================================================
// ============================================================
// 文件定位：单次执行的主流程：Bash 输出准备 → spawn → 事件/进度 → 等待退出 → IO 排空 → 结果装配。
// 输入输出：run(request, options) 返回 ExecutionResult；prepareBashOutput 返回已准备文件或提前停止结果。
// 副作用：mkdtemp 临时目录、open 输出文件、spawn 子进程、setTimeout/setInterval（均已 unref）、杀进程树。
// 失败语义：spawn 失败转 spawn_error 并仍产出 stdout/stderr；准备阶段取消返回 cancelled 空结果。
// 不变量：timeout 只约束子进程运行期；收尾在 finally 统一停表、停预览、关文件、注销活动执行。
// ============================================================
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BashFileOutput } from "./bash-file-output.js";
import { readCapturedCwd } from "./cwd-capture.js";
import { defaultCwdDialect } from "./execution-command.js";
import { NodeExecutionAdapterProcess } from "./node-execution-adapter-process.js";
import { resolveLegacyExecutionOutputEncoding } from "./outputEncoding.js";
import {
  DEFAULT_TIMEOUT_MS,
  FORCE_EXIT_AFTER_KILL_MS,
  abortSignalReason,
  isBashMergedOutputRequest,
  isExpectedChildStdinClosureError,
  resolveDefaultOutputRootDir,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedBashOutput,
  StopReason,
} from "./execution-adapter-types.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";

// [资源] 临时根目录前缀固定，便于运维按前缀清理残留；改名会让历史残留永远匹配不到清理规则。
// [权衡] 白名单只覆盖可预期的资源类 errno，其余错误必须上抛，避免把权限或挂载配置错误伪装成降级成功。
const BASH_TEMP_DIRECTORY_PREFIX = "zcode-bash-";
const BASH_TEMP_UNAVAILABLE_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "ENOTDIR",
  "ENOSPC",
  "EDQUOT",
]);

// 运行层：整个执行生命周期只有这一处 spawn，其余层只消费它的结果。
// 请求级状态（取消原因、限额标记、退出 promise）都限制在 run 的局部作用域。
export class NodeExecutionAdapterRun extends NodeExecutionAdapterProcess {
  // 每适配器只建一次 Bash 临时根目录；生成失败后自动清空以便下次重试。
  private bashTempRoot?: Promise<string>;

  // 是否走“Bash 输出直写磁盘临时文件”：仅当配置了 bashOutputTempDir 且是合并输出请求。
  protected usesBashTempOutput(request: ExecutionRequest): boolean {
    return this.options.bashOutputTempDir !== undefined && isBashMergedOutputRequest(request);
  }

  // 取得（并缓存）Bash 临时根目录；mkdtemp 失败时清空缓存，避免把一次失败永久钉住。
  private getBashTempRoot(): Promise<string> {
    if (!this.bashTempRoot) {
      const pending = mkdtemp(join(this.options.bashOutputTempDir!, BASH_TEMP_DIRECTORY_PREFIX));
      this.bashTempRoot = pending;
      void pending.catch(() => {
        if (this.bashTempRoot === pending) this.bashTempRoot = undefined;
      });
    }
    return this.bashTempRoot;
  }

  // 准备 Bash 输出：优先生成 tmpdir 下的隔离文件，不可用时回退 storage 路径（同一实现两种位置）。
  // 期间任何一次 isStopped() 都会丢弃半成品并返回 cancelled 结果，避免取消后遗留文件。
  protected async prepareBashOutput(
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<{ prepared: PreparedBashOutput } | { result: ExecutionResult }> {
    const startedAt = new Date();
    let stopped = false;
    // 准备阶段也登记为活动执行，使 close()/cancel() 能中断尚未 spawn 的准备工作。
    const executionId = this.registerActiveExecution(() => {
      stopped = true;
    });
    // [并发] 准备阶段的注销必须恰好一次：取消分支与正常返回互斥，重复调用会把登记计数减成负数。
    // [事务] 该闭包塞进 prepared.releasePreparation 交给 run 消费，保证准备与运行两段只有一处注销。
    const releasePreparation = () => this.completeActiveExecution(executionId);
    const isStopped = () => stopped || this.closePromise !== undefined || options.signal?.aborted;
    let file: BashFileOutput | undefined;
    // [失败路径] 取消终态统一走这里：先丢弃半成品文件再注销登记，顺序反了会留下无人引用的 fd。
    // [资源] discard 失败不阻断返回，取消路径必须无条件收敛成 cancelled 结果而不是抛错。
    const cancelled = async () => {
      await file?.discard();
      releasePreparation();
      return {
        result: this.createStoppedResult(
          startedAt,
          "cancelled",
          "Execution cancelled before spawn",
        ),
      };
    };
    try {
      if (isStopped()) return await cancelled();
      const legacyOutputEncoding = resolveLegacyExecutionOutputEncoding({
        platform: this.platform,
        processEnv: this.processEnv,
      });
      const knownPath = this.outputPathForRequest(request, "stdout")!;
      // 请求可能被复用；缓存保存的是实际路径，降级根必须始终来自原有配置。
      // [资源] 降级根必须重新从配置推导，不能用缓存里的实际路径反推，否则请求复用时会漂移到 tmp 目录。
      // [权衡] 目录名与文件名拆开重新 join，是为了在切换根的同时保留请求维度子目录，避免不同请求互相覆盖。
      const fallbackPath = join(
        this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv),
        basename(dirname(knownPath)),
        basename(knownPath),
      );
      try {
        const root = await this.getBashTempRoot();
        if (isStopped()) return await cancelled();
        const path = join(root, basename(dirname(fallbackPath)), basename(fallbackPath));
        file = new BashFileOutput(path, this.platform, legacyOutputEncoding);
        await file.prepare();
      // 临时目录建不出来时只对“可预期的资源问题”降级；其他错误继续抛出，暴露真实故障。
      } catch (error) {
        if (isStopped()) return await cancelled();
        // [失败路径] 非白名单错误直接上抛，由外层 catch 统一转 spawn_error，保留真实 errno 供用户排查。
        // [并发] 抛错前再判一次 isStopped：取消与失败同时到达时以取消为准，避免把取消误报成准备失败。
        if (!BASH_TEMP_UNAVAILABLE_CODES.has((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        await file?.discard();
        // 搜索数据目录会把正在写入的输出再次读回；优先隔离到 tmp，失败后完整复用旧文件实现。
        file = new BashFileOutput(fallbackPath, this.platform, legacyOutputEncoding);
        await file.prepare();
      }
      if (isStopped()) return await cancelled();
      // 路径必须在后台记录和文件入口发布之前确定，不能在 spawn 后再降级或重新打开。
      this.outputPathsByRequest.set(request, {
        outputPath: file.path,
        stdoutPersistedOutputPath: file.path,
      });
      // [事务] 此刻文件已 prepare 且路径已发布，调用方必须负责 close 或 discard，本层不再回收。
      // [权衡] 返回前必须先用 isStopped 兜底：宁可丢弃已开的文件，也不让取消后仍继续 spawn。
      return { prepared: { file, legacyOutputEncoding, releasePreparation } };
    } catch (error) {
      await file?.discard();
      releasePreparation();
      if (isStopped()) return await cancelled();
      return {
        result: this.createStoppedResult(
          startedAt,
          "spawn_error",
          this.toFailure("spawn_error", error).message,
        ),
      };
    }
  }

  // 执行主流程：准备输出 → spawn → 接事件/进度 → 等 exit → 排空 pipe → 组装结果。
  // 准备阶段失败时直接返回结果；spawn 之后无论成败都走 finally 清理，保证进程与文件不泄漏。
  async run(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = new Date();
    const useBashMergedOutput = isBashMergedOutputRequest(request);
    // [并发] 先给空实现占位，是因为 terminateStartedChild 与登记回调可能在赋值前被引用，空实现让早触发变成无害。
    // [事务] 真正赋值发生在 try 之前，保证 spawn 前注册的取消回调一定能命中状态机。
    let requestStop: (reason: StopReason) => void = () => undefined;
    let outputLimitExceeded = false;
    const internalOptions = options as InternalExecutionRunOptions;
    let preparedOutput = internalOptions.preparedBashOutput;
    // 未显式传入 prepared 时自行准备；准备即失败则已经是终态，直接回传不再 spawn。
    if (!preparedOutput && this.usesBashTempOutput(request)) {
      const preparation = await this.prepareBashOutput(request, options);
      if ("result" in preparation) {
        this.emitResult(options, preparation.result);
        return preparation.result;
      }
      preparedOutput = preparation.prepared;
    }
    // stdout/stderr 共享一份“落盘硬预算”，双流合计不能超过 persistedOutputLimit。
    // [资源] 双流共享同一个 bytes 计数器，任何一路写入都会推进合计，避免上限被各算一遍而翻倍。
    // [权衡] 未开启共享时传 undefined，collector 退回各自限额，兼容只关心单流的旧调用方。
    const aggregatePersistedBudget = internalOptions.sharePersistedOutputLimitAcrossStreams
      ? {
          bytes: 0,
          maxBytes: Math.max(0, this.persistedOutputLimit(request)),
        }
      : undefined;

    // 已关停：即使已准备好文件也要丢弃并释放准备登记，不能留下孤儿输出文件。
    if (this.closePromise) {
      await preparedOutput?.file.discard();
      preparedOutput?.releasePreparation();
      return this.createStoppedResult(startedAt, "cancelled", "Execution adapter is shutting down");
    }

    // 父级 signal 已在 spawn 前触发：与“适配器关闭”同样走取消终态，避免白起进程。
    if (options.signal?.aborted) {
      await preparedOutput?.file.discard();
      preparedOutput?.releasePreparation();
      return this.createStoppedResult(startedAt, "cancelled", "Execution cancelled before spawn");
    }

    // [并发] 标志在回调闭包里做一次性闸门：限额与停止谓词可能并发触发，重复通知会让上层收到两次限额事件。
    // [失败路径] 是否真正杀进程由 killProcessOnPersistedLimit 与 stop 谓词二次判定，通知与终止刻意解耦。
    let persistedLimitNotified = false;
    // 只有“请求要求限额即杀 / 注入回调 / 生命周期钩子”三者之一存在时才监听落盘上限。
    // 回调只触发一次；是否真正终止交给 killProcessOnPersistedLimit 或 stop 谓词决定。
    const onPersistedLimit =
      request.outputLimit?.killProcessOnPersistedLimit === true ||
      internalOptions.onPersistedLimit ||
      internalOptions.shouldStopOnPersistedLimit
        ? () => {
            if (persistedLimitNotified) return;
            persistedLimitNotified = true;
            internalOptions.onPersistedLimit?.();
            if (
              request.outputLimit?.killProcessOnPersistedLimit === true ||
              internalOptions.shouldStopOnPersistedLimit?.() === true
            ) {
              requestStop("output_limit");
            }
          }
        : undefined;
    const legacyOutputEncoding = preparedOutput
      ? preparedOutput.legacyOutputEncoding
      : resolveLegacyExecutionOutputEncoding({
          platform: this.platform,
          processEnv: this.processEnv,
        });
    // 任务记录单独解析会重复同步执行 Windows chcp；复用执行时的编码值。
    internalOptions.onOutputEncodingResolved?.(legacyOutputEncoding);
    // Bash 用文件直写（无 collector）；其余执行才创建 stdout/stderr 两个内存 collector。
    const file =
      preparedOutput?.file ??
      (useBashMergedOutput
        ? new BashFileOutput(
            this.outputPathForRequest(request, "stdout")!,
            this.platform,
            legacyOutputEncoding,
          )
        : undefined);
    // 只有前台（有 event 订阅）才发进度；后台由 lifecycle/file watchdog 自行驱动预览。
    // [权衡] 文件直写模式不建内存 collector，stdout 为 undefined 是本文件的常态分支，后续读取必须判空。
    // [资源] 内存 collector 会按限额保留尾部，只有非 Bash 合并输出才承担这份常驻开销。
    const stdout = file
      ? undefined
      : this.createOutputCollector(
          request,
          "stdout",
          legacyOutputEncoding,
          onPersistedLimit,
          aggregatePersistedBudget,
        );
    const stderr = file
      ? undefined
      : this.createOutputCollector(
          request,
          "stderr",
          legacyOutputEncoding,
          onPersistedLimit,
          aggregatePersistedBudget,
        );
    // 进程/流状态位集中在此：exited 与 childClosed 分别代表 exit 与 close（pipe 排空）阶段。
    let child: ChildProcess | undefined;
    let cwdDialect: ExecutionShellDialect = defaultCwdDialect(this.platform);
    let cwdFilePath: string | undefined;
    let timedOut = false;
    let cancelled = false;
    let exited = false;
    let childClosed = false;
    // [事务] settled 只由 finally 置位，requestStop 依赖它拒绝迟到的停止请求，防止结果已组装后状态位被改写。
    // [并发] 与 stopRequested 分离：前者表示结果已定稿，后者表示已请求停止，二者语义不能合并。
    let executionSettled = false;
    let childReadyForTermination = false;
    let terminationRequested = false;
    let stopRequested = false;
    let forceExitTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let finishExit: (state: ExitState) => void = () => undefined;
    let finishResourceTelemetry: (state: ExitState) => void = () => undefined;
    // timeout 计时器在 spawn 后才启动（见下），spawn 前的停止只可能来自取消或 adapter 关闭。
    const createPreSpawnStoppedResult = () =>
      this.createStoppedResult(
        startedAt,
        "cancelled",
        this.closePromise
          ? "Execution adapter is shutting down"
          : "Execution cancelled before spawn",
      );
    // [并发] spawn 前有三处检查点（命令准备后、文件准备后、取消登记后），全部复用同一个判定以免漏检。
    // [失败路径] 返回 undefined 表示可继续，返回结果表示必须立刻收敛，调用方不得忽略该返回值。
    const stoppedBeforeSpawn = (): ExecutionResult | undefined => {
      if (!stopRequested && !this.closePromise && !options.signal?.aborted) return undefined;
      return createPreSpawnStoppedResult();
    };

    // 所有停止原因最终收敛到 terminateStartedChild：先杀树，Bash 直接结束退出 promise，
    // 其余执行留 5s 等 pipe 关闭，超时后强杀并释放读端。
    const terminateStartedChild = () => {
      if (!stopRequested || !child || !childReadyForTermination || terminationRequested) {
        return;
      }
      const startedChild = child;
      // [资源] 置位必须在杀树之前，防止重入导致同一进程组被 taskkill 两次而报错掩盖真实原因。
      // [事务] 该标志同时传给 drainChildOutput，用于区分自然退出与主动击杀，决定是否强排 pipe。
      terminationRequested = true;
      // root shell exit 不代表其进程组和继承 pipe 的后代已经退出。
      // cancel/close 必须在组长 exit 后仍能清理整个 execution，避免 orphan。
      this.terminateProcessTree(startedChild, useBashMergedOutput);
      // Bash 走文件直写时没有 pipe 需要排空，可直接用 143/137 伪造退出态结束等待。
      if (file) {
        finishExit({ code: timedOut ? 143 : 137 });
        return;
      }
      // [失败路径] 强杀兜底：等 pipe 关闭最多 FORCE_EXIT_AFTER_KILL_MS，超时即伪造 SIGKILL 退出态，避免 await 永久挂起。
      // [资源] 定时器立即 unref，不让计时本身阻碍进程退出；回调里仍会释放读端做最后兜底。
      // [权衡] 伪造退出态会丢失真实 signal，但换来确定性收敛，比无限等待更符合 CLI 语义。
      forceExitTimer = setTimeout(() => {
        if (!exited) {
          finishExit({
            signal: "SIGKILL",
          });
        }
        // Windows 的 taskkill 或 POSIX 的 PGID 都可能已无法寻址脱离的后代；
        // 最终释放 ZCode 持有的读端，不能继续让未知进程保活 CLI。
        this.destroyChildOutputStreams(startedChild);
      }, FORCE_EXIT_AFTER_KILL_MS);
      forceExitTimer.unref?.();
    };

    // 在 spawn 前就登记停止入口：取消/关闭/限额都通过 requestStop 汇聚成一个状态机。
    requestStop = (reason: StopReason) => {
      if (executionSettled || stopRequested || (file && exited)) return;
      stopRequested = true;
      if (reason === "timeout") {
        timedOut = true;
      } else if (reason === "cancelled") {
        cancelled = true;
      } else {
        outputLimitExceeded = true;
      }
      terminateStartedChild();
    };

    // [并发] 这里才把停止入口登记到适配器，此前 close 无法中断本请求；登记后立即释放准备登记，避免双份计数。
    // [事务] 登记与注销必须一对一，finally 是唯一的注销点，异常路径也不能绕过。
    const executionId = this.registerActiveExecution(requestStop);
    preparedOutput?.releasePreparation();
    const abortHandler = () => {
      const reason = abortSignalReason(options.signal);
      requestStop(reason === "output_limit" ? "output_limit" : "cancelled");
    };
    if (options.signal?.aborted) {
      requestStop("cancelled");
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      // [并发] 该 await 期间用户可能取消或关停，返回后必须立刻用 stoppedBeforeSpawn 复查，不能直接 spawn。
      // [失败路径] 命令准备抛错会落到外层 catch，此时尚无 child，需要按未 spawn 语义丢弃文件。
      const prepared = await this.prepareChildSpawn(request);

      // shell init snapshot 创建是异步的；用户可能在等待期间取消或关闭 adapter。

      const stoppedAfterCommandPreparation = stoppedBeforeSpawn();
      if (stoppedAfterCommandPreparation) {
        if (preparedOutput) await file?.discard();
        return stoppedAfterCommandPreparation;
      }

      if (file) {
        if (!preparedOutput) await file.prepare();
        const stoppedAfterOutputPreparation = stoppedBeforeSpawn();
        if (stoppedAfterOutputPreparation) {
          await file.discard();
          return stoppedAfterOutputPreparation;
        }
        prepared.spawnOptions.stdio = [
          request.stdin === undefined ? "ignore" : "pipe",
          file.fd!,
          file.fd!,
        ];
      }

      // [资源] 全文件唯一 spawn 点：stdio 在文件模式下已换成文件 fd，避免管道缓冲区把大输出顶死。
      // [失败路径] spawn 本身同步抛错时 child 仍为 undefined，catch 分支据此走丢弃文件而非杀树。
      const spawnedChild = spawn(
        prepared.command.file,
        prepared.command.args,
        prepared.spawnOptions,
      );
      child = spawnedChild;
      finishResourceTelemetry = this.trackBashResources(spawnedChild, useBashMergedOutput, () => ({
        timedOut,
        killed: cancelled || outputLimitExceeded,
      }));
      cwdDialect = prepared.cwdDialect;
      cwdFilePath = prepared.cwdFilePath;

      const exitPromise = new Promise<ExitState>((resolve) => {
        // finishExit 幂等：error/exit/强制终止三路都可能先到，只允许第一次生效。
        finishExit = (state) => {
          if (exited) return;
          exited = true;
          finishResourceTelemetry(state);
          file?.stopWatching();
          if (file) internalOptions.bashLifecycle?.onExit?.();
          resolve(state);
        };
        spawnedChild.once("error", (error) => finishExit({ error }));
        spawnedChild.once("exit", (code, signal) =>
          finishExit({
            code: code ?? undefined,
            signal: signal ?? undefined,
          }),
        );
      });

      // [并发] close 是 pipe 真正排空的信号，与 exit 分离：exit 只代表进程结束，close 之后才能安全读完输出。
      // [事务] 只有非文件模式才 await 该 promise；文件模式无管道，等它反而可能被后代句柄拖住。
      const closePromise = new Promise<void>((resolve) => {
        spawnedChild.once("close", () => {
          childClosed = true;
          resolve();
        });
      });

      await file?.close();
      // Bash 的 5GB 软阈值：后台化时重新武装（onBackgrounded），前台退出后停止。
      // [资源] 5GB 软阈值探针按需武装：后台化时重新挂上，前台退出或已停止后不再重复注册。
      // [并发] 关闭前重判 exited 与 stopRequested，避免退出后仍触发 requestStop 把成功结果改写成 output_limit。
      // [权衡] 把 onBackgrounded 指向同一个闭包，复用监听逻辑但要求 finally 必须撤销，否则形成幽灵监听。
      const watchBashLimit = () => {
        if (!file || exited || stopRequested) return;
        file.watchLimit(this.persistedOutputLimit(request), () => requestStop("output_limit"));
      };
      if (file) {
        watchBashLimit();
        if (internalOptions.bashLifecycle)
          internalOptions.bashLifecycle.onBackgrounded = watchBashLimit;
        if (options.onEvent && !exited && !internalOptions.bashLifecycle?.isBackgrounded()) {
          file.watchProgress(
            this.progressTailBytes,
            this.progressThresholdMs,
            this.progressIntervalMs,
            (output, outputPreview) => {
              this.emit(options, {
                type: "progress",
                elapsedMs: Date.now() - startedAt.getTime(),
                pid: spawnedChild.pid,
                stdoutBytes: output.bytes,
                stderrBytes: 0,
                stdoutTail: output.text,
                outputPreview,
                timestamp: new Date(),
              });
            },
          );
        }
      }
      // 子进程已可被终止；若此前已请求停止（如 spawn 期间取消），这里补一次杀树。
      childReadyForTermination = true;
      terminateStartedChild();

      this.emit(options, { type: "started", pid: spawnedChild.pid, timestamp: startedAt });

      // 复原原因：计时器提前到准备阶段是 protected-resource sandbox 时代的行为——capability
      // probe 可能无限挂起，总超时必须覆盖准备期。sandbox 撤除后准备阶段只剩 shell snapshot /
      // artifact 等既有异步步骤，timeoutMs 恢复为只约束子进程运行，避免 shell 初始化较慢或
      // timeout 较短时命令尚未启动就被判 timed_out；准备期间的取消与关闭仍由 stoppedBeforeSpawn 兜底。
      // timeout 只在子进程运行期计时；准备阶段由 stoppedBeforeSpawn 兜底取消/关闭。
      // [事务] 计时器只在子进程已启动后创建，timeout 的语义边界因此与命令真正运行对齐。
      // [失败路径] timeoutMs 为 0 表示不限时，跳过创建可避免定时器溢出被误当成 0 立即触发。
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => requestStop("timeout"), timeoutMs);
      }

      // 通用执行的进度采样：按 interval 读 collector 的滚动尾部，未达阈值不发事件。
      if (stdout && stderr) {
        if (options.onEvent) {
          // [并发] 采样前判 childClosed 与 exited，已结束的执行不再发进度，防止结果事件之后仍有 progress 乱序到达。
          // [权衡] 固定 interval 轮询滚动尾部而非事件驱动，实现简单，代价是空闲命令也有空转开销。
          progressTimer = setInterval(() => {
            if (
              childClosed ||
              (exited && internalOptions.shouldRetainExecutionAfterRootExit?.() !== true)
            )
              return;
            const elapsedMs = Date.now() - startedAt.getTime();
            if (elapsedMs < this.progressThresholdMs) return;
            this.emit(options, {
              type: "progress",
              elapsedMs,
              pid: spawnedChild.pid,
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
              stdoutTail: stdout.tailText(),
              stderrTail: stderr.tailText(),
              timestamp: new Date(),
            });
          }, this.progressIntervalMs);
          progressTimer.unref?.();
        }
        this.attachPipedOutput(spawnedChild, stdout, stderr, legacyOutputEncoding, options);
      }
      // [失败路径] 返回的是延迟取错函数而非直接抛错：stdin 写完失败常因命令提前退出，需等结果出来后按上下文判定。
      // [事务] 这里只登记错误，是否升级为 failed 由后续 baseStatus 与白名单共同决定。
      const inputFailure = this.writeChildInput(spawnedChild, request.stdin);

      // [并发] 等到退出态后才排空管道：顺序反了会在子进程仍写时读 collector，得到被截断的尾部。
      // [资源] 文件模式下若退出态带 error，立即 discard，避免把失败运行的空文件当结果返回。
      const exitState = await exitPromise;
      if (!file) {
        await this.drainChildOutput(
          spawnedChild,
          closePromise,
          internalOptions,
          terminationRequested,
        );
        await Promise.all([stdout!.close(), stderr!.close()]);
      } else if (exitState.error) {
        await file.discard();
      }
      // 结果组装：Bash 的 stderr 恒为空（已合并进文件），stdout 永远来自 artifact 读取。
      const stdoutResult = file
        ? await this.readBashResult(file, request, internalOptions, exitState, outputLimitExceeded)
        : stdout!.result();
      // [权衡] Bash 合并输出下 stderr 恒为空对象，调用方据 truncated 与 bytes 判断无需再读文件。
      // [失败路径] 非合并模式必须解引用 stderr collector，file 与 collector 二者必居其一，不能同时为空。
      const stderrResult = useBashMergedOutput
        ? { text: "", bytes: 0, truncated: false }
        : stderr!.result();
      const completedAt = new Date();
      if (file && outputLimitExceeded) cancelled = true;
      // [事务] 基础状态只由退出态与三个标志决定，随后才被 stdin 异常覆盖成 failed，判定顺序不可颠倒。
      // [失败路径] 三个标志的互斥性由 requestStop 保证，若同时为真，状态优先级由 statusFromExit 固定。
      const baseStatus = this.statusFromExit(exitState, timedOut, cancelled, outputLimitExceeded);
      // stdin 写入失败通常可忽略（子进程已读完），只有“命令成功但出现意外错误”才升级为失败。
      const stdinWriteError = inputFailure();
      const unexpectedStdinFailure =
        baseStatus === "completed" &&
        stdinWriteError &&
        !isExpectedChildStdinClosureError(stdinWriteError)
          ? this.toFailure("unknown", stdinWriteError)
          : undefined;
      const failure = exitState.error
        ? this.toFailure("spawn_error", exitState.error)
        : file && outputLimitExceeded
          ? { type: "output_limit" as const, message: "Command killed: output file exceeded 5GB" }
          : (this.statusFailure(timedOut, cancelled, outputLimitExceeded, timeoutMs) ??
            unexpectedStdinFailure);
      const status = unexpectedStdinFailure ? "failed" : baseStatus;
      // 只有“命令成功 + 退出码 0”才回读 cwd，失败时保留请求原始 cwd 语义。
      const resolvedCwd =
        status === "completed" && exitState.code === 0
          ? readCapturedCwd(cwdFilePath, { dialect: cwdDialect })
          : undefined;
      const result = this.createResult({
        status,
        startedAt,
        completedAt,
        pid: spawnedChild.pid,
        exitCode: exitState.code,
        signal: exitState.signal,
        stdout: stdoutResult,
        stderr: stderrResult,
        timedOut,
        cancelled,
        error: failure,
        resolvedCwd,
      });

      this.emitResult(options, result);
      return result;
    // 主流程异常兜底：spawn 前的取消不算错误；已 spawn 的错误则返回 spawn_error 但仍收集已产出的输出。
    } catch (error) {
      if (!child) await file?.discard();
      if (stopRequested || this.closePromise || options.signal?.aborted) {
        return createPreSpawnStoppedResult();
      }
      const failure = this.toFailure("spawn_error", error);
      const result = this.createResult({
        status: "spawn_error",
        startedAt,
        completedAt: new Date(),
        stdout: file ? await file.result(this.bashInlineLimit(request)) : stdout!.result(),
        stderr: useBashMergedOutput ? { text: "", bytes: 0, truncated: false } : stderr!.result(),
        timedOut: false,
        cancelled: false,
        error: failure,
      });
      this.emitResult(options, result);
      return result;
    // 统一收尾：确保即使抛错也停表、停预览、关文件、摘监听并注销活动执行。
    } finally {
      if (!exited)
        finishResourceTelemetry({ error: new Error("Execution ended before child exit") });
      executionSettled = true;
      file?.stopWatching();
      if (internalOptions.bashLifecycle) internalOptions.bashLifecycle.onBackgrounded = undefined;
      await file?.close();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      if (forceExitTimer) clearTimeout(forceExitTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      this.completeActiveExecution(executionId);
    }
  }
}
