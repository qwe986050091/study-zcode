// INV-01 侧栏只做只读渲染、不持有任何业务状态；守住位置：Sidebar 函数体与全部子分区函数；改错故障：侧栏显示与权威 session 状态分叉，用户看到过期或错误状态。
// INV-02 全部数据经 props 注入且类型为 SidebarState 投影；守住位置：SidebarProps 类型声明；改错故障：宿主少传字段时侧栏直接崩溃或整段空白。
// INV-03 copy 缺省时回退 DEFAULT_TUI_COPY；守住位置：各渲染函数首行的 copy 取值；改错故障：未注入 i18n 时所有分区标题渲染为空或抛错。
// INV-04 developerMode 只增删调试分区、不改变核心分区顺序；守住位置：Sidebar 内四处条件展开；改错故障：普通用户丢失核心分区，或调试分区插错位置。
// INV-05 sectionExpansion 缺省按展开处理；守住位置：各分区的 expanded 取值处；改错故障：宿主未持久化展开态时分区的默认可见性反转。
// INV-06 折叠意图一律经 onToggleSection 上抛，组件不自持折叠态；守住位置：各分区 onToggle 闭包；改错故障：点击标题无反应，或本地态与宿主态长期不一致。
// INV-07 侧栏宽度与内容宽度只取自布局常量；守住位置：SIDEBAR_WIDTH 与 SIDEBAR_CONTENT_WIDTH 的使用点；改错故障：内容溢出撑破侧栏，或留白宽度错位。
// INV-08 所有文本行固定 1 行高、不换行、超宽截断；守住位置：SIDEBAR_TEXT_ROW_STYLE 与 truncateDisplay 调用；改错故障：长路径或长 todo 把侧栏撑开并挤压主区。
// INV-09 键值行 label 定宽 9 列、value 截断到剩余宽度；守住位置：rowLine 与 SIDEBAR_ROW_VALUE_WIDTH；改错故障：同分区内冒号列参差，数值被挤到换行。
// INV-10 statusDetails 最多展示 2 条、lastError 单独追加；守住位置：statusLines 的 slice 与 lastError 分支；改错故障：错误刷屏顶掉其他分区，或错误被静默吞掉。
// INV-11 todos 最多列 6 条、超出追加 more 提示；守住位置：todoLines 的 slice 与长度判断；改错故障：长任务列表占满侧栏，进度与页脚不可见。
// INV-12 空 todos 只显示 empty 文案并提前返回；守住位置：todoLines 的空列表分支；改错故障：空态多出无意义进度行或留下空白分区。
// INV-13 缓存命中率仅在 inputTokens 大于 0 时计算；守住位置：cacheHitLabel 的除法前置条件；改错故障：除零得到 NaN 或 Infinity 并直接显示在界面。
// INV-14 上下文窗口缺失或非正时不计算百分比；守住位置：contextUsedLabel 的 window 判断；改错故障：未知窗口时显示荒谬百分比误导用户。
// INV-15 页脚依赖 flexGrow 占位吸底；守住位置：Sidebar 末尾的空 box 与 footer 节点；改错故障：内容稀疏时页脚悬在半空，视觉断裂。
// INV-16 可空 props 一律以 - 占位而不是直出 undefined；守住位置：runLines、contextLines 与 workspaceFooterLabel；改错故障：界面出现 undefined 字样。
// INV-17 MCP、改动文件与子 Agent 复用既有分区组件而非在此重绘；守住位置：McpSection、ModifiedFilesSection 与 SubagentsSection 调用；改错故障：同一数据出现两条渲染路径并行为漂移。
// INV-18 本组件不处理键盘、焦点、选中态与滚动，也不发起任何 IO；守住位置：整个文件无事件订阅与副作用；改错故障：宿主与侧栏争抢按键，或引入不可观测副作用。
//
// 模块职责：把宿主投影好的只读快照编排成纵向侧栏，涵盖版本头、状态、子 Agent、MCP、改动文件、todos 与开发者调试分区。
// 状态所有权：业务状态归 session 层，展开态归宿主，本文件只读 props 并通过回调上抛用户意图。
// 阅读顺序：先看 Sidebar 的纵向分区骨架，再看 sidebarSection 容器，最后看各 lines 与 Label 纯函数。
// 侧栏主视图组装。
// 职责：纵向堆叠版本头、状态、子 Agent、MCP、改动文件、todos 等分区。
// 边界：全部数据来自 props，不持有业务状态、不订阅事件。
// 副作用：无 IO；折叠回调经 onToggleSection 上抛给宿主。
// 口径：developerMode 只决定调试分区是否出现，不改变核心分区顺序。

