import type { SessionsIndexPublisher } from "./sessions-index-publisher.js";

const GATEWAY_DISPOSED_FAULT = "fault.gateway.disposed";

/**
 * sessions-index publisher 的 workspace 级生命周期边界：同键异步操作串行，dispose 后禁止回写。
 * gateway 只负责构造/投影；并发等待、失败后重试与销毁代际统一收敛在这里。
 *
 * 归属口径：键是 workspaceId（不是 sessionId），一个 workspace 一个 publisher；connectionId
 * 的订阅归属仍由 publisher 自己维护。runExclusive 保证同一 workspaceId 的初始化/重建不会并发。
 * 失败与降级：前序初始化失败不封死后续请求（允许重试）；一旦 dispose，所有写入口抛
 * GATEWAY_DISPOSED_FAULT，等待中的链在恢复后再次检查 disposed，杜绝销毁后回写。
 * 无 IO、无定时器；dispose 只清内存，不通知 publisher 的订阅者（由 gateway 统一拆链）。
 */
export class SessionsIndexPublisherRegistry {
  private readonly publishers = new Map<string, SessionsIndexPublisher>();
  private readonly inFlight = new Map<string, Promise<SessionsIndexPublisher>>();
  private disposed = false;

  /**
   * 读取某 workspace 已登记的 publisher；未登记返回 undefined。
   * 只读、不触发异步初始化，也不校验 disposed（销毁后 Map 已清空）。
   */
  get(workspaceId: string): SessionsIndexPublisher | undefined {
    return this.publishers.get(workspaceId);
  }

  /**
   * 登记（或替换）某 workspace 的 publisher。
   * 副作用：仅写 Map；disposed 后调用直接抛错，避免销毁代际被重新写活。
   * 不做去重/比较：调用方应通过 runExclusive 保证同键构造串行。
   */
  set(workspaceId: string, publisher: SessionsIndexPublisher): void {
    this.ensureActive();
    this.publishers.set(workspaceId, publisher);
  }

  /**
   * 已登记的全部 workspaceId 迭代器。供 gateway dispose 时逐个清理；
   * 直接暴露内部迭代器，调用方不得在遍历中并发 set/delete。
   */
  keys(): IterableIterator<string> {
    return this.publishers.keys();
  }

  /**
   * 校验注册表仍处于存活代际；已 dispose 则抛出 fault.gateway.disposed。
   * 所有写入口（set/runExclusive）与异步恢复点都必须调用，形成统一的 fail-closed 边界。
   */
  ensureActive(): void {
    if (this.disposed) throw new Error(GATEWAY_DISPOSED_FAULT);
  }

  /**
   * 同 workspaceId 串行执行异步构造/恢复，返回最终 publisher。
   *
   * 并发口径：已有 inFlight 时先 await 它（失败被吞掉，允许当前请求重试），然后递归重新
   * 进入；无 inFlight 时把本次操作挂为 inFlight，操作前后各校验一次 disposed。
   * 副作用：操作成功后由调用方 set 入表；本方法只管理 inFlight，不写 publishers。
   * 失败：operation 抛错原样上抛，finally 清理 inFlight（仅当仍是本次 Promise，避免误删后继）。
   */
  async runExclusive(
    workspaceId: string,
    operation: () => Promise<SessionsIndexPublisher>,
  ): Promise<SessionsIndexPublisher> {
    this.ensureActive();
    const pending = this.inFlight.get(workspaceId);
    if (pending) {
      try {
        await pending;
      } catch {
        // 前序失败不能封死当前请求；销毁会由 ensureActive 阻断，其他失败允许重试。
      }
      this.ensureActive();
      return this.runExclusive(workspaceId, operation);
    }

    const current = (async () => {
      this.ensureActive();
      const publisher = await operation();
      this.ensureActive();
      return publisher;
    })();
    this.inFlight.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(workspaceId) === current) this.inFlight.delete(workspaceId);
    }
  }

  /**
   * 销毁注册表：置 disposed、丢弃全部在途 Promise 与已登记 publisher。
   * 之后任何 set/runExclusive 都抛 fault.gateway.disposed；已在途操作的 finally 不会回写。
   * 不主动取消 operation（其自身 IO 由上层负责），也不清理 publisher 内的订阅。
   */
  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
    this.publishers.clear();
  }
}
