import type { ApiClient } from "@zcode/shared";
import {
  buildRuntimeZCodeEndpointUrls,
  normalizeOfficialGlmModelId,
  ZCODE_VERSION,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

// INV-01：同一 ApiClient + 同一 authorization 的并发余额查询合并为一个请求，
// 否则冷启动时账号校验与用量面板会各打一次，触发后端 429。
// INV-02：in-flight 记录至少保留到发起后 1 秒，让「先校验、后查用量」拿到同一份响应。
// INV-03：过期判定以 HTTP Date 为准，不用本地时钟，避免机器时间偏移把 active 套餐判成过期。
const REQUEST_TIMEOUT_MS = 15_000;
const ZAI_START_PLAN_BALANCE_URL = buildRuntimeZCodeEndpointUrls(
  process.env,
).zcodePlanBillingBalanceUrl;

// 字段全部 optional：后端在不同套餐/环境下会省略部分键，读取侧不做存在性假设。
export interface ZaiStartPlanPlan {
  // user_plan_id 标识用户套餐实例；额度提醒用它关联同一实例的 entitlement 周期类型。
  user_plan_id?: string;
  plan_id?: string;
  name?: string;
  status?: string;
  starts_at?: number | string | null;
  ends_at?: number | string | null;
  entitlements?: Array<{
    entitlement_id?: string | null;
    show_name?: string | null;
    period?: string | null;
    effective_at?: number | string | null;
  }>;
}

// 信封保留 code/success/msg 三种业务状态表达，判定统一交给调用方的 isSuccessful 口径。
export interface ZaiStartPlanBalanceEnvelope {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    server_time?: number;
    plans?: ZaiStartPlanPlan[];
    balances?: Array<{
      bucket_id?: string;
      user_plan_id?: string;
      plan_id?: string;
      entitlement_id?: string;
      show_name?: string;
      meter?: string;
      unit_type?: string;
      capabilities?: string[];
      total_units?: number | string | null;
      used_units?: number | string | null;
      reserved_units?: number | string | null;
      remaining_units?: number | string | null;
      available_units?: number | string | null;
      period_start?: number | string | null;
      period_end?: number | string | null;
      expires_at?: number | string | null;
    }>;
  };
}

// [并发] 以 ApiClient 实例为弱键：不同 Environment 的客户端天然隔离，
// 客户端被回收时整张表随之消失，不需要额外清理钩子。
// 内层 Map 的 key 由 authorization + url 组成，避免不同账号共用同一份缓存。
const inflightBalanceRequests = new WeakMap<
  ApiClient,
  Map<string, Promise<ZaiStartPlanBalanceEnvelope>>
>();

// 每次重新求值：ZCODE_ENV 与 endpoint 配置可能在进程内变更（测试会注入不同 env）。
export function buildZaiStartPlanBalanceUrl(): string {
  const url = new URL(ZAI_START_PLAN_BALANCE_URL);
  // Start Plan balance 接口按真实 app_version 判定能力；
  // 开发环境也不能固定 3.0.0，否则本地验证会绕过当前 App 版本的后端策略。
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}

// invalidateCache=true 用于「刚完成登录/切档」这类必须绕过 1 秒窗口的场景。
// [资源] 返回的 Promise 被所有等待者共享，因此 finally 里必须先比对身份再删除。
export async function fetchZaiStartPlanBalanceEnvelope(
  apiClient: ApiClient,
  authorization: string,
  invalidateCache = false,
): Promise<ZaiStartPlanBalanceEnvelope> {
// 用 JSON 序列化拼键，避免分隔符冲突；authorization 先 trim 再入键，防止空白差异分裂缓存。
  const requestKey = JSON.stringify({
    authorization: authorization.trim(),
    url: buildZaiStartPlanBalanceUrl(),
  });

// [并发] JS 单线程保证「查表—建表—写表」不被中断；但 Map 可能被上一轮 finally 清空，
// 所以每轮都要重新取，不能缓存在函数外。
  let requests = inflightBalanceRequests.get(apiClient);
  if (!requests) {
    requests = new Map();
    inflightBalanceRequests.set(apiClient, requests);
  }

// 失效只影响本 key：其它账号的 in-flight 请求仍然有效。
  if (invalidateCache) requests.delete(requestKey);
  const inflight = requests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  const url = buildZaiStartPlanBalanceUrl();
// 记录发起时刻用于计算保留窗口；不能用响应到达时刻，否则慢响应会拉长驻留时间。
  const startedAt = Date.now();
  let responseTime: number | undefined;
// [权衡] 包一层 ApiClient 只为抓响应头 Date，而不是给 readApiJson 加回调参数：
// 回调会污染公共签名，而包装只在本函数内可见。
// Date 缺失或不可解析时 responseTime 保持 undefined，由 normalize 回落到 server_time/本地时间。
  const observedApi: ApiClient = {
    request: async (input, init) => {
      const response = await apiClient.request(input, init);
      const date = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(date)) responseTime = date / 1000;
      return response;
    },
  };
