// providers/api 公开入口：集中再导出 API 客户端、网络传输、端点表与鉴权头工具。
// INV：新增能力必须在此登记，调用方不得绕过本入口直达 nodeApiNetwork 等实现文件。
// INV：本文件只做转发，不构造实例、不读取配置，导入本入口必须保持零副作用。
// 违反会让 provider 的端点与代理选择出现第二套实现，鉴权头规范化被悄悄绕过。
export { createNodeApiClient, NodeApiClient } from "./nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  resolveHostProxyForUrl,
  type HostApiNetworkOptions,
  type HostApiNetworkTransport,
} from "./nodeApiNetwork.js";
export { readApiJson } from "./apiJson.js";
export * from "./apiEndpoints.js";
export { normalizeApiKeyForHeader } from "./apiKeyHeaders.js";
