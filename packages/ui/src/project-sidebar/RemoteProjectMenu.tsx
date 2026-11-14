// INV-01 远程子菜单随回调可选：守住位置 onOpenRemoteWorkspace 三元；改错故障 无远程能力时仍显示空子菜单。
// INV-02 服务器列表来自快照：守住位置 snapshot 的可选链；改错故障 快照缺失时渲染报错。
// INV-03 每台设备独立解析展示态：守住位置 getRemoteDevicePresentationInput；改错故障 多设备共用一份状态。
// INV-04 连接中禁用点击：守住位置 status 等值判断；改错故障 重复点击发起重复连接。
// INV-05 有 profileId 优先按 profile 打开：守住位置 三元展开；改错故障 已配置线路被降级成按服务器打开。
// INV-06 新建连接不带偏好：守住位置 无参调用；改错故障 新建被旧选择污染。
// INV-07 图标与短消息同源：守住位置 presentation 的两处读取；改错故障 图标显示在线而文案显示失败。
// INV-08 列表为空不画分隔线：守住位置 servers.length 判定；改错故障 只有新建项时出现孤立分隔。
// INV-09 分隔线在设备之后、新建之前：守住位置 JSX 顺序；改错故障 新建项混进设备列表。
// INV-10 打开本地目录始终可用：守住位置 第一个菜单项无禁用；改错故障 远程异常拖累本地入口。
// INV-11 设备名截断不挤压右侧状态：守住位置 truncate 与 shrink-0；改错故障 长设备名把文案挤出容器。
// INV-12 触发器带测试标识：守住位置 data-testid；改错故障 自动化找不到新增入口。
// INV-13 文案全部走 intl：守住位置 四处 formatMessage；改错故障 短消息 id 直接显示在界面上。
//
// 模块职责：项目侧边栏的新增入口，提供本地打开、按设备打开远程项目与新建远程连接。
// 阅读顺序：先看触发器，再看本地入口，最后看远程子菜单的设备映射与新建项。
import { Cloud, FolderOpen, Plus } from "lucide-react";
import { type SourceServerManagementSnapshot } from "@zcode/shared";
import { TID_VIRTUAL_PROJECT_ADD } from "@zcode/shared/test-ids";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";

export function RemoteProjectMenu({
  snapshot,
  onOpenFolder,
  onOpenRemoteWorkspace,
}: {
  // 快照可空，未加载时只保留本地与新建入口。
  snapshot?: SourceServerManagementSnapshot | null;
  onOpenFolder: () => void;
  // onOpenRemoteWorkspace 可选，远程入口是否存在由调用方决定。
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    // DropdownMenu 由单一菜单根承载，触发器与内容同源。
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // 测试标识挂在触发器上，便于端到端定位。
          data-testid={TID_VIRTUAL_PROJECT_ADD}
          className="text-foreground-subtle hover:text-foreground data-[state=open]:text-foreground"
          aria-label={intl.formatMessage({ id: "workspaceSidebar.addProject" })}
        >
          <Plus className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onOpenFolder}>
          <FolderOpen className="size-4" />
          {intl.formatMessage({ id: "workspace.openFolder" })}
        </DropdownMenuItem>
        {onOpenRemoteWorkspace ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Cloud className="size-4" />
              {intl.formatMessage({ id: "workspaceSidebar.openRemoteProject" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64 max-w-[calc(100vw-24px)]">
              {snapshot?.servers.map((server) => {
                const presentation = resolveRemoteConnectionPresentation(
                  // 展示输入按设备聚合，避免跨设备串状态。
                  getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
                );
                return (
                  <DropdownMenuItem
                    key={server.sourceServerId}
                    data-remote-project-device={server.sourceServerId}
                    // 连接中的设备不可再次点击。
                    disabled={presentation.status === "connecting"}
                    onSelect={() =>
                      onOpenRemoteWorkspace(
                        // 已绑定线路时按 profile 打开。
                        presentation.profileId
                          ? { preferredProfileId: presentation.profileId }
                          // 未绑定线路时退回按来源服务器打开。
                          : { preferredSourceServerId: server.sourceServerId },
                      )
                    }
                  >
                    <RemoteConnectionStateIcon presentation={presentation} project />
                    <span className="min-w-0 flex-1 truncate">{server.displayName}</span>
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: presentation.shortMessageId })}
                    </span>
                  </DropdownMenuItem>
                );
              })}
              {snapshot?.servers.length ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => onOpenRemoteWorkspace()}>
                <Plus className="size-4" />
                {intl.formatMessage({ id: "workspaceSidebar.newRemoteConnection" })}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
