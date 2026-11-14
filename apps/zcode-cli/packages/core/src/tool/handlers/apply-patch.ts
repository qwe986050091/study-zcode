/**
 * ============================================================================
 * tool/handlers/apply-patch.ts —— ApplyPatch 工具（结构化 diff 补丁）
 * ============================================================================
 *
 * 【定位】把 `*** Begin Patch / *** End Patch` 包裹的段落补丁翻译成文件系统操作；
 * 解析在 tool/patch-parser.ts，hunk 求值在 tool/patch-apply.ts，本文件只负责
 * "先全部验证、再全部落盘"的编排与错误映射。
 *
 * 【两阶段不变量】第 1 轮对每个 section 做 stat/read/hunk 求值，全部成功后才进入第 2 轮写入。
 * 因此一个坏 hunk 或一个不存在的路径会在任何文件被改动之前失败——补丁要么整体被接受、
 * 要么在写入前整体被拒（写入阶段本身的失败仍可能留下部分文件已改，见下）。
 *
 * 【副作用】add/update 走 writeTextFile（atomic，update 带 expectedRevision）；delete 走
 * removeFile；move 是"写新路径 + 删旧路径"的两步操作，不具备原子性，中途失败会同时留下
 * 新旧两份文件。这是本工具已知的窗口，所以它默认不注册（index.ts 中被注释掉）。
 *
 * 【失败语义】解析失败/空补丁/hunk 不匹配/目标已存在都映射为 ToolExecutionFailed +
 * ApplyPatchErrorCode，recoverable=true：模型应重读上下文后重发补丁，而不是换脚本硬改。
 * ============================================================================
 */

