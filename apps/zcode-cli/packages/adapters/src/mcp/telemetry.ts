/* ============================================================
 * MCP 遥测 tracker（adapters/src/mcp/telemetry.ts）
 *
 * 定位：连接/进程级匿名遥测的唯一入口，并组合 resource-telemetry 上报内存样本。
 * 输入：连接注册、owner 获取/释放、进程启动/崩溃/关闭、会话启动汇总、内存采样。
 * 输出：ZCodeMcpTelemetryEvent（process_start / process_crash / memory / session_startup）。
 * 副作用：通过 onEvent 上报（可能走 IPC/网络）；启动资源采样定时器；不含文件 IO。
 * 失败语义：onEvent 抛错被吞——遥测是旁路，绝不能影响连接或进程回收。
 * 不变量：mcpId 对 custom/plugin 用 HMAC(idSalt) 截断 12 hex，绝不出现明文 server 名；
 * owner 集合决定无主时长与 orphan 判定；registration 只能由 pool 的 closeEntry 注销。
 * ============================================================ */

import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import type { ZCodeMcpTelemetryEvent } from "@zcode/shared";
import {
  createMcpResourceTelemetry,
  type McpResourceTelemetryOptions,
} from "./resource-telemetry.js";

const BUILTIN_MCP_ID_PREFIX = "builtin:";
const BUILTIN_NODE_REPL_SERVER_NAME = "node_repl";
const MCP_ID_SAFE_CHARACTER_PATTERN = /^[A-Za-z0-9._~-]$/;
const PLUGIN_MCP_NAMESPACE_PREFIX = "plugin:";

/** 对外事件类型别名（来自 @zcode/shared，保证 host/CLI 协议一致）。 */
export type McpTelemetryEvent = ZCodeMcpTelemetryEvent;
/** 来源三分类：builtin（官方 node_repl）/ plugin（插件命名空间）/ custom（用户配置）。 */
export type McpTelemetrySource = Extract<
  ZCodeMcpTelemetryEvent,
  { kind: "process_start" }
>["mcpSource"];
/** 隔离级别（进程内 / 独立进程等），由连接创建方声明，tracker 原样透传。 */
export type McpTelemetryIsolation = Extract<
  ZCodeMcpTelemetryEvent,
  { kind: "process_start" }
>["mcpIsolation"];
/** 进程启动后返回的身份对：mcpId 稳定（配置维度），mcpInstanceId 每次启动随机。 */
export interface McpProcessTelemetryIdentity {
  mcpId: string;
  mcpInstanceId: string;
}

/**
 * 资源管理器用的 MCP 子进程视图：只回 pid 与归属，不含任何采样值。
 * 这里保留明文 serverName / pluginName——只在本机 host ↔ CLI 之间流转，
 * 不出本机，无需脱敏；Host 用它把 ps 进程树上的 pid 归到具体插件。
 */
export interface McpTrackedProcess {
  pid: number;
  serverName: string;
  mcpSource: McpTelemetrySource;
  /** `plugin:<name>:<key>` 命名空间里的插件名；builtin host MCP（node_repl）由调用方按官方插件表补齐 */
  pluginName?: string;
}

/**
 * tracker 对外契约：所有方法均同步完成（sampleNow 除外），无 I/O。
 *
 * registerConnection 必须在 spawn 前调用；recordProcessStarted 之后才有 listProcesses 条目；
 * acquireOwner/releaseOwner 维护“谁在用”以计算 orphan；unregisterConnection 是终态注销。
 * 任何非法入参（未知 connectionId、非法 pid）都是静默空操作，不抛错。
 */
