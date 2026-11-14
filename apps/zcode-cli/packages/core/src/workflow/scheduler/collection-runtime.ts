import { WorkflowSchedulerEventLog } from "./events.js";
import type { WorkflowGraphSchedulerDeps } from "./types.js";

/**
 * collection-planner 依赖的最小运行时切片（由 WorkflowGraphScheduler 组装）。
 * plannerRunner 可缺省：没有 planner 时调度器跳过所有集合扩张。
 * eventLog 负责时间戳、集合记录与事件；writeSnapshot/writeArtifact 负责持久化。
 * 这里只声明能力，不持有状态，便于单测替换。
 *
 * 字段口径：
 * - createActivityId：生成集合/活动 ID，必须全局唯一，由调度器注入实现保证；
 * - eventLog：事件与时间戳的唯一写入点，集合记录也在其中；
 * - plannerRunner：可缺省，undefined 时调度器跳过所有集合扩张，不报错；
 * - writeArtifact / writeSnapshot：宿主持久化钩子，失败语义由宿主决定并可向上抛。
 */
export interface WorkflowCollectionPlannerRuntime {
  createActivityId: () => string;
  eventLog: WorkflowSchedulerEventLog;
  plannerRunner?: WorkflowGraphSchedulerDeps["plannerRunner"];
  writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];
}
