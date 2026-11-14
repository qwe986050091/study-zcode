/**
 * ============================================================================
 * tool/handlers/edit.ts —— Edit 工具（精确字符串替换）
 * ============================================================================
 *
 * 【前置条件】必须先 Read 过该文件（read-before-edit），且读取后文件未被修改。
 *   校验顺序：readFileState 存在完整视图 → mtime/size/revision 未前进 → 内容比对。
 *   任何一项不满足都返回结构化失败（EditErrorCode），而不是抛裸异常。
 *
 * 【匹配策略】精确匹配失败时交给 edit-matchers 做有限度的宽松匹配
 *   （行尾空白/引号风格等），再由 preserveQuoteStyle 把替换文本的引号风格对齐
 *   到实际匹配到的原文，避免"能匹配但改坏了格式"。
 *   非 replace_all 且匹配多处 → AMBIGUOUS_REPLACE，要求模型提供更多上下文。
 *
 * 【写回】通过 FileSystemPort.writeTextFile，atomic + expectedRevision：
 *   写入前若文件已被别人改过，适配层会拒绝（防止覆盖用户/格式化工具的改动）。
 *   写入成功后同步更新 readFileState（sourceTool=Edit），
 *   这样模型下一次 Edit 不需要重新 Read。
 *
 * 【新文件语义】文件不存在且 old_string 为空 = 创建新文件（createParents）；
 *   文件存在但 old_string 为空 = FILE_EXISTS_NO_OLD_STRING。
 *
 * 【结果】返回结构化 patch（originalFile/newString/structuredPatch），
 *   并附带 perf 明细（读写耗时、hunk 数、匹配尝试次数）供遥测。
 * ============================================================================
 */

