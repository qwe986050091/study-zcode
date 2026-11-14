// INV-01 触发必须紧贴空白：守住位置 前一字符判断；改错故障 邮箱地址被当成提及。
// INV-02 token 内不得有空白：守住位置 空白检测；改错故障 整句被当成路径查询。
// INV-03 只认最近的符号：守住位置 末次索引；改错故障 多个提及区间错位。
// INV-04 光标越界先归一：守住位置 夹取函数；改错故障 非法偏移导致切片异常。
// INV-05 忙时关闭面板：守住位置 早退分支；改错故障 输入焦点被建议列表抢走。
// INV-06 无提供方不查询：守住位置 条件判断；改错故障 宿主未注入时反复报错。
// INV-07 关闭记忆按位置与词：守住位置 提及键；改错故障 关闭后同一位置反复弹出。
// INV-08 旧结果不得覆盖新状态：守住位置 中止信号；改错故障 慢查询把新候选冲掉。
// INV-09 查询失败只降级：守住位置 捕获分支；改错故障 一次失败清空草稿。
// INV-10 同一提及保留选中下标：守住位置 合并分支；改错故障 每次按键跳回第一项。
// INV-11 选中下标始终在范围内：守住位置 夹取调用；改错故障 候选项减少后越界。
// INV-12 面板条数有上限：守住位置 可见数量常量；改错故障 长列表撑满终端。
// INV-13 窗口让选中项靠底：守住位置 起始下标计算；改错故障 选中项滚出可视区。
// INV-14 目录补全不生成附件：守住位置 类型分支；改错故障 目录被当文件上传。
// INV-15 附件按占位符去重：守住位置 存在性判断；改错故障 重复提及产生重复附件。
// INV-16 替换优先走编辑器接口：守住位置 主分支；改错故障 光标与视口被重置。
// INV-17 编辑器失效可回退拼接：守住位置 捕获分支；改错故障 重挂载后补全直接报错。
// INV-18 卸载中止在途查询：守住位置 清理函数；改错故障 面板关闭后仍写入状态。
//
// 模块职责：识别草稿中的文件提及、拉取候选并把选中项补全回草稿。
// 状态所有权：面板状态与关闭记忆属于 hook，草稿与附件由宿主注入。
// 阅读顺序：先看识别规则，再看查询副作用，最后看按键与补全动作。
// 文件 @ 提及的识别、补全与候选拉取（L2）。
// 触发规则：光标前最近的 "@"，其前一字符必须是空白或行首，且 token 内不能再有空白。
// 副作用：通过注入的 listWorkspacePathSuggestions 发起可取消查询，并更新草稿/附件/状态栏。
// 查询失败只写入 state.error 供面板展示，不打断输入。
import type { KeyEvent } from "@mbears/opentui-core";
import React from "react";
import { clampIndex } from "./app-input.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import type { DraftAttachment, SlashSelectionState } from "./app-model.js";
import type { TuiListWorkspacePathSuggestions, TuiWorkspacePathSuggestion } from "./types.js";

// 面板最多展示的候选条数；单次查询上限 50 条，是否被截断由 provider 返回的 truncated 决定。
export const FILE_MENTION_VISIBLE_COUNT = 8;
const FILE_MENTION_QUERY_LIMIT = 50;
const FILE_MENTION_SIGIL = "@";
const FILE_MENTION_ATTACHED_STATUS_PREFIX = "Attached";
const FILE_MENTION_DISMISSED_STATUS = "File suggestions dismissed.";
const FILE_MENTION_EMPTY_STATUS = "No matching workspace path.";

// 光标处激活中的提及区间。endOffset 为光标偏移（替换右边界），triggerIndex 为 "@" 的下标。
export type ActiveFileMention = {
  // 光标偏移（绝对字符下标），即待替换区间的右边界。
  endOffset: number;
  // "@" 之后、光标之前的查询词，可能为空串（刚敲下 @）。
  token: string;
  // "@" 字符在草稿中的下标，即待替换区间的左边界。
  triggerIndex: number;
};

