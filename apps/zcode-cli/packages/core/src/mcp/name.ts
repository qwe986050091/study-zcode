import type { McpToolDescriptor } from "@zcode/contracts";

// 把 MCP 工具描述符归一化为模型可见工具名。
// descriptor.name 已存在时直接采用（视为权威已注册名），否则拼成 mcp__<server>__<tool>。
// 拼装前对 server/tool 段做字符清洗，避免空格、点号等破坏工具名字符集。
// 纯函数，无副作用；不保证全局唯一，同名冲突由上层注册表处理。
export function toMcpToolName(
  descriptor: Pick<McpToolDescriptor, "name" | "serverName" | "toolName">,
): string {
  return (
    descriptor.name ??
    `mcp__${toModelVisibleMcpNamePart(descriptor.serverName)}__${toModelVisibleMcpNamePart(
      descriptor.toolName,
    )}`
  );
}

// 将任意名称清洗为模型/工具名可用的片段：非 [a-zA-Z0-9_-] 字符替换为下划线，
// 连续下划线折叠成一个，保证拼接结果稳定且不与分隔符 mcp__ 混淆。
// 清洗后为空（如全为符号或空串）时返回 "unknown"，避免生成空片段。
// 不 trim、不改大小写，大小写差异由调用方比较逻辑自行归一。
export function toModelVisibleMcpNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

// 判断 server 名是否匹配需求名：同时比较原始名与清洗后的模型可见名，大小写不敏感。
// requiredName 为空白时直接返回 false，避免 "" 通过 includes 匹配到任意服务器。
// 除精确匹配外还接受子串包含，兼容 "plugin/foo" 与 "foo" 这类前缀/命名空间差异；
// 该宽松度只用于查找提示，不可用于权限判定。
export function matchesModelVisibleMcpServerName(
  requiredName: string,
  serverName: string,
): boolean {
  const expected = requiredName.trim().toLowerCase();
  if (expected.length === 0) return false;

  const rawServerName = serverName.trim().toLowerCase();
  const modelVisibleServerName = toModelVisibleMcpNamePart(serverName).toLowerCase();

  return (
    rawServerName === expected ||
    modelVisibleServerName === expected ||
    rawServerName.includes(expected) ||
    modelVisibleServerName.includes(expected)
  );
}
