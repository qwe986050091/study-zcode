// INV-01 守住位置：文件头 import 段保持包别名与相对入口；改错故障：改成相对路径或调整导入顺序会破坏跨包解析并引入循环依赖。
// INV-02 守住位置：SEND_MESSAGE_TOOL_ICON 留在模块作用域；改错故障：移进组件体会每次渲染新建元素，破坏 ToolLayout 的引用稳定。
// INV-03 守住位置：toRecord 的 type 与 Array 判定；改错故障：放行数组会把数组当记录取字段，静默渲染出空详情。
// INV-04 守住位置：JSON.parse 必须整体包在 try 内；改错故障：非法 JSON 抛错会穿透渲染，整块工具调用白屏。
// INV-05 守住位置：readStringField 的 trim 长度判空；改错故障：放行纯空白会让 hasDetails 在无内容时点亮展开入口。
// INV-06 守住位置：readStringField 返回原始 candidate 而非 trim 结果；改错故障：多行消息的缩进与换行会被吃掉。
// INV-07 守住位置：readRawRecord 对每个候选键再做一次 toRecord；改错故障：快照为 JSON 字符串时直接取值只能拿到字符串。
// INV-08 守住位置：readText 只接受非空字符串；改错故障：对象被当文本渲染会触发 React 子节点类型错误。
// INV-09 守住位置：readRawResultContent 固定下钻 result.content 两层；改错故障：加宽容匹配会误取其它字段并当成消息输出。
// INV-10 守住位置：DetailField 的 mono 默认 false；改错故障：默认等宽会让中文长消息按字符断行，视觉错乱。
// INV-11 守住位置：DetailField 输出 dt 与 dd 语义结构；改错故障：换成 div 会丢失读屏器的字段与值关联。
// INV-12 守住位置：input 的解析顺序 input 优先于 rawInput；改错故障：调换顺序会让旧快照覆盖当前流式输入。
// INV-13 守住位置：output 的三级回退 directOutput 到 rawOutput 再到 result.content；改错故障：删任一档都会让旧会话丢失失败原因。
// INV-14 守住位置：outputText 与 output 互斥取值；改错故障：两处都取会在同一失败里重复拼接同一段文本。
// INV-15 守住位置：hasDetails 只看 target、summary、message；改错故障：按 output 判定会让流式首帧出现空详情面板。
// INV-16 守住位置：isFailed 前置否定 denied 与 stopped；改错故障：被拒绝或被中断会被标成失败并给出误导性提示。
// INV-17 守住位置：failureMessage 以 context.errorText 开头、outputText 收尾；改错故障：顺序颠倒会让原始报文盖住可读错误。
// INV-18 守住位置：renderContent 仅在 hasDetails 为真时传给 ToolLayout；改错故障：无条件传入会出现可展开但空白的抽屉。
//
// 模块职责：把 send_message 调用的多来源快照规整为可读详情面板与状态标签，只做展示投影，不发请求不写状态。
// 状态所有权：工具调用状态与原始快照归上层 context 与 toolCall，组件内只有派生值，不持有可变状态。
// 阅读顺序：先看 toRecord 等纯读取器，再看 SendMessageToolCallBlock 的解析链，最后看 JSX 中 ToolLayout 与快照提示的装配。
import { SendIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const SEND_MESSAGE_TOOL_ICON = <SendIcon className="size-4 shrink-0 text-foreground-subtle" />;

// 对外契约：对象原样返回，非空 JSON 字符串解析后返回，其余输入一律 undefined。
// 用 undefined 而非抛错是刻意的：上层的每处读取都能安全降级为空展示。
// 任何抛错都会穿透渲染栈炸掉整块工具调用，流式快照里非法 JSON 并不罕见。
// 数组必须排除，否则会被当成记录取到 undefined 字段并渲染出空详情。
// 改错故障：把解析移出 try 或去掉 trim 判空，都会让空白输入变成可见异常。
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// 按 keys 声明顺序返回第一个非空字符串，顺序即优先级，调用方依赖它选定字段。
// 返回值保留原始空白：多行消息的缩进与换行属于用户输入，不能在读取层改写。
// 空串与纯空白视为缺失，否则 hasDetails 会被无内容的字段点亮。
// value 可能为 undefined，可选链让缺失输入直接退化为 undefined 而不是抛错。
// 改错故障：改成返回最后一个匹配键，会让兼容字段悄悄覆盖主字段。
function readStringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

// raw 是外层快照容器，真正载荷藏在 rawInput、rawOutput 这类键下，因此要二次规整。
// 逐个候选键尝试而不是合并，保证第一个可解析的快照胜出、语义可预测。
// 任一键都可能缺失或格式不同，循环必须能走完并回退到 undefined。
// 返回 undefined 是给上层的信号：改用其它来源，而不是把它当成空对象。
// 改错故障：只取第一个键就返回，会在新旧快照键名迁移期读到空值。
function readRawRecord(raw: unknown, keys: readonly string[]) {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = toRecord(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// 结果载荷固定在 result.content 这一层，路径写死是为了不误取其它 content 字段。
// 两层都可能是 undefined 或非对象，逐层规整后自然得到 undefined。
// 返回值保持 unknown：它既可能是字符串也可能是对象，由调用方各自判定。
// 改错故障：改成深度搜索 content 会命中不相干字段，把别的内容当消息输出。
// 不要在这里加兜底或默认值，否则下游无法区分真的缺失与伪造的空内容。
function readRawResultContent(raw: unknown): unknown {
  const rawRecord = toRecord(raw);
  const result = toRecord(rawRecord?.result);
  return result?.content;
}

// 纯展示组件，无状态无副作用，只把已翻译好的 label 与字符串 value 排成一行。
// 用 dt 与 dd 而不是 div，保留读屏器需要的字段名与字段值关联。
// mono 只给 target 这类标识符使用，正文用比例字体才符合设计规范的正文尺寸。
// break-words 与 pre-wrap 同时存在，长标识符与多行消息都不会撑破面板宽度。
// 改错故障：把 pre-wrap 换成普通空白折叠，用户输入的换行会在展示中消失。
function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-ui-base font-medium text-foreground-subtle">{label}</dt>
      <dd
        className={
          mono
            ? "whitespace-pre-wrap break-words font-mono text-ui-base text-foreground"
            : "whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

// 组件只做投影：不发起请求、不写 store、不 await，所有事实都来自 context 与 toolCall。
// 派生值在每次渲染重算，代价是若干次类型判断，换来没有缓存失效导致的状态错位。
// useMemo 与 useCallback 只服务于引用稳定，避免 ToolLayout 因新对象反复重排。
// intl 只用于取文案，所有 label id 必须与 i18n 资源一致，缺失会直接显示 id。
// 组件不区分运行环境，平台差异由上层 context 注入，这里不感知窗口类型。
// 改错故障：在此处新增订阅或本地状态，会出现与上层快照不同步的第二份事实。
export function SendMessageToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const messageDisplay = display?.kind === "local_agent_message" ? display : undefined;
  const input = toRecord(toolCall.input) ?? readRawRecord(toolCall.raw, ["rawInput", "input"]);
  const directOutput = toRecord(toolCall.output);
  const rawResultContent = readRawResultContent(toolCall.raw);
  const rawResultOutput = toRecord(rawResultContent);
  const output =
    directOutput ?? readRawRecord(toolCall.raw, ["rawOutput", "output"]) ?? rawResultOutput;
  const outputText =
    (directOutput ? undefined : readText(toolCall.output)) ??
    (rawResultOutput ? undefined : readText(rawResultContent));
  const summary = readStringField(input, ["summary"]);
  const target = readStringField(input, ["to"]);
  const message = readStringField(input, ["message"]);
  // streaming input 首帧可能还没有字段，不能为一个空详情面板提供展开入口。
  const hasDetails = Boolean(target || summary || message);
  const outputMessage = readStringField(output, ["message"]);
  const outputError = readStringField(output, ["error"]);
  const outputStatus = readStringField(output, ["status"]);
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  // 先排除 denied 与 stopped 再判失败：这两种终态有独立标签，不能重复计为错误。
  // 失败来源有三处：工具状态、本地消息显示、输出里的 status 字段，任一成立即算失败。
  // 三层来源对应历史快照与实时流式的差异，删掉任一层都会漏报失败。
  // 早返回语义让后续 failureMessage 与 statusTooltip 只在这一个布尔上分叉。
  // 改错故障：把 denied 并入失败，会让用户主动拒绝被渲染成系统异常。
  const isFailed =
    !isDenied &&
    !isStopped &&
    (toolCall.status === "failed" ||
      messageDisplay?.status === "failed" ||
      outputStatus === "failed");
  const failureMessage = isFailed
    ? (context.errorText ??
      messageDisplay?.error ??
      messageDisplay?.message ??
      outputError ??
      outputMessage ??
      outputText)
    : undefined;
  const kindLabelId = context.isRunning
    ? "chat.toolCall.sendMessage.sending"
    : "chat.toolCall.kind.message";
  const statusLabelId = isFailed
    ? "chat.toolCall.status.failed"
    : isDenied
      ? "chat.toolCall.status.denied"
      : isStopped
        ? "chat.toolCall.status.stopped"
        : undefined;
  // 标题回退链是 summary、toolCall.title、固定字符串，保证任何阶段都有可读主文本。
  // 依赖数组必须同时包含 summary 与 title，漏掉任一项会停留在上一次会话的文本。
  // 主文本用 truncate 单行截断，长消息摘要不能撑开工具条高度。
  // 只包一层 span 交由 ToolLayout 排版，这里不承担布局与可点击行为。
  // 改错故障：把 title 从依赖数组移除，同一组件切换工具调用后会显示旧标题。
  const primaryText = useMemo(
    () => <span className="min-w-0 truncate">{summary ?? toolCall.title ?? "SendMessage"}</span>,
    [summary, toolCall.title],
  );
  const secondaryText = useMemo(
    () =>
      target ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.sendMessage.to" })}
          </span>
          <code className="min-w-0 truncate font-mono">{target}</code>
        </span>
      ) : undefined,
    [intl, target],
  );
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <dl className="space-y-3">
          {target ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.sendMessage.target" })}
              value={target}
              mono
            />
          ) : null}
          {summary ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.sendMessage.summary" })}
              value={summary}
            />
          ) : null}
          {message ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.sendMessage.message" })}
              value={message}
            />
          ) : null}
        </dl>
      </div>
    ),
    [intl, message, summary, target],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEND_MESSAGE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={secondaryText}
        statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
        showStatusLabel={statusLabelId != null}
        statusTooltip={isFailed ? failureMessage : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
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