import { TextAttributes } from "@mbears/opentui-core";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { CacheStats, ContextUsage, SidebarState } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts } from "./app-model-ref.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import { formatNumber } from "./state.js";
import { ApiSection } from "./app-sidebar-api.js";
import { McpSection } from "./app-sidebar-mcp.js";
import { ModifiedFilesSection } from "./app-sidebar-modified-files.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { SubagentsSection } from "./app-sidebar-subagents.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";
import {
  SIDEBAR_CONTENT_WIDTH,
  SIDEBAR_HORIZONTAL_PADDING_COLUMNS,
  SIDEBAR_WIDTH,
  type SidebarSectionId,
  type SidebarSectionExpansion,
} from "./app-sidebar-layout.js";

export { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 行宽常量：label 定宽 9 列，todos 内容区比内容宽度再少 4 列（留给状态标记与缩进），
// 所有行统一 1 行高、不换行、超宽截断，避免侧边栏被长文本撑开。
const SIDEBAR_LABEL_WIDTH = 9;
const SIDEBAR_ROW_VALUE_WIDTH = SIDEBAR_CONTENT_WIDTH - SIDEBAR_LABEL_WIDTH - 1;
const SIDEBAR_TODO_CONTENT_WIDTH = SIDEBAR_CONTENT_WIDTH - 4;
const SIDEBAR_TEXT_ROW_STYLE = { flexShrink: 0, height: 1, truncate: true, wrapMode: "none" };
const PRODUCT_NAME = "ZCode";
const PRODUCT_NAME_WIDTH = displayWidth(PRODUCT_NAME);
const DEFAULT_PRODUCT_VERSION = "0.0.0";
const DEFAULT_MCP_STATUS = { loading: false, servers: {} };

// 侧边栏 props：继承 SidebarState（由 session 投影出的只读业务快照），
// 额外注入 subagents 控制器、section 展开态、i18n copy 与版本号等展示参数。
// 可空口径：subagents/copy/version/sectionExpansion 均可缺省（缺省用默认文案与全部展开）；
// developerMode 为 true 时额外渲染 run/context/apis 等调试分区，否则只保留核心分区。
type SidebarProps = SidebarState & {
  subagents?: SubagentsController;
  onOpenSubagent?: (item: SubagentItem) => void;
  copy?: TuiCopy;
  developerMode?: boolean;
  onToggleSection?: (section: SidebarSectionId) => void;
  sectionExpansion?: SidebarSectionExpansion;
  version?: string;
};

// 侧边栏主视图：纵向堆叠「版本头 → 状态 → 子 Agent → (run) → MCP → 改动文件 → (context) → todos → (apis) → 工作区页脚」。
// 输入全部来自 props，组件不持有业务状态，也不订阅事件；切换回调通过 onToggleSection 上抛。
// 分区顺序固定，developerMode 只决定调试分区是否出现，不改变核心分区的位置。
// 渲染不变量：footer 用 flexGrow 占位吸底，保证内容少时也不会让页脚悬在中间。
// 组件入口 AppSidebar 只做一次函数式渲染而不持有 hooks、state 与订阅，只在最后输出一个根 box。
// 入参只读：copy 与 developerMode 在入口一次性解析，后续子函数共享同一份语义。
// 交互归属：按键与焦点都归宿主，AppSidebar 只声明 layout 与回调。
export function Sidebar(props: SidebarProps): React.ReactElement {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const developerMode = props.developerMode === true;
  return h(
    "box",
    {
      style: {
        backgroundColor: palette.panelAlt,
        border: false,
        flexDirection: "column",
        flexShrink: 0,
        height: "100%",
        padding: SIDEBAR_HORIZONTAL_PADDING_COLUMNS,
        width: SIDEBAR_WIDTH,
      },
    },
    // 版本头永远第一个渲染，保证品牌与版本号位置稳定，不随其他分区增减而移动。
    // 品牌名占用 PRODUCT_NAME_WIDTH 而版本号占用剩余列宽，两段互不挤压。
    // 版本缺省走 DEFAULT_PRODUCT_VERSION，避免界面出现 undefined 或空串。
    productVersionHeader(props.version),
    ...(developerMode
      ? [
          h(
            "text",
            { key: "developer-subtitle", style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.muted } },
            copy.sidebar.shellSubtitle,
          ),
        ]
      : []),
    sidebarSection(copy.sidebar.sections.status, statusLines(props)),
    // 子 Agent 是可选分区：宿主未注入 controller 时整段不渲染，不占任何行高。
    // onOpen 缺省回退到 controller 自带的 open，减少宿主额外接线。
    // expanded 缺省为 true，展开态由 sectionExpansion 决定并经 onToggle 上抛。
    props.subagents
      ? h(SubagentsSection, {
          controller: props.subagents,
          copy,
          expanded: props.sectionExpansion?.subagents ?? true,
          onToggle: () => props.onToggleSection?.("subagents"),
          onOpen: props.onOpenSubagent ?? props.subagents.open,
        })
      : null,
    // run 分区只存在于开发者模式而位置固定在子 Agent 与 MCP 之间。
    // 条件展开用数组展开语法，数组为空即不占位，不产生多余行或空 key。
    // 分区顺序是隐性契约：调整顺序会改变用户定位调试信息的肌肉记忆。
    ...(developerMode ? [sidebarSection(copy.sidebar.sections.run, runLines(props))] : []),
    McpSection({
      copy,
      expanded: props.sectionExpansion?.mcp ?? true,
      mcpStatus: props.mcpStatus ?? DEFAULT_MCP_STATUS,
      onToggle: () => props.onToggleSection?.("mcp"),
    }),
    // 改动文件分区把 modifiedFiles 原样透传而不在本层过滤、去重或排序。
    // 数据归属在 session 投影层，侧栏只负责把列表渲染成固定高度的区块。
    // 折叠回调固定携带 modifiedFiles 标识，避免与相邻分区串号。
    ModifiedFilesSection({
      copy,
      expanded: props.sectionExpansion?.modifiedFiles ?? true,
      files: props.modifiedFiles,
      onToggle: () => props.onToggleSection?.("modifiedFiles"),
    }),
    ...(developerMode ? [sidebarSection(copy.sidebar.sections.context, contextLines(props))] : []),
    // todos 是核心分区且可折叠，标题点击回调固定携带 todos 标识。
    // 行内容在 todoLines 中一次算完，容器只承担标题与展开门控。
    // developerMode 不影响 todos 的位置，普通用户同样能看到任务进度。
    sidebarSection(copy.sidebar.sections.todos, todoLines(props), {
      expanded: props.sectionExpansion?.todos ?? true,
      onToggle: () => props.onToggleSection?.("todos"),
    }),
    ...(developerMode
      ? [
          ApiSection({
            copy,
            expanded: props.sectionExpansion?.apis ?? true,
            networkRequests: props.networkRequests,
            onToggle: () => props.onToggleSection?.("apis"),
            usage: props.usage,
          }),
        ]
      : []),
    // 弹性占位 box 吸收剩余高度，把工作区页脚压到侧栏底部。
    // 缺少该占位时内容稀疏会让页脚停在中间，视觉上像是布局断裂。
    // 页脚只读工作区路径与 git 分支，不参与比较或交互。
    h("box", { style: { flexGrow: 1 } }),
    h(
      "text",
      { style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: palette.muted } },
      workspaceFooterLabel(props),
    ),
  );
}

