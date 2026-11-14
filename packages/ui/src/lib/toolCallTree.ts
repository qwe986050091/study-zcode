// INV-01 渲染相等必须逐字段比较，且深度比较有预算：守住位置 areTaskChatToolCallsRenderEqual；改错故障 超大输出导致比较阻塞主线程。
// INV-02 同一引用直接判定相等，跳过字段比较：守住位置 首行判断；改错故障 流式增量也走全量比较。
// INV-03 父标识比较前统一把空值归一：守住位置 父标识比较；改错故障 空与未定义被判定为不同，缓存永远失效。
// INV-04 深度比较只认普通对象与数组：守住位置 普通对象判定；改错故障 类实例被逐键展开，产生误判。
// INV-05 预算按对象节点扣减，耗尽即判定不等：守住位置 预算检查；改错故障 深树比较耗时无上界。
// INV-06 数组必须长度相同且逐项相等：守住位置 数组分支；改错故障 截断的流式数组被判相等。
// INV-07 对象必须键集合一致且逐值相等：守住位置 键比较；改错故障 新增字段被忽略，界面停在旧值。
// INV-08 子树复用必须同时满足调用相等与子节点数组相等：守住位置 节点收口判断；改错故障 复用了引用但子节点已变。
// INV-09 父节点缺失或自引用时回退到根层：守住位置 父解析；改错故障 异常父标识让工具整条消失。
// INV-10 父标识等于自身时不得挂到自身：守住位置 自引用判断；改错故障 构建出环形树导致渲染栈溢出。
// INV-11 节点映射按工具标识唯一，后写覆盖前写：守住位置 节点映射写入；改错故障 重复标识生成两棵树。
// INV-12 树的构建结果与旧树引用相等时必须返回旧树：守住位置 末尾比较；改错故障 无变化时仍触发整棵重渲染。
// INV-13 默认入参为空数组，允许无参调用：守住位置 两个导出函数签名；改错故障 调用方必须自行兜底。
// INV-14 比较预算每次调用独立，不跨调用累计：守住位置 预算字面量；改错故障 首次比较后预算被永久耗尽。
// INV-15 节点结构只含工具调用与子节点，不携带派生字段：守住位置 节点接口；改错故障 派生字段与源数据不同步。
// INV-16 遍历顺序即输入顺序，不排序：守住位置 父子挂载循环；改错故障 时间线顺序被打乱。
// INV-17 子节点数组必须是新建数组，不能共享草稿数组：守住位置 节点收口映射；改错故障 复用导致后续挂载污染旧树。
// INV-18 本期不处理跨层去重，同标识只保留首层挂载：守住位置 父映射查找；改错故障 同名子工具被挂到错误父节点。
//
// 模块职责：把扁平工具调用数组重建为父子树，并在重建时尽量复用旧节点引用。
// 状态所有权：无状态；旧树只作为复用来源传入，不被修改。
// 阅读顺序：先看深度比较，再看单节点复用判定，最后读重建流程中的父挂载与最终比较。
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}

interface ToolCallTreeDraftNode {
  toolCall: TaskChatToolCall;
  childToolCalls: ToolCallTreeDraftNode[];
}

interface DeepEqualBudget {
  remaining: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

// areUnknownValuesEqual 先 Object.is(left, right) 走引用快路径，再判 typeof 不同或任一 null、非对象直接 false；每次进入对象比较 budget.remaining -= 1，< 0 即返回 false 防止深比较失控；数组长宽不等直接 false，普通对象按键数与 hasOwnProperty 逐键递归。
function areUnknownValuesEqual(left: unknown, right: unknown, budget: DeepEqualBudget): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => areUnknownValuesEqual(item, right[index], budget));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      areUnknownValuesEqual(left[key], right[key], budget),
  );
}

// areTaskChatToolCallsRenderEqual 先比较 toolId/parentToolUseId/toolName/kind/title/status/content/thought/error/startedAt 等标量，任一不等提前 false；parentToolUseId 用 ?? null 归一；input/output/raw/snapshotRefs 四个大字段各自 new { remaining: 500 } 走 areUnknownValuesEqual，预算独立不互相挤占。
export function areTaskChatToolCallsRenderEqual(
  left: TaskChatToolCall,
  right: TaskChatToolCall,
): boolean {
  if (left === right) {
    return true;
  }
  return (
    left.toolId === right.toolId &&
    (left.parentToolUseId ?? null) === (right.parentToolUseId ?? null) &&
    left.toolName === right.toolName &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.status === right.status &&
    left.content === right.content &&
    left.thought === right.thought &&
    left.error === right.error &&
    left.startedAt === right.startedAt &&
    areUnknownValuesEqual(left.input, right.input, { remaining: 500 }) &&
    areUnknownValuesEqual(left.output, right.output, { remaining: 500 }) &&
    areUnknownValuesEqual(left.raw, right.raw, { remaining: 500 }) &&
    areUnknownValuesEqual(left.snapshotRefs, right.snapshotRefs, { remaining: 500 })
  );
}