// 本文件是补丁落盘编排层：解析交给 patch-parser、hunk 求值交给 patch-apply，这里只管两阶段验证与写入。
// 阅读顺序：先看下面的 INV 清单确认边界，再看 applyPatchHandler 的两次循环与三个 verify 分支。
// 对外失败一律经 createPatchError 收敛成 ToolExecutionFailed 加错误码，模型据此重读后重发补丁。
// 该工具当前未注册（index.ts 中被注释掉），注释重点放在「一旦启用，哪条路径会伤到用户文件」。
// INV-01 两阶段提交：所有 section 先验证通过，才允许任何一个文件落盘；守住位置：applyPatchHandler 的验证循环与写入循环；改错故障：坏 hunk 之前已通过的 section 会被提前写盘，补丁半应用且无法回滚。
// INV-02 验证阶段严格只读，除 stat 与 readTextFile 外不得触碰写接口；守住位置：verifyAdd、verifyDelete、verifyUpdate；改错故障：校验失败时磁盘已被污染，「拒绝补丁」的承诺失效。
// INV-03 update 的写入必须携带验证阶段取得的 revision 作为 expectedRevision；守住位置：写入循环中 writeTextFile 的参数；改错故障：验证后被人改过的文件被静默覆盖，丢失他人编辑。
// INV-04 add 的存在性判断只把 not_found 视为可继续，其余 stat 错误必须原样上抛；守住位置：verifyAdd 的 catch 分支；改错故障：权限或 IO 故障被误判为文件不存在，随后写入覆盖真实文件。
// INV-05 delete 与 update 的读失败只把 not_found 映射为 FILE_NOT_EXIST；守住位置：readExisting 的 catch；改错故障：权限错误被包装成文件不存在，模型收到误导性的重试建议。
// INV-06 空补丁必须在解析后立刻拒绝为 EMPTY_PATCH；守住位置：applyPatchHandler 的空补丁分支；改错故障：模型发空补丁却拿到成功回执，误以为修改已经生效。
// INV-07 update section 没有 hunk 时拒绝为 INVALID_PATCH，不得退化为整文件覆写；守住位置：verifyUpdate 的 chunks 长度检查；改错故障：空 hunk 的 update 会把整份新内容灌入，文件被截断或清空。
// INV-08 hunk 求值失败统一映射 HUNK_NOT_FOUND，并把原始错误保留为 cause；守住位置：verifyUpdate 的 derivePatchedContent 异常处理；改错故障：上下文不匹配被报成内部错误，模型无法定位要重读的范围。
// INV-09 一切路径都必须经 resolveWorkspacePath 且 operation 固定为 write；守住位置：resolvePatchPath；改错故障：补丁可写到工作区之外，越权修改用户任意文件。
// INV-10 move 是「写新路径加删旧路径」两步，本层不做回滚；守住位置：applyPatchHandler 的 move 分支；改错故障：删旧失败时新旧两份文件并存，仓库出现重复源文件。
// INV-11 写入必须显式 atomic 与 createParents，不允许依赖适配层默认值；守住位置：writeTextFile 的参数字面量；改错故障：中断后留下半截文件，父目录缺失时整批补丁失败。
// INV-12 读到的 encoding 与 lineEndings 必须原样透传给写操作；守住位置：verify 分支的返回值与写入参数；改错故障：GB 系编码或 CRLF 文件被改写成 UTF-8 加 LF，产生整文件 diff。
// INV-13 写入顺序严格按 sections 原始顺序串行，不允许并发落盘；守住位置：写入循环的 await 链；改错故障：同文件被 add 与 update 同时处理的补丁出现竞态，结果取决于调度顺序。
// INV-14 本层只透传 context 的 trace 字段，不新建 traceId；守住位置：traceFor；改错故障：文件操作脱离原始会话链路，审计与问题定位断链。
// INV-15 每次适配层调用的 options 必须带 context.abortSignal；守住位置：全部 fileSystemPort 调用点；改错故障：用户取消后写入仍在继续，界面显示已停止而磁盘仍在变。
// INV-16 fileSystemPort 缺失属于 ConfigurationError 且 recoverable 为 false；守住位置：applyPatchHandler 的前置检查；改错故障：装配错误被当成模型可修复问题，陷入无效重试循环。
// INV-17 补丁语义错误都由 createPatchError 标记 recoverable 为 true 并附带 code；守住位置：createPatchError；改错故障：模型把可修复的上下文错误当成工具不可用，转而用 shell 硬改文件。
// INV-18 输出里的 structuredPatch 必须由实际 newContent 重新计算，不采信模型给的 diff 文本；守住位置：toOutputFileChange；改错故障：界面与审计看到与实际写入不一致的 diff，审查结论失真。
// INV-19 summary 的行标记只能是 A、D、M 三态，move 之后展示新路径；守住位置：formatSummaryLine；改错故障：用户无法从摘要判断文件是被新增、删除还是移动。
// INV-20 入口必须声明 concurrentSafe 为 false 且 timeout 不可被调用方覆盖；守住位置：applyPatchToolEntry 的 metadata 与 timeout；改错故障：两个补丁并行跑同一文件，或模型用超时参数拉长写窗口。
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  ApplyPatchErrorCode,
  ApplyPatchInputJsonSchema,
  ApplyPatchInputSchema,
  ApplyPatchOutputJsonSchema,
  ApplyPatchOutputSchema,
  CoreErrorType,
  createCoreError,
  isFileSystemPortError,
  type ApplyPatchFileChange,
  type ApplyPatchInput,
  type ApplyPatchOutput,
  type FileSystemTextEncoding,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { derivePatchedContent } from "../patch-apply.js";
import { parseStructuredPatch, type ParsedPatch } from "../patch-parser.js";
import { resolveWorkspacePath } from "../path-policy.js";

