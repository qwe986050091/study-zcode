// INV-01 断言：providerId 与 modelId 必须先 trim 归一 —— 守住它的位置：hook 顶部的 activeProviderId 与 modelId 两个常量 —— 改错故障：带空白的 provider 绕过套餐判定，横幅在错误会话上弹出。
// INV-02 断言：纯空白 provider 必须退化为 null，不能保留空串 —— 守住它的位置：两处 `|| null` 兜底 —— 改错故障：空串让 isStartPlanModelProviderId 得到看似有效的非空入参，dismiss key 与套餐分支都被污染。
// INV-03 断言：四个 GLM 编码套餐 id 必须集中判定 —— 守住它的位置：isGlmQuotaBannerProviderId —— 改错故障：漏一个 id 后该套餐的 1308 类额度错误不再接管，被通用错误横幅盖住升级入口。
// INV-04 断言：运行态只认 prewarming 与 running —— 守住它的位置：isRunningPhase —— 改错故障：把 idle 或 terminated 算作运行态后，阶段切换不再触发强制刷新，余额停在预占前的旧值。
// INV-05 [失败路径] 断言：1005 只在 Start Plan provider 内接管错误 —— 守住它的位置：serverQuotaExhausted 的组合判断 —— 改错故障：其他供应商返回 1005 时横幅抢走错误展示，用户看不到真实报错原因。
// INV-06 [失败路径] 断言：3008/3009/3010 同样必须叠加 Start Plan 边界 —— 守住它的位置：serverConcurrentLimited —— 改错故障：并发提示出现在非套餐会话，用户无法通过升级解决，提示失去可信度。
// INV-07 [权衡] 断言：GLM 额度码只在白名单 provider 上接管 —— 守住它的位置：serverProviderLimited —— 改错故障：白名单外的鉴权或参数错误被误判成额度问题，真实故障被隐藏。
// INV-08 断言：takesOverError 必须等于三个 server 标记的并集 —— 守住它的位置：takesOverError 常量 —— 改错故障：漏项会让 dismissKey 丢掉 errorKey，关闭一次后同类错误在本次会话内永久不再提示。
// INV-09 断言：entitlement 查询必须与 settings 的 ready 状态绑定 —— 守住它的位置：buildStartPlanEntitlementOptions 的第一个实参 —— 改错故障：未就绪时把空视图当套餐视图，横幅闪一下又消失。
// INV-10 断言：非 Start Plan 会话传空串而非 undefined —— 守住它的位置：buildStartPlanEntitlementOptions 第二个实参的三元 —— 改错故障：缺省语义切换后首选 provider 退回默认值，查询到与本会话无关的套餐。
// INV-11 [资源] 断言：reminderOwner 身份只含 sessionId、activeProviderId、modelId —— 守住它的位置：reminderOwner 的 useMemo —— 改错故障：把 snapshot 或 store 版本放进身份，每次余额刷新都换 owner，当前提醒立即被判为已隐藏。
// INV-12 [并发] 断言：reminderVersion 必须列进 state 的依赖 —— 守住它的位置：state 的 useMemo 依赖数组 —— 改错故障：其他会话写入提醒 store 后本会话不重算，过期结论让同一额度桶被重复提示。
// INV-13 [事务] 断言：带 reminderKey 的关闭只走提醒 store —— 守住它的位置：dismiss 回调的第一个分支 —— 改错故障：再写 session 级关闭表后，桶周期结束产生的新提醒会被旧 dismissKey 挡住。
// INV-14 断言：关闭提醒前必须补一次 markShown —— 守住它的位置：dismiss 内对 reminderExpiresAt 与 reminderReferenceTime 的双判空 —— 改错故障：可见性回调未执行时用户先点关闭，已展示事实丢失，同桶下个周期再次弹出。
// INV-15 断言：提醒 key 变化时必须释放旧 key —— 守住它的位置：previousReminderKeyRef 的 effect —— 改错故障：旧展示 owner 不释放，持有同一桶的其他会话被判为已展示而不再提示。
// INV-16 [失败路径] 断言：不可见状态不得产出 dismissKey —— 守住它的位置：buildSessionQuotaBannerDismissKey 的可见性前置判断 —— 改错故障：无效 key 写进关闭表，容量 256 的环形淘汰会把真实关闭记录挤掉。
// INV-17 [资源] 断言：升级查询必须由 shouldCheckTerminalPlan 门控 —— 守住它的位置：upgradeEntitlement 的 enabled 实参 —— 改错故障：每条横幅都带 refreshOnMount，无升级入口的 MCP 提示也多发一次权益请求。
// INV-18 [权衡] 断言：顶配套餐或本就不提供升级时对外 provider 必须为 null —— 守住它的位置：return 里 upgradeProviderId 的三元 —— 改错故障：顶配用户仍看到升级按钮，点击进入无法购买的套餐页。
//
// 模块职责：把会话错误、套餐快照与 MCP 不可用事实投影成一条可关闭的额度横幅，并给出关闭记忆与升级入口。
// 状态所有权：额度来自 entitlement 服务，关闭与已展示事实分别落在两个外部 store，本 hook 不持有持久状态。
// 阅读顺序：先看三个 server 错误标记与 takesOverError，再看 state 投影与 dismissKey，最后看升级门控与阶段刷新。
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { BUILTIN_MODEL_PROVIDER_IDS, isStartPlanModelProviderId } from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import type { SessionErrorInfo, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import {
  resolveGlmQuotaBannerBusinessCode,
  resolveStartPlanConcurrentLimitBannerReason,
  resolveStartPlanConcurrentLimitBusinessCode,
  resolveStartPlanQuotaExhaustedBusinessCode,
} from "@/lib/providerBusinessError.js";
import {
  isMaxCodingPlanSnapshot,
  isTerminalCodingPlanSnapshot,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  buildSessionQuotaBannerDismissKey,
  buildSessionQuotaBannerState,
  resolveQuotaBannerUpgradeProviderId,
  shouldOfferQuotaBannerUpgrade,
} from "@/v4/sessionQuotaBannerState.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { logger } from "@/logger.js";
import { sessionQuotaBannerDismissalStore } from "@/v4/sessionQuotaBannerDismissalStore.js";
import { startPlanQuotaReminderStore } from "@/v4/startPlanQuotaReminderStore.js";

// 两个私有判定函数只服务本 hook，不导出：供应商白名单决定哪些额度错误能接管横幅，运行态判定决定何时强制刷新余额。
// [权衡] isGlmQuotaBannerProviderId 列出四个内置编码套餐 id，新增套餐必须同步这里，否则 1308 系额度错误会退回通用错误展示。
// 该白名单与 sessionQuotaBannerState 内部同名函数各持一份，本文件只用于服务端接管判断，改动时两处都要对齐。
// isRunningPhase 只认 prewarming 与 running：这两个阶段在预占或占用并发额度，进入和退出都是余额变化的时机。
// 把 idle、terminated 也算运行态会让阶段切换失去意义，强制刷新永远不会触发。
function isGlmQuotaBannerProviderId(providerId: string | null): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

function isRunningPhase(phase: SessionPhase | null): boolean {
  return phase === "prewarming" || phase === "running";
}

/**
 * V4 quota 业务状态：conversation snapshot 只提供当前 provider/model/错误，额度仍由
 * entitlement 服务读取。两者在 renderer 合并，不把购买或额度状态写回 conversation。
 */
// 入参只带会话投影与展示所需事实：会话标识、错误、错误指纹、阶段、当前 provider 与 model，以及可选的用量服务。
// 错误与阶段来自 conversation 事件；额度、订阅与套餐信息一律由 entitlement 服务提供，两者在 renderer 合并，不回写会话状态。
// mcpUnavailableNotice 由调用方从 conversation rows 解析后传入，本 hook 不读 rows，也不自行判断 MCP 可用性。
// [权衡] usageStatsService 可选，缺省时由 useUsageEntitlementWithService 取默认服务；测试可直接注入替身。
// 参数每次渲染都是新对象，因此下文所有 memo 与 effect 都不依赖 params 引用，只拆取各自需要的字段。
export function useV4SessionQuotaBanner(params: {
  sessionId: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  phase: SessionPhase | null;
  providerId: string | null;
  modelId: string | null;
  usageStatsService?: IUsageStatsService;
  /**
   * 官方 Server MCP 不可用的事实。由调用方从 conversation rows 解析——它是会话事件的投影，
   * 与 entitlement 服务无关，不放进这个 hook 里取。
   */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}) {
  // 先归一 provider 与 model，再解析三类服务端业务码：Start Plan 额度耗尽 1005、并发上限 3008/3009/3010、GLM 额度码。
  // [失败路径] 1005 与并发码都必须叠加 isStartPlanProvider 才置真，避免其他供应商的同名错误被套餐横幅截胡。
  // providerId 为空时 isStartPlanProvider 为假，三个 server 标记同时失效，后续 state 会退回隐藏态。
  // 并发原因由错误文案区分首次繁忙与自动重试耗尽，取值在 state 组装时按码是否命中再补进参数。
  // takesOverError 是三者的并集，它同时决定横幅是否展示服务端错误，以及 dismissKey 是否携带 errorKey。
  const activeProviderId = params.providerId?.trim() || null;
  const modelId = params.modelId?.trim() || null;
  const isStartPlanProvider = Boolean(
    activeProviderId && isStartPlanModelProviderId(activeProviderId),
  );
  const quotaExhaustedCode = resolveStartPlanQuotaExhaustedBusinessCode(
    params.error?.code,
    params.error?.message,
  );
  const concurrentLimitCode = resolveStartPlanConcurrentLimitBusinessCode(
    params.error?.code,
    params.error?.message,
  );
  const providerLimitedCode = resolveGlmQuotaBannerBusinessCode(params.error?.code);
  const serverQuotaExhausted = quotaExhaustedCode === "1005" && isStartPlanProvider;
  const serverConcurrentLimited = Boolean(concurrentLimitCode) && isStartPlanProvider;
  const serverProviderLimited = Boolean(
    providerLimitedCode && isGlmQuotaBannerProviderId(activeProviderId),
  );
  const takesOverError = serverQuotaExhausted || serverConcurrentLimited || serverProviderLimited;

  // settings 提供套餐视图，用来构造 entitlement 查询选项；视图未 ready 时传 null，让 hook 走未就绪分支而不是空套餐。
  // [并发] 非 Start Plan 会话传空串占位而非 undefined：两种缺省语义不同，空串表示明确不指定首选 provider。
  // 两次 entitlement 查询共用同一个 usageStatsService，但选项不同：主查询跟当前套餐，升级查询跟候选套餐。
  // entitlement 的 snapshot 是额度唯一来源，本 hook 不做本地扣减，也不缓存跨 provider 的余额。
  // 不在渲染期调用刷新，所有 refresh 都放在下面的 effect 或用户动作里，否则每次渲染都会发请求。
  const settings = useProviderSettingsView();
  const entitlement = useUsageEntitlementWithService(params.usageStatsService, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      isStartPlanProvider ? activeProviderId! : "",
    ),
  });
  // reminderVersion 用 useSyncExternalStore 订阅提醒 store 的版本号，服务端快照函数复用 getSnapshot，保证 SSR 也稳定。
  // [资源] reminderOwner 只含 sessionId、activeProviderId、modelId，余额刷新不会产生新身份，当前提醒因此不会被自己判为已隐藏。
  // state 由 buildSessionQuotaBannerState 纯函数投影，可选字段条件展开，未命中时不传键而不是传 undefined。
  // isReminderHidden 闭包复用 reminderOwner 与快照时间，是否隐藏由 store 的 owner 归属决定，本 hook 不自行计周期。
  // 依赖数组显式列出每个入参，snapshot 与错误文案变化都会重算；漏掉任一项都会让横幅停在上一帧结论。
  const reminderVersion = useSyncExternalStore(
    startPlanQuotaReminderStore.subscribe,
    startPlanQuotaReminderStore.getSnapshot,
    startPlanQuotaReminderStore.getSnapshot,
  );
  // 展示实例随任务/模型切换而更新；余额刷新不能生成新实例，否则会立即收起当前提醒。
  const reminderOwner = useMemo(
    () => ({ sessionId: params.sessionId, activeProviderId, modelId }),
    [params.sessionId, activeProviderId, modelId],
  );
  const state = useMemo(
    () =>
      buildSessionQuotaBannerState({
        activeProviderId,
        snapshot: entitlement.snapshot,
        modelId,
        isReminderHidden: (key, referenceTime) =>
          startPlanQuotaReminderStore.isHidden(key, reminderOwner, referenceTime),
        serverQuotaExhausted,
        serverConcurrentLimited,
        ...(concurrentLimitCode ? { serverConcurrentLimitBusinessCode: concurrentLimitCode } : {}),
        ...(concurrentLimitCode
          ? {
              serverConcurrentLimitReason: resolveStartPlanConcurrentLimitBannerReason(
                params.error?.message,
              ),
            }
          : {}),
        ...(providerLimitedCode ? { serverProviderLimitedBusinessCode: providerLimitedCode } : {}),
        ...(serverProviderLimited
          ? { serverProviderLimitedMessage: params.error?.message ?? null }
          : {}),
        ...(params.mcpUnavailableNotice
          ? { mcpUnavailableNotice: params.mcpUnavailableNotice }
          : {}),
      }),
    [
      activeProviderId,
      reminderOwner,
      reminderVersion,
      concurrentLimitCode,
      entitlement.snapshot,
      modelId,
      params.error?.message,
      params.mcpUnavailableNotice,
      providerLimitedCode,
      serverConcurrentLimited,
      serverProviderLimited,
      serverQuotaExhausted,
    ],
  );

  // dismissKey 由 state 生成，只有可见横幅才有值；服务端错误接管时再拼上 errorKey，使同类错误的不同失败可分别关闭。
  // [事务] 关闭记忆写入 sessionQuotaBannerDismissalStore，按 sessionId 隔离且不持久化，跨窗口不共享。
  // 订阅该 store 的版本号是为了在本组件内感知其他路径的关闭，未订阅时 dismissed 只在首次渲染求值一次。
  // [失败路径] dismissed 需要 sessionId 与 dismissKey 同时存在才查询，缺一直接为假，避免空键命中空条目。
  // 恢复日志按 sessionId 与 dismissKey 组成指纹去重，同一条关闭只记录一次，防止每次渲染刷日志。
  // [资源] 指纹存的是拼接后的字符串而不是对象，比对不依赖引用，日志路径没有额外的 memo 开销。
  const dismissKey = buildSessionQuotaBannerDismissKey(
    state,
    takesOverError ? params.errorKey : null,
  );
  const previousReminderKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousKey = previousReminderKeyRef.current;
    previousReminderKeyRef.current = state.reminderKey;
    // 已展示的提醒退出后结束展示实例，避免余额回升再降低时在同一周期重复弹出。
    if (previousKey && previousKey !== state.reminderKey) {
      startPlanQuotaReminderStore.dismiss(previousKey);
    }
  }, [state.reminderKey]);
  useSyncExternalStore(
    sessionQuotaBannerDismissalStore.subscribe,
    sessionQuotaBannerDismissalStore.getSnapshot,
    sessionQuotaBannerDismissalStore.getSnapshot,
  );
  const dismissed = Boolean(
    params.sessionId &&
    dismissKey &&
    sessionQuotaBannerDismissalStore.isDismissed(params.sessionId, dismissKey),
  );
  const restoredDismissalRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dismissed || !params.sessionId || !dismissKey) return;
    const fingerprint = `${params.sessionId}\u0000${dismissKey}`;
    if (restoredDismissalRef.current === fingerprint) return;
    restoredDismissalRef.current = fingerprint;
    logger.debug("session quota banner dismissal restored", {
      dismissKey,
      sessionId: params.sessionId,
    });
  }, [dismissKey, dismissed, params.sessionId]);

  // 升级入口只对可见且应当提供升级的横幅有意义：先看 banner kind，再看候选 provider 是否本身就是 Start Plan。
  // [资源] shouldCheckTerminalPlan 为假时 upgradeEntitlement 不会发请求，MCP 今日额度用完这类提示因此省掉一次 refreshOnMount。
  // 升级查询显式要求首选 provider、允许已禁用候选、关掉环境变量 API Key，避免拿本机 key 误判为已购套餐。
  // terminalSnapshot 先认主查询的 snapshot，再认升级查询，两者都要求 provider id 与候选一致，防止跨套餐串档。
  // terminalPlan 与 maxPlan 都是对同一 snapshot 的判定，前者用于隐藏升级入口，后者用于切换续费文案。
  // [权衡] 顶配套餐时再返回候选 provider 已无意义，所以最终结论在 return 处统一收敛为 null。
  const upgradeProviderId = resolveQuotaBannerUpgradeProviderId(activeProviderId);
  const shouldCheckTerminalPlan =
    state.visible &&
    upgradeProviderId !== null &&
    // 不提供升级入口的提示（如 MCP 今日额度用完）无需判断是否已是顶配套餐，
    // 省掉一次 refreshOnMount 的 entitlement 请求。
    shouldOfferQuotaBannerUpgrade(state.kind) &&
    !isStartPlanModelProviderId(upgradeProviderId);
  const upgradeEntitlement = useUsageEntitlementWithService(params.usageStatsService, {
    enabled: shouldCheckTerminalPlan,
    includeSubscription: true,
    preferredProviderId: upgradeProviderId ?? undefined,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    refreshOnMount: true,
  });
  const terminalSnapshot =
    entitlement.snapshot?.provider?.id === upgradeProviderId
      ? entitlement.snapshot
      : upgradeEntitlement.snapshot?.provider?.id === upgradeProviderId
        ? upgradeEntitlement.snapshot
        : null;
  const terminalPlan = terminalSnapshot !== null && isTerminalCodingPlanSnapshot(terminalSnapshot);
  const maxPlan = terminalSnapshot !== null && isMaxCodingPlanSnapshot(terminalSnapshot);

  // [并发] 阶段跨越运行态边界时强制刷新一次：进入预占额度、退出释放或扣减，普通新鲜度窗口会读到旧余额。
  // 该 effect 只在 Start Plan 会话且阶段真的变化时执行，silent 让刷新不打断现有展示。
  // 模型切换的刷新跳过首次挂载：首个 nextKey 只记录基线，真正换模型或换 provider 才按 initial 语义请求。
  // [事务] dismiss 先按 reminderKey 分派，提醒类只写提醒 store，其余写 session 级关闭表，两条通道不可交叉。
  // markShown 单独暴露给可见性回调，参数不全时静默跳过，表示这一帧没有可持久化的提醒事实。
  // 返回值是稳定契约：终态套餐或无升级入口时 upgradeProviderId 为 null，动作文案按 maxPlan 在续费与升级之间取一。
  const previousPhaseRef = useRef<SessionPhase | null>(params.phase);
  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = params.phase;
    if (!isStartPlanProvider || previousPhase === params.phase) return;
    if (isRunningPhase(previousPhase) !== isRunningPhase(params.phase)) {
      // 任务开始会预占额度，终止会扣减或释放；必须绕过普通 freshness 校正一次。
      void entitlement.refresh({ force: true, silent: true, reason: "manual" });
    }
  }, [entitlement.refresh, isStartPlanProvider, params.phase]);

  const modelRefreshInitializedRef = useRef(false);
  const previousModelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const nextKey = isStartPlanProvider && modelId ? `${activeProviderId}:${modelId}` : null;
    const previousKey = previousModelKeyRef.current;
    previousModelKeyRef.current = nextKey;
    if (!modelRefreshInitializedRef.current) {
      modelRefreshInitializedRef.current = true;
      return;
    }
    if (nextKey && nextKey !== previousKey) {
      void entitlement.refresh({ reason: "initial" });
    }
  }, [activeProviderId, entitlement.refresh, isStartPlanProvider, modelId]);

  const dismiss = useCallback(() => {
    if (state.reminderKey) {
      // 点击关闭本身证明用户已看到提示，避免可见性回调尚未执行时关闭无效。
      if (state.reminderExpiresAt !== undefined && state.reminderReferenceTime !== undefined) {
        startPlanQuotaReminderStore.markShown(
          state.reminderKey,
          state.reminderExpiresAt,
          reminderOwner,
          state.reminderReferenceTime,
        );
      }
      startPlanQuotaReminderStore.dismiss(state.reminderKey);
      return;
    }
    if (!params.sessionId || !dismissKey) return;
    sessionQuotaBannerDismissalStore.dismiss(params.sessionId, dismissKey);
  }, [
    dismissKey,
    params.sessionId,
    reminderOwner,
    state.reminderKey,
    state.reminderExpiresAt,
    state.reminderReferenceTime,
  ]);

  const markShown = useCallback(() => {
    if (
      state.reminderKey &&
      state.reminderExpiresAt !== undefined &&
      state.reminderReferenceTime !== undefined
    ) {
      startPlanQuotaReminderStore.markShown(
        state.reminderKey,
        state.reminderExpiresAt,
        reminderOwner,
        state.reminderReferenceTime,
      );
    }
  }, [reminderOwner, state.reminderExpiresAt, state.reminderKey, state.reminderReferenceTime]);

  return {
    state,
    dismissKey,
    dismissed,
    dismiss,
    markShown,
    takesOverError,
    upgradeProviderId:
      terminalPlan || !shouldOfferQuotaBannerUpgrade(state.kind) ? null : upgradeProviderId,
    upgradeActionLabelId: maxPlan ? "chat.quota.action.renew" : "chat.quota.action.upgrade",
  } as const;
}
