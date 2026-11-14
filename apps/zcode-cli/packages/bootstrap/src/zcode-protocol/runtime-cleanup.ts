import type { Logger, McpPort } from "@zcode/contracts";
import type { McpConnectionPool, McpTelemetryTracker } from "@zcode/adapters/mcp";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import { shutdownPreparedModelTelemetry } from "@zcode/telemetry";
import { closeSessionStore } from "../app/session-store.js";
import type { NodeReplBrowserBroker } from "../app/node-repl-browser-broker.js";
import type { ZCodeProcessResourceSampler } from "../process-resource-sampler.js";
import type { ZCodeProtocolAgentServer } from "./server.js";

const DEFAULT_CLEANUP_BUDGET_MS = 1_200;
const CLEANUP_STEP_BUDGET_MS = 400;

/**
 * 协议进程的统一清理：按"遥测/采样 → 会话 runtime → 投影 → MCP 连接 → 存储 → provider/telemetry"
 * 的逆启动顺序释放，任一步失败只记 warn 并继续。所有步骤共享一个绝对 deadline（默认 1.2s，
 * 单步最多 400ms），不因某项挂起而无限等待；所有权由调用方通过可选端口传入，未传即跳过。
 * mcpPort 与 mcpConnectionPool 并列释放：port 挂起时 pool 仍必须被 close。
 */
export async function cleanupProtocolRuntime(options: {
  logger: Logger;
  deadlineAt?: number;
  server?: Pick<ZCodeProtocolAgentServer, "shutdown" | "disposeProjections">;
  processResourceSampler?: Pick<ZCodeProcessResourceSampler, "stop">;
  mcpTelemetryTracker?: Pick<McpTelemetryTracker, "stop">;
  nodeReplBrowserBroker?: Pick<NodeReplBrowserBroker, "close">;
  mcpPort?: Pick<McpPort, "close">;
  mcpConnectionPool?: Pick<McpConnectionPool, "close">;
  sessionStore?: SqliteSessionStore;
  providerRegistryRuntime?: { dispose(): unknown };
}): Promise<void> {
  const deadline = options.deadlineAt ?? Date.now() + DEFAULT_CLEANUP_BUDGET_MS;
  // 单步包装：失败/超时只记录，不向上抛；timeout 取剩余预算与单步预算的较小值。
  const step = async (resource: string, cleanup: () => unknown | Promise<unknown>) => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      // 共用绝对 deadline；某项失败/挂起不阻止其余资源被尝试，也不逐项续时。
      await Promise.race([
        Promise.resolve().then(cleanup),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Protocol cleanup timed out")),
            Math.max(0, Math.min(CLEANUP_STEP_BUDGET_MS, deadline - Date.now())),
          );
        }),
      ]);
    } catch (error) {
      options.logger.warn(`ZCode Protocol ${resource} shutdown failed`, {
        errorType: error instanceof Error ? error.name : typeof error,
        event: `zcode_protocol.${resource}.shutdown.failed`,
        module: "bootstrap.zcode_protocol",
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  await Promise.all([
    step("sampler", () => options.processResourceSampler?.stop()),
    step("mcp_telemetry", () => options.mcpTelemetryTracker?.stop()),
  ]);
  await step("sessions", () => options.server?.shutdown());
  await step("projections", () => options.server?.disposeProjections());
  await Promise.all([
    step("node_repl_browser_broker", () => options.nodeReplBrowserBroker?.close()),
    // 不能在同一个 finally 内 await：port 挂起时 pool 仍必须得到 close。
    step("mcp", () => options.mcpPort?.close()),
    step("mcp_pool", () => options.mcpConnectionPool?.close()),
  ]);
  await Promise.all([
    step("session_store", () => {
      if (options.sessionStore) closeSessionStore(options.sessionStore);
    }),
    step("provider_registry", () => options.providerRegistryRuntime?.dispose()),
    step("telemetry", () => shutdownPreparedModelTelemetry()),
  ]);
}
