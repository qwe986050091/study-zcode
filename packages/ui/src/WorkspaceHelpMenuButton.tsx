// INV-01 是否桌面端由挂载处注入而不是运行时嗅探：守住位置 桌面标记入参；改错故障 Web 端出现点了没反应的菜单项。
// INV-02 帮助按钮必须带无障碍名称与悬停提示：守住位置 无障碍标签与提示组件；改错故障 图标按钮无含义。
// INV-03 触发器必须标记为不可拖拽区域：守住位置 拖拽类名；改错故障 标题栏拖拽吞掉点击。
// INV-04 触发器携带固定测试标识：守住位置 数据属性；改错故障 自动化无法定位。
// INV-05 下拉菜单宽度由内容决定：守住位置 内容类名；改错故障 长文案被截断。
// INV-06 菜单项右内边距为角标预留：守住位置 菜单项样式；改错故障 更新角标压住文字。
// INV-07 漏洞报告入口只在加载中或已取得地址时出现：守住位置 条件渲染；改错故障 空地址产生死链。
// INV-08 加载中时漏洞入口禁用并标记忙碌：守住位置 禁用与忙碌属性；改错故障 用户重复点击。
// INV-09 未取得地址时不挂载选择回调：守住位置 回调三元；改错故障 点击后无反应。
// INV-10 桌面专属分组与其余菜单项之间必须有分隔线：守住位置 分隔组件；改错故障 分组边界不清。
// INV-11 导出日志复用统一菜单动作：守住位置 动作引用；改错故障 打包与提示口径不一致。
// INV-12 资源管理器只在桌面端渲染：守住位置 桌面分支；改错故障 Web 端出现无效入口。
// INV-13 更新项只在可见时渲染：守住位置 可见标记；改错故障 常驻一个不可用项。
// INV-14 重启更新项展示版本角标：守住位置 标签判断；改错故障 新版本号不可见。
// INV-15 其他更新文案带版本参数：守住位置 格式化入参；改错故障 文案缺版本号。
// INV-16 关于项只在桌面端存在：守住位置 桌面分支；改错故障 Web 端出现关于对话框入口。
// INV-17 菜单开合状态由本地持有：守住位置 状态初始化；改错故障 父级重渲染重置菜单。
// INV-18 漏洞地址请求只在菜单打开时触发：守住位置 入参；改错故障 启动即发网络请求。
//
// 模块职责：渲染工作区标题栏的帮助菜单入口，并按平台暴露不同分组。
// 状态所有权：菜单开合与漏洞报告地址由本组件及其 hook 持有；反馈入口来自共享 store。
// 阅读顺序：先看动作处理器装配，再读触发器与菜单容器，最后看桌面分组。
import { useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import {
  TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
  TID_WORKSPACE_HELP_MENU_TRIGGER,
} from "@zcode/shared/test-ids";
import {
  ActivityIcon,
  BookOpenIcon,
  CircleHelpIcon,
  DownloadIcon,
  LightbulbIcon,
  InfoIcon,
  MessageSquareIcon,
  UsersIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useVulnerabilityReportUrl } from "@/hooks/useVulnerabilityReportUrl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "@/lib/helpMenuActions.js";

// 桌面标记由调用方决定，不在组件内嗅探平台能力。
// 菜单开合是本地状态。
// 漏洞报告地址由专用 hook 按打开状态拉取。
// 反馈入口直接取自共享反馈 store。
// `WorkspaceHelpMenuButton` 的菜单动作表只创建一次并复用，避免每帧新建闭包。
export function WorkspaceHelpMenuButton({
  className,
  isDesktop = false,
}: {
  className?: string;
  /**
   * 是否桌面端。由挂载处注入而不是在组件内嗅探：Web 的 IPlatformService 桩同样实现了
   * executeDesktopCommand（no-op），拿它判定会让 Web 端出现一个点了没反应的「资源管理器」。
   */
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const { url: vulnerabilityReportUrl, loading: vulnerabilityReportLoading } =
    useVulnerabilityReportUrl(open);
  const updateMenu = useDesktopUpdateMenu(isDesktop);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeatureRequest = useFeedbackStore((state) => state.openFeatureRequest);
  const helpMenuLabel = intl.formatMessage({ id: "workspaceHeader.help.menu" });
  // helpMenuActions 每次渲染由 createHelpMenuActionHandlers({ platform, intl, openSubmit: openFeedbackSubmit }) 新建：intl 负责文档/issue 文案，platform 提供 openExternal 等能力，openSubmit 只取 useFeedbackStore((state) => state.openSubmit) 这一个动作而不订阅整个 store，避免反馈面板其他字段变化导致帮助菜单重渲。
  const helpMenuActions = createHelpMenuActionHandlers({
    platform,
    intl,
    openSubmit: openFeedbackSubmit,
  });
  const handleOpenCommunity = () => {
    void platform.openCommunity();
  };
  const handleOpenResourceManager = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager);
  };

  const handleShowAbout = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout);
  };

  // 桌面专属分组以 DropdownMenuSeparator 开头：导出日志复用 helpMenuActions.exportLogs，资源管理器/关于分别走 executeDesktopCommand(DesktopCommandIds.OpenResourceManager/ShowAbout)，更新项由 useDesktopUpdateMenu(isDesktop).visible 控制；isDesktop=false 时整段不渲染，避免 Web 端出现点了没反应的入口。
  return (
    // DropdownMenu 受控：open={open} + onOpenChange={setOpen}，开合状态留在本组件，父级重渲染不会重置；触发器用 asChild 包进 ControlHintTooltip，side="bottom" 固定提示方向，Button 同时承担 aria-label={helpMenuLabel} 与 data-testid={TID_WORKSPACE_HELP_MENU_TRIGGER}，[app-region:no-drag] 防止标题栏拖拽区吞掉点击。
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ControlHintTooltip title={helpMenuLabel} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            // Settings 页会把帮助按钮绝对定位在 Electron 顶部拖拽区上方。
            // 只依赖外层容器 no-drag 时，真实 trigger 仍可能被标题栏 drag 区吞掉点击。
            className={cn(
              "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
              className,
            )}
            aria-label={helpMenuLabel}
            data-testid={TID_WORKSPACE_HELP_MENU_TRIGGER}
          >
            <CircleHelpIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        align="end"
        // 宽度用 min-w-0 w-max 跟随文案，[&_[data-slot=dropdown-menu-item]]:pr-6 给右侧更新角标预留空间；两条样式只作用于本菜单，不限制换行，分隔线由桌面分组自己插入 DropdownMenuSeparator。
        className="min-w-0 w-max [&_[data-slot=dropdown-menu-item]]:pr-6"
      >
        <DropdownMenuItem onSelect={helpMenuActions.openProductDocs}>
          <BookOpenIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.docs" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleOpenCommunity}>
          <UsersIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.community" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={helpMenuActions.openIssueReport}>
          <MessageSquareIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.issueReport" })}
        </DropdownMenuItem>
        {vulnerabilityReportLoading || vulnerabilityReportUrl ? (
          <DropdownMenuItem
            disabled={vulnerabilityReportLoading}
            aria-busy={vulnerabilityReportLoading}
            onSelect={
              vulnerabilityReportUrl
                ? () => platform.openExternal(vulnerabilityReportUrl)
                : undefined
            }
          >
            <ShieldAlertIcon className="size-4" />
            {intl.formatMessage({ id: "workspaceHeader.help.reportVulnerability" })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={openFeatureRequest}>
          <LightbulbIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.productRequest" })}
        </DropdownMenuItem>
        {/* Windows/Linux 没有原生菜单栏，自绘标题栏箭头菜单也已下线，
            资源管理器只能从这里进；Web 端没有该窗口，不渲染。 */}
        {isDesktop ? (
          <>
            <DropdownMenuSeparator />
            {/* 独立导出入口曾被移除；复用原菜单动作，保持打包、系统定位与提示一致。 */}
            <DropdownMenuItem onSelect={helpMenuActions.exportLogs}>
              <DownloadIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.exportLogs" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER}
              onSelect={handleOpenResourceManager}
            >
              <ActivityIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
            </DropdownMenuItem>
            {updateMenu.visible ? (
              <DropdownMenuItem
                disabled={updateMenu.disabled}
                onSelect={updateMenu.checkForUpdates}
              >
                <RefreshCwIcon className="size-4" />
                {updateMenu.labelId === "desktopMenu.help.restartToUpdate" ? (
                  <>
                    <span className="whitespace-nowrap">
                      {intl.formatMessage({ id: "desktopMenu.help.restartUpdateAction" })}
                    </span>
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 py-0 bg-success/10 text-success"
                    >
                      {updateMenu.labelValues?.version}
                    </Badge>
                  </>
                ) : (
                  intl.formatMessage({ id: updateMenu.labelId }, updateMenu.labelValues)
                )}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={handleShowAbout}>
              <InfoIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.about" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
