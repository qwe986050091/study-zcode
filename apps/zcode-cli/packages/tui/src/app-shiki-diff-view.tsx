// INV-01 视图模式只由终端宽度阈值决定：守住位置 diffViewForWidth；改错故障 宽度非法时两列挤压或布局跳变。
// INV-02 行号宽度与 gutter 尾随空格是常量：守住位置 顶部布局常量；改错故障 行号与标记错位。
// INV-03 统一视图行模型必须保留原始标记与两侧行号：守住位置 buildDiffRows；改错故障 删除行占用新行号导致错位。
// INV-04 行号推进规则按侧独立：守住位置 展平循环的两个自增；改错故障 上下文行行号重复或跳号。
// INV-05 左右对照必须左右行数一致：守住位置 buildSplitDiffRows 的配对；改错故障 行高不齐、滚动错位。
// INV-06 上下文行左右复用同一行对象：守住位置 上下文分支；改错故障 同一行被构造两份，高亮索引分裂。
// INV-07 变更块以首个上下文行收尾：守住位置 内层收集循环；改错故障 跨块配对把远处改动凑成一行。
// INV-08 高亮结果必须带指纹校验后才落地：守住位置 cacheKey 比较；改错故障 旧 Promise 覆盖新内容的高亮。
// INV-09 卸载后迟到的高亮结果必须丢弃：守住位置 副作用内的销毁标记；改错故障 卸载后写状态触发警告。
// INV-10 高亮未完成时必须纯文本兜底：守住位置 highlightChunks 的早退；改错故障 首帧空白或丢行。
// INV-11 片段行数必须与行模型一一对应：守住位置 高亮结果的消费方式；改错故障 行错位着色。
// INV-12 左右单元格按 id 回指统一行序取片段：守住位置 indexById 映射；改错故障 左右行共用错误片段。
// INV-13 行背景与 gutter 背景必须分色：守住位置 两个色调查询；改错故障 行号区与正文混在一起。
// INV-14 截断提示固定缩进且只追加一行：守住位置 truncatedNode；改错故障 提示与正文错位或多行。
// INV-15 指纹构造用 NUL 分隔行 id 与内容：守住位置 diffRowsCacheKey；改错故障 相邻行拼接产生歧义。
// INV-16 shiki 与 opentui 的属性位不可互换：守住位置 位映射函数；改错故障 粗体斜体互相串位。
// INV-17 未知 fontStyle 位直接丢弃：守住位置 四个已知位判断；改错故障 误点亮未定义属性。
// INV-18 非法色值不兜底，由配置错误直接暴露：守住位置 rgba 解析；改错故障 静默使用错误颜色。
//
// 模块职责：把 diff hunk 展平为行模型，按终端宽度选择统一或左右视图，并叠加异步语法高亮。
// 状态所有权：高亮状态由组件本地持有；行模型每次由 patch 纯函数派生，不缓存可变数据。
// 阅读顺序：先看宽度与常量，再读行展平与配对，最后看节点拼装、gutter 与颜色工具。
// 语法高亮的 diff 视图渲染。
// 职责：把 hunk 展平为行模型，按终端宽度选择统一/左右视图并异步着色。
// 边界：纯渲染层，不修改 patch 数据、不参与工具结果判定。
// 副作用：effect 内发起异步高亮；卸载后迟到结果被丢弃。
// 降级：语言不可识别或高亮未完成时按纯文本+主题色渲染。

import { RGBA, StyledText, type TextChunk } from "@mbears/opentui-core";
import React from "react";
import type { ToolResultDisplayHunk, ToolResultDisplayLine } from "./app-model.js";
import {
  highlightShikiCodeLines,
  type ShikiHighlightSegment,
} from "./app-shiki-highlighter.js";
import { activeTuiTheme, type TuiThemeTokens } from "./theme/index.js";