// 面板渲染所需完整状态，由 ActiveFileMention 扩展查询结果。
export type FileMentionState = ActiveFileMention & {
  // 查询失败信息；undefined 表示成功或尚未返回。
  error?: string;
  // 当前候选列表；loading 期间可能为空数组。
  items: readonly TuiWorkspacePathSuggestion[];
  // 是否正在查询；用于面板显示 loading 文案。
  loading: boolean;
  // 选中项下标（相对 items），越界时由 UI 侧 clamp。
  selectedIndex: number;
  // provider 是否因条数上限截断了结果。
  truncated: boolean;
};

// hook 返回：state 为 undefined 表示面板关闭；handleKey 返回 true 表示按键已被消费。
type FileMentionController = {
  handleKey: (key: KeyEvent) => boolean;
  state: FileMentionState | undefined;
};

// 文件提及控制器。draft/busy 变化时重算当前 @ token，命中则发起一次可取消查询：
// - busy、未注入 provider 或无 token → state=undefined（面板关闭）；
// - 同一 token 被 Esc 关闭过则不再重开（dismissedKeyRef 记忆）；
// - 只接受与当前 key 相同的异步结果，避免旧请求覆盖新状态；
// - effect cleanup 时 abort 进行中的查询。
// 返回 handleKey 供按键层优先消费（escape/up/down/tab/return），其余按键返回 false。
// busy 为真时直接关闭面板，不抢输入焦点。
// 没有 listWorkspacePathSuggestions 或没有提及就不查询。
// 同一 dismissedKeyRef 键被 Esc 关闭后不再自动弹回。
// 同一 key 复用旧 candidates 与选中下标。
// effect cleanup 时 abort 在途查询。
export function useFileMentionController(options: {
  busy: boolean;
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  listWorkspacePathSuggestions?: TuiListWorkspacePathSuggestions;
  nextAttachmentIdRef: React.MutableRefObject<number>;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
}): FileMentionController {
  const [state, setState] = React.useState<FileMentionState | undefined>();
  const dismissedKeyRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    const provider = options.listWorkspacePathSuggestions;
    const cursorOffset = promptEditorCursorOffset(options.editorRef.current, options.draft.length);
    const active = resolveActiveFileMention(options.draft, cursorOffset);
    if (options.busy || !provider || !active) {
      // 忙时关闭面板，避免把输入焦点抢到建议列表上。
      setState(undefined);
      return undefined;
    }

    const key = fileMentionKey(active);
    if (dismissedKeyRef.current === key) {
      // 用户已用 Esc 关掉同一提及，不再自动弹回，直到位置或 token 变化。
      setState(undefined);
      return undefined;
    }

    const abortController = new AbortController();
    setState((current) =>
      // 复用同一提及的既有候选（保留 selectedIndex），避免每次按键都跳回第一项；
      // 位置变了才重置为新查询的初始状态。
      current && fileMentionKey(current) === key
        ? { ...current, ...active, error: undefined, loading: true }
        : {
            ...active,
            items: [],
            loading: true,
            selectedIndex: 0,
            truncated: false,
          },
    );

    void provider({
      abortSignal: abortController.signal,
      limit: FILE_MENTION_QUERY_LIMIT,
      token: active.token,
    })
      .then((result) => {
        // 已被 abort 或已切换到别的 token：丢弃这份旧结果。
        if (abortController.signal.aborted) return;
        setState((current) =>
          current && fileMentionKey(current) === key
            ? {
                ...current,
                error: undefined,
                items: result.items,
                loading: false,
                selectedIndex: clampIndex(current.selectedIndex, result.items.length),
                truncated: result.truncated,
              }
            : current,
        );
      })
      .catch((error) => {
        // 查询失败降级为面板内错误提示（保留面板，不清空草稿）。
        if (abortController.signal.aborted) return;
        setState((current) =>
          current && fileMentionKey(current) === key
            ? {
                ...current,
                error: error instanceof Error ? error.message : String(error),
                items: [],
                loading: false,
                selectedIndex: 0,
                truncated: false,
              }
            : current,
        );
      });

    return () => abortController.abort();
  }, [options.busy, options.draft, options.editorRef, options.listWorkspacePathSuggestions]);

  const handleKey = React.useCallback(
    (key: KeyEvent): boolean => {
      if (!state) return false;
      if (key.name === "escape") {
        // 记住被关闭的提及 key，避免同一位置下次 draft 变化时又弹出来。
        dismissedKeyRef.current = fileMentionKey(state);
        setState(undefined);
        options.setStatus(FILE_MENTION_DISMISSED_STATUS);
        return true;
      }
      if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        setState((current) =>
          current
            ? {
                ...current,
                selectedIndex: clampIndex(current.selectedIndex + delta, current.items.length),
              }
            : current,
        );
        return true;
      }
      if (key.name === "tab" || key.name === "return") {
        completeFileMention(state, options);
        return true;
      }
      return false;
    },
    [options, state],
  );

  return { handleKey, state };
}

