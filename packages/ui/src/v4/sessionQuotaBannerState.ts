// INV-01 服务端并发限流分支必须排在 buildSessionQuotaBannerState 全部判断之前。守住位置：函数体第一个 if。改错故障：3008/3009/3010 被普通耗尽提示盖住，文案与重试建议错位。
// INV-02 并发限流只对 Start Plan provider 生效，校验点是 isStartPlanModelProviderId。守住位置：首个分支的第二个条件。改错故障：其他 provider 也弹并发横幅，误报。
// INV-03 服务端配额耗尽分支必须排在并发限流之后。守住位置：第二个 if。改错故障：两类错误同时上报时并发提示被吞掉。
// INV-04 daily-exhausted 的 modelName 固定为 null，只有 model-exhausted 才携带模型名。守住位置：服务端耗尽分支的返回值。改错故障：日额度耗尽却点名某个模型，误导用户换模型。
// INV-05 provider-limited 只对 GLM 系四个 provider id 生效，判断在 isGlmQuotaBannerProviderId。守住位置：第三个 if 的第三个条件。改错故障：无关 provider 的业务错误被渲染成额度提示。
// INV-06 provider-limited 的文案必须经 normalizeProviderLimitedBannerMessage 归一。守住位置：第三个分支的 providerLimitedMessage 赋值。改错故障：原始多段方括号文本直接透出，UI 溢出。
// INV-07 MCP 不可用分支必须排在四条服务端业务错误之后。守住位置：第四个 if。改错故障：MCP 提示抢在模型侧紧急提示前面。
// INV-08 MCP 不可用分支必须排在 Start-Plan-only 早退之前。守住位置：早退 if 的上方。改错故障：Coding Plan 会话必然命中早退，该分支永不生效。
// INV-09 MCP 两种 kind 由 code 是否等于 quota_exceeded 决定。守住位置：mcpQuotaExhausted 取值与 kind 表达式。改错故障：权益缺失与额度耗尽的文案互换，升级建议给反。
// INV-10 MCP 提示的 blocksSubmit 必须为 false。守住位置：MCP 分支返回值。改错故障：MCP 故障阻断模型对话输入。
// INV-11 Start-Plan-only 早退要求 snapshot.provider.id 与 activeProviderId 相等。守住位置：早退 if 的第三个条件。改错故障：切换 provider 后旧快照继续驱动横幅。
// INV-12 早退必须返回共享的 HIDDEN_SESSION_QUOTA_BANNER_STATE，而不是新建对象。守住位置：早退 return。改错故障：每次调用产生新引用，上层 selector 失稳并重复渲染。
// INV-13 referenceTime 取 serverTime 优先、generatedAt 兜底，两者都是服务端时钟。守住位置：早退之后的第一行计算。改错故障：改用设备时钟使提醒窗口与桶周期错位。
// INV-14 全部有效桶耗尽时返回 daily-exhausted，remainingTokens 与 remainingPercent 都为 0。守住位置：allBucketsExhausted 分支。改错故障：耗尽被漏判成普通状态，横幅不出现。
// INV-15 modelBuckets 由 modelId 与 bucketMatchesModel 过滤得到，modelId 为空时结果为空数组。守住位置：modelBuckets 三元表达式。改错故障：空 modelId 命中全部桶，误报某模型耗尽。
// INV-16 modelName 优先取 usageDetails 的 displayName，缺失时回退 modelId。守住位置：modelName 的 flatMap 查找。改错故障：提示里出现内部模型 id。
// INV-17 低额度提醒要求 ratio 非空、大于 0、且不大于 0.1，并配合 isReminderHidden 去重。守住位置：循环内的 continue 条件。改错故障：阈值边界改写后 10% 提醒丢失或全量弹出。
// INV-18 reminderExpiresAt 取 periodEnd 与 nextResetTime 的较小值。守住位置：低额度返回值的 Math.min。改错故障：取较大值使提醒活过桶周期边界。
//
// 模块职责：把服务端配额事实、并发限流、provider 业务错误与 MCP 不可用事实，归一成唯一一份横幅状态投影。
// 状态所有权：本模块只导出类型、常量与纯函数，不持有可变状态、不发请求、不读设备时钟；去重记录由调用方持有。
// 阅读顺序：先看 SessionQuotaBannerKind 与 SessionQuotaBannerState 契约，再看 buildSessionQuotaBannerState 的分支优先级，最后看 dismissKey 与升级入口判断。
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type {
  GlmQuotaBannerBusinessCode,
  StartPlanConcurrentLimitBannerReason,
} from "@/lib/providerBusinessError.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";

