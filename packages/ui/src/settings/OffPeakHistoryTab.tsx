// INV-01 纯展示：守住位置 组件主体；改错故障：渲染期改写任务或发起删除。
// INV-02 一行一次执行：守住位置 表格结构；改错故障：续跑分段各占一行，历史重复。
// INV-03 未执行即空态：守住位置 开始时间判断；改错故障：纯排队任务显示一条零时长记录。
// INV-04 删除即空态：守住位置 历史删除标记；改错故障：已删记录在下一次渲染又出现。
// INV-05 状态映射全量：守住位置 状态解析；改错故障：未知状态读到未定义的样式键。
// INV-06 终结判定：守住位置 结束时间来源；改错故障：已完成任务时长仍随时间增长。
// INV-07 时长下限：守住位置 分钟计算；改错故障：刚启动显示零分钟。
// INV-08 相对行高：守住位置 表格行高；改错故障：大字号下内容被固定行盒裁切。
// INV-09 横向可滚：守住位置 外层容器；改错故障：窄容器把表格压到不可读。
// INV-10 指令截断：守住位置 指令列；改错故障：长指令撑破列宽，其他列被挤出。
// INV-11 全文可达：守住位置 指令标题；改错故障：截断后无法查看全文。
// INV-12 圆点装饰：守住位置 状态圆点；改错故障：读屏重复朗读状态。
// INV-13 文案同源：守住位置 状态文案键；改错故障：圆点颜色与文字语义不符。
// INV-14 跳转门控：守住位置 会话标识与回调；改错故障：无会话时出现无效跳转项。
// INV-15 分隔门控：守住位置 分隔线条件；改错故障：只有单项时多出一条分隔线。
// INV-16 删除门控：守住位置 删除回调；改错故障：无删除能力仍显示危险操作。
// INV-17 浮层对齐：守住位置 菜单偏移；改错故障：浮层向表格内侧偏移，遮挡操作。
// INV-18 空态统一：守住位置 空态组件；改错故障：空格式与自动化其他页不一致。
//
// 模块职责：OffPeakHistoryTab 的单行汇总表与行操作菜单。
// 状态所有权：task / onOpenSession / onDelete 由外部提供，本组件无内部状态。
// 阅读顺序：状态映射 → 空态判定 → 时长计算 → 表头 → 行与菜单。
/* 闲时任务 History tab（spec §5 / Figma 4866-2819 · 4866-3106 空态）：
   一行汇总一次完整执行（3h 续跑分段对用户透明，D30-6）：Instructions / Triggered /
   Status / Duration + 行菜单 Go to session / Delete；无执行记录 → 「No history yet.」 */
