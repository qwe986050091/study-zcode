// INV-01 图标数据仅为常量：守住位置 常量导出；改错故障 节点文件超出行数门禁。
// INV-02 命名空间复用单一常量：守住位置 顶部常量；改错故障 每处硬编码字符串漂移。
// INV-03 图标节点类型限定三种标签：守住位置 联合类型；改错故障 任意标签被允许。
// INV-04 属性表只读：守住位置 只读映射；改错故障 构建过程改写常量。
// INV-05 常量以 satisfies 收窄：守住位置 类型断言；改错故障 拼写错误标签不报错。
// INV-06 每个图标自带名称：守住位置 成对导出；改错故障 名称与图形不匹配。
// INV-07 视图框固定 24 见方：守住位置 viewBox 赋值；改错故障 图形被裁切或缩放。
// INV-08 尺寸固定 16 像素：守住位置 宽高赋值；改错故障 提及区图标撑高行高。
// INV-09 描边继承当前颜色：守住位置 stroke 赋值；改错故障 深色主题下图标不可见。
// INV-10 线宽与线帽统一：守住位置 属性设置；改错故障 不同图标粗细不一。
// INV-11 图标对辅助技术隐藏：守住位置 aria 与 tabindex；改错故障 读屏重复播报装饰图形。
// INV-12 内联排版类名固定：守住位置 类名追加；改错故障 图标换行导致基线跳动。
// INV-13 子节点按数据顺序生成：守住位置 遍历顺序；改错故障 图形层级颠倒。
// INV-14 属性逐项写入不覆盖：守住位置 双参 setAttribute；改错故障 名称冲突时丢属性。
// INV-15 生成的根元素直接返回：守住位置 返回值；改错故障 调用方拿到未挂子节点的空图。
// INV-16 仅创建不插入文档：守住位置 纯构建边界；改错故障 构建时污染调用方 DOM。
// INV-17 标签名与属性值保持原始字符串：守住位置 数据来源；改错故障 构建期改写常量。
// INV-18 新增插件图标只扩展常量：守住位置 数据区；改错故障 需要改动构建函数。
//
// 模块职责：承载提及节点的分类图标数据与原生 SVG 构建函数。
// 状态所有权：无状态；全部为常量与纯构建函数。
// 阅读顺序：先看命名空间与类型，再看图标数据区，最后看构建函数。
// PromptMentionNode.ts 承载 Lexical 节点行为 + 全部分类图标 DOM 数据，
// 新增 plugin 图标后超出 max-lines(400) 门禁。图标数据/DOM 构建是纯展示常量，
// 与节点行为解耦到本文件；PromptMentionNode 继续 re-export 保持既有导入面兼容。
//
// PromptMentionNode 是 Lexical 自定义 DOM 节点，不能直接渲染 lucide-react 组件。
// 这里保留 lucide 的 IconNode 数据形状，再用原生 SVG DOM 生成图标。
// SVG_NS 只在此处声明一次。
// 后续 createElementNS 全部复用 SVG_NS。
// tagName 与 attrs 的名称都取自常量表。
// 名称写错时由 satisfies 的类型断言拦下。
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// path 与 circle 与 rect 三种基础图形标签是唯一允许值。
// attrs 的类型是 Readonly<Record<string, string>>。
// readonly 同时作用于外层表与内层字符串映射。
export type MentionLucideIconNode = ReadonlyArray<
  readonly [
    "path" | "circle" | "rect",
    Readonly<Record<string, string>>,
  ]
>;

export const SKILL_MENTION_LUCIDE_ICON_NAME = "WandSparkles";
export const SKILL_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72",
    },
  ],
  ["path", { d: "m14 7 3 3" }],
  ["path", { d: "M5 6v4" }],
  ["path", { d: "M19 14v4" }],
  ["path", { d: "M10 2v2" }],
  ["path", { d: "M7 8H3" }],
  ["path", { d: "M21 16h-4" }],
  ["path", { d: "M11 3H9" }],
] as const satisfies MentionLucideIconNode;

