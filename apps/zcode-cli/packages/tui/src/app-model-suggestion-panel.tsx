// INV-01 可见窗口固定 8 行：守住位置 窗口常量；改错故障 浮层超出终端高度。
// INV-02 选中项必须落在可见窗口内：守住位置 窗口函数；改错故障 键盘移动看不到高亮。
// INV-03 空候选渲染提示行：守住位置 空值分支；改错故障 浮层空白无解释。
// INV-04 面板高度按可见行数加边框：守住位置 高度计算；改错故障 最后一行被裁掉。
// INV-05 provider 列预算上限为四成：守住位置 预算函数；改错故障 provider 挤压模型名。
// INV-06 provider 预算还需扣除选择符与最小模型名：守住位置 预算下界；改错故障 模型名被压到 0 列。
// INV-07 标注只在模型名仍够宽时显示：守住位置 显示判断；改错故障 模型名被标注挤没。
// INV-08 模型名优先标签回落标识：守住位置 展示组装；改错故障 别名模型显示为空。
// INV-09 provider 优先展示名回落标识：守住位置 展示组装；改错故障 列显示内部标识。
// INV-10 current 标记附在标注末尾：守住位置 标注拼接；改错故障 当前模型无法识别。
// INV-11 禁用原因与当前标记用竖线连接：守住位置 过滤连接；改错故障 空值产生悬空分隔符。
// INV-12 宽度非法回落 80 列：守住位置 归一函数；改错故障 NaN 导致布局异常。
// INV-13 内容宽最小 8 列：守住位置 下界夹取；改错故障 极窄面板出现负预算。
// INV-14 选择符固定 2 列：守住位置 宽度常量；改错故障 高亮箭头挤动文本。
// INV-15 provider 与模型名间隔 2 列：守住位置 间隔常量；改错故障 两列文字粘连。
// INV-16 空 provider 时不留间隔：守住位置 条件宽度；改错故障 行尾出现悬空留白。
// INV-17 纯展示不触发模型切换：守住位置 模块边界；改错故障 渲染产生副作用。
// INV-18 每次渲染重算裁剪不缓存：守住位置 行数据构造；改错故障 宽度变化后仍用旧裁剪。
//
// 模块职责：渲染模型候选浮层，处理可见窗口、当前标记与列宽对齐。
// 状态所有权：无状态；候选、选中项与当前模型全部由父层传入。
// 阅读顺序：先看面板与行组件，再读展示组装，最后看列预算与宽度归一。
// 模型候选浮层的布局与渲染。
// 职责：渲染最多 8 行模型窗口、当前模型标记与 provider 列对齐。
// 边界：纯展示组件，不触发模型切换，不读写会话状态。
// 副作用：无 IO，仅按 palette 取色；结果不缓存。
// 降级：宽度非法回落 80 列，空候选显示提示行而非抛错。

import React from "react";
import { visibleModelOptionWindow } from "./app-input.js";
import { palette } from "./app-model.js";
import { modelOptionValue } from "./app-model-ref.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import type { TuiModelOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const MODEL_OPTION_VISIBLE_COUNT = 8;
const MODEL_OPTION_PANEL_CHROME_ROWS = 2;
const MODEL_OPTION_ROW_HEIGHT = 1;
const MODEL_ROW_SELECTOR_WIDTH = 2;
const MODEL_ROW_PROVIDER_GAP_WIDTH = 2;
const MODEL_ROW_MIN_CONTENT_WIDTH = 8;
const MODEL_ROW_MIN_MODEL_WIDTH = 8;
const MODEL_ROW_FALLBACK_CONTENT_WIDTH = 80;
const MODEL_ROW_MAX_PROVIDER_RATIO = 0.4;

// 一行模型候选的展示三段：meta 为附加标注（禁用原因/current），model 为模型名，
// provider 为 provider 展示名；各段可为空串，渲染时按空串省略对应列。
type ModelOptionDisplayParts = {
  meta: string;
  model: string;
  provider: string;
};

