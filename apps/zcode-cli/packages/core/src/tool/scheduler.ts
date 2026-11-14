// ============================================================
// Tool Scheduler - Tool execution scheduling
// ============================================================
// 定位：把「模型这一轮要跑的一批工具调用」排成可执行的分组。输入只有依赖关系
// （dependsOn）与每个工具的安全元数据；输出是 parallelGroups（同组可并发、
// 组间串行）与 executionOrder（分组的扁平化，用于持久化/回放）。
//
// 关键选择：未知即并行。canRunInParallel 在「既没有工具名、也没有任何安全元数据」
// 时返回 true。理由是没有名字就无法查只读白名单，也没有 destructive/
// concurrentSafe 可供判断；与其把所有历史调用点一律串行化，不如保持旧的并发
// 行为。风险：任何新调用点漏传元数据，都会让带副作用的工具进入并发组——
// 需要串行时必须显式传 readOnly:false / destructive:true / concurrentSafe:false。
import type { ModelToolSideEffectScope, ToolCallId } from "@zcode/contracts";
import { createCoreError, CoreErrorType } from "@zcode/contracts";

// -----------------------------------------------
// Types
// -----------------------------------------------

export interface ToolSchedule {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface ToolScheduleItem {
  toolCallId: ToolCallId;
  toolName?: string;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

export interface ToolDependency {
  toolCallId: ToolCallId;
  toolName?: string;
  dependsOn: ToolCallId[];
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

// -----------------------------------------------
// Scheduler
// -----------------------------------------------

interface ToolSchedulerOptions {
  maxConcurrency?: number;
  readOnlyTools?: Set<string>;
}

const DEFAULT_MAX_CONCURRENCY = 10;

export class ToolScheduler {
  private itemsMap = new Map<ToolCallId, ToolScheduleItem>();
  private maxConcurrency: number;
  private readOnlyTools: Set<string>;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.readOnlyTools = options.readOnlyTools ?? READ_ONLY_TOOLS;
  }

  /**
   * 排一次调度：补全每个调用的安全标记 → 拓扑排序 → 按层分组 → 组内自依赖复查。
   *
   * 顺序固定，不能互换：
   *   - canRunInParallel 必须在拓扑排序前算好，它是分组的输入，而不是分组的产物；
   *   - 拓扑排序保证组内成员的所有依赖都已经出现在更早的组里，groupByParallel 才能
   *     只按「层号」切分而不回头检查跨层依赖；
   *   - validateNoCycles 是兜底断言：真正的环检测在 topologicalSort（剩余节点非空即
   *     抛错）；这里只复查「同一组内的依赖」，正常情况下不会触发。
   *
   * 副作用：覆盖内部 itemsMap，供 validateNoCycles 回查；同一实例重复 schedule 会替换
   * 这份内部映射，已返回的 ToolSchedule 是独立快照，不受后续调用影响。空输入返回三个空数组。
   */
  schedule(tools: ToolDependency[]): ToolSchedule {
    const items = tools.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      dependencies: tool.dependsOn,
      canRunParallel: this.canRunInParallel(tool),
      readOnly: tool.readOnly ?? (tool.toolName ? this.readOnlyTools.has(tool.toolName) : undefined),
      destructive: tool.destructive,
      concurrentSafe: tool.concurrentSafe,
      sideEffectScope: tool.sideEffectScope,
    }));

    this.itemsMap = new Map(items.map((item) => [item.toolCallId, item]));

    const sorted = this.topologicalSort(items);
    const groups = this.groupByParallel(sorted);
    this.validateNoCycles(groups);

