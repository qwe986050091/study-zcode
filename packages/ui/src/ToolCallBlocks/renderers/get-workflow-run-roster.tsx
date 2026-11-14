// INV-01 相位词永远在场：守住位置 状态单元格；改错故障 仅靠颜色表达状态。
// INV-02 颜色只是第二通道：守住位置 语义类映射；改错故障 色弱用户无法区分。
// INV-03 停驻视为需要注意：守住位置 状态色；改错故障 等人回答显示成空闲。
// INV-04 空花名册不占位：守住位置 长度早退；改错故障 卡片出现空白块。
// INV-05 匿名不留兜底名：守住位置 空值分支；改错故障 出现占位名字。
// INV-06 行身份用站点与序号：守住位置 键拼接；改错故障 同名子代理状态串位。
// INV-07 任务行从属上一行：守住位置 缩进类；改错故障 被读成新事实行。
// INV-08 读数缺席不补零：守住位置 条件渲染；改错故障 未知被显示为零 token。
// INV-09 在飞判定看读数在场：守住位置 多字段或运算；改错故障 执行中的行只显示相位词。
// INV-10 停驻先说出问题标识：守住位置 分支顺序；改错故障 停驻行没有可行动信息。
// INV-11 等待先说原因再说时长：守住位置 顺序注释与拼接；改错故障 两个时长含义混淆。
// INV-12 等待原因缺省则不占格子：守住位置 空数组返回；改错故障 出现空文案。
// INV-13 重试时长按需追加：守住位置 可选判断；改错故障 无退避时显示零时长。
// INV-14 老日志回退已结算读数：守住位置 空数组判断；改错故障 行里只有相位词。
// INV-15 最后工具名必填：守住位置 直接取值；改错故障 出现未定义文案。
// INV-16 工具目标可为空：守住位置 过滤条件；改错故障 名后残留多余空格。
// INV-17 已结算为零不占格子：守住位置 双零早退；改错故障 显示零步。
// INV-18 单复数走不同消息键：守住位置 三元选择；改错故障 英文单复数错乱。
//
// 模块职责：把工作流运行的子代理花名册渲染成一行一人、按相位分叉的活动描述。
// 状态所有权：无状态；子代理读数与生成时间全部由调用方传入。
// 阅读顺序：先看状态色与行结构，再看在飞判定，最后看三类活动单元格。
/**
 * GetWorkflowRun 工具卡的**子代理花名册**（情势截面的另一半，阶段轨与健康行在
 * get-workflow-run-situation.tsx）。
 *
 * 一行的读法与模型面
 * （apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts）同一句话：
 * 「谁 · 在哪 · 什么相位 · 在哪个阶段 · 正在做什么 · 花了多少 token」，其中「正在做什么」
 * 按相位分叉——在跑的说它的进度与最后一个工具，在等的说等什么、还要等多久，停驻的说等哪个
 * 问题。这正是这张卡存在的理由：一眼看出谁卡住了。
 *
 * 载荷是**扁平行**（没有 `currentAsk` 嵌套），所以「有没有一次在飞的 ask」由那几个读数是否
 * 在场推出来；缺席一律不画，绝不用 0 顶替不知道。
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatWorkflowAge,
  formatWorkflowDuration,
  formatWorkflowTokenCount,
} from "@/lib/workflowObservationFormat.js";
import {
  SITUATION_BLOCK_CLASS,
  SITUATION_ROW_CLASS,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";

type WorkflowRunSubagentView = NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>[number];
type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/**
 * 相位词的语义色。词永远在场，颜色只是第二通道（DESIGN：状态不能只靠颜色）：
 * 在动的用活动色 warning，等待与终态未完结居中，完成 success、失败 destructive。
 * `parked` 也用活动色——它在等一个人回答，是需要注意的状态，不是安静的空闲。
 */
// 相位词始终显示，颜色仅作第二通道，保证状态不只靠颜色传达。
// executing 与 parked 都用 text-warning 活动色，因为停驻在等人回答。
// done 取 text-success，failed 取 text-destructive。
// idle、waiting 与 unfinished 统一取 text-foreground-subtle 弱化色。
const SUBAGENT_STATE_TEXT: Record<WorkflowRunSubagentView["state"], string> = {
  idle: "text-foreground-subtlest",
  executing: "text-warning",
  waiting: "text-foreground-subtle",
  parked: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  unfinished: "text-foreground-subtle",
};

