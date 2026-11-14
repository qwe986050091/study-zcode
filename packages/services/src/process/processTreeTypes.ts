// 职责：定义进程树终止链路的类型契约——日志、快照、身份校验与终止结果。
// 边界：只声明数据形状与时序参数；实际 kill 策略在终止器实现，此处不承载副作用。
// INV：空快照不代表进程已退出，必须结合 identityVerification 判断，否则会误报清理成功。
// 改错后果：丢失身份或时间约束会让终止器认领复用 PID 的新进程，误杀无关任务。
import type { TraceId } from "@zcode/shared";

export interface ProcessTreeTerminatorLogger {
  debug?: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export interface WindowsTaskkillRequest {
  force: boolean;
  pid: number;
  timeoutMs: number;
}

export interface WindowsTaskkillResult {
  error?: unknown;
  stderr?: string;
}

export type WindowsTaskkillRunner = (
  request: WindowsTaskkillRequest,
) => Promise<WindowsTaskkillResult>;

export interface ProcessTreeTerminatorOptions {
  traceId?: TraceId;
  log?: ProcessTreeTerminatorLogger;
  forceAfterMs?: number;
  keepForceTimerRef?: boolean;
  /** POSIX Host 在 spawn(detached=true) 时拥有的独立进程组；仅用于 cleanup 边界。 */
  ownedProcessGroupId?: number;
  /** Windows Host 发起 spawn 的时间；与退出时间共同约束 root 退出后的后代归属。 */
  ownedProcessStartedAtMs?: number;
  /** Windows root 被观察到退出的时间；禁止认领此后由复用 PID 创建的新后代。 */
  ownedProcessExitedAtMs?: number;
  /** 异步查询完成时读取受管 ChildProcess 的真实 exit 事件时间。 */
  resolveOwnedProcessExitedAtMs?: () => number | undefined;
  /** Windows taskkill 依赖注入；生产默认仍使用异步 execFile，确定性时序测试可替换。 */
  windowsTaskkillRunner?: WindowsTaskkillRunner;
  /** Windows taskkill 单次命令预算；默认 2 秒，测试可缩短。 */
  windowsTaskkillTimeoutMs?: number;
  /** Windows cleanup 全链路绝对截止时间（Unix epoch ms）；覆盖快照、EOF、taskkill 与 exit 观察。 */
  windowsCleanupDeadlineAtMs?: number;
}

export interface ProcessIdentity {
  parentPid: number;
  pid: number;
  processGroupId?: number;
  startTime: string;
}

// 归属判定必须同时给出当前观测与历史已知身份，调用方据此区分自然退出与 PID 复用。
// childStillOwned 为 false 只表示不再归本树所有，并不蕴含子进程已经结束。
export interface ProcessTreeOwnershipResolution {
  childStillOwned: boolean;
  currentIdentities: ProcessIdentity[];
  knownIdentities: ProcessIdentity[];
}

export interface ProcessTreeTerminationResult {
  remainingPids: number[];
}

// 快照是一次采样的不可变视图：descendantPids 与 identities 不保证来自同一时刻。
// 采样发生在清理前，之后新生的后代不在其中，这正是需要时间窗约束的根本原因。
export interface ProcessTreeSnapshot {
  rootPid: number;
  descendantPids: readonly number[];
  identities: readonly ProcessIdentity[];
  /** Windows 进程表查询失败时，空 identities 不代表进程树已经退出。 */
  identityVerification?: "verified" | "unavailable";
}

// 复用终止选项并追加快照与强制后等待时长，保证两阶段清理共享同一组时序预算。
export interface ProcessTreeTerminatorWaitOptions extends ProcessTreeTerminatorOptions {
  snapshot?: ProcessTreeSnapshot;
  waitAfterForceMs?: number;
}
