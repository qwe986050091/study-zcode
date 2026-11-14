// INV-01 模板分组只由 zhipuIds 决定：守住位置 常量数组；改错故障 新模板被分到错误分组。
// INV-02 分组顺序固定为 zhipu 在前、other 在后：守住位置 groups 数组；改错故障 用户看到不稳定的排序。
// INV-03 模板顺序保持服务端下发顺序：守住位置 flatMap 与 filter；改错故障 排序随本地实现变化。
// INV-04 创建自定义供应商只在 other 组出现：守住位置 分组判断；改错故障 每个分组都多出一张自定义卡。
// INV-05 创建期间所有卡片统一禁用：守住位置 disabled 入参；改错故障 并发点击创建多个供应商。
// INV-06 创建失败必须留在当前页并给出可重试横幅：守住位置 createWithFeedback 的捕获；改错故障 用户看不到失败结果。
// INV-07 重试动作复用同一条反馈键：守住位置 feedbackKey；改错故障 多次失败堆叠出多条横幅。
// INV-08 启动新创建前先关闭旧反馈：守住位置 dismissFeedback 调用；改错故障 旧错误遮住新流程。
// INV-09 原始错误只写统一日志，不进横幅：守住位置 logger.error；改错故障 内部细节暴露给用户。
// INV-10 模板展示名统一走名称解析器：守住位置 resolveProviderTemplateName；改错故障 多语言下模板名不一致。
// INV-11 自定义供应商名称走国际化默认文案：守住位置 customLabel；改错故障 空名称被提交。
// INV-12 返回按钮必须有读屏标签：守住位置 aria-label；改错故障 图标按钮无含义。
// INV-13 卡片测试标识按模板标识生成：守住位置 testId 调用；改错故障 自动化无法定位具体模板。
// INV-14 卡片图标与文案都必须允许收缩与换行：守住位置 min-w-0 与 break-words；改错故障 长名称撑破网格。
// INV-15 网格在窄屏单列、宽屏两列：守住位置 grid 类名；改错故障 移动端卡片过窄。
// INV-16 卡片必须是原生按钮以保留键盘语义：守住位置 button 元素；改错故障 键盘无法聚焦或触发。
// INV-17 悬停提示只承载完整名称，不改变点击行为：守住位置 ControlHintTooltip；改错故障 提示层拦截点击。
// INV-18 创建回调只接受零参函数，参数在点击时闭包捕获：守住位置 createWithFeedback 签名；改错故障 异步过程中读到错误的模板标识。
//
// 模块职责：渲染供应商模板选择页，按智谱与其他分组展示模板，并提供自定义创建入口。
// 状态所有权：模板列表来自入参；创建中标记与反馈横幅分别由父组件和共享反馈 hook 持有。
// 阅读顺序：先看分组构造，再读带反馈的创建包装，最后看分组渲染与卡片组件。
import type { ProviderSettingsView } from "@zcode/services";
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { resolveProviderTemplateName } from "@zcode/provider";
import type { ReactNode } from "react";
import {
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ProviderLogo } from "./ProviderLogo.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";

type ProviderTemplateCreate = (templateId: string) => Promise<void>;
type CustomProviderCreate = (label: string) => Promise<void>;

