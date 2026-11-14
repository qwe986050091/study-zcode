/**
 * ============================================================================
 * executor/result-content-projection.ts —— 工具结果内容的"预算内投影"
 * ============================================================================
 *
 * 【职责】result-serialization 决定"要不要截断/落 artifact",本文件负责
 * "怎么截断":按 UTF-8 字节压缩文本、追加 hook 上下文、保留不可截断的结构块
 * (tool_reference / CUA 帧 / 图片等)。
 *
 * 【核心不变量】
 *   - 结构化块要么原样保留、要么整块丢弃,不能截半(半截 image_ref 会破坏协议);
 *   - 文本截断以"码点"为单位(Array.from + 二分),不会切出半个 surrogate pair;
 *   - 计量(returnedBytes)始终由"最终真正发给模型的 content"派生,
 *     不在函数内部维护第二份文本/媒体长度状态。
 * ============================================================================
 */
import {
  modelMessageContentToText,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { findOfficialCuaFrameContentPair } from "@zcode/zcode-cua/frame-contract";
import type { ToolEntry, ToolResultSerialization } from "../types.js";
import { isPersistedOutputContent } from "../result-persistence-format.js";

export interface HookStringProjection {
  content: string;
  truncated: boolean;
}

const TOOL_REFERENCE_TEXT_TRUNCATION_MARKER = "[Tool result text truncated by resultBudget]";

export function projectToolReferenceContent(
  modelContent: ModelMessageContent,
  maxTextBytes: number,
  direction: "head" | "tail",
):
  | Pick<ToolResultSerialization, "modelContent" | "content" | "returnedBytes" | "truncated">
  | undefined {
  // 只处理"纯 text + tool_reference"的混合内容;带图片/文件的结结果走其他投影分支。
  // 返回 undefined = "本次不适用",调用方继续走通用 resultBudget。
  // 三个条件全满足才处理：必须是数组、至少有一个 tool_reference、且所有块都是 text 或 tool_reference。
  // 有任何其他块类型（image/file）就不能用这个投影——它们的预算口径不同。
  if (
    !Array.isArray(modelContent) ||
    !modelContent.some((block) => block.type === "tool_reference") ||
    !modelContent.every((block) => block.type === "text" || block.type === "tool_reference")
  )
    return undefined;

  // 引用既是 schema 加载协议也是发现状态，不能按展示文本截断或转成 artifact。
  // 仅裁剪文本，原始引用及块顺序必须保留；展示内容和计量统一从最终块派生。
  const truncated = Buffer.byteLength(joinTextBlocks(modelContent), "utf8") > maxTextBytes;
  let projected: ModelMessageContentBlock[] = modelContent;
  if (truncated) {
    // marker 先占预算(它必须完整可读,否则模型不知道文本被截过),
    // 剩余预算再按 direction 分配各 text 块;引用块不消耗预算。
    const marker = fitStringToBytes(TOOL_REFERENCE_TEXT_TRUNCATION_MARKER, maxTextBytes, "head");
    let remainingBytes = maxTextBytes - Buffer.byteLength(marker, "utf8");
    let hasText = marker.length > 0;
    // tail 模式先把块序反转,让"离结尾最近"的文本先拿到预算,最后再反回来保持原顺序。
    const ordered = direction === "tail" ? [...modelContent].reverse() : modelContent;
    projected = ordered.flatMap((block): ModelMessageContentBlock[] => {
      // 非 text 块（即 tool_reference）原样返回，不参与预算分配——
      // 引用块必须完整保留，否则 schema 加载协议会失效。
      if (block.type !== "text") return [block];
      // 2 字节是 joinTextBlocks 用的 "\n\n" 分隔符;hasText 时每次拼接都要预留。
      const textBudget = Math.max(0, remainingBytes - (hasText ? 2 : 0));
      const text = fitStringToBytes(block.text, textBudget, direction);
      if (text.length > 0) {
        remainingBytes -= Buffer.byteLength(text, "utf8") + (hasText ? 2 : 0);
        hasText = true;
      }
      // 某个块被截断后预算已耗尽,后面的块不再尝试(否则会出现中间空块)。
      // 把 remainingBytes 置 0 让后续块的 textBudget 变成 0，直接返回空数组被过滤掉。
      if (text.length < block.text.length) remainingBytes = 0;
      // text 为空时返回 [] 被 flatMap 过滤掉：避免在投影中留下空 text 块。
      return text ? [{ ...block, text }] : [];
    });
    if (direction === "tail") projected.reverse();
    // marker 放最后:tail 场景下它也应该在末尾,head 场景下则是截断说明。
    if (marker) projected.push({ type: "text", text: marker });
  }
  // content/returnedBytes 都从 projected 派生,保证"展示值"和"计量值"是同一次投影。
  const content = stringifyModelContentForSerialization(projected);
  return {
    modelContent: projected,
    content,
    returnedBytes: Buffer.byteLength(content, "utf8"),
    truncated,
  };
}

export const OFFICIAL_CUA_TEXT_TRUNCATION_MARKER =
  "[Official CUA text truncated by resultBudget. Re-observe with detail=compact or a narrower window before relying on omitted state.]";

export const OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE = "official_cua_frame_pair_not_leading";

export class OfficialCuaFrameContractError extends Error {
  readonly code = OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE;

  constructor() {
    super("Official CUA frame pair must be the first two result blocks");
    this.name = "OfficialCuaFrameContractError";
  }
}

export function projectOfficialCuaStructuredContent(
  content: ModelMessageContentBlock[],
  maxModelBytes: number,
  direction: "head" | "tail",
): { content: ModelMessageContentBlock[]; truncated: boolean } | undefined {
  // 没有合法帧对 → 返回 undefined,让调用方回退到通用 resultBudget。
  // 这不代表内容一定有问题,只是"这条保护不适用"。
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  // 官方 producer 的 canonical pair 必须已经位于结果首部。consumer 只校验、
  // 预算并保序，不再猜测或提升非 canonical 布局。这里直接失败，避免后续通用
  // 小结果直通路径重新把带前缀的 frame authority 交给模型。
  if (pair.imageIndex !== 0 || pair.imageRefIndex !== 1) {
    // 不变量：CUA 帧对（image + image_ref）必须是结果的前两个块，位置不对就 throw——
    // 这是安全契约，不是普通截断失败，必须 fail closed，防止 frame authority 被重新排序后交给模型。
    throw new OfficialCuaFrameContractError();
  }

  const pairContent: ModelMessageContentBlock[] = [pair.image, pair.imageRef];
  // 帧对之后只保留非空 text 块:其它结构化块(额外图片/file)不能和帧混在一起,
  // 否则模型侧会看到无法归属的媒体块。
  const suffixBlocks = content
    .slice(2)
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text" && block.text.length > 0,
    );
  // 记录了"帧对之外还有结构化块"这一事实:即使总字节没超预算,
  // 也不能走小结果直通,否则那些块会被静默丢掉。
  const hasOtherStructuredBlocks = content.some(
    (block, index) =>
      index !== pair.imageRefIndex && index !== pair.imageIndex && block.type !== "text",
  );
  const completeContent: ModelMessageContentBlock[] = [...pairContent, ...suffixBlocks];
  // 小结果直通:无额外结构化块且总字节在预算内 → 原样返回,不做截断。
  // 两个条件都要满足：有额外结构化块时即使字节没超也不能直通，
  // 因为直通会让那些块在后续路径里被静默丢弃（帧对之外的结构化块不在 completeContent 里）。
  if (
    !hasOtherStructuredBlocks &&
    Buffer.byteLength(stringifyModelContentForSerialization(completeContent), "utf8") <=
      maxModelBytes
  ) {
    return { content: completeContent, truncated: false };
  }

  // 超出预算:帧对必须完整保留(它承载 image + image_ref 的原子关系),
  // 只能用剩余字节放文本,剩余不足时追加 marker 说明"有内容被省略"。
  const suffixText = joinTextBlocks(suffixBlocks);
  const pairBytes = Buffer.byteLength(stringifyModelContentForSerialization(pairContent), "utf8");
  const remainingAfterPair = Math.max(0, maxModelBytes - pairBytes);
  const projectedMarker = fitStringToBytes(
    OFFICIAL_CUA_TEXT_TRUNCATION_MARKER,
    Math.max(0, remainingAfterPair - 2),
    "head",
  );
  const markerCost =
    projectedMarker.length > 0 ? Buffer.byteLength(projectedMarker, "utf8") + 2 : 0;
  const suffixBudget =
    projectedMarker.length > 0 ? Math.max(0, remainingAfterPair - markerCost - 2) : 0;
  const projectedSuffix = fitStringToBytes(suffixText, suffixBudget, direction);

  const projected: ModelMessageContentBlock[] = [
    pair.image,
    pair.imageRef,
    ...(projectedSuffix ? [{ type: "text" as const, text: projectedSuffix }] : []),
    ...(projectedMarker ? [{ type: "text" as const, text: projectedMarker }] : []),
  ];
  return {
    content: projected,
    truncated: true,
  };
}