// 布局与字符宽度常量：宽度超过 120 列才启用左右对照；行号固定 4 列宽，
// 与 gutter 中标记位、尾随空格一起构成行首装饰区。
// 宽度阈值决定左右对照是否启用。
// 行号宽度固定，保证不同视图的 gutter 对齐。
// 这些常量同时被布局、gutter 与缓存键使用。
// 改常量前先确认窄终端的退让路径。
const SPLIT_DIFF_WIDTH_BREAKPOINT = 120;
const LINE_NUMBER_WIDTH = 4;
const GUTTER_TRAILING_SPACE = " ";
const UNIFIED_EMPTY_MARKER = " ";
const EMPTY_LINE_NUMBER = "";
// shiki fontStyle 位掩码与 opentui 文本属性位并不相同，下面的常量成对出现，
// 用于在 highlightChunks 中做逐位映射；两者数值不可互换。
const SHIKI_FONT_STYLE_ITALIC = 1;
const SHIKI_FONT_STYLE_BOLD = 2;
const SHIKI_FONT_STYLE_UNDERLINE = 4;
const SHIKI_FONT_STYLE_STRIKETHROUGH = 8;
const OPENTUI_BOLD_ATTRIBUTE = 1;
const OPENTUI_ITALIC_ATTRIBUTE = 4;
const OPENTUI_UNDERLINE_ATTRIBUTE = 8;
const OPENTUI_STRIKETHROUGH_ATTRIBUTE = 128;

// 颜色解析结果缓存：同一主题色在每帧每个字符片段都会被请求，缓存避免重复解析十六进制色值。
// 同一主题色在每帧的每个 chunk 都会被请求，rgba() 每次先查缓存。
// 未命中时才走 RGBA.fromHex 解析，命中直接返回已缓存的 RGBA。
// Map 不做淘汰，因为键空间只来自有限主题色板，最多几十项。
const rgbaCache = new Map<string, RGBA>();

type DiffMarker = "+" | "-" | " ";
type DiffTone = ToolResultDisplayLine["tone"];

type ShikiDiffViewMode = "split" | "unified";

// 统一视图行模型：content 已去掉行首 +/-/空格标记；oldLine/newLine 为对应侧行号，
// 删除行无 newLine、新增行无 oldLine（undefined 表示该侧不占行号）。
// tone 决定背景色与前景色，marker 用于 gutter 展示。
type DiffDisplayRow = {
  content: string;
  id: string;
  marker: DiffMarker;
  newLine?: number;
  oldLine?: number;
  tone: DiffTone;
};

// 左右对照行：left/right 各为可选的一侧，缺省表示该侧留空（用空白 gutter 占位）。
// 上下文行左右指向同一个 DiffDisplayRow 以避免重复构造。
type SplitDiffRow = {
  id: string;
  left?: DiffDisplayRow;
  right?: DiffDisplayRow;
};

// 异步高亮结果及其对应的行指纹：cacheKey 用于丢弃过期结果（行内容变化后旧 Promise 仍可能返回）。
type HighlightState = {
  cacheKey: string;
  segmentsByRow: ShikiHighlightSegment[][];
};

