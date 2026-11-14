// 输入面板（L2）：受控草稿 textarea + 底部 composer 状态行。
// 状态所有权：草稿值由父层持有，本组件只做"受控同步"与输入事件上抛，不存业务状态。
// 自增的 resetCursorToEndVersion 用于强制把光标/视口复位到末尾（历史回溯/提及补全后使用）。
// OpenTUI 的 textarea 实例可能被 keyed remount 替换，因此共享 editorRef 在每次 ref 回调时重新指向。
import type { TextareaRenderable } from "@mbears/opentui-core";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { InputComposerStatus } from "./app-input-status.js";
import { wordWrappedLineCount } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 编辑器高度口径（单位：终端行）：默认/最小 2 行，最大 6 行，超出部分由 textarea 内部滚动。
// INPUT_FRAME_CHROME_ROWS 是边框+标题占用；INPUT_PANE_STATUS_ROWS 是底部状态行；两者合计为面板 chrome。
// 宽度常量单位为显示列：缺失/非法回退 80，最小 8 列；水平 chrome 用于给状态行收窄宽度。
export const INPUT_DEFAULT_EDITOR_ROWS = 2;
// 最小可见行数，与默认行数同值，保证空面板启动时不会比默认更矮。
// 下调会连带压缩 INPUT_PANE_MIN_HEIGHT 的布局下限，需同步检查父层预留空间。
export const INPUT_MIN_EDITOR_ROWS = INPUT_DEFAULT_EDITOR_ROWS;
// 编辑区高度上限，超出部分由 textarea 内部滚动；与 INPUT_PANE_MAX_HEIGHT 的预留空间联动。
// 调整时必须同步检查 textarea 样式里的 maxHeight，两处不一致会导致裁切或留白。
export const INPUT_MAX_EDITOR_ROWS = 6;
const INPUT_FRAME_CHROME_ROWS = 3;
// 底部 composer 状态行固定占 1 行，计入 INPUT_CHROME_ROWS 的固定开销。
// 若改成多行，必须同步更新状态行组件自身的行高与面板总高度预算。
export const INPUT_PANE_STATUS_ROWS = 1;
const INPUT_CHROME_ROWS = INPUT_FRAME_CHROME_ROWS + INPUT_PANE_STATUS_ROWS;
const INPUT_CONTENT_FALLBACK_WIDTH = 80;
const INPUT_MIN_CONTENT_WIDTH = 8;
const INPUT_PANE_HORIZONTAL_CHROME_WIDTH = 4;

// 面板总高度上下限（编辑器行数 + chrome），供父层布局计算剩余空间。
export const INPUT_PANE_MIN_HEIGHT = INPUT_MIN_EDITOR_ROWS + INPUT_CHROME_ROWS;
// 单位终端行，等于最大编辑器行数加固定 chrome；父层按此上限预留垂直空间。
// 与 INPUT_PANE_MIN_HEIGHT 成对使用，是两个独立导出常量，不要在调用点重复相加。
export const INPUT_PANE_MAX_HEIGHT = INPUT_MAX_EDITOR_ROWS + INPUT_CHROME_ROWS;
// 边框开关与圆角样式；抽成常量便于统一外观（各平台终端渲染能力不同，只改这里）。
export const INPUT_PANE_BORDER = true;
// OpenTUI 圆角边框名；仅影响外观，不改变 chrome 行数与水平 padding 预算。
export const INPUT_PANE_BORDER_STYLE = "rounded";
// 弹性占位：把状态行推到面板底部；minHeight 固定 0，防止窄终端下额外撑高输入区。
export const INPUT_PANE_STATUS_SPACER_STYLE = {
  flexGrow: 1,
  minHeight: 0,
} as const;

// 键位绑定：裸 Enter/LF 提交，Shift+Enter/LF 换行（action: newline）；顺序即匹配优先级。
export const PROMPT_TEXTAREA_KEY_BINDINGS = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
] as const;

// 从 OpenTUI TextareaRenderable 抽出的最小编辑器契约，供历史/提及/粘贴等模块跨组件使用。
// 只暴露光标、行列删除、focus、纯文本读写；新增能力需同步维护这里的 Pick 列表，避免上层依赖内部实现。
export type PromptInputEditor = Pick<
  TextareaRenderable,
  | "cursorOffset"
  | "deleteRange"
  | "focus"
  | "focused"
  | "gotoBufferEnd"
  | "insertText"
  | "logicalCursor"
  | "plainText"
  | "setText"
>;

// 受控同步所需的最小能力集合（syncTextareaValue 只用到这三个方法）。
type DraftTextarea = Pick<PromptInputEditor, "gotoBufferEnd" | "plainText" | "setText">;

