// INV-01 空部件回退到三件套：守住位置 部件长度判断；改错故障 无部件消息整段空白。
// INV-02 回退顺序思考在前：守住位置 数组展开顺序；改错故障 思考块排在正文之后。
// INV-03 只展示根工具调用：守住位置 父标识过滤；改错故障 子代理内部调用平铺到主列表。
// INV-04 父标识自引用视为根：守住位置 父等于自身判断；改错故障 自引用调用被隐藏。
// INV-05 父不存在也视为根：守住位置 候选存在性检查；改错故障 孤儿调用整条消失。
// INV-06 显式部件优先：守住位置 三元第一分支；改错故障 新协议被旧三件套覆盖。
// INV-07 工具调用按标识索引：守住位置 映射构建；改错故障 重复扫描退化为平方复杂度。
// INV-08 同一工具只渲染一次：守住位置 已渲染集合；改错故障 同一调用出现多张卡片。
// INV-09 缺工具定义跳过：守住位置 空值判断；改错故障 渲染出空卡片。
// INV-10 父未到时子调用跳过：守住位置 父标识存在判断；改错故障 子调用先于父出现。
// INV-11 流式中不给最新块：守住位置 流式标志；改错故障 流式期间正文重复上浮。
// INV-12 中断态不给最新块：守住位置 中断标志；改错故障 中断后正文被抽走。
// INV-13 结算态不给最新块：守住位置 结算标志；改错故障 结算动画期间布局跳动。
// INV-14 最新块取最后一个匹配：守住位置 从后查找；改错故障 相同文本取到第一块。
// INV-15 历史块排除最新块：守住位置 下标不等过滤；改错故障 正文在两处重复。
// INV-16 无最新块时历史保留全部：守住位置 负下标；改错故障 空索引过滤掉首块。
// INV-17 返回字段固定四个：守住位置 返回结构；改错故障 调用方读到未定义字段。
// INV-18 本模块不改写入参：守住位置 部件拷贝；改错故障 上层数组被排序污染。
//
// 模块职责：把助手消息部件投影成内容、思考与工具调用块。
// 状态所有权：无状态；输入部件与工具调用由调用方提供。
// 阅读顺序：先看回退构造，再读主投影循环，最后看最新块与历史块切分。
import {
  getLatestAssistantContentPart,
  type ZCodeAssistantMessagePart,
} from "./assistant-message-parts.js";

export interface ZCodeAssistantPresentationToolCall {
  toolId: string;
  parentToolUseId?: string | null;
  kind: string;
  title?: string;
  input: unknown;
  status: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
}

export type ZCodeAssistantPresentationBlock =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "thought";
      content: string;
    }
  | {
      type: "tool-call";
      toolCall: ZCodeAssistantPresentationToolCall;
    };

export interface ZCodeAssistantPresentation {
  messageParts: ZCodeAssistantMessagePart[];
  blocks: ZCodeAssistantPresentationBlock[];
  latestPart: Extract<ZCodeAssistantPresentationBlock, { type: "content" }> | null;
  historyBlocks: ZCodeAssistantPresentationBlock[];
}

export interface BuildZCodeAssistantPresentationOptions {
  content: string;
  thought?: string;
  toolCalls?: readonly ZCodeAssistantPresentationToolCall[];
  parts?: readonly ZCodeAssistantMessagePart[];
  streaming?: boolean;
  interrupted?: boolean;
  settling?: boolean;
}

// 只把 parentToolUseId 为空的 toolCall 当根调用，子调用交给父调用统一渲染。
// parentToolUseId 为 null 视为根，兼容旧消息没写父标识的情形。
// parentToolUseId 等于自身 toolId 的自引用也当根，否则该调用永远不出现在画布上。
// parentToolUseId 在 toolCalls 里查不到时同样当根，避免父调用被裁掉后整棵子树消失。
// thought 块排在最前，content 块排在最后，中间的 tool-call 保持原始顺序。
// content 块排在 tool-call 之后，保证正文永远落在工具卡片下方。
function buildFallbackAssistantParts({
  content,
  thought,
  toolCalls,
}: Pick<BuildZCodeAssistantPresentationOptions, "content" | "thought" | "toolCalls">) {
  const rootToolCalls = (toolCalls ?? []).filter((toolCall) => {
    const parentToolUseId = toolCall.parentToolUseId ?? null;
    return (
      !parentToolUseId ||
      parentToolUseId === toolCall.toolId ||
      !(toolCalls ?? []).some((candidate) => candidate.toolId === parentToolUseId)
    );
  });

  return [
    ...(thought ? [{ type: "thought", content: thought } as const] : []),
    ...rootToolCalls.map(
      (toolCall) =>
        ({
          type: "tool-call",
          toolId: toolCall.toolId,
        }) as const,
    ),
    ...(content ? [{ type: "content", content } as const] : []),
  ];
}