/* eslint-disable max-lines -- Edit 工具需要集中维护文本匹配、read-before-edit 与写回状态，避免 bugfix 期间拆分扩大行为面。 */
// tool/handlers/edit.ts —— Edit 工具：在内存完成精确替换，经 FileSystemPort 原子写回
// 职责：read-before-edit 前置校验、换行与引号风格归一（normalizeLineEndings）、唯一性判定（findEditMatch）、写回后刷新读缓存——不刷新会让下一次 Edit 拿旧快照判 stale
// 职责：把每种失败收敛为 EditErrorCode 结构化结果，让模型按错误码自行纠正，而不是收到裸异常
//
// INV-01 每次成功写入前都必须已拿到 FileSystemPort 并完成 read-before-edit 校验；守住位置：editHandler 前半段；改错故障：跳过审批与陈旧检测后静默覆盖用户改动
// INV-02 old_string 与 new_string 全等时不写盘直接返回 NO_CHANGE，且该判断必须先于 stat；守住位置：editHandler 首个分支；改错故障：空操作触发一次真实写盘，产生无意义 mtime 与 diff
// INV-03 1GB 上限用 stat 的 sizeBytes 在读取前拦截，不是读完再量长度；守住位置：MAX_EDIT_FILE_SIZE_BYTES 分支；改错故障：超大文件被整份读入内存，工具进程 OOM 而非结构化报错
// INV-04 路径解析必须走 resolveWorkspacePath 且 operation 固定为 write，空路径单独返回 INVALID_PATH；守住位置：editHandler 路径段；改错故障：写入穿出工作区，或错误以裸异常穿透丢失 tool_use_error envelope
// INV-05 匹配与替换一律在 normalizeLineEndings 之后的 LF 视图上进行，写回时按 read.lineEndings 还原；守住位置：content 与 oldString 的归一化；改错故障：CRLF 文件被整体改写为 LF，产生整文件级 diff
// INV-06 唯一性必须以 match.actualString 实际命中的文本重新计数，而不是请求里的 old_string；守住位置：countOccurrences 调用点；改错故障：宽松匹配下把单处命中误判为多处，合法编辑被 AMBIGUOUS_REPLACE 拒绝
// INV-07 非 replace_all 且命中数大于 1 时必须失败且不写盘，不存在自动取首处的降级；守住位置：matchCount 分支；改错故障：模型意图之外的第一处被改写，用户拿到错误内容
// INV-08 引号风格对齐发生在宽松匹配之后、写回之前，只调整替换文本、不回改原文其余部分；守住位置：preserveQuoteStyle 调用；改错故障：匹配成功但文件混入异种引号，lint 直接失败
// INV-09 .ipynb 必须在 read-before-edit 之前就拒为 NOTEBOOK_FILE，避免对 JSON 结构做字符串替换；守住位置：ipynb 后缀分支；改错故障：notebook 结构被破坏且无法再打开
// INV-10 read-before-edit 的三态判定不可合并：无 readFileState 放行、partial view 拒绝、仅 mtime 前进才算 stale；守住位置：getEditableReadStateFailure；改错故障：子代理场景被误拦，或用户改动被覆盖
// INV-11 mtime 比较使用整数毫秒且只认严格前进，回退与相等都不算 stale；守住位置：hasReadStateChanged；改错故障：时钟回拨或粗粒度文件系统导致连续误报 STALE_FILE
// INV-12 写入必须带 expectedRevision 且 atomic 为 true，让适配层在外部改动时拒绝而非覆盖；守住位置：writeTextFile 参数；改错故障：并发编辑后写者静默覆盖先写者的结果
// INV-13 readFileState 只在写入成功返回后更新，且写成完整视图（offset 与 limit 为空、isPartialView 为 false）；守住位置：updateReadFileStateAfterEdit；改错故障：失败写入污染读缓存，下一次 Edit 基于并不存在的内容
// INV-14 读缓存键固定为 offset 1 且 limit 为空，与 Read 全量读取产生的键同构；守住位置：createReadFileStateKey 调用；改错故障：缓存分裂成两份，Edit 之后模型仍被要求重新 Read
// INV-15 并发模型是显式不并发：同一文件上的两个 Edit 不得并行，后写者由 expectedRevision 拒绝；守住位置：editToolEntry.concurrentSafe；改错故障：调度层并行化后并发编辑必然失败
// INV-16 取消是 bestEffort，取消落在 writeTextFile 中间时磁盘可能已部分写入，调用方不得假设回滚；守住位置：cancellation 字段；改错故障：上层把取消当原子回滚，文件停在半写状态
// INV-17 所有业务失败都返回 editFailure 的结构化 code 与 message，只有 FileSystemPort 缺失属于配置错误；守住位置：editFailure 与各分支；改错故障：provider 收不到可纠正的错误码，模型反复做无效重试
// INV-18 statEditableFile 只把 not_found 归一成 null，权限与 IO 错误必须上抛；守住位置：statEditableFile 的 catch；改错故障：不可读文件被当成不存在，进而走建新文件分支覆盖
// INV-19 perf 明细的 totalBytes 与 maxFileBytes 来自同一份新内容的单次字节计数；守住位置：writeEditResult 尾部；改错故障：大文件编辑被重复扫描两遍，编辑延迟翻倍
import { basename, dirname, extname } from "node:path";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolEntry,
} from "../types.js";
import {
  CoreErrorType,
  EditInputJsonSchema,
  EditInputSchema,
  EditOutputJsonSchema,
  EditOutputSchema,
  EditErrorCode,
  createCoreError,
  isFileSystemPortError,
  type EditInput,
  type EditOutput,
  type FileSystemReadTextResult,
  type FileSystemStatResult,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import {
  findEditMatch,
  normalizeLineEndings,
  normalizeReplacementForMatch,
  preserveQuoteStyle,
} from "../edit-matchers.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findEditableReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

// 这段描述是模型看到的工具契约：第一条“必须先 Read”与 handler 里的 read-before-edit 校验一一对应，
// 只改措辞而不改校验（或反之）会让模型按错误前提调用，实际每次都被 FILE_NOT_READ 拒绝。
const EDIT_PROVIDER_DESCRIPTION = [
  "Performs exact string replacement in a file.",
  "",
  "- You must Read the file in this conversation before editing, or the call will fail.",
  "- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.",
  "- `replace_all: true` replaces every occurrence instead.",
].join("\n");
// 以下四条文案属于对外错误契约，因为模型只按 message 自愈：改文案等同于改工具 API，同码两种说法会让模型按错误前提重试。
const NON_UNIQUE_OLD_STRING_MESSAGE =
  "old_string is not unique in the file. Provide more surrounding context or set replace_all to true.";
// 1GB 是能整份读进内存再匹配的上限，不是磁盘限制；超限在 stat 之后立刻拒绝
// [权衡] 放大到无限制会让一次误编辑把进程拖进 OOM，收紧到 100MB 又挡掉合法的日志与生成文件
const MAX_EDIT_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const EDIT_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
const EDIT_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
const EDIT_FRESHNESS_SUFFIX = " (file state is current in your context — no need to Read it back)";

// 输出形状非法时降级成通用文案而不是抛错；这里位于结果渲染路径，抛异常会把已落盘的成功编辑显示成失败
// userModified 为真说明用户在审批时改过内容，此时不再追加 freshness 后缀，避免暗示模型可以凭缓存继续编辑
// [失败路径] output 为 null、数组或字段缺失都落到默认分支，保证渲染永不失败
function formatEditModelContent(output: unknown): string {
  // 文件路径缺失时退化成 “the file”：这里是结果渲染路径，不能因为输出字段不全就抛错，否则一次已落盘的成功编辑会被显示成失败
  const filePath =
    isRecord(output) && typeof output.filePath === "string" ? output.filePath : "the file";
  // 只认严格布尔 true：输出可能来自旧适配层或被反序列化成字符串，宽松判断会把普通编辑误标成用户改过内容
  const userModified = isRecord(output) && output.userModified === true;
  // 同样只认严格 true：这个标记决定文案说“全部替换”还是“替换一处”，判错会让模型漏改或重复改
  const replaceAll = isRecord(output) && output.replaceAll === true;
  // 文案自带前后空格与句号，拼接处不必再补标点，两条模板都能得到完整句子
  const modifiedNote = userModified
    ? ".  The user modified your proposed changes before accepting them. "
    : "";
  // 用户动过内容时清空后缀：否则等于告诉模型缓存仍可直接复用，而实际落盘内容已被用户改过
  const freshnessSuffix = userModified ? "" : EDIT_FRESHNESS_SUFFIX;

  if (replaceAll) {
    // 全量替换单独一条模板：只改这个分支而不改文案，模型会误判是否还有剩余命中而重复调用
    return `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${freshnessSuffix}`;
  }

  // 默认分支即单处替换：replace_all 缺省为 false，走到这里不需要再判一次
  return `The file ${filePath} has been updated successfully${modifiedNote}.${freshnessSuffix}`;
}

/**
 * Edit 主入口。分派顺序（每一步失败都返回结构化 ToolHandlerFailure）：
 *   - old_string === new_string → NO_CHANGE（空操作不算错，但不写盘）；
 *   - 路径解析 → stat：不存在时，old_string 为空则建新文件，否则 FILE_NOT_EXIST；
 *   - 1GB 上限 → FILE_TOO_LARGE；
 *   - 读取并统一换行符后匹配：空 old_string 只能写空文件；
 *   - .ipynb → NOTEBOOK_FILE（必须走 NotebookEdit）；
 *   - read-before-edit / stale 校验；
 *   - findEditMatch → not_found / ambiguous；
 *   - 写回（writeEditResult）。
 *
 * 注意换行符规范化发生在匹配之前，写回时再按原文件的 lineEndings 还原，
 * 避免 CRLF 文件被 Edit 后整体变成 LF（产生巨大 diff）。
 */
// 入参先过 EditInputSchema.parse：schema 失败抛 ZodError，由上层统一转成 INVALID_INPUT，而不是这里的 ToolHandlerFailure
// [事务] 写盘是唯一有副作用的一步，全部校验与匹配都在内存完成，因此任何失败分支都不会留下半个文件
// abortSignal 只透传给适配层，本函数不做轮询取消：长匹配是纯 CPU 同步计算，中途无法安全打断
// fileSystemPort 缺失直接抛 ConfigurationError，属于装配错误而非用户可纠正错误，所以不走 editFailure
export const editHandler: ToolHandler = async (input, context) => {
  // schema 在这里同步解析：Zod 失败抛 ZodError，由上层统一转成 INVALID_INPUT；
  // 因此本函数返回的 editFailure 都是“参数合法但业务不成立”，两类错误不会混在一起。
  const { file_path, old_string, new_string, replace_all } = EditInputSchema.parse(
    input,
  ) as EditInput;
  // 端口只在这里取一次并复用：中途再读 context 可能拿到不同实例，导致 stat 与写盘落在两个适配器上
  const fileSystemPort = context.fileSystemPort;

  // 判空必须早于路径解析与 stat：缺适配器时连元数据都读不到，后续任何分支都只会再抛一次错
  if (!fileSystemPort) {
    // 缺端口抛 ConfigurationError 而不是返回 editFailure：模型改参数也修不好，只能由宿主补上依赖注入
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Edit tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Edit",
        },
        recoverable: false,
      },
    );
  }

  // [失败路径] 空操作返回 NO_CHANGE 而不是静默成功，让模型知道调用没有生效，避免它以为已经改完
  // 该判断必须先于 stat，否则不存在的文件配合相同的 old/new 会先落进建文件语义
  if (old_string === new_string) {
    return editFailure(
      EditErrorCode.NO_CHANGE,
      "No changes to make: old_string and new_string are exactly the same.",
    );
  }

  if (!file_path) {
    // 空路径由共享 path-policy 抛出普通异常，绕过了 Edit 自己维护的
    // code + message 失败契约，导致 provider-visible 内容丢失 tool_use_error envelope。
    return editFailure(EditErrorCode.INVALID_PATH, "Tool path must not be empty");
  }

  // operation 固定 write：读权限通过不代表可写，路径策略需要按写口径重新校验一次
  // [权衡] 越界路径在这里抛异常而不是返回 editFailure，是因为策略拒绝由上层统一渲染为权限错误
  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  // statEditableFile 只把 not_found 归一成 null；权限/IO 错误必须上抛，否则"无法访问"
  // 会被误判成"文件不存在"，然后走 old_string 为空的建新文件分支。
  // [失败路径] stat 为 null 只代表 not_found，随后按 old_string 是否为空分流成建文件或 FILE_NOT_EXIST
  // stat 结果同时供 1GB 上限和后续 read 使用，避免对同一路径做两次元数据查询
  // 此处不做 retry：stat 是幂等只读操作，重试只会把一次失败放大成超时
  const stat = await statEditableFile(filePath, context);
  // stat 为 null 只代表 not_found：权限与 IO 错误已在 statEditableFile 的 catch 里上抛，
  // 所以这里可以安全地只按“文件不存在”分流，不会把不可读文件误当成可新建。
  if (!stat) {
    // 文件不存在且 old_string 为空是唯一的隐式建文件入口，createParents 由 writeEditResult 统一打开
    // [权衡] 仅凭 old_string 为空就建文件，而不是要求显式 create 标志，换取模型少一次工具调用，代价是空串语义必须严格
    if (old_string === "") {
      // 新文件没有读盘与匹配过程：fsReadMs、patchMatchMs、matchAttempts 都填 0，否则遥测会虚构出不存在的 IO 成本；写盘耗时仍由 writeEditResult 真实测量。
      return writeEditResult({
        context,
        filePath,
        inputFilePath: file_path,
        originalFile: "",
        actualOldString: "",
        actualNewString: new_string,
        newContent: new_string,
        replaceAll: replace_all,
        fsReadMs: 0,
        patchMatchMs: 0,
        matchAttempts: 0,
      });
    }

    // 附上相似文件名建议：路径拼错是这类失败最常见的原因，给出候选能省掉一轮盲目重试
    return editFailure(
      EditErrorCode.FILE_NOT_EXIST,
      await createMissingEditFileMessage(filePath, context),
    );
  }

  // 大小判断放在 readTextFile 之前，这是唯一能在 OOM 之前拦住超大文件的时机
  // 错误文案把 1GB 写死在两处，改常量时必须同步，否则模型会收到自相矛盾的约束
  // 比较 stat 的 sizeBytes 而不是读到的字符串长度：后者只有把整份内容读进内存后才拿得到，起不到拦截作用
  if (stat.sizeBytes > MAX_EDIT_FILE_SIZE_BYTES) {
    return editFailure(
      EditErrorCode.FILE_TOO_LARGE,
      "File is too large to edit (1GB). Maximum editable file size is 1GB.",
    );
  }

  // [资源] readTextFile 返回整份字符串，超出工具能力的文件已在上面被拦截，这里不再做分块读取
  // read 结果要一直活到 writeEditResult 生成 patch，内存峰值约为旧内容加新内容的两倍
  // 计时从调用前开始，包含适配层的排队等待，因此 perf 里的 readMs 是端到端而非纯 IO
  const readStartedAt = Date.now();
  // 这是整个流程唯一一次全量读取；之后的归一化、匹配与 patch 都在这份内存副本上做，
  // 中途不再回读磁盘，因此 read 必须活到 writeEditResult 结束（内存峰值约为旧内容加新内容）。
  const read = await fileSystemPort.readTextFile(
    {
      path: filePath,
      trace: createEditTrace(context),
    },
    { signal: context.abortSignal },
  );
  // 读完立刻结算读耗时，后面的归一化与匹配再慢也不会被算进 readMs
  const fsReadMs = elapsedMsSince(readStartedAt);
  // 归一化只作用于内存副本，磁盘文件保持原样，写回时按 read.lineEndings 还原
  // [失败路径] 漏掉 oldString 的归一化时，模型传入的换行在 CRLF 文件里永远匹配不上，表现为莫名的 OLD_STRING_NOT_FOUND
  const content = normalizeLineEndings(read.content);
  // 请求里的 old_string 同样要归一：模型发出的 \n 在 CRLF 文件里必须转成 \r\n 才可能命中。
  const oldString = normalizeLineEndings(old_string);
  // 替换文本同样归一：否则会把模型给的 \n 原样写回 CRLF 文件，产出半 CRLF 半 LF 的混合内容
  const requestedNewString = normalizeLineEndings(new_string);

  // 文件已存在时的空 old_string 是“清空”语义，与上面 !stat 的建文件分支共用空串判据但落点不同：
  // 那条分支不读盘，这条必须先过 read-before-edit 才能改写已有内容。
  if (old_string === "") {
    // 用 trim 判空：只有空白字符的文件也不允许走新建分支，否则一个空串就能抹掉用户已有内容
    if (content.trim() !== "") {
      return editFailure(
        EditErrorCode.FILE_EXISTS_NO_OLD_STRING,
        "Cannot create new file - file already exists.",
      );
    }
    // 清空一个已存在的空文件同样要过 read-before-edit：模型不能把没读过的文件直接置空
    const readStateFailure = getEditableReadStateFailure(filePath, read, context.readFileState);
    // 清空已有文件同样受 read-before-edit 约束，否则模型能把一个没读过的文件直接置空。
    if (readStateFailure) return readStateFailure;
    return writeEditResult({
      context,
      filePath,
      inputFilePath: file_path,
      originalFile: content,
      // 空 old_string 表示清空语义：patch 以空原文为基准，新内容直接落盘，不做额外拼接
      actualOldString: "",
      actualNewString: requestedNewString,
      newContent: requestedNewString,
      read,
      replaceAll: replace_all,
      fsReadMs,
      patchMatchMs: 0,
      matchAttempts: 0,
    });
  }

  // notebook 是带结构的 JSON，字符串替换会破坏 cell 编码，必须交给 NotebookEdit 处理
  // 该判断有意放在 read-before-edit 之前：模型不必先 Read 一个注定不能编辑的文件
  if (filePath.endsWith(".ipynb")) {
    // 文案点名 NotebookEdit：模型看到具体替代工具才会切换，否则会把同样的 JSON 字符串替换再试一遍
    return editFailure(
      EditErrorCode.NOTEBOOK_FILE,
      "File is a Jupyter Notebook. Use the NotebookEdit to edit this file.",
    );
  }

  // 在匹配之前校验，使陈旧文件优先报 STALE_FILE，而不是先花代价做一次注定丢弃的匹配
  // 校验用的是刚读到的 read，而不是入口处 stat 的元数据，两者可能来自不同时刻
  const readStateFailure = getEditableReadStateFailure(filePath, read, context.readFileState);
  if (readStateFailure) return readStateFailure;

  // 计时覆盖 findEditMatch 整体，包含宽松匹配的多轮尝试，而不只是最终命中的那一次
  const patchMatchStartedAt = Date.now();
  // 精确匹配失败后才由 edit-matchers 做有限宽松匹配，策略结果写进 match.strategy 供遥测
  // [权衡] 宽松匹配提高了编辑成功率，但削弱了 old_string 必须唯一的直觉，因此后续必须按实际命中文本重算唯一性
  // findEditMatch 是同步 CPU 密集调用，超大 old_string 下耗时线性增长，patchMatchMs 用于暴露这项成本
  // match 携带状态与实际命中文本，后续唯一性计数只认 actualString，不能用请求里的 oldString。
  const match = findEditMatch({
    content,
    search: oldString,
    replaceAll: replace_all,
  });
  const patchMatchMs = elapsedMsSince(patchMatchStartedAt);
  // [失败路径] 文案回显原始 old_string 而不是归一化后的版本，模型才能对照自己发出的参数自行纠正
  // 这里不做模糊兜底猜测：静默改到相近文本比失败更糟，用户会拿到非预期内容
  if (match.status === "not_found") {
    // 只回显请求里的字符串，不带文件内容：避免为一次失败把整份文件重新灌回上下文
    return editFailure(
      EditErrorCode.OLD_STRING_NOT_FOUND,
      `String to replace not found in file.\nString: ${old_string}`,
    );
  }
  // ambiguous 来自宽松匹配阶段的多候选，与后面的 matchCount 不是同一口径，但对外映射到同一错误码
  // 提示 replace_all 或多给上下文，是模型能自愈的两条唯一出路
  if (match.status === "ambiguous") {
    // candidateCount 来自宽松匹配的候选集合，口径与后面的 matchCount 不同，两者不能互换使用
    return editFailure(
      EditErrorCode.AMBIGUOUS_REPLACE,
      createAmbiguousEditMessage(match.candidateCount, old_string),
    );
  }

  // findEditMatch 可能命中"宽松等价"的原文（行尾空白/引号风格差异），因此唯一性必须按
  // **实际命中的文本**重新计数：用请求里的 old_string 计数会把"只有一处真实匹配"误判成多处。
  const actualOldString = match.actualString;
  // [权衡] 只重算计数而不重跑匹配，用一次线性扫描换掉一次可能昂贵的宽松匹配
  // actualOldString 理论上非空，但空 needle 会让计数行为依赖 indexOf 实现，非空性必须由上游分支保证
  const matchCount = countOccurrences(content, actualOldString);
  // 命中多于一处且未开 replace_all 就整单失败：这里绝不降级成只替换第一处，否则用户会拿到模型没预期的内容
  // 这里的 matchCount 是 actualOldString 的字面命中数，与上面 ambiguous 的 candidateCount 不同源：
  // 前者是 actualOldString 的真实出现次数，后者是宽松匹配的候选集合大小。
  if (!replace_all && matchCount > 1) {
    return editFailure(
      EditErrorCode.AMBIGUOUS_REPLACE,
      createAmbiguousEditMessage(matchCount, old_string),
    );
  }

  // 归一化只作用于替换文本，原文保持不动，未命中的部分才会逐字节维持原样
  const normalizedNewString = normalizeReplacementForMatch(match.strategy, requestedNewString);
  // 先把替换文本按匹配策略归一，再把引号风格对齐到实际命中的原文；顺序反了会拿到错误的风格样本
  // [权衡] 只对齐引号不对齐缩进：缩进差异由模型显式给出，自动推断会把多行替换改坏
  const actualNewString = preserveQuoteStyle(oldString, actualOldString, normalizedNewString);
  // 替换只做一次，结果直接进写回；这里不做格式化或 trim，保持编辑即所见的语义
  // applyEditToContent 的删除分支会额外吞掉一个换行，因此 newContent 与朴素拼接可能不同
  const newContent = applyEditToContent(content, actualOldString, actualNewString, replace_all);

  // 走到这里说明路径、大小、read-before-edit 与唯一性全部通过，所以写盘是唯一副作用，
  // 因此上面所有失败分支都不会留下半个文件。
  return writeEditResult({
    context,
    filePath,
    inputFilePath: file_path,
    originalFile: content,
    actualOldString,
    actualNewString,
    newContent,
    read,
    replaceAll: replace_all,
    matchStrategy: match.strategy,
    matchCandidateCount: match.candidateCount,
    fsReadMs,
    patchMatchMs,
    // 记为 1 表示命中来自首次给出的请求文本；宽松匹配是否参与由 matchStrategy 单独体现
    matchAttempts: 1,
  });
};

