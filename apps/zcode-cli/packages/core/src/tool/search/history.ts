import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type {
  CompactBoundaryPayload,
  ModelMessageContentBlock,
  ModelToolContract,
  ResolvedToolSearchMode,
} from "@zcode/contracts";
import {
  createLocalToolDefinitionRenderer,
  localToolsAlreadyLoadedReminder,
  localToolsLoadedReminder,
} from "./local-projection.js";

/**
 * 从 compact boundary 提取可持久/可回放的"已发现工具"事实（只保留两个字段）。
 *
 * 口径：boundaryId 原样透传；preCompactDiscoveredTools 复制成数组（防御性拷贝，避免调用方后续
 * 修改原数组影响已写入的 boundary 或历史条目）。缺省字段归一成空数组，冷恢复不会因此报错。
 * 消费者：compact-active.ts 写新检查点 metadata；tool-search-hydration.ts 冷恢复时重建。
 * 副作用：无（纯映射）。
 */
export function compactDiscoveryMetadata(
  boundary: Pick<CompactBoundaryPayload, "boundaryId" | "preCompactDiscoveredTools">,
) {
  return {
    boundaryId: boundary.boundaryId,
    preCompactDiscoveredTools: [...(boundary.preCompactDiscoveredTools ?? [])],
  };
}

/**
 * 扫描当前请求历史，恢复两类"已发现工具"事实（工具面裁剪与公告重建的输入）。
 *
 * discovered：来自 compactBoundary.preCompactDiscoveredTools，或任意非 attachment、非 error 的 tool
 * 消息里的 tool_reference 块（即曾经把 schema 交给模型加载过的工具名）。
 * preCompactDiscoveredTools：只来自 compactBoundary，用于 Local 模式判断"压缩后应提升为常驻"。
 * 注意：attachment 不是模型输出；isError 的搜索结果不能算"已发现"，否则失败检索会让工具被错误提升；
 * 非数组 content（旧格式字符串结果）直接跳过，不猜测其语义。
 * 副作用：无，返回新 Set；调用方可安全持有。
 */
export function collectToolSearchHistory(entries: readonly RuntimeMessageEntry[]) {
  const discovered = new Set<string>();
  const preCompactDiscoveredTools = new Set<string>();
  for (const entry of entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? []) {
      discovered.add(name);
      preCompactDiscoveredTools.add(name);
    }
    if (entry.kind === "attachment" || entry.message.role !== "tool" || entry.message.isError)
      continue;
    if (!Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_reference") discovered.add(block.toolName);
    }
  }
  return { discovered, preCompactDiscoveredTools };
}

/**
 * 只取 discovered 集合的便捷包装（compact 写入 boundary 时使用）。
 * 口径与 collectToolSearchHistory 完全一致；每次返回新 Set，调用方可安全持有。
 */
export function collectDiscoveredTools(entries: readonly RuntimeMessageEntry[]): Set<string> {
  return collectToolSearchHistory(entries).discovered;
}

/**
 * 把历史里的 tool_reference 块投影成本次请求真正能发给 provider 的消息形态。
 *
 * 三种模式：off 删除全部 ToolSearch 公告与引用；native 保留引用块（provider 自行展开），
 * 只额外记录成功加载的 toolCallId；local 把引用渲染成 <functions> 文本定义并追加加载/调用提示。
 * 输出：entries（投影后的新数组，未改动条目共享原对象）与 loadedToolCallIds（成功搜索并引用了
 * 目录内工具的调用 id，供结算层标记"已加载"）。
 * 不变量：同一批（同一条 assistant 之后的并行 ToolSearch）结果不能互相去重——必须等下一条 assistant
 * 才把"已交付"合入 visible，否则并行搜索同一工具时第二份定义会被误判为重复加载。
 * 副作用：无（不修改原 entry；仅在需要删改时浅拷贝 message）。
 */