import { isOffPeakTerminalStatus, type ZCodeOffPeakTask } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import {
  AutomationExternalLinkIcon,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

// 状态用「圆点 + 彩色文字」呈现（Scheduled 历史表密度规格）。
const STATUS_INDICATOR_CLASS = {
  succeeded: { dot: "bg-success", text: "text-success" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  skipped: { dot: "bg-foreground-subtlest", text: "text-foreground-subtle" },
  running: { dot: "bg-brand", text: "text-brand" },
} as const satisfies Record<string, { dot: string; text: string }>;

// resolveOffPeakHistoryStatus 把 ZCodeOffPeakTask.status 全量映射到 STATUS_INDICATOR_CLASS 的键（INV-05）：
// completed→succeeded、failed→failed、cancelled→skipped；其余状态一律归 running，否则新增状态会读到 undefined。
// 映射键必须与样式表键集合一致，漏一个会让 STATUS_INDICATOR_CLASS[status] 读到 undefined 并抛错。
//
export function resolveOffPeakHistoryStatus(
  task: Pick<ZCodeOffPeakTask, "status">,
): keyof typeof STATUS_INDICATOR_CLASS {
  if (task.status === "completed") return "succeeded";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "skipped";
  return "running";
}

// OffPeakHistoryTab 一行汇总一次完整执行（INV-02）：startedAt 存在才视为执行过，纯排队/暂停无历史（INV-03）；
// historyDeletedAt 有值必须回退空态（INV-04）；空态统一走 AutomationHistoryEmptyState，不自定义布局。
// 3h 续跑分段对用户透明，不展开成多行（INV-02）。
//
export function OffPeakHistoryTab({
  task,
  onOpenSession,
  onDelete,
}: {
  task: ZCodeOffPeakTask | null;
  onOpenSession?: (task: ZCodeOffPeakTask) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
}) {
  const { intl } = useZCodeIntl();
  // 执行记录 = 首段派发起跑过（startedAt 存在）；纯排队/暂停中的任务无历史。
  if (!task?.startedAt || task.historyDeletedAt !== undefined) {
    return (
      <AutomationHistoryEmptyState>
        {intl.formatMessage({ id: "offPeak.history.empty" })}
      </AutomationHistoryEmptyState>
    );
  }
  // status 只驱动样式与文案，不参与业务判断（INV-05/13）；isOffPeakTerminalStatus 为真取 endedAt；
  // 缺失时回退 Date.now()（INV-06）；未终结任务按当前时间算已运行时长，否则已完成任务的时长会继续增长。
  const status = resolveOffPeakHistoryStatus(task);
  // 表格用 overflow-x-auto 保证窄容器横向可滚（INV-09）；行高走 h-[46px] 相对值，固定行盒会裁切大字号（INV-08）；
  // 指令列 max-w-64 truncate 并用 title={task.prompt} 保留全文（INV-10/11）；
  // 状态列圆点 aria-hidden 且文字承担语义（INV-12/13）。
  //
  const endAt = isOffPeakTerminalStatus(task.status)
    ? (task.endedAt ?? Date.now())
    : Date.now();
  const durationMin = Math.max(
    1,
    Math.round((endAt - task.startedAt) / 60_000),
  );
  return (
    <div className="overflow-x-auto rounded-[8px]">
      {/* 修复原因：History 表格字号可缩放，使用相对行高避免大字号内容被固定 18px 行盒裁切。 */}
      <table className="w-full text-left text-ui-base font-normal leading-snug tracking-[-0.08px]">
        <thead className="bg-surface text-foreground-subtle">
          <tr className="h-[30px] border-b border-border">
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "offPeak.history.col.instructions" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.triggered" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.status" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.duration" })}
            </th>
            <th className="px-4 font-normal" />
          </tr>
        </thead>
        <tbody>
          <tr className="h-[46px] transition-colors hover:bg-surface-hover">
            <td
              className="max-w-64 truncate px-4 text-foreground-subtle"
              title={task.prompt}
            >
              {task.prompt}
            </td>
            <td className="whitespace-nowrap px-4 text-foreground-subtle">
              {formatDateTime(task.startedAt)}
            </td>
            <td className="px-4">
              <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "inline-block size-1.5 rounded-full",
                      STATUS_INDICATOR_CLASS[status].dot,
                    )}
                  />
                </span>
                <span className={STATUS_INDICATOR_CLASS[status].text}>
                  {intl.formatMessage({
                    id: `automations.runs.status.${status}`,
                  })}
                </span>
              </span>
            </td>
            <td className="whitespace-nowrap px-4 text-foreground-subtle">
              {intl.formatMessage(
                { id: "offPeak.history.durationMinutes" },
                { count: durationMin },
              )}
            </td>
            <td className="px-4">
              <div className="flex items-center justify-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                    >
                      <AutomationMoreHorizontalIcon
                        className="size-4"
                        aria-hidden="true"
                      />
                    </button>
                  </DropdownMenuTrigger>
                  {/* 旧版按触发器右缘对齐且沿用紧凑菜单内距，导致浮层向表格内侧偏移并少 17.5px。 */}
                  <DropdownMenuContent
                    align="start"
                    alignOffset={-10}
                    sideOffset={4}
                    collisionPadding={8}
                    className="flex w-[160px] min-w-[160px] flex-col gap-0.5 border-0 px-1 py-1.5"
                  >
                    {task.sessionId && onOpenSession ? (
                      <DropdownMenuItem
                        className="min-h-9 gap-1 rounded-md p-2 text-ui-base leading-5 tracking-[-0.18px]"
                        onSelect={() => onOpenSession(task)}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationExternalLinkIcon
                            className="size-4"
                            aria-hidden="true"
                          />
                        </span>
                        {intl.formatMessage({ id: "offPeak.goToSession" })}
                      </DropdownMenuItem>
                    ) : null}
                    {task.sessionId && onOpenSession && onDelete ? (
                      <DropdownMenuSeparator className="m-0 h-px w-full" />
                    ) : null}
                    {onDelete ? (
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-9 gap-1 p-2 text-ui-base leading-5 tracking-[-0.18px]"
                        onSelect={() => onDelete(task)}
                      >
                        <AutomationTrashIcon />
                        {intl.formatMessage({ id: "offPeak.history.delete" })}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
