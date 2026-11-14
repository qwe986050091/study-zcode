// INV-01 只读投影：守住位置 组件体；改错故障 留白行自行补全或改动 run 数据。
// INV-02 三态封闭：守住位置 HoleRowState；改错故障 出现第四种未定义展示。
// INV-03 缺表即离开：守住位置 holes === undefined；改错故障 非活投影误显示等待。
// INV-04 缺项同样离开：守住位置 hole === undefined；改错故障 旧留白编号残留等待态。
// INV-05 等待与补全二选一：守住位置 hole.state 判定；改错故障 已补全仍显示等待时长。
// INV-06 计时只在等待态：守住位置 state !== "waiting" 早退；改错故障 已结束的留白仍每 30 秒重渲染。
// INV-07 停驻也计时：守住位置 setInterval；改错故障 无事件流时等待时长冻结。
// INV-08 定时器必须清理：守住位置 clearInterval；改错故障 状态切换后定时器泄漏。
// INV-09 切换即校准：守住位置 setNow(Date.now()) 立即调用；改错故障 首秒显示过期时长。
// INV-10 文案随态映射：守住位置 KIND_LABEL_ID；改错故障 三种态共用一句话。
// INV-11 主文本 memo 化：守住位置 primaryText 依赖；改错故障 每次计时刷新重建节点。
// INV-12 展开体不抖动：守住位置 不使用动画；改错故障 等待中的卡片闪烁。
// INV-13 站点描述按缺省降级：守住位置 standsId 三分支；改错故障 缺 before/after 时输出空占位。
// INV-14 打开入口可选：守住位置 onOpenRun 判断；改错故障 无回调时出现死链接。
//
// 模块职责：工作流留白通知行的状态判定、计时刷新与展开体渲染。
// 阅读顺序：先看 holeRowState，再看计时器，最后看展开体的各可选段落。
import { Pen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowNotificationMeta, WorkflowRunHole } from "@zcode/shared/zcode-protocol-v4";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * 留白通知行（docs/dynamic-workflow/transcript-and-notifications.md「The notification row」的 hole 一行、
 * 「The hole row's live state」）。从 WorkflowNotificationToolRow.tsx 拆出（max-lines 门）：同一套
 * ToolLayout 语法，笔图标，种类词按 run 投影的 `holes` 活翻转——
 *   run 在场且此 siteId 是 waiting → 「工作流留白 · 等待补全」，等待时长每 30 秒刷一次；
 *   run 在场且已 filled → 「留白已补全」；
 *   run 不在投影里（`holes` 缺席）→ 中性的「工作流留白」。
 * 主文本 `· <run 名> · <留白名>` 加类型徽标；展开体是提示全文、它站在哪两站之间、须返回什么、草稿
 * 路径、等了多久、run 链接。**永不 shimmer**：留白等的是主代理，不是工作。体不引用补全代码——那在相邻
 * 的 FillWorkflowHole 工具卡上。
 */
// 从联合类型中精确取出 `hole` 形态。
export type WorkflowHoleNotification = Extract<WorkflowNotificationMeta, { kind: "hole" }>;

// `waiting`、`completing` 与已离场三种态覆盖全部留白形态。
export type HoleRowState = "waiting" | "filled" | "left";

// 状态纯由投影表推导，可单测。
export function holeRowState(
  holes: readonly WorkflowRunHole[] | undefined,
  siteId: string,
): HoleRowState {
  // 投影缺席说明 run 不在活集合。
  if (holes === undefined) return "left";
  const hole = holes.find((candidate) => candidate.siteId === siteId);
  if (hole === undefined) return "left";
  // 只剩 `waiting` 与 `completing` 两种细分。
  return hole.state === "waiting" ? "waiting" : "filled";
}

// 状态到文案 id 的映射固定在此。
const KIND_LABEL_ID: Record<HoleRowState, string> = {
  waiting: "chat.backgroundResult.workflow.hole.waiting",
  filled: "chat.backgroundResult.workflow.hole.filled",
  left: "chat.backgroundResult.workflow.hole.left",
};

