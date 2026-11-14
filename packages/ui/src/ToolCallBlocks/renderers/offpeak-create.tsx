// INV-01 工具名归一化：守住位置 去符号小写；改错故障 大小写差异漏判。
// INV-02 三处名称都参与判定：守住位置 任一匹配；改错故障 旧事件缺字段漏判。
// INV-03 非对象一律无效：守住位置 类型守卫；改错故障 数组被当任务。
// INV-04 字符串先尝试解析：守住位置 首字符判断；改错故障 普通文本被解析。
// INV-05 解析失败静默回退：守住位置 捕获分支；改错故障 卡片渲染抛错。
// INV-06 缺任务标识即无效：守住位置 非空判断；改错故障 卡片无法定位任务。
// INV-07 标题去空白后才采用：守住位置 修剪；改错故障 出现空白标题。
// INV-08 位次需正有限数：守住位置 三条件；改错故障 出现零或小数位次。
// INV-09 多候选按序探测：守住位置 遍历顺序；改错故障 旧字段遮蔽新字段。
// INV-10 未命中原样返回空：守住位置 末尾返回；改错故障 调用方拿到半成品。
// INV-11 嵌套任务优先：守住位置 类型判断；改错故障 外层字段覆盖内层。
// INV-12 位次快照不订阅：守住位置 静态数据；改错故障 历史回看出现实时位次。
// INV-13 缺位次回退文案：守住位置 空值分支；改错故障 第二行空白。
// INV-14 标题缺省有回退：守住位置 空值合并；改错故障 卡片无标题。
// INV-15 绑定提示固定追加：守住位置 拼接；改错故障 用户误以为任务独立运行。
// INV-16 打开入口缺失即禁用：守住位置 布尔判断；改错故障 点击无反应。
// INV-17 打开时带任务标识：守住位置 回调参数；改错故障 跳转到错误任务。
// INV-18 卡片标识来自共享常量：守住位置 测试常量；改错故障 测试与实现漂移。
//
// 模块职责：闲时创建工具调用的轮尾卡片与输出摘要解析。
// 状态所有权：摘要为创建时快照，不订阅后续任务状态。
// 阅读顺序：先看工具名与类型守卫，再看摘要解析，最后看卡片渲染。
import { MoonIcon } from "lucide-react";
import { TID_OFFPEAK_CREATE_CARD, TID_OFFPEAK_CREATE_OPEN } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// OffPeakCreate 的静态轮尾卡（cron-create 兄弟实现，样式契约一致）。
// 位次是创建时快照（取自取号返回），不订阅后续状态——历史回看不产生过期活数据。

export interface OffPeakCreateTaskSummary {
  offPeakTaskId?: string;
  title?: string;
  status?: string;
  queuePosition?: number;
}

// normalizeToolName 对非字符串入参直接返回空串，调用方无需再判类型。
// 先 toLowerCase 统一大小写，保证 OffPeakCreate 各种写法可比。
// 再用正则 [^a-z0-9] 剥掉非字母数字字符，空格与连字符都会被移除。
// 归一结果只参与 offpeakcreate 工具名比较，不回写 toolCall 任何字段。
// 不做 trim 以外的其他归一，避免不同工具名被折叠成同一个键。
function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOffPeakCreateToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some(
    (value) => normalizeToolName(value) === "offpeakcreate",
  );
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeOutputCandidate(value: unknown): unknown {
  return typeof value === "string" ? parseJsonString(value) : value;
}