// 入参只要求 cursorOffset 能力（最小契约），便于测试传 stub 而不依赖 OpenTUI 实例。
// 返回绝对字符下标且不做 clamp，越界值由 resolveActiveFileMention 统一归一。
// 读取编辑器光标偏移；编辑器缺失或读取抛错（React 重挂载后 OpenTUI EditorView 失效）时
// 回退到 draft 长度，保证提及识别不因异常中断。
export function promptEditorCursorOffset(
  editor: Pick<PromptInputEditor, "cursorOffset"> | null,
  fallbackOffset: number,
): number {
  if (!editor) return fallbackOffset;
  try {
    return editor.cursorOffset;
  } catch {
    // A stale OpenTUI EditorView can throw after React remounts the prompt; the
    // controlled draft length keeps file mention detection recoverable.
    return fallbackOffset;
  }
}

// 解析光标处的 @ 提及。返回 undefined 的情形：
// - 光标前没有 "@"；"@" 前一字符不是空白（例如邮箱 a@b 不触发）；token 内含空白。
// cursorOffset 非法或越界时先被 clamp 到 [0, len]（非法数按文本长度处理）。
// cursorOffset 先由 clampOffset 夹到 [0, text.length]。
// lastIndexOf(FILE_MENTION_SIGIL) 只认最近的 @ 符号。
// triggerIndex 前一字符必须是空白或行首。
// token 内出现空白即判定 mention 失效。
// 返回的 range 右边界等于 normalizedCursorOffset。
export function resolveActiveFileMention(
  text: string,
  cursorOffset = text.length,
): ActiveFileMention | undefined {
  const normalizedCursorOffset = clampOffset(cursorOffset, text.length);
  const beforeCursor = text.slice(0, normalizedCursorOffset);
  const triggerIndex = beforeCursor.lastIndexOf(FILE_MENTION_SIGIL);
  if (triggerIndex < 0) return undefined;

  const beforeTrigger = triggerIndex === 0 ? undefined : text[triggerIndex - 1];
  if (beforeTrigger !== undefined && !/\s/u.test(beforeTrigger)) return undefined;

  const token = beforeCursor.slice(triggerIndex + FILE_MENTION_SIGIL.length);
  if (/\s/u.test(token)) return undefined;
  return {
    endOffset: normalizedCursorOffset,
    token,
    triggerIndex,
  };
}

