// INV-01 横幅始终可重连：守住位置 横幅挂载；改错故障 断线页没有恢复入口。
// INV-02 状态驱动外观：守住位置 状态属性；改错故障 断线与连接中用同一配色。
// INV-03 恢复中禁用按钮：守住位置 忙碌标志；改错故障 连点发起多次重连。
// INV-04 详情按需打开：守住位置 本地开关；改错故障 每次渲染都弹窗。
// INV-05 详情页签可缺席：守住位置 条件渲染；改错故障 空页签渲染空白面板。
// INV-06 冷态不读远端数据：守住位置 草稿读取；改错故障 断线页触发远端请求。
// INV-07 草稿只读持久化：守住位置 读取函数；改错故障 断线页出现可编辑输入。
// INV-08 项目标识先裁剪：守住位置 标识归一化；改错故障 空白标识命中错误工作区。
// INV-09 项目标识缺省退路径：守住位置 或运算；改错故障 无标识时取不到草稿。
// INV-10 页签标识走解析器：守住位置 作用域解析；改错故障 草稿落到错误项目。
// INV-11 会话标识缺省为根：守住位置 常量兜底；改错故障 无会话时读不到草稿。
// INV-12 发送不可用有明确文案：守住位置 固定消息；改错故障 输入框占位为空。
// INV-13 占位文案走国际化：守住位置 消息标识；改错故障 中文硬编码。
// INV-14 草稿为空显示空串：守住位置 空值兜底；改错故障 出现未定义字样。
// INV-15 发送按钮始终禁用：守住位置 硬编码禁用；改错故障 断线页仍可提交。
// INV-16 页面撑满可用高度：守住位置 外层样式；改错故障 占位区塌陷到顶部。
// INV-17 草稿区可访问名称：守住位置 标签属性；改错故障 读屏无法识别输入框。
// INV-18 名称与路径来自作用域：守住位置 对话框头部；改错故障 详情显示错误工作区。
//
// 模块职责：远程会话断线时的横幅、草稿回显与禁用发送区。
// 状态所有权：连接展示由共享 hook 提供，详情开关归横幅本地。
// 阅读顺序：先看横幅与重连，再读草稿作用域解析，最后看禁用输入区。
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteProjectConnectionPresentation } from "@/project-sidebar/useRemoteProjectConnectionPresentation.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface Scope {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
}

// RemoteConversationBanner 常驻断线页顶部。
// presentation.surface 与 foreground 决定横幅外观。
// busy 为 true 时重连按钮禁用，避免连点重复重连。
// detailsOpen 控制 Dialog 按需打开。
// tab 缺失时只渲染标题，不渲染 RemoteProjectConnectionDetails。
export function RemoteConversationBanner(scope: Scope) {
  const { intl } = useZCodeIntl();
  const { presentation, busy, reconnect, tab, deviceName, error } =
    useRemoteProjectConnectionPresentation(scope);
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div
      role="status"
      data-testid="remote-conversation-banner"
      data-connection-state={presentation.status}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-3 p-3 text-ui-sm",
        presentation.surface,
        presentation.foreground,
      )}
    >
      <RemoteConnectionStateIcon presentation={presentation} />
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium", presentation.tone === "neutral" && "text-foreground")}>
          {intl.formatMessage({ id: presentation.messageId })}
        </p>
        <p>
          {presentation.reasonText ??
            intl.formatMessage(
              { id: presentation.reason?.reasonId ?? "remote.conversation.unavailable" },
              presentation.reason?.values,
            )}
        </p>
        <p>{intl.formatMessage({ id: "remote.conversation.tasksContinue" })}</p>
      </div>
      <div className="ml-auto flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
          {intl.formatMessage({ id: "remote.error.details" })}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            void reconnect();
          }}
        >
          {intl.formatMessage({ id: "remote.conversation.reconnect" })}
        </Button>
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deviceName}</DialogTitle>
            <DialogDescription>{scope.workspacePath}</DialogDescription>
          </DialogHeader>
          {tab ? (
            <RemoteProjectConnectionDetails
              tab={tab}
              deviceName={deviceName}
              presentation={presentation}
              error={error}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 冷态不读取远端数据；草稿只读既有持久化，离线页面没有提交或排队处理器。 */
// 断线页只读本地状态，不发起远端读取。
// 项目标识先 trim 再查 zcodeSessionStore。
// workspaceIdentity 缺省时退回 scope.workspacePath。
// sessionId 缺省时落到 V4_DRAFT_SCOPE_ROOT。
// 草稿只来自 readV4ComposerDraft 读到的本地持久化。
export function RemoteConversationDisconnected(scope: Scope) {
  const { intl } = useZCodeIntl();
  const clientNamespace = useComposerClientNamespace();
  const projectId = useZCodeSessionStore(
    (state) =>
      state.workspaces[scope.workspaceIdentity?.trim() || scope.workspacePath]?.draftProjectId,
  );
  const draftScope =
    projectId !== undefined
      ? resolveComposerScope(projectId, scope.workspaceIdentity, clientNamespace)
      : (readComposerWorkspaceScope(
          scope.workspacePath,
          scope.workspaceIdentity,
          clientNamespace,
        ) ?? resolveComposerScope(null, scope.workspaceIdentity, clientNamespace));
  // draftScope 先经 resolveComposerScope 解析再读草稿。
  // sessionId 决定 readV4ComposerDraft 的分桶。
  // 读取失败时返回 undefined，不抛异常。
  // 只读不写回，也不清理既有草稿。
  // draft 只用于 textarea 回显文本。
  const draft = readV4ComposerDraft(
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.sessionId ?? V4_DRAFT_SCOPE_ROOT,
    draftScope,
  );
  // reason 只经 intl.formatMessage 计算一次。
  // 同一 reason 同时用于 placeholder 与下方提示。
  // 发送按钮硬编码 disabled。
  // textarea 带 readOnly，不接收编辑。
  // 所有文案走 intl.formatMessage，不硬编码中文。
  const reason = intl.formatMessage({ id: "remote.conversation.sendUnavailable" });
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="remote-conversation-unavailable"
    >
      <RemoteConversationBanner {...scope} />
      <div className="flex min-h-32 flex-1 items-center justify-center p-6 text-center text-ui-base text-remote-foreground-muted">
        {intl.formatMessage({ id: "remote.conversation.placeholder" })}
      </div>
      <div className="m-3 rounded-xl border border-input-border bg-input p-3">
        <textarea
          readOnly
          value={draft?.text ?? ""}
          placeholder={reason}
          aria-label={intl.formatMessage({ id: "remote.conversation.draft" })}
          className="min-h-20 w-full resize-none bg-transparent text-ui-base text-foreground outline-none max-md:text-mobile-input-safe"
        />
        <div className="flex items-center justify-end gap-2 text-ui-sm text-remote-foreground-muted">
          <span>{reason}</span>
          <Button disabled>{intl.formatMessage({ id: "chat.send" })}</Button>
        </div>
      </div>
    </div>
  );
}