export const SUBAGENT_MENTION_LUCIDE_ICON_NAME = "Bot";
export const SUBAGENT_MENTION_ICON_NODE = [
  ["path", { d: "M12 8V4H8" }],
  ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
  ["path", { d: "M2 14h2" }],
  ["path", { d: "M20 14h2" }],
  ["path", { d: "M15 13v2" }],
  ["path", { d: "M9 13v2" }],
] as const satisfies MentionLucideIconNode;

export const WHITEBOARD_MENTION_LUCIDE_ICON_NAME = "Palette";
export const WHITEBOARD_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "M12 22a8 8 0 0 1-8-8 8.5 8.5 0 0 1 8.5-8.5H16a4 4 0 0 1 0 8h-1.5a2 2 0 0 0 0 4H16a6 6 0 0 1-4 4.5Z",
    },
  ],
  ["path", { d: "M7.5 14h.01" }],
  ["path", { d: "M9.5 10h.01" }],
  ["path", { d: "M14.5 9h.01" }],
  ["path", { d: "M17 12h.01" }],
] as const satisfies MentionLucideIconNode;

export const GOAL_COMMAND_MENTION_LUCIDE_ICON_NAME = "Goal";
export const GOAL_COMMAND_MENTION_ICON_NODE = [
  ["path", { d: "M12 13V2l8 4-8 4" }],
  ["path", { d: "M20.561 10.222a9 9 0 1 1-12.55-5.29" }],
  ["path", { d: "M8.002 9.997a5 5 0 1 0 8.9 2.02" }],
] as const satisfies MentionLucideIconNode;

export const WORKFLOW_COMMAND_MENTION_LUCIDE_ICON_NAME = "Workflow";
export const WORKFLOW_COMMAND_MENTION_ICON_NODE = [
  ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4" }],
  ["rect", { width: "8", height: "8", x: "13", y: "13", rx: "2" }],
] as const satisfies MentionLucideIconNode;

export const COMPACT_COMMAND_MENTION_LUCIDE_ICON_NAME = "ScrollText";
export const COMPACT_COMMAND_MENTION_ICON_NODE = [
  ["path", { d: "M15 12h-5" }],
  ["path", { d: "M15 8h-5" }],
  ["path", { d: "M19 17V5a2 2 0 0 0-2-2H4" }],
  [
    "path",
    {
      d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
    },
  ],
] as const satisfies MentionLucideIconNode;

export const COMMAND_MENTION_LUCIDE_ICON_NAME = "SquareSlash";
export const COMMAND_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "M21 5v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
    },
  ],
  ["path", { d: "m9 15 6-6" }],
] as const satisfies MentionLucideIconNode;

export const SESSION_MENTION_LUCIDE_ICON_NAME = "MessagesSquare";
export const SESSION_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "M14 9a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
    },
  ],
  ["path", { d: "M18 9h2a2 2 0 0 1 2 2v10l-4-4h-6a2 2 0 0 1-2-2v-1" }],
] as const satisfies MentionLucideIconNode;

export const PLUGIN_MENTION_LUCIDE_ICON_NAME = "Cable";
export const PLUGIN_MENTION_ICON_NODE = [
  ["path", { d: "M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z" }],
  ["path", { d: "M17 21v-2" }],
  ["path", { d: "M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10" }],
  ["path", { d: "M21 21v-2" }],
  ["path", { d: "M3 5V3" }],
  ["path", { d: "M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z" }],
  ["path", { d: "M7 5V3" }],
] as const satisfies MentionLucideIconNode;

// 先经 createElementNS 建根元素再补固定属性。
// 逐个 data 项 appendChild 生成子节点。
// 最后原样返回 root 变量指向的根元素。
export function createMentionSvgIcon(iconNode: MentionLucideIconNode): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("inline-block", "align-middle", "shrink-0");

  for (const [tagName, attributes] of iconNode) {
    const node = document.createElementNS(SVG_NAMESPACE, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, value);
    }
    svg.append(node);
  }

  return svg;
}