export function appendHookWithoutReorderingStructuredContent(
  serialization: ToolResultSerialization,
  hookContext: string,
  suffix: string,
  maxModelBytes: number,
): ToolResultSerialization {
  const modelContent = serialization.modelContent ?? serialization.content;
  // 非结构化内容不归本函数处理:调用方应当走 appendHookToStringContent。
  // 返回原对象(而不是拼接)避免两条路径都生效导致 hook 被加两次。
  // 不变量：结构化内容（CUA 帧/图片）的顺序不能被 hook 追加打乱，所以这里只在末尾追加 text 块。
  if (!Array.isArray(modelContent)) return serialization;

  // 预算以"当前已序列化文本"为基数,而不是 maxModelBytes 单独计算:
  // 这样追加只受剩余额度约束,不会把已有内容挤出预算。
  const currentBytes = Buffer.byteLength(serialization.content, "utf8");
  const remainingBytes = Math.max(0, maxModelBytes - currentBytes);
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const fittedHookContext =
    remainingBytes > separatorBytes
      ? fitStringToBytes(hookContext, remainingBytes - separatorBytes, "head")
      : "";
  const fittedSuffix = fittedHookContext.length > 0 ? `${separator}${fittedHookContext}` : "";
  const hookTruncated = Buffer.byteLength(suffix, "utf8") > remainingBytes;
  const content = `${serialization.content}${fittedSuffix}`;

  return {
    ...serialization,
    content,
    // 只能在原始块之后追加 hook。这样 raster 仍然是首块、image_ref 仍紧随其后，
    // 即使 hook 超出预算也不会把文本搬到图片前或用字符串替换图片。
    modelContent:
      fittedHookContext.length > 0
        ? [...modelContent, { type: "text", text: fittedHookContext }]
        : modelContent,
    // returnedBytes 已包含受保护 raster；追加 hook 只增加实际新增的文本 bytes，
    // 避免重新拆分文本/媒体并维护第二份计量状态。
    returnedBytes: serialization.returnedBytes + Buffer.byteLength(fittedSuffix, "utf8"),
    truncated: serialization.truncated || hookTruncated,
  };
}

