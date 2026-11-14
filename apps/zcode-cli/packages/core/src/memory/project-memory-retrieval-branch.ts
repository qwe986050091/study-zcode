// ============================================================
// memory/project-memory-retrieval-branch —— project Memory 的检索分支开关
// ============================================================
//
// 【定位】决定本轮用哪种方式把记忆带进上下文：
//   default-index = 直接注入 MEMORY.md 索引；
//   semantic-recall = 先用选择器挑文件，再读取正文注入。
//
// 【消费方】context/builder.ts（Memory 说明段）、runtime/methods/context.ts
//   （索引加载）与 project-memory-recall（预取门禁）。
//
// 【口径】当前编译期常量为 false，即默认 default-index；
//   切换只改这一个常量，不引入运行时配置，避免同一会话内分支漂移。
//
// 【副作用】无：纯常量 + 纯函数。
// ============================================================
/**
 * 检索分支标识；字符串值会进入 context 段落与预取门禁的判断。
 */
export type ProjectMemoryRetrievalBranch = "default-index" | "semantic-recall";

// 当前默认检索分支关闭 Semantic Recall；未来切换只修改这一处值。
// 保持编译期常量而非配置项：分支决定 context 结构，不允许运行中来回翻转。
const PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false;

/**
 * 把布尔开关翻译成检索分支标识（纯函数，便于测试未来切换）。
 */
export function resolveProjectMemoryRetrievalBranch(
  semanticRecallEnabled: boolean,
): ProjectMemoryRetrievalBranch {
  return semanticRecallEnabled ? "semantic-recall" : "default-index";
}

/**
 * 当前生效的检索分支；所有消费方都应读这个常量，而不是各自判断开关。
 */
export const ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH = resolveProjectMemoryRetrievalBranch(
  PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED,
);
