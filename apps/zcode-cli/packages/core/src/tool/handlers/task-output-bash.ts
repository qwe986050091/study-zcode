// ============================================================
// Bash 任务输出投影
// ============================================================
// 定位：TaskOutput 对 `local_bash` 任务的专用投影，把 runtime 的任务句柄 + 执行端口快照
// 还原成模型可读的 `TaskOutputTask`。projectTask（task-output-projection.ts）按 task.type
// 分派到这里。
// 数据源优先级：executionPort.getBackgroundTask 的实时快照 > 仅凭 runtime registry 的
// outputFile。前者能拿到 exitCode、stdout/stderr 分路与 artifact 路径；后者只能读单文件。
// 失败/降级：读文件失败一律降级到快照里的内存 tail，绝不抛错——任务已经跑完，输出投影
// 失败不应把一次成功的 TaskOutput 变成工具失败。取消则例外：AbortError 原样上抛。
// 不变量：运行中的任务只读文件**头部**（避免与持续追加的写入者竞争，也避免把不断变长的
// 文件读成不一致的片段）；终态读尾部的 8MB，保证模型看到"最后发生了什么"。

import { open } from "node:fs/promises";
import type { BackgroundExecutionSnapshot, TaskOutputTask } from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { ToolExecutionContext } from "../types.js";

export interface ProjectBashTaskOptions {
  /** 终态任务的通用读文件实现（尾部快照 + omitted 提示）；path 可能 undefined。 */
  readOutputFile: (path: string | undefined) => Promise<TaskOutputFileRead>;
  /** 运行中任务改读头部，单位字节；由调用方给出（当前 30000），便于上层统一预算。 */
  runningOutputPrefixBytes: number;
}

export interface TaskOutputFileRead {
  /** false = 文件不存在/读失败/无路径；调用方据此回退到内存 tail，而不是报错。 */
  available: boolean;
  content: string;
  /** 磁盘上是否还有未读部分；只描述事实，投影层目前不据此改写文本。 */
  truncated: boolean;
}

interface BashOutputPart {
  content: string;
  /** 仅当内容确实来自该文件时保留；内存 fallback 没有可回指的路径。 */
  path?: string;
}

/**
 * 把一条 bash 任务（含其执行快照）投影成 TaskOutputTask。
 *
 * 输入：runtime 任务快照 + 工具上下文（用 executionPort 取实时后台快照）。
 * 输出：task_id/type/status/description/output/exitCode，以及在确有可读文件时附 outputFile。
 * 副作用：读输出文件（只读）；无 durable 写入。
 * 降级：拿不到 executionPort 快照时走 `projectFallbackTaskFile`——只读 registry 记的
 *   outputFile，读不到就给空串，不抛错。
 * 字段口径：exitCode 取 snapshot.result.exitCode → task.exitCode → null，前者是执行端
 *   的最终事实，后者可能只是登记时的占位。
 */
export async function projectBashTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
  options: ProjectBashTaskOptions,
): Promise<TaskOutputTask> {
  const snapshot = await context.executionPort?.getBackgroundTask?.(task.taskId);
  const projected = snapshot
    ? await projectBashSnapshot(snapshot, task, context, options)
    : await projectFallbackTaskFile(task.outputFile, options);

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output: projected.output,
    exitCode: snapshot?.result?.exitCode ?? task.exitCode ?? null,
    ...(projected.outputFile ? { outputFile: projected.outputFile } : {}),
  };
}

/**
 * 有执行快照时的完整投影。
 *
 * stdout 路径优先级刻意排成 outputPath → task.outputFile → stdoutPersistedOutputPath →
 *   result.stdout.artifactPath：前两者是"本次执行正在写的那个文件"，后两者是终态归档位置；
 *   运行中必须优先认前者，否则会去读一个还没写完整的归档。
 * stderr 与 stdout 同路径时不再重读（`{content:"", path}`）：重叠内容已经包含在 stdout 里，
 *   重复拼接会把同一段错误打印两遍。
 * `outputFile` 只在"恰好一个可回指的文件承载了输出"时给出，避免给模型一个读不到全量的路径。
 */
