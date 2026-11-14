/**
 * ============================================================================
 * runtime/methods/model-request-session-type.ts —— 请求归因的两个纯映射
 * ============================================================================
 *
 * 只把宿主 session 的 taskType 翻译成两类口径：
 *   1) 服务端统计用的 ModelRequestSessionType；
 *   2) 重试预算 ModelRetryBudget。
 *
 * 两个映射共用同一套 taskType 分支：若只改其中一个，统计上归为 main 的会话
 * 却拿着 workflow 的重试预算（或反之），事后无法用遥测还原真实行为。
 * ============================================================================
 */
import { ModelRequestSessionType, ModelRetryBudget, type SessionTaskType } from "@zcode/contracts";

/**
 * 模型请求按宿主 session 做粗分类；workflow child 不是 subagent，服务端统计统一归 other。
 */
export function resolveModelRequestSessionTypeFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRequestSessionType {
  // subagent 是独立的成本/延迟维度，必须单列；混进 main 会让子代理用量
  // 被算进主会话，服务端无法按 session 类型拆分。
  if (taskType === "subagent_child") return ModelRequestSessionType.Subagent;
  // 选中内容侧聊走同一条模型链路但 purpose 不同，单独归类才能做成本拆分。
  if (taskType === "selection_side_chat") return ModelRequestSessionType.SideChat;
  // workflow child（含嵌套）在服务端不算 subagent：工作流层级由 runner 自己维护，
  // 归 other 可避免把动态工作流误计成子代理数量。
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRequestSessionType.Other;
  }
  // undefined / 未知 taskType 兜底为 main：新增 taskType 时宁可少分类，
  // 也不能给旧服务端发一个它不认识的枚举值。
  return ModelRequestSessionType.Main;
}

/**
 * workflow actor（含嵌套 workflow 的 actor）的模型请求拿**无上限**重试预算：模型错误绝不是
 * workflow 错误，由 runner 以最大努力恢复。
 * 其余 session（主会话、subagent、fork…）沿用 adapter 的默认预算。
 */
export function resolveModelRetryBudgetFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRetryBudget {
  // 模型错误不是 workflow 错误：unbounded 把恢复责任交给 workflow runner 的最大努力重试，
  // 不能在这一层按普通预算耗尽后直接把整个 workflow 判失败。
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRetryBudget.Unbounded;
  }
  // 主会话 / subagent / fork 等共用 adapter 默认预算：
  // 重试上限由 provider adapter 统一收口，而不是由各调用点自行决定。
  return ModelRetryBudget.Default;
}
