/**
 * ============================================================================
 * workflow/expert/graph-artifacts.ts —— 阶段产物 → 图结构的两类增量应用
 * ============================================================================
 *
 * 【定位】agent 阶段结束后，模型产物可能驱动图的两处变化：
 *   1) seedGraphFromPhaseArtifact：把新节点/边/collection 播种进目标阶段；
 *   2) updateNodePromptsFromPhaseArtifact：改写目标阶段已有节点的 prompt/title/desc。
 * 两者都只做增量（不删节点、不重置已有状态），且各自受 definition 上的
 * seedGraphFromArtifact / nodePromptsFromArtifact 开关约束。
 *
 * 【失败/跳过口径】
 *   - 未配置来源、产物解析为 null、解析出空 seed、应用后 changed=false → 静默跳过
 *     （返回原快照）。播种是增强能力，不能让"模型没输出图"变成阶段失败。
 *   - 结构非法（重复节点/未知边端点/自环/成环/未知节点 id）由 lifecycle 的
 *     apply* 抛错 → 冒泡到 continueRun，阶段被置 paused（错误必须可见）。
 *
 * 【写入顺序】先写快照，再写 graph 记录，最后发图事件；顺序颠倒会让 UI/恢复
 * 看到"事件已发生但快照未更新"的窗口。
 * ============================================================================
 */

import {
  applyWorkflowGraphSeed,
  applyWorkflowNodePromptUpdates,
  type ApplyWorkflowGraphSeedResult,
} from "../lifecycle.js";
import { edgeId, phaseNodeId } from "./ids.js";
import { gateRootSeedNodes, parseWorkflowGraphSeed } from "./parsers/graph-seed.js";
import { parseWorkflowNodePromptUpdateSet } from "./parsers/node-prompts.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunSnapshot, WorkflowPhaseDefinition } from "@zcode/contracts";

/**
 * 用阶段产物给 targetPhase 播种图。
 *
 * 输入：phase-runner 产出的 response（模型原文）、阶段定义、取消信号。
 * 输出：应用后的快照；跳过时返回输入快照（引用不变）。
 * gateAfterPhase 存在时，先给"根节点"补一条闸门节点入边，保证新子图必须等闸门
 * 阶段完成后才可被调度（否则新节点会在前置阶段未完成时抢跑）。
 * 副作用：写快照 + 节点/边/collection 图记录 + graph_seeded op 记录 + graph_expanded 事件。
 */
export async function seedGraphFromPhaseArtifact(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  response: string,
  signal?: AbortSignal,
): Promise<ExpertWorkflowRunSnapshot> {
  if (!definition.seedGraphFromArtifact) {
    return snapshot;
  }

  const targetPhase = definition.seedGraphFromArtifact.targetPhase;
  const seed = parseWorkflowGraphSeed(response, targetPhase);
  // 解析失败或空草案：直接放过（不写快照也不发事件），避免给恢复端制造一次无变化的写入。
  if (!seed || (seed.nodes.length === 0 && seed.collections.length === 0)) {
    return snapshot;
  }

  // 闸门：只有 gateAfterPhase 声明时才补边，让新根节点依赖闸门阶段节点。
  const normalizedSeed = definition.seedGraphFromArtifact.gateAfterPhase
    ? gateRootSeedNodes(seed, phaseNodeId(definition.seedGraphFromArtifact.gateAfterPhase))
    : seed;
  // applyWorkflowGraphSeed 内部做严格校验（重复/未知端点/自环/成环），非法即抛错。
  const applied = applyWorkflowGraphSeed(snapshot, normalizedSeed, {
    phase: targetPhase,
    timestamp: ctx.timestamp(),
  });
  // 规范化后仍可能无净增量（例如全部条目已存在），此时不产生任何写入。
  if (!applied.changed) {
    return snapshot;
  }

  await ctx.store.writeSnapshot(applied.snapshot, { signal });
  await appendGraphSeedRecords(ctx, applied.snapshot, applied, definition.phase, signal);
  await ctx.appendEvent(applied.snapshot.runId, "graph_expanded", {
    message: `Workflow graph seeded from ${definition.title}.`,
    payload: {
      collectionIds: applied.addedCollections.map((collection) => collection.collectionId),
      edgeIds: applied.addedEdges.map(edgeId),
      nodeIds: applied.addedNodes.map((node) => node.id),
      sourcePhase: definition.phase,
      targetPhase,
    },
    phase: definition.phase,
    signal,
  });
  return applied.snapshot;
}

