// INV-01 缺少端口即配置错误：守住位置 端口判断；改错故障 搜索静默返回空结果。
// INV-02 路径先走工作区校验：守住位置 路径解析；改错故障 越界读取仓外文件。
// INV-03 缺省路径用工具工作目录：守住位置 三元分支；改错故障 相对路径落到进程目录。
// INV-04 上下文短选项可覆盖统一值：守住位置 空值合并；改错故障 上下文参数被忽略。
// INV-05 取消转可恢复错误：守住位置 错误码判断；改错故障 用户中断被记成工具失败。
// INV-06 其余错误原样上抛：守住位置 末尾抛出；改错故障 根因被包装丢失。
// INV-07 三种输出互斥：守住位置 模式分支；改错故障 列表与正文同时回填。
// INV-08 文件列表仅在路径模式：守住位置 条件赋值；改错故障 内容模式重复列出文件。
// INV-09 计数模式按路径聚合：守住位置 模板拼接；改错故障 计数行缺少文件前缀。
// INV-10 行号默认开启：守住位置 空值合并；改错故障 内容模式默认没有行号。
// INV-11 展示路径优先相对：守住位置 相对判断；改错故障 结果里全是绝对路径。
// INV-12 路径分隔符统一斜杠：守住位置 替换调用；改错故障 Windows 结果链接失效。
// INV-13 截断不视为失败：守住位置 字段透传；改错故障 分页信息丢失。
// INV-14 超时不可被调用覆盖：守住位置 覆盖标志；改错故障 全仓扫描被拉长。
// INV-15 大结果落盘只预览头部：守住位置 预算配置；改错故障 模型上下文被撑爆。
// INV-16 权限为只读且免审批：守住位置 描述字段；改错故障 每次搜索都要确认。
// INV-17 文案按模式分别组装：守住位置 格式化函数；改错故障 空结果显示错误提示。
// INV-18 复数按数量选择：守住位置 辅助函数；改错故障 一条结果写成复数。
//
// 模块职责：Grep 工具的输入归一、端口调用与模型可见文案。
// 状态所有权：无状态，文件系统能力由上下文注入。
// 阅读顺序：先看参数与路径，再看端口调用与输出组装，最后看工具元数据与文案。
// ============================================================
// Grep Tool Handler
// ============================================================
//
// 【工具语义】内容搜索，底层是 ripgrep 兼容实现（由 FileSystemPort 承担，本文件不 spawn
//   进程）。刻意引导模型优先用它而不是 Bash 的 grep/rg：结果能进权限 UI 与文件链接。
//
// 【输入口径】pattern 是 ripgrep 正则（不是 grep BRE，字面量花括号要转义）；glob/type 过滤；
//   output_mode 三选一：content（匹配行）/ files_with_matches（默认，仅路径）/ count；
//   还支持 -A/-B/-C 上下文、-n 行号、-i 忽略大小写、-o 仅匹配段、multiline、head_limit/offset
//   分页。path 缺省用当前工作目录，显式路径经 path-policy 做 workspace 边界校验。
//
// 【副作用/权限】只读、并发安全、无审批、sideEffectScope=none。端口缺席是 ConfigurationError。
//
// 【失败语义】FileSystemPort 的 cancelled 被翻译成 ToolCancelled（可恢复），其余错误原样上抛；
//   截断不失败，但 truncated/appliedLimit/appliedOffset 会进入模型可见文案。
// ============================================================