import {
  allBucketsExhausted,
  bucketMatchesModel,
  bucketRemainingRatio,
  bucketReminderKey,
  getActiveModelBuckets,
} from "@/v4/startPlanQuotaBuckets.js";

// 对 UI 而言这是唯一契约：渲染分流只按 kind 判定，不解析下游字段组合。
// 新增 kind 必须同步三处：buildSessionQuotaBannerState 的赋值、dismissKey 的拼接项、升级入口判断。
// 漏掉 dismissKey 的后果是同一条提示无法被关闭，只能等状态本身消失。
// mcp-quota-exhausted 与 mcp-plan-required 刻意分开：后者可由升级解决，前者只能等自然日重置。
// concurrent-limit 与 provider-limited 共用 visible，但业务码字段各自独立，不要合并成一个字符串字段。
export type SessionQuotaBannerKind =
  | "model-very-low"
  | "model-exhausted"
  | "daily-exhausted"
  | "concurrent-limit"
  | "provider-limited"
  | "mcp-quota-exhausted"
  | "mcp-plan-required";

// visible 与 kind 是唯一事实来源，其余字段都是渲染该 kind 所需的最小投影。
// 两者语义不可互换：visible 为 false 时 kind 必须为 null，反过来不成立。
// blocksSubmit 决定是否拦截提交，dismissible 决定用户能否关闭，二者独立，不要按 kind 推断。
// reminderKey 只服务低额度提醒；带它时 dismissKey 直接短路返回该值。
// 时间字段以服务端快照为准，reminderReferenceTime 不可换算为设备时钟。
export interface SessionQuotaBannerState {
  visible: boolean;
  kind: SessionQuotaBannerKind | null;
  concurrentLimitBusinessCode: "3008" | "3009" | "3010" | null;
  concurrentLimitReason: StartPlanConcurrentLimitBannerReason | null;
  providerLimitedBusinessCode: GlmQuotaBannerBusinessCode | null;
  providerLimitedMessage: string | null;
  modelName: string | null;
  /** 官方 Server MCP 提示专用：出问题的 MCP server 名，用于文案点名。 */
  mcpServerName: string | null;
  /** 官方 Server MCP 提示专用：产生该事实的 tool row，参与去重键。 */
  mcpNoticeRowId: number | null;
  /** 仅低额度提醒携带稳定桶周期键；不影响其他业务错误关闭。 */
  reminderKey?: string;
  reminderExpiresAt?: number;
  /** 与桶有效性一致的快照时间，不能换算为设备时钟。 */
  reminderReferenceTime?: number;
  quotaPeriod?: string;
  remainingTokens: number | null;
  remainingPercent: number | null;
  dismissible: boolean;
  blocksSubmit: boolean;
  priority: number;
}

// 隐藏态必须显式列出全部字段，不能依赖 undefined：调用方会直接把该对象展开成新状态。
// 它是模块级共享常量，任何就地赋值都会污染其他调用方；需要变体时只能用展开生成新对象。
// 该对象不含 reminderKey、quotaPeriod 等可选字段，保证纯隐藏态不参与提醒去重。
// 早退路径返回同一引用，使上层 selector 在输入无变化时保持稳定。
export const HIDDEN_SESSION_QUOTA_BANNER_STATE: SessionQuotaBannerState = {
  visible: false,
  kind: null,
  concurrentLimitBusinessCode: null,
  concurrentLimitReason: null,
  providerLimitedBusinessCode: null,
  providerLimitedMessage: null,
  modelName: null,
  mcpServerName: null,
  mcpNoticeRowId: null,
  remainingTokens: null,
  remainingPercent: null,
  dismissible: false,
  blocksSubmit: false,
  priority: 0,
};

function isGlmQuotaBannerProviderId(providerId: string): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

// 服务端消息可能形如多段方括号，第二段才是面向用户的正文，其余是内部标记。
// 只有在方括号不少于三段且第二段非空时才取第二段，否则原样返回，避免误裁正常文案。
// 归一化放在投影层而非渲染层，保证 dismissKey 与显示文本基于同一份字符串。
// 输入为 null 或全空白时返回 null 而不是空串，便于上层区分缺失与空文本。
export function normalizeProviderLimitedBannerMessage(
  message: string | null | undefined,
): string | null {
  const normalizedMessage = message?.trim();
  if (!normalizedMessage) return null;
  const bracketParts = [...normalizedMessage.matchAll(/\[([^\]]*)\]/gu)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return bracketParts.length >= 3 && bracketParts[1] ? bracketParts[1] : normalizedMessage;
}

