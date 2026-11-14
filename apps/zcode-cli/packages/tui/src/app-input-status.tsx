// INV-01 组件纯展示不持有状态：守住位置 组件体；改错故障 重渲染出现状态漂移。
// INV-02 宽度单位统一为显示列：守住位置 全部宽度计算；改错故障 中文与图标按字符数算错。
// INV-03 宽度非法回落 80 且最小 8：守住位置 归一函数；改错故障 NaN 导致布局崩溃。
// INV-04 显式动画帧优先于激活标记：守住位置 渲染分支；改错故障 外部驱动与内部动画打架。
// INV-05 未传动画帧时不挂动画钩子：守住位置 静态分支；改错故障 空闲状态仍每帧重渲染。
// INV-06 徽标缺失时整体不渲染：守住位置 条件子节点；改错故障 出现空文本节点。
// INV-07 已用量非法即隐藏徽标：守住位置 合法性判断；改错故障 显示 NaN 用量。
// INV-08 窗口非法时只显示已用量：守住位置 窗口校验；改错故障 除零得到无穷百分比。
// INV-09 百分比四舍五入为整数：守住位置 格式化；改错故障 小数位抖动。
// INV-10 紧凑计数按 K 与 M 进位：守住位置 分段阈值；改错故障 百万级仍显示长数字。
// INV-11 放不下时先保证思考强度完整：守住位置 拟合入口；改错故障 关键信息先被裁掉。
// INV-12 provider 预算为剩余宽度的 40%：守住位置 预算计算；改错故障 provider 挤压模型名。
// INV-13 模型名与 provider 各至少保留 1 列：守住位置 下界夹取；改错故障 出现负宽度。
// INV-14 状态行高度恒为 1：守住位置 高度常量；改错故障 输入区高度跳动。
// INV-15 不改入参并返回新对象：守住位置 构造返回；改错故障 React 依赖比较失效。
// INV-16 截断按显示宽度而非字符数：守住位置 截断调用；改错故障 宽字符被截半。
// INV-17 徽标隐藏阈值固定为 4 列：守住位置 阈值常量；改错故障 极窄行出现乱码。
// INV-18 组件不缓存用量对象：守住位置 入参读取；改错故障 新用量不触发重渲染。
//
// 模块职责：渲染输入区的活动状态行与底部 composer 元信息，并做宽度拟合。
// 状态所有权：无状态；动画帧由外部驱动或内部钩子提供。
// 阅读顺序：先看两个入口组件，再读纯渲染行，最后看宽度拟合与格式化。
// 输入区状态行（L2）：运行时活动指示（spinner + 上下文用量）与底部 composer 元信息（模型/provider/effort）。
// 纯展示：不持有状态，不含副作用；宽度单位为显示列，宽度非法时回退 80，最小 8。
// 文本超宽时按优先级截断（thought 保留、model/provider 按比例分配），保证右侧内容不被裁掉。
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ContextUsage } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts } from "./app-model-ref.js";
import { spinnerFrame, useSpinnerFrame } from "./app-motion.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 行高均为 1 行；宽度常量单位为显示列。TOKEN_COUNT_KILO/MEGA 定义 token 数紧凑格式的进位单位。
const ACTIVE_STATUS_HEIGHT = 1;
const ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH = 1;
const ACTIVE_STATUS_CONTEXT_SPACER_WIDTH = 1;
const COMPOSER_STATUS_HEIGHT = 1;
const COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH = 0;
const COMPOSER_STATUS_MIN_METADATA_WIDTH = 8;
const STATUS_MIN_CONTEXT_WIDTH = 4;
const COMPOSER_STATUS_FALLBACK_WIDTH = 80;
const COMPOSER_STATUS_MIN_CONTENT_WIDTH = 8;
const TOKEN_COUNT_KILO = 1_000;
const TOKEN_COUNT_MEGA = TOKEN_COUNT_KILO * TOKEN_COUNT_KILO;
const TOKEN_COUNT_DECIMAL_PLACES = 1;

// composer 状态行的三段文本：model/provider 由 modelSelection 解析，thought 为空时用 "-" 占位。
type InputComposerStatusParts = {
  model: string;
  provider: string;
  thought: string;
};

