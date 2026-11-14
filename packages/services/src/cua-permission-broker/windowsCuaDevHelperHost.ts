// 文件头不变量表（Windows CUA Helper Host，双阶段 transport 生命周期）：
// INV-01：lifecycleTail 是唯一线性化边界，任何 fork 都必须排在上一代 exact child exit 之后（守住位置：enqueue）。
//   把 kill 当成终止会让新旧 Helper 同时 bind 同一 pipe，Agent 随机连到其一，行为不可复现。
// INV-02：Agent-facing tuple 一经 transport_ready 暴露就不可替换（守住位置：resolveTransportReady、startNow 的 preserved 分支）。
//   换新 pipe 会让已建立连接的 Agent 永久悬挂，且不会自行恢复。
// INV-03：externalStopEpoch 单调递增，跨纪元的 start/restart 必须拒绝（守住位置：startNow、startGeneration）。
/* eslint-disable max-lines -- Windows two-phase transport lifecycle must remain one linearized state machine. */
import { randomBytes } from "node:crypto";

import type { HelperHealth } from "@zcode/zcode-cua/broker";
import type {
  CuaHelperHandle,
  CuaHelperTransportRestartResult,
  CuaProductHelperHost,
} from "@zcode/zcode-cua/broker/server";

import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ADDON_ENV,
  WindowsCuaChildLifecycle,
  asError,
  defaultChildProcess,
  defaultHealthProbe,
  defaultSocketPathFactory,
  isExactHealthPid,
  parseReadyMessage,
  type Generation,
  type WindowsCuaChild,
  type WindowsCuaChildProcessAdapter,
  type WindowsCuaHelperHostOptions,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

