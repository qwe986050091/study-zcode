// task-output.ts 顶到 oxlint max-lines 上限（400 行），把任务投影
// （projectTask 及 dwf / agent 分支）、输出文件尾部快照读取和紧凑文件大小格式化拆到本文件；
// 公开面仍从 task-output.ts 导出。
import { open } from "node:fs/promises";
import type { TaskOutputTask } from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { ToolExecutionContext } from "../types.js";
import { projectBashTask } from "./task-output-bash.js";

const TASK_OUTPUT_FILE_TAIL_BYTES = 8 * 1024 * 1024;
const TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES = 30_000;

/**
 * 把字节数格式化成紧凑的人类可读串（bytes / KB / MB / GB，保留一位小数并去掉 .0）。
 *
 * 只用于 persisted 结果的信封（"全量多大、存在哪里"），不参与预算计算；输入是字节，
 * 输出是不带空格的短标签。非有限值会被 toFixed 抛 RangeError——调用方只在真实文件大小时
 * 使用，不在这里额外兜底。
 */
export function formatCompactFileSize(size: number): string {
  const kilobytes = size / 1024;
  if (kilobytes < 1) return `${size} bytes`;
  if (kilobytes < 1024) return `${trimSingleDecimal(kilobytes)}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${trimSingleDecimal(megabytes)}MB`;
  return `${trimSingleDecimal(megabytes / 1024)}GB`;
}

function trimSingleDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * 按 task.type 分派投影：
 *   - local_bash → projectBashTask（执行端口快照优先，运行中只读头部）；
 *   - local_agent → projectAgentTask（优先取完整消息结果，磁盘文件兜底）；
 *   - local_dynamic_workflow → projectDynamicWorkflowTask（优先 resultText）；
 *   - 其它类型 → 只读 outputFile 的最简形状。
 * 输出统一为 TaskOutputTask；任何读文件失败都降级为空串，不抛错（取消除外）。
 */
export async function projectTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  if (task.type === "local_bash") {
    return projectBashTask(task, context, {
      readOutputFile: (outputFile) => readTaskOutputFileSnapshot(outputFile, context),
      runningOutputPrefixBytes: TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES,
    });
  }
  if (task.type === "local_agent") {
    return projectAgentTask(task, context);
  }
  if (task.type === "local_dynamic_workflow") {
    return projectDynamicWorkflowTask(task, context);
  }

  const output = await readTaskOutputFile(task.outputFile, context);
  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  };
}

/**
 * workflow run 的投影优先读取终态更新时写入的 resultText；只读 outputFile 可能遗漏结果。
 * 文件读取保留为回退，返回形状与 {@link projectAgentTask} 一致。
 */
async function projectDynamicWorkflowTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  const outputFile = task.outputFile;
  const output = task.resultText ?? (await readTaskOutputFile(outputFile, context));

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(outputFile ? { outputFile } : {}),
    ...(task.resultText === undefined ? {} : { result: task.resultText }),
    ...(task.error ? { error: task.error } : {}),
  };
}

/**
 * agent 任务的投影。
 *
 * 输出优先取 `task.output.status === "completed"` 时的结构化 content（把各块 text 拼起来）：
 * 那是子代理真正产出的完整结果；磁盘文件只是流式落盘的副本，可能不完整或尚未 flush。
 * `cleanResult || diskOutput` 用真值兜底，空字符串也会回退到磁盘——空结果不等于"没有输出"。
 * 附带 prompt（子代理收到的指令）便于模型理解上下文；`result` 与 output 同值，供 V4 投影
 * 直接读取。
 */
async function projectAgentTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  const outputFile = task.outputFile;
  const diskOutput = await readTaskOutputFile(outputFile, context);
  const completedOutput = task.output?.status === "completed" ? task.output : undefined;
  const cleanResult = completedOutput?.content.map((block) => block.text).join("\n");
  const output = cleanResult || diskOutput;

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(outputFile ? { outputFile } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(output ? { result: output } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

// 读文件并只取 content 的便捷包装：调用方不关心 available/truncated 时用它。
async function readTaskOutputFile(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<string> {
  return (await readTaskOutputFileSnapshot(outputFile, context)).content;
}

/**
 * 读取任务输出文件的**尾部**快照（最多 8MB）。
 *
 * 为什么读尾部：任务输出通常"结论在最后"，而 8MB 是防止一次 TaskOutput 把整个日志读进
 *   进程内存的上界；超出部分在文本前加一行"[NKB of earlier output omitted]"，让模型知道
 *   前面还有内容，而不是误以为这就是全部。
 * `omittedBytes` 用实际读到的字节算（而非 stat.size - 试图读取量），避免短读/并发截断时
 *   报出一个夸大的遗漏量。
 * 取消：读前读后各检查一次；AbortError 必须重新抛出，不能被"读失败即降级"吞掉。
 * 降级：路径缺失/文件不存在/权限不足 → `{available:false, content:""}`，不抛错。
 */
async function readTaskOutputFileSnapshot(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<{ available: boolean; content: string; truncated: boolean }> {
  if (!outputFile) {
    return { available: false, content: "", truncated: false };
  }

  try {
    throwIfAborted(context.abortSignal);
    const handle = await open(outputFile, "r");
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, TASK_OUTPUT_FILE_TAIL_BYTES);
      if (bytesToRead === 0) {
        return { available: true, content: "", truncated: false };
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const start = stat.size - bytesToRead;
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const read = await handle.read(
          buffer,
          bytesRead,
          bytesToRead - bytesRead,
          start + bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      throwIfAborted(context.abortSignal);

      const omittedBytes = stat.size - bytesRead;
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        available: true,
        content:
          omittedBytes > 0
            ? `[${Math.round(omittedBytes / 1024)}KB of earlier output omitted]\n${content}`
            : content,
        truncated: omittedBytes > 0,
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

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("Task output wait aborted", "AbortError");
}
