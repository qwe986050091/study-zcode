/* ============================================================
 * MCP 工具描述符归一化（adapters/src/mcp/descriptor.ts）
 *
 * 定位：把 tools/list 返回的原始 tool 对象转成内部稳定的 McpToolDescriptor，
 * 是 MCP 插件/官方 server 与 core 工具表之间唯一的形状收敛点。
 * 输入：serverName、原始 tool（unknown，来自不受信任的 server）、服务器级超时、
 * official / alwaysLoad 标记。输出：字段齐全的 descriptor；输入非法时按保守默认值
 * 补齐而绝不抛错（一个坏工具不能拖垮整个 server 的工具列表）。
 * 副作用：无 IO、无网络、无子进程；纯函数。
 * 失败语义：不抛错；缺失字段用 "unknown" / 空 schema / undefined 代替。
 * 不变量：工具名的命名空间固定为 mcp__<server>__<tool>，同名 server 或工具中的
 * 非安全字符统一折叠为下划线，保证跨 server 不串名、跨平台可作工具标识。
 * ============================================================ */

import {
  MCP_TOOL_META_TIMEOUT_MAX_MS,
  MCP_TOOL_META_TIMEOUT_MIN_MS,
  type JsonSchema,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from "@zcode/contracts";
import { normalizeMcpToolUiMeta, readMcpToolVisibility } from "@zcode/shared/mcp-apps";

/**
 * 归一化单个 MCP 工具描述符。
 *
 * - serverName：所属 server 的注册名，参与命名空间前缀；
 * - tool：原始 tools/list 条目，允许任意形状，非法字段静默忽略；
 * - timeoutMs：服务器级默认超时（毫秒），可被工具级 `_meta.timeoutMs` 覆盖；
 * - official：仅当来自已校验 origin 的官方 HTTP MCP 时为 true，决定错误标识能否被信任；
 * - alwaysLoad：宿主强制常驻工具表的标记，与 `_meta["anthropic/alwaysLoad"]` 取或。
 * 返回 descriptor：name 为 `mcp__server__tool`，visibility 与 ui 同时归一化，
 * 下游（core 工具表）不再读取原始 `_meta`。无副作用、不抛错。
 */
export function normalizeMcpToolDescriptor(
  serverName: string,
  tool: unknown,
  timeoutMs?: number,
  official?: boolean,
  alwaysLoad?: boolean,
): McpToolDescriptor {
  const record = isRecord(tool) ? tool : {};
  const meta = isRecord(record._meta) ? record._meta : {};
  const toolName = typeof record.name === "string" ? record.name : "unknown";
  // 插件 UI：tools/list 的 `_meta` 只在这里读一次，归一化成 descriptor.ui；下游不再碰原始 _meta。
  const ui = normalizeMcpToolUiMeta(record._meta);
  return {
    serverName,
    alwaysLoad: alwaysLoad === true || meta["anthropic/alwaysLoad"] === true,
    searchHint:
      typeof meta["anthropic/searchHint"] === "string"
        ? meta["anthropic/searchHint"].replace(/\s+/g, " ").trim()
        : undefined,
    toolName,
    name: `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`,
    description: typeof record.description === "string" ? record.description : undefined,
    // 工具级 `_meta.timeoutMs`（A8）覆盖服务器级超时：长任务（下载引擎、渲染）按工具声明，上限 30 分钟。
    timeoutMs: readToolMetaTimeoutMs(record._meta) ?? timeoutMs,
    inputSchema: normalizeInputSchema(record.inputSchema),
    outputSchema: isRecord(record.outputSchema) ? (record.outputSchema as JsonSchema) : undefined,
    annotations: normalizeAnnotations(record.annotations),
    // 只有 http 官方 MCP 的 tool error 标识才被信任——那种形态的响应来自已校验 origin 的
    // ZCode 后端，插件伪造不了（判据与代价见 mcp.port.ts 的 official 字段说明）。
    ...(official ? { official: true } : {}),
    // 可见性独立于 UI 呈现——没有 resourceUri 的 app-only 数据工具也不能进模型工具表。
    visibility: readMcpToolVisibility(record._meta),
    ...(ui ? { ui } : {}),
  };
}

/**
 * 读取并夹取工具级超时。
 *
 * 非有限数、小于下限（MCP_TOOL_META_TIMEOUT_MIN_MS）一律视为“未声明”返回 undefined，
 * 让服务器级超时生效；超过上限（30 分钟）截断。取整避免小数毫秒进入定时器。
 */
function readToolMetaTimeoutMs(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta.timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MCP_TOOL_META_TIMEOUT_MIN_MS) return undefined;
  return Math.min(Math.floor(value), MCP_TOOL_META_TIMEOUT_MAX_MS);
}

/**
 * 把 inputSchema 收敛成 object 型 JSON Schema。
 *
 * 非对象 / 缺失时返回 `{type:"object", properties:{}, additionalProperties:true}`：
 * 宁可让参数校验宽松，也不要把一个无法解析的 schema 交给模型导致工具不可调用。
 * 已有 schema 一律强制 type=object 并保证 properties 是对象，其余关键字原样保留。
 */
function normalizeInputSchema(schema: unknown): JsonSchema {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
  };
}

/**
 * 归一化 MCP tool annotations（只保留规范定义的 4 个布尔 hint）。
 * 非对象返回 undefined；非布尔的 hint 丢弃而不是强转，避免把 "false" 之类字符串
 * 误解成危险/幂等声明。
 */
function normalizeAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  return {
    readOnlyHint: typeof value.readOnlyHint === "boolean" ? value.readOnlyHint : undefined,
    destructiveHint: typeof value.destructiveHint === "boolean" ? value.destructiveHint : undefined,
    idempotentHint: typeof value.idempotentHint === "boolean" ? value.idempotentHint : undefined,
    openWorldHint: typeof value.openWorldHint === "boolean" ? value.openWorldHint : undefined,
  };
}

/**
 * 工具名安全化：非 `[a-zA-Z0-9_-]` 字符替换为下划线并折叠连续下划线。
 * 结果为空时返回 "unknown"，保证命名空间段永远非空；该变换在 server/tool 两段
 * 各执行一次，因此不同原始名可能碰撞，但不会产生空段或非法标识符。
 */
function sanitizeMcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/** 判定“纯对象”（非 null、非数组），用于逐个字段的安全读取。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
