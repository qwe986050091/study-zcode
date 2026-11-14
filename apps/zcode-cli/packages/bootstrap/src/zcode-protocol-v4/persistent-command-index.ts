// commands/query 的 session-scoped lazy index。
// loader 每 session 只执行一次；新 transcript/marker/child/discarded 事实用 record 增量并入。
//
// 在整体幂等查询里的位置与优先级（由 CommandInbox.lookupExact 固定）：
//   in-flight final → live input ack → settled LRU → transcript → timeline → child
//   → discarded → unknown。
// 本索引只承载后四段（durable 事实）的精确匹配：键是客户端 commandId（= sourceCommandId），
// 不做前缀/模糊/时间窗匹配；命中即返回当时的 ACK 终态，未命中返回 null，由上层收敛为
// unknown 并要求用户确认后重发，绝不据此自动重放（stop/fork/输入都有副作用）。
// 各来源语义：transcript=消息 anchor 已落盘；timeline=timeline part 已落盘；
// child=child/fork 命令事实；discarded=session_input 的 discarded/cancelled 终态。
import type { CommandAck, CommandKey } from "@zcode/shared/zcode-protocol-v4";

export type PersistentCommandFactSource = "transcript" | "timeline" | "child" | "discarded";

export interface PersistentCommandIndexSeed {
  workspacePath: string;
  workspaceIdentity?: string;
  facts?: Partial<Record<PersistentCommandFactSource, readonly CommandAck[]>>;
}

export interface PersistentCommandIndexTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface PersistentCommandIndexHost {
  loadSession(sessionId: string): Promise<PersistentCommandIndexSeed | null>;
}

interface SessionIndex {
  workspaceKey: string;
  facts: Record<PersistentCommandFactSource, Map<string, CommandAck>>;
}

// 身份 key 统一口径：workspaceIdentity 去空白优先，否则退回 workspacePath；
// 用于防止同路径的本地/远端会话共享同一事实索引。
function workspaceKey(target: PersistentCommandIndexTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function emptyFacts(): SessionIndex["facts"] {
  return {
    transcript: new Map(),
    timeline: new Map(),
    child: new Map(),
    discarded: new Map(),
  };
}

// 内存索引：sessionId → 单飞 Promise（不是已解析结果），保证并发 query 只 load 一次。
// 索引本身不做 durable 写入；失效（invalidate）后下次 lookup 会重新读 store 重建。
// 只有“已解析且非 null”的 session 会被长期缓存；unknown/加载失败都不缓存。
export class PersistentCommandIndex {
  private readonly sessions = new Map<string, Promise<SessionIndex | null>>();

  constructor(private readonly host: PersistentCommandIndexHost) {}

  /**
   * 按单一来源查某条命令的持久终态。
   * 输入：来源 + {sessionId, commandId}；输出：精确命中的 ACK 或 null（未知）。
   * sessionId 为 null（createSession 的 global bucket）不在此索引内，直接返回 null，
   * 由 create-session-command-fact 单独闭合。首次查询会触发该 session 的 lazy load。
   * 无副作用；不因“查不到”而写入任何负缓存。
   */
  async lookup(source: PersistentCommandFactSource, key: CommandKey): Promise<CommandAck | null> {
    if (key.sessionId === null) return null;
    const index = await this.ensureSession(key.sessionId);
    return index?.facts[source].get(key.commandId) ?? null;
  }

  // 输入：target（用于 workspace 校验）、sessionId、来源与 ack；输出：无（Promise<void>）。
  // 失败：session 尚未能 load → querySessionNotFound；workspaceKey 与已加载 seed 不一致
  // → queryForeignWorkspace（宁可拒绝也不把事实写进错误 workspace 的索引）。
  // 副作用：仅合并进内存 Map（同 commandId 后写覆盖），不触发 durable 写入、不重扫。
  /**
   * transcript append / marker settle / child create / discarded ledger 写入后调用；不重扫全量。
   * expected target 与首次 load 得到的 workspaceKey 不一致时明确拒绝，防同路径远端串线。
   */
  async record(
    target: PersistentCommandIndexTarget,
    sessionId: string,
    source: PersistentCommandFactSource,
    ack: CommandAck,
  ): Promise<void> {
    const index = await this.ensureSession(sessionId);
    if (!index) throw new Error("fault.command.querySessionNotFound");
    if (index.workspaceKey !== workspaceKey(target)) {
      throw new Error("fault.command.queryForeignWorkspace");
    }
    index.facts[source].set(ack.commandId, ack);
  }

  // 丢弃该 session 的 lazy 索引；调用方在 transcript 原子 promotion 后使用，
  // 让后续 query 重新读取包含新事实的 store，而不是继续用旧 seed。
  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // 单飞加载 + 负结果不缓存：
  // - load 抛错 → 删除该 Promise，下一次 query 可在 store 恢复后重试；
  // - load 返回 null（session 尚不存在/未知）→ 也删除，避免“永久 unknown”挡住
  //   后续 transcript 落盘后应可见的事实。
  private ensureSession(sessionId: string): Promise<SessionIndex | null> {
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = this.host.loadSession(sessionId).then((seed) => {
        if (!seed) return null;
        const facts = emptyFacts();
        for (const source of ["transcript", "timeline", "child", "discarded"] as const) {
          for (const ack of seed.facts?.[source] ?? []) facts[source].set(ack.commandId, ack);
        }
        return { workspaceKey: workspaceKey(seed), facts };
      });
      // 读取失败不缓存 rejected Promise；下次 query 可在 store 恢复后重试。
      pending.catch(() => {
        if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
      });
      pending.then(
        (index) => {
          // unknown/session-not-found 不是事实，不能缓存；后续 transcript 落盘后必须可见。
          if (index === null && this.sessions.get(sessionId) === pending) {
            this.sessions.delete(sessionId);
          }
        },
        () => {},
      );
      this.sessions.set(sessionId, pending);
    }
    return pending;
  }
}
