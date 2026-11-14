// ============================================================================
// markdown-table.tsx — 聊天流内 Markdown 表格的交互层
//
// 职责：把 assistant 输出里的 table 包装成「可横向阅读 + 可导出」的表格：
//   1) 在消息列宽度内按内容自然排布，超宽时允许向左右借用 timeline 空间；
//   2) 渲染一条自绘虚拟横向滚动条（原生滚动条被 scrollbar-hide 隐藏）；
//   3) 提供复制 Markdown / 下载 CSV / 全屏预览 / 增强滚动四类动作。
//
// 复用面：普通会话、subagent 面板、V4 transform 定位的 virtual row、只读分享页。
// 因此所有布局判定都必须能在「没有 composer dock」「没有 ChatView 根节点」
// 「父容器是 transform 定位的虚拟行」这三种环境下退化为安全值，不能假定单一宿主。
//
// 说明：这里的 setState 全部由 commitXxx 包裹。commitXxx 的提前 return 不是性能优化，
// 而是正确性的一部分：同一帧内反复提交相同字符串会让 React 做无意义的重渲染，
// 进而触发 ResizeObserver -> 再次测量的回环。
//
// INV 不变量表（「守住它的位置」指向真正执行约束的函数；改错后的故障见本文件末尾故障表）
// INV-01 只读量化：几何测量阶段不得写 DOM，唯一例外是吸底补偿写 wrapper.style.transform。
//         守住：measureViewportMaxWidth / updateStickyOffset。
// INV-02 提交幂等：每个 commitXxx 在值未变化时必须提前 return，避免同帧 setState 风暴。
//         守住：commitEdgeShadowState 等九个 commit 回调。
// INV-03 单向映射：虚拟 scrollLeft 是唯一事实源，viewport.scrollLeft 与 viewportLeftOffset
//         都由它派生，不得反向覆盖虚拟值。
//         守住：commitVirtualScrollLeft。
// INV-04 虚拟最大滚动距离 = 表格宽度 - 稳定槽宽，不得掺入 viewportLeftOffset。
//         守住：resolveVirtualScrollMax（它只接受 tableWidth 与 trackWidth）。
// INV-05 overflow 判定与 thumb 比例必须使用同一轮槽宽（virtualScrollTrackWidthRef 的浮点值）。
//         守住：resolveVirtualScrollLayoutWidth 与 resolveRenderedVirtualScrollTrackWidth 的分工。
// INV-06 左借位只在 expandedScrollEnabled 为真时生效；关闭时必须把 offset 归零并把
//         同一个虚拟位置重新映射回真实 scrollLeft。
//         守住：measureViewportMaxWidth 的 expanded 分支 + handleToggleExpandedScroll。
// INV-07 边缘阴影：左侧只由真实 viewport.scrollLeft 决定，右侧由虚拟总进度决定；
//         左借位本身不算「内容被遮住」。
//         守住：measureEdgeShadowState。
// INV-08 增强滚动按钮的可见性由「当前确有横向溢出」或「用户已开启」决定，
//         只能在测量完成后翻转，不能在渲染期根据 props 猜测。
//         守住：commitCanToggleExpandedScroll 的调用点。
// INV-09 吸底滚动条需同时满足：未被 opt-out、可见高度 > 0、表格高度 > 可视高的 80%。
//         守住：resolveMarkdownTableStickyScrollbarMode。
// INV-10 吸底偏移只能向上（offset <= 0），且不得越过表格自身下边界。
//         守住：resolveMarkdownTableStickyScrollbarOffset 的两个 Math.min/Math.max。
// INV-11 吸底避让量 = composer dock 高度 + 回到底部按钮高度 + 8px，缺任意一项都会被遮挡。
//         守住：readMarkdownTableDockHeight / readMarkdownTableBackToBottomClearance。
// INV-12 观察者生命周期只跟 DOM 节点绑定；内容变化交给 ResizeObserver 合到下一帧，
//         不得因 children 变化重建 observer 或同步读布局。
//         守住：两个 useEffect 的依赖数组（只允许稳定回调）。
// INV-13 所有 rAF 句柄必须在 cleanup 里 cancel，否则卸载后仍会写 state 并告警。
//         守住：三处 cleanup 里的 rafId / rectWatchRafId。
// INV-14 按 track 时 thumb 居中；按 thumb 拖动时保持指针在 thumb 内的相对偏移。
//         守住：handleVirtualScrollbarThumbPointerDown 与 commitVirtualScrollLeftFromClientX。
// INV-15 pointer capture 必须在 up/cancel 释放，且只在确实持有时释放（否则 Safari 抛错）。
//         守住：handleVirtualScrollbarPointerEnd。
// INV-16 CSV 导出必须同时做公式注入降级与 UTF-8 BOM，缺一都会在表格软件里出事。
//         守住：escapeCsvCell / buildCsvTableText。
// INV-17 复制与预览的表格文本只从 DOM 单元格读取，不读 React props —— 必须与用户所见一致。
//         守住：readRowsFromTable。
// INV-18 分享/只读场景不引入新依赖：本文件只允许引用已有组件与纯函数。
//         守住：import 区（新增静态 import 会同时进入公开分享页 bundle）。
// ============================================================================
"use client";

import type {
  ComponentProps,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MarkdownTableNodeProp = {
  node?: unknown;
};

// 边缘阴影的四种状态是互斥枚举而不是两个 boolean：
// 左右同时为真时必须落到 both，否则右侧阴影会在左侧条件分支里被跳过。
type MarkdownTableEdgeShadowState = "none" | "left" | "right" | "both";

export type MarkdownTableRows = string[][];

type MarkdownTableFrameDistances = {
  leftDistance: number;
  maxLeftOffset: number;
  scrollbarWidth: number;
  rightDistance: number;
  maxViewportWidth: number;
};

type MarkdownTableVirtualScrollbarMetrics = {
  contentWidth: number;
  thumbLeft: number;
  thumbWidth: number;
};

type MarkdownTableObservedRect = {
  left: number;
  right: number;
  width: number;
};

// [权衡] 根节点选择器同时接受新版显式布局根与旧 chat-view，是为了兼容尚未升级的宿主。
// 新版根通过 CSS 变量给出响应式左右 inset；旧根只能回退到按窗口宽度估算。
// sticky-disabled 选择器由 subagent 面板写在祖先上：它的 prompt/output 继承了
// 会话级 dock 高度，若也启用吸底，虚拟滚动条会被抬到嵌套容器中段。
// v4 composer dock 与回到底部按钮是两个独立选择器，因为按钮挂在 dock 的锚点子树里，
// 只量 dock 会让长表滚动条和按钮抢同一条水平带。
const MARKDOWN_TABLE_ROOT_SELECTOR =
  '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]';
const MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR = '[data-markdown-table-sticky-scrollbar="disabled"]';
const MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR =
  '[data-v4-back-to-bottom-anchor="composer-dock"] button';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX = 8;
const MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX = 32;
const MARKDOWN_TABLE_CONTENT_PADDING_LG_PX = 16;
const MARKDOWN_TABLE_CONTENT_PADDING_MD_PX = 8;
const MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO = 0.8;
const MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY = "--markdown-table-layout-left-inset";
const MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY = "--markdown-table-layout-right-inset";

// 单元格文本归一：折叠所有空白（含换行）为单空格。
// 复制出来的 Markdown 若保留源码里的折行，粘贴到表格软件会被当成分行，
// 因此 normalize 处理的是「表格语义」而不是「显示宽度」。
function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// 顺序不可交换：先转义反斜杠再转义竖线，否则新生成的 `\|` 会被上一轮反斜杠转义二次加倍。
// 换行必须变成 br 标签，因为 GFM 表格单元格内不允许裸换行，裸换行会把一张表拆成两张。
function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeCsvCell(value: string): string {
  // assistant markdown 属于不可信输入，CSV 被 Excel/Numbers/LibreOffice
  // 打开时会解释公式前缀。下载前统一把公式型单元格降级成纯文本。
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

// 把二维文本重建为 GFM 表格：首行当表头，第二行补分隔行。
// 列数取所有行的最大长度而不是首行长度：DOM 表格允许后续行 td 更多（rowspan/colspan 降维后），
// 按首行截断会静默丢列。
// 空数组返回空串而不是空表格，避免复制动作产生一段只有表头的残表。
// 分隔行固定 `---`，不做对齐推断：源信息里没有对齐语义，臆造对齐反而会改变渲染。
export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  // 空表格是合法输入（表头刚被流式写出、正文还没到），
  // 此时复制应得到空串而不是只有分隔行的残表。
  if (rows.length === 0) {
    return "";
  }

  // Math.max(..., 1) 保证空行数组也至少有一列，
  // 否则 Array.from({length: 0}) 会让 join 出 `|  |` 这种不可解析的行。
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

// CSV 用 CRLF 而不是 LF：Windows 系表格软件对裸 LF 的兼容性依赖实现，CRLF 是安全默认。
// BOM 必须加在字符串最前面（见下方注释）；调用方不要再二次拼 BOM，否则会出现两个。
export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // Blob 的 charset 不会写入文件字节，Excel 会把无 BOM 的 UTF-8 CSV
  // 按本地代码页解析，导致中文乱码；显式添加 UTF-8 BOM 让表格软件可靠识别编码。
  return `\uFEFF${csv}`;
}

// 从真实 DOM 读取「用户此刻看到的内容」，包括渲染器插入的换行与隐藏文本。
// 只取 th/td，忽略 thead/tbody 结构差异；空行被过滤掉，避免 colspan 占位行变成空行。
// 这里故意不做 trims 之外的清洗：复制与预览的职责是把所见搬到剪贴板，
// 而不是把表格「再解释一遍」。table 为空时返回空数组，由调用方决定提示。
function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}

