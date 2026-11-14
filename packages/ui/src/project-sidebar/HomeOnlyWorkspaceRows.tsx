// INV-01 单飞打开请求：守住位置 待定键；改错故障 两个切换互相覆盖。
// INV-02 可桥接走切换：守住位置 类型判断；改错故障 远程目标走错入口。
// INV-03 不可桥接走重连：守住位置 分支；改错故障 桌面已有连接被重建。
// INV-04 重连后刷新列表：守住位置 调用顺序；改错故障 状态显示过期。
// INV-05 失败统一提示：守住位置 捕获分支；改错故障 用户看不到原因。
// INV-06 失败先记日志：守住位置 日志调用；改错故障 线上问题无痕迹。
// INV-07 结束必清待定键：守住位置 最终清理；改错故障 按钮永久禁用。
// INV-08 待定期间禁用全部行：守住位置 禁用条件；改错故障 并发请求打架。
// INV-09 无重连能力即禁用：守住位置 条件组合；改错故障 点击无反应。
// INV-10 连接态映射展示：守住位置 状态解析；改错故障 失败显示为离线。
// INV-11 重连中标记连接中：守住位置 待定键判断；改错故障 无任何进行中反馈。
// INV-12 远程行显示状态图标：守住位置 类型分支；改错故障 远程与本地图标相同。
// INV-13 非桥接追加连接动作：守住位置 双条件；改错故障 用户不知道可点击。
// INV-14 空列表给空态文案：守住位置 长度判断；改错故障 区域空白。
// INV-15 加载中给加载文案：守住位置 双空判断；改错故障 加载与空态同时出现。
// INV-16 错误给重试入口：守住位置 错误分支；改错故障 用户只能刷新整页。
// INV-17 文案全部走国际化：守住位置 格式化调用；改错故障 出现硬编码文本。
// INV-18 行键用工作区键：守住位置 键属性；改错故障 切换后行状态错位。
//
// 模块职责：首页专用工作区列表的打开、重连与状态展示。
// 状态所有权：列表数据归专用钩子，进行中请求归本组件。
// 阅读顺序：先看操作函数，再看连接态派生，最后看渲染分支。
import { SidebarNativeTooltip } from "@/ControlHintTooltip.js";
import { useState } from "react";
import { Folder } from "lucide-react";
import {
  isWebRemoteControlBridgeableWorkspaceTarget,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  formatRemoteConnectionError,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { logger } from "@/logger.js";
import { useHomeOnlyWorkspaces } from "@/project-sidebar/useHomeOnlyWorkspaces.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

/** home-only 首页的工作区入口：可 bridge 的行打开工作区，其余行交给桌面已有重连 owner。 */
// workspaces 与 error 都来自 useHomeOnlyWorkspaces，组件自身不保存列表状态。
// pendingKey 非空即视为有请求在飞，同一时间只允许一个打开或重连操作。
// 可桥接的行调用 switcher.switchWorkspace 直接切换工作区。
// 不可桥接的行依次调用 reconnectWorkspace 与 reload，重连成功后再刷新列表。
// catch 里记 logger.warn 并 toast 提示，finally 一定把 pendingKey 清回 null。
export function HomeOnlyWorkspaceRows({
  switcher,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
}) {
  const { intl } = useZCodeIntl();
  const { workspaces, error, reload } = useHomeOnlyWorkspaces(switcher);
  // 同一时间只允许一个打开/重连请求，避免两个 bridge 切换互相覆盖 Root。
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // run 先 setPendingKey(workspaceKey) 锁住该行，避免双击重复发起请求。
  // isWebRemoteControlBridgeableWorkspaceTarget 决定走切换还是重连分支。
  // 重连分支在 await reconnectWorkspace 之后调用 reload 拉新列表。
  // 失败时 logger.warn 记下 workspaceKey 与错误，再用 toast 展示格式化后的原因。
  // finally 无条件 setPendingKey(null)，成功与失败都不会把行留在 pending。
  const run = async (workspace: WebRemoteControlWorkspaceTarget) => {
    const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
    setPendingKey(workspaceKey);
    try {
      if (isWebRemoteControlBridgeableWorkspaceTarget(workspace)) {
        await switcher.switchWorkspace(workspaceKey);
      } else {
        await switcher.reconnectWorkspace?.(workspaceKey);
        await reload();
      }
    } catch (cause) {
      logger.warn("[project-sidebar] home-only 工作区操作失败", {
        workspaceKey,
        error: getErrorMessage(cause),
      });
      toast(
        formatRemoteConnectionError({
          fallback: getErrorMessage(cause),
          reasonCode: getRemoteConnectionFailureCode(cause),
          formatMessage: intl.formatMessage,
        }),
      );
    } finally {
      setPendingKey(null);
    }
  };
  return (
    <section data-testid="home-only-workspaces" className="px-2">
      <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">
        {intl.formatMessage({ id: "webRemoteControl.homeOnlyWorkspaces" })}
      </h3>
      {workspaces?.map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        const bridgeable = isWebRemoteControlBridgeableWorkspaceTarget(workspace);
        const remote = workspace.kind === "remote";
        // workspace.connectionState 折成 online 或 connecting 等展示态，再交给 resolveRemoteConnectionPresentation 计算。
        // reconnecting 只在该行 pendingKey 命中且不可桥接时为 true，其余情况交回 connectionState。
        // lastConnectionError 存在时判 failed，优先于 offline 与 connecting。
        // presentation.status 为 connecting 时 busy 为 true，整行按钮禁用。
        // presentation 是本次渲染的只读派生值，不要写回 workspace 或 store。
        const presentation = resolveRemoteConnectionPresentation({
          state:
            workspace.connectionState === "connected"
              ? "online"
              : workspace.connectionState === "reconnecting"
                ? "connecting"
                : workspace.lastConnectionError
                  ? "failed"
                  : "offline",
          reconnecting: pendingKey === workspaceKey && !bridgeable,
          error: workspace.lastConnectionError,
        });
        // 行按钮的 disabled 同时受 pendingKey 与 busy 控制，连接中整行不可点。
        // pendingKey !== null 时禁用所有 home-only 行，防止并发切换覆盖 Root。
        // !bridgeable 且 switcher.reconnectWorkspace 缺失时该行没有可用动作，一并禁用。
        // 禁用态通过 cursor-wait 样式提示等待，与 disabled 属性同源。
        const busy = presentation.status === "connecting";
        return (
          <SidebarNativeTooltip key={workspaceKey}>
            <button
              type="button"
              data-home-only-workspace={workspaceKey}
              title={workspace.label}
              disabled={
                pendingKey !== null || busy || (!bridgeable && !switcher.reconnectWorkspace)
              }
              onClick={() => void run(workspace)}
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:cursor-wait"
            >
              {remote ? (
                <RemoteConnectionStateIcon presentation={presentation} project />
              ) : (
                <Folder aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
              )}
              <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
              {remote ? (
                <span
                  className={cn(
                    "shrink-0 text-ui-sm",
                    presentation.status === "online"
                      ? "text-remote-foreground-muted"
                      : presentation.foreground,
                  )}
                >
                  {intl.formatMessage({ id: presentation.shortMessageId })}
                  {!bridgeable && !busy
                    ? ` · ${intl.formatMessage({ id: "remote.action.connect" })}`
                    : null}
                </span>
              ) : null}
            </button>
          </SidebarNativeTooltip>
        );
      })}
      {workspaces?.length === 0 ? (
        <p className="px-2.5 py-2 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "webRemoteControl.noSwitchableWorkspaces" })}
        </p>
      ) : null}
      {!workspaces && !error ? (
        <p className="px-2.5 py-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 px-2.5 py-1">
          <p role="alert" className="min-w-0 flex-1 text-ui-sm text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
