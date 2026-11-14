// 本文件仅作契约示例与类型演示，不参与构建产物，也不会被宿主加载。
/**
 * office-runtime 标准用法示例：PDF 插件在 package.json 里声明的面板配置，以及构建后可依赖的产物。
 */
import { OFFICE_RUNTIME_OUTPUTS, type OfficeRuntimeContract } from "./contract.ts";

// 示例工厂：返回一个最小可用的 OfficeRuntimeContract，演示插件 package.json 中 office 段的声明形态。
// 输入：无。输出：config.title 为双语面板标题，config.kinds 为插件开放的格式子集，outputs 复用构建产物清单。
// 副作用：无，纯值构造，不读盘、不发事件；供文档与类型示例使用，可直接断言结构。
// 维护不变量：kinds 必须取自 ALL_KINDS，outputs 必须与 contract.ts 的产物路径常量保持一致。
export function examplePdfPlugin(): OfficeRuntimeContract {
  return {
    config: { title: { en: "PDF", "zh-CN": "PDF" }, kinds: ["pdf"] },
    outputs: OFFICE_RUNTIME_OUTPUTS,
  };
}
