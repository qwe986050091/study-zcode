// Host 侧网络抓包（network capture）出口。
//
// 职责：把 createNodeNetworkCapture 与本机 runtime capture 的观测批次统一转发给 main；
// 由 main 决定落盘 / 展示，Host 只负责采集与带 captureId 的路由。
// 输入输出：输入可选 port；输出 { setCaptureId }，用 null 表示停止抓包。
// 副作用：setCaptureId 会改变两层 capture 的全局状态；发送失败只丢当前批次。
// 失败语义：postMessage 异常被吞（抓包是旁路，不能影响 Host 主链路）。
// 维护的不变量：只有一个 captureId 生效，且必须同时同步给 node capture 与本机 runtime capture，
// 否则会出现「一半采集、一半不采集」的错位。

import { HostResponseTypes, type NetworkCaptureBatch } from "@zcode/shared";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { localRuntimeNetworkCapture } from "@zcode/services/node";

// 创建 Host 抓包出口。
// port 可为 undefined（无 parentPort 的调试环境），此时采集仍进行但批次被丢弃。
// 返回的 setCaptureId(captureId|null) 是唯一开关：null 同时关闭两层采集。
// 失败语义：send 内部 try/catch，不向外抛出。
export function createHostNetworkCapture(
  port: { postMessage(message: unknown): void } | undefined,
) {
  const send = (batch: NetworkCaptureBatch) => {
    try {
      port?.postMessage({ type: HostResponseTypes.NetworkCaptureBatch, batch });
    } catch {
      /* 观测丢弃，不影响 Host 主链路 */
    }
  };
  const nodeCapture = createNodeNetworkCapture("host", send);
  return {
    // 切换抓包会话：两层 capture 必须用同一个 captureId 与同一个 send，
    // 关闭时（null）第二参数传 undefined 表示解除 runtime capture 的回调。
    setCaptureId(captureId: string | null) {
      nodeCapture.setCaptureId(captureId);
      localRuntimeNetworkCapture.setCaptureId(captureId, captureId ? send : undefined);
    },
  };
}