export interface McpTelemetryTracker {
  acquireOwner(input: { connectionId: string; ownerId: string; sessionId?: string }): void;
  recordSessionStartup(input: {
    configuredCount: number;
    connectedCount: number;
    failedCount: number;
    processCount: number;
    sessionId: string;
  }): void;
  recordProcessCrashed(input: {
    connectionId: string;
    exitCode: number | null;
    signal: string | null;
  }): void;
  recordProcessClosed(input: { connectionId: string }): void;
  recordProcessStarted(input: {
    connectionId: string;
    pid: number;
  }): McpProcessTelemetryIdentity | undefined;
  releaseOwner(input: { connectionId: string; ownerId: string }): void;
  registerConnection(input: {
    connectionId: string;
    isolation: McpTelemetryIsolation;
    serverName: string;
    source?: McpTelemetrySource;
  }): void;
  unregisterConnection(input: { connectionId: string }): void;
  /** 当前仍有存活进程记录的 MCP 连接（纯内存，无 I/O） */
  listProcesses(): McpTrackedProcess[];
  sampleNow(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * 构造参数：idSalt 为 HMAC 盐（必填，避免明文名可被字典反推）；
 * onEvent 为上报出口；now/randomId/platform/arch 可注入；
 * 其余为资源采样透传（探针、CPU 核数、总内存、定时器）。
 */
export interface CreateMcpTelemetryTrackerOptions {
  arch?: ZCodeMcpTelemetryEvent["arch"];
  idSalt: string;
  now?: () => number;
  onEvent(event: McpTelemetryEvent): void;
  platform?: ZCodeMcpTelemetryEvent["platform"];
  randomId?: () => string;
  onResourceSamples?: McpResourceTelemetryOptions["onResourceSamples"];
  processProbe?: McpResourceTelemetryOptions["processProbe"];
  logicalCpuCount?: number;
  totalMemoryGb?: number;
  timer?: McpResourceTelemetryOptions["timer"];
}

/**
 * 内部连接状态。
 * owners：ownerId → sessionId（sessionId 可缺省）；process 存在即代表有存活进程；
 * unownedAt：owner 归零的 epoch ms，仅内存使用，用于 orphan 判定；
 * process.startedAt：启动时刻，用于 crash 时计算 uptimeMs。
 */
interface TrackedConnection {
  connectionId: string;
  isolation: McpTelemetryIsolation;
  mcpId: string;
  mcpSource: McpTelemetrySource;
  serverName: string;
  owners: Map<string, string | undefined>;
  process?: {
    instanceId: string;
    pid: number;
    startedAt: number;
  };
  unownedAt?: number;
}

/**
 * 创建 tracker。
 *
 * 维护 connections 内存表；把资源采样器接上（getProcesses 每次现取当前有进程的连接）。
 * 返回 tracker 实例：start/stop 转交采样器；所有记录方法均为内存写入 + 旁路 emit。
 * 副作用：仅 start() 会创建定时器；失败由采样器自己吞掉。
 */
export function createMcpTelemetryTracker(
  options: CreateMcpTelemetryTrackerOptions,
): McpTelemetryTracker {
  const arch = options.arch ?? (process.arch as ZCodeMcpTelemetryEvent["arch"]);
  const now = options.now ?? Date.now;
  const platform = options.platform ?? (process.platform as ZCodeMcpTelemetryEvent["platform"]);
  const randomId = options.randomId ?? randomUUID;
  const connections = new Map<string, TrackedConnection>();
  const emit = (event: McpTelemetryEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      // 遥测为旁路，下游通知或 IPC 关闭不得改变 MCP 连接、回收或 crash 处理。
    }
  };

  const resourceTelemetry = createMcpResourceTelemetry({
    ...options,
    arch,
    platform,
    now,
    getProcesses: () =>
      [...connections.values()].flatMap((connection) => {
        const trackedProcess = connection.process;
        if (!trackedProcess) return [];
        return [
          {
            ...trackedProcess,
            mcpId: connection.mcpId,
            isCurrent: () =>
              connections.get(connection.connectionId) === connection &&
              connection.process === trackedProcess,
            observed(samples, sampledAt, memoryScope) {
              // 进程在 OS 上已不可见：无 owner 时立刻回收 registration，避免残留条目永久泄漏。
              if (!samples) {
                if (connection.owners.size === 0) {
                  connection.process = undefined;
                  connections.delete(connection.connectionId);
                }
                return;
              }
              const sessionIds = new Set(
                [...connection.owners.values()].filter((id) => id !== undefined),
              );
              const unownedMs =
                connection.owners.size === 0 && connection.unownedAt !== undefined
                  ? Math.max(0, sampledAt - connection.unownedAt)
                  : 0;
              // 保留 tracker 内部孤儿观测口径；bootstrap 不再把旧 memory 事实发上协议。
              emit({
                arch,
                kind: "memory",
                mcpId: connection.mcpId,
                mcpInstanceId: trackedProcess.instanceId,
                mcpIsolation: connection.isolation,
                mcpSource: connection.mcpSource,
                platform,
                occurredAt: sampledAt,
                memoryKb: samples.reduce((total, sample) => total + sample.rssKb, 0),
                memoryScope,
                // 无主超过 60s 才标记 orphanSuspected：给短暂 idle grace / 重连留出窗口。
                orphanSuspected: connection.owners.size === 0 && unownedMs > 60_000,
                ownerSessionCount: sessionIds.size,
                unownedSeconds: unownedMs / 1_000,
              });
            },
          },
        ];
      }),
  });

  return {
    /** 登记 owner（可带 sessionId）；已知连接的重复 acquire 幂等，并清除无主计时。 */
    acquireOwner(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      connection.owners.set(input.ownerId, input.sessionId);
      connection.unownedAt = undefined;
    },
    /**
     * 记录进程崩溃：清理 process 记录并上报 crash，uptime 用 now - startedAt（下限 0）。
     * 连接 registration 保留，供 owner 继续使用/后续重连复用。
     */
    recordProcessCrashed(input) {
      const connection = connections.get(input.connectionId);
      const trackedProcess = connection?.process;
      if (!connection || !trackedProcess) return;
      connection.process = undefined;
      const occurredAt = now();
      const sessionIds = new Set(
        [...connection.owners.values()].filter(
          (sessionId): sessionId is string => sessionId !== undefined,
        ),
      );
      emit({
        affectedSessionCount: sessionIds.size,
        arch,
        exitCode: input.exitCode,
        kind: "process_crash",
        mcpId: connection.mcpId,
        mcpInstanceId: trackedProcess.instanceId,
        mcpIsolation: connection.isolation,
        mcpSource: connection.mcpSource,
        occurredAt,
        platform,
        signal: input.signal,
        uptimeMs: Math.max(0, occurredAt - trackedProcess.startedAt),
      });
    },
    /** 正常关闭：清除进程；仅当没有 owner 时才可安全删除 registration（否则重连会失联）。 */
    recordProcessClosed(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      connection.process = undefined;
      if (connection.owners.size === 0) connections.delete(input.connectionId);
    },
    /**
     * 记录进程启动：校验 pid 后生成新的 mcpInstanceId 并上报 process_start。
     * 无 owner 时开始 orphan 计时；返回身份对供 adapter 关联资源样本。
     */
    recordProcessStarted(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !Number.isInteger(input.pid) || input.pid <= 0) return undefined;
      const mcpInstanceId = randomId();
      const occurredAt = now();
      connection.process = {
        instanceId: mcpInstanceId,
        pid: input.pid,
        startedAt: occurredAt,
      };
      if (connection.owners.size === 0) connection.unownedAt ??= occurredAt;
      emit({
        arch,
        kind: "process_start",
        mcpId: connection.mcpId,
        mcpInstanceId,
        mcpIsolation: connection.isolation,
        mcpSource: connection.mcpSource,
        occurredAt,
        platform,
      });
      return { mcpId: connection.mcpId, mcpInstanceId };
    },
    /** 会话启动汇总：只上报计数，不含 server 名等可识别信息。 */
    recordSessionStartup(input) {
      emit({
        arch,
        configuredCount: input.configuredCount,
        connectedCount: input.connectedCount,
        failedCount: input.failedCount,
        kind: "session_startup",
        occurredAt: now(),
        platform,
        processCount: input.processCount,
        sessionId: input.sessionId,
      });
    },
    /**
     * 释放 owner：仅当确实删除成功且已归零时记录 unownedAt。
     * 故意不删除 registration（见下方注释），终态注销只由 pool closeEntry 触发。
     */
    releaseOwner(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !connection.owners.delete(input.ownerId)) return;
      if (connection.owners.size !== 0) return;
      connection.unownedAt = now();
      // process crash 后最后一个 owner 释放时，pool entry 仍会在 idle grace 内存活。
      // 此处提前删除 registration 会让同一 workspace entry 被复用后的新进程永久失去遥测。
      // registration 的终态由 pool closeEntry 显式 unregister，owner 释放只记录无主时间。
    },
    /**
     * 注册连接：解析来源并生成匿名 mcpId，初始化空 owner 表。
     * 同 connectionId 重复注册会覆盖旧状态，调用方需保证先 unregister。
     */
    registerConnection(input) {
      const mcpSource = input.source ?? resolveMcpSource(input.serverName);
      connections.set(input.connectionId, {
        connectionId: input.connectionId,
        isolation: input.isolation,
        mcpId: resolveMcpId(input.serverName, mcpSource, options.idSalt),
        mcpSource,
        serverName: input.serverName,
        owners: new Map(),
      });
    },
    /**
     * 终态注销：清空 owners 并开始无主计时。
     * 若 process 仍存在（回收失败）则保留 registration，让后续采样标记 orphan，
     * 直到进程关闭或 OS 已不可见再删除。
     */
    unregisterConnection(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      // pool entry 已进入终态，残留 lease 不能继续被视为 owner；若进程树回收失败则保留
      // process 供后续采样标记 orphan，确认进程关闭或 OS 不再可见后再删除 registration。
      connection.owners.clear();
      connection.unownedAt ??= now();
      if (!connection.process) connections.delete(input.connectionId);
    },
    /** 当前有存活进程的连接快照（本机明文 serverName，仅 host↔CLI 内部使用）。 */
    listProcesses() {
      const processes: McpTrackedProcess[] = [];
      for (const connection of connections.values()) {
        if (!connection.process) continue;
        const pluginName = resolvePluginName(connection.serverName);
        processes.push({
          pid: connection.process.pid,
          serverName: connection.serverName,
          mcpSource: connection.mcpSource,
          ...(pluginName ? { pluginName } : {}),
        });
      }
      return processes;
    },
    sampleNow: resourceTelemetry.sampleNow,
    start: resourceTelemetry.start,
    stop: resourceTelemetry.stop,
  };
}

