// ============================================================
// Glob Tool Handler
// ============================================================
//
// 【工具语义】按 glob 模式列文件路径，不读文件内容。pattern 由 FileSystemPort 解释（不在此
//   展开），path 缺省时用当前工作目录；两者都经 path-policy 做 workspace 越界校验。
//
// 【输入口径】pattern（如 "**/*.ts"）、path（可选目录）。结果按 mtime 排序，最多
//   MAX_GLOB_RESULTS=100 条；超出时 truncated=true，由 formatModelContent 追加"请缩小范围"
//   的提示——截断不失败，但模型必须知道结果不完整。
//
// 【副作用/权限】只读、并发安全、无审批；sideEffectScope=none。端口缺席抛
//   ConfigurationError（接线故障，不是业务失败）。
//
// 【失败语义】searchFiles 的错误原样上抛（路径不存在/权限）；abortSignal 透传，取消即中断。
// ============================================================

import { isAbsolute, relative, sep } from "node:path";
import {
  CoreErrorType,
  GlobInputJsonSchema,
  GlobInputSchema,
  GlobOutputJsonSchema,
  GlobOutputSchema,
  createCoreError,
  type GlobInput,
  type GlobOutput,
  type TraceContext,
} from "@zcode/contracts";
import { resolveToolWorkingDirectory, resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_GLOB_RESULTS = 100;
const MAX_GLOB_MODEL_BYTES = 100_000;
const GLOB_TOOL_DESCRIPTION =
  'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.';

export const globHandler: ToolHandler = async (input, context) => {
  const { pattern, path } = GlobInputSchema.parse(input) as GlobInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Glob tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Glob",
        },
        recoverable: false,
      },
    );
  }

  // path 显式给出时按"读操作"做 workspace 边界校验；缺省则退回当前工作目录。
  // 两种都经过 path-policy，避免 ../ 逃逸到工作区之外。
  const searchPath = path
    ? resolveWorkspacePath({
        inputPath: path,
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      })
    : resolveToolWorkingDirectory(undefined, {
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

  const result = await fileSystemPort.searchFiles(
    {
      path: searchPath,
      pattern,
      maxResults: MAX_GLOB_RESULTS,
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      } as unknown as TraceContext,
    },
    { signal: context.abortSignal },
  );

  const filenames = result.files.map((filePath) =>
    toDisplayPath(filePath, context.workingDirectory),
  );

  return {
    durationMs: result.durationMs,
    numFiles: filenames.length,
    filenames,
    truncated: result.truncated,
  } satisfies GlobOutput;
};

/**
 * 入口口径：readOnly/concurrentSafe 为真、needsApproval 为假（只列路径）；
 * 超时 30s 且 allowCallOverride=false（搜索是本地快速操作，不允许模型拉长）；
 * resultBudget 走 artifact + head 预览：命中多时把完整列表落盘，模型只看到前 100KB。
 */
export const globToolEntry: ToolEntry = {
  capability: "Find files by glob pattern through the file-system adapter without reading file contents",
  metadata: {
    name: "Glob",
    description: GLOB_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GLOB_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: globHandler,
  inputSchema: GlobInputJsonSchema,
  outputSchema: GlobOutputJsonSchema,
  runtimeInputSchema: GlobInputSchema,
  runtimeOutputSchema: GlobOutputSchema,
  formatModelContent: formatGlobModelContent,
  permission: {
    permission: "read",
    reason: "Glob only lists file paths and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path", "input"],
    alwaysAllowPatternSources: ["path", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_GLOB_MODEL_BYTES,
    maxModelBytes: MAX_GLOB_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_GLOB_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Glob was cancelled before file matches were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatGlobModelContent(output: unknown): string {
  const result = output as GlobOutput;
  const filenames = result.filenames ?? [];
  if (filenames.length === 0) return "No files found";

  const lines = [...filenames];
  if (result.truncated) {
    lines.push("(Results are truncated. Consider using a more specific path or pattern.)");
  }
  return lines.join("\n");
}

function toDisplayPath(filePath: string, workingDirectory: string): string {
  const relativePath = relative(workingDirectory, filePath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath.split(sep).join("/");
  }
  return filePath;
}