/**
 * 额度业务错误保持原优先级；Start Plan 低额度按桶提醒，耗尽按全部有效桶判断。
 */
// params 全量显式传入，函数保持纯函数：同样参数必须得到同样状态，便于单测与去重。
// 分支顺序即优先级：并发限流、服务端耗尽、provider 业务错误、MCP 不可用、Start Plan 低额度。
// 任一分支命中即 return，后续分支不再参与判断；重排顺序会直接改变用户看到的提示。
// 前四条只看服务端事实，不要求 snapshot 存在；只有走到桶计算时才依赖快照。
// 所有早退分支返回的都是新对象或共享隐藏常量，不会修改 params 内的任何字段。
export function buildSessionQuotaBannerState(params: {
  activeProviderId: string | null;
  snapshot: UsageEntitlementSnapshot | null;
  modelId: string | null;
  serverQuotaExhausted?: boolean;
  isReminderHidden?: (key: string, referenceTime: number) => boolean;
  serverConcurrentLimited?: boolean;
  serverConcurrentLimitBusinessCode?: "3008" | "3009" | "3010";
  serverConcurrentLimitReason?: StartPlanConcurrentLimitBannerReason;
  serverProviderLimitedBusinessCode?: GlmQuotaBannerBusinessCode;
  serverProviderLimitedMessage?: string | null;
  /** 官方 Server MCP 在本次会话内被判定不可用的事实（来自 tool row 的结构化标识）。 */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}): SessionQuotaBannerState {
  if (
    params.serverConcurrentLimited === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "concurrent-limit",
      concurrentLimitBusinessCode: params.serverConcurrentLimitBusinessCode ?? null,
      concurrentLimitReason: params.serverConcurrentLimitReason ?? "initial-busy",
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 60,
    };
  }

  if (
    params.serverQuotaExhausted === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "daily-exhausted",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: null,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: 0,
      dismissible: false,
      blocksSubmit: false,
      priority: 50,
    };
  }

  if (
    params.serverProviderLimitedBusinessCode &&
    params.activeProviderId &&
    isGlmQuotaBannerProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "provider-limited",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: params.serverProviderLimitedBusinessCode,
      providerLimitedMessage: normalizeProviderLimitedBannerMessage(
        params.serverProviderLimitedMessage,
      ),
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 45,
    };
  }

  // 官方 Server MCP 不可用（额度耗尽 / 无 Coding Plan）。
  //
  // 位置要求：必须在上面几条服务端业务错误之后（模型侧问题更紧急，不能被 MCP 提示挡住），
  // 且必须在下面那道 Start-Plan-only 早退之前——Coding Plan 会话一定命中那道早退，
  // 放在其后这条分支永远不会生效。
  // MCP 事实来自会话内 tool row 的结构化标识，不是文本推断，因此这里不需要再判空字符串。
  // 该分支不看 provider、也不看快照：MCP 不可用与模型额度是两个独立事实。
  // 优先级 6 与 8 都低于服务端业务错误，保证模型侧问题先被用户看到。
  // 命中条件只有 mcpUnavailableNotice 存在，命中后不再继续计算任何桶。
  // 返回值携带 serverName 与 rowId，供 dismissKey 做同一次调用只弹一次的去重。
  if (params.mcpUnavailableNotice) {
    const mcpQuotaExhausted = params.mcpUnavailableNotice.code === "quota_exceeded";
    return {
      visible: true,
      kind: mcpQuotaExhausted ? "mcp-quota-exhausted" : "mcp-plan-required",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: null,
      mcpServerName: params.mcpUnavailableNotice.serverName,
      mcpNoticeRowId: params.mcpUnavailableNotice.rowId,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      // MCP 不可用不影响模型对话，绝不阻断输入。
      blocksSubmit: false,
      priority: mcpQuotaExhausted ? 6 : 8,
    };
  }

  if (
    !params.activeProviderId ||
    !isStartPlanModelProviderId(params.activeProviderId) ||
    params.snapshot?.provider?.id !== params.activeProviderId
  ) {
    return HIDDEN_SESSION_QUOTA_BANNER_STATE;
  }

  // 服务端时间优先，缺失时才退回快照生成时间，两者都属于服务端时钟。
  // 提醒窗口与桶周期必须同源，否则设备时钟偏移会让提醒提前或延后过期。
  // 该值会写进 reminderReferenceTime 并参与 isReminderHidden 判定，不能换成 Date.now。
  // 后续所有桶判断共用这一个时间点，避免一次调用内多次取时间造成漂移。
  const referenceTime = params.snapshot.serverTime ?? params.snapshot.generatedAt;
  const buckets = getActiveModelBuckets(params.snapshot);
  if (allBucketsExhausted(buckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "daily-exhausted",
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 50,
    };
  }
  const modelId = params.modelId?.trim() ?? "";
  const modelBuckets = modelId
    ? buckets.filter((bucket) => bucketMatchesModel(bucket, modelId))
    : [];
  const modelName =
    modelBuckets.flatMap((bucket) => bucket.usageDetails).find((detail) => detail.displayName)
      ?.displayName ?? modelId;
  if (allBucketsExhausted(modelBuckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-exhausted",
      modelName,
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 40,
    };
  }
  // 这里只处理还有额度但很低的情况：整桶耗尽已在上面的 allBucketsExhausted 分支返回。
  // ratio 为 null 说明桶缺少可用额度信息，直接跳过，不能当成 0 处理。
  // 阈值判断是 ratio 不大于 0.1，边界值本身会提醒；改成严格小于会漏掉正好 10% 的桶。
  // 命中已被 isReminderHidden 标记的键时继续找下一个桶，保证同一时刻只展示一条提醒。
  // 循环结束仍未命中则返回隐藏态，说明当前模型桶健康，不应弹任何额度提示。
  for (const bucket of modelBuckets) {
    const ratio = bucketRemainingRatio(bucket);
    const key = bucketReminderKey(bucket);
    if (
      ratio === null ||
      ratio <= 0 ||
      ratio > 0.1 ||
      !key ||
      params.isReminderHidden?.(key, referenceTime)
    )
      continue;
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-very-low",
      modelName,
      remainingTokens: bucket.remaining ?? null,
      remainingPercent: ratio * 100,
      reminderKey: key,
      reminderReferenceTime: referenceTime,
      reminderExpiresAt: Math.min(bucket.periodEnd!, bucket.nextResetTime ?? Infinity),
      quotaPeriod: bucket.period,
      dismissible: true,
      priority: 30,
    };
  }
  return HIDDEN_SESSION_QUOTA_BANNER_STATE;
}

