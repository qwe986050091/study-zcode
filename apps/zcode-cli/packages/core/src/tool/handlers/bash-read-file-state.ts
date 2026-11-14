// INV-01 副作用不改变执行结果：守住位置 全函数捕获；改错故障 Bash 成功被增强逻辑改成失败。
// INV-02 先算提示再回填：守住位置 调用顺序；改错故障 提示基于回填后的新状态。
// INV-03 跳过条件统一判定：守住位置 共享判断函数；改错故障 后台或图片输出污染读状态。
// INV-04 只有写命令才查 stale：守住位置 标记匹配；改错故障 每条命令都遍历已读文件。
// INV-05 缺少端口即静默返回：守住位置 能力检查；改错故障 无端口时抛错。
// INV-06 修改判定需同时晚于两点：守住位置 双比较；改错故障 旧修改被误报。
// INV-07 时间缺失不参与比较：守住位置 归一化函数；改错故障 无效时间产生误报。
// INV-08 stat 失败只跳过该条：守住位置 单条捕获；改错故障 一个文件失败拖垮整批。
// INV-09 提示最多展示固定条数：守住位置 截断常量；改错故障 提示挤占上下文。
// INV-10 回填要求输出未截断：守住位置 字段判断；改错故障 绕过先读后写语义。
// INV-11 来源按退出码过滤：守住位置 条件过滤；改错故障 失败命令被当成已读。
// INV-12 已有状态不重复写：守住位置 查找早退；改错故障 覆盖更精确的既有记录。
// INV-13 只回填普通文件：守住位置 类型判断；改错故障 目录被当作可读文件。
// INV-14 超大文件不回填：守住位置 大小比较；改错故障 一次读取塞满会话状态。
// INV-15 读取截断即放弃：守住位置 结果判断；改错故障 半份内容冒充完整已读。
// INV-16 取消后不再写入：守住位置 中止检查；改错故障 用户取消后仍更新状态。
// INV-17 条目记录修订信息：守住位置 字段兜底链；改错故障 后续编辑判断拿到旧版本。
// INV-18 键包含范围参数：守住位置 键构造；改错故障 局部读取覆盖整文件记录。
//
// 模块职责：Bash 执行后生成过期读取提示，并把确实读到的内容回填到读状态。
// 状态所有权：读状态由执行上下文持有，本模块只按既有键写入条目。
// 阅读顺序：先看入口顺序，再看过期提示，最后看回填与跳过判定。
/**
 * Bash 执行后的 readFileState 副作用：stale 提示 + 已读文件回填。
 * 由 bash.ts 在执行结束后调用 applyBashReadFileStateEffects；
 * stale 提示只对已知会写文件的命令（WRITE_COMMAND_MARKERS）比较 mtime，
 * 回填只在 stdout 未截断、且非后台/图片/中断/provider 错误时进行，避免伪造"完整已读"。
 * 所有失败都静默：Bash 已经返回，read-state 增强不能改变执行结果。
 */

import type {
  BashOutput,
  ExecutionResult,
  FileSystemStatResult,
  TraceContext,
} from "@zcode/contracts";
import { relative } from "node:path";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";
import { collectBashReadFileSources, selectReadContent } from "./bash-read-file-sources.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";

// 超过 10MB 的文件不回填，避免一次 Bash 读取把超大内容塞进会话 read-state。
const MAX_BASH_READ_STATE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_STALE_HINT_DISPLAY_PATHS = 5;
// 这些命令/flag 会改写文件；只有命中才需要检查"用户已读文件是否被本次命令改动"。
const WRITE_COMMAND_MARKERS = new RegExp(
  [
    "--write",
    "--fix",
    "--in-place",
    "--auto-correct",
    "\\brun\\s+format\\b",
    "\\brun\\s+fix\\b",
    "\\b(yarn|pnpm)\\s+format\\b",
    "\\blint:file\\b",
    "\\blint:fix\\b",
    "\\bblack\\b",
    "\\bisort\\b",
    "\\bruff\\s+format\\b",
    "\\bcargo\\s+(fmt|fix)\\b",
    "\\brustfmt\\b",
    "\\bgo\\s+fmt\\b",
    "\\bterraform\\s+fmt\\b",
    "\\bdprint\\s+fmt\\b",
    "\\bswiftformat\\b",
    "\\bphpcbf\\b",
  ].join("|"),
);

