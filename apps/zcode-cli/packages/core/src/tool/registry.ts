/**
 * ============================================================================
 * tool/registry.ts —— 工具注册表(名称/别名/元数据/对外合同)
 * ============================================================================
 *
 * 【职责】
 *   - register:注册 ToolEntry,维护 canonical 名称 + 兼容别名;
 *   - get/has/list:执行与可见性过滤的统一查询入口(别名透明解析);
 *   - toContracts:把内部 ToolEntry 投影成 provider 可见的 ModelToolContract,
 *     过滤 providerVisible=false 的工具,并附上调度/权限/预算等声明。
 *
 * 【身份规则】
 *   canonical 名称永远优先于 alias;冲突的 alias 会被拒绝而不是静默覆盖,
 *   否则一次工具调用可能被路由到错误工具的权限与 handler。
 * ============================================================================
 */
// ============================================================
// Tool Registry - Tool registration and lookup
// ============================================================

import { type ModelToolContract } from "@zcode/contracts";
import type { ToolEntry, ToolMetadata } from "./types.js";

// -----------------------------------------------
// Tool Registry Interface
// -----------------------------------------------

/**
 * 工具注册表的对外契约。
 * 身份：以 metadata.name 为 canonical；aliases 只做查找重定向，不会出现在 provider 合同里。
 * 查询（get/has/getMetadata）对 alias 透明；list 只返回 canonical 名称。
 * toContracts 是“模型可见面”的唯一投影点：过滤 providerVisible=false，并剥离 execute。
 */
export interface ToolRegistry {
  register(entry: ToolEntry, options?: ToolRegistryRegisterOptions): void;
  unregister(name: string): void;
  get(name: string): ToolEntry | undefined;
  has(name: string): boolean;
  list(): string[];
  getMetadata(name: string): ToolMetadata | undefined;
  toContracts(): ModelToolContract[];
}

// 注册选项：silentDuplicateWarning 只用于测试/故意覆盖场景，生产默认保留告警，
// 因为“重复注册/别名冲突”通常意味着两个功能抢同一个工具身份。
export interface ToolRegistryRegisterOptions {
  silentDuplicateWarning?: boolean;
}

// -----------------------------------------------
// Tool Registry Implementation
// -----------------------------------------------

export class ToolRegistryImpl implements ToolRegistry {
  // alias → canonical 名称；只为查询服务，不参与执行/权限/合同投影。
  private aliases = new Map<string, string>();
  // canonical 名称 → ToolEntry；注册表的事实来源，模型可见/调度元数据都从这里读。
  private tools = new Map<string, ToolEntry>();

  /**
   * 注册/覆盖一个工具。
   * 注意:
   *   - 若同名工具之前是某个 alias 的目标,先移除该 alias(canonical 优先);
   *   - 若新工具的 alias 与已有 canonical/alias 冲突,跳过该 alias;
   *   - 默认对重复注册/冲突打印警告(silentDuplicateWarning 可关闭,测试用)。
   */
  register(entry: ToolEntry, options: ToolRegistryRegisterOptions = {}): void {
    const displacedAliasTarget = this.aliases.get(entry.metadata.name);
    if (displacedAliasTarget) {
      // 查找时 alias 若优先于 canonical，后注册的真实同名工具会继续被旧
      // alias 遮蔽。canonical 始终优先，并留下告警，避免兼容别名改变工具身份。
      this.aliases.delete(entry.metadata.name);
      if (options.silentDuplicateWarning !== true) {
        console.warn(
          `Tool ${entry.metadata.name} replaces alias previously targeting ${displacedAliasTarget}`,
        );
      }
    }
    if (this.tools.has(entry.metadata.name) && options.silentDuplicateWarning !== true) {
      console.warn(`Tool ${entry.metadata.name} already registered, overwriting`);
    }
    for (const [alias, target] of this.aliases) {
      if (target === entry.metadata.name) {
        this.aliases.delete(alias);
      }
    }
    this.tools.set(entry.metadata.name, entry);
    for (const alias of entry.aliases ?? []) {
      const existingAliasTarget = this.aliases.get(alias);
      if (
        alias === entry.metadata.name ||
        this.tools.has(alias) ||
        (existingAliasTarget !== undefined && existingAliasTarget !== entry.metadata.name)
      ) {
        // 兼容 alias 若静默覆盖 canonical/另一个 alias，会把一次工具调用路由到
        // 错误权限和 handler。冲突时拒绝本 alias，保留已注册身份。
        if (options.silentDuplicateWarning !== true) {
          console.warn(`Tool alias ${alias} conflicts with an existing tool or alias; skipping`);
        }
        continue;
      }
      this.aliases.set(alias, entry.metadata.name);
    }
  }

