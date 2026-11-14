// Host 侧网络遥测（LLM / RPC 请求观测）的批量回传。
//
// 职责：注册 @zcode/rpc 的全局 network telemetry sink，把 observation 先入内存队列，
// 再按「满 200 条立即刷」或「每 30s 定时刷」两种触发合并成 NetworkTelemetryBatch 发给 main。
// 输入输出：register 无返回值（模块级单例）；stop 清空定时器、解除 sink 并做最后一次刷出。
// 副作用：模块级可变状态（pending 数组、flushTimer、activeParentPort）；定时器与 sink 注册。
// 失败语义：postMessage 失败只吞掉当前批次，不影响 Host 主流程与后续观测。
// 维护的不变量：同一进程只允许一条 sink 与一个定时器；stop 后 sink 置 null 且 parentPort
// 清空，避免停止后仍向关闭的端口写入。

import { HostResponseTypes } from "@zcode/shared";
import { setNetworkTelemetrySink, type NetworkObservation } from "@zcode/rpc";

interface HostNetworkTelemetryParentPort {
  postMessage(message: unknown): void;
}

const pending: NetworkObservation[] = [];
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_MAX_BATCH = 200;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let activeParentPort: HostNetworkTelemetryParentPort | null = null;

// 刷出一批观测：一次最多取 FLUSH_MAX_BATCH 条，剩余留在队列等下次。
// 没有 parentPort 或队列为空时直接返回（本地调试环境允许只采集不发送）。
// 先 splice 再 postMessage：发送失败时这批观测已出队，宁可丢弃也不无限堆积。
// 失败语义：异常被吞，不向调用方（sink / timer）传播。
function flushHostNetworkTelemetryBatch(): void {
  if (!activeParentPort || pending.length === 0) {
    return;
  }
  const observations = pending.splice(0, FLUSH_MAX_BATCH);
  try {
    activeParentPort.postMessage({
      type: HostResponseTypes.NetworkTelemetryBatch,
      observations,
    });
  } catch {
    // 遥测批次失败不应影响 host 主流程
  }
}

// 注册网络遥测 sink 并启动定时刷出。
// parentPort 允许 null/undefined：本地调试下没有 utility process 端口，此时只采集不发。
// 满批即刷是为了限制内存上限，定时刷是为了保证低频观测也能在 30s 内到达 main。
// 副作用：覆盖模块级 sink 与 flushTimer；重复调用会替换旧 sink 但不会清理旧 timer。
// 维护的不变量：desktop Host 必须传 Electron utilityProcess 的 process.parentPort，
// 不能传 node:worker_threads.parentPort（后者为 null，会导致批次全部丢失）。
export function registerHostNetworkTelemetry(
  parentPort: HostNetworkTelemetryParentPort | null | undefined,
): void {
  // 修复原因：desktop host 是 Electron utility process，通信端口在 process.parentPort；
  // node:worker_threads.parentPort 在这里为 null，会导致 LLM/RPC 网络遥测批次无法发回 main。
  activeParentPort = parentPort ?? null;
  setNetworkTelemetrySink((observation) => {
    pending.push(observation);
    if (pending.length >= FLUSH_MAX_BATCH) {
      flushHostNetworkTelemetryBatch();
    }
  });

  flushTimer = setInterval(flushHostNetworkTelemetryBatch, FLUSH_INTERVAL_MS);
}

// 停止遥测：先清定时器再解除 sink，最后 flush 一次残余观测。
// 顺序很重要：先解 sink 可防止 flush 期间又新增观测，导致清理后队列仍有残留。
// 失败语义：不抛出；已发出的批次可能因端口已关闭而丢失。
export function stopHostNetworkTelemetry(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  setNetworkTelemetrySink(null);
  flushHostNetworkTelemetryBatch();
  activeParentPort = null;
}
