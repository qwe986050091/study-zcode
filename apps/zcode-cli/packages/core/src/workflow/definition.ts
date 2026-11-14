/**
 * ============================================================================
 * workflow/definition.ts —— 内置 expert 工作流的定义与默认策略
 * ============================================================================
 *
 * 【定位】这里定义的是"长程任务模板"：阶段顺序（clarify → task_analysis →
 * arch_decompose → env_setup → meta_prompt → exec → final_critic → complete）、
 * 每阶段的产物路径与行为（agent / planner / critic），以及调度默认参数。
 *
 * 【为什么是数据而不是代码】定义经 WorkflowDefinitionSchema.parse 校验后才
 * 可执行：阶段名、产物路径、strategy 数值都在快照里持久化，恢复时按同一份
 * schema 读回，避免"代码升级后旧 run 语义漂移"。
 *
 * 【默认策略口径】
 *   - executor.maxConcurrentLoops=2：单 run 内最多两个子会话并行；
 *   - maxConsecutiveErrors=3、maxPlannerRuns=10：防止无限重试/无限规划；
 *   - reactLoop.maxRounds=30：单个子代理的 ReAct 轮次上限（不是整个 run）；
 *   - finalCritic.maxIterations=3：验收打回重做的上限。
 * 这些值是产品契约的一部分，调整需同步更新 spec 与恢复兼容性说明。
 * ============================================================================
 */

import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowStrategy,
} from "@zcode/contracts";

// 内置定义的稳定标识：kind/definitionId/version 参与快照持久化与恢复匹配，
// 修改 version 会让旧 run 需要兼容处理。
export const BUILT_IN_EXPERT_WORKFLOW_KIND = "expert";
export const BUILT_IN_EXPERT_WORKFLOW_DEFINITION_ID = "expert";
export const BUILT_IN_EXPERT_WORKFLOW_DEFINITION_VERSION = "2";

export const DEFAULT_EXPERT_WORKFLOW_STRATEGY: WorkflowStrategy = {
  clarify: {
    confidenceThreshold: 0.8,
    maxRounds: 3,
    minRounds: 1,
  },
  executor: {
    drainingChangeHours: 1,
    frontierTarget: 3,
    maxConcurrentLoops: 2,
    maxConsecutiveErrors: 3,
    maxPlannerRuns: 10,
  },
  finalCritic: {
    maxIterations: 3,
  },
  reactLoop: {
    maxRounds: 30,
  },
};

/**
 * 构建内置 expert 工作流定义。
 * 输入无；输出经 WorkflowDefinitionSchema.parse 校验的完整定义（阶段/产物/策略）。
 * 失败语义：schema 校验失败直接抛错，不返回半成品。
 * 每次调用返回新对象；调用方修改不会污染其它 run。
 */
export function createExpertWorkflowDefinition(): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    definitionId: BUILT_IN_EXPERT_WORKFLOW_DEFINITION_ID,
    definitionVersion: BUILT_IN_EXPERT_WORKFLOW_DEFINITION_VERSION,
    description:
      "Durable long-task workflow for large NL->Code work. Child agent sessions perform each phase.",
    kind: BUILT_IN_EXPERT_WORKFLOW_KIND,
    phaseOrder: [
      "clarify",
      "task_analysis",
      "arch_decompose",
      "env_setup",
      "meta_prompt",
      "exec",
      "final_critic",
      "complete",
    ],
    phases: [
      {
        artifactPath: "artifacts/01-clarify.md",
        behavior: "agent",
        description:
          "Refine the user goal, assumptions, acceptance criteria, and unresolved questions. Ask only if blocking.",
        phase: "clarify",
        title: "Clarify",
      },
      {
        artifactPath: "artifacts/02-task-analysis.md",
        behavior: "agent",
        description:
          "Map the task to repo context, constraints, risks, likely files, validation, and failure paths.",
        phase: "task_analysis",
        title: "Task Analysis",
      },
      {
        artifactPath: "artifacts/03-architecture-decompose.md",
        behavior: "agent",
        description:
          "Decompose the work into a dependency graph of implementation and verification nodes.",
        phase: "arch_decompose",
        seedGraphFromArtifact: {
          gateAfterPhase: "meta_prompt",
          targetPhase: "exec",
        },
        title: "Architecture Decompose",
      },
      {
        artifactPath: "artifacts/04-env-setup.md",
        behavior: "agent",
        description:
          "Check whether environment setup, dependencies, credentials, or local services are required.",
        phase: "env_setup",
        title: "Environment Setup",
      },
      {
        artifactPath: "artifacts/05-meta-prompt.md",
        behavior: "agent",
        description:
          "Create the execution instructions, constraints, and node prompts needed for downstream work.",
        nodePromptsFromArtifact: {
          targetPhase: "exec",
        },
        phase: "meta_prompt",
        title: "Meta Prompt",
      },
      {
        artifactPath: "artifacts/06-exec.md",
        behavior: "scheduled_graph",
        description:
          "Execute the planned work through the normal agent runtime. Preserve small steps and validation.",
        phase: "exec",
        title: "Execute",
      },
      {
        artifactPath: "artifacts/07-final-critic.md",
        behavior: "critic",
        description:
          "Review results against acceptance criteria, identify regressions, missing tests, and residual risk.",
        phase: "final_critic",
        title: "Final Critic",
      },
      {
        behavior: "complete",
        description: "Write final report and mark the run completed.",
        phase: "complete",
        title: "Complete",
      },
    ],
    strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
    title: "Expert Workflow",
  });
}

/**
 * 把阶段数组映射为 phase → phase 定义，便于调度器按名查找。
 * 输入已校验的 definition；输出 Map。
 * 重复 phase 会被后者覆盖（schema 应已拦截）；不修改入参。
 */
export function workflowDefinitionPhaseMap(
  definition: WorkflowDefinition,
): Map<string, WorkflowDefinition["phases"][number]> {
  return new Map(definition.phases.map((phase) => [phase.phase, phase]));
}
