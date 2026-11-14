// INV-01 四种行映射四类内容：守住位置 contentTypeForRow；改错故障 引用类型与来源不符。
// INV-02 未知行不可引用：守住位置 末尾返回空；改错故障 系统行被选中。
// INV-03 文本节点先取父元素：守住位置 closestRowElement；改错故障 选区端点找不到行。
// INV-04 行标识来自数据集：守住位置 最近祖先；改错故障 跨行选择定位错误。
// INV-05 行集合引用常新：守住位置 rowsRef；改错故障 回调读到旧行。
// INV-06 关闭时不做检查：守住位置 enabled；改错故障 关闭后仍弹菜单。
// INV-07 折叠选区不处理：守住位置 isCollapsed；改错故障 光标点击弹出菜单。
// INV-08 只接受单一范围：守住位置 rangeCount；改错故障 多段选择位置错乱。
// INV-09 控件端点先排除：守住位置 端点判断；改错故障 表格工具按钮参与引用。
// INV-10 可选区域必须同段：守住位置 sameSelectableRegion；改错故障 跨区块引用不完整。
// INV-11 同行是硬条件：守住位置 sameRow；改错故障 跨行文本被拼接。
// INV-12 内容类型必须受支持：守住位置 supportedContent；改错故障 未知内容生成引用。
// INV-13 文本非空才继续：守住位置 text；改错故障 空引用进入菜单。
// INV-14 布局尺寸必须为正：守住位置 hasLayout；改错故障 零尺寸时菜单飘到角落。
// INV-15 单行超限返回错误态：守住位置 single-limit；改错故障 超限内容仍可引用。
// INV-16 引用对象集中构造：守住位置 createConversationSelectionReference；改错故障 字段散落易漏。
// INV-17 会话标识随选择写入：守住位置 sourceSessionId；改错故障 引用指向错误会话。
// INV-18 菜单动作后立即关闭：守住位置 close；改错故障 菜单停留遮挡内容。
//
// 模块职责：检测对话文本选区并弹出引用动作菜单。
// 状态所有权：选区事实来自浏览器；菜单可见性归 useTextSelection。
// 阅读顺序：先看行与内容映射，再看选区门禁，最后看引用构造与菜单渲染。
import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import { useTextSelection } from "@/hooks/useTextSelection.js";
import { useCallback, useRef, type RefObject } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createConversationSelectionReference,
  type ConversationSelectionContentType,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";
import {
  guardConversationSelectionCandidate,
  hasExcludedConversationSelectionEndpoint,
} from "@/lib/conversationSelectionGuard.js";

interface TooltipState {
  center: number;
  bottom: number;
  top: number;
  reference?: ConversationSelectionReference;
  error?: "single";
}

const SELECTABLE_SELECTOR = "[data-conversation-selectable]";

// contentTypeForRow 把 userInput/assistantText/reasoning/toolCall 映射成四类内容。
// toolCall 也算可选内容，与正文一样能生成引用。
// 其他 kind 返回 null，不允许引用。
function contentTypeForRow(row: ConversationRow): ConversationSelectionContentType | null {
  if (row.kind === "userInput") return "user";
  if (row.kind === "assistantText") return "assistant";
  if (row.kind === "reasoning") return "reasoning";
  if (row.kind === "toolCall") return "tool";
  return null;
}

// closestRowElement 对文本节点先取 parentElement。
// 再沿 [data-row-id] 向上 closest。
// 没有命中行标识时返回 null。
function closestRowElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-row-id]") ?? null;
}

export function ConversationSelectionTooltip({
  rootRef,
  rows,
  sourceSessionId,
  enabled,
  sideActionDisabled,
  onAddToCurrentTask,
  onAskInSideChat,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  rows: readonly ConversationRow[];
  sourceSessionId: string;
  enabled: boolean;
  sideActionDisabled?: boolean;
  onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
  onAskInSideChat: (reference: ConversationSelectionReference) => void;
}) {
  const { intl } = useZCodeIntl();
  // rowsRef 持有最新 rows，供事件回调读取。
  // 每次渲染直接赋 current，不放进 effect。
  // inspectSelection 读 rowsRef，不捕获旧闭包。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // enabled 为假时 inspectSelection 直接返回 null。
  // selection.isCollapsed 为真时直接返回 null。
  // selection.rangeCount 不等于 1 时同样返回 null。
  // inspectSelection 的结果同时供定位与 guardConversationSelectionCandidate 使用。
  const inspectSelection = useCallback((): TooltipState | null => {
    if (!enabled) return null;
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const startRow = closestRowElement(range.startContainer);
    const endRow = closestRowElement(range.endContainer);
    if (!startRow || !endRow) return null;
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    // 普通 Markdown 跨选到表格单元格时，Range.cloneContents() 会把 DOM 顺序中夹着的
    // select-none 表格工具栏按钮一并克隆，若据此判断会把合法正文误判为控件选区。控件门禁只看
    // Selection 两个端点；跨 row / selectable region 仍由下面的独立 guard 拒绝。
    const excluded = hasExcludedConversationSelectionEndpoint(startElement, endElement);
    const startContent = startElement?.closest(SELECTABLE_SELECTOR);
    const endContent = endElement?.closest(SELECTABLE_SELECTOR);
    const rowId = Number(startRow.dataset.rowId);
    const row = rowsRef.current.find((candidate) => candidate.rowId === rowId);
    const contentType = row ? contentTypeForRow(row) : null;
    const text = selection.toString().trim();
    const rect = range.getBoundingClientRect();
    // guardConversationSelectionCandidate 要求 sameRow、insideTimeline 与 sameSelectableRegion 同时成立。
    // excluded 先由 hasExcludedConversationSelectionEndpoint 判定，命中即 ineligible。
    // supportedContent 要求 contentType 非空，hasLayout 要求 rect 宽高至少一项大于 0。
    // guardResult 为 "ineligible" 时提前返回，不生成 tooltip 状态。
    const guardResult = guardConversationSelectionCandidate({
      enabled,
      sameRow: startRow === endRow,
      insideTimeline: root.contains(startRow),
      excluded,
      sameSelectableRegion: Boolean(
        startContent && startContent === endContent && startRow.contains(startContent),
      ),
      supportedContent: contentType !== null,
      text,
      hasLayout: rect.width > 0 || rect.height > 0,
    });
    if (guardResult === "ineligible" || !contentType) return null;
    const position = {
      center: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (guardResult === "single-limit") {
      return { ...position, error: "single" };
    }
    return {
      ...position,
      reference: createConversationSelectionReference({
        sourceSessionId,
        sourceRowId: rowId,
        contentType,
        text,
      }),
    };
  }, [enabled, rootRef, sourceSessionId]);
  const { state, close } = useTextSelection({
    rootRef,
    enabled,
    inspect: inspectSelection,
    scopeKey: sourceSessionId,
  });

  if (!state) return null;
  return (
    <SelectionActionMenu
      center={state.center}
      top={state.top}
      bottom={state.bottom}
      singleLimit={Boolean(state.error)}
      sideActionDisabled={sideActionDisabled}
      sideDisabledTitle={intl.formatMessage({ id: "chat.selections.sideBlocked" })}
      onAddToCurrentTask={() => {
        if (state.reference) onAddToCurrentTask(state.reference);
        close();
      }}
      onAskInSideChat={() => {
        if (state.reference) onAskInSideChat(state.reference);
        close();
      }}
    />
  );
}
