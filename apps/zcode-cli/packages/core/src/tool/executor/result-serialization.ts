/**
 * ============================================================================
 * executor/result-serialization.ts —— 工具输出 → 模型可见内容的"预算化序列化"
 * ============================================================================
 *
 * 【决策顺序】(serializeOutput)
 *   1. 把 output 转成 modelContent(string/块数组),并判空(空输出给占位文案);
 *   2. tool_reference 专用投影(引用是协议,不能截断/artifact 化);
 *   3. 需要时把完整原文落 artifact(仅 artifact 策略 + 显式 enabled);
 *   4. 官方 CUA 帧保护投影(image/image_ref 原子对原样保留);
 *   5. 未超预算 → 原样返回(带字符阈值的 provider 在持久化失败时也保留原文);
 *   6. artifact 已写入 → 用"预览 + 路径"替代全文;
 *   7. 其余 → 通用截断,追加包含 originalBytes/artifactPath 的说明,便于模型取回全文。
 *
 * 【计量口径】returnedBytes = "真正发给模型的字节",结构化媒体(base64 栅格)
 * 必须计入;originalBytes = 原始全文的 UTF-8 字节,仅用于诊断/统计。
 * ============================================================================
 */
import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ToolResultBudget,
  type TraceContext,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  containsOfficialCuaImageRefCredentialText,
} from "@zcode/zcode-cua/frame-contract";
import type { ToolEntry, ToolResultSerialization } from "../types.js";
import { formatHookAdditionalContexts } from "./hook-flow.js";
import { formatGenericPersistedOutputContent } from "../result-persistence-format.js";
import {
  appendHookToPersistedArtifactPreview,
  appendHookToStringContent,
  appendHookWithoutReorderingStructuredContent,
  fitContentWithSuffix,
  isEmptyModelContent,
  isPersistedArtifactPreview,
  OfficialCuaFrameContractError,
  projectHookAugmentedModelContent,
  projectOfficialCuaStructuredContent,
  projectToolReferenceContent,
  stringifyModelContentForSerialization,
  stringifyOutputForModel,
} from "./result-content-projection.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";

// 未声明 resultBudget 的工具统一走这份缺省:
//   - truncate 而非 artifact:默认不产生磁盘副作用,也不依赖 artifactStore 是否存在;
//   - head:大多数工具(读文件/命令输出)关键信息在开头。
// 两个 100_000 是"内联上限"与"模型上限"的同一值,后续取 min 时不会互相收紧。
const DEFAULT_RESULT_BUDGET: ToolResultBudget = {
  maxInlineBytes: 100_000,
  maxModelBytes: 100_000,
  strategy: "truncate",
  preview: {
    direction: "head",
  },
};

// 面向模型的恢复文案:必须同时说明"这张图无效"和"下一步该做什么"。
// 特别强调不要发送 coordinate target——否则模型会拿旧帧的坐标继续点击,
// 在真实屏幕上产生不可预期的操作。
export const OFFICIAL_CUA_INVALID_RASTER_RECOVERY_TEXT =
  "This CUA raster is invalid and cannot be used in this request. " +
  "Do not send a coordinate target; capture a new raster first.";

