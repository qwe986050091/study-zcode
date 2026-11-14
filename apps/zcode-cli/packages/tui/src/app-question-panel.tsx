// 交互式提问面板的渲染。
// 职责：按状态渲染复核页、编辑“其他”、正常答题三种视图。
// 边界：纯展示组件，答题推进与提交由键盘状态机负责。
// 副作用：无 IO/状态写入，仅按全局 palette 取色。
// 降级：题目缺失或索引越界时渲染空面板，保持固定高度不跳动。

import React from "react";
import type { QuestionPromptState } from "./app-model.js";
import { palette } from "./app-model.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 交互式提问面板：按状态渲染三种视图（复核页 / 编辑“其他” / 正常答题）。
// 输入：state 为 QuestionPromptState；questions 为空数组时渲染空面板而不是报错。
// 输出：始终返回 box 元素；复核页列出全部题目与答案，未答显示 "(not answered)"，
// 不展示当前题高亮，避免用户误解为仍可单选。
// 副作用：无 IO/状态写入，纯渲染；颜色取自全局 palette。
// 口径：选中高亮同时用于“方向键焦点”（>）与“已勾选”（[x]/(*)），
// 多选时焦点与勾选可能分离，因此两套标记独立计算。
export function QuestionPanel({ state }: { state: QuestionPromptState }): React.ReactElement {
  if (state.reviewing) {
    return h(
      "box",
      {
        title: "Review answers",
        style: questionPanelStyle(),
      },
      ...state.input.questions.map((question) =>
        h(
          "text",
          { key: question.question, style: { fg: palette.text } },
          `${question.header}: ${state.answers[question.question] ?? "(not answered)"}`,
        ),
      ),
      h("text", { style: { fg: palette.muted } }, "Enter submits, Tab edits, Esc declines"),
    );
  }

  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) {
    // 越界（例如题目列表被更新的同时索引尚未校正）时降级为空面板，保持布局高度稳定。
    return h("box", { style: questionPanelStyle() });
  }

  if (state.editingOther) {
    // 编辑态只展示题目与该题已输入内容，屏蔽选项列表，避免用户误以为还可继续切换选项。
    return h(
      "box",
      {
        title: `Question ${state.currentQuestionIndex + 1}/${state.input.questions.length}: ${question.header}`,
        style: questionPanelStyle(),
      },
      h("text", { style: { fg: palette.text } }, question.question),
      h("text", { style: { fg: palette.accent } }, `Other: ${state.otherBuffer}`),
      h(
        "text",
        { style: { fg: palette.muted } },
        "Type custom answer. Enter accepts, Esc cancels.",
      ),
    );
  }

  const otherIndex = question.options.length;
  // “其他”项的文本仅在已填写时才显示，未填写时用提示语占位。
  const otherValue = state.otherText[question.question];
  const selectedLabels = new Set(state.multiSelections[question.question] ?? []);
  const rows = [
    ...question.options.map((option, index) => ({
      description: option.description,
      label: option.label,
      selected: question.multiSelect
        ? selectedLabels.has(option.label)
        : state.selectedOptionIndex === index,
    })),
    {
      description: otherValue ?? "Type a custom answer",
      label: "Other",
      // 多选下“其他”只有在已填写文本时才显示为已勾选，避免空答案被误认为有效。
      selected: question.multiSelect
        ? Boolean(otherValue && selectedLabels.has("Other"))
        : state.selectedOptionIndex === otherIndex,
    },
  ];

  return h(
    "box",
    {
      title: `Question ${state.currentQuestionIndex + 1}/${state.input.questions.length}: ${question.header}`,
      style: questionPanelStyle(),
    },
    h("text", { style: { fg: palette.text } }, question.question),
    ...rows.map((row, index) =>
      h(
        "text",
        {
          key: row.label,
          style: {
            fg: state.selectedOptionIndex === index ? palette.accent : palette.text,
          },
        },
        `${state.selectedOptionIndex === index ? ">" : " "} ${
          question.multiSelect ? (row.selected ? "[x]" : "[ ]") : row.selected ? "(*)" : "( )"
        } ${row.label} - ${row.description}`,
      ),
    ),
    h(
      "text",
      { style: { fg: palette.muted } },
      question.multiSelect
        ? "Space toggles, Enter reviews, s skips, o edits Other, Esc declines"
        : "Enter answers, s skips, o edits Other, Esc declines",
    ),
  );
}

// 面板统一样式：固定高度 10 行，保证题目切换/编辑态之间布局不跳动；
// 与其它面板一致使用 panel 背景 + warning 边框以突出需要用户决策。
function questionPanelStyle(): Record<string, unknown> {
  return {
    backgroundColor: palette.panel,
    border: true,
    borderColor: palette.warning,
    flexDirection: "column",
    height: 10,
    marginBottom: 1,
    padding: 1,
  };
}
