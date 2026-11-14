import type { BootstrapModule } from "./cli-types.js";

// @zcode/bootstrap 是重依赖（provider/session/tool 装配），首次 import 需数秒并初始化大量模块。
// 用模块级 Promise 做单次加载缓存：并发调用共享同一次 import，避免重复初始化；
// 失败时保留 rejected Promise（不自动重试），错误原样传播给调用方。
let bootstrapModulePromise: Promise<BootstrapModule> | undefined;

// 返回缓存的 bootstrap 模块命名空间，永不返回 undefined；仅首次调用触发动态 import。
// 无重试、无超时：加载失败时 Promise 以原始错误 reject，由 CLI 入口层统一提示与决定退出码。
export const loadBootstrapModule = (): Promise<BootstrapModule> => {
  bootstrapModulePromise ??= import("@zcode/bootstrap");
  return bootstrapModulePromise;
};
