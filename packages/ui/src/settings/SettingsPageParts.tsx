// INV-01 列宽统一：守住位置 内容列常量；改错故障：各设置页标题起点与宽度不一致。
// INV-02 主题受限：守住位置 选项来源；改错故障：出现无法渲染的自由主题值。
// INV-03 类型收窄：守住位置 变更回调的断言；改错故障：字符串原样下沉，下游类型失配。
// INV-04 预览隔离：守住位置 主题变量覆盖；改错故障：预览继承应用主题，颜色错误。
// INV-05 角标随态：守住位置 激活分支；改错故障：激活预览没有视觉标识。
// INV-06 文案走字典：守住位置 角标格式调用；改错故障：界面出现硬编码语言。
// INV-07 两列网格：守住位置 行的列定义；改错故障：标签与控件互相挤压。
// INV-08 宽模式换行：守住位置 布局分支；改错故障：长说明把控件推到不可见区域。
// INV-09 详情归位：守住位置 详情渲染位置；改错故障：详情重复出现或错列。
// INV-10 首行无边：守住位置 上边框规则；改错故障：分组顶部出现多余分隔线。
// INV-11 卡内零距：守住位置 内容区间距；改错故障：行之间出现双倍空隙。
// INV-12 徽标无交互：守住位置 徽标结构；改错故障：弱提示被渲染成可点按钮。
// INV-13 数字即回传：守住位置 滑块回调；改错故障：字符串被当成数值传播。
// INV-14 可达性：守住位置 原生输入控件；改错故障：自定义控件丢失键盘操作。
// INV-15 标签对齐：守住位置 标签样式；改错故障：拖动时标签宽度变化导致抖动。
// INV-16 查找兜底：守住位置 标签查找的或运算；改错故障：未知主题显示空白。
// INV-17 无本地状态：守住位置 组件体；改错故障：界面值与配置值短暂分叉。
// INV-18 纯展示：守住位置 导出面；改错故障：渲染期间写入配置。
//
// 导出面由 `SettingsRow`、`SettingsGroupCard`、`SettingsBadge`、`SettingsRangeControl` 以及 `ThemeSelect`、`ThemePreviewCard` 组成。
// `value`/`isActive` 等全部来自调用方 props，本模块只渲染并回调 `onValueChange`/`onChange`。
// 阅读顺序：内容列常量 → 主题选择 → 预览卡 → 行 → 分组卡 → 徽标 → 滑块 → 标签查找。
import type { CSSProperties, ReactNode } from "react";
import type { BundledTheme } from "shiki";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { CODE_PREVIEW_THEME_OPTIONS, SETTINGS_PREVIEW_CODE } from "@/lib/codePreviewPreferences.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";

/**
 * Settings 与同级管理页在窗口框架内共享同一内容列。
 * Automations 曾在 shell 与页面内各自居中、加 padding，导致它与 Skills 等
 * Settings 功能的标题起点、顶部基线和内容宽度不一致。
 */
// `SETTINGS_FRAME_CONTENT_CLASSNAME` 的 `max-w-4xl` 与 `mx-auto` 让设置页和同级管理页共用同一内容列。
// 两处共用该常量后，标题起点与顶部基线由同一份 padding 决定。
//
export const SETTINGS_FRAME_CONTENT_CLASSNAME =
  "mx-auto w-full max-w-4xl px-4 pb-8 pt-0 lg:px-8 lg:pb-10";