interface BashReadFileStateEffectsInput {
  command: string;
  context: ToolExecutionContext;
  output: BashOutput;
  result: ExecutionResult;
}

// applyBashReadFileStateEffects() 只有两步，顺序即语义。
// staleHint 写回 input.output.staleReadFileStateHint，供模型看到。
// backfillReadFileStateFromBash() 失败不影响已产生的输出。
export async function applyBashReadFileStateEffects(
  input: BashReadFileStateEffectsInput,
): Promise<void> {
  // 先算 stale 提示、再回填：提示必须基于命令结束时的 mtime，不能被回填后的新状态影响。
  const staleHint = await createStaleReadFileStateHint(input);
  if (staleHint) input.output.staleReadFileStateHint = staleHint;
  await backfillReadFileStateFromBash(input);
}

// WRITE_COMMAND_MARKERS 不命中时不产生过期提示。
// 只比较命令开始前 readFileState 里的已读记录。
// mtime 必须同时晚于命令开始与读取时刻两点。
// 提示按相对路径展示，并由 formatStaleReadFileStateHint() 限制条数。
async function createStaleReadFileStateHint(
  input: BashReadFileStateEffectsInput,
): Promise<string | undefined> {
  if (shouldSkipBashReadFileStateEffects(input.output)) return undefined;
  if (!WRITE_COMMAND_MARKERS.test(input.command)) return undefined;
  const fileSystemPort = input.context.fileSystemPort;
  const readFileState = input.context.readFileState;
  if (!fileSystemPort || !readFileState) return undefined;

  const changedPaths = new Set<string>();
  const trace = createBashReadFileStateTrace(input.context);
  await Promise.all(
    Array.from(readFileState.values(), async (entry) => {
      const entryMtimeMs = normalizeReadFileStateMtimeMs(entry.mtimeMs);
      if (entryMtimeMs === undefined) return;
      try {
        const stat = await fileSystemPort.stat(
          { path: entry.path, trace },
          { signal: input.context.abortSignal },
        );
        const currentMtimeMs = currentStatMtimeMs(stat);
        if (currentMtimeMs === undefined) return;
        // mtime 晚于命令开始时间且晚于记录时间，说明本次命令改过该文件。
        if (currentMtimeMs > input.result.startedAt.getTime() && currentMtimeMs > entryMtimeMs) {
          changedPaths.add(entry.path);
        }
      } catch {
        // 无法 stat 的已读文件不阻断 Bash result。
      }
    }),
  );

  const paths = [...changedPaths];
  if (paths.length === 0) return undefined;
  return formatStaleReadFileStateHint(paths, input.context.workingDirectory);
}

