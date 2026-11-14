// ============================================================================
// V4ComposerToolbar.tsx — v4 composer 工具条（模型 / 思考深度 / context usage 三件套）
//
// 职责边界：
//   - 只做「展示 + 意图上抛」：不写 Composer 状态，不持久化选择，不调 runtime。
//   - 选中结果一律经 onSelectModel / onSelectThought 交给 Composer owner。
//   - 额度与连接只读取（providerSettingsView / entitlements / enterpriseProducts），
//     写入路径在设置页与 useComposerConnectionSwitch 内部。
//
// 三份输入必须分清（混用会直接显示错值）：
//   effectiveConfig  当前 scope 的 Composer 选择；新任务与已有会话都只看它。
//   modelSelectionView  目标 Host 的模型目录（静态事实：provider/model/档位候选）。
//   usage.contextWindow  已运行会话的上下文用量；新任务为 null。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 三件套不能整体门控在 config !== null 上。
//   守住它的位置：ChatContextUsage 的 !modelLocked 三元与末尾 thought 块。
//   改错故障：草稿态 config 尚未水合，整条工具条不渲染，用户看不到任何入口。
//
// INV-02 显示配置只消费 resolveDraftDisplayedConfig(draftConfig)，不得用 Session 旧值补。
//   守住它的位置：effectiveConfig 的 useMemo。
//   改错故障：界面显示 A，实际可提交状态是 B，用户发出的模型与看到的不是同一个。
//
// INV-03 modelLocked 优先于一切选择入口（点击、菜单、热键、恢复分支）。
//   守住它的位置：handleModelValueChange 首行早退 + ModelConfigSelect 的 disabled/open +
//   热键 modelMenuDisabled。
//   改错故障：Highspeed 卡生效期间用户切走模型，本轮提交与卡片声明的模型不一致。
//
// INV-04 Highspeed 指示器优先于 loading / error / unavailable 分支。
//   守住它的位置：渲染三元里 highspeedPresented && highspeedModel 排在第一位。
//   改错故障：加速轮进行中却显示「模型加载失败，重试」，用户以为会话坏了。
//
// INV-05 模型菜单可见性 = 有可选组 或 有「管理模型」入口。
//   守住它的位置：modelMenuVisible。
//   改错故障：零模型用户既没有模型也没有入口，只能去设置页自己找。
//
// INV-06 空配置分支必须同时满足 有入口 / provider 源就绪 / 无 planGroups / 非 pending。
//   守住它的位置：渲染三元的 modelMenuVisible && !providerSourcesLoading && ... 四段与。
//   改错故障：目录还在加载时先闪出「管理模型」按钮，随后又跳成选择器，界面抖一下。
//
// INV-07 触发器值必须与受控值同源：rawModelValue → triggerDisplay → normalizedModelValue。
//   守住它的位置：rawModelValue / triggerDisplay / normalizedModelValue 三段。
//   改错故障：显示 A、选中 B；data-model 与用户点击后真正提交的模型不是同一个。
//
// INV-08 目录外模型值（synthetic / 已下线 / 已退登）必须回落占位，不得直显原始 id。
//   守住它的位置：resolveModelSelectTriggerDisplay 与 resolveV4ModelTriggerDisplay 的兜底。
//   改错故障：工具条显示「<synthetic>」或一串内部 id，用户无法判断当前模型。
//
// INV-09 选中回调顺序：modelLocked 早退 → 解码 → recovery → slash 拆分 → 裸 id。
//   守住它的位置：handleModelValueChange 的四个连续 if。
//   改错故障：顺序一换，恢复分支会抢走本该直接生效的普通选择，点击后模型不变。
//
// INV-10 recovery 只在 configOptionsError + 有 providerId + api-key access + 有回调时触发。
//   守住它的位置：customRecoveryEligible 与随后四段与条件。
//   改错故障：普通选择也被送进 workspace recovery 链，选择被回滚且用户看不到原因。
//
// INV-11 recovery 期间必须置 recoveryPending，并同时禁用工具条与热键。
//   守住它的位置：setRecoveryPending 的 try 前置与 finally，以及 disabled 三处消费。
//   改错故障：恢复请求未回时重复点击，多条恢复并发，最终落到哪条取决于返回顺序。
//
// INV-12 sourceModel 只表达「点击时用户看到的模型」，允许为 null。
//   守住它的位置：sourceModel 的三元构造。
//   改错故障：用 Session 投影补 CAS，迟到的 prewarm 会把用户刚选的值覆盖回去。
//
// INV-13 裸 model id 必须 provider="" 上抛，由宿主从最新投影补齐。
//   守住它的位置：handleModelValueChange 末尾 onSelectModel("", value, sourceModel)。
//   改错故障：把当前 provider 硬绑给新 model，跨 provider 选到不存在的组合。
//
// INV-14 空 thought value 必须忽略，不能上抛。
//   守住它的位置：handleThoughtValueChange 的 if (!value.trim())。
//   改错故障：跨模型受控 Select 重建时抛出一次空值，把模型 intent 标成 superseded。
//
// INV-15 档位候选来自目标 Host 目录，当前值来自 Composer。
//   守住它的位置：draftModelThoughtOption（候选）与 thoughtOption.currentValue（现值）。
//   改错故障：用目录默认档覆盖用户显式选择，每次切模型档位都被重置。
//
// INV-16 Ctrl+T 只在 thoughtOption 为 select 且 nextValue 非 null 时上抛。
//   守住它的位置：handleCycleThoughtLevel 的两个早退。
//   改错故障：单档模型循环出 undefined，把空档位写进 intent。
//
// INV-17 plan connection 只认内置 coding / start providerId，其它一律 none。
//   守住它的位置：resolveFamilyForPlanProviderId 的 switch 白名单。
//   改错故障：自定义 api-key provider 被误挂额度查询，context 区出现无关套餐。
//
// INV-18 Start 额度不受全局付费连接门控。
//   守住它的位置：resolveV4ContextPlanConnection 的 start 提前返回分支。
//   改错故障：用户没选全局连接时，Start 余额区整块消失，像是没买套餐。
//
// INV-19 team 连接必须 selection.kind === team-coding-plan 且 providerId 与 family 匹配。
//   守住它的位置：teamCoding 分支与末尾 personalCoding 的类型收窄。
//   改错故障：zai 团队套用 bigmodel 连接键，切换到错误的团队或查不到额度。
//
// INV-20 团队 source 缓存按 scope + 鉴权隔离，未鉴权必须当帧清空。
//   守住它的位置：contextTeamUsageSourceCacheRef 的 if（render 期执行，不放 effect）。
//   改错故障：登出或换账号后仍展示上一账号的团队额度。
//
// INV-21 缓存 scope 比较必须在 render 期完成，不能挪进 useEffect。
//   守住它的位置：同上的模块内 if 语句。
//   改错故障：多渲染一帧旧账号额度，截图与 e2e 都会抓到错值。
//
// INV-22 team entitlement 必须跟随 source.providerId，不能硬编 bigmodel。
//   守住它的位置：useUsageEntitlement 的 preferredProviderId 与 requirePreferredProvider。
//   改错故障：zai team 在输入框 context 区永远不显示额度（服务端按 providerId 精确匹配）。
//
// INV-23 context 额度不得在挂载时自动请求。
//   守住它的位置：suppressProviderFingerprintAutoRefresh 与 refreshOnMount: false。
//   改错故障：每打开一个会话就打一次 billing/balance，额度接口被工具条刷爆。
//
// INV-24 团队 source 缓存必须先按 id 去重再 unshift，并限制 8 条。
//   守住它的位置：缓存 effect 的 filter + unshift + slice(0, 8)。
//   改错故障：切来切去同一条套餐叠出多份；或无上限增长，长时间运行后内存与比较成本上升。
//
// INV-25 codingPlanUsageRemainingConfig 是额度区最后一道门。
//   守住它的位置：无 personal / team source 时直接返回 undefined 的分支。
//   改错故障：返回空对象让额度区渲染成 0%，用户以为套餐额度耗尽。
//
// INV-26 连接切换 pending 时 selectedPlanKey 必须沿用 previousKey。
//   守住它的位置：selectedPlanKey 的 connectionSwitch.pending 三元。
//   改错故障：请求未回时菜单高亮在新旧连接之间来回跳，用户以为点击失败。
//
// INV-27 同 key 且无 error 时短路；有 error 必须允许重试。
//   守住它的位置：composerOptions.providerMenu.onSelect 的 !connectionSwitch.error 条件。
//   改错故障：一次展示失败后，再点同一个连接永远无反应。
//
// INV-28 普通 API 组切换也必须走 connectionSwitch.select，不能直调 onSelectModel。
//   守住它的位置：onSelect 的 else 分支（chooseConnectionModel + providerId 判断）。
//   改错故障：绕过切换 owner，缺少 loading 且新目录未就绪，暴露旧 provider 的模型列表。
//
// INV-29 热键提示文案必须读生效绑定表。
//   守住它的位置：useShortcutCommandLabel 的两个调用。
//   改错故障：用户改绑后提示仍是旧键位，按提示按键没有反应。
//
// INV-30 e2e 锚点 data-thought 必须与用户实际看到的受控值一致。
//   守住它的位置：TID_V4_MODEL_CONFIG 的 data-thought / data-thought-levels 三元。
//   改错故障：测试读到空投影而界面显示默认档，e2e 与真实行为长期分叉。
//
// INV-31 工具条禁用 = disabled || recoveryPending || connectionSwitch.pending；
//   模型菜单额外叠加 modelLocked 与不可见。
//   守住它的位置：useToolbarShortcutBindings 的 toolbarDisabled / modelMenuDisabled。
//   改错故障：pending 期间热键仍可用，用户连续切换得到不确定的最终连接。
//
// INV-32 窄窗口二级菜单宽度必须受 Radix 可用宽度约束。
//   守住它的位置：providerSubmenuClassName 的 max-w-(--radix-dropdown-menu-content-available-width)。
//   改错故障：手机远控下固定 w-40 让二级菜单溢出屏幕，右侧选项点不到。
//
/* oxlint-disable eslint(max-lines) -- V4ComposerToolbar 汇聚模型/思考深度/context usage 三件套；继续拆分会打散工具条热键与模型目录 memo 的共享状态。 */
/**
 * V4 composer 工具条。
 *
 * 展示件全部复用旧 chat-input-toolbar 的纯 props 组件（ModelConfigSelect /
 * ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage），外观与旧
 * ChatInputToolbar 对齐；但状态编排是全新 v4 wiring，不复活旧 ChatInputToolbar 的
 * effect 链 / 旧协议写路径：
 * - 当前模型/档位来自 Composer；已运行会话的用量来自 snapshot.usage.contextWindow
 * - 模型、思考深度和模式只更新下一次 Submission 的 Composer 意图
 * - 模型静态事实来自目标 Host ModelSelectionView；workspace configOptions 只提供
 *   mode 等非模型 presentation
 *
 * 新任务和已有会话采用相同的 Composer 显示事实；prewarm 不补模型或档位。
 * 提交时由宿主（SessionPane）把冻结选择随 Submission 一起发送。
 * 三件套不能全部门控在 config!==null 上——草稿态会整体不渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlarmClockIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  ZCODE_AGENT_PROVIDER,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import { TID_V4_MODEL_CONFIG, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import type {
  SessionConfigState,
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { ComposerModelOptions } from "@/chat-input-toolbar/ComposerModelMenu.js";
import { Button } from "@/components/ui/button.js";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { formatHighspeedRemainingTime } from "@/highspeed/highspeedTime.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import {
  getNextThoughtLevelValue,
  getThoughtLevelLabel,
} from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import {
  resolveModelSelectTriggerDisplay,
  shouldShowManageModelsAction,
} from "@/chat-input-toolbar/modelSelection.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import {
  setPendingSettingsSectionIntent,
  setPendingSettingsUsageCodingPlanIntent,
} from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ModelSelectionView } from "@zcode/services";
import type {
  ModelSelectionState,
  ModelSelectionRefreshResult,
} from "@/hooks/useModelSelectionView.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useComposerConnectionSwitch } from "@/hooks/useComposerConnectionSwitch.js";
import {
  buildComposerPlanGroups,
  composerConnectionKey,
  chooseConnectionModel,
} from "@/lib/composerPlanGroups.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import {
  type SidebarUsageCodingPlanProviderId,
  type SidebarUsageCodingPlanSourceId,
  writeSidebarUsageCodingPlanProviderPreference,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  resolveDraftDisplayedConfig,
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";

// 拆分件再导出（模式选择移居 V4ComposerModeControls，超行数拆分）：
// 既有消费方（ConversationComposer）继续从本模块入口 import，接口面不变。
export { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

// [契约] 用 TID 拼选择器而不是硬编码 data-testid 字符串：
// test-ids 是 shared 包内的单一事实源，改名时这里自动跟随。
// 该选择器只用于「关闭菜单后把焦点还给输入框」，不参与命中判定。
const V4_COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;
// [性能] 默认值必须是模块级常量：
// 若写成内联 { status: "loading" }，每次渲染都是新对象，依赖它的 memo 全部失效。
const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

/** 稳定空回调（热键 hook 单实例只处理本组件拥有的选项，其余动作占位）。 */
// [权衡] 热键 hook 是单实例、按命令表分发；本组件只拥有「模型 / 档位」两类命令，
// 其余命令（模式循环）必须给一个稳定空实现，不能传 undefined 或每次新建箭头函数，
// 否则 hook 内的依赖比较会认为绑定表变了。
function noop(): void {}

