// INV-01 未配置上下文时直接丢弃：守住位置 早退判断；改错故障 启动阶段上报缺字段。
// INV-02 内存事件不再生成上报：守住位置 种类判断；改错故障 已废弃事件继续进报表。
// INV-03 映射结果与事件一一对应：守住位置 分支表；改错故障 新种类被静默忽略。
// INV-04 发送异常只记警告：守住位置 捕获分支；改错故障 遥测失败影响业务。
// INV-05 属性统一转字符串：守住位置 序列化函数；改错故障 报表字段类型漂移。
// INV-06 空值属性直接剔除：守住位置 过滤条件；改错故障 报表出现字符串空值。
// INV-07 平台名归一为三种：守住位置 分支顺序；改错故障 报表出现两套平台写法。
// INV-08 进程事件共享公共字段：守住位置 辅助函数；改错故障 两条事件字段不一致。
// INV-09 崩溃事件追加影响面：守住位置 属性合并；改错故障 无法评估崩溃波及范围。
// INV-10 启动事件值为常量一：守住位置 字面量；改错故障 计数被当成耗时。
// INV-11 会话启动事件以进程数为值：守住位置 取值字段；改错故障 图表失去量纲。
// INV-12 事件名使用固定前缀：守住位置 名称字面量；改错故障 报表过滤条件失效。
// INV-13 分组只分资源与稳定性：守住位置 联合类型；改错故障 新分组破坏看板。
// INV-14 运行时面由调用方传入：守住位置 参数穿透；改错故障 本地与远程事件混淆。
// INV-15 发生时字段来自事件：守住位置 属性取值；改错故障 报表时间偏移。
// INV-16 架构字段直接透传：守住位置 属性取值；改错故障 下载包统计缺失维度。
// INV-17 配置函数只覆盖上下文：守住位置 赋值范围；改错故障 重配时清空已发缓存。
// INV-18 模块无发送队列：守住位置 同步调用；改错故障 退出时事件批量丢失。
//
// 模块职责：把 MCP 遥测事件映射为自定义上报事件并发送。
// 状态所有权：仅有一个模块级 context，由 configureDesktopMcpTelemetry 整体替换。
// 阅读顺序：先看发送入口，再看事件映射，最后看属性序列化。
import armsRum from "@arms/rum-electron";
import type { ZCodeMcpTelemetryEvent } from "@zcode/shared";

interface DesktopMcpTelemetryContext {
  appVersion: string;
  armsEnv: string;
  deviceMid: string;
}

let context: DesktopMcpTelemetryContext | undefined;

export function configureDesktopMcpTelemetry(next: DesktopMcpTelemetryContext): void {
  context = next;
}

// 未配置 context 时直接丢弃；kind 为 memory 的内存事件不再生成上报；sendCustom 异常只记警告；runtimeSurface 由调用方传入。
export function reportMcpTelemetryToArms(
  event: ZCodeMcpTelemetryEvent,
  runtimeSurface: "local" | "remote",
): void {
  // 旧 CLI 的内存通知仍允许协议解析，但不能再生成已废弃的 ARMS 事件。
  if (!context || event.kind === "memory") return;
  const mapped = mapMcpTelemetryEvent(event);
  try {
    armsRum.sendCustom({
      group: mapped.group,
      name: mapped.name,
      properties: stringifyProperties({
        app_version: context.appVersion,
        arms_env: context.armsEnv,
        device_mid: context.deviceMid,
        event_name: mapped.name,
        metric_value: mapped.value,
        runtime_surface: runtimeSurface,
        platform: normalizePlatform(event.platform),
        arch: event.arch,
        occurred_at: event.occurredAt,
        ...mapped.properties,
      }),
      type: "custom",
      value: mapped.value,
    });
  } catch (error) {
    console.warn("[mcp-telemetry] sendCustom failed:", mapped.name, error);
  }
}

// process_start 与 process_crash 归 stability；session_startup 汇总连接数量；事件名统一使用 perf_mcp_ 固定前缀。
function mapMcpTelemetryEvent(event: Exclude<ZCodeMcpTelemetryEvent, { kind: "memory" }>): {
  group: "resource" | "stability";
  name: string;
  properties: Record<string, string | number | boolean | undefined | null>;
  value: number;
} {
  switch (event.kind) {
    case "process_start":
      return {
        group: "stability",
        name: "perf_mcp_process_start",
        properties: processProperties(event),
        value: 1,
      };
    case "process_crash":
      return {
        group: "stability",
        name: "perf_mcp_process_crash",
        properties: {
          ...processProperties(event),
          affected_session_count: event.affectedSessionCount,
          exit_code: event.exitCode,
          signal: event.signal,
          uptime_ms: event.uptimeMs,
        },
        value: 1,
      };
    case "session_startup":
      return {
        group: "stability",
        name: "perf_mcp_session_startup",
        properties: {
          session_id: event.sessionId,
          configured_count: event.configuredCount,
          connected_count: event.connectedCount,
          process_count: event.processCount,
          failed_count: event.failedCount,
        },
        value: event.processCount,
      };
  }
}

function processProperties(
  event: Extract<ZCodeMcpTelemetryEvent, { kind: "process_start" | "process_crash" }>,
): Record<string, string> {
  return {
    mcp_id: event.mcpId,
    mcp_instance_id: event.mcpInstanceId,
    mcp_isolation: event.mcpIsolation,
    mcp_source: event.mcpSource,
  };
}

// 空值属性直接剔除；其余值统一 String 转字符串；返回新对象不改入参。
function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] != null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function normalizePlatform(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}
