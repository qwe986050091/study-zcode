// 输入历史回溯 hook（L2）：up 取更早的历史输入，down 逐步回到当前草稿。
// 副作用仅限草稿/附件/光标状态；历史数据来自注入的 options.recallPreviousInput（跳过条数由调用方记 ref）。
// 不变量：进入回溯前先快照当前草稿（inputHistoryDraftRef），回溯到最新一条时原样恢复该快照。
import type { TuiCopy } from "@zcode/i18n";
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toDraftAttachments } from "./app-input.js";
import type { DraftAttachment, SlashSelectionState } from "./app-model.js";
import type { TuiOptions, TuiPromptAttachment } from "./types.js";

// hook 依赖集合：全部由父层注入的 ref/setter，hook 自身不保存状态。
type UseInputHistoryOptions = {
  // i18n 文案；缺省由调用方传入 DEFAULT_TUI_COPY。
  copy: TuiCopy;
  // 当前草稿附件（首次回溯时快照用）。
  draftAttachmentsRef: MutableRefObject<DraftAttachment[]>;
  // 当前草稿文本（首次回溯时快照用）。
  draftRef: MutableRefObject<string>;
  // 进入回溯前的附件快照；undefined 表示当前不在回溯态。
  inputHistoryDraftAttachmentsRef: MutableRefObject<DraftAttachment[] | undefined>;
  // 进入回溯前的草稿快照；undefined 表示当前不在回溯态（同时作为"是否在回溯"的判据）。
  inputHistoryDraftRef: MutableRefObject<string | undefined>;
  // 已回溯的条数（0 表示未回溯；up 递增、down 递减）。
  inputHistoryIndexRef: MutableRefObject<number>;
  // 附件 id 分配器；历史附件重建时使用，调用方保证只增不减。
  nextAttachmentIdRef: MutableRefObject<number>;
  // 外部能力注入点，recallPreviousInput 为 undefined 表示无历史源。
  options: TuiOptions;
  // 附件列表 setter。
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  // 草稿状态 setter（受控值）。
  setDraftState: Dispatch<SetStateAction<string>>;
  // 草稿值 setter（不走受控 state，直接写编辑器）。
  setDraftValue: (value: string) => void;
  // 光标复位的版本号自增器：变化后输入面板会把光标移到末尾。
  setInputCursorToEndVersion: Dispatch<SetStateAction<number>>;
  // 斜杠命令选择态 setter；回溯时需清空，避免旧面板串味。
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  // 状态栏文案 setter。
  setStatus: Dispatch<SetStateAction<string>>;
  // 状态栏详情（底层错误 message）。
  setStatusDetails: Dispatch<SetStateAction<string[]>>;
};

// 两个返回动作都是 async 且永不 reject，调用方无需 try/catch，只看状态栏结果。
// hook 不订阅历史源变化，读取时机完全由按键层（up/down）控制。
// 返回 recallPreviousInput（向更早回溯）与 recallNextInput（向更新回溯）两个 async 动作。
// 失败语义：未注入历史源 / 无更早记录 / 读取抛错 → 只写状态栏（必要时 details），不 reject。
export function useInputHistory({
  copy,
  draftAttachmentsRef,
  draftRef,
  inputHistoryDraftAttachmentsRef,
  inputHistoryDraftRef,
  inputHistoryIndexRef,
  nextAttachmentIdRef,
  options,
  setDraftAttachments,
  setDraftState,
  setDraftValue,
  setInputCursorToEndVersion,
  setSlashSelection,
  setStatus,
  setStatusDetails,
}: UseInputHistoryOptions): {
  recallNextInput: () => Promise<void>;
  recallPreviousInput: () => Promise<void>;
} {
  // 用历史条目覆盖草稿：重建附件（重新分配 id，并把 nextAttachmentId 推到最大 id+1 之上），
  // 清空斜杠选择、光标移到末尾。附件 id 单调递增的不变量在此维护。
  const restoreHistoryDraft = useCallback(
    (value: string, attachments?: TuiPromptAttachment[]) => {
      const restoredAttachments = toDraftAttachments(
        attachments,
        () => nextAttachmentIdRef.current++,
      );
      for (const attachment of restoredAttachments) {
        nextAttachmentIdRef.current = Math.max(nextAttachmentIdRef.current, attachment.id + 1);
      }
      draftRef.current = value;
      setDraftState(value);
      setDraftAttachments(restoredAttachments);
      setSlashSelection(undefined);
      setInputCursorToEndVersion((current) => current + 1);
    },
    [
      draftRef,
      nextAttachmentIdRef,
      setDraftAttachments,
      setDraftState,
      setInputCursorToEndVersion,
      setSlashSelection,
    ],
  );

  // 向更早回溯。首次调用先快照当前草稿与附件；skip 为已回溯条数，用于分页取值。
  // previous.text 为空视为到底：状态栏提示"无更早输入"，但 index 不回滚。
  const recallPreviousInput = useCallback(async () => {
    if (!options.recallPreviousInput) {
      setStatus(copy.input.noHistorySource);
      return;
    }
    if (inputHistoryDraftRef.current === undefined) {
      // 首次回溯：快照当前草稿与附件，供 down 回到底部时恢复。
      inputHistoryDraftRef.current = draftRef.current;
      inputHistoryDraftAttachmentsRef.current = draftAttachmentsRef.current;
    }
    try {
      const skip = inputHistoryIndexRef.current;
      const previous = await options.recallPreviousInput(skip);
      if (!previous?.text) {
        setStatus(copy.input.noPreviousInput);
        return;
      }
      inputHistoryIndexRef.current = skip + 1;
      restoreHistoryDraft(previous.text, previous.attachments);
      setStatus(
        previous.attachments?.length
          ? copy.input.restoredPreviousInputWithAttachments(previous.attachments.length)
          : copy.input.restoredPreviousInput,
      );
    } catch (error) {
      setStatus(copy.input.restorePreviousInputFailed);
      setStatusDetails([error instanceof Error ? error.message : String(error)]);
    }
  }, [
    copy,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    options,
    restoreHistoryDraft,
    setStatus,
    setStatusDetails,
  ]);

  // 向更新回溯。未处于回溯态直接返回（避免把空草稿写进输入框）。
  // index <= 1 表示已到最新一条：恢复进入回溯前的快照并把回溯态清零。
  // 中间步骤读取失败静默忽略——历史导航是尽力而为的能力，不打断用户输入。
  const recallNextInput = useCallback(async () => {
    if (inputHistoryDraftRef.current === undefined) return;
    if (inputHistoryIndexRef.current <= 1) {
      // 回到最新一条：恢复快照并清空回溯标记，此后 up 会重新开始一轮回溯。
      setDraftValue(inputHistoryDraftRef.current);
      setDraftAttachments(inputHistoryDraftAttachmentsRef.current ?? []);
      setInputCursorToEndVersion((current) => current + 1);
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      inputHistoryIndexRef.current = 0;
      setStatus(copy.status.ready);
      return;
    }

    inputHistoryIndexRef.current -= 1;
    try {
      const previous = await options.recallPreviousInput?.(inputHistoryIndexRef.current - 1);
      if (previous?.text) restoreHistoryDraft(previous.text, previous.attachments);
    } catch {
      // History navigation is best-effort.
    }
  }, [
    copy,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    options,
    restoreHistoryDraft,
    setDraftAttachments,
    setDraftValue,
    setInputCursorToEndVersion,
    setStatus,
  ]);

  return { recallNextInput, recallPreviousInput };
}