// 版本头：左侧品牌名（accent 加粗），右侧版本号（muted，缺省 "0.0.0"）；
// 两段宽度固定分配，保证版本号再长也不会挤掉品牌名。
function productVersionHeader(version: string | undefined): React.ReactElement {
  return h(
    "box",
    {
      key: "product-version",
      style: {
        flexDirection: "row",
        flexShrink: 0,
        height: 1,
        width: SIDEBAR_CONTENT_WIDTH,
      },
    },
    h(
      "text",
      {
        key: "product-name",
        style: {
          ...SIDEBAR_TEXT_ROW_STYLE,
          attributes: TextAttributes.BOLD,
          fg: palette.accent,
          width: PRODUCT_NAME_WIDTH,
        },
      },
      PRODUCT_NAME,
    ),
    h(
      "text",
      {
        key: "product-version",
        style: {
          ...SIDEBAR_TEXT_ROW_STYLE,
          fg: palette.muted,
          width: SIDEBAR_CONTENT_WIDTH - PRODUCT_NAME_WIDTH,
        },
      },
      ` ${version ?? DEFAULT_PRODUCT_VERSION}`,
    ),
  );
}

// 通用分区容器：collapse 有值时渲染可折叠标题（默认展开），否则渲染不可折叠的加粗标题；
// children 是已计算好的行节点数组，容器只负责纵向布局与 1 行顶部间距。
// 通用分区容器：collapse 存在时渲染可折叠标题，否则渲染不可折叠加粗标题。
// children 已由调用方算好，容器不再遍历原始数据，避免渲染期重复计算。
// marginTop 固定 1 行，是分区之间的唯一间距来源而便于整体调整密度。
function sidebarSection(
  title: string,
  children: React.ReactNode[],
  collapse?: { expanded: boolean; onToggle: () => void },
): React.ReactElement {
  return h(
    "box",
    {
      key: title,
      style: {
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
      },
    },
    collapse
      ? SidebarSectionHeader({ ...collapse, title })
      : h(
          "text",
          {
            style: {
              ...SIDEBAR_TEXT_ROW_STYLE,
              attributes: TextAttributes.BOLD,
              fg: palette.accent,
            },
          },
          title,
        ),
    // 展开门控只作用于 children：折叠时标题保留、内容整段丢弃。
    // 折叠时卸载而非 display:none：不占纵向空间，侧栏高度随之还原。
    // 缺省 expanded 视为 true，宿主未给展开态时分区默认可见。
    ...((collapse?.expanded ?? true) ? children : []),
  );
}

