// INV-01 运行中列表始终可见：守住位置 合并顺序；改错故障 只有已结束列表时新条目看不到。
// INV-02 已结束列表按开关追加：守住位置 条件展开；改错故障 默认展开淹没运行中。
// INV-03 无已结束时隐藏入口：守住位置 总数判断；改错故障 出现可点的空入口。
// INV-04 分页按钮只在有游标时出现：守住位置 双条件；改错故障 点击更多没有下一页。
// INV-05 高度按内容行数估算：守住位置 求和表达式；改错故障 滚动区盖住主内容。
// INV-06 高度至少一行：守住位置 下限夹取；改错故障 空列表高度为零无法聚焦。
// INV-07 高度上限随终端收缩：守住位置 上限计算；改错故障 小终端下分区溢出。
// INV-08 点击条目先阻止冒泡：守住位置 事件处理；改错故障 点开详情同时触发展开。
// INV-09 展开按钮同样阻止冒泡：守住位置 事件处理；改错故障 折叠操作连带切换条目。
// INV-10 选中态按会话标识判断：守住位置 比较表达式；改错故障 高亮错位到别条。
// INV-11 失败状态单独着色：守住位置 三元分支；改错故障 失败子代理看起来正常。
// INV-12 标题与状态各占一行：守住位置 行高常量；改错故障 两行文字互相覆盖。
// INV-13 文本截断到内容宽度：守住位置 宽度参数；改错故障 长标题撑破侧栏。
// INV-14 目录错误优先于空态：守住位置 条件选择；改错故障 后端故障被说成没有数据。
// INV-15 更多按钮异步分页不阻塞渲染：守住位置 调用方式；改错故障 点击后界面卡住。
// INV-16 分区折叠时不渲染滚动区：守住位置 条件分支；改错故障 折叠后仍占位。
// INV-17 折叠指示符沿用加减号：守住位置 文案来源；改错故障 与其他分区符号不一致。
// INV-18 组件只读目录并上抛交互：守住位置 职责边界；改错故障 本层自行改写分页状态。
//
// 模块职责：侧栏子代理分区，渲染运行中与已结束列表并提供分页入口。
// 状态所有权：目录与分页归 controller，本组件只持有展开开关。
// 阅读顺序：先看列表合并与高度估算，再看点击处理，最后看空态与分页。
// 侧栏子 Agent 列表分区。
// 职责：渲染运行中/已结束子 Agent，支持点击打开详情与异步分页。
// 边界：目录数据与分页由 controller 持有，本组件只读并上抛交互。
// 副作用：点击调用 stopPropagation、open 或 loadMore；展开态为本地临时状态。
// 降级：无内容时显示 empty 或 unavailable；scrollbox 高度夹在 [1, 终端高-22]。

import React from "react";
import { useTerminalDimensions } from "@mbears/opentui-react";
import type { TuiCopy } from "@zcode/i18n";
import { palette } from "./app-model.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { truncateDisplay } from "./app-terminal-width.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";

const h = React.createElement;
type ClickEvent = { stopPropagation(): void };

