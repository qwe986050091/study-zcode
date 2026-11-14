// INV-01 关停后必须拒绝新任务；守住位置：start 开头对 closePromise 判空并抛出 shutting down 错误；改错故障：close 之后仍有任务登记进 backgroundTasks，留下无人回收的孤儿进程。
// INV-02 [事务] 准备阶段失败不建任务；守住位置：start 中 preparation 含 result 时走 Promise.resolve 并跳过 backgroundTasks 登记；改错故障：失败任务也占用 taskId，调用方拿到 running 却永远等不到终态。
// INV-03 [并发] 后台任务剥离 captureCwdAfterSuccess；守住位置：start 构造 runRequest 时把该标记置空，并以 runRequest 作为 outputPathsByRequest 的键；改错故障：后台结束回读临时 cwd 文件，与后续前台命令争用同一路径。
// INV-04 [资源] Bash 合并输出不再预建双文件；守住位置：start 中仅在非合并输出请求时调用 ensureBackgroundOutputFiles；改错故障：输出文件被重复打开，句柄与文件 watchdog 的字节计数口径不一致。
// INV-05 [并发] 父级取消只做转发且只挂一次；守住位置：start 对 options.signal 先判 aborted 再挂一次性监听，并把转发函数存入 record.externalAbort；改错故障：重复挂监听使收尾摘除不干净，signal 长期持有整条记录。
// INV-06 [失败路径] run 同步抛错也要落终态；守住位置：start 的 running 收尾第二分支用 toFailure 归为 spawn_error 后 finalize；改错故障：记录停在 running、completion 永久 pending，被异步资源检测判为泄漏。
// INV-07 状态机单向推进；守住位置：runBashWithBackgroundLifecycle 的 LifecycleState 只按 preparing 到 foreground、backgrounded 或 settling、terminal 前进；改错故障：回退写入让 deadline 与取消判断读到过期状态，误杀已转后台的进程。
// INV-08 [事务] 提交后台先原子改状态再清理；守住位置：commitBackground 开头校验 state 为 foreground 且未取消，随后立刻置 backgrounded 再清 deadline、摘父级取消、登记 task；改错故障：清理与置位之间插入取消或完成，后台进程在缝隙里被误杀。
// INV-09 [资源] 前台 deadline 只在前台阶段存在；守住位置：armForegroundDeadline 的 auto_on_timeout、无既有计时器、state 为 foreground 三重条件；改错故障：settling 阶段仍被计时器判超时，把正在读结果的执行再转一次后台。
// INV-10 [并发] 根进程退出后禁止再转后台；守住位置：bashLifecycle 的 onExit 仅在 preparing 或 foreground 时切到 settling 并清 deadline 与父级取消；改错故障：根进程已退出仍触发提交，前台结果与后台句柄同时产生。
// INV-11 [事务] 显式后台在 started 事件里提交；守住位置：onEvent 的 started 分支按 lifecycle.mode 选择 commitBackground 或 armForegroundDeadline；改错故障：explicit 模式漏提交，前台一直占着执行不返回任务句柄。
// INV-12 [并发] 转后台后事件不再外泄；守住位置：onEvent 中 state 为 backgrounded 时提前返回，不再调用 options.onEvent；改错故障：前台已返回结果仍收到后续事件，调用方状态被二次改写。
// INV-13 [资源] 落盘上限跨流共享且只在后台停流；守住位置：sharePersistedOutputLimitAcrossStreams 置真，shouldStopOnPersistedLimit 与 shouldRetainExecutionAfterRootExit 都判 backgrounded；改错故障：前台阶段按上限停流，把本可正常结束的前台命令截断。
// INV-14 [事务] 触达输出上限只标记不立即终止；守住位置：onPersistedLimit 仅在未取消时置 persistedLimitReached，真正的取消放到 commitBackground 里以 output_limit 为原因；改错故障：限额一到就终止，前台本可正常收尾的命令被判为输出超限失败。
// INV-15 [事务] 前台收尾必须走同一结算函数；守住位置：settleExecution 在非 backgrounded 分支置 terminal、摘父级取消，再按原始 persistOutput 与 maxArtifactBytes 还原后 finalize；改错故障：只 resolve outcome 不结算记录，completion 悬空。
// INV-16 [失败路径] 运行期异常转 spawn_error 后仍结算；守住位置：外层异步函数 try/catch 用 toFailure 归类后继续调用 settleExecution；改错故障：异常逃出使 outcome 永不 resolve，调用方永久等待。
// INV-17 [并发] 读尾窗先冻结快照再读文件；守住位置：readBackgroundBashOutput 先校验 sessionId、isBash 与 outputPath，再取 snapshot 后读文件；改错故障：读取期间退出导致状态与内容不同源，尾窗截断口径与快照不符。
// INV-18 取消幂等且先标状态；守住位置：cancelBackgroundTask 仅在 status 为 running 时改 cancelled 并取消 controller，其余直接返回快照；改错故障：重复取消重复终止，或对已终态任务回写状态导致快照倒退为 cancelled。
//
// 模块职责：在 run 层之上提供后台任务门面，把显式 start、Bash 超时转后台、尾窗读取与取消统一收敛到 backgroundTasks 记录。
// 状态所有权：backgroundTasks、outputPathsByRequest 与 closePromise 由基类持有，本层只写记录字段与一次性 outcome。
// 阅读顺序：先看类职责，再读 start 的注册与收尾，随后按状态机读 runBashWithBackgroundLifecycle 的四个闭包，最后是读取、查询、等待与取消。
// ============================================================
// 文件定位：后台任务与 Bash「前台/后台」生命周期语义的实现层（继承 run 层）。
// 输入输出：start 返回 taskId + 初始快照；runBashWithBackgroundLifecycle 返回前台结果或后台任务句柄。
// 副作用：注册后台任务、挂 abort 监听、一次 10s/自定义超时计时器，读取 Bash 输出文件。
// 失败语义：运行期异常转 spawn_error 结果；读取失败返回 read_failed（含 errno）。
// 不变量：状态机 preparing→foreground→backgrounded→settling→terminal 单向；提交后台前先摘掉前台 deadline 与父级 abort。
// ============================================================
import { BACKGROUND_BASH_OUTPUT_MAX_BYTES, type BackgroundBashOutputResult } from "@zcode/shared";
import { readBashOutput } from "./bash-file-output.js";
import { NodeExecutionAdapterRun } from "./node-execution-adapter-run.js";
import {
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  isBashMergedOutputRequest,
} from "./execution-utils.js";
import type {
  BashBackgroundLifecycleMode,
  BashBackgroundLifecycleResult,
  InternalExecutionRunOptions,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

// 生命周期门面：既支持显式 start（天然后台），也支持 Bash 的超时自动转后台。
// 两类路径都复用 backgroundTasks 记录，差异只在是否向前台返回结果。
// 生命周期门面只做编排，执行、输出归集与进程树回收都下沉到 NodeExecutionAdapterRun，本层不直接触碰子进程。
// 两条入口共用同一份后台任务表与同一种记录结构，差别只在是否向前台返回结果。
// [契约] start 面向显式后台，runBashWithBackgroundLifecycle 面向 Bash 的超时自动转后台，调用方按是否存在 deadline 语义二选一。
// [权衡] 继承而非组合是为了复用基类的失败归一与输出路径解析，代价是本类必须自己保证状态机不被基类回调打乱。
// 四个查询与取消方法只读或只改记录字段，不新增执行路径，把并发风险集中在两处入口。
export class NodeExecutionAdapterLifecycle extends NodeExecutionAdapterRun {
  // 启动一个“显式后台”任务：立即注册记录并异步跑 run，返回 running 快照。
  // Bash 会先准备输出文件；准备阶段就已失败的任务直接返回终态结果而不建任务。
  // 第一道门是 closePromise 判空：关停开始后任何新请求都直接抛出，避免 close 与 start 竞争出孤儿进程。
  // [顺序] Bash 先做 prepareBashOutput，准备失败时以 result 形态返回，跳过建记录与执行，调用方立刻拿到终态。
  // taskId 现生成，controller、startedAt 与 outputPaths 一并确定，记录字段此后不再重算。
  // [并发] 改写后的 runRequest 必须作为 outputPathsByRequest 的键，否则执行层按原对象查不到路径，回落到基类推导。
  // [资源] 只有非 Bash 合并输出才预建 stdout 与 stderr 文件，Bash 的输出文件在准备阶段已打开，重复创建会打乱句柄与限额计数。
  // [并发] 父级 signal 只转发取消：已取消时立即终止，否则挂一次性监听并把转发函数记到记录，收尾时统一摘除。
  // [失败路径] 收尾用两个分支兜住异常与拒绝，两条路径都必须 finalize，否则记录停在 running。
  async start(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<BackgroundExecutionStartResult> {
    // 已进入关停就不能再接受新任务，避免 close 之后出现孤儿进程。
    if (this.closePromise) {
      throw new Error("Execution adapter is shutting down");
    }

    const preparation = this.usesBashTempOutput(request)
      ? await this.prepareBashOutput(request, options)
      : undefined;

    const taskId = `exec_${crypto.randomUUID()}`;
    const controller = new AbortController();
    const startedAt = new Date();
    const outputPaths =
      preparation && "result" in preparation ? {} : this.outputPathsForRequest(request);
    // 后台任务不继承 captureCwdAfterSuccess：cwd 回传只服务于前台连续命令，
    // 后台会话结束时间不可控，回读临时文件会与后续命令竞争。
    // 后台不继承 captureCwdAfterSuccess：cwd 回传只服务前台连续命令，后台会话结束时间不可控。
    // [并发] 回读临时 cwd 文件会与后续前台命令争用同一路径，因此在构造请求时就把标记置空。
    // 只有标记真为 true 时才复制对象，未设置时沿用原请求，避免无谓分配。
    // outputPathsByRequest 记录的是改写后的对象，执行层按同一引用取路径，键选错就会退回默认推导。
    // [权衡] 代价是后台任务不再回报 cwd 变化，换来的是前台命令的 cwd 语义不被后台会话污染。
    const runRequest =
      request.captureCwdAfterSuccess === true
        ? { ...request, captureCwdAfterSuccess: undefined }
        : request;
    if (runRequest !== request) {
      this.outputPathsByRequest.set(runRequest, outputPaths);
    }
    // 非 Bash 才需要预建 stdout/stderr 文件；Bash 的合并文件在 prepare 阶段已打开。
    if (!isBashMergedOutputRequest(runRequest)) await this.ensureBackgroundOutputFiles(outputPaths);
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });
    this.backgroundTasks.set(taskId, record);

    // 父级 signal 只做“转发取消”，不直接持有执行期监听；任务收尾时统一移除。
    // 父级 signal 与子进程之间只保留这一条转发链，执行期不直接持有父级监听。
    // [并发] 挂监听前先判断已取消，避免漏掉先取消后注册的窗口。
    // 一次性监听保证同一个 signal 触发多次也只终止一次控制器。
    // 转发函数存进 record.externalAbort，收尾的两个分支都据此摘除，摘除动作幂等。
    // [失败路径] 若收尾漏摘，父级 signal 会长期持有记录，任务结束后仍被引用无法释放。
    const externalAbort = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    if (preparation && "result" in preparation) this.emitResult(options, preparation.result);
    const running =
      preparation && "result" in preparation
        ? Promise.resolve(preparation.result)
        : this.run(runRequest, {
            ...options,
            preparedBashOutput:
              preparation && "prepared" in preparation ? preparation.prepared : undefined,
            signal: controller.signal,
            onOutputEncodingResolved: (encoding) => {
              record.legacyOutputEncoding = encoding;
            },
            shouldRetainExecutionAfterRootExit: () => true,
            ...(isBashMergedOutputRequest(runRequest)
              ? { bashLifecycle: { isBackgrounded: () => true } }
              : {}),
            onEvent: (event) => {
              this.updateBackgroundTaskRecordFromEvent(record, event);
              return options.onEvent?.(event);
            },
          } as InternalExecutionRunOptions);
    // 后台任务即使根进程退出也要保留记录，等待输出排空与孤儿子进程回收。
    void running.then(
      (result) => {
        this.finalizeBackgroundTaskRecord(record, result);
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
      (error) => {
        const failure = this.toFailure("unknown", error);
        this.finalizeBackgroundTaskRecord(
          record,
          this.createStoppedResult(startedAt, "spawn_error", failure.message),
        );
        if (record.externalAbort) {
          options.signal?.removeEventListener("abort", record.externalAbort);
        }
      },
    );

    return {
      taskId,
      status: "running",
      startedAt,
      pid: record.pid,
      ...outputPaths,
    };
  }

  // Bash 的统一前台入口：explicit 模式启动后立刻转后台；auto_on_timeout 先跑前台，超时才转后台。
  // 返回两条互斥路径：前台完成给 result；转后台给 running 任务句柄（命令继续跑，不杀进程）。
  async runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options: ExecutionRunOptions = {},
  ): Promise<BashBackgroundLifecycleResult> {
    const useBashFile = isBashMergedOutputRequest(request);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 没有超时概念时无需“超时转后台”，直接走普通前台执行。
    if (lifecycle.mode === "auto_on_timeout" && timeoutMs <= 0) {
      return {
        kind: "foreground",
        result: await this.run(request, options),
      };
    }

    const taskId = `exec_${crypto.randomUUID()}`;
    const startedAt = new Date();
    const controller = new AbortController();
    const originalPersistOutput = request.outputLimit?.persistOutput ?? "none";
    const originalMaxArtifactBytes = useBashFile
      ? undefined
      : (request.outputLimit?.maxArtifactBytes ?? this.persistedOutputLimit(request));
    // 运行时改写成“无超时 + 永不杀进程 + 始终落盘”，超时由本函数自己的 deadline 决定，
    // 从而把“超时杀进程”变成“超时转后台”；Bash 的文件 watchdog 仍负责 5GB 硬上限。
    const runRequest: ExecutionRequest = {
      ...request,
      timeoutMs: 0,
      outputLimit: {
        ...request.outputLimit,
        killProcessOnPersistedLimit: false,
        maxPersistedBytes: BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
        persistOutput: "always",
      },
    };
    const preparation = this.usesBashTempOutput(runRequest)
      ? await this.prepareBashOutput(runRequest, options)
      : undefined;
    if (preparation && "result" in preparation) {
      this.emitResult(options, preparation.result);
      return { kind: "foreground", result: preparation.result };
    }
    const outputPaths = this.outputPathsForRequest(runRequest);
    if (!isBashMergedOutputRequest(runRequest)) {
      await this.ensureBackgroundOutputFiles(outputPaths);
    }
    const record = this.createBackgroundTaskRecord({
      controller,
      outputPaths,
      startedAt,
      taskId,
      request,
    });

    // 状态机：preparing→foreground→(backgrounded|settling)→terminal，只允许向前。
    // settling 表示根进程已退出、只剩异步读取结果，此时不得再被 deadline 判定为超时。
    type LifecycleState = "preparing" | "foreground" | "backgrounded" | "settling" | "terminal";
    let state: LifecycleState = "preparing";
    const bashLifecycle: InternalExecutionRunOptions["bashLifecycle"] = useBashFile
      ? {
          isBackgrounded: () => state === "backgrounded",
          onExit: () => {
            // root 已退出后只是异步读取结果，不能被前台 deadline 再转为后台任务。
            if (state === "preparing" || state === "foreground") {
              state = "settling";
              clearForegroundDeadline();
              removeExternalAbort();
            }
          },
        }
      : undefined;
    let persistedLimitReached = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveOutcome: (result: BashBackgroundLifecycleResult) => void = () => undefined;
    const outcome = new Promise<BashBackgroundLifecycleResult>((resolve) => {
      resolveOutcome = resolve;
    });

    // 已转后台/已终态时，父级 abort 不再影响该进程（后台任务有自己的 cancel 入口）。
    const externalAbort = () => {
      if (state === "backgrounded" || state === "terminal") return;
      controller.abort();
    };
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
      record.externalAbort = externalAbort;
    }

    const removeExternalAbort = () => {
      if (!record.externalAbort) return;
      options.signal?.removeEventListener("abort", record.externalAbort);
      record.externalAbort = undefined;
    };

    const clearForegroundDeadline = () => {
      if (!timeoutTimer) return;
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    };

    // [事务] 入口先判定 state 为 foreground 且控制器未取消，任一不满足即返回 false，不做任何副作用。
    // [并发] 状态置位放在最前，随后清理才安全：先改 backgrounded，再清 deadline、摘父级取消，最后登记 task。
    // [顺序] 这个顺序保证取消或完成回调落在提交缝隙时，看到的是已提交状态而不是半成品。
    // bashLifecycle 的 onBackgrounded 在置位后立刻回调，让执行层知道自己已脱离前台。
    // [资源] 已触达落盘上限时在提交后补一次取消，以 output_limit 作为原因，前台阶段不会提前终止进程。
    // outcome 只 resolve 一次后台句柄，返回 running 快照，命令继续跑而不结算。
    // [权衡] 提交与结算分离使前台结果与后台句柄互斥，代价是调用方必须靠 waitForBackgroundTask 才能拿终态。
    const commitBackground = () => {
      if (state !== "foreground" || controller.signal.aborted) return false;

      // 旧 explicit background 复用了通用 start()，foreground timeout 与
      // parent turn abort 会继续挂在子进程上。这里先原子提交状态，再同步清理 deadline、
      // 脱离 parent abort 并登记 task，避免 abort/completion 在提交缝隙里误杀后台进程。
      state = "backgrounded";
      bashLifecycle?.onBackgrounded?.();
      clearForegroundDeadline();
      removeExternalAbort();
      this.backgroundTasks.set(taskId, record);
      if (persistedLimitReached) {
        controller.abort("output_limit");
      }
      resolveOutcome({
        kind: "backgrounded",
        task: {
          taskId,
          status: "running",
          startedAt,
          pid: record.pid,
          ...outputPaths,
        },
      });
      return true;
    };

    // 只有前台阶段才允许被 deadline 转后台；已转后台或已终态时定时器不应存在。
    const armForegroundDeadline = () => {
      if (lifecycle.mode !== "auto_on_timeout" || timeoutTimer || state !== "foreground") {
        return;
      }
      timeoutTimer = setTimeout(commitBackground, timeoutMs);
    };

    const backgroundRunOptions: InternalExecutionRunOptions = {
      ...options,
      preparedBashOutput: preparation?.prepared,
      signal: controller.signal,
      onOutputEncodingResolved: (encoding) => {
        record.legacyOutputEncoding = encoding;
      },
      bashLifecycle,
      onPersistedLimit: () => {
        if (!controller.signal.aborted) {
          persistedLimitReached = true;
        }
      },
      onEvent: (event) => {
        this.updateBackgroundTaskRecordFromEvent(record, event);
        if (
          event.type === "started" &&
          event.pid !== undefined &&
          state === "preparing" &&
          !controller.signal.aborted
        ) {
          state = "foreground";
          if (lifecycle.mode === "explicit") {
            commitBackground();
          } else {
            armForegroundDeadline();
          }
        }
      // 已转后台的任务不再向前台转发事件（前台已返回，事件只进快照）。
        if (state === "backgrounded") return;
        return options.onEvent?.(event);
      },
      // 通用 lifecycle 仍使用独立 collector 和共享硬预算；Bash 由文件 watchdog 处理。
      sharePersistedOutputLimitAcrossStreams: true,
      shouldStopOnPersistedLimit: () => state === "backgrounded",
      shouldRetainExecutionAfterRootExit: () => state === "backgrounded",
    };

    // 收尾：后台路径只落一次终态快照；前台路径统一状态、摘监听，并按原始落盘策略还原结果。
    // 前台也复用 record，必须 resolve completion，否则后台表会永久 pending。
    // [并发] 先清前台 deadline，确保进入结算后不会被计时器再转一次后台。
    // 已 backgrounded 时只落一次后台终态，并用落盘上限标记归一输出超限结论。
    // terminal 分支直接返回，保证重复结算不会二次 resolve。
    // [事务] 前台路径先置 terminal、摘父级取消，再按原始 persistOutput 与 maxArtifactBytes 还原结果。
    // [资源] 前台也复用同一条记录，必须 finalize 让 completion 落地，否则异步资源检测会判为泄漏。
    // [失败路径] 外层 catch 把异常转成 spawn_error 后仍走同一结算，避免 outcome 永久挂起。
    const settleExecution = async (unprocessedResult: ExecutionResult) => {
      clearForegroundDeadline();
      if (state === "backgrounded") {
        this.finalizeBackgroundTaskRecord(
          record,
          this.normalizeBashBackgroundOutputLimitResult(unprocessedResult, persistedLimitReached),
        );
        return;
      }
      if (state === "terminal") return;

      state = "terminal";
      removeExternalAbort();
      const result = await this.normalizeBashBackgroundLifecycleForegroundResult(
        unprocessedResult,
        outputPaths,
        originalMaxArtifactBytes,
        originalPersistOutput,
      );
      // 前台完成仍复用 BackgroundTaskRecord；只结算 outcome 会让
      // record.completion 永久保持 pending，并被异步资源检测识别为泄漏。
      this.finalizeBackgroundTaskRecord(record, result);
      resolveOutcome({
        kind: "foreground",
        result,
      });
    };

    void (async () => {
      try {
        await settleExecution(await this.run(runRequest, backgroundRunOptions));
      } catch (error) {
        const failure = this.toFailure("unknown", error);
        await settleExecution(this.createStoppedResult(startedAt, "spawn_error", failure.message));
      }
    })();

    return await outcome;
  }

  // 读取后台 Bash 的尾部输出（最多 BACKGROUND_BASH_OUTPUT_MAX_BYTES）。
  // 先取快照再读文件：读取期间的退出不影响本次状态口径，下次查询才给终态。
  // 任务不存在/会话不匹配/非 Bash/无输出路径统一返回 unavailable；读文件异常返回 read_failed。
  // 读取前先校验记录存在、sessionId 匹配、isBash 为真且有输出路径，任一不满足返回 unavailable 而不是报错。
  // [并发] 先冻结快照再读文件：读取期间的退出不影响本次状态口径，下次查询才给终态。
  // 状态字段按快照结果判定，未结算时统一报 running，避免取消标记让详情提前停掉尾读。
  // 读取上限固定为 BACKGROUND_BASH_OUTPUT_MAX_BYTES，截断标记由读取器回传，本层不二次裁剪。
  // [失败路径] 文件读取异常返回 read_failed 并带上 errno 字符串，不把底层错误抛给查询方。
  async readBackgroundBashOutput(
    workId: string,
    sessionId: string,
  ): Promise<BackgroundBashOutputResult> {
    const record = this.backgroundTasks.get(workId);
    if (!record || record.sessionId !== sessionId || !record.isBash || !record.outputPath)
      return { kind: "unavailable", workId };
    // 先冻结状态，再读文件；若读取期间退出，下次查询才能返回终态及其最终尾窗。
    const snapshot = this.snapshot(record);
    try {
      const output = await readBashOutput(
        record.outputPath,
        BACKGROUND_BASH_OUTPUT_MAX_BYTES,
        true,
        record.legacyOutputEncoding,
      );
      return {
        kind: "output",
        workId,
        // Stop 先标记 cancelled，结算稍后才完成；不能让详情提前停止最终尾读。
        status: snapshot.result ? snapshot.status : "running",
        output: output.text,
        truncated: output.truncated,
        outputPath: record.outputPath,
      };
    } catch (error) {
      return {
        kind: "read_failed",
        workId,
        code: error instanceof Error && "code" in error ? String(error.code) : undefined,
      };
    }
  }

  // 查询任意后台任务快照（不区分是否 Bash）；未知 taskId 返回 undefined。
  async getBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    return record ? this.snapshot(record) : undefined;
  }

  // 等待任务终态：已终态立即返回；无 signal 时等 completion；有 signal 时 abort 也立即返回当前快照。
  // 取消等待不会取消任务本身（取消要显式调用 cancelBackgroundTask）。
  async waitForBackgroundTask(
    taskId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status !== "running") return this.snapshot(record);
    if (options.signal?.aborted) return this.snapshot(record);

    if (!options.signal) return await record.completion;

    return await new Promise<BackgroundExecutionSnapshot>((resolve) => {
      const abort = () => resolve(this.snapshot(record));
      options.signal?.addEventListener("abort", abort, { once: true });
      record.completion.then((snapshot) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(snapshot);
      });
    });
  }

  // 取消后台任务：先标记 cancelled（详情立即可见），再通过 controller 终止进程树；幂等。
  // 未知 taskId 返回 undefined，调用方据此区分不存在与已取消。
  // [并发] 只有 running 才改 cancelled 并终止控制器，已终态任务的状态不被回写。
  // 先标状态再终止进程树，详情查询能立即看到取消，而不必等进程退出。
  // [权衡] 取消不等待结算，终态由执行层收尾异步补齐，因此幂等性依赖状态判断而非锁。
  async cancelBackgroundTask(taskId: string): Promise<BackgroundExecutionSnapshot | undefined> {
    const record = this.backgroundTasks.get(taskId);
    if (!record) return undefined;
    if (record.status === "running") {
      record.status = "cancelled";
      record.controller.abort();
    }
    return this.snapshot(record);
  }
}