// 状态分区：busy 时状态行用强调色、否则正文色；最多展示 2 条 statusDetails，
// 有 lastError 时追加 error 行（danger 色）。只做展示，不改变状态本身。
// 状态行颜色由 busy 决定：运行中用强调色，空闲用正文色，只改颜色不改文案。
// 本分区不修改任何状态，状态真相仍由宿主投影进 props。
// statusDetails 与 lastError 属于补充信息，固定排在主状态行之后。
function statusLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const lines = [
    textLine(
      truncateDisplay(props.status, SIDEBAR_CONTENT_WIDTH),
      props.busy ? palette.accent : palette.text,
      "status",
    ),
    rowLine(copy.sidebar.status.last, props.lastEvent, "last"),
  ];

  for (const detail of props.statusDetails.slice(0, 2)) {
    lines.push(
      textLine(truncateDisplay(detail, SIDEBAR_CONTENT_WIDTH), palette.warning, `detail-${detail}`),
    );
  }
  // 失败路径：lastError 非空时追加一行 danger 色错误，不覆盖已有行。
  // 错误行放在详情之后，保证主状态与进度信息先被用户看到。
  // lastError 按内容宽度截断，避免一条错误撑破整个侧栏。
  if (props.lastError) {
    lines.push(
      textLine(truncateDisplay(props.lastError, SIDEBAR_CONTENT_WIDTH), palette.danger, "error"),
    );
  }
  return lines;
}

// run 分区（仅开发者模式）：展示 mode/provider/model/thought/workspace/turn/trace/消息数/草稿长度；
// 缺省值统一显示 "-"，避免 undefined 直接出现在界面上。
function runLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const modelParts = modelDisplayParts(props.model);
  return [
    rowLine(copy.sidebar.run.mode, props.mode, "mode"),
    rowLine(copy.sidebar.run.provider, modelParts.provider, "provider"),
    rowLine(copy.sidebar.run.model, modelParts.model, "model"),
    rowLine(copy.sidebar.run.thought, props.thoughtLevel, "thought"),
    rowLine(copy.sidebar.run.workspace, props.workspaceDirectory ?? "-", "workspace"),
    rowLine(copy.sidebar.run.turn, props.activeTurnId ?? "-", "turn"),
    rowLine(copy.sidebar.run.trace, props.traceId ?? "-", "trace"),
    rowLine(copy.sidebar.run.messages, String(props.messageCount), "messages"),
    rowLine(
      copy.sidebar.run.draft,
      props.draft ? copy.sidebar.run.draftChars(props.draft.length) : copy.sidebar.run.draftEmpty,
      "draft",
    ),
  ];
}

