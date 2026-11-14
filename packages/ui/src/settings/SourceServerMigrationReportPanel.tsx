// INV-01 状态即颜色：守住位置 getStatusChipClassName；改错故障：未知状态没有底色。
// INV-02 合并与放弃同色：守住位置 abandoned 两个分支；改错故障：两种收尾状态视觉不一致。
// INV-03 最新才可操作：守住位置 latestMigrationIdByPath；改错故障：旧迁移记录上出现重试按钮。
// INV-04 首见即最新：守住位置 首次写入判断；改错故障：后到的旧记录覆盖最新标识。
// INV-05 完成行讲合并：守住位置 completed 分支；改错故障：完成行显示错误详情。
// INV-06 错误码优先：守住位置 errorCode 的三元链；改错故障：有错误码却显示阶段文案。
// INV-07 阶段兜底：守住位置 phase 分支；改错故障：运行中行没有说明。
// INV-08 兜底文案：守住位置 migrationDetailUnavailable；改错故障：详情位出现空白。
// INV-09 冲突计数附加：守住位置 conflicts 拼接；改错故障：冲突数量丢失。
// INV-10 空态一句话：守住位置 rows 长度判断；改错故障：空报告渲染出空容器。
// INV-11 行键迁移标识：守住位置 key；改错故障：重试后列表项复用错行。
// INV-12 路径可悬停：守住位置 title 属性；改错故障：截断路径无法查看全貌。
// INV-13 动作仅失败可弃：守住位置 failed 且无阶段；改错故障：运行中的迁移被放弃。
// INV-14 禁用透传：守住位置 disabled；改错故障：刷新期间仍能点重试。
// INV-15 文案走 intl：守住位置 所有可见文本；改错故障：出现硬编码中文。
// INV-16 详情单行截断：守住位置 detailText 的 span；改错故障：长错误把行撑高。
// INV-17 动作右对齐：守住位置 ml-auto；改错故障：按钮挤在路径后面。
// INV-18 只呈现不拉取：守住位置 组件无数据请求；改错故障：面板自行轮询，状态双源。
//
// 模块职责：渲染来源服务器迁移报告，逐行给状态、路径、详情与重试或放弃动作。
// 状态所有权：报告数据与回调全部来自父级；组件只算派生映射与展示文本。
// 阅读顺序：状态色 → 组件签名 → 最新迁移映射 → 行详情 → 列表渲染 → 动作区。
import type {
  SourceServerMigrationReport,
  SourceServerMigrationReportRow,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getSourceMigrationPhaseMessageId,
  getSourceMigrationStatusMessageId,
} from "@/settings/sourceServerManagementPresentation.js";

// getStatusChipClassName 是状态到配色的唯一映射，改色只改这里。
// completed 用 bg-success-surface；running 用 bg-warning-surface；failed 用 bg-destructive-surface。
// abandoned 与 abandoned-diverged 共用 bg-tag 中性色，表示已收尾。
function getStatusChipClassName(
  status: SourceServerMigrationReportRow["status"],
): string {
  switch (status) {
    case "failed":
      return "bg-destructive-surface text-destructive-surface-foreground";
    case "completed":
      return "bg-success-surface text-success-surface-foreground";
    case "running":
      return "bg-warning-surface text-warning-surface-foreground";
    case "abandoned":
    case "abandoned-diverged":
      return "bg-tag text-foreground-subtle";
  }
}

