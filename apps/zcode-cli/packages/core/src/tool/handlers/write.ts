// ============================================================
// Write Tool Handler
// ============================================================
// 整文件写入（创建或覆盖），是 Edit 的「全量替换」对照物。
//
// 定位：一次调用 = 至多一次读（用于校验 + 生成 diff）+ 一次原子写。所有 I/O 走
// FileSystemPort，handler 本身不做路径越界判断以外的策略。
//
// 维护的不变量：
//   1. 覆盖一个已存在文件前，会话必须读过它（且不是部分视图 Read），否则报
//      `write_file_not_read`；读后文件被改过则报 `write_file_stale`。两条都是业务失败
//      （recoverable），由 executor 收成这次 tool_call 的结果。
//   2. 写成功后必须把最新 content/revision 写回 readFileState，否则紧接着的 Edit 会把
//      自己刚写的文件误判为 stale。同时写进 tool part metadata，冷恢复后不丢。
//   3. 写失败（权限、只读挂载、revision 不匹配）一律上抛，绝不返回一个「看起来成功」的
//      结果——模型会据此告诉用户文件已更新。
//
// 反直觉处：
//   - 目标是新文件时 `readTextFile` 的 not_found 被吞掉，走 create 分支；只有非 not_found
//     的读错误才上抛。
//   - 「是否 update」由 `originalFile` 的真值判断，因此覆盖一个**空文件**会被报成 create
//     （空串为 falsy）。这是既有行为，改动会影响结构化 patch 与展示，注释只标记不修改。
//   - `stampMemoryOriginSessionId` 可能改写将要落盘的 content（记忆文件的来源标记），
//     因此写回 read-state 的必须是改写后的字节。

