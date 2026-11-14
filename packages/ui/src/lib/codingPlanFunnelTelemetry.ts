// INV-01 事件类型固定为 ck 且元素名固定为 coding_plan_upgrade_ck，二者共同定位升级点击漏斗；守住位置：reportCodingPlanUpgradeClick 的事件对象字面量；改错故障：看板按事件名聚合，改名后点击量整段归零。
// INV-02 属性白名单只允许 buildFunnelBaseDetail 列出的八个键，新增维度必须同时改这里与看板；守住位置：buildFunnelBaseDetail 的键序；改错故障：新增维度静默丢失，分析侧拿不到分群。
// INV-03 一次会话的漏斗必须复用同一个 purchaseFunnelId，四步才能串成一次转化；守住位置：createCodingPlanFunnelContext 创建上下文的时机；改错故障：四步被拆成四段漏斗，转化率恒为 0。
// INV-04 purchaseFunnelId 必须全局唯一，随机源缺失时降级，不能用空串兜底；守住位置：createPurchaseFunnelId 与 createFallbackFunnelId；改错故障：多个用户共享同一漏斗被合并，数据被判为异常。
// INV-05 上下文创建后不再改写，后续步骤只读不重建；守住位置：CodingPlanFunnelContext 全字段一次赋值且无 setter；改错故障：第二步改了来源，同一人出现两种入口归因。
// INV-06 升级来源只能是八个枚举之一，空闲链路固定 session_idle_time；守住位置：CodingPlanUpgradeSource 联合类型与 createIdleTimeCodingPlanFunnelContext；改错故障：来源拼写不一致，入口分组出现孤立空桶。
// INV-07 入口状态只有四种取值，无法判定时必须落 unknown 而不是猜 no_plan；守住位置：resolveCodingPlanEntryPlanState 的兜底返回；改错故障：已购用户被当成未购，未购买占比虚高。
// INV-08 快照与本地展示冲突时以快照为准，快照无明细才回退展示状态；守住位置：resolveCodingPlanEntryPlanState 的 snapshot 前置分支；改错故障：刚续费用户仍上报未购，漏斗转化被低估。
// INV-09 快照标记 no_plan 时套餐名必须置空，不能沿用旧 planLevel；守住位置：unavailableReason 等于 no_plan 的分支；改错故障：无套餐用户带着上一档名称入库，档位分布错乱。
// INV-10 入口阶段不写 entryPlanList，权威快照只能由 Provider 查询完整后补；守住位置：createCodingPlanFunnelContext 中的 entryPlanList 空串；改错故障：入口卡片被当全集上报，套餐覆盖数虚高。
// INV-11 状态与档位必须同源，no_plan 与 unknown 都返回空档位；守住位置：resolveCodingPlanEntryPlanState 的四个 return 点；改错故障：状态显示未购却带套餐名，交叉表出现矛盾行。
// INV-12 体验档判定只看档位词 start 或 Start 供应商，不能把团队计划误判为体验档；守住位置：isStartPlanLevel 与 isStartPlanProviderId；改错故障：团队用户计入体验档，付费结构被错误归类。
// INV-13 设置推导先认个人版与团队版编码计划，再退到体验计划，两次查找顺序不可交换；守住位置：resolveCodingPlanEntryPlanStateFromProviderSettings 的两次 find；改错故障：同时持有两类计划的用户被记成体验档。
// INV-14 账号型接入必须要求 entitled 为 true，未授权供应商不参与推导；守住位置：accountProviders 的 filter 条件；改错故障：未开通用户被算作已购，转化率虚高。
// INV-15 providerFamily 只有 bigmodel、zai、unknown 三值，未知一律 unknown 且不抛错；守住位置：resolveCodingPlanProviderFamily 的末行返回；改错故障：新增供应商让推导抛异常，点击埋点整体中断。
// INV-16 channel 由 family 唯一映射，bigmodel 走 MaaS、zai 走 Z_AI、unknown 为空；守住位置：resolveCodingPlanChannel 的映射表；改错故障：渠道与供应商族不一致，按渠道拆分的报表对不上。
// INV-17 上报必须在同一同步栈内返回，调用方不等待 Promise，也不因失败抛错；守住位置：reportCodingPlanUpgradeClick 的 void 调用；改错故障：埋点失败冒泡到点击处理，按钮点了没反应。
// INV-18 平台或上下文缺失时直接跳过，不做半截上报；守住位置：reportCodingPlanUpgradeClick 的入口判空；改错故障：空壳事件污染漏斗，出现无来源的点击。
// INV-19 同一用户动作只能上报一次，元素名不得在渲染层被重复触发；守住位置：coding_plan_upgrade_ck 的唯一调用点与本函数的单次调用；改错故障：一次点击计两次，漏斗转化率超过 100%。
// INV-20 降级 id 必须带时间戳与随机后缀，并同时输出告警日志以暴露随机源缺失；守住位置：createFallbackFunnelId 的模板与 logger 告警；改错故障：随机源长期不可用却无人发现，漏斗 id 出现碰撞。
//
// 本文件只做编码计划升级漏斗的埋点数据组装与上报，不持有任何 UI 状态。
// 数据流：入口识别拼上下文，点击时补全白名单属性，再交给 appTelemetry 异步发出。
// 所有失败路径静默，埋点缺数据不能影响用户点击升级。
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  isZaiCodingPlanProviderId,
  ZAI_PROVIDER_ID,
  type IPlatformService,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

