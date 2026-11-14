// Host API 网络 transport 的临时所有权交接。
//
// 职责：在 ServiceCollection 接管 transport 之前，先把「未托管 transport」的清理责任守住：
// 初始化失败时用带 deadline 的 shutdown phase 释放它，再把原始错误抛回去。
// 输入输出：输入 transport / establishOwner / disposeTimeoutMs / log；成功返回 establishOwner
// 的产物 T，失败抛出原始 initializationError。
// 副作用：失败路径会调用 transport.disposeAndWait() 并按 phase 记账写日志。
// 失败语义：清理本身失败或超时不会覆盖原始初始化错误——调用方始终看到最初的原因；
// dispose 超时默认为 3.5s，避免 dispatcher 卡死拖住 fatal 收口。

import type { HostApiNetworkTransport } from "@zcode/services/node";
import { runHostShutdownPhases } from "./hostShutdownPhases.js";

const DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS = 3_500;

// 建立 transport 的 owner（通常是 ServiceCollection），失败时兜底释放 transport。
// 关键点：此时全局 activeServices 尚未赋值，进程级清理找不到这份 transport，只能在创建点
// 本地清理；因此失败分支必须走 runHostShutdownPhases 而不是直接调用 dispose。
// 失败语义：清理结果被吞掉（只写日志），最终 throw 原始错误。
export async function initializeHostApiNetworkTransportOwner<T>(params: {
  transport: Pick<HostApiNetworkTransport, "disposeAndWait">;
  establishOwner: () => T;
  disposeTimeoutMs?: number;
  log: (message: string, details: Record<string, unknown>) => void;
}): Promise<T> {
  try {
    return await params.establishOwner();
  } catch (initializationError) {
    // transport 在 ServiceCollection 接管前就会被启动预热请求使用；初始化中途抛错时，
    // 全局 activeServices 尚未赋值，进程级清理无法找到它。这里从创建点守住临时所有权，并用
    // deadline 避免 dispatcher 关闭卡住原始初始化错误的 fatal 收口。
    await runHostShutdownPhases(
      [
        {
          name: "unowned-host-api-network-transport-dispose",
          run: async () => {
            await params.transport.disposeAndWait();
          },
          timeoutMs: params.disposeTimeoutMs ?? DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS,
        },
      ],
      {
        phaseTimeoutMs: DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS,
        log: params.log,
      },
    );
    throw initializationError;
  }
}