// 去重键只在可见且有 kind 时生成，隐藏态返回 null，上层据此清理已关闭记录。
// reminderKey 存在时优先返回它，使同一桶周期内的提醒关一次即长期生效。
// 其余情况把 kind、各业务码、模型名、MCP 标识、额度数值、阻断标记与 serverErrorKey 拼成稳定键。
// 拼接项增删都会让旧关闭记录失效并重新弹出，改动前需确认这是预期行为。
export function buildSessionQuotaBannerDismissKey(
  state: SessionQuotaBannerState,
  serverErrorKey?: string | null,
): string | null {
  if (!state.visible || !state.kind) return null;
  if (state.reminderKey) return state.reminderKey;
  return [
    state.kind,
    state.concurrentLimitBusinessCode ?? "",
    state.concurrentLimitReason ?? "",
    state.providerLimitedBusinessCode ?? "",
    state.providerLimitedMessage ?? "",
    state.modelName ?? "",
    // MCP 提示按 server + 具体调用去重：关闭一次后同一次调用不再弹，
    // 之后再有新的失败调用（新 rowId）会重新弹。
    state.mcpServerName ?? "",
    state.mcpNoticeRowId ?? "",
    state.remainingTokens ?? "",
    state.remainingPercent ?? "",
    state.blocksSubmit ? "blocked" : "unblocked",
    serverErrorKey ?? "",
  ].join(":");
}

export function resolveQuotaBannerUpgradeProviderId(providerId: string | null): string | null {
  return providerId;
}

/**
 * 该提示是否应该带升级入口。
 *
 * `mcp-quota-exhausted` 明确不带：今日额度用完只能等自然日重置，升级按钮会让用户以为
 * 花钱就能立刻继续，是误导。权益缺失（`mcp-plan-required`）才是升级能解决的问题。
 */
export function shouldOfferQuotaBannerUpgrade(kind: SessionQuotaBannerKind | null): boolean {
  return kind !== "mcp-quota-exhausted";
}
