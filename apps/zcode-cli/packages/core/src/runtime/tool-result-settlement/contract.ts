/**
 * ============================================================================
 * runtime/tool-result-settlement/contract.ts —— 工具结果结算的公开类型契约（纯类型，无实现）
 * ============================================================================
 *
 * 【契约边界】ToolResultSettlement 直接取 methods/tool-result-settlement.ts 的
 *   settleToolResults 类型：整批工具结果**先进入 Runtime 历史**，再等待既有持久化；
 *   沿用原调用方、错误与取消语义。本文件不复制实现，也不重新声明签名，
 *   保证所有依赖方看到的是同一份方法类型（改实现即自动同步契约）。
 *
 * 【为什么放这里】architecture-governance 模块清单（module.ts）把 contract.ts 与
 *   ../methods/tool-result-settlement.ts 一起列为 publicEntrypoints；
 *   外部模块只应从这两个入口取类型/调用，不应直接 import methods 内部文件。
 * ============================================================================
 */
/** 整批结果先进入 Runtime 历史，再等待既有持久化；沿用原调用方、错误和取消语义。 */
export type ToolResultSettlement =
  typeof import("../methods/tool-result-settlement.js").settleToolResults;
export type { ToolResultPart } from "../methods/tool-result-settlement.js";
