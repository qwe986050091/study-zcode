// zcode-server-cli / supervisor —— Supervisor 单文件总闸：持有 Core 子进程、代际与运维状态。
// 职责边界：只管「谁拥有 Core、处于哪个 LifecycleState、状态如何落盘与释放资源」；
// 不解析业务请求语义（controlServer 只负责分发），不实现 release 下载与校验（ReleaseManager），
// 不决定崩溃预算参数（CrashBudget），不清理用户数据；对外事实只有 status() 与 runtimeIdentity()。
// 状态唯一所有者是 this.state：任何分支都必须先改内存状态、再 persistStatusSnapshot、最后才释放锁；
// 禁止只落盘不改内存，也禁止在 stop-failed 之上再叠加 starting/ready。
//
// INV 不变量表（每条都是可回归断言；违反即视为 supervisor 设计缺陷）：
// INV-01 断言：同一 data-root 至多一个 Supervisor 持锁 —— 守住它的位置：start() 的 lock.acquire() 与各收口分支的 lock.release() —— 改错故障：两个 Core 争抢端口与 control socket，日志互相覆盖。
// INV-02 断言：持锁期间必须已确认无存活 Core 或已观察终态 —— 守住它的位置：stopCore 只在 exit/close 后清 core，start 失败分支的 coreStopped 判定 —— 改错故障：锁已释放但孤儿 Core 继续写库。
// INV-03 断言：state 只能沿 stopped→starting→ready 与 ready→stopping→stopped 迁移 —— 守住它的位置：start/stopCore/handleTerminal —— 改错故障：ready 覆盖 stopping，停止请求被吞掉。
// INV-04 断言：ready 只接受 generation 匹配且 state 为 starting 的 Core 消息 —— 守住它的位置：handleCoreMessage 的 ready 分支 —— 改错故障：旧 Core 迟到的 ready 复活新实例。
// INV-05 断言：任何 Core 消息都必须来自当前 this.core 引用 —— 守住它的位置：handleCoreMessage 首行的 child 比对 —— 改错故障：上一代 listener 篡改 runningTaskCount。
// INV-06 断言：Core 终态只处理一次且必须记录 lastExitReason —— 守住它的位置：launchCore 的 terminalObserved 闸门 —— 改错故障：exit 与 close 双触发导致重复计数与重复重启。
// INV-07 断言：stop-failed 是终态，迟到终态只清引用，不重启也不计 crash budget —— 守住它的位置：handleTerminal 的 stop-failed 分支 —— 改错故障：失败被自动重启掩盖，锁永不释放。
// INV-08 断言：优雅退出必须有超时兜底，超时后升级 SIGKILL —— 守住它的位置：graceTimer 到 forceKill 的路径 —— 改错故障：Core 挂死不退出，stop 永久悬空。
// INV-09 断言：强杀后仍必须等到 exit/close 才算收口，否则失败并保留 Core 与锁 —— 守住它的位置：killTimer 到 fail 的路径 —— 改错故障：未收口就放锁，第二个 Core 与僵尸并存。
// INV-10 断言：每次状态变更后都要落盘，且落盘失败不得改变内存状态 —— 守住它的位置：persistStatusSnapshot 的各调用点 —— 改错故障：磁盘状态与内存事实漂移，CLI 读到旧状态。
// INV-11 断言：更新要么 current 指向新 release 且 Core ready，要么回滚 previous 并拉起旧 Core —— 守住它的位置：applyUpdate 的 try/catch —— 改错故障：指针与运行进程不一致。
// INV-12 断言：更新回滚期间不得让 crashed 的自动重启定时器抢跑 —— 守住它的位置：enterUpdateRollback —— 改错故障：坏 release 被反复拉起。
// INV-13 断言：同一时刻至多一个 lifecycleOperation，ack 型请求也必须先过 gate —— 守住它的位置：runLifecycleOperation 与 assertLifecycleOperationCanStart —— 改错故障：stop 与 update 并发撕裂锁。
// INV-14 断言：有运行任务时 update 需 force、uninstall 直接拒绝 —— 守住它的位置：applyUpdate 与 confirm-uninstall —— 改错故障：运行中的任务被静默中断。
//
// 状态机速记：stopped → starting → ready → stopping → stopped；异常侧 crashed → crash-loop-stopped
// 与 stop-failed 都是「需人工介入或预算耗尽」的收口态，任何自动重启都不得从这两个态发起。
// 本文件日志只出现 pid/generation/reason/version，不打印敏感信息。
// 所有超时预算都取自 contracts 常量或 SupervisorOptions 注入口，禁止在分支里写魔法数字。
//
import type { SourceServerRunningTask } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- Supervisor 集中维护生命周期、Core 代际和更新回滚状态机，启动恢复锁边界修复不应拆散其原子流程。 */