// collectPreviousNodes 递归遍历 previousTree 所有层级，把 nodeById.set(node.toolCall.toolId, node) 写入索引；同 toolId 后写覆盖先写，以最近一次为准；只读遍历，不修改旧树结构。
function collectPreviousNodes(
  nodes: readonly TaskChatToolCallTreeNode[],
  nodeById: Map<string, TaskChatToolCallTreeNode>,
) {
  for (const node of nodes) {
    nodeById.set(node.toolCall.toolId, node);
    collectPreviousNodes(node.childToolCalls, nodeById);
  }
}

// areNodeArraysEqual 要求 left.length === right.length 且 left.every((node, index) => node === right[index])：长度不同直接不等，长度相同还必须逐项引用相等，才允许 finalizeToolCallTreeNode 复用 previousNode。
function areNodeArraysEqual(
  left: readonly TaskChatToolCallTreeNode[],
  right: readonly TaskChatToolCallTreeNode[],
) {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

// finalizeToolCallTreeNode 先递归 map 出 childToolCalls，再从 previousNodeById 取 previousNode；只有 previousNode.toolCall === draftNode.toolCall 且 areNodeArraysEqual(previousNode.childToolCalls, childToolCalls) 同时成立才返回 previousNode，否则新建节点但子数组仍可能是复用引用。
function finalizeToolCallTreeNode(
  draftNode: ToolCallTreeDraftNode,
  previousNodeById: Map<string, TaskChatToolCallTreeNode>,
): TaskChatToolCallTreeNode {
  const childToolCalls = draftNode.childToolCalls.map((child) =>
    finalizeToolCallTreeNode(child, previousNodeById),
  );
  const previousNode = previousNodeById.get(draftNode.toolCall.toolId);

  if (
    previousNode &&
    previousNode.toolCall === draftNode.toolCall &&
    areNodeArraysEqual(previousNode.childToolCalls, childToolCalls)
  ) {
    return previousNode;
  }

  return {
    toolCall: draftNode.toolCall,
    childToolCalls,
  };
}

export function buildToolCallTree(
  toolCalls: readonly TaskChatToolCall[] = [],
): TaskChatToolCallTreeNode[] {
  return reconcileToolCallTree(toolCalls);
}

// reconcileToolCallTree 先 collectPreviousNodes 索引旧树，再按 toolCalls 顺序建 draft 节点并在语义未变时沿用 previousNode.toolCall；第二次遍历挂载父子关系，父不存在或 parentToolUseId === toolId 自引用都回退根层；最后 areNodeArraysEqual 整组比较，相等直接返回 previousTree。
export function reconcileToolCallTree(
  toolCalls: readonly TaskChatToolCall[] = [],
  previousTree: readonly TaskChatToolCallTreeNode[] = [],
): TaskChatToolCallTreeNode[] {
  const previousNodeById = new Map<string, TaskChatToolCallTreeNode>();
  collectPreviousNodes(previousTree, previousNodeById);

  const toolCallNodeById = new Map<string, ToolCallTreeDraftNode>();

  for (const toolCall of toolCalls) {
    const previousNode = previousNodeById.get(toolCall.toolId);
    toolCallNodeById.set(toolCall.toolId, {
      // 性能修复原因：streaming chunk 会让消息数组频繁重建，语义未变的 toolCall
      // 如果每轮都换引用，ToolCallBlock 的 memo 会被 childToolCalls 新数组击穿。
      toolCall:
        previousNode && areTaskChatToolCallsRenderEqual(previousNode.toolCall, toolCall)
          ? previousNode.toolCall
          : toolCall,
      childToolCalls: [],
    });
  }

  const rootToolCalls: ToolCallTreeDraftNode[] = [];
  for (const toolCall of toolCalls) {
    const node = toolCallNodeById.get(toolCall.toolId);
    if (!node) {
      continue;
    }

    const parentToolUseId = toolCall.parentToolUseId ?? null;
    const parentNode =
      parentToolUseId && parentToolUseId !== toolCall.toolId
        ? toolCallNodeById.get(parentToolUseId)
        : undefined;

    if (parentNode) {
      parentNode.childToolCalls.push(node);
    } else {
      // 子工具找不到父节点时回退到 root 平铺，避免异常 parent id 直接让工具消失。
      rootToolCalls.push(node);
    }
  }

  const nextTree = rootToolCalls.map((node) => finalizeToolCallTreeNode(node, previousNodeById));
  return areNodeArraysEqual(previousTree, nextTree)
    ? (previousTree as TaskChatToolCallTreeNode[])
    : nextTree;
}
