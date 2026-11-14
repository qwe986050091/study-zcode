// INV-01 状态不可变替换：守住位置 克隆函数；改错故障 上一帧被就地修改。
// INV-02 更新只命中同一项：守住位置 对象身份比较；改错故障 其他审批弹窗被改。
// INV-03 复核页优先分流：守住位置 分支顺序；改错故障 复核时仍能改选项。
// INV-04 其他编辑独立分支：守住位置 编辑态判断；改错故障 字符触发选项导航。
// INV-05 其他项下标等于选项数：守住位置 索引推导；改错故障 最后一项选不中。
// INV-06 越界一律夹取：守住位置 夹取函数；改错故障 非法下标写入答案。
// INV-07 无题目不处理按键：守住位置 空值判断；改错故障 写入不存在的答案键。
// INV-08 数字键定位选项：守住位置 正则判断；改错故障 多位数触发多次跳转。
// INV-09 多选数字键只切一次：守住位置 单次调用；改错故障 勾选状态来回翻转。
// INV-10 多选去重：守住位置 集合构造；改错故障 同一标签重复出现。
// INV-11 空白其他答案拒绝：守住位置 裁剪后判断；改错故障 提交校验失败。
// INV-12 选其他未填转编辑：守住位置 条件分支；改错故障 空答案被记录。
// INV-13 跳过清空四类草稿：守住位置 删除调用；改错故障 跳过题仍出现在结果里。
// INV-14 跳过不写答案：守住位置 只删不写；改错故障 跳过被当成已答。
// INV-15 最后一题进复核：守住位置 下标比较；改错故障 最后一题直接提交。
// INV-16 非最后题重置选中：守住位置 题号自增；改错故障 下一题沿用旧选中项。
// INV-17 提交前先清理：守住位置 调用顺序；改错故障 弹窗资源泄漏。
// INV-18 提交后移出队列：守住位置 过滤调用；改错故障 已答弹窗仍可见。
//
// 模块职责：交互式提问弹窗的本地键盘状态机。
// 状态所有权：只维护弹窗临时态，最终答案经 broker 回调上抛。
// 阅读顺序：先看状态构造与按键分发，再看复核与其他输入，最后看答案汇总。
// 交互式提问的本地键盘状态机。
// 职责：创建 QuestionPromptState，并按按键推进答题、复核与“其他”输入。
// 边界：只维护弹窗临时交互态，答案最终经 broker 回调上抛。
// 副作用：写审批队列与状态栏；提交/拒绝时调用 broker 回调且只调用一次。
// 不变量：state 视为渲染快照，所有修改都经 clone 后不可变替换。

import type {
  AskUserQuestionAnnotation,
  AskUserQuestionInput,
} from "@zcode/contracts";
import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { ApprovalPrompt, QuestionPromptState } from "./app-model.js";
import { clampIndex, printableKey } from "./app-input.js";

// 为一次交互式提问创建初始 UI 状态：停在第 0 题、无答案、复选框/“其他”均未填写。
// 输入：input 为契约层原始提问（题目与选项），本函数只引用不拷贝，之后不得就地修改。
// 输出：全新的 QuestionPromptState，各 Record 均为空对象（而非 undefined），便于无保护地读写。
// 副作用：无，纯构造；answers/multiSelections 的空对象表示“未回答”，不是“已回答空值”。
export function createQuestionPromptState(input: AskUserQuestionInput): QuestionPromptState {
  return {
    annotations: {},
    answers: {},
    currentQuestionIndex: 0,
    editingOther: false,
    input,
    multiSelections: {},
    otherBuffer: "",
    otherText: {},
    reviewing: false,
    selectedOptionIndex: 0,
  };
}