// 布局边界解析：显式根优先，找不到才回退到组件自身最外层容器。
// 回退值只是「不让测量崩掉」的安全网，不代表语义正确：
// 组件自身宽度等于 frame 宽度，此时可借用空间恒为 0，增强滚动按钮不会出现。
// [权衡] 不回退到 document.body：body 宽度会被侧栏/对话框污染，算出的 borrow 空间
// 会让表格在弹窗里横穿整屏。
function resolveMarkdownTableRoot(
  frame: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  // V4 删除旧 ChatView 后不再渲染 data-testid="chat-view"，表格会退回自身宽度，
  // 因而误判增强横向滚动没有收益。优先使用跨版本的显式布局边界，旧选择器只保留兼容。
  return frame?.closest<HTMLElement>(MARKDOWN_TABLE_ROOT_SELECTOR) ?? fallbackRoot;
}

// 旧宿主（无显式布局根）的右 padding 只能按窗口断点估算，
// 断点必须与 ChatConversationContent 的 px-8 / max-lg:px-4 / max-md:px-2 保持一致。
// 三处任何一处改动而这里没跟，右借位都会多算或漏算 8~16px，表现为表格右侧贴边或被裁。
function getMarkdownTableContentInlineInsetPx() {
  if (typeof window === "undefined") {
    return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
  }

  // 表格宽度借用 ChatView root 右侧空间时，需要扣掉消息列本身的响应式右 padding。
  // 对应 ChatConversationContent 的 px-8 max-lg:px-4 max-md:px-2。
  if (window.innerWidth < 768) {
    return MARKDOWN_TABLE_CONTENT_PADDING_MD_PX;
  }

  if (window.innerWidth < 1024) {
    return MARKDOWN_TABLE_CONTENT_PADDING_LG_PX;
  }

  return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
}

// 新版根把安全边距交给 CSS 变量，因此这里读的是计算后的 px 值而不是 Tailwind 类。
// 变量缺失时 readCssPixelValue 返回 0，等价于「不缩进」——安全但偏激进，
// 这也是为什么只有显式标记为布局根的节点才走这条路径。
function getMarkdownTableRootInlineInsets(root: HTMLElement) {
  if (typeof window !== "undefined" && root.matches('[data-markdown-table-layout-root="true"]')) {
    return {
      leftInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY),
      rightInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY),
    };
  }

  const legacyInset = getMarkdownTableContentInlineInsetPx();
  return { leftInset: legacyInset, rightInset: legacyInset };
}

// 把 getBoundingClientRect 收敛成三个整数分量，用于「布局是否真的动了」的廉价比较。
// 取整是刻意的：亚像素抖动会让 state panel 动画期间每帧都被判为变化，
// 从而每帧触发一次完整测量。
// 只保留 left/right/width，不保留 top/bottom —— 纵向变化由吸底逻辑单独处理，
// 混进来会让横向测量跟着纵向滚动重跑。
function readMarkdownTableObservedRect(
  element: HTMLElement | null,
): MarkdownTableObservedRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
  };
}

function isMarkdownTableObservedRectEqual(
  leftRect: MarkdownTableObservedRect | null,
  rightRect: MarkdownTableObservedRect | null,
) {
  return (
    leftRect?.left === rightRect?.left &&
    leftRect?.right === rightRect?.right &&
    leftRect?.width === rightRect?.width
  );
}

// 读 CSS 变量并做三重兜底：元素缺失、SSR（无 window）、非数值。
// Math.max(0, ...) 防止宿主写入负边距时把可用空间反向放大。
function readCssPixelValue(element: HTMLElement | null, propertyName: string) {
  if (!element || typeof window === "undefined") {
    return 0;
  }

  const value = window.getComputedStyle(element).getPropertyValue(propertyName);
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}

// dock 高度优先读旧 ChatView 的 CSS 变量，读不到再去量 V4 composer dock 的真实高度。
// 两者的顺序不能反：旧宿主可能同时存在一个视觉上隐藏的 dock 节点，
// 量出来是 0，会让吸底滚动条落到输入框下面。
// 返回 0 是合法值（无 dock 的只读分享页），调用方据此退化成「不避让」。
function readMarkdownTableDockHeight(root: HTMLElement | null) {
  const legacyDockHeight = readCssPixelValue(root, "--chat-bottom-dock-height");
  if (legacyDockHeight > 0) return legacyDockHeight;

  // V4 composer dock 位于 timeline 滚动视口内部，但不再设置旧 ChatView 的
  // CSS 变量。直接读取真实 dock 高度，避免吸底滚动条被输入区覆盖。
  return (
    root
      ?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR)
      ?.getBoundingClientRect().height ?? 0
  );
}

// 离底时回到底部按钮悬浮在 dock 上方，吸底滚动条必须再让出「按钮高度 + 8px」。
// 找不到按钮返回 0；这里刻意不用 querySelectorAll 取最大高度——
// 同一时刻只会渲染一个回到底部按钮。
function readMarkdownTableBackToBottomClearance(root: HTMLElement | null) {
  const button = root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR);
  if (!button) return 0;

  return button.getBoundingClientRect().height + MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX;
}

// resolveMarkdownTableVerticalViewport 向上找能纵向滚动的祖先，作为吸底滚动的参考视口。
// 两个条件缺一不可：overflow-y 允许滚动，且 scrollHeight 确实大于 clientHeight。
// 只判 overflow-y 会踩到一个经典陷阱：横向滚动容器设置了 overflow-x-auto 后，
// 浏览器会把 overflow-y 计算成 auto，于是表格自己成了「视口」，
// 表格高度恒等于可视高度，80% 判定永远成立，短表也会长出吸底条。
// +1 是像素取整容差；clientHeight 为 0（display:none / 折叠中）时跳过，
// 否则会把隐藏容器当成视口算出 0 高度。
function resolveMarkdownTableVerticalViewport(
  element: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  if (typeof window === "undefined") {
    return fallbackRoot;
  }

  let currentElement = element?.parentElement ?? null;
  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const canScrollY = /auto|scroll|overlay/u.test(style.overflowY);
    // 横向滚动 viewport 因 overflow-x-auto 可能让浏览器把 overflow-y 计算成 auto；
    // 如果不确认真的存在纵向滚动空间，短表格会把自身高度误当成可视区域高度，导致 80% 判定永远成立。
    const hasVerticalScrollRange = currentElement.scrollHeight > currentElement.clientHeight + 1;
    if (canScrollY && currentElement.clientHeight > 0 && hasVerticalScrollRange) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return fallbackRoot;
}

// 纯函数，便于单测覆盖三种退化：opt-out、可视高为 0、表格未超阈值。
// 阈值取可视高度的 80% 而不是 100%：表格刚过一屏时若启用吸底，
// 滚动条会浮在最后一行正文上，反而更碍事。
// visibleHeight 先做 Math.max(0, ...)，dock 比视口还高时不能得出正数。
export function resolveMarkdownTableStickyScrollbarMode({
  stickyScrollbarDisabled,
  viewportHeight,
  dockHeight,
  tableHeight,
}: {
  stickyScrollbarDisabled: boolean;
  viewportHeight: number;
  dockHeight: number;
  tableHeight: number;
}) {
  if (stickyScrollbarDisabled) {
    return false;
  }

  // 可视高度要扣掉 dock：dock 覆盖在 timeline 之上，
  // 不扣会让「表格是否超过 80% 可视高」的判定偏乐观。
  const visibleHeight = Math.max(0, viewportHeight - dockHeight);
  return (
    visibleHeight > 0 && tableHeight > visibleHeight * MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO
  );
}

// 计算吸底条的纵向补偿量，语义是「把条从自然位置往上推多少」。
// minimumBottom 先保证不越过 frameBottom（表格自身下边界），
// 再与 viewportBottom 取大，最后整体夹到 <= 0。
// 两次夹取的顺序不能换：先夹 viewport 再夹 frame，会让条在表格底部之外仍然上浮，
// 视觉上脱离表格。
export function resolveMarkdownTableStickyScrollbarOffset({
  frameTop,
  frameBottom,
  scrollbarHeight,
  viewportBottom,
}: {
  frameTop: number;
  frameBottom: number;
  scrollbarHeight: number;
  viewportBottom: number;
}) {
  // 下界先保证滚动条至少完整落在表格内（frameTop + 条高），
  // 再被 frameBottom 截断，防止条高大于表格时反向下溢。
  const minimumBottom = Math.min(frameBottom, frameTop + Math.max(0, scrollbarHeight));
  const pinnedBottom = Math.min(frameBottom, Math.max(minimumBottom, viewportBottom));
  return Math.min(0, pinnedBottom - frameBottom);
}

