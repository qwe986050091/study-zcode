// INV-01 图标统一从一处再导出：守住位置 模块顶部；改错故障 各页面各自引用图标库。
// INV-02 返回入口只变色不改热区：守住位置 类名常量；改错故障 点击区域随 hover 收缩。
// INV-03 表单间距用 gap 不用 margin：守住位置 类名常量；改错故障 行盒让实际间距小于设计值。
// INV-04 空态高度固定：守住位置 容器类名；改错故障 定时与闲时两页高度不一致。
// INV-05 分段页签复用同一组件：守住位置 渲染；改错故障 详情页与列表页样式漂移。
// INV-06 页签值只两种：守住位置 联合类型；改错故障 出现第三种值导致空面板。
// INV-07 页签标签由调用方注入：守住位置 props；改错故障 组件内硬编码文案无法国际化。
// INV-08 保持唤醒用共享设置：守住位置 受控 props；改错故障 页面级 mock 与服务端不一致。
// INV-09 提示条带稳定标识：守住位置 属性；改错故障 端到端用例找不到提示条。
// INV-10 提示图标对读屏隐藏：守住位置 aria 属性；改错故障 读屏重复朗读装饰图标。
// INV-11 开关与提示共用文案：守住位置 aria 标签；改错故障 开关没有可读名称。
// INV-12 提示条垂直内边距回填：守住位置 类名；改错故障 桌面断点下高度不足。
// INV-13 创建入口分成两个按钮：守住位置 结构；改错故障 手动创建缺少独立入口。
// INV-14 手动按钮带测试标识：守住位置 data-testid；改错故障 用例只能按文案定位。
// INV-15 菜单按钮带可读名称：守住位置 aria-label；改错故障 图标按钮无名称。
// INV-16 下拉菜单贴边对齐：守住位置 对齐参数；改错故障 菜单溢出右侧被裁切。
// INV-17 菜单项按需回调：守住位置 onSelect；改错故障 菜单打开即触发创建。
// INV-18 组件不取全局状态：守住位置 入参；改错故障 同一组件在设置页外复用受限。
//
// 模块职责：自动化设置页共用的排版、空态与创建入口组件。
// 状态所有权：无业务状态；开关值与页签值都由调用方持有。
// 阅读顺序：先看类名常量，再看两个空态与页签，最后看提示条与创建入口。
import { TID_AUTOMATION_CREATE_MANUALLY, TID_AUTOMATION_CREATE_MENU } from "@zcode/shared/test-ids";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import {
  AutomationChevronDownIcon,
  AutomationInfoIcon,
} from "@/settings/AutomationIcons.js";
import { Button } from "@/components/ui/button.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

export {
  AutomationAddScheduleIcon,
  AutomationCancelActionIcon,
  AutomationChevronDownIcon,
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationEditActionIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationIcons.js";

/** 设置页返回入口仅高亮图标与文本，保留点击热区但不显示 hover/focus 背景。 */
export const AUTOMATION_BACK_TRIGGER_CLASSNAME =
  "-m-1 inline-flex w-fit max-w-full min-w-0 items-center gap-1 bg-transparent p-1 text-ui-base leading-5 text-foreground-subtle transition-colors hover:text-foreground active:text-foreground focus-visible:text-foreground focus-visible:outline-none";

// 修复原因：space-y 给行内 label 添加 margin 时会受字体行盒影响，实际视觉间距小于设计稿的 6px。
export const AUTOMATION_FORM_FIELD_CLASSNAME = "flex flex-col gap-1.5";

export type AutomationSettingsHistoryTab = "settings" | "history";

/** 定时与闲时共用运行历史空态，防止透明留白与卡片容器样式再次漂移。 */
// AutomationHistoryEmptyState 用 min-h-[226px] 与 dashed 边框锁住高度。
// children 是唯一文案入口，组件内不做国际化。
// 定时与闲时都渲染 AutomationHistoryEmptyState，样式只维护一处。
// AutomationHistoryEmptyState 只画容器，loading 由调用方决定。
// 空态尺寸写在 AutomationHistoryEmptyState 内，改版不用同步两个页面。
export function AutomationHistoryEmptyState({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[226px] items-center justify-center rounded-xl border border-dashed border-card-border bg-background px-4 text-center text-ui-base text-foreground-subtle">
      {children}
    </div>
  );
}

/** 定时与闲时设置页复用 Hooks scope tabs 的 pill 视觉，避免详情页分段样式漂移。 */
// AutomationSettingsHistoryTabs 的 value 由外部传入。
// items 只有 settings 与 history 两项，类型是 AutomationSettingsHistoryTab。
// settingsLabel 与 historyLabel 不在此处硬编码。
// onValueChange 只上报，状态仍归调用方。
// 渲染落到 SettingsSegmentedTabs，避免分段样式分叉。
export function AutomationSettingsHistoryTabs({
  value,
  settingsLabel,
  historyLabel,
  onValueChange,
}: {
  value: AutomationSettingsHistoryTab;
  settingsLabel: string;
  historyLabel: string;
  onValueChange: (value: AutomationSettingsHistoryTab) => void;
}) {
  return (
    <SettingsSegmentedTabs
      value={value}
      items={[
        { value: "settings", label: settingsLabel },
        { value: "history", label: historyLabel },
      ]}
      onValueChange={onValueChange}
    />
  );
}

/** Keep-awake 提示条；开关值由调用方接入全局共享设置，而非页面级 mock store。 */
// AutomationKeepAwakeNotice 的 checked 由调用方接入共享设置。
// AutomationInfoIcon 外层带 aria-hidden，读屏不重复朗读。
// 同一 formatMessage 结果同时给正文与 AutomationSwitchToggle 的 ariaLabel。
// className 的 py-3 把桌面断点丢掉的 12px 垂直内边距补回。
export function AutomationKeepAwakeNotice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // 桌面断点曾清空提示栏的垂直内边距，导致实际样式偏离 12px 规格。
  return (
    <div
      data-automations-keep-awake
      className="flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-[10px] bg-surface px-3 py-3 text-foreground-subtle"
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <AutomationInfoIcon className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-ui-base leading-5">
        {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
      </p>
      <AutomationSwitchToggle
        checked={checked}
        ariaLabel={intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        onChange={onChange}
        color="blue"
        size="sm"
      />
    </div>
  );
}

// AutomationCreateDropdown 主按钮绑定 onManually。
// DropdownMenuTrigger 只开菜单，不触发创建。
// DropdownMenuItem 的 onSelect 才调用 onViaChat。
// 主按钮与触发器放在同一 inline-flex 组内保持等高。
export function AutomationCreateDropdown({
  onViaChat,
  onManually,
}: {
  onViaChat: () => void;
  onManually: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-lg">
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-none border-0"
          data-testid={TID_AUTOMATION_CREATE_MANUALLY}
          onClick={onManually}
        >
          {intl.formatMessage({ id: "automations.createManually" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-md"
            data-testid={TID_AUTOMATION_CREATE_MENU}
            aria-label={intl.formatMessage({ id: "automations.create" })}
            className="!w-6 rounded-none border-0"
          >
            <AutomationChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-auto min-w-0"
      >
        <DropdownMenuItem className="pr-6" onSelect={onViaChat}>
          {intl.formatMessage({ id: "automations.createViaChat" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