import { isAbsolute, relative, sep } from "node:path";
import {
  CoreErrorType,
  GrepInputJsonSchema,
  GrepInputSchema,
  GrepOutputJsonSchema,
  GrepOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type FileSystemSearchTextEntry,
  type FileSystemSearchTextResult,
  type GrepInput,
  type GrepOutput,
  type TraceContext,
} from "@zcode/contracts";
import { resolveToolWorkingDirectory, resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_GREP_MODEL_BYTES = 20_000;
const DEFAULT_GREP_TIMEOUT_MS = 30_000;
const GREP_TOOL_DESCRIPTION = `Content search built on ripgrep. Prefer this over \`grep\`/\`rg\` via Bash — results integrate with the permission UI and file links.

- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Ripgrep, not grep — escape literal braces (\`interface\\{\\}\`).
- Filter with \`glob\` (e.g. "**/*.tsx") or \`type\` (e.g. "js", "py", "rust").
- \`output_mode\`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".
- \`multiline: true\` for patterns that span lines.`;

// 入参先过 GrepInputSchema；端口缺席直接抛 ConfigurationError，路径统一由 path-policy 做 workspace 边界校验。
export const grepHandler: ToolHandler = async (input, context) => {
  const parsed = GrepInputSchema.parse(input) as GrepInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Grep tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Grep",
        },
        recoverable: false,
      },
    );
  }

  // 端口只看到展开后的数值：-A/-B/-C 已在上段合并；trace 与 abortSignal 原样下传，取消不在这里翻译。
  const searchPath = parsed.path
    ? resolveWorkspacePath({
        inputPath: parsed.path,
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      })
    : resolveToolWorkingDirectory(undefined, {
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

  // 同时接受语义字段 context 与 ripgrep 风格短选项 -C；-A/-B 各自可覆盖统一上下文，
  // 这层映射只发生在 handler，FileSystemPort 永远看到展开后的具体数值。
  const contextLines = parsed.context ?? parsed["-C"];
  let result: FileSystemSearchTextResult;
  try {
    result = await fileSystemPort.searchText(
      {
        path: searchPath,
        pattern: parsed.pattern,
        glob: parsed.glob,
        outputMode: parsed.output_mode,
        beforeContext: parsed["-B"] ?? contextLines,
        afterContext: parsed["-A"] ?? contextLines,
        context: contextLines,
        showLineNumbers: parsed["-n"],
        onlyMatching: parsed["-o"],
        ignoreCase: parsed["-i"],
        type: parsed.type,
        headLimit: parsed.head_limit,
        offset: parsed.offset,
        multiline: parsed.multiline,
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
  } catch (error) {
    // 取消是"用户/回合终止"而不是搜索失败：保留 cause，转成可恢复的 ToolCancelled，
    // 让上层按取消收口而不是记成一次工具失败。
    if (isFileSystemPortError(error) && error.code === "cancelled") {
      throw createCoreError(CoreErrorType.ToolCancelled, "Grep was cancelled", {
        cause: error,
        context: {
          path: searchPath,
          toolCallId: context.toolCallId,
          toolName: "Grep",
        },
        recoverable: true,
      });
    }
    throw error;
  }

  const filenames = result.files.map((filePath) =>
    toDisplayPath(filePath, context.workingDirectory),
  );
  const showLineNumbers = parsed["-n"] ?? true;

  // output 是三种模式共用的壳；多填一份会让模型同时看到文件名与正文，权限 UI 也按 mode 分支取值。
  const output: GrepOutput = {
    mode: result.mode,
    durationMs: result.durationMs,
    numFiles: filenames.length,
    filenames: result.mode === "files_with_matches" ? filenames : [],
    truncated: result.truncated,
    appliedLimit: result.appliedLimit,
    appliedOffset: result.appliedOffset,
  };

  // 三种 mode 的输出形态互斥：只有 files_with_matches 回 filenames；content/count 把条目
  // 拼成文本（count 是 "path:count" 逐行）。numMatches 在三种模式下都回填，供文案统计。
  if (result.mode === "content") {
    output.content = result.entries
      .map((entry) => formatContentEntry(entry, context.workingDirectory, showLineNumbers))
      .join("\n");
    output.numLines = result.entries.length;
    output.numMatches = result.numMatches;
  } else if (result.mode === "count") {
    output.content = result.entries
      .map((entry) => `${toDisplayPath(entry.path, context.workingDirectory)}:${entry.count ?? 0}`)
      .join("\n");
    output.numMatches = result.numMatches;
  } else {
    output.numMatches = result.numMatches;
  }

  return output;
};

/**
 * 入口口径：readOnly/concurrentSafe 为真、needsApproval 为假（只搜内容）；
 * timeout 固定 30s 且不允许调用覆盖（避免模型用超时把全仓扫描拖长）；
 * resultBudget 走 artifact + head 预览：大结果落盘，模型只看到 20KB 头部加分页信息。
 * patternSources 同时取 path 与 input：规则可按搜索目录或 pattern 前缀限定。
 */
export const grepToolEntry: ToolEntry = {
  capability: "Search file contents with ripgrep-compatible regular expressions",
  metadata: {
    name: "Grep",
    description: GREP_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_GREP_TIMEOUT_MS,
    maxOutputBytes: MAX_GREP_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: grepHandler,
  inputSchema: GrepInputJsonSchema,
  outputSchema: GrepOutputJsonSchema,
  runtimeInputSchema: GrepInputSchema,
  runtimeOutputSchema: GrepOutputSchema,
  formatModelContent: formatGrepModelContent,
  permission: {
    permission: "read",
    reason: "Grep only searches file contents and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path", "input"],
    alwaysAllowPatternSources: ["path", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_GREP_MODEL_BYTES,
    maxModelBytes: MAX_GREP_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_GREP_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: DEFAULT_GREP_TIMEOUT_MS,
    maxMs: DEFAULT_GREP_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Grep was cancelled before search results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatGrepModelContent(output: unknown): string {
  const result = output as GrepOutput;
  const mode = result.mode ?? "files_with_matches";
  const limitInfo = formatLimitInfo(result.appliedLimit, result.appliedOffset);

  if (mode === "content") {
    const content = result.content || "No matches found";
    return limitInfo ? `${content}\n\n[Showing results with pagination = ${limitInfo}]` : content;
  }

  if (mode === "count") {
    const content = result.content || "No matches found";
    const matches = result.numMatches ?? 0;
    const files = result.numFiles ?? 0;
    const summary = `Found ${matches} total ${plural(matches, "occurrence")} across ${files} ${plural(files, "file")}.`;
    return `${content}\n\n${summary}${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
  }

  const filenames = result.filenames ?? [];
  const fileCount = result.numFiles ?? filenames.length;
  if (fileCount === 0) return "No files found";

  return `Found ${fileCount} ${plural(fileCount, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${filenames.join("\n")}`;
}

function formatLimitInfo(appliedLimit?: number, appliedOffset?: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset !== undefined) parts.push(`offset: ${appliedOffset}`);
  return parts.join(", ");
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function formatContentEntry(
  entry: FileSystemSearchTextEntry,
  workingDirectory: string,
  showLineNumbers: boolean,
): string {
  const path = toDisplayPath(entry.path, workingDirectory);
  if (showLineNumbers && entry.lineNumber !== undefined) {
    return `${path}:${entry.lineNumber}:${entry.text ?? ""}`;
  }
  return `${path}:${entry.text ?? ""}`;
}

function toDisplayPath(filePath: string, workingDirectory: string): string {
  const relativePath = relative(workingDirectory, filePath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath.split(sep).join("/");
  }
  return filePath;
}
