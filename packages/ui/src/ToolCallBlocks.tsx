// INV-01 任何提前返回都必须位于全部 hook 调用之后；守住位置：showTodoToolCalls 过滤分支；改错故障：同一 key 下这一帧少执行数个 hook，React 抛「Rendered fewer hooks than expected」并让整个聊天面板白屏。
// INV-02 子卡身份只认 toolCall.toolId，不得用 toolName 或数组下标充当 key；守住位置：childToolList 里的 key 表达式；改错故障：同一次响应中两个同名 read 调用共用实例，折叠状态与 diff 滚动位置互相串台。
// INV-03 renderContext 必须列全渲染器依赖的每个字段，并同步进依赖数组；守住位置：上下文对象字面量与下方依赖清单；改错故障：回调更新后上下文引用不变，渲染器握着旧闭包，按钮打开的是上一次会话的详情。
// INV-04 渲染器组件身份在同一上下文上必须稳定；守住位置：ToolCallRenderer 的 useMemo；改错故障：组件类型每帧变化导致子树卸载重建，折叠状态与 tab 选择在流式输出中被反复清零。
// INV-05 渲染器解析必须对未知工具降级到通用卡片，绝不返回空实现；守住位置：resolveToolCallRenderer 调用与插件覆盖三元；改错故障：新工具或插件卸载后整条调用从对话里消失，用户无法判断命令是否执行。
// INV-06 展示模型只由 toolCall 与 workspacePath 派生，不得读取任何组件外可变状态；守住位置：buildToolDisplayModel 的 useMemo；改错故障：同一条调用在不同时刻画出不同文件摘要，分享截图与本地回放对不上。
// INV-07 结果与参数分离：派生只读 toolCall 的 input、output、raw，不得把 isRunning、statusLabel 等渲染态写回模型；守住位置：两处派生 useMemo 的依赖清单；改错故障：状态推进触发摘要重算，已解析的文件列表被打回空数组并闪烁。
// INV-08 错误文本优先级高于状态枚举与运行标记；守住位置：getToolCallErrorText 取值与 errorText 进入上下文；改错故障：工具以失败结束但卡片仍画成功态，用户误以为文件已写入。
// INV-09 todo 过滤只允许发生在渲染返回处，不得上移到 hook 之前；守住位置：family 为 todo 的提前返回；改错故障：开关切换时同一 key 的 hook 数量变化，页面崩溃且无法通过重试恢复。
// INV-10 折叠、tab、展开态归各渲染器组件本地所有，本文件不得把它们放进上下文或模块级容器；守住位置：renderContext 字面量无展开类字段、渲染器身份稳定；改错故障：展开一张卡会让同一 toolId 的其余历史卡片一起展开。
// INV-11 入场动画键必须由来源前缀与 toolId 共同组成，不能只用 toolId；守住位置：toolEntranceAnimationKey 的模板拼接；改错故障：父卡与子卡投影出同一 toolId 时互相顶掉记录，后来者永久不播放淡入。
// INV-12 动画记录表记的是「已播放」而非「正在播放」，并在超过 800 条时淘汰最旧项；守住位置：recordToolEntranceAnimation 与 pruneToolEntranceAnimationKeys；改错故障：长会话中记录无界增长，或淘汰策略误删刚写入的键导致同一张卡反复淡入。
// INV-13 淡入只在流式激活时发生，历史回放一律不播；守住位置：canPlayToolEntranceAnimation 的 active 形参；改错故障：打开旧会话时整屏工具卡依次闪入，观感上像是刚刚重新执行过。
// INV-14 宿主能力只在 Provider 处求值一次并覆盖整棵子树；守住位置：useToolPresentationHostCapabilities 与 ToolPresentationCapabilitiesProvider 的包裹范围；改错故障：父卡与子卡对同一能力得出不同结论，同一操作入口一半可点一半灰。
// INV-15 插件绑定按「显式入参优先、会话绑定兜底」合并，且不向子工具卡透传；守住位置：providedPluginUi ?? inheritedPluginUi 与 childToolList 的参数清单；改错故障：分享或导出场景下插件卡被会话绑定顶替，或子卡被渲染成父卡的工具界面。
// INV-16 按 toolCallId 联接的 workflowRun、workflowDraft 与各类 workflow 药丸回调一律不向子卡透传；守住位置：childToolList 的显式参数列表；改错故障：父卡的运行进度被画到子卡上，用户看到的是另一次运行的产物与状态。
// INV-17 来源标签仅在子代理调用且未被抑制时出现；守住位置：isSubAgentToolCall 与 suppressSourceLabel 的合取；改错故障：分享出去的对话里出现「子代理」标签，或顶层 agent 卡被误标为子代理。
// INV-18 根节点的 data-tool-call-id、data-tool-name、data-status 一律取原始字段，不得替换为展示文案；守住位置：根 div 的 data-* 属性；改错故障：端到端用例与外部脚本按状态选择器全部失配，且不会报错只静默选不到节点。
// INV-19 流式动画属性为真时输出 true，其余情况必须是 undefined；守住位置：data-zcode-tool-stream-animate 的三元；改错故障：输出 false 后属性选择器依然命中，静止卡片保留动画末端样式并持续参与合成。
import { useToolPresentationHostCapabilities } from "@/hooks/useToolPresentationHostCapabilities.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared/test-ids";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mapToolStatus } from "@/lib/mapToolStatus.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "@/lib/toolCallSummary.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import * as PluginUi from "@/plugin-ui/index.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";

