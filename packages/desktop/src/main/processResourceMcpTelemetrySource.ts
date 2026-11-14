// INV-01 每窗口只交一份合计：守住位置 flushPending；改错故障 同一实例被重复计数。
// INV-02 瞬时读数不落盘：守住位置 模块注释与存储；改错故障 采样进入会话或队列。
// INV-03 入参先过 schema：守住位置 解析入口；改错故障 非法结构污染聚合表。
// INV-04 过期样本先清理：守住位置 每次入口；改错故障 陈旧数据长期占用内存。
// INV-05 乱序样本不回溯：守住位置 时间戳比较；改错故障 旧读数覆盖新读数。
// INV-06 重复样本不二次计数：守住位置 相等分支；改错故障 并发转发的样本翻倍。
// INV-07 实例上限保护：守住位置 容量判断；改错故障 异常客户端撑爆内存。
// INV-08 分组键含运行面：守住位置 键构造；改错故障 本地与远程实例被合并。
// INV-09 分组键含环境：守住位置 键构造；改错故障 多环境读数互相污染。
// INV-10 分组键含硬件特征：守住位置 键构造；改错故障 换机后读数被平均。
// INV-11 新鲜度取或：守住位置 合并逻辑；改错故障 已交付样本再次上报。
// INV-12 接收时间取最大：守住位置 合并逻辑；改错故障 有效期被旧样本刷新。
// INV-13 CPU 按核数归一：守住位置 增量换算；改错故障 多核机器读数虚高。
// INV-14 驻留内存累加：守住位置 聚合分支；改错故障 总量只反映单个进程。
// INV-15 单进程峰值取最大：守住位置 聚合分支；改错故障 峰值被最后一个样本覆盖。
// INV-16 外部总量按组覆盖：守住位置 采样回调；改错故障 与真实读数重复叠加。
// INV-17 交付后统一标记：守住位置 窗口末尾；改错故障 下一窗口重复提交。
// INV-18 重置清空全表：守住位置 reset；改错故障 切换会话后残留旧读数。
//
// 模块职责：收集 MCP 实例资源样本，按窗口聚合成外部应用读数。
// 状态所有权：模块级映射保存未交付样本；交付标记随窗口推进。
// 阅读顺序：先看存储结构，再看摄入与分组，最后看采样源实现。
/** MCP 每个上报窗口只交一份合计；瞬时读数不进入会话、队列或持久化。 */
import {
  zcodeMcpResourceSamplesSchema,
  ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeMcpResourceSample,
  type ProcessResourceRuntimeSurface,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { recordExternalAppResourceSample } from "./processResourceExternalAppSamples.js";
import type {
  ProcessResourceSampleContext,
  ProcessResourceSampleSource,
} from "./processResourceSampleSources.js";
import {
  processResourceHardwareKey,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";

// MAX_MCP_GROUPS_PER_WINDOW 是每窗口分组硬上限；超出分组必须在交付前丢弃；实例样本另有 MAX_MCP_INSTANCE_SAMPLES 独立上限；两个上限保护不同阶段；调大之前必须先确认宿主预算。
const MAX_MCP_GROUPS_PER_WINDOW = 32;
const MAX_MCP_INSTANCE_SAMPLES = 256;
interface StoredSample {
  sample: ZCodeMcpResourceSample;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  receivedAt: number;
  delivered: boolean;
}
const latest = new Map<string, StoredSample>();

// purgeExpired 按 receivedAt 判断过期；有效期取 ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS 的两倍；过期项直接从 latest 删除；摄入与采样都必须先调用；清理不区分 delivered 状态。
function purgeExpired(now: number): void {
  for (const [key, entry] of latest) {
    if (now - entry.receivedAt > ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS * 2) latest.delete(key);
  }
}

// safeParse 必须整批一次校验；校验失败整批忽略；key 由四段信息拼成；sampledAt 旧于已有样本时必须跳过；新样本以 delivered=false 写入。
export function ingestMcpResourceSamples(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
  environmentKey?: string,
): void {
  const parsed = zcodeMcpResourceSamplesSchema.safeParse(raw);
  if (!parsed.success) return;
  const receivedAt = Date.now();
  purgeExpired(receivedAt);
  for (const sample of parsed.data) {
    const key = JSON.stringify([
      runtimeSurface,
      environmentKey ?? "",
      sample.instanceToken,
      sample.mcpId,
    ]);
    const previous = latest.get(key);
    // 同一个 CLI 的同一份样本可能经多个远端连接转发；乱序/重复都不能二次计数。
    if (previous && previous.sample.sampledAt >= sample.sampledAt) continue;
    if (!previous && latest.size >= MAX_MCP_INSTANCE_SAMPLES) {
      logger.debug("[resource] MCP 实例样本已达上限，丢弃新样本");
      continue;
    }
    latest.set(key, { sample, runtimeSurface, environmentKey, receivedAt, delivered: false });
  }
}

// groupSamples 按 runtimeSurface 与 environmentKey 再分组；硬件特征经 processResourceHardwareKey 参与分组键；首次出现时必须建好角色骨架；后续样本就地累加。
function groupSamples(): Map<
  string,
  { role: ProcessRoleSample; fresh: boolean; receivedAt: number }
> {
  const groups = new Map<string, { role: ProcessRoleSample; fresh: boolean; receivedAt: number }>();
  for (const entry of latest.values()) {
    const { sample, runtimeSurface, environmentKey } = entry;
    const hardware = {
      platform: sample.platform,
      arch: sample.arch,
      logicalCpuCount: sample.logicalCpuCount,
      totalMemoryGb: sample.totalMemoryGb,
    };
    const key = JSON.stringify([
      runtimeSurface,
      environmentKey ?? "",
      sample.mcpId,
      processResourceHardwareKey(hardware),
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        role: {
          role: "mcp",
          mcpId: sample.mcpId,
          runtimeSurface,
          ...(environmentKey === undefined ? {} : { environmentKey }),
          hardware,
          cpuPercent: 0,
          rssKbTotal: 0,
          rssKbMaxProcess: 0,
          processCount: 0,
          uptimeMinutes: 0,
        },
        fresh: false,
        receivedAt: 0,
      };
      groups.set(key, group);
    }
    group.fresh ||= !entry.delivered;
    group.receivedAt = Math.max(group.receivedAt, entry.receivedAt);
    group.role.cpuPercent +=
      (sample.cpuTimeMsDelta / sample.intervalMs / sample.logicalCpuCount) * 100;
    group.role.rssKbTotal += sample.rssKbTotal;
    group.role.rssKbMaxProcess = Math.max(group.role.rssKbMaxProcess, sample.rssKbMaxProcess);
    group.role.processCount += sample.processCount;
    group.role.uptimeMinutes = Math.max(group.role.uptimeMinutes, sample.uptimeMinutes);
  }
  return groups;
}

export const mcpProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "mcp",
  sample(context) {
    purgeExpired(context.now);
    // 外部总量按 MCP 分组覆盖；沿用真实读数到达时刻，10 秒 tick 不能刷新其有效期。
    for (const [key, group] of groupSamples()) {
      recordExternalAppResourceSample({
        sourceKey: `mcp:${key}`,
        runtimeSurface: group.role.runtimeSurface ?? "local",
        cpuPercent: group.role.cpuPercent,
        rssKbTotal: group.role.rssKbTotal,
        processCount: group.role.processCount,
        intervalMs: ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS,
        receivedAt: group.receivedAt,
      });
    }
  },
  flushPending(context: ProcessResourceSampleContext) {
    purgeExpired(context.now);
    let reported = 0;
    for (const group of groupSamples().values()) {
      if (!group.fresh) continue;
      if (reported >= MAX_MCP_GROUPS_PER_WINDOW) {
        logger.debug("[resource] MCP 每窗口最多 32 个分组，丢弃超额样本");
        continue;
      }
      context.addRoleSample(group.role);
      reported += 1;
    }
    for (const entry of latest.values()) entry.delivered = true;
  },
  reset() {
    latest.clear();
  },
};