export type CodingPlanUpgradeSource =
  | "profile_menu"
  | "session_quota_alert"
  | "session_token_usage"
  | "session_idle_time"
  | "setting_plan_card"
  | "setting_start_plan_card"
  | "setting_personal_plan_banner"
  | "setting_team_plan_banner";

export type CodingPlanEntryPlanStatus = "no_plan" | "start_plan" | "coding_plan" | "unknown";

export type CodingPlanPurchaseAudience = "" | "personal" | "team";
export type CodingPlanProviderFamily = "bigmodel" | "zai" | "unknown";

export interface CodingPlanFunnelContext {
  purchaseFunnelId: string;
  upgradeSource: CodingPlanUpgradeSource;
  eventRegion: string;
  eventText: string;
  entryPlanStatus: CodingPlanEntryPlanStatus;
  entryPlanLevel: string;
  entryPlanList: string;
  purchaseAudience: CodingPlanPurchaseAudience;
  providerFamily: CodingPlanProviderFamily;
  channel: string;
}

export interface CodingPlanEntryPlanState {
  entryPlanStatus: CodingPlanEntryPlanStatus;
  entryPlanLevel: string;
}

type TelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

// 每次进入漏斗生成一个 id，作为四步串联的唯一关联键。
// [并发] 纯同步返回，不依赖调用顺序，同一 tick 内多次调用互不干扰。
export function createPurchaseFunnelId(): string {
  // 优先使用平台随机 UUID，缺失时整条回退到本地降级实现。
  // [失败路径] 可选链保证老运行时或非安全上下文不抛错。
  // [权衡] `createFallbackFunnelId` 时间粒度较粗，只在 `randomUUID` 不可用时启用。
  return globalThis.crypto?.randomUUID?.() ?? createFallbackFunnelId();
}

// 上下文是不可变快照，四个漏斗步骤共享同一份字段。
// [事务] 所有字段在同一次返回里一次成型，调用方拿不到半成品。
export function createCodingPlanFunnelContext(params: {
  providerId: string;
  upgradeSource: CodingPlanUpgradeSource;
  eventRegion: string;
  eventText: string;
  entryPlanState?: CodingPlanEntryPlanState;
  purchaseAudience?: CodingPlanPurchaseAudience;
}): CodingPlanFunnelContext {
  // 供应商族只在这一处推导，后续渠道也从它派生。
  // [权衡] 未知供应商不抛错而是归为 unknown，保证埋点不阻塞点击。
  const providerFamily = resolveCodingPlanProviderFamily(params.providerId);
  return {
    purchaseFunnelId: createPurchaseFunnelId(),
    upgradeSource: params.upgradeSource,
    eventRegion: params.eventRegion,
    eventText: params.eventText,
    // 入口状态缺省为 unknown，宁可少归类也不猜测用户是否已购。
    // [失败路径] 上游没传入口状态时仍产出可上报的完整上下文。
    // 只有 Provider 查询出权威状态后，才会出现 no_plan 或 coding_plan。
    entryPlanStatus: params.entryPlanState?.entryPlanStatus ?? "unknown",
    entryPlanLevel: params.entryPlanState?.entryPlanLevel ?? "",
    // 入口卡片不是已购套餐全集；只由 Provider 在查询完整后填入权威快照。
    // 入口卡片不是已购套餐全集：entryPlanList 留空串，等 Provider 回填权威快照。
    // [权衡] 空串由上层视为未采集，避免把入口可见套餐当成订阅全集。
    entryPlanList: "",
    purchaseAudience: params.purchaseAudience ?? "",
    providerFamily,
    channel: resolveCodingPlanChannel(providerFamily),
  };
}