import { type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServiceLogger } from "@zcode/services/node";
import { SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE } from "@zcode/shared";
import {
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  coreMessageSchema,
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlRequest,
  type LifecycleState,
  type ReleaseManifest,
  type RuntimeIdentity,
  type ServerStatus,
} from "../contracts.js";
import { createControlServer, type ControlHandler } from "../ipc/controlServer.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { DataRootLock } from "../runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createStatusPersister } from "../runtime/statusSnapshot.js";
import { recoverSupervisorStartup } from "../runtime/startupRecovery.js";
import { waitForUpdateReady } from "../runtime/updateReadiness.js";
import { createRollbackFailure, updateErrorMessage } from "../runtime/updateErrors.js";
import { CrashBudget } from "./crashBudget.js";

// 生命周期事件按运维排障判据用 info/warn/error（出问题时运维要能在日志里看到）；
// 高频 heartbeat/task-activity 明细走 debug，避免生产日志膨胀。
// [契约] 日志级别约定：生命周期迁移、更新、回滚走 info/warn/error，可作为运维审计事实；
// 心跳与 task-activity 快照只走 debug，避免高频消息把生产日志淹没。
// 新增日志时先判断是不是「状态事实」，不要用 info 打高频明细。
const log = createServiceLogger("server-supervisor");

// [契约] launcher 是唯一创建 Core 子进程的入口，接收 generation 与当前 activeRelease；
// Supervisor 不关心 spawn 细节（execPath/env），但要求返回的 ChildProcess 带 IPC 通道。
// 测试通过注入 launcher 伪造 exit/close/error 顺序，这是覆盖终态分支的主要手段。
export interface CoreLauncher {
  launch(generation: number, release?: ReleaseManifest | null): ChildProcess;
}

export interface SupervisorOptions {
  layout?: ServerLayout;
  launcher: CoreLauncher;
  version: string;
  /** 当前 Supervisor bundle 所属 immutable release；开发态入口允许缺失。 */
  supervisorReleaseId?: string;
  serviceRegistered?: boolean;
  /** 测试和诊断可缩短 ready 等待；生产默认使用 CORE_READY_TIMEOUT_MS。 */
  coreReadyTimeoutMs?: number;
  /** 测试可缩短 Core 优雅退出和强杀后的终态等待；生产默认使用 contracts 中的停止预算。 */
  coreStopGraceTimeoutMs?: number;
  coreKillTimeoutMs?: number;
  now?: () => number;
  onStopped?: () => void;
}

// [并发] 四类破坏性操作共用一把「生命周期互斥」：stop、restart、update、uninstall；
// 该类型只用于冲突判定与日志，不参与状态机迁移，state 仍是唯一事实源。
// [契约] 冲突判定不看 force 参数：force 只放过运行任务检查，不改变互斥语义。
type LifecycleOperationKind = "stop" | "restart" | "update" | "uninstall";

export class Supervisor {
  private readonly layout: ServerLayout;
  private readonly lock: DataRootLock;
  private readonly crashBudget: CrashBudget;
  private readonly releaseManager: ReleaseManager;
  private core: ChildProcess | undefined;
  private control: Awaited<ReturnType<typeof createControlServer>> | undefined;
  // [契约] state 是内存唯一事实源，status() 直接透出，不做二次推导；
  // 初值为 stopped 而非 starting，避免构造后未 start 就被读到中间态。
  // [权衡] 没有独立 mutex 保护 state：Node 单线程下所有迁移都在 await 之间同步完成。
  private state: LifecycleState = "stopped";
  private generation = 0;
  private host: string | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private runningTaskCount = 0;
  private runningTasks: SourceServerRunningTask[] | undefined;
  private lastExitReason: string | null = null;
  private readonly persistStatusSnapshot: () => Promise<void>;
  private lifecycleOperation:
    | { kind: LifecycleOperationKind; promise: Promise<unknown> }
    | undefined;
  private activeRelease: ReleaseManifest | null = null;
  private coreVersion: string | undefined;
  private coreReleaseId: string | undefined;

  public constructor(private readonly options: SupervisorOptions) {
    this.layout = options.layout ?? resolveServerLayout();
    this.lock = new DataRootLock(this.layout.lockFile);
    this.crashBudget = new CrashBudget({ now: options.now });
    this.releaseManager = new ReleaseManager(this.layout);
    this.persistStatusSnapshot = createStatusPersister(
      this.layout.statusFile,
      () => this.status(),
      (error) => log.warn("failed to persist status snapshot", error),
    );
  }

