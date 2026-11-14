/**
 * ============================================================================
 * tool/handlers/read.ts —— Read 工具
 * ============================================================================
 *
 * 【定位】按扩展名分派到四类读取：图片/视频（返回媒体 block）、PDF（按页）、
 * 文本（cat -n 行号视图）。所有文件系统访问都走 FileSystemPort，路径先经
 * resolveWorkspacePath 做工作区约束。
 *
 * 【read-before-edit 状态】
 *   每次成功读取都会写 ReadFileStateMap（key = path + offset + limit），
 *   Edit/Write 用它确认"模型看过当前内容"。三条口径：
 *   - 缓存命中（isCachedReadFresh）：返回 file_unchanged 桩文本而不是重读，
 *     防止模型反复 Read 浪费上下文；判定用 mtime + size/revision，不用内容哈希；
 *   - isPartialView：只表示"输出被 token cap 截断"，此时 Write/Edit 必须拒绝，
 *     因为模型看到的内容不完整；
 *   - offset/limit 只是 range view，不等价于 partial view（模型仍可据此编辑）。
 *
 * 【错误形态】输入预检失败包成 <tool_use_error> 文本（而不是裸 ZodError），
 *   保证 provider 看到的是可理解的工具错误；文件不存在时附带"你是不是想找 X"
 *   的近似文件名提示（同目录、同 stem 或编辑距离 ≤ 3）。
 *
 * 【结果投影】图片/视频只保留媒体 block，尺寸信息留在结构化 output 给 UI/调试：
 *   否则 provider-visible content 会随是否缩放而变化，破坏缓存与回放一致性。
 *
 * 【分派顺序不可交换】图片 → 视频 → PDF → 文本。前两者按扩展名识别；PDF 还要求当前
 *   模型支持 PDF 输入；都不命中才进入文本 stat/缓存/读取路径。把文本放到最后，是为了
 *   避免把二进制媒体当 UTF-8 文本读出一堆乱码。
 *
 * 【缓存的作用域】readFileState 优先用 context 注入的 map；缺失时按「每个 context」
 *   的 WeakMap 兜底。WeakMap 的键必须在 context 生命周期内稳定，否则同一 turn 内两次
 *   Read 会拿到不同缓存，`file_unchanged` 永远不会命中。
 *
 * 【组合件边界】本文件只负责分派与 read-before-edit 状态；具体读取/预算/投影分别在
 *   read-image.ts、read-video.ts、read-pdf.ts、read-text.ts 中维护，错误码与
 *   recoverable 语义也以那些文件为准。
 * ============================================================================
 */

import { basename, dirname, extname } from "node:path";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
  ToolHandler,
  ToolEntry,
  ToolInputValidationResult,
} from "../types.js";
import {
  CoreErrorType,
  READ_DEFAULT_MAX_LINES,
  READ_MAX_FILE_SIZE_BYTES,
  ReadInputJsonSchema,
  ReadInputSchema,
  ReadOutputJsonSchema,
  ReadOutputSchema,
  createCoreError,
  getReadPdfPagesValidationFailure,
  isFileSystemPortError,
  type ReadInput,
  type ReadImageOutput,
  type ReadVideoOutput,
  type ModelMessageContent,
  type ReadOutput,
  type ReadTextOutput,
  type FileSystemStatResult,
  type TraceContext,
} from "@zcode/contracts";
import { resolveWorkspacePath } from "../path-policy.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import { createReadFileStateMetadata } from "../read-file-state-metadata.js";
import { inferImageMimeFromPath, readImageFile } from "./read-image.js";
import { inferVideoMimeFromPath } from "../../runtime/helpers/attachment-video.js";
import { readVideoFile } from "./read-video.js";
import { formatReadTextOutput, readTextFileForModel } from "./read-text.js";
import {
  formatReadPdfOutput,
  formatReadPdfPagesOutput,
  isPdfPath,
  READ_PDF_TOOL_TIMEOUT_MS,
  readPdfFile,
  resolveReadInputSchema,
  resolveReadProviderDescription,
  resolveReadTimeoutBudgetMs,
  supportsPdfForExecution,
} from "./read-pdf.js";

export { addReadLineNumbers } from "./read-text.js";

