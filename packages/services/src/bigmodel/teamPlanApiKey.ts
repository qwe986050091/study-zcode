// 团队版（Coding Plan）项目级 API Key 的读取与按需创建。
// INV-01：可用性判定必须同时满足 name、keyType 与 apiKey 非空白；只看 name 会误用个人
//         Key，只看 apiKey 会把别的场景凭据投影成套餐 Key（守住：isUsable...）。
// INV-02：诊断信息只允许出现布尔、计数与协议字段，绝不回填 apiKey 原文；这些结构会被
//         写日志与上报，回填等于把凭据带出进程（守住：dataHasApiKey/listDiagnostics）。
// INV-03：先 GET 列表、命中即返回，未命中才 POST 创建；顺序颠倒会在每次调用时制造新 Key。
// INV-04：信封失败（success=false 或 code 非 0）时降级为空列表并继续创建，而不是中止；
//         已有 Key 但列表读失败时会多建一把，代价可接受，用户不会无 Key 可用。
// INV-05：URL 的组织/项目 ID 必须逐段 encodeURIComponent，否则含斜杠的 ID 会改变路径层级。
// 本模块不删除 Key：回收是用户设置页的显式动作，运行时自动回收容易误删在用凭据。
import { API_KEY_USAGE_SCENE, type ApiClient } from "@zcode/shared";
import { readApiJson } from "#src/providers/api/apiJson.js";

// 与后端约定的固定标识：name 用于在列表里认出本产品创建的 Key，keyType=2 表示团队 Key。
// 任一处改动都会让既有 Key 变得不可识别，从而每次启动都新建一把，直接消耗团队配额。
const BIGMODEL_TEAM_PLAN_API_KEY_NAME = "zcode-team-api-key";
const BIGMODEL_TEAM_PLAN_API_KEY_TYPE = 2;

// 团队上下文是请求头的最小集合：组织决定归属，项目决定作用域，缺一即可能落到默认团队。
export interface BigModelTeamPlanBizContext {
  organizationId: string;
  projectId: string;
}

// 列表与创建返回的 Key 结构；字段可空，因为后端在不同失败阶段会回不完整对象。
export interface BigModelTeamPlanApiKeySummary {
  apiKey?: string | null;
  keyType?: number | null;
  name?: string | null;
}

// 统一信封：后端同时存在 code/msg/success 与 data 的多种组合，判定函数必须全部兼容。
// 只认 data 为载荷，错误信息仅进入诊断，不参与业务决策。
interface BigModelBizEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T | null;
}

// 三态区分「已有/新建/创建失败」；只有 missing 需要上层提示用户，前两者可直接使用。
export type BigModelTeamPlanApiKeyEnsureStatus = "existing" | "created" | "missing";

// apiKey 与 diagnostics 分离返回：凭据只走使用路径，诊断只走日志/上报路径。
export interface BigModelTeamPlanApiKeyEnsureResult {
  apiKey: BigModelTeamPlanApiKeySummary | null;
  diagnostics: BigModelTeamPlanApiKeyEnsureDiagnostics;
  status: BigModelTeamPlanApiKeyEnsureStatus;
}

// create 可选：命中已有 Key 时根本没有创建请求，强行填 null 会让人误判为创建失败。
export interface BigModelTeamPlanApiKeyEnsureDiagnostics {
  create?: BigModelBizEnvelopeDiagnostics & {
    dataHasApiKey: boolean;
    dataKeyType: number | null;
    dataName: string | null;
  };
  list: BigModelBizEnvelopeDiagnostics & {
    apiKeyCount: number;
    usableApiKeyCount: number;
  };
}

export interface BigModelBizEnvelopeDiagnostics {
  code: number | null;
  msg: string | null;
  success: boolean | null;
}

// 只组装请求头，不读取/刷新 token：凭据生命周期属于 provider 层，这里不能成为第二个持有者。
export function createBigModelBizHeaders(
  authorization: string,
  teamContext?: BigModelTeamPlanBizContext | null,
): Record<string, string> {
// 基础头固定；Authorization 由调用方传入，可能是 Bearer，也可能是团队 token。
  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Type": "application/json",
  };
