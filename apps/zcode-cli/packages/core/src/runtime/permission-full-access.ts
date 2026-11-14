/**
 * ============================================================================
 * runtime/permission-full-access.ts —— 一次性"完全访问"放行(yolo)的提交入口
 * ============================================================================
 *
 * 【业务口径】
 *   用户批准一次"整批排队输入的完全访问"后,本会话切到 mode=yolo,并且只对
 *   receipt 里固定的 queueItemIds 生效(冻结目标集合),之后新入队的项不会
 *   被这次授权顺带放行。
 *
 * 【三段式与事实】
 *   1) durable:commitPermissionFullAccess 在一个事务里写执行状态 entry +
 *      permission receipt(session entry);receipt 存的是"同一只事件"的完整 payload;
 *   2) 内存:更新 config / lastPermissionGrantId / activeTurn 队列项 intent;
 *   3) 投影:事件已存在则只扇出 sink(幂等重发),否则 appendEvent 落库。
 *
 * 【不变量】
 *   - receipt 以 `${sessionId}:permission-full-access:${interactionId}` 为固定 id,
 *     重复审批命中同一 receipt,不会生成第二份授权;
 *   - 一旦事务提交,后面的传输取消不允许制造"半个授权":内存与事件必须继续发布;
 *   - 待发布状态登记在 internal.permissionFullAccessPending 与
 *     unpublishedPermissionGrants,供 mode 变更前先恢复。
 * ============================================================================
 */
import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "./execution-state.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

// 记录"内存发布已做过"的 interactionId,保证恢复路径重入时不会重复改 config/intent
// (事件可以重发,内存事实不能被写两次)。键是 runtime,随实例回收。
const appliedGrants = new WeakMap<AgentRuntimeInternal, Set<string>>();

/** 完全访问只改当前任务；receipt 固定目标集合，发布失败后不能重新抓取后来队列。 */
// 批准一次完全访问:写 receipt/执行状态 → 发布内存事实 → 发布/重发事件。
// 输入:interactionId(审批交互 id,幂等键)与可选 abortSignal。
// 输出:被发布事件的字符串 id(调用方用它回应审批)。
// 副作用:durable(commitPermissionFullAccess)+ 内存(config/queue intent)+ 事件。
// 失败语义:store 不支持 → 直接抛 "Full access is unsupported";队列正在变更
// (pending 标记/预留/正在 drain)→ 抛 "Queue mutation is busy" 让调用方重试;
// 事务提交前的 abort 可安全放弃;提交后的 abort 不再生效(见下方注释)。
// 不变量:receipt 里固定的 queueItemIds 就是本次授权范围,绝不重新抓取后来的队列项。
export async function grantPermissionFullAccess(
  this: AgentRuntimeInternal,
  interactionId: string,
  signal?: AbortSignal,
): Promise<string> {
  // 能力门:精简 store/测试环境没有事务入口时,不允许伪造授权。
  if (!this.sessionStore?.commitPermissionFullAccess) throw new Error("Full access is unsupported");
  // 并发门:审批要"冻结当前队列项集合",任何在途的预留/drain 都会让快照漂移,
  // 因此宁可让调用方重试,也不在队列变更中途抓取目标集合。
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.size > 0 ||
    this.pendingInputDrains
  ) {
    throw new Error("Queue mutation is busy; retry approval");
  }
  // 若上一次审批已提交但尚未发布,且是另一个交互:先完成它再开始本次,
  // 避免两个授权在半发布状态叠加。
  const unpublished = unpublishedPermissionGrants.get(this);
  if (unpublished && unpublished.interactionId !== interactionId)
    await recoverPendingPermissionGrant(this);
  this.permissionFullAccessPending = true;
  try {
    signal?.throwIfAborted();
    const receiptId = `${this.sessionId}:permission-full-access:${interactionId}`;
    // 固定 receipt id 让"重复审批"变成幂等查找:已存在就复用同一只事件,
    // 不再重新计算 queueItemIds(那一刻的队列已经不是授权对象)。
    const entries = await this.sessionStore.sessionEntries?.({
      sessionID: this.sessionId,
      type: PERMISSION_FULL_ACCESS_ENTRY,
    });
    const saved = entries?.find((entry) => entry.id === receiptId);
    let event: SessionEvent;
    if (saved) {
      // receipt 是持久化数据,读回时用 schema 校验;scope 不符说明 id 撞车或数据被
      // 串写,此时不能"尽量放行",必须失败(fail closed)。
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (data.event.sessionId !== this.sessionId || data.interactionId !== interactionId) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
    } else {
      // 首次审批:从投影取"当前仍在排队的项"作为冻结目标集合。
      // 用 projection 而不是 activeTurn.pendingInputs,是因为 held/暂停项也在投影里,
      // 它们同样属于本次授权的对象。
      const projection = await this.rebuildProjection();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      const next = { ...previous, mode: "yolo" as const };
      event = this.createEvent(
        SessionEventType.SessionModeChanged,
        {
          ...next,
          previousMode: previous.mode,
          previousPlanEnabled: previous.planEnabled,
          source: "command",
          permissionGrant: { interactionId, queueItemIds },
        },
        this.rootTraceContext,
      );
      // 第二个 abort 检查放在写事务之前:此后 receipt 一旦落库,授权即 durable,
      // 再因为传输取消而中止就会产生"已授权但 UI/内存不知道"的分裂。
      signal?.throwIfAborted();
      await this.sessionStore.commitPermissionFullAccess({
        sessionID: this.sessionId,
        queueItemIds,
        signal,
        execution: buildExecutionStateEntry(this.sessionId, next),
        receipt: {
          id: receiptId,
          sessionID: this.sessionId,
          type: PERMISSION_FULL_ACCESS_ENTRY,
          touchSession: false,
          time: { created: Date.now(), updated: Date.now() },
          data: { interactionId, event },
        },
      });
    }
    const payload = event.payload as SessionModeChangedPayload;
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => grantPermissionFullAccess.call(this, interactionId),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // 事务已提交：之后即使传输取消也必须完成内存和投影发布，不能制造半个授权。
    // appliedGrants 保证恢复重入时这段内存写入只发生一次(事件重发是无害的,
    // 但 config/intent 被写两次会让后来切换的 mode 被这次授权覆盖)。
    const applied = appliedGrants.get(this) ?? new Set<string>();
    if (!applied.has(interactionId)) {
      this.lastPermissionGrantId = interactionId;
      this.config.mode = payload.mode;
      this.config.planEnabled = payload.planEnabled;
      // 只改 receipt 名单内的项,且只改"已带 intent"的项:后者说明该输入在准入时
      // 捕获过执行态快照,如果不就地改成 yolo,后续从队列提升时会带着旧 mode 起轮。
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode: "yolo" };
      }
      applied.add(interactionId);
      appliedGrants.set(this, applied);
    }
    // 恢复路径可能发现事件其实已经落库:此时只补扇出 sink(幂等重发),
    // 不能重复 append,否则会生成重复事件污染 projection。
    const existing = (await this.eventStore.getEvents(this.sessionId)).find(
      (item) => item.id === event.id,
    );
    if (existing) await this.notifyEventSinks(existing, this.rootTraceContext);
    else await this.appendEvent(event, this.rootTraceContext);
    unpublishedPermissionGrants.delete(this);
    return String(event.id);
  } finally {
    // 成功/失败都必须解锁:该标记只用于阻止并行审批与并行 mode 变更,
    // 残留会让后续所有 setExecutionState 永久报 busy。
    this.permissionFullAccessPending = false;
  }
}
