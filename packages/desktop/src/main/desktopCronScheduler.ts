// INV-01 scheduler 进程只通过 utilityProcess 拉起：守住位置 spawn 调用；改错故障 子进程脱离 Electron 生命周期。
// INV-02 子进程环境必须带进程标签与宿主环境：守住位置 env 构造；改错故障 遥测无法区分 scheduler 角色。
// INV-03 派发只路由给可用的本地 host：守住位置 resolveDispatchHost；改错故障 无窗口时任务丢失。
// INV-04 无可用 host 必须回执 transient：守住位置 两处空 host 分支；改错故障 scheduler 永久放弃任务。
// INV-05 退出中拒绝新派发且不等待：守住位置 isDisposing 判断；改错故障 退出延迟被拉长。
// INV-06 转发失败必须回执 transient 并带错误文本：守住位置 两个转发捕获；改错故障 派发悬空不结算。
// INV-07 消息入口必须丢弃非对象载荷：守住位置 消息监听首行；改错故障 非法帧导致主进程异常。
// INV-08 日志级别只允许三档：守住位置 scheduler-log 分支；改错故障 未知级别丢失日志。
// INV-09 闲时活跃计数变化只做透传：守住位置 offpeak-active-count 分支；改错故障 主进程自行推断唤醒状态。
// INV-10 资源样本必须走统一入口校验：守住位置 scheduler-resource-sample 分支；改错故障 非法样本污染遥测。
// INV-11 关闭流程必须幂等：守住位置 disposePromise 缓存；改错故障 重复调用发送多次关闭消息。
// INV-12 关闭消息发出后必须等待退出或强杀：守住位置 dispose 定时器；改错故障 主进程先退出留下孤儿进程。
// INV-13 强杀超时固定为 1.5 秒：守住位置 常量；改错故障 退出体验过慢。
// INV-14 强杀异常必须吞掉，不能阻断收尾：守住位置 定时器内的捕获；改错故障 已经退出的进程让关闭失败。
// INV-15 进程退出必须注销角色注册：守住位置 exit 监听；改错故障 资源面板残留死进程。
// INV-16 CronRun 转发字段必须逐个映射：守住位置 host.postMessage 载荷；改错故障 任务缺少工作区或模型信息。
// INV-17 闲时任务与定时任务使用独立消息类型：守住位置 两个 HostMessageTypes；改错故障 host 侧分派错分支。
// INV-18 唤醒只在非关闭状态发送：守住位置 wake；改错故障 关闭后仍向 scheduler 投递消息。
//
// 模块职责：托管 cron scheduler 子进程，并在 scheduler 与本地 host 之间转发派发请求与结算结果。
// 状态所有权：子进程句柄与关闭状态归本模块；任务与运行结果归 scheduler 与 host 各自持有。
// 阅读顺序：先看接口与常量，再读 spawn，随后读消息路由，最后看关闭流程。
// desktop main 侧的 cron scheduler 进程管理器。
// 职责：拉起/销毁常驻 scheduler 进程；把 scheduler 的派发请求路由给某个本地 host（转成 CronRun）；
// 把 host 回报的 CronRunResult 转回 scheduler 结算。scheduler 只碰 tasks-index，createTask 在 host 域执行。
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";
import type {
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "../scheduler/schedulerProtocol.js";

export interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

/** host → main 的闲时任务派发结果（与 cron 消息独立）。 */
export interface OffPeakRunResultPayload {
  offPeakTaskId: string;
  ok: boolean;
  lifecycleManaged?: true;
  conversationId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 选一个能执行本地 workspace 派发的 host；无可用 host 时返回 null（scheduler 会退避重试）。 */
  resolveDispatchHost: () => ElectronUtilityProcess | null;
  /** 闲时任务执行中计数变化（keep-awake：main 据此 + 设置切 powerSaveBlocker）。 */
  onOffPeakActiveCountChanged?: (count: number) => void;
}

export interface CronSchedulerHandle {
  /** host 回报派发结果时调用，转交给 scheduler 结算。 */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /** host 回报闲时任务派发结果时调用，转交给 scheduler 结算。 */
  handleOffPeakRunResult: (result: OffPeakRunResultPayload) => void;
  /** manual run 落库后立即唤醒 scheduler，不等待下一次轮询。 */
  wake: (automationId: string) => void;
  /** app 退出前优雅收尾（通知 scheduler 释放认领 + 关库，兜底强杀）。 */
  dispose: () => Promise<void>;
}

// DISPOSE_FORCE_KILL_MS 关闭消息发出后最多等待 1.5 秒；超时必须强杀，避免退出流程被卡住；该常量只影响关闭，不影响正常派发。
const DISPOSE_FORCE_KILL_MS = 1_500;

// 以固定服务名与无警告参数拉起子进程。
// 环境继承宿主变量并附加 scheduler 标签。
// spawn 后立即登记角色，供资源遥测使用。
// 关闭状态用标记加 Promise 双重缓存。
// 所有对外方法都围绕同一个 child 子进程句柄。
export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  const child = electronUtilityProcess.fork(schedulerModulePath, [], {
    serviceName: "zcode-cron-scheduler",
    execArgv: ["--no-warnings"],
    env: {
      ...buildHostProcessEnv(deps.hostProcessLocalEnv),
      ZCODE_PROCESS_LABEL: "scheduler",
    },
  });

  deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
  // 资源遥测的 scheduler 角色 pid 只有 spawn 点知道，这里登记到进程角色注册表。
  registerSchedulerProcess(child);
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    try {
      child.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  // 非对象载荷直接丢弃，不尝试解析；scheduler-log、offpeak-active-count 与 scheduler-resource-sample 各自早退；cron-dispatch-request 统一在后续分支处理；该监听不向外抛异常，避免主进程崩溃。
  child.on("message", (raw: unknown) => {
    const msg = raw as SchedulerToMainMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "scheduler-log") {
      const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
      deps.logger[level](`[cron-scheduler] ${msg.message}`);
      return;
    }

    if (msg.type === "offpeak-active-count") {
      deps.onOffPeakActiveCountChanged?.(msg.count);
      return;
    }

    // scheduler 自采的 60 秒样本：main 只取 heap 作 scheduler 角色事件的 heap 维度，
    // 非法样本在入口按 schema 丢弃。
    if (msg.type === "scheduler-resource-sample") {
      ingestSchedulerSelfResourceSample(msg.sample);
      return;
    }

    // 关闭中先回执失败，避免把任务交给正在关闭的 host。
    // 没有可用 host 时按瞬态失败回执。
    // 转发成功即返回，结算由 host 回报触发。
    // 转发异常时把错误文本带回 scheduler。
    // CronRun 字段逐个映射，不直接透传整条消息。
    if (msg.type === "cron-dispatch-request") {
      if (isDisposing) {
        // App 退出时 Cron 与 Host 并行收口；进入 disposing 后继续派发会把新任务
        // 发送给正在关闭的 Host。明确拒绝派发，避免为了保持串行而额外增加 1.5 秒退出延迟。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "app is shutting down",
        });
        return;
      }
      const host = deps.resolveDispatchHost();
      if (!host) {
        // 没有可派发的本地 host（无窗口/未就绪）：按 transient 回执，scheduler 退避后重试。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.CronRun,
          automationId: msg.automationId,
          runId: msg.runId,
          prompt: msg.prompt,
          targetTaskId: msg.targetTaskId,
          modelSelection: msg.modelSelection,
          mode: msg.mode,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
          projectId: msg.projectId,
          hostId: msg.hostId,
          additionalDirectories: msg.additionalDirectories,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    // 闲时任务与定时任务共用 host 选择。
    // 无 host 时同样回执瞬态失败，由 scheduler 自行退避。
    // 消息类型使用独立的 OffPeakRun。
    // 转发失败时保留任务标识，便于 scheduler 重试。
    // 该分支不处理关闭中的特殊回执，由 host 选择兜底。
    if (msg.type === "offpeak-dispatch-request") {
      const host = deps.resolveDispatchHost();
      if (!host) {
        // 无可用 host：transient 回执，scheduler 按 off-peak 独立退避重试（顺延不丢弃）。
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.OffPeakRun,
          offPeakTaskId: msg.offPeakTaskId,
          prompt: msg.prompt,
          permissionMode: msg.permissionMode,
          modelSelection: msg.modelSelection,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          serverTicketId: msg.serverTicketId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
          projectId: msg.projectId,
          hostId: msg.hostId,
          additionalDirectories: msg.additionalDirectories,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward OffPeakRun to host failed:", error);
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  child.on("exit", (code) => {
    unregisterSchedulerProcess(child);
    deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
  });

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    handleOffPeakRunResult(result) {
      postToScheduler({ type: "offpeak-dispatch-result", ...result });
    },
    wake(automationId) {
      if (isDisposing) return;
      postToScheduler({ type: "scheduler-wake", automationId });
    },
    // 已有关闭 Promise 时直接复用，保证幂等。
    // 先置 isDisposing 关闭标记，再发送 scheduler-dispose 消息。
    // 等待 child 退出或 DISPOSE_FORCE_KILL_MS 超时强杀。
    // 无论哪条路径都只兑现一次 Promise。
    dispose() {
      if (disposePromise) return disposePromise;
      isDisposing = true;
      postToScheduler({ type: "scheduler-dispose" });
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 忽略。
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
      });
      return disposePromise;
    },
  };
}
