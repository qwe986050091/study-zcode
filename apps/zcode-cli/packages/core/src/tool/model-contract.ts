import type { ModelToolContract } from "@zcode/contracts";
import type { ToolEntry, ToolExecutionModelContext } from "./types.js";

/**
 * 按当前模型解析注册项的“模型投影”，供执行器在本次调用中使用。
 * 输入：注册表里的 ToolEntry + 模型上下文（可能无 model，表示只枚举）。
 * 输出：resolveModelContract 缺失/返回 undefined 时原样返回 entry（静态契约兜底）；
 * 否则返回浅拷贝，只覆盖 inputSchema 与 metadata.description。
 * 不变量：不合并 readOnly/concurrentSafe/timeoutMs 等调度元数据——模型投影只影响
 * 模型看到的参数与描述，不能顺带改变并行性、审批或预算事实。无副作用、不缓存。
 */
export function resolveToolEntryModelContract(
  entry: ToolEntry,
  context: ToolExecutionModelContext,
): ToolEntry {
  const projection = entry.resolveModelContract?.(context);
  if (!projection) return entry;
  return {
    ...entry,
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
    metadata: {
      ...entry.metadata,
      ...(projection.description !== undefined ? { description: projection.description } : {}),
    },
  };
}

/**
 * 对已经成型的 provider 工具合同再做一次模型投影。
 * 输入：contract 是 registry.toContracts() 的产物，entry 是可选的注册项。
 * 输出：entry 不存在（如动态/外部工具）或投影返回 undefined 时返回原 contract；
 * 否则仅替换 description 与 inputSchema，其余字段保持注册表口径。
 * 消费者是 runtime/methods/config.ts 的 getTools：缓存与模型无关的合同，
 * 再按当前模型现算投影，避免把模型事实写进缓存。
 */
export function projectToolModelContract(
  contract: ModelToolContract,
  entry: ToolEntry | undefined,
  context: ToolExecutionModelContext,
): ModelToolContract {
  // 为什么早退：部分工具只存在于 provider 列表中而无注册项，此时没有投影来源，
  // 必须保持原合同可用，不能因为查不到 entry 就让工具从模型视野消失。
  if (!entry) return contract;
  const projection = entry.resolveModelContract?.(context);
  if (!projection) return contract;
  return {
    ...contract,
    ...(projection.description !== undefined ? { description: projection.description } : {}),
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
  };
}