export type {
  WindowsCuaChild,
  WindowsCuaChildProcessAdapter,
  WindowsCuaHelperHostOptions,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

/** authority 铸造兜底：config-provenance 随机数，与 node.ts 懒分支 spawn 同口径。 */
// authority 用随机数兜底：named pipe 在同机可枚举，固定凭据等于把任意本机进程当作合法 Agent。
const mintRandomAuthority = (): string => randomBytes(16).toString("hex");

// 30s 覆盖 Electron 冷启动与 CUA addon 加载；1s 是「终止管道」的预算，不等待业务收尾。
// 两者都可从 options 覆盖；默认值只承诺「不会永久悬挂」，不承诺具体机器上的最优值。
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

// 只暴露 Agent 真正需要的两项：pid/path 等字段对下游无用，暴露面越大越容易被误当作身份依据。
type CuaHelperTransportHandle = Pick<CuaHelperHandle, "socketPath" | "pluginAuthority">;

// waitForTransport 保持可选：web 与测试替身只实现 CuaProductHelperHost，不应被迫实现 transport 契约。
export type ManagedCuaProductHelperHost = CuaProductHelperHost & {
  stop(): Promise<void>;
  checkHealth(timeoutMs?: number): Promise<unknown>;
  waitForTransport?(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
};

/**
 * Host 的 lifecycle tail 是唯一线性化边界：任何 fresh fork 都必须排在上一代 exact child
 * exit 之后。kill 仅是请求，不能把未观察到 exit 的进程误判为已经终止。
 */
// 进程代际、transport 承诺与外部停止纪元必须收在同一个线性状态机里，拆成多把锁会产生不可证的中间态。
// [权衡] 全部入口经 enqueue 串行化：牺牲启动吞吐换取「任意时刻最多一个 fork 在途」。
export class WindowsCuaHelperHost implements ManagedCuaProductHelperHost {
  private readonly childProcess: WindowsCuaChildProcessAdapter;
  private readonly mintSocketPath: () => string;
  private readonly healthProbe: (socketPath: string, timeoutMs: number) => Promise<HelperHealth>;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: ServiceLogger;
  private readonly childLifecycle: WindowsCuaChildLifecycle;
  private readonly authority: string;
  private handle: CuaHelperHandle | null = null;
  // 只要 transport_ready 已经对外 resolve，Agent 就可能已经持有这组凭据；即使 full health
  // 尚未完成，后续可恢复启动也必须复用它。显式 stop 会清掉该状态，避免 dispose 后复活旧 pipe。
  private lastAgentVisibleTransport: Pick<CuaHelperHandle, "socketPath"> | null = null;
  private current: Generation | null = null;
// [并发] tail 的 then 是串行链：队列项只在上一个操作 settle 后执行，失败也被消化成 undefined 继续排队。
// 队列项内禁止 await 外部回调（如 onUnexpectedExit），否则一个卡死的订阅者会阻塞所有生命周期操作。
  private lifecycleTail: Promise<void> = Promise.resolve();
  private terminationBlocker: Error | null = null;
  private startInFlight: Promise<CuaHelperHandle> | null = null;
  private startInFlightEpoch: number | null = null;
  private restartInFlight: Promise<CuaHelperHandle> | null = null;
  private restartAfterStartInFlight: Promise<CuaHelperHandle> | null = null;
  private restartPreservingTransportInFlight: Promise<CuaHelperTransportRestartResult> | null =
    null;
  private transportReadyInFlight: Promise<CuaHelperTransportHandle> | null = null;
  private transportReadyResolve: ((handle: CuaHelperTransportHandle) => void) | null = null;
  private transportReadyReject: ((error: unknown) => void) | null = null;
  private nextGeneration = 0;
  // 外部 stop 是 disposal 边界；排队中的旧 start/restart 不得在其后重新 fork。
// [并发] 每次外部 stop 递增纪元；排队中的旧操作靠 stopEpoch 快照发现「已过期」并主动放弃。
// 该字段只在同步代码中读改；await 之后必须重读，不能沿用快照。
  private externalStopEpoch = 0;

// 构造期不 spawn、不探测：Host 可能在窗口创建前实例化，任何副作用都会把启动失败提前成构造失败。
  constructor(private readonly options: WindowsCuaHelperHostOptions) {
    this.childProcess = options.childProcess ?? defaultChildProcess;
    this.mintSocketPath = options.mintSocketPath ?? defaultSocketPathFactory;
    this.healthProbe = options.healthProbe ?? defaultHealthProbe;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.logger = options.logger ?? createServiceLogger("windows-cua-helper-host");
    this.childLifecycle = new WindowsCuaChildLifecycle(this.logger);
    this.authority = (options.mintPluginAuthority ?? mintRandomAuthority)();
  }

// handle 是「已通过 full health」的唯一标志；transport 就绪但 health 未过时 running 仍为 false。
  get running(): boolean {
    return this.handle !== null;
  }
  get socketPath(): string | null {
    return this.handle?.socketPath ?? null;
  }
  get pluginAuthority(): string | null {
    return this.handle ? this.authority : null;
  }

// 已在运行时直接返回当前 tuple，调用方无需区分 cold start 与恢复。
// [失败路径] 未在启动中时立即 reject：错误马上暴露比超时更容易定位控制器状态错乱。
  waitForTransport(timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Promise<CuaHelperTransportHandle> {
    if (this.handle) {
      return Promise.resolve({
        socketPath: this.handle.socketPath,
        pluginAuthority: this.handle.pluginAuthority,
      });
    }
    const pending = this.transportReadyInFlight;
    if (!pending) return Promise.reject(new Error("Windows Computer Use Helper is not starting"));
    // 调用方通常会再套同一份有界 startup 预算；这里的本地 timer 保护直接调用者，
    // 避免 transport promise 因 Helper 永久不回消息而悬挂。
    return new Promise<CuaHelperTransportHandle>((resolve, reject) => {
// 本地 timer 保护直接调用者；unref 让等待本身不阻止进程退出，CLI 场景可以自然收尾。
// 两个 settle 分支都 clearTimeout，避免每个等待者留下一个悬挂定时器。
      const timer = setTimeout(() => {
        reject(new Error(`Windows Computer Use Helper transport timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.then(
        (handle) => {
          clearTimeout(timer);
          resolve(handle);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

// start 同时是 cold start 与异常退出后的按需恢复入口，因此必须优先复用已发布的 tuple（见 INV-02）。
// 同一 stopEpoch 下的重复调用合并到同一 promise：并发 CUA demand 不会各自 fork 一份 Helper。
  start(): Promise<CuaHelperHandle> {
    const stopEpoch = this.externalStopEpoch;
// 只有纪元相同才复用：外部 stop 之后旧 promise 注定失败，复用它会把「已停止」误报成「启动失败」。
// 该判断必须先于 createTransportReadyPromise，否则重复 start 会覆盖在途 transport 承诺。
    if (this.startInFlight && this.startInFlightEpoch === stopEpoch) return this.startInFlight;
    this.createTransportReadyPromise();
    const transportReady = this.transportReadyInFlight;
    // start() 既是 cold-start 入口，也是异常退出后的按需恢复入口。Host 已经暴露过的
    // Agent-facing tuple 必须优先复用；只有从未暴露过 tuple（或显式 stop 后已清理）才 fresh。
// [资源] 优先复用 Agent 已持有的 tuple：Helper 重启后 Agent 不会重建连接，新 pipe 会让它永久失联。
// 只有从未暴露过（或显式 stop 已清空）才允许 mint 新 socketPath，这是 INV-02 的唯一例外。
    const preservedTransport = this.lastAgentVisibleTransport ?? undefined;
    const tracked = this.enqueue(() => this.startNow(stopEpoch, preservedTransport))
// 旧 start 可能在 stop 竞态中晚于新代失败；只有仍持有同一 promise 时才允许收口 transport。
// 收口后仍 rethrow：调用方拿到原始错误，共享 transport 的等待者也被同步拒绝。
      .catch((error) => {
        // 旧 start 可能在 stop 竞态中晚于新 generation 失败，只有仍持有同一 promise 时才能收口。
        if (this.transportReadyInFlight === transportReady) {
          this.rejectTransportReady(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.startInFlight === tracked) {
          this.startInFlight = null;
          this.startInFlightEpoch = null;
        }
      });
    this.startInFlight = tracked;
    this.startInFlightEpoch = stopEpoch;
    // 外部 stop 会在调用方等待 start 之前同步中止它；保留原 Promise 语义，同时避免形成未处理 rejection。
    void tracked.catch(() => undefined);
    return tracked;
  }

// stop 是 disposal 边界：先同步让当前代失效（清 tuple、abort 启动），再把终止排到 tail 上。
// 同步失效早于 enqueue，保证并发 start 立刻看到纪元变化而不 fork。
  stop(): Promise<void> {
    const generation = this.current;
    const termination = this.invalidateForExternalStop(generation);
    return this.enqueue(async () => {
      try {
        await termination;
      } finally {
        if (generation && this.current?.id === generation.id) this.current = null;
      }
    });
  }

// restart 排到 tail 尾部，与 restartAfterCurrentStart 的「紧跟当前 start」语义不同，不能合并实现。
// 只保留一个在途 promise，重复调用共享结果，避免多次 stop/start 抖动。
  restart(): Promise<CuaHelperHandle> {
    if (this.restartInFlight) return this.restartInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      await this.stopNow("restart");
      return this.startNow(stopEpoch);
    }).finally(() => {
      if (this.restartInFlight === tracked) this.restartInFlight = null;
    });
    this.restartInFlight = tracked;
    return tracked;
  }

// 该入口用于权限变更后的强制重启：必须等当前 start 真正结束，否则会终止一个尚未 ready 的代。
  restartAfterCurrentStart(): Promise<CuaHelperHandle> {
    if (this.restartAfterStartInFlight) return this.restartAfterStartInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      await this.stopNow("permission-restart");
      return this.startNow(stopEpoch);
    }).finally(() => {
      if (this.restartAfterStartInFlight === tracked) this.restartAfterStartInFlight = null;
    });
    this.restartAfterStartInFlight = tracked;
    return tracked;
  }

// 恢复时保留 Agent-facing tuple：Helper 是可替换的 downstream，Agent 绑定的是 host-facing pipe。
// enqueue 已等到在途 start 结束，因此这里能读到最新 handle 或最近暴露的 tuple。
// [失败路径] 停止后重新核对 stopEpoch：排队期间发生外部 stop 时必须放弃，不能把进程重新拉起。
  restartAfterCurrentStartPreservingTransport(
    options: { beforeFreshStart?: () => void } = {},
  ): Promise<CuaHelperTransportRestartResult> {
    if (this.restartPreservingTransportInFlight) return this.restartPreservingTransportInFlight;
    const stopEpoch = this.externalStopEpoch;
    const tracked = this.enqueue(async () => {
      // enqueue 会等待在途 start；在这里读取 handle 才能覆盖“授权回调早于首个 ready”竞态。
// [并发] 必须在队列项内部读取：授权回调可能早于首个 ready，提前读取会漏掉刚生成的状态。
// 该值同时是「是否已有 Agent 绑定」的判据，决定 reused 的取值。
      const previous = this.handle ?? this.lastAgentVisibleTransport;
      await this.stopNow("preserving-transport-restart");
      if (stopEpoch !== this.externalStopEpoch)
        throw new Error("Windows Computer Use Helper startup stopped");
      if (previous) {
        // Helper 进程是可替换的 downstream；已有 Agent 绑定的是 host-facing named pipe，
        // 恢复时复用它们，避免 Windows Helper 重启把 Agent 留在旧 pipe 上。
        return {
          handle: await this.startNow(stopEpoch, previous),
          reused: true,
        };
      }
// [权衡] 只在 fresh 分支触发：复用 tuple 时 Agent 连接仍有效，通知它重连只会造成无谓抖动。
      options.beforeFreshStart?.();
      this.lastAgentVisibleTransport = null;
      return { handle: await this.startNow(stopEpoch), reused: false };
    }).finally(() => {
      if (this.restartPreservingTransportInFlight === tracked)
        this.restartPreservingTransportInFlight = null;
    });
    this.restartPreservingTransportInFlight = tracked;
    return tracked;
  }

// 健康检查只对当前 handle 生效：没有运行时立即报错，而不是返回看似成功的空结果。
// 默认超时沿用 shutdown 预算：探测必须短于终止预算，否则检查会拖住回收。
  async checkHealth(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<HelperHealth> {
    const handle = this.handle;
    if (!handle) throw new Error("Windows Computer Use Helper is not running");
    return this.healthProbe(handle.socketPath, timeoutMs);
  }

// [并发] 所有生命周期入口的唯一串行化点：tail.then 保证操作按提交顺序执行。
// terminationBlocker 一旦置位就拒绝后续操作：终止失败意味着进程状态未知，继续 fork 会叠加孤儿进程。
// 队列项失败不污染 tail：tail 被重新赋值为已消化的 promise，后续 stop 仍可执行。
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
// 返回 queued 而不是 tail：调用方要本次结果，tail 只负责排队顺序。
    const queued = this.lifecycleTail.then(async () => {
      if (this.terminationBlocker) throw this.terminationBlocker;
      return operation();
    });
    this.lifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

// 纪元校验必须在最前：排队期间发生的 stop 要让本次启动变成「已取消」，而不是静默成功。
// handle 已存在时直接返回：重复 fork 会破坏 INV-01。
  private startNow(
    stopEpoch: number,
    preservedTransport?: Pick<CuaHelperHandle, "socketPath">,
  ): Promise<CuaHelperHandle> {
    if (stopEpoch !== this.externalStopEpoch)
      return Promise.reject(new Error("Windows Computer Use Helper startup stopped"));
    if (this.handle) return Promise.resolve(this.handle);
    if (this.terminationBlocker) return Promise.reject(this.terminationBlocker);
    return this.startGeneration(stopEpoch, preservedTransport);
  }

// 每代只允许一个 transport 承诺：已存在时不覆盖，避免后到 start 抢走先到者的等待者。
// 预先 catch 一次：直接 waitForTransport 的调用方可能从不 await 这个 promise。
  private createTransportReadyPromise(): void {
    if (this.transportReadyInFlight) return;
    this.transportReadyInFlight = new Promise<CuaHelperTransportHandle>((resolve, reject) => {
      this.transportReadyResolve = resolve;
      this.transportReadyReject = reject;
    });
    // start() 负责最终失败收口；直接等待 transport 的调用方也不能留下未处理 rejection。
    void this.transportReadyInFlight.catch(() => undefined);
  }

// [资源] 一旦 resolve，tuple 就成为 Agent 身份并写入 lastAgentVisibleTransport，后续重启必须复用。
// 只记录 socketPath：authority 是 Host 实例恒定值，重复保存只会制造不一致。
  private resolveTransportReady(handle: CuaHelperTransportHandle): void {
    // transport_ready 已经可能被 spawn env 消费；从此刻起 tuple 就是 Agent-facing identity，
    // 不能因为后续 full health 失败或子进程异常退出而在下一次 start 时改发新 pipe。
    this.lastAgentVisibleTransport = {
      socketPath: handle.socketPath,
    };
    this.transportReadyResolve?.(handle);
    this.transportReadyResolve = null;
    this.transportReadyReject = null;
  }

  private rejectTransportReady(error: unknown): void {
    this.transportReadyReject?.(error);
    this.invalidateTransportReady();
  }

// [并发] 已 resolve 的 promise 无法再 reject，但仍要摘除引用，否则下一代 start 会复用死凭据。
// 该函数只清引用不 settle：调用方看到的 promise 状态保持不变。
  private invalidateTransportReady(): void {
    // transport_ready 是 generation 级承诺；Helper 退出后，已 resolve 的 promise
    // 无法再 reject，但必须从 Host 上摘除，避免下一代 start 复用死 generation 的 tuple。
    this.transportReadyResolve = null;
    this.transportReadyReject = null;
    this.transportReadyInFlight = null;
  }

// 先清 handle 再终止：running/socketPath 必须在进程真正退出前变为不可用，防止新请求打到垂死 pipe。
// [资源] 顺序固定为「标记 stopped → 等 exact exit → 清 current → 丢 transport」，错序会让 onExit 误报异常退出。
  private async stopNow(context: string): Promise<void> {
    const generation = this.current;
    if (!generation) return;
    this.handle = null;
// 只有 preserving-transport-restart 保留 tuple；dispose 与权限重启必须丢弃，避免复活旧 pipe。
// 新 context 需要显式决定是否保留，不能默默继承默认行为。
    if (context !== "preserving-transport-restart") {
      this.lastAgentVisibleTransport = null;
    }
    generation.stopped = true;
    await this.terminateGeneration(generation, context);
    if (this.current?.id === generation.id) this.current = null;
    this.invalidateTransportReady();
  }

// 代际 id 单调递增且永不复用：日志与竞态判断都靠它区分同一 pid 前后的两次进程。
// 每次 fork 携带 --parent-pid：Helper 据此在父进程消失后自毁，避免 Host 崩溃留下孤儿。
// 本方法不做前置校验（由调用方完成），只负责「fork 并等待 ready」。
  private startGeneration(
    stopEpoch: number,
    preservedTransport?: Pick<CuaHelperHandle, "socketPath">,
  ): Promise<CuaHelperHandle> {
    const id = ++this.nextGeneration;
// 复用 tuple 时沿用同一 pipe 名；Windows named pipe 没有 rename 让渡语义，名字即身份。
// mint 只在从未暴露过时执行，factory 负责唯一性，避免两个窗口撞名。
    const socketPath = preservedTransport?.socketPath ?? this.mintSocketPath();
    const argv = [
      this.options.runtime.entryPath,
      "--socket",
      socketPath,
      "--parent-pid",
      String(process.pid),
    ];
    let child: WindowsCuaChild;
    try {
      child = this.childProcess.fork(this.options.runtime.command, argv, {
        cwd: this.options.runtime.root,
// [资源] addon 路径走专用环境变量：命令行参数会出现在进程列表里，暴露安装路径。
// 保留父进程 env 以继承 Electron 运行时依赖，commandEnv 最后展开以覆盖宿主误设值。
        env: {
          ...process.env,
          ...this.options.runtime.commandEnv,
          [ADDON_ENV]: this.options.runtime.addonPath,
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
    } catch (error) {
// [失败路径] fork 同步失败没有 child 与 exit 事件，fail 永远不会触发，必须在这里主动拒绝 transport。
// 同时按 fork 分类记录：区分二进制缺失与权限拒绝只能依赖原始 error。
      const startupError = asError(error);
      // fork 同步失败时没有 child/exit 事件可触发 fail()，必须主动终止本代 transport 等待。
      this.rejectTransportReady(startupError);
      this.childLifecycle.logFailure(id, undefined, "fork", startupError);
      return Promise.reject(startupError);
    }

// settled 与 generation.stopped 双标志：前者防重复 settle，后者让 stop 能在 ready 之前中止本代。
// 该 promise 只在保证子进程已终止后才 reject，失败调用方不会留下半死进程。
    return new Promise<CuaHelperHandle>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let generation: Generation;
// [失败路径] 全部失败收口都走这里：先置 settled、清 timer，再等 terminate 完成才 reject。
// 先 reject transport 再等清理：共享等待者立即失败，不必跟着进程回收一起等。
      const fail = (error: unknown, errorClass: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const original = asError(error);
        this.handle = null;
        this.rejectTransportReady(original);
        generation.stopped = true;
        this.childLifecycle.logFailure(id, child.pid, errorClass, original);
        void this.terminateGeneration(generation, errorClass).then(
          () => reject(original),
          (cleanupError) => {
            this.childLifecycle.logFailure(id, child.pid, `${errorClass}-cleanup`, cleanupError);
            reject(original);
          },
        );
      };
// abort 只服务外部 stop：不触发进程终止（由 stop 统一做），仅让启动 promise 立刻失败。
      const abort = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.handle = null;
        this.rejectTransportReady(error);
        reject(error);
      };
      const onError = (error: unknown) => fail(error, "child-error");
// exitObserved 是「已观察到 OS 级退出」的唯一证据：kill 只是请求，不能据此判定进程已终止。
// 未 settle 时走 early-exit 失败；已 settle 则按 stopped 区分正常停止与异常退出。
      const onExit = (code: unknown) => {
        generation.exitObserved = true;
        if (!settled)
          fail(
            new Error(`Windows Computer Use Helper exited before ready (${String(code)})`),
            "early-exit",
          );
// [并发] 二次校验 stopped 与 current.id：stop 期间到达的 exit 不得触发「异常退出」通知。
// [权衡] 只通知不自动重启：重启策略属于上层 CUA demand，此处自动 fork 会在无人操作时反复拉起进程。
        else if (!generation.stopped && this.current?.id === id) {
          this.handle = null;
          this.current = null;
          this.invalidateTransportReady();
          this.logger.warn(undefined, "Windows Computer Use Helper exited unexpectedly", {
            generation: id,
            pid: child.pid,
            errorClass: "unexpected-exit",
          });
          // 这里只通知 Helper 状态失效；下次 CUA demand 复用已发布 tuple 恢复，不回收 Agent。
          this.options.onUnexpectedExit?.({ generation: id, pid: child.pid });
        }
      };
// [并发] 先按代际与纪元过滤：stop 之后旧进程仍可能发 ready，不能写回已清空的 handle。
// 同一 handler 兼容 transport_ready 与 ready 两种协议版本，避免两套监听器产生顺序竞争。
      const onMessage = (message: unknown) => {
        // stop 后、旧进程退出前仍可能收到 ready；先检查代际，避免把已清除的 tuple 重新写回。
// 三个条件必须同时匹配：stopped 防外部 stop，stopEpoch 防跨代排队，current.id 防旧代冒充新代。
// 不匹配时静默返回：这是过期消息而非错误，记日志会在 stop 高频时刷屏。
        if (generation.stopped || stopEpoch !== this.externalStopEpoch || this.current?.id !== id)
          return;
        const ready = parseReadyMessage(message);
        if (ready === "ignore") return;
        if (!ready)
          return fail(
            new Error("Invalid Windows Computer Use Helper control message"),
            "malformed-message",
          );
        if (ready.type === "error") {
          // The helper reported its own startup failure — surface the
          // diagnostic instead of discarding it as a malformed message.
          return fail(new Error(ready.message), "helper-reported-error");
        }
// [失败路径] Helper 上报的 socketPath 与分配值不一致说明协议被篡改或版本不兼容，必须拒绝而不是采纳。
// 不采纳远程值同时守住权限边界：Agent 只应连接 Host 分配的 pipe。
        if (ready.socketPath !== socketPath) return;
// pid 不一致说明 ready 来自别的进程，采纳会连上他人的管道。
        if (ready.pid !== child.pid)
          return fail(new Error("ready-pid-mismatch"), "ready-pid-mismatch");
        this.resolveTransportReady({
          socketPath,
          pluginAuthority: this.authority,
        });
        if (ready.type === "transport_ready") return;
// transport_ready 之后仍要做 full health：只有探测结果能证明 addon 与权限状态真的可用。
// 探测复用 startup 预算，避免「transport 已好但 health 永久挂起」。
        void this.healthProbe(socketPath, this.startupTimeoutMs).then(
          (health) => {
            if (
              settled ||
              generation.stopped ||
              stopEpoch !== this.externalStopEpoch ||
              this.current?.id !== id
            )
              return;
// [失败路径] 用精确 pid 比对而非「非空」：pipe 名可预测，宽松校验会让任意进程伪装成 Helper。
// 不匹配走 fail 而非重试：pid 错误属于协议/权限问题，重试只会放大错误。
            if (!isExactHealthPid(health, child.pid))
              return fail(new Error("health-pid-mismatch"), "health-pid-mismatch");
            settled = true;
            if (timer) clearTimeout(timer);
// handle 只使用已校验的 health 与 authority：bundleId/pid 必须来自探测结果，不能回填期望值。
// transport tuple 与运行状态必须同时保存，缺一会让恢复分支判断错误。
            const handle: CuaHelperHandle = {
              socketPath,
              // Windows 走 named pipe，不参与 macOS 的冷启动 rendezvous（pipe 不是 fs 节点，
              // 没有 rename 让渡语义）。Helper 直接 bind 这个 pipe 名，两者恒等。
// Windows 上 bind 名与 Agent 连接名恒等：named pipe 不是文件系统节点，没有 macOS 的让渡层。
              launchSocketPath: socketPath,
              pluginAuthority: this.authority,
              helperAppPath: this.options.runtime.entryPath,
              bundleId: health.bundleId,
              pid: health.pid,
            };
            // 合并时保留 ready handle；transport_ready 已保存可恢复 tuple，不能只存 tuple 而丢掉运行状态。
            this.handle = handle;
            this.logger.info(undefined, "Windows Computer Use Helper ready", {
              generation: id,
              pid: health.pid,
            });
            resolve(handle);
          },
          (error) => fail(error, "health-failed"),
        );
      };
// 先登记 current 再挂监听：回调可能同步触发，current 未就位会让代际守卫把本代误判为过期。
      generation = {
        id,
        child,
        socketPath,
        stopped: false,
        exitObserved: false,
        abort,
        removeMainListeners: () => {
          this.childLifecycle.off(child, "message", onMessage, id, "cleanup-off-message");
          this.childLifecycle.off(child, "error", onError, id, "cleanup-off-error");
          this.childLifecycle.off(child, "exit", onExit, id, "cleanup-off-exit");
        },
      };
      this.current = generation;
      if (
        !this.childLifecycle.on(child, "message", onMessage, id, "setup-on-message") ||
        !this.childLifecycle.on(child, "error", onError, id, "setup-on-error") ||
        !this.childLifecycle.on(child, "exit", onExit, id, "setup-on-exit")
      ) {
// [失败路径] 安装失败（child 已销毁）时立即 fail：否则本代永远等不到 message 与 exit。
        fail(new Error("Windows Computer Use Helper listener setup failed"), "listener-setup");
        return;
      }
      timer = setTimeout(
        () => fail(new Error("Windows Computer Use Helper startup timed out"), "startup-timeout"),
        this.startupTimeoutMs,
      );
      timer.unref?.();
    });
  }

// 每代只终止一次：缓存的 terminationPromise 让并发 stop 与失败清理共享同一次等待。
// [资源] 缓存而非重入：重复 kill 同一 pid 在 pid 复用后可能误杀无关进程。
  private terminateGeneration(generation: Generation, context: string): Promise<void> {
    if (generation.terminationPromise) return generation.terminationPromise;
    const termination = this.terminateGenerationOnce(generation, context);
    generation.terminationPromise = termination;
    return termination;
  }

// 终止失败写入 terminationBlocker：此后所有 start 被拒，避免在状态未知时继续 fork。
// blocker 只增不减：恢复需要重建 Host，而不是在不确定的进程树上继续叠代。
  private async terminateGenerationOnce(generation: Generation, context: string): Promise<void> {
    try {
      await this.childLifecycle.terminate(generation, context, this.shutdownTimeoutMs);
    } catch (error) {
      this.terminationBlocker = asError(error);
      throw error;
    }
  }

// [并发] 纪元先自增：这是让排队中 start 失效的唯一同步信号，必须在任何 await 之前完成。
// [资源] 无论有无 generation 都清 lastAgentVisibleTransport：显式 stop 之后不允许复活旧 pipe。
// 有 generation 时 abort 启动并立即发起终止；终止在 tail 之前执行以缩短停止延迟。
  private invalidateForExternalStop(generation: Generation | null): Promise<void> {
    this.externalStopEpoch += 1;
    this.lastAgentVisibleTransport = null;
    if (!generation) {
      this.rejectTransportReady(new Error("Windows Computer Use Helper startup stopped"));
      return Promise.resolve();
    }
    this.handle = null;
    generation.stopped = true;
// 未 settle 的代靠 abort 失败；已 settle 的代没有 rejecter，只能靠 invalidateTransportReady 摘除。
// 两者都在终止之前完成，保证「停止」对调用方可见的时机早于进程真正退出。
    generation.abort?.(new Error("Windows Computer Use Helper startup stopped"));
    // settled generation 没有 abort rejecter，仍必须摘除旧 transport tuple，避免后续 start 复用死凭据。
    this.invalidateTransportReady();
// 终止在 tail 之前发起：外部 stop 不应排队等慢启动，否则窗口关闭会被它拖住。
// 预先 catch 一份，避免 deadline 先于 tail 接管时产生 unhandledRejection 并终止进程。
    const termination = this.terminateGeneration(generation, "stop");
    // 外部 stop 在 tail 之前发起终止；预先消费拒绝，避免 deadline 先于 tail 接管时出现未处理 rejection。
    void termination.catch(() => undefined);
    return termination;
  }
}
