// INV-01 [状态所有权] 运行详情的一切事实都取自 toolCall.raw 的投影 display，本块只读不写；守住位置：display 声明与 readToolResultDisplay；改错故障：另起一份本地 run 状态会让流式刷新与卡面互相打架。
// INV-02 [失败路径] 查询错误与运行失败必须分层，failed 只在非运行且 status 为 failed 时成立；守住位置：failed 的三元比较；改错故障：把运行中的短暂失败当成终态，整卡会提前塌成错误文本。
// INV-03 [失败路径] 错误态必须丢弃旧 display，run 判定里同时排除 running 与 failed；守住位置：run 的三元与 kind 判定；改错故障：残留的旧运行数据会盖住真正的查询错误。
// INV-04 [契约] kind 必须等于 get_workflow_run 才认作运行详情；守住位置：run 的 kind 比较；改错故障：同形状的其它工具载荷会被按运行卡渲染，字段全空。
// INV-05 [资源] 折叠行摘要使用 useMemo 且依赖只有 intl 与 run；守住位置：primaryText 的 memo 与依赖数组；改错故障：依赖写上 toolCall 会让每次流式 token 都重建节点树。
// INV-06 [权衡] 有摘要就让摘要占折叠行，没有才退回步数；守住位置：summary 长度判定与两个 span 的二选一；改错故障：空串摘要会渲染成一个空白折叠行，用户看不到任何进展。
// INV-07 [契约] 步数分子是完成加失败，分母是已观测；守住位置：card.steps 的 done 与 total 两个参数；改错故障：分母误用总数会把未出现的节点算成待办，进度永远到不了头。
// INV-08 [权衡] 摘要截断交给 CSS 的 truncate，不在 JS 里切字符；守住位置：摘要 span 的 min-w-0 truncate 类；改错故障：手切字符在窄屏与宽屏都给出错误长度，还会切坏多字节文本。
// INV-09 [契约] hasDetails 只在非运行且存在错误、运行或兜底文本时为真；守住位置：hasDetails 的合取式；改错故障：运行中也允许展开，用户点开的是一份半截快照。
// INV-10 [失败路径] renderContent 在 failed 或无 run 时渲染纯文本占位；守住位置：renderContent 回调的首个 if 与占位 p；改错故障：无 display 时进入正文组件会读到 undefined 的 usage。
// INV-11 [失败路径] 占位文本按宿主错误、兜底输出、失败标签的顺序降级；守住位置：error 的或链与占位处的三元；改错故障：顺序颠倒会把英文兜底文案盖在已翻译的失败标签上。
// INV-12 [资源] renderContent 的依赖必须列全 failed、run、error、fallback、theme；守住位置：useCallback 依赖数组；改错故障：漏掉 theme 后切主题仍渲染旧代码块配色。
// INV-13 [契约] 折叠标题按 running 在抓取与已抓取两条文案间切换；守住位置：kindLabel 的 id 三元与 kindLabelOverride 短路；改错故障：覆盖值被忽略时宿主无法给同一工具起别名。
// INV-14 [契约] 失败时状态标签与悬浮提示同源于 error；守住位置：statusLabel 与 statusTooltip 的三元；改错故障：两处取值不同源会出现标签说失败、提示说别的。
// INV-15 [契约] canToggle 与 forceOpen 都必须先过 hasDetails；守住位置：两个属性的与运算；改错故障：无详情时仍可展开，展开区是一片空白。
// INV-16 [失败路径] 快照字段提示只在 refs 非空时才有回调，空数组直接传空壳；守住位置：snapshotRefs 的兜底与 onLoadFullToolCallFields 的三元；改错故障：无字段可加载仍显示提示，点击无反应。
// INV-17 [契约] terminal 由 completed、errored、stopped 三态共同决定；守住位置：GetWorkflowRunBody 的 terminal 合取链；改错故障：漏掉 stopped 会让被停的 run 一直显示在跑节点与在跑计数。
// INV-18 [契约] 停止原因经 readWorkflowRunStopReason 归一后再取文案 id；守住位置：stopReason 声明与 workflowRunStopReasonMessageId 调用；改错故障：直接拼原始原因会漏译，非枚举值还可能取到不存在的 key。
//
// 模块职责：把 get_workflow_run 结果投影成运行详情卡，先给折叠行导语，再按摘要、未知提问、错误、结果、阶段轨、花名册、健康行、状态行、日志、中断与截断提示的顺序铺开。
// 状态所有权：运行事实全部来自 toolCall 的 raw 与 output 投影，本文件只做归一化与降级，不持有也不写回任何运行状态。
// 阅读顺序：先看常量与四层状态判定，再看折叠行摘要与详情开关，随后是正文的终态判定、结果解析、日志拼装与各分支渲染顺序。
import { Gauge } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import {
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowTokenCount } from "@/lib/workflowObservationFormat.js";
import { WorkflowRunSubagentRoster } from "@/ToolCallBlocks/renderers/get-workflow-run-roster.js";
import {
  WorkflowRunHealthLine,
  WorkflowRunPhaseTrack,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// [资源] 图标常量提到模块作用域，避免每次渲染新建一个 Gauge 元素。
// [权衡] 尺寸与颜色类写死在这里，与 ToolLayout 的图标槽位约定保持一致。
// [契约] 颜色用 foreground-subtle 而不是主前景，保证折叠行的视觉重心落在文字上。
// [失败路径] 改成在组件内联创建会让 icon 身份每帧变化，触发图标无谓重挂。
const ICON = <Gauge className="size-4 shrink-0 text-foreground-subtle" />;

export function GetWorkflowRunToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  // [状态所有权] display 是本文件唯一的数据入口，后续所有分支都由它派生。
  // [契约] running 取 context 的 isRunning，而不是从 display 的 status 反推：抓取首帧两者并不同步。
  // [失败路径] 查询错误与运行失败被分成两层，failed 只看 status 是否 failed 且已停止运行。
  // [并发] 首帧仍 running 时即便 status 已是 failed 也不认错，避开流式更新中的抖动。
  // [权衡] 失败判定不接受 display，因为失败可能根本没有可解析的 display。
  // [失败路径] 若把 failed 写成对错误文本判空，任何带警告的失败都会被当成正常。
  const display = readToolResultDisplay(toolCall.raw);
  const running = context.isRunning;
  // 查询错误与 run 执行失败是两个状态层级；错误查询不能继续展示旧 display。
  const failed = !running && toolCall.status === "failed";
  // [契约] run 是三重叠条件：已停、未失败、kind 匹配，缺一不可。
  // [失败路径] 排除 running 是为了不在抓取过程中把上一份 display 当成本次结果。
  // [失败路径] 排除 failed 是为了让错误态彻底遮蔽旧运行数据。
  // [契约] fallback 只接受字符串 output 并去掉首尾空白，其它形态一律 undefined。
  // [失败路径] error 的取值顺序是宿主错误、兜底输出、已翻译的失败标签，逐级降级。
  // [权衡] 既无 display 也无 output 时仍给出失败标签，好过留一行空白。
  const run = !running && !failed && display?.kind === "get_workflow_run" ? display : undefined;
  const fallback = typeof toolCall.output === "string" ? toolCall.output.trim() : undefined;
  const failureLabel = intl.formatMessage({ id: "chat.toolCall.status.failed" });
  const error = context.errorText || fallback || failureLabel;
  // [资源] 折叠行的节点树用 useMemo 缓存，依赖只列 intl 与 run。
  // [并发] 流式阶段 run 每帧都是新对象，memo 的命中率取决于 display 投影是否稳定。
  // [契约] 摘要存在时优先渲染摘要，并挂 workflow-run-summary-line 供测试定位。
  // [权衡] 摘要为空串与 undefined 走同一条步数分支，避免出现空白折叠行。
  // [契约] 名称缺省时退回 fallbackName 文案，不让标题位空掉。
  // [失败路径] 若 memo 依赖漏掉 run，切换 run 后折叠行会停在上一份摘要。
  const primaryText = useMemo(
    () =>
      run ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">
            {run.label ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" })}
          </span>
          <span aria-hidden>·</span>
          {/*
            有那句摘要就让它占住折叠行：一句「在第 2 / 4 个阶段、5 步已结算、2 个在跑」比
            「5/7 步」回答了更多问题。截断交给 CSS（truncate），不在这里切字符——切出来的
            半句话在窄屏和宽屏上都是错的长度。情势上线前的老载荷没有摘要，仍按步数画。
          */}
          {run.summary === undefined || run.summary.length === 0 ? (
            <span className="shrink-0 tabular-nums">
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.card.steps" },
                {
                  done: run.usage.nodesCompleted + run.usage.nodesFailed,
                  total: run.usage.nodesObserved,
                },
              )}
            </span>
          ) : (
            <span className="min-w-0 truncate" data-testid="workflow-run-summary-line">
              {run.summary}
            </span>
          )}
        </span>
      ) : undefined,
    [intl, run],
  );
  // [契约] hasDetails 决定是否挂 renderContent，也决定能否展开与是否强制展开。
  // [契约] canToggle 与 context 的开关取与，宿主仍可整体禁用展开。
  // [契约] forceOpen 同样先过 hasDetails，不存在无内容却被强制展开的组合。
  // [失败路径] renderContent 的首个分支覆盖 failed 与无 run 两种情形，统一渲染占位段落。
  // [失败路径] 占位段落的 testid 与正文容器相同，测试按状态断言不会因分支而失配。
  // [资源] 回调依赖列全 failed、run、error、fallback 与 theme，避免闭包读到旧值。
  const hasDetails = !running && (failed || run !== undefined || Boolean(fallback));
  const renderContent = useCallback(() => {
    if (failed || !run)
      return (
        <p
          data-testid="workflow-status-body"
          className="mb-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground-subtle"
        >
          {failed ? error : fallback}
        </p>
      );
    return <GetWorkflowRunBody display={run} theme={context.theme} />;
  }, [failed, run, error, fallback, context.theme]);
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: running
              ? "chat.toolCall.workflow.getRun.fetching"
              : "chat.toolCall.workflow.getRun.fetched",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        isRunning={running}
        showFailureStatus={failed}
        statusLabel={failed ? failureLabel : undefined}
        statusTooltip={failed ? error : undefined}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        renderContent={hasDetails ? renderContent : undefined}
        title={toolCall.title}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}

