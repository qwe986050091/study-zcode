import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export const EXIT_STDERR_DRAIN_MS = 250;

/** stderr 的寿命独立于协议；child exit 时管道中仍可能有最后一行诊断。 */
// 收集器只做两件事：把 stderr 行转成回调，并在管道结束时给出可等待的排空信号。
export class AgentStderrCollector {
  private readonly reader;
// drained 是一次性 Promise：所有等待者共享同一个完成信号，不重复创建。
  private readonly drained: Promise<void>;
  private resolveDrained!: () => void;
  private done = false;
// 只保留最早的死线：多次 waitForDrain 不能把排空时间越推越晚。
  private deadlineAt = Infinity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(input: Readable, onLine?: (line: string) => void) {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
    this.reader = createInterface({ input });
    this.reader.on("line", (line) => onLine?.(line));
// 读端关闭、读端错误、输入流错误与输入流关闭都收敛到 finish，
// 保证任何一条终止路径都不会让等待者悬挂。
    this.reader.once("close", this.finish);
    this.reader.on("error", this.finish);
    // 只有诊断出口不可用，不能因此撤销仍然健康的 stdin/stdout 协议。
    input.on("error", this.finish);
    input.once("close", this.finish);
    if (input.destroyed || input.readableEnded) this.finish();
  }

// [契约] waitForDrain 只收紧死线：新 timeoutMs 更早则重置定时器，更晚则保留原计划；绝不延长既有等待。
// 这样调用方可以要求「最多再等 N 毫秒」，而不会延长已有等待。
  waitForDrain(timeoutMs = EXIT_STDERR_DRAIN_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (!this.done && deadline < this.deadlineAt) {
      this.deadlineAt = deadline;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(this.finish, Math.max(0, timeoutMs));
    }
// 永远返回同一个 Promise，调用方可以安全地多次等待。
    return this.drained;
  }

// 用箭头函数固定 this：它会被作为事件处理器直接注册。
// done 标志让 finish 幂等，重复触发只做一次关闭与 resolve。
  private readonly finish = (): void => {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
// 先关闭读端再 resolve，确保等待者被唤醒时不会再收到新的行回调。
    this.reader.close();
    this.resolveDrained();
  };
}
