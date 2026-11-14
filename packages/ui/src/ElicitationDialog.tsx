// ============================================================================
// ElicitationDialog.tsx — 阻塞式问答（AskUserQuestion / ExitPlanMode）的交互层
//
// 位置：Agent 发起 elicit 请求后，由对话流渲染这张卡片；用户的每次选择都直接
// 写回协议（onRespond），本文件不持有任何需要持久化的业务状态。
//
// 本文件同时服务两种语义，混用会立刻产生错答：
//   普通问答：可选澄清，空答案表示「跳过，由 Agent 自行判断」；
//   计划审批（ExitPlanMode）：空答案表示「拒绝」，主按钮必须显式提交 approve。
//
// 本地状态只有三类，且全部属于「表单进度」：
//   questionIndex / activeOptionIndex：导航位置；
//   drafts：每题的选择与自定义输入；
//   isQuestionExpanded / isDialogExpanded：移动端折叠态。
//
// INV 不变量表（每条注明守住它的位置）
// INV-01 requestId 是表单实例身份：外层必须以 requestId 作 key 重建子组件。
//         守住：ElicitationDialog 的 return 语句。
// INV-02 drafts 以 question.key 为键，key 必须含题号，重复题面不得互相覆盖。
//         守住：normalizeElicitationQuestions 的 key 拼装。
// INV-03 单选模式下写自定义输入必须清空 selectedValues，两者不能同时存在。
//         守住：updateCustomAnswer 的 selectedValues 三元。
// INV-04 只有最后一题算 submit，其余一律 next；判定只看题号，不看答案是否为空。
//         守住：getElicitationQuestionAdvanceKind。
// INV-05 空答案不得伪造偏好：没有答案的题不写进 content。
//         守住：buildElicitationResponseContent 的 length > 0 过滤。
// INV-06 计划审批的空答案在协议里是拒绝，主按钮必须显式提交 approve。
//         守住：continueOrSubmit 的 isPlanApproval 前置分支。
// INV-07 IME 组合态下 Enter 只确认候选词，不提交、不导航。
//         守住：resolveElicitationCustomInputKeyAction 首行的 IME 短路。
// INV-08 自定义输入框内也必须能用方向键离开（映射为选项移动），否则会困在输入框。
//         守住：ArrowUp / ArrowDown 两条分支。
// INV-09 Escape 语义：非 plan 且有上题则返回上一题，否则 dismiss。
//         守住：resolveElicitationCustomInputKeyAction 与两处 onKeyDown 的同构判断。
// INV-10 activeOptionIndex 为 -1 表示「无活动项」，不得预选任何选项。
//         守住：getPreferredActiveOptionIndex 末尾返回 -1。
// INV-11 焦点移动用 rAF 排队，且必须在 cleanup 里 cancel。
//         守住：两处 useEffect 的 frameId。
// INV-12 倒计时只在最后 60 秒内显示；snoozed 或已过期一律返回 null。
//         守住：getElicitationCountdownSeconds 的两个前置 return。
// INV-13 页面隐藏时不调度倒计时，回到前台靠 focus / visibilitychange 重新对齐。
//         守住：schedule 里的 visibilityState 判断。
// INV-14 首次交互上报必须幂等；上报失败（false 或抛错）要重置闸门以便下次重试。
//         守住：reportFirstInteraction 的 try/catch 与 then/catch。
// INV-15 多选 Enter 是「确认并推进」，单选 Enter 是「选中当前项」。
//         守住：handleOptionKeyDown 的 Enter 分支。
// INV-16 自定义输入只有 trim 后非空才算「已作答」。
//         守住：renderCustomInput 的 isSelected 与 getQuestionAnswers。
// INV-17 题号计数最小值是 1：零题时显示 1 / 1，不能显示 0 / 0。
//         守住：两处 Math.max(questions.length, 1)。
// INV-18 卡片与选项按钮的 tabIndex 互斥：有活动项时卡片退出 tab 序。
//         守住：cardRef 的 tabIndex 与 renderOption 的 tabIndex。
// INV-19 onFormDraftChange 只上报，不回写本地 drafts（否则形成双向同步环）。
//         守住：上报 effect 内没有 setDrafts。
// INV-20 归一化后的选项 label 为空时回退为 value，展示层不需要再判空。
//         守住：normalizeElicitationQuestions 的 label 兜底。
// ============================================================================
/* eslint-disable max-lines */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ZCodeElicitationQuestion, ZCodeElicitationRequest } from "@zcode/shared";
import type { InteractionAutoResolution } from "@zcode/shared/zcode-protocol-v4";
import { CheckIcon, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";

// props 全为受控：组件不缓存 request，也不保留「上次回答」。
// onRespond 是唯一出口，三态 accept / decline / cancel 分别对应提交、拒绝与关闭。
// initialFormDraft 用于跨窗口恢复，只在挂载时读取一次（见 useState 惰性初始化）。
interface ElicitationDialogProps {
  // 只读输入。除 useMemo 的 questions 外不缓存任何派生结构：
  // requestId 变化时整个实例会被 key 重建，缓存反而会成为陈旧数据。
  request: ZCodeElicitationRequest;
  autoResolution?: InteractionAutoResolution;
  onRespond: (
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => void;
  /** 普通 AskUserQuestion 首次暂停来源；失败返回 false 后允许下一次操作重试。 */
  onFirstInteraction?: (
    source: ElicitationAutoResolutionSnoozeSource,
  ) => boolean | void | Promise<boolean | void>;
  // 跨窗口恢复用的快照，只在挂载期读取一次。
  // 运行期变更不回灌表单 —— 否则会覆盖用户正在编辑的内容。
  initialFormDraft?: ElicitationFormDraft;
  onFormDraftChange?: (requestId: string, draft: ElicitationFormDraft) => void;
}

// source 是埋点维度，不是行为分支：四种来源都执行同一个「停止自动结束」动作。
// 新增来源时只需扩展联合类型，不要在 reportFirstInteraction 里按 source 分流。
export type ElicitationAutoResolutionSnoozeSource =
  | "panelHover"
  | "answer"
  | "navigation"
  | "countdown";

// 只在最后 60 秒显示倒计时：更早显示会制造时间压力，并挤占标题行的横向空间。
// 这个阈值同时决定「何时开始按秒调度」，改大意味着更长时间的高频 timer。
const ELICITATION_FINAL_MINUTE_MS = 60_000;
// 协议约定的 approve 选项值；改这里必须同步服务端与旧客户端的解析。
const PLAN_APPROVAL_APPROVE_VALUE = "approve";

// 把绝对 deadline 换算成「还要几秒」。返回 null 表示「不显示倒计时」，而不是 0。
// Math.max(1, ...)：剩余不足 1 秒时仍显示 1，避免出现「0 秒」这种看起来已失效的状态。
export function getElicitationCountdownSeconds(
  autoResolution: InteractionAutoResolution | undefined,
  now: number,
): number | null {
  // snoozed 是用户已经交互过的状态：此时自动结束已取消，倒计时必须消失而不是继续倒数。
  if (!autoResolution || autoResolution.state === "snoozed") return null;
  // 用绝对 deadline 现算，而不是维护本地倒计时变量：
  // 跨窗口、休眠唤醒、系统时间调整后都能自动对齐，不需要持久化剩余秒数。
  const remainingMs = autoResolution.deadlineAt - now;
  if (remainingMs <= 0 || remainingMs >= ELICITATION_FINAL_MINUTE_MS) return null;
  return Math.max(1, Math.floor(remainingMs / 1_000));
}

// 调度与展示必须共用同一套边界，否则会出现「显示 12 秒但 5 秒后才刷新」。
// 剩余超过 1 分钟时不做秒级轮询：只等到「进入最后一分钟」的那一刻，
// 这样长 deadline 的任务不会被无意义的 tick 拖住主线程。
// 最后阶段对齐到秒边界（提前 1ms 唤醒），保证秒数跳变与真实时间一致。
function getElicitationCountdownRefreshDelay(
  autoResolution: InteractionAutoResolution | undefined,
  now: number,
): number | null {
  if (!autoResolution || autoResolution.state === "snoozed") return null;
  // 超过 1 分钟时只安排一次「进入最后一分钟」的唤醒：
  // 长 deadline 不应该产生秒级 timer，否则一个挂起的请求会持续占据事件循环。
  const remainingMs = autoResolution.deadlineAt - now;
  if (remainingMs <= 0) return null;
  if (remainingMs >= ELICITATION_FINAL_MINUTE_MS) {
    return remainingMs - (ELICITATION_FINAL_MINUTE_MS - 1);
  }
  // 取整到秒后提前 1ms 唤醒，保证显示的秒数与真实剩余时间同步跳变；
  // 不提前的话会因为渲染耗时累积出可见的延迟漂移。
  const seconds = Math.max(1, Math.floor(remainingMs / 1_000));
  if (seconds <= 1) return remainingMs;
  return Math.max(1, remainingMs - (seconds * 1_000 - 1));
}

// [资源] 单飞 timer 链：每次 schedule 先清旧 timer，再按需排下一个；不存在并行 tick。
// 依赖数组刻意用三个标量（state / startedAt / deadline 或 snoozedAt），
// 而不是整个 autoResolution 对象：投影每次重建都会换引用，会导致 timer 反复重置。
// clockNow 只是「触发重渲染的时钟快照」，真实剩余时间永远由 Date.now() 现算。
function useElicitationCountdownSeconds(autoResolution: InteractionAutoResolution | undefined) {
  // 惰性初始化：把函数本身传给 useState，避免每次渲染都调用 Date.now 并产生新初值。
  const [clockNow, setClockNow] = useState(Date.now);

  useEffect(() => {
    if (!autoResolution || autoResolution.state === "snoozed") return;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      const now = Date.now();
      setClockNow(now);
      // 后台标签页不排 timer：浏览器会限流，累积的 tick 反而会在回到前台时集中触发。
      // 回到前台由 focus 与 visibilitychange 两个监听重新 schedule，等价于一次补课。
      if (document.visibilityState === "hidden") return;
      const delay = getElicitationCountdownRefreshDelay(autoResolution, now);
      if (delay !== null) {
        timeoutId = window.setTimeout(schedule, delay);
      }
    };
    // 首次立即执行一次：不只为了拿到初始秒数，也为了在挂载后立刻建立 timer 链。
    // 如果只在监听器里调度，页面从未获得焦点时倒计时永远不会开始。
    schedule();
    // focus 与 visibilitychange 绑定同一个 schedule：只绑其中一个，从后台切回时会少一次补课。
    // 两个监听都必须在 cleanup 里成对移除，否则跨请求复用时会叠加多个 timer 链。
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [
    autoResolution?.state,
    autoResolution?.startedAt,
    autoResolution?.state === "snoozed" ? autoResolution.snoozedAt : autoResolution?.deadlineAt,
  ]);

  return getElicitationCountdownSeconds(autoResolution, clockNow);
}

// key 形如 index:question：题号在前保证唯一性。
// 只用题面做 key 会让重复提问（例如两次「是否继续」）共享同一份草稿，答案会串台。
export interface NormalizedElicitationQuestion extends ZCodeElicitationQuestion {
  key: string;
}

// 单题草稿：多选时 selectedValues 可以有多个，单选时最多一个；customAnswer 与选项互斥由调用方维护。
export interface AnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export type DraftState = Record<string, AnswerDraft>;

export type ElicitationCustomInputKeyAction =
  | "advance"
  | "submit"
  | "previous"
  | "dismiss"
  | "previousOption"
  | "nextOption";

// 纯函数：把键盘事件翻译成动作，不接触 DOM 也不读组件状态，便于单测覆盖边界。
// 决策顺序固定为 IME → 方向键 → Enter → Escape：
// IME 必须最先判，否则组词过程中的方向键会去移动选项；
// 方向键先于 Enter，是为了在输入框内也能离开（INV-08）。
export function resolveElicitationCustomInputKeyAction(event: {
  key: string;
  advanceKind?: "next" | "submit";
  ctrlKey?: boolean;
  metaKey?: boolean;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  isPlanApproval?: boolean;
  hasPreviousQuestion?: boolean;
}): ElicitationCustomInputKeyAction | null {
  // 自定义回答使用可自动换行的文本框；普通 AskUserQuestion 的 Enter 跟随当前题目的
  // 推进/提交语义，ExitPlanMode 属于计划审批边界，裸 Enter 才能直接提交。
  // 中文输入法用 Enter 确认候选时仍属于 composition，不能误提交给 agent。
  // 三重判定（compositionActive、isComposing、nativeEvent.isComposing）见 isImeComposingKeyEvent；
  // 这里只做短路，不重复实现判断，避免两处口径漂移。
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  // 原因：输入框也是末尾选项；只处理 Enter/Escape 会让上下键进入后无法离开。
  // 导航复用选项焦点索引，并放在 IME 检查后，避免组词选候选时跳走。
  // 方向键在输入框内映射为选项移动；返回专用动作名，由调用方 preventDefault 后交给 moveSelection。
  if (event.key === "ArrowUp") return "previousOption";
  if (event.key === "ArrowDown") return "nextOption";

  // Ctrl / Cmd / 计划审批下裸 Enter 都是直接提交：前者是显式加速键，后者是审批的默认意图。
  // 其余情况跟随 advanceKind：中间题往前，最后一题提交。
  if (event.key === "Enter") {
    if (event.ctrlKey || event.metaKey || event.isPlanApproval) {
      return "submit";
    }
    return event.advanceKind === "submit" ? "submit" : "advance";
  }

  // 非 plan 且有上题时 Escape 是「返回上一题」，不是取消整个请求：
  // 用户想改上一题答案时，误取消会让 Agent 收到拒绝。
  if (event.key === "Escape") {
    if (!event.isPlanApproval && event.hasPreviousQuestion) {
      return "previous";
    }
    return "dismiss";
  }

  return null;
}

// 统一两种协议形态：新协议带 questions 数组，旧协议只有单题的 options。
// request.questions 为空数组时用 message/header/options 合成单题数组，下游只面对统一结构。
// label 为空时回退 value：展示层永远有可显示文本，不会出现空按钮。
export function normalizeElicitationQuestions(
  request: ZCodeElicitationRequest,
): NormalizedElicitationQuestion[] {
  // questions 为空数组也走回退分支：空数组与缺省在 UI 上应表现一致（都渲染单题）。
  const sourceQuestions =
    request.questions && request.questions.length > 0
      ? request.questions
      : [
          {
            question: request.message,
            header: request.header ?? request.message,
            options: request.options,
            ...(request.multiSelect ? { multiSelect: true } : {}),
          },
        ];

  return sourceQuestions.map((question, index) => ({
    key: `${index}:${question.question}`,
    question: question.question,
    header: question.header,
    // 选项按原顺序保留：顺序即编号，也是用户对「第几项」的心理预期。
    // value 是身份与提交值，label 只影响展示；不要在归一化里排序或去重。
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label || option.value,
      description: option.description,
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}

// 显式排除数组：schema 只可能是对象，数组会被 Object 判断误认为 record。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 两个条件必须同时成立：interaction 是 plan_approval，且来源工具是 ExitPlanMode。
// 只看 interaction 会把其他审批类请求误判成计划审批，从而改变空答案的语义（INV-06）。
function isPlanApprovalElicitationRequest(request: ZCodeElicitationRequest): boolean {
  const schema = request.schema;
  return (
    isRecord(schema) && schema.interaction === "plan_approval" && schema.toolName === "ExitPlanMode"
  );
}

// 从服务端回传的 answerDrafts 恢复草稿，兼容两代键名：answer_i 与纯数字字符串。
// 命中选项的值进 selectedValues；其余值合并进 customAnswer：
// 这样已删除的选项不会凭空出现在选中态，但仍能作为自由文本保留。
export function createInitialElicitationDrafts(
  questions: readonly NormalizedElicitationQuestion[],
  request: ZCodeElicitationRequest,
): DraftState {
  return Object.fromEntries(
    questions.map((question, index) => {
      // 两代键名兼容（answer_0 与纯数字字符串），服务端可能只写其中一种。
      // draftValues 是值数组而不是对象，因此无法区分「选项值」与「自定义文本」的原始类型，
      // 只能按「是否命中当前选项集」来分流。
      const draftValues =
        request.answerDrafts?.[`answer_${index}`] ?? request.answerDrafts?.[String(index)] ?? [];
      const optionValues = new Set(question.options.map((option) => option.value));
      const selectedValues = draftValues.filter((value) => optionValues.has(value));
      const customAnswer = draftValues.filter((value) => !optionValues.has(value)).join(", ");
      return [question.key, { selectedValues, customAnswer }];
    }),
  );
}

// 越界不是错误：跨窗口恢复时题数可能已变，钳制到合法区间比归零更贴近用户预期。
function normalizeInitialQuestionIndex(
  request: ZCodeElicitationRequest,
  questions: readonly NormalizedElicitationQuestion[],
) {
  if (questions.length === 0) {
    return 0;
  }
  const index = request.currentQuestionIndex;
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return 0;
  }
  return Math.max(0, Math.min(index, questions.length - 1));
}

// 选项数 + 1：自定义输入行在键盘导航里占一个位置，必须与按钮一起环形移动。
function getQuestionOptionCount(question: NormalizedElicitationQuestion | undefined) {
  if (!question) {
    return 0;
  }
  return question.options.length + 1;
}

// 切题时恢复「上次停留位置」：已选项优先，其次是非空自定义输入。
// 两者都没有时返回 -1 而不是 0：预选会让焦点色被误读为「已选中」（INV-10）。
function getPreferredActiveOptionIndex(
  question: NormalizedElicitationQuestion | undefined,
  drafts: DraftState,
) {
  if (!question) {
    return 0;
  }
  // 只取第一条选中值恢复焦点：多选场景下它是最先被勾选的那一项，
  // 与「上次停留位置」的重合度最高。
  const draft = drafts[question.key];
  const selectedValue = draft?.selectedValues[0];
  if (selectedValue) {
    const selectedIndex = question.options.findIndex((option) => option.value === selectedValue);
    if (selectedIndex >= 0) {
      return selectedIndex;
    }
  }
  // 自定义输入非空时焦点落到最后一行（输入框本身），避免切题后还要再按一次 Tab。
  if (draft?.customAnswer.trim()) {
    return question.options.length;
  }
  // 不预选任何选项，避免用户将键盘焦点（bg-hover）误认为"已选中"。
  // 用户必须通过方向键导航或点击才能聚焦选项，聚焦后点继续/提交才会自动补选。
  return -1;
}

// 顺序固定为「先选项、后自定义」：提交给 Agent 的数组顺序即阅读顺序。
// customAnswer 按 trim 判空：只有空格不构成一条答案（INV-16）。
function getQuestionAnswers(question: NormalizedElicitationQuestion, drafts: DraftState): string[] {
  const draft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  const customAnswer = draft.customAnswer.trim();
  return [...draft.selectedValues, ...(customAnswer ? [customAnswer] : [])];
}

// 一次请求同时输出三种键，都是为了兼容不同年代的 agent 读取路径：
// answers（以题面为键）、answer_i（以题号为键）、answer（仅单题）。
// answers/answer_i/answer 只为非空 getQuestionAnswers 结果写入，下游可用键是否存在判断作答。
// 多选题写数组，单选题写标量：这是协议差异，不是风格选择。
export function buildElicitationResponseContent(
  questions: readonly NormalizedElicitationQuestion[],
  drafts: DraftState,
): Record<string, unknown> {
  // AskUserQuestion 是可选澄清，不是必填表单。只提交用户真实提供的答案，
  // 避免用空字符串伪造偏好；部分或空 answers 由 Agent 使用最佳判断继续。
  // flatMap + 空数组的技巧用于「过滤并映射」：没有答案的题直接不产生键，而不是产生空值。
  const answers = Object.fromEntries(
    questions.flatMap((question) => {
      const questionAnswers = getQuestionAnswers(question, drafts);
      return questionAnswers.length > 0 ? [[question.question, questionAnswers.join(", ")]] : [];
    }),
  );
  const content: Record<string, unknown> = { answers };

  questions.forEach((question, index) => {
    const questionAnswers = getQuestionAnswers(question, drafts);
    if (questionAnswers.length > 0) {
      content[`answer_${index}`] = question.multiSelect ? questionAnswers : questionAnswers[0];
    }
  });

  // 兼容旧版单题 agent 读取 { answer } 的路径。
  // 只有单题时才写 answer：多题场景写这个键会让旧 agent 只看到第一题的答案。
  const onlyQuestion = questions.length === 1 ? questions[0] : undefined;
  if (onlyQuestion) {
    const questionAnswers = getQuestionAnswers(onlyQuestion, drafts);
    if (questionAnswers.length > 0) {
      content.answer = onlyQuestion.multiSelect ? questionAnswers : questionAnswers[0];
    }
  }

  return content;
}

// 选项变更的唯一入口，保持不可变更新（返回新 drafts）。
// 多选是切换语义；单选是替换语义，并且必须清空 customAnswer ——
// 否则用户先输入自定义文本再点选项时，会同时提交两个答案。
export function updateElicitationDraftsForOption(
  drafts: DraftState,
  question: NormalizedElicitationQuestion,
  optionValue: string,
): DraftState {
  const currentDraft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  // 三元两分支的字段集合不同：单选分支只保留 selectedValues 与空的 customAnswer。
  const nextDraft = question.multiSelect
    ? {
        ...currentDraft,
        selectedValues: currentDraft.selectedValues.includes(optionValue)
          ? currentDraft.selectedValues.filter((value) => value !== optionValue)
          : [...currentDraft.selectedValues, optionValue],
      }
    : { selectedValues: [optionValue], customAnswer: "" };
  return {
    ...drafts,
    [question.key]: nextDraft,
  };
}

// getElicitationQuestionAdvanceKind 只看 questionIndex 与 questions.length，空答案同样走到最后一题。
export function getElicitationQuestionAdvanceKind(
  questions: readonly NormalizedElicitationQuestion[],
  questionIndex: number,
): "next" | "submit" {
  return questionIndex >= questions.length - 1 ? "submit" : "next";
}

// [权衡] 外层只做一件事：用 requestId 作 key 强制重建表单实例。
// 不能按 request 对象引用重置：普通问答首次交互会把 autoResolution 改为 snoozed，
// 投影因此重建 request 对象，若以引用为界，本地题号与草稿会被清空并跳回第一题。
// 代价是同 requestId 下无法「重置表单」，这由服务端重新发请求（新 requestId）解决。
export function ElicitationDialog(props: ElicitationDialogProps) {
  // 普通 AskUserQuestion 首次操作会把 autoResolution 从计时态更新为
  // snoozed，投影因此重建 request 对象，但业务 requestId 没变。若按 request/questions
  // 引用重置，本地 questionIndex 和 drafts 会被误清空并跳回第一题。
  // 用 key 把本地表单实例绑定到协议身份：同一请求保留进度，新请求才完整初始化。
  // 只透传，不做状态提升：任何在两层之间缓存的值都会绕过 key 的重建语义。
  return <ElicitationDialogContent key={props.request.requestId} {...props} />;
}

// 真正的表单实现。挂载即意味着一份新的请求，所有本地状态都从 props 与 initialFormDraft 初始化。
function ElicitationDialogContent({
  request,
  autoResolution,
  onRespond,
  onFirstInteraction,
  initialFormDraft,
  onFormDraftChange,
}: ElicitationDialogProps) {
  const { intl } = useZCodeIntl();
  // 依赖 request 引用即可：外层 key 已保证「同 requestId 不重建」，
  // 因此这里只会在新请求或有意义的投影变更时重算。
  const questions = useMemo(() => normalizeElicitationQuestions(request), [request]);
  // 恢复优先：跨窗口带回的 questionIndex 高于协议里的 currentQuestionIndex。
  const [questionIndex, setQuestionIndex] = useState(
    () => initialFormDraft?.questionIndex ?? normalizeInitialQuestionIndex(request, questions),
  );
  // 计划审批默认聚焦第一项（0），普通问答默认无活动项（-1）。
  // 这是唯一一处在挂载期就预选的位置：审批语义下「批准」是最常见选择。
  const [activeOptionIndex, setActiveOptionIndex] = useState(() =>
    isPlanApprovalElicitationRequest(request) ? 0 : -1,
  );
  // 草稿恢复优先于协议 draft：本地未提交的编辑不应该被服务端快照覆盖。
  const [drafts, setDrafts] = useState<DraftState>(
    () => initialFormDraft?.drafts ?? createInitialElicitationDrafts(questions, request),
  );
  // isQuestionExpanded 初值 false；折叠样式仅 max-md 生效，桌面端问题始终完整显示。
  const [isQuestionExpanded, setIsQuestionExpanded] = useState(false);
  // 整卡默认展开：桌面端没有折叠入口，初值必须与「用户能看到内容」一致。
  // 手机端折叠只是收起 body，标题与题号仍可见。
  const [isDialogExpanded, setIsDialogExpanded] = useState(true);
  // 按数组索引存 DOM 引用，长度不随选项数收缩：
  // 题数变化时旧引用会残留，但只会被当前索引访问，删除反而增加一次同步负担。
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // customInputRef 同时给键盘导航的末行落点与整行点击聚焦，两处共用同一个 textarea 引用。
  // 两处都必须走同一个 ref，不能再查询 DOM —— 否则多题切换时会命中上一个题的节点。
  // 切题后 ref 会被 React 重新赋值，因此不要在 effect 之外缓存该节点。
  const customInputRef = useRef<HTMLTextAreaElement | null>(null);
  // 卡片容器引用：无活动项时由它接管键盘事件，因此必须可聚焦。
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 必须用 ref：compositionstart/end 与 keydown 在同一事件循环内，setState 尚未生效时会读到旧值。
  const customInputCompositionActiveRef = useRef(false);
  // 首次交互闸门：同一份请求只上报一次，避免鼠标进入卡片后每次移动都触发。
  // 失败时可重置，见 reportFirstInteraction。
  const firstInteractionReportedRef = useRef(false);
  // 返回 null 表示不显示倒计时按钮，调用方不需要再判断状态。
  const countdownSeconds = useElicitationCountdownSeconds(autoResolution);

  useEffect(() => {
    // 只上报，不回写（INV-19）。回写会让服务端快照与本地编辑形成互推，产生抖动。
    // 依赖包含 requestId：跨请求复用组件时若漏掉它，草稿会被写到上一个请求上。
    onFormDraftChange?.(request.requestId, { questionIndex, drafts });
  }, [drafts, onFormDraftChange, questionIndex, request.requestId]);

  // [并发] 同步置位闸门，再调用可能返回 Promise 的回调：
  // 同一事件循环内的第二次点击必须被挡住，因此不能在 await 之后才置位。
  // 返回 false 或抛错都视为「没上报成功」，重置闸门允许下一次操作重试。
  // Promise 与同步返回值用 Promise.resolve 统一处理，不 await，避免阻塞交互。
  const reportFirstInteraction = useCallback(
    (source: ElicitationAutoResolutionSnoozeSource) => {
      // 幂等的第一道闸：已上报就完全不进入异常处理分支，连 catch 都不会触发。
      if (firstInteractionReportedRef.current) return;
      firstInteractionReportedRef.current = true;
      let request: boolean | void | Promise<boolean | void>;
      try {
        request = onFirstInteraction?.(source);
      } catch {
        firstInteractionReportedRef.current = false;
        return;
      }
      void Promise.resolve(request)
        .then((accepted) => {
          if (accepted === false) firstInteractionReportedRef.current = false;
        })
        .catch(() => {
          firstInteractionReportedRef.current = false;
        });
    },
    [onFirstInteraction],
  );

  useEffect(() => {
    // 切题即收起长问题：不同题目的展开态没有继承意义，保留会让新题看起来「默认展开」。
    setIsQuestionExpanded(false);
  }, [questionIndex]);

  // 可能为 undefined（零题或索引越界），后续所有读取都必须容忍这一点。
  const currentQuestion = questions[questionIndex];
  // 当前草稿可能尚不存在（用户从未操作过）。这里给出空对象默认值，
  // 后续渲染统一按「有草稿」处理，减少可选链分支。
  const currentDraft = currentQuestion
    ? (drafts[currentQuestion.key] ?? { selectedValues: [], customAnswer: "" })
    : undefined;
  // 一次计算多处复用：键盘语义、标题文案、默认焦点、空答案处理都依赖它，各处分别计算容易出现口径漂移。
  const isPlanApproval = isPlanApprovalElicitationRequest(request);

  useEffect(() => {
    // 无题或无活动项时不移动焦点：此时应由卡片容器持有焦点（见下一个 effect）。
    if (getQuestionOptionCount(currentQuestion) === 0 || activeOptionIndex < 0) {
      return;
    }
    // rAF 排队等 DOM 更新完成后再聚焦；同步 focus 会作用在旧节点上。
    // cleanup 必须 cancel：快速切题时多次排队会让焦点来回跳。
    // 索引越界时落到自定义输入框：最后一行等价于「自定义答案」。
    const frameId = requestAnimationFrame(() => {
      if (activeOptionIndex < (currentQuestion?.options.length ?? 0)) {
        optionRefs.current[activeOptionIndex]?.focus();
        return;
      }
      customInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [activeOptionIndex, currentQuestion]);

  // 初始 activeOptionIndex=-1 时无按钮有焦点。卡片容器自动聚焦后
  // 可接收键盘事件，在容器层捕获 Tab/↓/↑/Enter 启动导航或推进。
  useEffect(() => {
    // 无活动项时卡片自身获得焦点，才能接收键盘事件启动导航；与按钮焦点互斥（INV-18）。
    if (activeOptionIndex < 0) {
      const frameId = requestAnimationFrame(() => {
        cardRef.current?.focus();
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [activeOptionIndex]);

  // 函数式 setState：连续快速点击时避免基于陈旧 drafts 计算，导致后一次覆盖前一次。
  const updateDraft = useCallback(
    (question: NormalizedElicitationQuestion, updater: (draft: AnswerDraft) => AnswerDraft) => {
      setDrafts((current) => ({
        ...current,
        [question.key]: updater(current[question.key] ?? { selectedValues: [], customAnswer: "" }),
      }));
    },
    [],
  );

  // 输入自定义文本即视为作答，先上报（snooze 自动结束）。
  // 单选模式下同时清空 selectedValues（INV-03）；多选保留已勾选项。
  const updateCustomAnswer = useCallback(
    (question: NormalizedElicitationQuestion, value: string) => {
      reportFirstInteraction("answer");
      updateDraft(question, (draft) => ({
        selectedValues: question.multiSelect ? draft.selectedValues : [],
        customAnswer: value,
      }));
    },
    [reportFirstInteraction, updateDraft],
  );

  // 用调用方传入的草稿而不是 state：最后一题的选择在 setState 尚未刷新时就要提交。
  const submitWithDrafts = useCallback(
    (nextDrafts: DraftState) => {
      const content = buildElicitationResponseContent(questions, nextDrafts);
      onRespond(request.requestId, "accept", content);
    },
    [onRespond, questions, request.requestId],
  );

  // 推进的唯一实现：最后一题直接提交，否则切到下一题并恢复焦点位置。
  // 计划审批切题后若无可恢复位置则聚焦首项（0），普通问答保持 -1。
  // nextDrafts 必须显式传入并用于计算下一题焦点：state 里的 drafts 此刻还是旧值。
  const advanceFromQuestion = useCallback(
    (nextDrafts: DraftState) => {
      // 提交分支必须在 setQuestionIndex 之前返回，否则会出现「先跳题再提交」的闪烁。
      if (getElicitationQuestionAdvanceKind(questions, questionIndex) === "submit") {
        // 最后一题选完要直接提交；这里用传入的最新草稿，避免 React state
        // 尚未刷新时漏掉最后一次选择。
        submitWithDrafts(nextDrafts);
        return;
      }
      // 这里不钳制上界：进入该分支的前提就是「不是最后一题」，额外判断只会掩盖调用方错误。
      const nextIndex = questionIndex + 1;
      setQuestionIndex(nextIndex);
      const preferred = getPreferredActiveOptionIndex(questions[nextIndex], nextDrafts);
      // Plan mode 切题后默认聚焦第一项，与普通问答的"不预选"策略区分。
      setActiveOptionIndex(isPlanApproval && preferred < 0 ? 0 : preferred);
    },
    [questionIndex, questions, submitWithDrafts, isPlanApproval],
  );

  // selectOption 先用 updateElicitationDraftsForOption 落草稿，单选题再调 advanceFromQuestion。
  // 单选立即推进是 AskUserQuestion 的既有交互；多选停留以便继续勾选。
  const selectOption = useCallback(
    (question: NormalizedElicitationQuestion, optionValue: string) => {
      reportFirstInteraction("answer");
      const nextDrafts = updateElicitationDraftsForOption(drafts, question, optionValue);
      setDrafts(nextDrafts);
      if (!question.multiSelect) {
        advanceFromQuestion(nextDrafts);
      }
    },
    [advanceFromQuestion, drafts, reportFirstInteraction],
  );

  // 不预选任何选项（activeOptionIndex 初始 -1），消除"焦点即选中"的 UX 混淆。
  // 用户通过方向键/Tab 将焦点移到某选项后点继续/提交，代表意图选择该选项，此时自动补选。
  // 若用户从未按键导航（activeOptionIndex 仍为 -1），提交空答案即为明确的跳过意图。
  // 「焦点即意图」的补选逻辑，仅用于主按钮与键盘推进：
  // 多选不补选（多选没有隐含唯一答案），无活动项不补选（-1 表示明确跳过），
  // 已有任何答案时也不补选（不覆盖用户输入）。
  // 返回值与 drafts 引用相同即表示「无需更新」，调用方据此跳过 setState。
  const getDraftsWithAutoSelectedOption = useCallback((): DraftState => {
    if (!currentQuestion || currentQuestion.multiSelect) {
      return drafts;
    }
    if (activeOptionIndex < 0) {
      return drafts;
    }
    const draft = drafts[currentQuestion.key];
    const hasAnswer =
      (draft?.selectedValues.length ?? 0) > 0 || (draft?.customAnswer.trim().length ?? 0) > 0;
    if (hasAnswer) {
      return drafts;
    }
    const activeOption = currentQuestion.options[activeOptionIndex];
    if (!activeOption) {
      return drafts;
    }
    return updateElicitationDraftsForOption(drafts, currentQuestion, activeOption.value);
  }, [activeOptionIndex, currentQuestion, drafts]);

  // 返回上一题同样要恢复焦点位置；题号钳制在 0，避免第一题继续后退。
  const goBack = useCallback(() => {
    reportFirstInteraction("navigation");
    const nextIndex = Math.max(questionIndex - 1, 0);
    setQuestionIndex(nextIndex);
    const preferred = getPreferredActiveOptionIndex(questions[nextIndex], drafts);
    // Plan mode 返回上一题后默认聚焦第一项。
    setActiveOptionIndex(isPlanApproval && preferred < 0 ? 0 : preferred);
  }, [drafts, questionIndex, questions, reportFirstInteraction, isPlanApproval]);

  // submit 直接把 drafts 交给 submitWithDrafts，不调 getDraftsWithAutoSelectedOption 补选。
  // 与 continueOrSubmit 的差异是刻意的，不要合并。
  const submit = useCallback(() => {
    reportFirstInteraction("answer");
    submitWithDrafts(drafts);
  }, [drafts, reportFirstInteraction, submitWithDrafts]);

  // dismiss 一律 decline（而不是 cancel）：用户看到了问题并选择不回答，语义上是拒绝而非放弃请求。
  const dismiss = useCallback(() => {
    reportFirstInteraction("answer");
    onRespond(request.requestId, "decline");
  }, [onRespond, reportFirstInteraction, request.requestId]);

  // 翻页按钮复用 goBack，保证与键盘 Escape 的路径完全一致。
  const goPreviousPage = useCallback(() => {
    if (questions.length === 0) {
      return;
    }
    goBack();
  }, [goBack, questions.length]);

  // goNextPage 先用 getDraftsWithAutoSelectedOption 补选，再调 advanceFromQuestion 推进而不提交。
  // 补选失败（引用相同）时跳过 setState，减少一次无意义渲染。
  const goNextPage = useCallback(() => {
    if (questions.length === 0 || questionIndex >= questions.length - 1) {
      return;
    }
    reportFirstInteraction("navigation");
    const nextDrafts = getDraftsWithAutoSelectedOption();
    if (nextDrafts !== drafts) {
      setDrafts(nextDrafts);
    }
    advanceFromQuestion(nextDrafts);
  }, [
    advanceFromQuestion,
    drafts,
    getDraftsWithAutoSelectedOption,
    questionIndex,
    questions.length,
    reportFirstInteraction,
  ]);

  // 主按钮/Enter 的统一入口。计划审批有一处额外分支：
  // 空答案在审批协议里表示拒绝，因此必须显式选中 approve 再走 selectOption，
  // 不能复用普通问答的「空即跳过」语义（INV-06）。
  // 其余情况与 goNextPage 相同：补选 → 推进或提交。
  const continueOrSubmit = useCallback(() => {
    if (
      isPlanApproval &&
      currentQuestion &&
      getQuestionAnswers(currentQuestion, drafts).length === 0
    ) {
      const approveOption = currentQuestion.options.find(
        (option) => option.value === PLAN_APPROVAL_APPROVE_VALUE,
      );
      if (approveOption) {
        // ExitPlanMode 复用普通问答组件，但空答案在计划审批协议里表示拒绝。
        // 主提交按钮没有反馈时必须显式提交 approve，不能继承 AskUserQuestion 的跳过语义。
        // 走 selectOption 而不是直接调 submitWithDrafts：单选选项会触发推进逻辑，提交路径与用户点击完全一致。
        selectOption(currentQuestion, approveOption.value);
        return;
      }
    }
    reportFirstInteraction("navigation");
    const nextDrafts = getDraftsWithAutoSelectedOption();
    if (nextDrafts !== drafts) {
      setDrafts(nextDrafts);
    }
    advanceFromQuestion(nextDrafts);
  }, [
    advanceFromQuestion,
    currentQuestion,
    drafts,
    getDraftsWithAutoSelectedOption,
    isPlanApproval,
    reportFirstInteraction,
    selectOption,
  ]);

  // 环形移动，模运算保证首尾相接；optionCount 已包含自定义输入行。
  // 当前无活动项时按方向落到首或末：首次按 ↓ 应从第 1 项开始，按 ↑ 则从最后一项开始。
  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      const optionCount = getQuestionOptionCount(currentQuestion);
      if (optionCount === 0) {
        return;
      }
      reportFirstInteraction("navigation");
      setActiveOptionIndex((index) => {
        if (index < 0) return direction > 0 ? 0 : optionCount - 1;
        return (index + direction + optionCount) % optionCount;
      });
    },
    [currentQuestion, reportFirstInteraction],
  );

  // 选项按钮上的键盘处理。所有已识别按键都 preventDefault：
  // Space/Enter 若不拦截会触发按钮默认点击并与自定义逻辑叠加成两次选择。
  // Space 在选项区是勾选，在自定义行是聚焦输入框；Enter 在多选是推进、单选是选中。
  // Escape 与卡片层保持同一语义（INV-09）。
  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!currentQuestion) {
        return;
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case " ":
          event.preventDefault();
          if (activeOptionIndex < 0) return;
          if (activeOptionIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[activeOptionIndex];
            if (option) {
              selectOption(currentQuestion, option.value);
            }
          } else {
            customInputRef.current?.focus();
          }
          return;
        case "Enter":
          event.preventDefault();
          if (activeOptionIndex < 0) return;
          // 多选题 Space 勾选/取消勾选，Enter 确认选择并推进/提交。
          // 单选题 Enter 等同 Space，选中当前选项。
          if (currentQuestion?.multiSelect) {
            continueOrSubmit();
          } else if (activeOptionIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[activeOptionIndex];
            if (option) {
              selectOption(currentQuestion, option.value);
            }
          } else {
            customInputRef.current?.focus();
          }
          return;
        case "Escape":
          event.preventDefault();
          if (!isPlanApproval && questionIndex > 0) {
            goBack();
            return;
          }
          dismiss();
          return;
        default:
          return;
      }
    },
    [
      activeOptionIndex,
      continueOrSubmit,
      currentQuestion,
      dismiss,
      goBack,
      isPlanApproval,
      moveSelection,
      questionIndex,
      selectOption,
    ],
  );

  // 输入框内的键盘处理。首行 stopPropagation：否则同一次按键会冒泡到卡片层再执行一遍导航。
  // resolveElicitationCustomInputKeyAction 只返回动作名，handleCustomInputKeyDown 负责执行对应副作用。
  // 任何非空 action 都先上报首次交互：空输入框里按 Esc 切题也是明确操作。
  const handleCustomInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // 阻止冒泡到卡片层：卡片在无活动项时会接管同一按键，
      // 不拦的话一次按键会执行两次导航（一次在输入框，一次在卡片）。
      event.stopPropagation();
      // compositionActive 与 nativeEvent 同时传入，覆盖 React 合成事件与原生事件两条 isComposing 来源。
      const action = resolveElicitationCustomInputKeyAction({
        key: event.key,
        advanceKind: getElicitationQuestionAdvanceKind(questions, questionIndex),
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        compositionActive: customInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
        isPlanApproval,
        hasPreviousQuestion: questionIndex > 0,
      });
      // 方向键移动的是选项焦点，不改变输入内容；preventDefault 阻止光标在 textarea 内跳行。
      if (action === "previousOption" || action === "nextOption") {
        event.preventDefault();
        moveSelection(action === "previousOption" ? -1 : 1);
        return;
      }
      if (action) {
        // 原因：空自定义输入框也允许用 Enter / Esc 切题；这仍是明确的题目导航，
        // 不能因为没有触发 onChange 就继续保留自动结束 deadline。
        reportFirstInteraction("navigation");
      }
      // 只有在存在下一题时才推进；最后一题的空 Enter 不提交，避免误触发送空答案。
      if (action === "advance") {
        event.preventDefault();
        if (getElicitationQuestionAdvanceKind(questions, questionIndex) === "next") {
          advanceFromQuestion(drafts);
        }
        return;
      }
      if (action === "submit") {
        event.preventDefault();
        submit();
        return;
      }
      // 返回上一题时不提交当前题的任何输入，草稿仍保留在 drafts 里。
      if (action === "previous") {
        event.preventDefault();
        // AskUserQuestion 是多题澄清流；中间题按 Esc 应先返回上一题，
        // 避免用户想改上一题答案时把整个阻塞请求取消掉。
        goBack();
        return;
      }
      if (action === "dismiss") {
        event.preventDefault();
        dismiss();
      }
    },
    [
      advanceFromQuestion,
      dismiss,
      drafts,
      goBack,
      isPlanApproval,
      moveSelection,
      questionIndex,
      questions,
      reportFirstInteraction,
      submit,
    ],
  );

  // 选项渲染。可访问性契约：多选 role=checkbox + aria-checked，单选 role=option + aria-selected，
  // 两者不能同时出现，否则读屏器会给出矛盾状态。
  // tabIndex 只允许一个 0：有活动项时就是它，否则让第 1 项进入 tab 序供键盘用户进入列表。
  // onFocus 回写 activeOptionIndex，保证鼠标点击与键盘导航共用同一份焦点状态。
  const renderOption = (
    question: NormalizedElicitationQuestion,
    option: NormalizedElicitationQuestion["options"][number],
    index: number,
  ) => {
    // 用 === true 收敛 undefined：便于 isSelected 在 className 三元里直接参与判断。
    const isSelected = currentDraft?.selectedValues.includes(option.value) === true;
    // 活动态只在有活动项时成立：-1 不能被任何索引匹配，否则会误高亮第一项。
    const isActive = activeOptionIndex >= 0 && activeOptionIndex === index;
    // 只有计划审批的 approve 选项覆盖展示文案，其余选项沿用协议给的 label。
    const optionLabel =
      isPlanApproval && option.value === PLAN_APPROVAL_APPROVE_VALUE
        ? intl.formatMessage({ id: "chat.elicitation.planApproval.approve" })
        : option.label;
    // 描述同 label 一样只做展示覆盖，不改变提交的 value。
    const optionDescription =
      isPlanApproval && option.value === PLAN_APPROVAL_APPROVE_VALUE
        ? intl.formatMessage({
            id: "chat.elicitation.planApproval.approveDescription",
          })
        : option.description;
    return (
      <button
        key={option.value}
        ref={(node) => {
          // 回调式 ref：卸载时 React 会以 null 调用一次，因此数组元素会被写成 null，
          // 这正是期望行为 —— 残留已卸载节点比 null 更危险。
          // 不要在这里做 focus 或状态更新：ref 回调发生在提交阶段，写入 state 会触发额外渲染。
          optionRefs.current[index] = node;
        }}
        type="button"
        // role 必须与下方 aria-selected / aria-checked 成对出现：
        // 改一处会让读屏器状态与视觉选中态互相矛盾。
        role={question.multiSelect ? "checkbox" : "option"}
        aria-selected={question.multiSelect ? undefined : isSelected}
        aria-checked={question.multiSelect ? isSelected : undefined}
        // 无活动项时仅第一项可 tab 进入；一旦有了活动项，焦点职责交给 activeOptionIndex 指向的节点。
        tabIndex={isActive || (activeOptionIndex < 0 && index === 0) ? 0 : -1}
        onClick={() => selectOption(question, option.value)}
        onFocus={() => setActiveOptionIndex(index)}
        onKeyDown={handleOptionKeyDown}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-hover",
          isSelected ? "bg-selected" : isActive ? "bg-hover" : "hover:bg-hover",
        )}
      >
        {question.multiSelect ? (
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm border",
              isSelected
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border text-transparent",
            )}
          >
            <CheckIcon className="size-3" />
          </span>
        ) : (
          <span
            className={cn(
              "w-5 shrink-0 self-center text-ui-base font-medium",
              isSelected ? "text-foreground" : "text-foreground-subtlest",
            )}
          >
            {index + 1}.
          </span>
        )}
        {/* 修复原因：界面字号可动态增大，固定 20px 行高会让大字号文字贴边或裁切。 */}
        <span className="min-w-0 flex-1 text-ui-base leading-normal">
          <span className="text-ui-base font-medium leading-normal text-foreground">
            {optionLabel}
          </span>
          {optionDescription ? (
            <span className="ml-2 text-ui-base leading-normal text-foreground-subtle">
              {optionDescription}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  // 自定义输入行与选项行共享选中/活动样式，但它是 textarea 而非 button。
  // 整行 onClick 聚焦输入框：扩大点击热区，同时内层点击不重复聚焦。
  // isSelected 以 trim 后非空为准（INV-16）。
  const renderCustomInput = (question: NormalizedElicitationQuestion, index: number) => {
    // 同样以 trim 判空：只输入空格不算作答，与提交时的过滤口径一致。
    const isSelected = (currentDraft?.customAnswer.trim().length ?? 0) > 0;
    const isActive = activeOptionIndex >= 0 && activeOptionIndex === index;
    // 原因：计划审批曾隐藏输入序号；所有单选输入行都接续选项编号。
    return (
      <div
        key="custom-input"
        role={question.multiSelect ? "checkbox" : undefined}
        aria-checked={question.multiSelect ? isSelected : undefined}
        onClick={(event) => {
          if (event.target !== customInputRef.current) {
            customInputRef.current?.focus();
          }
        }}
        className={cn(
          "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
          isSelected ? "bg-selected" : isActive ? "bg-hover" : "hover:bg-hover",
        )}
      >
        {question.multiSelect ? (
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm border",
              isSelected
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border text-transparent",
            )}
          >
            <CheckIcon className="size-3" />
          </span>
        ) : (
          <span
            className={cn(
              // 与 textarea 首行使用相同行高并让出 1px 边框，避免顶部或整体居中造成错位。
              "mt-px w-5 shrink-0 self-start text-ui-base font-medium leading-normal md:leading-relaxed",
              isSelected ? "text-foreground" : "text-foreground-subtlest",
            )}
          >
            {index + 1}.
          </span>
        )}
        {/* 原因：按内容增高的输入框没有上限会撑满问答卡片；与权限反馈一致，五行后内部滚动。 */}
        <Textarea
          ref={customInputRef}
          rows={1}
          wrap="soft"
          value={currentDraft?.customAnswer ?? ""}
          placeholder={intl.formatMessage({
            id: "chat.elicitation.customAnswer.placeholder",
          })}
          onFocus={() => setActiveOptionIndex(index)}
          onChange={(event) => updateCustomAnswer(question, event.target.value)}
          // 组合态用 ref 记录（见字段注释）；end 时必须重置，否则后续 Enter 会永远被当作组词。
          onCompositionStart={() => {
            customInputCompositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            customInputCompositionActiveRef.current = false;
          }}
          onKeyDown={handleCustomInputKeyDown}
          className="h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 text-ui-base font-medium leading-normal shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0"
        />
      </div>
    );
  };

  // 翻页按钮的禁用条件必须包含「有题」：零题时两个方向都不能翻。
  const canGoPreviousPage = questions.length > 0 && questionIndex > 0;
  // 与 canGoPreviousPage 对称；两者共同决定翻页按钮的 disabled。
  const canGoNextPage = questions.length > 0 && questionIndex < questions.length - 1;

  // activeOptionIndex=-1 时卡片有焦点，键盘事件到达卡片 onKeyDown。
  // Tab/↓/↑ 聚焦选项，Enter 直接推进到下一题（或提交）。
  // 卡片层键盘处理，只在「无活动项」时接管（首行直接返回）。
  // 它与 handleOptionKeyDown 是同构的两套分支，改动时两边必须同步，
  // 否则焦点在卡片与选项之间切换时会出现行为差异。
  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (activeOptionIndex >= 0) return; // 按钮已有焦点，由按钮 onKeyDown 处理
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          continueOrSubmit();
          return;
        case "Escape":
          // 初始 activeOptionIndex=-1 时卡片接收焦点，Escape 必须
          // 由卡片层处理，与按钮 onKeyDown 保持一致：非 plan mode 有上题则返回，
          // 否则 dismiss。
          event.preventDefault();
          if (!isPlanApproval && questionIndex > 0) {
            goBack();
          } else {
            dismiss();
          }
          return;
        default:
          return;
      }
    },
    [
      activeOptionIndex,
      moveSelection,
      continueOrSubmit,
      isPlanApproval,
      questionIndex,
      goBack,
      dismiss,
    ],
  );

  // 主按钮文案由「是否最后一题」决定：零题也算提交（没有下一题可去）。
  const primaryActionMessageId =
    questions.length === 0 || questionIndex >= questions.length - 1
      ? "chat.elicitation.submit"
      : "chat.elicitation.continue";
  // 计划审批复用权限弹窗的标题与说明文案，避免出现「ExitPlanMode」这种内部工具名。
  // 普通问答直接用题目的 header；缺失时不高亮 badge（渲染处判空）。
  const titleHeader = isPlanApproval
    ? intl.formatMessage({ id: "chat.permission.title" })
    : currentQuestion?.header;
  // 计划审批的说明文案来自权限模块，避免暴露 ExitPlanMode 这类内部工具名。
  // 普通问答缺题面时回退通用标题，保证标题区不为空。
  const titleQuestion = isPlanApproval
    ? intl.formatMessage({ id: "chat.permission.switchMode.placeholder" })
    : (currentQuestion?.question ?? intl.formatMessage({ id: "chat.elicitation.title" }));
  // 只有长题或多行题才提供折叠按钮：短题折叠反而增加一次点击。
  const shouldOfferQuestionCollapse = titleQuestion.length > 80 || titleQuestion.includes("\n");
  // 折叠/展开文案由状态决定，同时用作 aria-label 与可见文本：两处必须同源。
  const questionCollapseLabel = intl.formatMessage({
    id: isQuestionExpanded
      ? "chat.elicitation.collapseQuestion"
      : "chat.elicitation.expandQuestion",
  });
  // 移动端整卡折叠的文案。桌面端不渲染这两个折叠按钮，但文案仍在这里统一取值。
  const dialogCollapseLabel = intl.formatMessage({
    id: isDialogExpanded ? "chat.elicitation.collapseDialog" : "chat.elicitation.expandDialog",
  });
  // 复用任务列表的「停止倒计时」文案，保证同一动作在不同入口的措辞一致。
  const stopCountdownLabel = intl.formatMessage({ id: "taskList.stopCountdown" });
  // 倒计时按钮同时是「停止自动结束」的入口：点击即上报 countdown 来源。
  // data-elicitation-countdown-seconds 供 E2E 断言秒数，不要依赖文案格式。
  const countdownButton =
    countdownSeconds !== null ? (
      <Button
        type="button"
        size="xs"
        variant="secondary"
        data-elicitation-countdown-seconds={countdownSeconds}
        aria-label={stopCountdownLabel}
        title={stopCountdownLabel}
        onClick={() => reportFirstInteraction("countdown")}
        className="min-w-10 px-1.5 tabular-nums text-foreground-subtle"
      >
        {intl.formatMessage(
          { id: "chat.elicitation.countdownSeconds" },
          { seconds: String(countdownSeconds) },
        )}
      </Button>
    ) : null;

  return (
    <div className="w-full shrink-0">
      {/* Bugfix: 手机远控视口较短，长问题和多选项会把按钮顶出弹窗；卡片限高后让内容区内部滚动。 */}
      <div
        ref={cardRef}
        // 卡片只在无活动项时进入 tab 序；否则键盘焦点应落在具体选项上（INV-18）。
        tabIndex={activeOptionIndex < 0 ? 0 : -1}
        data-elicitation-dialog-card="true"
        // 限高 + flex 纵排：手机远控视口较短时，长问题与多选项会把底部按钮顶出可视区，
        // 限高后由 body 内部滚动，操作区始终留在卡片内。
        className="relative z-1 flex w-full max-h-[min(72dvh,42rem)] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-xs outline-none"
        // onMouseEnter 调 reportFirstInteraction("panelHover")，悬停后倒计时不再自动结束弹窗。
        onMouseEnter={() => reportFirstInteraction("panelHover")}
        onKeyDown={handleCardKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div
            // 内容区独立滚动 + overscroll-contain：滚动到底时不再带动外层对话流。
            // 折叠态用 max-md:hidden 隐藏内容区，桌面端由按钮控制展开而不隐藏内容。
            data-elicitation-dialog-body="true"
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1",
              !isDialogExpanded ? "max-md:hidden" : undefined,
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 text-ui-base font-medium leading-5">
                <InteractionRequestOriginBadge origin={request.origin} className="mr-2" />
                {titleHeader ? (
                  <Badge
                    variant="outline"
                    className="mr-2 max-w-40 align-baseline text-ui-base truncate"
                  >
                    {titleHeader}
                  </Badge>
                ) : null}
                {/* Bugfix: 问题不能只放在会截断的标题行；移动端没有 hover，必须在 tag 后直接完整可读。 */}
                <span
                  title={titleQuestion}
                  className={cn(
                    "whitespace-pre-wrap break-words leading-6 text-foreground",
                    shouldOfferQuestionCollapse && !isQuestionExpanded
                      ? "max-md:line-clamp-4"
                      : undefined,
                  )}
                >
                  {titleQuestion}
                </span>
                {shouldOfferQuestionCollapse ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-expanded={isQuestionExpanded}
                    aria-label={questionCollapseLabel}
                    title={questionCollapseLabel}
                    onClick={() => setIsQuestionExpanded((expanded) => !expanded)}
                    className="mt-2 hidden max-md:inline-flex"
                  >
                    {isQuestionExpanded ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                    <span>{questionCollapseLabel}</span>
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-1 text-ui-base font-medium leading-tight text-foreground-subtlest">
                {countdownButton}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-expanded={isDialogExpanded}
                  aria-label={dialogCollapseLabel}
                  title={dialogCollapseLabel}
                  onClick={() => setIsDialogExpanded((expanded) => !expanded)}
                  className="hidden max-md:inline-flex"
                >
                  {isDialogExpanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronUp className="size-3" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  // 第一题禁用上一页；用禁用而不是隐藏，避免标题区左右布局跳动。
                  disabled={!canGoPreviousPage}
                  title={intl.formatMessage({
                    id: "chat.elicitation.previousQuestion",
                  })}
                  aria-label={intl.formatMessage({
                    id: "chat.elicitation.previousQuestion",
                  })}
                  onClick={goPreviousPage}
                >
                  <ChevronLeft className="size-3" />
                </Button>
                <span className="min-w-10 text-center">
                  {`${Math.min(questionIndex + 1, Math.max(questions.length, 1))} / ${Math.max(questions.length, 1)}`}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  // 最后一题禁用下一页：此时推进由主按钮或 Enter 承担，两条路径最终都走 advanceFromQuestion。
                  disabled={!canGoNextPage}
                  title={intl.formatMessage({
                    id: "chat.elicitation.nextQuestion",
                  })}
                  aria-label={intl.formatMessage({
                    id: "chat.elicitation.nextQuestion",
                  })}
                  onClick={goNextPage}
                >
                  <ChevronRight className="size-3" />
                </Button>
              </div>
            </div>

            {currentQuestion ? (
              <div className="space-y-3">
                <div
                  // 多选是 group（可含多个独立 checkbox），单选是 listbox（互斥选项）。
                  // 容器 role 决定读屏器的浏览模式，不能为了省事统一成 listbox。
                  role={currentQuestion.multiSelect ? "group" : "listbox"}
                  aria-label={titleQuestion}
                  className="space-y-1"
                >
                  {currentQuestion.options.map((option, index) =>
                    renderOption(currentQuestion, option, index),
                  )}
                  {renderCustomInput(currentQuestion, currentQuestion.options.length)}
                </div>
              </div>
            ) : (
              <p className="px-1 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "chat.elicitation.noQuestions" })}
              </p>
            )}
          </div>

          {!isDialogExpanded ? (
            <div className="hidden min-w-0 items-center justify-between gap-2 max-md:flex">
              <button
                type="button"
                onClick={() => setIsDialogExpanded(true)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left text-ui-base font-medium text-foreground hover:bg-hover"
              >
                {titleHeader ? (
                  <Badge
                    variant="outline"
                    className="max-w-32 shrink-0 align-baseline text-ui-base truncate"
                  >
                    {titleHeader}
                  </Badge>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{titleQuestion}</span>
              </button>
              {countdownButton}
              <span className="shrink-0 text-ui-base font-medium text-foreground-subtlest">
                {`${Math.min(questionIndex + 1, Math.max(questions.length, 1))} / ${Math.max(questions.length, 1)}`}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-expanded={isDialogExpanded}
                aria-label={dialogCollapseLabel}
                title={dialogCollapseLabel}
                onClick={() => setIsDialogExpanded(true)}
              >
                <ChevronUp className="size-3" />
              </Button>
            </div>
          ) : null}

          <div
            // 底部操作区固定不滚动：滚动的是 body，按钮始终可达。
            // 手机视口很短时这是「能不能点提交」的差别，移动端折叠态会整体隐藏它。
            data-elicitation-dialog-footer="true"
            className={cn(
              "flex shrink-0 items-center justify-between gap-2 px-1 max-sm:flex-wrap",
              !isDialogExpanded ? "max-md:hidden" : undefined,
            )}
          >
            <p className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground-subtle max-sm:basis-full">
              <Info className="size-4 shrink-0 text-foreground" />
              <span className="min-w-0">
                {intl.formatMessage({ id: "chat.elicitation.keyboardHint" })}
              </span>
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" size="lg" variant="outline" onClick={dismiss}>
                {intl.formatMessage({ id: "chat.elicitation.dismiss" })}
              </Button>
              <Button
                type="button"
                size="lg"
                // 零题时直接 submit：此时 continueOrSubmit 会走进「最后一题」分支，行为相同，
                // 但显式区分让「空表单提交」的意图在代码里可读。
                onClick={questions.length === 0 ? submit : continueOrSubmit}
                className="bg-brand text-foreground-inverse hover:bg-brand/80"
              >
                {intl.formatMessage({ id: primaryActionMessageId })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