  // [契约] start 幂等：ready 或 starting 时直接返回当前 status，不重复拉起 Core；
  // [失败路径] 其余任何一步失败都在下方 catch 中收口，并把原始错误抛给调用方。
  // 幂等判断放在 releaseManager.ensure 之前，避免重复 start 反复触碰磁盘。
  public async start(): Promise<ServerStatus> {
    if (this.state === "ready" || this.state === "starting") return this.status();
    // [事务] ensure 在取锁之前执行：目录结构准备是幂等的，失败时不应该占用锁；
    // 它不读取 current pointer，真正的执行版本在 recovery 结束后才解析。
    // [资源] 目录权限由 layout 统一给出，Supervisor 不在此处做 chmod 或历史清理。
    await this.releaseManager.ensure();
    // [资源] data-root 单实例锁在启动临界区最前端获取，覆盖 recovery、mkdir、control、Core 四段；
    // 锁文件是跨进程唯一互斥手段，同进程重复 start 由上面的 state 幂等挡住；
    // [失败路径] acquire 失败直接抛出，此时尚未改动任何状态，无需回滚；
    // 释放点只有两处：启动成功后的正常 stop 路径，以及 catch 中 Core 与 control 均已收口的分支。
    await this.lock.acquire();
    try {
      // 启动恢复会回写 current.json 并删除 update-transaction.json，必须先取得
      // data-root 单实例锁；否则存活 Supervisor 的 apply-update 会与第二个启动者竞态，
      // 造成内存继续运行新 release、磁盘 current pointer 却被回滚到旧 release。
      // [事务] 启动恢复必须在锁内完成，它可能回写 current.json 并删除 update-transaction.json；
      // 回调只负责把状态标成 stop-failed 并落盘，真正的抛错由 recoverSupervisorStartup 自己完成。
      await recoverSupervisorStartup(
        this.releaseManager,
        this.layout.uninstalledFile,
        this.layout.serverRoot,
        async (error) => {
          this.state = "stop-failed";
          this.lastExitReason = `update rollback recovery failed: ${updateErrorMessage(error)}`;
          await this.persistStatusSnapshot();
        },
      );
      // recovery 可能已经恢复 current pointer；必须在恢复后读取，避免启动已回滚的 candidate。
      this.activeRelease = await this.releaseManager.readCurrentForExecution();
      await mkdir(this.layout.runDir, { recursive: true, mode: 0o700 });
      const handler: ControlHandler = (request) => this.handleControl(request);
      // [资源] control server 与 Core 同属「启动成功后必须收口」的资源，顺序为 Core 先停、control 后关；
      // 先建 control 再置 starting，保证客户端不会在没有 IPC 端点时读到 starting。
      // [失败路径] createControlServer 失败时 core 仍为 undefined，catch 只需关 control 并放锁。
      this.control = await createControlServer(this.layout.controlEndpoint, handler);
      this.state = "starting";
      log.info("supervisor started", {
        serverRoot: this.layout.serverRoot,
        version: this.options.version,
      });
      this.launchCore();
      await this.persistStatusSnapshot();
      return this.status();
    } catch (error) {
      // 只在 recovery 失败时释放锁是不够的：mkdir、control server、Core 启动或
      // 初始状态落盘失败会留下锁（以及可能已启动的 Core），同一 Supervisor 重试会把
      // 自己识别成另一个实例。启动临界区必须在确认 Core/control 都收口后才释放锁。
      // [失败路径] 启动失败分两档：可回收（Core 与 control 都收口）则回到 stopped 或保留 stop-failed；
      // 不可回收（stop 或 close 失败）则停在 stop-failed 并继续持锁，等待人工处理；
      // recoveryFailed 只表示 recovery 已写过 stop-failed，避免下面被 stopped 覆盖掉待处理事务；
      // coreStopped 与 controlClosed 是独立布尔量，只有两者都为真才允许释放锁。
      const recoveryFailed = this.state === "stop-failed";
      let coreStopped = this.core === undefined;
      if (this.core) {
        try {
          await this.stopCore("startup-failed");
          coreStopped = true;
        } catch (stopError) {
          log.error("failed to stop Core after supervisor startup failure", stopError);
        }
      }

      let controlClosed = this.control === undefined;
      if (this.control) {
        try {
          await this.control.close();
          this.control = undefined;
          controlClosed = true;
        } catch (closeError) {
          log.error("failed to close control server after supervisor startup failure", closeError);
        }
      }

      // [资源] 只有 Core 与 control 都确认收口才释放锁，此前任何 catch 路径都在等终态；
      // 释放锁前先落盘最终状态，保证下次启动读到的快照与磁盘一致。
      if (coreStopped && controlClosed) {
        // 恢复失败本身已经写入 stop-failed；即使没有 Core/control 需要收口，也保留该
        // 状态，让 status 继续暴露待人工处理的事务，同时释放锁允许同实例稍后重试。
        this.state = recoveryFailed ? "stop-failed" : "stopped";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stopped state after supervisor startup failure",
            snapshotError,
          );
        });
        await this.lock.release();
      } else {
        this.state = "stop-failed";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stop-failed state after supervisor startup failure",
            snapshotError,
          );
        });
      }
      throw error;
    }
  }

  // [并发] 对外的 stop 一律包进生命周期互斥，避免与 update/restart 交叉执行；
  // 默认 reason 服务于 CLI 与信号入口，便于在 lastExitReason 中区分主动停止原因。
  public async stop(reason = "requested"): Promise<ServerStatus> {
    return await this.runLifecycleOperation("stop", () => this.stopInternal(reason));
  }

  // [契约] 无 Core 时是快速路径：置 stopped、落盘、关 control、放锁，四步顺序固定；
  // 有 Core 时先 stopCore 再改状态，确保 status 不会出现「stopped 但 pid 还在」的窗口；
  // reason 为 restart 时不触发 onStopped，避免进程管理器把重启误判为退出；
  // [权衡] stopInternal 自身不加互斥，互斥由 stop、restart 与 handleControl 的调用方保证。
  private async stopInternal(reason: string): Promise<ServerStatus> {
    if (!this.core) {
      this.state = "stopped";
      await this.persistStatusSnapshot();
      await this.control?.close();
      this.control = undefined;
      await this.lock.release();
      if (reason !== "restart") this.options.onStopped?.();
      return this.status();
    }
    await this.stopCore(reason);
    this.state = "stopped";
    await this.persistStatusSnapshot();
    await this.control?.close();
    this.control = undefined;
    await this.lock.release();
    log.info("supervisor stopped", { reason });
    if (reason !== "restart") this.options.onStopped?.();
    return this.status();
  }

  // [并发] restart 复用同一个 lifecycleOperation 槽位，内部先 stopInternal 再 start；
  // [失败路径] start 失败会把异常抛给调用方，此时状态由 start 的 catch 决定（stopped 或 stop-failed）。
  public async restart(): Promise<ServerStatus> {
    return await this.runLifecycleOperation("restart", async () => {
      await this.stopInternal("restart");
      return await this.start();
    });
  }

  // [资源] stopCore 是唯一允许结束 Core 的路径，成功后才清 this.core 与 Core 作用域状态；
  // 先把 state 置 stopping 再发 shutdown，任何迟到的 ready 都会被 handleCoreMessage 丢弃；
  // [失败路径] 捕获到未收口异常时保留 core 引用、置 stop-failed、落盘，然后继续抛出；
  // 引用比对 this.core 与 core 保证并发 stop 中只有最后一次能清理共享状态。
  private async stopCore(reason: string): Promise<void> {
    if (!this.core) return;
    this.state = "stopping";
    this.lastExitReason = reason;
    log.info("stopping server core", { reason, pid: this.core.pid });
    const core = this.core;
    try {
      await new Promise<void>((resolve, reject) => {
        // 发出 SIGKILL 后不能最多等两秒便无条件返回：未观察到子进程终态
        // 也会释放 data-root lock，随后可启动第二个 Core。只有 exit/close 能证明进程
        // 已收口；强杀后仍无终态必须失败并保留 Core 引用和锁。
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(graceTimer);
          if (killTimer) clearTimeout(killTimer);
          core.off("exit", finish);
          core.off("close", finish);
          core.off("error", handleError);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(`Server Core pid ${core.pid ?? "unknown"} did not terminate after SIGKILL`),
          );
        };
        const handleError = (error: Error): void => {
          log.warn("server core emitted an error while stopping; awaiting exit or close", error);
        };
        // [失败路径] 优雅退出超时后升级为 SIGKILL，这是最后手段，日志必须 warn 以便定位挂死原因；
        // kill 之后再挂 killTimer：SIGKILL 也不能假设必达（pid 复用、OS 调度卡顿）；
        // [契约] killTimer 到期仍无 exit/close 则 reject，让上层停在 stop-failed 并保留锁；
        // settled 闸门保证 finish 与 fail 二选一，避免先 resolve 后 reject 的无效竞态。
        const forceKill = (): void => {
          log.warn("server core did not exit within grace period, sending SIGKILL", {
            pid: core.pid,
          });
          core.kill("SIGKILL");
          if (!settled) {
            killTimer = setTimeout(fail, this.options.coreKillTimeoutMs ?? CORE_KILL_TIMEOUT_MS);
          }
        };
        const graceTimer = setTimeout(() => {
          forceKill();
        }, this.options.coreStopGraceTimeoutMs ?? CORE_STOP_GRACE_TIMEOUT_MS);
        core.once("exit", finish);
        core.once("close", finish);
        core.once("error", handleError);
        try {
          // [失败路径] IPC 通道已关闭时 send 会同步抛错，但只能说明通道断了，不能证明进程已退出；
          // 此分支直接 forceKill 并继续等待 exit/close，不做「发不出去就算停好」的乐观判断。
          core.send({ command: "shutdown" });
        } catch {
          // IPC 已关闭不代表 OS 进程已退出，直接强杀后仍等待 exit/close 终态。
          clearTimeout(graceTimer);
          forceKill();
        }
      });
    } catch (error) {
      if (this.core === core) {
        this.state = "stop-failed";
        this.lastExitReason = error instanceof Error ? error.message : String(error);
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    if (this.core === core) {
      this.core = undefined;
      this.clearCoreScopedStatus();
    }
  }

  // [事务] 更新是「停旧 Core → 事务替换 pointer → 拉新 Core → 等 ready → completeUpdate」的补偿事务；
  // [契约] 无 pending 直接拒绝；有运行任务且未 force 时返回结构化错误码而不是静默停服；
  // previous 必须在停 Core 之前读取，否则事务回滚时拿不到可信的旧指针；
  // [权衡] force 只跳过任务保护，不跳过 ready 校验与回滚流程。
  private async applyUpdate(force: boolean): Promise<unknown> {
    const pending = await this.releaseManager.readPending();
    if (!pending) throw new Error("No pending release is prepared");
    if (this.runningTaskCount > 0 && !force) {
      throw new ControlRequestError(
        SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
        "Running tasks require --force for update",
        false,
      );
    }
    const previous = await this.releaseManager.readCurrent();
    log.info("applying pending release", { version: pending.version, force });
    // [事务] 先停 Core 再置 updating：只要旧 Core 还在写库，指针替换就不安全；
    // state 为 updating 期间 handleTerminal 不会安排重启，因为分支已离开 starting 与 ready。
    await this.stopCore("update");
    this.state = "updating";
    await this.persistStatusSnapshot();
    try {
      await this.releaseManager.applyPendingWithTransaction(previous);
      this.activeRelease = pending;
      this.state = "starting";
      this.launchCore();
      await waitForUpdateReady(
        () => this.state,
        this.options.coreReadyTimeoutMs ?? CORE_READY_TIMEOUT_MS,
      );
      await this.releaseManager.completeUpdate();
      log.info("release applied", { version: pending.version });
      return { applied: true, version: pending.version };
    } catch (error) {
      this.enterUpdateRollback();
      // 更新后的 Core 未 ready 时必须先停止仍存活的子进程，再恢复 current 指针。
      // 否则 timeout 路径会覆盖 this.core 引用后遗留新 Core，与回滚后的旧 Core 并存。
      if (this.core) {
        try {
          await this.stopCore("update-rollback");
        } catch (stopError) {
          log.error("failed to stop unhealthy release during rollback", stopError);
          await this.persistStatusSnapshot();
          throw stopError;
        }
      }
      // 恢复 current 指针，避免下一次启动继续使用坏 release。
      log.error("release apply failed, restoring previous current pointer", error);
      try {
        // [事务] 回滚分两步：先恢复 current 指针，再 completeUpdate 清掉事务文件；
        // 指针恢复失败即 stop-failed，此时不假装更新成功，也不自动重试，避免放大损坏面。
        await this.releaseManager.restoreCurrent(previous);
        await this.releaseManager.completeUpdate();
      } catch (rollbackError: unknown) {
        this.state = "stop-failed";
        this.lastExitReason = `rollback pointer restore failed: ${updateErrorMessage(rollbackError)}`;
        await this.persistStatusSnapshot();
        throw createRollbackFailure(error, rollbackError);
      }
      this.activeRelease = previous;
      // 回滚不仅恢复 pointer，还要立即拉起旧 release；否则 daemon 会以 stopped 留在
      // 不可用状态，用户必须手工 restart 才能恢复服务。
      this.state = "stopped";
      // [失败路径] 回滚成功后必须立刻拉起旧 release，否则 daemon 卡在 stopped 需人工 restart；
      // 旧 release 仍 ready 超时则再走一次 stopCore，让「进程与状态一致」优先于「服务持续可用」。
      // 回滚是否成功只由 activeRelease 与磁盘 pointer 共同表达，不额外维护标志位。
      if (previous) {
        this.state = "starting";
        this.launchCore();
        try {
          await waitForUpdateReady(
            () => this.state,
            this.options.coreReadyTimeoutMs ?? CORE_READY_TIMEOUT_MS,
          );
        } catch (rollbackError) {
          log.error("previous release rollback failed", rollbackError);
          // 旧 release ready 超时只改状态会让仍存活的 Core、PID 和 lock 与 stopped 脱节；复用 stopCore 等待 exit/close，失败则保持 stop-failed。
          if (this.core) await this.stopCore("update-rollback");
          this.state = "stopped";
        }
      }
      await this.persistStatusSnapshot();
      throw error;
    }
  }

  // [契约] status 是只读快照：不触发迁移、不做 IO，字段全部来自内存；
  // version 语义保持 Core 与 current release，Supervisor 自身版本走 runtimeIdentity，避免击穿旧版 schema。
  // [权衡] pid 取自 this.core 而不是最后一次 ready 的缓存，进程消失后立即反映为 null。
  public status(): ServerStatus {
    return {
      protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
      state: this.state,
      pid: this.core?.pid ?? null,
      port: this.port,
      host: this.host,
      // status.version 保持 Core/current release 的兼容语义；Supervisor 自身版本与 release
      // 由独立 runtime-identity control 返回，避免向严格持久化 schema 增加字段击穿旧版回滚。
      version: this.activeRelease?.version ?? this.options.version,
      generation: this.generation,
      startedAt: this.startedAt,
      lastExitReason: this.lastExitReason,
      serviceRegistered: this.options.serviceRegistered ?? false,
      runningTaskCount: this.runningTaskCount,
      crashBudget: this.crashBudget.snapshot(),
      updatedAt: Date.now(),
    };
  }

  private runtimeIdentity(): RuntimeIdentity {
    return {
      supervisorVersion: this.options.version,
      ...(this.options.supervisorReleaseId
        ? { supervisorReleaseId: this.options.supervisorReleaseId }
        : {}),
      ...(this.activeRelease?.version ? { activeReleaseVersion: this.activeRelease.version } : {}),
      ...(this.activeRelease?.releaseId ? { activeReleaseId: this.activeRelease.releaseId } : {}),
      ...(this.coreVersion ? { coreVersion: this.coreVersion } : {}),
      ...(this.coreReleaseId ? { coreReleaseId: this.coreReleaseId } : {}),
    };
  }

  // [资源] 每次启动自增 generation，它是识别「消息属于哪一代 Core」的唯一凭据；
  // launch 后立刻清空 Core 作用域状态，防止上一代的 host、port、runningTaskCount 泄漏到新实例；
  // [契约] exit 与 close 都可能先到，launchCore 必须让两者共用一个一次性终态处理函数；
  // error 事件不设终态，只记录原因并等 exit/close，因为 fork 失败时 Node 只发 error 加 close。
  private launchCore(): void {
    const generation = ++this.generation;
    const child = this.options.launcher.launch(generation, this.activeRelease);
    this.core = child;
    this.clearCoreScopedStatus();
    log.info("launching server core", { generation, pid: child.pid });
    child.on("message", (raw: unknown) => this.handleCoreMessage(child, generation, raw));
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    // [并发] terminalObserved 保证 exit/close/error 组合只处理一次，幂等是崩溃预算正确的前提；
    // 若 this.core 已被替换或状态已是 stopping/stopped，迟到的终态直接忽略，不得改状态；
    // [失败路径] stop-failed 分支只清引用并记录原因，不重启、不记账，等待人工 stop 重试；
    // 正常运行期崩溃走 crashed，交给 crashBudget 决策是定时重启还是 crash-loop-stopped。
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.core !== child || this.state === "stopping" || this.state === "stopped") return;
      if (this.state === "stop-failed") {
        // stop 已失败时继续保留锁；迟到的终态只清除已死亡 child，不得计入 crash budget
        // 或启动替代 Core。用户重试 stop 后再释放 control socket 与 data-root lock。
        this.core = undefined;
        this.clearCoreScopedStatus();
        this.lastExitReason = reason;
        void this.persistStatusSnapshot();
        return;
      }
      this.core = undefined;
      this.clearCoreScopedStatus();
      this.state = "crashed";
      this.lastExitReason = reason;
      const decision = this.crashBudget.recordCrash();
      if (!decision.shouldRestart) {
        this.state = "crash-loop-stopped";
        log.error("server core crash budget exhausted, entering crash-loop-stopped", {
          lastExitReason: this.lastExitReason,
        });
        void this.persistStatusSnapshot();
        return;
      }
      log.warn("server core crashed, scheduling restart", {
        lastExitReason: this.lastExitReason,
        delayMs: decision.delayMs,
      });
      void this.persistStatusSnapshot();
      // [并发] 重启退避由 CrashBudget 给出 delayMs，定时器 unref 不阻止进程退出；
      // 回调再次校验 state 为 crashed，期间若有 stop 或 update 介入则放弃这次自动重启。
      // [资源] 定时器捕获 this 但 unref 后不延长进程寿命，stop 之后靠状态校验自然失效。
      setTimeout(() => {
        if (this.state !== "crashed") return;
        this.state = "starting";
        this.launchCore();
      }, decision.delayMs).unref();
    };
    // fork 的 execPath 不存在/不可执行时 Node 只发 error + close，不发 exit。
    // error 与 exit 必须共用一次性终态，否则未处理的 error 会杀死 Supervisor，并让更新
    // 已写入的新 current pointer 绕过 catch/rollback。
    // [失败路径] spawn error 只记录 spawnErrorReason 并落盘，真正的终态仍由 exit/close 触发；
    // reason 里带上 error.code，便于区分 ENOENT（release 缺文件）与 EACCES（权限不足）。
    // spawnErrorReason 由闭包持有，exit 与 close 谁先到都会带上它，保证真实原因不丢。
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `core spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.lastExitReason = spawnErrorReason;
      log.error("server core process error", error);
      void this.persistStatusSnapshot();
    });
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
  }

  // [并发] message 监听器绑定在 child 上且跨代存活，所以入口必须双重校验事件源与代际；
  // ready 额外要求 state 为 starting，防止 stopping 与 stop-failed 被迟到消息复活；
  // heartbeat 只更新任务快照字段，不参与状态迁移，也不重置崩溃预算；
  // fatal 与 exit 只记录 lastExitReason，真正收口仍等 OS 终态，不信任 Core 自述。
  private handleCoreMessage(child: ChildProcess, expectedGeneration: number, raw: unknown): void {
    // 旧 child 的 message listener 会跨 generation 存活，延迟 heartbeat/ready
    // 可覆盖当前 Core 的状态。消息必须同时绑定当前 child；ready 还需匹配启动 generation。
    if (this.core !== child) return;
    const parsed = coreMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      // ready 只对当前 starting 的 Core 有效；stopping/stopped/stop-failed 阶段的迟到消息
      // 不能复活已经收口或进入不确定终态的 Supervisor。
      if (message.generation !== expectedGeneration || this.state !== "starting") return;
      this.state = "ready";
      this.host = message.host;
      this.port = message.port;
      this.generation = message.generation;
      this.startedAt = Date.now();
      this.coreVersion = message.version;
      this.coreReleaseId = message.releaseId;
      log.info("server core ready", {
        host: this.host,
        port: this.port,
        generation: this.generation,
      });
    } else if (message.type === "heartbeat" || message.type === "task-activity") {
      this.runningTaskCount = message.runningTaskCount;
      this.runningTasks = message.runningTasks;
      log.debug("core activity snapshot", {
        type: message.type,
        runningTaskCount: message.runningTaskCount,
      });
    } else if (message.type === "fatal") {
      this.lastExitReason = message.message;
      log.error("server core reported fatal error", { message: message.message });
    } else if (message.type === "exit") {
      this.lastExitReason = message.reason;
      log.info("server core reported exit", { reason: message.reason });
    }
    void this.persistStatusSnapshot();
  }

  // [并发] 候选 Core 崩溃会把状态置 crashed 并安排重启定时器，回滚期间必须离开该状态；
  // 只把 crashed 改成 updating，其它状态保持原样，避免误改写已收口的 stop-failed。
  // [契约] 本函数不落盘：applyUpdate 的 catch 会统一持久化 updating 与最终状态。
  private enterUpdateRollback(): void {
    // 候选 Core 崩溃后 handleTerminal 会将状态置为 crashed 并安排自动重启；
    // 回滚文件操作期间必须先离开 crashed，否则定时器会用坏的 activeRelease 再次拉起 Core。
    if (this.state === "crashed") this.state = "updating";
  }

  private clearCoreScopedStatus(): void {
    this.host = null;
    this.port = null;
    this.startedAt = null;
    this.runningTaskCount = 0;
    this.runningTasks = undefined;
    this.coreVersion = undefined;
    this.coreReleaseId = undefined;
  }

  // [契约] control 层分支只做参数校验与分发，所有状态迁移都委托给带互斥的方法；
  // ack 型命令（stop/restart/uninstall）先回包再后台执行，同步命令直接返回快照。
  // 分支不设 default：未知命令由 ControlRequest 联合类型在编译期穷举兜住。
  private async handleControl(request: ControlRequest): Promise<unknown> {
    switch (request.command) {
      case "ping":
        return { protocolVersion: SERVER_CLI_PROTOCOL_VERSION };
      case "status":
        return this.status();
      case "running-tasks":
        return this.runningTasks ?? null;
      case "runtime-identity":
        return this.runtimeIdentity();
      case "stop":
        this.startAcknowledgedLifecycleOperation("stop", () =>
          this.stopInternal("control request"),
        );
        return { stopping: true };
      case "restart":
        this.startAcknowledgedLifecycleOperation("restart", async () => {
          await this.stopInternal("restart");
          await this.start();
        });
        return { restarting: true };
      case "prepare-update":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "apply-update":
        return await this.runLifecycleOperation("update", () =>
          this.applyUpdate(request.force === true),
        );
      case "prepare-uninstall":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "confirm-uninstall":
        if (request.confirmation !== "DELETE")
          throw new Error("Uninstall confirmation must be DELETE");
        // Bug 修复：spec 要求 uninstall 前检查运行任务（R2-CLI-10）。旧实现只有
        // prepare-uninstall 会返回 blocked 却没有任何调用方消费它，confirm-uninstall
        // 直接停 Core 删数据，运行中的任务会被无提示中断。这里在最后防线上强制 guard，
        // 有运行任务时返回结构化错误并保持原状态。
        if (this.runningTaskCount > 0) {
          throw new Error(
            `Cannot uninstall while ${this.runningTaskCount} task(s) are running; stop the server first`,
          );
        }
        log.info("uninstall confirmed, stopping server");
        // [契约] uninstall 在 ack 之前已完成运行任务 guard，回包 uninstalled 代表停服动作已受理；
        // 真正的删数据由数据层完成，Supervisor 只保证 Core 与锁已释放。
        this.startAcknowledgedLifecycleOperation("uninstall", () => this.stopInternal("uninstall"));
        return { uninstalled: true };
    }
  }

  // [并发] 单槽位互斥：已有操作在跑时直接复用其 promise，调用方拿到同一结果而不是新开一条链；
  // promise 用 Promise.resolve().then 延迟到微任务，保证槽位先写入再执行，避免重入绕过 gate；
  // 完成与失败都只在仍是当前槽位时清空，防止旧操作清掉后来者的槽位；
  // [权衡] 冲突时返回首个操作结果，语义上等价于顺序执行，简化调用方的重试逻辑。
  private runLifecycleOperation<T>(
    kind: LifecycleOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLifecycleOperationCanStart(kind);
    const active = this.lifecycleOperation;
    if (active) {
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    this.lifecycleOperation = { kind, promise };
    void promise.then(
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
    );
    return promise;
  }

  private startAcknowledgedLifecycleOperation(
    kind: LifecycleOperationKind,
    operation: () => Promise<unknown>,
  ): void {
    // ack 型请求也必须在回包前检查 gate；后台 Promise 再 reject 会让客户端误以为
    // restart/uninstall 已受理，实际却只在 Supervisor 日志里留下冲突。
    this.assertLifecycleOperationCanStart(kind);
    const started = this.runLifecycleOperation(kind, async () => {
      // control response 必须先写回原 socket；直接关闭 control server 会与 dispatch 互等。
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation();
    });
    void started.catch((error: unknown) => {
      log.error(`lifecycle operation ${kind} failed`, error);
    });
  }

  // [契约] 唯一豁免是同类型 stop 重入（重复 stop 幂等），其余组合一律 operation-in-progress；
  // 抛出的 ControlRequestError 带 retryable 标记，客户端可据此稍后重试而非直接放弃。
  // [并发] 判定与槽位写入在同一同步段内完成，中间没有 await，因此不存在检查后抢跑。
  private assertLifecycleOperationCanStart(kind: LifecycleOperationKind): void {
    const active = this.lifecycleOperation;
    if (!active || (kind === "stop" && active.kind === "stop")) return;
    throw new ControlRequestError(
      "operation-in-progress",
      `Lifecycle operation ${active.kind} is already in progress`,
      true,
    );
  }
}
