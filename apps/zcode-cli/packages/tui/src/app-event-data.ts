// 事件 payload 解析工具（L2）：把宽松的 Record<string, unknown> 收敛为强类型展示数据。
// 所有函数对缺字段/类型错误一律返回 undefined 或安全默认值，绝不抛错——事件流不能因单个字段中断。
// token 计数口径统一为 >= 0 的有限数；非法值视为"未知"，而不是 0。
import { createModelUsageSummary, type ModelUsageSummary } from "@zcode/contracts";
import type { CacheStats, ContextUsage } from "./app-model.js";
import { asRecord, booleanField, numberField, stringField } from "./state.js";

// 网络请求目标三元组，供状态栏展示（不参与请求本身）。
type ModelNetworkRequestTarget = {
  // 模型 id；缺失时为 undefined（调用方显示占位）。
  model?: string;
  // provider id；缺失时为 undefined。
  provider?: string;
  // 展示用 URL；必填，解析不到真实地址时退化为 "provider/model" 文本。
  url: string;
};

// 只做有限非负数校验，不做单位换算或上限截断，超大值会原样保留。
// 返回对象与入参是不同引用，调用方用展开合并时不会污染原有 ContextUsage。
// 过滤 ContextUsage 中的非法字段：只保留通过 validTokenCount 的值，
// 因此 contextUsed/contextWindow 都可能缺失（返回对象可能为 {}，调用方需用展开合并保持旧值）。
export function validContextUsage(projection: ContextUsage): ContextUsage {
  return {
    ...(validTokenCount(projection.contextUsed) !== undefined
      ? { contextUsed: projection.contextUsed }
      : {}),
    ...(validTokenCount(projection.contextWindow) !== undefined
      ? { contextWindow: projection.contextWindow }
      : {}),
  };
}

// 0 会原样返回（非负即合法），需要算百分比的调用方必须另行防除零。
// 只读顶层 contextWindow 字段，嵌套结构不在本函数职责内。
// 从 payload.contextWindow 读取有效 token 数；缺失或非法返回 undefined（调用方保持旧值）。
export function contextWindowFromPayload(payload: Record<string, unknown>): number | undefined {
  return validTokenCount(numberField(payload, "contextWindow"));
}

// 解析 provider 用量。两条路径：
// 1) usage 直接带 modelRequestCount（新版汇总）→ 映射为 source="provider"，缺失数值补 0；
// 2) 否则按原始 token 字段走 createModelUsageSummary（source 由该函数决定）。
// usage 为空对象或完全无字段时返回 undefined，避免用 0 覆盖已有统计。
export function usageFromPayload(payload: Record<string, unknown>): ModelUsageSummary | undefined {
  const usage = asRecord(payload.usage);
  if (Object.keys(usage).length === 0) return undefined;
  const modelRequestCount = numberField(usage, "modelRequestCount");
  if (modelRequestCount !== undefined) {
    return {
      cacheReadTokens: numberField(usage, "cacheReadTokens") ?? 0,
      cacheWriteTokens: numberField(usage, "cacheWriteTokens") ?? 0,
      inputTokens: numberField(usage, "inputTokens") ?? 0,
      modelRequestCount,
      outputTokens: numberField(usage, "outputTokens") ?? 0,
      reasoningTokens: numberField(usage, "reasoningTokens") ?? 0,
      source: "provider",
      totalTokens: numberField(usage, "totalTokens") ?? 0,
      webFetchRequests: numberField(usage, "webFetchRequests") ?? 0,
      webSearchRequests: numberField(usage, "webSearchRequests") ?? 0,
    };
  }

  const serverToolUse = asRecord(usage.serverToolUse);
  return createModelUsageSummary([
    {
      cacheReadTokens: numberField(usage, "cacheReadTokens"),
      cacheWriteTokens: numberField(usage, "cacheWriteTokens"),
      inputTokens: numberField(usage, "inputTokens"),
      outputTokens: numberField(usage, "outputTokens"),
      reasoningTokens: numberField(usage, "reasoningTokens"),
      serverToolUse: {
        webFetchRequests: numberField(serverToolUse, "webFetchRequests"),
        webSearchRequests: numberField(serverToolUse, "webSearchRequests"),
      },
      totalTokens: numberField(usage, "totalTokens"),
    },
  ]);
}