// subagents.length === 0 时整块返回 null，不渲染空列表。
// 每行 key 由站点与序号拼成，避免同名子代理互相顶替。
// 缺少名称的子代理直接留空，不合成 "subagent" 之类的兜底名。
// 子任务行按 depth 缩进，用缩进表达与父代理的从属关系。
export function WorkflowRunSubagentRoster({
  subagents,
  generatedAt,
}: {
  subagents: readonly WorkflowRunSubagentView[];
  generatedAt: number | undefined;
}) {
  const { intl } = useZCodeIntl();
  // 空花名册什么也不画：还没造出子代理是一件不需要一整块区域来说的事。
  if (subagents.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-subagents">
      {subagents.map((subagent) => {
        const activity = subagentActivity(subagent, generatedAt, intl.formatMessage);
        return (
          <div className="min-w-0 space-y-0.5" key={`${subagent.siteId}@${subagent.ordinal}`}>
            <div className={`${SITUATION_ROW_CLASS} text-ui-sm`}>
              {/* 匿名子代理不合成兜底名：留空，地址仍然把它认出来。 */}
              {subagent.name === undefined ? null : (
                <span className="min-w-0 break-words text-foreground">{subagent.name}</span>
              )}
              <span className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {subagent.siteId}@{subagent.ordinal}
              </span>
              <span className={`shrink-0 ${SUBAGENT_STATE_TEXT[subagent.state]}`}>
                {intl.formatMessage({ id: `${I18N_PREFIX}subagent.state.${subagent.state}` })}
              </span>
              {subagent.phaseName === undefined ? null : (
                <span className="min-w-0 break-words text-foreground-subtle">
                  {intl.formatMessage(
                    { id: `${I18N_PREFIX}subagent.phase` },
                    { name: subagent.phaseName },
                  )}
                </span>
              )}
              {activity.map((cell) => (
                <span className="min-w-0 break-words text-foreground-subtle" key={cell}>
                  {cell}
                </span>
              ))}
              {subagent.tokens > 0 ? (
                <span className="shrink-0 tabular-nums text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.usage.tokens" },
                    { tokens: formatWorkflowTokenCount(subagent.tokens) },
                  )}
                </span>
              ) : null}
            </div>
            {subagent.instructionsHead === undefined ||
            subagent.instructionsHead.length === 0 ? null : (
              // 任务行从属于上一行，不是新的一行事实：缩进而不是另起一格。
              <p className="min-w-0 break-words pl-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: `${I18N_PREFIX}subagent.task` },
                  { task: subagent.instructionsHead },
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 那几个进度读数任意一个在场，就说明这一行背后有一次 ask（扁平载荷没有 `currentAsk` 标记）。 */
// 扁平载荷不带 currentAsk 标记，只能靠进度读数推断。
// startedAt、turn、toolCalls 等任一读数在场，即由 hasCurrentAsk() 判为在飞。
// 全部读数缺席时返回 false，走已结算分支。
function hasCurrentAsk(subagent: WorkflowRunSubagentView): boolean {
  return (
    subagent.startedAt !== undefined ||
    subagent.turn !== undefined ||
    subagent.toolCalls !== undefined ||
    subagent.lastTool !== undefined ||
    subagent.instructionsHead !== undefined
  );
}

// state === "parked" 时先输出 parkedOn 的 qid，说明在等哪个问题。
// waiting 由 waitCells() 处理；其余在飞状态由 executingCells() 处理，各自组装单元格。
// state === "unfinished" 且有在飞读数时，单独返回 inFlightAtStop 一句。
function subagentActivity(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    // 只有 qid，没有提问时刻：卡面载荷不带 pendingQuestions，所以这一行说不出「等了多久」。
    return [formatMessage({ id: `${I18N_PREFIX}subagent.parkedOn` }, { qid: subagent.parkedOn })];
  }
  if (subagent.state === "waiting") return waitCells(subagent, generatedAt, formatMessage);
  if (subagent.state === "unfinished" && hasCurrentAsk(subagent)) {
    return [formatMessage({ id: `${I18N_PREFIX}subagent.inFlightAtStop` })];
  }
  if (hasCurrentAsk(subagent)) {
    const cells = executingCells(subagent, generatedAt, formatMessage);
    // 一次 ask 在飞但一个读数也没有（老 journal）：退回已结算步数，别留下一行只有相位词。
    return cells.length > 0 ? cells : settledCells(subagent, formatMessage);
  }
  return settledCells(subagent, formatMessage);
}

function executingCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  const cells: string[] = [];
  const onStep = formatWorkflowAge(generatedAt, subagent.startedAt);
  if (onStep !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.onStep` }, { age: onStep }));
  }
  if (subagent.turn !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.turn` }, { count: subagent.turn }));
  }
  if (subagent.toolCalls !== undefined) {
    cells.push(
      formatMessage(
        {
          id: `${I18N_PREFIX}subagent.${subagent.toolCalls === 1 ? "toolCallsOne" : "toolCalls"}`,
        },
        { count: subagent.toolCalls },
      ),
    );
  }
  if (subagent.lastTool !== undefined) {
    const { name, target, at } = subagent.lastTool;
    const age = formatWorkflowAge(generatedAt, at);
    cells.push(
      [
        formatMessage({ id: `${I18N_PREFIX}subagent.lastTool` }, { name }),
        target,
        age === undefined ? undefined : formatMessage({ id: `${I18N_PREFIX}age` }, { age }),
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" "),
    );
  }
  return cells;
}

function waitCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  if (subagent.waitCause === undefined) return [];
  const cells = [
    formatMessage({
      id: `${I18N_PREFIX}subagent.${subagent.waitCause === "slot" ? "waitingSlot" : "waitingBackoff"}`,
    }),
  ];
  // 「等了多久」贴着原因，「还要等多久」收尾：两个时长挨在一起时读者分不清哪个是哪个。
  const waited = formatWorkflowAge(generatedAt, subagent.waitSince);
  if (waited !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.waitedFor` }, { age: waited }));
  }
  if (subagent.retryAfterMs !== undefined) {
    cells.push(
      formatMessage(
        { id: `${I18N_PREFIX}subagent.retryIn` },
        { duration: formatWorkflowDuration(subagent.retryAfterMs) },
      ),
    );
  }
  return cells;
}

function settledCells(subagent: WorkflowRunSubagentView, formatMessage: FormatMessage): string[] {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return [];
  const cells = [
    formatMessage(
      { id: `${I18N_PREFIX}subagent.${subagent.stepsSettled === 1 ? "stepsOne" : "steps"}` },
      { count: subagent.stepsSettled },
    ),
  ];
  if (subagent.stepsFailed > 0) {
    cells.push(
      formatMessage({ id: `${I18N_PREFIX}subagent.stepsFailed` }, { count: subagent.stepsFailed }),
    );
  }
  return cells;
}
