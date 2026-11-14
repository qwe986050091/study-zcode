// 子智能体工具块渲染层：把父 Agent tool 的 prompt、thought、activity、后台进程
// 状态与已展开的子工具列表组装成只读展示树，交由 ToolLayout 的单行摘要承载。
// 本文件不推进 Agent 生命周期、不解析协议、不持有任务状态，也不提供子时间线展开入口。
//
// INV-01 断言：childToolCalls 为空时直接返回 null 而非空容器 —— 守住它的位置：AgentChildToolList 首个 if —— 改错故障：折叠态下方多出空白间距，块高度抖动
// INV-02 断言：子工具固定 depth 为 1 且关闭图标与来源标签 —— 守住它的位置：AgentChildToolList 传给嵌套渲染器的属性 —— 改错故障：嵌套工具重复画图标与 badge，摘要行叠字
// INV-03 断言：子工具 key 使用 toolId 而非数组索引 —— 守住它的位置：childToolCalls.map 的 key 属性 —— 改错故障：流式追加子工具时子组件错位复用，展开态串行
// INV-04 断言：父块运行态只取 context.isRunning —— 守住它的位置：isAgentVisuallyRunning 赋值 —— 改错故障：父 Agent 完成后仍显示渐变与运行摘要
// INV-05 断言：子工具摘要仅在可视化运行中计算 —— 守住它的位置：collapsedChildSummary 的三元分支 —— 改错故障：完成态残留子动作文案，下次渲染才消失
// INV-06 断言：sourceLabel 恒为 undefined —— 守住它的位置：AgentToolCallBlock 内的常量声明 —— 改错故障：来源 badge 与层级信息重复，摘要行拥挤
// INV-07 断言：折叠态主文案优先子摘要、展开态用父文案 —— 守住它的位置：primaryText 与 expandedPrimaryText 两个属性 —— 改错故障：展开后主文案被子工具文案顶替，用户看不到原始 prompt 摘要
// INV-08 断言：summaryContentKey 必须稳定且随内容变化 —— 守住它的位置：summaryContentKey 属性 —— 改错故障：每帧重算 key 导致内容动画反复重放，或内容已变却不触发动画
// INV-09 断言：statusTooltip 仅在 status 为 failed 时取 errorText —— 守住它的位置：statusTooltip 属性 —— 改错故障：成功块悬停出现红色错误提示，或失败块无任何错误信息
// INV-10 断言：后台过程区由 backgroundAgentInfo 存在性决定 —— 守住它的位置：renderContent 首个条件渲染 —— 改错故障：普通 Agent 块出现空的启动/活动卡片
// INV-11 断言：hasActivity 由 activityContent 与 activityThought 任一成立 —— 守住它的位置：BackgroundAgentProcessSection 的 hasActivity 入参 —— 改错故障：只有 thought 时摘要在等待与已回传之间来回跳
// INV-12 断言：launchStatusKind 只允许 failed、pending、launched —— 守住它的位置：launchStatusKind 的三元链 —— 改错故障：E2E 读到未知属性值，启动态断言失效
// INV-13 断言：activityStatusKind 只允许 streaming、running_waiting、received、waiting —— 守住它的位置：activityStatusKind 的嵌套三元 —— 改错故障：运行中与已结束状态混淆，等待文案停在终态
// INV-14 断言：两个 background-agent data 属性是测试观测锚点 —— 守住它的位置：后台卡片 section 的属性 —— 改错故障：改名后 E2E 选择器全部失配，后台态无法验证
// INV-15 断言：renderContent 的依赖数组覆盖其闭包读取的全部外部值 —— 守住它的位置：useCallback 依赖数组 —— 改错故障：流式更新后闭包读到旧 status 或旧 activity，内容停更
// INV-16 断言：折叠与展开摘要片段各自缓存、不共用元素 —— 守住它的位置：两个 useMemo 的 span —— 改错故障：两态共用引用使布局误判内容未变，过渡动画不触发
// INV-17 断言：ToolSnapshotFieldNotice 渲染在 ToolLayout 之外 —— 守住它的位置：末尾 Fragment 的第二个子节点 —— 改错故障：快照提示被塞进摘要行，与状态标签挤在同一行
// INV-18 断言：父块不支持手动展开，canToggle 与 forceOpen 均为 false —— 守住它的位置：ToolLayout 的属性 —— 改错故障：出现空的展开入口，点开只有重复摘要
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { BotIcon } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import type { AgentColor } from "@zcode/shared";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName, SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { getLatestExploreChildSummaryFromChildren } from "./explore.js";
import { AgentPromptSection } from "./agentPromptSection.js";
import {
  formatAgentMessage,
  getAgentColor,
  getAgentKindLabel,
  getAgentActivityContent,
  getAgentPrimaryText,
  getAgentPrompt,
  readBackgroundAgentInfo,
} from "./agentHelpers.js";

