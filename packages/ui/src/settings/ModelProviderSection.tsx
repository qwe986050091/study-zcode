/* eslint-disable max-lines -- Model Provider 设置页需要集中编排导航、表单和 OAuth 交互，后续整体拆分时再收敛。 */
// ============================================================================
// ModelProviderSection.tsx — 模型供应商设置页的编排层（导航 / 连接 / 权益 / OAuth）
//
// 职责边界：
//   - 只做编排：表单渲染在 Detail，侧栏在 SectionLayout，导航树在
//     useModelProviderNavigation，OAuth 副作用在 oauthActions。
//   - 本文件持有「页面级会话状态」：选中节点、临时连接选择、登录/解绑进行态。
//   - 读写一律走本机 Local Host（见下方组件注释），不接收 workspaceIdentity。
//
// 四类状态，禁止混用：
//   持久事实   sharedSettings.providerFamilyDomain / ConnectionSelections（落盘）
//   远端快照   providerSettingsView / codingPlanEntitlements / team products
//   页面意图   selectedNodeKey / pendingConnectionSelections（乐观）
//   进行中标记 presetSubscriptionProviderId / codingPlanStatusSyncProviderId /
//              codingPlanDisconnectProviderId（只影响按钮态，不参与身份 key）
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 同步尝试的身份 key 只能由 providerId + activeOAuthProvider 组成。
//   守住它的位置：resolveCodingPlanProviderSyncAttemptKey 的返回表达式。
//   改错故障：把 checking / 展示状态放进 key，状态抖动就会产生新 key，
//   自动水合反复触发同步，形成请求风暴。
//
// INV-02 activeOAuthProvider 与目标不一致时 key 为 null，即「不尝试」。
//   守住它的位置：resolveCodingPlanProviderSyncAttemptKey 的首个 if。
//   改错故障：在 BigModel 登录态下去同步 Z.ai 的 provider，
//   拿到 401 后把按钮永久置为失败态。
//
// INV-03 只有 failed 才允许在「模式与选中键都没变」时重试，且必须由用户动作触发。
//   守住它的位置：shouldRetryUnchangedCodingPlanProviderSync 的四个与条件。
//   改错故障：把 succeeded / inFlight 也纳入重试，点击同项会重复刷新；
//   把该判断移进 effect，自动水合会无限重试。
//
// INV-04 pending 目标只能被消费一次，未知 providerId 必须显式置错而不是静默忽略。
//   守住它的位置：applyModelProviderTarget 的 !providerId 分支返回 true。
//   改错故障：静默忽略会让 pending 指令永远不被消费，导航卡死在外部入口。
//
// INV-05 initialModelProviderTarget 只读取一次（useState 惰性初值），之后不再读取队列。
//   守住它的位置：consumePendingSettingsModelProviderTarget 的 useState 初始化。
//   改错故障：每次渲染都 consume，会把后续外部导航指令提前吃掉。
//
// INV-06 新建 provider 后的选中必须等「列表里真的出现该 provider」再执行。
//   守住它的位置：pendingCreatedProviderId effect 的 some 判断。
//   改错故障：保存先发布快照、后落盘，导航校正会把暂不存在的 custom key 回退，
//   新 provider 出现后也不会再被自动选中。
//
// INV-07 保存后只有「手工 API Key 真的变化」才刷新权益。
//   守住它的位置：shouldRefreshCodingPlanEntitlementsAfterSave 的末尾比较。
//   改错故障：改 enabled / name / models 也刷新，侧栏短暂 loading 并冲掉当前选中。
//
// INV-08 保存不得顺带清空账号域（providerFamilyDomain）。
//   守住它的位置：handleSave 只调 saveProvider，不触碰 sharedSettings。
//   改错故障：配置不可执行时被当作登出，套餐页再选也无法就绪。
//
// INV-09 连接方式切换必须先写 pending，再落盘，再同步 provider。
//   守住它的位置：persistProviderFamilyModeForNavItem 的三段顺序。
//   改错故障：先落盘会让水合 effect 在旧快照上重跑一次同步，选中项来回闪。
//
// INV-10 pending 只有在持久化快照追上后才清除。
//   守住它的位置：connectionSelections effect 里的 JSON 相等比较。
//   改错故障：提前清除会让旧 mode 把选中项短暂纠偏回去，表现为点击后闪一下。
//
// INV-11 落盘失败必须回滚 pending，并把 attempt 标为 failed。
//   守住它的位置：persistProviderFamilyModeForNavItem 的 catch。
//   改错故障：UI 显示已切到团队套餐，实际仍是个人，权益与按钮全部错配。
//
// INV-12 同一 provider/OAuth 组合的自动水合只执行一次，userTransition 才允许重入。
//   守住它的位置：syncCodingPlanProviderOnce 的 has(attemptKey) 早退。
//   改错故障：每次选中都同步一次，切换导航就刷一轮 provider 列表。
//
// INV-13 同步失败必须保留 failed 状态，不能删除 map 条目。
//   守住它的位置：catch 里的 set(attemptKey, failed) 后重新抛出。
//   改错故障：删掉条目等价于「从未尝试」，自动水合会再次触发，形成失败循环。
//
// INV-14 预设订阅完成回调必须用 ref 去重，且在本轮权益刷新结束后才释放。
//   守住它的位置：presetSubscriptionCompletionProviderIdRef 的比较与 finally。
//   改错故障：提前释放会让 Plan Card 短暂显示旧套餐态（非 loading）。
//
// INV-15 预设订阅必须有超时兜底，且只清理仍指向自己的进行中标记。
//   守住它的位置：PRESET_SUBSCRIPTION_TIMEOUT_MS 的 setTimeout。
//   改错故障：权益接口挂起时按钮永远转圈，无法重试。
//
// INV-16 解绑必须走 provider logout，并清理 Coding Plan webview 的独立存储。
//   守住它的位置：handleCodingPlanDisconnect 的 oauthService.logout 与 ClearCodingPlanWebviewStorage。
//   改错故障：只清 token 不清 webview 分区，重新登录后仍是旧账号的官网会话。
//
// INV-17 解绑后必须切换 providerFamilyDomain 并清 user（若是最后一个登录态）。
//   守住它的位置：resolveLogoutProviderFamilyDomain + updateSharedSettings + clearUserWhenLoggedOut。
//   改错故障：侧边栏继续显示旧登录态直到重启。
//
// INV-18 已登录同一 provider 时点击 Connect 只做刷新，不重新走登录入口。
//   守住它的位置：handleCodingPlanLogin 的 activeOAuthProvider === providerId 分支。
//   改错故障：把 refresh 变成 RequestLoginEntry，用户会被无谓地弹登录框。
//
// INV-19 营销导航只定位侧栏节点，不得复用带 mode 的选择路径。
//   守住它的位置：marketing effect 里只调 setSelectedNodeKey。
//   改错故障：从营销页跳转顺手改写了套餐连接方式，用户套餐被切换。
//
// INV-20 模型排序权限与 provider 排序权限是两套，不能互相复用。
//   守住它的位置：onReorderProviderModels 直接传 reorderProviderModels。
//   改错故障：Built-in Provider 的模型无法写入 Personal modelOrder。
//
// INV-21 首屏必须始终渲染布局壳，不允许整页 return null。
//   守住它的位置：presetLoading / customLoading 与最后的 return。
//   改错故障：慢网下整块设置页空白，用户以为页面坏了。
//
// INV-22 加载失败走独立错误页并可重试；此分支不得渲染导航骨架。
//   守住它的位置：if (loadError) 的提前 return。
//   改错故障：错误页里带着一个永远 loading 的侧栏，没有可用的重试入口。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { marketingNavigation, finishMarketingNavigation } from "@/lib/marketingNavigation.js";
import {
  getProviderFormApiKey,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DesktopCommandIds,
  isStartPlanModelProviderId,
  type BuiltinModelProviderId,
  type ModelConnectivityResult,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type OAuthProviderId,
  resolveModelProviderFamilyIdByProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  PRESET_PROVIDER_SPECS,
  PRESET_SUBSCRIPTION_TIMEOUT_MS,
  BIGMODEL_REGISTRATION_URL,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "./model-provider-section/constants.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import type { CodingPlanLoginOptions } from "./model-provider-section/codingPlanPricingCards.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { reportPresetSubscriptionSuccess } from "./model-provider-section/oauthActions.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "./model-provider-section/utils.js";
import {
  confirmAndDeleteModelProvider,
  refreshModelProviderSection,
  refreshProviderPanelAfterAuthChange as refreshModelProviderPanelAfterAuthChange,
} from "./model-provider-section/modelProviderActions.js";
import {
  useCodingPlanAccessRefresh,
  useCodingPlanEntitlements,
} from "./model-provider-section/useCodingPlanEntitlements.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

type CodingPlanConnectionNavItem = Extract<
  ModelProviderNavGroup["items"][number],
  { type: "codingPlan" | "teamPlan" }
>;

// INV-01 / INV-02 的唯一实现：身份 key 只由稳定的 provider 与 OAuth 事实构成。
// 返回 null 表示「当前登录态与该连接不匹配」，调用方据此跳过而不是报错。
export function resolveCodingPlanProviderSyncAttemptKey({
  activeOAuthProvider,
  oauthProviderId,
  providerId,
}: {
  activeOAuthProvider: OAuthProviderId | null;
  oauthProviderId: OAuthProviderId;
  providerId: BuiltinModelProviderId;
}): string | null {
  // [失败路径] 不匹配必须返回 null：这是「不尝试」的唯一表达，
  // 不要用空串代替——空串会被 Map 当成合法 key，导致跨 provider 串状态。
  if (activeOAuthProvider !== oauthProviderId) {
    return null;
  }
  // 操作身份只由稳定的 provider/auth 事实组成，禁止把 checking 等展示状态放入 key。
  // 分隔符用冒号且两侧都来自枚举，不存在歧义；拼接顺序不可交换（会影响已持久化的运行时 key）。
  return `${providerId}:${activeOAuthProvider}`;
}

// INV-03：仅在「什么都没变却失败了」时允许用户手动重试。
// [权衡] 四个条件全部为与：attemptKey 非空、状态为 failed、模式未变、选中键未变。
export function shouldRetryUnchangedCodingPlanProviderSync({
  attemptKey,
  attemptStatus,
  modeUnchanged,
  selectedKeyUnchanged,
}: {
  attemptKey: string | null;
  attemptStatus: "inFlight" | "succeeded" | "failed" | undefined;
  modeUnchanged: boolean;
  selectedKeyUnchanged: boolean;
}): boolean {
  // [并发] 这个函数只做判定，不产生副作用：重试动作必须由调用方（用户点击）执行，
  // 放进 effect 会让失败态变成自动重试循环。
  return modeUnchanged && selectedKeyUnchanged && attemptKey !== null && attemptStatus === "failed";
}

// 把外部导航目标收敛为「本文件认识的六个 coding plan provider」。
// 其余一律 null，由调用方转成显式的导航失败提示（INV-04）。
function resolveCodingPlanIntentProviderId(
  target: SettingsModelProviderTarget | undefined,
): BuiltinModelProviderId | null {
  // [权衡] 用 switch 枚举而不是 startsWith / 正则：
  // 新增 provider 时 TS 的穷尽性检查会提醒补齐，正则不会。
  switch (target?.providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return target.providerId;
    // [失败路径] default 必须返回 null，不能回退成 target.providerId：
    // 未知 ID 会让导航定位到一个不存在的节点，选中态悬空。
    default:
      return null;
  }
}

// INV-07：保存后是否刷新权益。区分「配置变化」与「凭据变化」是本函数存在的全部理由。
function shouldRefreshCodingPlanEntitlementsAfterSave(
  previousProvider: ProviderSettingsFormProvider | undefined,
  nextProvider: ProviderSettingsFormProvider,
): boolean {
  // 先按 providerId 白名单筛掉非套餐 provider；白名单必须与 resolveCodingPlanIntentProviderId 保持一致。
  const isCodingPlanProvider =
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  // 非套餐 provider 的保存永远不触发权益刷新，避免无意义的网络请求。
  if (!isCodingPlanProvider) {
    return false;
  }

  // 只比较手工 Key 配置；OAuth account access 不读取旧 Key，由账号/权益事件刷新。
  // Bugfix: enabled/name/models 这类 UI 配置不会改变权益查询凭据。
  // 之前保存任意 Coding Plan 字段都会刷新状态，导致侧栏短暂进入 loading 并冲掉当前选中。
  // [事务] 只比较手工 API Key：OAuth 账号凭据不在这条路径里，
  // 由账号/权益事件刷新。enabled / name / models 等 UI 配置不改变查询凭据。
  // 这一行是 INV-07 的判定本体，改成「总是 true」会重现侧栏闪烁的旧 bug。
  return (
    (previousProvider ? getProviderFormApiKey(previousProvider).trim() : "") !==
    getProviderFormApiKey(nextProvider).trim()
  );
}

// 预设 → OAuth provider 的映射。zai 三兄弟归 ZAI，bigmodel 三兄弟归 BigModel。
// 返回 null 的预设不参与「按当前账号域过滤」的逻辑。
function resolveBuiltinPresetOAuthProvider(
  presetId: BuiltinModelProviderId,
): OAuthProviderId | null {
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  ) {
    // individual / team / start 三个 zai 计划共用同一个 OAuth 身份，不要拆开。
    return ZAI_PROVIDER_ID;
  }
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    // 同理，bigmodel 三个计划共用一个 OAuth 身份。
    return BIGMODEL_PROVIDER_ID;
  }
  return null;
}