// 缓存命中时返回的固定提醒。文案刻意带"Wasted call"：这是在纠正模型的重复读取习惯，
// 而不是描述文件内容；模型看到后应直接引用上一次 tool_result。
const FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
// provider 描述是静态基线；PDF 能力存在时由 resolveReadProviderDescription 动态注入一条。
// 描述里声称"读图片/视频/空文件会提示"等行为，修改分派逻辑时必须同步更新这些承诺。
const READ_PROVIDER_DESCRIPTION = [
  "Reads a file from the local filesystem.",
  "",
  "- `file_path` must be an absolute path.",
  `- Reads up to ${READ_DEFAULT_MAX_LINES} lines by default.`,
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters",
  "- Results are returned using cat -n format, with line numbers starting at 1",
  "- Reads images (PNG, JPG, …) and presents them visually.",
  "- Reads videos (MP4, MOV, WEBM, …) and presents them as video input (subject to ZCode's video input limit).",
  "- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.",
  "- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.",
].join("\n");

// 无注入 readFileState 时的兜底缓存。用 WeakMap<context, Map> 而不是模块级 Map：
//   1) context 被回收时缓存自动消失，不会跨 turn 泄漏；
//   2) 同一个 context 内多次 Read 共享同一份状态，`file_unchanged` 才能生效。
// 只在测试/冷路径出现，生产由 executor 注入 context.readFileState。
const fallbackReadFileStates = new WeakMap<ToolExecutionContext, ReadFileStateMap>();

/**
 * 把结构化 ReadOutput 投影成模型可见内容；解析失败时退化为 JSON 字符串。
 *
 * 为什么先 safeParse 再分派：output 可能来自持久化回放或旧版本数据，直接 switch 会让
 * 未知形状走进 `undefined` 分支。退化成字符串至少保证模型拿到可读内容，不会出现
 * 空 tool result（不变量 1）。
 */
function formatReadModelContent(output: unknown): ModelMessageContent {
  // 输出可能来自持久化回放或旧版本实现，形状不受本轮代码控制，必须先按 schema 收敛
  const parsed = ReadOutputSchema.safeParse(output);
  if (!parsed.success) {
    // 解析失败不能抛错：这里只负责投影，抛错会让整条 tool result 丢失，模型什么都看不到
    return stringifyReadOutputFallback(output);
  }

  // 解析成功后 output.type 一定落在已知枚举里，才能安全进入按变体分派
  return formatReadOutput(parsed.data);
}

// 每种 output 变体都有自己的模型投影：文本带行号、媒体只留 block、PDF 带说明。
// notebook 没有专用投影，退化为 JSON——它通常是结构化数据，保留原始形状比硬编文本更安全。
function formatReadOutput(output: ReadOutput): ModelMessageContent {
  // 分派只按 type 进行：新增 output 变体必须在此登记，漏掉会让函数返回 undefined 而不是内容
  switch (output.type) {
    case "text":
      // 行号、截断标记由 read-text 统一生成，这里若重新拼装，两处口径迟早不一致
      return formatReadTextOutput(output);
    case "file_unchanged":
      // 缓存命中没有正文，只能返回固定提醒，引导模型引用上一次 tool_result 而不是再读一遍
      return FILE_UNCHANGED_STUB;
    case "image":
      // 图片只保留媒体 block，尺寸等元信息留在结构化 output，防止可见内容随缩放变化
      return formatReadImageOutput(output);
    case "video":
      // 视频与图片同构，OpenAI 系 provider 会在后置投影里把它拆成独立的 user part
      return formatReadVideoOutput(output);
    case "pdf":
      // PDF 投影附带页数与渲染说明，让模型知道看到的是整篇还是被选中的页
      return formatReadPdfOutput(output);
    case "parts":
      // 按页读取必然是分片输出，逐片投影才能保住页与页之间的边界
      return formatReadPdfPagesOutput(output);
    case "notebook":
      // notebook 没有专用投影，退化为 JSON 保留原始结构，硬编文本会丢字段
      return stringifyReadOutputFallback(output);
  }
}

