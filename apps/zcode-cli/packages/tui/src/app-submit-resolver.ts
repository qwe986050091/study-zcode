// 提交文本解析模块：把输入框原始提交值改写为真正要发送的文本。
// 边界：只做取值与改写，不读全局状态、不做校验、不改输入框。
// 口径：模型 > 思考档位 > 模式 > 选中 slash 命令 > 原样文本，互斥且各选择器未激活时跳过。
// 失败语义：纯函数无可失败路径；未匹配任何选择器时原样返回 submittedValue。
import { selectedSlashCommand } from "./app-input.js";
import { modelOptionValue } from "./app-model-ref.js";
import type { SlashCommand, SlashSelectionState } from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

// 把输入框的原始提交值解析为真正要发送的文本（斜杠命令优先）。
// 优先级（互斥）：model 选择 > effort 选择 > mode 选择 > 选中的 slash 命令 > 原样文本；
// 前三者会改写成对应的 "/model xxx" 等命令文本，由下游服务端统一解析。
// 入参均可选：option 为 undefined 表示该选择器未激活；slashSelection 缺省表示没有候选列表。
// 无副作用：纯函数，不读全局状态、不改输入。
export function resolveComposerSubmittedText({
  effortOption,
  modeOption,
  modelOption,
  slashCommands,
  slashSelection,
  submittedValue,
}: {
  effortOption?: TuiEffortOption;
  modeOption?: TuiModeOption;
  modelOption?: TuiModelOption;
  slashCommands: readonly SlashCommand[];
  slashSelection?: SlashSelectionState;
  submittedValue: string;
}): string {
  const slashCommand = selectedSlashCommand(submittedValue, slashSelection, slashCommands);
  if (modelOption) return `/model ${modelOptionValue(modelOption)}`;
  if (effortOption) return `/effort ${effortOption.id}`;
  if (modeOption) return `/mode ${modeOption.id}`;
  if (slashCommand) return `/${slashCommand.name}`;
  return submittedValue;
}
