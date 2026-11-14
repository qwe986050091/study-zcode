// 计划步骤解析统一复用 @zcode/shared 的实现，services 层不再维护第二套口径。
// 仅做转导出，保证工具名判断与步骤提取在各宿主之间完全一致。
export {
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  isTodoPlanToolName,
} from "@zcode/shared";