// 图片投影：只保留 image block，不附加尺寸/压缩说明。
// 原因：这些信息会随"是否缩放/是否压缩"变化，而 provider 缓存与回放一致性要求
// 同一张图的可见内容稳定；结构化 output 仍保留 dimensions 供 UI 与调试消费。
function formatReadImageOutput(output: ReadImageOutput): ModelMessageContent {
  // dataUrl 现场拼接：output 只存 mime 与 base64，持久化时不必重复保存完整前缀字符串
  const imageBlock = {
    type: "image" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      // id 固定为 read-image，下游据此区分图片来源；改动会让回放缓存对不上
      id: "read-image",
      kind: "inline" as const,
      mimeType: output.mimeType,
      // placeholder 是 provider 不支持内联图片时的替代文案，必须是非空的人类可读文本
      placeholder: "Read image",
      // 用原始字节数而非 base64 长度：base64 会膨胀约三分之一，展示出来会误导用户
      sizeBytes: output.originalSize,
    },
  };
  // 尺寸提示拼进 tool result 会让 provider-visible content 随是否缩放而改变；
  // 图片结果只保留媒体 block，dimensions 继续留在结构化 output 供 UI 和调试使用。
  return [imageBlock];
}

// 与图片同构：tool result 只保留媒体 block；OpenAI 系 provider 由
// tool-result-media-projection 拆成后置 user part（AI SDK tool result 无 video part 变体）。
function formatReadVideoOutput(output: ReadVideoOutput): ModelMessageContent {
  // block 形状必须与图片对齐，后续 media projection 才能用同一套逻辑拆出后置 user part
  const videoBlock = {
    // 变体名必须是 video，投影层按它选择媒体拆包策略，写错会退化成未知 part
    type: "video" as const,
    mediaType: output.mimeType,
    // 与图片一致现场拼 data url，避免在 base64 之外再持久化一份前缀
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-video",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read video",
      sizeBytes: output.originalSize,
    },
  };
  // 只返回单个媒体 block：视频体积大，再附加文本说明会挤占后续消息的上下文预算
  return [videoBlock];
}

function stringifyReadOutputFallback(output: unknown): string {
  // 字符串直接透传：调用方已给过可读文本，再序列化会多出一层引号与转义
  if (typeof output === "string") return output;
  // undefined 经 JSON.stringify 会返回 undefined，这里用空串兜住返回类型
  return JSON.stringify(output) ?? "";
}

/**
 * Read 主入口。执行顺序：
 *   1) 解析输入（预检失败转 tool_use_error）；
 *   2) 路径约束（read 操作，不允许越出工作区）；
 *   3) 媒体/PDF 分派：图片→readImageFile、视频→readVideoFile、
 *      PDF（且执行上下文支持）→readPdfFile；
 *   4) 文本路径：stat → 查 readFileState 缓存 → 命中返回 file_unchanged；
 *   5) 未命中则真正读取并写回状态（供 Edit 的 read-before-edit 校验）。
 * 错误映射：not_found → read_file_not_found（带近似文件名建议）；
 * too_large → read_file_too_large（带 maxBytes）；其余原样抛出。
 */