const NESTED_TOOLCALL_CONTAINER_CLASS =
  "ml-2 space-y-2 border-border border-l pl-3.5 border-border";
const MAX_TOOL_ENTRANCE_ANIMATION_KEYS = 800;
const TOOL_ENTRANCE_ANIMATION_CLEANUP_MS = 1000;
const toolEntranceAnimationKeys = new Map<string, number>();

function pruneToolEntranceAnimationKeys() {
  if (toolEntranceAnimationKeys.size <= MAX_TOOL_ENTRANCE_ANIMATION_KEYS) {
    return;
  }

  const staleKeys = Array.from(toolEntranceAnimationKeys.entries())
    .sort(([, left], [, right]) => left - right)
    .slice(0, toolEntranceAnimationKeys.size - MAX_TOOL_ENTRANCE_ANIMATION_KEYS)
    .map(([key]) => key);

  for (const key of staleKeys) {
    toolEntranceAnimationKeys.delete(key);
  }
}

function normalizeToolEntranceAnimationKey(key: string) {
  const normalizedKey = key.trim();
  return normalizedKey.length > 0 ? normalizedKey : null;
}

function hasPlayedToolEntranceAnimation(key: string) {
  const normalizedKey = normalizeToolEntranceAnimationKey(key);
  return normalizedKey === null || toolEntranceAnimationKeys.has(normalizedKey);
}

function recordToolEntranceAnimation(key: string) {
  const normalizedKey = normalizeToolEntranceAnimationKey(key);
  if (normalizedKey === null) {
    return;
  }

  toolEntranceAnimationKeys.set(normalizedKey, Date.now());
  pruneToolEntranceAnimationKeys();
}

function canPlayToolEntranceAnimation(key: string, active: boolean) {
  return active && !hasPlayedToolEntranceAnimation(key);
}

export function isAgentToolCall(toolCall: TaskChatToolCallTreeNode["toolCall"]): boolean {
  return resolveToolCallIdentity(toolCall).family === "agent";
}

