import type { ZCodeApp } from "../app/types.js";
import type { ZCodeProtocolAgentDependencies } from "./server-types.js";

/** 持有 app 资源而非业务 session；临时 workspace app、尚未登记的 app 也归此 owner。 */
export class ProtocolRuntimeResources {
  private stopping = false;
  private readonly apps = new Set<ZCodeApp>();
  private closePromise?: Promise<void>;

  constructor(private readonly factory: ZCodeProtocolAgentDependencies["createZCodeApp"]) {}

  /**
   * 资源 owner 的工厂入口：先 assertServing 拒绝停机后新建，再把 app.close 包成幂等并
   * 从集合摘除；若 create 在 EOF 前开始、EOF 后才返回，则立即 stop 该 app 再抛
   * "runtime is stopping"，保证既不复活也不泄漏资源。
   */
  readonly create: ZCodeProtocolAgentDependencies["createZCodeApp"] = async (options) => {
    this.assertServing();
    const app = await this.factory(options);
    const originalClose = app.close?.bind(app);
    let closing: Promise<void> | undefined;
    app.close = () => {
      closing ??= Promise.resolve().then(async () => {
        try {
          await originalClose?.();
        } finally {
          this.apps.delete(app);
        }
      });
      return closing;
    };
    this.apps.add(app);
    if (this.stopping) {
      // create 在 EOF 前开始、EOF 后返回时不能重新成为可用 session，也不能遗失资源。
      await this.stopApp(app);
      this.assertServing();
    }
    return app;
  };

  /** 停机闸门：停机开始后新 create 一律拒绝，避免协议 EOF 后再产生可用 session。 */
  assertServing(): void {
    if (this.stopping) throw new Error("ZCode Protocol runtime is stopping");
  }

  /**
   * 关闭全部 app：置 stopping 后逐个 stopApp（allSettled），全部失败聚合为 AggregateError。
   * closePromise 记忆化，重复 close 返回同一 promise，不会重复释放。
   */
  close(): Promise<void> {
    this.stopping = true;
    this.closePromise ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.apps].map((app) => this.stopApp(app)));
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Protocol apps shutdown failed");
    });
    return this.closePromise;
  }

  /** 先置 runtime shutdown 并中止前台执行，再 close app；close 必执行，即使 beginShutdown 抛错。 */
  private async stopApp(app: ZCodeApp): Promise<void> {
    try {
      app.runtime.beginShutdown();
      app.runtime.stopActiveForegroundExecution?.({ reason: "Protocol runtime stopping" });
    } finally {
      await app.close?.();
    }
  }
}