import type { ToolHandler, ToolEntry } from "../types.js";
import {
  CoreErrorType,
  WriteInputJsonSchema,
  WriteInputSchema,
  WriteOutputJsonSchema,
  WriteOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type FileSystemReadTextResult,
  type FileSystemTextEncoding,
  type WriteInput,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import type { ReadFileStateEntry, ReadFileStateMap, ToolExecutionContext } from "../types.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

const WRITE_PROVIDER_DESCRIPTION = [
  "Writes a file to the local filesystem, overwriting if one exists.",
  "",
  "When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.",
].join("\n");

const WRITE_STORAGE_SUFFIX =
  " (file state is current in your context \u2014 no need to Read it back)";
const WRITE_USER_MODIFIED_NOTE = " The user modified your proposed content before accepting it.";
const WRITE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
const WRITE_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

/**
 * 渲染模型面文本。
 *
 * 输入是未经 schema 校验的 handler output；形状不认识时给一句保守的成功文案——这里**不**
 * 报错，因为写已经发生了，报错会让模型误以为需要重试（重试会覆盖用户可能已改动的文件）。
 * `userModified` 时同时省略 `WRITE_STORAGE_SUFFIX`：那句话承诺「文件状态已在你上下文中」，
 * 而用户改过之后模型的上下文已经不是磁盘事实，必须让它重新 Read。
 * 副作用无；`filePath` 使用模型传入的原写法（不是解析后的绝对路径），便于它复用同一字符串。
 */
function formatWriteModelContent(output: unknown): string {
  if (!isRecord(output)) {
    return "The file has been written successfully.";
  }

  const filePath = typeof output.filePath === "string" ? output.filePath : "the file";
  const userModified = output.userModified === true;
  const userModifiedNote = userModified ? WRITE_USER_MODIFIED_NOTE : "";
  const storageSuffixNote = userModified ? "" : WRITE_STORAGE_SUFFIX;

  if (output.type === "create") {
    return `File created successfully at: ${filePath}${userModifiedNote}${storageSuffixNote}`;
  }

  return `The file ${filePath} has been updated successfully.${userModifiedNote}${storageSuffixNote}`;
}

/**
 * 执行一次整文件写入。
 *
 * 输入：`file_path` 是模型给的原路径（内部经 resolveWorkspacePath 解析，保留原串用于结果
 * 展示与 diff 标签）；`content` 是要写的完整正文。
 * 输出：`type: "update" | "create"` 的结果对象，含 filePath（原串）、content（**实际落盘**
 * 的字节，可能被记忆来源标记改写）、structuredPatch（update 时为逐行 diff，create 时空数组）
 * 与 originalFile（create 时为 null）。
 * 副作用：一次 FS 读 + 一次原子写；更新内存 read-file-state 并写 tool part metadata（供冷
 * 恢复）；附加性能遥测。
 * 失败语义：端口缺席 → ConfigurationError（不可恢复）；读错误（非 not_found）、读状态过期、
 * 写失败全部上抛，由 executor 收成失败结果，不变量「每个 tool_call 有配对结果」保持。
 * 取消经 abortSignal 透传到两次 FS 调用；取消后不会再有成功的返回。
 */
export const writeHandler: ToolHandler = async (input, context) => {
  const { file_path, content } = WriteInputSchema.parse(input) as WriteInput;
  const fileSystemPort = context.fileSystemPort;

  // 没有端口就没有任何可用的写入通道；静默降级成「假装写成功」会让模型继续基于错误前提工作。
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Write tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Write",
        },
        recoverable: false,
      },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  let originalFile: string | null = null;
  let originalEncoding: FileSystemTextEncoding | undefined;
  let originalLineEndings: "LF" | "CRLF" | undefined;
  let originalRevision: FileSystemReadTextResult["revision"] | undefined;
  const readStartedAt = Date.now();
  let fsReadMs = 0;
  try {
    const read = await fileSystemPort.readTextFile(
      {
        path: filePath,
        trace: createWriteTrace(context),
      },
      { signal: context.abortSignal },
    );
    assertWritableExistingFileIsFresh(filePath, read, context.readFileState);
    originalFile = read.content;
    originalEncoding = read.encoding;
    originalLineEndings = read.lineEndings;
    originalRevision = read.revision;
    fsReadMs = elapsedMsSince(readStartedAt);
  } catch (error) {
    fsReadMs = elapsedMsSince(readStartedAt);
    // not_found 是「目标尚不存在」的正常路径，清空 originalFile 后走 create；
    // 其余错误（权限、路径非法、端口故障）不是 Write 能修复的，原样上抛。
    if (!isFileSystemPortError(error) || error.code !== "not_found") {
      throw error;
    }
  }

  // 记忆文件会在这里被注入来源 session 标记；后续的 diff、遥测、read-state 都必须用改写后的
  // 字节，否则模型看到的 diff 与磁盘实际内容会差一个标记。
  const contentToWrite = stampMemoryOriginSessionId({
    content,
    filePath,
    memoryRoot: context.memoryRoot,
    sessionId: context.sessionId,
  });
  const writeStartedAt = Date.now();
  const writeResult = await fileSystemPort.writeTextFile(
    {
      path: filePath,
      content: contentToWrite,
      encoding: originalEncoding,
      lineEndings: originalLineEndings,
      // createParents：允许在 Read 未覆盖的新目录里创建文件；atomic：端口负责临时文件+
      // 重命名，失败不留半截内容。
      // expectedRevision 只在文件原本存在时非空：端口据此做 CAS，读后被别人改过就写失败，
      // 把 stale 检测下沉到真正的写入时刻（与上面的读校验互补）。
      createParents: true,
      atomic: true,
      expectedRevision: originalRevision,
      trace: createWriteTrace(context),
    },
    { signal: context.abortSignal },
  );
  const fsWriteMs = elapsedMsSince(writeStartedAt);

  // 先更新会话内的 read-state，再落 metadata：内存态让紧随其后的 Edit 通过 stale 校验，
  // metadata 让冷恢复后的同一 Edit 也通过。
  const readFileStateEntry = updateReadFileStateAfterWrite(
    context.readFileState,
    filePath,
    contentToWrite,
    writeResult.revision,
  );
  recordReadFileStateMetadata(context, readFileStateEntry);

  // 反直觉：用真值判「原本存在」会把空文件当成新建（空串 falsy）。这不影响落盘内容，
  // 只影响结果 type 与 structuredPatch；改动它会改变展示与结果 schema，故保持现状。
  if (originalFile) {
    return attachToolExecutionTelemetry(
      {
        type: "update",
        filePath: file_path,
        content: contentToWrite,
        structuredPatch: createStructuredPatch({
          filePath: file_path,
          oldContent: originalFile,
          newContent: contentToWrite,
        }),
        originalFile,
        userModified: false,
      },
      createWritePerformanceTelemetry({
        content: contentToWrite,
        fsReadMs,
        fsWriteMs,
        context,
      }),
    );
  }

  // create 分支没有旧内容，因此 patch 为空数组而不是 undefined：结果 schema 要求该字段存在。
  return attachToolExecutionTelemetry(
    {
      type: "create",
      filePath: file_path,
      content: contentToWrite,
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
    createWritePerformanceTelemetry({
      content: contentToWrite,
      fsReadMs,
      fsWriteMs,
      context,
    }),
  );
};