export function appendHookToStringContent(
  content: string,
  suffix: string,
  maxBytes: number,
  previewDirection: "head" | "tail",
): HookStringProjection {
  const augmentedContent = `${content}${suffix}`;
  // 快路径:拼完仍在预算内,原样返回,不触发任何截断逻辑。
  if (Buffer.byteLength(augmentedContent, "utf8") <= maxBytes) {
    return { content: augmentedContent, truncated: false };
  }
  // 超预算:交给 fitContentWithSuffix —— 它把 suffix 视作必须保留的尾部信息,
  // 再按方向裁正文。没有直接 slice 是因为要按 UTF-8 字节与码点安全截断。
  return {
    content: fitContentWithSuffix(content, maxBytes, suffix, previewDirection),
    truncated: true,
  };
}

/**
 * 已持久化 artifact 的预览追加 hook。
 * 预览本身已经是"原文的截断摘要",所以这里不再按总预算裁剪正文,
 * 只限制 hook 自身大小:预算是 maxHookBytes,而不是 maxBytes。
 */
export function appendHookToPersistedArtifactPreview(
  content: string,
  suffix: string,
  maxHookBytes: number,
): HookStringProjection {
  const fittedSuffix = fitStringToBytes(suffix, maxHookBytes, "head");
  return {
    content: `${content}${fittedSuffix}`,
    truncated: Buffer.byteLength(suffix, "utf8") > maxHookBytes,
  };
}

