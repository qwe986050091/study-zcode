// filesystem MCP 的 workspace 注入：只补命令行参数，不修改用户持久化配置。
import { existsSync } from "node:fs";
import { normalize } from "node:path";
import type { ZCodeAgentMcpServer } from "@zcode/shared";

// 比较用归一：去尾部斜杠；Windows 下再转小写。
// 归一结果仅用于判重，不会替换实际参数值。
function normalizePathForCompare(value: string): string {
  const normalized = normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// 只识别官方 filesystem server：名称命中且参数里出现对应包名。
// 其它自定义 MCP 即使名字相同也不能被注入。
function isFilesystemServer(
  server: ZCodeAgentMcpServer,
): server is Extract<ZCodeAgentMcpServer, { command: string }> {
// 三个条件必须同时满足，避免误改同名但不同实现的服务。
  return (
    "command" in server &&
    server.name === "filesystem" &&
    server.args.some((arg) => arg.includes("@modelcontextprotocol/server-filesystem"))
  );
}

// 对外入口：输入为空或 workspace 不存在时原样返回，不创建新数组。
// 返回同一引用表示未发生修改，调用方可用引用比较决定是否重写配置。
export function appendWorkspaceToFilesystemMcpServers(
  mcpServers: ZCodeAgentMcpServer[] | undefined,
  workspacePath: string,
): ZCodeAgentMcpServer[] | undefined {
// 无配置时不注入，避免凭空创建 filesystem server。
  if (!mcpServers || mcpServers.length === 0) {
    return mcpServers;
  }

// 先 trim 再判存在，避免尾部空格导致 existsSync 误判。
  const trimmedWorkspacePath = workspacePath.trim();
  if (!trimmedWorkspacePath || !existsSync(trimmedWorkspacePath)) {
    return mcpServers;
  }

  let changed = false;
  const workspaceKey = normalizePathForCompare(trimmedWorkspacePath);
  const nextServers = mcpServers.map((server) => {
    if (!isFilesystemServer(server)) {
      return server;
    }

    const hasWorkspace = server.args.some((arg) => normalizePathForCompare(arg) === workspaceKey);
    if (hasWorkspace) {
      return server;
    }

    changed = true;
    // 用户目录里的 filesystem MCP 可能只包含固定目录，
    // 不会自动允许当前 workspace，导致 agent 写当前项目文件时报
    // "Access denied - path outside allowed directories"。这里仅在本机路径存在时
    // 非持久化追加当前 workspace，避免远程 workspace 被误注入本机 MCP。
    return {
      ...server,
      args: [...server.args, trimmedWorkspacePath],
    };
  });

  return changed ? nextServers : mcpServers;
}
