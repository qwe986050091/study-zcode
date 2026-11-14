import {
  networkCaptureBatchSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type NetworkCaptureBatch,
} from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** 仅由本机子进程 spawn 点登记；remote RPC/手机 attachment 不登记也不透传启停。 */
// 抓包状态集中在一个进程内单例：captureId 与订阅都随进程生命周期存续。
export class LocalRuntimeNetworkCapture {
// 每个 client 记录 pid 与它当前的订阅：pid 用于补齐真实归属，
// 订阅用于在重配置或注销时精确拆除，不影响其他连接。
  private readonly clients = new Map<
    ZCodeProtocolClient,
    { pid: number; subscription?: IDisposable }
  >();
// null 表示未开启抓包；非空时才向各 client 下发配置。
  private captureId: string | null = null;
// sink 由调用方提供；未提供时只维持订阅，不消费批次。
  private sink?: (batch: NetworkCaptureBatch) => void;

// 登记发生在 spawn 点，因此 pid 可信；远端连接不经过这里，也就不会进入抓包。
// 返回的注销函数会先拆订阅再删表，避免回调持有已注销的 client。
  register(client: ZCodeProtocolClient, pid: number): () => void {
    this.clients.set(client, { pid });
// 抓包已开启时，新登记的连接立即补配，不需要等待下一次 setCaptureId。
    if (this.captureId) this.configure(client);
    return () => {
// 注销时先释放订阅：否则 client 仍可能向已删除的表项推送批次。
      this.clients.get(client)?.subscription?.dispose();
      this.clients.delete(client);
    };
  }

// 启停都走这一个入口：无论开启还是关闭，都对全部已登记连接重配一次，
// 因此不存在「部分连接还在旧 captureId」的中间态。
  setCaptureId(captureId: string | null, sink?: (batch: NetworkCaptureBatch) => void): void {
    this.captureId = captureId;
    this.sink = sink;
// 遍历时 configure 可能删除已销毁的 client，Map 允许安全删除当前/其他键。
    for (const client of this.clients.keys()) this.configure(client);
  }

// [事务] 重配是可重复执行的：先无条件拆旧订阅，再按当前状态决定是否重建。
// 这样调用方无需关心此前处于开启还是关闭状态。
  private configure(client: ZCodeProtocolClient): void {
    const entry = this.clients.get(client)!;
    entry.subscription?.dispose();
    entry.subscription = undefined;
// 已销毁的连接直接从表中移除，不保留永远无法恢复的条目。
    if (client.isDisposed) {
      this.clients.delete(client);
      return;
    }
    if (this.captureId) {
// [边界] onNotification 只转发 processNetworkRequests：其余通知直接丢弃，避免 capture 承担无关流量。
      entry.subscription = client.onNotification((message) => {
        if (message.method !== zcodeProtocolNotifications.processNetworkRequests) return;
        const result = networkCaptureBatchSchema.safeParse(message.params);
        if (!result.success || result.data.captureId !== this.captureId) return;
        // PID/角色来自本机 spawn 登记，不能采用对端自报身份。
        this.sink?.({
          ...result.data,
          records: result.data.records.map((record) => ({
            ...record,
            pid: entry.pid,
            processType: "cli",
          })),
        });
      });
    }
    void client
      .notify(zcodeProtocolMethods.processNetworkCapture, { captureId: this.captureId })
      .catch(() => {
        /* 已退出进程无需重试或重启 */
      });
  }
}

export const localRuntimeNetworkCapture = new LocalRuntimeNetworkCapture();