// 渲染输入面板。value 为受控草稿（由父层持有），onInput 只在"用户真正改动"时回调；
// onSubmit 取 textarea 当前文本（编辑器缺失时退回 value），保证提交内容与屏幕一致。
// editorRef 可选：传入时把实时 textarea 实例共享给提及/历史/粘贴等 hook。
// busy 只影响占位文案，不禁用输入（流式期间仍可排队 followup）。
export function InputPane({
  busy,
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  focused,
  mode,
  model,
  onInput,
  onSubmit,
  editorRef,
  resetCursorToEndVersion,
  thoughtLevel,
  value,
}: {
  busy: boolean;
  contentWidth?: number;
  copy?: TuiCopy;
  editorRef?: React.MutableRefObject<PromptInputEditor | null>;
  focused: boolean;
  mode?: string;
  model: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  resetCursorToEndVersion: number;
  thoughtLevel: string;
  value: string;
}): React.ReactElement {
  const textareaRef = React.useRef<TextareaRenderable | null>(null);
  const appliedCursorToEndVersionRef = React.useRef(0);
  const syncingValueRef = React.useRef(false);
  const editorRows = inputPaneEditorRows(value, contentWidth);

  const setTextareaRef = React.useCallback(
    (textarea: TextareaRenderable | null) => {
      textareaRef.current = textarea;
      if (editorRef) {
        // OpenTUI destroys the previous EditorView during keyed remounts; keep
        // the shared prompt editor ref aligned with the live textarea instance.
        editorRef.current = textarea;
      }
    },
    [editorRef],
  );

  React.useLayoutEffect(() => {
    if (!editorRef) return undefined;
    editorRef.current = textareaRef.current;
    return () => {
      editorRef.current = null;
    };
  }, [editorRef]);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // syncing 标记是必需的：setText 会在同一提交帧触发 onContentChange，
    // 不屏蔽就会把"父层写值"误判为用户输入（并中断历史回溯态）。
    syncingValueRef.current = true;
    try {
      syncTextareaValue(textarea, value);
    } finally {
      syncingValueRef.current = false;
    }
  }, [value]);

  React.useLayoutEffect(() => {
    if (resetCursorToEndVersion <= 0) return;
    // 版本号去重：同一版本只处理一次，避免渲染循环里反复 gotoBufferEnd 抖动。
    if (appliedCursorToEndVersionRef.current === resetCursorToEndVersion) return;
    appliedCursorToEndVersionRef.current = resetCursorToEndVersion;
    const textarea = textareaRef.current;
    if (textarea) moveInputCursorToEnd(textarea);
  }, [resetCursorToEndVersion, value]);

  const handleContentChange = React.useCallback(() => {
    if (syncingValueRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    // OpenTUI can echo a controlled setText as content-change after
    // sync finishes; treating that as user input exits history navigation.
    if (!shouldEmitTextareaInput(value, textarea.plainText)) return;
    onInput(textarea.plainText);
  }, [onInput, value]);

  const handleSubmit = React.useCallback(() => {
    onSubmit(textareaRef.current?.plainText ?? value);
  }, [onSubmit, value]);
  const title = inputPaneTitle(copy, mode);

  return h(
    "box",
    {
      title,
      style: inputPaneContainerStyle(focused, editorRows),
    },
    h("textarea", {
      focused,
      initialValue: value,
      keyBindings: PROMPT_TEXTAREA_KEY_BINDINGS,
      onContentChange: handleContentChange,
      onSubmit: handleSubmit,
      placeholder: inputPanePlaceholder(copy, busy),
      ref: setTextareaRef,
      style: inputPaneTextareaStyle(editorRows),
    }),
    h("box", { style: INPUT_PANE_STATUS_SPACER_STYLE }),
    h(InputComposerStatus, {
      contentWidth: inputPaneStatusContentWidth(contentWidth),
      model,
      thoughtLevel,
    }),
  );
}

// 返回值两侧带空格是 OpenTUI 标题口径，调用方不要再次 trim 或补空格。
// mode 为空串时按无 mode 处理（空串是 falsy），标题回落到 i18n 默认值。
// 面板标题文案：有 mode 时显示首字母大写的模式名，否则用 i18n 默认标题，两侧留空格。
export function inputPaneTitle(copy: TuiCopy, mode?: string): string {
  const title = mode ? formatInputModeLabel(mode) : copy.input.title;
  return ` ${title} `;
}

// 只随 busy 切换，不感知登录/权限等其他状态，两种文案都取自同一份 TuiCopy。
// 纯函数，便于不同渲染分支复用同一口径；不缓存结果。
// 占位文案：忙时提示可以排队输入，空闲时提示正常输入。
export function inputPanePlaceholder(copy: TuiCopy, busy: boolean): string {
  return busy ? copy.input.busyPlaceholder : copy.input.placeholder;
}

// 换行行数由 wordWrappedLineCount 按显示宽度计算，非 ASCII 宽字符也计入列宽。
// 返回值已归一化，调用方无需再夹范围；仅用于布局，不改变 textarea 内容。
// 由草稿文本的换行行数推算编辑器可见行数，结果夹在 [2, 6]；宽度非法时按 80 列算。
export function inputPaneEditorRows(value: string, contentWidth?: number): number {
  const contentRows = wordWrappedLineCount(value, normalizeInputContentWidth(contentWidth));
  return normalizeEditorRows(contentRows);
}

