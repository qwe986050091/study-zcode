/**
 * ============================================================================
 * runtime/execution-state.ts —— 执行状态（mode / planEnabled）的唯一写入口
 * ============================================================================
 *
 * 【定位】mode 与 planEnabled 是"权限与计划"的已消费状态：
 *   内存 config、session entry、session_mode_changed 事件三者必须一致。
 *   本文件负责按"先持久化、再改内存、最后发事件"的顺序提交，任一失败都不留下
 *   半更新状态（不会出现 UI 显示 yolo 但持久化仍是 plan 的分裂）。
 *
 * 【与 permission-grant 的关系】待发布的 permissionGrant（用户一次性放行整批
 *   排队输入）必须先恢复/发布，否则新 mode 会与队列项的 intent 口径冲突。
 *
 * 【并发】permissionFullAccessPending 期间直接 reject：
 *   权限升级是"已消费状态"，并发改 mode 会让授权对象与队列快照对不上。
 *
 * 【互斥约束】Plan 与 active Goal 不能同时启用：两者都要求"尚未开始执行"，
 *   同时开启会让 goal 的完成校验与 plan 的只读约束互相打架。
 * ============================================================================
 */
import { resolveExecutionState, type ExecutionState } from "@zcode/shared";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SessionEventType,
  type TraceContext,
  type SessionId,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

// 从 runtime.config 解析当前执行状态。config 是唯一内存事实来源，
// 不在此处读 session entry（恢复流程会先把 entry 灌进 config）。
// 输出 { mode, planEnabled } 由 shared 的 resolveExecutionState 归一化；
// 纯读、无副作用、不触发 I/O——需要 durable 事实时必须先完成 resume。
export function readRuntimeExecutionState(runtime: AgentRuntimeInternal): ExecutionState {
  return resolveExecutionState(runtime.config);
}

/**
 * 持久化执行状态到 session entry。
 *
 * 两个跳过条件都有含义：
 *   - sessionPersisted=false：新会话的 entry 由 ensureSessionPersisted 统一创建，
 *     此时先写会因外键不存在而失败；
 *   - 无 saveSessionEntry：精简 store/测试环境，执行状态只存在于内存。
 * 注意这里**不吞**写入错误：状态持久化失败必须让调用方回滚/中止。
 */
export async function persistExecutionState(
  runtime: AgentRuntimeInternal,
  state = readRuntimeExecutionState(runtime),
): Promise<void> {
  // 两个早退条件各自有语义:
  //   sessionPersisted=false → 新会话 entry 由 ensureSessionPersisted 统一创建,先写会外键失败;
  //   无 saveSessionEntry → 精简 store/测试环境,状态只在内存。
  // 失败处理:不吞写入错误——持久化失败必须让调用方回滚/中止,否则内存与 durable 分裂。
  // 维护不变量:config / session entry / session_mode_changed 事件三者口径一致(链路 0 执行态)。
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  await runtime.sessionStore.saveSessionEntry(buildExecutionStateEntry(runtime.sessionId, state));
}

/**
 * 构造执行态的 session entry。id 固定为 `${sessionId}:runtime-execution-state`,
 * 因此同一会话永远只有一条,写入是覆盖而非追加;touchSession=false 表示这次写入
 * 不改变会话的 updated 时间,避免执行态刷新干扰会话列表排序。纯构造、无 I/O。
 */
export function buildExecutionStateEntry(
  sessionId: SessionId,
  state: ExecutionState,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-execution-state`,
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: state,
  };
}

/**
 * 提交一次执行状态变更（命令或工具触发）。
 *
 * 权限与 Plan 是一个"已消费状态"：保存失败不发布成功快照，也不提前改内存。
 *
 * 顺序（任一失败即中止，内存不变）：
 *   1) 处理 permissionFullAccessPending / 未发布的 permissionGrant；
 *   2) 计算 next 并与 previous 比较，无变化直接返回（幂等，不发多余事件）；
 *   3) 校验 Plan 与 active Goal 互斥；
 *   4) 持久化 session entry；
 *   5) 更新内存 config（mode/planEnabled）与 plan 退出提醒；
 *   6) 发 session_mode_changed（带 previous* 与 source，供 projection/UI 审计）。
 *
 * needsPlanModeExitReminder：只在 planEnabled 发生翻转时设置，
 * 表示"模式刚变化，下一轮需要提醒模型当前约束"；置 false 的时机在下游消费。
 */
export async function applyRuntimeExecutionState(
  runtime: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  cause: { source: "command" | "tool"; toolCallId?: string; traceContext?: TraceContext },
): Promise<ExecutionState> {
  // 权限升级是"已消费状态":permissionFullAccessPending 期间并发改 mode,
  // 会让授权对象与队列快照对不上 → 直接 reject 让调用方重试。
  // 维护不变量#3:权限只能收紧——permissionFullAccessPending 期间不允许 mode 变更,
  // 避免新 mode 与待发布的授权状态产生竞态。
  if (runtime.permissionFullAccessPending)
    throw new Error("Permission update is busy; retry mode change");
  // 待发布的 permissionGrant 必须先恢复/发布,否则新 mode 会与队列项 intent 冲突。
  if (unpublishedPermissionGrants.has(runtime)) await recoverPendingPermissionGrant(runtime);
  const previous = readRuntimeExecutionState(runtime);
  const next = resolveExecutionState(input, previous);
  // 幂等早退:mode 与 planEnabled 都未变化 → 不发多余事件,不写 entry。
  // 维护不变量:事件只在真正状态迁移时发出,避免 projection/UI 收到无意义 update。
  if (next.mode === previous.mode && next.planEnabled === previous.planEnabled) return next;
  // Plan 与 active Goal 互斥:两者都要求"尚未开始执行",同时开启会让 goal 完成校验
  // 与 plan 只读约束打架 → 直接抛错,不做半更新。
  if (next.planEnabled && !previous.planEnabled) {
    const goal = await runtime.readSessionTargetForContext?.(
      cause.traceContext ?? runtime.rootTraceContext,
    );
    if (goal?.status === "active")
      throw new Error("Plan and Goal cannot be active at the same time.");
  }
  // 先持久化 session entry,成功后才改内存——任何一步失败都不留下半更新状态
  // (不会出现 UI 显示 yolo 但持久化仍是 plan 的分裂)。
  await persistExecutionState(runtime, next);
  runtime.config.mode = next.mode;
  runtime.config.planEnabled = next.planEnabled;
  // needsPlanModeExitReminder 只在 planEnabled 翻转时置位,表示"模式刚变化,
  // 下一轮需要提醒模型当前约束";置 false 的时机由下游消费(turn-loop 注入提醒后清)。
  if (previous.planEnabled !== next.planEnabled)
    runtime.needsPlanModeExitReminder = !next.planEnabled;
  const trace = cause.traceContext ?? runtime.rootTraceContext;
  // 发 session_mode_changed:带 previous* 与 source,供 projection/UI 审计迁移来源
  // (command 还是 tool),失败会抛出——事件落库失败不能让内存状态独走。
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionModeChanged,
      {
        ...next,
        previousMode: previous.mode,
        previousPlanEnabled: previous.planEnabled,
        source: cause.source,
        ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
      },
      trace,
    ),
    trace,
  );
  return next;
}
