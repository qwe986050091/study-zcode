import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";
import { matchesModelVisibleMcpServerName } from "../mcp/name.js";

// agent profile 中 mcpServers 声明的解析结果。
export interface ParsedAgentMcpServers {
  // 配置存在但结构非法（type 与必填字段不匹配）的 server 名，保持原声明顺序。
  invalidServerNames: string[];
  // 按名称引用但未在全局配置中定义的 server 名；空数组表示全部命中。
  missingServerNames: string[];
  // 解析成功的 server 配置副本（按名称索引），可直接用作 scope 白名单来源。
  scopedServers: Record<string, McpServerConfig>;
}

// 解析 profile 的 mcpServers 声明。输入支持两种写法：
// 1) 字符串数组，按名称引用全局已配置 server；2) 对象/对象数组，直接内联完整配置。
// 输出拆分为 invalid/missing/scoped 三类，便于上层分别告警与过滤。
// 语义：mcpServers 为 undefined 表示未声明，返回三个空集合；重复声明后者覆盖前者。
// 无 IO、无副作用；不修改入参，scopedServers 为新对象。
export function parseAgentMcpServers(
  mcpServers: readonly unknown[] | undefined,
  configuredServers: Record<string, McpServerConfig>,
): ParsedAgentMcpServers {
  const invalidServerNames: string[] = [];
  const missingServerNames: string[] = [];
  const scopedServers: Record<string, McpServerConfig> = {};
  for (const spec of mcpServers ?? []) {
    // 名称引用分支：空串或纯空白不构成有效声明，静默跳过。
    if (typeof spec === "string" && spec.trim().length > 0) {
      const serverName = spec.trim();
      const config = configuredServers[serverName];
      // 未配置与配置非法属于两种不同问题，分别落到 missing / invalid 以便区分提示。
      if (!config) {
        missingServerNames.push(serverName);
      } else if (!isMcpServerConfig(config)) {
        invalidServerNames.push(serverName);
      } else {
        scopedServers[serverName] = config;
      }
      continue;
    }
    // 非对象值（null/数组/基础类型）无法解释为内联配置，直接忽略。
    if (!isRecord(spec)) continue;
    for (const [serverName, config] of Object.entries(spec)) {
      const normalizedServerName = serverName.trim();
      if (normalizedServerName.length === 0) continue;
      // 内联配置缺少全局查找步骤，非法结构直接记 invalid 而不会进入 missing。
      if (!isMcpServerConfig(config)) {
        invalidServerNames.push(normalizedServerName);
        continue;
      }
      scopedServers[normalizedServerName] = config;
    }
  }
  return { invalidServerNames, missingServerNames, scopedServers };
}

// 判断 required-server 约束是否满足：`*` 表示只需任一 server 处于 connected；
// 具体名称按模型可见命名规则做忽略大小写匹配，且必须处于 connected 状态。
// 输入 statuses 可能为空对象（尚未连接任何 server），此时除 `*` 外一律返回 false。
// 纯判断，无 IO；不触发连接，也不修改状态。
export function matchesRequiredMcpServer(
  requiredName: string,
  statuses: Record<string, McpServerStatus>,
): boolean {
  // 通配符语义是“至少有一个可用连接”，而不是“所有连接都可用”。
  if (requiredName === "*") {
    return Object.values(statuses).some((status) => status.status === "connected");
  }
  const expected = requiredName.toLowerCase();
  return Object.entries(statuses).some(
    ([serverName, status]) =>
      status.status === "connected" &&
      // MCP tool name 会把 plugin:android-emulator:android-emulator
      // 规范化成 plugin_android-emulator_android-emulator；required-server 检查
      // 必须使用同一套模型可见命名规则，否则已连接的 plugin MCP 会被误判为 missing。
      matchesModelVisibleMcpServerName(expected, serverName),
  );
}

// 判断 required-server 约束在“profile 已声明的 scope 内”是否满足。
// 与 matchesRequiredMcpServer 的差异：只看已声明的 server 集合，不看运行时连接状态。
// `*` 在 scope 语义下表示“至少声明了一个 server”；空集合时返回 false。
export function matchesScopedMcpServer(
  requiredName: string,
  scopedServers: Record<string, McpServerConfig>,
): boolean {
  const serverNames = Object.keys(scopedServers);
  if (requiredName === "*") return serverNames.length > 0;
  return serverNames.some((serverName) =>
    matchesModelVisibleMcpServerName(requiredName, serverName),
  );
}

// 从工具白名单中提取 required-server 声明（形如 `mcp__<server>__<tool>`）。
// 输出去重且保持首次出现顺序；`mcp__*` / `mcp` 归一为 `*`。
// 非 MCP 工具名（不含 `mcp__` 前缀）不产生条目，空数组表示无 MCP 约束。
export function extractRequiredMcpServerNames(allowedTools: readonly string[]): string[] {
  const names = new Set<string>();
  for (const tool of allowedTools) {
    const requiredName = extractRequiredMcpServerName(tool);
    if (requiredName) names.add(requiredName);
  }
  return [...names];
}

// 单个工具名 → server 名。`mcp__*` 与裸 `mcp` 视为通配 `*`；
// 其余要求 `mcp__` 前缀且 server 段非空，否则返回 undefined（表示不是 MCP 约束）。
function extractRequiredMcpServerName(tool: string): string | undefined {
  const trimmed = tool.trim();
  if (trimmed === "mcp__*" || trimmed === "mcp") return "*";
  if (!trimmed.startsWith("mcp__")) return undefined;
  const [, serverName] = trimmed.split("__");
  return serverName && serverName.length > 0 ? serverName : undefined;
}

// 运行期校验 MCP server 配置的最小必要字段：stdio 需要 command，
// http/sse 需要 url；未知 type 或缺失字段一律判非法（不做默认值填充）。
function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isRecord(value)) return false;
  if (value.type === "stdio") return typeof value.command === "string";
  if (value.type === "http" || value.type === "sse") return typeof value.url === "string";
  return false;
}

// 排除数组与 null：两者 typeof 均为 object，但不是可枚举键值配置对象。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