/**
 * 入口口径：concurrentSafe=false —— 同一文件上的两个 Edit 必须串行，否则两次
 * expectedRevision 都基于同一旧版本，后写者会被适配层拒绝（这比静默覆盖安全，
 * 但代价是并发编辑必然失败，所以调度层不应把它们放进同一并行组）。
 * permission.patternSources 取 path：规则按被改文件路径匹配，而不是按文件内容。
 * timeout 固定 30s 且不允许调用覆盖；resultBudget 走 truncate（返回的是 diff，不是全文）。
 */
// concurrentSafe 为 false 是契约而非保守：同文件并行 Edit 会让两次 expectedRevision 指向同一旧版本，后写者必被拒绝
// [权衡] 超时 30s 且不允许调用覆盖，是因为超时后写盘可能已完成，重试会把同一次替换再叠一层
export const editToolEntry: ToolEntry = {
  capability: "Replace exact text in a file through the file-system adapter",
  metadata: {
    name: "Edit",
    description: EDIT_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: editHandler,
  formatModelContent: formatEditModelContent,
  inputSchema: EditInputJsonSchema,
  outputSchema: EditOutputJsonSchema,
  runtimeInputSchema: EditInputSchema,
  runtimeOutputSchema: EditOutputSchema,
  permission: {
    permission: "edit",
    reason: "Edit modifies file contents through the file-system adapter",
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
  // 取消只保证尽早停手，cleanup 为 bestEffort：writeTextFile 已进入提交阶段时磁盘可能已经留下新内容
  // [失败路径] 上层不能把取消当回滚，唯一的恢复手段是重新 Read 并比对
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Edit was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function editFailure(errorCode: number, message: string): ToolHandlerFailure {
  // 统一收敛成 result:false 加错误码：上层据此渲染 tool_use_error，而不是靠异常栈猜测失败原因
  return { result: false, errorCode, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 必须显式排除数组：数组也满足 typeof object，不剔除的话按字段读取会拿到 undefined 并静默落入默认分支
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 按不重叠方式推进扫描位置，避免在连续重复片段上得到重叠命中而虚增计数
// 空 needle 会让 indexOf 恒返回当前位置且步长为 0，形成空转，调用方必须在进入前拦住
// [权衡] 用朴素 indexOf 而不是正则，避开特殊字符转义与灾难性回溯
function countOccurrences(content: string, needle: string): number {
  // 计数与扫描位置都必须显式归零：两个变量跨越整轮扫描，漏掉复位会把上一次的结果带进本次
  let count = 0;
  let position = 0;
  // 上界用内容长度而不是 while (true)：needle 为空时 indexOf 恒返回当前位，靠这个条件才能退出
  while (position < content.length) {
    // 从上次命中末尾继续找，命中区间天然不重叠，连续重复片段不会被算两次
    const index = content.indexOf(needle, position);
    // 返回 -1 说明后面再无命中，提前退出，省掉对剩余区间的无意义扫描
    if (index === -1) break;
    // 先计数再前移：顺序反了会把本次命中的起点当成下一次搜索起点，同一处被重复统计
    count += 1;
    // 跨过整个命中长度，保证下一次搜索从本次命中之后开始
    position = index + needle.length;
  }
  // 返回总次数而不是命中位置列表：调用方只关心是否大于 1，返回数组会多一次分配
  return count;
}

function createEditTrace(context: ToolExecutionContext): TraceContext {
  // 逐字段白名单而不是展开整个 context：上游上下文含大量与透传无关的字段，展开会把整份上下文送进适配层
  return {
    traceId: context.traceId,
    // spanId 与 parentSpanId 必须成对透传，适配层才能把读和写挂到同一条调用链上
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    // turnId 缺失时保持 undefined，不新生成：凭空造的 id 会让 trace 出现无法回溯的分支
    turnId: context.turnId,
    // 断言只做编译期收口，运行期字段全部来自上面的显式映射
  } as unknown as TraceContext;
}

async function statEditableFile(
  filePath: string,
  context: ToolExecutionContext,
): Promise<FileSystemStatResult | null> {
  // 端口缺失返回 null 而不是抛错：真正的配置错误由调用方入口拦过，探测本身不应再制造一条失败路径
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return null;
  // stat 只取元数据不读内容，所以可以先于 1GB 拦截执行，成本与文件大小无关
  try {
    // 把 context.abortSignal 透传给 stat，用户取消后这次元数据查询不应继续占用适配层队列。
    return await fileSystemPort.stat(
      { path: filePath, trace: createEditTrace(context) },
      { signal: context.abortSignal },
    );
  } catch (error) {
    // 只把 not_found 翻译成 null：权限与 IO 错误必须上抛，否则不可读文件会被当成不存在而走建文件分支
    if (isFileSystemPortError(error) && error.code === "not_found") return null;
    // 原样抛出保留 code 与 message，上层才能区分权限不足和磁盘故障
    throw error;
  }
}

// 失败文案里带上工作目录与相似文件候选：路径拼错是 FILE_NOT_EXIST 最常见的原因，
// 一条 FILE_NOT_EXIST 建议能省掉模型一轮盲目重试。
async function createMissingEditFileMessage(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string> {
  // 先算候选再拼文案：没有候选时整句省略，避免输出 "Did you mean undefined?"
  const suggestion = await findSimilarFilename(filePath, context);
  // 带上当前工作目录：模型据此判断自己是不是在错误的 workspace 下操作
  return [
    `File does not exist. Note: your current working directory is ${context.workingDirectory}.`,
    suggestion ? ` Did you mean ${suggestion}?` : "",
  ].join("");
}

// [失败路径] 目录列举失败一律吞掉：找不到候选只是少一条建议，不能让 FILE_NOT_EXIST 退化成 IO 异常
// 优先同 stem 命中，再退回编辑距离阈值，覆盖扩展名写错与文件名打错两类高频失误
async function findSimilarFilename(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return undefined;

  try {
    // 目录、文件名、主干一次派生好：后面筛选与比较都复用，避免重复调用 dirname/basename
    const parent = dirname(filePath);
    const targetName = basename(filePath);
    const targetStem = basename(filePath, extname(filePath));
    // 只列直接父目录不递归：递归在巨型仓库里会把一次报错拖成秒级扫描
    const listed = await fileSystemPort.listDirectory(
      { path: parent, trace: createEditTrace(context) },
      { signal: context.abortSignal },
    );
    // 只保留普通文件与符号链接：目录和特殊文件不可能被 Edit 打开，混进来只会污染建议
    const entries = listed.entries
      .filter((entry) => entry.kind === "file" || entry.kind === "symlink")
      .map((entry) => entry.name)
      // 排除目标自身，否则“最相似”永远命中那个并不存在的名字
      .filter((name) => name !== targetName)
      // 排序让候选顺序稳定，同一错误多次触发会给出同样的建议，方便复现
      .sort();

    // 同主干优先：扩展名写错远比文件名打错常见，先按主干对齐能命中大多数情况
    const sameStem = entries.find((name) => basename(name, extname(name)) === targetStem);
    if (sameStem) return sameStem;

    // 阈值 3 只容忍少量字符错位：再放宽就会挑到语义无关的文件，反而误导模型
    return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
  } catch {
    return undefined;
  }
}

// [权衡] levenshteinDistance 只保留相邻两行滚动数组（空间为 right.length + 1），也没有做阈值提前退出：
// 这段只在找不到同 stem 时才走到，候选数量已被目录规模封顶，再加分支只会增加维护面而不减少实际耗时。
function levenshteinDistance(left: string, right: string): number {
  // 上一行初始化为 0..n：表示空串到右串各前缀的编辑距离
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  // 两行滚动数组复用固定长度空间，不建 m×n 矩阵；候选文件名短但数量多，省下的是分配次数
  const current = Array.from({ length: right.length + 1 }, () => 0);

  // 外层遍历左串的每个字符，第二个内层循环负责把 current 回写进 previous。
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    // 首列表示左串前缀整体删除，值等于已处理的字符数
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      // 字符相同不需操作，不同则至少一次替换
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      // 三个候选取 Math.min：删除是 current[j-1]+1；插入是 previous[j]+1；替换是 previous[j-1]+cost。
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    // 逐格回写而不是交换引用：两个数组长度固定，交换会让下一轮写入落在错误的目标上
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index]!;
    }
  }

  // 取右下角结果；理论上必有值，?? 0 只为满足无索引检查的编译约束
  return previous[right.length] ?? 0;
}

/**
 * read-before-edit 校验。
 *
 * 三种结果：
 *   - 没有 readFileState：视为"不走该机制的调用方"（例如子代理精简上下文），放行；
 *   - 没有最近读取记录，或记录是 partial view → FILE_NOT_READ
 *     （partial view 意味着模型看到的不是完整文件，不能在其上做精确替换）；
 *   - 文件已变化 → STALE_FILE；唯一例外：严格全量读取且内容完全一致，
 *     说明 mtime 变了但内容没变（格式化工具重写同样内容），允许继续。
 */
// 没有 readFileState 直接放行，是为了兼容不使用该机制的调用方，例如上下文精简过的子代理
// partial view 一律拒绝：模型只看到片段时做精确替换，等于在猜测没看到的那部分
// [事务] 内容完全一致的特例只对严格全量读生效，防止格式化工具重写同样内容后模型被迫重新 Read
function getEditableReadStateFailure(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): ToolHandlerFailure | undefined {
  // 只有显式传入状态表才校验：缺表说明调用方不走该机制，直接拒绝会把子代理的编辑全部挡死
  if (!readFileState) return undefined;

  // 按路径归一后取最近一条：分片读取或多次 Read 会留下多条记录，只有最近那条能代表当前视图
  const lastRead = findEditableReadFileState(readFileState, filePath);
  // 没有记录等于本轮从未读过；partial view 等于只看到片段，两者都不能作为精确替换的依据
  if (!lastRead || lastRead.isPartialView) {
    return editFailure(EditErrorCode.FILE_NOT_READ, EDIT_NOT_READ_MESSAGE);
  }

  // 未变化直接放行：正常编辑走这条路径，不产生任何额外 IO
  if (!hasReadStateChanged(lastRead, currentRead)) return undefined;
  // 全量读且内容一致时放过：mtime 变了但内容没变，常见于格式化工具原样重写
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return undefined;

  // 其余一律判陈旧：宁可让模型多读一次，也不能基于看不到的内容做替换
  return editFailure(EditErrorCode.STALE_FILE, EDIT_STALE_MESSAGE);
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  // 分片视图无论起点多靠前都不算全量：它保证不了覆盖到文件末尾
  if (entry.isPartialView) return false;
  // offset 缺省按 1 处理（Read 默认从首行开始），limit 必须为空才代表不限行数
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

/**
 * 判断文件是否在 Read 之后被修改。
 *
 * 口径：mtime 只比较整数毫秒，并且只有"当前 mtime 严格晚于记录值"才算变化
 * （mtime 回退可能是时钟/恢复导致，不作为 stale 依据）；size 任何变化都算。
 * 无 mtime 时退回 size/revision.id 比对。
 */
// mtime 只认严格前进：时钟回拨、快照恢复、容器时间同步都可能让它变小，而内容通常没变
// size 任何变化都判 stale，包括变小；截断之后内容必然不同，不存在变小但等价的合法场景
// 无 mtime 时退回 revisionId 比对，网络文件系统下 mtime 精度不可信，只能依赖适配层给的版本号
function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  // 先取出当前 mtime：下面只在两边都非 undefined 时才用它比较
  const currentMtimeMs = currentRead.revision?.mtimeMs;
  // 两边都有 mtime 时优先比较它：判定外部修改最直接，也最便宜
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 亚毫秒级精度，只在当前文件的整数毫秒晚于 Read 记录或大小变化时判 stale，减少误报。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    // 只有严格大于才算变化：相等表示没动，变小通常是时钟回拨或快照恢复而非真实修改
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    // mtime 没前进但大小变了同样判 stale：长度变化说明文件确实被改写过
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  // 缺 mtime 时退到 size：大小不同内容必然不同，可以直接判定
  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  // 大小相同仍可能被等长替换，只能再比一次版本号
  const currentRevisionId = currentRead.revision?.id;
  // 两边都有版本号且不同才判变化；任一缺失时不做判断，避免无依据地拦截
  return Boolean(
    lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId,
  );
}

/**
 * 写回编辑结果并更新读取状态。
 *
 * 关键点：
 *   - stampMemoryOriginSessionId：写 memory 目录文件时打上来源 session，供后续
 *     记忆归因；对普通文件是 no-op；
 *   - lineEndings 取自本次读取（缺失时用原内容探测），保证 CRLF/LF 不被改写；
 *   - expectedRevision：乐观并发控制，文件被外部改动时写入失败而不是覆盖；
 *   - 写入成功后 readFileState 更新为"完整、已读"视图，避免模型二次 Read；
 *   - perf 明细里的 totalBytes 只算一次（大文件时不重复扫描）。
 */
// [事务] 顺序固定：stamp memory 来源、原子写、更新读缓存、生成 patch；任一前置失败都不能先动缓存
// createParents 恒为 true：新建深层目录下的文件与覆盖已有文件走同一条写路径
// [资源] 写入失败时 read 与 newContent 仍被持有到本函数返回，大文件下这段内存无法提前释放
async function writeEditResult(input: {
  // 调用上下文：端口、trace、取消信号与读缓存都从这里读取。
  context: ToolExecutionContext;
  // 解析后的绝对路径，写盘与 readFileState 缓存键都依赖它。
  filePath: string;
  // 模型传入的原始路径：只用于 patch 与回显，保持与请求一致的前缀形式。
  inputFilePath: string;
  // 归一化后的旧内容：作为 patch 的 old 侧，与新内容同口径比较。
  originalFile: string;
  // 实际命中的原文：宽松匹配后可能与请求里的 old_string 不同，patch 必须用它。
  actualOldString: string;
  // 实际写入的替换文本，已按 matchStrategy 与引号风格归一。
  actualNewString: string;
  // 即将落盘的新内容；memory 来源标记会在此之上再追加。
  newContent: string;
  // 读取结果返回编码、换行风格与 expectedRevision，新建文件时缺省。
  read?: FileSystemReadTextResult;
  // 是否全量替换：决定 applyEditToContent 的语义与输出字段。
  replaceAll: boolean;
  // fsReadMs 在新建文件时为 0，避免遥测虚构不存在的 IO 开销。
  fsReadMs: number;
  // 匹配耗时：包含 findEditMatch 的多轮尝试。
  patchMatchMs: number;
  // matchAttempts：命中来自首次请求文本时固定为 1。
  matchAttempts: number;
  // 命中的 matchStrategy，供遥测区分精确匹配与宽松匹配。
  matchStrategy?: string;
  // matchCandidateCount：宽松匹配的候选数量，仅在该策略下有意义。
  matchCandidateCount?: number;
}): Promise<EditOutput> {
  // 再取一次端口而不是信任入参：新建文件路径也走这个函数，它必须自己保证依赖存在
  const fileSystemPort = input.context.fileSystemPort;
  // 新建文件同样从这里落盘，因此入口处的判空不能替代本函数的自检。
  if (!fileSystemPort) {
    // 缺端口属于装配错误，只能抛出去让宿主修复注入，返回结构化失败会让模型反复重试
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Edit tool",
      {
        context: {
          toolCallId: input.context.toolCallId,
          toolName: "Edit",
        },
        recoverable: false,
      },
    );
  }

  // memory 源标记对普通文件是 no-op，因此可以无条件套用，不必在这里判断目录归属
  const contentToWrite = stampMemoryOriginSessionId({
    content: input.newContent,
    filePath: input.filePath,
    memoryRoot: input.context.memoryRoot,
    sessionId: input.context.sessionId,
  });
  // 写耗时包含适配层的排队与原子替换，反映的是端到端耗时而不是纯 IO
  const writeStartedAt = Date.now();
  const writeResult = await fileSystemPort.writeTextFile(
    {
      path: input.filePath,
      content: contentToWrite,
      // 沿用读取时的编码：按 UTF-8 重写一个 UTF-16 文件会让整份内容变成乱码
      encoding: input.read?.encoding,
      // 换行风格优先用读取结果，缺失时才按原文探测，保证 CRLF 文件不会整体被改成 LF
      lineEndings: input.read?.lineEndings ?? detectLineEndings(input.originalFile),
      // 恒为 true：新建深层目录与覆盖已有文件共用这条写路径，无需调用方额外声明
      createParents: true,
      atomic: true,
      // [并发] 这是唯一的乐观锁：适配层用它比对磁盘当前版本，不相等即拒绝写入
      // read 缺失时该字段为 undefined，适配层据此跳过比对，语义是允许创建
      expectedRevision: input.read?.revision,
      // trace 必传：适配层靠它把这次写盘挂到当前工具调用链上
      trace: createEditTrace(input.context),
    },
    { signal: input.context.abortSignal },
  );
  // 写耗时在 await 返回后立刻结算，后面的缓存与 patch 计算不计入 writeMs
  const fsWriteMs = elapsedMsSince(writeStartedAt);

  // 缓存更新写在 writeTextFile 成功之后，此刻磁盘内容已确定，缓存与磁盘不会分叉
  // 传入的是 contentToWrite 而不是 newContent，保证缓存里是含 memory 标记的真实落盘内容
  const readFileStateEntry = updateReadFileStateAfterEdit(
    input.context.readFileState,
    input.filePath,
    contentToWrite,
    writeResult.revision,
  );
  // 元数据上报是可选的观测钩子，可能未装配，判空交给函数内部，调用点不写条件分支
  recordReadFileStateMetadata(input.context, readFileStateEntry);

  // 路径用调用方给的原始 inputFilePath，保持与模型请求一致的前缀形式，而不是解析后的绝对路径
  // [权衡] patch 基于旧内容与新内容全量比对，大文件下是线性成本，但省掉了维护增量 hunk 状态
  const structuredPatch = createStructuredPatch({
    filePath: input.inputFilePath,
    // 旧内容用归一化后的视图，与新内容同口径比较，否则仅换行差异就会撑出整文件 diff
    oldContent: input.originalFile,
    newContent: contentToWrite,
  });
  // perf 里 totalBytes/maxFileBytes 语义相同，缓存结果避免大文件编辑时重复扫描新内容。
  const newContentBytes = fileByteCount(contentToWrite);

  return attachToolExecutionTelemetry(
    {
      filePath: input.inputFilePath,
      oldString: input.actualOldString,
      newString: input.actualNewString,
      originalFile: input.originalFile,
      structuredPatch,
      // 工具层不臆造用户修改标记：审批阶段的改动由上层在回调里覆盖这个字段
      userModified: false,
      replaceAll: input.replaceAll,
      matchStrategy: input.matchStrategy,
      matchCandidateCount: input.matchCandidateCount,
    } satisfies EditOutput,
    {
      detail: {
        kind: "patch",
        filesystem: {
          readMs: input.fsReadMs,
          writeMs: fsWriteMs,
          // 固定为 1：Edit 只写一个文件，多文件语义应走其他工具
          fileCount: 1,
          totalBytes: newContentBytes,
          maxFileBytes: newContentBytes,
          workspaceKind: workspaceKind(input.context),
        },
        patch: {
          matchMs: input.patchMatchMs,
          // 直接取 patch 数组长度，不再额外统计一遍 hunk
          hunkCount: structuredPatch.length,
          matchAttempts: input.matchAttempts,
        },
      },
    },
  );
}

function updateReadFileStateAfterEdit(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"] | undefined,
): ReadFileStateEntry | undefined {
  // 没有状态表就什么都不做：不走该机制的调用方不该被强塞一份缓存
  if (!readFileState) return undefined;
  // 写成完整视图：offset 与 limit 置空、isPartialView 为 false，下一次 Edit 才能直接复用
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    // 显式置空而不是省略字段：Read 全量读取产生的就是空 offset，字段缺省与空值必须同构
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    // 时间戳取写成功后的当前时刻，作为之后 mtime 比较的基准
    readAt: new Date(),
    // 标记来源为 Edit，排查缓存出处时能区分是读还是写产生的记录
    sourceTool: "Edit",
    // 版本号来自写回结果，适配层不提供时留空，后续只能靠 mtime 与 size 判定
    revisionId: revision?.id,
    // 与 Read 走同一套归一函数，保证两处写入的精度口径一致
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    // 适配层给不出大小时按 UTF-8 字节数兜底，与 mtime 一起构成下一轮陈旧判定
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  // 键固定 offset 1 且 limit 为空，与 Read 全量读取的键完全同构，否则缓存会分裂成两条
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  // 返回条目供上面的元数据回调复用，调用方不必再回表里查一次
  return entry;
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  // 回调是可选的观测钩子，未装配时直接返回，不影响编辑主流程
  if (!context.recordReadFileStateMetadata) return;
  // 转换函数在条目为空时可能返回 undefined，所以下面还要再判一次
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Edit",
  });
  // 只有转换成功才上报，避免把空元数据写进会话记录
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function applyEditToContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  // 先取局部变量：删除分支要用同一个值判空，直接读参数会让两处判断出现分歧
  const replacement = newString;
  // 非空替换走直接字面替换，不需要处理换行吞噬
  if (replacement !== "") {
    return replaceLiteral(content, oldString, replacement, replaceAll);
  }

  // 删除分支：old_string 后面紧跟换行时把换行一起删掉，避免在文件里留下空行；
  // old_string 自身已以换行结尾时不再追加，防止把下一行的缩进也吞掉。
  // includes 先探测带换行的形式是否存在，避免对不存在的组合多做一次替换尝试
  const search =
    !oldString.endsWith("\n") && content.includes(`${oldString}\n`) ? `${oldString}\n` : oldString;

  // 删除也复用同一个字面替换实现，replace_all 语义在这里同样生效
  return replaceLiteral(content, search, replacement, replaceAll);
}

