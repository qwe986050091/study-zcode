/**
 * ============================================================================
 * workflow/expert/prompts.ts —— 提示词、阶段摘要与初始图的构造
 * ============================================================================
 *
 * 【定位】工作流里所有"给模型看的文本"和"初始图结构"都在这里生成：
 *   - buildPhasePrompt：agent/critic 阶段子会话的完整提示词；
 *   - buildScheduledNodePrompt：scheduler 里单个 task 节点的提示词；
 *   - buildScheduledPhaseSummary / buildReport：阶段产物与 run 最终报告的正文；
 *   - createPhaseGraph / updateGraphNodeStatus：阶段图的初始形态与状态同步。
 *
 * 【注入口径】提示词只注入"任务 + 策略数值 + 阶段目标 + 已有产物的路径清单"，
 * 不内联 artifact 内容（内容由子会话按路径自行读取），因此 artifact 列表必须
 * 是相对 run 目录的稳定路径，否则子会话找不到文件。
 *
 * 【纯函数】本文件不做 I/O、不发事件；写文件与写快照由调用方负责。
 * ============================================================================
 */

import {
  type ExpertWorkflowRunSnapshot,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowPhaseDefinition,
} from "@zcode/contracts";
import { workflowDefinitionPhaseMap } from "../definition.js";
import { phaseNodeId } from "./ids.js";

/**
 * 构造阶段级提示词（agent 与 critic 共用）。
 *
 * 输入：当前快照与阶段定义。输出单段 Markdown 文本，作为 agentRunner.run 的
 * prompt。结构固定：身份/runId/cwd → 用户任务 → 调度策略数值 → 阶段目标 →
 * 已有产物路径 → 可选"架构图契约" → 输出要求。
 *
 * 关键口径：
 *   - 只有定义了 seedGraphFromArtifact 的阶段才追加 JSON 契约，并要求节点 id 唯一、
 *     引用真实 id、禁止成环——这些约束失败时由 lifecycle 抛错，阶段转为 paused。
 *   - 策略数值来自 snapshot.strategy（持久化事实），不是代码默认值。
 * 无副作用；输出为空任务时仍会产出完整骨架（不返回空串）。
 */
export function buildPhasePrompt(
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
): string {
  const previousArtifacts = snapshot.artifacts
    .map((artifact) => `- ${artifact.label}: ${artifact.path}`)
    .join("\n");
  // 仅当定义声明"该阶段产物要用于播种下游图"时才注入 JSON 契约；否则模型会
  // 输出无用的大段 JSON，既浪费上下文又可能与阶段真实产物格式冲突。
  const architectureGraphContract =
    definition.seedGraphFromArtifact !== undefined
      ? [
          "",
          "Architecture graph contract:",
          `Return a JSON object, either raw or fenced as \`\`\`json, so the workflow runtime can seed the ${definition.seedGraphFromArtifact.targetPhase} DAG:`,
          '{"nodes":[{"id":"implement_auth","title":"Implement auth","description":"small executable unit","dependsOn":["setup_config"],"collectionId":"implementation","prompt":"optional node-specific instructions"}],"edges":[{"from":"setup_config","to":"implement_auth"}],"collections":[{"collectionId":"implementation","title":"Implementation","nodeIds":["setup_config","implement_auth"],"explorable":false,"goal":"ship the feature","metric":"tests pass"}],"reasoning":"brief rationale"}',
          "Node ids must be unique, references must point to real node ids, and edges must not create cycles.",
        ]
      : [];
  return [
    `You are running the ZCode workflow phase: ${definition.phase}.`,
    `Workflow run: ${snapshot.runId}`,
    `Working directory: ${snapshot.cwd}`,
    "",
    `User task:\n${snapshot.task}`,
    "",
    "Scheduling strategy:",
    `- Clarify max rounds: ${snapshot.strategy.clarify.maxRounds}, min rounds: ${snapshot.strategy.clarify.minRounds}, confidence threshold: ${snapshot.strategy.clarify.confidenceThreshold}`,
    `- Executor frontier target: ${snapshot.strategy.executor.frontierTarget}, max concurrent loops: ${snapshot.strategy.executor.maxConcurrentLoops}, max planner runs: ${snapshot.strategy.executor.maxPlannerRuns}`,
    `- React loop max rounds: ${snapshot.strategy.reactLoop.maxRounds}`,
    `- Final critic max iterations: ${snapshot.strategy.finalCritic.maxIterations}`,
    "",
    `Phase objective:\n${definition.description}`,
    "",
    previousArtifacts.length > 0
      ? `Previous artifacts available on disk:\n${previousArtifacts}`
      : "No previous artifacts yet.",
    ...architectureGraphContract,
    "",
    "Output a concise Markdown artifact for this phase. Preserve concrete file paths, commands, risks, and next actions. If this phase executes code, make the edits and run focused validation when practical.",
  ].join("\n");
}