export function projectToolReferences(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  tools: readonly ModelToolContract[],
  deferred: ReadonlySet<string> = new Set(),
): { entries: RuntimeMessageEntry[]; loadedToolCallIds: ReadonlySet<string> } {
  // off 不建目录：tool_reference 一律按"不可用"删除；local/native 用目录判断引用是否仍然有效。
  const catalog = mode === "off" ? undefined : new Map(tools.map((tool) => [tool.name, tool]));
  const renderDefinition = mode === "local" ? createLocalToolDefinitionRenderer() : undefined;
  // 同批结果尚未被模型看到：直到下一条 assistant 才合入已交付集合，避免并行搜索互相去重。
  // visible = 模型已经看过（上一条 assistant 之前）的已加载工具；pending = 本批刚交付、尚未被模型看到。
  const visible = mode === "local" ? new Set<string>() : undefined;
  const pending = mode === "local" ? new Set<string>() : undefined;
  const projected: RuntimeMessageEntry[] = [];
  const loadedToolCallIds = new Set<string>();
  for (const entry of entries) {
    // 新的 assistant 边界意味着上一批工具结果已被模型消费，可安全合入 visible 并清空 pending。
    if (pending && entry.kind !== "attachment" && entry.message.role === "assistant") {
      for (const name of pending) visible!.add(name);
      pending.clear();
    }
    // off 时公告里列出的工具已不可见，保留公告只会诱导模型继续搜索不存在的工具。
    if (mode === "off" && entry.metadata?.toolSearchAnnouncement) continue;
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      !Array.isArray(entry.message.content)
    ) {
      projected.push(entry);
      continue;
    }
    const original = entry.message.content;
    let content: ModelMessageContentBlock[] | undefined;
    let definitions: string[] | undefined;
    let alreadyLoaded: Set<string> | undefined;
    let newlyLoaded: Set<string> | undefined;
    // 只把真正成功的 ToolSearch 算作加载事件；失败结果即使带引用也不能标已加载。
    const successfulSearch = entry.message.toolName === "ToolSearch" && !entry.message.isError;
    for (let index = 0; index < original.length; index++) {
      const block = original[index]!;
      if (block.type !== "tool_reference") {
        if (definitions) {
          content!.push(localDefinitionsBlock(definitions));
          definitions = undefined;
        }
        content?.push(block);
        continue;
      }
      // 目录里找不到 → 工具已下线，引用必须从请求中移除，否则 provider 会展开出不存在的 schema。
      const tool = catalog?.get(block.toolName);
      if (tool && !renderDefinition) {
        // 结果外的成功提示仅用于 Native；Local 已在结果内给出加载和调用指引。
        // 反直觉：loadedToolCallIds 记在"结果外"的块上，供结算层标 tool call 完成，而不是改写消息内容。
        if (successfulSearch && entry.message.toolCallId)
          loadedToolCallIds.add(entry.message.toolCallId);
        content?.push(block);
        continue;
      }
      // 仅在引用确实被移除/展开时复制；普通结果与有效 Native 引用直接共享原历史。
      // 只在第一次需要删改时复制前缀，避免把整段历史无谓地复制一遍（缓存前缀也依赖对象稳定）。
      content ??= original.slice(0, index);
      // local 展开：有效引用渲染为定义；已交付过的延迟工具只回"已加载"提醒，不重复贴 schema。
      if (tool && renderDefinition) {
        if (successfulSearch && deferred.has(tool.name) && visible!.has(tool.name)) {
          (alreadyLoaded ??= new Set()).add(tool.name);
        } else {
          (definitions ??= []).push(renderDefinition(tool));
          // 常驻及 compact 提升工具仍直接调用，不能混入包装调用的首搜指引。
          if (successfulSearch && deferred.has(tool.name))
            (newlyLoaded ??= new Set()).add(tool.name);
        }
        if (successfulSearch) pending!.add(tool.name);
      }
      // 被删除的引用不切断连续段，保持原来“先过滤再展开”的合并语义。
      // 反过来说：连续的有效引用会合成一个 <functions> 块，而不是逐块包裹。
    }
    // 循环末尾必须 flush：最后一段连续定义没有后续非引用块来触发落盘。
    if (definitions) content!.push(localDefinitionsBlock(definitions));
    if (newlyLoaded)
      content!.push({ type: "text", text: localToolsLoadedReminder([...newlyLoaded]) });
    if (alreadyLoaded)
      content!.push({ type: "text", text: localToolsAlreadyLoadedReminder([...alreadyLoaded]) });
    // 全部块被移除时必须改发一条文本占位：空 content 会被部分 provider 判为非法消息。
    // 两种文案用于区分"配置关闭"与"工具下线"，日志与回归断言依赖这个差别。
    projected.push(
      content === undefined
        ? entry
        : {
            ...entry,
            message: {
              ...entry.message,
              content: content.length
                ? content
                : [
                    {
                      type: "text",
                      text:
                        mode === "off"
                          ? "[Tool references removed - tool search not enabled]"
                          : "[Tool references removed - tools no longer available]",
                    },
                  ],
            },
          },
    );
  }
  return { entries: projected, loadedToolCallIds };
}

/**
 * 把若干 <function> 定义行包进一个 <functions> 文本块（Local 模式的展开格式）。
 * 口径：参数是 renderDefinition 产出的单行 JSON 字符串；调用方保证非空。
 * 消费者：provider 收到的是普通 text 块，模型按 system prompt 的格式约定解析。
 */
function localDefinitionsBlock(definitions: readonly string[]): ModelMessageContentBlock {
  return { type: "text", text: `<functions>\n${definitions.join("\n")}\n</functions>` };
}
