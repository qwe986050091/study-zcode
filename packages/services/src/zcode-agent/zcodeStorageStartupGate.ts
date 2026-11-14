import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  zcodeStorageStartupStateSchema,
  type ZCodeStorageStartupState,
  type DatabaseStartupErrorCode,
} from "@zcode/shared";

// 首状态超时：连接建立后 30s 内必须收到合法的 startup 状态帧，
// 否则视为存储不可用，避免调用方无限挂起。
const FIRST_STATUS_TIMEOUT_MS = 30_000;

/** 一个 protocol client 对应一个进程代次，状态只来自该连接的合法控制帧。 */
// [契约] ZCodeStorageStartupGate 只消费当前连接的合法控制帧：一个 protocol client 对应一个进程代次。
export class ZCodeStorageStartupGate {
// current 是最近一次被接受的状态快照，也是对外唯一的事实来源。
  private current?: ZCodeStorageStartupState;
  private terminalError?: Error;
// pending 是单次等待句柄：一旦 resolve 或 reject 就不再重建，避免新旧等待者分裂。
  private pending?: Promise<void>;
  private resolve?: () => void;
  private reject?: (error: Error) => void;
// 首帧超时定时器只在 required 模式下存在，任何被接受的帧都会清掉它。
  private timer?: ReturnType<typeof setTimeout>;
// changed 只用于广播快照，写入方不读取它，避免形成第二条状态源。
  private readonly changed = new Emitter<ZCodeStorageStartupState>();
  readonly onDidChange = this.changed.event;

// required=true 时立即建 pending 并启动超时；不需要存储的进程不占用定时器。
// timer.unref 让门禁本身不会阻止 Node 进程正常退出。
  constructor(required: boolean, firstStatusTimeoutMs = FIRST_STATUS_TIMEOUT_MS) {
    if (required) {
      this.ensurePending();
// [失败路径] 超时走统一 fail 路径，生成失败快照并拒绝所有等待者。
      this.timer = setTimeout(() => this.fail("startup_status_timeout"), firstStatusTimeoutMs);
      this.timer.unref?.();
    }
  }

// isWaiting 同时覆盖「已失败」与「仍在启动」：调用方用它决定是否阻塞输入。
  get isWaiting(): boolean {
    return Boolean(this.terminalError || (this.pending && this.current?.phase !== "ready"));
  }

// 快照是纯读：返回当前不可变状态对象，不做任何派生计算。
// 未收到任何帧时为 undefined，调用方需自行区分「未知」与「失败」。
  get snapshot(): ZCodeStorageStartupState | undefined {
    return this.current;
  }

// 唯一的写入入口：校验、单调性检查、状态推进与广播都在这里完成。
// 返回 false 表示该帧被忽略，调用方无需区分具体原因。
  accept(input: unknown): boolean {
    const parsed = zcodeStorageStartupStateSchema.safeParse(input);
// 终态之后不再接受任何帧：进程代次已判定失败，后续状态没有意义。
    if (!parsed.success || this.terminalError) return false;
    const next = parsed.data;
    if (
      this.current &&
      (next.attemptId !== this.current.attemptId ||
        next.databaseId !== this.current.databaseId ||
// [并发] 换 attempt/database 或序号不递增都视为过期帧；
// ready/failed 之后同样拒绝，保证终态不可被回退。
        next.sequence <= this.current.sequence ||
        this.current.phase === "ready" ||
        this.current.phase === "failed")
    )
      return false;
    clearTimeout(this.timer);
// 先更新快照再决定 resolve/fail，保证广播出去的状态与内部一致。
    this.current = next;
// ready 放行等待者；failed 走 fail 统一构造错误，其余阶段继续 pending。
    if (next.phase === "ready") this.resolve?.();
// 失败帧在进入终态前还要清掉首帧超时：任何被接受的帧都不应再触发超时路径。
    else if (next.phase === "failed") this.fail(next.errorCode ?? "sql_failed");
    else this.ensurePending();
    this.changed.fire(next);
    return true;
  }

// wait 可被调用方取消，但取消只影响本次等待，不改门禁状态。
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.terminalError) throw this.terminalError;
    if (!this.pending || this.current?.phase === "ready") return;
// [资源] 无 signal 时直接复用同一个 pending，避免为每次等待新建 Promise；
// 有 signal 时才额外挂 abort 竞速，并在 finally 中移除监听。
    if (!signal) return this.pending;
    let abort!: () => void;
    try {
// 竞速失败只代表本次等待被取消，pending 本身仍对其他等待者有效。
      await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

// 销毁等价于传输关闭：仍在启动则按 transport_closed 失败，防止等待者悬挂。
  dispose(): void {
    clearTimeout(this.timer);
// [资源] 只有尚未就绪且未失败时才补一个失败：已 ready 的连接不应被销毁改写历史。
    if (this.pending && this.current?.phase !== "ready" && !this.terminalError)
      this.fail("transport_closed");
    this.changed.dispose();
  }

// pending 只创建一次：多个阶段重复调用不会替换 Promise，也不会丢失已有等待者。
  private ensurePending(): void {
    if (this.pending) return;
    this.pending = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // 尚无业务调用时也可能先收到失败；仍保留 rejected promise 给之后的调用者。
// 先挂一个空 catch，避免首个失败在还没有等待者时触发 unhandledRejection。
    void this.pending.catch(() => undefined);
  }

// fail 是幂等的：已处于 failed 时只拒绝等待者，不再重复推进序号或重复广播。
  private fail(code: DatabaseStartupErrorCode): void {
    // 首帧之前失败也必须形成快照；未知数据库身份不能伪装成某个已解析路径。
    if (this.current?.phase !== "failed") {
      this.current = this.current
        ? { ...this.current, phase: "failed", errorCode: code, sequence: this.current.sequence + 1 }
        : {
            schemaVersion: 1,
            attemptId: randomUUID(),
            databaseId: `unresolved:${randomUUID()}`,
            databaseKind: "session",
            sequence: 1,
            phase: "failed",
            elapsedMs: 0,
            errorCode: code,
          };
      this.changed.fire(this.current);
    }
    this.terminalError = new Error(`SQLite startup failed: ${code}`);
// 错误对象在构造时固化 code，后续读取不会因状态再变而漂移。
    this.reject?.(this.terminalError);
  }
}