export const readHandler: ToolHandler = async (input, context) => {
  // 先做输入预检：schema 失败要变成模型可纠正的 tool_use_error，不能带进后续路径解析
  const { file_path, offset, limit, pages } = parseReadInput(input);
  // 端口就是外部 I/O 边界，本文件不做任何 fs 直连；缺它时连 stat 都无法完成
  const fileSystemPort = context.fileSystemPort;

  // 端口缺失属于装配错误，继续执行只会在调用点抛 TypeError，不如提前给出可诊断的配置错误
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Read tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }

  // 所有读取路径先过工作区约束：越界路径在这里被拒绝，原始 file_path 不得直达端口
  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "read",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  try {
    // 图片只看扩展名，不做内容嗅探：判定必须廉价且确定，嗅探错误会把二进制当文本读成乱码
    const imageMime = inferImageMimeFromPath(filePath);
    if (imageMime) {
      return await readImageFile(filePath, imageMime, context);
    }

    // 视频必须排在 PDF 与文本之前，否则 mp4 会被当成 UTF-8 文本读出大量乱码
    const videoMime = inferVideoMimeFromPath(filePath);
    if (videoMime) {
      return await readVideoFile(filePath, videoMime, context);
    }

    // PDF 分支是唯一同时看"扩展名 + 模型能力"的：不支持 PDF 的模型继续走文本路径，
    // 由 io adapter 决定如何展示；在这里报"模型不支持"反而会丢掉可能的文本降级。
    if (isPdfPath(filePath) && supportsPdfForExecution(context)) {
      // pages 只在 PDF 分支有意义；非 PDF 时该字段被忽略，不要在此另行校验
      return await readPdfFile({ filePath, pages }, context);
    }

    // trace 只承载链路标识，保证这次 stat 能与上层 tool call 关联，缺字段会让日志断链
    const trace = createReadTrace(context);
    // 先 stat 再决定读取方式：大小上限与缓存新鲜度都依赖这次结果，失败即进入错误映射
    const stat = await fileSystemPort.stat(
      { path: filePath, trace },
      { signal: context.abortSignal },
    );
    // 状态表按 context 隔离：跨 session 复用会让"已读"结论泄漏到别的会话
    const readFileState = getReadFileState(context);
    // offset 必须归一后再进 key，否则缺省与显式 1 会变成两个互不相认的条目
    const cacheOffset = normalizeCacheOffset(offset);
    // limit 原样参与 key：不同窗口对应不同内容，不能互相复用
    const cacheKey = createReadFileStateKey(filePath, cacheOffset, limit);
    const cached = readFileState.get(cacheKey);
    if (cached && isCachedReadFresh(cached, stat)) {
      // 命中缓存时仍然记录一次 metadata：UI/诊断需要知道"本次没有真正读盘"，
      // 而 ReadFileState 本身保持原条目（不刷新 readAt，避免把旧内容伪装成新读取）。
      const output = { type: "file_unchanged", filePath } satisfies ReadOutput;
      recordReadFileStateMetadata(context, {
        output,
        readFileState,
        toolInput: input,
      });
      return output;
    }

    // stat 与 read 之间文件可能被外部改写，revision 只能从真正读取的回调里取
    let rangeReadRevision: FileSystemStatResult["revision"] | undefined;
    // abortSignal 透传给读取层，用户取消时必须能中断读盘，否则大文件会把 turn 拖住
    const output = await readTextFileForModel({
      abortSignal: context.abortSignal,
      filePath,
      fileSystemPort,
      limit,
      onRead: (read) => {
        // 记录真正读取那一刻的 revision；stat 与 read 之间文件可能被外部修改，
        // 只有这里的 revision 才能和"模型实际看到的字节"对应。
        rangeReadRevision = read.revision;
      },
      offset,
      trace,
    });
    // 状态必须在读取成功后立刻写回：晚于返回会让并发的 Edit 看不到这次读取
    updateReadFileState(readFileState, cacheKey, {
      output,
      path: filePath,
      stat,
      rangeReadRevision,
      offset,
      limit,
    });
    // metadata 只是 UI 与审计增强，写入失败不应推翻已经成功的读取结果
    recordReadFileStateMetadata(context, {
      output,
      readFileState,
      toolInput: input,
    });
    return output;
  } catch (error) {
    // 只改写端口的结构化错误；其余异常原样上抛，避免把真实故障伪装成业务提示
    if (isFileSystemPortError(error) && error.code === "not_found") {
      // 近似文件名是 best-effort，构造失败也不改变"文件不存在"这一事实
      const message = await createMissingReadFileMessage(filePath, context);
      // recoverable 为真：换个路径或补全目录后重试仍有机会成功，模型应能看到这句
      throw createCoreError(CoreErrorType.ToolExecutionFailed, message, {
        cause: error,
        context: {
          code: "read_file_not_found",
          filePath,
        },
        recoverable: true,
      });
    }
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // 超限不是路径写错：必须带上 maxBytes，让模型自行改用 offset/limit 分段读取
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_file_too_large",
          filePath,
          maxBytes: READ_MAX_FILE_SIZE_BYTES,
        },
        recoverable: true,
      });
    }
    throw error;
  }
};

/**
 * 解析 Read 入参，并把"可读的预检失败"包装成 <tool_use_error>。
 *
 * 两条路径：
 *   - schema 通过 → 直接返回；
 *   - schema 失败且错误属于 `file_path` 的 custom issue（如路径不是绝对路径）
 *     → 抛 ToolExecutionFailed，message 是 <tool_use_error> 包裹的人话；
 *   - 其他 issue（例如 JSON 结构损坏）→ 原样抛出 ZodError，交给 executor 的
 *     通用校验路径，避免把内部错误伪装成模型可纠正的业务失败。
 * 为什么不用裸 ZodError 直接暴露给 provider：模型读不懂 issue JSON，也无法据此重试。
 */