// 返回对象逐字段可选，缺失字段保持 undefined，调用方应以展开合并而非整体替换。
// 不聚合多次事件、不补默认 0，统计口径完全以本次 payload 为准。
// 解析缓存统计。payload.cacheStats 为空对象返回 undefined；
// 逐字段读取后若全部 undefined 也返回 undefined，防止空壳对象让 UI 显示 0。
export function cacheStatsFromPayload(payload: Record<string, unknown>): CacheStats | undefined {
  const stats = asRecord(payload.cacheStats);
  if (Object.keys(stats).length === 0) return undefined;

  const next: CacheStats = {
    cachedMessages: numberField(stats, "cachedMessages"),
    cacheReadTokens: numberField(stats, "cacheReadTokens"),
    lastCacheHit: booleanField(stats, "lastCacheHit"),
    totalMessages: numberField(stats, "totalMessages"),
  };

  return Object.values(next).some((value) => value !== undefined) ? next : undefined;
}

// 空串同样触发回退，四个来源都取不到时得到固定兜底文案。
// 返回值不带前缀或冒号，展示格式由调用方拼接，避免文案重复。
// 提取错误文案：error.message → payload.message → payload.reason → "Unknown error"。
// 不拼接堆栈，避免把内部细节直接展示给用户；本函数必定返回非空字符串。
export function formatEventError(payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  return (
    stringField(error, "message") ??
    stringField(payload, "message") ??
    stringField(payload, "reason") ??
    "Unknown error"
  );
}

// 从事件 payload 推断网络请求目标三元组。provider/model 支持从 model/provider/connection 三层嵌套依次回退，
// url 依次尝试 baseURL/baseUrl/url，全部缺失时退化为 "provider/model" 文本。
// 返回值 url 必定非空，便于状态栏直接展示。
export function modelNetworkRequestTargetFromPayload(
  payload: Record<string, unknown>,
): ModelNetworkRequestTarget {
  const model = asRecord(payload.model);
  const providerRecord = asRecord(payload.provider);
  const connection = asRecord(payload.connection);
  const provider =
    stringField(model, "providerId") ??
    stringField(payload, "providerId") ??
    stringField(providerRecord, "providerId") ??
    stringField(providerRecord, "id") ??
    stringField(connection, "providerId");
  const modelId =
    stringField(model, "modelId") ??
    stringField(model, "model") ??
    stringField(model, "id") ??
    stringField(payload, "modelId");
  const url =
    stringUrlField(payload, "baseURL") ??
    stringUrlField(payload, "baseUrl") ??
    stringUrlField(payload, "url") ??
    stringUrlField(providerRecord, "baseURL") ??
    stringUrlField(providerRecord, "baseUrl") ??
    stringUrlField(providerRecord, "url") ??
    stringUrlField(connection, "baseURL") ??
    stringUrlField(connection, "baseUrl") ??
    stringUrlField(connection, "url") ??
    modelNetworkTargetFallback(provider, modelId);

  return {
    model: modelId,
    provider,
    url,
  };
}

// token 计数合法性：必须是 >= 0 的有限数；其余（undefined/NaN/Infinity/负数）一律视为未知。
function validTokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// 读取非空 URL 字符串；字面量 "model" 是上游模型的占位值，视为无效地址。
function stringUrlField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value && value !== "model" ? value : undefined;
}

// URL 兜底：provider/model 拼接，缺一项则用已有项，两者都没有时返回 "model" 占位。
function modelNetworkTargetFallback(
  provider: string | undefined,
  model: string | undefined,
): string {
  if (provider && model) return `${provider}/${model}`;
  return provider ?? model ?? "model";
}
