// INV-01 租约必须释放：守住位置 useEffect 的 cleanup；改错故障 关闭侧栏后会话引用计数泄漏。
// INV-02 租约随父会话切换重建：守住位置 依赖数组 layer 与 parentSessionId；改错故障 切会话后仍读旧投影。
// INV-03 投影只在有租约时订阅：守住位置 useConversationProjection(lease)；改错故障 空租约导致重复订阅。
// INV-04 实时内容只认 toolCall 行：守住位置 kind 双重判断；改错故障 同 id 的其它行被误解析成计划。
// INV-05 窗口外不阻塞渲染：守住位置 find 的返回值判空；改错故障 消息被裁出窗口时侧栏白屏。
// INV-06 摘要是两路选择的兜底：守住位置 liveMarkdown ?? lastMarkdown；改错故障 流式中断后内容回退为空。
// INV-07 tab.markdown 变化要覆盖缓存：守住位置 第二个 useEffect；改错故障 打开历史计划仍显示上一条。
// INV-08 实时内容优先于快照：守住位置 合并顺序；改错故障 用户看到滞后的计划文本。
// INV-09 主题与预览设置走默认值订阅：守住位置 useZCodeStoreWithDefault；改错故障 未初始化时渲染报错。
// INV-10 scope 只在字段存在时展开：守住位置 条件展开三元；改错故障 undefined 身份被当成有效 scope。
// INV-11 scope 依赖必须精确：守住位置 useMemo 依赖数组；改错故障 切换工作区后连接不重建。
// INV-12 provider 只按 scope 路由：守住位置 V4PaneConversationProvider；改错故障 侧栏误用 shell 身份分支。
// INV-13 容器承担滚动而非外层：守住位置 overflow-y-auto 与 min-h-0；改错故障 长计划把布局撑破。
// INV-14 组件用 memo 隔离：守住位置 两处 memo；改错故障 父级高频重渲染带动整篇 markdown 重排。
//
// 模块职责：在侧栏中挂载单条计划工具调用的实时与历史内容，并保证会话租约生命周期正确。
// 阅读顺序：先看 PlanDetailContent 的租约与内容合并，再看 PlanDetailSidePane 的 scope 构造与注入。
import { memo, useEffect, useMemo, useState } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import type { PlanDetailSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";

const PlanDetailContent = memo(function PlanDetailContent({
  tab,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: PlanDetailSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}) {
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  // 初值取打开时的快照，实时内容到达前先显示它。
  const [lastMarkdown, setLastMarkdown] = useState(tab.markdown);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  // 预览设置与主题都从 store 取默认值，未初始化也能渲染。
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  useEffect(() => {
    // 进入即占租约，退出必须由 cleanup 释放。
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);

  // 只在当前窗口里找目标行，避免遍历全量历史。
  const liveMarkdown = useMemo(() => {
    const row = state.snapshot?.rows.window.find(
      (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === tab.toolCallId,
    );
    // 找不到或类型不符一律返回 undefined，交给缓存兜底。
    if (!row || row.kind !== "toolCall") return undefined;
    const node = toolCallRowToLegacyNode(row);
    return extractPlanToolCallContent(node.toolCall, tab.workspacePath).markdown;
  }, [state.snapshot, tab.toolCallId, tab.workspacePath]);

  // 实时内容一旦有效就写入缓存，供后续切换回退。
  useEffect(() => {
    if (liveMarkdown) setLastMarkdown(liveMarkdown);
  }, [liveMarkdown]);
  useEffect(() => {
    // 快照更新时以快照为准，避免停留在旧计划。
    if (tab.markdown) setLastMarkdown(tab.markdown);
  }, [tab.markdown]);

  // 合并顺序固定：实时优先，其次缓存，最后空串。
  const markdown = liveMarkdown ?? lastMarkdown;
  return (
    <div
      // DOM 上标注来源，便于自动化测试定位具体计划。
      data-plan-detail-tool-call-id={tab.toolCallId}
      className="h-full min-h-0 overflow-y-auto bg-background px-4 py-4"
    >
      <MessageResponse
        className="mx-auto w-full max-w-4xl min-w-0 break-words text-foreground"
        workspacePath={tab.workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenExternalUrl={onOpenBrowserUrl}
      >
        {markdown}
      </MessageResponse>
    </div>
  );
});

export const PlanDetailSidePane = memo(function PlanDetailSidePane({
  tab,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: PlanDetailSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}) {
  // scope 只带存在字段，未设置的身份不落成 undefined。
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      // 条件展开而非置空，保持对象形状稳定。
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    // provider 接口已收敛为仅按 scope 做连接路由，不再接受
    // isShellWorkspace 参数；side pane 不需要额外的 shell 身份分支。
    // 连接路由完全由 scope 决定，侧栏不再区分 shell 身份。
    <V4PaneConversationProvider scope={scope}>
      <PlanDetailContent
        tab={tab}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
