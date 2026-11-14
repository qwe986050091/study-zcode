// 子 Agent 详情视图模块：只读渲染选中子会话的标题、状态与消息记录。
// 边界：数据全部来自 SubagentsController（目录/transcript/loading/error），本组件不持有业务状态。
// 副作用：点击返回/重试/待返回提示时先 stopPropagation 再回调 controller，不做任何 IO。
// 失败语义：加载失败只展示错误文案与重试入口，不自动重试，避免失败循环。
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import { ContentPane } from "./app-transcript-components.js";
import { palette } from "./app-model.js";
import { truncateDisplay } from "./app-terminal-width.js";
import type { SubagentsController } from "./app-subagents.js";

const h = React.createElement;

// 子 Agent 详情视图：只读展示选中子会话的标题、状态与消息记录。
// 输入 controller.selected 由调用方保证非空（进入本视图前已选中），transcript 可为空表示尚未加载。
// 消息合并：若存在 liveModelText，则作为一条 streaming 的 agent 消息追加在历史之后，
// 使流式输出与已完成历史共用同一渲染管线；transcript 缺失时按空列表渲染 emptyText。
// 副作用：点击返回/重试/待返回提示时先 stopPropagation 再调用 controller.back()/open()。
// 错误态：加载失败显示错误文案与重试入口，不自动重试，避免失败循环。
export function SubagentView({
  controller,
  copy,
  contentWidth,
  pendingMain,
}: {
  controller: SubagentsController;
  copy: TuiCopy;
  contentWidth: number;
  pendingMain: boolean;
}): React.ReactElement {
  const labels = copy.sidebar.subagents;
  const selected = controller.selected!;
  const transcript = controller.transcript;
  const messages = transcript?.liveModelText
    ? [
        ...transcript.messages,
        { role: "agent" as const, content: transcript.liveModelText, streaming: true },
      ]
    : (transcript?.messages ?? []);
  const clickBack = (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    controller.back();
  };
  return h(
    "box",
    { id: "subagent-view", style: { flexDirection: "column", flexGrow: 1, minHeight: 0 } },
    h(
      "text",
      {
        id: "subagent-back",
        selectable: false,
        onMouseUp: clickBack,
        style: { fg: palette.accent, height: 1, flexShrink: 0 },
      },
      labels.back,
    ),
    h(
      "text",
      { style: { fg: palette.text, height: 1, flexShrink: 0 } },
      truncateDisplay(`${selected.title} · ${labels.status[selected.status]}`, contentWidth),
    ),
    h("text", { style: { fg: palette.muted, height: 1, flexShrink: 0 } }, labels.readonly),
    pendingMain
      ? h(
          "text",
          {
            selectable: false,
            onMouseUp: clickBack,
            style: { fg: palette.warning, flexShrink: 0 },
          },
          labels.pendingMain,
        )
      : null,
    controller.loading
      ? h("text", { style: { fg: palette.muted } }, labels.loading)
      : controller.error
        ? h(
            "box",
            { style: { flexDirection: "column" } },
            h(
              "text",
              { style: { fg: palette.danger } },
              `${labels.unavailable} ${controller.error}`,
            ),
            h(
              "text",
              {
                selectable: false,
                onMouseUp: (event: { stopPropagation(): void }) => {
                  event.stopPropagation();
                  controller.open(selected);
                },
                style: { fg: palette.accent },
              },
              labels.retry,
            ),
          )
        : h(ContentPane, {
            key: selected.childSessionId,
            copy,
            focused: true,
            messages,
            terminalWidth: contentWidth,
            emptyText: labels.emptyOutput,
          }),
  );
}