// 渲染语法高亮的 diff：先把 structuredPatch 展平为统一行序，再按终端宽度选择视图模式。
// 输入：filePath 用于推断语言（未知语言则降级为纯文本着色）；terminalWidth 缺省由调用方保证；
// structuredPatch 为空时渲染空容器；truncated 为真时在末尾追加一行截断提示。
// 副作用：effect 内发起异步高亮（无 IO 外泄），组件卸载后迟到结果被 disposed 丢弃；
// 数据流不阻塞渲染，未完成时先用纯文本兜底，拿到结果后按 cacheKey 校验再替换。
// 不变量：segmentsByRow 的行数与 rows 一一对应（由 highlighter 侧补齐空行保证）。
// 行模型与指纹都按 patch 记忆化，避免每帧重算。
// 视图模式由宽度推导，调用方只能强制覆盖。
// 副作用只做异步高亮，不修改 patch。
// [资源] 高亮 Promise 不取消，但结果由销毁标记与指纹双重过滤。
// 渲染始终返回容器，空 patch 输出空内容。
export function ShikiDiffView(props: {
  filePath?: string;
  structuredPatch: ToolResultDisplayHunk[];
  terminalWidth: number;
  truncated?: boolean;
  view?: ShikiDiffViewMode;
}): React.ReactElement {
  const theme = activeTuiTheme();
  const rows = React.useMemo(() => buildDiffRows(props.structuredPatch), [props.structuredPatch]);
  const cacheKey = React.useMemo(() => diffRowsCacheKey(rows), [rows]);
  const [highlightState, setHighlightState] = React.useState<HighlightState | undefined>();
  const view = props.view ?? diffViewForWidth(props.terminalWidth);

  // effect 开头 setHighlightState(undefined)，旧 segmentsByRow 不跨 cacheKey 复用。
  // highlightShikiCodeLines 只传 filePath、lines、mode 三个字段，行文本由 rows 映射生成。
  // then 回调先判 disposed 再判 segmentsByRow 是否为空，两者都放过才 setHighlightState。
  // 清理函数只置标记，不等待 Promise 结束。
  // cacheKey 由 diffRowsCacheKey(rows) 生成并放进依赖数组，指纹一变就重跑 effect。
  React.useEffect(() => {
    let disposed = false;
    setHighlightState(undefined);
    void highlightShikiCodeLines({
      filePath: props.filePath,
      lines: rows.map((row) => row.content),
      mode: theme.mode,
    }).then((segmentsByRow) => {
      if (disposed || !segmentsByRow) return;
      setHighlightState({ cacheKey, segmentsByRow });
    });
    return () => {
      disposed = true;
    };
  }, [cacheKey, props.filePath, rows, theme.mode]);

  const segmentsByRow =
    highlightState?.cacheKey === cacheKey ? highlightState.segmentsByRow : undefined;

  return h(
    "box",
    {
      style: {
        flexDirection: "column",
        paddingLeft: 2,
        width: "100%",
      },
    },
    ...(view === "split"
      ? splitRowsToNodes(buildSplitDiffRows(rows), rows, segmentsByRow, theme)
      : unifiedRowsToNodes(rows, segmentsByRow, theme)),
    ...(props.truncated ? [truncatedNode(theme)] : []),
  );
}

// 输入：terminalWidth 为终端可见列数，NaN/负数/0 与阈值比较恒为 false，因此自然归入 unified。
// 输出只有 "split"/"unified" 两态，与 patch 行数无关；纯函数无副作用，可作为布局推导的稳定依据。
// 按宽度选视图：宽终端用左右对照便于定位改动，窄终端退化为统一视图避免两列挤压变形。
export function diffViewForWidth(terminalWidth: number): ShikiDiffViewMode {
  return terminalWidth > SPLIT_DIFF_WIDTH_BREAKPOINT ? "split" : "unified";
}

// 把 hunks 展平为逐行模型：marker 取原始行首字符（+/−/空格），content 去掉该前缀。
// 行号按侧推进：删除行不占用新文件行号，新增行不占用旧文件行号，上下文行两侧都推进。
// id 采用「hunkIndex:lineIndex」，仅在当前 patch 内唯一，作为 React key 与高亮索引使用。
// 每个 hunk 从各自的起始行号开始推进。
// diffMarker(rawLine) 取行首字符，diffContent 按 marker 用 slice(1) 去前缀。
// marker 为 "-" 时 newLine 留 undefined，为 "+" 时 oldLine 留 undefined。
// 两个自增分侧执行：marker 不是 "+" 才推进 oldLine，不是 "-" 才推进 newLine。
// id 只在当前 patch 内唯一，用作渲染键与高亮索引。
export function buildDiffRows(hunks: ToolResultDisplayHunk[]): DiffDisplayRow[] {
  const rows: DiffDisplayRow[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    hunk.lines.forEach((rawLine, lineIndex) => {
      const marker = diffMarker(rawLine);
      rows.push({
        content: diffContent(rawLine, marker),
        id: `${hunkIndex}:${lineIndex}`,
        marker,
        newLine: marker === "-" ? undefined : newLine,
        oldLine: marker === "+" ? undefined : oldLine,
        tone: toneForMarker(marker),
      });

      if (marker !== "+") oldLine += 1;
      if (marker !== "-") newLine += 1;
    });
  });

  return rows;
}

