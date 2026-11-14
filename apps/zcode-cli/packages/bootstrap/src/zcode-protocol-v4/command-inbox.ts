/**
 * ============================================================================
 * zcode-protocol-v4/command-inbox.ts —— V4 命令 admission 的唯一入口
 * ============================================================================
 *
 * 【定位】gateway 把每条 V4 command 交给本 inbox；inbox 负责：
 *   - 幂等查询：同 commandId 再来一次必须返回同一终态，不能重复执行；
 *   - CAS：校验 session 是否存在、baseRevision / baseLogEpoch 是否仍然匹配；
 *   - 串行 admission：同一 session 的命令按真实到达顺序分配 admissionSeq；
 *   - 冷会话准备：在持有 session admission 时调用宿主钩子把持久会话拉起来；
 *   - 终态回收：execute 完成后由 gateway 调用 settle，释放 session gate。
 *
 * 【三类事实严格分离】
 *   - inFlight：已接纳、正在执行，带一个 final Promise；同 key 的重试共享它；
 *   - liveInputs：已排队/已 guide、尚未进入 transcript 的输入；永远 pinned；
 *   - settled：已终结的命令，进入每 session 上限
 *     PROTOCOL_V4_LIMITS.idempotencyTablePerSession 的 LRU。
 *   只有 settled 可以被 LRU 淘汰；in-flight / live input 被淘汰会导致
 *   "query 返回 unknown → 客户端重试 → 同一条命令执行两次"。
 *
 * 【锁序】key gate → per-session admission gate。
 *   - key gate 只包住"查重 + 决策"，避免同 commandId 并发进入；
 *   - session gate 持有到 settle 才释放，因此同 session 的不同 command 也串行；
 *   - 反过来（先 session 后 key）会让一条长命令堵住其它 session 的查重。
 *
 * 【durable 兜底】内存表未命中时，按固定顺序查
 *   transcript → timeline → child → discarded 四类持久事实；
 *   顺序本身就是"事实优先级"，实现必须精确匹配 sourceCommandId。
 *
 * 【studio 分工】gateway 负责 READY 水位、订阅与命令转交；
 *   业务裁决、队列位置与终态都在本文件与宿主回调里完成。
 * ============================================================================
 */