// 按宽度裁剪后的行数据；providerWidth 为裁剪后 provider 的显示列宽，用于固定列宽排版。
type FittedModelOptionRow = {
  meta: string;
  model: string;
  provider: string;
  providerWidth: number;
};

// /model 建议面板：展示模型候选窗口并按当前生效模型做标记。
// 输入：contentWidth 可为 undefined/非有限数（回落 80 列）；models 空数组时显示空态行；
// currentModel 为 "provider/model" 展示值，用于标记 current，不参与选中判断。
// 输出：始终返回 box 元素；高度按可见行数计算，最多 MODEL_OPTION_VISIBLE_COUNT 行。
// 副作用：无 IO；每次渲染取 palette 色值并重算裁剪，结果不缓存。
// 不变量：可见窗口由 visibleModelOptionWindow 保证选中项在窗口内且不越界。
// ModelSuggestionPanel 先 visibleModelOptionWindow(models, selectedIndex, MODEL_OPTION_VISIBLE_COUNT) 取 8 行窗口，
// normalizeModelRowContentWidth 把 contentWidth 归一为显示列；rows 同时算 current（modelOptionValue(model) === currentModel）
// 与 selected（index === visible.selectedIndex），两态互不推导；panelHeight = 边框 2 行 + max(1, rows.length)，
// 空候选按 1 行算高度并渲染 "No matching models."；key 用 JSON.stringify(model.ref) 保证同模型多次出现也不撞。
export function ModelSuggestionPanel({
  contentWidth,
  currentModel,
  models,
  selectedIndex,
}: {
  contentWidth?: number;
  currentModel: string;
  models: readonly TuiModelOption[];
  selectedIndex: number;
}): React.ReactElement | null {
  const visible = visibleModelOptionWindow(models, selectedIndex, MODEL_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeModelRowContentWidth(contentWidth);
  const rows =
    visible.models.length > 0
      ? visible.models.map((model, index) => ({
          current: modelOptionValue(model) === currentModel,
          fitted: fitModelOptionRow(
            modelOptionDisplayParts(model, modelOptionValue(model) === currentModel),
            rowContentWidth,
          ),
          model,
          selected: index === visible.selectedIndex,
        }))
      : [];
  const panelHeight =
    MODEL_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * MODEL_OPTION_ROW_HEIGHT;

  return h(
    "box",
    {
      title: "Models",
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    rows.length > 0
      ? rows.map((row) =>
          h(ModelSuggestionRow, {
            key: JSON.stringify(row.model.ref),
            fitted: row.fitted,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: MODEL_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching models.",
        ),
  );
}

// 单行模型渲染：选择符、模型名（可压缩）、meta 标注、弹性间隔、provider（固定宽度）。
// meta 为空时不渲染该文本节点，provider 为空时间隔最小宽度为 0，避免出现悬空留白。
// ModelSuggestionRow 的列顺序固定：选择符（MODEL_ROW_SELECTOR_WIDTH=2，selected 时 "> "）→ 模型名（flexShrink:1,minWidth:1）
// → meta（空串时不渲染节点）→ 弹性间隔（minWidth 取 provider 是否存在时的 MODEL_ROW_PROVIDER_GAP_WIDTH，否则 0）
// → provider（宽固定 fitted.providerWidth、flexShrink:0）；标注为空时省略节点，provider 为空时间隔不留白（INV-16）。
function ModelSuggestionRow({
  fitted,
  selected,
}: {
  fitted: FittedModelOptionRow;
  selected: boolean;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: MODEL_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: MODEL_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.text,
          flexShrink: 1,
          minWidth: 1,
        },
      },
      fitted.model,
    ),
    fitted.meta
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
            },
          },
          fitted.meta,
        )
      : null,
    h("box", {
      style: {
        flexGrow: 1,
        minWidth: fitted.provider ? MODEL_ROW_PROVIDER_GAP_WIDTH : 0,
      },
    }),
    fitted.provider
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
              width: fitted.providerWidth,
            },
          },
          fitted.provider,
        )
      : null,
  );
}

