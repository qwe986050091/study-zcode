// INV-01 能力先行探测：守住位置 readTarget/setTarget/updateTargetStatus/clearTarget 四方法检查；改错故障 精简客户端上直接抛错。
// INV-02 无参即摘要：守住位置 trimmed.length 判断；改错故障 空 /goal 被当成目标文本写入。
// INV-03 子命令只认首词：守住位置 splitArgs 取 action；改错故障 目标正文含 pause 被误判为子命令。
// INV-04 pause 幂等：守住位置 updateTargetStatus 返回空；改错故障 无目标时报错而非提示。
// INV-05 resume 失败不续跑：守住位置 !target 早退；改错故障 无目标也触发一次空续跑。
// INV-06 clear 如实回报：守住位置 cleared 布尔；改错故障 清空失败仍显示已清除。
// INV-07 replace 前缀剥离：守住位置 replace 正则；改错故障 目标正文残留 "replace"。
// INV-08 replace 空目标拒绝：守住位置 objective.length 判断；改错故障 用空串覆盖既有目标。
// INV-09 覆盖必须二次确认：守住位置 existing 分支；改错故障 误覆盖长程目标与预算。
// INV-10 确认项携带原目标：守住位置 buildTargetReplaceSelection；改错故障 确认界面上看不到将被替换的内容。
// INV-11 变更统一出口：守住位置 continueTargetAfterChange；改错故障 设置与恢复两条路径行为分叉。
// INV-12 续跑透传取消与事件：守住位置 abortSignal / onEvent；改错故障 用户无法中断续跑，UI 收不到流。
// INV-13 Plan 模式不续跑并说明：守住位置 appendPlanModeGoalContinuationNote；改错故障 用户以为已继续。
// INV-14 只做格式化：守住位置 formatTargetChanged；改错故障 展示层做单位换算导致数据失真。
//
// 模块职责：/goal 命令的解析与分发，把目标状态变更收敛到一条统一续跑出口。
// 阅读顺序：先看能力探测与无参摘要，再看四个子命令，最后看覆盖确认与格式化。
import type { TuiSubmitPromptResult } from "@zcode/tui";
import { attachCurrentSessionMetadata } from "../metadata.js";
import { buildTargetReplaceSelection } from "../selections.js";
import type {
  CommandCenterApp,
  CommandCenterDeps,
  CommandCenterTarget,
  TuiSubmitOptions,
} from "../types.js";
import { splitArgs } from "../utils.js";

// Plan 模式下不自动续跑目标的提示文案：目标已记录，但避免在只规划模式下产生写操作。
const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE =
  "Plan mode 下已记录 goal，但不会自动继续。";

// 处理 /goal：无参展示摘要；pause/resume/clear 改写状态；其余文本作为目标，
// 已有目标时先弹出确认选择（除非显式替换）。任何缺失能力都降级为提示文本。
// 副作用：读写目标状态、可能触发一次目标续跑（会提交 prompt 并产生模型事件）。
// 入口先拿 app，再做能力探测。
export async function handleTargetCommand(
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  // trim 之后首尾空白不参与子命令判定。
  const trimmed = args.trim();

  // readTarget/setTarget/updateTargetStatus/clearTarget 缺一即整体降级为提示。
  if (!app.readTarget || !app.setTarget || !app.updateTargetStatus || !app.clearTarget) {
    return {
      mode: deps.getMode?.(),
      response: "Goal management is not available in this client.",
    };
  }

  // 无参数只读摘要，不改状态。
  if (trimmed.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: formatTargetSummary(await app.readTarget()),
    };
  }

  // splitArgs 只取首个词判断是否子命令。
  const [action] = splitArgs(trimmed);
  // pause 分支只改状态，不触发续跑。
  if (action === "pause") {
    const target = await app.updateTargetStatus("paused");
    return {
      mode: deps.getMode?.(),
      response: target ? formatTargetChanged("Goal paused", target) : "No goal to pause.",
    };
  }

  // 恢复后才走统一续跑出口。
  if (action === "resume") {
    const target = await app.updateTargetStatus("active");
    if (!target) {
      return {
        mode: deps.getMode?.(),
        response: "No goal to resume.",
      };
    }
    return continueTargetAfterChange("Goal resumed", target, app, deps, options);
  }

  // clearTarget 的结果按布尔如实回报。
  if (action === "clear") {
    const cleared = await app.clearTarget();
    return {
      mode: deps.getMode?.(),
      response: cleared ? "Goal cleared." : "No goal to clear.",
    };
  }

  // replace 是唯一跳过确认的路径。
  const forceReplace = action === "replace";
  const objective = forceReplace ? trimmed.replace(/^replace\s*/i, "").trim() : trimmed;
  if (forceReplace && objective.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: "Usage: /goal replace <objective>",
    };
  }

  // 非 forceReplace 写入需先 readTarget 检查是否已有目标。
  if (!forceReplace) {
    const existing = await app.readTarget();
    if (existing) {
      // 覆盖目标前必须二次确认：goal 是长程状态，误覆盖会丢失既有目标与预算。
      return {
        mode: deps.getMode?.(),
        response: "A goal already exists. Confirm replacement to overwrite it.",
        selection: buildTargetReplaceSelection(existing, objective),
      };
    }
  }

  // setTarget 落库后立刻进入统一续跑出口。
  const target = await app.setTarget({ objective, status: "active" });
  return continueTargetAfterChange("Goal active", target, app, deps, options);
}

// 目标变更后的统一出口：支持续跑时立即触发一次 continueActiveTarget 并合并 session 元数据；
// 不支持续跑则只返回变更摘要。Plan 模式下续跑被跳过，需在文本中补充说明避免用户误以为已继续。
// 目标变更后的唯一收尾函数。
async function continueTargetAfterChange(
  title: string,
  target: CommandCenterTarget,
  app: CommandCenterApp,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  if (!app.continueActiveTarget) {
    return {
      mode: deps.getMode?.(),
      response: formatTargetChanged(title, target),
    };
  }

  const continuation = await app.continueActiveTarget({
    abortSignal: options.abortSignal,
    onEvent: options.onEvent,
  });
  const response = formatTargetChanged(title, target);
  return continuation
    ? attachCurrentSessionMetadata(continuation, deps, app)
    : {
        mode: deps.getMode?.(),
        response: appendPlanModeGoalContinuationNote(response, deps.getMode?.()),
      };
}

// Plan 模式下追加「不会自动继续」提示；其他模式原样返回，避免噪声。
function appendPlanModeGoalContinuationNote(response: string, mode: string | undefined): string {
  return mode === "plan"
    ? `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`
    : response;
}

// 目标摘要：null 表示当前无目标，给出设置方式；有目标时复用变更格式化并带上 status。
function formatTargetSummary(target: CommandCenterTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatTargetChanged(`Goal ${target.status}`, target);
}

// 目标详情：标题、目标文本；有 token 用量或预算时才输出用量行（预算 null/undefined 显示 none）；
// 时间只在有值时输出，单位为秒。纯格式化，不做单位换算。
// 用量行只在有 token 事实时出现。
function formatTargetChanged(title: string, target: CommandCenterTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget = target.tokenBudget === null || target.tokenBudget === undefined
      ? "none"
      : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}