// [权衡] 账号域未知（null）时全部显示：首次登录前不能把列表清空。
function shouldShowPresetProviderForActiveOAuth(
  presetId: BuiltinModelProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null | undefined,
): boolean {
  const presetOAuthProvider = resolveBuiltinPresetOAuthProvider(presetId);
  // [失败路径] 两个缺失都按「显示」处理：过滤是优化，不是权限，
  // 误隐藏会让用户找不到已经买过的套餐。
  if (!providerFamilyDomain || !presetOAuthProvider) {
    return true;
  }
  // 只显示与当前登录域同族的预设；跨域预设保留在侧栏会造成「登录了却连不上」。
  return resolveModelProviderFamilyIdByProviderId(presetId) === providerFamilyDomain;
}

// INV-10 的纯函数实现：只有 pending 与已落盘值相等时才删除该 family 的临时选择。
// 返回原对象引用，便于 setState 做 bail-out。
function clearPendingProviderFamilyConnectionSelection(
  selections: ProviderFamilyConnectionSelectionSettings,
  familyId: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
): ProviderFamilyConnectionSelectionSettings {
  // [权衡] 用 JSON 序列化比较：选择对象字段少且都是原始类型，
  // 手写逐字段比较会随着 kind 增加而漏字段。
  if (JSON.stringify(selections[familyId]) !== JSON.stringify(selection)) {
    return selections;
  }
  // 解构删除而不是 delete：保持不可变更新，React 才能正确判断引用变化。
  const { [familyId]: _removed, ...rest } = selections;
  return rest;
}