function parseReadInput(input: unknown): ReadInput {
  // 用 safeParse 而非 parse：需要区分"可翻译给模型的 custom issue"与"结构损坏"两类失败
  const parsed = ReadInputSchema.safeParse(input);
  // 通过即结束，不做二次规范化；offset/limit 的缺省语义由下游各自处理
  if (parsed.success) return parsed.data as ReadInput;

  // 返回 undefined 表示"这不是能翻译给模型的错误"，函数不认领它
  const toolUseErrorMessage = getReadInputToolUseErrorMessage(parsed.error);
  if (!toolUseErrorMessage) {
    // 原样抛出 ZodError，交给 executor 的统一校验路径，避免把协议错误伪装成业务失败
    throw parsed.error;
  }

  // Read 输入预检失败应以 <tool_use_error> 文本进入 provider；
  // 直接透出 ZodError JSON 会让 binary/device preflight 与 capture 偏离。
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `<tool_use_error>${toolUseErrorMessage}</tool_use_error>`,
    {
      cause: parsed.error,
      context: {
        code: "read_input_preflight_failed",
      },
      recoverable: true,
    },
  );
}

/**
 * 权限/hook 之前执行的语义校验（executor 的 validateInput 阶段）。
 *
 * 目前只补 PDF `pages` 的跨字段约束：JSON Schema 只能表达"pages 是 string"，
 * "pages 只对 .pdf 有意义、且格式/页数上限合法"属于 runtime schema 知识。
 * 若放到 handler 才抛，坏参数会先穿过 PreToolUse hook 与权限询问，用户被问了一个
 * 注定失败的调用。这里返回 result:false 让 executor 直接生成配对失败结果。
 * 非对象/非目标字段组合一律放行（{result:true}），把形状问题留给 schema 层。
 */
function validateReadInput(input: unknown): ToolInputValidationResult {
  // 非对象输入不归本函数管，放行给 schema 层统一报类型错误，避免两处口径打架
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { result: true };
  }

  const candidate = input as { file_path?: unknown; pages?: unknown };
  // 只有两个字段同时是字符串才具备跨字段校验的前提，其余组合一律放行
  if (typeof candidate.file_path !== "string" || typeof candidate.pages !== "string") {
    return { result: true };
  }

  // PDF pages 的语义约束只存在于 runtime schema 时，JSON Schema 会接受任意
  // string，导致错误调用穿过 Hook 和权限后才在 handler 抛出裸 ZodError。
  const failure = getReadPdfPagesValidationFailure(candidate.file_path, candidate.pages);
  return failure ? { result: false, ...failure } : { result: true };
}

// 从 Zod issues 中挑出第一条"可以翻译给模型"的错误。
// 只认 file_path 上的 custom issue：其他 issue 属于结构/类型问题，翻译成一句话反而
// 会掩盖真实的协议错误，交给 executor 统一处理更合适。
function getReadInputToolUseErrorMessage(error: unknown): string | undefined {
  // 用鸭子类型读 issues：入参实际是 ZodError，但这里不引 zod，避免多一层运行时耦合
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;

  // 只取第一条可翻译的 issue：多条拼在一起会让模型抓不住重点，也无法对应单一修复动作
  for (const issue of issues) {
    if (!isReadInputToolUseIssue(issue)) continue;
    return issue.message;
  }
  return undefined;
}

// 判定标准刻意收窄：code=custom、message 为字符串、path 正好是 ["file_path"]。
// 条件放宽会把嵌套字段或别的工具的 issue 也误翻成 Read 的业务错误。
function isReadInputToolUseIssue(issue: unknown): issue is { message: string } {
  // 先排除 null 与非对象：issue 来自外部 schema 库，形状不可信，后面才敢读字段
  if (!issue || typeof issue !== "object") return false;
  const record = issue as { code?: unknown; message?: unknown; path?: unknown };
  // code 必须是 custom：内置 issue 的文案面向开发者，直接透给模型会误导重试方向
  if (record.code !== "custom" || typeof record.message !== "string") return false;
  // path 必须是长度 1 且首段为 file_path，防止嵌套字段或别的参数名被误认领
  if (!Array.isArray(record.path)) return false;
  return record.path.length === 1 && record.path[0] === "file_path";
}