// 计算滚动窗口：窗口大小 min(maxVisible, 总数)，选中项尽量靠底（向上溢出时才滚动），
// 返回值 selectedIndex 是"窗口内相对下标"，startIndex 为窗口首项在 items 中的绝对下标。
// 空列表或 maxVisible <= 0 返回空窗口（selectedIndex=0, startIndex=0）。
export function visibleFileMentionWindow(
  items: readonly TuiWorkspacePathSuggestion[],
  selectedIndex: number,
  maxVisible: number,
): {
  items: readonly TuiWorkspacePathSuggestion[];
  selectedIndex: number;
  startIndex: number;
} {
  if (items.length === 0 || maxVisible <= 0) {
    return {
      items: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, items.length);
  const visibleCount = Math.min(maxVisible, items.length);
  const maxStartIndex = items.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    items: items.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

// 补全当前选中项。目录：把 "@path" 写回草稿（便于继续输入子路径），不生成附件。
// 文件：已有同 placeholder 的附件则不重复添加，否则分配新 id 并追加；随后写入 "@path "（带尾空格）。
// 无候选时只写状态栏，不修改草稿。
// 无 candidates 时只写状态栏，不改草稿。
// kind 为目录时只回写 "@path"，不生成附件。
// 文件按 placeholder 去重，已有附件不重复添加。
// 新附件 id 取自 nextAttachmentIdRef 自增。
// replaceSelection 的补全文本带尾随空格，便于继续输入。
// replaceSelection 失败时退回字符串拼接。
function completeFileMention(
  state: FileMentionState,
  options: {
    draft: string;
    editorRef: React.MutableRefObject<PromptInputEditor | null>;
    nextAttachmentIdRef: React.MutableRefObject<number>;
    setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
    setDraftValue: (value: string) => void;
    setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
    setStatus: React.Dispatch<React.SetStateAction<string>>;
  },
): void {
  const item = state.items[clampIndex(state.selectedIndex, state.items.length)];
  if (!item) {
    options.setStatus(FILE_MENTION_EMPTY_STATUS);
    return;
  }

  options.setSlashSelection(undefined);
  if (item.kind === "directory") {
    replaceMentionText(
      options.editorRef.current,
      options.draft,
      state,
      `${FILE_MENTION_SIGIL}${item.path}`,
      options.setDraftValue,
    );
    return;
  }

  const placeholder = `${FILE_MENTION_SIGIL}${item.path}`;
  options.setDraftAttachments((current) =>
    current.some(
      (attachment) => attachment.type === "file" && attachment.placeholder === placeholder,
    )
      ? current
      : [
          ...current,
          {
            id: options.nextAttachmentIdRef.current++,
            path: item.path,
            placeholder,
            type: "file" as const,
          },
        ],
  );
  replaceMentionText(
    options.editorRef.current,
    options.draft,
    state,
    `${placeholder} `,
    options.setDraftValue,
  );
  options.setStatus(`${FILE_MENTION_ATTACHED_STATUS_PREFIX} ${placeholder}.`);
}

// 用 replacement 替换草稿中 [triggerIndex, endOffset) 区间。优先走编辑器 API（保留光标/视口语义），
// 编辑器缺失或调用抛错时退化为纯字符串拼接，并通过 setDraftValue 同步受控值。
function replaceMentionText(
  editor: PromptInputEditor | null,
  draft: string,
  mention: ActiveFileMention,
  replacement: string,
  setDraftValue: (value: string) => void,
): void {
  if (!editor) {
    setDraftValue(
      `${draft.slice(0, mention.triggerIndex)}${replacement}${draft.slice(mention.endOffset)}`,
    );
    return;
  }

  try {
    // 用 logicalCursor 换算选区：cursorOffset 是扁平偏移，deleteRange 需要行列坐标。
    const endOffset = editor.cursorOffset;
    editor.cursorOffset = mention.triggerIndex;
    const startCursor = editor.logicalCursor;
    editor.cursorOffset = endOffset;
    const endCursor = editor.logicalCursor;
    editor.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col);
    editor.insertText(replacement);
    setDraftValue(editor.plainText);
    editor.focus();
  } catch {
    setDraftValue(
      `${draft.slice(0, mention.triggerIndex)}${replacement}${draft.slice(mention.endOffset)}`,
    );
  }
}

// 以"位置 + token"作为提及身份：位置变化即视为新提及，可绕过 Esc 的 dismiss 记忆。
function fileMentionKey(mention: ActiveFileMention): string {
  return `${mention.triggerIndex}:${mention.endOffset}:${mention.token}`;
}

// 把偏移夹到 [0, len]；非有限数按 len 处理（等价于"光标在末尾"）。
function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return length;
  return Math.max(0, Math.min(Math.trunc(offset), length));
}
