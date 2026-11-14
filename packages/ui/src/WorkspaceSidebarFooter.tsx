// WorkspaceSidebarFooter.tsx —— 侧边栏底部账户区：头像菜单、语言/主题/界面模式、缩放与设置入口。
//
// 职责边界
//   做什么：渲染用户身份、偏好子菜单、桌面缩放项、用量摘要与登录登出入口。
//   不做什么：主题与语言由 useZCodeStore 持有、缩放由 usePlatform 执行，本组件只上抛事件。
//   依赖谁：usePlatform 的平台能力、useZCodeStore 的界面模式、用量摘要 hook 与图标组件。
//   被谁调用：桌面与 Web 侧边栏，以及设置页复用同一 footer。
//   边界：组件只读状态并上抛事件，账户事实由上层与服务层持有。
//
//
// INV-01 footer 只做展示与转发，不拥有账户状态：不要在这里缓存 user —— 守住它的位置：全部 props 读取点 —— 改错故障：登出后头像仍显示旧用户
// INV-02 头像 key 必须随 avatarUrl 或 id 变化：缺 key 会复用旧图像 —— 守住它的位置：avatarKey 计算 —— 改错故障：切换账号后头像停在上一张
// INV-03 未登录且正在恢复会话时必须显示 loading：不能直接画未登录头像 —— 守住它的位置：showAuthRestoreLoading —— 改错故障：启动瞬间被误判为已登出
// INV-04 菜单内容必须保持挂载：forceMount 不能删 —— 守住它的位置：DropdownMenuContent —— 改错故障：每次点开头像都重建 footer 内部状态
// INV-05 缩放级别只能来自平台查询与订阅：不要在本地推导 —— 守住它的位置：getDesktopZoomLevel 与 onDesktopZoomLevelChanged —— 改错故障：界面被外部快捷键缩放后菜单按钮状态失真
// INV-06 effect 清理必须同时取消请求与解绑监听 —— 守住它的位置：缩放订阅 effect 的返回函数 —— 改错故障：窗口重开后旧监听仍在写已卸载组件的 state
// INV-07 非桌面环境必须把缩放级别归零 —— 守住它的位置：isDesktop 为假的分支 —— 改错故障：切到 Web 后缩放项仍显示可用的旧值
// INV-08 缩放命令只能通过平台抽象下发 —— 守住它的位置：runDesktopZoomCommand —— 改错故障：Web 构建里出现桌面专用调用
// INV-09 设置按钮与用量入口共用同一回调兜底 —— 守住它的位置：usageButtonClick —— 改错故障：未传用量回调时点击无反应
// INV-10 复制用户 id 失败必须有可见反馈 —— 守住它的位置：copyUserId 的 catch —— 改错故障：剪贴板被拒后界面毫无提示
// INV-11 用户名截断只能发生在文本列：触发按钮要允许收缩 —— 守住它的位置：触发按钮与文本容器的 class —— 改错故障：超长用户名把 footer 撑出侧边栏
// INV-12 语言、主题、界面模式必须是受控值：值来自上层 —— 守住它的位置：三个 RadioGroup 的 value —— 改错故障：选择后界面不回写，菜单停在旧选项
// INV-13 菜单分组顺序固定为语言、主题、界面模式、缩放、用量、登录登出 —— 守住它的位置：DropdownMenuContent 子节点顺序 —— 改错故障：出现重复的缩放入口或顺序回退
// INV-14 远程控制入口只在桌面且存在工作区时渲染 —— 守住它的位置：isDesktop 与 workspacePath 判断 —— 改错故障：Web 上出现点击无效的入口
// INV-15 footer 不自带页面边距：间距由调用方 className 决定 —— 守住它的位置：footer 的 cn 调用 —— 改错故障：设置页复用后出现双重内边距
// INV-16 memo 包裹的组件要求 props 引用稳定 —— 守住它的位置：组件导出处的 memo —— 改错故障：父级每次 render 都重建整个菜单树
// INV-17 退出登录的分隔符与菜单项必须同条件渲染 —— 守住它的位置：onLogout 的两处判断 —— 改错故障：菜单底部出现孤立分隔线
// INV-18 所有用户可见文案走 i18n：包括 aria-label 与 tooltip —— 守住它的位置：formatMessage 调用点 —— 改错故障：切换语言后部分菜单仍是旧语言
//
// 维护提示
//   这是被设置页复用的共享 footer，任何新增入口都要考虑两处布局。
//   平台差异只能通过 IPlatformService 表达，不要用 isDesktop 直接调桌面 API。
//   账户相关改动要同时检查未登录、恢复中、已登录三种状态。
//   菜单结构发生变化时，先确认分组顺序不变，再考虑视觉微调。
//   用量摘要的状态来自独立 hook，footer 只负责传引用，不要复制计算结果。
//   注释块位置与密度基线由 DEEP-SPEC 统一维护，改动时不要打乱既有块顺序。
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* oxlint-disable eslint(max-lines) -- footer 聚合账户、主题、模式和快捷键菜单。 */
import type { Locale, UserInfo } from "@zcode/shared";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import {
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared/test-ids";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Badge } from "@/components/ui/badge.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Copy,
  PencilRuler,
  Globe,
  Gift,
  Loader2,
  LogInIcon,
  LogOut,
  Maximize,
  Palette,
  Settings,
  User,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOpenRewards } from "@/rewards/RewardsProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceWebRemoteControlTrigger } from "@/WorkspaceWebRemoteControlTrigger.js";
