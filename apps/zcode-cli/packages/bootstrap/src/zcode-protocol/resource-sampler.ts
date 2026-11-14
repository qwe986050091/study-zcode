import type { Logger } from "@zcode/contracts";
import {
  createMemorySampleWriteGate,
  memoryUsageToSampleFields,
  zcodeProtocolNotifications,
  type MemorySample,
  type ZCodeProtocolNotification,
} from "@zcode/shared";
import {
  createZCodeProcessResourceSampler,
  type ZCodeProcessResourceSampler,
} from "../process-resource-sampler.js";
import type { ZCodeProtocolAgentServer } from "./server.js";

/**
 * 启动协议进程资源采样器（60s 一节拍）。每个采样点做三件事：
 * 1. 向 Host 推 processResourceSample 遥测；
 * 2. 顺带驱动 resident session 水位回收、event store 与 detached publisher 淘汰（复用节拍，不新增定时器）；
 * 3. 按变化/心跳门控写一条内存诊断日志。
 * 返回 undefined 表示采样器初始化失败——资源遥测是 best effort，不能改变 Agent 启动结果。
 */
export function startProtocolResourceSampler(
  server: ZCodeProtocolAgentServer,
  send: (message: ZCodeProtocolNotification) => void,
  logger: Logger,
): ZCodeProcessResourceSampler | undefined {
  try {
    // 本地内存诊断日志：复用同一 60s 节拍，
    // 变化/心跳门控后才写一行，避免与消息流同频刷盘。
    const memoryDiagnosticsGate = createMemorySampleWriteGate();
    const sampler = createZCodeProcessResourceSampler({
      onSample: (sample, memoryUsage) => {
        send({
          method: zcodeProtocolNotifications.processResourceSample,
          params: sample,
        });
        // resident session TTL / 水位收敛借用资源采样节拍（60s）作兜底，不新增定时器；
        // sampler 对 onSample 已有异常兜底，单次 rebalance 失败不影响遥测上报。
        server.rebalanceResidentSessions();
        try {
          // 同一节拍先做瞬态事件时间兜底淘汰，再采样，日志里的 eventRows 反映淘汰后的驻留量。
          server.pruneSessionEventStores();
          server.pruneDetachedChildPublishers();
        } catch {
          // 兜底淘汰失败不影响资源上报与诊断日志。
        }
        try {
          const memorySample: MemorySample = {
            role: "agent_node",
            ...memoryUsageToSampleFields(memoryUsage),
            counters: server.collectMemoryDiagnostics(),
          };
          const reason = memoryDiagnosticsGate.evaluate(memorySample, Date.now());
          if (reason) {
            const { role: _role, counters, ...memoryFields } = memorySample;
            logger.info("Process memory sample", {
              event: "zcode_protocol.process.memory_sample",
              reason,
              ...memoryFields,
              counters,
            });
          }
        } catch {
          // 诊断日志失败只丢当前样本，不影响资源上报与 rebalance。
        }
      },
    });
    sampler.start();
    return sampler;
  } catch {
    // 资源遥测是 best effort，初始化失败不能改变 Agent 启动结果。
    return undefined;
  }
}
