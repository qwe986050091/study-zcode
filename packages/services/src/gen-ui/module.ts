// 模块清单只声明 id、依赖与公开出口，不承载运行时装配或初始化逻辑。
// INV: requires 与 publicEntrypoints 必须与目录实际导出一致，缺失会导致模块加载期解析失败。
export const genUiServiceModule = {
  id: "gen-ui-service",
  requires: ["services", "shared", "rpc", "gen-ui-protocol", "mcp-apps-protocol"],
  provides: ["gen-ui-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