export async function serializeOutput(
  deps: ToolExecutorDeps,
  output: unknown,
  entry: ToolEntry,
  traceContext: TraceContext,
  toolCallId: string,
  signal: AbortSignal,
): Promise<ToolResultSerialization> {
  // entry 未声明预算时用缺省;后面所有分支都用 effectiveBudget,不再读 entry.resultBudget,
  // 避免某条分支漏掉 fallback 而拿到 undefined。
  const effectiveBudget: ToolResultBudget = entry.resultBudget ?? DEFAULT_RESULT_BUDGET;
  const modelContent = stringifyOutputForModel(output, entry);
  // content 是"用于持久化/计量/字符串投影"的版本;modelContent 才是真正发给模型的形态。
  // 两者在纯文本工具下相同,在结构化工具下 content 是 media 的占位文本。
  const content = stringifyModelContentForSerialization(modelContent);
  if (isEmptyModelContent(modelContent)) {
    // Bash 空输出也需要通用占位，避免模型把静默成功误读成缺失工具结果。
    // 空输出必须给占位文案：模型需要看到"工具成功执行了，只是没有输出"，
    // 否则会把空 tool_result 误判为工具调用未完成或结果丢失。
    // returnedBytes 用占位文案的字节，不是 0——0 会让预算统计误认为这次没有内容。
    const emptyContent = `(${entry.metadata.name} completed with no output)`;
    return {
      content: emptyContent,
      modelContent: emptyContent,
      originalBytes: Buffer.byteLength(content, "utf8"),
      returnedBytes: Buffer.byteLength(emptyContent, "utf8"),
      truncated: false,
      budgetStrategy: effectiveBudget.strategy,
    };
  }

  // artifact 的 content-type 优先用工具声明,否则按输出类型推断:
  // 字符串是纯文本,其它(对象/数组)按 JSON 存,便于取回后直接反序列化。
  const contentType =
    entry.resultArtifactContentType ??
    (typeof output === "string" ? "text/plain" : "application/json");
  const originalBytes = Buffer.byteLength(content, "utf8");
  // 部分 provider contract 按 JS 字符计数；保留现有工具的 UTF-8
  // byte budget，只让显式声明字符阈值的工具增加该持久化判据。
  // 口径差异是刻意的:byte 预算管上下文体积,字符阈值满足特定 provider 的硬限制。
  const exceedsCharacterBudget =
    entry.maxModelChars !== undefined && content.length > entry.maxModelChars;
  // 两个上限取 min:maxModelBytes 是"模型可接受"的约束,maxInlineBytes 是"内联进事件/历史"
  // 的约束,任何一条超了都必须走截断/artifact。
  const maxModelBytes = Math.max(
    0,
    Math.min(effectiveBudget.maxModelBytes, effectiveBudget.maxInlineBytes),
  );
  // 有些工具自己已经落盘(如 Bash 的 outputPath),这里把路径找出来,
  // 后面无论走 artifact 还是通用截断,都能在说明里带上"全文在哪"。
  const artifactPath = findArtifactPath(output);
  // 引用投影必须排在 artifact 之前:引用是 schema 加载协议,
  // 一旦被 artifact 化成"路径 + 摘要",模型就再也拿不到那个 tool_reference。
  const referenceProjection = projectToolReferenceContent(
    modelContent,
    maxModelBytes,
    effectiveBudget.preview?.direction ?? "head",
  );
  if (referenceProjection) {
    return {
      ...referenceProjection,
      originalBytes,
      budgetStrategy: effectiveBudget.strategy,
      artifactPath,
    };
  }
  // 落 artifact 需要三个条件同时成立:确实超预算、工具显式开启 artifact、
  // 且策略就是 artifact。只声明 strategy 但没 enabled 的工具按 truncate 走,
  // 避免"声明了 artifact 却没人打算写盘"的配置产生意外文件。
  // 不变量 #4：超预算是前提（originalBytes > maxModelBytes 或超字符阈值），
  // 没超预算时不需要落盘——直接走小结果直通更高效。
  const shouldPersistArtifact =
    (originalBytes > maxModelBytes || exceedsCharacterBudget) &&
    effectiveBudget.artifact?.enabled === true &&
    effectiveBudget.strategy === "artifact";
  const artifact = shouldPersistArtifact
    ? await tryWriteToolArtifact(
        deps,
        content,
        contentType,
        entry,
        effectiveBudget,
        traceContext,
        toolCallId,
        signal,
      )
    : undefined;
  // 路径优先级:实际写入产物返回的 path > uri > 工具自带 output path。
  // path 是可读的本地文件,uri 可能只是逻辑引用;两者都没有时才用工具报告的路径。
  const resolvedArtifactPath = artifact?.path ?? artifact?.uri ?? artifactPath;

  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION &&
    hasImageBlock(modelContent)
  ) {
    // 只有"声明了帧保护 + 结果里确实有图片"才进入该分支;
    // 纯文本的 CUA 结果仍走通用预算,不需要帧投影。
    let protectedProjection;
    try {
      protectedProjection = projectOfficialCuaStructuredContent(
        modelContent,
        maxModelBytes,
        effectiveBudget.preview?.direction ?? "head",
      );
    } catch (error) {
      // 只吞 OfficialCuaFrameContractError：其他异常（如 OOM）必须继续抛出，
      // 不能被当成"帧契约失败"静默处理。
      if (!(error instanceof OfficialCuaFrameContractError)) throw error;
      // 原因：非 canonical frame 必须继续 fail closed，但低层布局 invariant 不能作为
      // tool result 暴露给模型；这里只记录稳定诊断，再交给 executor 生成可恢复错误结果。
      // 不变量 #11：本地 CUA 包无法 attest 时 core 必须 fail closed——
      // 帧位置不对说明 producer 可能被篡改，不能把可能伪造的 frame authority 交给模型。
      deps.logger?.warn("Official CUA frame contract rejected during result serialization", {
        ...traceContextToLogContext(traceContext),
        code: error.code,
        event: "tool.result.cua_frame_contract_rejected",
        module: "core.tool.executor",
        status: "failed",
        toolCallId,
        toolName: entry.metadata.name,
      });
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        OFFICIAL_CUA_INVALID_RASTER_RECOVERY_TEXT,
        {
          context: { code: error.code, source: "tool" },
          recoverable: true,
        },
      );
    }
    if (protectedProjection) {
      // 投影成功才走早返回。protectedProjection 为 undefined 意味着
      // "没有可识别的 canonical 帧对",此时不能绕过通用预算:
      // 继续往下走,让 resultBudget 对整段内容做正常截断。
      const projectedModelContent = protectedProjection.content;
      const projectedContent = stringifyModelContentForSerialization(projectedModelContent);
      const projectedBytes = Buffer.byteLength(projectedContent, "utf8");
      // 序列化文本里 image 块只是短占位符；真实 base64 栅格（bridge 上限 200 KiB）
      // 会原样进入模型请求。returnedBytes 语义是"发给模型的字节"，必须计入
      // 图片载荷，否则 setOutputBytes / turn-tool-usage / usage-observability
      // 每次 CUA 帧系统性少计一张栅格。只保留 aggregate，避免文本/媒体分量
      // 与 returnedBytes 形成需要同步维护的第二份状态。
      const structuredPayloadBytes = structuredMediaBytes(projectedModelContent);

      // 官方 CUA 的 image/image_ref 原子对始终原样保留；图片字节由 bridge 的独立
      // 上限保护，普通文本仍走 resultBudget，不能借一张合法 raster 绕过上下文预算。
      // 不变量 #4：returnedBytes 是真实发给模型的字节，必须计入结构化媒体
      // （CUA 栅格 base64）。projectedBytes 只是序列化文本（image 块是占位符），
      // 加上 structuredPayloadBytes 才是模型实际收到的总字节。
      // 早返回与 official CUA protection authority 强制成对；配对验证失败
      //（protectedProjection 为 undefined）时不得绕过通用预算。
      return {
        content: projectedContent,
        modelContent: projectedModelContent,
        originalBytes,
        returnedBytes: projectedBytes + structuredPayloadBytes,
        truncated: protectedProjection.truncated,
        budgetStrategy: effectiveBudget.strategy,
        artifactPath: resolvedArtifactPath,
      };
    }
  }

  if (
    (originalBytes <= maxModelBytes && !exceedsCharacterBudget) ||
    // 带字符阈值的 provider 文本在持久化失败时必须保留原文；
    // 不能再落入通用 resultBudget 截断并注入另一套提示。
    (exceedsCharacterBudget && shouldPersistArtifact && artifact === undefined)
  ) {
    // 第二种情况是有意"超限还返回原文":provider 按字符计数,
    // 用字节预算截断会给出错误判断,而 artifact 写失败又没有可替代的全文载体。
    // 宁可让这次请求承担原文体积,也不要让模型看到误导性的截断说明。
    // returnedBytes = originalBytes：原文全部进模型，计量与实际传输一致。
    return {
      content,
      modelContent,
      originalBytes,
      returnedBytes: originalBytes,
      truncated: false,
      budgetStrategy: effectiveBudget.strategy,
      artifactPath: resolvedArtifactPath,
    };
  }

  if (effectiveBudget.strategy === "artifact" && effectiveBudget.artifact?.enabled === true) {
    if (artifact && resolvedArtifactPath) {
      // artifact 分支必须同时有"写入结果"和"可引用路径":
      // 只有路径没有写入说明文件不存在,只有写入没有路径模型无法取回,
      // 两种情况都不能用 preview 冒充全文,所以落回下面的通用截断。
      // 不变量：artifact 预览必须能让模型取回全文，否则不如直接截断。
      const persistedOutputContent = formatPersistedOutputContent({
        content,
        entry,
        originalBytes,
        output,
        persistedPath: resolvedArtifactPath,
      });
      const persistedContent = stringifyModelContentForSerialization(persistedOutputContent);
      return {
        content: persistedContent,
        modelContent: persistedOutputContent,
        originalBytes,
        returnedBytes: Buffer.byteLength(persistedContent, "utf8"),
        truncated: true,
        budgetStrategy: effectiveBudget.strategy,
        artifactPath: resolvedArtifactPath,
      };
    }
  }

  // 通用截断:说明里必须带 originalBytes(让模型知道丢了多少)和 artifactPath
  // (告诉它如何取回全文)。suffix 由 fitContentWithSuffix 优先保留,不会被裁掉。
  const artifactHint = resolvedArtifactPath ? `artifactPath=${resolvedArtifactPath}, ` : "";
  const suffix = `\n\n[Tool output truncated by resultBudget: ${artifactHint}originalBytes=${originalBytes}, maxModelBytes=${maxModelBytes}, strategy=${effectiveBudget.strategy}]`;
  const truncatedContent = fitContentWithSuffix(
    content,
    maxModelBytes,
    suffix,
    effectiveBudget.preview?.direction ?? "head",
  );

  return {
    content: truncatedContent,
    modelContent: truncatedContent,
    originalBytes,
    returnedBytes: Buffer.byteLength(truncatedContent, "utf8"),
    truncated: true,
    budgetStrategy: effectiveBudget.strategy,
    artifactPath: resolvedArtifactPath,
  };
}

