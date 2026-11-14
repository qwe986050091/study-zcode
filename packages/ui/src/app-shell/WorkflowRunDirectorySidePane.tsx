// INV-01 打开请求只带作用域与运行标识：守住位置 buildWorkflowRunDirectoryOpenRequest；改错故障 详情页拿到错误 run。
// INV-02 工作区身份与远端会话按需展开：守住位置 条件展开；改错故障 空值键覆盖默认作用域。
// INV-03 展示名只作标题兜底：守住位置 workflowName 注释语义；改错故障 目录行名与详情标题不一致。
// INV-04 运行标识与工具调用标识必填：守住位置 请求字段；改错故障 详情页无法回查来源。
// INV-05 行只渲染 journal 摘要：守住位置 DirectoryRow；改错故障 实时状态重复渲染两套。
// INV-06 未命名运行用统一兜底名：守住位置 label 回退；改错故障 runId 暴露到界面。
// INV-07 状态词是主通道圆点是冗余：守住位置 文本与圆点；改错故障 仅靠颜色传达状态。
// INV-08 停止原因优先于失败码：守住位置 stopReason 判断；改错故障 可读原因被技术码覆盖。
// INV-09 相对时间可缺省：守住位置 updatedAt 判断；改错故障 缺失时间显示为 1970。
// INV-10 分段只负责标题与空态：守住位置 DirectorySection；改错故障 统计口径散落两处。
// INV-11 计数直接取行数：守住位置 rows.length；改错故障 计数与列表不一致。
// INV-12 空段保留可测标识：守住位置 emptyTestId；改错故障 空态无法被测试区分。
// INV-13 运行段与已结束段分开：守住位置 section 字段；改错故障 跑完不挪段。
// INV-14 租约随页签生命周期获取与释放：守住位置 useEffect 清理；改错故障 对话层租约泄漏。
// INV-15 投影只作刷新触发器：守住位置 refreshKey；改错故障 页面跑完仍留在运行中。
// INV-16 刷新键由运行数与结算数组成：守住位置 workflowRunDirectoryRefreshKey；改错故障 节点级事件导致频繁重取。
// INV-17 三种无行状态必须可分辨：守住位置 unavailable 与 empty 分支；改错故障 接口缺失被显示成空列表。
// INV-18 截断必须明写上限：守住位置 truncated 分支；改错故障 取满一页被当成全部。
//
// 模块职责：一条对话的 workflow 运行目录侧边页。
// 状态所有权：SessionLease 与投影来自对话层（useV4Conversation），目录行由 useWorkflowRunJournalSummaries 的摘要派生；
// 本组件不缓存行数据，刷新只靠 refreshKey 触发重取。
// 阅读顺序：先看打开请求，再读行与分段，最后看内容装配。
import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  buildWorkflowRunDirectory,
  workflowRunDirectoryRefreshKey,
  type WorkflowRunDirectoryRow,
} from "@/v4/workflowRunDirectoryModel.js";

/**
 * 一条对话的 workflow run 目录。三步形状与 subagent 目录逐字同构：任务列表页脚行 → 这一页 → `workflow-run`
 * 详情页。
 *
 * **行只渲染 journal 摘要**：发现查询本来就返回 `pending`/
 * `running`，所以两段都齐；活 run 的步数与时长在任务列表上（就在你点的那行上方）和详情页里，
 * 这一页不重复那份实时状态。
 *
 * 但它**确实**订一份投影——只当新鲜度触发器。第一版按
 * 「不租会话、不订投影」实现，于是页面一个信号都没有：hook 首答即收口，跑完的 run 永远留在
 * 「运行中」。租约 + 投影这套接线与 `SubagentDirectorySidePane` 逐字相同，那边靠的是
 * `subagents.revision`；这里的键要更挑（见 `workflowRunDirectoryRefreshKey`），因为 dwf 的
 * `revision` 每来一个节点事件就抬一次。
 */
function buildWorkflowRunDirectoryOpenRequest(
  tab: WorkflowRunDirectorySidePaneTab,
  row: WorkflowRunDirectoryRow,
): OpenScopedWorkflowRunSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    parentSessionId: tab.parentSessionId,
    runId: row.runId,
    toolCallId: row.toolCallId,
    // 展示名冻进 tab 只作投影缺席时的标题兜底（见 WorkflowRunSidePaneTab 的注释）。
    ...(row.label ? { workflowName: row.label } : {}),
  };
}