// report 与 onAbandon / onRetry 全部由父级注入，组件不自行拉取。
// disabled 只影响动作按钮，不影响信息展示。
// onAbandon 与 onRetry 都带工作区路径和迁移标识。
// intl 在这里取一次，供各分支复用。
export function SourceServerMigrationReportPanel({
  report,
  onAbandon,
  onRetry,
  disabled = false,
}: {
  report: SourceServerMigrationReport;
  disabled?: boolean;
  onAbandon: (workspacePath: string, migrationId: string) => void;
  onRetry: (workspacePath: string, migrationId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // latestMigrationIdByPath 按 workspacePath 记录首个出现的 migrationId。
  // report.rows 按时间倒序给出，首个命中即最新。
  // 只有 isLatestForPath 为 true 的记录允许出现动作按钮。
  const latestMigrationIdByPath = new Map<string, string>();
  for (const row of report.rows) {
    if (!latestMigrationIdByPath.has(row.workspacePath)) {
      latestMigrationIdByPath.set(row.workspacePath, row.migrationId);
    }
  }
  // completed 分支讲 variantKeys.length 条被合并的来源线路，没有则留空。
  // detailMessageId 优先取 errorCode 映射的稳定诊断文案。
  // errorCode 未覆盖时退回 getSourceMigrationPhaseMessageId。
  // errorCode 与 phase 都没有才用 migrationDetailUnavailable。
  // conflicts.length 附在详情末尾，用中点分隔。
  // renderRowDetail 只产出文本，不渲染节点。
  const renderRowDetail = (row: SourceServerMigrationReportRow): string => {
    if (row.status === "completed") {
      // 原型完成行「已合并 N 条线路的历史」，N = 被并入 canonical 的来源线路数。
      return row.variantKeys.length > 0
        ? intl.formatMessage(
            { id: "settings.source.migrationMergedHistory" },
            { count: row.variantKeys.length },
          )
        : "";
    }
    const detailMessageId = row.errorCode
      ? row.errorCode === "workspace-task-identity-conflict"
        ? "remote.error.workspaceTaskIdentityConflict"
        : row.errorCode === "workspace-config-file-conflict"
          ? "remote.error.workspaceConfigConflict"
          : row.errorCode === "workspace-migration-plan-diverged"
            ? "remote.error.workspaceMigrationPlanDiverged"
            : row.errorCode === "workspace-session-generation-changed"
              ? "remote.error.workspaceSessionGenerationChanged"
              : null
      : row.phase
        ? getSourceMigrationPhaseMessageId(row.phase)
        : null;
    const detail = detailMessageId
      ? intl.formatMessage({ id: detailMessageId })
      : intl.formatMessage({
          id: "settings.source.migrationDetailUnavailable",
        });
    return row.conflicts.length > 0
      ? `${detail} · ${intl.formatMessage(
          { id: "settings.source.migrationConflictCount" },
          { count: row.conflicts.length },
        )}`
      : detail;
  };
  // report.rows 为空时只渲染 noMigrationIssues 一句话，不渲染列表骨架。
  // 外层 div 用 px-4 pb-3 留出底部内边距，与设置页其他分区对齐。
  // 每行一个 SourceServerMigrationReportRow，key 用 migrationId。
  // flex-wrap 允许换行，窄容器下 ml-auto 动作整体下移。
  return (
    <div className="px-4 pb-3">
      {report.rows.length === 0 ? (
        <p className="py-1.5 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.source.noMigrationIssues" })}
        </p>
      ) : (
        report.rows.map((row) => {
          const isLatestForPath =
            latestMigrationIdByPath.get(row.workspacePath) === row.migrationId;
          const detailText = renderRowDetail(row);
          // showActions 只在 isLatestForPath 且状态为 failed 或 abandoned 时成立。
          // retry 对 failed 与 abandoned 两类状态都可用。
          // abandon 只对 failed 且 row.phase 为空的记录开放。
          const showActions =
            isLatestForPath &&
            (row.status === "failed" ||
              row.status === "abandoned" ||
              row.status === "abandoned-diverged");
          return (
            <div
              key={row.migrationId}
              className="flex min-w-0 flex-wrap items-center gap-2 py-1.5"
            >
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                  getStatusChipClassName(row.status),
                )}
              >
                {intl.formatMessage({
                  id: getSourceMigrationStatusMessageId(row.status),
                })}
              </span>
              <span title={row.workspacePath} className="min-w-0 truncate font-mono text-ui-sm text-foreground">
                {row.workspacePath}
              </span>
              {detailText ? (
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {detailText}
                </span>
              ) : null}
              {showActions ? (
                <span className="ml-auto flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    onClick={() => onRetry(row.workspacePath, row.migrationId)}
                  >
                    {intl.formatMessage({
                      id: "settings.source.retryMigration",
                    })}
                  </Button>
                  {row.status === "failed" && !row.phase ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive"
                      disabled={disabled}
                      onClick={() =>
                        onAbandon(row.workspacePath, row.migrationId)
                      }
                    >
                      {intl.formatMessage({
                        id: "settings.source.abandonMigration",
                      })}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })
      )}
      {/* 导出详情供客服或内部诊断工具调用，普通设置页不暴露 JSON 下载入口。 */}
    </div>
  );
}