    return {
      items,
      parallelGroups: groups,
      executionOrder: groups.flat(),
    };
  }

  /**
   * 并发判定，按下面的优先级短路，先命中先返回：
   *   0. 既无 toolName 也无任何安全元数据 → true（未知即并行，见文件头取舍）；
   *   1. destructive === true → false；破坏性标记压倒一切，即使同时声明了
   *      concurrentSafe:true 也不并发（本函数先判 destructive）；
   *   2. concurrentSafe 显式为 true / false → 直接采信；
   *   3. readOnly（显式传入，或 toolName 命中 READ_ONLY_TOOLS）→ true；
   *   4. 兜底：sideEffectScope === "none" 才并行，其余（含未声明 scope）一律串行。
   *
   * 注意第 0 条与第 4 条的分界：只给了 toolName、但名字不在白名单且没有元数据时，
   * readOnly 解析为 false，会落到第 4 条变成串行——「具名但未知」比「完全未知」更
   * 保守：拿得到名字说明本可查表，查不到就不按只读处理。
   */
  private canRunInParallel(tool: ToolDependency): boolean {
    const hasToolName = typeof tool.toolName === "string" && tool.toolName.length > 0;
    const hasSafetyMetadata =
      tool.readOnly !== undefined ||
      tool.destructive !== undefined ||
      tool.concurrentSafe !== undefined ||
      tool.sideEffectScope !== undefined;

    if (!hasToolName && !hasSafetyMetadata) {
      return true;
    }

    const readOnly = tool.readOnly ?? (hasToolName ? this.readOnlyTools.has(tool.toolName!) : false);
    if (tool.destructive) return false;
    if (tool.concurrentSafe === true) return true;
    if (tool.concurrentSafe === false) return false;
    if (readOnly) return true;
    return tool.sideEffectScope === "none";
  }

  private topologicalSort(items: ToolScheduleItem[]): ToolScheduleItem[] {
    const result: ToolScheduleItem[] = [];
    const remaining = new Map(items.map((item) => [item.toolCallId, item]));
    const inDegree = new Map<string, number>();

    for (const item of items) {
      inDegree.set(item.toolCallId, item.dependencies.length);
    }

    const queue = items
      .filter((item) => item.dependencies.length === 0)
      .map((item) => item.toolCallId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const item = remaining.get(current);

      if (!item) continue;

      result.push(item);
      remaining.delete(current);

      for (const [toolId, depItem] of remaining) {
        if (depItem.dependencies.includes(current)) {
          const newDegree = (inDegree.get(toolId) ?? 0) - 1;
          inDegree.set(toolId, newDegree);
          if (newDegree === 0) {
            queue.push(toolId);
          }
        }
      }
    }

    if (remaining.size > 0) {
      throw createCoreError(
        CoreErrorType.InvalidStateTransition,
        "Circular dependency detected in tool scheduling",
        {
          context: {
            remaining: Array.from(remaining.keys()),
          },
          recoverable: false,
        },
      );
    }

    return result;
  }

  /**
   * 按「依赖层」切组：层号 = max(依赖的层号) + 1，无依赖的从 0 开始。
   *
   * 分组边界有三条，混在一起看容易误读：
   *   1. 层边界：不同层永远落在不同组，后一层依赖前一层全部完成；
   *   2. 串行边界：canRunParallel=false 的调用会先把攒着的并发组 flush 出去，再单独
   *      成组——所以它既不与前面合并，也不与后面合并；
   *   3. 容量边界：同一层的并发调用按 maxConcurrency 截断，满了先 flush 再继续，
   *      因此「同层」不等于「同组」，一个层可能产出多个满额组加一个残余组。
   *
   * 层号的依赖查找对 items 之外的工具 id 回退为 0：依赖不在本批里的调用会被当成
   * 「依赖了第 0 层」而直接落到第 1 层，这是本函数的已知假设，调用方需保证 dependsOn
   * 引用的都是同一批内的工具。
   */
  private groupByParallel(items: ToolScheduleItem[]): ToolCallId[][] {
    if (items.length === 0) return [];

    const levels = new Map<ToolCallId, number>();
    const byLevel = new Map<number, ToolScheduleItem[]>();

    for (const item of items) {
      const dependencyLevel =
        item.dependencies.length === 0
          ? -1
          : Math.max(...item.dependencies.map((dep) => levels.get(dep) ?? 0));
      const level = dependencyLevel + 1;
      levels.set(item.toolCallId, level);
      const levelItems = byLevel.get(level) ?? [];
      levelItems.push(item);
      byLevel.set(level, levelItems);
    }

    const groups: ToolCallId[][] = [];
    const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);

    for (const level of sortedLevels) {
      let parallelGroup: ToolCallId[] = [];

      const flushParallelGroup = () => {
        if (parallelGroup.length === 0) return;
        groups.push(parallelGroup);
        parallelGroup = [];
      };

      for (const item of byLevel.get(level) ?? []) {
        if (item.canRunParallel) {
          // Flush if current group is full
          if (parallelGroup.length >= this.maxConcurrency) {
            flushParallelGroup();
          }
          parallelGroup.push(item.toolCallId);
          continue;
        }

        flushParallelGroup();
        groups.push([item.toolCallId]);
      }

      flushParallelGroup();
    }

    return groups;
  }

  private validateNoCycles(groups: ToolCallId[][]): void {
    for (const group of groups) {
      const groupSet = new Set(group);

      for (const toolId of group) {
        const item = this.itemsMap.get(toolId);
        if (!item) continue;

        for (const dep of item.dependencies) {
          if (groupSet.has(dep)) {
            throw createCoreError(
              CoreErrorType.InvalidStateTransition,
              `Circular dependency detected: ${toolId} depends on ${dep} in same group`,
              {
                context: { toolId, dependency: dep, group },
                recoverable: false,
              },
            );
          }
        }
      }
    }
  }
}

// -----------------------------------------------
// Default instance
// -----------------------------------------------

// 按工具名判定的只读白名单，被 schedule()（填 item.readOnly）与 canRunInParallel()（兜底）
// 共用；两处都只在没有显式传 readOnly 时使用。
// 注意这份表按名字放行、不看参数：名字一旦加进来，该工具的全部调用都按可并发处理，
// 且表内并非全是纯读工具（TodoWrite 会改会话状态），别按「白名单=只读」来理解。
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
]);

export const defaultToolScheduler = new ToolScheduler();