export function appendHookAdditionalContexts(
  serialization: ToolResultSerialization,
  additionalContexts: string[],
  entry: ToolEntry,
): ToolResultSerialization {
  // 没有上下文时返回原对象:调用方会用返回值替换结果,返回新对象会制造无意义的状态差异。
  if (additionalContexts.length === 0) return serialization;
  // CUA 帧保护模式下,过滤掉含 image_ref 凭证文本的 hook 上下文:
  // hook 若把凭证回显到上下文里,保护就形同虚设(凭证会进入模型历史)。
  // 不变量 #11：CUA 凭证不能通过任何旁路（包括 hook 上下文）进入模型可见内容。
  const filteredAdditionalContexts =
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION
      ? additionalContexts.filter((context) => !containsOfficialCuaImageRefCredentialText(context))
      : additionalContexts;
  const omittedFrameCredential = filteredAdditionalContexts.length !== additionalContexts.length;
  if (filteredAdditionalContexts.length === 0) {
    // 全被过滤掉时不要加空的 "[Hook additional context]" 标题:
    // 只把 truncated 置真,让 UI/统计知道有一批上下文被安全策略丢弃。
    // 返回原对象 + truncated=true：不改变内容，只标记"有内容被安全过滤"。
    return omittedFrameCredential ? { ...serialization, truncated: true } : serialization;
  }
  const hookContext = formatHookAdditionalContexts(filteredAdditionalContexts);
  const suffix = `\n\n${hookContext}`;
  // hook 追加使用"模型可见"的字节上限口径,与 serializeOutput 保持一致,
  // 否则 hook 可以把已经贴近上限的结果再次顶出预算。
  const maxModelBytes = resolveMaxModelBytes(entry);
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION &&
    hasImageBlock(serialization.modelContent ?? serialization.content)
  ) {
    // 结构化(图片/帧)结果:只能把 hook 文本追加到原块之后,
    // 绝不能重排或合并文本块,否则 image/image_ref 的"前两块"契约会被破坏。
    const projected = appendHookWithoutReorderingStructuredContent(
      serialization,
      hookContext,
      suffix,
      maxModelBytes,
    );
    return omittedFrameCredential ? { ...projected, truncated: true } : projected;
  }
  const previewDirection = entry.resultBudget?.preview?.direction ?? "head";
  const modelContent = serialization.modelContent ?? serialization.content;
  // 含 tool_reference 时优先用引用投影:引用块必须原样保留,
  // 通用字符串投影会把它们变成不可恢复的文本。
  const referenceProjection = Array.isArray(modelContent)
    ? projectToolReferenceContent(
        [...modelContent, { type: "text", text: hookContext }],
        maxModelBytes,
        previewDirection,
      )
    : undefined;
  if (referenceProjection) {
    return {
      ...serialization,
      ...referenceProjection,
      truncated: serialization.truncated || referenceProjection.truncated || omittedFrameCredential,
    };
  }
  // 剩下两条字符串路径:
  //   - artifact 预览:只在 hook 自身限长,不再挤压预览正文;
  //   - 普通文本:按总预算拟合,正文与 hook 一起受 maxModelBytes 约束。
  const artifactPreview = isPersistedArtifactPreview(serialization);
  const contentProjection = artifactPreview
    ? appendHookToPersistedArtifactPreview(serialization.content, suffix, maxModelBytes)
    : appendHookToStringContent(serialization.content, suffix, maxModelBytes, previewDirection);

  const projected = {
    ...serialization,
    content: contentProjection.content,
    modelContent: projectHookAugmentedModelContent({
      artifactPreview,
      contentProjection,
      hookContext,
      maxModelBytes,
      modelContent: serialization.modelContent ?? serialization.content,
      previewDirection,
      suffix,
    }),
    returnedBytes: Buffer.byteLength(contentProjection.content, "utf8"),
    truncated: serialization.truncated || contentProjection.truncated,
  };
  return omittedFrameCredential ? { ...projected, truncated: true } : projected;
}