// 子 Agent 列表 section：渲染运行中子 Agent，并可展开查看已结束列表。
// 输入 controller 提供 directory/selected/loading 与 loadMore/open/back；copy 提供文案；
// expanded/onToggle 控制整段折叠；onOpen 在点击条目时回调（默认由调用方切换到详情视图）。
// 展示口径：运行中始终可见；已结束列表按 endedOpen 开关追加，ended.total 为 0 时不渲染入口。
// 副作用：点击条目/展开按钮会调用 stopPropagation 与 setEndedOpen；点击"更多"触发 loadMore 异步分页。
// 高度不变量：scrollbox 高度按内容行数估算并夹在 [1, max(3, 终端高-22)]，保证不挤占主内容。
// 组件只持有 endedOpen 一个状态，其余数据全部来自 controller。
// 目录与分页由 controller 提供。
// directory 与 loadMore 分页能力均由 controller 注入，组件不自行拉取。
// items 由 directory.running 与已结束分页按 endedOpen 合并而成。
export function SubagentsSection({
  controller,
  copy,
  expanded,
  onToggle,
  onOpen,
}: {
  controller: SubagentsController;
  copy: TuiCopy;
  expanded: boolean;
  onToggle(): void;
  onOpen(item: SubagentItem): void;
}): React.ReactElement {
  const [endedOpen, setEndedOpen] = React.useState(false);
  const { height } = useTerminalDimensions();
  const { directory, selected } = controller;
  const labels = copy.sidebar.subagents;
  // running 条目始终排在 items 前段，已结束条目只在开关打开后追加。
  // endedOpen 为真时才把 directory.ended.items 追加到末尾。
  // 选中态用 selected 与 item.sessionId 比较判定。
  // 条目点击先调 stopPropagation，再上抛 onOpen。
  const items = [...directory.running, ...(endedOpen ? directory.ended.items : [])];
  // 内容高度按"每条 2 行 + 已结束标题 1 行 + 分页按钮 1 行"估算，用于给 scrollbox 一个上限。
  // contentHeight 里每条 item 固定按 2 行估算。
  // directory.ended.total 非零时标题额外占 1 行。
  // nextCursor 存在且已展开时，分页按钮再占 1 行。
  // 最终高度用 Math.min 夹在 1 与 max(3, 终端高-22) 之间。
  const contentHeight =
    items.length * 2 +
    (directory.ended.total ? 1 : 0) +
    (endedOpen && directory.ended.nextCursor ? 1 : 0);
  return h(
    "box",
    { style: { flexDirection: "column", flexShrink: 0, marginTop: 1 } },
    h(SidebarSectionHeader, {
      title: `${labels.title} (${directory.running.length})`,
      expanded,
      onToggle,
    }),
    expanded
      ? h(
          "scrollbox",
          {
            id: "subagent-directory",
            scrollX: false,
            style: {
              height: Math.max(1, Math.min(contentHeight || 1, Math.max(3, height - 22))),
              contentOptions: { flexDirection: "column" },
            },
          },
          ...items.map((item) =>
            h(
              "box",
              {
                key: item.childSessionId,
                id: `subagent-${item.childSessionId}`,
                onMouseUp: (event: ClickEvent) => {
                  event.stopPropagation();
                  onOpen(item);
                },
                style: {
                  flexDirection: "column",
                  height: 2,
                  flexShrink: 0,
                  backgroundColor:
                    selected?.childSessionId === item.childSessionId
                      ? palette.panel
                      : palette.panelAlt,
                },
              },
              h(
                "text",
                {
                  selectable: false,
                  style: {
                    fg:
                      selected?.childSessionId === item.childSessionId
                        ? palette.accent
                        : palette.text,
                    height: 1,
                    wrapMode: "none",
                  },
                },
                truncateDisplay(
                  `${selected?.childSessionId === item.childSessionId ? "›" : "·"} ${item.title}`,
                  SIDEBAR_CONTENT_WIDTH - 1,
                ),
              ),
              h(
                "text",
                {
                  selectable: false,
                  style: {
                    fg: item.status === "failed" ? palette.danger : palette.muted,
                    height: 1,
                    wrapMode: "none",
                  },
                },
                truncateDisplay(
                  `  ${item.subagentType} · ${labels.status[item.status]}`,
                  SIDEBAR_CONTENT_WIDTH - 1,
                ),
              ),
            ),
          ),
          directory.ended.total
            ? h(
                "text",
                {
                  selectable: false,
                  onMouseUp: (event: ClickEvent) => {
                    event.stopPropagation();
                    setEndedOpen((value) => !value);
                  },
                  style: { fg: palette.muted, height: 1 },
                },
                `${endedOpen ? "▼" : "▶"} ${labels.ended(directory.ended.total)}`,
              )
            : null,
          endedOpen && directory.ended.nextCursor
            ? h(
                "text",
                {
                  selectable: false,
                  onMouseUp: (event: ClickEvent) => {
                    event.stopPropagation();
                    void controller.loadMore();
                  },
                  style: { fg: palette.accent, height: 1 },
                },
                labels.more,
              )
            : null,
          contentHeight === 0
            ? h(
                "text",
                { style: { fg: palette.muted, height: 1 } },
                controller.directoryError ? labels.unavailable : labels.empty,
              )
            : null,
        )
      : null,
  );
}
