import {
  WorkflowNodePromptUpdateSchema,
  WorkflowNodePromptUpdateSetSchema,
  type WorkflowNodePromptUpdate,
} from "@zcode/contracts";
import {
  isRecord,
  parsePlannerJson,
  readLooseArray,
  readLooseString,
  readLooseValue,
  stringValue,
} from "./json.js";

/**
 * ============================================================================
 * workflow/expert/parsers/node-prompts.ts —— 节点 prompt 更新的解析与归一化
 * ============================================================================
 *
 * 【定位】把阶段产物中的"给已有节点改写 prompt/描述/标题"指令解析为更新集合，
 * 由 graph-artifacts.updateNodePromptsFromPhaseArtifact 合入快照。
 *
 * 【宽松边界】支持数组包裹、nodes 列表、以及 id -> 字符串/对象的映射表三种形态；
 * prompt 的近义键（instructions/rules/metaPrompt 等）都能识别。
 *
 * 【失败语义】JSON 不可解析或归一化后 schema 不通过时返回 null；调用方看到
 * null 或空 nodes 时直接跳过，不写快照、不发事件，阶段继续执行。
 * ============================================================================
 */

/**
 * 解析节点 prompt 更新集合。
 * 输入：模型原始文本；输出：{ nodes, reasoning? } 或 null。
 * 失败语义：与 graph-seed 一致——吞掉 JSON 解析错误并返回 null，不向上抛。
 * 下游影响：更新只作用于已存在且阶段匹配的节点，跨阶段改 prompt 会被 lifecycle 拒绝。
 */
export function parseWorkflowNodePromptUpdateSet(
  response: string,
): { nodes: WorkflowNodePromptUpdate[]; reasoning?: string } | null {
  let raw: unknown;
  try {
    raw = parsePlannerJson(response);
  } catch {
    return null;
  }
  return normalizeWorkflowNodePromptUpdateSetCandidate(raw);
}

/**
 * 把候选值归一化为更新集合；结构不可用时返回 null。
 * 直通 schema 要求 nodes 非空，否则继续走宽松合并（列表 + 映射表）。
 */
function normalizeWorkflowNodePromptUpdateSetCandidate(
  value: unknown,
): { nodes: WorkflowNodePromptUpdate[]; reasoning?: string } | null {
  // 纯数组视为节点更新列表，统一包成 nodes 后再递归处理。
  if (Array.isArray(value)) {
    return normalizeWorkflowNodePromptUpdateSetCandidate({ nodes: value });
  }

  if (!isRecord(value)) return null;
  const direct = WorkflowNodePromptUpdateSetSchema.safeParse(value);
  if (direct.success && direct.data.nodes.length > 0) return direct.data;

  const nodeCandidates = readLooseArray(value, [
    "nodes",
    "nodePrompts",
    "node_prompts",
    "nodeInstructions",
    "node_instructions",
  ]);
  const keyedCandidates = normalizeWorkflowNodePromptUpdateMap(
    readLooseValue(value, [
      "nodePrompts",
      "node_prompts",
      "nodeInstructions",
      "node_instructions",
      "prompts",
    ]),
  );
  const nodes = [...(nodeCandidates ?? []), ...keyedCandidates]
    .map(normalizeWorkflowNodePromptUpdate)
    .filter((node): node is WorkflowNodePromptUpdate => node !== null);
  const parsed = WorkflowNodePromptUpdateSetSchema.safeParse({
    nodes,
    reasoning: stringValue(value.reasoning),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 把 id -> 内容 的映射表展开成更新项数组。
 * 字符串值视为仅改 prompt；对象值以映射键作为缺省 id，但对象内显式 id 优先。
 * 非对象或数组返回空数组（映射形态不成立时静默忽略）。
 */
function normalizeWorkflowNodePromptUpdateMap(value: unknown): unknown[] {
  if (!isRecord(value) || Array.isArray(value)) return [];
  return Object.entries(value).map(([id, entry]) =>
    typeof entry === "string"
      ? {
          id,
          prompt: entry,
        }
      : isRecord(entry)
        ? {
            id,
            ...entry,
          }
        : {
            id,
          },
  );
}

/**
 * 归一化单条更新；缺 id 返回 null 丢弃。
 * schema 的 refine 要求 prompt/description/title 至少一个，不满足时同样返回 null，
 * 防止生成"空更新"占用一次写入。
 */
function normalizeWorkflowNodePromptUpdate(value: unknown): WorkflowNodePromptUpdate | null {
  if (!isRecord(value)) return null;
  const id = readLooseString(value, ["id", "name", "nodeId", "node_id", "nodeName", "node_name"]);
  if (!id) return null;
  const prompt = readLooseString(value, [
    "prompt",
    "instructions",
    "instruction",
    "rules",
    "metaPrompt",
    "meta_prompt",
    "nodePrompt",
    "node_prompt",
  ]);
  const description = readLooseString(value, ["description", "objective", "goal", "summary"]);
  const title = readLooseString(value, ["title"]);
  const parsed = WorkflowNodePromptUpdateSchema.safeParse({
    description,
    id,
    prompt,
    title,
  });
  return parsed.success ? parsed.data : null;
}