function ToolCallBlockComponent({
  toolCallNode,
  depth = 0,
  workspacePath,
  theme,
  codePreviewSettings,
  showIcon = true,
  cuaAppIconClassName,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenPlanDetail,
  pluginUi: providedPluginUi,
  onOpenWorkflowRun,
  onResumeWorkflowRun,
  onOpenWorkflowActor,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  workflowRun,
  workflowDraft,
  onLoadFullToolCallFields,
  suppressSourceLabel = false,
  showTodoToolCalls = true,
  disableSummaryContentAnimation = false,
  animateDiffCountOnMount = false,
  agentSummaryAction,
  authoritativeAgentType,
  streamingEntranceActive = false,
  streamingEntranceKeyPrefix = "tool",
  cuaGroupEvents,
  renderCuaAssistantMessage,
  renderCuaReasoning,
}: {
  toolCallNode: TaskChatToolCallTreeNode;
  depth?: number;
  workspacePath: string;
  /** 应用主题（store 耦合剥离）：由宿主（v4 SessionPane 等）传入，缺省按 "system" 兜底。 */
  theme?: ToolCallBlockRenderContext["theme"];
  /** 代码预览设置（store 耦合剥离）：由宿主传入并保持引用稳定。 */
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  showIcon?: boolean;
  cuaAppIconClassName?: ToolCallBlockRenderContext["cuaAppIconClassName"];
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: (automationId?: string) => void;
  onOpenPlanDetail?: ToolCallBlockRenderContext["onOpenPlanDetail"];
  pluginUi?: ToolCallBlockRenderContext["pluginUi"];
  onOpenWorkflowRun?: ToolCallBlockRenderContext["onOpenWorkflowRun"];
  /** 工具卡页脚的 Resume；与 workflowRun 同样不向子工具卡透传。 */
  onResumeWorkflowRun?: ToolCallBlockRenderContext["onResumeWorkflowRun"];
  /** 药丸 → 子代理 transcript；同样不向子工具卡透传。 */
  onOpenWorkflowActor?: ToolCallBlockRenderContext["onOpenWorkflowActor"];
  /** 脚本药丸 → 脚本 transcript；同样不向子工具卡透传。 */
  onOpenWorkflowWorkspace?: ToolCallBlockRenderContext["onOpenWorkflowWorkspace"];
  /** 产物药丸 → 产物 tab；同样不向子工具卡透传。 */
  onOpenWorkflowArtifact?: ToolCallBlockRenderContext["onOpenWorkflowArtifact"];
  /**
   * 该工具调用联接到的 workflow run 摘要（宿主按 toolCallId 从 workflowRuns 投影解析）。
   * 刻意**不**向子工具卡透传：摘要是按 toolCallId 联接出来的，把父卡的 run 摘要传给
   * 一个不同 toolCallId 的子卡，画出来的就是别人的运行态。
   */
  workflowRun?: ToolCallBlockRenderContext["workflowRun"];
  /** 编译反馈的草稿位置（宿主按 toolCallId 从行窗口联接）；同 workflowRun，不向子工具卡透传。 */
  workflowDraft?: ToolCallBlockRenderContext["workflowDraft"];
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
  suppressSourceLabel?: boolean;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  animateDiffCountOnMount?: boolean;
  agentSummaryAction?: ToolCallBlockRenderContext["agentSummaryAction"];
  authoritativeAgentType?: ToolCallBlockRenderContext["authoritativeAgentType"];
  streamingEntranceActive?: boolean;
  streamingEntranceKeyPrefix?: string;
  cuaGroupEvents?: readonly ConversationCuaGroupEvent[];
  renderCuaAssistantMessage?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>,
  ) => ReactNode;
  renderCuaReasoning?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>,
  ) => ReactNode;
}) {
  // [资源] 宿主能力在这里求值一次，再由 Provider 向下覆盖整棵工具卡子树。
  // 若改由各渲染器自行调用同名 hook，父卡与子卡会各持一份快照，
  // 内置渲染器与插件渲染器对「能否打开预览」就可能给出相反判断。
  // [权衡] 取值键只用 workspacePath 而不是 toolId：能力是工作区级事实，
  // 按 toolId 求值会让同一工作区的每张卡各存一份，流式输出时不断重算。
  // Provider 必须包住根节点而非只包渲染器，卡片内的按钮与药丸同样读这份值。
  // [失败路径] 宿主未提供能力时 hook 返回保守默认，渲染器必须按不支持降级，
  // 不能把缺省当成支持，否则点击后既无反应也无报错。
  const presentationCapabilities = useToolPresentationHostCapabilities(workspacePath);
  const inheritedPluginUi = PluginUi.usePluginUiToolBinding(toolCallNode.toolCall.toolId);
  // [权衡] 显式入参优先于会话绑定：分享、导出、独立预览等宿主没有会话上下文，
  // 此时只有显式入参能让插件卡照常渲染，回退到绑定只会拿到空实现。
  // 兜底值按 toolId 查询绑定，因此绑定粒度是单次调用而不是整个工作区。
  // 这里刻意不把合并结果写回 props 再透传：子卡有自己的 toolId，
  // 沿用父卡绑定会把父工具渲染进子卡，插件侧收到错误入参。
  // [失败路径] 两条来源都为空时插件绑定为 undefined，插件判定必须返回不渲染，
  // 而不是抛错，否则未声明插件的普通工具会整卡崩溃。
  const pluginUi = providedPluginUi ?? inheritedPluginUi;
  const { toolCall, childToolCalls } = toolCallNode;
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  // [并发] 键由来源前缀与 toolId 拼接，前缀区分主对话与子代理 transcript 等流式来源。
  // 只取 toolId 会让两个来源里同 id 的投影互相顶掉，后来者永远拿不到播放机会。
  // 键在渲染期现算而不进 state：前缀或 toolId 变化必须立刻得到新键。
  // 若缓存在 state，切换会话后新卡沿用旧键，被判为已播放而直接跳过淡入。
  // 键的规范化（去空白 / 空串视为无效）由 `normalizeToolEntranceAnimationKey` 在记录与查询两侧共用。
  // [失败路径] 空键按已播放处理且不入表：空串不代表任何真实调用，写进去只会挤占 800 条上限。
  const toolEntranceAnimationKey = `${streamingEntranceKeyPrefix}:${toolCall.toolId}`;
  // tool 在流式对话中新出现时如果没有淡入，会和同一段文字的渐入节奏割裂。
  // 这里按 toolId 记录已经展示过的 tool，切换任务或虚拟列表重挂时不重复播放。
  // 记录动作放在 effect 里延迟执行，避免 React 开发态重挂把第一次动画误吞掉。
  const [shouldPlayEntranceAnimation, setShouldPlayEntranceAnimation] = useState(() =>
    canPlayToolEntranceAnimation(toolEntranceAnimationKey, streamingEntranceActive),
  );
  useEffect(() => {
    if (!streamingEntranceActive || shouldPlayEntranceAnimation) {
      return;
    }

    if (canPlayToolEntranceAnimation(toolEntranceAnimationKey, streamingEntranceActive)) {
      setShouldPlayEntranceAnimation(true);
    }
  }, [shouldPlayEntranceAnimation, streamingEntranceActive, toolEntranceAnimationKey]);

  useEffect(() => {
    if (!shouldPlayEntranceAnimation) {
      return;
    }

    const markAnimatedTimer = window.setTimeout(() => {
      recordToolEntranceAnimation(toolEntranceAnimationKey);
    }, 0);
    const cleanupTimer = window.setTimeout(() => {
      setShouldPlayEntranceAnimation(false);
    }, TOOL_ENTRANCE_ANIMATION_CLEANUP_MS);

    return () => {
      window.clearTimeout(markAnimatedTimer);
      window.clearTimeout(cleanupTimer);
    };
  }, [shouldPlayEntranceAnimation, toolEntranceAnimationKey]);
  // 注意：下面的 early return 必须放在所有 hook 调用之后。
  // 之前这里在 useMemo 之前就 `return null`，导致当某个 toolCall 的
  // family 在 todo 与非 todo 之间切换（或 showTodoToolCalls 变化）时，
  // 本组件这次渲染执行的 hook 数量和上次不一致，React 会抛出
  // "Rendered fewer hooks than expected" 并导致整个聊天页面白屏崩溃。
  // 修复方式：把 early return 下移到所有 hook 之后，保证 hook 调用顺序稳定。
  const identity = resolveToolCallIdentity(toolCall);
  // [权衡] 视觉状态只从状态字段映射，不靠受理结果是否存在来反推。
  // 按受理结果反推会把「已完成但无输出」的工具画成运行中，长驻任务永远转圈。
  // 映射必须是纯函数，同一条调用在父卡、子卡与紧凑摘要里得到同一个枚举。
  // 渲染器只允许按这个枚举分支，不允许再拿原始状态串做字符串比较。
  // [失败路径] 未知状态落回默认枚举而不是抛错，新增状态时旧前端显示为中性态。
  // 文案 key 与图标都取自该枚举，不能让一处用原始串一处用枚举。
  // 改错后果：两者不同步时，用户会看到「运行中」配上已完成的对勾。
  const toolState = mapToolStatus(toolCall.status);
  // [权衡] 展示模型只吃调用对象与工作区路径，不吃任何渲染态（运行中、折叠、tab）。
  // 把渲染态塞进这个派生会让每个 token 到达都重建文件摘要与预览源。
  // 依赖取整个调用对象：流式时它每帧换新引用，重建难免，但必须保持纯派生。
  // 若在这里发起读取（例如补全大文件内容），一次回答会打出成百上千次请求。
  // [失败路径] 输入残缺时模型可能缺少预览源，渲染器必须容忍缺字段而不是直接取用。
  const displayModel = useMemo(
    () => buildToolDisplayModel(toolCall, workspacePath),
    [toolCall, workspacePath],
  );
  // [权衡] 依赖刻意列到 raw、input、output 等基础字段，而不是整个调用对象。
  // 对象级依赖会在流式每帧触发重解析，把已读出的文件列表反复打回重算。
  // 解析入口收到 raw 与 input、output、title 的只读投影，结果不写回调用对象。
  // [失败路径] raw 为空或结构不合法时返回空数组，卡片退化为不显示文件行。
  // 不要在渲染器里再解析一次 raw：两处结果不一致时文件名会与点击目标错位。
  const rawFileSummaries = useMemo(
    () =>
      readRawToolCallFileSummaries(toolCall.raw, {
        toolName: toolCall.toolName,
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [
      toolCall.input,
      toolCall.kind,
      toolCall.output,
      toolCall.raw,
      toolCall.title,
      toolCall.toolName,
    ],
  );
  const isRunning = isCompactToolCallRunningState(toolState);
  const statusLabel = intl.formatMessage({
    id: getCompactToolCallStatusMessageId(toolState, toolCall.status),
  });
  // [失败路径] 错误文本是最高优先级展示信号：只要取到文本，卡片就必须呈现失败态。
  // 状态枚举可能已被宿主归并为完成（命令以非零码结束但调用本身有返回），
  // 此时再按状态画成功，用户会以为写入已落地，实际文件没有任何改动。
  // 渲染器读这里的结果而不是自己去输出里找错误字段：错误格式有多套，判定只留一处。
  // [权衡] 这里只取文本不做解析：错误码、堆栈、退出码原样交给渲染器决定展开方式。
  // 改错后果：错误被藏进折叠区，用户必须展开原始输出才能发现失败。
  const errorText = getToolCallErrorText(toolCall);
  const isCurrentAgentToolCall = isAgentToolCall(toolCall);
  const isSubAgentToolCall = !isCurrentAgentToolCall && (depth > 0 || toolCall.parentToolUseId);
  const sourceLabel =
    !suppressSourceLabel && isSubAgentToolCall
      ? intl.formatMessage({ id: "chat.toolCall.source.subAgent" })
      : undefined;
  // 之前为了避免“双预览”把 onOpenCodeViewer 全局置空，
  // 会导致 edit/read 文件摘要失去点击能力，回归为“看得到文件名但不能点”。
  // 这里恢复透传，保持历史交互；是否做“避免双预览”应改为更细粒度开关，而不是一刀切禁用。
  const toolPreviewCodeViewer: ToolCallBlockRenderContext["onOpenCodeViewer"] = onOpenCodeViewer;

  // [并发] 子卡 key 取子节点的调用 id：同一次响应里同名工具会被调用多次，
  // toolName 在它们之间完全相同，用名字或下标做 key 会让 React 复用到另一条调用的实例。
  // 复用实例的代价不是多渲染一次，而是折叠、tab 与滚动位置串到别的调用上。
  // 调用 id 由创建方生成且全局唯一，是本文件唯一可用的稳定身份。
  // 这里显式列出要透传的参数，运行摘要、草稿、插件绑定以及各类 workflow 药丸回调
  // 都不在列表内：它们按调用 id 联接，传给子卡就是别人的运行态与别人的剧本。
  // [失败路径] 子调用为空时返回 null 而非空容器，避免每张叶子卡多一层无意义节点。
  const childToolList = useMemo(
    () =>
      childToolCalls.length > 0 ? (
        <div className={NESTED_TOOLCALL_CONTAINER_CLASS}>
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              depth={depth + 1}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              showIcon={showIcon}
              onOpenCodeViewer={toolPreviewCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenAutomationsMain={onOpenAutomationsMain}
              onOpenPlanDetail={onOpenPlanDetail}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onLoadFullToolCallFields={onLoadFullToolCallFields}
              suppressSourceLabel={suppressSourceLabel}
              showTodoToolCalls={showTodoToolCalls}
              disableSummaryContentAnimation={disableSummaryContentAnimation}
              animateDiffCountOnMount={animateDiffCountOnMount}
              streamingEntranceActive={streamingEntranceActive}
              streamingEntranceKeyPrefix={streamingEntranceKeyPrefix}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      depth,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      onOpenFileLink,
      showIcon,
      showTodoToolCalls,
      streamingEntranceActive,
      streamingEntranceKeyPrefix,
      suppressSourceLabel,
      theme,
      codePreviewSettings,
      toolPreviewCodeViewer,
      workspacePath,
    ],
  );

  // [权衡] 上下文是渲染器唯一的信息通道：字段在这里缺一个，对应渲染器就永远收不到。
  // 依赖数组必须逐字段列全，否则回调更新后上下文引用不变，渲染器继续持有旧闭包。
  // 反过来，把不稳定值（内联函数、临时对象）放进来会让派生每帧失效，
  // 下游的渲染器选择也跟着重算，最终表现为整棵工具卡子树反复重挂。
  // 嵌套渲染器指向本组件自身，用于逐层递归渲染子卡，定义必须先于上下文可用。
  // [失败路径] 未列入上下文的参数不会报错，只会静默失效，只能靠这条约定守住。
  const renderContext: ToolCallBlockRenderContext = useMemo(
    () => ({
      nestedToolRenderer: ToolCallBlock,
      isOfficeMode,
      toolCallNode,
      workspacePath,
      theme,
      codePreviewSettings,
      displayModel,
      viewerSource: displayModel.viewerSource,
      rawFileSummaries,
      isRunning,
      statusLabel,
      sourceLabel,
      errorText,
      childToolList,
      showIcon,
      cuaAppIconClassName,
      showTodoToolCalls,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      agentSummaryAction,
      authoritativeAgentType,
      onOpenCodeViewer: toolPreviewCodeViewer,
      onOpenFileLink,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenPlanDetail,
      pluginUi,
      // onOpenWorkflowRun 之前只被透传给子工具卡，从未进过 renderContext，
      // 于是 CreateWorkflow renderer 永远收不到它——「打开详情页」的入口不是被埋深了，
      // 是根本没渲染过。run 态紧凑卡就挂在这个回调上，所以它必须在这里。
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      workflowRun,
      workflowDraft,
      onLoadFullToolCallFields,
    }),
    [
      isOfficeMode,
      agentSummaryAction,
      authoritativeAgentType,
      childToolList,
      codePreviewSettings,
      cuaAppIconClassName,
      displayModel,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      errorText,
      isRunning,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      pluginUi,
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      onOpenFileLink,
      rawFileSummaries,
      showIcon,
      showTodoToolCalls,
      sourceLabel,
      statusLabel,
      suppressSourceLabel,
      theme,
      toolCallNode,
      toolPreviewCodeViewer,
      workflowRun,
      workflowDraft,
      workspacePath,
    ],
  );

  // [权衡] 渲染器按工具身份分派，未知工具落到通用卡片而不是返回空。
  // 返回空会让一条真实发生的调用从对话里彻底消失，用户无法判断是否执行过。
  // 插件声明通过判定函数覆盖内置分派，但只有宿主校验过的声明才走到这里。
  // 分派结果放进派生而不是每帧现取：组件类型一变，React 会卸载整棵子树。
  // 子树被卸载意味着折叠状态、tab 选择、diff 滚动位置全部丢失，流式时表现为闪回顶部。
  // 因此折叠状态只能活在渲染器内部，不能上提到本文件，也不能按调用 id 存进模块级表。
  // [失败路径] 插件判定为假时一律回到内置渲染器，不会出现两者都不渲染的空卡。
  // [资源] 这里只保存解析出的组件引用，不订阅、不缓存实例，插件卸载后下次渲染自然回到内置实现。
  const ToolCallRenderer = useMemo(() => {
    const Renderer = resolveToolCallRenderer(renderContext);
    // 插件声明与 session 绑定已由宿主校验，不能再用通用 renderer 身份截断入口。
    // 没有合法插件声明时仍保持共同注册表的专用工具优先级。
    return PluginUi.shouldRenderPluginUi(renderContext) ? PluginUi.PluginUiToolCallBlock : Renderer;
  }, [renderContext]);
  // early return 必须在所有 hook 之后（见上方注释说明的崩溃原因）
  if (!showTodoToolCalls && identity.family === "todo") {
    return null;
  }
  return (
    <ToolPresentationCapabilitiesProvider value={presentationCapabilities}>
      <div
        className="w-full"
        data-testid={testId(TID_CHAT_TOOL_CALL_BLOCK, toolCall.toolId)}
        data-tool-call-id={toolCall.toolId}
        data-tool-name={toolCall.toolName ?? toolCall.kind ?? ""}
        data-status={toolCall.status}
        data-zcode-tool-stream-animate={shouldPlayEntranceAnimation ? "true" : undefined}
      >
        {toolCall.kind === "cuaGroup" ? (
          <CuaGroupToolCallBlock
            {...renderContext}
            events={cuaGroupEvents}
            renderAssistantMessage={renderCuaAssistantMessage}
            renderReasoning={renderCuaReasoning}
          />
        ) : (
          <ToolCallRenderer {...renderContext} />
        )}
      </div>
    </ToolPresentationCapabilitiesProvider>
  );
}

export const ToolCallBlock = memo(ToolCallBlockComponent);
ToolCallBlock.displayName = "ToolCallBlock";
