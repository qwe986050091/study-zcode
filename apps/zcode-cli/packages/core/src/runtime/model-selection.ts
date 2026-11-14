/**
 * model-selection.ts —— ModelSelection 的浅拷贝工具
 *
 * 为什么不直接展开对象：selection.options 是嵌套对象，展开只复制引用。
 * 会话选择会被多处读写（发布快照、持久化、执行作用域回退），
 * 必须复制到 options 一级，避免调用方改 reasoningLevel 时意外改写别人的快照。
 */
import type { ModelSelection } from "@zcode/contracts";

/**
 * 复制一份 ModelSelection(providerId/modelId 值拷贝,options 展开到一级)。
 *
 * 输入:任意有效 selection;输出:与入参不共享 options 引用的新对象。
 * 口径:会话级 selection 会被发布快照、持久化与执行作用域回退多处读写,
 * 只要任一调用方拿到同一引用并改 reasoningLevel,就会污染其它快照,因此必须复制。
 * 副作用:无(纯同步);失败语义:不抛错。注意只做一层深拷贝:options 内若再有
 * 嵌套对象仍共享引用,新增嵌套字段时需同步升级本函数。
 */
export function cloneModelSelection(selection: ModelSelection): ModelSelection {
  // 只复制到 options 一级:providerId/modelId 是值类型,options 是嵌套对象必须展开;
  // 失败/回退:不涉及外部 I/O,纯同步拷贝,无抛错路径。
  // 维护不变量:selection 是会话级可变事实,任何"发布快照/持久化/执行作用域回退"
  // 都必须拿到独立副本,避免调用方改 reasoningLevel 时污染别人的快照(链路 0 入口冻结)。
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}
