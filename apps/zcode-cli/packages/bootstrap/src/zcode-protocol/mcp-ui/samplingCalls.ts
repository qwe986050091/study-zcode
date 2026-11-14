import {
  MCP_APPS_SAMPLING_MAX_OPERATIONS,
  MCP_APPS_SAMPLING_MAX_PER_AGENT,
  MCP_APPS_SAMPLING_MAX_PER_SESSION,
  MCP_APPS_SAMPLING_TIMEOUT_MS,
} from "@zcode/shared/mcp-apps";
import { ProtocolRequestError } from "../server-types.js";

type Scope = { token: string; sessionId: string; signal: AbortSignal };
type Ledger = { scope: Scope; calls: Map<string, AbortController | null> };
const cancelled = () => new ProtocolRequestError(-32000, "Sampling cancelled");

/** 终态账本与并发额度的唯一 owner。只在凭证失效时清账本，旧 operationId 不能被重放。 */
export class McpUiSamplingCalls {
  private readonly instances = new Map<string, Ledger>();
  private readonly sessions = new Map<string, number>();
  private active = 0;

  private ledger(scope: Scope): Ledger {
    scope.signal.throwIfAborted();
    let ledger = this.instances.get(scope.token);
    if (ledger) return ledger;
    ledger = { scope, calls: new Map() };
    this.instances.set(scope.token, ledger);
    const captured = ledger;
    scope.signal.addEventListener(
      "abort",
      () => {
        this.instances.delete(scope.token);
        for (const controller of captured.calls.values()) controller?.abort(cancelled());
        captured.calls.clear();
      },
      { once: true },
    );
    return ledger;
  }

  /**
   * 取消指定 operationId。无论调用是否已开始，都在账本里留下 null 终态，
   * 使随后到达的同 id sample 请求被判重/拒绝；cancelled 仅表示当时是否有在跑的控制权。
   */
  cancel(scope: Scope, operationId: string): { cancelled: boolean } {
    const ledger = this.ledger(scope);
    const controller = ledger.calls.get(operationId);
    if (!ledger.calls.has(operationId)) this.checkLedgerCapacity(ledger);
    // 取消先于 sample 到达时也留下终态；旧请求之后到达不会执行。
    ledger.calls.set(operationId, null);
    controller?.abort(cancelled());
    return { cancelled: Boolean(controller) };
  }

  /**
   * 执行一次 sampling：先做 operationId 去重与三重额度检查（实例操作数、agent 并发、会话并发），
   * 再在独立 AbortController 上跑 run，并与取消 Promise 竞速；超时/取消都以 -32000 结束。
   * finally 里只把账本项重置为终态，不重建已被实例关闭删除的账本，避免复活旧租约。
   */
  async execute<T>(
    scope: Scope,
    operationId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ledger = this.ledger(scope);
    if (ledger.calls.has(operationId))
      throw new ProtocolRequestError(-32602, "Duplicate sampling operationId");
    this.checkLedgerCapacity(ledger);
    if (
      this.active >= MCP_APPS_SAMPLING_MAX_PER_AGENT ||
      (this.sessions.get(scope.sessionId) ?? 0) >= MCP_APPS_SAMPLING_MAX_PER_SESSION ||
      [...ledger.calls.values()].some(Boolean)
    )
      throw new ProtocolRequestError(-32000, "Sampling busy");
    const controller = new AbortController();
    ledger.calls.set(operationId, controller);
    this.active++;
    this.sessions.set(scope.sessionId, (this.sessions.get(scope.sessionId) ?? 0) + 1);
    const timer = setTimeout(
      () => controller.abort(new ProtocolRequestError(-32000, "Sampling timed out")),
      MCP_APPS_SAMPLING_TIMEOUT_MS,
    );
    const signal = controller.signal;
    let off = () => {};
    try {
      // 先装取消 listener 再执行，取消无需等待不合作的底层 Promise；迟到成功被永久丢弃。
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(signal.reason ?? cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
        off = () => signal.removeEventListener("abort", onAbort);
      });
      const result = await Promise.race([run(signal), aborted]);
      signal.throwIfAborted();
      scope.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      off();
      // 迟到清理不重新创建已被 close 删除的实例/账本。
      if (this.instances.get(scope.token) === ledger) ledger.calls.set(operationId, null);
      this.active--;
      const count = (this.sessions.get(scope.sessionId) ?? 1) - 1;
      if (count) this.sessions.set(scope.sessionId, count);
      else this.sessions.delete(scope.sessionId);
    }
  }
  /** 单个实例的 operationId 历史上限；满了要求重开 App（防止无界内存与重放面扩大）。 */
  private checkLedgerCapacity(ledger: Ledger): void {
    if (ledger.calls.size >= MCP_APPS_SAMPLING_MAX_OPERATIONS)
      throw new ProtocolRequestError(-32000, "Sampling operation limit reached; reopen the App");
  }
}
