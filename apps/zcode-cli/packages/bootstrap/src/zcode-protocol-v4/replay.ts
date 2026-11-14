// 回放导出桶。
//
// 下游回放页面在浏览器里用 CLI 自己的三段归约器把持久化的 MessageWithParts 重建成
// ConversationSnapshot：synthesizeEventsFromMessages → mergeColdConversationEvents →
// ProductProjection（hydration replay）。三者都是纯函数/纯类，无 node 依赖——这条纪律由
// 浏览器回放包的 `vite build` 机械检查（桶里一旦混进 node 内建模块导入，浏览器包立刻构建失败）。
//
// 只 re-export，不定义任何东西。
//
// 导出面刻意保持最小：只暴露三段归约器的入口与 hydration trace 哨兵，
// 不暴露 reducer 内部索引、publisher 或 gateway 的半成品。这样浏览器回放端只能
// 复用与 CLI 相同的归约实现，不能自建第二套 rows/availability 推导。
// delta 的封闭集合仍由 ProductProjection 统一产出，回放端只消费 snapshot/delta 结果。
export { ProductProjection } from "./product-projection.js";
export { synthesizeEventsFromMessages } from "./transcript-hydration.js";
export { mergeColdConversationEvents, type ColdEventMergeResult } from "./cold-event-merge.js";
export { HYDRATION_TRACE_ID } from "./projection-state.js";