// context 分区（仅开发者模式）：展示上下文窗口、已用 token、输入/输出/推理 token 与缓存命中读写。
// usage 缺失时相关行显示 "-"；cache 命中率仅在 inputTokens > 0 时计算，避免除零。
function contextLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const usage = props.usage;
  return [
    rowLine(
      copy.sidebar.context.window,
      formatOptionalNumber(props.contextUsage.contextWindow),
      "window",
    ),
    rowLine(copy.sidebar.context.used, contextUsedLabel(props.contextUsage), "used"),
    rowLine(
      copy.sidebar.context.tokens,
      usage ? `${formatNumber(usage.totalTokens)} ${copy.sidebar.cache.total}` : "-",
      "tokens",
    ),
    rowLine(
      copy.sidebar.context.inputOutput,
      usage
        ? `${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`
        : "-",
      "io",
    ),
    rowLine(
      copy.sidebar.context.reason,
      usage ? formatNumber(usage.reasoningTokens) : "-",
      "reasoning",
    ),
    rowLine(copy.sidebar.context.cache, cacheHitLabel(usage, props.cacheStats, copy), "cache"),
    rowLine(
      copy.sidebar.context.cacheReadWrite,
      cacheReadWriteLabel(usage, props.cacheStats, copy),
      "cache-rw",
    ),
  ];
}

// todos 分区：先展示 completed/total 进度，再最多列 6 条（带状态标记与状态色）；
// 空列表时只显示 empty 文案；超出 6 条追加 "more(N)" 提示，保持分区高度上限固定。
function todoLines(props: SidebarProps): React.ReactNode[] {
  const copy = props.copy ?? DEFAULT_TUI_COPY;
  const completed = props.todos.filter((todo) => todo.status === "completed").length;
  const lines = [
    rowLine(copy.sidebar.todos.progress, `${completed}/${props.todos.length}`, "todo-progress"),
  ];

  // 空态分支：todos 为空时只渲染 empty 文案并立即返回。
  // 提前返回避免继续计算进度与 more 提示，空列表不产生多余行。
  // 空态文案走 i18n copy，缺省时由 DEFAULT_TUI_COPY 兜底。
  if (props.todos.length === 0) {
    lines.push(textLine(copy.sidebar.todos.empty, palette.muted, "todo-empty"));
    return lines;
  }

  // 截断策略：最多渲染 6 条 todo，分区高度上限因此固定。
  // key 由序号与正文拼成，正文变化时强制重建行，避免复用旧文本。
  // 正文按 SIDEBAR_TODO_CONTENT_WIDTH 截断，为状态标记与缩进预留列。
  for (const [index, todo] of props.todos.slice(0, 6).entries()) {
    lines.push(
      textLine(
        `${todoMarker(todo.status)} ${truncateDisplay(todo.content, SIDEBAR_TODO_CONTENT_WIDTH)}`,
        todoColor(todo.status),
        `todo-${index}-${todo.content}`,
      ),
    );
  }
  if (props.todos.length > 6) {
    lines.push(
      textLine(copy.sidebar.todos.more(props.todos.length - 6), palette.muted, "todo-more"),
    );
  }
  return lines;
}

// 键值行：label 定宽 9 列左对齐，value 截断到剩余宽度，中间 1 列间隔，保证纵向对齐。
// 键值行布局：label 右补空格到 9 列，value 截断到剩余宽度。
// 固定列宽让同分区多行的冒号列对齐，降低纵向扫读成本。
// 中间 1 列空格是 label 与 value 的硬间隔，改宽度需同步两个常量。
function rowLine(label: string, value: string, key: string): React.ReactElement {
  return textLine(
    `${padEndDisplay(label, SIDEBAR_LABEL_WIDTH)} ${truncateDisplay(value, SIDEBAR_ROW_VALUE_WIDTH)}`,
    palette.text,
    key,
  );
}

function textLine(value: string, color: string, key: string): React.ReactElement {
  // Yoga can shrink sidebar text rows to 0 height under pressure while the
  // native text buffer still draws glyph tails into the next row.
  return h("text", { key, style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: color } }, value);
}

