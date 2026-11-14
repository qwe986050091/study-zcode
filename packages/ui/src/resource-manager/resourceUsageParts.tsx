// INV-01 双层条顺序：守住位置 系统条在品牌条之前；改错故障：自身占用被整机占用遮住。
// INV-02 比例越界：守住位置 宽度值来源；改错故障：进度条溢出容器。
// INV-03 第二编码：守住位置 图例文字；改错故障：仅靠颜色区分，色觉障碍用户无法识别。
// INV-04 无障碍描述：守住位置 图像角色与标签；改错故障：读屏只念出两个数字。
// INV-05 未采样占位：守住位置 采样判断；改错故障：未采样显示为零，误导用户。
// INV-06 提示条件：守住位置 未采样时才给提示；改错故障：正常值也挂提示。
// INV-07 指标分派：守住位置 CPU 与内存格式化分支；改错故障：数字单位与指标不符。
// INV-08 列名同步：守住位置 表头与行共用列模板；改错故障：表头与数据错列。
// INV-09 分组标题：守住位置 截断容器；改错故障：长进程名撑破面板。
// INV-10 计数来源：守住位置 分组进程数；改错故障：徽标数与实际行数不一致。
// INV-11 展开语义：守住位置 展开属性；改错故障：读屏不知道分组是否展开。
// INV-12 空态：守住位置 展开且无进程分支；改错故障：空分组展开后没有任何说明。
// INV-13 图标语义：守住位置 箭头隐藏标记；改错故障：装饰图标被朗读。
// INV-14 行键：守住位置 进程标识；改错故障：重采样后行状态错位。
// INV-15 分组标识：守住位置 分组数据属性；改错故障：自动化无法定位具体分组。
// INV-16 子标签：守住位置 非基础分组的标签行；改错故障：基础进程也显示分组名。
// INV-17 样式合并：守住位置 类名合并顺序；改错故障：调用方样式被覆盖。
// INV-18 纯展示：守住位置 组件内无状态；改错故障：重采样时组件自行缓存旧值。
//
// 模块职责：渲染资源管理器的指标卡、分组列表与进程行，只做格式化与布局。
// 状态所有权：无组件状态；分组、展开状态与文案全部由上层传入。
// 阅读顺序：常量与类型 → 指标卡 → 分组列表 → 进程行。
/**
 * 资源管理器 CPU / 内存 tab 的展示零件：双层指标卡、分组列表、进程行。
 * 只做格式化与布局，不持有任何指标状态。
 */
import { ChevronRight } from "lucide-react";
import type { ResourceUsageProcess } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { formatBytes, formatPercent, type ResourceUsageGroupView } from "./resourceUsageView.js";

// 未采样占位：采集不到的数值统一显示破折号，而不是零。
// 显示零会被误读为真实占用。
//
export const UNSAMPLED_PLACEHOLDER = "—";

// 指标类型：CPU 与内存两种，决定格式化和列名。
// UsageMetric 的两个取值同时是 UsageGroupProps.metric 与列名选择的输入。
//
export type UsageMetric = "cpu" | "memory";

// 指标卡属性：应用值、系统值、两个比例与两段图例文案。
// 文案由调用方提供，组件不读国际化。
//
interface UsageMeterProps {
  testId: string;
  label: string;
  appValue: string;
  systemValue: string;
  appPercent: number;
  systemPercent: number;
  appLabel: string;
  systemLabel: string;
}