// frameMs 与 active 的组合决定渲染分支：显式 frameMs 优先，其次才由 active 决定是否挂动画。
// 组件不缓存 ContextUsage，父层每次传入新对象即可触发重渲染。
// 运行时活动状态行。frameMs 显式传入时走无状态分支（供外部统一驱动动画帧）；
// active=false 且未传 frameMs 时也直接静态渲染，避免挂载无意义的动画 hook。
// InputActiveStatus 的分支只有两条：显式 frameMs 或 active=false 时走无状态 inputActiveStatusRow，
// frame 取 spinnerFrame(frameMs ?? 0)；否则挂 InputActiveStatusContent 订阅 useSpinnerFrame(true)。
// contentWidth 是父层已扣减面板 chrome 后的显示列数，组件不再二次换算；返回值恒为元素，active=false 时仍渲染空行以稳定高度（INV-14）。
export function InputActiveStatus({
  active,
  contentWidth,
  contextUsage,
  copy = DEFAULT_TUI_COPY,
  frameMs,
}: {
  active: boolean;
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy?: TuiCopy;
  frameMs?: number;
}): React.ReactElement {
  if (frameMs !== undefined || !active) {
    return inputActiveStatusRow(copy, active ? spinnerFrame(frameMs ?? 0) : undefined, {
      contentWidth,
      contextUsage,
    });
  }
  return h(InputActiveStatusContent, { contentWidth, contextUsage, copy });
}

// 内部动画分支：订阅 spinner 帧，把最新 frame 传给静态行渲染函数。
function InputActiveStatusContent({
  contentWidth,
  contextUsage,
  copy,
}: {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy: TuiCopy;
}): React.ReactElement {
  return inputActiveStatusRow(copy, useSpinnerFrame(true), { contentWidth, contextUsage });
}

// 只做参数转发到纯渲染行，不持有状态；contentWidth 由父层按面板 chrome 扣减后传入。
// 返回值恒为 React 元素，空 model 也会渲染（modelDisplayParts 会回落占位符）。
// 底部 composer 状态行：展示模型、provider 与推理强度；宽度不足时按比例截断。
// InputComposerStatus 只把 { contentWidth, model, thoughtLevel } 转交 inputComposerStatusRow，不做 memo 也不读 store；
// model 为空时 modelDisplayParts 会回落占位符，因此这里无需条件渲染；thoughtLevel 的空值由 inputComposerStatusParts 用 "-" 兜底。
export function InputComposerStatus({
  contentWidth,
  model,
  thoughtLevel,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
}): React.ReactElement {
  return inputComposerStatusRow({
    contentWidth,
    model,
    thoughtLevel,
  });
}

// frame 为 undefined 时不渲染左侧提示，右侧徽标仍会独占剩余宽度。
// 返回元素高度恒为 1 行，父层无需为有无 frame 做高度分支。
// 活动状态行的纯渲染（无 hook）。frame 缺省表示不显示 spinner 前缀，只显示右侧上下文徽标。
// 徽标按可用宽度截断；宽度不足最小阈值时整体隐藏，而不是挤成乱码。
// inputActiveStatusRow 先算右侧徽标：inputContextUsageBadge 只依赖 contextUsage，activeStatusContextBadgeWidth 依赖
// contentWidth/copy/frame；fitStatusContextBadge 在可用宽度 < STATUS_MIN_CONTEXT_WIDTH 时返回 undefined（INV-17），
// 宽度不足就整体隐藏而不是截成乱码；frame 为空时不渲染左侧 spinner 提示，contextBadge 为空时也不留 flexGrow 间隔；
// 根 box 高度固定 ACTIVE_STATUS_HEIGHT，父层无需按有无 frame 做高度分支。
export function inputActiveStatusRow(
  copy: TuiCopy,
  frame?: string,
  options: { contentWidth?: number; contextUsage?: ContextUsage } = {},
): React.ReactElement {
  const contextBadge = fitStatusContextBadge(
    inputContextUsageBadge(options.contextUsage),
    activeStatusContextBadgeWidth({
      contentWidth: options.contentWidth,
      copy,
      frame,
    }),
  );
  return h(
    "box",
    {
      style: {
        flexDirection: "row",
        height: ACTIVE_STATUS_HEIGHT,
        paddingLeft: 1,
        width: "100%",
      },
    },
    frame
      ? h(
          "box",
          { style: { flexDirection: "row", flexShrink: 0 } },
          h(
            "text",
            { style: { fg: palette.accent, flexShrink: 0, width: displayWidth(frame) } },
            frame,
          ),
          h("text", { style: { fg: palette.muted } }, " "),
          h("text", { style: { fg: palette.muted } }, copy.input.activeStatusHint),
        )
      : null,
    contextBadge ? h("box", { style: { flexGrow: 1, minWidth: 1 } }) : null,
    contextBadge ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, contextBadge) : null,
  );
}

