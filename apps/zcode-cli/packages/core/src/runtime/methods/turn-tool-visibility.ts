/**
 * turn-tool-visibility.ts —— 计算"本轮 turn 实际暴露给模型的工具集"
 *
 * 规则:
 *   - 全量工具来自 runtime.getTools(model);
 *   - automation create limit 命中后返回空集(本 turn 只能纯文本收口);
 *   - 其余按 turn-scoped denylist 过滤:
 *       * automation 执行轮禁用 CronCreate/Update/Delete(保留只读 CronList);
 *       * off-peak 执行轮禁用 OffPeakCreate 等 mutation(保留只读列表)。
 * 这里只做"可见性"过滤,不改变 registry;执行边界的权限校验仍会独立进行。
 */
import type { AgentRuntimeInternal } from "../internal.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";

/** 返回本轮应暴露给模型的工具列表(可能有过滤)。 */
export function getTurnTools(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const disallowed = buildTurnDisallowedTools(state);
  // 创建上限命中时直接返回空集,不再调用 getTools:
  // 这一轮只允许纯文本收口,连工具 schema 都不应发给 provider。
  if (state.automationCreateLimitReached) return [];
  const tools = runtime.getTools(state.model);
  // disallowed 为 null 表示无需过滤,直接复用原数组(避免无意义的 filter 分配)。
  return disallowed ? tools.filter((tool) => !disallowed.has(tool.name)) : tools;
}

/** 汇总本轮需要隐藏的工具名;为空返回 null,避免上层做无意义过滤。 */
function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  // 起点是本轮显式 denylist(来自输入/上层策略),再叠加"按轮次类型"的隐式限制。
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 修复原因：定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    // 不变量 3：权限只能收紧——这里通过隐藏工具 schema 实现，执行层权限校验仍独立进行。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // D49：闲时执行轮禁止再创建闲时任务（免费池自我放大）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 按 D49-3 放行 OffPeakCreate。
    // 不变量 3：这是"按轮次类型收紧工具面"，不是放宽——任何轮次都不能获得比基础更多的工具。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