// 类型守卫:数组且含 image 块。用于把"是否进入结构化投影分支"的判断
// 与后续代码的类型收窄合并成一次,避免各调用点重复写 Array.isArray。
function hasImageBlock(content: ModelMessageContent): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some((block) => block.type === "image");
}

/** 结构化内容里所有 image/file 块的真实载荷字节（dataUrl 原样计入）。 */
function structuredMediaBytes(content: ModelMessageContent): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    // image 块的 dataUrl 是 base64 栅格，会原样进模型请求，必须计入。
    if (block.type === "image") return total + Buffer.byteLength(block.dataUrl, "utf8");
    // file-with-text 的模型可见内容是 text（dataUrl 不进请求），不计入媒体字节。
    // 只有纯 file（无 text）的 dataUrl 才进模型，才计入。
    if (block.type === "file" && block.dataUrl !== undefined && block.text === undefined)
      return total + Buffer.byteLength(block.dataUrl, "utf8");
    return total;
  }, 0);
}

// 与 serializeOutput 中的预算合并口径保持一致:appendHook 等后续阶段
// 也必须用 min(maxModelBytes, maxInlineBytes),否则会出现"序列化时按 A 截断、
// 追加 hook 时按 B 计算"的双口径。
function resolveMaxModelBytes(entry: ToolEntry): number {
  const budget = entry.resultBudget ?? DEFAULT_RESULT_BUDGET;
  return Math.max(0, Math.min(budget.maxModelBytes, budget.maxInlineBytes));
}

