// memory 模块公开入口：只做 barrel re-export，归一化对外暴露的类型与工厂。
// INV：外部只能经本入口取得 IMemoryService 与 createMemoryService，禁止深引内部实现文件。
// INV：本文件不引入运行时副作用，导入它不得触发任何文件 IO 或记忆缓存初始化。
// 违反后依赖图会环化，且记忆文件读写时机漂移，错误码判定在多入口间失真。
export {
  IMemoryService,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "./memory.js";
export type {
  ProjectMemoryFileSummary,
  ProjectMemoryWorkspaceSummary,
} from "./memory.js";
export { createMemoryService } from "./memoryService.js";