// 两个团队头必须成对出现：只带一个时后端会按默认值补齐，Key 就创建到错误的项目里。
  if (teamContext) {
    headers["bigmodel-organization"] = teamContext.organizationId;
    headers["bigmodel-project"] = teamContext.projectId;
  }
  return headers;
}

// 创建载荷字段由常量收窄，避免调用点手写魔法值导致与列表判定不一致。
function createBigModelTeamPlanApiKeyPayload(): {
  keyType: typeof BIGMODEL_TEAM_PLAN_API_KEY_TYPE;
  name: typeof BIGMODEL_TEAM_PLAN_API_KEY_NAME;
  usageScene: typeof API_KEY_USAGE_SCENE.CODING_PLAN;
} {
  return {
    name: BIGMODEL_TEAM_PLAN_API_KEY_NAME,
    keyType: BIGMODEL_TEAM_PLAN_API_KEY_TYPE,
    // keyType 描述团队 Key 类型，usageScene 描述编程套餐用途，两者不能互相替代。
    usageScene: API_KEY_USAGE_SCENE.CODING_PLAN,
  };
}

// 三重判定缺一不可：name 认来源、keyType 认类型、apiKey.trim() 排除空白串。
// 少最后一项会把「刚创建但未下发密钥」的半成品当成可用，后续请求必然 401。
function isUsableBigModelTeamPlanApiKey(item: BigModelTeamPlanApiKeySummary): boolean {
  return (
    item.name === BIGMODEL_TEAM_PLAN_API_KEY_NAME &&
    item.keyType === BIGMODEL_TEAM_PLAN_API_KEY_TYPE &&
    Boolean(item.apiKey?.trim())
  );
}

