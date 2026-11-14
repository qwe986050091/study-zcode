import type { TuiSubmitPromptResult } from "@zcode/tui";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";
import { listAppEffortOptions } from "../effort-options.js";
import { rememberCurrentModelSelection } from "../model-selection.js";
import type { CommandCenterDeps, CommandCenterModelOption } from "../types.js";

// 处理 /model：无参或 "list" 展示当前模型与可选列表（附带档位选项）；
// 带参或带选择器值时解析为 ModelSelection 并切换，成功后尝试持久化选择。
// 切换失败保留原模型并返回错误文本；能力缺失时降级为提示。副作用：写模型偏好、触发生效事件。
export async function handleModelCommand(
  args: string,
  deps: CommandCenterDeps,
  selectedRef?: ModelSelection,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const current = app.getModel?.();
  const options = app.listModels ? await app.listModels() : undefined;

  if (!app.getModel || !app.listModels || !app.setModel || !options) {
    return {
      mode: deps.getMode?.(),
      response: "Model selection is not available in this client.",
    };
  }

  if (!selectedRef && (args.length === 0 || args === "list")) {
    const effortOptions = await listAppEffortOptions(app);
    return {
      ...(effortOptions ? { effortOptions } : {}),
      mode: deps.getMode?.(),
      model: current,
      modelOptions: options,
      response: formatModelList(current, options),
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }

  try {
    const selection = resolveTuiModelSelection(args, options, selectedRef);
    const result = await app.setModel(selection);
    const persistenceWarning = await rememberCurrentModelSelection(app, deps);
    const effortOptions = await listAppEffortOptions(app);
    return {
      ...(effortOptions ? { effortOptions } : {}),
      mode: deps.getMode?.(),
      model: result.model,
      modelOptions: options,
      loginRequired: false,
      response: `Model switched to ${result.model} (${selection.options!.reasoningLevel}).${persistenceWarning}`,
      thoughtLevel: result.thoughtLevel ?? app.getThoughtLevel?.(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to switch model: ${message}`,
      model: current,
      modelOptions: options,
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }
}

/** A deliberate new selection uses the catalog default; restored selections never pass here. */
// 本函数只处理「用户新建选择」：恢复历史选择不走这里，因此可安全使用目录默认档位。
// 解析顺序为 显式选择器值 > provider/model 精确匹配 > 通用 picker 解析；
// 最终校验模型可选中（disabledReason）与推理档位合法，否则抛出用户可读错误。
export function resolveTuiModelSelection(
  args: string,
  options: readonly CommandCenterModelOption[],
  selectedRef?: ModelSelection,
): ModelSelection {
  // Exact catalog matching preserves literal slashes and dollar signs in model IDs.
  // 先按完整 provider/model 精确匹配，避免 picker 解析对含 "/"、"$" 的模型 ID 产生歧义。
  const requested =
    selectedRef ??
    options.find((option) => `${option.ref.providerId}/${option.ref.modelId}` === args)?.ref ??
    parseModelPickerValue(args);
  const option = options.find(
    ({ ref }) => ref.providerId === requested.providerId && ref.modelId === requested.modelId,
  );
  if (!option) throw new Error(`Model is not available: ${args}`);
  if (option.disabledReason) throw new Error(option.disabledReason);
  const reasoningLevel = requested.options?.reasoningLevel ?? option.reasoning?.defaultLevel;
  if (
    !reasoningLevel ||
    !option.reasoning?.levels.some((level) => level.value === reasoningLevel)
  ) {
    throw new Error(
      `Select a supported reasoning effort: ${option.reasoning?.levels.map((level) => level.value).join(", ") || "none available"}`,
    );
  }
  return {
    providerId: requested.providerId,
    modelId: requested.modelId,
    options: { reasoningLevel },
  };
}

// 模型列表文本：首行当前模型（未选显示 not selected）；无候选时给出明确空态；
// 每个候选附 provider 标签与禁用原因，末行提示后续 /model 与 /effort 用法。
function formatModelList(current: string | undefined, options: CommandCenterModelOption[]): string {
  const currentLine = `Current model: ${current || "not selected"}.`;
  if (options.length === 0) {
    return `${currentLine}\nNo selectable models are configured.`;
  }

  const lines = options.map((option) => {
    const id = `${option.ref.providerId}/${option.ref.modelId}`;
    const provider = option.providerLabel ?? option.ref.providerId;
    const disabled = option.disabledReason ? ` — ${option.disabledReason}` : "";
    return `- ${id} (${option.label}; ${provider})${disabled}`;
  });

  return [
    currentLine,
    "Available models:",
    ...lines,
    "Use /model <provider/model> to select a model, then /effort <level> to change reasoning effort.",
  ].join("\n");
}