export function ProviderTemplatePicker({
  templates,
  onBack,
  onCreateFromTemplate,
  onCreateCustom,
  creating,
}: {
  templates: ProviderSettingsView["providerTemplates"];
  onBack: () => void;
  onCreateFromTemplate: ProviderTemplateCreate;
  onCreateCustom: CustomProviderCreate;
  creating: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  const customLabel = intl.formatMessage({ id: "settings.modelProvider.newProviderName" });
  // zhipuIds 固定为 ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"]：groups 里 id 为 "zhipu" 的分组按这个顺序 flatMap 取模板，其余模板进 "other"；这里只做展示归类，不改变 template.config 的能力字段。
  const zhipuIds = ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"];
  // groups 的 "zhipu" 组按 zhipuIds.flatMap 保持稳定顺序，"other" 组用 !zhipuIds.includes(template.templateId) 过滤且保留 templates 的服务端顺序；group.id 同时用于 data-provider-template-group 与 settings.modelProvider.templateGroup.${group.id} 文案键。
  const groups = [
    {
      id: "zhipu",
      templates: zhipuIds.flatMap((id) =>
        templates.filter((template) => template.templateId === id),
      ),
    },
    {
      id: "other",
      templates: templates.filter((template) => !zhipuIds.includes(template.templateId)),
    },
  ] as const;
  // createWithFeedback 先 dismissFeedback("provider-template-create") 清同键旧横幅；await create() 成功后不额外提示，由父组件切页；catch 里 logger.error 记录原始错误，再 showFeedback({ key: feedbackKey, state: "failure", ... }) 展示可读摘要，onAction 的 retry 复用同一个 create 闭包，失败时停留在当前页。
  const createWithFeedback = async (create: () => Promise<void>) => {
    const feedbackKey = "provider-template-create";
    dismissFeedback(feedbackKey);
    try {
      await create();
    } catch (error) {
      // Template 创建失败过去只写日志，用户留在选择页却看不到任何结果。
      // 失败继续留在当前页，并复用详情栏底部反馈横幅提供同一次创建的重试入口。
      // 完整 Schema issues 只进入统一 UI 日志；横幅保持可读摘要，避免原始数组撑满详情区。
      logger.error("[ProviderTemplatePicker] 创建供应商失败", error);
      const retry = () => void createWithFeedback(create);
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.templateCreateFailed" }),
        actionLabel: intl.formatMessage({ id: "settings.modelProvider.templateCreateRetry" }),
        onAction: retry,
        dismissible: true,
      });
    }
  };
  // groups.map 为每个分组渲染标题与卡片网格："other" 组在网格首位插入自定义创建卡，模板卡用 testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, template.templateId) 生成测试标识与 React key，creating 统一传给所有卡片。
  return (
    <section className="space-y-5" data-testid={TID_MODEL_PROVIDER_TEMPLATE_PICKER}>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON}
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.templatePickerTitle" })}
        </h2>
      </div>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.id} data-provider-template-group={group.id} className="space-y-3">
            <h3 className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: `settings.modelProvider.templateGroup.${group.id}` })}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.id === "other" ? (
                <ProviderTemplateCard
                  label={intl.formatMessage({ id: "settings.modelProvider.createCustomProvider" })}
                  disabled={creating}
                  testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom")}
                  icon={
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover">
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </span>
                  }
                  // 自定义卡片的 onClick 走 createWithFeedback(() => onCreateCustom(customLabel))：customLabel 已在渲染期用 intl.formatMessage 解析为当前语言，外层 void 显式忽略 Promise，失败由 createWithFeedback 的 catch 统一展示。
                  onClick={() => void createWithFeedback(() => onCreateCustom(customLabel))}
                />
              ) : null}
              {group.templates.map((template) => {
                const label = resolveProviderTemplateName(template.templateId, template, locale);
                return (
                  <ProviderTemplateCard
                    key={template.templateId}
                    label={label}
                    disabled={creating}
                    testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, template.templateId)}
                    icon={
                      <span className="flex size-9 shrink-0 items-center justify-center">
                        <ProviderLogo logo={template.config.logo} className="size-8" />
                      </span>
                    }
                    onClick={() =>
                      void createWithFeedback(() => onCreateFromTemplate(template.templateId))
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

// ProviderTemplateCard 是受控展示组件：disabled 直接落到 button 的 disabled，onClick 原样转发给调用方，label 同时用于 ControlHintTooltip 的 title 与 break-words 文本，icon 容器 shrink-0 防止长文案挤压图标。
function ProviderTemplateCard({
  label,
  disabled,
  testId: cardTestId,
  icon,
  onClick,
}: {
  label: string;
  disabled: boolean;
  testId: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <button
        type="button"
        data-testid={cardTestId}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-hover hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
      >
        {icon}
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{label}</span>
        <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      </button>
    </ControlHintTooltip>
  );
}