// `ThemeSelect` 的选项来自 `CODE_PREVIEW_THEME_OPTIONS`，不能自由输入主题。
// `onValueChange` 收到字符串后转成 `BundledTheme` 再回传。
// 触发按钮固定宽度，选项过多时也不撑破布局。
//
export function ThemeSelect({
  value,
  onValueChange,
}: {
  value: BundledTheme;
  onValueChange: (value: BundledTheme) => void;
}) {
  return (
    <Select value={value} onValueChange={(nextValue) => onValueChange(nextValue as BundledTheme)}>
      <SelectTrigger size="lg" className="w-64 min-w-0 justify-between">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CODE_PREVIEW_THEME_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// `ThemePreviewCard` 用 `previewThemeStyle` 固定 `--color-background` 与 `--color-card`，不继承应用主题。
// `isActive` 只切换角标类名 `bg-selected`，`CodeBlock` 的 `theme` 不受影响。
//
export function ThemePreviewCard({
  mode,
  title,
  themeName,
  theme,
  isActive,
  showLineNumbers,
  wrapLongLines,
  fontSizePx,
}: {
  mode: "light" | "dark";
  title: string;
  themeName: string;
  theme: BundledTheme;
  isActive: boolean;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}) {
  const { intl } = useZCodeIntl();
  const previewSurfaceClassName = mode === "light" ? "ring-1 ring-black/5" : "ring-1 ring-white/8";
  // 预览主题变量在卡片内固定，隔离外部主题。
  // `--color-background` 与 `--color-card` 取同一个十六进制值，否则 `CodeBlock` 会出现色差。
  //
  const previewThemeStyle = {
    "--color-background": mode === "light" ? "#f8f8f8" : "#161616",
    "--color-card": mode === "light" ? "#f8f8f8" : "#161616",
    "--color-foreground": mode === "light" ? "#0d0d0d" : "#ffffff",
  } as CSSProperties;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-ui-base font-semibold text-foreground">{title}</div>
          <div className="text-ui-base text-foreground-subtle">{themeName}</div>
        </div>
        <span
          className={`rounded-md px-2.5 py-1 text-ui-xs font-medium ${
            isActive ? "bg-selected text-foreground" : "bg-surface text-foreground-subtle"
          }`}
        >
          {intl.formatMessage({
            id: isActive ? "settings.previewBadge.active" : `settings.previewBadge.${mode}`,
          })}
        </span>
      </div>
      <div className="p-2">
        <CodeBlock
          code={SETTINGS_PREVIEW_CODE}
          language="typescript"
          theme={theme}
          showLineNumbers={showLineNumbers}
          wrapLongLines={wrapLongLines}
          fontSizePx={fontSizePx}
          // Light/Dark Preview 是预览目标主题，不应继承当前应用主题的 background token。
          // CodeBlock 内部会把 @pierre/diffs 背景映射到 card，这里同时固定 background/card。
          className={`overflow-hidden border-0 bg-background ${previewSurfaceClassName}`}
          style={previewThemeStyle}
        />
      </div>
    </div>
  );
}

// 行布局用网格固定标签与控件两列。
// `controlLayout` 为 wide 时 `detail` 移到控件旁一行，避免 `SettingsRow` 两列挤压。
//
export function SettingsRow({
  label,
  description,
  control,
  detail,
  controlLayout = "default",
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  controlLayout?: "default" | "wide";
}) {
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div
        className={cn(
          "grid items-center gap-4",
          controlLayout === "wide"
            ? "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]"
            : "grid-cols-[minmax(0,1fr)_192px]",
        )}
      >
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">{label}</div>
          {description ? (
            <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</div>
          ) : null}
        </div>
        <div className="flex w-full flex-nowrap items-center justify-end gap-2">
          {controlLayout === "wide" ? detail : null}
          {control}
        </div>
      </div>
      {detail && controlLayout !== "wide" ? <div className="mt-3">{detail}</div> : null}
    </div>
  );
}

// `SettingsGroupCard` 的 `Card` 带 `py-0` 与 `CardContent` 的 `px-0` 由本组件固定，分隔交给 `SettingsRow` 的上边框。
// `SettingsRow` 的 `first:border-t-0` 让分组卡首行不出上边框。
//
export function SettingsGroupCard({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">{children}</CardContent>
    </Card>
  );
}

// `SettingsBadge` 只是 `span` 样式，不带 onClick 也不接受交互 props。
// `SettingsBadge` 用 `text-ui-base`，与 `SettingsRow` 的正文同字号。
//
export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle">
      {children}
    </span>
  );
}

// `SettingsRangeControl` 用原生 `input type=range`，键盘可达性由浏览器提供。
// `onChange` 里 `Number(event.currentTarget.value)` 直接回传，`SettingsRangeControl` 不存本地副本。
//
export function SettingsRangeControl({
  value,
  min,
  max,
  step,
  onChange,
  valueLabel,
  valueLabelClassName,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  valueLabel: ReactNode;
  valueLabelClassName?: string;
}) {
  return (
    <div className="flex w-[280px] min-w-0 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
      <span
        className={cn(
          "min-w-10 text-right text-ui-base font-medium tabular-nums text-foreground",
          valueLabelClassName,
        )}
      >
        {valueLabel}
      </span>
    </div>
  );
}

// 标签查找失败时回退到原始值。
// `getThemeOptionLabel` 只对 `CODE_PREVIEW_THEME_OPTIONS` 做一次 `find`，找不到回退 `value`。
//
export function getThemeOptionLabel(value: BundledTheme): string {
  return CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
