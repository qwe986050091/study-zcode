// 忙碌期排队输入的渲染与列表工具。
// 职责：渲染最多 3 条排队项，并提供按 id upsert/remove 的纯函数。
// 边界：队列真实状态由 session 层持有，本模块不推断、不消费队列。
// 副作用：无 IO；内容未变化时返回原数组引用，避免无谓重渲染。
// 口径：空数组不渲染面板；未命中 id 的删除被静默忽略，操作幂等。

import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import type { QueuedInput } from "./app-model.js";
import { palette } from "./app-model.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const QUEUED_INPUT_VISIBLE_COUNT = 3;
const QUEUED_INPUT_PANEL_CHROME_ROWS = 2;
const QUEUED_INPUT_HINT_ROWS = 1;
const QUEUED_INPUT_ROW_HEIGHT = 1;
const QUEUED_INPUT_INDEX_WIDTH = 4;
const QUEUED_INPUT_FALLBACK_CONTENT_WIDTH = 80;
const QUEUED_INPUT_MIN_CONTENT_WIDTH = 12;

// 排队输入面板：展示 busy 期间提交、等待串行消费的用户输入。
// 输入：inputs 空数组时返回 null（完全不占布局）；最多展示 3 条，其余以 "还有 N 条" 提示。
// contentWidth 为可用列宽，undefined/非有限数回落 80 列；copy 缺省使用英文兜底文案。
// 输出：有内容时返回 box 元素，否则 null；高度按实际可见行数计算。
// 副作用：无 IO；仅渲染，不从本地状态推断队列内容。
// 不变量：面板标题与行数都基于完整 inputs 长度，与可见条数无关，保证“共几条”始终准确。
export function QueuedInputPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  inputs,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  inputs: QueuedInput[];
}): React.ReactElement | null {
  // 无排队输入时不渲染（返回 null），避免占用一行空白并干扰主输入区布局。
  if (inputs.length === 0) return null;

  const visible = inputs.slice(0, QUEUED_INPUT_VISIBLE_COUNT);
  const hiddenCount = Math.max(0, inputs.length - visible.length);
  const rowContentWidth = normalizeQueuedInputContentWidth(contentWidth);

  return h(
    "box",
    {
      title: copy.input.queuedTitle(inputs.length),
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: queuedInputPanelHeight(inputs.length),
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    h("text", { key: "hint", style: { fg: palette.muted } }, copy.input.queuedSubmitHint),
    ...visible.map((input, index) =>
      h(QueuedInputRow, {
        contentWidth: rowContentWidth,
        input,
        key: input.id,
        position: index + 1,
      }),
    ),
    hiddenCount > 0
      ? h("text", { key: "more", style: { fg: palette.muted } }, copy.input.queuedMore(hiddenCount))
      : null,
  );
}

// 按 id upsert 排队输入：不存在则追加到队尾；已存在则原位更新（保持排队顺序不变）。
// options.preserveExistingText=true 时，若已有文本非空则保留旧文本，只更新其他字段
// （用于“排队项先以乐观文本出现，随后收到权威回填”的场景）。
// 返回：原数组引用（内容未变化时）或新数组；调用方可据此跳过无意义的重渲染。
export function upsertQueuedInput(
  current: QueuedInput[],
  input: QueuedInput,
  options: { preserveExistingText?: boolean } = {},
): QueuedInput[] {
  const existingIndex = current.findIndex((item) => item.id === input.id);
  if (existingIndex === -1) return [...current, input];

  const existing = current[existingIndex]!;
  const nextInput = {
    ...existing,
    ...input,
    // 仅在显式要求且已有文本非空时保留旧文本，空文本仍允许被权威值覆盖。
    text: options.preserveExistingText && existing.text ? existing.text : input.text,
  };
  // id 与文本都未变化时返回原引用，避免向上层触发无谓的状态更新。
  if (existing.id === nextInput.id && existing.text === nextInput.text) return current;

  return [
    ...current.slice(0, existingIndex),
    nextInput,
    ...current.slice(existingIndex + 1),
  ];
}

// 入参 ids 允许重复，内部先去重再过滤，重复 id 不会放大任何副作用；输出保持原数组相对顺序。
// 返回引用仅在“零操作”时复用，其余情况恒为新数组，调用方可据此安全地做引用比较决定是否 setState。
// 按 id 批量移除排队项；ids 为空时直接返回原引用（无操作），避免产生新的空数组引用。
// 未命中的 id 会被静默忽略，删除操作因此是幂等的。
export function removeQueuedInputs(current: QueuedInput[], ids: readonly string[]): QueuedInput[] {
  if (ids.length === 0) return current;
  const idsToRemove = new Set(ids);
  return current.filter((input) => !idsToRemove.has(input.id));
}

function queuedInputPanelHeight(inputCount: number): number {
  const visibleCount = Math.min(Math.max(0, inputCount), QUEUED_INPUT_VISIBLE_COUNT);
  const hiddenRows = inputCount > visibleCount ? 1 : 0;
  return (
    QUEUED_INPUT_PANEL_CHROME_ROWS +
    QUEUED_INPUT_HINT_ROWS +
    visibleCount * QUEUED_INPUT_ROW_HEIGHT +
    hiddenRows
  );
}

function QueuedInputRow({
  contentWidth,
  input,
  position,
}: {
  contentWidth: number;
  input: QueuedInput;
  position: number;
}): React.ReactElement {
  const indexLabel = `${position}.`;
  const textWidth = Math.max(
    QUEUED_INPUT_MIN_CONTENT_WIDTH,
    contentWidth - QUEUED_INPUT_INDEX_WIDTH,
  );

  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: QUEUED_INPUT_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: palette.accent,
          flexShrink: 0,
          width: QUEUED_INPUT_INDEX_WIDTH,
        },
      },
      indexLabel.padEnd(QUEUED_INPUT_INDEX_WIDTH),
    ),
    h(
      "text",
      {
        style: {
          fg: palette.text,
          flexShrink: 1,
          minWidth: 1,
          width: displayWidth(truncateDisplay(input.text, textWidth)),
        },
      },
      truncateDisplay(input.text, textWidth),
    ),
  );
}

function normalizeQueuedInputContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return QUEUED_INPUT_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(QUEUED_INPUT_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
