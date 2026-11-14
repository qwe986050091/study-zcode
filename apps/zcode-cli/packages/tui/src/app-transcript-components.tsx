// INV-01 纯展示：守住位置 两个导出组件的入参；改错故障：渲染期间解析事件或请求数据。
// INV-02 parts 优先：守住位置 正文渲染的分支顺序；改错故障：有片段时仍重复渲染整段 content。
// INV-03 镜像卡优先：守住位置 tool 片段的分派；改错故障：命中镜像仍渲染旧文本投影。
// INV-04 状态读镜像：守住位置 卡片状态的来源；改错故障：工具一启动就显示完成。
// INV-05 空态二选一：守住位置 emptyText 与 logo 的分支；改错故障：同时渲染文案与 logo。
// INV-06 键稳定：守住位置 空态与消息行的 key；改错故障：文案切换导致滚动容器重建。
// INV-07 贴底滚动：守住位置 stickyScroll 与 stickyStart；改错故障：新消息到达时视图停在旧位置。
// INV-08 视口裁剪：守住位置 viewportCulling；改错故障：长会话为屏外内容做全量布局。
// INV-09 最小高度：守住位置 minHeight；改错故障：内容很少时面板塌成一行。
// INV-10 timeline 早退：守住位置 role 判断；改错故障：timeline 消息进入正文渲染产生空行。
// INV-11 用户气泡：守住位置 背景与上下内边距的条件；改错故障：agent 消息也带背景块。
// INV-12 system 配色：守住位置 plainTextColor 的三元；改错故障：系统提示与普通文本无法区分。
// INV-13 未知片段回落：守住位置 末尾的文本分支；改错故障：新片段类型直接不渲染。
// INV-14 未知 timeline 空盒：守住位置 类型判断；改错故障：其它事件被误显示为压缩进度。
// INV-15 状态覆盖率：守住位置 六分支文案；改错故障：新增状态落到 completed 文案。
// INV-16 重试提示成对：守住位置 failed 与 interrupted 共用分支；改错故障：失败状态没有恢复入口。
// INV-17 横线非负：守住位置 Math.max 4；改错故障：窄终端下重复次数为负而抛错。
// INV-18 无 IO：守住位置 全部组件体；改错故障：渲染触发订阅或全局写入。
//
// 模块职责：把消息数组渲染为 transcript 面板，并按角色与片段类型分派到具体行组件。
// 状态所有权：无状态；消息、展开集合与镜像卡均由调用方传入。
// 阅读顺序：类型别名 → 面板容器 → 消息行分派 → 片段分派 → 压缩分隔行。
// 会话内容渲染模块：把消息数组渲染为 transcript 面板，并按消息角色/片段类型分派具体行组件。
// 边界：只做布局与样式，不解析事件、不请求数据；所有内容都来自 props。
// 口径：parts 优先于 content；工具片段命中 workflow 镜像卡时渲染实时卡，否则回落文本投影。
// 失败语义：纯展示无失败路径；空消息数组渲染 logo 或 emptyText，未知 timeline 类型渲染空盒。
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { Message } from "./app-model.js";
import { palette } from "./app-model.js";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { MarkdownText } from "./app-markdown.js";
import { ThoughtTranscriptPartView } from "./app-thought-components.js";
import { ToolTranscriptPartView } from "./app-tool-components.js";
import { WorkflowRunCardView } from "./app-workflow-card.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";

// 收窄 createElement 的类型签名，让 JSX 之外的元素声明也能传扁平 props 与可变 children。
// 收窄 createElement 签名，让扁平属性与可变子节点都能通过类型检查。
// h 这个 createElement 别名只在文件内使用、不 export，外部不会绕过类型收窄。
//
const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 用户消息上下各留 1 行内边距，形成与 agent/system 消息的视觉分隔。
// USER_MESSAGE_VERTICAL_PADDING 固定为 1 行：再多会让用户消息在窄终端里占掉整屏。
// 该常量只作用于用户气泡，其余角色不带上下内边距。
//
const USER_MESSAGE_VERTICAL_PADDING = 1;