export function buildZCodeAssistantPresentation({
  content,
  thought,
  toolCalls = [],
  parts,
  streaming = false,
  interrupted = false,
  settling = false,
}: BuildZCodeAssistantPresentationOptions): ZCodeAssistantPresentation {
  const messageParts =
    parts && parts.length > 0
      ? [...parts]
      : buildFallbackAssistantParts({ content, thought, toolCalls });
  const toolCallById = new Map(toolCalls.map((toolCall) => [toolCall.toolId, toolCall]));
  const renderedToolCallIds = new Set<string>();
  const blocks: ZCodeAssistantPresentationBlock[] = [];

  // content 与 thought 部件直接 push 成块，不做二次裁剪。
  // tool-call 部件先经 toolCallById 查定义，查不到就直接跳过。
  // toolCallById 缺失 part.toolId 时 continue，避免渲染出空卡片。
  // renderedToolCallIds 保证同一个 toolId 只渲染一次，重复部件不会叠加。
  // 父调用已在 toolCallById 里时跳过子调用，避免父子各画一遍。
  // 入块后立刻把 toolId 写进 renderedToolCallIds，后续重复部件才能被拦住。
  for (const part of messageParts) {
    if (part.type === "content") {
      blocks.push({ type: "content", content: part.content });
      continue;
    }
    if (part.type === "thought") {
      blocks.push({ type: "thought", content: part.content });
      continue;
    }

    const toolCall = toolCallById.get(part.toolId);
    if (!toolCall || renderedToolCallIds.has(part.toolId)) {
      continue;
    }
    const parentToolUseId = toolCall.parentToolUseId ?? null;
    if (
      parentToolUseId &&
      parentToolUseId !== toolCall.toolId &&
      toolCallById.has(parentToolUseId)
    ) {
      continue;
    }
    renderedToolCallIds.add(part.toolId);
    blocks.push({ type: "tool-call", toolCall });
  }

  // streaming 等三种进行态都不给 latestPart，流式期间不抢最新块。
  // 只有 type 为 content 的 block 参与最新块选择，thought 与 tool-call 不参与。
  // 选择逻辑委托 getLatestAssistantContentPart，本函数不重复实现比较规则。
  // getLatestAssistantContentPart 可能返回 null，latestPart 因此允许为空。
  // blocks 只读传入，filter 生成新数组而不改写调用方的块数组。
  const latestContentPart =
    streaming || interrupted || settling
      ? null
      : getLatestAssistantContentPart(
          blocks
            .filter(
              (block): block is Extract<ZCodeAssistantPresentationBlock, { type: "content" }> =>
                block.type === "content",
            )
            .map((block) => ({ type: "content", content: block.content })),
        );
  let latestPart: Extract<ZCodeAssistantPresentationBlock, { type: "content" }> | null = null;
  let latestBlockIndex = -1;
  if (latestContentPart) {
    latestBlockIndex = blocks.findLastIndex(
      (block) => block.type === "content" && block.content === latestContentPart.content,
    );
    latestPart =
      latestBlockIndex >= 0
        ? (blocks[latestBlockIndex] as Extract<
            ZCodeAssistantPresentationBlock,
            { type: "content" }
          >)
        : null;
  }

  // messageParts 原样返回，调用方可以按部件顺序重建消息。
  // blocks 的顺序就是渲染顺序，UI 不再二次排序。
  // latestPart 可以为 null：没有 content 块或处于进行态时都属于这种情形。
  // historyBlocks 用 filter 按同一顺序过滤，不重排 blocks。
  // historyBlocks 返回新数组，messageParts 与 blocks 的入参不被改写。
  return {
    messageParts,
    blocks,
    latestPart,
    historyBlocks: blocks.filter((_, index) => index !== latestBlockIndex),
  };
}
