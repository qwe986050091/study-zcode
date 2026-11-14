// INV-01 键即作用域：守住位置 getPluginWorkspaceKey；改错故障：同一工作区在不同入口算出不同键。
// INV-02 在线优先：守住位置 configOnline 分支；改错故障：已下发在线状态仍按本地可用性判断。
// INV-03 失效排除：守住位置 unavailable-local-directory；改错故障：已删除的本地目录仍可被选中。
// INV-04 远端要会话：守住位置 isRemote 与会话判断；改错故障：断开的远端项目出现在列表里。
// INV-05 本地必可用：守住位置 非远端直接放行；改错故障：本地失效目录被误判为可用。
// INV-06 选项可注入：守住位置 workspaceOptions；改错故障：调用方无法覆盖列表，只能吃默认过滤。
// INV-07 过滤只一处：守住位置 workspaceTabs 的筛选；改错故障：多处各自过滤，规则漂移。
// INV-08 用户作用域独立：守住位置 userLabel；改错故障：用户范围被设备名或账号名替换。
// INV-09 图标随机器：守住位置 UserIcon 与 WorkspaceIcon；改错故障：远端与本地图标颠倒。
// INV-10 选中态回显：守住位置 selectedWorkspace 查找；改错故障：当前作用域在触发器上看不到名字。
// INV-11 无用户项时不回退：守住位置 includeUser 分支；改错故障：隐藏用户项后仍显示用户标签。
// INV-12 分隔符跟随：守住位置 includeUser 与分隔线；改错故障：没有用户项却留下孤立分隔线。
// INV-13 空列表不渲染分组：守住位置 scopeWorkspaces 的长度；改错故障：只出现一个空分组标题。
// INV-14 测试钩子成对：守住位置 data-plugin-scope-key 与测试标识；改错故障：自动化测试取不到选项。
// INV-15 受控选择：守住位置 RadioGroup 的 value 与回调；改错故障：选择后触发器不更新。
// INV-16 参数默认值：守住位置 解构默认；改错故障：未传 align 时弹出方向漂移。
// INV-17 禁用透传：守住位置 disabled 到触发器；改错故障：禁用态仍能展开菜单。
// INV-18 文案全走 intl：守住位置 触发器与分组标题；改错故障：出现硬编码文案。
//
// 模块职责：插件作用域下拉菜单，选择用户范围或某个已连接工作区。
// 状态所有权：选中键由父级受控，工作区列表来自 props 或设置作用域的 tab 列表。
// 阅读顺序：键与可用性工具 → 组件签名 → 选项推导 → 触发器 → 下拉内容。
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useSettingsMachineLabel, useSettingsUserScope } from "@/settings/SettingsMachine.js";
import { ChevronDown, Cloud, Folder, Monitor } from "lucide-react";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

// getPluginWorkspaceKey 由 workspacePath 与 workspaceIdentity 共同决定作用域键。
// 本地 tab 的 workspaceIdentity 为空，远端带 remoteTarget 或 remoteSessionId。
// 同一 workspacePath 的所有入口必须算出同一个键，否则 Scope 会出现重复项。
export function getPluginWorkspaceKey(tab: ConfigWorkspaceTarget): string {
  return getWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
}

// configOnline 已下发时直接 return，不再按 availability 猜测。
// availability 为 unavailable-local-directory 时返回 false。
// 远端 tab 必须带 remoteSessionId，否则 isPluginScopeWorkspaceConnected 返回 false。
// 没有远端特征的 tab 视为本地可用。
export function isPluginScopeWorkspaceConnected(tab: ConfigWorkspaceTarget): boolean {
  // Bug 根因：持久化 tab 会保留已经断开的远端项目和已失效的本地目录；Scope 若继续展示，
  // 用户会选中一个没有可用 service target 的项目。远端必须有当前 session，本地必须仍可用。
  if (tab.configOnline !== undefined) return tab.configOnline;
  if (tab.availability === "unavailable-local-directory") {
    return false;
  }
  const isRemote = Boolean(
    tab.workspaceIdentity?.trim() || tab.remoteTarget || tab.remoteSessionId,
  );
  if (!isRemote) {
    return true;
  }
  return Boolean(tab.remoteSessionId);
}