function createReadTrace(context: ToolExecutionContext): TraceContext {
  // 逐字段搬运而不是整体展开 context：TraceContext 只允许链路标识，混入业务字段会污染日志
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    // 双断言是必要的：契约里的 TraceContext 带品牌字段，这里只构造最小可观测集合
  } as unknown as TraceContext;
}

/**
 * 取当前 context 的 read-before-edit 状态表。
 *
 * 优先使用宿主注入的 `context.readFileState`（可跨工具共享、可持久化）；
 * 没有注入时才使用按 context 隔离的 WeakMap。两条路径都返回 Map，调用方无需区分。
 * 副作用：首次访问会在 WeakMap 中创建一个空 Map（不泄漏，随 context 回收）。
 */
function getReadFileState(context: ToolExecutionContext): ReadFileStateMap {
  // 宿主注入优先：可跨工具共享甚至持久化，WeakMap 只是没有注入时的兜底
  if (context.readFileState) return context.readFileState;
  // 同一 context 复用同一张表，重复读取才可能命中 file_unchanged
  const existing = fallbackReadFileStates.get(context);
  if (existing) return existing;
  // 首次访问才建表；键是 context 对象，回收后缓存跟着失效，不会跨 turn 泄漏
  const state: ReadFileStateMap = new Map();
  fallbackReadFileStates.set(context, state);
  return state;
}

// 缓存 key 的 offset 归一：缺省与 0/1 都视为首行。若不归一，"没传 offset"与
// "offset: 1"会得到两个 key，同一文件被读两次仍不会命中 file_unchanged。
// limit 原样进入 key：不同窗口对应不同内容，不能互相复用。
function normalizeCacheOffset(offset: number | undefined): number {
  // 缺省按首行处理，与显式 offset=1 归一到同一个 key，否则同一窗口会被读两次
  return offset === undefined ? 1 : offset;
}

/**
 * 判断上次读取是否仍可复用。
 *
 * 优先级：mtime(整数毫秒) + size → revision.id → size。
 * 只比较 mtime 的整数毫秒，和写前 freshness 校验保持同一策略，减少亚毫秒抖动误报。
 * isPartialView 一律视为过期：模型只看到截断内容，必须重新读完整文件。
 * 任何一项无法确认时返回 false（宁可多读一次，也不能让模型基于旧内容编辑）。
 */
function isCachedReadFresh(entry: ReadFileStateEntry, stat: FileSystemStatResult): boolean {
  // 被 token 截断的视图一律不可复用：模型只看到前半段，据旧内容编辑会写坏文件尾部
  if (entry.isPartialView) return false;

  // revision 里的 mtime 更贴近 adapter 观察到的时间，缺失时才退回 stat 顶层字段
  const mtimeMs = stat.revision?.mtimeMs ?? stat.mtimeMs;
  if (entry.mtimeMs !== undefined && mtimeMs !== undefined) {
    // 和写前 freshness 校验保持同一套策略，mtime 只比较整数毫秒。
    return (
      normalizeReadFileStateMtimeMs(entry.mtimeMs) === normalizeReadFileStateMtimeMs(mtimeMs) &&
      entry.sizeBytes === stat.sizeBytes
    );
  }

  const revisionId = stat.revision?.id;
  // 没有 mtime 时退到 revision.id：内容寻址存储下它比时间戳更可靠
  if (entry.revisionId && revisionId) return entry.revisionId === revisionId;

  // 最后只能比大小：判断力最弱，但宁可判定过期多读一次，也不能让模型基于旧内容编辑
  return entry.sizeBytes !== undefined && entry.sizeBytes === stat.sizeBytes;
}

/**
 * 写入读取状态。
 *
 * revisionId 优先用 stat.revision.id，缺失时退回本次实际读取返回的 revision
 * （rangeReadRevision）：range read 的 stat 可能来自另一时刻，用真实读取的
 * revision 才能正确判断后续是否被修改。
 * isPartialView 只看 truncatedByTokenCap——offset/limit 只是窗口视图，
 * 不意味着内容不完整。
 */
