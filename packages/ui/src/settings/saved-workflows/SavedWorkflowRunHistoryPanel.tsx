// INV-01 空历史直接给提示：守住位置 runs.length 判断；改错故障 渲染空表格边框。
// INV-02 行键用 runId：守住位置 key 属性；改错故障 重排后行状态串位。
// INV-03 状态徽标由纯函数决定：守住位置 savedWorkflowRunBadgeKind；改错故障 图标与文案不一致。
// INV-04 运行中时长随 now 重算：守住位置 durationMs；改错故障 时长停在首次渲染值。
// INV-05 分钟与秒分开格式化：守住位置 两条时长键；改错故障 出现 90 秒这类读数。
// INV-06 查看实例需三个条件同时成立：守住位置 openable 表达式；改错故障 老行也显示入口。
// INV-07 产物入口条件比查看实例松：守住位置 artifactsOpenable；改错故障 产物无法打开。
// INV-08 老行缺产物键即整块缺席：守住位置 artifacts 判断；改错故障 渲染空白 chip 区。
// INV-09 项目列仅在解析器存在时渲染：守住位置 resolveRunProject 判断；改错故障 单项目视图多一列。
// INV-10 项目不可打开则隐藏入口：守住位置 project.canOpen；改错故障 跨项目行点了无响应。
// INV-11 实参以 chip 形式平铺：守住位置 formatSavedWorkflowRunArgs；改错故障 长参数撑破行高。
// INV-12 token 数走统一格式化：守住位置 formatSavedWorkflowTokens；改错故障 大数字无分隔。
// INV-13 首行不加分隔线：守住位置 index 判断；改错故障 表格顶部多一条横线。
// INV-14 状态色只由 switch 决定：守住位置 statusClass 赋值；改错故障 未知状态无配色。
// INV-15 未知状态回落中性图标：守住位置 default 分支；改错故障 运行态误显示为完成。
// INV-16 图标全部标记 aria-hidden：守住位置 图标属性；改错故障 读屏重复播报状态。
// INV-17 时间统一走 formatDateTime：守住位置 createdAt 渲染；改错故障 时区展示不一致。
// INV-18 底部说明常驻：守住位置 history.note；改错故障 用户不知道历史来自 journal。
//
// 模块职责：把已保存工作流的运行 journal 渲染成可按行追溯的历史列表。
// 状态所有权：runs 与 now 由上层传入，本组件不做请求也不缓存。
// 阅读顺序：先看空态与行模型，再看两种入口门槛，最后看状态分支。
import type { ReactNode } from "react";
import { Ban, ChevronRight, CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import { TID_WORKFLOW_RUN_ROW, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { SavedWorkflowArtifactChips } from "@/settings/saved-workflows/SavedWorkflowArtifactChips.js";
import {
  formatSavedWorkflowRunArgs,
  formatSavedWorkflowTokens,
  savedWorkflowRunBadgeKind,
  savedWorkflowRunDurationMs,
} from "@/settings/saved-workflows/savedWorkflowRunHistory.js";

/** 详情页某一行运行记录对应的项目（全局工作流跨 cwd 时用；cwd 命中已打开项目才能「查看实例」）。 */
// 标签用于展示。
// 完整路径放 title 兜底。
// canOpen 决定「查看实例」入口是否出现。
// 解析失败返回空表示无项目列。
export interface SavedWorkflowRunProject {
  label: string;
  /** 完整 cwd 路径，挂在 title 上。 */
  title?: string;
  /** 该行 cwd 对应本地已打开项目 → 可「查看实例」。 */
  canOpen: boolean;
}

/** 详情页「运行历史」：journal 行（状态 / 时间 / 花费 / 实参），有归属字段的行可「查看实例」。 */
// 入参全部为只读数据或回调。
// props 中不含任何可变缓存。
// 渲染顺序固定为状态、时间、参数、产物。
// 回调缺席时对应入口自动降级。
export function SavedWorkflowRunHistory({
  runs,
  now,
  canOpenRun,
  onOpenRun,
  onOpenArtifact,
  resolveRunProject,
}: {
  runs: readonly ZCodeSavedWorkflowRun[];
  now: number;
  canOpenRun: boolean;
  onOpenRun: (run: ZCodeSavedWorkflowRun) => void;
  /**
   * 产物 chip → `workflow-artifact` tab。
   * 缺席即 chips 只读。门比「查看实例」松一格：产物不需要 `toolCallId`。
   */
  onOpenArtifact?: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
  /** 传入即在每行渲染项目列（全局工作流跨项目历史）；「查看实例」还要该行 canOpen。 */
  resolveRunProject?: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null;
}) {
  const { intl } = useZCodeIntl();
  if (runs.length === 0) {
    return (
      <p className="text-ui-base text-foreground-subtlest">
        {intl.formatMessage({ id: "workflows.hub.history.empty" })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border">
        {runs.map((run, index) => {
          const kind = savedWorkflowRunBadgeKind(run.status);
          const project = resolveRunProject ? resolveRunProject(run) : null;
          const durationMs = savedWorkflowRunDurationMs(run, now);
          const totalSeconds = Math.round(durationMs / 1000);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          const duration =
            minutes > 0
              ? intl.formatMessage(
                  { id: "workflows.hub.time.duration.minutes" },
                  { minutes: String(minutes), seconds: String(seconds) },
                )
              : intl.formatMessage(
                  { id: "workflows.hub.time.duration.seconds" },
                  { seconds: String(seconds) },
                );
          // canOpenRun 先短路，未开启时不必再看会话标识。
          // parentSessionId 与 toolCallId 必须成对。
          // resolveRunProject 存在时还要求 project.canOpen 为真。
          // 三者同时成立时 openable 才为真。
          const openable =
            canOpenRun &&
            Boolean(run.parentSessionId && run.toolCallId) &&
            (resolveRunProject ? (project?.canOpen ?? false) : true);
          // 产物 chip 的门：只要 `parentSessionId` 在场（老行可缺）+ 项目可打开。
          // `toolCallId` 不是条件——产物 tab 不回那条 CreateWorkflow 工具行。
          const artifactsOpenable =
            onOpenArtifact !== undefined &&
            Boolean(run.parentSessionId) &&
            (resolveRunProject ? (project?.canOpen ?? false) : true);
          const statusLabel = intl.formatMessage({ id: `workflows.hub.lastRun.${kind}` });
          let icon: ReactNode;
          let statusClass: string;
          // switch (kind) 的四个分支各自绑定 icon 与 statusClass。
          // 未知 kind 落到 default 的中性配色。
          // statusClass 只取 text-success 这类语义令牌。
          // 文案键由 kind 直接拼出。
          switch (kind) {
            case "completed":
              icon = <CircleCheck className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-success";
              break;
            case "errored":
              icon = <TriangleAlert className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-destructive";
              break;
            case "running":
              icon = (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.33} aria-hidden="true" />
              );
              statusClass = "text-warning";
              break;
            default:
              icon = <Ban className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-foreground-subtle";
          }
          return (
            <div
              key={run.runId}
              data-testid={testId(TID_WORKFLOW_RUN_ROW, run.runId)}
              className={cn(
                "grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <span className={cn("inline-flex items-center gap-1.5 text-ui-base", statusClass)}>
                {icon}
                {statusLabel}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-base">
                <span className="text-foreground">{formatDateTime(run.createdAt)}</span>
                {resolveRunProject && project ? (
                  <span
                    data-workflow-run-project="true"
                    className="min-w-0 max-w-40 truncate text-foreground-subtle"
                    title={project.title ?? project.label}
                  >
                    {project.label}
                  </span>
                ) : null}
                <span className="text-foreground-subtle">
                  {duration} ·{" "}
                  {intl.formatMessage(
                    { id: "workflows.hub.history.tokens" },
                    { tokens: formatSavedWorkflowTokens(run.spentTokens) },
                  )}
                </span>
                {formatSavedWorkflowRunArgs(run.args).map((chip) => (
                  <span
                    key={chip}
                    className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                  >
                    {chip}
                  </span>
                ))}
                {/*
                 * 这次运行交付的产物。
                 * ⚠ 术语：artifact = 脚本发布给用户看的产出，不是脚本的顶层返回值。
                 * 老行没有这个键（老 CLI 不发），整块因此缺席而不是画一个空位。
                 */}
                {run.artifacts === undefined ? null : (
                  <SavedWorkflowArtifactChips
                    artifacts={run.artifacts}
                    {...(artifactsOpenable
                      ? {
                          onOpenArtifact: (artifactId: string) => onOpenArtifact?.(run, artifactId),
                        }
                      : {})}
                  />
                )}
              </div>
              {openable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-icon="inline-end"
                  className="text-foreground-subtle"
                  onClick={() => onOpenRun(run)}
                >
                  {intl.formatMessage({ id: "workflows.hub.history.open" })}
                  <ChevronRight className="size-3" aria-hidden="true" />
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "workflows.hub.history.note" })}
      </p>
    </div>
  );
}