export function projectHookAugmentedModelContent(input: {
  artifactPreview: boolean;
  contentProjection: HookStringProjection;
  hookContext: string;
  maxModelBytes: number;
  modelContent: ModelMessageContent;
  previewDirection: "head" | "tail";
  suffix: string;
}): ModelMessageContent {
  // 分支 1:artifact 预览 —— 预览是字符串摘要,hook 已按 maxHookBytes 限长,
  // 不再重算总预算(否则摘要在不同调用方下会被二次截断)。
  if (input.artifactPreview) return input.contentProjection.content;
  // 分支 2:文本未超预算 —— 直接追加,保留原有结构化块顺序。
  if (!input.contentProjection.truncated) {
    return appendHookContextToModelContent(input.modelContent, input.hookContext);
  }
  // 分支 3:超预算但没有需要保留的结构块 —— 用已截断的字符串投影。
  // 没有结构块时不需要保序，直接用 contentProjection 的结果即可。
  if (!hasPreservedStructuredBlocks(input.modelContent)) return input.contentProjection.content;

  // 分支 4:超预算且含结构块 —— 结构块整块保留,文本部分重新按预算拟合,
  // 最后把文本追加在结构块之后(顺序不变,图片/帧仍在原位)。
  // 不变量：结构块（image/file/tool_reference）整块保留不截半，文本只能放在它们之后。
  const textContent = budgetedTextFromStructuredContent(input.modelContent);
  const budgetedText = fitContentWithSuffix(
    textContent,
    input.maxModelBytes,
    input.suffix,
    input.previewDirection,
  );
  return [
    ...input.modelContent.filter(shouldPreserveStructuredBlock),
    ...(budgetedText.length > 0 ? [{ type: "text" as const, text: budgetedText }] : []),
  ];
}

/**
 * 把正文裁到 maxBytes,且**优先保留 suffix**。
 * 顺序:先按预算裁 suffix(它承载"已截断"的说明,不能被裁没),
 * 剩余额度再给正文。若正文额度为 0,返回的就是 suffix 本身。
 */
export function fitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const suffixContent = fitStringToBytes(suffix, maxBytes, "head");
  const remainingBytes = maxBytes - Buffer.byteLength(suffixContent, "utf8");
  if (remainingBytes <= 0) return suffixContent;
  return `${fitStringToBytes(content, remainingBytes, direction)}${suffixContent}`;
}