// 归一化放在 then 里：过期改写与余额过滤必须基于同一份响应时间，
// 否则两个消费者会看到互不一致的 plans/balances 组合。
  const request = readApiJson<ZaiStartPlanBalanceEnvelope>(observedApi, url, {
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: authorization,
    },
  })
    .then((payload) => normalizeStartPlanExpiry(payload, responseTime))
    .finally(() => {
      // 账号校验先完成，用量查询随后到达：保留同一响应至发起后 1 秒。
      // 失败同样保留，避免 429 之后立刻重复请求；旧请求不得删除失效后创建的新记录。
// [并发] 先确认 Map 中仍是本 Promise 再删除：失效后可能已有人新建请求，
// 旧请求的 finally 不能把新记录删掉。
// 表为空时顺手删掉 WeakMap 条目，避免长期持有一个空 Map。
      const evict = () => {
        if (requests?.get(requestKey) !== request) return;
        requests.delete(requestKey);
        if (requests.size === 0) inflightBalanceRequests.delete(apiClient);
      };
// 保留窗口按「发起时间」而非「完成时间」计：慢请求完成后不再额外驻留，
// 防止弱网下新请求一直命中旧响应。
      const remainingMs = 1000 - (Date.now() - startedAt);
      if (remainingMs > 0) setTimeout(evict, remainingMs);
      else evict();
    });

// 先建请求再登记：同步段结束前到达的并发调用只能看到这一个 Promise。
  requests.set(requestKey, request);
// 返回的是已登记的 Promise：调用方 await 到的结果与后续并发调用完全一致。
  return request;
}

// 模型白名单优先来自 balances[].capabilities 的 model: 前缀，缺失时才退回 show_name，
// 后者是人类可读名，尽量不作为权威 ID。
// 去重按小写比较但保留首次出现的原始大小写，保持与后端模型 ID 一致。
export function resolveZaiStartPlanBalanceModelIds(payload: ZaiStartPlanBalanceEnvelope): string[] {
// 跨 balance 去重：同一模型可能出现在多个权益桶（例如套餐与试用并存）。
  const seen = new Set<string>();
  const modelIds: string[] = [];

// balances 可能为空：此时返回空数组，表示「套餐可用但没有模型白名单」。
  for (const balance of payload.data?.balances ?? []) {
    const fromCapabilities = (balance.capabilities ?? [])
      .map((capability) => {
        const normalized = capability.trim();
        return normalized.toLowerCase().startsWith("model:")
          ? normalized.slice("model:".length).trim()
          : "";
      })
      .filter(Boolean);
// 只在 capabilities 完全没有 model: 项时退化为 show_name，避免两种来源混用产生重复模型。
    const candidates = fromCapabilities.length > 0 ? fromCapabilities : [balance.show_name ?? ""];
    for (const candidate of candidates) {
      const modelId = normalizeOfficialGlmModelId(candidate.trim());
      const key = modelId.toLowerCase();
      if (!modelId || seen.has(key)) {
        continue;
      }
      seen.add(key);
      modelIds.push(modelId);
    }
  }

  return modelIds;
}

/** HTTP Date 与本次响应配对，避免旧 JSON 时间让过期 active 记录继续提供权益。 */
// [失败路径] 只把「status=active 且 ends_at 已过」改成 expired：
// 缺失或非法的 ends_at 保持原状态，宁可让调用方按未知处理，也不能凭空判定过期。
// plans 改写后必须同步过滤 balances，否则 UI 会继续展示已过期套餐的余额。
function normalizeStartPlanExpiry(
  payload: ZaiStartPlanBalanceEnvelope,
  responseTime?: number,
): ZaiStartPlanBalanceEnvelope {
// 无 data 时原样返回：错误信封由上层按 code/success 判定，这里不做二次解释。
  if (!payload.data) return payload;
  const serverTime = payload.data.server_time;
  const now =
    responseTime ??
    (typeof serverTime === "number" && Number.isFinite(serverTime) && serverTime >= 0
      ? serverTime
      : Date.now() / 1000);
// 只改 status，不裁剪 plans：调用方仍需看到已过期套餐，用于展示历史与诊断。
// 判定用 <= 而非 <：截止时刻视为已结束，避免边界上多展示一瞬间的可用权益。
  const plans = (payload.data.plans ?? []).map((plan) => {
    const end = Number(plan.ends_at);
    return plan.status?.trim().toLowerCase() === "active" &&
      Number.isFinite(end) &&
      end > 0 &&
      end <= now
      ? { ...plan, status: "expired" }
      : plan;
  });
// 无归属桶（找不到对应 plan）保留给既有诊断；有归属时只要存在一个未过期实例就保留。
  const balances = payload.data.balances?.filter((balance) => {
    const owners = plans.filter((plan) =>
      balance.user_plan_id && plan.user_plan_id
        ? plan.user_plan_id === balance.user_plan_id
        : plan.plan_id === balance.plan_id,
    );
    // 无归属桶继续由既有诊断处理，不能误删同商品另一个有效实例的余额。
    return !owners.length || owners.some((plan) => plan.status?.trim().toLowerCase() !== "expired");
  });
// 返回新对象而不原地改写：同一份 payload 可能被日志与多个消费者共享，
// 原对象留着用于排查后端真实返回值。
  return { ...payload, data: { ...payload.data, plans, balances } };
}