// handleQuestionKey 是交互式提问的键盘处理入口：根据当前模式（复核页/编辑其他/正常答题）分发。
// 输入：key 为原始按键，approval 必须携带 questionState（否则直接忽略）；
// setApprovalQueue/setStatus 为唯一的写出口。
// 输出：无返回值；通过 update 生成新的 approval 对象替换队列中的同一项（不可变更新），
// 或在 Escape/提交时 resolve/cleanup 并移除该项。
// 副作用：写 React 状态；提交/拒绝时调用 broker 回调（有业务后果，须保证只调用一次）。
// 口径：其他选项的下标等于 options.length，因此选中态范围是 [0, options.length]，
// 所有 clampIndex 都以 otherIndex+1 为长度，保证“其他”始终可作为最后一项被选中。
// 不变量：state 是渲染快照，所有修改都必须走 update 的 clone，禁止直接改 state 对象。
export function handleQuestionKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  const state = approval.questionState;
  if (!state) return;

  const update = (recipe: (draft: QuestionPromptState) => void) => {
    // 只替换队列中同一个 approval 实例；用对象身份判断，避免误改其他审批弹窗。
    setApprovalQueue((current) =>
      current.map((item) => {
        if (item !== approval || !item.questionState) return item;
        const nextState = cloneQuestionState(item.questionState);
        recipe(nextState);
        return {
          ...item,
          questionState: nextState,
        };
      }),
    );
  };

  if (state.reviewing) {
    // 复核页的按键语义与答题页完全不同（Enter=提交全部、Tab=返回修改），必须先分流。
    handleQuestionReviewKey(key, approval, state, update, setApprovalQueue, setStatus);
    return;
  }

  const question = state.input.questions[state.currentQuestionIndex];
  // 下标可能因输入变化而越界；无题目时不处理任何按键，避免写入不存在的答案键。
  if (!question) return;
  const otherIndex = question.options.length;

  if (state.editingOther) {
    // 编辑“其他”时按键全部属于文本框（字符/退格/Enter 确认），不能再触发选项导航。
    handleOtherAnswerKey(key, state, update, setStatus);
    return;
  }

  if (key.name === "escape") {
    // 答题页 Escape 语义是“拒绝整个提问”，而不是返回上一题；需一次清理并 resolve。
    denyQuestion(approval, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "up" || printableKey(key)?.toLowerCase() === "k") {
    update((draft) => {
      draft.selectedOptionIndex = clampIndex(draft.selectedOptionIndex - 1, otherIndex + 1);
    });
    return;
  }
  if (key.name === "down" || printableKey(key)?.toLowerCase() === "j") {
    update((draft) => {
      draft.selectedOptionIndex = clampIndex(draft.selectedOptionIndex + 1, otherIndex + 1);
    });
    return;
  }
  if (key.name === "o") {
    update((draft) => {
      const target = draft.input.questions[draft.currentQuestionIndex];
      if (!target) return;
      draft.editingOther = true;
      // 优先回填该题已保存的“其他”答案，便于用户修改；没有则从空开始。
      draft.otherBuffer = draft.otherText[target.question] ?? "";
      draft.selectedOptionIndex = target.options.length;
    });
    setStatus("Type a custom answer. Press Enter to accept.");
    return;
  }
  if (key.name === "s") {
    skipQuestionAnswer(state, update, setStatus);
    return;
  }
  if (question.multiSelect && key.name === "space") {
    update((draft) => {
      toggleQuestionSelection(draft);
    });
    return;
  }
  if (/^[1-9]$/.test(key.name)) {
    const selected = Number(key.name) - 1;
    update((draft) => {
      // 数字键 1-9 直接定位选项；越界（选项不足）时 clamp 到“其他”项，不写入非法下标。
      draft.selectedOptionIndex = clampIndex(selected, otherIndex + 1);
      // 多选模式下数字键兼具“选中并切换勾选”，但仅在按下时切换一次，避免重复。
      if (question.multiSelect) toggleQuestionSelection(draft);
    });
    return;
  }
  if (key.name === "return") {
    // Enter 在单选/多选下语义都是“确认当前题并前进”，具体推进由 submitQuestionAnswer 负责。
    submitQuestionAnswer(state, update, setStatus);
  }
}

// 复核页键盘：Enter 提交全部答案（resolve=modify），Escape 拒绝，Tab/PageUp 返回修改。
// 输出副作用：提交/拒绝会调用 broker 回调并把该项移出队列，调用后弹窗关闭。
function handleQuestionReviewKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  if (key.name === "return") {
    approval.cleanup();
    approval.resolve({
      decision: "modify",
      modifiedInput: {
        annotations: state.annotations,
        answers: state.answers,
        questions: state.input.questions,
      },
      reason: "Answered in TUI",
      resolvedAt: new Date(),
    });
    setApprovalQueue((current) => current.filter((item) => item !== approval));
    setStatus(`Answered ${Object.keys(state.answers).length} clarification questions.`);
    return;
  }
  if (key.name === "escape") {
    denyQuestion(approval, setApprovalQueue, setStatus);
    return;
  }
  if (key.name === "tab" || key.name === "pageup") {
    update((draft) => {
      draft.reviewing = false;
      // PageUp 回到最后一题方便就地修改，Tab 回到第一题；两者都重置选中下标。
      draft.currentQuestionIndex = key.name === "pageup" ? draft.input.questions.length - 1 : 0;
      draft.selectedOptionIndex = 0;
    });
  }
}