// 把 DOM 侧证据（视口、dock、表格高度、opt-out 祖先）收齐后交给纯函数判定。
// viewportHeight 的三级兜底依次是 clientHeight、rect.height、window.innerHeight，
// 最后一级只在 SSR 边界之外才会命中，但保留它可以让测量失败时退回「按窗口判断」。
// opt-out 用 closest 而不是逐层检查，确保 subagent 的任意嵌套层都能生效。
function shouldUseMarkdownTableStickyScrollbar({
  root,
  table,
}: {
  root: HTMLElement | null;
  table: HTMLTableElement | null;
}) {
  if (!table) {
    return false;
  }

  const viewport = resolveMarkdownTableVerticalViewport(table, root);
  const viewportHeight =
    viewport?.clientHeight ||
    viewport?.getBoundingClientRect().height ||
    (typeof window === "undefined" ? 0 : window.innerHeight);
  const dockHeight = readMarkdownTableDockHeight(root);
  const tableHeight = table.getBoundingClientRect().height;

  // subagent prompt/output 会继承会话 dock 高度；如果也启用 sticky，虚拟滚动条会在
  // 嵌套容器内错误上抬到表格中段。显式 opt-out 不依赖容器当前是否已经产生纵向 overflow。
  return resolveMarkdownTableStickyScrollbarMode({
    stickyScrollbarDisabled: table.closest(MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR) !== null,
    viewportHeight,
    dockHeight,
    tableHeight,
  });
}

// 把「frame 相对 root 的左右余量」翻译成可借用宽度与槽宽。
// leftDistance / rightDistance 都夹到 >= 0：frame 可能因为动画 momentary 超出 root。
// maxLeftOffset 要扣掉 leftInset，scrollbarWidth 要扣掉 rightInset ——
// 这两个 inset 就是消息列自身的 padding，不扣会让表格盖住正文左边距。
// maxViewportWidth 与 scrollbarWidth 同值是有意的：调用方只应消费一个概念，
// 保留两个字段是为了让调用点读起来更贴近语义。
export function resolveMarkdownTableFrameDistances({
  frameWidth,
  frameLeft,
  frameRight,
  rootLeft,
  rootRight,
  leftInset = 0,
  rightInset = 0,
}: {
  frameWidth: number;
  frameLeft: number;
  frameRight: number;
  rootLeft: number;
  rootRight: number;
  leftInset?: number;
  rightInset?: number;
}): MarkdownTableFrameDistances {
  // frame 与 root 的位置差就是左右可借用空间；
  // 夹到 0 是为了吸收入场动画第一帧的负偏移。
  const leftDistance = Math.max(0, frameLeft - rootLeft);
  const rightDistance = Math.max(0, rootRight - frameRight);
  const maxLeftOffset = Math.max(0, leftDistance - leftInset);
  const scrollbarWidth = Math.max(0, frameWidth + rightDistance - rightInset);

  return {
    leftDistance,
    maxLeftOffset,
    scrollbarWidth,
    rightDistance,
    maxViewportWidth: scrollbarWidth,
  };
}

// 计算虚拟滚动条的内容宽度、thumb 宽度与 thumb 左偏移。
// 三处短路都返回「thumb 占满整条」的退化态：槽宽为 0（未挂载）、
// 无可滚动距离（<=1 像素容差）、表格不比槽宽（无需滚动）。
// thumb 宽度按 track/table 比例缩放并夹到不超过 track；
// thumbLeft 先夹到 [0, maxThumbLeft] 再乘比例 —— 不先夹会让 scrollLeft 越界时
// thumb 冲出轨道右侧。
// Math.max(0, scrollLeft) 防止弹性滚动产生负值把 thumb 推出左边界。
export function resolveMarkdownTableVirtualScrollbarMetrics({
  scrollLeft,
  scrollMax,
  tableWidth,
  trackWidth,
}: {
  scrollLeft: number;
  scrollMax: number;
  tableWidth: number;
  trackWidth: number;
}): MarkdownTableVirtualScrollbarMetrics {
  const safeTableWidth = Math.max(0, tableWidth);
  // 三个 safe 前缀变量把所有除法分母收拢到非负，
  // 后面只做一次短路判断，不必每个公式各自防 NaN。
  const safeTrackWidth = Math.max(0, trackWidth);
  const safeScrollMax = Math.max(0, scrollMax);
  const contentWidth = Math.max(safeTrackWidth, safeTableWidth);

  if (safeTrackWidth <= 0 || safeScrollMax <= 1 || safeTableWidth <= safeTrackWidth) {
    return {
      contentWidth: safeTrackWidth,
      thumbLeft: 0,
      thumbWidth: safeTrackWidth,
    };
  }

  // thumb 宽度 = 槽宽平方 / 表格宽度，再夹到槽宽，
  // 保证表格宽度趋近槽宽时 thumb 平滑铺满而不是先超后裁。
  const thumbWidth = Math.min(
    safeTrackWidth,
    Math.max(0, safeTrackWidth * (safeTrackWidth / safeTableWidth)),
  );
  const maxThumbLeft = Math.max(0, safeTrackWidth - thumbWidth);
  const thumbLeft = Math.min(
    maxThumbLeft,
    Math.max(0, Math.max(0, scrollLeft) * (safeTrackWidth / safeTableWidth)),
  );

  return {
    contentWidth,
    thumbLeft,
    thumbWidth,
  };
}

// resolveMarkdownTableVirtualScrollMax 的返回值：tableWidth 减 trackWidth，负数归零。
// 注意这里没有 viewportLeftOffset 参数，这是 INV-04 的物理落点：
// 左借位只改变内容层的位置，不改变「还有多少内容可看」。
export function resolveMarkdownTableVirtualScrollMax({
  tableWidth,
  trackWidth,
}: {
  tableWidth: number;
  trackWidth: number;
}): number {
  return Math.max(0, tableWidth - trackWidth);
}

export type MarkdownTableProps = ComponentProps<"table"> & MarkdownTableNodeProp;