export function createIdleTimeCodingPlanFunnelContext(params: {
  providerId: string;
  eventText: string;
  entryPlanState: CodingPlanEntryPlanState;
}): CodingPlanFunnelContext {
  return createCodingPlanFunnelContext({
    providerId: params.providerId,
    // 空闲场景固定来源为 session_idle_time，与其余七种入口区分。
    // 该来源同时固定 personal 受众，因为空闲提示只出现在个人会话。
    upgradeSource: "session_idle_time",
    eventRegion: "app.session",
    eventText: params.eventText,
    entryPlanState: params.entryPlanState,
    purchaseAudience: "personal",
  });
}

// 把展示状态、供应商与快照归一成漏斗可用的入口档位。
// 判定顺序即优先级：快照高于展示状态，展示状态高于供应商推断。
export function resolveCodingPlanEntryPlanState(params: {
  displayStatus?: string | null;
  providerId?: string | null;
  planLevel?: string | null;
  snapshot?: UsageEntitlementSnapshot | null;
}): CodingPlanEntryPlanState {
  const rawPlanLevel = params.planLevel?.trim() ?? "";
  const snapshotLevel =
    params.snapshot?.subscription?.details?.[0]?.productName?.trim() ||
    params.snapshot?.subscription?.details?.[0]?.productId?.trim() ||
    params.snapshot?.quota?.level?.trim() ||
    "";
  // 显式传入的档位优先，缺失才从快照里逐级回退。
  // [权衡] 两个来源都先裁剪再比较，避免空白被当成有效档位。
  const entryPlanLevel = rawPlanLevel || snapshotLevel;
  if (params.snapshot) {
    // 快照明确说没有套餐时直接判定未购，档位一并清空。
    // [失败路径] 该分支先于明细判定，避免旧明细残留导致误判已购。
    // no_plan 分支把 entryPlanLevel 置空串，防止无套餐用户带上历史档位名。
    if (params.snapshot.unavailableReason === "no_plan") {
      return { entryPlanStatus: "no_plan", entryPlanLevel: "" };
    }
    if (params.snapshot.subscription?.details.length) {
      return {
        entryPlanStatus: isStartPlanLevel(entryPlanLevel) ? "start_plan" : "coding_plan",
        entryPlanLevel,
      };
    }
  }
  // 没有快照时退回本地展示状态，notPurchased 直接判未购。
  // 该分支同样清空档位，与快照分支保持相同形状。
  if (params.displayStatus === "notPurchased") {
    return { entryPlanStatus: "no_plan", entryPlanLevel: "" };
  }
  if (params.displayStatus === "purchased") {
    return {
      entryPlanStatus: isStartPlanLevel(entryPlanLevel) ? "start_plan" : "coding_plan",
      entryPlanLevel,
    };
  }
  if (params.providerId && isStartPlanProviderId(params.providerId) && entryPlanLevel) {
    return { entryPlanStatus: "start_plan", entryPlanLevel };
  }
  return { entryPlanStatus: "unknown", entryPlanLevel: "" };
}