// 遥测只描述这次 FS 活动的规模与耗时，不含路径与内容（避免把用户文件路径/正文送进遥测）。
// readMs 在「新建文件」时也非零（一次 not_found 的读同样消耗 I/O），这是有意的口径：
// 报告真实发生的操作，而不是按成功/失败改写。
function createWritePerformanceTelemetry(input: {
  content: string;
  context: ToolExecutionContext;
  fsReadMs: number;
  fsWriteMs: number;
}) {
  const totalBytes = fileByteCount(input.content);
  return {
    detail: {
      kind: "filesystem" as const,
      filesystem: {
        readMs: input.fsReadMs,
        writeMs: input.fsWriteMs,
        fileCount: 1,
        totalBytes,
        maxFileBytes: totalBytes,
        workspaceKind: workspaceKind(input.context),
      },
    },
  };
}

/**
 * Write 的工具注册项。
 *
 * 关键口径：
 *   - `destructive: false`：覆盖是本工具的**正常语义**，破坏性由权限门（`permission: "edit"`，
 *     按 path 生成规则）承担；`needsApproval: true` 保证每次写入仍走审批/规则。
 *   - `concurrentSafe: false`：同一文件并发写会互相覆盖，且 read-state 是进程内单值。
 *   - 结果预算 1MB/100k：`maxInlineBytes` 给结构化结果，`maxModelBytes` 给模型面；超出由
 *     executor 截断并可能走 artifact/预览，handler 自身不截断。
 *   - `cancellation.cleanup: "bestEffort"`：写在端口内是原子的，取消只能尽力而为，不能承诺
 *     完整回滚。
 */