async function tryWriteToolArtifact(
  deps: ToolExecutorDeps,
  content: string,
  contentType: string,
  entry: ToolEntry,
  budget: ToolResultBudget,
  traceContext: TraceContext,
  toolCallId: string,
  signal: AbortSignal,
): Promise<{ path?: string; uri: string } | undefined> {
  if (!deps.artifactStore) {
    // 没有 artifactStore 直接返回 undefined：调用方会据此回退到通用截断。
    // 不抛错——artifactStore 是可选依赖，缺失不应让工具调用失败。
    return undefined;
  }

  try {
    return await deps.artifactStore.writeToolResultArtifact(
      {
        sessionId: deps.sessionId,
        turnId: traceContext.turnId ?? deps.turnId,
        toolCallId,
        toolName: entry.metadata.name,
        content,
        contentType,
        retention: budget.artifact?.retention ?? "session",
        trace: traceContext,
      },
      { signal },
    );
  } catch {
    // 与主模型交互时，artifact 写入失败不应让一次成功的工具调用变成失败。
    // 这里回退到统一的 resultBudget 截断路径，保持工具结果可见并避免原始大输出进模型。
    // 返回 undefined 而非抛错：调用方的 `artifact === undefined` 分支会处理回退。
    return undefined;
  }
}

function formatPersistedOutputContent(input: {
  content: string;
  entry: ToolEntry;
  originalBytes: number;
  output: unknown;
  persistedPath: string;
}): ModelMessageContent {
  // 工具可以自定义"落盘后给模型看什么"(例如只给结构化摘要、或给尾部而非头部);
  // 返回 undefined 表示不自定义,落到与所有工具一致的通用预览格式。
  // 通用格式会带上 persistedPath,保证模型始终有办法取回全文。
  const projected = input.entry.formatPersistedModelContent?.({
    content: input.content,
    originalBytes: input.originalBytes,
    output: input.output,
    persistedPath: input.persistedPath,
  });
  if (projected !== undefined) return projected;

  return formatGenericPersistedOutputContent({
    content: input.content,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
  });
}

// 工具自己落盘时使用的字段名历史上并不统一:不同工具在不同版本里各用一套。
// 按优先级取第一个非空字符串,任何一个命中都算"全文已存在磁盘上"。
function findArtifactPath(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  for (const key of ["persistedOutputPath", "rawOutputPath", "artifactPath", "outputPath"]) {
    const value = output[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