// 把 provider 映射到侧栏节点 key。start plan 指向自己的 codingPlan 节点，
// 其余指向所属 family 的 start plan 节点——这是导航树的既有约定。
function resolveProviderFamilySideNodeKey(providerId: BuiltinModelProviderId): string | null {
  // start plan 独占节点，不能折叠到 family 上。
  if (isStartPlanModelProviderId(providerId)) return createCodingPlanProviderNodeKey(providerId);
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  // [失败路径] 找不到 family 返回 null，调用方用 ?? item.key 兜底；
  // 不要返回空串，空串会成为合法但无对应节点的 key。
  return familySpec ? createPresetProviderNodeKey(familySpec.startPlanProviderId) : null;
}

// 导航项 → 持久化连接选择。team 需要三元组齐全，individual 只需 kind。
// 返回 null 表示该项没有需要落盘的连接语义（例如普通 preset）。
function resolveConnectionSelectionForNavItem(
  item: Extract<
    ModelProviderNavGroup["items"][number],
    { type: "preset" | "codingPlan" | "teamPlan" }
  >,
): ProviderFamilyConnectionSelection | null {
  if (item.type === "preset") return null;
  // [事务] 三字段全部 trim 后非空才算有效 team 选择；
  // 缺一不可——只落一半会让详情页拼不出权益查询参数。
  if (item.type === "teamPlan") {
    const productId = item.currentProductId?.trim() ?? "";
    const organizationId = item.organizationId?.trim() ?? "";
    const projectId = item.projectId?.trim() ?? "";
    // 用与运算收敛成布尔再走三元：避免把空串当作有效值返回。
    return productId && organizationId && projectId
      ? { kind: "team-coding-plan", productId, organizationId, projectId }
      : null;
  }
  // [权衡] start plan 不落连接选择：它没有「个人/团队」维度，落盘会污染 family 的 pending 逻辑。
  return isStartPlanModelProviderId(item.presetId) ? null : { kind: "individual-coding-plan" };
}

// 导航项 → 侧栏选中 key。preset / individual codingPlan / start plan 用自身 key，
// team plan 与 team 视角的 codingPlan 折叠到 family 节点上。
export function resolveModelProviderSideSelectionKey(
  item: ModelProviderNavGroup["items"][number],
): string {
  // custom / unavailable 等节点直接用 key，不做 family 折叠。
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (
    item.type === "preset" ||
    (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId))
  )
    return item.key;
  // [失败路径] family 解析失败时退回 item.key：宁可选中一个独立节点，
  // 也不要让 selectedNodeKey 为 null 导致详情区空白。
  return resolveProviderFamilySideNodeKey(item.presetId) ?? item.key;
}

/**
 * 模型 Provider 设置只由 SettingsPage 注入 Local Host；这里不接收 workspaceIdentity，
 * 防止远程 workspace 误将 Provider Settings 的读写路由到远端 Environment。
 */