// stdoutTruncated 为真时整段不参与回填。
// 来源由 collectBashReadFileSources() 按退出码与内容过滤。
// 已有 readFileState 优先，回填不覆盖。
async function backfillReadFileStateFromBash(input: BashReadFileStateEffectsInput): Promise<void> {
  if (shouldSkipBashReadFileStateEffects(input.output)) return;
  // Bash cat/head/tail/sed 的 read-state 只能代表模型已经看到的内容；
  // stdout 被截断时回读完整文件会绕过 Edit/Write 的 read-before-write 语义。
  if (input.output.stdoutTruncated === true) return;
  const fileSystemPort = input.context.fileSystemPort;
  const readFileState = input.context.readFileState;
  if (!fileSystemPort || !readFileState) return;

  const sources = collectBashReadFileSources(input.command).filter(
    // grep 这类要求 exit 0 的来源，命令失败时说明没有匹配行被读到，不能算已读。
    (source) => !source.requiresExitZero || input.result.exitCode === 0,
  );
  if (sources.length === 0) return;

  const trace = createBashReadFileStateTrace(input.context);
  await Promise.all(
    sources.map(async (source) => {
      const resolvedPath = resolveWorkspacePath({
        inputPath: source.filePath,
        operation: "read",
        workingDirectory: input.context.workingDirectory,
        workspaceRoot: input.context.workspaceRoot,
      });
      if (findLatestReadFileState(readFileState, resolvedPath)) return;

      try {
        const stat = await fileSystemPort.stat(
          { path: resolvedPath, trace },
          { signal: input.context.abortSignal },
        );
        if (stat.kind !== "file") return;
        if (stat.sizeBytes > MAX_BASH_READ_STATE_FILE_BYTES) return;
        if (input.context.abortSignal.aborted) return;

        const read = await fileSystemPort.readTextFile(
          {
            path: resolvedPath,
            maxBytes: MAX_BASH_READ_STATE_FILE_BYTES,
            trace,
          },
          { signal: input.context.abortSignal },
        );
        if (read.truncated) return;
        const selected = selectReadContent(read.content, source);
        if (!selected) return;

        const entry: ReadFileStateEntry = {
          path: resolvedPath,
          content: selected.content,

          // (offset ?? 1) <= 1 && limit === undefined；grep/cat 这类整文件
          // Bash 回填保持 offset undefined，但显式 offset=1 的 Read 也仍算整文件读。
          offset: selected.offset,
          limit: selected.limit,
          isPartialView: false,
          readAt: new Date(),
          revisionId: read.revision?.id ?? stat.revision?.id,
          mtimeMs: normalizeReadFileStateMtimeMs(
            read.revision?.mtimeMs ?? stat.revision?.mtimeMs ?? stat.mtimeMs,
          ),
          sizeBytes: read.revision?.sizeBytes ?? stat.revision?.sizeBytes ?? stat.sizeBytes,
        };
        readFileState.set(
          createReadFileStateKey(resolvedPath, selected.offset ?? 1, selected.limit),
          entry,
        );
      } catch {
        // Bash 已经返回，read-state 回填失败不能改变 Bash 结果。
      }
    }),
  );
}

// 带 backgroundTaskId 的任务没有完整正文。
// isImage 为真不代表文本已读。
// interrupted 与 isBashProviderErrorStatus() 同样跳过。
function shouldSkipBashReadFileStateEffects(output: BashOutput): boolean {
  // provider 错误应在 stale/backfill 前返回，避免失败结果污染 read-state。
  return (
    output.backgroundTaskId !== undefined ||
    output.isImage === true ||
    output.interrupted === true ||
    isBashProviderErrorStatus(output)
  );
}

function currentStatMtimeMs(stat: FileSystemStatResult): number | undefined {
  return normalizeReadFileStateMtimeMs(stat.revision?.mtimeMs ?? stat.mtimeMs);
}

function formatStaleReadFileStateHint(paths: string[], workingDirectory: string): string {
  // 最多展示 5 个路径，其余折叠成 "and N more"，避免提示本身挤占模型上下文。
  const displayPaths = paths
    .slice(0, MAX_STALE_HINT_DISPLAY_PATHS)
    .map((path) => relative(workingDirectory, path) || path);
  const hiddenCount = paths.length - MAX_STALE_HINT_DISPLAY_PATHS;
  const hiddenSuffix = hiddenCount > 0 ? ` and ${hiddenCount} more` : "";
  const fileWord = paths.length === 1 ? "file" : "files";
  return `[This command modified ${paths.length} ${fileWord} you've previously read: ${displayPaths.join(", ")}${hiddenSuffix}. Call Read before editing.]`;
}

function createBashReadFileStateTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
