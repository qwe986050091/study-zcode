// ============================================================
// executor/permission-capability.ts —— 工具能力的运行时解析
// ============================================================
// 静态 `entry.metadata/permission` 与本调用 `resolvePermissionCapability` 的运行时结论合并，
// 供权限判定与 ToolCallStarted 的副作用旗标共用同一份解析。
// 覆盖方向固定：运行时结论逐字段覆盖静态声明，但 permissionCapabilityGroup 例外——它是注册时的
// 可信来源（provenance），不能被模型入参或运行时解析改写。
// 失败语义：本模块是纯计算，不返回错误；单个字段的失效会由下游按"能力未知"处理。

import type { ModelToolSideEffectScope } from "@zcode/contracts";
import type { PermissionToolCapability } from "../../permission/service.js";
import type { ToolEntry, ToolRuntimePermissionCapabilityContext } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

/**
 * 把静态能力声明与本次输入的运行时解析折叠成一份 capability。
 * 输入：entry、已规范化的执行入参、权限上下文（cwd/workspace/runtimeScope）；
 * 输出：PermissionToolCapability 纯数据，无 IO/无副作用。
 * `resolvePermissionCapability` 可覆盖 readOnly/sideEffectScope 等（如 Bash 按命令内容判定只读），
 * 未声明时等价于静态声明；嵌套的 permission 是"合并"而非整体替换。
 */
export function resolveRuntimePermissionCapability(
  entry: ToolEntry,
  input: unknown,
  context: ToolRuntimePermissionCapabilityContext,
): PermissionToolCapability {
  const runtimeCapability = entry.resolvePermissionCapability?.(input, context);
  return {
    // 先铺静态声明，再让本次调用的运行时结论逐字段覆盖。
    ...entry.metadata,
    ...runtimeCapability,
    // capability group is provenance, not a runtime/model-controlled override.
    permissionCapabilityGroup: entry.permissionCapabilityGroup,
    // 嵌套 permission 也按字段合并：运行时只改它关心的项，其余静态声明保持不变。
    permission: {
      ...entry.permission,
      ...runtimeCapability?.permission,
    },
  };
}

/**
 * 一次调用**解析后**的副作用旗标，挂在 `ToolCallStarted` 上：与权限判定同一次解析，所以 Bash 的只读命令判定等运行时结论一并生效。
 * 订阅者（dynamic-workflow 的 driver）据它在 handler 动手之前判断这一笔是否会改写工作区。
 */
export function resolveToolCallCapabilityFlags(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
): { readOnly?: boolean; sideEffectScope?: ModelToolSideEffectScope } {
  const capability = resolveRuntimePermissionCapability(
    entry,
    input,
    resolveRuntimePermissionContext(deps),
  );
  // 只取这两个旗标：订阅者关心的是"会不会改写工作区"，其余能力不随事件外泄。
  return { readOnly: capability.readOnly, sideEffectScope: capability.sideEffectScope };
}

/**
 * 构造所有权限判定共用的上下文：runtimeScope、当前 cwd、workspaceRoot。
 * 必须走 deps 的 getter 而不是快照字段，保证审批/重判期间目录变化在同一调用内可见；
 * 每次调用现取，纯读、不缓存。
 */
export function resolveRuntimePermissionContext(
  deps: ToolExecutorDeps,
): ToolRuntimePermissionCapabilityContext {
  return {
    runtimeScope: deps.runtimeScope,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  };
}
