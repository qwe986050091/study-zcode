// INV-01 组件纯展示：守住位置 无请求副作用；改错故障 打开侧栏就发起连接。
// INV-02 展示模型外部计算：守住位置 传入的展示对象；改错故障 颜色与状态两处分别判断。
// INV-03 动作回调全部可选：守住位置 参数类型；改错故障 只读场景出现死按钮。
// INV-04 错误详情要有原因才展开：守住位置 双条件判断；改错故障 空详情块占位。
// INV-05 在线与离线切换同一按钮：守住位置 三元选择；改错故障 同时出现连接与断开。
// INV-06 连接中禁用主按钮：守住位置 禁用属性；改错故障 重复点击发起两次连接。
// INV-07 编辑与设备管理独立：守住位置 各自条件渲染；改错故障 离线时无法编辑配置。
// INV-08 底部提示按三态切换：守住位置 嵌套三元；改错故障 连接中显示重连提示。
// INV-09 恢复信息优先于原因：守住位置 两块渲染顺序；改错故障 同时出现两条矛盾说明。
// INV-10 文案全部走消息键：守住位置 格式化调用；改错故障 出现硬编码文案。
// INV-11 状态标签复用同一模型：守住位置 标签组件入参；改错故障 标签与按钮状态不一致。
// INV-12 路径允许断行：守住位置 换行类；改错故障 长路径撑破侧栏。
// INV-13 设备名与线路只读：守住位置 展示字段；改错故障 详情区可编辑造成误改。
// INV-14 分隔线不参与布局计算：守住位置 负边距容器；改错故障 内容宽度被压缩。
// INV-15 标题优先展示远端标签：守住位置 展示纯函数；改错故障 本地名与远端目标混用。
// INV-16 本地标签页不渲染本组件：守住位置 调用方的目标判断；改错故障 本地标签页显示云端信息。
// INV-17 提示文案跟随状态色：守住位置 展示模型的样式字段；改错故障 提示与状态色脱节。
// INV-18 组件不留内部状态：守住位置 仅两个派生常量；改错故障 重渲染后残留旧状态。
//
// 模块职责：在侧栏展示远程工作区连接详情与连接相关动作。
// 状态所有权：无内部状态；连接状态、颜色与文案都由展示模型注入。
// 阅读顺序：先看两个派生常量，再看状态标签与详情表，最后看动作区。
import { formatRemoteWorkspaceDisplayLabel } from "@/lib/remoteWorkspaceHistory.js";
import { Button } from "@/components/ui/button.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { Cloud } from "lucide-react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  formatRemoteConnectionDescription,
  type RemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";

// RemoteProjectConnectionDetails 只负责展示，所有网络动作由父级回调注入。
// presentation 由调用方按 RemoteConnectionPresentation 计算后注入。
// onConnect / onDisconnect / onEdit / onManage 四个回调全部可选。
// error 非空时才展开错误文案，没有原因就不占位。
// deviceName 与 tab.remoteTarget 都走只读展示字段。
export function RemoteProjectConnectionDetails({
  tab,
  deviceName,
  presentation,
  error,
  onConnect,
  onDisconnect,
  onEdit,
  onManage,
}: {
  tab: WorkspaceTabState;
  deviceName: string;
  presentation: RemoteConnectionPresentation;
  error?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onEdit?: () => void;
  onManage?: () => void;
}) {
  const { intl } = useZCodeIntl();
  // color 直接取 presentation.foreground，不在组件内推导。
  // presentation.status 决定主按钮文案与 disabled。
  // RemoteConnectionStatusTag 复用同一个 presentation。
  // 颜色类只来自 presentation.foreground，组件不做本地推导。
  const color = presentation.foreground;
  // status 为在线时主按钮指向 onDisconnect。
  // status 为连接中时主按钮 disabled，防止重复发起。
  // onEdit 与 onManage 始终可用，不受连接态影响。
  // 底部提示按 presentation.status 三态切换消息键。
  // 所有文案都走 intl.formatMessage()，不硬编码中文。
  const state = presentation.status;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-ui-sm text-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Cloud className={cn("size-4 shrink-0", color)} />
        <strong className="min-w-0 flex-1 break-words font-medium">
          {formatRemoteWorkspaceDisplayLabel(tab.label, tab.remoteTarget)}
        </strong>
        <RemoteConnectionStatusTag presentation={presentation} className="ml-auto" />
      </div>
      {presentation.recovery ? (
        <p className={presentation.foreground}>
          {intl.formatMessage(
            { id: presentation.recovery.messageId },
            presentation.recovery.values,
          )}
        </p>
      ) : null}
      {presentation.reason ? (
        <p className={presentation.foreground}>
          {presentation.reasonText ??
            intl.formatMessage({ id: presentation.reason.reasonId }, presentation.reason.values)}
        </p>
      ) : null}
      {error && presentation.reason ? (
        <details className="text-ui-xs text-remote-foreground-muted">
          <summary>{intl.formatMessage({ id: "remote.error.details" })}</summary>
          <pre className="whitespace-pre-wrap break-words">{error}</pre>
        </details>
      ) : null}
      <div className="-mx-3 border-t border-border" />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "workspaceSidebar.projectDevice" })}
        </dt>
        <dd className="min-w-0 break-all">{deviceName}</dd>
        <dt className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "workspaceSidebar.projectLine" })}
        </dt>
        <dd className="min-w-0 break-all">{formatRemoteConnectionDescription(tab.remoteTarget)}</dd>
        <dt className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "workspaceSidebar.projectPath" })}
        </dt>
        <dd className="min-w-0 break-all rounded-sm bg-surface px-2 py-1 font-mono">
          {tab.workspacePath}
        </dd>
      </dl>
      <div className="-mx-3 flex flex-wrap gap-2 border-t border-border px-3 pt-3">
        {(state === "online" ? onDisconnect : onConnect) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={state === "connecting"}
            onClick={state === "online" ? onDisconnect : onConnect}
          >
            {intl.formatMessage({
              id: state === "online" ? "remote.action.disconnect" : "remote.action.connect",
            })}
          </Button>
        ) : null}
        {onEdit ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
            {intl.formatMessage({ id: "settings.source.editConnectionTitle" })}
          </Button>
        ) : null}
        {onManage ? (
          <Button size="sm" variant="ghost" onClick={onManage}>
            {intl.formatMessage({ id: "workspaceSidebar.manageDevice" })}
          </Button>
        ) : null}
      </div>
      <p className="text-remote-foreground-muted">
        {intl.formatMessage({
          id:
            state === "online"
              ? "workspaceSidebar.openProjectHint"
              : state === "connecting"
                ? "workspaceSidebar.connecting"
                : "workspaceSidebar.reconnectProjectHint",
        })}
      </p>
    </div>
  );
}
