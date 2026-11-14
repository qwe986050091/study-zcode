// INV-01 灰度未命中不渲染：守住位置 灰度判断；改错故障 未放量用户看到入口。
// INV-02 关闭后本次会话不再出现：守住位置 关闭态；改错故障 关闭后立即复现。
// INV-03 本地模板追加在远端之后：守住位置 合并缓存；改错故障 空白创建卡排到首位。
// INV-04 远端模板依赖服务实例：守住位置 依赖数组；改错故障 模板列表不随服务更新。
// INV-05 资格探测随设置修订：守住位置 修订号参数；改错故障 套餐变更后资格不刷新。
// INV-06 套餐不可用两条判据：守住位置 不可用计算；改错故障 无套餐用户绕过门禁。
// INV-07 主页只做导航放行：守住位置 点击内判断；改错故障 已购套餐用户被误拦。
// INV-08 表单提交仍严格拦截：守住位置 门禁分层；改错故障 主页放行被当成提交放行。
// INV-09 拦截时记录调试日志：守住位置 调试日志调用；改错故障 线上无法定位被拦原因。
// INV-10 拦截时弹出套餐提示：守住位置 提示调用；改错故障 用户点击无任何反馈。
// INV-11 草稿标题按当前语言生成：守住位置 物化传语言；改错故障 中文界面出现英文草稿。
// INV-12 空白创建不预填标题：守住位置 自定义判断；改错故障 空白创建被写入模板文案。
// INV-13 草稿带遥测来源：守住位置 遥测字段；改错故障 点击来源无法归因。
// INV-14 先暂存再导航：守住位置 调用顺序；改错故障 创建页取不到草稿。
// INV-15 导航回调可缺省：守住位置 可选调用；改错故障 未传回调时崩溃。
// INV-16 入口固定在底部：守住位置 底部内边距；改错故障 入口与窗口底部贴合。
// INV-17 宽度不依赖会话容器：守住位置 最大宽度类；改错故障 容器外宽度塌陷。
// INV-18 模板栅格桌面三列：守住位置 响应式类；改错故障 窄屏出现横向滚动。
//
// `OffPeakNewTaskEntry` 是新建任务页底部的闲时任务入口：渲染引导横幅与 Client Scenes 模板卡，点击后把预填草稿交给 Automations。
// `useOffPeakTaskStore` 持有 `grayConfig`、`newTaskBannerDismissed` 与 `pendingCreateDraft`；模板列表由 `useAutomationTemplates` 提供。
// 阅读顺序：先看灰度与模板合并，再读门禁与点击流程，最后看横幅与栅格结构。
import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* New task 页闲时任务入口（Figma ⚫️ Z.ai - Zcode / node 5488-3978；spec §5「模板」/ D30-4 第二入口）。
   引导横幅「Use free run Idle-time task」+ Client Scenes 模板卡（预填创建表单，Customize=空白）。
   灰度未命中不渲染（D31）；横幅可关闭（本会话内，D28「关闭后下次登录/重启再开」→ session 级）。
   点击卡片：暂存预填草稿 → 打开 Automations 主视图（idle tab）创建表单消费草稿。
   入口位于草稿页底部固定区（距底 38px），模板恢复为桌面三列横排、窄屏单列；
   业务逻辑（灰度、Coding Plan 判定、Upgrade Toast、草稿预填、埋点）保持不变。 */
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { Megaphone, Moon, X } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  appendLocalCustomizeTemplate,
  materializeOffPeakTemplateDraft,
  resolveOffPeakTemplateText,
  type OffPeakAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useOffPeakTaskStore, type OffPeakCreateDraft } from "@/store/offPeakTaskStore.js";
import { useMemo } from "react";

interface OffPeakNewTaskEntryProps {
  /** 打开 Automations 主视图（idle tab）；点击卡片前会先暂存预填草稿。 */
  onOpenAutomations?: () => void;
}