// “其他”答案编辑：Enter 保存并退出编辑，Escape 取消且丢弃本次输入，Ctrl-U 清空缓冲。
// 非打印键直接忽略；打印字符逐字追加到 otherBuffer，不做长度限制（由 UI 截断展示）。
function handleOtherAnswerKey(
  key: KeyEvent,
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setStatus: (status: string) => void,
): void {
  if (key.name === "return") {
    const other = state.otherBuffer.trim();
    // 空白答案无意义：拦在写入前，避免 answers 中出现空值导致提交校验失败。
    if (!other) {
      setStatus("Other answer cannot be empty.");
      return;
    }
    update((draft) => {
      const target = draft.input.questions[draft.currentQuestionIndex];
      if (!target) return;
      draft.otherText[target.question] = other;
      draft.selectedOptionIndex = target.options.length;
      draft.editingOther = false;
      draft.otherBuffer = "";
      if (target.multiSelect) {
        // 多选需把“其他”作为选中项登记，且用 Set 去重，防止重复追加同一标签。
        draft.multiSelections[target.question] = [
          ...new Set([...(draft.multiSelections[target.question] ?? []), "Other"]),
        ];
      }
    });
    setStatus("Other answer added.");
    return;
  }
  if (key.name === "escape") {
    update((draft) => {
      draft.editingOther = false;
      draft.otherBuffer = "";
    });
    setStatus("Other input cancelled.");
    return;
  }
  if (key.name === "backspace") {
    update((draft) => {
      draft.otherBuffer = draft.otherBuffer.slice(0, -1);
    });
    return;
  }
  if (key.name === "u" && key.ctrl) {
    update((draft) => {
      draft.otherBuffer = "";
    });
    setStatus("Other answer cleared.");
    return;
  }
  const character = printableKey(key);
  if (character) {
    update((draft) => {
      draft.otherBuffer = `${draft.otherBuffer}${character}`;
    });
  }
}

// 单选：取当前选中项标签；多选：取已勾选标签集合；“其他”项用 otherText 中的文本替换。
// 若选中“其他”但尚未填写，则转入编辑态而不是报错，减少一次多余按键。
// 副作用：写 answers/annotations；最后一题确认后 reviewing=true，否则题号 +1 并重置选中项。
// 口径：多选答案为所有标签以 ", " 连接；preview 汇总为该题所有选中项的 preview，用空行分隔。
function submitQuestionAnswer(
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setStatus: (status: string) => void,
): void {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;
  const otherIndex = question.options.length;

  if (state.selectedOptionIndex === otherIndex && !state.otherText[question.question]) {
    // 选了“其他”却没有内容：直接进入编辑态，避免把空答案记入 answers。
    update((draft) => {
      draft.editingOther = true;
      draft.otherBuffer = "";
    });
    setStatus("Type a custom answer. Press Enter to accept.");
    return;
  }

  const answer = answerCurrentQuestion(state);
  // 未选任何项且未选“其他”时无法构成答案，提示用户而不是静默跳过本题。
  if (!answer) {
    setStatus("Select at least one option, or choose Other.");
    return;
  }

  update((draft) => {
    const target = draft.input.questions[draft.currentQuestionIndex];
    if (!target) return;
    const nextAnswer = answerCurrentQuestion(draft);
    if (!nextAnswer) return;
    draft.answers[target.question] = nextAnswer.answer;
    if (nextAnswer.annotation) {
      draft.annotations[target.question] = nextAnswer.annotation;
    } else {
      delete draft.annotations[target.question];
    }
    if (draft.currentQuestionIndex >= draft.input.questions.length - 1) {
      // 最后一题确认后置 reviewing=true，由用户在复核页统一检查全部答案。
      draft.reviewing = true;
    } else {
      draft.currentQuestionIndex += 1;
      draft.selectedOptionIndex = 0;
    }
  });
  setStatus("Review answers, then press Enter to submit.");
}

