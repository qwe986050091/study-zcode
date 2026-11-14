/**
 * mcp-ui 模块清单（architecture-governance managed 模块）。
 * app 层：`mcp/readResource`、`mcp/uiCallTool`、`mcp/uiReadResource` 三个 app→agent 协议方法的处理器，
 * 以及 serverName 归属的 fail-closed 校验（任何已配置的 MCP server 都能渲染 MCP App）。
 * requires 声明依赖模块（zcode-cli / shared / mcp-apps-protocol），provides 声明对外提供
 * mcp-ui-handlers 能力；publicEntrypoints 限定外部只能从 index.ts 与 contract.ts 这两个入口引用。
 */
export const mcpUiModule = {
  id: "mcp-ui",
  requires: ["zcode-cli", "shared", "mcp-apps-protocol"],
  provides: ["mcp-ui-handlers"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
