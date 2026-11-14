// 引入 Vite 客户端类型（import.meta.env、?worker、?raw 等）。
/// <reference types="vite/client" />

// 声明 Vite 插件注入的虚拟图谱模块：内容为规范化后的只读图谱，运行时由 load 钩子提供。
// 该模块仅存在于 dev-docs 应用，测试与类型检查依赖此声明，源码中不可解析为真实文件路径。
declare module "virtual:zcode-feature-boundary-graph" {
  import type { FeatureBoundaryGraph } from "@/data/featureBoundaryGraph.js";

  const graph: FeatureBoundaryGraph;
  export default graph;
}
