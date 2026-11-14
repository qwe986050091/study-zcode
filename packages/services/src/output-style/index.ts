// 输出风格服务 barrel：仅 re-export 契约接口与工厂函数，唯一不变量是导入本入口不创建实例、无副作用。
export { IOutputStyleService } from "./outputStyle.js";
export { createOutputStyleService } from "./outputStyleService.js";