// 按显示列宽右补空格；宽字符（中文等）按 2 列计，保证每行宽度恰好等于 targetCells。
function padEndDisplay(value: string, targetCells: number): string {
  const visible = truncateDisplay(value, targetCells);
  return `${visible}${" ".repeat(Math.max(0, targetCells - displayWidth(visible)))}`;
}

// 上下文档位文案：两者都缺失显示 "-"；有窗口且窗口 > 0 时显示"已用 (百分比)"；
// 只有已用值（窗口未知）时只显示数量，避免拿未知窗口做除法。
// 上下文档位文案：used 与 window 都缺失时输出 -，不猜默认值。
// 只有窗口为正数时才做除法，未知或零窗口一律不出百分比。
// 仅知已用量时只显示数字，避免用未知窗口制造假百分比。
function contextUsedLabel(contextUsage: ContextUsage): string {
  const used = contextUsage.contextUsed;
  const window = contextUsage.contextWindow;
  if (used === undefined && window === undefined) return "-";
  if (used !== undefined && window !== undefined && window > 0) {
    return `${formatNumber(used)} (${formatPercent(used / window)})`;
  }
  if (used !== undefined) return formatNumber(used);
  return "-";
}

// 缓存命中率：优先用 usage 的 cacheReadTokens/inputTokens（inputTokens 必须 > 0）；
// 无 usage 时退回最近一次请求的命中记录（lastCacheHit 布尔），都没有则显示 "-"。
function cacheHitLabel(
  usage: SidebarState["usage"],
  cacheStats: CacheStats | undefined,
  copy: TuiCopy,
): string {
  if (usage && usage.inputTokens > 0) {
    return `${formatPercent(usage.cacheReadTokens / usage.inputTokens)} ${copy.sidebar.cache.hit}`;
  }
  if (cacheStats?.lastCacheHit !== undefined) {
    return cacheStats.lastCacheHit ? copy.sidebar.cache.lastHit : copy.sidebar.cache.lastMiss;
  }
  return "-";
}

// 缓存读写文案：read 优先取 usage，缺失时退回 cacheStats；write 仅 usage 提供。
// 两者都 undefined 时返回 "-"，否则缺失的一侧按 "-" 占位以保证格式稳定。
function cacheReadWriteLabel(
  usage: SidebarState["usage"],
  cacheStats: CacheStats | undefined,
  copy: TuiCopy,
): string {
  const read = usage?.cacheReadTokens ?? cacheStats?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  if (read === undefined && write === undefined) return "-";
  return copy.sidebar.cache.readWrite({
    read: formatOptionalNumber(read),
    write: formatOptionalNumber(write),
  });
}

// 页脚文案：工作区路径，存在 git 分支时以 "path:branch" 拼接；整体截断到内容宽度。
function workspaceFooterLabel(props: SidebarProps): string {
  const workspace = props.workspaceDirectory ?? "-";
  const branch = props.workspaceGitBranch;
  const value = branch ? `${workspace}:${branch}` : workspace;
  return truncateDisplay(value, SIDEBAR_CONTENT_WIDTH);
}

// 可选数值格式化：undefined 显示 "-"，其余交给 formatNumber 做千分位/单位处理。
function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "-" : formatNumber(value);
}

// 百分比格式化：非有限数（NaN/Infinity，例如窗口为 0 时的除法结果）显示 "-"，
// 其余四舍五入到整数百分比，不带小数位以节省侧边栏列宽。
function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

// todo 状态标记：completed 用 [x]、in_progress 用 [>]、其余（pending）用 [ ]，
// 固定 3 字符宽度，保证多条 todo 的正文起始列一致。
// todo 状态标记固定占 3 列：[x] 完成 / [>] 进行中 / [ ] 未开始。
// 固定宽度让多条 todo 的正文起始列一致，列表可以纵向扫读。
// 状态集合由上游类型限定，这里按状态做穷尽映射并以未开始兜底。
function todoMarker(status: "completed" | "in_progress" | "pending"): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  return "[ ]";
}

// todo 正文配色：已完成用 muted 表示弱化，进行中用 accent 突出，未开始用正文色。
function todoColor(status: "completed" | "in_progress" | "pending"): string {
  if (status === "completed") return palette.muted;
  if (status === "in_progress") return palette.accent;
  return palette.text;
}
