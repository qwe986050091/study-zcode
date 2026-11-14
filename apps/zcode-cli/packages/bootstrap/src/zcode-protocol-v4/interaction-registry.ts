// v4 交互应答登记表（原生化，resolveInteraction）。
//
// 背景：conversation-product-protocol 的权限/AskUserQuestion 是「反向请求」——CLI 经
// context.requestClient 把请求推给客户端并 await 应答。旧客户端用 RPC RESPONSE 应答
// （resolveClientRequest 按 server-N id 收口）。v4 客户端不回 RPC response，而是发一条
// 前向 `resolveInteraction` COMMAND（先到先得，晚到 noop）。
//
// 本登记表是两条应答路径的汇合点：interaction-broker 发起反向请求时按业务 requestId
// （= v4 的 interactionId）注册一个 deferred，并让 requestClient 与该 deferred 竞态；
// v4 命令面（handlers/interaction-background.ts）拿到 resolveInteraction 后经本表
// resolve 对应 deferred，broker 侧的 Promise.race 立即用 v4 应答收口、abort 掉悬空的
// 反向 RPC。
//
// 分层：本表只做「按 id 找到 deferred 并投递应答」，不懂 permission/userInput 的 schema
// 差异——broker 注册时自带各自的 resolve 回调（闭包已知 kind），本表对应答体透明。
// 归属：本文件是 v4 原生基础设施（放 v4 目录），旧目录（broker/server）import 本文件
// 合法（依赖方向只允许 旧目录 → v4 目录）。
import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";

export type V4InteractionAnswer = {
  optionId?: string;
  freeText?: string;
  // （elicitation 回执收敛，与 shared command.ts resolveInteraction
  // answer 同步）：action 存在时 broker 按 accept/decline/cancel 精确映射，
  // content 直传旧 userInput response 的 content 语义（多题答案/注解无损）。
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export const ASK_USER_QUESTION_HIDDEN_GRACE_MS = 60_000;
export const ASK_USER_QUESTION_AUTO_RESOLUTION_MS = 300_000;
export interface V4InteractionRegistryOptions {
  hiddenGraceMs?: number;
  autoResolutionMs?: number;
  now?: () => number;
}

export function resolveV4InteractionRegistryOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): V4InteractionRegistryOptions | undefined {
  if (env.ZCODE_ENV !== "test") return undefined;
  const rawScale = env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim();
  if (!rawScale) return undefined;
  const scale = Number(rawScale);
  if (!Number.isFinite(scale) || scale < 1 || scale > 1_000) {
    throw new Error(`${ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV} must be between 1 and 1000`);
  }
  return {
    hiddenGraceMs: Math.max(1, Math.round(ASK_USER_QUESTION_HIDDEN_GRACE_MS / scale)),
    autoResolutionMs: Math.max(1, Math.round(ASK_USER_QUESTION_AUTO_RESOLUTION_MS / scale)),
  };
}

export type V4InteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface V4InteractionRegistrationOptions {
  sessionId: string;
  kind: "askUserQuestion" | "other";
  fullAccess?: () => Promise<void>;
  initialAutoResolution?: V4InteractionAutoResolution;
  onAutoResolutionUpdated?: (state: V4InteractionAutoResolution) => void | Promise<void>;
}

interface RegisteredInteraction {
  /** broker 侧回调：把 v4 answer 映射成对应 schema 的应答并 resolve 反向请求。 */
  resolve: (answer: V4InteractionAnswer) => void;
  options?: V4InteractionRegistrationOptions;
  autoResolution?: V4InteractionAutoResolution;
  /**
   * AskUserQuestion 注册时固化的计时资格。关闭后永久置 false，重新开启不会追溯旧问题。
   */
  fullAccessPending?: Promise<void>;
  autoResolutionEligible: boolean;
  visibleTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  token: symbol;
}

