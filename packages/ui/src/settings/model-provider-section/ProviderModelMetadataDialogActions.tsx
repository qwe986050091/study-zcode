// INV-01 恢复按钮沿用表单重置语义：守住位置 消息键；改错故障 按钮文案与行为不符。
// INV-02 恢复按钮为幽灵样式：守住位置 变体属性；改错故障 次要动作抢走视觉焦点。
// INV-03 反馈区无内容时不占位：守住位置 双空早退；改错故障 空容器撑开表单。
// INV-04 错误优先于成功：守住位置 三元选择；改错故障 同时存在时显示成功。
// INV-05 反馈图标随状态切换：守住位置 图标选择；改错故障 错误也显示对勾。
// INV-06 反馈角色随状态切换：守住位置 角色属性；改错故障 读屏软件不播报错误。
// INV-07 图标对读屏隐藏：守住位置 隐藏属性；改错故障 图标名被重复朗读。
// INV-08 错误文字优先于默认文案：守住位置 空值合并；改错故障 有错误仍显示已载入。
// INV-09 成功文案来自消息键：守住位置 翻译调用；改错故障 界面出现英文硬编码。
// INV-10 跟随建议开关带说明入口：守住位置 说明组件；改错故障 用户不知道开关含义。
// INV-11 开关标签同时作无障碍名：守住位置 标签属性；改错故障 读屏只念开关。
// INV-12 开关状态由调用方持有：守住位置 受控属性；改错故障 开关自行变化不回写。
// INV-13 页脚左侧动作可缺席：守住位置 条件渲染；改错故障 左侧出现空槽。
// INV-14 保存中禁用两个按钮：守住位置 禁用属性；改错故障 保存期间可重复提交。
// INV-15 保存中显示转圈图标：守住位置 条件渲染；改错故障 长请求看起来无响应。
// INV-16 转圈图标对读屏隐藏：守住位置 隐藏属性；改错故障 朗读出现图标名称。
// INV-17 页脚两端分布：守住位置 布局类；改错故障 两个按钮挤在同一侧。
// INV-18 页脚标注测试钩子：守住位置 数据属性；改错故障 端到端测试定位不到页脚。
//
// 模块职责：提供模型元数据弹窗的恢复、反馈、开关与页脚四个小件。
// 状态所有权：无状态；开关取值、禁用与保存状态全部由调用方注入。
// 阅读顺序：先看两个提示小件，再看建议开关，最后看页脚动作组。
import { Loader2Icon, CircleAlertIcon, CheckCircle2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ModelConfigHelp } from "@/settings/model-provider-section/ModelConfigHelp.js";

// ModelConfigRestoreButton 用 variant="ghost" 渲染重置入口。
// disabled 完全由调用方传入，组件不自行判断。
// 文案取 settings.modelProvider.resetForm 消息键。
export function ModelConfigRestoreButton({
  disabled,
  onRestore,
}: {
  disabled: boolean;
  onRestore?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="shrink-0 px-0 text-ui-sm text-foreground-subtle underline underline-offset-4 hover:bg-transparent"
      disabled={disabled}
      onClick={onRestore}
    >
      {intl.formatMessage({ id: "settings.modelProvider.resetForm" })}
    </Button>
  );
}

// error 与 matched 都为空时 ModelConfigDraftFeedback 返回 null。
// error 存在时优先按 alert 渲染，忽略 matched。
// 图标在 CircleAlertIcon 与 CheckCircle2Icon 之间切换。
export function ModelConfigDraftFeedback({
  error,
  matched,
}: {
  error?: string | null;
  matched?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (!error && !matched) return null;
  const Icon = error ? CircleAlertIcon : CheckCircle2Icon;
  return (
    <div
      role={error ? "alert" : "status"}
      className={
        error
          ? "flex min-h-10 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
          : "flex min-h-10 items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-success"
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="text-ui-sm font-medium">
        {error ?? intl.formatMessage({ id: "settings.modelProvider.modelDefaultsLoaded" })}
      </span>
    </div>
  );
}

// label 同时作为 Switch 的 aria-label。
// ModelConfigHelp 挂在 label 的 span 旁，点击打开字段说明。
// Switch 的 checked 由外部传入，onCheckedChange 原样上报。
export function ModelSmartConfigSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "settings.modelProvider.followRecommendedConfig" });
  return (
    <div
      data-model-recommended-config="true"
      className="flex shrink-0 items-center justify-start gap-2 pt-2 text-ui-base text-foreground"
    >
      <span className="inline-flex items-center whitespace-nowrap">
        {label}
        <ModelConfigHelp field="followRecommendedConfig" />
      </span>
      <Switch disabled={disabled} aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// leadingAction 为空时左侧留空，只渲染取消与保存。
// saving 为真时取消与保存按钮同时 disabled。
// saving 为真时保存按钮显示转圈图标，文案仍在。
export function ProviderModelMetadataDialogActions({
  saveLabel,
  cancelLabel,
  saving,
  onSave,
  onCancel,
  leadingAction,
}: {
  saveLabel: string;
  cancelLabel: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  leadingAction?: ReactNode;
}) {
  return (
    <div data-model-settings-footer="true" className="flex items-center justify-between gap-2 pt-1">
      {leadingAction}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="lg" disabled={saving} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="button" variant="default" size="lg" disabled={saving} onClick={onSave}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