// [契约] 正文组件只接收已归一化的 display 与主题，不再回读工具调用。
// [契约] terminal 由 completed、errored、stopped 三态并集得出，其余都算进行中。
// [失败路径] 停止原因统一经 readWorkflowRunStopReason 归一，非终态通常得到 undefined。
// [契约] 令牌数先经 formatWorkflowTokenCount 缩写，再套用 usage.tokens 模板。
// [权衡] 令牌行无论终态与否都渲染，它是这张卡里唯一恒定存在的计量。
// [契约] 主题从外部传入而非取自上下文，代码块与全站主题保持同源。
function GetWorkflowRunBody({
  display,
  theme,
}: {
  display: ToolCallGetWorkflowRunDisplay;
  theme: ToolCallBlockRenderContext["theme"];
}) {
  const { intl } = useZCodeIntl();
  const terminal =
    display.status === "completed" || display.status === "errored" || display.status === "stopped";
  const stopReason = readWorkflowRunStopReason(display);
  const tokens = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.usage.tokens" },
    { tokens: formatWorkflowTokenCount(display.usage.spentTokens) },
  );
  // [失败路径] 结果解析放在 try 里，非 JSON 文本不让异常冒到渲染期。
  // [契约] 只有解析出对象或数组才格式化，字符串与数字仍按原文排版。
  // [资源] 缩进两级格式化在渲染前一次完成，不进入 JSX 内部重复计算。
  // [契约] 日志缺年龄时只留正文：`GetWorkflowRunToolCallBlock` 绝不编造「刚刚」。
  // [失败路径] 年龄以快照时刻为基准计算，用当前时刻会让旧快照的日志越看越新。
  // [契约] 空行在拼接后过滤，末端不留多余换行。
  let json: string | undefined;
  if (display.result !== undefined) {
    try {
      const value: unknown = JSON.parse(display.result);
      if (value !== null && typeof value === "object") json = JSON.stringify(value, null, 2);
    } catch {
      /* 普通文本结果沿用正文排版。 */
    }
  }
  const logs = display.logTail
    .map((entry) => {
      // 事件落 journal 的时刻有则前缀年龄，没有就只剩正文：情势上线前的 journal 没有这一列，
      // 而一个编出来的「刚刚」比没有年龄更糟。年龄一律对快照时刻算。
      const age = formatWorkflowAge(display.generatedAt, entry.at);
      const prefix =
        age === undefined
          ? ""
          : `${intl.formatMessage({ id: "chat.toolCall.workflow.getRun.age" }, { age })}  `;
      return `${prefix}${entry.message}`;
    })
    .filter((line) => line.trim())
    .join("\n");
  return (
    <div className="mb-2 min-w-0 space-y-2" data-testid="workflow-status-body">
      {/*
        那一句由工具装配好的摘要放在最前：它是整张卡的导语，下面的阶段轨、花名册和健康行
        都是它的展开。老载荷没有它，卡就从第一件事（结果 / 错误）开始。
      */}
      {display.summary === undefined || display.summary.length === 0 ? null : (
        <p className="break-words text-ui-base text-foreground" data-testid="workflow-run-summary">
          {display.summary}
        </p>
      )}
      {/*
        两处「把不知道说出口」之一：这个会话不持有这个 run，停驻的问题只活在提问进程的内存里，
        看不见不等于没有。沉默会被读成「没人在等回答」。
      */}
      {display.health?.pendingQuestionsKnown === false ? (
        <p
          className="break-words text-ui-sm text-warning"
          data-testid="workflow-run-questions-unknown"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.questionsUnknown" })}
        </p>
      ) : null}
      {display.error ? (
        <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-destructive">
          {display.error.code}: {display.error.message}
        </p>
      ) : null}
      {display.status === "completed" && display.result ? (
        json ? (
          <CodeBlock
            code={json}
            language="json"
            appTheme={theme}
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            wrapLongLines
          >
            <CodeBlockHeader language="json" className="pl-3 pr-2 pt-2" />
          </CodeBlock>
        ) : (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground">
            {display.result}
          </p>
        )
      ) : null}
      {display.phases === undefined ? null : (
        <WorkflowRunPhaseTrack
          generatedAt={display.generatedAt}
          phases={display.phases}
          terminal={terminal}
        />
      )}
      {display.subagents === undefined ? null : (
        <WorkflowRunSubagentRoster
          generatedAt={display.generatedAt}
          subagents={display.subagents}
        />
      )}
      {display.health === undefined ? null : (
        <WorkflowRunHealthLine
          generatedAt={display.generatedAt}
          health={display.health}
          terminal={terminal}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-ui-sm text-foreground-subtlest">
        <span className={RUN_STATUS_TEXT[display.status]}>
          {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${display.status}` })}
        </span>
        {stopReason ? (
          <span data-testid="workflow-run-stop-reason">
            {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
          </span>
        ) : null}
        <span aria-hidden>·</span>
        {!terminal ? (
          <>
            <span>
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.card.steps" },
                {
                  done: display.usage.nodesCompleted + display.usage.nodesFailed,
                  total: display.usage.nodesObserved,
                },
              )}
            </span>
            <span aria-hidden>·</span>
            <span>
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.getRun.runningNodes" },
                { count: display.usage.nodesRunning },
              )}
            </span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span>{tokens}</span>
      </div>
      {display.status !== "completed" && logs ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
          {logs}
        </pre>
      ) : null}
      {display.possiblyInterrupted ? (
        <p className="text-ui-sm text-warning">
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.interruptedHint" })}
        </p>
      ) : null}
      {display.truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {/* 这张卡被裁掉的是花名册 / 阶段 / 日志的行，不是诊断——共用 create_workflow 的
              「省略了部分诊断」会说错是什么被省略了。 */}
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