export const writeToolEntry: ToolEntry = {
  capability: "Create or overwrite a file through the file-system adapter",
  metadata: {
    name: "Write",
    description: WRITE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: writeHandler,
  formatModelContent: formatWriteModelContent,
  inputSchema: WriteInputJsonSchema,
  outputSchema: WriteOutputJsonSchema,
  runtimeInputSchema: WriteInputSchema,
  runtimeOutputSchema: WriteOutputSchema,
  permission: {
    permission: "edit",
    reason: "Write creates or overwrites files through the file-system adapter",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: {
      maxBytes: 100_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Write was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// TraceContext 的构造与 Read/Edit 同形：只透传 id，不添加上下文之外的信息。
// 这里的 `as unknown as TraceContext` 是既有类型断言（端口接口比 WebSearch 的 trace 窄），
// 只加注释不改类型，避免把断言扩散成新接口。
function createWriteTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

/**
 * 覆盖前的读状态校验（fail-closed）。
 *
 * 只对**已存在**的文件调用：目标不存在时走 create，没有「读过」的前提。
 * 两条独立失败：
 *   1. 没有读记录，或最后一次只是部分视图（offset/limit 读）——两者都不足以证明模型见过
 *      完整文件，统一报 `write_file_not_read`；部分视图尤其危险，它会让人以为「我读过了」。
 *   2. 读记录与当前磁盘事实不一致——`hasReadStateChanged` 返回 true 时再给一次豁免：如果
 *      是严格全量读且文本逐字相同（mtime 变了但内容没变，常见于 formatter 重写），允许写。
 * 副作用无；失败抛 `ToolExecutionFailed`，recoverable=true（模型可先 Read 再重试）。
 */
function assertWritableExistingFileIsFresh(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): void {
  const lastRead = findLatestReadFileState(readFileState, filePath);
  // 部分视图不算「读过」：Write 是整文件替换，必须基于完整内容做决定。
  if (!lastRead || lastRead.isPartialView) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_NOT_READ_MESSAGE, {
      context: {
        code: "write_file_not_read",
        filePath,
      },
      recoverable: true,
    });
  }

  // revision/mtime/size 都没变：无需进一步比较，直接放行。
  if (!hasReadStateChanged(lastRead, currentRead)) return;
  // 元数据变了但严格全量读的文本与当前一致：常见于 formatter 只重排/更新 mtime、
  // 或行尾归一化；这种情况下内容仍是模型看过的字节，允许写，避免无谓地逼模型重读。
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return;

  // 走到这里说明内容也可能已经变了；recoverable=true 的语义是「先 Read 再重试」，
  // 不是「换个参数」。
  throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_STALE_MESSAGE, {
    context: {
      code: "write_file_stale",
      filePath,
    },
    recoverable: true,
  });
}

/**
 * 判断「读过的快照」与「当前磁盘事实」是否可能已不一致。
 *
 * 证据按可靠性排序：
 *   1. revision id 不同 → 立即判定变化（最强证据，端口提供时优先用）。
 *   2. mtime 前进（只在两端都给了 mtime 时比较；mtime 回拨不算变化——时钟回拨/恢复快照
 *      不应把一次未改动的写拦下）或 size 不同 → 变化。
 *   3. 两者都没有（老记录/端口不支持）时退到 size；再退到全量文本比较。
 * 返回值只表示「可能变了」，不表示「一定变了」；调用方还有一次内容等值豁免。
 * 纯函数、无副作用。
 */
function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentRevisionId = currentRead.revision?.id;
  // 只有两端都有 id 才比较：缺 id 是端口能力差异，不能当成「变了」。
  if (lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId) {
    return true;
  }

  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 让已确认内容未变的 Write 被误判为 stale。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  // 没有任何 mtime 可用时，size 是唯一低成本的粗判据；注意这里不与 undefined 比较，
  // 缺 size 的记录不会因此被误判为变化。
  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  // 最后的兜底只对「严格全量读」成立：部分视图的 content 只是一段，与整文件比较必然不等，
  // 那样会把每个部分视图都误判成 stale（前面其实已经用 isPartialView 拦住了，这里是双保险）。
  return isStrictFullRead(lastRead) && lastRead.content !== currentRead.content;
}

// 「严格全量读」= 不是部分视图、从第 1 行开始、且没有 limit。offset 缺省视为 1；
// limit 只要存在就说明只读了前 N 行，不能当作整文件快照。
function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

/**
 * 把刚写下的内容登记为「已读」。
 *
 * 输入 `content` 必须是**实际落盘**的字节（含记忆来源标记改写）；`revision` 来自写返回，
 * 拿不到时退化为 undefined，下一次 stale 校验会走 size/内容路径。
 * 输出：新条目（同时供 metadata 写入）或 undefined（会话没开 read-state）。
 * 副作用：覆盖该文件的整文件读槽（key 与「整文件 Read」同形）。
 * 失败语义：不抛；写已经成功，登记失败最多让下一次 Edit 要求重读，不能把成功写变成失败。
 */
function updateReadFileStateAfterWrite(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"] | undefined,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Write",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  return entry;
}

// 把 read-state 投影成 tool part metadata（冷恢复的唯一来源）。端口/回调缺席时安静跳过：
// live 路径已经拿到内存态，metadata 只是 resume 时的补票。
function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    // entry 缺席（没开 read-state）时用当前时刻占位：metadata 的 completedAt 只是排序信息，
    // 不参与 stale 判定。
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Write",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