const DirectoryRow = memo(function DirectoryRow({
  onOpen,
  row,
}: {
  onOpen: (row: WorkflowRunDirectoryRow) => void;
  row: WorkflowRunDirectoryRow;
}) {
  const { intl } = useZCodeIntl();
  // 未命名的 run 用与工具卡/任务列表同一个兜底名，绝不把 runId 端到台面上。
  const name = row.label ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const statusLabel = intl.formatMessage({
    id: `chat.toolCall.workflow.run.status.${row.status}`,
  });
  const stopReason = readWorkflowRunStopReason(row);

  return (
    <button
      type="button"
      data-run-id={row.runId}
      data-run-status={row.status}
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      onClick={() => onOpen(row)}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      {/* 状态永远有词（下一行），圆点只是冗余通道。 */}
      <span
        aria-hidden="true"
        className={cn("mt-2 size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[row.status])}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{name}</span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-ui-sm">
          <span className={cn("shrink-0", RUN_STATUS_TEXT[row.status])}>{statusLabel}</span>
          {/*
            「为什么值得回去看」的那半句：stopped 行显示停止原因，errored 行显示 failureCode。
            老服务端若未提供 stopped 的原因，则回退到 failureCode。
          */}
          {stopReason ? (
            <span className="min-w-0 truncate text-foreground-subtle">
              · {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
            </span>
          ) : (row.status === "errored" || row.status === "stopped") && row.failureCode ? (
            <span className="min-w-0 truncate text-foreground-subtle">· {row.failureCode}</span>
          ) : null}
        </span>
      </span>
      {row.updatedAt === undefined ? null : (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(row.updatedAt, intl)}
        </span>
      )}
      <ChevronRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-subtlest" />
    </button>
  );
});

function DirectorySection({
  countTestId,
  emptyLabel,
  emptyTestId,
  onOpen,
  rows,
  section,
  title,
}: {
  countTestId: string;
  emptyLabel: string;
  emptyTestId: string;
  onOpen: (row: WorkflowRunDirectoryRow) => void;
  rows: readonly WorkflowRunDirectoryRow[];
  section: "running" | "ended";
  title: string;
}) {
  return (
    <section
      data-workflow-directory-section={section}
      className={section === "ended" ? "mt-5" : ""}
    >
      <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
        {title} · <span data-testid={countTestId}>{rows.length}</span>
      </h3>
      {rows.length > 0 ? (
        rows.map((row) => <DirectoryRow key={row.runId} row={row} onOpen={onOpen} />)
      ) : (
        <p data-testid={emptyTestId} className="px-3 py-3 text-ui-base text-foreground-subtlest">
          {emptyLabel}
        </p>
      )}
    </section>
  );
}

const WorkflowRunDirectoryContents = memo(function WorkflowRunDirectoryContents({
  onOpenWorkflowRun,
  tab,
}: {
  onOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  tab: WorkflowRunDirectorySidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  // pane 是从一条活着的对话里点开的，所以 `live: true` 是实话；`limit` 与任务列表计数共用
  // 同一个常量，两处深度一旦不同就等于两套口径。
  //
  // `refreshKey` 是这一页会不会自己更新的**全部**依据（实测 bug：跑完的 run 不会挪到
  // 「已结束」，因为这里当初一个信号都没接）。投影在这里只是触发器，不是信源：行仍然只渲染
  // journal 摘要，活 run 的步数与时长仍然只在任务列表和详情页。键的形状（run 数 + 已结算数）
  // 让「多一个 run / 跑完一个 run」重取一次，而节点级进度不重取——见模型里那段注释。
  const summaries = useWorkflowRunJournalSummaries({
    sessionId: tab.parentSessionId,
    live: true,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(projection.snapshot?.workflowRuns?.runs),
  });
  const directory = useMemo(() => buildWorkflowRunDirectory(summaries), [summaries]);
  const handleOpen = (row: WorkflowRunDirectoryRow) => {
    onOpenWorkflowRun(buildWorkflowRunDirectoryOpenRequest(tab, row));
  };
  // 三种「屏幕上没有行」必须可分辨：列不出来（摘要缺席）／一条都没有／只是某一段空。
  const isUnavailable = summaries === null;
  const isEmpty = !isUnavailable && directory.running.length + directory.ended.length === 0;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "workflowDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {isUnavailable ? (
          // 不是报错语气：拿不到名单最常见的原因是这条对话所在的运行时不提供枚举面。
          <p
            data-testid="workflow-run-directory-unavailable"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "workflowDirectory.unavailable" })}
          </p>
        ) : isEmpty ? (
          <p
            data-testid="workflow-run-directory-empty"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "workflowDirectory.empty" })}
          </p>
        ) : (
          <>
            <DirectorySection
              section="running"
              title={intl.formatMessage({ id: "workflowDirectory.running" })}
              rows={directory.running}
              countTestId="workflow-run-directory-running-count"
              emptyTestId="workflow-run-directory-running-empty"
              emptyLabel={intl.formatMessage({ id: "workflowDirectory.runningEmpty" })}
              onOpen={handleOpen}
            />
            <DirectorySection
              section="ended"
              title={intl.formatMessage({ id: "workflowDirectory.ended" })}
              rows={directory.ended}
              countTestId="workflow-run-directory-ended-count"
              emptyTestId="workflow-run-directory-ended-empty"
              emptyLabel={intl.formatMessage({ id: "workflowDirectory.endedEmpty" })}
              onOpen={handleOpen}
            />
            {/* 截断必须明写：一页正好取满时「就这些」是假话，而查询没有游标可翻。 */}
            {directory.truncated ? (
              <p
                data-testid="workflow-run-directory-truncated"
                className="px-3 pt-4 text-ui-sm text-foreground-subtlest"
              >
                {intl.formatMessage(
                  { id: "workflowDirectory.truncated" },
                  { count: String(WORKFLOW_RUN_DIRECTORY_LIMIT) },
                )}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});

export const WorkflowRunDirectorySidePane = memo(function WorkflowRunDirectorySidePane({
  onOpenWorkflowRun,
  tab,
}: {
  onOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  tab: WorkflowRunDirectorySidePaneTab;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowRunDirectoryContents tab={tab} onOpenWorkflowRun={onOpenWorkflowRun} />
    </V4PaneConversationProvider>
  );
});