// [权衡] 这段指令是工具契约的一部分：补丁语法与失败后的正确动作都写在这里，
// 而不是靠 handler 在错误信息里临时解释，避免模型与实现各自演化出两套语法约定。
// [失败路径] 指令要求校验失败时重读上下文再重发，禁止改用替换脚本，
// 因为绕过本工具的写入会跳过路径策略与审批，副作用不可审计。
const APPLY_PATCH_MODEL_INSTRUCTIONS = [
  "Use ApplyPatch for structured, reviewable edits that are easier to express as local diff hunks than exact old_string replacements.",
  "The patch must start with `*** Begin Patch` and end with `*** End Patch`.",
  "Use `*** Update File: <path>` with `@@` hunks for existing files. Prefix context lines with a space, removed lines with `-`, and added lines with `+`.",
  "Use `*** Add File: <path>` for new files and prefix every content line with `+`.",
  "Use `*** Delete File: <path>` only when deleting the file is intentional.",
  "Patch hunks are logical Unicode text, just like Read output. Updates preserve each existing file's detected original text encoding and line endings when possible, including GB2312, GBK, and GB18030.",
  "If verification fails, re-read the relevant range and provide more exact context; do not switch to Python or shell replacement scripts.",
];

// 该结构是验证产物，只由三个 verify 分支构造，写入循环只读不写。
// [事务] oldContent 与 revision 必须来自同一次读取，否则 diff 基线与条件写基线会不一致。
// [权衡] 这里持有完整正文而非只存路径，用内存换掉第二阶段的整批重读，
// 代价是超大文件补丁的内存峰值等于所有 section 正文之和。
interface VerifiedPatchChange {
  filePath: string;
  type: ApplyPatchFileChange["type"];
  movePath?: string;
  oldContent: string;
  newContent: string;
  encoding?: FileSystemTextEncoding;
  lineEndings?: "LF" | "CRLF";
  revision?: { id: string; mtimeMs?: number; sizeBytes?: number; hash?: string };
}

function formatApplyPatchModelContent(output: unknown): string {
  const parsed = ApplyPatchOutputSchema.safeParse(output);
  if (!parsed.success) return "Patch applied successfully.";
  return `Patch applied successfully.\n${parsed.data.summary}`;
}