import {
  WorkspaceSidebarFooterPlanBadge,
  WorkspaceSidebarFooterUsageSummaryContent,
  useWorkspaceSidebarFooterUsageSummaryState,
} from "@/WorkspaceSidebarFooterUsageSummary.js";

// DESKTOP_ZOOM_MIN_LEVEL = -3 与 DESKTOP_ZOOM_MAX_LEVEL = 5 只决定菜单项是否禁用：真正的缩放边界由桌面主进程校验，组件内越界判断只影响 canZoomIn/canZoomOut 的 disabled 状态。
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

// [契约] 展示名优先于用户名，两者都为空才用固定占位。
// 顺序不能反：用户名是登录标识，通常不适合作为主展示。
// trim 后的空串按缺失处理，
// 避免出现只显示空白的头像区。
function getSidebarProfileName(user?: UserInfo | null): string {
  const displayName = user?.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const username = user?.username?.trim();
  if (username) {
    return username;
  }

  return "ZCode";
}

// [契约] 有用户对象就展示名称，没有才取未登录文案。
// 不要用 isRestoringOAuthSession 影响徽标，
// 恢复中状态由头像区域的 loading 单独表达。
function getSidebarProfileBadge(
  user: UserInfo | null | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  if (user) {
    return getSidebarProfileName(user);
  }

  return formatMessage({ id: "sidebar.profile.notLoggedIn" });
}

// [契约] 兜底首字母来自展示名、用户名，最后是固定的 Z。
// 取首字符后统一大写，
// emoji 或非拉丁字符会原样返回，不需要额外处理。
function getAvatarFallbackText(user: UserInfo | null | undefined): string {
  const source = user?.displayName?.trim() || user?.username?.trim() || "Z";
  return source[0]?.toUpperCase() ?? "Z";
}