/**
 * 用阶段产物更新 targetPhase 已有节点的问题描述/prompt。
 *
 * 只覆盖 title/description/prompt（未提供的字段保持原值）；节点必须真实存在且
 * 属于 targetPhase，否则 lifecycle 抛错（阶段 paused）。
 * 输出：更新后的快照；无来源配置/解析为空/无实际变化时返回输入快照。
 * 副作用：写快照 + node_prompts_updated op 记录 + graph_updated 事件。
 */
export async function updateNodePromptsFromPhaseArtifact(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  response: string,
  signal?: AbortSignal,
): Promise<ExpertWorkflowRunSnapshot> {
  if (!definition.nodePromptsFromArtifact) {
    return snapshot;
  }

  const targetPhase = definition.nodePromptsFromArtifact.targetPhase;
  const updateSet = parseWorkflowNodePromptUpdateSet(response);
  // 解析失败/空更新：静默跳过。meta_prompt 阶段偶尔不产出结构化更新，
  // 此时沿用原 prompt 继续执行比让整个阶段失败更符合"增强而非强制"的定位。
  if (!updateSet || updateSet.nodes.length === 0) {
    return snapshot;
  }

  const applied = applyWorkflowNodePromptUpdates(snapshot, updateSet.nodes, {
    phase: targetPhase,
    timestamp: ctx.timestamp(),
  });
  // 字段值与旧值完全一致时 lifecycle 返回 changed=false，不写快照也不发事件。
  if (!applied.changed) {
    return snapshot;
  }

  await ctx.store.writeSnapshot(applied.snapshot, { signal });
  await ctx.store.appendGraphRecord(
    applied.snapshot.runId,
    {
      nodeIds: applied.updatedNodes.map((node) => node.id),
      payload: {
        sourcePhase: definition.phase,
        targetPhase,
      },
      phase: definition.phase,
      recordType: "op",
      runId: applied.snapshot.runId,
      timestamp: ctx.timestamp(),
      type: "node_prompts_updated",
    },
    { signal },
  );
  await ctx.appendEvent(applied.snapshot.runId, "graph_updated", {
    message: `Workflow node prompts updated from ${definition.title}.`,
    payload: {
      nodeIds: applied.updatedNodes.map((node) => node.id),
      sourcePhase: definition.phase,
      targetPhase,
    },
    phase: definition.phase,
    signal,
  });
  return applied.snapshot;
}

/**
 * 把播种产生的节点/边/collection 逐条写成 append-only 图记录。
 *
 * 顺序：node → edge → collection → graph_seeded op。节点先于边的原因同 writeInitialGraph
 * （重放时不能出现悬空边）；最后一并写 op 记录，便于恢复端一次识别"这批条目来自
 * 哪次播种"（payload.sourcePhase 记录来源阶段）。
 * 失败语义：任一写入失败即中断，调用方（seedGraphFromPhaseArtifact）会让阶段失败。
 */
async function appendGraphSeedRecords(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  applied: ApplyWorkflowGraphSeedResult<ExpertWorkflowRunSnapshot>,
  phase: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const node of applied.addedNodes) {
    await ctx.store.appendGraphRecord(
      snapshot.runId,
      {
        node,
        recordType: "node",
        runId: snapshot.runId,
        timestamp: ctx.timestamp(),
      },
      { signal },
    );
  }
  for (const edge of applied.addedEdges) {
    await ctx.store.appendGraphRecord(
      snapshot.runId,
      {
        edge,
        recordType: "edge",
        runId: snapshot.runId,
        timestamp: ctx.timestamp(),
      },
      { signal },
    );
  }
  for (const collection of applied.addedCollections) {
    await ctx.store.appendGraphRecord(
      snapshot.runId,
      {
        collection,
        recordType: "collection",
        runId: snapshot.runId,
        timestamp: ctx.timestamp(),
      },
      { signal },
    );
  }
  await ctx.store.appendGraphRecord(
    snapshot.runId,
    {
      edgeIds: applied.addedEdges.map(edgeId),
      nodeIds: applied.addedNodes.map((node) => node.id),
      payload: {
        collectionIds: applied.addedCollections.map((collection) => collection.collectionId),
        sourcePhase: phase,
      },
      phase,
      recordType: "op",
      runId: snapshot.runId,
      timestamp: ctx.timestamp(),
      type: "graph_seeded",
    },
    { signal },
  );
}
