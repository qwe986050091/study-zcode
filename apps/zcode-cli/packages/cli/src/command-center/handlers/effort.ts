import type { TuiSubmitPromptResult } from "@zcode/tui";
import { thoughtLevelsToEffortOptions } from "../effort-options.js";
import { rememberCurrentModelSelection } from "../model-selection.js";
import type { CommandCenterDeps } from "../types.js";

// /effort 用法提示常量：与可用命令名保持同步，避免分散字面量。
const EFFORT_COMMAND_USAGE = "Use /effort <level>, /variant <level>, or /effort list.";

// 处理 /effort（及别名 /variant）：无参数或 "list" 展示当前档位与可选列表；带参数则切换档位。
// 切换成功会尝试持久化模型选择（失败仅返回 warn 后缀，不改变已生效状态）；失败保留原档位并提示可用值。
// 该能力缺失、当前模型无档位时降级为提示文本，均返回结果对象而非抛错。
export async function handleEffortCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const current = app.getThoughtLevel?.();
  const levels = app.listThoughtLevels ? await app.listThoughtLevels() : undefined;
  const effortOptions = levels
    ? thoughtLevelsToEffortOptions(levels, app.getLocale?.())
    : undefined;

  if (!app.getThoughtLevel || !app.listThoughtLevels || !app.setThoughtLevel || !levels) {
    return {
      mode: deps.getMode?.(),
      response: "Reasoning effort selection is not available in this client.",
    };
  }

  if (levels.length === 0) {
    // 模型存在但不支持思考档位：返回空列表 + 当前值，避免 UI 误显示可切换。
    return {
      mode: deps.getMode?.(),
      response: "Reasoning effort selection is not available for the current model.",
      ...(effortOptions ? { effortOptions } : {}),
      thoughtLevel: current,
    };
  }

  const normalizedArgs = args.trim();

  if (normalizedArgs.length === 0) {
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: formatEffortList(current, levels),
      thoughtLevel: current,
    };
  }

  if (normalizedArgs.toLowerCase() === "list") {
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: formatEffortList(current, levels),
      thoughtLevel: current,
    };
  }

  const requested = resolveRequestedLevel(normalizedArgs, levels) ?? normalizedArgs;

  try {
    const result = await app.setThoughtLevel(requested);
    const persistenceWarning = await rememberCurrentModelSelection(app, deps);
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: `Reasoning effort switched to ${result.thoughtLevel}.${persistenceWarning}`,
      thoughtLevel: result.thoughtLevel,
    };
  } catch (error) {
    // 切换失败不改变当前档位：把错误文本与可用值一并回给用户，保持可恢复状态。
    const message = error instanceof Error ? error.message : String(error);
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: `Unable to switch reasoning effort: ${message}. Available efforts: ${levels.join(", ")}.`,
      thoughtLevel: current,
    };
  }
}

// 渲染档位列表：首行当前值（未选显示 "not selected"），随后逐项标记 (current)，末行附用法。
function formatEffortList(current: string | undefined, levels: readonly string[]): string {
  return [
    `Current reasoning effort: ${current ?? "not selected"}.`,
    "Available reasoning efforts:",
    ...levels.map((level) => `- ${level}${level === current ? " (current)" : ""}`),
    EFFORT_COMMAND_USAGE,
  ].join("\n");
}

// 在合法档位中做大小写不敏感匹配，返回目录中的规范值；未命中返回 undefined，由调用方原样透传。
function resolveRequestedLevel(args: string, levels: readonly string[]): string | undefined {
  const requested = args.trim();
  return levels.find(
    (level) => level === requested || level.toLowerCase() === requested.toLowerCase(),
  );
}
