// ============================================================
// Tool Search 能力判定与 beta 头注入
// 定位：决定某 provider/账号组合能否启用 tool search，并在启用时附加 anthropic-beta。
// 输入：apiType 协议名 + access（账号类型与模式）。输出：冻结的能力对象 / 新的 header 映射。
// 副作用：resolve 无副作用；toolSearchHeaders 返回副本，不修改调用方 headers。
// 失败语义：无（不抛错）；不满足条件时安静地不注入。
// 不变量：默认启用需同时满足"协议支持"与"编码套餐账号"，缺一即 defaultEnabled=false。
// ============================================================

import { TOOL_SEARCH_BETA, type ToolSearchCapability } from "@zcode/contracts";

/**
 * 计算 tool search 能力：protocolSupported 表示协议层能否承载（仅 anthropic-messages）；
 * defaultEnabled 还要求账号属于智谱编码套餐（api-key 类型或 individual/team coding-plan 模式）。
 * 返回冻结对象，调用方无法在运行期翻转能力位。
 */
export function resolveToolSearchCapability(
  apiType: string,
  access: { type: string; mode?: string },
): ToolSearchCapability {
  const protocolSupported = apiType === "anthropic-messages";
  const codingPlan =
    access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan"));
  return Object.freeze({ protocolSupported, defaultEnabled: protocolSupported && codingPlan });
}

/**
 * 在 headers 中追加 TOOL_SEARCH_BETA。
 * enabled 非 true（含 undefined）时原样返回，不复制也不去重；启用时按大小写不敏感定位已有
 * anthropic-beta 名并合并去重，避免同义头被服务端当作两个独立声明。
 */
export function toolSearchHeaders(headers: Record<string, string> | undefined, enabled?: boolean) {
  if (!enabled) return headers;
  const result = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  result[key] = [
    ...new Set([
      ...(result[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      TOOL_SEARCH_BETA,
    ]),
  ].join(",");
  return result;
}