// 用函数式 replacement 规避 $$ 与 $& 等替换 token 被解释，模型写入的文本必须原样落盘
// [权衡] 不用 split 加 join，是因为 split 在空 search 下会产生意外切分，而 replaceAll 已覆盖全部场景
function replaceLiteral(
  content: string,
  search: string,
  replacement: string,
  replaceAll: boolean,
): string {
  // String.replace 的字符串 replacement 会把 $$/$& 当特殊 token；
  // replace_all 覆盖全部命中，与 matchCount 校验时的计数口径保持一致
  return replaceAll
    ? content.replaceAll(search, () => replacement)
    // 单次 replace 只改首个命中，前提是上游已确认唯一；否则其余命中会被静默丢掉
    : content.replace(search, () => replacement);
}

function createAmbiguousEditMessage(matchCount: number, oldString: string): string {
  // 有正数命中才报具体次数，同时给出两条自愈路径：开 replace_all 或补充上下文
  if (matchCount > 0) {
    return `Found ${matchCount} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
  }
  // 计数为 0 说明候选来自宽松匹配而非字面命中，次数在这里没有意义，退回通用文案
  return NON_UNIQUE_OLD_STRING_MESSAGE;
}

/**
 * 探测原文件换行风格：CRLF 数量多于 LF 才判定为 CRLF。
 * 平局按 LF 处理（混合换行文件不应被整体转成 CRLF）。
 */
// 只在 input.read?.lineEndings 缺失时兜底；逐字符扫描而不用正则或 split，避免为大文件额外分配一份与正文等长的临时数组。
function detectLineEndings(content: string): "LF" | "CRLF" {
  // 两个计数器只服务比值判据，从 0 起即可，不需要记录总行数
  let crlfCount = 0;
  let lfCount = 0;
  // 逐字符扫描避免 split 出一份与内容等长的行数组，大文件下这份临时内存很可观
  for (let index = 0; index < content.length; index += 1) {
    // 非换行字符直接跳过，减少后面的分支判断
    if (content[index] !== "\n") continue;
    // index > 0 防越界：行首的 \n 前面没有字符可读
    if (index > 0 && content[index - 1] === "\r") {
      // 前一个字符是 \r，说明这是 CRLF 的后半段
      crlfCount += 1;
    } else {
      // 否则是裸 LF，单独累计用于和 CRLF 比多少
      lfCount += 1;
    }
  }
  // 返回字面量而非枚举：调用方直接写进 lineEndings 字段，多余转换只会多一层映射
  return crlfCount > lfCount ? "CRLF" : "LF";
}