// 输出恒为数组：空输入返回空数组，不存在 null/undefined；行序按原始 hunk 顺序推进，不做重排。
// 纯函数：只读取 rows 的 marker/id/行号，不修改 DiffDisplayRow；返回的新数组仅供渲染侧消费。
// 左右对照配对：上下文行左右复用同一行；连续变更块内把删除行与新增行按序下标配对，
// 数量不等时多出一侧在对应配对位置留空，保证左右行数一致且行高对齐。
// 上下文行 push 时 left 与 right 都指向同一个 current 对象。
// 变更块内按 marker 分流："-" 推入 deleted，"+" 推入 added，两侧都保持文件顺序。
// pairCount 由 Math.max(deleted.length, added.length) 决定，短的一侧配 undefined。
// 循环按 pairCount 走满，缺的一侧仍 push 一行，保证左右两列行高一致。
// splitRows 的 id 由左右 id 拼成，left/right 保留原 DiffDisplayRow 以便回指。
export function buildSplitDiffRows(rows: DiffDisplayRow[]): SplitDiffRow[] {
  const splitRows: SplitDiffRow[] = [];
  let index = 0;

  while (index < rows.length) {
    const current = rows[index];
    if (!current) break;
    if (current.marker === " ") {
      splitRows.push({ id: current.id, left: current, right: current });
      index += 1;
      continue;
    }

    // 变更块以首次出现的上下文行为界；块内按 marker 分类收集删除/新增行，顺序即文件顺序。
    const deleted: DiffDisplayRow[] = [];
    const added: DiffDisplayRow[] = [];
    while (index < rows.length && rows[index]?.marker !== " ") {
      const changed = rows[index];
      if (changed?.marker === "-") deleted.push(changed);
      if (changed?.marker === "+") added.push(changed);
      index += 1;
    }

    const pairCount = Math.max(deleted.length, added.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const left = deleted[pairIndex];
      const right = added[pairIndex];
      splitRows.push({
        id: `${left?.id ?? "empty"}:${right?.id ?? "empty"}`,
        left,
        right,
      });
    }
  }

  return splitRows;
}

// 统一视图输出：每行一个 text 元素，背景按 tone 着色；segments 缺失时整行按主题正文色渲染。
function unifiedRowsToNodes(
  rows: DiffDisplayRow[],
  segmentsByRow: ShikiHighlightSegment[][] | undefined,
  theme: TuiThemeTokens,
): React.ReactElement[] {
  return rows.map((row, index) =>
    h("text", {
      content: rowToStyledText({
        row,
        segments: segmentsByRow?.[index],
        side: "unified",
        theme,
      }),
      key: `unified-${row.id}`,
      style: {
        bg: backgroundForTone(row.tone, theme),
        width: "100%",
      },
      wrapMode: "word",
    }),
  );
}

// 左右对照输出：两列各占 50% 宽、单行截断；通过 id->index 映射把左右行回指到统一行序，
// 从而复用同一份高亮片段（左右行来自不同源行时各自取自己的片段）。
function splitRowsToNodes(
  rows: SplitDiffRow[],
  sourceRows: DiffDisplayRow[],
  segmentsByRow: ShikiHighlightSegment[][] | undefined,
  theme: TuiThemeTokens,
): React.ReactElement[] {
  const indexById = new Map<string, number>();
  for (const [index, row] of sourceRows.entries()) {
    indexById.set(row.id, index);
  }

  return rows.map((row) =>
    h(
      "box",
      {
        key: `split-${row.id}`,
        style: {
          flexDirection: "row",
          width: "100%",
        },
      },
      splitCellNode({
        key: `left-${row.id}`,
        row: row.left,
        segments: row.left ? segmentsByRow?.[indexById.get(row.left.id) ?? -1] : undefined,
        side: "left",
        theme,
      }),
      splitCellNode({
        key: `right-${row.id}`,
        row: row.right,
        segments: row.right ? segmentsByRow?.[indexById.get(row.right.id) ?? -1] : undefined,
        side: "right",
        theme,
      }),
    ),
  );
}