// 生命周期与不变量：
// - pendingInteractions 是纯内存表，不做 durable 写入；进程重启后由 runtime 重新发起反向请求。
// - 先到者生效：resolve 命中即先删除再投递，第二个应答按“未命中”幂等收口，不覆盖首个结果。
// - 去重口径：interactionId + 注册 token；同 id 重注册替换回调但保留 autoResolution 状态，
//   不重复进 per-session 队列，因此不会出现同一问题被计时两次。
// - 清理：broker 的 finally 注销、resolve 命中、权限副作用完成、TTL 型 auto-resolution 到期
//   都会 remove；remove 负责清 timer、出队并在队首变化时激活下一个问题。
// - 边界：本表只“按 id 找到 deferred 并投递应答”，不判断 permission/userInput schema；
//   也不产生 projection，projection 由 resolver 之后的业务事件驱动。
// - ACK 与 projection：resolve 返回 boolean 仅表示“是否命中等待者”，命令面据此决定
//   accepted/alreadyResolved；真正的界面收口仍要等 projection 的 pendingInteractions 变化。
export class V4InteractionRegistry {
  private readonly pending = new Map<string, RegisteredInteraction>();
  private readonly queuesBySession = new Map<string, string[]>();
  private readonly hiddenGraceMs: number;
  private readonly autoResolutionMs: number;
  private readonly now: () => number;
  private askUserQuestionAutoResolutionEnabled = true;
  private interactionPreferenceCommandApplied = false;

  constructor(options: V4InteractionRegistryOptions = {}) {
    this.hiddenGraceMs = options.hiddenGraceMs ?? ASK_USER_QUESTION_HIDDEN_GRACE_MS;
    this.autoResolutionMs = options.autoResolutionMs ?? ASK_USER_QUESTION_AUTO_RESOLUTION_MS;
    this.now = options.now ?? Date.now;
  }

  // 注册等待中的交互（内存注册表，无 durable 副作用）。
  // 返回注销闭包：broker 在 finally 调用，无论由 v4 应答还是旧 RPC response 收口都清理，
  // 防止 pending 与 timer 泄漏；注销是 token 安全的，过期回调不会误删新注册项。
  // 输入口径：interactionId 必须全局唯一（= 业务 requestId）；options 提供 sessionId、
  // kind 与 fullAccess 能力，用于按 session 排队与自动结束计时。
  // 副作用：写 pending；首次注册时按 session 入队；可能启动 auto-resolution timer。
  /**
   * broker 发起反向请求时注册。返回注销函数（broker 在 finally 里调用，无论走 v4 还是
   * RPC-response 收口都清理，防泄漏）。同一 interactionId 重注册（reannounce 重发）覆盖
   * 旧回调——旧的反向请求已被 broker 的 race/abort 作废，指向最新一次等待。
   */
  register(
    interactionId: string,
    resolve: (answer: V4InteractionAnswer) => void,
    options?: V4InteractionRegistrationOptions,
  ): () => void {
    const previous = this.pending.get(interactionId);
    const token = Symbol(interactionId);
    if (previous) {
      this.clearTimers(previous);
    }
    // eligibility 在注册瞬间固化：之后全局开关变化不会追溯已存在的问题。
    const entry: RegisteredInteraction = {
      resolve,
      options,
      token,
      autoResolutionEligible:
        previous?.autoResolutionEligible ??
        (options?.kind === "askUserQuestion" ? this.askUserQuestionAutoResolutionEnabled : false),
      ...(previous?.autoResolution || options?.initialAutoResolution
        ? { autoResolution: previous?.autoResolution ?? options?.initialAutoResolution }
        : {}),
    };
    this.pending.set(interactionId, entry);
    // 只有首次注册才入队：重注册沿用原队列位置，否则同一 id 会被重复激活。
    if (options && !previous) {
      const queue = this.queuesBySession.get(options.sessionId) ?? [];
      queue.push(interactionId);
      this.queuesBySession.set(options.sessionId, queue);
    }
    if (options) {
      if (entry.autoResolution) {
        if (options.kind === "askUserQuestion" && !entry.autoResolutionEligible) {
          void this.convertToSnoozed(entry);
        } else {
          this.resumeAutoResolution(interactionId, entry);
        }
      } else {
        this.activateHead(options.sessionId);
      }
    }
    // 注销按 token 校验归属：同 id 已被后来者替换时不删除新的等待。
    return () => {
      const current = this.pending.get(interactionId);
      if (!current || current.token !== token) return;
      this.remove(interactionId, current);
    };
  }

