// contract 使用示例（仅为文档，不被运行时代码引用）。
//
// 职责：演示用 tasksStorageWorkerDataSchema 校验 Worker 输入的标准写法。
// 输入输出：输出 exampleWorkerData（parse 后的只读对象）。
// 副作用：模块加载时执行一次 parse；失败会抛 ZodError。
// 维护的不变量：示例必须保持在 schema 允许的形状内，schema 变更时同步更新。

import { tasksStorageWorkerDataSchema } from "./contract.js";
// 用 schema.parse 而非手工构造：示例本身也要经过严格校验，
// path 为空或拼错字段名会立即失败，避免文档与实际合约脱节。
/** 宿主构造 Worker 输入；文件路径保持原值，真实打开与迁移只发生在 Worker。 */
export const exampleWorkerData = tasksStorageWorkerDataSchema.parse({
  path: "./tasks-index.sqlite",
});
