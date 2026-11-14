// 选区复制（L2）：把终端选中文本写入系统剪贴板，并把结果映射为状态栏文案。
// 剪贴板能力由调用方注入 writeClipboardText（为 undefined 表示终端不支持），本层不直接触碰系统剪贴板。
// 所有失败都收敛为 SelectionCopyResult 判别联合，不向调用方抛错。
import type { TuiWriteClipboardText } from "./types.js";
import type { TuiCopy } from "@zcode/i18n";

// 复制结果判别联合：四种状态互斥，调用方必须穷尽处理。
export type SelectionCopyResult =
  | {
      // 成功：写入的原始字符数（含空白与换行）。
      characterCount: number;
      kind: "copied";
    }
  | {
      // 选区为空或只有空白，未执行写入。
      kind: "empty";
    }
  | {
      // 终端未提供剪贴板能力。
      kind: "unavailable";
    }
  | {
      // 写入抛错；message 为原始错误文本，供详情展示。
      kind: "failed";
      message: string;
    };

// 复制动作的依赖注入集合。
type SelectionCopyHandlerOptions = {
  // 清空选区（无论复制成功与否都会调用）。
  clearSelection: () => void;
  // 读取当前选中文本；null/undefined 视为无选区。
  getSelectionText: () => string | null | undefined;
  // 写剪贴板能力；缺省表示当前终端不支持。
  writeClipboardText?: TuiWriteClipboardText;
};

// 创建复制动作。语义：
// - 无可复制文本（null/undefined/纯空白）→ 清空选区后返回 "empty"；
// - 终端未提供写剪贴板能力 → 清空选区后返回 "unavailable"；
// - 写入抛错 → 返回 "failed" 并携带原始 message；
// - 成功 → 返回已复制字符数（按原始文本长度，不 trim）。
// finally 都会清空选区，避免"已复制但高亮仍在"的错觉。
export function createSelectionCopyHandler({
  clearSelection,
  getSelectionText,
  writeClipboardText,
}: SelectionCopyHandlerOptions): () => Promise<SelectionCopyResult> {
  return async () => {
    const text = getSelectionText();
    if (!hasCopyableSelectionText(text)) {
      clearSelection();
      return { kind: "empty" };
    }
    if (!writeClipboardText) {
      clearSelection();
      return { kind: "unavailable" };
    }

    try {
      await writeClipboardText(text);
      return {
        characterCount: text.length,
        kind: "copied",
      };
    } catch (error) {
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearSelection();
    }
  };
}

// 类型守卫形式，调用方判定通过后可直接当 string 使用，无需再次判空。
// 判定口径必须与 createSelectionCopyHandler 的 empty 分支保持一致。
// 类型守卫：非空字符串且 trim 后非空才算可复制；纯空白视同空选区。
export function hasCopyableSelectionText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

// 返回字段均可选，调用方应以"status 是否存在"作为是否更新状态栏的唯一判据。
// 纯展示映射，不触发清空选区或剪贴板写入等副作用。
// 把复制结果映射为状态栏 { status, details }：copied/unavailable 的 details 为空数组，
// failed 把原始错误放进 details，empty 返回空对象表示"无需提示"（调用方不应清空状态栏）。
export function selectionCopyStatus(
  result: SelectionCopyResult,
  copy: TuiCopy["copy"],
): {
  details?: string[];
  status?: string;
} {
  if (result.kind === "copied") {
    return {
      details: [],
      status: copy.copied,
    };
  }
  if (result.kind === "unavailable") {
    return {
      details: [],
      status: copy.unavailable,
    };
  }
  if (result.kind === "failed") {
    return {
      details: [result.message],
      status: copy.failed,
    };
  }
  return {};
}