// 所有可选参数都有默认值，调用方按需覆盖。
// selectedScopeKey 受控，组件不维护选中态。
// workspaceOptions 优先于自动过滤结果。
// userTarget 与 userSourceServerId 用于计算用户范围的机器标签。
// onScopeKeyChange 只把 scopeKey 交给调用方，语义由调用方解释。
export function PluginScopeMenu({
  align = "start",
  disabled = false,
  includeUser = true,
  selectedScopeKey,
  triggerIconTestId,
  triggerTestId,
  userOptionTestId,
  workspaceOptionTestIdPrefix,
  workspaceOptions,
  userTarget,
  userSourceServerId,
  workspaceTabs = [],
  onScopeKeyChange,
}: {
  align?: "start" | "center" | "end";
  disabled?: boolean;
  includeUser?: boolean;
  selectedScopeKey: string;
  triggerIconTestId?: string;
  triggerTestId?: string;
  userOptionTestId?: string;
  workspaceOptionTestIdPrefix?: string;
  workspaceOptions?: Array<{ key: string; label: string; remote?: boolean }>;
  workspaceTabs?: ConfigWorkspaceTarget[];
  userTarget?: Partial<WorkspaceTabState> | null;
  userSourceServerId?: string | null;
  onScopeKeyChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const machineLabel = useSettingsMachineLabel();
  const inheritedUserScope = useSettingsUserScope();
  const userMachine = machineLabel(
    userTarget ?? inheritedUserScope.target,
    userSourceServerId ?? inheritedUserScope.sourceServerId,
  );
  const UserIcon = userMachine.remote ? Cloud : Monitor;
  // 显式传入的选项直接采用，不再过滤。
  // 否则从工作区 tab 里筛出仍可用者。
  // label 用 settings.machine.scope 拼上 machineLabel，区分同名工作区。
  // 远端标记来自机器标签，供图标与文案复用。
  const scopeWorkspaces =
    workspaceOptions ??
    workspaceTabs.filter(isPluginScopeWorkspaceConnected).map((tab) => ({
      key: getPluginWorkspaceKey(tab),
      label: intl.formatMessage(
        { id: "settings.machine.scope" },
        { scope: tab.label, machine: machineLabel(tab).label },
      ),
      remote: machineLabel(tab).remote,
    }));
  // selectedWorkspace 由 selectedScopeKey 反查，供触发器回显图标与文案。
  // 已断开的 tab 不在 scopeWorkspaces 里，find 可能返回 undefined。
  // 未命中时 SelectedWorkspaceIcon 退回 Folder，避免空触发器。
  const selectedWorkspace = scopeWorkspaces.find((workspace) => workspace.key === selectedScopeKey);
  const SelectedWorkspaceIcon = selectedWorkspace?.remote ? Cloud : Folder;
  // 用户作用域是本机配置范围，不能使用登录账号或设备用户名代替其语义。
  const userLabel = intl.formatMessage(
    { id: "settings.machine.scope" },
    { scope: intl.formatMessage({ id: "settings.plugin.scope.user" }), machine: userMachine.label },
  );

  // DropdownMenuTrigger 包住整颗 Button，点击即展开菜单。
  // 作用域键与选中项同时写进 data 属性，便于测试定位。
  // 图标随选中项在云与文件夹之间切换。
  // 标题单行截断，长工作区名不撑破按钮。
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="default"
          data-testid={triggerTestId}
          data-plugin-scope-trigger="true"
          data-plugin-scope-key={selectedScopeKey}
          className="rounded-full"
        >
          {selectedWorkspace || !includeUser ? (
            <SelectedWorkspaceIcon
              className="size-4"
              aria-hidden="true"
              data-testid={triggerIconTestId}
            />
          ) : (
            <UserIcon className="size-4" aria-hidden="true" data-testid={triggerIconTestId} />
          )}
          <span className="max-w-48 truncate">{selectedWorkspace?.label ?? userLabel}</span>
          <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={selectedScopeKey} onValueChange={onScopeKeyChange}>
          {includeUser ? (
            <DropdownMenuRadioItem
              value="user"
              data-testid={userOptionTestId}
              data-plugin-scope-key="user"
            >
              <UserIcon className="size-4" aria-hidden="true" />
              <span className="truncate text-ui-base font-medium text-foreground">{userLabel}</span>
            </DropdownMenuRadioItem>
          ) : null}
          {scopeWorkspaces.length > 0 ? (
            <>
              {includeUser ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>
                {intl.formatMessage({
                  id: "settings.plugin.scope.workspaces",
                })}
              </DropdownMenuLabel>
              {scopeWorkspaces.map((workspace) => {
                const WorkspaceIcon = workspace.remote ? Cloud : Folder;
                return (
                  <DropdownMenuRadioItem
                    key={workspace.key}
                    value={workspace.key}
                    data-plugin-scope-key={workspace.key}
                    data-testid={
                      workspaceOptionTestIdPrefix
                        ? testId(workspaceOptionTestIdPrefix, workspace.key)
                        : undefined
                    }
                    className="items-start py-2"
                  >
                    <WorkspaceIcon className="mt-0.5 size-4" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
