/**
 * ============================================================================
 * zcode-protocol-v4/cold-session-resume.ts —— 冷会话恢复的单飞协调器
 * ============================================================================
 *
 * 【定位】UI 订阅一个"不在内存注册表、但可能已持久化"的会话（CLI 重启后打开
 * 历史会话）时，本文件负责把它拉起来，再交回 gateway 的 READY hydration 路径。
 *
 * 【为什么单独拆出来】
 *   - 恢复是异步且可能失败的，必须与 gateway 的订阅/帧调度解耦；
 *   - 同一 session 的并发订阅只能有一次 runtime activation（flights）。
 *
 * 【错误分型（不靠错误文本）】
 *   - fault.subscribe.sessionNotFound：store 里也没有 / 宿主不支持恢复；
 *   - fault.subscribe.resumeFailed：恢复中途失败，保留原始 cause。
 *   message 附带 reasonCode，renderer 的错误块可以直接显示，无需 UI 特判。
 * ============================================================================
 */

// 冷恢复协调器：订阅落在「不在内存注册表、但可能已持久化」的会话时
// （CLI 重启后打开历史会话），经宿主钩子把 record 拉起来，再回到既有
// gateway READY hydration 路径。从 v4-gateway 拆出（单一职责 + max-lines）。
//
// 语义要点：
// - 这里只保留既有 runtime activation 单飞；完整 READY 水位由 gateway 负责；
// - 错误分型（项目规范：不靠错误文本分流）：
//   fault.subscribe.sessionNotFound（store 里也没有 / 宿主不支持恢复）
//   vs fault.subscribe.resumeFailed（恢复中途失败，保留原始 cause）。
//   message 附带 reasonCode——renderer 订阅错误块直显 lastError，无需 UI 改动即透出。

import type { MessageWithParts } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";

// 宿主恢复结果两态：resumed 携带可选的持久 transcript（hydrate 用）和失败回滚钩子
// disposeOnFailure（最终物化失败时要拆掉本次 activation）；notFound = store 里也没有。
export type ColdSessionResumeOutcome =
  | {
      status: "resumed";
      persistedMessages?: MessageWithParts[];
      disposeOnFailure?: () => Promise<void>;
    }
  | { status: "notFound" };

/** 协调器需要的宿主能力窄面（与 V4GatewayHost 同形，避免循环 import）。 */
export interface ColdSessionResumeHost {
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
  ): Promise<ColdSessionResumeOutcome>;
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

/** 订阅不可用会话的结构化错误（reasonCode 见文件头）。 */
// 分型只由本类承担：sessionNotFound 表示"这条会话确实不存在/宿主不支持恢复"，
// resumeFailed 表示"存在但恢复过程失败"。两种都保留原始 cause 与 detail，
// message 末尾附 reasonCode，renderer 无需解析文本即可选择错误块文案。
export class V4SubscribeSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reasonCode: "fault.subscribe.sessionNotFound" | "fault.subscribe.resumeFailed",
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${reasonCode})`, options);
    this.name = "V4SubscribeSessionUnavailableError";
  }
}

/**
 * 冷会话 runtime activation 的单飞协调器。
 *
 * 职责：把"订阅一个可能已持久化的会话"收敛成一次 host.resumePersistedSession 调用；
 * 并发订阅共享同一个 flight promise，避免同一 session 建出两个 runtime。
 * 输入/输出：入参透传 sessionId / thoughtLevel / workspace / additionalDirectories /
 * persistedMessages；输出为持久 transcript（可能 undefined，交给 gateway hydration）。
 * 副作用：调用宿主恢复（可能建 runtime、写 SessionResumed 等持久事实），并由
 * onActivated 回调把 disposeOnFailure 交给调用方；不负责 READY 水位与 topic 帧。
 * 失败语义：不提供降级空投影，一律抛出结构化 V4SubscribeSessionUnavailableError。
 * 不变量：flight 在 settle（成功或失败）后立即释放，不做永久缓存，也不跨会话共享。
 */
export class ColdSessionResumeCoordinator {
  /** sessionId → 进行中的 runtime activation；settle 后立即释放。 */
  private readonly flights = new Map<string, Promise<MessageWithParts[] | undefined>>();

  constructor(private readonly host: ColdSessionResumeHost) {}

  /**
   * 确保该 session 的 runtime 已激活（幂等、单飞）。
   *
   * 命中 flights 时直接 join 现有 flight（不改参数、不重复 activation）；
   * 未命中则创建 flight 并在 finally 中删除，保证下一次冷订阅重新走恢复。
   * 副作用：第一次调用会触发宿主恢复；所有调用者共享同一份 persistedMessages。
   * 失败：原样向所有 join 者传播结构化错误；onActivated 只在 resumed 分支触发，
   * 供调用方保存 disposeOnFailure（最终 hydration 失败时回滚本次 activation）。
   */
  ensureResumed(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
    onActivated?: (outcome: Extract<ColdSessionResumeOutcome, { status: "resumed" }>) => void,
  ): Promise<MessageWithParts[] | undefined> {
    const inFlight = this.flights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold resume joined existing flight session=${sessionId}`);
      return inFlight;
    }
    this.host.onDebug?.(`cold resume flight created session=${sessionId}`);
    const flight = this.resume(
      sessionId,
      resumeThoughtLevel,
      workspace,
      additionalDirectories,
      persistedMessages,
      onActivated,
    ).finally(() => {
      this.flights.delete(sessionId);
      this.host.onDebug?.(`cold resume flight cleared session=${sessionId}`);
    });
    this.flights.set(sessionId, flight);
    return flight;
  }

  // gateway dispose 时调用：只清 flight 表（不 cancel 在途 activation）；
  // 在途 promise 仍会 settle，调用方各自通过 cancel/closed 检查丢弃结果。
  clear(): void {
    this.flights.clear();
  }

  /**
   * 真正执行一次宿主恢复，并完成错误分型。
   *
   * 宿主未实现恢复钩子 → sessionNotFound（不支持恢复等同于不可用）；
   * 钩子抛错 → resumeFailed 并保留 cause（记录 onError 后包装）；
   * 钩子返回 notFound → sessionNotFound（store 里也没有）。
   * 成功时先回调 onActivated，再返回 persistedMessages；不在此写 publisher/READY。
   */
  private async resume(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
    onActivated?: (outcome: Extract<ColdSessionResumeOutcome, { status: "resumed" }>) => void,
  ): Promise<MessageWithParts[] | undefined> {
    const resume = this.host.resumePersistedSession;
    if (!resume) {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active: ${sessionId}`,
      );
    }
    let outcome: ColdSessionResumeOutcome;
    try {
      outcome = await resume.call(
        this.host,
        sessionId,
        resumeThoughtLevel,
        workspace,
        additionalDirectories,
        persistedMessages,
      );
    } catch (error) {
      this.host.onError?.("v4.subscribe.resume", error, {
        phase: "resumePersistedSession",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to resume persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    onActivated?.(outcome);
    return outcome.persistedMessages;
  }
}
