// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。
// V4 pending command registry 深注：renderer 侧唯一一份「已上行、尚未被权威证实」的恢复账本。
// 职责边界：按 sessionId 与 commandId 登记恢复线索，接收 ACK、commands query、snapshot 三类权威证据并结算。
// 职责边界：维护 composer 草稿归属，让首发命令的成功或失败与本地草稿状态同进同退。
// 不属于本文件：命令 admission、ACK 语义、snapshot 生成、是否重放 —— 分别属于 CLI/runtime 与用户。
// 账本键由 sessionId 与 commandId 组成，以 NUL 分隔，全局命令用 <global> 占位。
// 条目 TTL 为 24 小时，锚定 record 首次登记时刻，reload、对账、关闭恢复提示都不得续期。
// 权威证据只有三类：ACK、commands query 结果、snapshot 中的 queue 或 transcript 投影，缺一不结算。
// INV-01 断言：账本只记录恢复线索，不构成权威事实，任何界面都不得据此断言命令已到达 CLI —— 守住它的位置：PendingCommandEntry 与 applyAck、applyQuery 的收口分支 —— 改错故障：把 accepted 当成会话已接受，刷新后出现重复发送。
// INV-02 断言：账本键必须同时包含 sessionId 与 commandId，全局命令用 <global> 占位 —— 守住它的位置：keyOf —— 改错故障：createSession 前后同 commandId 落到两个会话，键冲突导致旧条目被覆盖。
// INV-03 断言：record 对同一键是首次登记优先，重复记录返回既有条目而不刷新 issuedAt 与 expiresAt —— 守住它的位置：existing 早返回 —— 改错故障：重试把 TTL 推后，过期命令永远不被 prune 清掉。
// INV-04 断言：TTL 只由 record 计算一次，24 小时从首次登记起算，对账不得续期 —— 守住它的位置：expiresAt 赋值 —— 改错故障：离线数天的账本长期驻留，恢复提示反复出现。
// INV-05 断言：replay 仅在 pendingCommandReplayFor 返回非空时登记，不支持的 envelope 必须直接丢弃 —— 守住它的位置：record 的 replay 空判断 —— 改错故障：登记了无法重放的条目，用户点重发没有任何反应。
// INV-06 断言：首发恢复线索写入 localStorage 失败时必须回滚内存并拒绝上行 —— 守住它的位置：record 的 commit 检查与 delete —— 改错故障：留下一条无法查询、无法清理的幽灵命令身份。
// INV-07 断言：sensitiveDigest 永不重放，拿到确定 ACK 或查询结果后立即结算 —— 守住它的位置：applyAck 与 applyQuery 的首个分支 —— 改错故障：交互答案在本地长期留存，并可能被二次提交。
// INV-08 断言：accepted 与 duplicate 语义相同，都必须先过 acceptComposer，成功后才通知 resolution —— 守住它的位置：两个成功的 ACK 分支 —— 改错故障：草稿尚未交接就宣告解决，输入框内容丢失。
// INV-09 断言：inputDiscardedOnRestart 且 delivery 为 queue 或 guide 时属于 runtime 本地丢弃，直接结算而不是标记待恢复 —— 守住它的位置：isRuntimeLocalDiscard —— 改错故障：正常重启后的旧队列被当成故障，弹出无法处理的横幅。
// INV-10 断言：查询返回 queryUnavailable 时不得结算，必须保留线索等下一轮 —— 守住它的位置：applyQuery 的跳过分支 —— 改错故障：一次查询不可用就丢掉唯一查询依据，之后再也无法对账。
// INV-11 断言：查询返回 unknown 时，若本账本仍持有对应 pending draft 则保留，否则静默结算 —— 守住它的位置：applyQuery 的 unknown 分支 —— 改错故障：首发结果未知被清账，界面既不清草稿也不提示。
// INV-12 断言：snapshot 中 queue 条目、userInput 行、compact 时间线标记都算权威接收证据 —— 守住它的位置：reconcileSnapshot 的 settled 集合 —— 改错故障：正常进入 queue 的命令仍被提示重发，App 重启后产生重复输入。
// INV-13 断言：createSession 被接受后必须把键从 null 会话重映射到新 sessionId —— 守住它的位置：remapCreatedSession —— 改错故障：后续查询与结算全部落到旧键，账本泄漏到 TTL 到期。
// INV-14 断言：consumeReplay 是一次性消费，返回请求前必须解除 composer 归属并删除账本键 —— 守住它的位置：consumeReplay 尾部两步 —— 改错故障：同一条恢复线索被重发两次，产生两条真实用户消息。
// INV-15 断言：reconcileSession 同一 workspaceKey 与 sessionId 只允许一个在飞请求，后来者复用同一个 Promise —— 守住它的位置：reconcileInFlight 的提前返回与收尾清理 —— 改错故障：并发对账对同一条命令重复结算，listener 被触发两次。
// INV-16 断言：pruneExpired 只清理已过期且不再持有 pending draft 的条目 —— 守住它的位置：pruneExpired 的删除条件 —— 改错故障：把用户仍在编辑的首发草稿清掉，输入框变成无主草稿。
// 结算与清理顺序：先重映射 sessionId，再接受 composer，再通知 resolution，最后删键并提交。
// 一次对账最多 64 条一批，批与批之间是不同的异步往返，中间可能已有别的结算发生。
// 阅读顺序建议：record 登记 → applyAck 或 applyQuery 或 reconcileSnapshot 对账 → consumeReplay 一次性消费。
// 以上内容只描述现状契约，不构成行为改动，任何调整都必须同步维护 INV 表。
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  resolvePendingCommandWorkspaceKey,
  type PendingCommandClientContext,
} from "@/v4/pendingCommandWorkspace.js";
import { pendingCommandReplayFor, type PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
import { acceptComposerRecentReceipt } from "@/lib/composerRecent.js";
import {
  completePendingTaskDraft,
  markPendingTaskDraftCommand,
  releasePendingTaskDraftCommand,
  readPendingTaskDraft,
  readV4ComposerDraft,
  persistV4ComposerDraft,
  clearV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
export type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";

export type PendingCommandResolution =
  | "accepted"
  | "duplicate"
  | "authoritative"
  | "unknown"
  | "failed"
  | "discarded";

export const PENDING_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "zcode-v4-pending-commands:v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingCommandRecoveryReason = "discarded";

export interface PendingCommandEntry {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
  replay: PendingCommandReplay;
  clientContext?: PendingCommandClientContext;
  recovery?: PendingCommandRecoveryReason;
  recoveryDismissed?: boolean;
}

export interface PendingCommandReplayRequest {
  type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
  payload: Record<string, unknown>;
  sessionId: string | null;
  baseRevision?: number;
  clientContext?: PendingCommandClientContext;
}

export interface PendingCommandRegistryOptions {
  storage?: StorageLike;
  now?: () => number;
}

type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;

// [契约] 存储句柄只在此处解析一次，SSR 或隐私模式下拿不到 localStorage 时返回空。
// [失败路径] 取值本身可能抛错，必须吞掉并降级为内存账本，不能让聊天入口起不来。
// [权衡] 不缓存解析结果，因为测试会替换全局对象，缓存会让注入的假存储失效。
function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// [契约] 键是 sessionId 与 commandId 的二元组，用 NUL 拼接，避免分隔符与 id 内容相撞。
// [契约] sessionId 为空时统一落到 <global> 桶，createSession 之前与之后是两条不同的键。
// [并发] 键只由这两个字段决定，不掺入 workspace，跨 workspace 的同名命令因此天然隔离到不同会话。
// [失败路径] 若只按 commandId 建键，重映射与结算都会命中错误条目，表现为账本删不掉。
function keyOf(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "<global>"}\u0000${commandId}`;
}

// [契约] 重放载荷必须深拷贝后才交出去，调用方修改它不能污染持久化账本。
// [权衡] 用 JSON 往返而不是结构化克隆，因为载荷本身只允许可序列化的协议字段。
// [失败路径] 不可序列化的载荷会在此抛错，宁可失败也不把半截对象交给上行层。
function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

// [契约] 这是 localStorage 反序列化的唯一闸门，字段类型不符即视为脏数据整条丢弃。
// [契约] 只校验对账必需字段，clientContext 与 recovery 属于可选线索，缺失不影响条目可用。
// [失败路径] 放宽这里等于让旧版本或手改的 JSON 进入内存，后续结算会出现不可预期的会话错配。
function isEntry(value: unknown): value is PendingCommandEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingCommandEntry>;
  return (
    typeof entry.commandId === "string" &&
    typeof entry.clientId === "string" &&
    (typeof entry.sessionId === "string" || entry.sessionId === null) &&
    typeof entry.issuedAt === "number" &&
    typeof entry.expiresAt === "number" &&
    Boolean(entry.replay) &&
    typeof entry.replay === "object"
  );
}

// [契约] 只有重启导致的本地丢弃且投递形态为 queue 或 guide，才算 runtime 自己放弃了这条输入。
// [权衡] 这类失败不需要用户处理，因此后续走 discarded 结算，而不是留一条恢复横幅。
// [失败路径] 扩大判定范围会把真正需要恢复的失败一起吞掉，用户再也看不到重发入口。
function isRuntimeLocalDiscard(ack: CommandAck): boolean {
  return (
    ack.reasonCode === "fault.command.inputDiscardedOnRestart" &&
    ack.result?.type === "inputDisposition" &&
    (ack.result.delivery === "queue" || ack.result.delivery === "guide")
  );
}

/**
 * ACK、queue 与 transcript 曾分别维护临时状态；renderer 刷新或 ACK 丢失后，
 * UI 已清空但无法证明 CLI 是否 admission。这里把“待对账线索”先于上行持久化，并用
 * queue/guided/transcript sourceCommandId 或显式终态收口；registry 本身永远不产生权威事实。
 */
export class PendingCommandRegistry {
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  // [契约] 内存账本是唯一运行时真相，localStorage 只是它的序列化副本。
  // [并发] 所有增删都在 renderer 单线程上完成，Map 的迭代顺序即登记顺序，list 再按 issuedAt 排序。
  // [资源] 条目只通过 settle、查询 unknown、runtime 丢弃与 TTL 过期四条路径释放，没有别的删除点。
  // [权衡] 不额外维护索引，因为单会话待处理命令数量有限，线性扫描换来的是一致性。
  private readonly entries = new Map<string, PendingCommandEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly resolutionListeners = new Map<
    string,
    Set<(resolution: PendingCommandResolution) => void>
  >();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.load();
  }

  // [契约] 订阅只用于界面重绘，不携带差异，回调方自行重新读 list。
  // [资源] 退订闭包删除的是同一个函数引用，传匿名包装会让监听集合永远收缩不了。
  // [并发] 回调在 commit 的末尾同步遍历，期间再次 commit 会重入，回调里不要写账本。
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // [契约] resolution 是按 commandId 的一次性通知，触发后本命令的监听集合整体注销。
  // [时序] 必须在发起上行之前订阅，否则 ACK 可能在界面挂载前就到达而无人接收。
  // [资源] 退订时若集合已空要顺手删除该键，否则一次性通知的键会永久留在表里。
  // [失败路径] 同一命令重复订阅是允许的，多个监听者会各收到一次，顺序按注册先后。
  subscribeResolution(
    commandId: string,
    listener: (resolution: PendingCommandResolution) => void,
  ): () => void {
    const listeners = this.resolutionListeners.get(commandId) ?? new Set();
    listeners.add(listener);
    this.resolutionListeners.set(commandId, listeners);
    return () => {
      const current = this.resolutionListeners.get(commandId);
      current?.delete(listener);
      if (current?.size === 0) this.resolutionListeners.delete(commandId);
    };
  }

  // [契约] 这是账本唯一的写入口，envelope 必须已由上层完成协议校验与 commandId 生成。
  // [时序] 先 prune 再登记，保证同一次写入里不会同时存在一条刚过期与一条新登记的键。
  // [契约] 返回空表示该命令类型不支持恢复，调用方仍可正常上行，只是刷新后不再提示。
  // [事务] 持久化成功后才标记 composer 的待处理命令，两步任一步失败都要把内存条目撤回。
  // [权衡] 这里不校验 issuedAt 是否超前，时钟回拨由 TTL 判定自然覆盖。
  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
  ): PendingCommandEntry | null {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    if (!replay) return null;
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    // [契约] 同键重复登记是幂等的，返回既有条目，不改 issuedAt 也不改 expiresAt。
    // [并发] 重试与首发的竞态在这里收敛，后到者拿到的是首发那一条，不会产生双份线索。
    // [权衡] 不做字段合并，因为 clientContext 属于首发上下文，覆盖会让草稿归属漂移。
    if (existing) return existing;
    const entry: PendingCommandEntry = {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      sessionId: envelope.sessionId,
      issuedAt: envelope.issuedAt,
      // TTL 锚定首次登记时间；reload/reconcile 不得续期。
      // [契约] TTL 从本行首次登记时刻起算，24 小时后由 pruneExpired 清理。
      // [并发] `this.now()` 只在登记时读一次，后续过期判断都以 `expiresAt` 为准。
      // [失败路径] 若在对账里刷新它，长期离线用户的账本将永远不过期，恢复提示反复打扰。
      expiresAt: this.now() + PENDING_COMMAND_TTL_MS,
      replay,
      ...(clientContext ? { clientContext } : {}),
    };
    this.entries.set(key, entry);
    const composer = clientContext?.composer;
    // 首发恢复线索必须先持久化；失败时拒绝上行，不能留下无法查询的待发送身份。
    // [事务] 首发草稿把命令身份写进任务目录，因此必须先证明恢复线索已持久化。
    // [失败路径] 存储不可用时回滚内存条目并抛错，让上层放弃本次上行而不是留下无法查询的身份。
    // [权衡] 只有带草稿的首发才强制写盘成功，普通命令允许内存降级，保证聊天不被存储故障阻断。
    // [契约] 抛出的错误是固定的 composer 存储不可用语义，调用方据此提示而不是重试。
    if (!this.commit() && composer?.draftId) {
      this.entries.delete(key);
      throw new Error("composer.draft-storage-unavailable");
    }
    try {
      if (composer?.draftId)
        markPendingTaskDraftCommand(
          composer.scope,
          composer.draftId,
          envelope.commandId,
          envelope.sessionId,
        );
    } catch (error) {
      this.entries.delete(key);
      this.commit();
      throw error;
    }
    return entry;
  }

  // [契约] 按会话过滤并升序返回，顺序即用户提交顺序，消费方不要自行重排。
  // [时序] 每次读取前先 prune，调用方拿到的列表里不会夹杂已过期的条目。
  // [资源] 返回新数组，调用方可以安全地迭代或过滤，不会影响内部 Map。
  list(sessionId: string | null): readonly PendingCommandEntry[] {
    this.pruneExpired();
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  findCommand(commandId: string): PendingCommandEntry | undefined {
    return [...this.entries.values()].find((entry) => entry.commandId === commandId);
  }

  // [契约] 只有仍处于 discarded 且用户未关闭的条目才需要恢复界面。
  // [契约] recovery 已清除的条目说明对账已有结论，不能再次出现在恢复列表里。
  // [失败路径] 若把 unknown 或 failed 混进来，界面会把不可操作的结论渲染成可重发按钮。
  listRecoverable(sessionId: string | null): readonly PendingCommandEntry[] {
    return this.list(sessionId).filter(
      // 兼容 V4 初版已经写入 localStorage 的 unknown：它不是可操作错误，不能再进入 UI。
      (entry) => entry.recovery === "discarded" && !entry.recoveryDismissed,
    );
  }

  // [契约] 结算只删键并提交，不碰 composer，因为草稿清理属于接受与拒绝的职责。
  // [并发] 删除不到直接返回，避免无变更的提交触发一次无意义的重绘广播。
  // [资源] 这是大多数终态的公共出口，任何新增删除路径都应复用这里而不是直接操作 Map。
  settle(sessionId: string | null, commandId: string): void {
    if (!this.entries.delete(keyOf(sessionId, commandId))) return;
    this.commit();
  }

  // [契约] `rejectCommand` 先释放草稿归属再删账本，顺序反了会丢诊断状态。
  // [时序] 释放放在删除之前，保证即使删键抛出也能留下可诊断的草稿状态。
  // [失败路径] 条目已不存在时结算安静返回，重复调用是安全的。
  rejectCommand(sessionId: string | null, commandId: string): void {
    const entry = this.entries.get(keyOf(sessionId, commandId));
    if (entry) this.rejectComposer(entry);
    this.settle(sessionId, commandId);
  }

  // [契约] 关闭恢复提示只翻标记，不删除条目，线索仍可用于后续对账。
  // [并发] 只有带 recovery 且未关闭的条目需要写回，其余直接返回，避免多余持久化。
  // [资源] 标记会随条目一直保留到结算，属于有意保留的用户决策记录。
  dismissRecovery(sessionId: string | null, commandId: string): void {
    const key = keyOf(sessionId, commandId);
    const entry = this.entries.get(key);
    if (!entry?.recovery || entry.recoveryDismissed) return;
    this.entries.set(key, { ...entry, recoveryDismissed: true });
    this.commit();
  }

  // [契约] ACK 是单条命令的权威结论，入口先按键取条目，取不到说明已被别的路径结算。
  // [时序] 重映射必须在分支判断之前完成，createSession 的成功 ACK 会带来新的 sessionId。
  // [事务] 成功分支的顺序是接受草稿、清恢复标记、通知，然后保留条目等待下一次证据，不可颠倒。
  // [失败路径] 草稿交接失败时直接返回，条目留在账本里等下次对账重试。
  applyAck(envelope: CommandEnvelope, ack: CommandAck): void {
    let entry = this.entries.get(keyOf(envelope.sessionId, envelope.commandId));
    if (!entry) return;
    if (entry.replay.kind === "sensitiveDigest") {
      // 交互答案不可重放；拿到确定 ACK 后其对账职责已结束。
      this.settle(entry.sessionId, entry.commandId);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      if (!this.acceptComposer(entry)) return;
      this.clearRecovery(entry);
      this.notifyResolution(entry.commandId, ack.status);
      return;
    }
    // [契约] 重启丢弃先释放草稿，再区分 runtime 本地丢弃与需要用户处理的失败。
    // [权衡] 前者立即结算且通知 discarded，后者只打恢复标记，让用户决定是否重发。
    // [失败路径] 两个分支都不删条目以外的状态，重复 ACK 到达时按幂等处理。
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      this.rejectComposer(entry);
      if (isRuntimeLocalDiscard(ack)) {
        this.notifyResolution(entry.commandId, "discarded");
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      this.notifyResolution(entry.commandId, "failed");
      this.markRecovery(entry, "discarded");
      return;
    }
    this.rejectComposer(entry);
    this.notifyResolution(entry.commandId, "failed");
    this.settle(entry.sessionId, entry.commandId);
  }

  // [契约] 查询结果是批量对账入口，逐条处理，单条失败不影响同批其他命令。
  // [时序] 未知结果先判断是否仍持有草稿，再决定保留还是静默结算。
  // [契约] 查询不可用属于暂时性结论，必须跳过而不是清账，否则丢失唯一查询依据。
  // [并发] 同一批内不允许跨条目共享可变状态，每条都从当前 Map 重新取最新条目。
  applyQuery(result: CommandsQueryResult): void {
    for (const item of result.results) {
      let entry = this.entries.get(keyOf(item.key.sessionId, item.key.commandId));
      if (!entry) continue;
      if (item.result === "unknown") {
        // 首发结果未知不能释放目录或删除唯一的查询线索。
        if (this.ownsPendingDraft(entry)) continue;
        // V4 初版把“权威事实未命中”提升成需要用户处理的错误横幅，导致正常的
        // App/CLI 生命周期切换也频繁打扰用户。unknown 没有可操作结论，renderer 静默清账。
        this.notifyResolution(item.key.commandId, "unknown");
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.queryUnavailable"
      ) {
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.inputDiscardedOnRestart"
      ) {
        this.rejectComposer(entry);
        if (isRuntimeLocalDiscard(item.result)) {
          this.notifyResolution(entry.commandId, "discarded");
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        this.notifyResolution(entry.commandId, "failed");
        this.markRecovery(entry, "discarded");
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        if (!this.acceptComposer(entry)) continue;
        this.clearRecovery(entry);
        this.notifyResolution(entry.commandId, item.result.status);
      } else {
        this.rejectComposer(entry);
        this.notifyResolution(entry.commandId, "failed");
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  // [契约] snapshot 里的 queue 条目是 CLI 已接收的最强证据，优先于任何本地标记。
  // [契约] userInput 行与 compact 的时间线标记分别覆盖普通输入与维护命令两种形态。
  // [事务] 先收集命中集合再统一结算，避免边遍历边删除造成漏判。
  // [失败路径] 草稿交接失败的命令跳过删除，保留到下一次快照或查询。
  reconcileSnapshot(snapshot: ConversationSnapshot): void {
    const settled = new Set<string>();
    for (const item of snapshot.queue.items) {
      if (item.sourceCommandId) {
        // 把“进入 queue”当成仍未投递的话，直到 transcript 才清理
        // localStorage；App/CLI 重启后旧 runtime queue 被正常丢弃，却又触发重发提示。
        // queue projection 已是 CLI 权威接收证据，renderer ingress 账本应在此结算。
        settled.add(item.sourceCommandId);
      }
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        settled.add(row.sourceCommandId);
      }
      if (row.kind === "timelineMarker" && row.marker.type === "compact" && row.sourceCommandId) {
        // compact 不产生 user row；timeline marker 是该维护命令已开始执行的权威证据。
        settled.add(row.sourceCommandId);
      }
    }
    if (settled.size === 0) return;
    let changed = false;
    for (const commandId of settled) {
      const entry = this.entries.get(keyOf(snapshot.sessionId, commandId));
      if (entry && !this.acceptComposer(entry)) continue;
      this.notifyResolution(commandId, "authoritative");
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  // [契约] 接受草稿是三段式：写最近回执、把根草稿移交到真实会话、完成待处理草稿。
  // [时序] 移交只在重放类型为 input 且文本与已提交文本不同时发生，否则说明用户已改过。
  // [失败路径] 任一存储操作失败都返回假，调用方据此保留账本条目，不做通知。
  // [权衡] 捕获所有异常并转为假值，因为这里是界面清理路径，抛错会中断整批对账。
  private acceptComposer(entry: PendingCommandEntry): boolean {
    const composer = entry.clientContext?.composer;
    if (!composer) return true;
    if (!acceptComposerRecentReceipt(composer, this.storage)) return false;
    try {
      if (composer.draftId && this.ownsPendingDraft(entry)) {
        const workspace = entry.clientContext?.workspace;
        if (!workspace || !entry.sessionId) return false;
        const draft = readV4ComposerDraft(
          workspace.workspacePath,
          workspace.workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          composer.scope,
        );
        // 首发期间可能已经切走；下一条输入仍归该 session，不能遗留给下一份任务目录。
        // 传输失败恢复的原文已被权威接纳，应清除而不是再次放入正式会话输入框。
        if (draft && entry.replay.kind === "input") {
          const payload = entry.replay.payload;
          const sentText =
            composer.submittedText ??
            (entry.replay.type === "createSession"
              ? (payload.firstInput as { text?: string } | undefined)?.text
              : (payload.displayText ?? payload.text));
          if (
            draft.text !== sentText &&
            !readV4ComposerDraft(
              workspace.workspacePath,
              workspace.workspaceIdentity,
              entry.sessionId,
            ) &&
            !persistV4ComposerDraft(
              workspace.workspacePath,
              workspace.workspaceIdentity,
              entry.sessionId,
              draft,
            )
          )
            return false;
        }
        if (
          !clearV4ComposerDraft(
            workspace.workspacePath,
            workspace.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            composer.scope,
          )
        )
          return false;
        completePendingTaskDraft(composer.scope, composer.draftId);
      }
      return true;
    } catch {
      return false;
    }
  }

  private rejectComposer(entry: PendingCommandEntry): void {
    const composer = entry.clientContext?.composer;
    if (composer?.draftId)
      releasePendingTaskDraftCommand(composer.scope, composer.draftId, entry.commandId);
  }

  // [契约] 在飞键由 workspaceKey 与 sessionId 组成，同一会话同一工作区只允许一个对账。
  // [并发] 后来者复用同一个 Promise，调用方拿到的是同一轮结果。
  // [资源] 收尾时必须确认表里仍是自己这个 Promise 再删，避免误删后发起的下一轮。
  // [权衡] 不做结果缓存，对账的目的就是拿到最新权威状态。
  reconcileSession(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    const inFlightKey = JSON.stringify([workspaceKey, sessionId]);
    const existing = this.reconcileInFlight.get(inFlightKey);
    if (existing) return existing;
    const pending = this.runReconcile(sessionId, query, workspaceKey).finally(() => {
      if (this.reconcileInFlight.get(inFlightKey) === pending) {
        this.reconcileInFlight.delete(inFlightKey);
      }
    });
    this.reconcileInFlight.set(inFlightKey, pending);
    return pending;
  }

  // [契约] 这是唯一把账本线索变成上行请求的出口，只有 input 类型可以重放。
  // [事务] 返回前必须解除草稿归属并删键，保证同一条线索不会被消费第二次。
  // [并发] 消费是同步的，两个调用方竞争同一命令时只有一个能拿到请求。
  // [契约] 载荷深拷贝后交付，调用方修改不会回写账本。
  // [失败路径] 条目不存在或类型不符直接返回空，上层应视为该命令已无可重放内容。
  consumeReplay(key: {
    sessionId: string | null;
    commandId: string;
  }): PendingCommandReplayRequest | null {
    const entry = this.entries.get(keyOf(key.sessionId, key.commandId));
    if (!entry || entry.replay.kind !== "input") return null;
    const request: PendingCommandReplayRequest = {
      type: entry.replay.type,
      payload: clonePayload(entry.replay.payload),
      sessionId: entry.sessionId,
      ...(entry.replay.baseRevision !== undefined
        ? { baseRevision: entry.replay.baseRevision }
        : {}),
      ...(entry.clientContext ? { clientContext: entry.clientContext } : {}),
    };
    // 用户已确认以新 commandId 重发，旧 discarded 线索在本地完成收口。
    this.rejectComposer(entry);
    this.settle(entry.sessionId, entry.commandId);
    return request;
  }

  // [契约] 先按会话取条目，再按 workspaceKey 过滤，空工作区的创建类命令允许跨 workspace 归集。
  // [并发] 每批 64 条串行往返，批次之间可能发生别的结算，因此每次都重新应用最新结果。
  // [时序] 过滤器里保留无工作区归属的条目，是因为 createSession 之前还没有 workspace 键。
  // [失败路径] 查询抛错会中断后续批次，已应用的结果保留，下一轮对账从剩余条目继续。
  private async runReconcile(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    // null bucket 会收集各 workspace 的创建；只能向命令原属 Agent 查询。
    const entries = this.list(sessionId).filter(
      (entry) =>
        workspaceKey === undefined ||
        resolvePendingCommandWorkspaceKey(entry) === workspaceKey ||
        (sessionId !== null && resolvePendingCommandWorkspaceKey(entry) === null),
    );
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const result = await query({
        commands: batch.map((entry) => ({
          sessionId: entry.sessionId,
          commandId: entry.commandId,
        })),
      });
      this.applyQuery(result);
    }
  }

  // [契约] 标记恢复是幂等的，已是同一原因时不重复写盘。
  // [事务] 写回时重置关闭标记，让新的恢复原因重新出现在界面上。
  // [资源] 标记不删除条目，线索要留到查询或快照给出结论。
  private markRecovery(entry: PendingCommandEntry, recovery: PendingCommandRecoveryReason): void {
    if (entry.recovery === recovery) return;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), {
      ...entry,
      recovery,
      recoveryDismissed: false,
    });
    this.commit();
  }

  private clearRecovery(entry: PendingCommandEntry): void {
    if (!entry.recovery && !entry.recoveryDismissed) return;
    const { recovery: _recovery, recoveryDismissed: _dismissed, ...settled } = entry;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), settled);
    this.commit();
  }

  private remapCreatedSession(entry: PendingCommandEntry, ack: CommandAck): PendingCommandEntry {
    if (
      entry.replay.kind !== "input" ||
      entry.replay.type !== "createSession" ||
      (ack.status !== "accepted" && ack.status !== "duplicate") ||
      ack.result?.type !== "createSession" ||
      entry.sessionId === ack.result.sessionId
    ) {
      return entry;
    }
    this.entries.delete(keyOf(entry.sessionId, entry.commandId));
    const remapped = { ...entry, sessionId: ack.result.sessionId };
    this.entries.set(keyOf(remapped.sessionId, remapped.commandId), remapped);
    this.commit();
    return remapped;
  }

  // [契约] `load()` 冷启动只做形状校验后灌入内存，不发任何网络或协议请求。
  // [失败路径] 解析失败或结构不符时清空内存，存储损坏不能阻断聊天入口。
  // [资源] 载入后立即 prune 一次，把上次会话遗留的过期条目就地清掉。
  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (isEntry(value)) {
          this.entries.set(keyOf(value.sessionId, value.commandId), value);
        }
      }
      this.pruneExpired();
    } catch {
      // storage 损坏不能阻断聊天；丢弃的是客户端恢复线索，不影响 CLI 权威事实。
      this.entries.clear();
    }
  }

  // [契约] 归属判定要求任务目录里记录的草稿号与本条目的草稿号一致。
  // [并发] 目录可能已被下一次首发改写，此时旧条目自动失去保护，允许被清理。
  // [权衡] 每次判定都重新读取目录而不是缓存，目录切换频繁且读取成本低。
  private ownsPendingDraft(entry: PendingCommandEntry): boolean {
    const composer = entry.clientContext?.composer;
    return Boolean(
      composer?.draftId && readPendingTaskDraft(composer.scope)?.draftId === composer.draftId,
    );
  }

  // [契约] `expiresAt <= now` 且不持有草稿才算过期，两个条件缺一不可。
  // [事务] 先统计是否有删除再统一提交，避免逐条写盘。
  // [失败路径] 仍持有草稿的条目必须留下，否则用户正在编辑的首发输入会失去命令身份。
  // [资源] 这是 TTL 的唯一执行点，record 与 list 只是提前触发它。
  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && !this.ownsPendingDraft(entry)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  // [契约] 空账本删除整个存储键，避免留下一个空数组让下次启动误判为有内容。
  // [事务] 写入失败只降级为内存模式，不抛错，首发场景由 record 检查返回值自行回滚。
  // [并发] 无论是否写盘成功都同步通知订阅者，界面以内存状态为准。
  // [失败路径] 返回值只表示是否写盘成功，不表示账本是否有效。
  private commit(): boolean {
    let written = Boolean(this.storage);
    if (this.storage) {
      try {
        if (this.entries.size === 0) {
          this.storage.removeItem(STORAGE_KEY);
        } else {
          this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
        }
      } catch {
        // 普通命令保持原有内存降级；首发目录交接由 record 检查写入结果。
        written = false;
      }
    }
    for (const listener of this.listeners) listener();
    return written;
  }

  private notifyResolution(commandId: string, resolution: PendingCommandResolution): void {
    const listeners = this.resolutionListeners.get(commandId);
    if (!listeners) return;
    this.resolutionListeners.delete(commandId);
    for (const listener of listeners) listener(resolution);
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