// 三段文本在同一条 flex row 内排布，provider 与 model 共享可收缩空间。
// 不处理 loading 或错误态，状态语义完全由调用方通过传入文案表达。
// composer 状态行的纯渲染。parts 已按 maxWidth 拟合过，这里只做布局，不再截断。
export function inputComposerStatusRow({
  contentWidth,
  model,
  thoughtLevel,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
}): React.ReactElement {
  const parts = inputComposerStatusParts(
    model,
    thoughtLevel,
    composerStatusMetadataWidth(contentWidth),
  );
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        flexShrink: 0,
        height: COMPOSER_STATUS_HEIGHT,
        width: "100%",
      },
    },
    h(
      "box",
      { style: { flexDirection: "row", flexShrink: 1, minWidth: 1 } },
      h("text", { style: { fg: palette.text, flexShrink: 1 } }, parts.model),
      h("text", { style: { fg: palette.muted } }, ` ${parts.provider} | `),
      h("text", { style: { fg: palette.warning, flexShrink: 0 } }, parts.thought),
    ),
  );
}

// modelSelection 的解析口径与状态栏展示一致，均来自 modelDisplayParts。
// 始终返回新对象，不修改入参，可安全用于 React 依赖比较。
// 把 modelSelection 拆成 model/provider 两段，空 thought 用 "-" 占位，并按 maxWidth 拟合。
// maxWidth 为 undefined 表示不限宽，原样返回。
// inputComposerStatusParts 先用 modelDisplayParts(modelSelection) 拆出 model/provider，再 trim thoughtLevel，
// 空串替换为 "-" 后才交给 fitComposerStatusParts；返回 { ...modelParts, thought } 是新对象，可安全作为 React 依赖（INV-15）。
export function inputComposerStatusParts(
  modelSelection: string,
  thoughtLevel: string,
  maxWidth?: number,
): InputComposerStatusParts {
  const modelParts = modelDisplayParts(modelSelection);
  const thought = thoughtLevel.trim();
  return fitComposerStatusParts(
    {
      ...modelParts,
      thought: thought || "-",
    },
    maxWidth,
  );
}

// contextUsage 整体缺失同样返回 undefined，调用方据此隐藏徽标。
// 百分比四舍五入为整数，K/M 后缀与 composer 其他 token 计数保持同一口径。
// 上下文用量徽标："12.3K (45%)"。contextUsed 非法时返回 undefined（不显示徽标）；
// contextWindow 非法时只显示已用量，不显示百分比（避免除零/Infinity）。
export function inputContextUsageBadge(contextUsage?: ContextUsage): string | undefined {
  const used = contextUsage?.contextUsed;
  if (!validContextTokenCount(used)) return undefined;

  const usedLabel = formatCompactTokenCount(used);
  const window = contextUsage?.contextWindow;
  if (!validContextWindow(window)) return usedLabel;

  return `${usedLabel} (${formatComposerPercent(used / window)})`;
}

// composer 行可用的元信息宽度 = 归一化行宽 - 水平 padding，最小 8 列。
function composerStatusMetadataWidth(contentWidth?: number): number {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  return Math.max(
    COMPOSER_STATUS_MIN_METADATA_WIDTH,
    rowWidth - COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH,
  );
}

// 活动行里上下文徽标可用的最大宽度 = 行宽 - padding - spinner 提示宽度 - 间隔。
// 剩余宽度小于最小阈值时返回 undefined，表示干脆不显示徽标。
function activeStatusContextBadgeWidth({
  contentWidth,
  copy,
  frame,
}: {
  contentWidth?: number;
  copy: TuiCopy;
  frame?: string;
}): number | undefined {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  const activeHintWidth = frame
    ? displayWidth(frame) + 1 + displayWidth(copy.input.activeStatusHint)
    : 0;
  const activeSpacerWidth = activeHintWidth > 0 ? ACTIVE_STATUS_CONTEXT_SPACER_WIDTH : 0;
  const availableWidth =
    rowWidth - ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH - activeHintWidth - activeSpacerWidth;
  if (availableWidth < STATUS_MIN_CONTEXT_WIDTH) return undefined;
  return Math.floor(availableWidth);
}

