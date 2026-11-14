// 运行时端点集中在此派生，调用方不得自行拼接 URL 或硬编码主机名。
// INV: 端点必须经 buildRuntimeZCodeApiUrl / resolveZaiBusinessBaseUrl 从 env 解析，否则多环境会落到错误网关。
import { buildRuntimeZCodeApiUrl, resolveZaiBusinessBaseUrl } from "@zcode/shared";

export const ZCODE_CLIENT_SCENES_URL = buildRuntimeZCodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