export function resolveCodingPlanEntryPlanStateFromProviderSettings(
  view: ProviderSettingsView | null,
): CodingPlanEntryPlanState {
  if (!view) {
    return resolveCodingPlanEntryPlanState({});
  }
  // 候选集只含账号型且已授权的供应商，其余不参与推导。
  // [事务] 先过滤再匹配，保证后续两次查找在同一集合内进行。
  const accountProviders = view.providers.filter(
    (provider) =>
      provider.effectiveConfig.access?.type === "zhipu-account" &&
      provider.effectiveConfig.access.entitled === true,
  );
  // 优先匹配个人版与团队版编码计划，不用含 Start 的宽泛 helper，避免误判体验档。
  // [权衡] 团队计划同样持有编码计划，因此不能只认个人版 id。
  const codingPlanProvider = accountProviders.find(
    (provider) =>
      provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
      provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
      // Team 同样持有 Coding Plan；不能用包含 Start 的宽泛 helper 判断套餐。
      provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
      provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  if (codingPlanProvider) {
    return resolveCodingPlanEntryPlanState({
      displayStatus: "purchased",
      providerId: codingPlanProvider.providerId,
    });
  }
  const startPlanProvider = accountProviders.find((provider) =>
    isStartPlanProviderId(provider.providerId),
  );
  if (startPlanProvider) {
    return resolveCodingPlanEntryPlanState({
      displayStatus: "purchased",
      providerId: startPlanProvider.providerId,
      planLevel: "start",
    });
  }
  return resolveCodingPlanEntryPlanState({ displayStatus: "notPurchased" });
}

// 升级点击的唯一上报出口，其它位置不得自行拼事件对象。
// [失败路径] 用 void 发出 Promise，失败只走 appTelemetry 内部日志。
// 第三个参数是模块名，用于日志定位，不进入埋点属性。
export function reportCodingPlanUpgradeClick(
  platform: TelemetryPlatform | null | undefined,
  context: CodingPlanFunnelContext | null | undefined,
): void {
  // [并发] 平台未就绪或上下文缺失时静默返回，不做半截上报。
  // [失败路径] 这里吞掉异常场景，保证点击处理链不被埋点打断。
  if (!platform || !context) {
    return;
  }
  void reportAppTelemetryEvent(
    platform,
    {
      eventType: "ck",
      eventRegion: context.eventRegion,
      // 元素名与事件类型共同构成漏斗步骤标识，改名等于换指标。
      // [事务] 事件对象在调用处一次成型，不留给后续层补字段。
      elementName: "coding_plan_upgrade_ck",
      eventText: context.eventText,
      eventExtraDetail: buildFunnelBaseDetail(context),
    },
    "codingPlanFunnelTelemetry",
  );
}

// 属性白名单在此固定为八个键，新增维度必须同步看板。
// [事务] 只输出白名单内字段，其余上下文成员不会泄漏到事件里。
export function buildFunnelBaseDetail(context: CodingPlanFunnelContext): Record<string, string> {
  return stringifyDetail({
    purchase_funnel_id: context.purchaseFunnelId,
    upgrade_source: context.upgradeSource,
    entry_plan_status: context.entryPlanStatus,
    entry_plan_level: context.entryPlanLevel,
    entry_plan_list: context.entryPlanList,
    purchase_audience: context.purchaseAudience,
    provider_family: context.providerFamily,
    channel: context.channel,
  });
}

// 先比 bigmodel 系列，再比 zai 系列，最后回落 unknown。
// [失败路径] 不认识的新供应商返回 unknown，不抛错也不阻断上报。
export function resolveCodingPlanProviderFamily(providerId: string): CodingPlanProviderFamily {
  if (
    providerId === BIGMODEL_PROVIDER_ID ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return "bigmodel";
  }
  if (providerId === ZAI_PROVIDER_ID || isZaiCodingPlanProviderId(providerId)) {
    return "zai";
  }
  return "unknown";
}

export function resolveCodingPlanChannel(providerFamily: CodingPlanProviderFamily): string {
  return { bigmodel: "MaaS", zai: "Z_AI", unknown: "" }[providerFamily];
}

// 统一把属性值转成字符串，事件协议只接受字符串字典。
// [权衡] undefined 与 null 变空串且不删键，保持每次上报同形。
export function stringifyDetail(detail: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      value === undefined || value === null ? "" : String(value),
    ]),
  );
}

function isStartPlanProviderId(providerId: string): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

// 体验档判定按单词边界匹配 start，大小写不敏感。
// [权衡] 用词边界避免 restart 之类子串误命中。
function isStartPlanLevel(value: string): boolean {
  return /\bstart\b/i.test(value.trim());
}

function createFallbackFunnelId(): string {
  logger.warn("[codingPlanFunnelTelemetry] crypto.randomUUID unavailable, using fallback id");
  return `funnel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