// [契约] 整个 footer 用 memo 包裹。
// 父级常因流式状态更新而重渲，
// 但账户与偏好 props 本身不变，
// 不 memo 会连带重建整套下拉菜单，
// 打开状态与动画都会被重置。
export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  onUsageClick,
  onUpgradeClick,
  onLogin,
  onLogout,
  settingsButtonMode = "settings",
  user,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  isDesktop = false,
  banner,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  onUsageClick?: () => void;
  onUpgradeClick?: Parameters<
    typeof WorkspaceSidebarFooterUsageSummaryContent
  >[0]["onUpgradeClick"];
  onLogin?: () => void;
  onLogout?: () => void;
  settingsButtonMode?: "settings" | "back";
  user?: UserInfo | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  banner?: ReactNode;
  className?: string;
}) {
  // [契约] 文案格式化统一取自同一个 intl 实例。
  // 不要在菜单内部再取一次，
  // 否则两处语言切换时机可能不同。
  const { intl } = useZCodeIntl();
  // [契约] 平台能力只能通过注入的实例获取。
  // 组件内不得直接访问桌面全局对象，
  // Web 构建里那部分能力并不存在。
  const platform = usePlatform();
  const openRewards = useOpenRewards();
  // [契约] 界面模式用选择器订阅，只取单个字段。
  // 不要订阅整个 store，否则任何无关状态变化都会重渲 footer。
  // 对应的 setter 必须从同一个 store 取，
  // 保证读写落在同一份状态上。
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  // [契约] 恢复中标志来自全局会话状态。
  // 它决定头像区是否显示 loading，
  // 不能在组件内用本地 state 模拟，
  // 否则刷新后会出现一次错误的未登录闪动。
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  // profileBadge 在 WorkspaceSidebarFooter 内用 getSidebarProfileBadge(user, intl.formatMessage) 算一次，同时供 DropdownMenuTrigger 的 aria-label 与菜单头部使用：两处各算一次会在语言切换时出现不同步。
  const profileBadge = getSidebarProfileBadge(user, intl.formatMessage);
  const avatarFallbackText = getAvatarFallbackText(user);
  // avatarKey 按 user?.avatarUrl ?? user?.id ?? "guest" 取值并作为 Avatar 的 key：key 变化才会重建 Avatar、丢弃上一张图片缓存；固定字符串会让切换账号后仍显示旧头像。
  const avatarKey = user?.avatarUrl ?? user?.id ?? "guest";
  // showAuthRestoreLoading 取 !user && isRestoringOAuthSession：user 存在时即使 isRestoringOAuthSession 残留为 true 也不能盖住头像，这个与条件是启动阶段未登录闪动的唯一开关。
  const showAuthRestoreLoading = !user && isRestoringOAuthSession;
  // [契约] 用量摘要状态由独立 hook 维护。
  // footer 只传工作区身份与路径，不复制其内部数据。
  // enabled 恒为真，
  // 菜单关闭时也要保持数据新鲜。
  const usageSummaryState = useWorkspaceSidebarFooterUsageSummaryState({
    enabled: true,
    workspaceIdentity,
    workspacePath,
  });
  // copyUserId 在 !user?.id 时直接 return；写入成功弹 sidebar.profile.userIdCopied，navigator.clipboard.writeText 抛错弹 sidebar.profile.userIdCopyFailed——剪贴板权限被拒时静默会使用户以为已复制。
  const copyUserId = async () => {
    if (!user?.id) return;
    try {
      await navigator.clipboard.writeText(user.id);
      toast(intl.formatMessage({ id: "sidebar.profile.userIdCopied" }));
    } catch {
      toast(intl.formatMessage({ id: "sidebar.profile.userIdCopyFailed" }));
    }
  };
  // [资源] profileContent 把 Avatar 与用户名称组合成一块只读内容，供触发按钮与菜单头部共用。
  // 触发按钮与菜单头部结构相同但样式不同，
  // 不要为了复用强行合并两个分支的 class。
  // 这块内容只读 props，不持有任何交互状态。
  const profileContent = (
    <>
      <Avatar key={avatarKey} size="default">
        {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={profileBadge} /> : null}
        <AvatarFallback className="bg-background text-foreground">
          {user ? (
            avatarFallbackText
          ) : showAuthRestoreLoading ? (
            <>
              {/* Bugfix: OAuth 启动恢复未落定前，footer 之前会直接显示未登录头像，
                  用户很容易把“还在校验”误判成“已经退出”。
                  这里用 loading 图标明确表达“状态确认中”，等恢复成功或失败后再展示最终状态。 */}
              <Loader2 className="size-4 animate-spin" />
              <span className="sr-only">{intl.formatMessage({ id: "common.loading" })}</span>
            </>
          ) : (
            <User className="size-4" />
          )}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 overflow-hidden text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {profileBadge}
          </span>
        </div>
      </div>
    </>
  );
  // [契约] 设置按钮在返回模式下用返回文案。
  // 两种模式的图标相同，只有标题不同，
  // aria-label 必须跟随同一个值。
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });
  // [契约] 未提供用量回调时回落到设置入口。
  // 这样独立复用的侧边栏也不会出现点击无反应。
  // 两个回调都为空的场景由按钮自身的 disabled 兜住。
  const usageButtonClick = onUsageClick ?? onSettingsButtonClick;
  // [契约] 菜单开关是受控的本地状态。
  // 放在 footer 内是为了让触发按钮与菜单同源，
  // 不要提升到上层，
  // 否则多个 footer 实例会共享同一个开关。
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // desktopZoomLevel 初值 0 表示实际大小：非桌面环境下 isDesktop 为 false 时 effect 会把它归零，canZoomIn/canZoomOut/canResetDesktopZoom 因此全部按边界禁用。
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  // runDesktopZoomCommand 只调 platform.executeDesktopCommand(command)，不先改 desktopZoomLevel：真实级别由 onDesktopZoomLevelChanged 回写，本地预判连续点击会越过 DESKTOP_ZOOM_MIN_LEVEL/MAX_LEVEL。
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    // isDesktop 为 false 时 effect 先 setDesktopZoomLevel(0) 再 return，不订阅 onDesktopZoomLevelChanged：同一 WorkspaceSidebarFooter 实例可能因环境切换复用，残留旧级别会让三个缩放菜单项状态错误。
    if (!isDesktop) {
      // 非桌面分支的 setDesktopZoomLevel(0) 只改本地展示值，不调 platform.executeDesktopCommand：Web 构建下平台侧没有缩放能力，下发 ResetZoom 只会得到无效调用。
      setDesktopZoomLevel(0);
      return;
    }

    // getDesktopZoomLevel?.() 的回调用局部 isCancelled 拦截：首次查询可能在组件卸载后才 resolve，标志在 cleanup 里置 true，只覆盖这一次查询，订阅回调由 dispose 单独解绑。
    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    // [资源] 订阅返回的释放函数必须保存并在清理时调用。
    // 订阅回调也要校验数值有效性，
    // NaN 会让边界比较全部为假，三个缩放项同时禁用。
    // platform.onDesktopZoomLevelChanged 可能不存在，所以 dispose 声明为可选返回值。
    // 调用处写 dispose?.() 而不是 dispose()，缺失时不会抛 TypeError。
    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    // [资源] 清理函数先写 isCancelled = true 再调 dispose?.()，顺序反了会漏掉已排队的回调。
    // 顺序不能反：
    // 先解绑再置标志，仍可能有已排队的回调在这两步之间写入状态。
    // 标志是实例级闭包变量，
    // 每次 effect 重新执行都会得到新的一份。
    // return 的清理函数保持同步，不 await dispose，否则 React 会在等待期间继续渲染。
    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  // canResetDesktopZoom 用 desktopZoomLevel !== 0 而不是 > 0：缩放级别可以是 -3 这类负值；重置只调 runDesktopZoomCommand("ResetZoom")，不在这里预先写 0。
  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  // canZoomOut 用 desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL：-3 本身是允许的最低档，用 >= 会在到达下限时提前禁用缩小项。
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;

  return (
    // footer 被 Settings 复用，页面专属边距由调用方传入，避免修改共享默认样式。
    <footer className={cn("flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4", className)}>
      {banner}
      <div className="flex min-w-0 gap-2">
        <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
          <DropdownMenuTrigger asChild>
            {/* Bugfix: 头像和 Login 之前直接绑定到登录动作，导致用户无法从这里打开偏好设置。
              现在把这一块改成统一的设置菜单入口，登录/退出留在菜单项里，交互职责更清晰。 */}
            <Button
              type="button"
              variant="ghost"
              size={"lg"}
              className="min-w-0 flex-1 justify-start gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl border-0 pl-0"
              data-testid={TID_LOGIN_TRIGGER}
              aria-label={profileBadge}
            >
              {/* Bugfix: Button 默认 shrink-0 且带 whitespace-nowrap，超长用户名会把 footer 撑出 sidebar。
                这里让触发按钮和文本列都允许收缩，并只在用户名自身做单行截断。 */}
              {profileContent}
            </Button>
          </DropdownMenuTrigger>
          {/* Bugfix: 菜单内容保持挂载，避免每次点击头像菜单都重建 footer 内部状态。 */}
          <DropdownMenuContent
            align="start"
            className="w-max min-w-50 max-w-[calc(100vw-2rem)]"
            forceMount
          >
            {user ? (
              <>
                <div
                  data-testid="profile-menu-header"
                  className="flex max-w-80 items-center gap-2 px-2 py-1.5"
                >
                  <Avatar key={avatarKey} size="default">
                    {user.avatarUrl ? (
                      <AvatarImage src={user.avatarUrl} alt={profileBadge} />
                    ) : null}
                    <AvatarFallback className="bg-background text-foreground">
                      {avatarFallbackText}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        data-testid="profile-menu-name"
                        className="truncate text-ui-base font-medium"
                      >
                        {profileBadge}
                      </span>
                      <span
                        data-testid="profile-menu-plan"
                        className="flex shrink-0 [&>span]:border-border/50 [&>span]:bg-transparent [&>span]:font-normal"
                      >
                        <WorkspaceSidebarFooterPlanBadge state={usageSummaryState} />
                      </span>
                    </div>
                    {user.id ? (
                      <div className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle">
                        <span data-testid="profile-menu-id" className="min-w-0 truncate">
                          {intl.formatMessage({ id: "sidebar.profile.accountId" }, { id: user.id })}
                        </span>
                        <DropdownMenuItem
                          asChild
                          className="data-[highlighted]:bg-transparent data-[highlighted]:hover:bg-menu-hover data-[highlighted]:focus-visible:bg-menu-hover"
                          onSelect={(event) => {
                            event.preventDefault();
                            void copyUserId();
                          }}
                        >
                          <SidebarNativeTooltip>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              data-testid="copy-user-id"
                              className="min-h-0 p-0 text-foreground-subtle"
                              aria-label={intl.formatMessage({ id: "sidebar.profile.copyUserId" })}
                              title={intl.formatMessage({ id: "sidebar.profile.copyUserId" })}
                            >
                              <Copy className="size-3" />
                            </Button>
                          </SidebarNativeTooltip>
                        </DropdownMenuItem>
                      </div>
                    ) : null}
                  </div>
                </div>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="size-4" />
                {intl.formatMessage({ id: "settings.locale" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en-US">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.en-US",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zh-CN">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.zh-CN",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                {intl.formatMessage({ id: "settings.themeMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-dark">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-dark",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-light">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-light",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PencilRuler className="size-4" />
                {intl.formatMessage({ id: "settings.interfaceMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={interfaceMode}
                  onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
                >
                  <DropdownMenuRadioItem value="coding">
                    {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="office">
                    {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* 快捷键设置（a58fdef 一系）：缩放子菜单 label 读生效表，设置页改绑后即时跟随 */}
            {/* Bugfix: ecc6952 收口重复缩放子菜单时误留了语言之后的那份，导致菜单顺序变成
                语言→缩放→主题；账户菜单分组顺序固定为 语言→主题→界面模式→缩放→用量→登录/登出，
                这里把唯一一份（读生效表）挪回用量摘要之前。
                staging 的 1d3179cb83 独立做过同一处移动（位置一致、缺本注释与 JSX 缩进），
                合并时保留本版本，不要再补第二份缩放子菜单。 */}
            {isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-50">
                  <DropdownMenuItem
                    disabled={!canZoomIn}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                  >
                    <ZoomIn className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                    <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canZoomOut}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                  >
                    <ZoomOut className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                    <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canResetDesktopZoom}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                  >
                    <Maximize className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                    <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {/* Bugfix: 升级入口状态不再以菜单开关为生命周期边界。 */}
            <WorkspaceSidebarFooterUsageSummaryContent
              state={usageSummaryState}
              onUsageClick={usageButtonClick}
              onUpgradeClick={onUpgradeClick}
            />
            {user ? (
              <DropdownMenuItem onSelect={() => openRewards?.()} data-testid="rewards-menu-item">
                <Gift className="size-4" />
                {intl.formatMessage({ id: "rewards.menuTitle" })}
                <Badge
                  data-testid="rewards-reward-badge"
                  className="-ml-0.5 h-auto border-0 px-1.5 py-0.5 text-ui-sm leading-none bg-[var(--color-plugin-paid-plan-badge)] text-[var(--color-plugin-paid-plan-badge-foreground)]"
                >
                  {intl.formatMessage({ id: "rewards.menuBadge" })}
                </Badge>
              </DropdownMenuItem>
            ) : null}
            {onLogin && !user ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogin} data-testid={TID_LOGIN_MENU_ITEM}>
                  <LogInIcon className="size-4" />
                  {intl.formatMessage({ id: "app.login" })}
                </DropdownMenuItem>
              </>
            ) : null}
            {onLogout ? <DropdownMenuSeparator /> : null}
            {onLogout ? (
              <DropdownMenuItem onSelect={onLogout} data-testid={TID_LOGOUT_BUTTON}>
                <LogOut className="size-4" />
                {intl.formatMessage({ id: "app.logout" })}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-1.5">
          {isDesktop && workspacePath ? (
            <WorkspaceWebRemoteControlTrigger
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              remoteSessionId={workspaceRemoteSessionId}
              initialTaskId={activeTaskId ?? undefined}
              compact
            />
          ) : null}
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </footer>
  );
});