// 会话主内容面板：按消息数组渲染 transcript，空态显示 logo 或自定义文案。
// messages 为空数组时显示空态；否则逐条交给 MessageRow。terminalWidth 缺省 100，用于折行估算。
// 纯展示组件，无 IO；scrollbox 固定贴底并开启视口裁剪，避免长会话全量布局。
// 滚动容器贴底并开启视口裁剪，长会话不会为屏外内容做布局。
// 最小高度 8 行，内容很少时面板仍保持可读。
// 终端宽度缺省 100，调用方未传时按保守值估算折行。
//
export function ContentPane({
  animateEmptyLogo = false,
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  emptyText,
  id,
  focused,
  messages,
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  animateEmptyLogo?: boolean;
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  emptyText?: string;
  id?: string;
  focused: boolean;
  messages: Message[];
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  return h(
    "scrollbox",
    {
      id,
      focused,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      style: {
        backgroundColor: palette.background,
        border: false,
        flexGrow: 1,
        marginBottom: 1,
        minHeight: 8,
        contentOptions: {
          backgroundColor: palette.background,
          flexDirection: "column",
          padding: 1,
        },
        rootOptions: {
          backgroundColor: palette.background,
        },
        scrollbarOptions: {
          showArrows: true,
        },
        viewportOptions: {
          backgroundColor: palette.background,
        },
        wrapperOptions: {
          backgroundColor: palette.background,
        },
      },
    },
    // 空消息时优先显示调用方文案，其次渲染 logo 动画。
    // 两种情况共用同一个键，切换文案不会重建滚动容器。
    // 消息非空时逐条渲染消息行，索引参与键拼接保证唯一。
    //
    ...(messages.length === 0
      ? [
          emptyText
            ? h("text", { key: "empty", style: { fg: palette.muted } }, emptyText)
            : h(EmptyTranscriptLogo, { animated: animateEmptyLogo, key: "empty-transcript-logo" }),
        ]
      : messages.map((message, index) =>
          h(MessageRow, {
            copy,
            expandedWorkflowRunIds,
            index,
            key: `${index}-${message.role}`,
            message,
            terminalWidth,
            workflowCardsByToolCallId,
          }),
        )),
  );
}

// 渲染单条消息：timeline 走压缩分隔行；user 消息带背景与内边距；
// agent 文本走 Markdown（支持流式），system 文本用警告色纯文本。
// parts 优先于 content：工具段命中 workflow 镜像卡则渲染实时卡，否则回落文本投影；
// 未命中镜像时读取 part.status 会失真，因此卡片状态必须以镜像为准。无副作用。
// 消息行按角色分派：timeline 走压缩分隔行，其余走气泡。
// MessageRow 把两种颜色作为 props 下传，AgentMessage 与 SystemMessage 不需要知道角色到颜色的映射。
//
export function MessageRow({
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  message,
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  index: number;
  message: Message;
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  const parts = message.parts ?? [];
  // timeline 是独立行类型，不参与正文渲染，直接切换到压缩进度分隔行。
  // timeline 是独立行类型，不参与正文渲染，命中即早退。
  // 早退避免后续片段映射对 timeline 消息做无意义处理。
  //
  if (message.role === "timeline") {
    return h(CompactTimelineRow, { copy, message, terminalWidth });
  }
  // speaker labels were visually noisy; only user prompts carry row chrome.
  const isUserMessage = message.role === "user";
  // 只有用户消息带背景与上下内边距，其余角色使用页面背景。
  // agent 文本走 Markdown，system 文本用警告色纯文本。
  //
  const rowBackground = isUserMessage ? palette.userMessageBackground : palette.background;
  const assistantText = message.role === "agent";
  const plainTextColor = message.role === "system" ? palette.warning : palette.text;

  return h(
    "box",
    {
      style: {
        backgroundColor: rowBackground,
        flexDirection: "column",
        marginBottom: 1,
        minHeight: 2,
        paddingLeft: 1,
        paddingRight: 1,
        paddingBottom: isUserMessage ? USER_MESSAGE_VERTICAL_PADDING : 0,
        paddingTop: isUserMessage ? USER_MESSAGE_VERTICAL_PADDING : 0,
        width: "100%",
      },
    },
    // 没有片段时才渲染整段正文，agent 与其它角色走不同分支。
    // parts.length > 0 时整段正文分支不渲染，不会出现同一内容渲染两次。
    //
    ...(assistantText && parts.length === 0
      ? [
          h(MarkdownText, {
            backgroundColor: rowBackground,
            content: message.content,
            key: "content",
            streaming: message.streaming,
          }),
        ]
      : parts.length === 0
        ? [h("text", { key: "content", style: { fg: plainTextColor } }, message.content)]
        : []),
    ...parts.map((part, partIndex) => {
      if (part.type === "tool") {
        // 卡片 join 按 toolCallId（与 GUI buildWorkflowRunByToolCallId 同规）。命中即渲染实时卡：
        // 工具行自己的 status 在 CreateWorkflow 上会在 run 还在飞的时候就变成 completed
        // （工具一launch完 run 就返回），所以状态必须读镜像，不能读 part.status。
        const workflowCard = workflowCardsByToolCallId?.get(part.toolCallId);
        if (workflowCard) {
          return h(WorkflowRunCardView, {
            card: workflowCard,
            copy,
            expanded: expandedWorkflowRunIds?.has(workflowCard.runId) ?? false,
            key: `workflow-${part.toolCallId}`,
            terminalWidth,
          });
        }
        // 无命中就回落今日的文本投影（编过但没有 run、或镜像尚未补种）。
        return h(ToolTranscriptPartView, {
          key: `tool-${part.toolCallId}`,
          part,
          terminalWidth,
        });
      }
      if (part.type === "thought") {
        return h(ThoughtTranscriptPartView, {
          copy,
          key: `thought-${partIndex}`,
          part,
        });
      }
      return assistantText && part.format !== "plain"
        ? h(MarkdownText, {
            backgroundColor: rowBackground,
            content: part.text,
            key: `text-${partIndex}`,
            streaming: message.streaming,
          })
        : h("text", { key: `text-${partIndex}`, style: { fg: plainTextColor } }, part.text);
    }),
  );
}

// 上下文压缩的进度分隔行：started/retrying/skipped/failed/interrupted/completed 各有文案。
// 失败/中断额外展示重试命令提示；左右横线宽度按终端列宽计算并至少保留 4 列。
// 非 context_compaction 的 timeline 消息渲染空盒子，避免误显示其他事件。
// 片段按工具、思考、文本三类分派，未知类型回落纯文本。
// 工具片段命中镜像卡时用卡片状态，不读取工具自身状态。
//
function CompactTimelineRow({
  copy,
  message,
  terminalWidth,
}: {
  copy: TuiCopy;
  message: Message;
  terminalWidth: number;
}): React.ReactElement {
  const timeline = message.timeline;
  if (!timeline || timeline.type !== "context_compaction") {
    return h("box", null);
  }
  const compactCopy = copy.transcript.compact;
  const label =
    timeline.status === "started"
      ? compactCopy.started
      : timeline.status === "retrying"
        ? compactCopy.retrying({
            attempt: timeline.attempt ?? 0,
            maxAttempts: timeline.maxAttempts ?? 0,
          })
        : timeline.status === "skipped"
          ? compactCopy.skipped
          : timeline.status === "failed"
            ? compactCopy.failed
            : timeline.status === "interrupted"
              ? compactCopy.interrupted
              : compactCopy.completed;
  const retry =
    timeline.status === "failed" || timeline.status === "interrupted"
      ? compactCopy.retry(timeline.command ?? "/compact")
      : undefined;
  // 状态文案六选一，重试与中断额外拼上重试命令提示。
  // 左右横线按终端列宽对半分，至少保留四列避免负宽度。
  //
  const center = retry ? ` ${label} | ${retry} ` : ` ${label} `;
  const sideWidth = Math.max(4, Math.floor((terminalWidth - center.length - 6) / 2));
  const line = "-".repeat(sideWidth);
  const color =
    timeline.status === "failed"
      ? palette.warning
      : timeline.status === "started"
        ? palette.accent
        : timeline.status === "retrying"
          ? palette.accent
          : palette.muted;

  return h(
    "box",
    {
      style: {
        backgroundColor: palette.background,
        flexDirection: "column",
        marginBottom: 1,
        minHeight: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    h(
      "text",
      {
        key: "compact-timeline",
        style: { fg: color },
      },
      `${line}${center}${line}`,
    ),
  );
}