function updateReadFileState(
  state: ReadFileStateMap,
  key: string,
  input: {
    output: ReadTextOutput;
    path: string;
    stat: FileSystemStatResult;
    rangeReadRevision?: FileSystemStatResult["revision"];
    offset?: number;
    limit?: number;
  },
): void {
  // 优先取 stat 的 revision，缺失时用真实读取时刻的 revision，混用会漏判外部修改
  const revision = input.stat.revision ?? input.rangeReadRevision;
  state.set(key, {
    // path 存的是解析后的绝对路径，不是模型传来的原文，便于后续按同一 key 检索
    path: input.path,
    content: input.output.content,
    offset: input.offset,
    limit: input.limit,
    // offset/limit 是 range view，不等价于 partial view。
    // partial view 只表示模型看到的内容被工具截断，Write/Edit 必须拒绝这种不完整视图。
    isPartialView: input.output.truncatedByTokenCap === true,
    readAt: new Date(),
    sourceTool: "Read",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs ?? input.stat.mtimeMs),
    sizeBytes: input.stat.sizeBytes,
  });
}

/**
 * 把本次读取投影成可持久化的 read-file-state metadata（可选能力）。
 *
 * 宿主没有注入 `recordReadFileStateMetadata` 时直接跳过：这是 UI/审计增强，
 * 不是 Read 成功的必要条件。createReadFileStateMetadata 返回 undefined 同样跳过，
 * 保证"元数据缺失"永远不会让一次成功读取变成失败。
 */
