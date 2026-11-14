import type {
  WorkflowGraphCollection,
  WorkflowGraphNode,
  WorkflowRunSnapshot,
} from "@zcode/contracts";
import { collectionNodeIdsForGraph, nodeById } from "./graph.js";

/**
 * ============================================================================
 * workflow/scheduler/prompts.ts —— 调度器默认提示词与文件名清洗
 * ============================================================================
 *
 * 【定位】node-runner 与 collection-planner 在调用方没提供自定义 buildPrompt
 * 时使用的默认提示词模板，以及产物文件名安全化工具。
 * 本文件只拼字符串，不做 I/O；模板里约定的输出形态与解析器（planner-result、
 * node-runner 的 Markdown 产物）是配套契约。
 * ============================================================================
 */

/**
 * 构造单个节点的默认执行提示词。
 * 输入：快照、节点、阶段名；输出：包含任务、节点目标/指令与既往产物清单的文本。
 * 纯函数；产物清单只给 label + path，不内联正文，避免提示词随产物体积膨胀。
 * 约定：模型只执行该节点范围，返回简洁 Markdown（改动/验证/残余风险）。
 */
export function buildDefaultNodePrompt(
  snapshot: WorkflowRunSnapshot,
  node: WorkflowGraphNode,
  phase: string,
): string {
  const previousArtifacts = snapshot.artifacts
    .map((artifact) => `- ${artifact.label}: ${artifact.path}`)
    .join("\n");
  return [
    `You are running a ZCode workflow node for phase: ${phase}.`,
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
 * 构造集合扩张 planner 的默认提示词。
 * 输入：快照、集合、阶段名；输出含集合目标/指标、现有成员状态以及 JSON 输出样例。
 * 模板里的 JSON 形状是 parseWorkflowPlannerResult 的配套契约；"exhausted=true
 * 仅在没有有用扩张时"直接对应调度器的集合关闭条件。
 * 纯函数；现有成员逐行列出 id/status/title，让 planner 避免重复造节点。
 */
export function buildDefaultPlannerPrompt(
  snapshot: WorkflowRunSnapshot,
  collection: WorkflowGraphCollection,
  phase: string,
): string {
  const collectionNodes = collectionNodeIdsForGraph(collection, snapshot.graph)
    .map((nodeId) => nodeById(snapshot.graph, nodeId))
    .filter((node): node is WorkflowGraphNode => node !== undefined)
    .map(
      (node) =>
        `- ${node.id} [${node.status}]: ${node.title}${node.description ? ` - ${node.description}` : ""}`,
    )
    .join("\n");
  return [
    `You are running a ZCode workflow exploration planner for phase: ${phase}.`,
    `Workflow run: ${snapshot.runId}`,
    `Working directory: ${snapshot.cwd}`,
    "",
    `User task:\n${snapshot.task}`,
    "",
    `Collection: ${collection.title ?? collection.collectionId}`,
    `Collection id: ${collection.collectionId}`,
    collection.goal ? `Goal:\n${collection.goal}` : undefined,
    collection.metric ? `Metric:\n${collection.metric}` : undefined,
    "",
    collectionNodes.length > 0
      ? `Existing collection nodes:\n${collectionNodes}`
      : "No existing collection nodes.",
    "",
    "Return only JSON matching this shape:",
    '{"nodes":[{"id":"string","title":"string","description":"string","dependsOn":["node-id"],"prompt":"string"}],"edges":[{"from":"node-id","to":"node-id"}],"collectionNodeIds":["node-id"],"exhausted":false,"reasoning":"string"}',
    "Use unique node ids, avoid cycles, and set exhausted=true only when no useful expansion remains.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * 把节点/集合标识清洗成可安全落盘的文件名片段。
 * 规则：非字母数字与 . _ - 的字符替换为 _，截断到 100 字符，空结果回退 "node"。
 * 目的：阻止路径穿越与非法文件名；结果只作为单段名，不包含目录分隔符。
 */
export function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "node";
}
