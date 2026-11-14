/*
 * Plugin `.mcp.json` 里 `auth: { type: "zcode_official" }` 的严格解析与 provenance 生成。
 *
 * 单独成文件而不是留在 mcp.ts：官方鉴权的解析规则覆盖 http 与 stdio 两种传输方式，
 * 且与模板变量解析、传输层字段解析没有耦合——放一起只会让 mcp.ts 继续膨胀（它已到 max-lines 上限）。
 */
import type { McpOfficialProvenance, ZCodeOfficialMcpAuthConfig } from "@zcode/contracts";

/*
 * ============================================================
 * plugins / mcp-official-auth.ts —— 官方 MCP 鉴权声明解析与 provenance
 *
 * 定位：严格解析 .mcp.json 的 `auth`（必须 type=zcode_official 且 provider=jwt_token），
 * 并由宿主生成 provenance；覆盖 http/stdio 两种传输。
 *
 * 输入输出：parseZCodeOfficialAuth 返回规范化的 auth 或 undefined（未声明）；
 * buildOfficialProvenance 返回 {mcpKey, pluginId, source:"plugin"}。
 *
 * 副作用：无（纯函数，不读文件/网络）。
 *
 * 失败语义：声明了但形状不合法一律抛错（不降级），避免“看似官方鉴权、实际匿名请求”。
 *
 * 不变量：官方身份只能由宿主 provenance 表达，插件自写的 official 字段会被覆盖。
 * ============================================================
 */

/** 类型守卫：非数组普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格解析 `auth`。未声明返回 undefined（走普通 MCP 路径）；声明了但形状不合法一律抛错，
 * 不做宽容降级——降级会让"看起来配了官方鉴权、实际匿名请求"的配置静默上线。
 */
export function parseZCodeOfficialAuth(
  value: unknown,
  mcpKey: string,
): ZCodeOfficialMcpAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`MCP server ${mcpKey}: auth must be an object`);
  }
  // 精确值匹配，区分大小写；zcode-official、zcode_official_auth 等别名一律拒绝。
  if (value.type !== "zcode_official") {
    throw new Error(`MCP server ${mcpKey}: unsupported auth type: ${String(value.type)}`);
  }
  if (value.provider !== "jwt_token") {
    throw new Error(`MCP server ${mcpKey}: unsupported auth provider: ${String(value.provider)}`);
  }
  return { type: "zcode_official", provider: "jwt_token" };
}

/**
 * 宿主生成的运行时 provenance。`.mcp.json` 里写了 `official` 字段也会被它覆盖——
 * 官方身份不能由被审查方自己声明。
 */
export function buildOfficialProvenance(identity: {
  mcpKey: string;
  pluginId: string;
}): McpOfficialProvenance {
  return { mcpKey: identity.mcpKey, pluginId: identity.pluginId, source: "plugin" };
}
