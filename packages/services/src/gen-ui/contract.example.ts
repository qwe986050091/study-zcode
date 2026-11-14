// 示例契约：给出 GenUiPrepareParams 的合法取值样本，供类型对齐与评审时参考。
// INV：纯静态示例，runtime 与 gen-ui 装配代码都不得引用此文件。
// 被误 import 时会连同示例常量一起打包，并污染真实的预览实例入参。
import type { GenUiPrepareParams } from "./contract.js";
export const exampleGenUiPrepare: GenUiPrepareParams = {
  workspacePath: "/workspace",
  sessionId: "session",
  path: "/workspace/chart.html",
  html: '<div id="chart">Chart</div>',
  ownerWebContentsId: 1,
  instanceKey: "message-1",
};
