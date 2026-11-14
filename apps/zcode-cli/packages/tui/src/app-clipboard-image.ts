// 剪贴板图片粘贴 hook（L2）：读取终端剪贴板图片，转成草稿附件并写入占位符。
// IO 能力由注入的 options.readClipboardImage 提供（终端能力检测在 adapter 层完成），本层不做直接 IO。
// 所有失败路径只写状态栏/详情、不抛出：粘贴属于可降级操作。
import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { isValidClipboardImage } from "./app-input.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import type { DraftAttachment } from "./app-model.js";
import type { TuiOptions } from "./types.js";

// hook 的依赖集合：全部由父层注入，hook 自身不持有 ref 之外的任何状态。
type UseClipboardImagePasteOptions = {
  // 当前轮次的取消信号来源；读图请求会带上它的 signal。
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  // 是否正忙；忙时拒绝粘贴，避免改写正在提交的草稿快照。
  busy: boolean;
  // 读取当前草稿文本（供编辑器不可用时追加占位符）。
  getDraftValue: () => string;
  // 输入编辑器实例；为 null 时退化为纯草稿字符串拼接。
  inputEditorRef: MutableRefObject<PromptInputEditor | null>;
  // 附件自增 id 分配器，调用方保证只增不减。
  nextAttachmentIdRef: MutableRefObject<number>;
  // TUI 外部能力注入点，readClipboardImage 为 undefined 表示终端不支持。
  options: TuiOptions;
  // 附件列表 setter（React 函数式更新）。
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  // 草稿文本 setter（受控值）。
  setDraftValue: (value: string) => void;
  // 状态栏文案 setter。
  setStatus: Dispatch<SetStateAction<string>>;
  // 状态栏详情（通常放底层错误 message）。
  setStatusDetails: Dispatch<SetStateAction<string[]>>;
};

// 返回一个 async 粘贴动作。前置条件：提示符空闲（busy=false）且终端支持读图。
// 成功：追加 DraftAttachment 并尽量在编辑器光标处写入 "[image #id]"，编辑器不可用时追加到草稿尾部。
// 失败语义（均只写状态，不 reject）：忙 / 不支持 / 空剪贴板 / 格式非法 / 读取异常。
export function useClipboardImagePaste({
  abortControllerRef,
  busy,
  getDraftValue,
  inputEditorRef,
  nextAttachmentIdRef,
  options,
  setDraftAttachments,
  setDraftValue,
  setStatus,
  setStatusDetails,
}: UseClipboardImagePasteOptions): () => Promise<void> {
  return useCallback(async () => {
    if (busy) {
      // 忙时不允许改草稿附件，避免与提交中的 prompt 快照竞争。
      setStatus("Image paste is available when the prompt is idle.");
      return;
    }
    if (!options.readClipboardImage) {
      setStatus("Image paste is not available in this terminal.");
      return;
    }

    try {
      setStatus("Reading image from clipboard...");
      const image = await options.readClipboardImage({
        abortSignal: abortControllerRef.current?.signal,
      });
      if (!image) {
        // 空剪贴板是常见路径，按提示处理而不是当作错误。
        setStatus("No image found in clipboard.");
        return;
      }
      if (!isValidClipboardImage(image)) {
        // 过滤终端返回的路径/占位文本，只接受 data:<mediaType>;base64, 前缀。
        setStatus("Clipboard image is not a supported image format.");
        return;
      }

      const id = nextAttachmentIdRef.current++;
      const placeholder = `[image #${id}]`;
      const attachment: DraftAttachment = {
        dataUrl: image.dataUrl,
        id,
        mediaType: image.mediaType,
        placeholder,
        sizeBytes: image.sizeBytes,
        type: "image",
      };
      setDraftAttachments((current) => [...current, attachment]);
      if (!insertPlaceholderIntoEditor(inputEditorRef.current, placeholder)) {
        // 编辑器不可用（未挂载/已销毁）时退化为受控草稿拼接，保证占位符仍可见。
        setDraftValue(appendedImagePlaceholder(getDraftValue(), placeholder));
      }
      setStatus(`Attached ${placeholder}.`);
    } catch (error) {
      // 状态栏给可读文案，原始 message 只放进详情，避免泄露内部细节到主提示。
      setStatus("Could not read image from clipboard.");
      setStatusDetails([error instanceof Error ? error.message : String(error)]);
    }
  }, [
    abortControllerRef,
    busy,
    getDraftValue,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  ]);
}

// 把占位符追加到草稿末尾：非空草稿先去掉尾部空白再加一个空格，避免出现双空格。
function appendedImagePlaceholder(draft: string, placeholder: string): string {
  const trimmed = draft.trimEnd();
  return trimmed ? `${trimmed} ${placeholder}` : placeholder;
}

// 在编辑器末尾写入占位符；成功返回 true，编辑器缺失返回 false 由调用方降级。
// 副作用：改写编辑器内容并把光标/视口移到缓冲区末尾。
function insertPlaceholderIntoEditor(
  editor: PromptInputEditor | null,
  placeholder: string,
): boolean {
  if (!editor) return false;
  editor.setText(appendedImagePlaceholder(editor.plainText, placeholder));
  editor.gotoBufferEnd();
  return true;
}