// 编排入口：输入先经运行时 schema 解析，再做端口检查、补丁解析、两轮循环。
// [失败路径] 任一阶段抛错都直接冒泡，不 catch、不做部分成功返回，调用方只看到全成或全败。
// [并发] 本函数不自带锁，串行性完全依赖 tool runtime 对 concurrentSafe 为 false 的调度。
// [资源] 不持有文件句柄，读与写都由适配层在单次调用内开闭并由其负责异常清理。
// 返回值必须满足 ApplyPatchOutput，summary 由 files 派生，不额外拼接自由文本。
export const applyPatchHandler: ToolHandler = async (input, context) => {
  const { patch_text } = ApplyPatchInputSchema.parse(input) as ApplyPatchInput;
  const fileSystemPort = context.fileSystemPort;

  // [失败路径] 端口缺失说明宿主装配错误，不是模型能修的问题，因此 recoverable 固定为 false。
  // 若这里改成可恢复，模型会反复重发同一补丁，把一次装配故障放大成多轮无效调用。
  // 上下文只带 toolCallId 与 toolName，不泄漏宿主内部配置细节。
  // 该检查先于解析，避免为一坨注定失败的补丁做无意义的字符串扫描。
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ApplyPatch tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "ApplyPatch",
        },
        recoverable: false,
      },
    );
  }

  // 解析与空补丁判断紧邻：解析成功但没有 section，等价于模型发了一段无操作的包装。
  // [失败路径] 语法错误统一映射 INVALID_PATCH，原始异常在 parsePatchOrThrow 内保留为 cause。
  // [权衡] 解析器不接收 context，只用 toolCallId 组装错误，保证 parser 可独立单测。
  // 空补丁被显式拒绝而不是返回空 files，否则模型会误判修改已生效。
  // 此处之后 sections 的元素类型已收窄，后续分支无需再判空。
  const sections = parsePatchOrThrow(patch_text, context.toolCallId);
  if (sections.length === 0) {
    throw createPatchError("patch rejected: empty patch", ApplyPatchErrorCode.EMPTY_PATCH, {
      toolCallId: context.toolCallId,
    });
  }

  // 第一阶段：只读验证。任何 section 失败都在这里抛出，此时磁盘还没有被改动。
  const trace = traceFor(context);
  const changes: VerifiedPatchChange[] = [];
  for (const section of sections) {
    changes.push(await verifySection(section, context, trace));
  }

  // 第二阶段：落盘。update 带 expectedRevision，若验证后被别人改过，写入会被适配层拒绝，
  // 避免"验证时看到 A、写入时覆盖 B"。move 的两步写删在这里无法回滚（见文件头）。
  // [事务] 进入本循环意味着全部 section 已通过验证，但循环本身没有整体回滚能力。
  // 中途任一写入失败，前面已写的文件保持新内容，后面未写的保持旧内容，形成部分应用。
  // [权衡] 不做快照回滚是为避免在工具层复制整个工作区，代价由审批与可恢复错误码兜住。
  // 循环必须串行 await，并发写同一文件会让 expectedRevision 的语义失效。
  // [失败路径] 写入错误不在此转换，直接冒泡，由上层统一映射成工具失败。
  for (const change of changes) {
    // delete 只走 removeFile，不写空内容，避免把删除实现成「清空文件」留下空壳。
    // [资源] 删除不校验 revision，验证阶段读到的内容只用于生成 structuredPatch 与摘要。
    // 因此验证后被改动的文件仍会被删除，这是删除语义的已知窗口，靠审批兜底。
    // continue 保证 delete 不落入下面的写入逻辑，省掉多余的分支嵌套。
    if (change.type === "delete") {
      await fileSystemPort.removeFile(
        { path: change.filePath, trace },
        { signal: context.abortSignal },
      );
      continue;
    }

    const targetPath = change.movePath ?? change.filePath;
    await fileSystemPort.writeTextFile(
      {
        path: targetPath,
        content: change.newContent,
        encoding: change.encoding,
        lineEndings: change.lineEndings,
        createParents: true,
        atomic: true,
        expectedRevision: change.type === "update" ? change.revision : undefined,
        trace,
      },
      { signal: context.abortSignal },
    );

    // [事务] move 拆成写新路径与删旧路径两步，两步之间不存在原子边界。
    // [失败路径] 写新成功而删旧失败时，新旧两份文件同时存在，用户会看到重复模块。
    // 顺序被刻意固定为先写后删，保证不会出现「旧的已删、新的没写」这种丢失方向。
    // [权衡] 用可手工清理的重复，换掉不可恢复的数据丢失，这是本工具默认不注册的原因之一。
    // move 的目标路径已在验证阶段解析过，这里不再重复做路径策略检查。
    if (change.type === "move") {
      await fileSystemPort.removeFile(
        { path: change.filePath, trace },
        { signal: context.abortSignal },
      );
    }
  }

  const files = changes.map(toOutputFileChange);
  return {
    files,
    structuredPatch: files.flatMap((file) => file.structuredPatch),
    summary: files.map(formatSummaryLine).join("\n"),
  } satisfies ApplyPatchOutput;
};

async function verifySection(
  section: ParsedPatch,
  context: Parameters<typeof applyPatchHandler>[1],
  trace: TraceContext,
): Promise<VerifiedPatchChange> {
  switch (section.type) {
    case "add":
      return verifyAdd(section, context, trace);
    case "delete":
      return verifyDelete(section, context, trace);
    case "update":
      return verifyUpdate(section, context, trace);
  }
}

