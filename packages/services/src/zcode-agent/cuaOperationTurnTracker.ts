import { resolveWorkspaceKey, type ZCodeComputerUseOperationEvent } from "@zcode/shared";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";

export interface CuaOperationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

// 上报给桌面投影的状态快照：active=false 表示该 turn 结束，
// workspaceIdentity 与 workspacePath 一起构成归属，远端同名路径不能互相覆盖。
export interface CuaOperationState {
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationStateReporter {
  onStateChanged(event: CuaOperationState): void;
}

// 只暴露四个动作：投递事件、查询是否有活跃 turn、按 workspace/全量清理。
// 没有「设置状态」这种入口，状态只能由事件推导，避免出现无源真相。
export interface CuaOperationTurnTracker {
  accept(workspace: CuaOperationWorkspaceTarget, event: ZCodeComputerUseOperationEvent): void;
  /** 当前是否存在仍在执行 Computer Use 工具的 turn。 */
  hasActiveTurn(): boolean;
  clearWorkspaceKey(workspaceKey: string): void;
  clearAll(): void;
}

interface TrackerLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

// 三个 key 是同一事实的三级索引：workspaceKey 供清理，
// sessionKey/turnKey 供事件匹配与去重；对外上报时只暴露 CuaOperationState 的字段。
interface ActiveTurnRecord extends CuaOperationState {
  workspaceKey: string;
  sessionKey: string;
  turnKey: string;
}

// [资源] 已退役 turn 的记忆上限：它的唯一作用是拒绝迟到事件复活浮层，
// 超过上限按 FIFO 淘汰，最老 turn 早已不可能再有迟到事件。
const MAX_RETIRED_TURN_KEYS = 2_048;
// 事件 id 去重窗口比 turn 更大：sideband 可能重放多条工具事件，
// 仍用 FIFO 淘汰，保证内存有界。
const MAX_SEEN_OPERATION_EVENT_IDS = 8_192;

// 上报对象刻意剔除内部 key：投影层不需要也不应该依赖路由细节；
// workspaceIdentity 用条件展开，缺席与空串都会被省略。
function toReportedState(record: ActiveTurnRecord, active: boolean): CuaOperationState {
  return {
    active,
    sessionId: record.sessionId,
    turnId: record.turnId,
    workspacePath: record.workspacePath,
    ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
  };
}

// 三个旁路回调全部可选：Windows 顶部提示条、活跃/空闲边界、macOS PiP 生命周期。
// 它们都只是展示投影，不能影响主 session 事件链路。
export function createCuaOperationTurnTracker(options: {
  /** Windows 顶部提示条的桌面投影；非 win32 不注入。 */
  reporter?: CuaOperationStateReporter;
  /** Windows operation indicator 的聚合边界；PiP 不再消费该聚合状态。 */
  onTurnsActive?: () => void;
  onTurnsIdle?: () => void;
  /** macOS desktop-local PiP 只消费这些产品事实；panel policy 留在 producer。 */
  onPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
  logger?: TrackerLogger;
}): CuaOperationTurnTracker {
// 每个 session 当前 turn：用来拒绝迟到工具事件，以及在新 turn 开始时退役旧 turn。
  const currentTurnBySession = new Map<string, string>();
// 水位按 session 记录而不是全局：不同 session 的序号空间彼此独立，
// 全局比较会让活跃 session 把安静 session 的事件全判成迟到。
  const lastSeqBySession = new Map<string, number>();
  /**
   * 已排期、且经确认在用 Computer Use 的 tool call（键为 turnKey\0toolCallId）。
   *
   * 只有 tool-scheduled 携带模型源码（ToolCallStartedPayload 没有 input 字段），所以
   * "是否 CUA" 只能在排期时判定；但浮层要等真正开始执行才亮——排期与开始之间可能卡在
   * 权限审批上，那时还没有人在操作电脑。于是这里把排期时的事实存下来，交给 tool-started 兑现。
   */
// 排期时只能判定「是不是 CUA」，真正点亮要等 tool-started；两者用 toolKey 对齐。
  const computerUseScheduledCalls = new Set<string>();
// 活跃 turn 表即对外事实来源：hasActiveTurn 与边界回调都只看它。
  const activeTurns = new Map<string, ActiveTurnRecord>();
// 退役集合与顺序数组配合实现有界 FIFO；只用一个 Map 无法保证淘汰顺序。
  const retiredTurnKeys = new Set<string>();
// 与 Set 同步维护的插入顺序：Set 本身不提供稳定淘汰顺序，
// 只靠它会导致超限时随机删掉仍然需要的近期 key。
  const retiredTurnKeyOrder: string[] = [];
// 事件去重同样用 Set + 数组双结构，保证 O(1) 查询与确定性淘汰。
  const seenEventIds = new Set<string>();
// 事件 id 的顺序数组同理；两个数组都只在插入与淘汰两处改动，
// 任何删除都必须成对，否则 Set 与数组会长期漂移。
  const seenEventIdOrder: string[] = [];

// 用 \0 拼接而不是冒号/斜杠：workspace 路径里可能含任意可打印字符，
// 只有 NUL 不会出现在这些标识里，拼接结果才无歧义。
  const sessionKeyFor = (workspaceKey: string, sessionId: string) =>
    `${workspaceKey}\0${sessionId}`;
  const turnKeyFor = (sessionKey: string, turnId: string) => `${sessionKey}\0${turnId}`;
  const toolKeyFor = (turnKey: string, toolCallId: string) => `${turnKey}\0${toolCallId}`;

// 只在 0→1 与 1→0 两个边界各触发一次，中间增减不触发；
// 回调异常必须吞掉，否则会截断正在处理的 session 事件。
  function notifyBoundary(kind: "active" | "idle"): void {
    const callback = kind === "active" ? options.onTurnsActive : options.onTurnsIdle;
    if (!callback) return;
    options.logger?.info(
      `CUA operation turns ${kind === "active" ? "became active" : "went idle"} (activeTurns=${activeTurns.size})`,
    );
    try {
      callback();
    } catch (error) {
      // 边界回调是展示旁路（PiP 收口），不能截断主 session event 链路。
      options.logger?.warn(`CUA operation turn boundary callback failed error=${String(error)}`);
    }
  }

// PiP 只消费产品事实（开始/结束/会话关闭），不消费 focus 变化；
// 发布失败只记 warn，不影响 tracker 自身状态。
  function publishPipLifecycle(
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ): void {
    try {
      options.onPipSessionLifecycle?.(workspace, event);
    } catch (error) {
      options.logger?.warn(
        `CUA PiP lifecycle publisher failed session=${event.sessionId} event=${event.kind} error=${String(error)}`,
      );
    }
  }

// [失败路径] reporter 是 MessagePort 投影，端口关闭竞态会抛错；
// 这里必须吞掉异常并继续写日志，不能让它冒泡到 session 事件分发。
// refresh 只降日志级别：同一 turn 内新 CUA 单元只是刷新安全截止时间。
  function report(record: ActiveTurnRecord, active: boolean, refresh = false): void {
    if (options.reporter) {
      try {
        options.reporter.onStateChanged(toReportedState(record, active));
      } catch (error) {
        // Reporter 是桌面投影旁路；MessagePort 关闭竞态不能截断主 session event 链路。
        options.logger?.warn(
          `CUA operation reporter failed workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId} error=${String(error)}`,
        );
      }
    }
    const message = `CUA operation turn ${active ? "activated" : "cleared"} workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId}`;
    if (refresh) {
      options.logger?.debug(message);
    } else {
      options.logger?.info(message);
    }
  }

// 退役即「以后不再接受该 turn 的任何事件」；
// 幂等插入，超出上限按插入顺序淘汰最老 key。
  function retireTurn(turnKey: string): void {
    if (retiredTurnKeys.has(turnKey)) return;
    retiredTurnKeys.add(turnKey);
    retiredTurnKeyOrder.push(turnKey);
    while (retiredTurnKeyOrder.length > MAX_RETIRED_TURN_KEYS) {
      const removed = retiredTurnKeyOrder.shift();
      if (removed) retiredTurnKeys.delete(removed);
    }
  }

// [事务] 清理顺序：摘活跃记录 → 上报 inactive → 清该 turn 的排期标记 → 判边界。
// 只有真的删掉一条活跃记录才可能从 1 变 0，从未 active 的 turn 不触发 idle。
  function clearTurn(turnKey: string): void {
    const record = activeTurns.get(turnKey);
    if (record) {
      activeTurns.delete(turnKey);
      report(record, false);
    }
    const toolPrefix = `${turnKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(toolPrefix)) computerUseScheduledCalls.delete(key);
    }
    // 只有真的清掉了一个操作 turn 才可能归零；从未 active 过的 turn 不会触发边界。
    if (record && activeTurns.size === 0) notifyBoundary("idle");
  }

// 会话级清理遍历活跃表而不是按前缀找：turnKey 不含 sessionId 之外的信息，
// 必须先按 record.sessionKey 精确匹配，避免前缀碰撞误清别的会话。
  function clearSession(sessionKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.sessionKey === sessionKey) clearTurn(record.turnKey);
    }
    const sessionPrefix = `${sessionKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(sessionPrefix)) computerUseScheduledCalls.delete(key);
    }
  }

// [事务] 事件处理是单线程状态机：去重 → 水位校验 → 按 kind 分派。
// 任何一步提前 return 都不会改变已有状态，保证重放/乱序事件不会制造假浮层。
// 分派分支顺序固定：turn 生命周期优先，工具事件最后。
  function accept(
    workspace: CuaOperationWorkspaceTarget,
    event: ZCodeComputerUseOperationEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    const sessionKey = sessionKeyFor(workspaceKey, event.sessionId);
    const eventKey = `${workspaceKey}\0${event.eventId}`;
// [并发] 事件 id 去重必须先于水位判断：sideband 重放可能带着更大的序号回来，
// 先比序号会让重复事件通过校验；这里以 id 为唯一事实。
    if (seenEventIds.has(eventKey)) return;
    seenEventIds.add(eventKey);
    seenEventIdOrder.push(eventKey);
    while (seenEventIdOrder.length > MAX_SEEN_OPERATION_EVENT_IDS) {
      const removed = seenEventIdOrder.shift();
      if (removed) seenEventIds.delete(removed);
    }

    const lastSeq = lastSeqBySession.get(sessionKey) ?? 0;
// 严格小于才丢弃，等于允许通过：同一序号的不同事件（如工具开始与结束）需要都处理。
    if (event.sequenceNumber < lastSeq) {
      options.logger?.debug(
        `ignored stale CUA operation event sequenceNumber=${event.sequenceNumber} lastSeq=${lastSeq} session=${event.sessionId}`,
      );
      return;
    }
    // sideband 使用 runtime 原始 sequenceNumber；不能与旧 session/event 的投影 seq
    // 混用，否则较大的 raw 序号会让后续旧协议终态被误判为迟到并留下永久浮层。
    lastSeqBySession.set(sessionKey, Math.max(lastSeq, event.sequenceNumber));

// [事务] 新 turn 开始：先发布 PiP 事实，再退役并清理旧 turn，最后记录当前 turn。
// 顺序保证旧 turn 的迟到工具事件在清理后无法复活浮层。
// 已在退役集合中的 turn 直接忽略，避免重放把已结束的 turn 重新点亮。
    if (event.kind === "turn-started") {
      if (!event.turnId) return;
      const nextTurnKey = turnKeyFor(sessionKey, event.turnId);
      if (retiredTurnKeys.has(nextTurnKey)) return;
      publishPipLifecycle(workspace, {
        kind: "turn-started",
        sessionId: event.sessionId,
        turnId: event.turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const previousTurnId = currentTurnBySession.get(sessionKey);
      if (previousTurnId && previousTurnId !== event.turnId) {
        retireTurn(turnKeyFor(sessionKey, previousTurnId));
        clearSession(sessionKey);
      }
      currentTurnBySession.set(sessionKey, event.turnId);
      return;
    }

// 会话关闭是强终态：退役当前 turn、清会话全部状态、删除当前 turn 指针。
// 不依赖 turn-completed 是否到达，避免关闭后浮层常驻。
    if (event.kind === "session-closed") {
      publishPipLifecycle(workspace, {
        kind: "session-closed",
        sessionId: event.sessionId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
      });
      const currentTurnId = currentTurnBySession.get(sessionKey);
      if (currentTurnId) retireTurn(turnKeyFor(sessionKey, currentTurnId));
      clearSession(sessionKey);
      currentTurnBySession.delete(sessionKey);
      return;
    }

// 两种终态共用一条清理路径，只在上报 outcome 上区分；
// 只有在当前指针仍指向该 turn 时才清指针，防止并发新 turn 被误删。
    if (event.kind === "turn-completed" || event.kind === "turn-failed") {
      const turnId = event.turnId;
      if (!turnId) return;
      publishPipLifecycle(workspace, {
        kind: "turn-ended",
        sessionId: event.sessionId,
        turnId,
        sequenceNumber: event.sequenceNumber,
        eventId: event.eventId,
        outcome: event.kind === "turn-completed" ? "completed" : "failed",
      });
      const turnKey = turnKeyFor(sessionKey, turnId);
      retireTurn(turnKey);
      clearTurn(turnKey);
      if (currentTurnBySession.get(sessionKey) === turnId) {
        currentTurnBySession.delete(sessionKey);
      }
      return;
    }

    if (event.kind !== "tool-scheduled" && event.kind !== "tool-started") return;
    const toolCallId = event.toolCallId;
    const currentTurnId = currentTurnBySession.get(sessionKey);
    const turnId = event.turnId ?? currentTurnId;
    if (!toolCallId || !turnId) return;
    // 根因：新 turn 已替换旧 turn 后，迟到的旧 tool event 不能再次复活已终止的顶部提示。
// [失败路径] 旧 turn 的迟到工具事件必须拒绝：
// 否则它会把已终止的顶部提示重新激活，且再也等不到对应的完成事件。
    if (currentTurnId && turnId !== currentTurnId) return;
    if (!currentTurnId) currentTurnBySession.set(sessionKey, turnId);

    const turnKey = turnKeyFor(sessionKey, turnId);
    if (retiredTurnKeys.has(turnKey)) return;
    const toolKey = toolKeyFor(turnKey, toolCallId);
    if (event.kind === "tool-scheduled") {
// 只有 computerUse=true 的排期才登记：普通工具开始时不查表，
// 因此不会产生任何浮层或安全计时。
      if (event.computerUse) computerUseScheduledCalls.add(toolKey);
      return;
    }

    // 只认"这次 tool call 在用 Computer Use"这一个布尔事实，不解析动作名：
    // 动作名要从模型源码里抽出来再拿动作词表比对，SDK 面一改就整条链失配。
    // 判定在 bootstrap 侧一次做完（usesComputerUse）。
// delete 同时完成「查表」与「消费」：同一 tool call 的 started 只兑现一次，
// 重放事件不会重复激活；未排期过的工具直接返回。
    if (!computerUseScheduledCalls.delete(toolKey)) return;

    const existingRecord = activeTurns.get(turnKey);
// 同一 turn 内后续 CUA 单元只刷新：reporter 会重置安全截止时间但不会重建窗口。
    if (existingRecord) {
      // 同一 turn 内每个新 CUA cell 都要刷新桌面浮层的安全截止时间；Reporter 会在 Main 侧
      // 重置兜底计时器，但不会重复创建原生窗口。
      report(existingRecord, true, true);
      return;
    }

    const record: ActiveTurnRecord = {
      active: true,
      workspaceKey,
      sessionKey,
      turnKey,
      sessionId: event.sessionId,
      turnId,
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    };
    activeTurns.set(turnKey, record);
    report(record, true);
// 只在 0→1 时通知：多个 turn 并存时第一个已经点亮，后续不再重复触发。
    if (activeTurns.size === 1) notifyBoundary("active");
  }

// [资源] workspace 下线时清七张表：活跃 turn、当前指针、水位、排期标记、
// 退役集合与事件 id 集合。任何一张漏清，重建同名 workspace 后都会残留旧状态。
// 两个顺序数组必须倒序 splice，正序遍历会因下标位移跳过元素。
  function clearWorkspaceKey(workspaceKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.workspaceKey === workspaceKey) clearTurn(record.turnKey);
    }
    const workspacePrefix = `${workspaceKey}\0`;
    for (const key of currentTurnBySession.keys()) {
      if (key.startsWith(workspacePrefix)) currentTurnBySession.delete(key);
    }
    for (const key of lastSeqBySession.keys()) {
      if (key.startsWith(workspacePrefix)) lastSeqBySession.delete(key);
    }
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(workspacePrefix)) computerUseScheduledCalls.delete(key);
    }
    for (let index = retiredTurnKeyOrder.length - 1; index >= 0; index -= 1) {
      const key = retiredTurnKeyOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      retiredTurnKeyOrder.splice(index, 1);
      retiredTurnKeys.delete(key);
    }
    for (let index = seenEventIdOrder.length - 1; index >= 0; index -= 1) {
      const key = seenEventIdOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      seenEventIdOrder.splice(index, 1);
      seenEventIds.delete(key);
    }
  }

// 全量清理用于 Host 关闭：逐 turn 走正常清理以发出 inactive，再整体重置。
  function clearAll(): void {
    for (const record of activeTurns.values()) clearTurn(record.turnKey);
    currentTurnBySession.clear();
    lastSeqBySession.clear();
    computerUseScheduledCalls.clear();
    retiredTurnKeys.clear();
    retiredTurnKeyOrder.length = 0;
    seenEventIds.clear();
    seenEventIdOrder.length = 0;
  }

  return {
    accept,
// 返回值语义是「此刻是否有正在执行的 CUA turn」，供 Host 决定是否推迟关机。
    hasActiveTurn: () => activeTurns.size > 0,
    clearWorkspaceKey,
    clearAll,
  };
}