function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  input: {
    output: ReadOutput;
    readFileState: ReadFileStateMap;
    toolInput: unknown;
  },
): void {
  // 宿主没提供该方法说明不支持持久化元数据，静默跳过即可，不构成读取失败
  if (!context.recordReadFileStateMetadata) return;
  // 构造失败用返回值表达（undefined）而不是抛错，保证元数据缺失不影响读取成功
  const metadata = createReadFileStateMetadata({
    // completedAt 用本地时钟记录完成时刻，仅用于 UI 排序，不参与新鲜度判定
    completedAt: new Date(),
    output: input.output,
    readFileState: input.readFileState,
    toolInput: input.toolInput,
    // toolName 固定为 Read，宿主按它区分来源，写成别的值会让审计记录归错工具
    toolName: "Read",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

/**
 * 构造"文件不存在"的模型可见提示，附带当前工作目录与近似文件名建议。
 *
 * 为什么带 cwd：模型经常用相对路径，not_found 时最需要知道"相对哪里"。
 * 为什么建议是 best-effort：找不到近似名也不影响错误本身，不因建议失败而改变错误形态。
 */
async function createMissingReadFileMessage(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string> {
  // 建议查找是 best-effort：内部已吞掉列目录失败，这里不必再包一层错误处理
  const suggestion = await findSimilarFilename(filePath, context);
  // 拼成单行文本而不是多段消息，避免 provider 把换行解释成新的 content block
  return [
    `File does not exist. Note: your current working directory is ${context.workingDirectory}.`,
    suggestion ? ` Did you mean ${suggestion}?` : "",
  ].join("");
}

/**
 * 在目标文件所在目录里找最可能的"想读的文件"。
 *
 * 优先级：同 stem（忽略扩展名）优先于编辑距离 ≤3；因为模型最常见的错误是写错扩展名
 * （.ts vs .tsx），同 stem 比字符串相似更能表达真实意图。
 * 只看 file/symlink，排除目录；排除目标名本身；排序保证多候选时结果稳定。
 * 失败降级：目录不可读/端口缺席一律返回 undefined——建议是锦上添花，不能把
 * not_found 错误变成另一个错误。
 */
async function findSimilarFilename(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const fileSystemPort = context.fileSystemPort;
  // 端口缺失时直接放弃建议：错误形态不能因为装饰性能力缺失而改变
  if (!fileSystemPort) return undefined;

  try {
    // 只在目标文件所在目录里找候选，避免为一个 not_found 触发全盘扫描
    const parent = dirname(filePath);
    const targetName = basename(filePath);
    const targetStem = basename(filePath, extname(filePath));
    const listed = await fileSystemPort.listDirectory(
      { path: parent, trace: createReadTrace(context) },
      { signal: context.abortSignal },
    );
    const entries = listed.entries
      // 只看文件与符号链接：同名目录不是模型想读的目标，混进来会给出错误建议
      .filter((entry) => entry.kind === "file" || entry.kind === "symlink")
      .map((entry) => entry.name)
      // 排除目标名本身，否则"建议"永远等于用户已经写下的名字
      .filter((name) => name !== targetName)
      // 排序让多候选时的选择稳定，避免同一输入在不同目录顺序下给出不同提示
      .sort();

    // 同 stem 优先于编辑距离：模型最常见的错误是写错扩展名而不是写错主干名
    const sameStem = entries.find((name) => basename(name, extname(name)) === targetStem);
    if (sameStem) return sameStem;

    return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
  } catch {
    // 目录不可读或权限不足一律降级为无建议，不能把 not_found 变成另一个错误
    return undefined;
  }
}

// 经典 Levenshtein 动态规划：previous 保存上一行，current 保存当前行，滚动复用。
// 只用于文件名的近似建议（≤3 阈值），因此 O(n*m) 足够；非最佳匹配路径不追求性能。
function levenshteinDistance(left: string, right: string): number {
  // 只分配 right 长度的一行缓冲并滚动复用，阈值 ≤3 时长度差过大的输入不会走到这里
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  // 外层推进 left：current[0] 表示"left 前缀全删完"的边界距离
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      // 等代价为 0、不等为 1，替换代价交给后面的三选一承担
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      // Math.min 的三项对应删除 current[rightIndex - 1] + 1、插入 previous[rightIndex] + 1 与替换 previous[rightIndex - 1] + cost。
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      // 本行算完整体搬回 previous，下一轮直接复用，避免每轮重新分配数组
      previous[index] = current[index]!;
    }
  }

  // right 为空时 previous[0] 就是 0；?? 0 只是满足索引访问的类型收窄
  return previous[right.length] ?? 0;
}

/**
 * Read 的注册声明。
 *
 * 字段口径：
 *   - readOnly=true / sideEffectScope="none"：只读文件，不写盘、不发网络；
 *   - concurrentSafe=true：多次读取不会互相改变结果（缓存是 per-context 内存态）；
 *   - maxOutputBytes=READ_MAX_FILE_SIZE_BYTES 作为兜底预算，真正的 token 上限在
 *     read-text.ts 里按 READ_MAX_OUTPUT_TOKENS 收口；
 *   - timeout.defaultMs=30s，maxMs=READ_PDF_TOOL_TIMEOUT_MS：默认给文本/图片，
 *     只有 pages 渲染路径通过 resolveTimeoutBudgetMs 抬到 PDF 专用预算；
 *   - cancellation.cleanup="required"：取消时必须释放文件/渲染资源，不能让子进程悬挂。
 * resolveModelContract 让 description 与 inputSchema 随模型能力同源变化：不支持 PDF
 * 的模型不会看到 `pages` 参数，避免"schema 允许但 handler 拒绝"的契约分裂。
 */
export const readToolEntry: ToolEntry = {
  capability:
    "Read text files and supported images from the file-system adapter without modifying files",
  metadata: {
    name: "Read",
    description: READ_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: READ_MAX_FILE_SIZE_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: readHandler,
  validateInput: validateReadInput,
  resolveModelContract: (context) => ({
    description: resolveReadProviderDescription(READ_PROVIDER_DESCRIPTION, context),
    inputSchema: resolveReadInputSchema(context),
  }),
  resolveTimeoutBudgetMs: resolveReadTimeoutBudgetMs,
  formatModelContent: formatReadModelContent,
  inputSchema: ReadInputJsonSchema,
  outputSchema: ReadOutputJsonSchema,
  runtimeInputSchema: ReadInputSchema,
  runtimeOutputSchema: ReadOutputSchema,
  permission: {
    permission: "read",
    reason: "Read only inspects file content and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: READ_MAX_FILE_SIZE_BYTES,
    maxModelBytes: READ_MAX_FILE_SIZE_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: READ_MAX_FILE_SIZE_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: READ_PDF_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "required",
    userVisibleMessage: "Read was cancelled before file content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
