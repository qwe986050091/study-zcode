// ============================================================
// executor/permission-input.ts —— 审批输入的快照与规范化
// ============================================================
// 两个职责都发生在"确认窗与 handler 之间"：snapshotPermissionInput 冻结 guarded 的审批字节，
// preparePermissionInput 把 Hook/用户在确认窗里改过的输入按同一套 schema 归一化并校验。
// 不变量：guarded 下"批准什么"与"执行什么"必须同字节；改写后的输入不过 schema 永远不能进 handler。
// 反直觉：这里只跑 schema 校验、不跑工具语义预检——审批改写不应扩大旧模式的行为变更。

import type { ToolEntry } from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import type { ToolExecutorDeps } from "./types.js";
import { validateInput } from "./validation.js";

/** 审批只读快照；先冻结再下钻，避免可信 Hook 返回循环引用时无限递归。 */
export function snapshotPermissionInput<T>(input: T): T {
  // 先克隆再冻结：只冻结副本，调用方持有的原对象仍可被后续逻辑安全使用。
  const snapshot = structuredClone(input);
  function freeze(value: unknown): void {
    // 已冻结的子树直接跳过：既避免重复遍历，也靠"先 freeze 当前节点再下钻"斩断循环引用。
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  freeze(snapshot);
  // 返回冻结后的克隆：调用方只能读，任何改写都必须另起对象，否则会抛 TypeError。
  return snapshot;
}

/**
 * 把"即将审批/执行的入参"规范化成 handler 将看到的形状。
 * 输入可以是模型原始入参，也可以是 Hook/用户在确认窗里改写的版本；输出是新对象，不改调用方引用。
 * source="permission" 决定归一化的宽松度；随后只做 schema 校验，失败即抛出——审批链路据此把
 * 无效输入收口成错误结果，而不是先弹一次注定失败的确认窗。
 */
export function preparePermissionInput(
  input: unknown,
  entry: ToolEntry,
  deps: ToolExecutorDeps,
): unknown {
  const normalized = normalizeToolExecutionInput({
    entry,
    input,
    logger: deps.logger,
    source: "permission",
  });
  // 原因：审批重构曾额外重跑所有工具的语义预检，扩大了旧模式行为变更；改写保留原 schema 校验。
  const error = validateInput(normalized, entry);
  if (error) throw error;
  return normalized;
}