// 图标在模块级只创建一次，是稳定的元素引用，父组件重渲染不会重建它
// 若下移到函数体内联创建，每次渲染都会给出新元素，让 ToolLayout 的浅比较失效
// 尺寸与颜色写在类名里，不要在此处按主题分支切换
const AGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

// 该组件只承接已确认存在子工具的展示，空数组情形在函数体内兜底
// 所有回调原样透传给嵌套渲染器，本层不改写调用语义，也不补默认值
// depth 固定为 1：层级关系已由父块表达，继续加深只会造成重复缩进
// 这里不做排序与过滤，渲染顺序即协议下发的 childToolCalls 顺序
function AgentChildToolList({
  nestedToolRenderer,
  childToolCalls,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onLoadFullToolCallFields,
}: {
  nestedToolRenderer: ToolCallBlockRenderContext["nestedToolRenderer"];
  childToolCalls: ToolCallBlockRenderContext["toolCallNode"]["childToolCalls"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  onOpenAutomationsMain?: ToolCallBlockRenderContext["onOpenAutomationsMain"];
  onLoadFullToolCallFields?: ToolCallBlockRenderContext["onLoadFullToolCallFields"];
}) {
  // 空数组必须返回 null：折叠态下多一个空节点会撑出间距，且外层 space-y 会把它算作一个子项
  // 不要退回 Fragment 或空字符串，两者同样会被父级布局计入间隔
  // 判定用长度严格等于零，childToolCalls 恒为数组，不要改成真假值判断
  if (childToolCalls.length === 0) {
    return null;
  }

  // 先取出渲染器再以大写变量名当组件使用，满足 JSX 大写标签约定
  // 直接写 context.nestedToolRenderer 会被当成字符串标签而不是组件
  // 这层别名无副作用，父级已保证渲染器注入，不要在这里补判空分支
  const ToolCallBlock = nestedToolRenderer;
  return (
    <div className="space-y-2">
      {childToolCalls.map((childToolCallNode) => (
        <ToolCallBlock
          key={childToolCallNode.toolCall.toolId}
          toolCallNode={childToolCallNode}
          depth={1}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          showIcon={false}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenAutomationsMain={onOpenAutomationsMain}
          onLoadFullToolCallFields={onLoadFullToolCallFields}
          suppressSourceLabel
        />
      ))}
    </div>
  );
}

// thought 与 activity 共用同一个渲染壳，只有标题文案不同，避免两套样式漂移
// 容器限高并允许内部滚动，长输出不会把摘要区整块顶开
// 关闭 markdown 表格吸底滚动条，防止出现内外两层滚动
// 关闭吸底后表格宽内容仍在横向容器内，窄屏不会截断
function AgentActivitySection({
  label,
  content,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  label: string;
  content: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  return (
    // 使用 section 而非 div，屏幕阅读器可按区域跳读活动内容
    // 外层间距与内部卡片边框配合，多个活动块之间节奏一致
    // 不要在这里加 key 或出现动画，显隐完全由父级条件渲染决定
    <section className="space-y-2">
      <div className="rounded-lg border border-border bg-background-alt/40 flex flex-col">
        <h4 className="p-3 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {label}
        </h4>
        <div className="overflow-auto max-h-64" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent 活动内容同样可能包含长代码/路径，允许横向滚动避免窄屏截断。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {content}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}

// 标签列定宽、值列取剩余宽度，保证长路径可换行而不是撑破卡片
// 值列的 min-w-0 是必需的，缺省时网格子项最小宽度会把卡片顶宽
function BackgroundAgentProcessRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
      <div className="text-foreground-subtlest">{label}</div>
      <div className="min-w-0 text-foreground-subtle">{children}</div>
    </div>
  );
}

// 名称截断后仍保留 title 属性，悬停可以看到完整名称
// 最大宽度限制摘要行占用，避免长名称把主文案挤成省略号
// 颜色来自色板常量映射，不要在此处再做主题条件判断
function AgentNameText({ color, name }: { color: AgentColor; name: string }) {
  return (
    <span
      className={cn(
        // 行内弹性布局与一点五倍行高是配合摘要行节奏的显式设定
        // 去掉行内弹性布局后基线对齐会让名称相对周围文字上下抖动
        // 等宽字体让名称与摘要里的标识符保持同一字形节奏
        // 子智能体名在 tool summary 行内不能依赖字体基线对齐。
        // inline-flex 负责垂直居中，1.5 倍行高保持和周围摘要文字一致的阅读节奏。
        "inline-flex max-w-36 items-center truncate font-mono text-ui-base font-medium leading-[1.5]",
        SUBAGENT_TEXT_COLOR_CLASS[color],
      )}
      title={name}
    >
      {name}
    </span>
  );
}

// 该区块只读展示启动与活动两行状态，不订阅任何进度事件
// status 与 isRunning 是两个维度：一个表达启动结果，一个表达运行中
// 输出文件行仅在协议回传 outputFile 时渲染，缺失即整行不出现
// 三处文案全部走国际化，缺 key 时回退中文默认值
function BackgroundAgentProcessSection({
  outputFile,
  hasActivity,
  isRunning,
  status,
}: {
  outputFile?: string;
  hasActivity: boolean;
  isRunning: boolean;
  status: string | undefined;
}) {
  // 只解构 intl，避免整包持有上下文对象带来的多余比较
  // 文案取值应在调用期读取最新的 intl，本组件内不做跨渲染缓存
  const { intl } = useZCodeIntl();
  const msg = (id: string, fallback: string) => formatAgentMessage(intl, id, fallback);
  // 启动状态只有失败、进行中、已启动三种，未知状态一律归入已启动
  // 判断顺序不可调换：失败必须优先于进行中，否则失败会被覆盖成启动中
  // 文案与下面的 kind 必须成对更新，UI 断言依赖 kind 而不是文案
  const launchStatus =
    status === "failed"
      ? msg("chat.toolCall.agent.backgroundLaunchFailed", "启动失败")
      : status === "pending"
        ? msg("chat.toolCall.agent.backgroundLaunching", "启动中")
        : msg("chat.toolCall.agent.backgroundLaunched", "已启动");
  const launchStatusKind =
    status === "failed" ? "failed" : status === "pending" ? "pending" : "launched";
  // 活动状态由运行态与是否已有输出交叉得出四种组合
  // 运行中且已有输出表达为正在同步，运行中无输出表达为等待输出
  // 结束后无论有无输出都要给终态文案，避免摘要停在运行中字眼
  // 这里不做节流，切换频率由上层渲染节奏决定
  const activityStatus = isRunning
    ? hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityStreaming", "后台运行中，正在同步输出")
      : msg("chat.toolCall.agent.backgroundActivityRunningWaiting", "后台运行中，等待输出")
    : hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityReceived", "已收到子智能体回传")
      : msg("chat.toolCall.agent.backgroundActivityWaiting", "等待子智能体回传");
  // kind 是对外稳定枚举，取值四选一，不能随意新增或改名
  // 新增分支必须同步更新此处取值，否则测试读到未定义属性
  // 不要拿文案反推状态，文案会随语言变化而失效
  const activityStatusKind = isRunning
    ? hasActivity
      ? "streaming"
      : "running_waiting"
    : hasActivity
      ? "received"
      : "waiting";

  return (
    // 两个 data 属性是端到端测试的观测锚点，改名等同于破坏测试契约
    // 属性值必须取自上面算好的 kind，不要就地内联三元表达式
    <section
      data-background-agent-activity-status={activityStatusKind}
      data-background-agent-launch-status={launchStatusKind}
      className="rounded-lg border border-border bg-background-alt/40 p-3 text-ui-base"
    >
      <div className="font-medium text-foreground-subtle">
        {msg("chat.toolCall.agent.backgroundProcess", "后台 Agent 过程")}
      </div>
      <div className="mt-2 space-y-2">
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundLaunch", "启动")}>
          {launchStatus}
        </BackgroundAgentProcessRow>
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundActivity", "活动")}>
          {activityStatus}
        </BackgroundAgentProcessRow>
        {outputFile ? (
          <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.outputFile", "输出文件")}>
            <span className="block break-all rounded-md bg-background px-2 py-1 font-mono text-foreground-subtle">
              {outputFile}
            </span>
          </BackgroundAgentProcessRow>
        ) : null}
      </div>
    </section>
  );
}

// 父 Agent 块在对话流里只保留单行摘要，完整子时间线从右侧面板查看
// 组件不持有本地状态，全部输入来自渲染上下文，可被上层自由重挂载
// 不在此处读取服务或 store，任何异步取数都应留在上层
// 组装顺序固定：先解析数据，再算派生布尔，最后构造渲染闭包
export function AgentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  // 只解构需要的两个字段，避免整份上下文参与后续依赖比较
  // childToolCalls 在本层只服务摘要与子列表，不参与生命周期判断
  // toolCall 是不可变快照，流式更新会整体替换对象而不是就地修改
  const { toolCall, childToolCalls } = context.toolCallNode;
  const prompt = getAgentPrompt(toolCall);
  const fallbackLabel = formatAgentMessage(intl, "chat.toolCall.agent.fallback", "SubAgent");
  const primaryText = getAgentPrimaryText(toolCall, fallbackLabel);
  // 名称可能为空串，表示协议未给出类型，此时不渲染名称徽标
  // 权威类型优先于工具入参里的类型，顺序由该函数内部保证
  // 第二个参数的空串是显式占位，表示不提供本地化回退名
  const agentName = getAgentKindLabel(toolCall, "", context.authoritativeAgentType);
  const configuredAgentColor = useToolPresentationCapabilities().agentColor?.(agentName);
  // 颜色解析三层优先级：展示能力配置、工具自带、名称哈希回退
  // 配置回调返回空值时继续向下取，不能提前短路掉后两层
  // 名称缺失时整体置空，名称与颜色必须同时存在或同时缺失
  // 哈希回退保证同名 Agent 在不同会话里颜色一致
  const agentColor = agentName
    ? (configuredAgentColor ?? getAgentColor(toolCall) ?? resolveSubagentColorFromName(agentName))
    : null;
  // 名称与颜色同时具备才构造元素，避免渲染出只有颜色的空壳
  // 折叠与展开传入同一个元素，两种状态视觉完全一致
  // 这里只是元素而非组件，随父组件重渲染重建即可
  const agentNameDetail =
    agentName && agentColor ? <AgentNameText color={agentColor} name={agentName} /> : null;
  // 这条边界是协议约定：父工具结束后子工具明细不再续命
  // 一旦让子工具状态参与运行判定，完成后块会继续闪烁并保留子摘要
  // 渐变、动画与子摘要都由该布尔驱动，不要分叉出第二个运行态变量
  // Agent 父块的完成/进行中边界只由父 Agent tool 决定。
  // 子 tool 是展开区明细，不能反向续住父块运行态，否则父 Agent completed 后
  // 仍会显示渐变和子工具摘要，和协议里的父工具生命周期不一致。
  const isAgentVisuallyRunning = context.isRunning;
  // 仅父块仍运行时才计算子摘要，完成态直接短路掉整个分支
  // 计算函数接收国际化对象与完整上下文，属纯派生，不要外提缓存
  // 传入带动作类型标签的开关，让摘要不止显示动词而缺少对象
  const collapsedChildSummary = isAgentVisuallyRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  // 该函数返回结构化后台信息或空值，空值是判断非后台 Agent 的唯一依据
  // 不要用工具名做字符串匹配，后台标记的解析规则统一收敛在辅助模块
  const backgroundAgentInfo = readBackgroundAgentInfo(toolCall);
  const activityContent = getAgentActivityContent(toolCall);
  const activityThought = toolCall.thought?.trim();
  // Agent 块和它内部的子工具都已经通过层级表达了来源，
  // 继续显示子智能体来源 badge 会制造重复噪音。
  // 显式置空是刻意为之：层级已经表达来源，再加徽标就是重复信息
  // 不要改写为条件表达式，该属性本身允许空值
  // 若将来要恢复来源标签，需同步去掉子列表的来源抑制开关
  const sourceLabel = undefined;
  // 折叠与展开两个摘要片段分别缓存，不能共用同一个元素引用
  // 共用会让布局误判内容未变，从而跳过内容过渡动画
  const collapsedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const expandedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  // 摘要动作在原有定义上补充无障碍标签，其余字段原样透传
  // 上下文未提供动作时返回空值，布局据此不渲染操作按钮
  const summaryAction = useMemo(
    () =>
      context.agentSummaryAction
        ? {
            ...context.agentSummaryAction,
            ariaLabel: formatAgentMessage(
              intl,
              "chat.toolCall.agent.openInSidePane",
              "Open on the right",
            ),
          }
        : undefined,
    [context.agentSummaryAction, intl],
  );
  // 渲染闭包必须缓存，ToolLayout 按引用判断内容是否变化
  // 新增任何上下文字段都要补进下方依赖数组，否则闭包读到旧值
  // 函数体只做组装，不发起请求、不写状态，也不做副作用
  const renderContent = useCallback(
    () => (
      // 左边框加左外边距与左内边距，形成子时间线的视觉缩进
      // 块间距比摘要区更松，因为这里放的是多块富内容
      // 不要在这层加溢出隐藏，活动区自己负责滚动
      <div className="ml-2 space-y-3 border-border border-l pl-3.5">
        {backgroundAgentInfo ? (
          <BackgroundAgentProcessSection
            outputFile={backgroundAgentInfo.outputFile}
            hasActivity={Boolean(activityContent || activityThought)}
            isRunning={isAgentVisuallyRunning}
            status={toolCall.status}
          />
        ) : null}
        {prompt ? (
          <AgentPromptSection
            prompt={prompt}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityThought ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.thought", "Agent thought")}
            content={activityThought}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityContent ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.output", "Agent output")}
            content={activityContent}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        <AgentChildToolList
          nestedToolRenderer={context.nestedToolRenderer}
          childToolCalls={childToolCalls}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onLoadFullToolCallFields={context.onLoadFullToolCallFields}
        />
      </div>
    ),
    [
      activityContent,
      activityThought,
      backgroundAgentInfo,
      childToolCalls,
      context.codePreviewSettings,
      context.onLoadFullToolCallFields,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      isAgentVisuallyRunning,
      prompt,
      toolCall.status,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={AGENT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        forceOpen={false}
        summaryAction={summaryAction}
        // 产品边界：Agent/Task 在父对话中只保留单行摘要；完整 child timeline 统一从
        // 右侧 tab / 手机抽屉查看，因此这里既不自动展开，也不提供手动展开入口。
        kindLabel={fallbackLabel}
        expandedKindLabel={fallbackLabel}
        kindDetail={agentNameDetail}
        expandedKindDetail={agentNameDetail}
        sourceLabel={sourceLabel}
        autoCollapseOnComplete
        primaryText={
          collapsedChildSummary ? collapsedChildSummary.primaryText : collapsedPrimaryText
        }
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ?? `agent:${toolCall.toolId}:${primaryText}`
        }
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isAgentVisuallyRunning}
        title={collapsedChildSummary?.title ?? primaryText}
        expandedTitle={primaryText}
        renderContent={renderContent}
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