// 兼容入口：老调用方只关心 Key 本身；诊断仍会内部生成，排障时可切到 WithStatus 版本。
export async function ensureBigModelTeamPlanProjectApiKey(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<BigModelTeamPlanApiKeySummary | null> {
// 薄封装不做错误处理：创建失败以 null 返回，让调用方按「无 Key」走降级路径。
  const result = await ensureBigModelTeamPlanProjectApiKeyWithStatus(params);
  return result.apiKey;
}

// 主流程：先查后建。查询幂等且廉价，创建不是；反过来会在每次冷启动多出一把 Key。
// 整个函数不写缓存：缓存 Key 会让后台轮换或吊销后本地继续用旧凭据。
export async function ensureBigModelTeamPlanProjectApiKeyWithStatus(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<BigModelTeamPlanApiKeyEnsureResult> {
// 列表与创建共用同一 URL，仅 method 不同；路径由组织与项目两段拼接。
  const listUrl = buildBigModelTeamPlanApiKeysUrl(params.host, params.teamContext);
// 传输层错误（网络/非 2xx）会抛出，此处不吞：没有列表就无法判断是否已有 Key，
// 继续创建可能重复；交由上层决定重试还是提示，比静默多建一把更安全。
  const listPayload = await readApiJson<BigModelBizEnvelope<BigModelTeamPlanApiKeySummary[]>>(
    params.apiClient,
    listUrl,
    {
      method: "GET",
      timeoutMs: params.timeoutMs,
      headers: createBigModelBizHeaders(params.authorization, params.teamContext),
    },
  );
// 信封不成功时按空列表处理：后续必然走创建分支，至少保证本次调用有机会拿到可用 Key。
  const apiKeys = isSuccessfulBigModelBizEnvelope(listPayload) ? (listPayload.data ?? []) : [];
// 诊断只统计数量：apiKeyCount 反映后端返回了几行，usableApiKeyCount 反映过滤掉多少。
// 两者不等通常意味着 name/keyType 约定漂移，是排查「为什么总是新建」的第一手信号。
  const listDiagnostics = {
    ...createBigModelBizEnvelopeDiagnostics(listPayload),
    apiKeyCount: apiKeys.length,
    usableApiKeyCount: apiKeys.filter(isUsableBigModelTeamPlanApiKey).length,
  };
// 取第一个可用项而不是新建：列表顺序由后端决定，多把 Key 时复用任意一把都不影响计费归属。
  const existingApiKey = apiKeys.find(isUsableBigModelTeamPlanApiKey) ?? null;
// 命中即返回，零写入；这是稳态路径，绝大多数调用都会走这里。
  if (existingApiKey) {
    return {
      apiKey: existingApiKey,
      diagnostics: { list: listDiagnostics },
      status: "existing",
    };
  }

  // 一个账号可能有多个 Team Plan 项目，每个项目都需要自己的 keyType=2
  // 项目级 API Key；只给当前选中团队创建会导致切换到其他团队后 runtime 无法投影。
// POST 与 GET 同 URL；创建接口本身不保证幂等，重复调用会产生多把 Key，
// 所以必须先经过上面的 GET 判重。
  const createPayload = await readApiJson<BigModelBizEnvelope<BigModelTeamPlanApiKeySummary>>(
    params.apiClient,
    listUrl,
    {
      method: "POST",
      timeoutMs: params.timeoutMs,
      headers: createBigModelBizHeaders(params.authorization, params.teamContext),
      body: JSON.stringify(createBigModelTeamPlanApiKeyPayload()),
    },
  );
// 失败信封的 data 视为不存在；不要从错误体里猜 Key。
  const createData = isSuccessfulBigModelBizEnvelope(createPayload)
    ? (createPayload.data ?? null)
    : null;
// 创建返回也要过 isUsable：后端可能只回显 name/keyType 而不下发 apiKey（权限或配额问题）。
// 不过滤就会把「创建成功但没有密钥」当成可用，错误被推迟到真正调用模型时才暴露。
// created 与 missing 由这一步的过滤结果决定，HTTP 200 不代表拿到了可用 Key。
  const createdApiKey =
    createData && isUsableBigModelTeamPlanApiKey(createData) ? createData : null;
  return {
    apiKey: createdApiKey,
    diagnostics: {
      create: {
        ...createBigModelBizEnvelopeDiagnostics(createPayload),
// [失败路径] 诊断只记录布尔值，绝不回填 apiKey 原文——这段结构会进日志与上报。
// 同时记录 keyType/name 便于判断是字段缺失还是取值不符，两者修复动作不同。
        dataHasApiKey: Boolean(createPayload.data?.apiKey?.trim()),
        dataKeyType:
          typeof createPayload.data?.keyType === "number" ? createPayload.data.keyType : null,
        dataName: createPayload.data?.name?.trim() || null,
      },
      list: listDiagnostics,
    },
// 状态由「是否拿到可用 Key」决定，而不是由 HTTP 是否成功决定。
    status: createdApiKey ? "created" : "missing",
  };
}

// 逐段 encode：组织/项目 ID 可能来自 URL 或用户输入，含斜杠时会把路径层级写歪。
// 用模板字符串拼接而不是 new URL，是因为 host 可能自带前缀路径。
function buildBigModelTeamPlanApiKeysUrl(
  host: string,
  teamContext: BigModelTeamPlanBizContext,
): string {
  return (
    `${host}/api/biz/v1/organization/${encodeURIComponent(teamContext.organizationId)}` +
    `/projects/${encodeURIComponent(teamContext.projectId)}/api_keys`
  );
}

// 信封判定集中在一处：列表、创建、诊断三条路径必须使用同一套成功语义。
function isSuccessfulBigModelBizEnvelope(envelope: BigModelBizEnvelope<unknown>): boolean {
// success===false 一票否决，即使 code 是 0：显式失败字段比 legacy 的 code 更可信。
  if (envelope.success === false) {
    return false;
  }
// code 是数字时以 code 为准，不再看 success，兼容只回 code 的老接口。
  if (typeof envelope.code === "number") {
    return envelope.code === 0 || envelope.code === 200;
  }
// 三个字段都缺失时退化为「有 data 即成功」，否则无法与真正的空响应区分。
  return envelope.success === true || envelope.data !== undefined;
}

// 诊断快照：code/msg/success 原样记录，msg 做 trim 以免空白串掩盖真实错误。
// 这里不做脱敏，因为按约定这些字段不含凭据；新增字段时必须重新审视这条前提。
function createBigModelBizEnvelopeDiagnostics(
  envelope: BigModelBizEnvelope<unknown>,
): BigModelBizEnvelopeDiagnostics {
  return {
    code: typeof envelope.code === "number" ? envelope.code : null,
    msg: envelope.msg?.trim() || null,
    success: typeof envelope.success === "boolean" ? envelope.success : null,
  };
}