// [并发] 倒计时是独立组件，计数状态留在内部：
// 1s ticker 只驱动这一个 span，不向上传播，避免整条工具条每秒重渲染。
// [资源] interval 必须在 unmount 时清理；expiresAt 变化不重建 interval，
// 剩余时间由 render 期按 (expiresAt, now) 纯计算得出。
function HighspeedCountdown({ expiresAt }: { expiresAt: number }) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // [失败路径] 剩余时间只做展示，不参与任何有效性判断：
  // 过期后格式化为 0 并保留时钟入口，由上层决定是否已经收起 Highspeed 卡。
  // 不要在这里顺手调用 onExpire，否则父组件会在子组件 render 期间被要求改状态。
  const remainingTime = formatHighspeedRemainingTime(expiresAt, now);
  const absoluteExpiryLabel = intl.formatMessage(
    { id: "chat.highspeed.expiresAt" },
    {
      time: new Date(expiresAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  );
  const remainingTimeLabel = intl.formatMessage(
    { id: "chat.highspeed.remainingTime" },
    { time: remainingTime },
  );

  // Bug 根因：倒计时原先晚于 Think 折叠，在中等窄窗口继续占用固定 82px；
  // 窄窗口只收起数值，保留可 hover 的时钟入口。
  return (
    <span
      aria-label={absoluteExpiryLabel}
      title={remainingTimeLabel}
      data-highspeed-countdown="true"
      className="highspeed-inline-countdown inline-flex h-7 w-[82px] shrink-0 items-center justify-center gap-1 rounded-md p-1 text-ui-caption @max-xl/composer:w-7 @max-xl/composer:gap-0 @max-xl/composer:p-0"
    >
      <AlarmClockIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        data-highspeed-countdown-value="true"
        className="relative h-[18px] w-[54px] shrink-0 leading-4 tabular-nums @max-xl/composer:hidden"
      >
        <span className="absolute left-0 top-0.5">{remainingTime}</span>
      </span>
    </span>
  );
}

// [契约] 只携带 provider + model 两个字段，刻意不含 reasoningLevel：
// 档位是目标模型的属性，由宿主按目录解析；把它塞进 sourceModel 会造成第二份 CAS 事实。
export interface ModelSelectionSource {
  provider: string;
  model: string;
}

// [契约] 四态判别联合，用 kind 收窄而不是若干布尔开关：
// none        当前模型不属于任何内置套餐（含自定义 api-key provider）。
// personalCoding  个人 Coding Plan，额度按 providerId 直接查。
// teamCoding  团队套餐，额度必须再按 product/org/project 三元组定位 source。
// start       Start 按量余额，与全局付费连接解耦（见 INV-18）。
// [权衡] 把 selection 只挂到 teamCoding 上：个人与 Start 没有「连接键」概念，
// 给它们加 selection 只会诱导下游用错比较方式。
type V4ContextPlanConnection =
  | { kind: "none" }
  | {
      family: ProviderFamilyDomain;
      kind: "personalCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "teamCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
      selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "start";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    };

// [契约] 只做 providerId → (family, kind) 的纯映射，不读任何 store。
// [失败路径] 未命中返回 null 而不是抛错：绝大多数模型都不是套餐 provider，
// 「不是套餐」是正常路径，不能让它走异常分支。
function resolveFamilyForPlanProviderId(providerId: string | null | undefined): {
  family: ProviderFamilyDomain;
  kind: "personalCoding" | "teamCoding" | "start";
} | null {
  // [失败路径] 必须先 trim 再匹配：
  // providerId 可能来自持久化配置或手填，带首尾空格的同一个 id 会静默落到 default 分支，
  // 表现为「套餐明明买了但 context 区没有额度」。
  switch (providerId?.trim()) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
      return { family: "zai", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
      return { family: "zai", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
      return { family: "zai", kind: "start" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      return { family: "bigmodel", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      return { family: "bigmodel", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return { family: "bigmodel", kind: "start" };
    default:
      return null;
  }
}

// [契约] 把「当前模型 + 全局连接选择」折叠成一个可判别的连接事实，
// 下游（额度查询、团队产品、Start 余额）都只消费这个结果，不再各自解析 providerId。
// [权衡] 纯函数、无 memo 依赖：调用方负责 useMemo，保证同一输入同一引用。
function resolveV4ContextPlanConnection(params: {
  connectionSelections?: ProviderFamilyConnectionSelectionSettings | null;
  providerId?: string | null;
}): V4ContextPlanConnection {
  const providerFamily = resolveFamilyForPlanProviderId(params.providerId);
  // [失败路径] 非套餐 provider 直接 none：
  // 不要在 none 上继续猜测 family，否则 api-key provider 会借用同 family 的套餐额度。
  if (!providerFamily) {
    return { kind: "none" };
  }

  // Start 额度属于输入框的有效模型；全局付费连接不能作为它的查询门禁。
  // [权衡] Start 分支在读取 connectionSelections 之前返回：
  // Start 是「输入框内有效模型」的按量余额，用户是否配置了全局付费连接与它无关。
  // 如果把它挪到 selection 判空之后，未选全局连接的用户会看不到 Start 余额（INV-18）。
  if (providerFamily.kind === "start") {
    const providerId = params.providerId?.trim();
    if (
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan &&
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ) {
      return { kind: "none" };
    }
    return {
      family: providerFamily.family,
      kind: "start",
      providerId,
    };
  }

  // [事务] 个人 / 团队两条路径都必须有对应 family 的显式连接选择：
  // 缺失即 none，不做「按 providerId 反推」的兜底——反推会在多账号下选错组织。
  // [失败路径] kind 不匹配（例如 family 是 teamCoding 但连接是 individual）同样返回 none，
  // 避免把个人套餐的额度挂到团队模型上。
  const selection = params.connectionSelections?.[providerFamily.family];
  if (!selection) return { kind: "none" };

  const providerId = params.providerId?.trim();
  if (providerFamily.kind === "teamCoding" && selection.kind === "team-coding-plan") {
    return {
      family: providerFamily.family,
      kind: "teamCoding",
      providerId: providerId as
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      selection,
    };
  }
  if (providerFamily.kind !== "personalCoding" || selection.kind !== "individual-coding-plan") {
    return { kind: "none" };
  }

  return {
    family: providerFamily.family,
    kind: "personalCoding",
    providerId: providerId as
      | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  };
}

// [契约] 从一份 entitlement snapshot 反推出可用的团队额度 source，
// 用于「企业商品目录还没回来 / 个人 snapshot 已到」的水合空档。
// [权衡] 这是唯一的 snapshot 反推入口；上游 resolveContextCodingPlanUsageSource 只在
// 目录与缓存都查不到时才调用它，避免正常路径依赖 snapshot 的字段完整性。
function resolveContextTeamUsageSourceFromEntitlementSnapshot({
  accountAccess,
  snapshot,
}: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  snapshot?: UsageEntitlementSnapshot | null;
}): CodingPlanUsageSource | null {
  // [失败路径] 只接受 scope === "team"：
  // 个人 snapshot 也带 organizationId 字段（可能为空串），不能凭字段存在就当成团队。
  if (snapshot?.context?.scope !== "team") {
    return null;
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  // [失败路径] org 与 project 缺一即放弃：
  // sourceId 由三元组拼接，缺项会退化成「同一团队不同项目共用一条额度」。
  if (!organizationId || !projectId) {
    return null;
  }
  const subscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() || subscription?.productId?.trim() || "current";
  // 原 createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId 硬编码，
  // zai team snapshot 也生成 bigmodel 前缀 sourceId（与设置页/usage sources 不一致）。
  // 从 snapshot.provider.id 反查 family，生成对应前缀。
  // [失败路径] family 从 snapshot.provider.id 反查，查不到才回落 bigmodel：
  // 历史实现硬编 bigmodel 前缀，导致 zai 团队 snapshot 生成与设置页不一致的 sourceId，
  // 同一个套餐在侧栏与 context 区被当成两条记录（INV-22 的同源问题）。
  const familySpec = resolveModelProviderFamilySpecByProviderId(snapshot.provider?.id ?? "");
  const family: ProviderFamilyDomain = familySpec?.id ?? "bigmodel";
  // [失败路径] 没有 accountAccess 就没有可用的鉴权凭据：
  // 此时即使 snapshot 完整也不产出 source，否则额度查询会带着空凭据发出并被服务端拒绝。
  if (!accountAccess) {
    return null;
  }
  if ("mode" in accountAccess && accountAccess.mode !== "team-coding-plan") {
    return null;
  }
  if (
    "planKind" in accountAccess &&
    (accountAccess.planKind !== "team-coding-plan" ||
      accountAccess.productId !== productId ||
      accountAccess.organizationId !== organizationId ||
      accountAccess.projectId !== projectId)
  ) {
    return null;
  }
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const sourceId = ["team", family, productId, organizationId, projectId]
    .map(encodeURIComponent)
    .join(":") as SidebarUsageCodingPlanSourceId;
  const displayName =
    snapshot.context.displayName?.trim() || subscription?.productName?.trim() || "Team";

  return {
    id: sourceId,
    providerId: codingPlanProviderId,
    accountAccess: {
      type: "zhipu-account",
      family,
      planKind: "team-coding-plan",
      productId,
      organizationId,
      projectId,
    },
    label: `${familySpec?.id === "zai" ? "ZAI" : "BigModel"} - ${displayName}`,
  };
}

// [契约] 团队额度 source 的三级查找：
// 1) 用当前 accountAccess 实时构建（最新目录）；
// 2) 回落最近解析过的缓存（跨水合空档保稳）；
// 3) 最后才用 entitlement snapshot 反推（见上）。
// [权衡] 三级必须按此顺序：缓存优先于 snapshot，是因为缓存来自真实目录，
// 字段可信度高于被裁剪过的 snapshot。
function resolveContextCodingPlanUsageSource(params: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  cachedTeamSources?: readonly CodingPlanUsageSource[];
  entitlementSnapshot?: UsageEntitlementSnapshot | null;
  // 原类型/守卫硬绑 bigmodelCodingPlan，zai team 上下文永远返回 null。
  // 放开为 zai/bigmodel 两种 codingPlan providerId。
  providerId?:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan;
  teamSelection?: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  subscribedTeamProducts: Parameters<
    typeof buildCodingPlanUsageSources
  >[0]["subscribedTeamProducts"];
}): CodingPlanUsageSource | null {
  // [失败路径] 没有 team selection 就不是团队上下文：
  // 此处不判断 kind，调用方已按 kind === teamCoding 门控；这里只做防御。
  if (!params.teamSelection) return null;
  if (!params.accountAccess) return null;

  // [失败路径] 三级查找共用同一个匹配谓词（productId + organizationId + projectId 全等）：
  // 任何一级放宽为「只比 productId」，都会在多项目团队里把 A 项目的额度显示到 B 项目。
  return (
    buildCodingPlanUsageSources({
      accountAccesses: {
        [resolveModelProviderFamilySpecByProviderId(params.providerId ?? "")?.id ?? "bigmodel"]:
          params.accountAccess,
      },
      subscribedTeamProducts: params.subscribedTeamProducts,
    }).find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    params.cachedTeamSources?.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    resolveContextTeamUsageSourceFromEntitlementSnapshot({
      accountAccess: params.accountAccess,
      snapshot: params.entitlementSnapshot,
    })
  );
}

// [契约] 工具条是受控组件：所有「当前值」由 Composer 传入，所有「用户意图」回调上抛。
// 不能在这里新增任何本地镜像状态——一旦有第二份值，就会出现「显示已切、提交未切」。
// [权衡] props 数量偏多但语义分组清晰（呈现 / 连接 / 动效 / 回调），
// 拆成多个 context 会让 memo 边界失效，工具条每次 token 都重渲染。
export interface V4ComposerToolbarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  modelSelectionReload?: () => void;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  sessionId: string | null;
  phase: SessionPhase | null;
  provider?: ZCodeProvider;
  /** 当前工具条是否运行在 Web 远控壳中。 */
  isWebRemoteControl?: boolean;
  /** 当前视口是否为手机输入布局。 */
  isMobileViewport?: boolean;
  /** 草稿态（sessionId=null），仅区分新任务呈现，不改变选择来源。 */
  draftMode?: boolean;
  /** 当前 scope 的 Composer 选择；新任务与已有会话都只显示这份状态。 */
  draftConfig?: Partial<SessionConfigState>;
  usage: SessionUsageState | null;
  disabled: boolean;
  /** Highspeed 卡生效时固定本轮模型，禁止通过选择器或快捷键切换。 */
  modelLocked?: boolean;
  /** 扩散尾段开始后（恢复入场则立即）展示 Highspeed 模型与倒计时。 */
  highspeedPresented?: boolean;
  /** 本次入场是否为 draw 新命中的激活动效；恢复入场的模型标识不做翻页。 */
  highspeedEntranceAnimated?: boolean;
  /** 模型翻页完成并静置后播放一次扫光。 */
  highspeedSweepActive?: boolean;
  /** Highspeed 卡片过期时间；有值时在模型与 Think 之间显示倒计时。 */
  highspeedExpiresAt?: number;
  /** draw 响应绑定的模型；只覆盖锁定期的触发器文案。 */
  highspeedModel?: string;
  /** 单个 composer 内的配置 picker 排他 owner；只属于 renderer-local presentation。 */
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  /**
   * 选中模型（providerId/modelId 来自目录 value 解码），由 Composer owner 更新并持久化。
   * sourceModel 只表达这次用户操作的来源，不从 Session 投影补 CAS 或思考档位。
   */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  /** 选中思考深度；modelContext 固定本次用户操作的目标模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  onSendCompressionCommand?: (command: string) => void;
}

/** 模型 / 思考深度 / context usage 簇（渲染在发送键左侧，与旧 UI 同位）。 */
// [性能] 组件用 memo 包裹并保持 props 全部为原始值或稳定引用：
// 父级在流式输出期间高频重渲染，工具条必须靠引用相等整体跳过。
// [失败路径] 因此禁止在此解构默认值为新对象/新数组（如 provider 默认值必须是模块常量）。
function V4ComposerModelControlsImpl({
  workspacePath,
  workspaceIdentity,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  modelSelectionRefresh,
  provider,
  isWebRemoteControl = false,
  isMobileViewport = false,
  draftMode = false,
  draftConfig,
  usage,
  disabled,
  modelLocked = false,
  highspeedPresented = false,
  highspeedEntranceAnimated = false,
  highspeedSweepActive = false,
  highspeedExpiresAt,
  highspeedModel,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectThought,
  onSendCompressionCommand,
  onRecoverCustomModelSelection,
}: V4ComposerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  // [契约] displayProvider 只影响「展示与分组」，不写回 Composer：
  // 未显式传 provider 时用 agent 内置 provider 作为分组上下文，避免把 undefined 传进目录构建。
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // 配置面读取：workspace 缺省目录（taskId=null），不读旧会话态。
  const { error: configOptionsError } = useToolbarConfigOptions(
    workspacePath,
    null,
    workspaceIdentity,
  );
  // [失败路径] ready 之外的任何状态都视为「源未就绪」：
  // providerSourcesLoading 同时驱动禁用与空配置分支，不能只判 error——
  // loading 期间若放行，会先渲染出「管理模型」按钮再跳成选择器。
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  // 配置面存活服务读（过渡归宿 = 配置面 v4 化）：连接方式选中键喂 BigModel Team Plan 门控豁免。
  const baseServices = useBaseWorkspaceServices();
  const { settings: sharedSettings } = useSettings({ services: baseServices });
  // [事务] suppressProviderFingerprintAutoRefresh: true 是额度请求的节流阀：
  // 工具条挂载/每次 provider 指纹变化都不自动拉额度，只在用户 hover 或显式刷新时请求（INV-23）。
  // [并发] 同一轮内的多次 access 刷新由刷新策略层合并 in-flight，
  // 这里不要自己加 debounce，否则与策略层的 60s 窗口叠加出不可预期的延迟。
  const {
    entitlements,
    enabledStartPlanProviderIds,
    refresh: refreshCodingPlanEntitlements,
  } = useCodingPlanEntitlements({
    providerSettingsView,
    connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
    // Context 只在用户 hover/open 时刷新，不在 composer 挂载时请求额度。
    suppressProviderFingerprintAutoRefresh: true,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Ctrl+M 热键：递增 openRequestKey 请求 ModelConfigSelect 打开菜单（旧 handleOpenModelMenuShortcut 语义）。
  const [modelMenuOpenRequestKey, setModelMenuOpenRequestKey] = useState(0);
  // [并发] recoveryPending 是「恢复请求在飞」的唯一开关：
  // 它同时禁用选择器、context 入口与热键，保证恢复期间没有第二条选择写入（INV-11）。
  const [recoveryPending, setRecoveryPending] = useState(false);
  const handleOpenModelMenuShortcut = useCallback(() => {
    setModelMenuOpenRequestKey((current) => current + 1);
  }, []);
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
    },
    [onConfigPickerOpenChange],
  );
  const handleThoughtPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("thought", open);
    },
    [onConfigPickerOpenChange],
  );

  // [契约] modelOption 只用于热键「有没有东西可操作」的判定，不参与渲染：
  // 真正的选项列表来自 modelSelectGroups；这里若直接复用渲染数据，
  // 会把「管理模型」入口误算成可循环模型，Ctrl+M 打开一个空菜单。
  const modelOption = modelSelectionView?.providers.some((provider) => provider.models.length > 0)
    ? ({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "",
        options: [],
      } satisfies ZCodeConfigOption)
    : undefined;

  // 空模型/档位曾被 Session 旧值补回，界面显示与实际不可提交状态矛盾。
  // 初始化已经由 Composer owner 完成；显示层只消费它，不能再次补值。
  // [不变量] 这里是「显示事实」的唯一入口（INV-02）：
  // resolveDraftDisplayedConfig 只做字段规整（空串归一、缺省补齐），不读 Session、不读 prewarm。
  // [失败路径] 曾在此处用 Session 旧值回填空模型/空档位，
  // 结果界面显示可提交，实际 Composer 仍是空选择，发送后模型与界面不一致。
  const effectiveConfig = useMemo<SessionConfigState | null>(() => {
    return resolveDraftDisplayedConfig(draftConfig ?? {});
  }, [draftConfig]);

  // [契约] 升级入口必须带漏斗上下文（来源 session_token_usage、区域 app.session）：
  // 埋点字段与真实入口一一对应，缺字段会让转化漏斗在这一步断掉。
  // [权衡] entryPlanState 固定 purchased + start：此处只在「已持有 Start」的额度区出现。
  const handleOpenStartPlanUpgrade = useCallback(
    (providerId: string) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext: createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "session_token_usage",
          eventRegion: "app.session",
          eventText: intl.formatMessage({ id: "chat.quota.action.upgrade" }),
          entryPlanState: resolveCodingPlanEntryPlanState({
            providerId,
            displayStatus: "purchased",
            planLevel: "start",
          }),
        }),
      });
    },
    [intl, openCodingPlanUpgrade],
  );
  // [事务] 顺序是「写来源偏好 → 置设置页意图 → 打开设置」，三步不能换：
  // 偏好是设置页选中当前套餐的依据，晚写会让使用统计先渲染默认套餐再跳。
  // [失败路径] 不传 sourceId 时保留既有偏好（通用 Usage 入口），
  // 不能把它清空，否则从 context 区进来会丢失「上次看的套餐」。
  const handleOpenUsageDetails = useCallback(
    (sourceId?: SidebarUsageCodingPlanSourceId) => {
      if (sourceId) {
        writeSidebarUsageCodingPlanProviderPreference(sourceId);
      }
      // 剩余额度「更多」直达 Coding Plan 使用统计（按上面写入的来源偏好选中当前套餐），
      // 不落到应用用量；通用 Usage 入口仍走 setPendingSettingsUsageIntent。
      setPendingSettingsUsageCodingPlanIntent();
      openSettingsTab();
    },
    [openSettingsTab],
  );

  // [性能] 连接事实按 (provider, 连接选择) 缓存：
  // 它是额度/团队产品多路 effect 的依赖，引用不稳定会让这些请求链每帧重算。
  // [失败路径] 依赖里只放 effectiveConfig.provider，不放整个 config：
  // thought / model 变化不影响连接归属，放整对象会造成无意义的额度重查。
  const contextPlanConnection = useMemo(
    () =>
      resolveV4ContextPlanConnection({
        connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
        providerId: effectiveConfig?.provider,
      }),
    [effectiveConfig?.provider, sharedSettings?.providerFamilyConnectionSelections],
  );
  // [契约] 只有个人 / 团队两种套餐才解析 account access；Start 与 none 一律 null。
  // [失败路径] 这里的 null 会被下游当作「无凭据」直接跳过查询，
  // 所以不能为了「总能拿到点什么」而在非套餐分支返回兜底 access。
  const contextAccountProviderAccess = useMemo(
    () =>
      contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
        ? resolveEntitledAccountProviderAccess(
            providerSettingsView,
            contextPlanConnection.providerId,
          )
        : null,
    [contextPlanConnection, providerSettingsView],
  );
  // [契约] Start 余额卡的配置对象：非 start 返回 undefined，让展示层整体不渲染。
  // [并发] onAccess 只在 provider 被 enabledStartPlanProviderIds 收录时挂载：
  // 没有独立 Account Access 的 Start 用户 hover 刷新会打到空 provider，
  // 既浪费请求又会把错误状态写进共享 entitlement。
  // [事务] snapshot 必须校验 provider.id 与当前 providerId 一致才透传：
  // entitlement 表按 providerId 建索引，错取会把另一套餐的余额显示成本模型余额。
  const contextStartPlanBalanceConfig = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (contextPlanConnection.kind !== "start") {
      return undefined;
    }
    const entitlement = entitlements[contextPlanConnection.providerId];
    // Start Plan 只有具备独立 Account Access 时才挂载 hover 查询入口。
    const startPlanEntitlementEnabled = enabledStartPlanProviderIds.includes(
      contextPlanConnection.providerId,
    );
    return {
      loading: entitlement?.loading ?? providerSourcesLoading,
      // hover access 刷新入口不能只在 Coding Plan 配置上（onAccess）：
      // start plan 用户 hover context 面板从不主动刷新今日余额，只能等设置页/侧栏
      // 刷新后被动同步。接入与 Coding Plan 相同的静默 access 刷新；60s access 窗口
      // 与 in-flight 合并由刷新策略层自动生效，不会因反复 hover 放大 billing/balance 请求。
      ...(startPlanEntitlementEnabled
        ? {
            onAccess: () => refreshCodingPlanEntitlements({ silent: true, reason: "access" }),
          }
        : {}),
      onUpgradeClick: () => handleOpenStartPlanUpgrade(contextPlanConnection.providerId),
      snapshot:
        entitlement?.snapshot?.provider?.id === contextPlanConnection.providerId
          ? entitlement.snapshot
          : null,
    };
  }, [
    contextPlanConnection,
    enabledStartPlanProviderIds,
    entitlements,
    handleOpenStartPlanUpgrade,
    providerSourcesLoading,
    refreshCodingPlanEntitlements,
  ]);
  // [失败路径] 用 has* 守卫把「看似有配置、实际无数据」折叠成 undefined：
  // 直接透传配置对象会让卡片展示 loading 骨架永不结束。
  const contextStartPlanBalance = hasChatStartPlanBalance(contextStartPlanBalanceConfig)
    ? contextStartPlanBalanceConfig
    : undefined;

  // 按当前连接 family 拉取团队产品，避免 zai 团队误用 bigmodel 产品目录。
  // [失败路径] family 解析顺序：当前模型 provider → 全局连接 domain → bigmodel。
  // 团队产品目录必须按 family 请求，zai 团队误用 bigmodel 目录会拿到空产品列表（INV-19）。
  const connectionFamily =
    resolveModelProviderFamilySpecByProviderId(effectiveConfig?.provider ?? "")?.id ??
    sharedSettings?.providerFamilyDomain ??
    "bigmodel";
  const user = useZCodeStoreWithDefault((state) => state.user, undefined);
  // [失败路径] 「已鉴权」需要同时满足：有 user、有同 family 的 zhipu-account、provider 启用、
  // 未被标记 not-authenticated，且（team 模式 或 availability === available）。
  // 少任何一条都会把未登录用户带进团队查询，返回 401 后又被展示成「无套餐」。
  // [权衡] 这里刻意不做异步探测：只读当前投影，鉴权变化由 provider 刷新推动重算。
  const connectionAuthenticated =
    user !== null &&
    Boolean(
      providerSettingsView?.providers.some(
        (p) =>
          p.effectiveConfig.access?.type === "zhipu-account" &&
          p.effectiveConfig.access.accountType === connectionFamily &&
          p.enabled &&
          p.accountState?.unavailableReason !== "not-authenticated" &&
          (p.effectiveConfig.access.mode === "team-coding-plan" ||
            p.accountState?.availability === "available"),
      ),
    );
  // [并发] enabled 采用「需要时才拉」策略：
  // 只有 teamCoding 连接或用户主动打开模型 picker 时才请求企业商品目录，
  // teamCoding 之外的大部分会话不会产生这条请求。
  // [失败路径] 同时要求 connectionAuthenticated：未鉴权时不发请求，避免必然 401 的噪声。
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      !providerSourcesLoading &&
      (contextPlanConnection.kind === "teamCoding" || activeConfigPicker === "model") &&
      connectionAuthenticated,
    authenticated: connectionAuthenticated,
    family: connectionFamily,
  });
  // [失败路径] 未鉴权返回空数组而不是 undefined：
  // 下游 buildComposerPlanGroups / buildCodingPlanUsageSources 都按数组消费，
  // undefined 会在解构时抛错。
  // [权衡] 只保留 subscribed === true 的产品：未订阅产品出现在切换菜单里点了也无法使用。
  const subscribedTeamProducts = useMemo(
    () =>
      (connectionAuthenticated
        ? enterpriseProducts.snapshot?.productList.filter((product) => product.subscribed === true)
        : undefined) ?? [],
    [connectionAuthenticated, enterpriseProducts.snapshot?.productList],
  );
  // [事务] authSessionSeq 是「登录代际」信号：
  // 同一 user.id 重新登录后 teamUsageScope 必须变化，才能让缓存与额度重新解析。
  const authSessionSeq = useZCodeStoreWithDefault((state) => state.authSessionSeq, 0);
  // [契约] scope 对象内容为空，靠「引用身份」表达 scope 变化，
  // 因此依赖必须覆盖 services / family / user.id / authSessionSeq 四个维度：
  // 任一变化都代表「团队额度上下文已不同」，缓存必须失效（INV-20）。
  // [失败路径] 千万不要把它写成 {} 字面量返回，每次渲染新引用会让缓存每帧清空。
  const teamUsageScope = useMemo(
    () => ({}),
    [baseServices, connectionFamily, user?.id, authSessionSeq],
  );
  // [事务] 团队 source 缓存的唯一目的是跨水合空档保稳：
  // Team → Personal → Team 期间企业商品或个人 snapshot 会短暂缺失，
  // 直接从缓存回放最近解析过的 source，context 余额不会闪断。
  // [资源] 上限 8 条（写入时 slice），避免长时间切换累积。
  const contextTeamUsageSourceCacheRef = useRef<{
    scope: object;
    sources: CodingPlanUsageSource[];
  }>({ scope: teamUsageScope, sources: [] });
  // 原因：独立来源缓存可复活已清空的目录；鉴权边界要在本次渲染就隔离，不能等待 Provider 刷新。
  // [事务] 清空发生在 render 期而非 effect：
  // effect 在 commit 之后执行，中间那一帧仍会用旧账号缓存渲染（INV-21）。
  // [失败路径] 未鉴权时无条件清空：这是安全边界，不能等 Provider 刷新再处理，
  // 否则登出瞬间会短暂展示上一账号的团队额度。
  if (contextTeamUsageSourceCacheRef.current.scope !== teamUsageScope || !connectionAuthenticated)
    contextTeamUsageSourceCacheRef.current = { scope: teamUsageScope, sources: [] };
  // [契约] 只有 personal / team 两种连接才有 providerId，Start 不走 coding plan 额度通道。
  const contextCodingPlanUsageProviderId =
    contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
      ? contextPlanConnection.providerId
      : undefined;
  // [事务] 团队 source 只在该帧「已鉴权 + teamCoding」时解析，否则 null。
  // [失败路径] entitlementSnapshot 必须按 connection.providerId 取：
  // 原实现硬取 bigmodelCodingPlan，zai 团队在此处永远拿不到 snapshot。
  // [并发] 依赖含 teamUsageScope：它是缓存失效的显式触发器，不能省。
  const contextCodingPlanUsageTeamSource = useMemo(
    () =>
      connectionAuthenticated && contextPlanConnection.kind === "teamCoding"
        ? resolveContextCodingPlanUsageSource({
            accountAccess: contextAccountProviderAccess?.access,
            cachedTeamSources: contextTeamUsageSourceCacheRef.current.sources,
            // 原硬取 bigmodelCodingPlan 的 entitlement snapshot，
            // zai team plan 查不到额度。改为按 connection.providerId 取对应 snapshot。
            entitlementSnapshot: entitlements[contextPlanConnection.providerId]?.snapshot ?? null,
            providerId: contextPlanConnection.providerId,
            teamSelection: contextPlanConnection.selection,
            subscribedTeamProducts,
          })
        : null,
    [
      connectionAuthenticated,
      teamUsageScope,
      contextAccountProviderAccess?.access,
      contextPlanConnection,
      entitlements,
      subscribedTeamProducts,
    ],
  );
  useEffect(() => {
    // [事务] 只有解析成功才写缓存：
    // null 不代表「这个团队没有额度」，只是这一刻查不到，写入 null 会抹掉可用缓存。
    // [并发] 同 id 先删后插，保持「最近使用在前」的顺序供后续查找。
    if (!contextCodingPlanUsageTeamSource) {
      return;
    }
    const cache = contextTeamUsageSourceCacheRef.current.sources;
    const nextCache = cache.filter((source) => source.id !== contextCodingPlanUsageTeamSource.id);
    nextCache.unshift(contextCodingPlanUsageTeamSource);
    // Team -> Personal(no_plan) -> Team 期间企业商品或个人 snapshot 可能短暂缺失。
    // 保留最近解析过的团队 source，避免输入框 context 余额跟随水合顺序闪断。
    contextTeamUsageSourceCacheRef.current = {
      scope: teamUsageScope,
      sources: nextCache.slice(0, 8),
    };
  }, [contextCodingPlanUsageTeamSource, teamUsageScope]);
  // [契约] 选中来源 id 的语义按连接类型分叉：
  // teamCoding 用 source.id（含 product/org/project），其它用 providerId。
  // [失败路径] 用错会让「更多」跳转到错误的套餐详情：团队三元组被折叠成 provider 后，
  // 设置页只能选中该 family 的第一个套餐。
  const contextCodingPlanUsageSelectedSourceId: SidebarUsageCodingPlanSourceId | undefined =
    contextPlanConnection.kind === "teamCoding"
      ? contextCodingPlanUsageTeamSource?.id
      : contextCodingPlanUsageProviderId;
  // [契约] 团队额度走独立的 entitlement 实例（独立 freshness key），
  // 与全局 coding plan entitlement 并行但互不覆盖。
  // [失败路径] preferredProviderId 跟随 team source，并同时打开
  // allowDisabledPreferredProvider + requirePreferredProvider：
  // 这样服务端必须按该 provider 精确匹配，选不到就返回空，而不是静默换一个 provider。
  // [失败路径] allowEnvApiKey: false：团队额度不能用环境里的 api key 顶替。
  // [并发] cacheKey 用 source.id：source 切换即视为不同缓存槽，旧结果不会串台。
  const teamEntitlement = useUsageEntitlement({
    enabled: !providerSourcesLoading && Boolean(contextCodingPlanUsageTeamSource),
    includeSubscription: true,
    // 原硬编码 bigmodelCodingPlan，zai family team plan 选中时
    // contextCodingPlanUsageTeamSource.providerId 是 zaiCodingPlan，但这里仍传 bigmodelCodingPlan
    // → 服务端 pickQuotaProvider 按 providerId 精确匹配选不到 zai provider →
    // resolveAuthorization 返回 null → zai team plan 的输入框上下文用量区域不显示额度。
    // 改为跟随 team source 的 providerId（已在 resolveContextTeamUsageSourceFromEntitlementSnapshot
    // / resolveV4ContextPlanConnection 按 family 正确产出 zaiCodingPlan/bigmodelCodingPlan）。
    preferredProviderId:
      contextCodingPlanUsageTeamSource?.providerId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: contextCodingPlanUsageTeamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: contextCodingPlanUsageTeamSource?.id,
    refreshOnMount: false,
  });
  // [并发] 任务边界刷新必须并行发出两份请求：
  // 全局 coding plan 与团队 source 的 freshness key 不同，只刷一份会让另一份显示旧值。
  // [事务] Promise.all 保证调用方 await 到「两份都完成」，底层相同团队请求由 request key 合并。
  const refreshTaskEntitlements = useCallback(
    async (options?: UsageEntitlementRefreshOptions) => {
      // Team Plan 的 context 面板使用 sourceId 隔离自己的 freshness key；任务边界刷新时
      // 与全局 entitlement 一起发布，底层 request key 会合并相同团队请求。
      await Promise.all([refreshCodingPlanEntitlements(options), teamEntitlement.refresh(options)]);
    },
    [refreshCodingPlanEntitlements, teamEntitlement.refresh],
  );
  // [契约] 可用套餐列表只服务个人 Coding Plan：
  // 团队与 Start 各有自己的通道，混进这个数组会让切换器出现无法切换的条目。
  // [失败路径] 没有 account access 时返回空数组：
  // 空数组表示「不可切换」，而不是「还没加载」，展示层据此隐藏切换器。
  const contextCodingPlanUsageProviders = useMemo(() => {
    if (contextPlanConnection.kind !== "personalCoding" || !contextCodingPlanUsageProviderId) {
      return [];
    }
    const access = contextAccountProviderAccess;
    if (!access) return [];
    return [
      {
        providerId: contextCodingPlanUsageProviderId as SidebarUsageCodingPlanProviderId,
        accountAccess: access.access,
        label:
          access.label ||
          (contextCodingPlanUsageProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
            ? "Z.ai - Coding Plan"
            : "BigModel - Coding Plan"),
      },
    ];
  }, [contextAccountProviderAccess, contextCodingPlanUsageProviderId, contextPlanConnection.kind]);
  // [事务] 额度条目分两支，互斥且顺序固定：
  // 1) 有团队 source → 单条团队条目，snapshot / loading / error 全部来自 teamEntitlement。
  // 2) 个人连接且可用列表非空 → 单条个人条目，来自全局 entitlements 表。
  // [失败路径] 团队分支不看 personal 分支的 entitlements，
  // 两支若同时产出会让额度区出现两张卡（一张永远 0%）。
  const codingPlanUsageEntitlements = useMemo<
    ChatCodingPlanUsageRemainingConfig["entitlements"]
  >(() => {
    if (contextCodingPlanUsageTeamSource) {
      return [
        {
          sourceId: contextCodingPlanUsageTeamSource.id,
          providerId: contextCodingPlanUsageTeamSource.providerId,
          accountAccess: contextCodingPlanUsageTeamSource.accountAccess,
          label: contextCodingPlanUsageTeamSource.label,
          snapshot: teamEntitlement.snapshot,
          loading: teamEntitlement.loading,
          error: teamEntitlement.error,
        },
      ];
    }

    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId ||
      contextCodingPlanUsageProviders.length === 0
    ) {
      return [];
    }
    const providerId = contextCodingPlanUsageProviderId;
    const entitlement = entitlements[providerId];
    return [
      {
        sourceId: providerId,
        providerId,
        accountAccess: contextCodingPlanUsageProviders[0]!.accountAccess,
        snapshot: entitlement?.snapshot ?? null,
        loading: entitlement?.loading ?? providerSourcesLoading,
        error: entitlement?.error ?? null,
      },
    ];
  }, [
    contextCodingPlanUsageProviderId,
    contextCodingPlanUsageProviders.length,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    entitlements,
    providerSourcesLoading,
    teamEntitlement.error,
    teamEntitlement.loading,
    teamEntitlement.snapshot,
  ]);
  // [契约] 「更多」入口固定携带当前选中来源，保证设置页打开的就是用户正在看的套餐。
  const handleUsageClick = useCallback(
    () => handleOpenUsageDetails(contextCodingPlanUsageSelectedSourceId),
    [contextCodingPlanUsageSelectedSourceId, handleOpenUsageDetails],
  );
  // [失败路径] 没有 personal 也没有 team source 时返回 undefined（INV-25）：
  // 这是额度区的最后一道门，返回空对象会让展示层渲染 0% 的假数据。
  // [并发] onAccess 与 onEntitlementRefresh 都走 refreshTaskEntitlements，
  // 保证 hover 刷新与显式刷新共享同一套 freshness 合并逻辑。
  const codingPlanUsageRemainingConfig = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (contextPlanConnection.kind !== "personalCoding" && !contextCodingPlanUsageTeamSource) {
      return undefined;
    }
    return {
      availableProviders: contextCodingPlanUsageProviders,
      entitlements: codingPlanUsageEntitlements,
      modelProvidersLoading: providerSourcesLoading,
      onEntitlementRefresh: () => refreshTaskEntitlements({ force: true, silent: true }),
      onAccess: () => refreshTaskEntitlements({ silent: true, reason: "access" }),
      onUsageClick: handleUsageClick,
      selectedProviderId: contextCodingPlanUsageSelectedSourceId,
    };
  }, [
    contextCodingPlanUsageProviders,
    contextCodingPlanUsageSelectedSourceId,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    codingPlanUsageEntitlements,
    handleUsageClick,
    providerSourcesLoading,
    refreshTaskEntitlements,
  ]);
  // [失败路径] has* 二次守卫：配置对象存在 ≠ 有可展示的额度（可能全是 loading 或空 limits）。
  const codingPlanUsageRemaining =
    codingPlanUsageRemainingConfig &&
    hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingConfig)
      ? codingPlanUsageRemainingConfig
      : undefined;

  // 高频交互排障只走 debug，避免生产日志量随每次选择增长。
  useEffect(() => {
    if (!draftMode) return;
    logger.debug("[v4-toolbar] draft effectiveConfig changed", {
      provider: effectiveConfig?.provider ?? null,
      model: effectiveConfig?.model ?? null,
      thought: effectiveConfig?.thought ?? null,
      modelSelectionRevision: modelSelectionView?.revision ?? null,
    });
  }, [draftMode, effectiveConfig, modelSelectionView?.revision]);

  // [性能] 所有分组文案一次成型并缓存：
  // 分组构建函数按 label 引用做 memo，逐个 formatMessage 每次渲染产生新字符串会让分组全量重建。
  // [契约] 这里只放「连接方式」类文案，模型名与档位名由目录提供，不走 i18n。
  const modelGroupLabels = useMemo(
    () => ({
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      apiKeyBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.apiKeyBadge",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
      codingPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlanBadge",
      }),
      startPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlan",
      }),
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      teamPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlanBadge",
      }),
      teamPlanFallbackLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlan",
      }),
    }),
    [intl],
  );
  // [契约] 菜单分组来自 registry 目录（buildRegistryModelSelectGroups），
  // 不合并 workspace configOptions：后者只提供 mode 等非模型展示。
  // [失败路径] 没有 modelSelectionView 时返回空数组而不是占位组。
  const modelSelectGroups = useMemo<ModelSelectGroup[]>(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(displayProvider, modelSelectionView, modelGroupLabels);
  }, [displayProvider, modelGroupLabels, modelSelectionView]);

  // 修复：恢复「管理模型」入口（老版 onManageModels = 打开设置页并定位模型供应商区）。
  // [事务] 「管理模型」= 置 section 意图 + 打开设置页，顺序固定：
  // 先置意图再打开，设置页首帧即可定位到模型供应商区。
  const handleOpenModelProviderSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const showManageModelsAction = shouldShowManageModelsAction(handleOpenModelProviderSettings);
  const manageModelsLabel = intl.formatMessage({
    id: "chat.toolbar.model.manageModels",
  });

  // 当前投影模型的编码值：provider 命中目录则按自定义模型编码，否则回落裸 model id。
  // [契约] 编码规则：provider 在目录内 → 编码成自定义值；否则回落裸 model id。
  // [失败路径] provider 不在目录（已下线/退登）时若仍强行编码，
  // ModelConfigSelect 会把它当成未知自定义值，展示成空白；回落裸 id 才能命中占位兜底。
  // [失败路径] 空 model 直接返回空串，不产出 "provider/" 这类半成品值。
  const rawModelValue = useMemo(() => {
    if (!effectiveConfig || !effectiveConfig.model) return "";
    const providerExists = modelSelectionView?.providers.some(
      (candidate) => candidate.providerId === effectiveConfig.provider,
    );
    if (providerExists) {
      return encodeCustomModelValue(effectiveConfig.provider, effectiveConfig.model);
    }
    return effectiveConfig.model;
  }, [effectiveConfig, modelSelectionView]);

  // 触发器显示兜底——`<synthetic>`（SDK 恢复时合成的占位模型）或当前模型
  // 不在可选组（失效/下线/退登）→ 回落占位/默认「选择模型」，不直显协议内部占位符或失效
  // 模型 id。复用存活的 resolveModelSelectTriggerDisplay。
  // [失败路径] 触发器文案的兜底链：命中分组 → 管理入口 → 占位/默认「选择模型」。
  // 复用存活的 resolveModelSelectTriggerDisplay，保证与旧工具条文案一致（INV-08）。
  const triggerDisplay = useMemo(
    () =>
      resolveModelSelectTriggerDisplay(
        rawModelValue,
        modelSelectGroups,
        showManageModelsAction,
        manageModelsLabel,
      ),
    [manageModelsLabel, modelSelectGroups, rawModelValue, showManageModelsAction],
  );
  const normalizedModelValue = triggerDisplay.value ?? "";

  // [契约] 在通用触发器之上再补 provider 展示名（fullLabel 用），
  // Highspeed 指示器的 originalModel 需要「provider + 模型」的完整标签。
  const modelTriggerDisplay = useMemo(() => {
    // 非可选值（未选 / synthetic / 不可用）：占位文案或默认「选择模型」。
    const fallbackLabel =
      triggerDisplay.placeholder ?? intl.formatMessage({ id: "chat.toolbar.model.label" });
    const providerName =
      modelSelectionView?.providers.find(
        (candidate) => candidate.providerId === effectiveConfig?.provider,
      )?.providerName ?? undefined;
    return resolveV4ModelTriggerDisplay({
      modelGroups: modelSelectGroups,
      normalizedValue: normalizedModelValue,
      fallbackLabel,
      providerId: effectiveConfig?.provider,
      providerName,
    });
  }, [
    effectiveConfig?.provider,
    intl,
    modelSelectionView,
    modelSelectGroups,
    normalizedModelValue,
    triggerDisplay.placeholder,
  ]);
  // [事务] 选中模型的唯一写入口，分支顺序即语义（INV-09）：
  // 1) modelLocked 早退；2) 解码自定义值；3) 捕获 sourceModel；
  // 4) configOptions 失败且是 api-key provider → 走 recovery；
  // 5) 解码成功 → onSelectModel；6) 含斜杠 → 按 provider/model 拆；7) 裸 id → provider 留空。
  // [失败路径] 任何一步提前 return 都必须保证「要么不写，要么只写一次」，
  // 否则一次点击会先写 A 再写 B，最终值取决于 microtask 顺序。
  const handleModelValueChange = useCallback(
    (value: string, reasoningLevel?: string) => {
      // [失败路径] 这里是锁定期最外层防线（INV-03）：
      // 菜单 disabled 只是 UI 提示，热键、恢复回调、程序化 onChange 都可能绕过，必须在此拦截。
      if (modelLocked) return;
      const decoded = decodeCustomModelValue(value);
      // 草稿的点击时可见模型可能只存在于 catalog，或已经被最新 draft
      // intent 覆盖，不能让 SessionPane 再从迟到的 prewarm projection 反推。
      const sourceModel =
        effectiveConfig?.provider && effectiveConfig.model
          ? {
              provider: effectiveConfig.provider,
              model: effectiveConfig.model,
            }
          : null;
      // debug 日志（草稿态切模型排障）：点击值 + 解码分支。
      logger.debug("[v4-toolbar] model select onValueChange", {
        value,
        decodedProviderId: decoded?.providerId ?? null,
        decodedModelName: decoded?.modelName ?? null,
        draftMode,
      });
      const selectedRegistryProvider = decoded?.providerId
        ? modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )
        : undefined;
      // [契约] recovery 只适用于 api-key 接入的 provider（INV-10）：
      // 套餐类 provider 的选择由服务端目录决定，本地恢复链对它没有意义。
      // [失败路径] selectedRegistryProvider 取不到时 eligible 为 false，
      // 宁可走普通选择让宿主报错，也不要把未知 provider 送进恢复链。
      const customRecoveryEligible = isApiKeyAccess(selectedRegistryProvider?.config.access);
      if (
        configOptionsError &&
        decoded?.providerId &&
        customRecoveryEligible &&
        onRecoverCustomModelSelection
      ) {
        setRecoveryPending(true);
        void Promise.resolve(onRecoverCustomModelSelection(value, sourceModel))
          .catch((error) => {
            logger.warn("[v4-toolbar] custom provider recovery failed", {
              error: error instanceof Error ? error.message : String(error),
              providerId: decoded.providerId,
            });
          })
          .finally(() => {
            setRecoveryPending(false);
          });
        return;
      }
      if (decoded) {
        if (reasoningLevel !== undefined)
          onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel, reasoningLevel);
        else onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel);
        return;
      }
      // [失败路径] slashIndex > 0 才拆分：
      // 等于 0 表示值以斜杠开头（畸形值），此时按裸 id 处理比产出空 provider 更安全。
      // [权衡] 这里不做 trim：模型名可能合法地包含空格，裁剪会改变用户的选择。
      const slashIndex = value.indexOf("/");
      if (slashIndex > 0) {
        onSelectModel(value.slice(0, slashIndex), value.slice(slashIndex + 1), sourceModel);
        return;
      }
      // 裸 model id：provider 沿用当前（宿主从最新投影补齐）。
      onSelectModel("", value, sourceModel);
    },
    [
      configOptionsError,
      displayProvider,
      draftMode,
      effectiveConfig?.model,
      effectiveConfig?.provider,
      onRecoverCustomModelSelection,
      onSelectModel,
      modelLocked,
      modelSelectionView,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // [契约] 切换菜单分组 = 目录分组 + 已订阅团队产品 + 当前连接选择。
  // [失败路径] 必须与 subscribedTeamProducts / providerFamilyConnectionSelections 同步：
  // 连接选择变化后菜单仍显示旧团队，点击会切到已失效的连接键。
  const planGroups = useMemo(
    () =>
      buildComposerPlanGroups(
        modelSelectGroups,
        subscribedTeamProducts,
        providerSettingsView,
        displayProvider,
        modelGroupLabels,
        sharedSettings?.providerFamilyConnectionSelections,
      ),
    [
      modelSelectGroups,
      subscribedTeamProducts,
      providerSettingsView,
      displayProvider,
      modelGroupLabels,
      sharedSettings?.providerFamilyConnectionSelections,
    ],
  );
  // [事务] 连接切换由独立 owner 负责（loading / 错误 / 提交后刷新目录），
  // 工具条只提供「当前展示值」与「选中回调」两个接点。
  // [并发] waitForPresentation: true：切换后等目录重新就绪再落值，
  // 避免菜单先跳到新连接、模型仍是旧连接的值。
  // [失败路径] presentationErrorRevision 只在 ready 时透传，
  // loading 期的旧错误不能触发重试提示。
  const connectionSwitch = useComposerConnectionSwitch({
    workspacePath,
    workspaceIdentity,
    agentProvider: displayProvider,
    normalizedValue: normalizedModelValue,
    onSelectModel: handleModelValueChange,
    waitForPresentation: true,
    refreshPresentation: modelSelectionRefresh,
    presentationStatus: modelSelectionState.status,
    presentationRevision: modelSelectionView?.revision,
    presentationErrorRevision:
      modelSelectionState.status === "ready"
        ? modelSelectionState.refreshError?.revision
        : undefined,
  });
  // [契约] 当前选中 provider 只从「规范化后的展示值」解码：
  // 从 effectiveConfig 直接读会与触发器展示分叉（例如值已被兜底成占位）。
  const selectedProviderId = decodeCustomModelValue(normalizedModelValue)?.providerId;
  const selectedPlanGroup = planGroups.find((group) => {
    const connection = group.connection;
    if (!connection || connection.providerId !== selectedProviderId) return false;
    const selection = sharedSettings?.providerFamilyConnectionSelections?.[connection.family];
    return (
      connection.selection?.kind !== "team-coding-plan" ||
      (selection && composerConnectionKey(connection.family, selection) === connection.key)
    );
  });
  // [并发] pending 时锁定 previousKey（INV-26）：
  // 此刻目录可能已切到新连接，但用户意图尚未完成，高亮必须停在原连接。
  // [失败路径] 第二段兜底只接受「非 team 且含当前 value」的分组：
  // 团队共用模型 value，若不过滤会误选另一个团队，并把用户点击目标挡住。
  const selectedPlanKey = connectionSwitch.pending
    ? connectionSwitch.previousKey
    : (selectedPlanGroup?.key ??
      // 团队共用模型 value；当前过期行隐藏后，不能误选另一团队并阻止用户点击它。
      planGroups.find(
        (group) =>
          group.connection?.selection?.kind !== "team-coding-plan" &&
          group.items.some((item) => item.value === normalizedModelValue),
      )?.key);

  // [契约] 档位候选只来自目标 Host 目录，按当前 provider+model 精确定位。
  // [失败路径] 返回 null（模型不在目录 / 无档位）时下游整体不展示档位控件，不造默认项。
  const draftModelThoughtOption = useMemo(
    () =>
      effectiveConfig
        ? resolveDraftModelThoughtOption(
            effectiveConfig.provider,
            effectiveConfig.model,
            modelSelectionView,
          )
        : null,
    [effectiveConfig, modelSelectionView],
  );

  // 候选档位只来自目标 Host 的 ModelSelectionView，已选档位只来自 Composer。
  // [事务] 候选来自目录，当前值来自 Composer（INV-15）。
  // [失败路径] currentValue 必须过 resolveDraftThoughtCurrentValue：
  // 用户选的档位可能已不在新模型的可选列表里，需要回落到该模型的默认档，
  // 直接透传会让受控 Select 显示一个不存在的选项（空白）。
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!effectiveConfig) return null;
    if (!draftModelThoughtOption) return null;
    return {
      ...draftModelThoughtOption,
      currentValue: resolveDraftThoughtCurrentValue({
        thought: effectiveConfig.thought,
        thoughtLevels: draftModelThoughtOption.options?.map((option) => option.value) ?? [],
      }),
    };
  }, [draftModelThoughtOption, effectiveConfig]);

  // [契约] 档位写入口，携带 modelContext 固定本次操作的目标模型：
  // 异步落库期间用户可能已切模型，缺 modelContext 会把档位写到错误模型上。
  const handleThoughtValueChange = useCallback(
    (value: string) => {
      if (!effectiveConfig) return;
      // [失败路径] 空值必须吞掉（INV-14）：
      // 跨模型受控 Select 重建时会触发一次空 value，它不是用户选择；
      // 若继续上抛，会把模型 intent 标成 superseded，导致 accepted 模型无法写入全局元组。
      // [权衡] 这里只打 debug 日志：高频交互排障需要，但不能进生产日志量。
      if (!value.trim()) {
        // 跨模型受控 Select 重建时可能抛出一次空 value；它不是用户选择，
        // 若继续上抛会把模型 intent 标成 superseded，导致 accepted 模型无法写入全局元组。
        logger.debug("[v4-toolbar] ignore synthetic empty thought change", {
          model: effectiveConfig.model,
          provider: effectiveConfig.provider,
        });
        return;
      }
      onSelectThought(value, {
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
      });
    },
    [effectiveConfig, onSelectThought],
  );

  // Ctrl+T 热键：按目录顺序循环下一次 Submission 的思考深度。
  // [失败路径] 两个早退缺一不可（INV-16）：
  // 非 select（单档/无档）与 nextValue == null 都不能上抛，否则会写入空档位。
  // [契约] 循环顺序由 getNextThoughtLevelValue 按目录顺序给出，这里不自定义顺序。
  const handleCycleThoughtLevel = useCallback(() => {
    if (!thoughtOption || thoughtOption.type !== "select") {
      return;
    }
    const nextValue = getNextThoughtLevelValue(thoughtOption);
    if (nextValue == null) {
      return;
    }
    if (!effectiveConfig) return;
    onSelectThought(nextValue, {
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
    });
  }, [effectiveConfig, onSelectThought, thoughtOption]);

  // [契约] 把 usage.contextWindow 投影成展示结构；cache / breakdown 只在存在时透传：
  // 显式写 undefined 字段会让下游的「有无缓存」判断失真。
  // [失败路径] 没有 contextWindow 返回 null（新任务 / 老会话），展示层据此不渲染用量圈。
  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
    };
  }, [usage?.contextWindow]);
  // 工具条热键已转正为命令表命令：tooltip 快捷键文案读生效表，
  // 改绑后按钮提示即时跟随（不能用硬编码文案）。
  // [契约] 提示文案读生效绑定表（INV-29）：
  // 硬编码 "Ctrl+M" 在用户改绑或非 Windows 平台上会给出错误提示。
  const modelShortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const selectConnection = connectionSwitch.select;
  // 原因：内联对象会在无关渲染时使 memo 选择器失效；按展示事实和回调缓存选项。
  // [性能] 这个对象直接进 memo 子组件，必须整体缓存（INV-07 的引用侧）：
  // 内联对象会让 ModelConfigSelect 在每次 token 渲染时失效。
  // [失败路径] providerMenu.error 只透传切换错误，不混入团队目录查询错误：
  // 登录失败被挂到 API 菜单上，用户会以为是自己 key 的问题。
  const composerOptions = useMemo<ComposerModelOptions>(
    () => ({
      providerMenu: {
        groups: planGroups,
        selectedKey: selectedPlanKey,
        pending: connectionSwitch.pending,
        // 团队目录查询不是用户的连接切换操作，不能把登录错误挂到 API 菜单。
        error: connectionSwitch.error,
        onSelect: (group) => {
          // 原因：展示失败时设置可能已成功；已选连接仍须允许重试，不能被同 key 短路。
          // [失败路径] 同 key 短路必须带 !error（INV-27）：
          // 展示失败但设置可能已成功的场景下，用户需要能再点一次同一连接重试。
          // [事务] 无 connection 的普通 API 组也必须走 selectConnection（INV-28）：
          // 绕过 owner 会缺少 loading 且暴露旧目录。
          if (group.key === selectedPlanKey && !connectionSwitch.error) return;
          if (group.connection) {
            void selectConnection(group.connection, selectedPlanKey);
          } else {
            const model = chooseConnectionModel(
              group.items,
              decodeCustomModelValue(normalizedModelValue)?.modelName,
            );
            const providerId = decodeCustomModelValue(model?.value ?? "")?.providerId;
            // 原因：普通 API 原先绕过连接切换 owner，缺少 loading 且会暴露旧目录。
            if (providerId)
              void selectConnection(
                {
                  key: group.key,
                  label: group.label,
                  providerId,
                  family: connectionFamily,
                  items: group.items,
                },
                selectedPlanKey,
              );
          }
        },
      },
      providerLabel: intl.formatMessage({ id: "chat.toolbar.combined.provider" }),
      modelsLabel: intl.formatMessage({ id: "chat.toolbar.combined.models" }),
      effortLabel: intl.formatMessage({ id: "chat.toolbar.combined.effort" }),
      effortShortcutLabel: thoughtShortcutLabel,
      selectModelLabel: intl.formatMessage({ id: "chat.toolbar.combined.selectModel" }),
      levels:
        thoughtOption?.options?.map((entry) => ({
          value: entry.value,
          label: getThoughtLevelLabel(intl, displayProvider, thoughtOption, entry),
        })) ?? [],
      value: String(thoughtOption?.currentValue ?? ""),
      onValueChange: handleThoughtValueChange,
    }),
    [
      planGroups,
      selectedPlanKey,
      connectionSwitch.pending,
      connectionSwitch.error,
      selectConnection,
      normalizedModelValue,
      connectionFamily,
      intl,
      thoughtShortcutLabel,
      thoughtOption,
      displayProvider,
      handleThoughtValueChange,
    ],
  );
  // [契约] v4 不做逐项锁：锁定只发生在整条工具条层（modelLocked），
  // 保留这个回调是为了复用旧组件的接口，必须返回稳定 true/false 而不是新函数。
  const isModelOptionLocked = useCallback(() => false, []);

  // 键盘热键（旧 useToolbarShortcutBindings）：Ctrl+M 打开模型菜单、Ctrl+T 循环思考深度。
  // 模式循环（Ctrl+Shift+M）由 V4ComposerModeSwitch 单独绑定（modeOption 在彼处）。
  // 模型留空是正常的待选择状态，包括已有会话；不能因为没有已选模型隐藏重选入口。
  // 有可选组时正常显示；无组但有「管理模型」入口时也显示，避免用户零模型入口。
  // [失败路径] 两个条件缺一不可（INV-05）：
  // modelSelectGroups 为空但 showManageModelsAction 为真时仍要露出入口，否则零模型用户进不去设置。
  // [契约] 模型留空是正常待选状态（含已有会话），不能因此隐藏重选入口。
  const modelMenuVisible = modelSelectGroups.length > 0 || showManageModelsAction;
  // Bug 根因：手机端固定宽度的二级菜单没有消费 Radix 测得的当前方向可用宽度，
  // 共享 min-w-32 还会阻止极窄空间继续收缩。保持二级交互，同时把窗口边缘作为硬上限。
  const providerSubmenuClassName =
    isWebRemoteControl && isMobileViewport
      ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
      : undefined;
  // [并发] 三档禁用粒度（INV-31）：
  // toolbarDisabled  整体不可用（disabled / 恢复中 / 连接切换中）。
  // modelMenuDisabled  额外叠加 modelLocked 与「菜单不可见」。
  // hasAnyOption  两个选项都没有时连绑定都不注册，避免占位热键抢键。
  // [契约] onCycleSessionMode 传 noop：模式循环由 V4ComposerModeSwitch 单独绑定。
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modelOption) || Boolean(thoughtOption),
    toolbarDisabled: disabled || recoveryPending || connectionSwitch.pending,
    modelMenuDisabled:
      disabled || recoveryPending || modelLocked || connectionSwitch.pending || !modelMenuVisible,
    modelOption,
    thoughtOption: thoughtOption ?? undefined,
    onOpenModelMenu: handleOpenModelMenuShortcut,
    onCycleThoughtLevel: handleCycleThoughtLevel,
    onCycleSessionMode: noop,
  });

  // [契约] 渲染顺序即优先级，自上而下不可随意调整：
  // 1) e2e 锚点 span：只读投影，不产生任何状态。
  // 2) context usage（!modelLocked）：Highspeed 期间隐藏，避免与卡片信息冲突。
  // 3) Highspeed 指示器 → 加载失败重试 → 不可用说明 → 空配置管理 → 模型选择器。
  // 4) 倒计时（Highspeed 且有过期时间）。
  // 5) 档位控件：仅在锁定或 Highspeed 展示时出现，其它时候档位在选择器内部。
  // [失败路径] 首三项都是「同一位置的不同事实」，必须用一条三元链表达：
  // 拆成多个独立条件渲染会同时出现指示器与加载失败。
  return (
    <>
      {/*
        e2e 契约（TID_V4_MODEL_CONFIG）：Composer/usage 状态的 data-* 属性锚点。
        Bug 原因：跨模型切换会主动清除源模型的显式 thought；此时可见控件已按目标模型
        Option Spec 展示默认档位，但旧锚点仍暴露空的原始投影。data-thought 必须与用户
        实际看到的受控值一致，不能重新引入一份草稿状态。
      */}
      <span
        data-testid={TID_V4_MODEL_CONFIG}
        data-source={effectiveConfig || draftConfig?.mode ? "composer" : ""}
        data-provider={effectiveConfig?.provider ?? ""}
        data-model={effectiveConfig?.model ?? ""}
        data-thought={
          thoughtOption?.type === "select"
            ? String(thoughtOption.currentValue ?? "")
            : (effectiveConfig?.thought ?? "")
        }
        data-thought-levels={
          thoughtOption?.type === "select"
            ? (thoughtOption.options ?? []).map((option) => option.value).join(",")
            : ""
        }
        data-mode={draftConfig?.mode ?? ""}
        data-plan-enabled={draftConfig?.planEnabled ?? false}
        data-usage-used={usage?.contextWindow?.usedTokens ?? ""}
        data-usage-max={usage?.contextWindow?.maxTokens ?? ""}
        className="hidden"
      />
      {/* Highspeed 卡激活即锁定模型；不能等动效交接完成才隐藏，否则 usage 圈圈会短暂闪现。 */}
      {!modelLocked ? (
        <ChatContextUsage
          codingPlanUsageRemaining={codingPlanUsageRemaining}
          taskUsage={taskUsage}
          startPlanBalance={contextStartPlanBalance}
          selectedProvider={displayProvider}
          intl={intl}
          locale={locale}
          onSendCompressionCommand={onSendCompressionCommand}
          compressionDisabled={disabled || recoveryPending}
        />
      ) : null}
      {/* 加速轮的模型由本次卡决定，选型菜单此时不可用，所以指示器优先于选型加载态。 */}
      {highspeedPresented && highspeedModel ? (
        <HighspeedModelIndicator
          model={highspeedModel}
          originalModel={modelTriggerDisplay.fullLabel}
          sweepActive={highspeedSweepActive}
          animateEntrance={highspeedEntranceAnimated}
        />
      ) : modelSelectionState.status === "error" && modelSelectionReload ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm text-destructive"
          onClick={modelSelectionReload}
        >
          {intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}
        </Button>
      ) : modelSelectionState.status === "unavailable" ? (
        <span className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id:
              modelSelectionState.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })}
        </span>
      ) : modelMenuVisible &&
        !providerSourcesLoading &&
        planGroups.length === 0 &&
        !connectionSwitch.pending ? (
        // 空配置是正常状态；直接复用 Provider 设置入口，不展开无名称、无模型的菜单。
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm"
          data-testid="chat-model-select-trigger"
          onClick={handleOpenModelProviderSettings}
        >
          {manageModelsLabel}
        </Button>
      ) : modelMenuVisible ? (
        <ModelConfigSelect
          key={workspaceIdentity?.trim() || workspacePath}
          modelGroups={modelSelectGroups}
          contentAlign="center"
          normalizedValue={normalizedModelValue}
          triggerLabel={modelTriggerDisplay.modelLabel}
          composerOptions={composerOptions}
          showManageModelsAction={showManageModelsAction}
          manageModelsLabel={manageModelsLabel}
          onManageModels={handleOpenModelProviderSettings}
          lockReasonMessage={intl.formatMessage({
            id: modelLocked
              ? "chat.highspeed.modelLocked"
              : "chat.toolbar.modelSwitch.lockedByRunningTask",
          })}
          isItemLocked={isModelOptionLocked}
          onValueChange={handleModelValueChange}
          disabled={
            disabled ||
            recoveryPending ||
            modelLocked ||
            (modelSelectionState.status !== "ready" &&
              !(modelSelectionState.status === "loading" && modelSelectionState.catalog))
          }
          tooltipTitle={modelTriggerDisplay.fullLabel}
          shortcutLabel={modelShortcutLabel}
          triggerRef={modelTriggerRef}
          open={!modelLocked && activeConfigPicker === "model"}
          onOpenChange={handleModelPickerOpenChange}
          openRequestKey={modelMenuOpenRequestKey}
          labelVisibilityClassName="hidden @sm/composer:inline-flex"
          indicatorClassName="block group-data-[composer-model-icon=true]/toolbar:hidden"
          triggerLabelClassName="block min-w-0 text-left group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
          triggerClassName="composer-model-trigger group-data-[composer-model-icon=true]/toolbar:px-1.5 group-data-[composer-model-icon=true]/toolbar:justify-center"
          triggerIconClassName="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
          focusSelectorOnClose={V4_COMPOSER_INPUT_SELECTOR}
          providerSubmenuClassName={providerSubmenuClassName}
        />
      ) : null}
      {highspeedPresented && highspeedExpiresAt !== undefined ? (
        <HighspeedCountdown expiresAt={highspeedExpiresAt} />
      ) : null}
      {thoughtOption && (modelLocked || highspeedPresented) ? (
        <ThoughtLevelCycleControl
          composerCollapsePriority={3}
          labelVisibilityClassName="inline-flex"
          indicatorClassName="block"
          triggerClassName={cn(highspeedPresented && "text-ui-caption")}
          option={thoughtOption}
          onValueChange={handleThoughtValueChange}
          disabled={disabled || recoveryPending}
          intl={intl}
          provider={displayProvider}
          shortcutLabel={thoughtShortcutLabel}
          triggerRef={thoughtTriggerRef}
          open={activeConfigPicker === "thought"}
          onOpenChange={handleThoughtPickerOpenChange}
          restoreFocusSelector={V4_COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
    </>
  );
}

// [性能] 导出面只暴露 memo 后的组件；Impl 保持私有，防止外部绕过 memo 直接调用。
// [失败路径] 下方 import 语句位于 export 之后属于既有文件结构（循环依赖规避），
// 整理 import 顺序时不要移动它，否则 provider 包会在模块初始化期被提前求值。
export const V4ComposerModelControls = memo(V4ComposerModelControlsImpl);
import { isApiKeyAccess } from "@zcode/provider";