// 按可用宽度截断徽标；maxWidth 未定义视为不限宽。宽度低于最小阈值时返回 undefined（隐藏）。
function fitStatusContextBadge(
  contextBadge: string | undefined,
  maxWidth?: number,
): string | undefined {
  if (contextBadge === undefined) return undefined;
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return contextBadge;
  if (maxWidth < STATUS_MIN_CONTEXT_WIDTH) return undefined;
  return truncateDisplay(contextBadge, Math.floor(maxWidth));
}

// 按 maxWidth 拟合三段文本：能放下则原样返回；
// 放不下时先保证 thought 完整，再把剩余宽度按 40% 给 provider、其余给 model（各自至少 1 列）。
// fitComposerStatusParts 只在 maxWidth 有限时裁剪：width 先 Math.max(1, Math.floor(maxWidth))；
// modelProviderWidth + " | " + thoughtWidth <= width 时原样返回；放不下时 thought 优先保留（INV-11），
// modelProviderBudget 为负则清空 model/provider 只截 thought；剩余预算按 0.4 给 provider、其余给 model，两者各自 Math.max(1, …)（INV-12/13）。
function fitComposerStatusParts(
  parts: InputComposerStatusParts,
  maxWidth?: number,
): InputComposerStatusParts {
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return parts;
  const width = Math.max(1, Math.floor(maxWidth));
  const separatorWidth = displayWidth(" | ");
  const modelProviderGapWidth = 1;
  const thoughtWidth = displayWidth(parts.thought);
  const modelProviderWidth =
    displayWidth(parts.model) + modelProviderGapWidth + displayWidth(parts.provider);

  if (modelProviderWidth + separatorWidth + thoughtWidth <= width) return parts;

  const modelProviderBudget = width - separatorWidth - thoughtWidth;
  if (modelProviderBudget <= 0) {
    return {
      model: "",
      provider: "",
      thought: truncateDisplay(parts.thought, width),
    };
  }

  if (modelProviderBudget <= modelProviderGapWidth) {
    return {
      ...parts,
      model: truncateDisplay(parts.model, modelProviderBudget),
      provider: "",
    };
  }

  const providerBudget = Math.min(
    displayWidth(parts.provider),
    Math.max(1, Math.floor(modelProviderBudget * 0.4)),
  );
  const modelBudget = Math.max(1, modelProviderBudget - providerBudget - modelProviderGapWidth);

  return {
    ...parts,
    model: truncateDisplay(parts.model, modelBudget),
    provider: truncateDisplay(parts.provider, providerBudget),
  };
}

// 归一化状态行内容宽度：undefined/NaN/Infinity → 80，其余向下取整并夹到 >= 8。
function normalizeComposerStatusContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return COMPOSER_STATUS_FALLBACK_WIDTH;
  }
  return Math.max(COMPOSER_STATUS_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

// token 数紧凑格式：< 1000 取整显示；< 1M 用 K；否则用 M。保留 1 位小数并去掉末尾 ".0"。
function formatCompactTokenCount(value: number): string {
  if (value < TOKEN_COUNT_KILO) return String(Math.round(value));
  if (value < TOKEN_COUNT_MEGA) return `${formatCompactDecimal(value / TOKEN_COUNT_KILO)}K`;
  return `${formatCompactDecimal(value / TOKEN_COUNT_MEGA)}M`;
}

function formatCompactDecimal(value: number): string {
  return value.toFixed(TOKEN_COUNT_DECIMAL_PLACES).replace(/\.0$/u, "");
}

// 百分比展示：非有限值返回 "-"（调用方本应已过滤），否则四舍五入到整数百分比。
function formatComposerPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

// 已用量合法性：>= 0 的有限数（0 是合法值，表示刚开新会话）。
function validContextTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

// 窗口大小合法性：在已用量合法的基础上还必须 > 0，否则百分比无意义。
function validContextWindow(value: number | undefined): value is number {
  return validContextTokenCount(value) && value > 0;
}