// 图标是常量节点，避免重复创建。
const HOLE_ICON = <Pen className="size-4 shrink-0 text-foreground-subtle" />;

const PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground";

// 行组件只依赖传入的通知与投影。
export function WorkflowNotificationHoleRow({
  forceOpen = false,
  holes,
  notification,
  onOpenRun,
  runName,
  toolId,
}: {
  notification: WorkflowHoleNotification;
  runName: string;
  toolId: string;
  /** run 投影里的留白表；undefined = run 不在活投影（中性词）。 */
  holes: readonly WorkflowRunHole[] | undefined;
  onOpenRun?: () => void;
  forceOpen?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // 站点 id 是查表的唯一键。
  const state = holeRowState(holes, notification.siteId);

  // 等待时长要在没有事件流时也照走（停驻的 run 恰恰不发事件），30 秒喂一次新的「现在」；只在等待时走。
  // 本地时钟只用于展示已等待时长。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state !== "waiting") return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  // 状态变化才重装计时器。
  }, [state]);
  // 时长文案在等待态才计算。
  const waited =
    state === "waiting"
      ? workflowRunQuestionWaitedLabel(notification.reachedAt, now, (descriptor, values) =>
          intl.formatMessage(descriptor, values),
        )
      : undefined;

  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{runName}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate" data-testid="workflow-hole-notification-name">
          {notification.name}
        </span>
      </span>
    ),
    [notification.name, runName],
  );

  // 展开体按需构造，未展开不渲染。
  const renderContent = useCallback(() => {
    const { after, before, draftPath, line, prompt } = notification;
    const standsId =
      before !== undefined && after !== undefined
        ? "chat.toolCall.workflow.hole.stands.between"
        : before !== undefined
          ? "chat.toolCall.workflow.hole.stands.after"
          : after !== undefined
            ? "chat.toolCall.workflow.hole.stands.before"
            : undefined;
    return (
      <div className="space-y-3" data-testid="workflow-hole-notification-body">
        {prompt === undefined || prompt.length === 0 ? null : (
          <p className={PANEL_CLASS}>{prompt}</p>
        )}
        <p className="text-ui-sm text-foreground-subtle">
          {standsId === undefined
            ? null
            : intl.formatMessage({ id: standsId }, { before: before ?? "", after: after ?? "" })}
        </p>
        {draftPath === undefined ? null : (
          <p className="text-ui-sm text-foreground-subtle">
            <span className="text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.toolCall.workflow.hole.draftPath" })}
            </span>{" "}
            <span className="font-mono" data-testid="workflow-hole-notification-draft">
              {line === undefined ? draftPath : `${draftPath}:L${line}`}
            </span>
          </p>
        )}
        {waited ? (
          <p
            className="text-ui-sm text-foreground-subtle"
            data-testid="workflow-hole-notification-waited"
          >
            {intl.formatMessage({ id: "chat.toolCall.workflow.hole.waited" }, { time: waited })}
          </p>
        ) : null}
        {onOpenRun ? (
          <button
            type="button"
            onClick={onOpenRun}
            className="text-ui-sm text-foreground-subtle decoration-dotted underline-offset-2 hover:text-foreground hover:underline"
          >
            {intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
          </button>
        ) : null}
      </div>
    );
  }, [intl, notification, onOpenRun, waited]);

  return (
    <div data-testid={toolId} data-hole-state={state}>
      <ToolLayout
        toolId={toolId}
        persistOpenKey={toolId}
        icon={HOLE_ICON}
        canToggle
        forceOpen={forceOpen}
        kindLabel={intl.formatMessage({ id: KIND_LABEL_ID[state] })}
        primaryText={primaryText}
        title={runName}
        renderContent={renderContent}
      />
    </div>
  );
}