// 单侧单元格：row 缺失时渲染空白填充以对齐行高；背景色沿用该行 tone，无行时按上下文色。
function splitCellNode(input: {
  key: string;
  row?: DiffDisplayRow;
  segments?: ShikiHighlightSegment[];
  side: "left" | "right";
  theme: TuiThemeTokens;
}): React.ReactElement {
  const tone = input.row?.tone ?? "context";
  return h("text", {
    content: rowToStyledText({
      row: input.row,
      segments: input.segments,
      side: input.side,
      theme: input.theme,
    }),
    key: input.key,
    style: {
      bg: backgroundForTone(tone, input.theme),
      width: "50%",
    },
    truncate: true,
    wrapMode: "none",
  });
}

// 拼装一行 StyledText：先 gutter（行号+标记，单独背景），再高亮片段。
// 无 segments 时用 row.content 与主题正文色兜底，因此高亮未完成也有可读内容。
function rowToStyledText(input: {
  row?: DiffDisplayRow;
  segments?: ShikiHighlightSegment[];
  side: "left" | "right" | "unified";
  theme: TuiThemeTokens;
}): StyledText {
  const tone = input.row?.tone ?? "context";
  const rowBackground = backgroundForTone(tone, input.theme);
  const gutterBackground = gutterBackgroundForTone(tone, input.theme);
  const fallbackText = input.row?.content ?? "";
  return new StyledText([
    styledChunk(gutterText(input.row, input.side), input.theme.diffLineNumber, gutterBackground),
    ...highlightChunks(input.segments, fallbackText, input.theme.text, rowBackground),
  ]);
}

// 把高亮片段转成 opentui chunk：片段色缺省用主题正文色，背景统一用行背景；
// segments 为空（未高亮/语言不支持）时退化为单个纯文本 chunk，保证内容不丢失。
function highlightChunks(
  segments: ShikiHighlightSegment[] | undefined,
  fallbackText: string,
  fallbackColor: string,
  background: string,
): TextChunk[] {
  if (!segments?.length) return [styledChunk(fallbackText, fallbackColor, background)];
  return segments.map((segment) =>
    styledChunk(
      segment.text,
      segment.color ?? fallbackColor,
      background,
      opentuiAttributesFromShiki(segment.fontStyle),
    ),
  );
}

// 截断提示行：patch 本身被截断时追加，文案固定缩进 4 列以与行内容对齐。
function truncatedNode(theme: TuiThemeTokens): React.ReactElement {
  return h("text", {
    key: "diff-truncated",
    style: {
      fg: theme.diffLineNumber,
      width: "100%",
    },
  }, "    ... diff truncated");
}

// 行首装饰区：4 位行号 + 空格 + 标记 + 尾随空格。左右视图取对应侧行号，
// 统一视图对新增行取新行号、其余取旧行号；row 缺失时输出全空白占位。
function gutterText(row: DiffDisplayRow | undefined, side: "left" | "right" | "unified"): string {
  if (!row) return `${EMPTY_LINE_NUMBER.padStart(LINE_NUMBER_WIDTH)}   `;
  const lineNumber = side === "left" ? row.oldLine : side === "right" ? row.newLine : displayLine(row);
  const marker = side === "unified" ? row.marker : markerForSplitSide(row, side);
  return `${String(lineNumber ?? "").padStart(LINE_NUMBER_WIDTH)} ${marker}${GUTTER_TRAILING_SPACE}`;
}

// 左右视图的标记：只有落在本侧的行才显示 +/−，另一侧显示空格，
// 避免同一行在两侧重复出现符号造成误读。
function markerForSplitSide(row: DiffDisplayRow, side: "left" | "right"): string {
  if (row.marker === " ") return UNIFIED_EMPTY_MARKER;
  if (side === "left") return row.marker === "-" ? "-" : UNIFIED_EMPTY_MARKER;
  return row.marker === "+" ? "+" : UNIFIED_EMPTY_MARKER;
}