// add 的验证只确认目标不存在，不预创建文件，也不写占位内容。
// [失败路径] 目标已存在时抛 FILE_EXISTS，提示模型改用 Update File 而不是覆盖。
// [并发] stat 与后续 writeTextFile 之间存在窗口，别的进程可在此期间创建同名文件。
// 该窗口无法在本层消除；原子写只保证内容完整，不保证独占创建。
// newContent 直接取 section.contents，add 不参与 hunk 求值。
async function verifyAdd(
  section: Extract<ParsedPatch, { type: "add" }>,
  context: Parameters<typeof applyPatchHandler>[1],
  trace: TraceContext,
): Promise<VerifiedPatchChange> {
  const filePath = resolvePatchPath(section.path, context);
  // Add File 的语义是"新建"：先 stat 确认不存在。只有 not_found 才算验证通过，
  // 其它 stat 错误（权限、IO）原样上抛，不能当成"文件不存在"而继续写。
  try {
    await context.fileSystemPort!.stat({ path: filePath, trace }, { signal: context.abortSignal });
    throw createPatchError(`File already exists: ${filePath}`, ApplyPatchErrorCode.FILE_EXISTS, {
      filePath,
      toolCallId: context.toolCallId,
    });
  } catch (error) {
    if (!isFileSystemPortError(error) || error.code !== "not_found") throw error;
  }
  return {
    filePath,
    type: "add",
    oldContent: "",
    newContent: section.contents,
  };
}

async function verifyDelete(
  section: Extract<ParsedPatch, { type: "delete" }>,
  context: Parameters<typeof applyPatchHandler>[1],
  trace: TraceContext,
): Promise<VerifiedPatchChange> {
  const filePath = resolvePatchPath(section.path, context);
  const read = await readExisting(filePath, context, trace);
  return {
    filePath,
    type: "delete",
    oldContent: read.content,
    newContent: "",
    encoding: read.encoding,
    lineEndings: read.lineEndings,
    revision: read.revision,
  };
}

async function verifyUpdate(
  section: Extract<ParsedPatch, { type: "update" }>,
  context: Parameters<typeof applyPatchHandler>[1],
  trace: TraceContext,
): Promise<VerifiedPatchChange> {
  if (section.chunks.length === 0) {
    throw createPatchError("Update file section has no hunks", ApplyPatchErrorCode.INVALID_PATCH, {
      filePath: section.path,
      toolCallId: context.toolCallId,
    });
  }

  const filePath = resolvePatchPath(section.path, context);
  const read = await readExisting(filePath, context, trace);
  let patched: string;
  try {
    // hunk 求值以验证阶段读到的正文为唯一基线，绝不在写入前重读文件。
    // [事务] 重读会让 diff 基线与 expectedRevision 脱节，产生基于新内容却挂旧版本的写。
    // [失败路径] 上下文不匹配时求值抛错，这里补上 filePath 与错误码后重抛。
    // 错误信息沿用底层 message，保留行号与期望上下文，便于模型精确重读。
    // [权衡] 不求值成功后再做二次校验，因为二次校验必然重读，等于主动打开竞态窗口。
    patched = derivePatchedContent(read.content, section.chunks).content;
  } catch (error) {
    throw createPatchError(
      error instanceof Error ? error.message : String(error),
      ApplyPatchErrorCode.HUNK_NOT_FOUND,
      {
        filePath,
        toolCallId: context.toolCallId,
      },
      error,
    );
  }

  const movePath = section.movePath ? resolvePatchPath(section.movePath, context) : undefined;
  return {
    filePath,
    type: movePath ? "move" : "update",
    movePath,
    oldContent: read.content,
    newContent: patched,
    encoding: read.encoding,
    lineEndings: read.lineEndings,
    revision: read.revision,
  };
}