import type {
  CommandAck,
  CommandEnvelope,
  CommandKey,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  PROTOCOL_V4_LIMITS,
  ROW_TARGETING_COMMANDS,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";

/** guard 裁决结果：拒绝（撤 optimistic）或 noop（晚到者静默收口，§6.3）。 */
// 四个分支的 ACK 映射口径：
// - allow：继续走 execute；stale：epoch/revision/行目标已过期，客户端应重订阅后再试；
// - reject：schema/业务 guard 不允许，撤掉本地 optimistic overlay；
// - noop：命令合法但事实已在目标状态，需要 remember（晚到重试要读到同一结论）。
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

export interface CommandInboxHost {
  /** 幂等查询完成后、持有 session admission 时准备冷会话，不另设接受队列。 */
  prepareDecision?(envelope: CommandEnvelope): Promise<void>;

  /** 会话当前 revision；未知会话返回 null（createSession 用 null sessionId）。 */
  getRevision(sessionId: string): number | null;
  /** 会话当前投影代际；CAS 必须先校验 epoch，再校验 revision。 */
  getLogEpoch(sessionId: string): string | null;
  /** row-targeting command 的 entity/action 同源 resolver 裁决。 */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** 业务 guard（product-protocol guard id）。缺省一律放行。 */
  guard?(envelope: CommandEnvelope): GuardDecision;
  /** 以下回调顺序就是持久化事实优先级；实现必须精确匹配 sourceCommandId。 */
  lookupTranscriptCommand?: PersistentLookup;
  lookupTimelineCommand?: PersistentLookup;
  lookupChildCommand?: PersistentLookup;
  lookupDiscardedCommand?: PersistentLookup;
  now?(): number;
}

interface InFlightEntry {
  ack: CommandAck;
  final: Promise<CommandAck>;
  resolveFinal: (ack: CommandAck) => void;
}

type CommandFinal = Pick<
  CommandAck,
  "status" | "reasonCode" | "message" | "result" | "memoryEnabled"
>;

interface LiveInputEntry {
  ack: CommandAck;
  intent: ConversationInputIntent;
}

// handle 的两种出口：ack = 本次不执行（重复/拒绝/过期/noop，ACK 已终态）；
// execute = 已被接纳，调用方必须执行并把终态交回 settle（否则 session gate 永不释放）。
export type CommandInboxOutcome =
  | { kind: "ack"; ack: CommandAck }
  | {
      kind: "execute";
      envelope: CommandEnvelope;
      ack: CommandAck;
      /** CLI 串行 admission 分配的权威顺序；用它构造 ConversationInputIntent。 */
      admissionSeq: number;
      admittedAt: number;
      queueItemId: string;
      /** 执行完成后回填终态。必须调用一次，用于释放 per-session admission gate。 */
      settle: (final: CommandFinal) => void;
    };

// createSession 与 null sessionId query 归全局桶。
const GLOBAL_BUCKET = "@global";

/**
 * 由 commandId 派生队列项 id（`queue_<commandId>`）。
 *
 * 口径：queueItemId 必须是 commandId 的确定性函数——客户端重试同一命令时，
 * runtime queue / session_input ledger 里仍应命中同一条 item，而不是新建第二条。
 * 副作用：无；调用方负责把它写进 durable admission 与 executeCommand 的 admission 参数。
 */
export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

type GateRelease = () => void;

/**
 * FIFO async gate。返回显式 release 是因为 per-session gate 要跨过 gateway execute，
 * 直到 settle 才释放；普通 with-lock 会在 handle 返回时过早放行下一条 admission。
 */
// 同一 key 的 release 本身也幂等：重复调用只放行一次，避免 finally 与显式释放双触发
// 把 tail 提前清空、放大并发。tail 只有在仍是当前尾巴时才删除，防止误删后继链。
class AsyncGateRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<GateRelease> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

/**
 * 单进程内的命令 admission 账本（不持久化，重启后靠四类 durable 事实回源）。
 *
 * 三张表严格分离（不变量 15）：inFlight（执行中，带共享 final Promise）、
 * liveInputs（已排队/guide 但未进 transcript，永远 pin）、settled（终态，按 session
 * 上限 512 条 LRU）。只有 settled 可被淘汰；淘汰 in-flight/live 会让 query 变 unknown，
 * 客户端重试即重复执行。
 *
 * 并发口径（不变量 14）：key gate 只包"查重 + 决策"；per-session admission gate
 * 一直持有到 settle，因此同 session 的不同 commandId 也按真实 admission 顺序串行。
 * 本类不产生任何 durable 写入 / 事件广播：副作用全部在 host 回调与 gateway 执行面。
 */
export class CommandInbox {
  private readonly inFlight = new Map<string, Map<string, InFlightEntry>>();
  private readonly liveInputs = new Map<string, Map<string, LiveInputEntry>>();
  private readonly settled = new Map<string, Map<string, CommandAck>>();
  private readonly admissionSeq = new Map<string, number>();
  private readonly keyGates = new AsyncGateRegistry();
  private readonly sessionGates = new AsyncGateRegistry();

  constructor(private readonly host: CommandInboxHost) {}

  /**
   * 处理一条原始命令。
   *
   * 流程（任何一步失败都不能让同 key 后续请求看到不一致状态）：
   *   1) schema 校验；失败直接 rejected（不回写 settled，因为命令身份可能无效）；
   *   2) 拿 key gate，查 in-flight → live → settled → durable 四类事实；
   *   3) 命中即返回 duplicate/final ack（failed 是终态，不被 duplicate 覆盖）；
   *   4) 拿 session gate，**再查一次**（等待期间可能有新事实落库）；
   *   5) prepareDecision（冷会话可能在此被拉起）→ decide（CAS/guard/row target）；
   *   6) 拒绝/过期/noop 直接 ack；允许则分配 admissionSeq、写入 inFlight、
   *      提前释放 key gate，返回 execute + settle 回调。
   *
   * 为什么 execute 路径要提前释放 key gate：同 commandId 的重复请求应在
   * final Promise 上等待，而不是继续占着 key 锁；session gate 仍持有到 settle。
   */
  async handle(raw: unknown): Promise<CommandInboxOutcome> {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) {
      return this.ackOnly({
        commandId: this.extractCommandId(raw),
        status: "rejected",
        reasonCode: "proto.invalidPayload",
        message: parsed.error.message,
        revisionAtDecision: 0,
      });
    }
    const envelope = parsed.envelope;
    const key = { sessionId: envelope.sessionId, commandId: envelope.commandId };
    const bucketKey = this.bucketKey(envelope.sessionId);
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));

    try {
      const pinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
      if (pinned) return this.ackOnly(this.retryAck(await pinned.final));
      const existing = await this.lookupExact(key);
      if (existing) return this.ackOnly(this.retryAck(existing));

      // 固定锁序：key gate → per-session admission gate。session gate 持有到 settle，
      // 因而同 session 不同 commandId 以 CLI 实际执行 admission 的顺序串行。
      const releaseSession = await this.sessionGates.acquire(bucketKey);
      try {
        // 等待 session gate 期间，上一条命令可能增量写入了本 key 的持久化事实。
        const afterWaitPinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
        if (afterWaitPinned) {
          releaseSession();
          return this.ackOnly(this.retryAck(await afterWaitPinned.final));
        }
        const afterWait = await this.lookupExact(key);
        if (afterWait) {
          releaseSession();
          return this.ackOnly(this.retryAck(afterWait));
        }

        await this.host.prepareDecision?.(envelope);
        const decision = this.decide(envelope);
        if (decision.kind === "ack") {
          if (decision.remember) this.rememberSettled(bucketKey, envelope.commandId, decision.ack);
          releaseSession();
          return this.ackOnly(decision.ack);
        }

        const nextAdmissionSeq = (this.admissionSeq.get(bucketKey) ?? 0) + 1;
        const admittedAt = this.host.now?.() ?? Date.now();
        this.admissionSeq.set(bucketKey, nextAdmissionSeq);
        let resolveFinal!: (ack: CommandAck) => void;
        const final = new Promise<CommandAck>((resolve) => {
          resolveFinal = resolve;
        });
        const entry: InFlightEntry = { ack: decision.ack, final, resolveFinal };
        this.mapFor(this.inFlight, bucketKey).set(envelope.commandId, entry);

        // 旧单表 LRU 会在 >512 条 churn 时淘汰仍在执行/队列里的命令，随后
        // query 返回 unknown、重试再次执行。新命令先 pin，再释放 key gate。
        releaseKey();
        let settled = false;
        return {
          kind: "execute",
          envelope,
          ack: decision.ack,
          admissionSeq: nextAdmissionSeq,
          admittedAt,
          queueItemId: queueItemIdForCommand(envelope.commandId),
          settle: (final) => {
            if (settled) return;
            settled = true;
            const live = this.liveInputs.get(bucketKey)?.get(envelope.commandId);
            const ack = {
              ...decision.ack,
              ...final,
            };
            this.inFlight.get(bucketKey)?.delete(envelope.commandId);
            if (live) {
              live.ack = ack;
            } else {
              this.rememberSettled(bucketKey, envelope.commandId, ack);
            }
            // 在途 duplicate 过去直接拿 admission ACK，fork/create 尚无 child
            // result 时就返回，ACK 丢失重试会导航失败。所有同 key 请求必须共享这一个
            // final promise，并在释放 session FIFO 前看到同一终态。
            entry.resolveFinal(ack);
            releaseSession();
          },
        };
      } catch (error) {
        releaseSession();
        throw error;
      }
    } catch (error) {
      return this.ackOnly(this.queryUnavailableAck(key, error));
    } finally {
      // execute 路径已在 pin 后提前 release；release 幂等，其他路径在这里释放。
      releaseKey();
    }
  }

  /**
   * 批量查询命令终态（供 ACK 丢失后的 commands/query 使用）。
   *
   * 1..64 的批量上限由上层 schema 校验；这里并行查询并保持 Promise.all 的
   * 输入顺序。单条查询失败不会让整批失败，而是该条返回 failed ack。
   */
  async query(
    keys: readonly CommandKey[],
  ): Promise<Array<{ key: CommandKey; result: CommandAck | "unknown" }>> {
    return Promise.all(keys.map((key) => this.queryOne(key)));
  }

  /**
   * 把 queue/guide 输入的完整 intent pin 到 liveInputs。
   *
   * ack 取值顺序：显式传入 > 同 commandId 的 inFlight ack > 合成 accepted。
   * 同时从 settled 中删除同 id：该输入已经进入"未消费"状态，不能再被当成
   * 已完成命令的旧终态返回。
   */
  pinLiveInput(sessionId: string, intent: ConversationInputIntent, ack?: CommandAck): void {
    const bucketKey = this.bucketKey(sessionId);
    const inFlightAck = this.inFlight.get(bucketKey)?.get(intent.sourceCommandId)?.ack;
    this.mapFor(this.liveInputs, bucketKey).set(intent.sourceCommandId, {
      intent,
      ack: ack ??
        inFlightAck ?? {
          commandId: intent.sourceCommandId,
          status: "accepted",
          revisionAtDecision: 0,
        },
    });
    this.settled.get(bucketKey)?.delete(intent.sourceCommandId);
  }

  /**
   * 解除 live pin（进入 transcript / 取消 / 失败）。
   *
   * 有终态 ack 时转入 settled；没有终态时只用 live 里保存的 ack。
   * 这一步之后该命令才允许被 LRU 淘汰。
   */
  releaseLiveInput(key: CommandKey, finalAck?: CommandAck): void {
    const bucketKey = this.bucketKey(key.sessionId);
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    this.liveInputs.get(bucketKey)?.delete(key.commandId);
    if (finalAck ?? live?.ack) {
      this.rememberSettled(bucketKey, key.commandId, finalAck ?? live!.ack);
    }
  }

  /**
   * 常驻池回收前置条件：该 session 是否还有"未落盘的活事实"。
   *
   * 输入：sessionId（null 会话也按全局桶统计）；输出：in-flight 或 live input 是否存在。
   * 副作用：无，只读 size。返回 true 时调用方禁止 clearSession / 拆 runtime，
   * 否则未执行完的命令与排队输入会丢失（不变量 15，settled 不算 pin）。
   */
  // 常驻池回收保护：只要还有 in-flight 或 live input，就不能 clearSession。
  hasPinnedSessionState(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    return (
      (this.inFlight.get(bucketKey)?.size ?? 0) > 0 ||
      (this.liveInputs.get(bucketKey)?.size ?? 0) > 0
    );
  }

  /**
   * Resident 去激活后回到 CLI 冷启动状态。
   *
   * in-flight / live input 是"未落盘的活事实"，清掉会丢命令；因此有它们时
   * 直接返回 false，调用方必须把 hasPinnedSessionState 作为回收前置条件。
   * settled 只是幂等缓存，清掉后仍可从 transcript/timeline 回源。
   */
  clearSession(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    if (this.hasPinnedSessionState(sessionId)) return false;
    this.inFlight.delete(bucketKey);
    this.liveInputs.delete(bucketKey);
    this.settled.delete(bucketKey);
    this.admissionSeq.delete(bucketKey);
    return true;
  }

  // 单条查询也走 key gate：避免与同 commandId 的 handle 并发读到半更新状态。
  private async queryOne(
    key: CommandKey,
  ): Promise<{ key: CommandKey; result: CommandAck | "unknown" }> {
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));
    try {
      return { key, result: (await this.lookupExact(key)) ?? "unknown" };
    } catch (error) {
      return { key, result: this.queryUnavailableAck(key, error) };
    } finally {
      releaseKey();
    }
  }

  /**
   * 按优先级查"这条命令的终态"：
   *   in-flight final Promise → live ack → settled LRU → 四类 durable 事实。
   *
   * in-flight 必须 await final：同 commandId 的重复请求要看到同一个终态，
   * 而不是提前拿到 accepted。settled 命中时 touch 一次，维持 LRU 热度。
   */
  private async lookupExact(key: CommandKey): Promise<CommandAck | null> {
    const bucketKey = this.bucketKey(key.sessionId);
    const inflight = this.inFlight.get(bucketKey)?.get(key.commandId);
    if (inflight) return await inflight.final;
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    if (live) return live.ack;
    const settled = this.settled.get(bucketKey)?.get(key.commandId);
    if (settled) {
      this.touchSettled(bucketKey, key.commandId, settled);
      return settled;
    }

    for (const lookup of [
      this.host.lookupTranscriptCommand,
      this.host.lookupTimelineCommand,
      this.host.lookupChildCommand,
      this.host.lookupDiscardedCommand,
    ]) {
      const found = await lookup?.(key);
      if (found) return found;
    }
    return null;
  }

  /**
   * 决策：session 存在性 → baseRevision → baseLogEpoch（仅 row-targeting）
   * → row target resolver → 业务 guard。
   *
   * 顺序有语义：先看 epoch 再看 revision，因为 rewind/fork 后 epoch 变化意味着
   * 整个 row 空间已换代，即使 revision 数值碰巧相同也不能接受旧命令。
   *
   * 返回 remember=false 的拒绝/过期不应写 settled：它们不是"已执行终态"，
   * 客户端应修正参数后重试。noop 需要 remember，因为晚到者要能查到同一结论。
   */
  private decide(
    envelope: CommandEnvelope,
  ): { kind: "execute"; ack: CommandAck } | { kind: "ack"; ack: CommandAck; remember: boolean } {
    const revision = envelope.sessionId === null ? 0 : this.host.getRevision(envelope.sessionId);
    if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.sessionNotFound",
          revisionAtDecision: 0,
        },
      };
    }

    if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
      if (envelope.baseRevision === undefined) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "rejected",
            reasonCode: "proto.missingBaseRevision",
            revisionAtDecision: revision,
          },
        };
      }
      const logEpoch =
        envelope.sessionId === null ? null : this.host.getLogEpoch(envelope.sessionId);
      if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleLogEpoch",
            revisionAtDecision: revision,
          },
        };
      }
      if (envelope.baseRevision !== revision) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleRevision",
            revisionAtDecision: revision,
          },
        };
      }
    }

    const targetDecision = this.host.validateRowTarget?.(envelope);
    if (targetDecision?.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (targetDecision?.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }

    const decision = this.host.guard?.(envelope) ?? {
      verdict: "allow" as const,
    };
    if (decision.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "noop") {
      return {
        kind: "ack",
        remember: true,
        ack: {
          commandId: envelope.commandId,
          status: "noop",
          reasonCode: decision.reasonCode,
          revisionAtDecision: revision,
          result: decision.result,
        },
      };
    }
    return {
      kind: "execute",
      ack: {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: revision,
      },
    };
  }

  /**
   * 重复请求的状态改写。
   *
   * failed 是终态事实，保持原样；其余（accepted/duplicate/noop…）统一标成
   * duplicate，让客户端知道"这次没有新执行"。不能把 failed 改成 duplicate，
   * 否则 UI 会误判为可再次接受。
   */
  private retryAck(ack: CommandAck): CommandAck {
    // failed 是终态事实，不得被 duplicate 状态覆盖后让 UI/服务误判为可接受。
    return ack.status === "failed" ? ack : { ...ack, status: "duplicate" };
  }

  /**
   * 查询链路自身异常时的降级 ACK：返回 failed + fault.command.queryUnavailable。
   *
   * 口径：不是把异常吞成 unknown（unknown 会诱导客户端静默重发），而是显式失败；
   * revisionAtDecision 取当前 revision（取不到记 0）。副作用无——不写 settled，
   * 因此下一次查询仍可重新尝试持久事实。
   */
  private queryUnavailableAck(key: CommandKey, _error: unknown): CommandAck {
    return {
      commandId: key.commandId,
      status: "failed",
      reasonCode: "fault.command.queryUnavailable",
      revisionAtDecision: key.sessionId === null ? 0 : (this.host.getRevision(key.sessionId) ?? 0),
    };
  }

  // 统一构造"本次不执行"的出口；调用方必须已经释放 session gate（若持有）。
  private ackOnly(ack: CommandAck): CommandInboxOutcome {
    return { kind: "ack", ack };
  }

  // createSession 与 null sessionId 的 query 归全局桶；其余按 session 分桶。
  private bucketKey(sessionId: string | null): string {
    return sessionId ?? GLOBAL_BUCKET;
  }

  // key gate 的键：session 桶 + commandId；用 \0 拼接避免与普通字符串撞键。
  private keyGateKey(key: CommandKey): string {
    return `${this.bucketKey(key.sessionId)}\0${key.commandId}`;
  }

  // 懒建 per-session 分桶；createSession / null sessionId 共用全局桶，不按 session 分。
  private mapFor<T>(store: Map<string, Map<string, T>>, bucketKey: string): Map<string, T> {
    let bucket = store.get(bucketKey);
    if (!bucket) {
      bucket = new Map();
      store.set(bucketKey, bucket);
    }
    return bucket;
  }

  // 命中 settled 时刷新 LRU 热度：先删后插，Map 迭代顺序即"最近使用"顺序。
  private touchSettled(bucketKey: string, commandId: string, ack: CommandAck): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, ack);
  }

  /**
   * 写入 settled 并维持 per-session LRU。
   *
   * 先 delete 再 set，保证"最近使用"顺序正确；超限时从最旧（Map 迭代头部）
   * 开始淘汰。这里只操作 settled，绝不能碰 in-flight / liveInputs。
   */
  private rememberSettled(bucketKey: string, commandId: string, ack: CommandAck): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, ack);
    while (bucket.size > PROTOCOL_V4_LIMITS.idempotencyTablePerSession) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  // schema 校验失败时仍尽量回填 commandId，让客户端能把 rejected ACK 与本地
  // optimistic overlay 对齐；拿不到就返回空串（不做任何猜测或重写）。
  private extractCommandId(raw: unknown): string {
    if (typeof raw === "object" && raw !== null && "commandId" in raw) {
      const id = (raw as { commandId: unknown }).commandId;
      if (typeof id === "string") return id;
    }
    return "";
  }
}