// 返回值是面板外框高度（含边框与状态行），不是 textarea 的可视行数。
// 入参先夹到 [2, 6]，调用方传越界值也安全，无需自行做范围校验。
// 面板总高度 = 归一化编辑器行数 + 固定 chrome 行数；入参会先夹到 [2, 6]。
export function inputPaneHeight(editorRows: number): number {
  return normalizeEditorRows(editorRows) + INPUT_CHROME_ROWS;
}

// 每次调用生成新样式对象，不做缓存（编辑器行数变化频率低）。
// height 与 min/max 同时给出，父层 flex 收缩时仍受上下限约束。
// 容器样式：高度随编辑器行数变化，但受 min/max 高度约束；焦点态用 accent 边框区分。
export function inputPaneContainerStyle(
  focused: boolean,
  editorRows = INPUT_MIN_EDITOR_ROWS,
): Record<string, unknown> {
  const height = inputPaneHeight(editorRows);
  return {
    backgroundColor: palette.panel,
    border: INPUT_PANE_BORDER,
    borderColor: focused ? palette.accent : palette.border,
    borderStyle: INPUT_PANE_BORDER_STYLE,
    flexDirection: "column",
    height,
    maxHeight: INPUT_PANE_MAX_HEIGHT,
    minHeight: INPUT_PANE_MIN_HEIGHT,
    paddingLeft: 1,
    paddingRight: 1,
  };
}

// 与 inputPaneContainerStyle 共用同一行数归一化，二者高度必须同步变化。
// 只包含外观与尺寸，不含 keyBindings 或事件，交互由 InputPane 外层绑定。
// textarea 样式：高度同样归一化到 [2, 6]，word 换行；placeholder 用 muted 色。
export function inputPaneTextareaStyle(editorRows: number): Record<string, unknown> {
  return {
    focusedBackgroundColor: palette.panel,
    focusedTextColor: palette.text,
    height: normalizeEditorRows(editorRows),
    maxHeight: INPUT_MAX_EDITOR_ROWS,
    minHeight: INPUT_MIN_EDITOR_ROWS,
    placeholderColor: palette.muted,
    textColor: palette.text,
    width: "100%",
    wrapMode: "word",
  };
}

// 只在文本有差异时调用 setText，避免无谓的 OpenTUI 重建与光标跳动。
// 写入后统一 moveInputCursorToEnd，调用方不需要再单独复位光标。
// 把受控值写入 textarea：文本相同则不做任何操作（返回 false），否则 setText 并把光标移到末尾（返回 true）。
// 返回值的唯一用途是让调用方知道是否真的发生了写入。
export function syncTextareaValue(textarea: DraftTextarea, value: string): boolean {
  if (textarea.plainText === value) return false;
  textarea.setText(value);
  moveInputCursorToEnd(textarea);
  return true;
}

// 这是受控输入回声过滤的唯一判据，调用方不得再用其他启发式判断用户输入。
// 仅比较文本，不做 trim 或换行归一，空白差异同样视为用户输入。
// 判断编辑器内容变化是否应上抛给父层：与受控值不同才算用户输入，相同说明是 setText 的回声。
export function shouldEmitTextareaInput(controlledValue: string, editorValue: string): boolean {
  return editorValue !== controlledValue;
}

// 把输入光标与视口一并移到缓冲区末尾；受控 setText 之后调用，避免光标停留在旧位置。
// 入参只需要 gotoBufferEnd，便于历史召回/提及补全等仅持有最小能力的调用方复用。
// 副作用：改变 textarea 的光标与滚动位置，不修改文本内容。
export function moveInputCursorToEnd(input: Pick<TextareaRenderable, "gotoBufferEnd">): void {
  // OpenTUI controlled value updates can leave the previous cursor viewport in
  // place after history recall; gotoBufferEnd refreshes both cursor and scroll.
  input.gotoBufferEnd();
}

// 归一化输入内容宽度：undefined/NaN/Infinity → 80，其余向下取整并夹到 >= 8。
function normalizeInputContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return INPUT_CONTENT_FALLBACK_WIDTH;
  }
  return Math.max(INPUT_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

// 底部状态行可用宽度 = 内容宽 - 面板水平 chrome（左右 padding）；宽度非法时返回 undefined，
// 交给状态行自己回退默认值。最小值 8 列，避免负数宽度。
function inputPaneStatusContentWidth(contentWidth?: number): number | undefined {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) return undefined;
  return Math.max(
    INPUT_MIN_CONTENT_WIDTH,
    Math.floor(contentWidth) - INPUT_PANE_HORIZONTAL_CHROME_WIDTH,
  );
}

// 把编辑器行数夹到 [INPUT_MIN_EDITOR_ROWS, INPUT_MAX_EDITOR_ROWS]，并向下取整。
function normalizeEditorRows(rows: number): number {
  return Math.min(INPUT_MAX_EDITOR_ROWS, Math.max(INPUT_MIN_EDITOR_ROWS, Math.floor(rows)));
}

// 模式名首字母大写（空串原样返回），用于面板标题展示。
function formatInputModeLabel(mode: string): string {
  if (mode.length === 0) return mode;
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}
