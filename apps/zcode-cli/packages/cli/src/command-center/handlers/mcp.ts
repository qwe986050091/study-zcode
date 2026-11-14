import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps, CommandCenterMcpStatus } from "../types.js";
import { splitArgs } from "../utils.js";

// /mcp 用法提示：动作集合与下方分支保持一致，未知动作统一回落到该文案。
const MCP_COMMAND_USAGE = "Usage: /mcp [list|status|connect <server>|disconnect <server>]";

// 处理 /mcp：list/status 展示全部服务器状态；connect/disconnect 管理单个连接。
// 客户端不支持对应能力或缺少 server 参数时返回提示文本；connect 失败捕获错误并保留可读原因。
// 副作用：connect/disconnect 会改动真实 MCP 连接（可能启动/停止子进程），list 只读。
export async function handleMcpCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const [action = "list", serverName] = splitArgs(args);

  if (action === "list" || action === "status") {
    if (!app.listMcpServers) {
      return {
        mode: deps.getMode?.(),
        response: "MCP is not available in this client.",
      };
    }

    const statuses = await app.listMcpServers();
    return {
      mode: deps.getMode?.(),
      response: formatMcpStatusList(statuses),
    };
  }

  if (action === "connect") {
    if (!serverName) {
      return {
        mode: deps.getMode?.(),
        response: MCP_COMMAND_USAGE,
      };
    }
    if (!app.connectMcpServer) {
      return {
        mode: deps.getMode?.(),
        response: "MCP connection management is not available in this client.",
      };
    }
    try {
      const status = await app.connectMcpServer(serverName);
      return {
        mode: deps.getMode?.(),
        response: `MCP server ${formatMcpStatusLine(serverName, status)}.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        mode: deps.getMode?.(),
        response: `Unable to connect MCP server ${serverName}: ${message}`,
      };
    }
  }

  if (action === "disconnect") {
    if (!serverName) {
      return {
        mode: deps.getMode?.(),
        response: MCP_COMMAND_USAGE,
      };
    }
    if (!app.disconnectMcpServer) {
      return {
        mode: deps.getMode?.(),
        response: "MCP connection management is not available in this client.",
      };
    }
    const status = await app.disconnectMcpServer(serverName);
    return {
      mode: deps.getMode?.(),
      response: status
        ? `MCP server ${formatMcpStatusLine(serverName, status)}.`
        : `MCP server is not connected: ${serverName}`,
    };
  }

  return {
    mode: deps.getMode?.(),
    response: MCP_COMMAND_USAGE,
  };
}

// 状态列表格式化：按服务器名排序保证输出稳定；空记录返回「未配置」而非空行。
// status 的 toolCount/error 口径来自 app facade，error 仅在非空时以括号附加。
function formatMcpStatusList(statuses: Record<string, CommandCenterMcpStatus>): string {
  const entries = Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "No MCP servers configured.";
  }

  return [
    "MCP servers:",
    ...entries.map(([name, status]) => `- ${formatMcpStatusLine(name, status)}`),
  ].join("\n");
}

// 单行状态：`name: status via transport; N tools`，toolCount 为 1 时用单数；error 存在时附在末尾。
function formatMcpStatusLine(name: string, status: CommandCenterMcpStatus): string {
  const toolCount = status.toolCount === 1 ? "1 tool" : `${status.toolCount} tools`;
  const error = status.error ? ` (${status.error})` : "";
  return `${name}: ${status.status} via ${status.transport}; ${toolCount}${error}`;
}