// 组装展示三段：名称优先 label、回落到 modelId；provider 优先 providerLabel、回落到 providerId；
// meta 由禁用原因与 "current" 标记用 " | " 连接，两者都没有时为空串。
// modelOptionDisplayParts 的回落顺序固定：modelName 取 model.label || model.ref.modelId（INV-08），
// provider 取 model.providerLabel || model.ref.providerId（INV-09）；meta 由 [model.disabledReason, current ? "current" : undefined]
// filter(Boolean) 后 join(" | ")，空值不会产生悬空分隔符（INV-10/11）；返回新对象，不修改 model。
function modelOptionDisplayParts(model: TuiModelOption, current: boolean): ModelOptionDisplayParts {
  const modelName = model.label || model.ref.modelId;
  const meta = [model.disabledReason, current ? "current" : undefined].filter(Boolean).join(" | ");
  return {
    meta,
    model: modelName,
    provider: model.providerLabel || model.ref.providerId,
  };
}

// 按宽度裁剪整行：先分配 provider 列预算，剩余宽度给“模型名 + meta”。
// meta 只有在模型名仍保留最小宽度时才显示，否则整体省略，优先保证模型名可辨识。
// fitModelOptionRow 先 providerColumnBudget 定 provider 预算并截断，providerWidth 用截断后 displayWidth 回写用于固定列宽；
// providerGapWidth 仅在 provider 非空时为 2；leftBudget 是内容宽扣掉选择符、间隔与 provider 后的剩余；
// meta 前缀两个空格，只有 leftBudget - metaWidth >= MODEL_ROW_MIN_MODEL_WIDTH 才显示（INV-07），
// 其余宽度全给模型名，modelBudget 下限 0 保证不出现负宽。
function fitModelOptionRow(
  parts: ModelOptionDisplayParts,
  contentWidth: number,
): FittedModelOptionRow {
  const providerBudget = providerColumnBudget(parts.provider, contentWidth);
  const provider = truncateDisplay(parts.provider, providerBudget);
  const providerWidth = displayWidth(provider);
  const providerGapWidth = provider ? MODEL_ROW_PROVIDER_GAP_WIDTH : 0;
  const leftBudget = Math.max(
    0,
    contentWidth - MODEL_ROW_SELECTOR_WIDTH - providerGapWidth - providerWidth,
  );
  const meta = parts.meta ? `  ${parts.meta}` : "";
  const metaWidth = displayWidth(meta);
  const showMeta = metaWidth > 0 && leftBudget - metaWidth >= MODEL_ROW_MIN_MODEL_WIDTH;
  const modelBudget = Math.max(0, leftBudget - (showMeta ? metaWidth : 0));

  return {
    meta: showMeta ? meta : "",
    model: truncateDisplay(parts.model, modelBudget),
    provider,
    providerWidth,
  };
}

// provider 列预算：取“比例上限”和“扣除选择符/间隔/最小模型名后剩余”的较小值，且不小于 0。
// 空 provider 预算为 0。
// providerColumnBudget 空 provider 直接 0；上限 providerMax = floor(contentWidth * 0.4)（INV-05），
// 同时还要扣掉选择符、provider 间隔与 MODEL_ROW_MIN_MODEL_WIDTH（INV-06），取两者较小值后再 Math.max(0, …)；
// 因此极窄面板只会把 provider 压到 0，不会让模型名变成负预算。
function providerColumnBudget(provider: string, contentWidth: number): number {
  if (!provider) return 0;
  const providerMax = Math.floor(contentWidth * MODEL_ROW_MAX_PROVIDER_RATIO);
  const providerBudget =
    contentWidth -
    MODEL_ROW_SELECTOR_WIDTH -
    MODEL_ROW_PROVIDER_GAP_WIDTH -
    MODEL_ROW_MIN_MODEL_WIDTH;
  return Math.max(0, Math.min(providerMax, providerBudget));
}

// 归一化内容宽：undefined/NaN/Infinity 回落 80 列，其余向下取整并保证不小于最小内容宽。
function normalizeModelRowContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return MODEL_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MODEL_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