// 字符串候选先交给 parseJsonString 解析，解析失败时原样返回。
// 解析结果不是 plain object 时返回 null，数组与 null 都算无效。
// offPeakTaskId 缺失时返回 null，卡片回退成普通工具行。
// title 与 status 只取 trim 后的非空字符串，其余一律留 undefined。
// queuePosition 必须是 Number.isFinite 且大于 0 的数，否则留 undefined。
export function readOffPeakCreateTaskOutputSummary(
  value: unknown,
): OffPeakCreateTaskSummary | null {
  const normalizedValue = normalizeOutputCandidate(value);
  if (!isPlainRecord(normalizedValue)) {
    return null;
  }

  const task = isPlainRecord(normalizedValue.task) ? normalizedValue.task : normalizedValue;
  const offPeakTaskId =
    typeof task.offPeakTaskId === "string" && task.offPeakTaskId.trim()
      ? task.offPeakTaskId.trim()
      : undefined;
  const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : undefined;
  // 卡片必须能定位任务；缺 id 视为无效输出，回退普通工具行。
  if (!offPeakTaskId) {
    return null;
  }
  const status = typeof task.status === "string" && task.status.trim() ? task.status : undefined;
  const queuePosition =
    typeof task.queuePosition === "number" &&
    Number.isFinite(task.queuePosition) &&
    task.queuePosition > 0
      ? task.queuePosition
      : undefined;

  return {
    offPeakTaskId,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(queuePosition !== undefined ? { queuePosition } : {}),
  };
}

// readOffPeakCreateTaskSummary 先要求 toolCall.raw 是 plain record，否则只试 output。
// candidates 按 output 到 content 的固定顺序逐个探测，顺序变化会影响命中结果。
// 任一候选被 readOffPeakCreateTaskOutputSummary 解析成功即返回，不再看后面的候选。
// 所有候选都解析失败时返回 null，由上层决定回退展示。
// 这里只读 toolCall 里的历史快照，不订阅 offPeakTaskId 对应的实时状态。
export function readOffPeakCreateTaskSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): OffPeakCreateTaskSummary | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawResult = isPlainRecord(raw?.result) ? raw.result : null;
  const candidates = [
    toolCall.output,
    raw?.rawOutput,
    raw?.output,
    rawResult?.content,
    rawResult?.display,
    raw?.result,
    toolCall.content,
  ];

  for (const candidate of candidates) {
    const summary = readOffPeakCreateTaskOutputSummary(candidate);
    if (summary) {
      return summary;
    }
  }

  return null;
}

/** 卡片第二行：创建时位次快照优先，缺位次回退「已加入闲时队列」文案。 */
// queuePosition 为正数时用 queuedAt 文案报出具体位次。
// queuePosition 缺失时 statusText 退回「已加入闲时队列」，不显示位置。
// 位次判据与读取侧一致：queuePosition 必须是大于 0 的数。
// 两条文案都走 intl.formatMessage，不在组件里硬编码中文。
export function describeOffPeakCardStatus(
  task: OffPeakCreateTaskSummary,
  intl: IntlInstance,
): string {
  if (typeof task.queuePosition === "number" && task.queuePosition > 0) {
    return intl.formatMessage(
      { id: "offPeak.chatCreated.queuedAt" },
      { position: task.queuePosition },
    );
  }
  return intl.formatMessage({ id: "offPeak.chatCreated.queued" });
}

export function OffPeakCreateTaskCard({
  task,
  onOpenAutomationsMain,
}: {
  task: OffPeakCreateTaskSummary;
  onOpenAutomationsMain?: (automationId?: string, automationTab?: "scheduled" | "idle") => void;
}) {
  const { intl } = useZCodeIntl();
  const title = task.title ?? intl.formatMessage({ id: "offPeak.chatCreated.defaultTitle" });
  // 会话内创建的任务绑定并运行在当前会话；位次快照后追加一句提示。
  const statusLine = `${describeOffPeakCardStatus(task, intl)} · ${intl.formatMessage({
    id: "offPeak.chatCreated.boundHint",
  })}`;
  const canOpenAutomations = Boolean(onOpenAutomationsMain);

  return (
    <div
      data-testid={TID_OFFPEAK_CREATE_CARD}
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <MoonIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">{statusLine}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_OFFPEAK_CREATE_OPEN}
          className={cn(
            "h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground",
            !canOpenAutomations && "opacity-50",
          )}
          disabled={!canOpenAutomations}
          onClick={() => onOpenAutomationsMain?.(task.offPeakTaskId, "idle")}
        >
          <span>{intl.formatMessage({ id: "offPeak.chatCreated.open" })}</span>
        </Button>
      </div>
    </div>
  );
}