  // 输入：interactionId 与已由命令面校验过的 answer（不含 schema 判断）。
  // 输出：true = 本次应答生效并已交付 broker；false = 未命中（已应答/已注销/未知 id）。
  // 副作用：从 pending 移除该交互并清 timer，deferred 由 broker 侧自行收口。
  // 幂等边界：多端并发时只有首个调用拿到 true，后续按 alreadyResolved 成功收口。
  /**
   * v4 resolveInteraction 命令收口：投递应答给等待中的 broker deferred。
   * 返回是否命中——未命中（已被应答/已注销/未知 id）时命令面按幂等成功收口
   * （proto.alreadyResolved 语义，多端先到先得，晚到应答无害）。
   */
  resolve(interactionId: string, answer: V4InteractionAnswer): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry || entry.fullAccessPending) return false;
    // 先删再 resolve：resolve 可能同步触发 broker finally 的注销，避免重入下重复投递。
    this.remove(interactionId, entry);
    entry.resolve(answer);
    return true;
  }

  // 输入：交互 id + 调用方 sessionId（必须与注册时一致，否则视为越权而抛错）。
  // 输出：true = 权限已生效且交互已用 allowOnce 收口；false = 交互已不在（被并发应答）。
  // 失败语义：fullAccess 副作用抛错时保留 pending 与 fullAccessPending 令牌，客户端可重试；
  // 只有副作用成功后才 remove + resolve，因此不会出现“已扣权限但会话仍阻塞”。
  /** 带权限副作用的应答只对已登记的同 session 能力开放；失败保留请求供重试。 */
  async resolveFullAccess(interactionId: string, sessionId: string): Promise<boolean> {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    if (entry.options?.sessionId !== sessionId || !entry.options.fullAccess) {
      throw new Error("Full access is not supported for this interaction");
    }
    if (entry.fullAccessPending) {
      await entry.fullAccessPending;
      return true;
    }
    const operation = entry.options.fullAccess();
    entry.fullAccessPending = operation;
    try {
      await operation;
      if (this.pending.get(interactionId) !== entry) return false;
      this.remove(interactionId, entry);
      entry.resolve({ optionId: "allowOnce" });
      return true;
    } finally {
      delete entry.fullAccessPending;
    }
  }

  // 输入：目标交互 id；输出：true = 本次把倒计时转为 snoozed，false = 不适用或已 snoozed。
  // 副作用：清 timer 并把 snoozed 状态回写给 broker（可能是 durable 偏好持久化的入口）。
  // snoozed 是终态：同 id 再次 snooze 或自动到期逻辑都不会再触发。
  /** 首次有效操作永久暂停当前 AskUserQuestion 的自动结束；重复/迟到调用为 noop。 */
  async snoozeAutoResolution(interactionId: string): Promise<boolean> {
    // 非 AskUserQuestion、从未启动计时或已 snoozed 的交互不进入转换。
    const entry = this.pending.get(interactionId);
    if (
      !entry?.options ||
      entry.options.kind !== "askUserQuestion" ||
      !entry.autoResolution ||
      entry.autoResolution.state === "snoozed"
    ) {
      return false;
    }
    await this.convertToSnoozed(entry);
    return true;
  }

  // 输入：用户显式选择的开关值；输出：本次被强制转 snoozed 的交互数量。
  // 顺序：先记“命令已应用”，再改 gate；关闭路径 await 全部 snoozed 回写后才返回，
  // 保证 ACK 到达时持久化已完成（否则重开客户端会看到仍在倒计时的旧问题）。
  // 幂等：重复调用安全，只是可能返回 0；开启操作从不清除既有 snoozed。
  /**
   * 更新全局 gate。关闭会同步取消所有 timer，并在 ACK 前等待活动倒计时持久化为 snoozed；
   * 重新开启只允许之后新注册的问题计时。
   */
  async setAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    this.interactionPreferenceCommandApplied = true;
    return this.applyAskUserQuestionAutoResolutionEnabled(enabled);
  }

  // 输入：握手带来的初值；输出：实际被 snoozed 的数量（迟到握手固定返回 0）。
  // 副作用：仅在“从未收到显式命令”时改 gate 与 timer；用于兼容旧 Host 与首个 runtime。
  // 优先级：显式命令 > 启动握手，二者不可逆序覆盖。
  /**
   * session 启动握手只负责旧 Host 兼容和首个 runtime 的初值。显式 workspace 命令一旦
   * 到达，迟到的启动握手不得覆盖更晚的设置提交。
   */
  async initializeAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    if (this.interactionPreferenceCommandApplied) return 0;
    return this.applyAskUserQuestionAutoResolutionEnabled(enabled);
  }

  // 实际生效点：关闭时把每个活动 AskUserQuestion 永久置为不合格并转 snoozed；
  // eligibility=false 是不可逆的，重新开启后只影响新注册的问题。
  private async applyAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    this.askUserQuestionAutoResolutionEnabled = enabled;
    if (enabled) return 0;

    const persistence: Promise<void>[] = [];
    let snoozedInteractionCount = 0;
    for (const entry of this.pending.values()) {
      if (entry.options?.kind !== "askUserQuestion") continue;
      entry.autoResolutionEligible = false;
      if (entry.autoResolution && entry.autoResolution.state !== "snoozed") {
        snoozedInteractionCount += 1;
        persistence.push(this.convertToSnoozed(entry));
      }
    }
    await Promise.all(persistence);
    return snoozedInteractionCount;
  }

  // 只读探针：该 id 是否仍在等待应答；不触发任何 timer 或清理。
  has(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  // 线性扫描 pending；返回 true 时调用方必须拒绝去激活该 session。
  // 这是“应答不能落空”的守卫，而不是性能热点，故不做额外索引。
  /** Resident 回收判定：该 session 是否仍有等待用户应答的交互（去激活会让应答落空）。 */
  hasPendingForSession(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.options?.sessionId === sessionId) return true;
    }
    return false;
  }

  // 只为“队首且无既有 autoResolution”的 AskUserQuestion 启动计时：同一 session 同一
  // 时刻只允许一个问题在倒计时，否则多个 deadline 会互相掩盖用户的实际操作。
  private activateHead(sessionId: string): void {
    const queue = this.queuesBySession.get(sessionId);
    const interactionId = queue?.[0];
    if (!interactionId) return;
    const entry = this.pending.get(interactionId);
    if (
      !entry?.options ||
      entry.options.kind !== "askUserQuestion" ||
      !entry.autoResolutionEligible ||
      entry.autoResolution
    ) {
      return;
    }
    const startedAt = this.now();
    const visibleAt = startedAt + this.hiddenGraceMs;
    const deadlineAt = startedAt + this.autoResolutionMs;
    entry.autoResolution = {
      state: "hiddenGrace",
      startedAt,
      visibleAt,
      deadlineAt,
    };
    this.notifyAutoResolution(entry);
    this.scheduleActiveAutoResolution(interactionId, entry);
  }

  // 重注册（reannounce）后的恢复：仍非队首则不启动；已 snoozed 只回写状态；
  // 已过 deadline 用 microtask 投递 accept，避免在注册调用栈内同步 resolve 造成重入。
  private resumeAutoResolution(interactionId: string, entry: RegisteredInteraction): void {
    const sessionId = entry.options?.sessionId;
    if (!sessionId || this.queuesBySession.get(sessionId)?.[0] !== interactionId) {
      return;
    }
    const autoResolution = entry.autoResolution;
    if (!autoResolution) return;
    if (autoResolution.state === "snoozed") {
      this.notifyAutoResolution(entry);
      return;
    }
    const now = this.now();
    if (now >= autoResolution.deadlineAt) {
      queueMicrotask(() => {
        this.resolve(interactionId, {
          action: "accept",
          content: { answers: {} },
        });
      });
      return;
    }
    if (autoResolution.state === "hiddenGrace" && now >= autoResolution.visibleAt) {
      entry.autoResolution = {
        ...autoResolution,
        state: "visibleCountdown",
      };
    }
    this.notifyAutoResolution(entry);
    this.scheduleActiveAutoResolution(interactionId, entry);
  }

  // 两个 timer：visibleAt 只负责 hiddenGrace → visibleCountdown 的状态推进（不 resolve）；
  // deadlineAt 负责自动 accept 空答案。回调都先校验 entry 身份，防止已被替换的旧 timer
  // 误改新交互的状态。
  private scheduleActiveAutoResolution(interactionId: string, entry: RegisteredInteraction): void {
    const autoResolution = entry.autoResolution;
    if (!autoResolution || autoResolution.state === "snoozed") return;
    const now = this.now();
    if (autoResolution.state === "hiddenGrace") {
      entry.visibleTimer = setTimeout(
        () => {
          const current = this.pending.get(interactionId);
          if (current !== entry || current.autoResolution?.state !== "hiddenGrace") {
            return;
          }
          current.autoResolution = {
            state: "visibleCountdown",
            startedAt: autoResolution.startedAt,
            visibleAt: autoResolution.visibleAt,
            deadlineAt: autoResolution.deadlineAt,
          };
          this.notifyAutoResolution(current);
        },
        Math.max(0, autoResolution.visibleAt - now),
      );
    }
    entry.deadlineTimer = setTimeout(
      () => {
        this.resolve(interactionId, {
          action: "accept",
          content: { answers: {} },
        });
      },
      Math.max(0, autoResolution.deadlineAt - now),
    );
  }

  // 状态回写是 fire-and-forget：投影更新失败不影响内存计时，也不回滚交互。
  private notifyAutoResolution(entry: RegisteredInteraction): void {
    if (!entry.autoResolution) return;
    void entry.options?.onAutoResolutionUpdated?.(entry.autoResolution);
  }

  // snoozed 幂等：已 snoozed 直接返回；转换前先清 timer，再 await 状态持久化。
  // 保留 startedAt 便于 UI 展示“何时开始等待”，snoozedAt 记录暂停时刻。
  private async convertToSnoozed(entry: RegisteredInteraction): Promise<void> {
    const autoResolution = entry.autoResolution;
    if (!autoResolution || autoResolution.state === "snoozed") return;
    this.clearTimers(entry);
    entry.autoResolution = {
      state: "snoozed",
      startedAt: autoResolution.startedAt,
      snoozedAt: this.now(),
    };
    await entry.options?.onAutoResolutionUpdated?.(entry.autoResolution);
  }

  // 清 timer 后删除字段：后续 replace/remove 不会对已触发的句柄重复 clearTimeout。
  private clearTimers(entry: RegisteredInteraction): void {
    if (entry.visibleTimer) clearTimeout(entry.visibleTimer);
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    delete entry.visibleTimer;
    delete entry.deadlineTimer;
  }

  // 统一清理路径：删 pending、清 timer、按 session 出队；若出队后队列非空，
  // 立即激活新队首（可能是 AskUserQuestion 的下一题，需要重新开始倒计时）。
  // 队列清空即删除 session 键，避免长期驻留空数组。
  private remove(interactionId: string, entry: RegisteredInteraction): void {
    this.pending.delete(interactionId);
    this.clearTimers(entry);
    const sessionId = entry.options?.sessionId;
    if (!sessionId) return;
    const queue = this.queuesBySession.get(sessionId);
    if (!queue) return;
    const index = queue.indexOf(interactionId);
    // 可能已被此前的 remove 移出（例如 resolve 先删再触发 broker 注销），index=-1 时跳过。
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.queuesBySession.delete(sessionId);
      return;
    }
    this.activateHead(sessionId);
  }
}