  /**
   * 注销工具：传入 alias 时只移除该别名（canonical 仍然可用）；
   * 传入 canonical 时同时移除工具本体与所有指向它的 alias，避免留下悬空重定向。
   * 幂等：名称不存在时不报错、不抛异常。
   */
  unregister(name: string): void {
    const aliasTarget = this.aliases.get(name);
    if (aliasTarget) {
      this.aliases.delete(name);
      return;
    }

    this.tools.delete(name);
    for (const [alias, target] of this.aliases) {
      if (target === name) {
        this.aliases.delete(alias);
      }
    }
  }

  /** 查询入口:别名会透明解析到 canonical ToolEntry。 */
  // 注意：alias 解析只做一层；不存在的名称返回 undefined，调用方按 registry miss 处理。
  get(name: string): ToolEntry | undefined {
    return this.tools.get(this.aliases.get(name) ?? name);
  }

  /** 判断工具是否存在（alias 也算）；等价于 get(name) !== undefined。 */
  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** 返回全部 canonical 工具名（不含 alias），顺序为 Map 的插入顺序。 */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 取工具元数据（alias 透明）；只读引用，调用方不得就地修改注册表事实。 */
  getMetadata(name: string): ToolMetadata | undefined {
    return this.get(name)?.metadata;
  }

  /**
   * 生成 provider 可见的工具合同(不含 execute,避免 handler 泄露到协议层)。
   * 只包含 providerVisible !== false 的工具;描述会把 modelInstructions 拼成 Usage 段。
   */
  // 注意：这里只输出 canonical 名称，alias 不会出现在模型工具表里；
  // 调度/权限字段（readOnly/concurrentSafe/sideEffectScope 等）逐项透传，不得在此改写。
  toContracts(): ModelToolContract[] {
    return Array.from(this.tools.values())
      .filter((entry) => entry.metadata.providerVisible !== false)
      .map((entry) => ({
        name: entry.metadata.name,
        description: toolDescriptionForProvider(entry.metadata),
        capability: entry.capability,
        executionMode: entry.executionMode,
        providerNative: entry.providerNative,
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
        ...(entry.strict === undefined ? {} : { strict: entry.strict }),
        readOnly: entry.metadata.readOnly,
        destructive: entry.metadata.destructive,
        concurrentSafe: entry.metadata.concurrentSafe,
        requiresUserInteraction:
          entry.requiresUserInteraction ?? entry.metadata.requiresUserInteraction,
        maxOutputBytes: entry.metadata.maxOutputBytes,
        timeoutMs: entry.metadata.timeoutMs,
        needsApproval: entry.metadata.needsApproval,
        sideEffectScope: entry.metadata.sideEffectScope,
        permission: entry.permission,
        resultBudget: entry.resultBudget,
        execute: undefined,
      }));
  }
}

/**
 * 把 metadata 投影成 provider 描述：modelInstructions 非空时追加 Usage 列表。
 * description 为空则只返回 Usage 段；两者都空时返回 undefined（合同里不写空描述）。
 * 纯函数；不修改 metadata。
 */
function toolDescriptionForProvider(metadata: ToolMetadata): string | undefined {
  const description = metadata.description;
  const instructions = metadata.modelInstructions?.map((line) => line.trim()).filter(Boolean) ?? [];
  if (instructions.length === 0) return description;

  const usage = ["Usage:", ...instructions.map((instruction) => `- ${instruction}`)].join("\n");
  return description && description.length > 0 ? `${description}\n\n${usage}` : usage;
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

/** 创建默认注册表实现；每次调用返回独立实例，调用方负责生命周期与注册顺序。 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}