// 组件入口。workspacePath 与 connectivityWorkspacePath 是两个不同用途的路径：
// 前者用于 Provider 设置存储定位，后者只用于「测试模型连通性」的本地工作区。
// [权衡] 刻意不接收 workspaceIdentity：防止远程 workspace 把 Provider Settings 路由到远端。
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  // 三个服务分工：modelSelectionService 提供当前选中模型上下文，
  // oauthService 负责登出，credentialService 读取 OAuth token 快照。
  const { modelSelectionService, oauthService, credentialService } = useServices();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  // [事务] useModelProviders 是本页唯一的 provider 读写入口；
  // 返回值里 refresh 与 reload 语义不同：refresh 静默、reload 会让整页进入 loading。
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  // 从 providerSettingsView 里挑出「已登录且已获权益」的账号 provider，
  // 供导航树决定是否显示套餐入口。用 Set 是为了 O(1) 查询。
  const entitledAccountProviderIds = useMemo<ReadonlySet<string>>(() => {
    return new Set(
      (providerSettingsView?.providers ?? [])
        .filter(
          (provider) =>
            provider.effectiveConfig.access?.type === "zhipu-account" &&
            provider.effectiveConfig.access.entitled === true,
        )
        .map((provider) => provider.providerId),
    );
  }, [providerSettingsView]);
  // [并发] 用 revision 而不是整个 view 作为刷新信号：
  // revision 变化才代表「列表里有真实变更」，可以安全地重读 token 快照。
  const providerConnectionRefreshSignal = providerSettingsView?.revision;
  // INV-05：惰性初值只执行一次，把「进入页面前的待处理目标」取出来并出队。
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  // INV-04 的展示态：初值就根据首个目标是否可解析决定，避免首帧闪一下正常界面。
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(() =>
    Boolean(
      initialModelProviderTarget && !resolveCodingPlanIntentProviderId(initialModelProviderTarget),
    ),
  );
  // 选中节点是页面意图而非持久事实；初值来自外部目标，之后由导航与用户点击驱动。
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() => {
    const providerId = resolveCodingPlanIntentProviderId(initialModelProviderTarget);
    return providerId ? resolveProviderFamilySideNodeKey(providerId) : null;
  });
  // INV-14 的进行中标记：只表示「当前正在等待该预设的订阅结果」，不参与身份 key。
  const [presetSubscriptionProviderId, setPresetSubscriptionProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // 同步进行中标记。它的另一个作用是让权益 hook 暂停按 fingerprint 自动刷新（见下方入参），
  // 避免同步过程中两路刷新互相覆盖。
  const [codingPlanStatusSyncProviderId, setCodingPlanStatusSyncProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // 解绑进行中标记：用来禁用按钮并阻止水合 effect 在解绑过程中再次同步。
  const [codingPlanDisconnectProviderId, setCodingPlanDisconnectProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // 死代码清理：refreshToken 只被已下线的原生购买面板消费，这里仅保留 setter 供
  // 登录/解绑后的 refreshCodingPlanProducts 契约调用（保持共享 helper 签名不变）。
  // 只保留 setter 的计数器：原生购买面板已下线，但共享 helper 的签名仍要求
  // 一个 refreshCodingPlanProducts 回调，这里用状态自增维持契约（见上方既有注释）。
  const [, setCodingPlanProductsRefreshToken] = useState(0);
  // INV-06 的等待标记：新建成功后先记下 providerId，等列表里出现再选中。
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    // saveProvider 会先发布共享快照，再异步落盘；React 在高负载下可能先提交
    // selectedNodeKey、后提交 provider 列表。导航校正会把暂时不存在的 custom key 回退，
    // 新 provider 随后出现也不会再自动选中。只在列表事实可见后完成选中与草稿清理。
    // [并发] 只有列表事实可见后才选中并清标记；
    // 顺序不能反——先清标记再选中会让 effect 无法判断是否已处理。
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  // 统一的「外部目标 → 页面状态」入口，供 props、全局监听、初始目标三条路径共用。
  // 返回 true 表示该目标已被处理（包括被判定为非法），调用方据此决定是否消费。
  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      const providerId = resolveCodingPlanIntentProviderId(target);
      if (!providerId) {
        // 未知 ID 不能只静默忽略：pending 指令不消费的话，外部输入错误会困住导航。
        // 仅显示错误，保留当前可操作页面和持久连接，后续合法导航/手动选择可恢复。
        // [失败路径] 非法目标必须「报错 + 关闭模板选择器 + 返回 true」三件事一起做：
        // 返回 false 会让 pending 指令永远不被消费，外部入口卡死。
        logger.warn("[ModelProviderSection] 无法打开目标供应商", { providerId: target.providerId });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }

      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(resolveProviderFamilySideNodeKey(providerId));
      return true;
    },
    [],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) {
      return;
    }
    // props 目标只在处理成功后回调消费；失败时不消费，留给用户手动恢复。
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyModelProviderTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);

  useEffect(
    () =>
      // [资源] 该监听器返回取消函数，直接作为 useEffect 的清理返回值；
      // effect 依赖只有 applyModelProviderTarget（已 useCallback 且依赖为空），不会反复重挂。
      addPendingSettingsSectionListener((section, detail) => {
        // 只响应模型供应商分区；其它分区指令必须原样放行给各自的监听者。
        if (section !== "modelProvider") {
          return;
        }
        applyModelProviderTarget(
          detail?.modelProviderId
            ? {
                providerId: detail.modelProviderId,
              }
            : undefined,
        );
      }),
    [applyModelProviderTarget],
  );
  const [
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    setCodingPlanPurchaseTokenAuthenticatedByProviderId,
  ] = useState<Partial<Record<BuiltinModelProviderId, boolean>>>({});
  const [activeOAuthProvider, setActiveOAuthProvider] = useState<OAuthProviderId | null>(null);
  const [pendingConnectionSelections, setPendingConnectionSelections] =
    useState<ProviderFamilyConnectionSelectionSettings>({});
  // INV-14 的去重 ref。必须是 ref 而不是 state：它在同一次异步流程内读写，
  // 放进 state 会因为闭包快照读不到最新值。
  const presetSubscriptionCompletionProviderIdRef = useRef<BuiltinModelProviderId | null>(null);
  // INV-01 / INV-03 的尝试状态表：key → inFlight / succeeded / failed。
  // [资源] 用 ref 保存，避免每次写状态都触发整页重渲染。
  const codingPlanStatusSyncAttemptsRef = useRef(
    new Map<string, "inFlight" | "succeeded" | "failed">(),
  );
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const setUser = useZCodeStore((state) => state.setUser);
  const oauthError = useZCodeStore((state) => state.oauthError);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const {
    settings: sharedSettings,
    loading: sharedSettingsLoading,
    error: sharedSettingsError,
    update: updateSharedSettings,
  } = useSettings();
  // BigModel 团队订阅产品。enabled 条件同时要求「该 provider 已认证」与 authenticated=true，
  // 未登录时不发请求。
  const authenticatedEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "bigmodel",
  });
  // zai 与 bigmodel Team Plan 对称化。原仅 bigmodel 调 hook，
  // zai 团队订阅永远拉不到、也无法展示对应团队。
  // zai 独立调 hook（zai family 走 zai provider），下游合并两 family 的订阅产品。
  // [权衡] zai 与 bigmodel 各调一次 hook，而不是做一个按 family 取参的通用 hook：
  // 两个 family 的认证条件与刷新时机独立，合并后会出现「一个登录另一个也跟着刷」。
  const authenticatedZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "zai",
  });
  // [并发] 两个 family 的产品刷新并发执行；任一失败都会冒泡，由调用方决定提示。
  const refreshAuthenticatedEnterpriseProducts = useCallback(async () => {
    await Promise.all([
      authenticatedEnterpriseProducts.refresh(),
      authenticatedZaiEnterpriseProducts.refresh(),
    ]);
  }, [authenticatedEnterpriseProducts, authenticatedZaiEnterpriseProducts]);
  // 只合并 subscribed=true 的产品，供导航树显示「已购团队」。
  // [权衡] 保留两个 family 的顺序而不是排序：导航分组按 family 展示，顺序即语义。
  const subscribedTeamProducts = useMemo(
    () => [
      ...(authenticatedEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(authenticatedZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      authenticatedEnterpriseProducts.snapshot?.productList,
      authenticatedZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  // 持久化的连接选择。空对象兜底保证下游展开运算不需要判空。
  const connectionSelections = sharedSettings?.providerFamilyConnectionSelections ?? {};
  // [失败路径] 只有「有错误且完全没有快照」才算失败：
  // 有旧快照的刷新失败仍可继续展示，不应把整页打成错误态。
  const familyConnectionSettingsFailed = sharedSettingsError !== null && sharedSettings === null;
  // 持久值 + 页面 pending 的合并视图；pending 优先，保证点击后立即生效（INV-09）。
  // 只读消费方（导航、详情）都拿这个，而不是各自合并。
  const effectiveConnectionSelections = useMemo(
    () => ({
      ...connectionSelections,
      ...pendingConnectionSelections,
    }),
    [connectionSelections, pendingConnectionSelections],
  );
  // 原仅检查 bigmodel selectedKey 是否为 team plan，zai team key
  // 永远不会触发已购团队 fallback（断裂）。改为任一 family 有持久化 team key 即显示。
  // [权衡] 任一 family 有 team 选择就显示「已购团队」兜底入口：
  // 只查 bigmodel 会让 zai 团队订阅永远进不去。
  const showPurchasedTeamPlanFallback = Boolean(
    effectiveConnectionSelections.bigmodel?.kind === "team-coding-plan" ||
    effectiveConnectionSelections.zai?.kind === "team-coding-plan",
  );
  // [失败路径] 持久值优先，缺失时退回当前 OAuth provider 推断；
  // 两者都为空时保持 null，由导航层按「全部显示」处理。
  const effectiveProviderFamilyDomain =
    sharedSettings?.providerFamilyDomain ??
    resolveProviderFamilyDomainFromOAuthProvider(activeOAuthProvider);
  // suppressProviderFingerprintAutoRefresh 必须在同步进行中为 true，
  // 否则同步写入的新快照会触发 hook 再刷一次，与同步本身的结果竞争。
  const { entitlements: codingPlanEntitlements, refresh: refreshCodingPlanEntitlements } =
    useCodingPlanEntitlements({
      providerSettingsView,
      connectionSelections: effectiveConnectionSelections,
      suppressProviderFingerprintAutoRefresh: codingPlanStatusSyncProviderId !== null,
    });
  useEffect(() => {
    // INV-10 的清理 effect：遍历 pending，逐个与已落盘值比较。
    // 返回同一个引用时 React 会跳过更新，因此没有 pending 时零成本。
    setPendingConnectionSelections((current) => {
      let next = current;
      for (const [familyId, selection] of Object.entries(current) as Array<
        [ProviderFamilyDomain, ProviderFamilyConnectionSelection]
      >) {
        if (JSON.stringify(connectionSelections[familyId]) !== JSON.stringify(selection)) {
          continue;
        }
        // API Key/Coding Plan tab 点击后 settings 落盘和 hook 刷新是异步的。
        // 等持久化快照真的追上再清 pending，避免旧 mode 把选中项短暂纠偏回去造成闪烁。
        next = clearPendingProviderFamilyConnectionSelection(next, familyId, selection);
      }
      return next;
    });
  }, [connectionSelections]);

  // 契约保活的空实现：计数自增即可，真正的产品刷新由 useEnterpriseCodingPlanProducts 承担。
  const refreshCodingPlanProducts = useCallback(() => {
    setCodingPlanProductsRefreshToken((current) => current + 1);
  }, []);

  // 读取三条凭据并归一化成「当前 active provider 是否已认证」。
  // [并发] 三条 credentialService.load 并发执行，避免串行叠加 IPC 延迟。
  const refreshCodingPlanPurchaseTokenState = useCallback(
    async (
      options: {
        clearUserWhenLoggedOut?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ) => {
      // 只读 oauth:active_provider 与两条 access_token；不读 refresh token，
      // 本函数只判断「是否有 token」，不负责续期。
      const [activeProvider, zaiToken, bigmodelToken] = await Promise.all([
        credentialService.load("oauth:active_provider"),
        credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`),
        credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`),
      ]);
      // [失败路径] 组件已卸载或 target 已切换时丢弃结果（disposed 检查），
      // 否则会把旧 target 的登录态写进新页面。
      if (options.shouldApply && !options.shouldApply()) {
        return null;
      }
      const normalizedActiveProvider =
        activeProvider === ZAI_PROVIDER_ID || activeProvider === BIGMODEL_PROVIDER_ID
          ? activeProvider
          : null;
      // 归一化后的 active provider 是全文件身份判断的核心（INV-01 / INV-18）。
      setActiveOAuthProvider(normalizedActiveProvider);
      setCodingPlanPurchaseTokenAuthenticatedByProviderId({
        [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
      });
      // INV-17：解绑后没有 active provider 等价于 App 登出，
      // 必须同时清 user 与 oauthError，否则侧栏会一直显示旧账号。
      if (!normalizedActiveProvider && options.clearUserWhenLoggedOut) {
        // provider Unlink 已等价于 App logout。
        // 服务端 token 已清理后，设置页也要同步清掉 Zustand user，否则侧边栏会一直显示旧登录态直到重启。
        setUser(null);
        setOAuthError(null);
      }
      return normalizedActiveProvider;
    },
    [credentialService, setOAuthError, setUser],
  );

  // 认证态变化的统一刷新入口：provider 列表、权益、团队产品、购买态、token 快照。
  // [事务] refreshPlanSnapshots 允许调用方按场景裁剪，但 token 快照永远刷新——
  // 它决定后续所有身份判断。
  const refreshProviderPanelAfterAuthChange = useCallback(
    async ({
      refreshPlanSnapshots = true,
      refreshReason = "auth",
    }: {
      refreshPlanSnapshots?: boolean;
      refreshReason?: "auth" | "purchase";
    }) => {
      // 把本文件的五个回调打包交给共享 helper，顺序与并发策略都在 helper 内统一，
      // 本文件不重复实现。
      await refreshModelProviderPanelAfterAuthChange({
        refreshModelProviders: refresh,
        refreshCodingPlanEntitlements: () =>
          refreshCodingPlanEntitlements({ force: true, reason: refreshReason }),
        refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        refreshCodingPlanProducts,
        refreshPurchaseTokenState: refreshCodingPlanPurchaseTokenState,
        refreshPlanSnapshots,
      });
    },
    [
      refresh,
      refreshAuthenticatedEnterpriseProducts,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
      refreshModelProviderPanelAfterAuthChange,
    ],
  );

  // INV-12：同一 attemptKey 只同步一次；userTransition=true 时允许重入（用户主动点击）。
  const syncCodingPlanProviderOnce = useCallback(
    async (
      item: CodingPlanConnectionNavItem,
      options: { userTransition?: boolean; refreshPlanSnapshots?: boolean } = {},
    ) => {
      // 身份 key 在函数入口一次算定，后续全部复用这一个值，
      // 中途重算可能因 activeOAuthProvider 变化而写出两个不同的 key。
      const attemptKey = resolveCodingPlanProviderSyncAttemptKey({
        activeOAuthProvider,
        oauthProviderId: item.oauthProviderId,
        providerId: item.presetId,
      });
      if (!attemptKey) {
        return;
      }
      if (
        // [并发] 非用户动作且已尝试过 → 直接返回；这是自动水合与用户点击的唯一分岔点。
        options.userTransition !== true &&
        codingPlanStatusSyncAttemptsRef.current.has(attemptKey)
      ) {
        return;
      }
      // 先占位再发请求：并发渲染下两个 effect 可能同时进入，占位是唯一的互斥手段。
      codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "inFlight");
      setCodingPlanStatusSyncProviderId(item.presetId);
      try {
        await refreshProviderPanelAfterAuthChange({
          refreshPlanSnapshots: options.refreshPlanSnapshots,
        });
        // 成功后保留 succeeded，不再重试；只有 failed 才允许用户手动恢复。
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "succeeded");
      } catch (error) {
        // 失败状态必须显式保留。自动水合看到 failed 后不循环重试，
        // 用户再次点击同一连接项时则可以按 failed 状态主动恢复。
        // INV-13：失败必须显式落表并重新抛出，让调用方决定提示；
        // 删除条目会让自动水合认为「从未尝试」而再次触发。
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "failed");
        throw error;
      } finally {
        setCodingPlanStatusSyncProviderId((current) =>
          current === item.presetId ? null : current,
        );
      }
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange],
  );

  useEffect(() => {
    // [资源] 卸载标记配合 shouldApply 丢弃迟到的 token 结果。
    let disposed = false;

    // [并发] 依赖 providerConnectionRefreshSignal：只要 provider 列表有真实 revision 变化就重读，
    // 保证登录/解绑后身份立即更新，不依赖某个具体按钮的回调。
    void refreshCodingPlanPurchaseTokenState({
      shouldApply: () => !disposed,
    });

    return () => {
      disposed = true;
    };
  }, [providerConnectionRefreshSignal, refreshCodingPlanPurchaseTokenState]);

  // 把静态预设与真实 provider 合并：预设决定展示顺序与能力，
  // provider 提供运行时配置（可能暂不存在，故为 null）。
  const presetProviders = useMemo(
    () =>
      PRESET_PROVIDER_SPECS.filter((preset) =>
        shouldShowPresetProviderForActiveOAuth(preset.id, effectiveProviderFamilyDomain),
      ).map((preset) => ({
        ...preset,
        provider: modelProviders.find((provider) => provider.providerId === preset.id) ?? null,
      })),
    [effectiveProviderFamilyDomain, modelProviders],
  );

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    // 订阅完成判定只看「账号是否已获权益」，不看本轮请求是否返回成功，
    // 因为连接状态会先于权益接口结果就绪。
    const accountEntitled = Boolean(
      resolveEntitledAccountProviderAccess(providerSettingsView, presetSubscriptionProviderId),
    );
    if (accountEntitled) {
      if (presetSubscriptionCompletionProviderIdRef.current === presetSubscriptionProviderId) {
        return;
      }

      presetSubscriptionCompletionProviderIdRef.current = presetSubscriptionProviderId;
      // [事务] 整个完成流程用 IIFE 包裹：ref 去重必须在同步段完成，
      // 异步体内部才允许 await；写成外层 async 函数会让去重晚一拍。
      void (async () => {
        void reportPresetSubscriptionSuccess({
          platform,
          presetId: presetSubscriptionProviderId,
        });
        try {
          // Bugfix: 连接/重新授权成功后账号连接状态会先于本轮权益接口结果就绪。
          // pending 必须等本轮权益刷新完成后再清，否则 Plan Card 会短暂显示旧套餐态或非 loading 状态。
          // INV-14：必须 await 本轮刷新完成后再在 finally 里清标记，
          // 否则 Plan Card 会短暂显示旧套餐态。
          await refreshProviderPanelAfterAuthChange({});
        } finally {
          presetSubscriptionCompletionProviderIdRef.current = null;
          setCodingPlanStatusSyncProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
          setPresetSubscriptionProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
        }
      })();
    }
  }, [
    platform,
    presetSubscriptionProviderId,
    providerSettingsView,
    refreshProviderPanelAfterAuthChange,
  ]);

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    // INV-15：超时兜底只清仍指向自己的标记（比较 current），
    // 避免把后续新一轮订阅的进行中状态误清。
    const timeoutId = setTimeout(() => {
      setCodingPlanStatusSyncProviderId((current) =>
        current === presetSubscriptionProviderId ? null : current,
      );
      setPresetSubscriptionProviderId((current) => {
        if (current !== presetSubscriptionProviderId) {
          return current;
        }
        return null;
      });
    }, PRESET_SUBSCRIPTION_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [presetSubscriptionProviderId]);

  // 导航树是纯派生结果：输入全部来自上面四类状态，本文件不缓存节点。
  // selectedNavItem 由 selectedNodeKey 反查得到，两者必须同源。
  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      presetProviders,
      modelProviders,
      entitledAccountProviderIds,
      modelProvidersLoading: loading,
      displayOrder,
      codingPlanEntitlements,
      subscribedTeamProducts,
      providerFamilyDomain: effectiveProviderFamilyDomain,
      connectionSelections: effectiveConnectionSelections,
      pendingConnectionSelections,
      showPurchasedTeamPlanFallback,
      familyConnectionSettingsLoading: sharedSettingsLoading && sharedSettings === null,
      familyConnectionSettingsFailed,
      selectedNodeKey,
      setSelectedNodeKey,
      intl,
    });
  // 只有选中 codingPlan / teamPlan 时才产生 key；其它节点不触发套餐权益的按需刷新。
  const selectedPlanAccessKey =
    selectedNavItem?.type === "codingPlan" || selectedNavItem?.type === "teamPlan"
      ? selectedNavItem.key
      : null;
  // 套餐卡每次被用户打开时按需校正；共享 freshness window 保证一分钟内切换返回
  // 不会放大 quota 请求。权益展示更新不等于用户重新打开套餐。
  // [资源] 按打开事件校正，而不是按渲染刷新；共享 freshness window 保证一分钟内切换不放大请求。
  useCodingPlanAccessRefresh({
    refresh: refreshCodingPlanEntitlements,
    selectedPlanKey: selectedPlanAccessKey,
  });

  useEffect(() => {
    // 水合校正只针对套餐节点；非套餐节点没有「provider 与账号是否匹配」的问题。
    if (selectedNavItem?.type !== "codingPlan" && selectedNavItem?.type !== "teamPlan") {
      return;
    }
    if (
      activeOAuthProvider !== selectedNavItem.oauthProviderId ||
      presetSubscriptionProviderId === selectedNavItem.presetId ||
      codingPlanDisconnectProviderId === selectedNavItem.presetId
    ) {
      return;
    }

    // [失败路径] 用 === true 而不是 truthy：accountEntitled 可能是 undefined（未知），
    // 未知不应被当作已获权益而跳过同步。
    const accountEntitled = selectedNavItem.accountEntitled === true;
    if (accountEntitled) {
      return;
    }

    // 这是首次水合校正，不是由详情 status 驱动的状态机。
    // 同一 provider/OAuth 组合只执行一次，checking 与最终状态来回切换不能重启刷新。
    // 自动水合失败只记 warn：这是后台校正，失败不应打断用户当前操作（INV-12/13）。
    void syncCodingPlanProviderOnce(selectedNavItem).catch((error) => {
      logger.warn("[ModelProviderSection] 自动同步 Coding Plan provider 失败", {
        providerId: selectedNavItem.presetId,
        error,
      });
    });
  }, [
    activeOAuthProvider,
    codingPlanDisconnectProviderId,
    presetSubscriptionProviderId,
    selectedNavItem,
    syncCodingPlanProviderOnce,
  ]);

  // INV-08：保存只写 provider 配置，不触碰账号域；错误记日志后原样抛出，
  // 由表单层展示，避免本层吞掉保存失败。
  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        // 保存前先抓旧快照：凭据变化比较必须有「旧值」，
        // 保存后再读列表拿到的是新值，比较恒为相等。
        const previousProvider = modelProviders.find(
          (provider) => provider.providerId === config.providerId,
        );
        // 配置不可执行不是用户退出账号；保存不得顺带清空账号域，否则套餐再选也无法就绪。
        await saveProvider(config);
        // INV-07 的调用点：只有手工 Key 变化才刷新，且不 await——
        // 权益刷新与表单关闭解耦，避免保存按钮等待网络。
        if (shouldRefreshCodingPlanEntitlementsAfterSave(previousProvider, config)) {
          refreshCodingPlanEntitlements();
        }
      } catch (error) {
        logger.error("[ModelProviderSection] 保存模型供应商失败", error);
        throw error;
      }
    },
    [modelProviders, refreshCodingPlanEntitlements, saveProvider],
  );

  // 删除交给共享 helper：确认弹窗、文案、错误处理都在 helper 内统一，本文件不重复。
  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  // [失败路径] 空 URL 直接忽略；外部跳转统一走 platform.openExternal，
  // 不要用 window.open——桌面壳里的新窗口不会走安全的 external 通道。
  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      // trim 后再判空，避免把纯空格当成合法 URL 传给系统浏览器。
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  // 统一登录入口（INV-18）：先置进行中标记，再决定「刷新」还是「换账号」。
  const handleCodingPlanLogin = useCallback(
    (
      presetId: BuiltinModelProviderId,
      providerId: OAuthProviderId,
      providerName: string,
      status: CodingPlanStatus,
      options?: CodingPlanLoginOptions,
    ) => {
      // [事务] 两个标记同时置位：presetSubscription 负责订阅完成，statusSync 负责 provider 同步；
      // 只置一个会让另一个流程在错误的时机重入。
      setPresetSubscriptionProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      logger.info("[ModelProviderSection] 请求通过统一登录入口登录并连接 Coding Plan", {
        presetId,
        providerId,
        providerName,
        status,
        forceOAuth: options?.forceOAuth === true,
      });
      // [失败路径] 已登录同一 provider 时只刷新，不再走登录入口；
      // forceOAuth 是显式的「我要重新授权」，必须优先于上面的短路。
      if (activeOAuthProvider === providerId && options?.forceOAuth !== true) {
        void refreshProviderPanelAfterAuthChange({}).finally(() => {
          setPresetSubscriptionProviderId((current) => (current === presetId ? null : current));
          setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
        });
        return;
      }
      // ZAI/BigModel provider 不再有独立 connection，Connect 必须切换 App active provider。
      // [权衡] 返回登录入口的调用结果（而不是 void）：调用方可能需要在弹窗关闭后继续流程。
      return requestLoginEntry(providerId);
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange, requestLoginEntry],
  );

  // 解绑流程（INV-16 / INV-17）：守卫 provider → 置进行中 → logout → 清 webview → 切域 → 刷状态。
  // 步骤顺序不可交换：先切域会让 logout 用错身份。
  const handleCodingPlanDisconnect = useCallback(
    async (presetId: BuiltinModelProviderId, providerId: OAuthProviderId, providerName: string) => {
      // [失败路径] 只允许两个已知 provider 解绑；未知 id 直接返回，
      // 避免把任意字符串传给 oauthService.logout。
      if (providerId !== BIGMODEL_PROVIDER_ID && providerId !== ZAI_PROVIDER_ID) {
        return;
      }

      // 两个标记一起置：disconnect 用于按钮态，statusSync 用于暂停自动水合。
      setCodingPlanDisconnectProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      try {
        logger.info("[ModelProviderSection] 请求解绑 Coding Plan provider", {
          presetId,
          providerId,
          providerName,
        });
        // ZAI/BigModel provider 已恢复为 App 登录镜像。
        // 这里的 Unlink 必须走 provider logout，退出当前 active provider 并触发另一组 provider 恢复 Connect。
        // [事务] 下一个域必须由共享 helper 判定：它要同时考虑当前域与迁移标记，
        // 本文件不能自己写「bigmodel 退到 zai」这类硬编码。
        const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
          currentDomain: sharedSettings?.providerFamilyDomain,
        });
        // logout 是账号边界操作：它清 token、清 active provider，并广播认证变化。
        await oauthService.logout(providerId);
        // Coding Plan 官网 webview 使用独立持久 partition，provider Unlink 也属于账号边界。
        // [资源] 能力探测后再清 webview 分区：Web 环境没有该命令，直接调用会抛错；
        // 清的是 Coding Plan 官网 webview 的独立持久分区，不等同于 cookie 清理。
        if (typeof platform.executeDesktopCommand === "function") {
          await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
        }
        // [事务] 三个字段必须一起写：域、更新时间、迁移标记。
        // 只写域会让下游的「迁移已完成」判断停留在旧值。
        await updateSharedSettings({
          providerFamilyDomain: (nextProviderFamilyDomain ?? "") as never,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
        });
        // INV-17：解绑后立即重读 token 快照，并在完全退出时清 user。
        await refreshCodingPlanPurchaseTokenState({ clearUserWhenLoggedOut: true });
        await refresh();
        // 解绑后 batch-preview 的订阅/鉴权态已经失效，套餐卡片内部缓存必须刷新，
        // 否则按钮会继续沿用解绑前的 purchased 或 authenticated 状态。
        // 解绑后套餐卡片里的 purchased / authenticated 缓存必须失效，否则按钮仍按旧状态渲染。
        refreshCodingPlanProducts();
        // unlink 前的 React 闭包里仍可能保留旧 Start/Coding provider key。
        // 解绑按钮只等待本地 logout 和 provider 列表刷新；权益 hook 会在新 provider 快照落地后清空旧状态。
      } catch (error) {
        logger.error("[ModelProviderSection] 解绑 Coding Plan provider 失败", {
          presetId,
          providerId,
          providerName,
          error,
        });
      } finally {
        // 两个 finally 清理都用「比较后再清」：并发解绑两个 provider 时，
        // 无条件置 null 会提前释放另一个仍在进行的标记。
        setCodingPlanDisconnectProviderId((current) => (current === presetId ? null : current));
        setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
      }
    },
    [
      oauthService,
      platform,
      updateSharedSettings,
      sharedSettings?.providerFamilyDomain,
      modelSelectionService,
      refresh,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
    ],
  );

  // INV-09 / 10 / 11 的集中实现：判断是否需要落盘 → 写 pending → 落盘 → 同步 → 失败回滚。
  const persistProviderFamilyModeForNavItem = useCallback(
    async (item: (typeof navigationItems)[number]) => {
      if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
        return;
      }
      // [失败路径] 找不到 family 直接返回：没有 family 就没有可写的域与选择。
      const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
      if (!familySpec) {
        return;
      }
      const selection = resolveConnectionSelectionForNavItem(item);
      if (!selection) return;
      // 选择是否与已落盘值一致；JSON 比较的理由同 clearPending（字段少且全为原始类型）。
      const selectionUnchanged =
        JSON.stringify(connectionSelections[familySpec.id]) === JSON.stringify(selection);
      // 同套餐仍可能缺少持久账号域；用户重选必须补齐，不能用页面展示兜底值去重。
      // [事务] 只比较持久域，不用 effectiveProviderFamilyDomain：
      // 页面兜底值不能当作「已落盘」的证据。
      const modeUnchanged = sharedSettings?.providerFamilyDomain === familySpec.id;
      const selectedKeyUnchanged = selectionUnchanged;
      const planSyncAttemptKey =
        item.type === "codingPlan" || item.type === "teamPlan"
          ? resolveCodingPlanProviderSyncAttemptKey({
              activeOAuthProvider,
              oauthProviderId: item.oauthProviderId,
              providerId: item.presetId,
            })
          : null;
      // 都没变时仍要检查「上次失败」：这是 INV-03 的唯一触发点。
      if (modeUnchanged && selectedKeyUnchanged) {
        const isPlanItem = item.type === "codingPlan" || item.type === "teamPlan";
        const planSyncAttemptStatus = planSyncAttemptKey
          ? codingPlanStatusSyncAttemptsRef.current.get(planSyncAttemptKey)
          : undefined;
        if (
          // [失败路径] 只有套餐项才重试 provider 同步；普通 preset 的「什么都没变」直接返回。
          isPlanItem &&
          shouldRetryUnchangedCodingPlanProviderSync({
            attemptKey: planSyncAttemptKey,
            attemptStatus: planSyncAttemptStatus,
            modeUnchanged,
            selectedKeyUnchanged,
          })
        ) {
          try {
            // userTransition=true 允许绕过「只同步一次」的限制；
            // refreshPlanSnapshots=false 表示本次不重复拉团队产品（用户没有换套餐）。
            await syncCodingPlanProviderOnce(item, {
              userTransition: true,
              refreshPlanSnapshots: false,
            });
          } catch (error) {
            logger.warn("[ModelProviderSection] 重试同步 Coding Plan provider 失败", {
              providerId: item.presetId,
              error,
            });
          }
        }
        return;
      }
      // 先写 pending 再落盘（INV-09）：这样落盘往返期间 UI 已按新选择渲染。
      setPendingConnectionSelections((current) => ({
        ...current,
        [familySpec.id]: selection,
      }));
      if (planSyncAttemptKey) {
        // pending state 会先触发渲染；先占位，避免水合 effect 在设置落盘前重复发起同步。
        // 落盘前先占位：水合 effect 可能在本轮渲染后立即执行，
        // 不占位会与即将到来的落盘后同步重复发请求。
        codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "inFlight");
      }
      try {
        // [事务] 第二个参数是「锁内预期」：把页面快照作为乐观锁基线传给设置服务，
        // 其他窗口已改动时会冲突，而不是盲写覆盖。
        await updateSharedSettings(
          {
            providerFamilyDomain: familySpec.id,
            providerFamilyDomainUpdatedAt: Date.now(),
            providerFamilyDomainMigrated: true,
            providerFamilyConnectionSelections: {
              ...sharedSettings?.providerFamilyConnectionSelections,
              [familySpec.id]: selection,
            },
          },
          {
            // 原因：页面快照可能落后其它窗口；不能把展示/待提交映射当作锁内预期。
            providerFamilyDomain: sharedSettings?.providerFamilyDomain,
            providerFamilyConnectionSelections: sharedSettings?.providerFamilyConnectionSelections,
            providerFamilyDomainUpdatedAt: sharedSettings?.providerFamilyDomainUpdatedAt ?? 0,
          },
        );
        // 用户动作完成落盘后只同步一次目标 provider（userTransition=true），
        // 不再重复刷新团队产品快照。
        if (item.type === "codingPlan" || item.type === "teamPlan") {
          // 用户动作拥有连接方式 transition：设置落盘后只刷新一次目标 Plan provider。
          await syncCodingPlanProviderOnce(item, {
            userTransition: true,
            refreshPlanSnapshots: false,
          });
        }
      } catch (error) {
        if (planSyncAttemptKey) {
          // 设置落盘或后续 provider 同步失败时必须允许同项重试。
          codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "failed");
        }
        logger.warn("[ModelProviderSection] 保存模型供应商连接方式失败", {
          familyId: familySpec.id,
          error,
        });
        // INV-11：失败时清掉 pending，UI 回落到持久值；
        // attempt 状态已在上面标 failed，用户可再次点击重试。
        setPendingConnectionSelections((current) =>
          clearPendingProviderFamilyConnectionSelection(current, familySpec.id, selection),
        );
      }
    },
    [
      activeOAuthProvider,
      connectionSelections,
      sharedSettings,
      syncCodingPlanProviderOnce,
      updateSharedSettings,
    ],
  );

  // 点击导航的入口：先清错误与模板选择器，再定位节点，最后异步持久化连接方式。
  // 持久化不 await，点击立即响应。
  const handleSelectNavItem = useCallback(
    (item: (typeof navigationItems)[number]) => {
      setInvalidProviderTarget(false);
      // [并发] 选中 key 与持久化用的 item 必须来自同一次点击；
      // 不要在异步回调里重新从 navigationItems 查 item，列表可能已变。
      setSelectedNodeKey(resolveModelProviderSideSelectionKey(item));
      setTemplatePickerOpen(false);
      void persistProviderFamilyModeForNavItem(item);
    },
    [persistProviderFamilyModeForNavItem],
  );

  // 新建 provider：先置 creating（禁用重复提交），成功后记录待选中 id，失败清标记并抛出。
  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        // locale 透传给服务端生成默认名称；input 展开而不是逐字段传，
        // 避免新增模板参数时漏改这里。
        const created = await createPersonalProvider({ ...input, locale });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        // [失败路径] 成功与失败都要复位 creating，否则按钮永久禁用；
        // 放在 finally 而不是两个分支里各写一次。
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  // 营销页导航请求是独立 store，单独订阅只取 request，避免无关字段变化触发重渲染。
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    // [失败路径] 非本页请求直接忽略且不 finish：请求可能属于其它设置分区，
    // 提前结束会让对应页面永远等不到自己的指令。
    if (marketingRequest?.target.page !== "settings" || !marketingRequest.target.provider_id)
      return;
    if (
      loading ||
      modelProvidersRefreshing ||
      sharedSettingsLoading ||
      navigationItems.some((item) => item.type === "codingPlanLoading")
    )
      return;
    // 全部加载完成后再解析目标：loading / refreshing / 套餐 loading 任一为真都先等，
    // 否则会拿不完整的导航树做查找。
    const providerId = marketingRequest.target.provider_id;
    const item = navigationItems.find((item) =>
      item.type === "custom"
        ? // 当前表单契约使用 providerId；旧 id 会让所有自定义提供商被误判为不存在。
          item.provider.providerId === providerId
        : "presetId" in item &&
          item.presetId === providerId &&
          (!isStartPlanModelProviderId(providerId) || item.type === "codingPlan"),
    );
    if (!item) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_provider_unavailable"));
      return;
    }
    const key = resolveModelProviderSideSelectionKey(item);
    // INV-19：只定位节点。复用 handleSelectNavItem 会顺带持久化连接方式，
    // 营销跳转就变成了「偷偷改套餐」。
    if (selectedNodeKey !== key) {
      // 只定位侧栏节点；禁止复用带 mode 的选择路径，避免营销导航修改套餐连接。
      setSelectedNodeKey(key);
    } else if (selectedNavItem) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [
    marketingRequest,
    loading,
    modelProvidersRefreshing,
    sharedSettingsLoading,
    navigationItems,
    selectedNodeKey,
    selectedNavItem,
  ]);

  // [事务] 排序只重排「被拖动的这一组」：先把该组抽出，再按插入点拼回，
  // 组外顺序保持不变。
  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      // 插入点取「组内第一个元素在全局列表中的位置」，保证拖到不同分组之间时归属正确。
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  // 测试连通性直接透传 hook 方法；不在这里加 try/catch——结果对象本身携带失败原因。
  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  // 首屏慢网时之前直接 return null，导致整块模型供应商页空白，
  // 已有的左侧分组 loading 和刷新按钮 loading 都没有机会渲染。
  // 这里改为始终先渲染布局壳子，再按分组展示 loading，避免用户误以为页面坏了。
  // INV-21：两个分组共用同一 loading 源，但分开命名，便于将来按分组差异化。
  const presetLoading = loading || modelProvidersRefreshing;
  const customLoading = loading || modelProvidersRefreshing;

  // INV-22：首次加载失败走独立错误页；这里不渲染导航骨架，
  // 避免「有侧栏但点不动」的半坏状态。
  if (loadError) {
    // 主渲染：布局壳永远先渲染（INV-21），loading 由 presetLoading / customLoading 下传。
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={presetLoading}
      customLoading={customLoading}
      // [并发] 手动刷新同时刷 provider 列表、两个 family 的团队产品、套餐权益；
      // 顺序无关但都不能省——只刷 BigModel 会让 Z.ai 团队显示旧项目。
      onRefresh={() => {
        void refreshModelProviderSection({
          refresh,
          // 手动刷新设置页时也要同时刷新 Z.ai / BigModel Team Plan 快照；
          // 原来只刷新 BigModel，Z.ai Team Plan 购买或订阅变化后会继续显示旧项目。
          refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        });
        refreshCodingPlanEntitlements();
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={handleSelectNavItem}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {(invalidProviderTarget || navigationUnavailable) && !templatePickerOpen ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({
            id: invalidProviderTarget
              ? "settings.modelProvider.navigationUnavailable"
              : "settings.modelProvider.connectionUnavailable",
          })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => {
            return handleCreateProvider({ templateId });
          }}
          onCreateCustom={(label) => {
            return handleCreateProvider({ providerName: label });
          }}
        />
      ) : (
        <ModelProviderSectionDetail
          connectionSelections={effectiveConnectionSelections}
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          navigationItems={navigationItems}
          connectionSettingsFailed={familyConnectionSettingsFailed}
          // [权衡] 用立即执行函数就地推导订阅数：它依赖 selectedNavItem 的窄化类型，
          // 提到外层会失去 "presetId" in item 的类型收窄。
          startPlanSubscriptionCount={(() => {
            const providerId =
              selectedNavItem && "presetId" in selectedNavItem ? selectedNavItem.presetId : null;
            const family = providerId
              ? resolveModelProviderFamilySpecByProviderId(providerId)
              : null;
            const entitlement = family ? codingPlanEntitlements[family.startPlanProviderId] : null;
            // 只展示当前 Family 已查询到的权益，不用当前是否选中 Start 代替拥有数量。
            // INV：查询失败时返回 0，而不是沿用旧数量——失败意味着「不知道」，
            // 展示旧数字会让用户误以为套餐还在。
            return entitlement?.error
              ? 0
              : (entitlement?.snapshot?.subscription?.details.length ?? 0);
          })()}
          presetLoading={presetLoading}
          codingPlanAuthError={oauthError}
          // `authByProvider` 整表下传而不只传当前项，详情页可能同时展示多个套餐卡。
          codingPlanPurchaseTokenAuthenticatedByProviderId={
            codingPlanPurchaseTokenAuthenticatedByProviderId
          }
          presetSubscriptionProviderId={presetSubscriptionProviderId}
          codingPlanStatusSyncProviderId={codingPlanStatusSyncProviderId}
          codingPlanDisconnectProviderId={codingPlanDisconnectProviderId}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          // Provider 的左栏排序权限被误复用成模型排序门禁，导致 Built-in / Account
          // Provider 的 Effective 模型无法写入 Personal modelOrder。模型调序独立于成员来源。
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onCodingPlanLogin={handleCodingPlanLogin}
          // [失败路径] 取 Key 失败不等于登录失效：这里只强制刷新权益，
          // 不触发重新登录，也不清 OAuth 错误以外的任何状态。
          onRetryCodingPlan={() => {
            // 取 Key 失败不等于登录失效；沿用 Host 手动刷新，不清除 OAuth 或重新登录。
            logger.info("[ModelProviderSection] 重试获取套餐状态");
            return refresh().then(() =>
              refreshCodingPlanEntitlements({ force: true, reason: "manual" }),
            );
          }}
          onCodingPlanDisconnect={handleCodingPlanDisconnect}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
          onSelectNavItem={handleSelectNavItem}
          // 跳转注册前清 oauthError 并释放订阅进行中标记：未注册提示来自一次失败检查，
          // 跳走后仍保留会让提示卡住。
          onOpenBigModelRegistration={() => {
            // 未注册提示来自一次失败的 OAuth checking 状态；跳转注册后要恢复普通状态，避免提示卡住。
            setOAuthError(null);
            setPresetSubscriptionProviderId((current) =>
              current === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? null : current,
            );
            platform.openExternal(BIGMODEL_REGISTRATION_URL);
          }}
          // 购买完成用 purchase 原因刷新，让权益层可以按原因区分是否绕过新鲜度窗口。
          onCodingPlanPurchaseComplete={async () => {
            await refreshProviderPanelAfterAuthChange({ refreshReason: "purchase" });
          }}
        />
      )}
    </ModelProviderSectionLayout>
  );
}
