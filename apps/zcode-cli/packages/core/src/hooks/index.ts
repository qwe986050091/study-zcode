/**
 * ============================================================================
 * hooks/index.ts —— hooks 包的公共入口（barrel）
 * ============================================================================
 *
 * 只做再导出,不放实现:调用方据此拿到执行器、注册契约,以及工作区 hook 的
 * 信任域、运行期准入、审核流、遥测四组能力,而不依赖具体文件路径。
 *
 * 信任域是子聚合(策略 + coordinator + 记录 + 类型),其余按能力星号导出;
 * 新增模块必须在此登记,否则对包外不可见,也就不会被装配进链路（链路 9）。
 * ============================================================================
 */
// 装配入口:同时覆盖配置 hook 与工作区 hook 的建 runner 路径。
export { createConfiguredHookRunner } from "./configured-runner.js";
// 展示与脱敏:descriptor 构造 + 文本掩码,UI 侧只应使用这里导出的版本。
export { createHookExecutionDescriptor, sanitizeHookDisplayText } from "./display-metadata.js";
// 运行时执行器;工作区 hook 的授权在每次 dispatch 时重算,不在装配期定稿（不变量 #10）。
export { InMemoryHookRunner, createInMemoryHookRunner } from "./runner.js";
// 内置会话邮箱 hook:把未读消息投成上下文或待办输入（链路 9）。
export { createSessionMailboxHookRegistrations } from "./session-mailbox.js";
// 契约类型只做 type 导出,避免运行期依赖倒挂。
export type {
  ConfiguredHookRunnerOptions,
  HookCallback,
  HookCallbackContext,
  HookCallbackDiagnostics,
  HookCallbackResult,
  HookRegistration,
  HookRunOptions,
  HookRunResult,
  HookRunner,
  HookRunnerOptions,
} from "./types.js";
// 信任域子聚合:policy、coordinator、trust record 与类型由 domain 统一转出。
export * from "./workspace-hook-trust-domain.js";

// 运行期准入、审核流与遥测:工作区 hook 能否执行只由这几层的结论决定。
export * from "./workspace-hook-runtime-admission.js";
export * from "./workspace-hook-review-flow.js";
export * from "./workspace-hook-telemetry.js";