// 组件主体。状态分为三类，阅读时需要区分：
// 1) 镜像到 ref 的渲染态（edgeShadow/expanded/canToggle/宽度/offset/sticky/visible/thumb），
//    ref 供事件回调读取最新值，state 只负责触发重渲染；
// 2) 纯测量缓存（maxViewportLeftOffsetRef / virtualScrollTrackWidthRef / virtualScrollLeftRef），
//    不参与渲染，但必须跨帧保持；
// 3) 交互瞬时态（dragging / dragOffset），只在指针生命周期内有效。
// node: _node 是 react-markdown 注入的语法树节点，必须剥离，不能落到 table 属性上。
// 所有镜像 state 都只能通过 commitXxx 写入，直接 setXxx 会绕过幂等检查。
export function MarkdownTable({ className, children, node: _node, ...props }: MarkdownTableProps) {
  const { intl } = useZCodeIntl();
  // 全屏预览是纯展示态，不参与测量；打开时复用同一份 children，
  // 因此预览里的表格不会出现与正文不同的列宽契约。
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedScrollEnabled, setExpandedScrollEnabled] = useState(false);
  const [canToggleExpandedScroll, setCanToggleExpandedScroll] = useState(false);
  const [edgeShadowState, setEdgeShadowState] = useState<MarkdownTableEdgeShadowState>("none");
  const [viewportMaxWidth, setViewportMaxWidth] = useState<string>("100%");
  const [scrollbarWidth, setScrollbarWidth] = useState<string>("100%");
  const [viewportLeftOffset, setViewportLeftOffset] = useState(0);
  const [virtualScrollbarSticky, setVirtualScrollbarSticky] = useState(false);
  const [virtualScrollbarVisible, setVirtualScrollbarVisible] = useState(false);
  const [virtualScrollThumbStyle, setVirtualScrollThumbStyle] = useState<CSSProperties>({
    transform: "translateX(0px)",
    width: "100%",
  });
  // 镜像 ref 与 state 必须成对出现：ref 给回调读最新值，state 给渲染用。
  // 只加 state 会让滚动回调读到过期闭包，只加 ref 则不会重渲染。
  const edgeShadowStateRef = useRef<MarkdownTableEdgeShadowState>("none");
  const expandedScrollEnabledRef = useRef(expandedScrollEnabled);
  const canToggleExpandedScrollRef = useRef(canToggleExpandedScroll);
  const viewportMaxWidthRef = useRef(viewportMaxWidth);
  const scrollbarWidthRef = useRef(scrollbarWidth);
  const viewportLeftOffsetRef = useRef(viewportLeftOffset);
  const virtualScrollbarStickyRef = useRef(virtualScrollbarSticky);
  // 可见性 ref 只用于避免重复提交，不参与任何几何计算；
  // 把可见性当几何输入会让轨道挂载与槽宽互相影响，形成振荡。
  const virtualScrollbarVisibleRef = useRef(virtualScrollbarVisible);
  const maxViewportLeftOffsetRef = useRef(0);
  const virtualScrollTrackWidthRef = useRef(0);
  const virtualScrollLeftRef = useRef(0);
  const virtualScrollThumbLeftRef = useRef(0);
  const virtualScrollThumbStyleRef = useRef(virtualScrollThumbStyle);
  // 拖拽标记只允许在指针生命周期内为真：
  // pointercancel（来电、系统手势打断）也必须走同一条结束路径。
  const isVirtualScrollbarDraggingRef = useRef(false);
  const virtualScrollbarDragOffsetRef = useRef<number | null>(null);
  // 五个 DOM ref 的分工：root 是组件最外层（也是旧根回退值），
  // frame 是视觉边界，viewport 是真实滚动容器，track/table 分别用于 thumb 与宽度测量。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollbarWrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  // 阴影状态唯一写入口；值相同直接返回。
  // 滚动事件每帧都会调用它，不幂等会让每个 wheel 事件都触发一次重渲染，
  // 在长表 + 流式输出时会明显掉帧。
  const setNextEdgeShadowState = useCallback(
    (nextEdgeShadowState: MarkdownTableEdgeShadowState) => {
      if (edgeShadowStateRef.current === nextEdgeShadowState) {
        return;
      }

      edgeShadowStateRef.current = nextEdgeShadowState;
      setEdgeShadowState(nextEdgeShadowState);
    },
    [],
  );
  const commitExpandedScrollEnabled = useCallback((nextExpandedScrollEnabled: boolean) => {
    if (expandedScrollEnabledRef.current === nextExpandedScrollEnabled) {
      return;
    }

    expandedScrollEnabledRef.current = nextExpandedScrollEnabled;
    setExpandedScrollEnabled(nextExpandedScrollEnabled);
  }, []);
  const commitCanToggleExpandedScroll = useCallback((nextCanToggleExpandedScroll: boolean) => {
    if (canToggleExpandedScrollRef.current === nextCanToggleExpandedScroll) {
      return;
    }

    canToggleExpandedScrollRef.current = nextCanToggleExpandedScroll;
    setCanToggleExpandedScroll(nextCanToggleExpandedScroll);
  }, []);
  const commitViewportMaxWidth = useCallback((nextViewportMaxWidth: string) => {
    if (viewportMaxWidthRef.current === nextViewportMaxWidth) {
      return;
    }

    viewportMaxWidthRef.current = nextViewportMaxWidth;
    setViewportMaxWidth(nextViewportMaxWidth);
  }, []);
  const commitScrollbarWidth = useCallback((nextScrollbarWidth: string) => {
    if (scrollbarWidthRef.current === nextScrollbarWidth) {
      return;
    }

    scrollbarWidthRef.current = nextScrollbarWidth;
    setScrollbarWidth(nextScrollbarWidth);
  }, []);
  const commitViewportLeftOffset = useCallback((nextViewportLeftOffset: number) => {
    if (viewportLeftOffsetRef.current === nextViewportLeftOffset) {
      return;
    }

    viewportLeftOffsetRef.current = nextViewportLeftOffset;
    setViewportLeftOffset(nextViewportLeftOffset);
  }, []);
  const commitVirtualScrollbarSticky = useCallback((nextVirtualScrollbarSticky: boolean) => {
    if (virtualScrollbarStickyRef.current === nextVirtualScrollbarSticky) {
      return;
    }

    virtualScrollbarStickyRef.current = nextVirtualScrollbarSticky;
    setVirtualScrollbarSticky(nextVirtualScrollbarSticky);
  }, []);
  const commitVirtualScrollbarVisible = useCallback((nextVirtualScrollbarVisible: boolean) => {
    if (virtualScrollbarVisibleRef.current === nextVirtualScrollbarVisible) {
      return;
    }

    virtualScrollbarVisibleRef.current = nextVirtualScrollbarVisible;
    setVirtualScrollbarVisible(nextVirtualScrollbarVisible);
  }, []);
  const commitVirtualScrollThumbStyle = useCallback(
    (nextVirtualScrollThumbStyle: CSSProperties) => {
      const currentStyle = virtualScrollThumbStyleRef.current;
      if (
        currentStyle.width === nextVirtualScrollThumbStyle.width &&
        currentStyle.transform === nextVirtualScrollThumbStyle.transform
      ) {
        return;
      }

      virtualScrollThumbStyleRef.current = nextVirtualScrollThumbStyle;
      setVirtualScrollThumbStyle(nextVirtualScrollThumbStyle);
    },
    [],
  );
  // 表格宽度优先取 table 元素，元素缺失时退回 viewport.scrollWidth。
  // viewport.scrollWidth 在首帧可能含滚动条槽，是可接受的近似；
  // 但一旦 table 挂载就必须以 table 为准，否则 thumb 比例会随滚动跳变。
  const resolveTableWidth = useCallback((viewport: HTMLDivElement) => {
    return tableRef.current?.getBoundingClientRect().width ?? viewport.scrollWidth;
  }, []);
  // 布局槽宽只认缓存值，缓存为空才退回 viewport.clientWidth。
  // 这是 INV-05 的稳定侧：它不随 track 的挂载状态变化，
  // 因此可以安全地用于「是否 overflow」的判定。
  const resolveVirtualScrollLayoutWidth = useCallback((viewport: HTMLDivElement) => {
    return virtualScrollTrackWidthRef.current || viewport.clientWidth;
  }, []);
  // 渲染槽宽只用于 thumb 比例；拿不到真实宽度时退回布局槽宽。
  // 两个槽宽函数不能合并：合并后必然有一侧读到不稳定的值。
  const resolveRenderedVirtualScrollTrackWidth = useCallback(
    (viewport: HTMLDivElement) => {
      const trackWidth = virtualScrollTrackRef.current?.getBoundingClientRect().width ?? 0;
      if (trackWidth > 0) {
        return trackWidth;
      }

      return resolveVirtualScrollLayoutWidth(viewport);
    },
    [resolveVirtualScrollLayoutWidth],
  );
  const resolveVirtualScrollMax = useCallback(
    (viewport: HTMLDivElement) => {
      // 虚拟滚动的总距离只应由 table 标签本身宽度减去滚动条槽宽决定；
      // 之前混入 viewportLeftOffset 后，向左借位会改变最大值，导致 thumb 和内容滚动进度不一致。
      // 条件挂载后的 DOM track 会使用 CSS 宽度；若它与未挂载时保存的浮点布局宽度精度不同，
      // 可见性会在同一阈值两侧往返。是否 overflow 必须始终读取同一轮稳定的布局槽宽。
      return resolveMarkdownTableVirtualScrollMax({
        tableWidth: resolveTableWidth(viewport),
        trackWidth: resolveVirtualScrollLayoutWidth(viewport),
      });
    },
    [resolveTableWidth, resolveVirtualScrollLayoutWidth],
  );
  // 虚拟滚动位置的唯一写入口，承担三件事：
  // 1) 夹到 [0, virtualScrollMax]；
  // 2) 先让 leftOffset 消耗掉一部分距离（只在增强模式下有非零上限）；
  // 3) 把剩余量写进真实 viewport.scrollLeft。
  // 这样「向左借位」和「内容滚动」共享同一个进度轴，边界处不会互相覆盖。
  // viewport 不存在时把虚拟值清零并返回：此时没有 DOM 承接位置，
  // 保留旧值会在下次挂载时突然跳到旧位置。
  // 不要在调用后再手动改 viewport.scrollLeft：那会制造第二条写入路径，
  // scroll 事件回来时又会把虚拟值覆盖成旧进度。
  const commitVirtualScrollLeft = useCallback(
    (nextVirtualScrollLeft: number) => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        virtualScrollLeftRef.current = 0;
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const clampedVirtualScrollLeft = Math.min(
        Math.max(0, nextVirtualScrollLeft),
        virtualScrollMax,
      );
      const nextViewportLeftOffset = Math.min(
        clampedVirtualScrollLeft,
        maxViewportLeftOffsetRef.current,
      );
      const nextViewportScrollLeft = clampedVirtualScrollLeft - nextViewportLeftOffset;

      virtualScrollLeftRef.current = clampedVirtualScrollLeft;
      commitViewportLeftOffset(nextViewportLeftOffset);
      viewport.scrollLeft = nextViewportScrollLeft;
    },
    [commitViewportLeftOffset, resolveVirtualScrollMax],
  );
  // 把「DOM 实际滚动位置」同步回虚拟轨道，并在槽宽变化导致越界时立即回写。
  // 可见性只看 virtualScrollMax > 1，与 track 是否已挂载无关。
  // 反向依赖会形成振荡：槽宽变小 -> 位置越界 -> 卸载 track -> 槽宽恢复 -> 又挂载。
  // 越界时选择 commitVirtualScrollLeft 而不是就地赋值，是为了同时修正 offset 与真实 scrollLeft。
  // thumb 的宽度/位移用已挂载 track 的真实宽度，但「是否 overflow」用缓存槽宽 ——
  // 这正是 INV-05 的两个来源。
  const syncVirtualScrollMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollThumbStyle({
        transform: "translateX(0px)",
        width: "100%",
      });
      virtualScrollLeftRef.current = 0;
      virtualScrollThumbLeftRef.current = 0;
      return;
    }

    const virtualScrollMax = resolveVirtualScrollMax(viewport);
    // 虚拟滚动条只在表格宽度超过可视槽时有意义；小表格如果也渲染 pill，
    // 会误导用户以为还有横向内容可滚。
    commitVirtualScrollbarVisible(virtualScrollMax > 1);
    const nextVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    const clampedVirtualScrollLeft = Math.min(Math.max(0, nextVirtualScrollLeft), virtualScrollMax);
    if (clampedVirtualScrollLeft !== nextVirtualScrollLeft) {
      // 状态面板收起/展开或窗口 resize 会改变槽宽，旧的虚拟滚动位置可能越过新边界。
      // 这里立即回写统一入口，避免 thumb 到边界而内容还停在旧的 DOM scrollLeft。
      commitVirtualScrollLeft(clampedVirtualScrollLeft);
      return;
    }

    virtualScrollLeftRef.current = clampedVirtualScrollLeft;
    // 已渲染 track 的实际宽度只用于 thumb 比例和位置，不能反向决定 track 是否挂载。
    const virtualScrollViewportWidth = resolveRenderedVirtualScrollTrackWidth(viewport);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: clampedVirtualScrollLeft,
      scrollMax: virtualScrollMax,
      tableWidth: resolveTableWidth(viewport),
      trackWidth: virtualScrollViewportWidth,
    });
    commitVirtualScrollThumbStyle({
      transform: `translateX(${Math.round(metrics.thumbLeft)}px)`,
      width: `${Math.ceil(metrics.thumbWidth)}px`,
    });
    virtualScrollThumbLeftRef.current = metrics.thumbLeft;
  }, [
    commitVirtualScrollLeft,
    commitVirtualScrollbarVisible,
    commitVirtualScrollThumbStyle,
    resolveTableWidth,
    resolveVirtualScrollMax,
    resolveRenderedVirtualScrollTrackWidth,
  ]);
  // 核心测量函数：一次读取 root/frame/table 三方几何，算出宽度上限、槽宽、借位上限。
  // frame 缺失时的分支必须把所有派生状态清零，否则弹窗关闭后残留旧宽度，
  // 下次打开会先闪一帧错误布局。
  // expanded 分支只影响 maxLeftOffset / maxViewportWidth / scrollbarWidth 三个量，
  // canToggle 的判定始终使用未展开时的 baseline，保证「按钮存在性」与「是否已展开」解耦。
  // maxScrollbarWidth 用原值（不向上取整）写入缓存，
  // 而 CSS 宽度向上取整：两者相差 <1px，overflow 判定必须用前者，
  // 否则子像素场景会出现 track 每帧挂载/卸载并抖动 timeline 高度。
  // measure 末尾必须补一次 sync：宽度变化可能同时改变可见性与 thumb 比例。
  // 本函数在 ResizeObserver / MutationObserver / rAF / pointer 事件里共用，
  // 因此内部不得再注册任何观察者或 rAF。
  const measureViewportMaxWidth = useCallback(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      commitCanToggleExpandedScroll(false);
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollbarSticky(false);
      maxViewportLeftOffsetRef.current = 0;
      virtualScrollTrackWidthRef.current = 0;
      commitViewportLeftOffset(0);
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    let maxLeftOffset = 0;
    let maxViewportWidth = frameRect.width;
    let measuredScrollbarWidth = frameRect.width;
    let expandedMaxLeftOffset = 0;
    let expandedScrollbarWidth = frameRect.width;

    if (root) {
      const rootRect = root.getBoundingClientRect();
      // V4 的扩展边界是完整 timeline 视口而非居中的消息内容列；显式根节点
      // 通过 CSS 变量提供响应式安全边距，旧根节点继续保留原兼容规则。
      const { leftInset, rightInset } = getMarkdownTableRootInlineInsets(root);
      const measuredDistances = resolveMarkdownTableFrameDistances({
        frameWidth: frameRect.width,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        leftInset,
        rightInset,
      });
      expandedMaxLeftOffset = measuredDistances.maxLeftOffset;
      expandedScrollbarWidth = measuredDistances.scrollbarWidth;

      if (expandedScrollEnabledRef.current) {
        maxLeftOffset = measuredDistances.maxLeftOffset;
        maxViewportWidth = measuredDistances.maxViewportWidth;
        measuredScrollbarWidth = measuredDistances.scrollbarWidth;
      }
    }

    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
    const hasFrameHorizontalOverflow = tableWidth > frameRect.width + 1;
    const hasExpandedScrollBenefit =
      expandedScrollbarWidth > frameRect.width + 1 || expandedMaxLeftOffset > 1;
    // 开关只在普通 frame 宽度下确实横向溢出，并且增强模式能提供额外可视宽度或左借位时才有意义；
    // 已开启时仍保留按钮，让用户可以收回到普通滚动范围。
    commitCanToggleExpandedScroll(
      expandedScrollEnabledRef.current || (hasFrameHorizontalOverflow && hasExpandedScrollBenefit),
    );

    maxViewportLeftOffsetRef.current = maxLeftOffset;
    virtualScrollTrackWidthRef.current = measuredScrollbarWidth;
    commitViewportMaxWidth(`${Math.ceil(maxViewportWidth)}px`);
    // 向上取整会让已挂载 track 比用于 overflow 判断的槽宽最多多 1px，
    // 子像素 overflow 恰好靠近 1px 阈值时会导致 track 每帧挂载/卸载并扰动 timeline 高度。
    commitScrollbarWidth(`${measuredScrollbarWidth}px`);
    commitVirtualScrollbarSticky(
      shouldUseMarkdownTableStickyScrollbar({
        root,
        table: tableRef.current,
      }),
    );
    if (scrollViewportRef.current) {
      commitVirtualScrollLeft(virtualScrollLeftRef.current);
    } else {
      commitViewportLeftOffset(Math.min(viewportLeftOffsetRef.current, maxLeftOffset));
    }
    syncVirtualScrollMetrics();
  }, [
    commitScrollbarWidth,
    commitCanToggleExpandedScroll,
    commitVirtualScrollLeft,
    commitVirtualScrollbarSticky,
    commitVirtualScrollbarVisible,
    commitViewportLeftOffset,
    commitViewportMaxWidth,
    syncVirtualScrollMetrics,
  ]);

  // 阴影判定只读两样东西：虚拟总距离与真实 scrollLeft。
  // maxScrollLeft <= 1 时一律置 none，避免 1px 抖动导致阴影闪烁。
  // hasHiddenLeft 用真实 scrollLeft 而非虚拟值：左借位把内容整体左移后，
  // 虚拟值可能 > 0 但内容并没有被裁掉。
  // hasHiddenRight 用虚拟值：右侧是否还有内容取决于全局进度。
  // latestMeasureEdgeShadowStateRef 让旧的调用方总能拿到最新实现，
  // 避免把回调写进 Observer 依赖导致反复重建。
  const measureEdgeShadowState = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    // 这里必须用虚拟总距离而不是 viewport.scrollWidth - clientWidth：
    // 后者把左借位算进了可滚动量，会在增强模式下高估进度。
    const maxScrollLeft = resolveVirtualScrollMax(viewport);
    if (maxScrollLeft <= 1) {
      setNextEdgeShadowState("none");
      return;
    }

    // 虚拟位置 = 借位消耗 + 真实滚动，这是 INV-03 的读取侧。
    // 反向计算只允许出现在 commitVirtualScrollLeft 内部。
    const currentVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    // 向左借位只是把表格区域扩到左侧，不代表表格内容已经在滚动容器左边被遮住；
    // 左侧阴影只应该在真实内部 scrollLeft 产生后出现，右侧阴影继续按虚拟总进度判断。
    const hasHiddenLeft = viewport.scrollLeft > 1;
    const hasHiddenRight = currentVirtualScrollLeft < maxScrollLeft - 1;
    setNextEdgeShadowState(
      hasHiddenLeft && hasHiddenRight
        ? "both"
        : hasHiddenLeft
          ? "left"
          : hasHiddenRight
            ? "right"
            : "none",
    );
  }, [resolveVirtualScrollMax, setNextEdgeShadowState]);
  // 用 ref 转发最新回调，让 observer 的依赖数组保持为空。
  // 直接依赖 measureEdgeShadowState 会在每次渲染后重装 observer，
  // 流式输出时等于每 token 重建一次滚动监听。
  const latestMeasureEdgeShadowStateRef = useRef(measureEdgeShadowState);

  useEffect(() => {
    latestMeasureEdgeShadowStateRef.current = measureEdgeShadowState;
  });

  // 布局测量主循环（useLayoutEffect 保证在 paint 前完成首次测量，避免宽度跳动）。
  // 四个节点任一缺失即把宽度退回 100%：这是 SSR 首帧与弹窗未挂载时的正常路径，
  // 不要在这里报错或抛异常。
  // ResizeObserver 覆盖 root/frame/viewport/table 四个节点；
  // MutationObserver 只观察 root 的 style 属性 —— status panel 收起/展开只改
  // root 的 left/right，不会触发 ResizeObserver，需要 style 变化兜底。
  // watchRectChanges 的 800ms 轮询窗口用于覆盖布局动画：动画期间 rect 每帧变，
  // 只靠 observer 会在动画结束后停在中间值。
  // scheduleMeasure 用 rafId 合帧；cleanup 必须 cancel，否则卸载后写 state 报警告。
  // 依赖数组只放稳定回调，measureViewportMaxWidth 的变化本身不应重建循环。
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!root || !frame || !viewport || !table) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      return;
    }

    // 表格 viewport 需要先按内容自然宽度排布，再最多扩展到当前 frame 宽度
    // 加上右侧可借用空间；直接 w-full 会丢失小表格按内容收缩的布局语义。
    let rafId: number | null = null;
    let rectWatchRafId: number | null = null;
    let rectWatchUntil = 0;
    let latestRootRect = readMarkdownTableObservedRect(root);
    let latestFrameRect = readMarkdownTableObservedRect(frame);
    // scheduleMeasure 合帧：同一帧内多次调用只跑一次 requestAnimationFrame。
    // 执行前重新读 rect，因为回调排队期间布局可能已经变化。
    const scheduleMeasure = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestRootRect = readMarkdownTableObservedRect(root);
        latestFrameRect = readMarkdownTableObservedRect(frame);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      });
    };
    // rect 轮询是 ResizeObserver 的补丁，专门覆盖「尺寸没变但位置变了」的场景
    // （status panel 收起、侧栏宽度动画）。窗口结束后自行停止，不做常驻轮询。
    const watchRectChanges = () => {
      rectWatchRafId = null;
      const nextRootRect = readMarkdownTableObservedRect(root);
      const nextFrameRect = readMarkdownTableObservedRect(frame);
      const rectChanged =
        !isMarkdownTableObservedRectEqual(latestRootRect, nextRootRect) ||
        !isMarkdownTableObservedRectEqual(latestFrameRect, nextFrameRect);

      if (rectChanged) {
        // status panel 收起/展开可能只改变 chat root 的 left/right 位置，
        // ResizeObserver 不一定会触发；轮询 rect 签名能让左右借位和滚动槽宽跟随布局动画更新。
        latestRootRect = nextRootRect;
        latestFrameRect = nextFrameRect;
        scheduleMeasure();
      }

      if (performance.now() < rectWatchUntil) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    // 任何一次外部变更都同时「测一次 + 开一个 800ms 观察窗口」，
    // 窗口内保留单个 rAF 链，多个事件不会叠加出多条链。
    const scheduleMeasureAndWatchRect = () => {
      scheduleMeasure();
      rectWatchUntil = performance.now() + 800;
      if (rectWatchRafId === null) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    // MutationObserver 只关心 style 属性，且只挂在 root 上。
    // 观察整棵子树（childList）会在大表格流式渲染时产生大量回调，
    // 内容尺寸变化已由 ResizeObserver 覆盖。
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasureAndWatchRect);
    mutationObserver?.observe(root, {
      attributeFilter: ["style"],
      attributes: true,
    });

    measureViewportMaxWidth();
    scheduleMeasureAndWatchRect();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasureAndWatchRect);
      return () => {
        window.removeEventListener("resize", scheduleMeasureAndWatchRect);
        mutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
      };
    }

    // 四个 observe 目标缺一不可：root 管位置、frame 管宽度、viewport 管滚动槽、table 管内容宽度。
    // 少 observe 任一个都会出现「某类布局变化后不重测」的静默缺陷。
    const resizeObserver = new ResizeObserver(scheduleMeasureAndWatchRect);
    resizeObserver.observe(root);
    resizeObserver.observe(frame);
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", scheduleMeasureAndWatchRect);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasureAndWatchRect);
      mutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
    };
  }, [commitScrollbarWidth, commitViewportMaxWidth, measureViewportMaxWidth]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    // 滚动后要重算 viewportMaxWidth，因为左借位被消耗完的瞬间，
    // 内容层从 translateX 左移切换到真实滚动，calc 公式随之变化。
    const updateViewportLayout = () => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    };
    const updateEdgeShadowState = () => {
      syncVirtualScrollMetrics();
      latestMeasureEdgeShadowStateRef.current();
    };
    // 横向滚轮兼容三种输入：deltaX、Shift+deltaY、以及触控板自然横向滑动。
    // 只在确有可滚动距离时 preventDefault，否则页面纵向滚动会被表格吃掉。
    // 监听必须 passive:false 才能阻止默认行为。
    const handleWheel = (event: WheelEvent) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) {
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      if (virtualScrollMax <= 1) {
        return;
      }

      event.preventDefault();
      // 向左借位和表格内容滚动原来各自维护位置，边界处会互相覆盖导致无法回滚；
      // 现在统一用虚拟 scrollLeft 映射：先消耗 leftOffset，再把剩余量交给真实 viewport.scrollLeft。
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      updateViewportLayout();
    };

    // 性能修复：p12 trace 显示流式表格 children 变化会重建 observer 并同步读布局。
    // observer 生命周期只跟 DOM 节点绑定，内容变化交给 ResizeObserver 合并到下一帧测量。
    let rafId: number | null = null;
    // 内容变化走 rAF 合帧，避免流式表格每个 token 都同步读布局。
    // 这里刻意不复用 scheduleMeasure：阴影更新不需要重算宽度，成本更低。
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateEdgeShadowState();
      });
    };

    updateEdgeShadowState();
    viewport.addEventListener("scroll", updateEdgeShadowState, {
      passive: true,
    });
    viewport.addEventListener("wheel", handleWheel, { passive: false });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateEdgeShadowState);
        viewport.removeEventListener("wheel", handleWheel);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateEdgeShadowState);
      viewport.removeEventListener("wheel", handleWheel);
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    commitVirtualScrollLeft,
    measureViewportMaxWidth,
    resolveVirtualScrollMax,
    setNextEdgeShadowState,
    syncVirtualScrollMetrics,
  ]);

  // 吸底滚动条的纵向跟随（第二个 useLayoutEffect）。
  // virtualScrollbarSticky 为假时必须清空 transform：
  // 上一次 sticky 留下的 translateY 会残留到普通模式，把滚动条顶到表格外。
  // verticalViewport 找不到时直接返回，保留原始 transform 由 CSS 决定。
  // updateStickyOffset 每帧重新量 frame/viewport/dock/按钮四个高度，
  // 因为 composer 会随输入行数增长，缓存高度会在第二行输入时失效。
  // dockMutationObserver 观察整个 root 子树：draft/空态切换会替换 dock 节点，
  // 只观察初始节点会让新 dock 的增高铁不触发重算。
  // syncDockObservation 在节点未变时也要 schedule，因为 dock 内部按钮可能新增/移除。
  // cleanup 里 unobserve 由 disconnect 统一完成，但 transform 必须显式还原。
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const table = tableRef.current;
    const wrapper = virtualScrollbarWrapperRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame || !table || !wrapper || !virtualScrollbarSticky) {
      if (wrapper) wrapper.style.transform = "";
      return;
    }

    const verticalViewport = resolveMarkdownTableVerticalViewport(table, root);
    if (!verticalViewport) return;

    let rafId: number | null = null;
    let observedDock: HTMLElement | null = null;
    // 吸底补偿每帧重算四个量，其中 dock 与按钮高度是易变量。
    // offset 为 0 时写空串而不是 translateY(0px)：
    // 空串让元素回到自然位置，避免残留的 will-change/合成层影响 sticky 判定。
    const updateStickyOffset = () => {
      rafId = null;
      const frameRect = frame.getBoundingClientRect();
      const viewportRect = verticalViewport.getBoundingClientRect();
      const dockHeight = readMarkdownTableDockHeight(root);
      // 离底时“回到底部”按钮位于 composer dock 上方；只扣 dock 会让长表
      // sticky 滚动条与按钮占用同一条水平带，导致按钮被宽滚动槽遮挡。
      const backToBottomClearance = readMarkdownTableBackToBottomClearance(root);
      const offset = resolveMarkdownTableStickyScrollbarOffset({
        frameTop: frameRect.top,
        frameBottom: frameRect.bottom,
        scrollbarHeight: wrapper.getBoundingClientRect().height,
        viewportBottom: viewportRect.bottom - dockHeight - backToBottomClearance,
      });
      wrapper.style.transform = offset === 0 ? "" : `translateY(${Math.round(offset)}px)`;
    };
    const scheduleStickyOffset = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateStickyOffset);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleStickyOffset);
    // dock 节点被替换时必须先 unobserve 旧节点再 observe 新节点，
    // 只 observe 不 unobserve 会持续持有已卸载节点的引用。
    // 节点未变时也要 schedule：dock 内部按钮的挂载不会改变 dock 引用。
    const syncDockObservation = () => {
      const nextDock =
        root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR) ?? null;
      // MutationObserver 也负责感知 dock 内回到底部按钮的挂载/卸载；即使 dock
      // 节点本身未变化也必须安排一次几何更新。
      if (nextDock === observedDock) {
        scheduleStickyOffset();
        return;
      }
      if (observedDock) resizeObserver?.unobserve(observedDock);
      observedDock = nextDock;
      if (observedDock) resizeObserver?.observe(observedDock);
      scheduleStickyOffset();
    };

    // V4 virtual row 使用 transform 定位，原生 sticky 会被 transformed ancestor
    // 限制在自然位置。改为跟随 timeline scroll 计算纵向补偿，且仍受当前表格上下边界约束。
    updateStickyOffset();
    verticalViewport.addEventListener("scroll", scheduleStickyOffset, { passive: true });
    window.addEventListener("resize", scheduleStickyOffset);
    resizeObserver?.observe(frame);
    resizeObserver?.observe(verticalViewport);
    syncDockObservation();
    // draft/空态切换会条件挂载或替换 V4 composer dock；只观察初始节点会让
    // 新 dock 的输入增高不再触发吸底重算，因此同时跟踪根节点的子树变化并重新绑定。
    // dock 子树观察只在 sticky 模式下建立，普通模式没有 dock 依赖，
    // 为此常驻一个 subtree observer 会白白增加流式渲染开销。
    const dockMutationObserver =
      typeof MutationObserver === "undefined" || !root
        ? null
        : new MutationObserver(syncDockObservation);
    if (dockMutationObserver && root) {
      dockMutationObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      verticalViewport.removeEventListener("scroll", scheduleStickyOffset);
      window.removeEventListener("resize", scheduleStickyOffset);
      resizeObserver?.disconnect();
      dockMutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      wrapper.style.transform = "";
    };
  }, [virtualScrollbarSticky, virtualScrollbarVisible]);

  // 读取函数依赖为空是刻意的：它只经 ref 访问 DOM，
  // 因此复制/下载回调不会因为渲染态变化而失效。
  const getRows = useCallback(() => readRowsFromTable(tableRef.current), []);
  // 把指针 X 坐标换算成虚拟滚动位置：先由 thumb 尺寸求可动范围，
  // 再由 nextThumbLeft / maxThumbLeft 反推进度。
  // maxThumbLeft <= 0（thumb 占满轨道）时进度恒为 0，不做除法以免 NaN。
  // thumbDragOffset 为 null 表示「点在 track 上」，此时以点击点为 thumb 中心；
  // 非 null 表示拖拽 thumb，保持按下时的相对偏移才不会跳动。
  // 换算后立即重新测量：滚动可能改变阴影和可见性，但不会改变宽度，
  // 之所以仍调 measure，是为了覆盖「弹窗刚展开、宽度尚未稳定」的场景。
  const commitVirtualScrollLeftFromClientX = useCallback(
    (clientX: number, thumbDragOffset: number | null = null) => {
      const track = virtualScrollTrackRef.current;
      const viewport = scrollViewportRef.current;
      if (!track || !viewport) return;

      const trackRect = track.getBoundingClientRect();
      const trackWidth = trackRect.width;
      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
        scrollLeft: virtualScrollLeftRef.current,
        scrollMax: virtualScrollMax,
        tableWidth: resolveTableWidth(viewport),
        trackWidth,
      });
      const maxThumbLeft = Math.max(0, trackWidth - metrics.thumbWidth);
      const rawThumbLeft =
        thumbDragOffset === null
          ? clientX - trackRect.left - metrics.thumbWidth / 2
          : clientX - trackRect.left - thumbDragOffset;
      const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, rawThumbLeft));
      const nextVirtualScrollLeft =
        maxThumbLeft <= 0 ? 0 : (nextThumbLeft / maxThumbLeft) * virtualScrollMax;

      commitVirtualScrollLeft(nextVirtualScrollLeft);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveTableWidth, resolveVirtualScrollMax],
  );
  // 按在 track 空白处：立即把 thumb 中心移到指针位置。
  // dragOffset 置 null 是「本次不是拖 thumb」的信号，供 move 阶段区分语义。
  const handleVirtualScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = true;
      virtualScrollbarDragOffsetRef.current = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      commitVirtualScrollLeftFromClientX(event.clientX);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = false;
      virtualScrollbarDragOffsetRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  // 按住 thumb 时不做位置跳转，只记录抓取点。
  // stopPropagation 必须保留：thumb 是 track 的子节点，冒泡会触发 track 的
  // 「点击居中」逻辑，导致刚按下 thumb 就跳到指针位置。
  // dragOffset 夹到 >= 0：指针可能落在 thumb 左侧 padding 外（触摸误差），
  // 负偏移会在后续换算里把 thumb 推过左边界。
  // pointer capture 放在 thumb 自己身上，这样移出轨道仍能收到 move/up。
  const handleVirtualScrollbarThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const track = virtualScrollTrackRef.current;
      if (!track) return;

      const trackRect = track.getBoundingClientRect();
      isVirtualScrollbarDraggingRef.current = true;
      // thumb 是 track 的子元素，按住 thumb 时不能冒泡到 track 的点击跳转逻辑；
      // 记录指针在 thumb 内的位置，拖动时保持这个相对偏移，避免 thumb 突然居中跳动。
      virtualScrollbarDragOffsetRef.current = Math.max(
        0,
        event.clientX - trackRect.left - virtualScrollThumbLeftRef.current,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarThumbPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handleVirtualScrollbarPointerEnd(event);
    },
    [handleVirtualScrollbarPointerEnd],
  );
  // 滚动条自身的 wheel 与 viewport 的 wheel 必须行为一致，
  // 否则指针从表格移到滚动条上时滚动会突然失效。
  const handleVirtualScrollbarWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) return;

      const viewport = scrollViewportRef.current;
      if (!viewport || resolveVirtualScrollMax(viewport) <= 1) return;

      event.preventDefault();
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveVirtualScrollMax],
  );

  // 复制 Markdown：先检查 navigator.clipboard 能力，再写剪贴板。
  // 能力缺失与写入失败都必须 toast，不能静默 —— 用户会反复点击。
  // 错误信息只透出 message，不经由模板拼 URL 或表格内容，避免把正文带进提示。
  // 依赖 getRows 与 intl；getRows 内部只读 DOM，因此不会因为渲染态变化而失效。
  const handleCopyMarkdown = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "markdownTable.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(buildMarkdownTableText(getRows()));
      toast(intl.formatMessage({ id: "markdownTable.copySucceeded" }));
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "markdownTable.copyFailed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }, [getRows, intl]);

  // CSV 下载走 Blob + 临时 a 标签；三个能力任一缺失都提前失败并提示。
  // 文件名固定 table.csv：表格没有可靠标题，用内容推断反而产生奇怪文件名。
  // link.remove() 与 revokeObjectURL 必须都执行：只 remove 会泄漏 blob URL，
  // 只 revoke 会在部分浏览器里让下载被取消。
  // revoke 放在 click 之后同步调用是安全的，下载已开始读取引用。
  const handleDownloadCsv = useCallback(() => {
    if (
      typeof document === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      toast(intl.formatMessage({ id: "markdownTable.downloadFailed" }));
      return;
    }

    const blob = new Blob([buildCsvTableText(getRows())], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [getRows, intl]);
  // 增强滚动的开关。关闭方向有额外收尾：先把借位上限清零，
  // 再把虚拟位置重新映射回真实 scrollLeft。
  // 顺序不能反：先映射会按旧上限继续扣减 offset，用户会看到内容回跳。
  // requestAnimationFrame 里再测量一次，因为宽度变化要等下一帧布局才能读到。
  // 不要在这里直接改 maxViewportWidth：统一交给 measure，避免两处维护同一公式。
  const handleToggleExpandedScroll = useCallback(() => {
    const nextExpandedScrollEnabled = !expandedScrollEnabledRef.current;
    commitExpandedScrollEnabled(nextExpandedScrollEnabled);

    if (!nextExpandedScrollEnabled) {
      maxViewportLeftOffsetRef.current = 0;
      commitViewportLeftOffset(0);
      const viewport = scrollViewportRef.current;
      if (viewport) {
        // 从增强模式收回普通模式时，既有的虚拟滚动位置可能被左借位消耗；
        // 先清掉 leftOffset 再把同一个虚拟 scrollLeft 映射回真实 scrollLeft，避免表格内容跳回开头。
        viewport.scrollLeft = virtualScrollLeftRef.current;
      }
    }

    requestAnimationFrame(() => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    });
  }, [commitExpandedScrollEnabled, commitViewportLeftOffset, measureViewportMaxWidth]);

  const copyLabel = intl.formatMessage({ id: "markdownTable.copyMarkdown" });
  const downloadLabel = intl.formatMessage({ id: "markdownTable.downloadCsv" });
  const previewLabel = intl.formatMessage({ id: "markdownTable.openPreview" });
  const scrollModeLabel = intl.formatMessage({
    id: expandedScrollEnabled
      ? "markdownTable.collapseScrollMode"
      : "markdownTable.expandScrollMode",
  });
  const previewTitle = intl.formatMessage({ id: "markdownTable.previewTitle" });
  const previewDescription = intl.formatMessage({
    id: "markdownTable.previewDescription",
  });
  // viewportMaxWidth 是虚拟滚动槽宽，用来计算 virtualScrollMax 和 thumb；
  // 内容层本身会 translateX 向左借位，所以需要把借出去的宽度补回右侧，避免视觉右边界跟着左移。
  // 内容层宽度 = viewportMaxWidth + ceil(viewportLeftOffset)，即槽宽加已借出的左移量。
  // 内容层通过 translateX(-offset) 左移，右边界也随之左移；
  // 补回 offset 才能让视觉右边界与滚动槽对齐，否则表格右侧会露出一条空隙。
  // 用 calc 而不是数值相加，是为了让 viewportMaxWidth 仍以字符串形式参与 CSS 过渡。
  const contentViewportMaxWidth =
    viewportLeftOffset > 0
      ? `calc(${viewportMaxWidth} + ${Math.ceil(viewportLeftOffset)}px)`
      : viewportMaxWidth;

  return (
    <div ref={rootRef} className="my-0 flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-end gap-1" data-markdown-table-toolbar="">
        <MarkdownTableActionButton
          label={copyLabel}
          onClick={() => {
            void handleCopyMarkdown();
          }}
        >
          <CopyIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={downloadLabel} onClick={handleDownloadCsv}>
          <DownloadIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={previewLabel} onClick={() => setPreviewOpen(true)}>
          <Maximize2Icon className="size-3.5" />
        </MarkdownTableActionButton>
        {canToggleExpandedScroll ? (
          <MarkdownTableActionButton label={scrollModeLabel} onClick={handleToggleExpandedScroll}>
            {expandedScrollEnabled ? (
              <ArrowLeftFromLine className="size-3.5" />
            ) : (
              <ArrowRightToLine className="size-3.5" />
            )}
          </MarkdownTableActionButton>
        ) : null}
      </div>
      <div
        ref={frameRef}
        className="group/markdown-table-frame relative w-full"
        data-markdown-table-frame=""
        data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
      >
        <div
          className={cn(
            "min-w-full w-max",
            viewportLeftOffset <= 0 &&
              "transition-[max-width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={{
            maxWidth: contentViewportMaxWidth,
            transform: viewportLeftOffset > 0 ? `translateX(-${viewportLeftOffset}px)` : undefined,
          }}
        >
          <div
            // 表格已有边缘阴影提示横向溢出，显示系统滚动条会在消息块底部产生额外视觉噪音；
            // 外层宽度容器按 frame 宽度 + rightDistance 计算最大宽度，滚动 viewport 只占满该容器。
            className="relative w-full overflow-hidden rounded-xl border border-border"
          >
            <div
              ref={scrollViewportRef}
              className="!scrollbar-hide w-full overflow-x-auto overflow-y-visible"
            >
              <table
                ref={tableRef}
                className={cn(
                  "w-max min-w-full border-separate border-spacing-0 text-ui-base",
                  className,
                )}
                {...props}
                data-streamdown="table"
              >
                {children}
              </table>
            </div>
            <MarkdownTableEdgeShadow side="left" state={edgeShadowState} />
            <MarkdownTableEdgeShadow side="right" state={edgeShadowState} />
          </div>
        </div>
        <div
          ref={virtualScrollbarWrapperRef}
          aria-hidden={!virtualScrollbarVisible}
          // V4 transformed virtual row 下 sticky 由 relative + translateY 模拟，
          // computed position 不能表达产品语义；显式状态供跨实现的 E2E 与可访问性诊断读取。
          data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
          data-markdown-table-virtual-scroll-visible={virtualScrollbarVisible ? "true" : "false"}
          // 滚动条槽宽必须等于 frameRect.width + rightDistance 再扣掉消息列响应式右 padding；
          // 长表格需要在纵向阅读时也能横向滚动，sticky 底部要避让 composer 和底部面板。
          // overflow 测量变化时只切换可见性，保留节点和纵向占位，避免扰动 timeline 高度。
          style={{ width: scrollbarWidth }}
          className={cn(
            "pointer-events-none py-1 opacity-0 transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
            virtualScrollbarVisible
              ? "visible group-hover/markdown-table-frame:pointer-events-auto group-hover/markdown-table-frame:opacity-100"
              : "invisible",
            virtualScrollbarSticky && "relative z-20",
          )}
        >
          <div
            ref={virtualScrollTrackRef}
            aria-hidden="true"
            className="mt-1 h-3.5 w-full touch-none rounded-full bg-foreground/3"
            data-markdown-table-virtual-scroll-track=""
            onPointerCancel={handleVirtualScrollbarPointerEnd}
            onPointerDown={handleVirtualScrollbarPointerDown}
            onPointerMove={handleVirtualScrollbarPointerMove}
            onPointerUp={handleVirtualScrollbarPointerEnd}
            onWheel={handleVirtualScrollbarWheel}
          >
            <div
              className="h-3 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40"
              onPointerCancel={handleVirtualScrollbarThumbPointerEnd}
              onPointerDown={handleVirtualScrollbarThumbPointerDown}
              onPointerMove={handleVirtualScrollbarThumbPointerMove}
              onPointerUp={handleVirtualScrollbarThumbPointerEnd}
              style={virtualScrollThumbStyle}
            />
          </div>
        </div>
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-max max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-2xl p-4 sm:max-h-[calc(100vh-8rem)] sm:max-w-[calc(100vw-8rem)] md:min-w-[640px] lg:min-w-[720px]">
          <DialogHeader className="pr-8">
            <DialogTitle>{previewTitle}</DialogTitle>
            <DialogDescription>{previewDescription}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto rounded-xl border border-border bg-background">
            <table
              className={cn(
                "w-max min-w-full border-separate border-spacing-0 text-ui-base [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background",
                className,
              )}
              {...props}
              data-streamdown="table-preview"
            >
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MarkdownTableEdgeShadow({
  side,
  state,
}: {
  side: "left" | "right";
  state: MarkdownTableEdgeShadowState;
}) {
  const visible = state === side || state === "both";
  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-6",
        side === "left"
          ? "left-0 rounded-l-xl shadow-[inset_12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
          : "right-0 rounded-r-xl shadow-[inset_-12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]",
      )}
      data-markdown-table-edge-shadow={side}
    />
  );
}

function MarkdownTableActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <Button type="button" variant="ghost" size="icon-md" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

export type MarkdownTableHeaderProps = ComponentProps<"thead"> & MarkdownTableNodeProp;

// 表头/表体/行/单元格都是薄包装：只剥离 node，再追加类名。
// 不要在这里做任何布局测量或状态，否则每个单元格都会创建一次 observer。
export function MarkdownTableHeader({
  className,
  node: _node,
  ...props
}: MarkdownTableHeaderProps) {
  return <thead className={cn("", className)} {...props} />;
}

export type MarkdownTableBodyProps = ComponentProps<"tbody"> & MarkdownTableNodeProp;

export function MarkdownTableBody({ className, node: _node, ...props }: MarkdownTableBodyProps) {
  return <tbody className={cn("", className)} {...props} />;
}

export type MarkdownTableRowProps = ComponentProps<"tr"> & MarkdownTableNodeProp;

export function MarkdownTableRow({ className, node: _node, ...props }: MarkdownTableRowProps) {
  return (
    <tr
      className={cn("transition-colors last:[&>td]:border-b-0 hover:bg-hover/20", className)}
      {...props}
    />
  );
}

export type MarkdownTableHeadProps = ComponentProps<"th"> & MarkdownTableNodeProp;

export function MarkdownTableHead({ className, node: _node, ...props }: MarkdownTableHeadProps) {
  return (
    <th
      className={cn(
        "border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export type MarkdownTableCellProps = ComponentProps<"td"> & MarkdownTableNodeProp;

// min-w-16 + max-w-md + break-words 是表格可读性的下限契约：
// 去掉 max-w 会让一列长文本把整表撑到不可滚动，去掉 min-w 会让短列塌成竖排。
export function MarkdownTableCell({ className, node: _node, ...props }: MarkdownTableCellProps) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}
