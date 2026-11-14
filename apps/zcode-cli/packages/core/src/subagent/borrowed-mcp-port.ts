import type { McpConnectionSnapshot, McpPort } from "@zcode/contracts";
import { SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE } from "./computer-use-policy.js";

// 子智能体借用的 MCP 只读视图：port 只允许转发 callTool，snapshot 是父启动快照的过滤投影。
export interface BorrowedSubagentMcpAccess {
  // 受限代理：拒绝生命周期变更，仅转发可见 server 的工具调用。
  port: McpPort;
  // 投影后的状态与工具描述符；只含 scope 内且已 connected 的 server，可能为空。
  snapshot: McpConnectionSnapshot;
}

// 由父 agent 的 MCP port 与启动快照派生出子 agent 的借用视图。
// scopedServerNames 为 undefined 表示不设白名单；传入空数组表示看不到任何 server。
// deniedServerNames 与 scope 独立求交且优先级更高，命中即视为不可见（如屏蔽官方 CUA）。
// 输入 parentStartupSnapshot 视为不可变快照，函数内只读，不做深拷贝以外的持久化。
// 无 IO、无事件、无日志：不连接、不断开，仅构造过滤后的内存视图。
// 空集合语义：父级未启动任何 server 时 status 为 {}、tools 为 []，调用方需容忍。
export function createBorrowedSubagentMcpAccess(
  parentPort: McpPort,
  parentStartupSnapshot: McpConnectionSnapshot,
  scopedServerNames?: readonly string[],
  deniedServerNames?: ReadonlySet<string>,
): BorrowedSubagentMcpAccess {
  // 复制成 Set，避免调用方后续修改原数组影响可见性判断。
  const scope = scopedServerNames === undefined ? undefined : new Set(scopedServerNames);
  const isDenied = (serverName: string): boolean => deniedServerNames?.has(serverName) === true;
  const isInScope = (serverName: string): boolean =>
    (scope === undefined || scope.has(serverName)) && !isDenied(serverName);
  // 只投影 visible 范围内的状态，避免子 agent 感知父级全量 MCP 连接情况。
  const statuses = Object.fromEntries(
    Object.entries(parentStartupSnapshot.statuses).filter(([serverName]) => isInScope(serverName)),
  );
  // 仅 connected 的 server 才暴露工具；connecting/failed/disabled 一律对子 agent 不可用。
  const connectedServerNames = new Set(
    Object.entries(statuses)
      .filter(([, status]) => status.status === "connected")
      .map(([serverName]) => serverName),
  );
  // 工具与状态口径必须一致：未 connected 的 server 即使有描述符也不导出。
  const snapshot: McpConnectionSnapshot = {
    statuses,
    tools: parentStartupSnapshot.tools.filter(
      (descriptor) =>
        isInScope(descriptor.serverName) && connectedServerNames.has(descriptor.serverName),
    ),
  };
  const rejectLifecycleMutation = (): never => {
    // child 借用 parent adapter，不拥有 MCP 连接生命周期。
    throw new Error("Subagent MCP port cannot mutate parent connection lifecycle");
  };

  return {
    snapshot,
    port: {
      async callTool(request, options) {
        // 先判 denied：被屏蔽的官方能力需要返回稳定的不可用错误，不能落成 scope 越界。
        if (isDenied(request.serverName)) {
          throw new Error(SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE);
        }
        // 未连接到快照中的 server 按越界拒绝，防止绕过投影直接调用父 port。
        if (!connectedServerNames.has(request.serverName)) {
          throw new Error(`Subagent MCP server is outside visible scope: ${request.serverName}`);
        }
        return parentPort.callTool(request, options);
      },
      async close() {
        // child 结束时不向 parent adapter 传播 close。
      },
      async connectConfiguredServers() {
        return rejectLifecycleMutation();
      },
      async connectServer() {
        return rejectLifecycleMutation();
      },
      async disconnectServer() {
        return rejectLifecycleMutation();
      },
      async listTools() {
        // 返回副本，防止调用方改动内部快照数组。
        return [...snapshot.tools];
      },
      async status() {
        // 浅拷贝维持只读视图语义；状态值本身不可变。
        return { ...snapshot.statuses };
      },
    },
  };
}
