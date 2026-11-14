// executor 门面：实现与类型都收在 executor/ 子目录，本文件只固定对外入口。
// 调用方应从这里拿 ToolExecutor/ToolExecutorOptions 与工厂，不要直接 import
// executor/impl.js——否则会绕过工厂的默认依赖装配，并耦合内部目录结构。
export { ToolExecutorImpl, createToolExecutor } from "./executor/impl.js";
export type { ToolExecutor, ToolExecutorOptions } from "./executor/types.js";