/** `plugin:<name>:<key>` → `<name>`；非插件命名空间返回 undefined */
/**
 * `plugin:<name>:<key>` → `<name>`；非插件命名空间返回 undefined。
 * name 去除首尾空白后为空也返回 undefined；不做任何网络/IO。
 */
export function resolvePluginName(serverName: string): string | undefined {
  if (!serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)) return undefined;
  const name = serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length).split(":")[0]?.trim();
  return name ? name : undefined;
}

/**
 * 由 serverName 推断来源：node_repl → builtin；plugin: 前缀 → plugin；其余 custom。
 * 仅做字符串判断，无副作用。
 */
function resolveMcpSource(serverName: string): McpTelemetrySource {
  if (serverName === BUILTIN_NODE_REPL_SERVER_NAME) return "builtin";
  return serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX) ? "plugin" : "custom";
}

/**
 * 生成匿名 mcpId。
 * builtin：保留可读名（官方组件，非用户隐私）并逐段百分号转义；
 * plugin/custom：HMAC-SHA256(idSalt, serverName) 取前 12 hex，不可逆，避免明文配置名外泄。
 */
function resolveMcpId(serverName: string, source: McpTelemetrySource, idSalt: string): string {
  if (source === "builtin") {
    const publicName = serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)
      ? serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length)
      : serverName;
    return `${BUILTIN_MCP_ID_PREFIX}${publicName.split(":").map(encodeMcpIdSegment).join(":")}`;
  }
  const digest = createHmac("sha256", idSalt).update(serverName).digest("hex").slice(0, 12);
  return `${source}:${digest}`;
}

function encodeMcpIdSegment(value: string): string {
  // 原因：encodeURIComponent 遇到孤立 surrogate 会抛 URIError，遥测编码不能反向阻断 MCP 启动。
  // Buffer 的 UTF-8 编码会把畸形序列替换为 U+FFFD，再逐字节转义成协议允许的稳定 `%HH`。
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    encoded += MCP_ID_SAFE_CHARACTER_PATTERN.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}