async function readExisting(
  filePath: string,
  context: Parameters<typeof applyPatchHandler>[1],
  trace: TraceContext,
) {
  try {
    return await context.fileSystemPort!.readTextFile(
      { path: filePath, trace },
      { signal: context.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      throw createPatchError(`File not found: ${filePath}`, ApplyPatchErrorCode.FILE_NOT_EXIST, {
        filePath,
        toolCallId: context.toolCallId,
      });
    }
    throw error;
  }
}

function toOutputFileChange(change: VerifiedPatchChange): ApplyPatchFileChange {
  const structuredPatch = createStructuredPatch({
    filePath: change.movePath ?? change.filePath,
    oldContent: change.oldContent,
    newContent: change.newContent,
  });
  const { additions, deletions } = countPatchLines(structuredPatch);
  return {
    filePath: change.filePath,
    type: change.type,
    movePath: change.movePath,
    structuredPatch,
    additions,
    deletions,
  };
}

function countPatchLines(hunks: ApplyPatchFileChange["structuredPatch"]) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function formatSummaryLine(change: ApplyPatchFileChange): string {
  const marker = change.type === "add" ? "A" : change.type === "delete" ? "D" : "M";
  return `${marker} ${change.movePath ?? change.filePath}`;
}

function parsePatchOrThrow(patchText: string, toolCallId: string): ParsedPatch[] {
  try {
    return parseStructuredPatch(patchText);
  } catch (error) {
    throw createPatchError(
      error instanceof Error ? error.message : String(error),
      ApplyPatchErrorCode.INVALID_PATCH,
      { toolCallId },
      error,
    );
  }
}

function resolvePatchPath(
  inputPath: string,
  context: Parameters<typeof applyPatchHandler>[1],
): string {
  return resolveWorkspacePath({
    inputPath,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });
}

// 错误收敛点：补丁语义错误一律 ToolExecutionFailed，用 code 区分具体原因。
// [失败路径] cause 只在确实是 Error 时透传，避免把字符串错误塞进 cause 破坏序列化。
// code 与 toolName 合并进 context，extra 不得覆盖这两个字段的语义。
// recoverable 恒为 true：这些错误都能通过重读上下文并重发补丁修复。
// [权衡] 不新增错误类型而复用 ToolExecutionFailed，让上层重试与展示逻辑保持单一入口。
function createPatchError(
  message: string,
  code: (typeof ApplyPatchErrorCode)[keyof typeof ApplyPatchErrorCode],
  extra: Record<string, unknown>,
  cause?: unknown,
) {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    cause: cause instanceof Error ? cause : undefined,
    context: {
      code,
      toolName: "ApplyPatch",
      ...extra,
    },
    recoverable: true,
  });
}

function traceFor(context: Parameters<typeof applyPatchHandler>[1]): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

/**
 * 入口口径：readOnly=false + sideEffectScope=workspace + needsApproval=true（写工作区）；
 * permission="edit" 与 Edit 共用规则域，patternSources 只取 input —— 补丁正文即待审内容。
 * timeout 固定 30s 且 allowCallOverride=false：补丁应在一次文件操作内完成，不允许模型
 * 用超时参数把写操作拖长。resultBudget 走 truncate：写入摘要本身很小，不需要 artifact。
 */
// 注册声明与实现分离：handler 只关心执行，权限、超时、预算集中在这里声明。
// [权衡] concurrentSafe 为 false，因为补丁跨多个文件且 move 非原子，无法安全并行。
// [资源] resultBudget 走 truncate，摘要足够小，不需要落 artifact。
// [失败路径] cancellation 声明为 bestEffort，取消不保证回滚已写入的文件，用户提示已明说这点。
export const applyPatchToolEntry: ToolEntry = {
  capability: "Apply a structured patch through the file-system adapter",
  metadata: {
    name: "ApplyPatch",
    description: "Apply structured file patches with verification before writing.",
    modelInstructions: APPLY_PATCH_MODEL_INSTRUCTIONS,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: applyPatchHandler,
  formatModelContent: formatApplyPatchModelContent,
  inputSchema: ApplyPatchInputJsonSchema,
  outputSchema: ApplyPatchOutputJsonSchema,
  runtimeInputSchema: ApplyPatchInputSchema,
  runtimeOutputSchema: ApplyPatchOutputSchema,
  permission: {
    permission: "edit",
    reason: "ApplyPatch modifies file contents through the file-system adapter",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
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
    userVisibleMessage: "ApplyPatch was cancelled before file changes completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
