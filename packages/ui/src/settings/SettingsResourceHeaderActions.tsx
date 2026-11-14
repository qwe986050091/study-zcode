// INV-01 导入导出归入更多菜单：守住位置 hasOverflowActions；改错故障 顶栏按钮过多挤压标题。
// INV-02 无导入导出不渲染菜单：守住位置 条件渲染；改错故障 出现空菜单按钮。
// INV-03 刷新按钮可选：守住位置 onRefresh 判断；改错故障 不支持刷新页面出现无效按钮。
// INV-04 刷新中展示加载图标：守住位置 refreshing 三元；改错故障 刷新中图标不变。
// INV-05 刷新中禁用按钮：守住位置 disabled 组合；改错故障 刷新中重复触发请求。
// INV-06 新建按钮可选：守住位置 onNew 判断；改错故障 无新建能力页面出现按钮。
// INV-07 新建禁用独立传入：守住位置 newDisabled；改错故障 权限不足仍可点击。
// INV-08 标签可被外部覆盖：守住位置 两个可选标签属性；改错故障 业务文案无法定制。
// INV-09 标签缺省走国际化：守住位置 空值合并；改错故障 按钮出现空文本。
// INV-10 图标对读屏隐藏：守住位置 aria-hidden；改错故障 读屏重复朗读图形名。
// INV-11 按钮有可访问名称：守住位置 aria-label；改错故障 纯图标按钮无法识别。
// INV-12 测试 id 由调用方注入：守住位置 两个测试 id 属性；改错故障 端到端选择器漂移。
// INV-13 操作 id 由调用方注入：守住位置 三个 data 属性；改错故障 埋点无法区分入口。
// INV-14 菜单右对齐：守住位置 align 属性；改错故障 菜单超出视口被裁剪。
// INV-15 菜单触发只含图标：守住位置 MoreHorizontal；改错故障 顶栏宽度抖动。
// INV-16 操作项按条件渲染：守住位置 两个回调判断；改错故障 出现无回调的禁用项。
// INV-17 本组件不持有状态：守住位置 纯受控属性；改错故障 与设置页状态不同步。
// INV-18 本组件不发请求：守住位置 回调注入；改错故障 组件直接耦合数据层。
//
// SettingsResourceHeaderActions 的模块职责：设置页头部操作区由刷新、导入导出与新建三段入口组成。
// 状态所有权：无状态；刷新中与禁用态均由调用方传入。
// 阅读顺序：先看属性默认值，再读标签解析，最后看三段按钮渲染。
import {
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  SquareArrowRightEnter,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SettingsResourceHeaderActionsProps {
  onRefresh?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onNew?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  importDisabled?: boolean;
  exportDisabled?: boolean;
  newDisabled?: boolean;
  refreshTestId?: string;
  newTestId?: string;
  refreshLabel?: string;
  newLabel?: string;
  importActionId?: string;
  exportActionId?: string;
  newActionId?: string;
}

export function SettingsResourceHeaderActions({
  onRefresh,
  onImport,
  onExport,
  onNew,
  refreshing = false,
  refreshDisabled = false,
  importDisabled = false,
  exportDisabled = false,
  newDisabled = false,
  refreshTestId,
  newTestId,
  refreshLabel,
  newLabel: customNewLabel,
  importActionId,
  exportActionId,
  newActionId,
}: SettingsResourceHeaderActionsProps) {
  const { intl } = useZCodeIntl();
  // refreshLabel 等外部标签优先于 intl 默认值。
  // 导入导出标签固定取 settings.resourceActions 字典。
  // moreActionsLabel 供读屏使用，按钮本身只有图标。
  // newLabel 同样可被 customNewLabel 覆盖。
  // 所有标签在渲染前由 intl.formatMessage 解析。
  // 缺省值不回退硬编码文案，一律走 intl.formatMessage 字典。
  const resolvedRefreshLabel = refreshLabel ?? intl.formatMessage({ id: "common.refresh" });
  // importLabel 取自 settings.resourceActions.import。
  // exportLabel 与 importLabel 同组，共用资源操作字典。
  // importLabel 与 exportLabel 都不拼接动态参数，保持静态可缓存。
  // 每次渲染重新调用 intl.formatMessage 解析。
  // intl.formatMessage 的解析结果不缓存到模块级，避免语言切换后串文案。
  const importLabel = intl.formatMessage({
    id: "settings.resourceActions.import",
  });
  const exportLabel = intl.formatMessage({
    id: "settings.resourceActions.export",
  });
  const moreActionsLabel = intl.formatMessage({
    id: "settings.resourceActions.more",
  });
  // newLabel 优先用 customNewLabel 外部值。
  // 缺省取 settings.create.action 通用创建文案。
  // aria-label 与可见文本同源，读屏与视觉一致。
  // 该值每次渲染重算，不做额外 memo。
  // 空串视为有效覆盖，不会回退到字典。
  const newLabel = customNewLabel ?? intl.formatMessage({ id: "settings.create.action" });
  // onImport 或 onExport 任一存在即显示更多操作菜单。
  // 两个回调都缺省时 hasOverflowActions 为假，菜单隐藏。
  // 菜单承载 import/export 等次要操作。
  // refresh 与 new 两个主操作保留在顶栏。
  // hasOverflowActions 只影响渲染，不改变回调语义。
  const hasOverflowActions = Boolean(onImport || onExport);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasOverflowActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon-md" aria-label={moreActionsLabel}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onImport ? (
              <DropdownMenuItem
                data-settings-import-action={importActionId}
                disabled={importDisabled}
                onSelect={onImport}
              >
                <SquareArrowRightEnter aria-hidden="true" />
                {importLabel}
              </DropdownMenuItem>
            ) : null}
            {onExport ? (
              <DropdownMenuItem
                data-settings-export-action={exportActionId}
                disabled={exportDisabled}
                onSelect={onExport}
              >
                <Download aria-hidden="true" />
                {exportLabel}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {onRefresh ? (
        <ControlHintTooltip title={resolvedRefreshLabel}>
          <Button
            type="button"
            variant="outline"
            size="icon-md"
            aria-label={resolvedRefreshLabel}
            data-testid={refreshTestId}
            disabled={refreshDisabled || refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCcw aria-hidden="true" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onNew ? (
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-lg"
          data-settings-create-action={newActionId}
          aria-label={newLabel}
          data-testid={newTestId}
          disabled={newDisabled}
          onClick={onNew}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {newLabel}
        </Button>
      ) : null}
    </div>
  );
}
