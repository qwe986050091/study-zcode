// Hooks 服务 barrel：只做 IHooksService 与工厂的 re-export，唯一不变量是该入口无副作用、不隐藏实例化逻辑。
export { IHooksService } from "./hooks.js";
export { createHooksService } from "./hooksService.js";
