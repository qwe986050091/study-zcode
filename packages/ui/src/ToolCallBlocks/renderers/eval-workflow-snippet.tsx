// INV-01 三态判定中运行中优先于失败，失败只在终态成立；守住位置：failed 计算；改错故障：开始瞬间闪红再转正常，状态标签抖动
// INV-02 片段展示必须按 kind 白名单取出，不信任任意工具结果形状；守住位置：snippet 赋值；改错故障：别的工具结果被当成片段渲染，面板内容错位
// INV-03 失败时耗时节点整体为空，不给耗时留位置；守住位置：durationNode 的 useMemo；改错故障：失败行仍显示毫秒，用户误以为执行完成
// INV-04 运行中耗时按整秒刷新，终态定格在结果毫秒；守住位置：durationText 三元链；改错故障：每 100ms 更新毫秒尾数，聊天区高频重渲染 [资源]
// INV-05 代码只在非空字符串时成立，纯空白按没有代码处理；守住位置：code 归一化；改错故障：空代码块展开后是一片空白 [失败路径]
// INV-06 响应文本优先取片段解包值，其次原始输出，最后为空；守住位置：response 的 useMemo；改错故障：失败时正文无内容，用户只能看悬停提示 [失败路径]
// INV-07 错误文本先取上层透传，再退回诊断消息逐行拼接；守住位置：error 计算；改错故障：工具层错误被诊断文本覆盖，根因丢失 [失败路径]
// INV-08 展开入口必须与各分支真实产出同构，不允许出现空面板；守住位置：hasDetails 三元链；改错故障：折叠箭头可点，展开后什么都没有
// INV-09 失败且诊断为空时，错误文本兜底进入正文；守住位置：renderContent 中 response 的传参；改错故障：失败原因只留在 tooltip，正文读不到 [权衡]
// INV-10 内容子树按运行态分键，状态切换时整棵重建；守住位置：renderContent 里的 key；改错故障：旧代码块残留，内部滚动位置错乱
// INV-11 非失败分支只渲染一个面板：运行中给代码，终态给结果；守住位置：SnippetBody 首个分支；改错故障：代码与结果同时在屏，信息互相干扰
// INV-12 失败与成功互斥，失败时不走正常结果分支；守住位置：if (!failed) 分支收口；改错故障：失败结果被当作成功值展示，状态与正文矛盾
// INV-13 失败时诊断排在结果之前，先定位再看输出；守住位置：失败返回体的段落顺序；改错故障：用户先读到截断输出，忽略编译错误 [权衡]
// INV-14 结果区高度固定上限并可滚动，长输出不撑高消息；守住位置：结果容器的 max-h-72；改错故障：超长 JSON 把会话流拉成整屏，滚动失真 [资源]
// INV-15 日志仅在存在非空行时渲染，纯空白日志不出区块；守住位置：logs 的 some 判断；改错故障：出现只有标题没有内容的空日志区
// INV-16 源码折叠在 details 内，默认收起且单独滚动；守住位置：snippet-code 的 details；改错故障：代码默认展开挤走结果，复制入口被推离视口
// INV-17 复制按钮与语言标签固定在头部，正文独立滚动；守住位置：SnippetTextPanel 的 CodeBlockHeader；改错故障：复制入口随长正文滚走 [权衡]
// INV-18 截断提示只在终态且片段标记被截断时出现；守住位置：truncated 传参与两处提示分支；改错故障：运行中就提示内容被截断，误导用户 [失败路径]
//
// 总述：本文件只做片段求值结果的展示分派，不执行代码，也不改写工具结果。
// 三态为运行中、成功、失败：运行中给代码，成功给结果，失败给诊断加输出与源码。
// 改动时先确认 hasDetails 与 SnippetBody 分支同构，再调整面板顺序与滚动上限。
import { FlaskConical } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ToolCallEvalWorkflowSnippetDisplay } from "@zcode/shared/zcode-protocol-v4";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { WorkflowDiagnosticsSection } from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";
import {
  snippetResponse,
  snippetValue,
} from "@/ToolCallBlocks/renderers/workflow-snippet-presentation.js";

// 统一定义工具图标：片段工具用烧瓶，尺寸与颜色沿用工具行规范
// [资源] 常量提到模块顶层，避免每次渲染都新建 React 元素
const ICON = <FlaskConical className="size-4 shrink-0 text-foreground-subtle" />;

