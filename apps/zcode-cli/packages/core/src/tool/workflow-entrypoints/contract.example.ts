import type { WorkflowToolEntrypoints } from "./contract.js";
import type { ToolRegistry } from "../registry.js";

/** 只注册既有入口；调用仍进入公共调度、参数校验及审批链。 */
// 职责：演示"把已构造好的三个 workflow ToolEntry 批量登记进 registry"的装配写法。
// 注意：当前无生产代码引用本函数，它只是契约示例，不代表这些工具的真实注册入口。
// 口径：不做 schema 校验、不改 metadata、不包装 handler；调用仍走公共调度 → validation → permission。
// 副作用：register 对同名工具是覆盖并 console.warn；非内置名会按注册顺序进入 provider-visible 列表。
// 失败语义：不抛错；重复注册只告警，装配幂等由调用方负责。
export function exampleWorkflowToolEntrypoints(
  registry: Pick<ToolRegistry, "register">,
  entries: WorkflowToolEntrypoints,
): void {
  registry.register(entries.amendWorkflow);
  registry.register(entries.listModels);
  registry.register(entries.fillWorkflowHole);
}