/**
 * 构造单个 task 节点的提示词。
 *
 * 分支：若 node 就是本阶段的 phase 节点（kind=phase 且 phase 相同），直接复用
 * buildPhasePrompt——scheduler 在"空图退化"时会把 phase 节点当作可执行节点。
 * 否则生成节点级提示：节点 id/title/description → node.prompt（meta_prompt 阶段
 * 注入的专属指令）→ 并发/轮次约束 → 已有产物路径 → "只做本节点范围"的输出要求。
 *
 * 输入 node 由 scheduler 传入（可能来自图播种）；输出是完整提示词字符串。
 * 无副作用；undefined 行在末尾统一过滤，不会在文本里留下空行噪声。
 */
export function buildScheduledNodePrompt(
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  node: WorkflowGraphNode,
): string {
  // 空图退化情况下 scheduler 会把 phase 节点当可执行节点传进来，此时提示词就是阶段提示词。
  if (node.phase === definition.phase && node.kind === "phase") {
    return buildPhasePrompt(snapshot, definition);
  }
  const previousArtifacts = snapshot.artifacts
    .map((artifact) => `- ${artifact.label}: ${artifact.path}`)
    .join("\n");
  return [
    `You are running a ZCode workflow node inside phase: ${definition.phase}.`,
    `Workflow run: ${snapshot.runId}`,
    `Working directory: ${snapshot.cwd}`,
    "",
    `User task:\n${snapshot.task}`,
    "",
    `Node: ${node.title}`,
    `Node id: ${node.id}`,
    node.description ? `Node objective:\n${node.description}` : undefined,
    node.prompt ? `Node prompt:\n${node.prompt}` : undefined,
    "",
    "Scheduling constraints:",
    `- Max concurrent loops: ${snapshot.strategy.executor.maxConcurrentLoops}`,
    `- React loop max rounds: ${snapshot.strategy.reactLoop.maxRounds}`,
    "",
    previousArtifacts.length > 0
      ? `Previous artifacts available on disk:\n${previousArtifacts}`
      : "No previous artifacts yet.",
    "",
    "Execute only this node's scope. Return a concise Markdown artifact with changes, validation, and residual risk.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * 生成阶段执行摘要（作为该阶段最终 artifact 的正文）。
 *
 * 数据来源：该阶段所有 activity（状态/产物路径/错误）+ 图里该阶段及所有 task
 * 节点（状态/attempts/error）。用于让后续阶段与 final_critic 快速了解执行结果，
 * 因此只列状态不复制产物全文。
 * 纯函数；无节点/活动时给出 "- No ..." 占位而不是空 section。
 */
export function buildScheduledPhaseSummary(
  snapshot: ExpertWorkflowRunSnapshot,
  phase: string,
): string {
  const activities = snapshot.activities.filter((activity) => activity.phase === phase);
  const activityLines = activities.map(
    (activity) =>
      `- ${activity.nodeId ?? activity.activityId}: ${activity.status}${activity.artifactPath ? ` (${activity.artifactPath})` : ""}${activity.error ? ` error=${activity.error}` : ""}`,
  );
  const nodeLines = snapshot.graph.nodes
    .filter((node) => node.phase === phase || node.kind === "task")
    .map(
      (node) =>
        `- ${node.id}: ${node.status}${node.attempts ? ` attempts=${node.attempts}` : ""}${node.error ? ` error=${node.error}` : ""}`,
    );
  return [
    `# ${phase} Scheduler Summary`,
    "",
    `Run: ${snapshot.runId}`,
    `Status: ${snapshot.status}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    "## Nodes",
    "",
    ...(nodeLines.length > 0 ? nodeLines : ["- No scheduled nodes."]),
    "",
    "## Activities",
    "",
    ...(activityLines.length > 0 ? activityLines : ["- No activities."]),
    "",
  ].join("\n");
}

/**
 * 生成 run 最终报告（Markdown）。
 *
 * 结构：run 元信息 → 各阶段状态与产物路径 → 各 activity（含 session/turn）→
 * artifact 清单。reportPath 由 completeRun 写盘后回填到快照；本函数只负责正文，
 * 不判断 run 是否真的成功（失败/取消时也会正常生成，供用户复盘）。
 */
export function buildReport(snapshot: ExpertWorkflowRunSnapshot): string {
  const phaseLines = snapshot.phases.map(
    (phase) =>
      `- ${phase.phase}: ${phase.status}${phase.artifactPath ? ` (${phase.artifactPath})` : ""}`,
  );
  return [
    `# Workflow Report`,
    "",
    `Run: ${snapshot.runId}`,
    `Task: ${snapshot.task}`,
    `Status: ${snapshot.status}`,
    `Directory: ${snapshot.cwd}`,
    `Created: ${snapshot.createdAt}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    "## Phases",
    "",
    ...phaseLines,
    "",
    "## Activities",
    "",
    ...snapshot.activities.map(
      (activity) =>
        `- ${activity.phase}: ${activity.status} (${activity.activityId})${activity.sessionId ? ` session=${activity.sessionId}` : ""}${activity.turnId ? ` turn=${activity.turnId}` : ""}`,
    ),
    "",
    "## Artifacts",
    "",
    ...snapshot.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`),
    "",
  ].join("\n");
}

/**
 * 构造初始阶段图：每个 phase 一个 phase 节点，按 phaseOrder 串成有向链。
 *
 * 不变量：节点 id 全部经 phaseNodeId 生成，且 dependsOn 只指向直接前驱；
 * edges 与 dependsOn 同时写入（调度器读 dependsOn，恢复/UI 读 edges）。
 * 定义缺某个 phase 时抛错（装配错误，不能生成一张不完整的图）。
 * 纯函数，不读 store。
 */
export function createPhaseGraph(definition: WorkflowDefinition): WorkflowGraph {
  const phaseDefinitions = workflowDefinitionPhaseMap(definition);
  const nodes: WorkflowGraphNode[] = definition.phaseOrder.map((phase) => {
    const phaseDefinition = phaseDefinitions.get(phase);
    if (!phaseDefinition) {
      throw new Error(`${definition.title} definition is missing phase: ${phase}`);
    }
    return {
      dependsOn: [],
      description: phaseDefinition.description,
      id: phaseNodeId(phaseDefinition.phase),
      kind: "phase",
      phase: phaseDefinition.phase,
      status: "pending",
      title: phaseDefinition.title,
    };
  });
  const edges: WorkflowGraphEdge[] = [];
  // 只连相邻阶段：形成线性链，保证同一时刻只有一个"阶段级"可执行节点；
  // 真正的并行由 exec 阶段播种的 task 节点承担。
  for (let index = 1; index < definition.phaseOrder.length; index++) {
    const previous = definition.phaseOrder[index - 1]!;
    const current = definition.phaseOrder[index]!;
    edges.push({
      from: phaseNodeId(previous),
      to: phaseNodeId(current),
    });
    const node = nodes[index]!;
    node.dependsOn = [phaseNodeId(previous)];
  }
  return { collections: [], edges, nodes };
}

/**
 * 同步 phase 节点状态到 graph（phases 数组侧由 updatePhase 处理）。
 *
 * 只改 kind=phase 且 id=phase:<phase> 的那一个节点，collection/edges 原样复用。
 * status 缺省时直接返回原图（调用方可能只 patch 了 error/artifactPath 等字段），
 * 因此本函数对"无状态变更"是幂等的。纯函数，返回新图对象。
 */
export function updateGraphNodeStatus(
  graph: WorkflowGraph,
  phase: string,
  status: WorkflowNodeStatus | undefined,
): WorkflowGraph {
  if (!status) return graph;
  const targetNodeId = phaseNodeId(phase);
  return {
    collections: graph.collections,
    edges: graph.edges,
    nodes: graph.nodes.map((node) =>
      node.id === targetNodeId && node.kind === "phase"
        ? {
            ...node,
            status,
          }
        : node,
    ),
  };
}