async function projectBashSnapshot(
  snapshot: BackgroundExecutionSnapshot,
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
  options: ProjectBashTaskOptions,
): Promise<{ output: string; outputFile?: string }> {
  const stdoutPath =
    snapshot.outputPath ??
    task.outputFile ??
    snapshot.stdoutPersistedOutputPath ??
    snapshot.result?.stdout.artifactPath;
  const stderrPath = snapshot.stderrPersistedOutputPath ?? snapshot.result?.stderr.artifactPath;
  const readOutputFile =
    task.status === "running"
      ? (path: string | undefined) =>
          readRunningBashOutputFile(path, context, options.runningOutputPrefixBytes)
      : options.readOutputFile;

  const stdout = await readBashOutputPart(
    stdoutPath,
    snapshot.result?.stdout.text ?? snapshot.stdoutTail ?? "",
    readOutputFile,
  );
  const stderr =
    stderrPath && stderrPath === stdout.path
      ? { content: "", path: stderrPath }
      : await readBashOutputPart(
          stderrPath,
          snapshot.result?.stderr.text ?? snapshot.stderrTail ?? "",
          readOutputFile,
        );

  const output = [stdout.content, stderr.content].filter((part) => part.length > 0).join("\n");
  const outputFile =
    stdout.path && (!stderr.content || stderr.path === stdout.path)
      ? stdout.path
      : !stdout.content && stderr.path
        ? stderr.path
        : undefined;

  return {
    output,
    ...(outputFile ? { outputFile } : {}),
  };
}

/**
 * 读一路输出（stdout 或 stderr）：读得到就用磁盘内容并记下 path；读不到回退到快照里的
 * 内存 tail（`result.text` / `*Tail`）。回退时**丢掉 path**——那份内存内容并不来自该文件，
 * 保留路径会让模型以为可以再读全文。
 */
async function readBashOutputPart(
  path: string | undefined,
  fallback: string,
  readOutputFile: ProjectBashTaskOptions["readOutputFile"],
): Promise<BashOutputPart> {
  const read = await readOutputFile(path);
  if (read.available) {
    return {
      content: read.content,
      ...(path ? { path } : {}),
    };
  }
  return { content: fallback };
}

/**
 * 无执行快照时的兜底：只认 registry 上的 outputFile。`available=false` 时仍然返回空串，
 * 且**不**附 outputFile——给模型一个指向不存在文件的路径，比不给路径更容易误导。
 */
async function projectFallbackTaskFile(
  outputFile: string | undefined,
  options: ProjectBashTaskOptions,
): Promise<{ output: string; outputFile?: string }> {
  const read = await options.readOutputFile(outputFile);
  return {
    output: read.content,
    ...(outputFile && read.available ? { outputFile } : {}),
  };
}

/**
 * 运行中任务的头部读取。
 *
 * 为什么读头部而不是尾部：文件仍在追加，尾部是"最新但可能正在变"的内容；TaskOutput 的
 *   字符预算会再做一次裁剪，这里固定读 30KB 前缀即可，不追求完整。
 * 取消语义：读前后各检查一次 abort；外层取消时必须抛 AbortError，不能被下面的
 *   "读失败即降级"吞掉——否则一个已取消的 tool_call 会拿到一份看似正常的输出。
 * 降级：除取消外的任何错误（ENOENT/EACCES/句柄失效）都返回 available=false，由调用方
 *   回退到内存 tail。
 */
async function readRunningBashOutputFile(
  outputFile: string | undefined,
  context: ToolExecutionContext,
  maxBytes: number,
): Promise<TaskOutputFileRead> {
  // 运行中 Bash 复用通用 8 MiB 尾读后，模型会看到输出末尾；
  // 这里固定读取文件头部 30000 bytes，再交给 TaskOutput 应用最终字符预算。
  if (!outputFile) {
    return { available: false, content: "", truncated: false };
  }

  try {
    throwIfAborted(context.abortSignal);
    const handle = await open(outputFile, "r");
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, maxBytes);
      if (bytesToRead === 0) {
        return { available: true, content: "", truncated: false };
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const read = await handle.read(buffer, bytesRead, bytesToRead - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      throwIfAborted(context.abortSignal);

      return {
        available: true,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: stat.size > bytesRead,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (context.abortSignal.aborted) throwIfAborted(context.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { available: false, content: "", truncated: false };
  }
}

// 统一的取消检查点。用 DOMException + name="AbortError"，与 fetch/fs 的取消错误形状一致，
// 让上层 call-runner 能按错误类型（而不是文本）区分"取消"与"读失败"。
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("Task output wait aborted", "AbortError");
}