/** 三态摘要不放结果预览，展开内容按执行状态排序。 */
// 片段工具卡片入口：从工具结果读出展示数据，再按三态分派内容
// 组件不持有服务端事实，所有状态都来自 context 与 toolCall
export function EvalWorkflowSnippetToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  // [失败路径] raw 可能被快照裁剪或尚未落盘，读不到展示数据时整张卡片按无片段降级
  const display = readToolResultDisplay(toolCall.raw);
  // 按 kind 白名单收窄类型，只有片段结果才当作片段展示
  // [权衡] 形状相近的其他结果不会被误渲染成片段面板
  const snippet = display?.kind === "eval_workflow_snippet" ? display : undefined;
  const running = context.isRunning;
  // 失败判定要求非运行中，且工具状态失败或片段结果为失败
  // [失败路径] 运行中一律不判失败，避免开始瞬间状态标签闪红
  const failed = !running && (toolCall.status === "failed" || snippet?.ok === false);
  const startedAt = toolCall.startedAt;
  // 进行中按整秒走、每秒一格（与面板里其他计时同一粒度）；终态定格在工具结果的精确毫秒。
  // 不能每 100ms 显示一次毫秒——尾数肉眼读不了，却是聊天区里最频繁的待处理更新
  // （React 嵌套更新计数在投影帧积压时的种子）。
  // 计时器只在运行中且有开始时间时启用，终态不再订阅
  // [资源] 停表后不产生秒级更新，是这个组件唯一的高频渲染来源
  const now = useNowTicker(running && typeof startedAt === "number");
  const durationText = running
    ? typeof startedAt === "number"
      ? `${Math.max(0, Math.floor((now - startedAt) / 1000))}s`
      : undefined
    : snippet?.durationMs === undefined
      ? undefined
      : `${snippet.durationMs}ms`;
  // 耗时节点在失败时整体为空，把失败表达让给状态标签
  // 文案用等宽数字，秒数变化时不推挤同行元素
  const durationNode = useMemo(
    () =>
      !failed && durationText !== undefined ? (
        <span className="font-mono tabular-nums">{durationText}</span>
      ) : undefined,
    [durationText, failed],
  );
  // [权衡] 入参只按最小形状断言，不信任流式累积结果，字段类型留到取值时才校验
  const input = toolCall.input as { code?: unknown } | undefined;
  // 入参代码只在非空字符串时成立，纯空白按没有代码处理
  // 该判定同时决定运行中是否有可展开内容
  const code = typeof input?.code === "string" && input.code.trim() ? input.code : undefined;
  // 响应文本优先级为片段解包值、原始输出、空
  // 解包交给展示辅助模块，本组件不解析协议前缀
  const response = useMemo(
    () =>
      snippet
        ? snippetResponse(snippet)
        : typeof toolCall.output === "string" && toolCall.output.trim()
          ? toolCall.output
          : undefined,
    [snippet, toolCall.output],
  );
  // 错误文本先取上层透传，再退回诊断消息的逐行拼接
  // [失败路径] 诊断顺序即源码顺序，可按行号定位第一条错误
  const error =
    context.errorText ||
    (failed ? response || snippet?.diagnostics.map((d) => d.message).join("\n") : undefined);
  // 展开入口与当前实际展示的内容一致，不能因隐藏的代码/日志留下空面板。
  // 展开入口必须与各分支真实产出同构，否则会留下空面板
  // 运行中看代码，失败看代码、日志、诊断与响应，成功只看响应
  // [权衡] 宁可少一个入口，也不让用户点开看到空白
  const hasDetails = running
    ? code !== undefined
    : failed
      ? code !== undefined ||
        !!snippet?.logs.length ||
        !!snippet?.diagnostics.length ||
        !!(response || error)
      : response !== undefined;
  // 内容节点按运行态分键，状态切换时整棵子树重建
  // 依赖只列参与计算的字段，避免无谓的重渲染
  const renderContent = useCallback(
    () => (
      <SnippetBody
        key={running ? "running" : "terminal"}
        code={code}
        display={snippet}
        running={running}
        failed={failed}
        response={
          failed ? response || (!snippet?.diagnostics.length ? error : undefined) : response
        }
        theme={context.theme}
      />
    ),
    [code, snippet, running, failed, response, error, context.theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        // 标题按运行态在校验中与已执行之间切换，允许上层覆盖
        // 两条文案都走国际化，不在组件内写死中英文
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: running
              ? "chat.toolCall.workflow.snippet.validating"
              : "chat.toolCall.workflow.snippet.ran",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={durationNode}
        summaryContentSeparator="·"
        statusLabel={failed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined}
        statusTooltip={failed ? error : undefined}
        showFailureStatus={failed}
        isRunning={running}
        // 没有可展示内容时传空，工具行收起折叠箭头且与 hasDetails 同源
        renderContent={hasDetails ? renderContent : undefined}
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

// 正文组件：非失败走单面板，失败走诊断、结果、日志、源码四段
// 面板选择只依赖运行态与失败态，不读其他外部状态
function SnippetBody({
  code,
  display,
  running,
  failed,
  response,
  theme,
}: {
  code?: string;
  display?: ToolCallEvalWorkflowSnippetDisplay;
  running: boolean;
  failed: boolean;
  response?: string;
  theme: ToolCallBlockRenderContext["theme"];
}) {
  const { intl } = useZCodeIntl();
  // `running` 与成功态共用同一面板，差别只在 `content` 的来源。
  // `running` 时渲染待执行代码，终态渲染解包后的 `response`。
  if (!failed) {
    // 运行中要求有代码才渲染，终态要求有响应才渲染
    // 两者都缺时返回空，交给上层收起面板
    const content = running
      ? code === undefined
        ? undefined
        : { code, language: "typescript" }
      : response === undefined
        ? undefined
        : snippetValue(response);
    if (!content) return null;
    return (
      <SnippetTextPanel
        key={content.code}
        text={content.code}
        language={content.language}
        running={running}
        truncated={!running && display?.truncated === true}
      />
    );
  }

  const codeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.snippet.section.code" });
  // 失败分支把源码常驻为折叠块，便于对照诊断行号
  // 语言固定为 typescript，关闭图表渲染避免误判代码块
  const codeBlock =
    code === undefined ? null : (
      <CodeBlock
        code={code}
        language="typescript"
        appTheme={theme}
        showLineNumbers
        renderMermaid={false}
      />
    );
  // 响应值先尝试 JSON 解析并美化，解析失败则原样按文本展示
  // [权衡] 解析失败不当错误处理，日志与纯文本同样需要可读
  const value = response === undefined ? undefined : snippetValue(response);
  return (
    <div className="mb-2 space-y-3" data-testid="workflow-snippet-body">
      {display?.diagnostics.length ? (
        <WorkflowDiagnosticsSection diagnostics={display.diagnostics} />
      ) : null}
      {value ? (
        <section className="space-y-1.5" data-testid="snippet-result">
          <div className="max-h-72 overflow-auto">
            <CodeBlock
              code={value.code}
              language={value.language}
              appTheme={theme}
              renderMermaid={false}
            >
              <CodeBlockHeader>
                <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                  {intl.formatMessage({
                    id: failed
                      ? "chat.toolCall.status.failed"
                      : "chat.toolCall.workflow.snippet.section.response",
                  })}
                </h4>
                <CodeBlockCopyButton />
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        </section>
      ) : null}
      {display?.logs.some((line) => line.trim()) ? (
        <section className="space-y-1.5" data-testid="snippet-logs">
          <h4 className="text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.toolCall.workflow.snippet.section.logs" })}
          </h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
            {display.logs.join("\n")}
          </pre>
        </section>
      ) : null}
      {codeBlock ? (
        // 源码默认折叠，展开后才渲染代码块，减少首屏负担
        // 标题即代码段名，点击整行可切换，沿用浏览器原生行为
        <details className="space-y-2" data-testid="snippet-code">
          <summary className="cursor-pointer text-ui-sm text-foreground-subtlest">
            {codeLabel}
          </summary>
          <div className="max-h-64 overflow-auto">{codeBlock}</div>
        </details>
      ) : null}
      {display?.truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}

/** 共用 Markdown 工具栏，正文独立滚动，避免复制按钮随长内容卷走。 */
// 共用文本面板：头部常驻工具栏，正文在自己的容器内滚动
// 截断提示挂在面板底部，只由外部传入的标记控制
function SnippetTextPanel({
  text,
  language,
  running,
  truncated,
}: {
  text: string;
  language: string;
  running: boolean;
  truncated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="mb-2 min-w-0" data-testid="workflow-snippet-body">
      <div data-testid={running ? "snippet-running-code" : "snippet-result"}>
        <CodeBlock
          code={text}
          language={language}
          className="border border-border bg-card"
          contentClassName="max-h-80 overflow-auto"
          wrapLongLines
          renderMermaid={false}
        >
          <CodeBlockHeader className="pl-3 pr-2 pt-2" language={language} />
        </CodeBlock>
      </div>
      {truncated ? (
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
