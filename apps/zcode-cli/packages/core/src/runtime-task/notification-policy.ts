/**
 * runtime task 的通知策略：只回答"这条完成通知该不该发"，不负责发送。
 * 输入是子运行时标记、seal 状态与任务来源；输出为布尔值，纯函数、无副作用。
 * 失败语义：不做 IO 也不抛错，信息缺失（registry 无记录 / 无 toolName）时一律按"不抑制"处理，
 * 宁可多发一次通知，也不静默吞掉父会话需要感知的完成事件。
 */

import type { RuntimeTaskSnapshot, RuntimeTaskType } from "./registry.js";

// 安全读取任务类型：taskType 为新字段优先，缺失时兼容旧字段 type；task 为 undefined 时返回 undefined。
// 不做字符串校验，调用方按值比较即可。
export function runtimeTaskTypeOf(
  task: Pick<RuntimeTaskSnapshot, "taskType" | "type"> | undefined,
): RuntimeTaskType | undefined {
  return task?.taskType ?? task?.type;
}

// 判断是否应抑制子运行时发出 Bash 完成通知：子会话已 seal 时，Bash 结果已由父级汇总，
// 再发一次会造成重复提醒。三个条件全部满足才抑制，任一不满足都保持原有通知行为。
// 该判定只影响通知投递，不改变任务本身的完成状态与结果落盘。
// registryTask/ toolName 都可缺省：registry 无记录时退回工具名判断，两者都没有则不抑制。
export function shouldSuppressSealedSubagentBashNotification(input: {
  isSubagentChildRuntime: boolean;
  notificationSealed: boolean;
  registryTask?: Pick<RuntimeTaskSnapshot, "taskType" | "type">;
  toolName?: string;
}): boolean {
  // 非子运行时或未 seal 时与本策略无关，提前返回避免无谓的类型读取。
  if (!input.isSubagentChildRuntime) return false;
  if (!input.notificationSealed) return false;
  // 工具名与注册表任务类型是"同一个 Bash 任务"的两种来源，任一命中即可抑制。
  return input.toolName === "Bash" || runtimeTaskTypeOf(input.registryTask) === "local_bash";
}