// 统一视图行号取值：新增行用新文件行号，其余（删除/上下文）用旧文件行号。
function displayLine(row: DiffDisplayRow): number | undefined {
  return row.marker === "+" ? row.newLine : row.oldLine;
}

// 高亮缓存的指纹：id 与内容用 \0 分隔，避免相邻行拼接产生歧义（如 "a"+"bc" 与 "ab"+"c"）。
function diffRowsCacheKey(rows: DiffDisplayRow[]): string {
  return rows.map((row) => `${row.id}\0${row.content}`).join("\n");
}

// 从原始 patch 行首字符识别类型；不以前缀开头的行一律视为上下文。
function diffMarker(rawLine: string): DiffMarker {
  if (rawLine.startsWith("+")) return "+";
  if (rawLine.startsWith("-")) return "-";
  return " ";
}

// 去掉行首标记字符；上下文行可能带前导空格也可能不带，后者原样返回。
function diffContent(rawLine: string, marker: DiffMarker): string {
  if (marker === "+" || marker === "-") return rawLine.slice(1);
  return rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
}

// 标记到语义色调的映射：+ 新增、- 删除、空格上下文，供背景/前景查询使用。
function toneForMarker(marker: DiffMarker): DiffTone {
  if (marker === "+") return "addition";
  if (marker === "-") return "deletion";
  return "context";
}

// 行背景色：新增/删除/上下文各取主题对应背景 token，两者色值随主题模式变化。
function backgroundForTone(tone: DiffTone, theme: TuiThemeTokens): string {
  if (tone === "addition") return theme.diffAddedBg;
  if (tone === "deletion") return theme.diffRemovedBg;
  return theme.diffContextBg;
}

// gutter 背景色：新增/删除用行号专用底色以区分标记区，上下文行沿用上下文背景。
function gutterBackgroundForTone(tone: DiffTone, theme: TuiThemeTokens): string {
  if (tone === "addition") return theme.diffAddedLineNumberBg;
  if (tone === "deletion") return theme.diffRemovedLineNumberBg;
  return theme.diffContextBg;
}

// 构造 opentui 的 TextChunk；attributes 为位掩码，0 表示无粗体/斜体等修饰。
function styledChunk(text: string, fg: string, bg: string, attributes = 0): TextChunk {
  return {
    __isChunk: true,
    attributes,
    bg: rgba(bg),
    fg: rgba(fg),
    text,
  };
}

// 十六进制色值转 RGBA 并缓存；非法色值由 RGBA.fromHex 抛错，属调用方配置错误，不在此兜底。
function rgba(color: string): RGBA {
  const cached = rgbaCache.get(color);
  if (cached) return cached;
  const parsed = RGBA.fromHex(color);
  rgbaCache.set(color, parsed);
  return parsed;
}

// shiki fontStyle 位 -> opentui 属性位的转换；0/undefined 视为无修饰，
// 只做已知 4 种位的映射，未知位直接丢弃（避免误点亮其他属性）。
function opentuiAttributesFromShiki(fontStyle: number | undefined): number {
  if (!fontStyle) return 0;
  let attributes = 0;
  if ((fontStyle & SHIKI_FONT_STYLE_BOLD) !== 0) attributes |= OPENTUI_BOLD_ATTRIBUTE;
  if ((fontStyle & SHIKI_FONT_STYLE_ITALIC) !== 0) attributes |= OPENTUI_ITALIC_ATTRIBUTE;
  if ((fontStyle & SHIKI_FONT_STYLE_UNDERLINE) !== 0) attributes |= OPENTUI_UNDERLINE_ATTRIBUTE;
  if ((fontStyle & SHIKI_FONT_STYLE_STRIKETHROUGH) !== 0) {
    attributes |= OPENTUI_STRIKETHROUGH_ATTRIBUTE;
  }
  return attributes;
}

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;