// 跳过当前题：清除该题的全部本地草稿（答案/标注/多选/其他文本）后推进。
// 与“提交”不同，跳过不写入 answers，最终 broker 收到的 modifiedInput 中不含该题。
// 副作用：写状态；最后一题跳过后同样进入复核页。
function skipQuestionAnswer(
  state: QuestionPromptState,
  update: (recipe: (draft: QuestionPromptState) => void) => void,
  setStatus: (status: string) => void,
): void {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;

  update((draft) => {
    const target = draft.input.questions[draft.currentQuestionIndex];
    if (!target) return;
    // 焦点只服务键盘导航；显式跳过必须清除该题已有草稿并推进，
    // 不能把焦点选项或本地化的“跳过”文案写进共享 answers 契约。
    delete draft.answers[target.question];
    delete draft.annotations[target.question];
    delete draft.multiSelections[target.question];
    delete draft.otherText[target.question];
    if (draft.currentQuestionIndex >= draft.input.questions.length - 1) {
      draft.reviewing = true;
    } else {
      draft.currentQuestionIndex += 1;
      draft.selectedOptionIndex = 0;
    }
  });
  setStatus(
    state.currentQuestionIndex >= state.input.questions.length - 1
      ? "Review answers, then press Enter to submit."
      : "Question skipped.",
  );
}

// 拒绝整个提问：先 cleanup 再 resolve(deny)，随后把该项移出队列并更新状态栏。
// 副作用：调用 broker 回调（只应发生一次）；即使 resolve 抛错也不影响队列移除的语义。
function denyQuestion(
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  approval.cleanup();
  approval.resolve({
    decision: "deny",
    reason: "Denied in TUI",
    resolvedAt: new Date(),
  });
  setApprovalQueue((current) => current.filter((item) => item !== approval));
  setStatus("Clarification declined.");
}

// 深拷贝可变部分（answers/annotations/multiSelections/otherText），
// 其余标量字段浅拷贝即可；保证 update 的 recipe 不会污染上一帧状态。
function cloneQuestionState(state: QuestionPromptState): QuestionPromptState {
  return {
    ...state,
    annotations: { ...state.annotations },
    answers: { ...state.answers },
    multiSelections: Object.fromEntries(
      Object.entries(state.multiSelections).map(([key, value]) => [key, [...value]]),
    ),
    otherText: { ...state.otherText },
  };
}

// 切换当前题的多选勾选：选中项索引等于 options.length 时代表“Other”标签。
// 用 Set 去重后写回数组，保持勾选顺序稳定；空标签（选项缺失）不写入。
function toggleQuestionSelection(state: QuestionPromptState): void {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return;
  const label =
    state.selectedOptionIndex === question.options.length
      ? "Other"
      : question.options[state.selectedOptionIndex]?.label;
  if (!label) return;
  const current = new Set(state.multiSelections[question.question] ?? []);
  if (current.has(label)) current.delete(label);
  else current.add(label);
  state.multiSelections[question.question] = [...current];
}

// 汇总当前题的最终答案：
// - 单选：取选中项标签（索引越界或未选返回空列表）；
// - 多选：取已勾选标签（可能为空数组）；
// - “Other”标签替换为 otherText 中已填写的文本。
// 返回 undefined 表示无法构成有效答案（无任何非空白文本），由调用方提示用户。
// annotation 仅在存在 preview 时生成，多个 preview 以空行拼接，供上层展示推荐说明。
function answerCurrentQuestion(
  state: QuestionPromptState,
): { annotation?: AskUserQuestionAnnotation; answer: string } | undefined {
  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) return undefined;

  const selectedLabels = question.multiSelect
    ? state.multiSelections[question.question] ?? []
    : [
        state.selectedOptionIndex === question.options.length
          ? "Other"
          : question.options[state.selectedOptionIndex]?.label,
      ].filter((label): label is string => Boolean(label));

  const answers = selectedLabels
    .map((label) => (label === "Other" ? state.otherText[question.question] : label))
    .filter((label): label is string => Boolean(label && label.trim().length > 0));
  if (answers.length === 0) return undefined;

  const previews = selectedLabels
    .map((label) => question.options.find((option) => option.label === label)?.preview)
    .filter((preview): preview is string => Boolean(preview));

  return {
    annotation:
      previews.length > 0
        ? {
            preview: previews.join("\n\n"),
          }
        : undefined,
    answer: answers.join(", "),
  };
}