/** 双层进度条：灰色 = 整机总占用，brand = ZCode 自身占用；图例文字做颜色之外的第二编码 */
// UsageMeter 顶部显示 appValue 大数字，下方是 systemPercent 与 appPercent 两条比例条。
// systemPercent 条先渲染作底色，appPercent 条绝对定位覆盖在其上。
// 容器 role="img" 的 aria-label 把 appLabel 与 systemLabel 两段数值合成一句读屏描述。
//
export function UsageMeter({
  testId,
  label,
  appValue,
  systemValue,
  appPercent,
  systemPercent,
  appLabel,
  systemLabel,
}: UsageMeterProps) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-4" data-testid={testId}>
      <div className="text-ui-sm font-medium text-foreground-subtle">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-ui-xl font-medium" data-testid={`${testId}-app`}>
          {appValue}
        </span>
        <span className="text-ui-xs text-foreground-subtlest">{appLabel}</span>
      </div>
      <div
        className="relative mt-3 h-2 overflow-hidden rounded-sm bg-surface-hover"
        role="img"
        aria-label={`${appLabel} ${appValue}, ${systemLabel} ${systemValue}`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-foreground-subtlest/40"
          style={{ width: `${systemPercent}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-brand"
          style={{ width: `${appPercent}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-brand" aria-hidden="true" />
          {appLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-foreground-subtlest/40" aria-hidden="true" />
          {systemLabel}
          <span className="font-mono text-foreground" data-testid={`${testId}-system`}>
            {systemValue}
          </span>
        </span>
      </div>
    </div>
  );
}

// 分组属性：分组数据、指标、标题、展开状态与列名。
// columns.cpu 与 columns.memory 按 metric 二选一，表头与数据行共用同一个 columns 对象。
//
interface UsageGroupProps {
  group: ResourceUsageGroupView;
  metric: UsageMetric;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  emptyText: string;
  samplingText: string;
  columns: { process: string; pid: string; cpu: string; memory: string };
}

// 行网格：三列固定为名称、进程标识与数值列。
// 表头与数据行共用该模板，保证列对齐。
//
const ROW_GRID_CLASS = "grid grid-cols-[minmax(0,1fr)_72px_96px] items-center gap-2";

// 分组：标题行是展开按钮，右侧依次是计数徽标与汇总值。
// expanded 为 true 时先渲染 ROW_GRID_CLASS 表头，再按 group.processes 逐行渲染 ProcessRow。
// group.processes 为空时只渲染一行 emptyText，不输出表头。
// data-testid 用 group.category 拼接，标题改名不会改变测试定位。
//
export function UsageGroup({
  group,
  metric,
  title,
  expanded,
  onToggle,
  emptyText,
  samplingText,
  columns,
}: UsageGroupProps) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-card-border bg-card"
      data-testid={`resource-manager-group-${group.category}`}
    >
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-hover"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-foreground-subtle transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">{title}</span>
        <span className="rounded-sm bg-tag px-1.5 text-ui-xs text-foreground-subtle">
          {group.processCount}
        </span>
        <span className="w-24 text-right font-mono text-ui-sm text-foreground-subtle">
          {metric === "cpu" ? formatPercent(group.cpuPercent) : formatBytes(group.memoryBytes)}
        </span>
      </button>
      {expanded ? (
        group.processes.length === 0 ? (
          <div className="border-t border-border px-3 py-2 text-ui-sm text-foreground-subtlest">
            {emptyText}
          </div>
        ) : (
          <div className="border-t border-border">
            <div
              className={cn(
                ROW_GRID_CLASS,
                "h-7 border-b border-border px-3 text-ui-xs font-medium text-foreground-subtle",
              )}
            >
              <div>{columns.process}</div>
              <div className="text-right">{columns.pid}</div>
              <div className="text-right">{metric === "cpu" ? columns.cpu : columns.memory}</div>
            </div>
            {group.processes.map((process) => (
              <ProcessRow
                key={process.pid}
                process={process}
                metric={metric}
                samplingText={samplingText}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

// ProcessRow 名称列用 truncate 截断，并给内层 div 挂 title={process.name} 显示全名。
// process.category 不是 "base" 时在名称下方补 groupLabel 一行。
// 数值为 null 时显示 UNSAMPLED_PLACEHOLDER，title 挂在整格而不是数字上。
//
function ProcessRow({
  process,
  metric,
  samplingText,
}: {
  process: ResourceUsageProcess;
  metric: UsageMetric;
  samplingText: string;
}) {
  return (
    <div
      className={cn(
        ROW_GRID_CLASS,
        "min-h-8 border-b border-border px-3 text-ui-sm last:border-b-0",
      )}
      data-testid="resource-manager-process-row"
      data-process-name={process.name}
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground" title={process.name}>
          {process.name}
        </div>
        {process.category !== "base" ? (
          <div className="truncate text-ui-xs text-foreground-subtlest" title={process.groupLabel}>
            {process.groupLabel}
          </div>
        ) : null}
      </div>
      <div className="text-right font-mono text-foreground-subtle">{process.pid}</div>
      <div
        className="text-right font-mono text-foreground-subtle"
        title={process.sampled ? undefined : samplingText}
      >
        {!process.sampled
          ? UNSAMPLED_PLACEHOLDER
          : metric === "cpu"
            ? formatPercent(process.cpuPercent)
            : formatBytes(process.memoryBytes)}
      </div>
    </div>
  );
}