function joinTextBlocks(content: ModelMessageContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** 把 ModelMessageContent 统一成"持久化/比较用"的文本形式。
 * 字符串原样返回;块数组走 modelMessageContentToText(媒体块在那里有固定占位格式)。
 * 该结果用于 byte 计量与 artifact 内容存储,不用于模型请求本身。 */
export function stringifyModelContentForSerialization(content: ModelMessageContent): string {
  return typeof content === "string" ? content : modelMessageContentToText(content);
}

/**
 * 判断内容是否"没有可展示信息"。
 * 关键点:只要存在任何一个非 text 块(图片/文件/引用),就不算空——
 * 否则纯图片结果会被误判成空输出并被替换成占位文案,模型永远看不到图。
 */
export function isEmptyModelContent(content: ModelMessageContent): boolean {
  if (typeof content === "string") return content.trim() === "";
  if (content.length === 0) return true;
  return content.every((block) => {
    if (block.type !== "text") return false;
    return typeof block.text !== "string" || block.text.trim() === "";
  });
}

/**
 * 把工具 handler 的原始输出转成模型可见内容。
 * 优先级:工具自定义 formatModelContent(知道如何精炼自己的输出)
 * → 字符串原样 → undefined 视为空串 → JSON 序列化(失败退化为 String)。
 * JSON 分支兜底 String 是因为 output 可能含 BigInt/循环引用,
 * 直接抛错会让一个成功工具因"无法序列化"而失败。
 */
export function stringifyOutputForModel(output: unknown, entry: ToolEntry): ModelMessageContent {
  if (entry.formatModelContent) return entry.formatModelContent(output);
  if (typeof output === "string") return output;
  if (output === undefined) return "";

  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return String(output);
  }
}

/**
 * 判断当前序列化结果是否"只是 artifact 预览"。
 * 四个条件必须同时成立:策略是 artifact、确实被截断、有非空 artifactPath、
 * 且 content 的形态就是持久化预览格式(不是普通截断文本)。
 * 该判定决定 hook 追加走"预览专用"分支,不重算总预算。
 */
export function isPersistedArtifactPreview(serialization: ToolResultSerialization): boolean {
  return (
    serialization.budgetStrategy === "artifact" &&
    serialization.truncated &&
    typeof serialization.artifactPath === "string" &&
    serialization.artifactPath.length > 0 &&
    isPersistedOutputContent(serialization.content)
  );
}

function appendHookContextToModelContent(
  content: ModelMessageContent,
  hookContext: string,
): ModelMessageContent {
  if (typeof content === "string") return `${content}\n\n${hookContext}`;
  return [...content, { type: "text", text: hookContext }];
}

function hasPreservedStructuredBlocks(
  content: ModelMessageContent,
): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some(shouldPreserveStructuredBlock);
}

function shouldPreserveStructuredBlock(block: ModelMessageContentBlock): boolean {
  if (block.type === "text") return false;
  if (block.type === "file" && typeof block.text === "string" && block.text.length > 0) {
    return false;
  }
  return true;
}

function budgetedTextFromStructuredContent(content: ModelMessageContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "file" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * 按 UTF-8 字节裁字符串,以**码点**为单位。
 * 为什么不用 slice:UTF-16 代理对会被切成孤立半字符,导致持久化/回放时
 * JSON 序列化异常。Array.from 先转成码点数组,再二分找到"字节不超限的最大码点数"。
 * 二分而不是逐字符累加:长文本(数百 KB)下 O(n log n) 明显快于 O(n) 的
 * 反复 Buffer.byteLength 全量计算。
 */
function fitStringToBytes(value: string, maxBytes: number, direction: "head" | "tail"): string {
  // 预算 <= 0 直接返回空串：没有额度就不输出任何字符，避免负数预算导致异常。
  if (maxBytes <= 0) return "";
  // 快路径：原始文本已在预算内，原样返回，不触发码点拆分。
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  // Array.from 按码点拆分：保证不会在 surrogate pair 中间截断。
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  // 二分搜索"字节不超限的最大码点数"：比逐字符累加 O(n) 快，长文本下优势明显。
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate =
      direction === "tail"
        ? chars.slice(chars.length - mid).join("")
        : chars.slice(0, mid).join("");
    // candidate 字节 <= maxBytes 时尝试更大的 mid，否则缩小上界。
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return direction === "tail"
    ? chars.slice(chars.length - low).join("")
    : chars.slice(0, low).join("");
}
