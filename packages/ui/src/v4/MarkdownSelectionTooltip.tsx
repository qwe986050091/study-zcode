// INV-01 选区必须落在根内：守住位置 起止包含判断；改错故障 页面其他文本也弹操作条。
// INV-02 折叠选区不弹条：守住位置 折叠早退；改错故障 单击就出现菜单。
// INV-03 多段选区不受支持：守住位置 范围数量判断；改错故障 跨段选择取到错误矩形。
// INV-04 排除区内的端点不弹条：守住位置 端点守卫；改错故障 按钮文字下方也出现菜单。
// INV-05 空文本不弹条：守住位置 去空判断；改错故障 全空白选择仍出菜单。
// INV-06 零尺寸矩形不弹条：守住位置 宽高判断；改错故障 菜单飘到左上角。
// INV-07 位置取选区矩形：守住位置 矩形字段；改错故障 菜单偏离选中文字。
// INV-08 侧聊键仅在会话可辨时构造：守住位置 会话判断；改错故障 不同会话共用一份侧聊。
// INV-09 侧聊状态走外部存储：守住位置 订阅函数；改错故障 状态变化不触发重渲染。
// INV-10 服务端快照固定为不可用：守住位置 第三个参数；改错故障 首帧误判为可用。
// INV-11 超长选区只允许加入任务：守住位置 单条上限标记；改错故障 长文本也能开侧聊。
// INV-12 侧聊不可用时给出原因：守住位置 标题分支；改错故障 按钮灰掉却无说明。
// INV-13 引用按当前选区构造：守住位置 取值时机；改错故障 引用带上上一条选区。
// INV-14 加入任务后关闭菜单：守住位置 关闭调用；改错故障 菜单停在原地挡住正文。
// INV-15 侧聊打开成功才关闭：守住位置 条件调用；改错故障 未打开却收起菜单。
// INV-16 引用类型固定为 Markdown：守住位置 内容类型字段；改错故障 引用被当成代码片段。
// INV-17 检查函数只依赖根引用：守住位置 依赖数组；改错故障 每次渲染重建监听。
// INV-18 未选中时整块不渲染：守住位置 空状态早退；改错故障 空菜单占位。
//
// 模块职责：把正文选区变成加入任务与侧聊两条动作。
// 状态所有权：选区与侧聊可用性分别来自专用 hook 与外部存储。
// 阅读顺序：先看选区检查，再看状态接线，最后看菜单属性与两个动作。
import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import {
  buildSelectionSideChatKey,
  getSelectionSideChatOpenState,
  requestSelectionSideChatOpen,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import { useCallback, useSyncExternalStore, type RefObject } from "react";
import { useTextSelection } from "@/hooks/useTextSelection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { hasExcludedConversationSelectionEndpoint } from "@/lib/conversationSelectionGuard.js";
import {
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  dispatchConversationSelectionAdd,
  createConversationSelectionReference,
  type MarkdownSelectionTarget,
} from "@/lib/conversationSelectionReference.js";

// inspect 的选区检查只在 rootRef 根节点内。
// SelectionActionMenu 的 top 与 center 来自 range.getBoundingClientRect。
// 侧聊可用性经 useSyncExternalStore 另取外部状态。
export function MarkdownSelectionTooltip({
  rootRef,
  sourceKey,
  sourceTitle,
  sourcePath,
  target,
  scopeKey,
}: {
  scopeKey: object;
  rootRef: RefObject<HTMLDivElement | null>;
  sourceKey: string;
  sourceTitle: string;
  sourcePath?: string;
  target: MarkdownSelectionTarget;
}) {
  const { intl } = useZCodeIntl();
  // selection.isCollapsed 为真或 rangeCount≠1 时直接放弃。
  // hasExcludedConversationSelectionEndpoint 命中任一端点时放弃。
  // selection.toString 为空或 rect 宽高皆零时放弃。
  const inspect = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
    if (
      hasExcludedConversationSelectionEndpoint(
        element(range.startContainer),
        element(range.endContainer),
      )
    )
      return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { text, top: rect.top, bottom: rect.bottom, center: rect.left + rect.width / 2 };
  }, [rootRef]);
  // useTextSelection 经 observeSelectionChange 订阅选区变化。
  // 作用域键用于区分宿主。
  // 关闭回调由 hook 提供。
  const { state, close } = useTextSelection({
    rootRef,
    enabled: true,
    inspect,
    scopeKey,
    observeSelectionChange: true,
  });
  const sideKey = target.sessionId
    ? buildSelectionSideChatKey(target.workspaceKey, target.sessionId)
    : null;
  const sideState = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () => (sideKey ? getSelectionSideChatOpenState(sideKey) : "unavailable"),
    () => "unavailable",
  );
  if (!state) return null;
  const createReference = () =>
    createConversationSelectionReference({
      contentType: "markdown",
      sourceKey,
      sourceTitle,
      path: sourcePath,
      text: state.text,
    });
  // 超长选区下 SelectionActionMenu 只保留加入任务一项。
  // sideState 为 unavailable 时给出原因文案。
  // onOpen 成功返回后才调 close 收起菜单。
  return (
    <SelectionActionMenu
      center={state.center}
      top={state.top}
      bottom={state.bottom}
      singleLimit={state.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH}
      sideActionDisabled={sideState !== "ready"}
      sideDisabledTitle={
        sideState === "ready"
          ? undefined
          : intl.formatMessage({
              id:
                sideState === "blocked"
                  ? "chat.selections.previewSideBlocked"
                  : "chat.selections.previewSideUnavailable",
            })
      }
      onAddToCurrentTask={() => {
        dispatchConversationSelectionAdd({
          targetSessionId: target.sessionId,
          draftScopeKey: target.draftScopeKey,
          workspaceKey: target.workspaceKey,
          reference: createReference(),
        });
        close();
      }}
      onAskInSideChat={() => {
        if (sideKey && requestSelectionSideChatOpen(sideKey, createReference())) close();
      }}
    />
  );
}
