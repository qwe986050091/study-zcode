/**
 * 子 agent 工具面收敛策略：在 profile 声明的禁用项之外，强制剔除 plan 模式工具。
 * 纯函数集合运算，不读写盘、不改全局注册表；调用方拿到的是新数组，原数组保持不变。
 * 顺序约定：强制禁用项永远排在声明项之前，便于上层展示与测试断言稳定。
 * 不做去重：重复项由下游过滤语义按集合处理，这里保留调用方输入原貌。
 */

import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@zcode/contracts";
import { filterDisallowedToolNames } from "../tool/tool-visibility.js";

// 所有子 agent 强制禁用的工具：plan 模式进出由父会话独占，子 agent 不得改变计划状态。
export const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
] as const;

// 合并强制禁用项与 profile 自身声明的禁用项，输出顺序为“强制项在前、声明项在后”。
// disallowedTools 为 undefined 时只返回强制项；重复名称不去重（过滤语义按集合判断）。
// 返回值为只读语义，调用方不可原地修改；纯函数，同一入参恒定输出同一顺序。
export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [
    ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
    ...(disallowedTools ?? []),
  ];
}

// 按禁用规则过滤掉子 agent 不应暴露的工具名，返回新数组（保持剩余项原顺序）。
// 该结果只用于工具可见性/暴露面，不改变工具注册状态，也不影响父会话工具集。
// 纯函数、无副作用；过滤失败不存在降级分支，任何异常都会在集合运算前暴露。
export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  // 子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让
  // ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 工具面统一剔除。
  return filterDisallowedToolNames(
    toolNames,
    buildSubagentChildDisallowRules(disallowedTools),
  );
}