export function OffPeakNewTaskEntry({ onOpenAutomations }: OffPeakNewTaskEntryProps) {
  const { intl, locale } = useZCodeIntl();
  const { clientScenesService } = useServices();
  const { offPeak: remoteOffPeakTemplates } = useAutomationTemplates(clientScenesService);
  // `appendLocalCustomizeTemplate` 先滤掉远端里的 `customize` 项并截到 `HOMEPAGE_REMOTE_OFF_PEAK_TEMPLATE_LIMIT` 条，再追加常量 `CUSTOMIZE_TEMPLATE`，因此空白卡恒在末位。
  // 依赖数组只放 `remoteOffPeakTemplates`：本地模板是模块常量，放进依赖会让 `useMemo` 每次渲染都重算。
  const offPeakTemplates = useMemo(
    () => appendLocalCustomizeTemplate(remoteOffPeakTemplates),
    [remoteOffPeakTemplates],
  );
  const { settings: sharedSettings } = useSettings();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  // `useCodingPlanEntryGate` 的 `status` 决定提示动作；`loading` 时 `actionLabel` 留空；`error` 时 `onAction` 走 `entryGate.retry`；`ready` 时才打开升级面板。
  // `entryGate` 不参与下方 `return null` 的灰度判断；门禁未知或报错时入口照常渲染，避免已放量用户看到空白。
  const entryGate = useCodingPlanEntryGate();
  const grayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const dismissed = useOffPeakTaskStore((state) => state.newTaskBannerDismissed);
  const dismiss = useOffPeakTaskStore((state) => state.dismissNewTaskBanner);
  const setPendingCreateDraft = useOffPeakTaskStore((state) => state.setPendingCreateDraft);

  // 灰度未命中 / 用户已关闭 → 不渲染（D31 曝光门控 + D28 可关闭）。
  if (grayConfig?.enabled !== true || dismissed) return null;

  // `resolveCodingPlanEntryPlanStateFromProviderSettings` 把 `providerSettingsView` 归一成 `entryPlanState`；视图为 `null` 时走空对象分支，档位落到 unknown。
  // 该值每次渲染重算并被 `funnelContext` 冻结，不写全局缓存：设置页改了套餐也无需手动失效。
  const entryPlanState = resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView);
  // `codingPlanUnavailable` 两条判据互斥：`codingPlanActive === false` 显式否定直接成立；仅当该字段为 `undefined` 时才回落到 `entryPlanState.entryPlanStatus !== coding_plan`，视图为空不判不可用。
  // 该布尔只拦主页模板卡跳转，表单提交仍由 Automations 的 selected support 严格校验，两层门禁不可合并。
  const codingPlanUnavailable =
    grayConfig.codingPlanActive === false ||
    (grayConfig.codingPlanActive === undefined &&
      providerSettingsView !== null &&
      entryPlanState.entryPlanStatus !== "coding_plan");

  // `showCodingPlanRequiredToast` 的 `actionLabel` 按 `entryGate.status` 三态取值：`loading` 不给动作，`error` 重试，`ready` 打开升级面板。
  // `funnelContext` 在点击时用 `createIdleTimeCodingPlanFunnelContext` 冻结 `providerId`、`eventText` 与 `entryPlanState`；弹窗跨 OAuth 登录仍能归因。
  const showCodingPlanRequiredToast = () => {
    toast(entryGate.label ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryGate.status === "loading"
          ? undefined
          : (entryGate.label ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction:
        entryGate.status === "error"
          ? entryGate.retry
          : () => {
              const providerId =
                sharedSettings?.providerFamilyDomain === "bigmodel"
                  ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
                  : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
              const eventText = intl.formatMessage({
                id: "settings.modelProvider.codingPlan.upgrade",
              });
              // 埋点缺失原因：闲时入口此前只传 providerId，购买面板无法建立来源明确的漏斗，
              // OAuth 前后也没有可延续的归因上下文。点击时冻结一次 context，由全局弹窗跨登录持有。
              codingPlanUpgradeDialog?.openCodingPlanUpgrade({
                providerId,
                initialAudience: "personal",
                funnelContext: createIdleTimeCodingPlanFunnelContext({
                  providerId,
                  eventText,
                  entryPlanState,
                }),
              });
            },
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  };

  // `handleCardClick` 先判 `codingPlanUnavailable`：命中时 `logger.debug` 记录 `template.id` 再弹提示返回，未命中才物化草稿。
  // `materializeOffPeakTemplateDraft(template, locale)` 按当前语言生成标题与指令；`customize` 模板不带 title/prompt，`telemetrySource` 固定 app.session，先 `setPendingCreateDraft` 再 `onOpenAutomations`。
  const handleCardClick = (template: OffPeakAutomationTemplate) => {
    // Bug 原因：selected-connection 门禁把“未选 provider”和“没有套餐”混为一谈，误拦已有套餐用户。
    // 主页只做导航，按任一 Coding Plan 放行；表单提交仍由 Automations 的 selected support 严格拦截。
    if (codingPlanUnavailable) {
      logger.debug("[off-peak] blocked home template without any Coding Plan", {
        templateId: template.id,
      });
      showCodingPlanRequiredToast();
      return;
    }
    // Bugfix：首页文案走 i18n、草稿却曾写死英文，导致中文系统点击模板后创建页中英混排。
    // 点击时按当前 locale 生成同源标题与指令；Customize 仍保持空白创建。
    const materialized = materializeOffPeakTemplateDraft(template, locale);
    const draft: OffPeakCreateDraft = {
      ...(template.customize ? {} : { title: materialized.title, prompt: materialized.prompt }),
      telemetrySource: {
        eventRegion: "app.session",
        templateId: template.id,
      },
    };
    setPendingCreateDraft(draft);
    onOpenAutomations?.();
  };

  // 外层容器用 `pb-[38px]` 固定与窗口底部的间距；`@container/conversation` 只声明在 timeline 内部，外层宽度因此不受它影响。
  // 横幅 `max-w-[580px]` 水平居中；关闭按钮仍在 DOM 中，仅通过类名隐藏。
  return (
    // 5488-3978：入口常驻草稿页底部，pb-[38px] 给出与窗口底部的固定间距；
    // 宽度不依赖 @container/conversation 断点外扩（该容器只声明在 timeline 内部）。
    <div
      data-off-peak-new-task-entry="true"
      className="flex w-full shrink-0 flex-col items-center gap-3 px-4 pb-[38px]"
    >
      {/* 引导横幅：32px 图标位 + 4px 间距 + 主文案/说明 Tooltip，整体水平居中；
          关闭钮本轮设计隐藏（见下方注释） */}
      <div
        data-off-peak-new-task-banner="true"
        className="flex w-full max-w-[580px] items-center justify-center"
      >
        <div className="flex min-w-0 items-center gap-1 text-foreground-subtle opacity-80">
          <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            <Megaphone className="size-4" strokeWidth={2} />
          </span>
          {/* Bug 原因：资格说明与主文案拼成单行后触发省略号，用户既看不全主文案，
              也无法单独查看括号内限制。主文案完整换行，并由整个文案区域承接说明 Tooltip；
              普通文本提示不使用 cursor-help，避免额外出现带问号的光标。 */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* 修复原因：caption 字号随 UI 设置缩放，使用相对行高避免大字号时文字被固定 18px 行盒裁切。 */}
                <span
                  tabIndex={0}
                  className="min-w-0 cursor-default rounded-sm text-ui-caption font-normal leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-hover"
                >
                  {intl.formatMessage({ id: "offPeak.newTask.bannerText" })}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="max-w-none whitespace-nowrap">
                <span>
                  {intl.formatMessage({
                    id: "offPeak.newTask.bannerTipText",
                  })}
                </span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {/* 5488-3978 暂不提供关闭入口：按产品要求只隐藏、不删除实现，
            dismissNewTaskBanner 与 offPeak.newTask 关闭语义保持可用；
            重新放开时把 hidden 换回 flex 即可（两者同属 display 组，不能并存）。 */}
        <button
          type="button"
          data-off-peak-new-task-dismiss="true"
          onClick={dismiss}
          aria-label={intl.formatMessage({ id: "common.close" })}
          className="ml-auto hidden size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtle opacity-80 hover:bg-hover hover:opacity-100"
        >
          <X className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* 远程模板按钮使用等宽栅格；桌面横排，窄屏单列，
          描述不锁固定高度，由同一行最高内容拉伸卡片。 */}
      <div
        data-off-peak-template-grid="true"
        className="grid w-full max-w-[780px] grid-cols-1 gap-4 sm:grid-cols-3"
      >
        {offPeakTemplates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => handleCardClick(template)}
            className="flex h-full w-full flex-col gap-2 rounded-2xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-surface-hover"
          >
            <div className="flex items-center gap-1.5 text-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <ClientSceneLucideIcon
                  name={template.iconName}
                  aria-hidden="true"
                  className="size-4"
                  size={16}
                  strokeWidth={2}
                  fallback={
                    <Moon
                      aria-hidden="true"
                      className="size-4"
                      data-off-peak-homepage-template-icon="moon"
                      size={16}
                      strokeWidth={2}
                    />
                  }
                />
              </span>
              <span className="truncate text-ui-base leading-5 text-foreground">
                {resolveOffPeakTemplateText(template, "title", locale, intl.formatMessage)}
              </span>
            </div>
            <p className="text-wrap-phrase line-clamp-2 text-ui-caption font-normal leading-snug text-foreground-subtle">
              {resolveOffPeakTemplateText(
                template,
                "homepageDescription",
                locale,
                intl.formatMessage,
              )}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
