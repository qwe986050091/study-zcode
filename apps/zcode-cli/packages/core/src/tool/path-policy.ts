// ============================================================
// Tool Path Policy
// ============================================================

import { isAbsolute, normalize, resolve } from "node:path";
import { CoreErrorType, createCoreError } from "@zcode/contracts";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: "read" | "write" | "execute";
}

/**
 * 把工具入参路径解析成绝对路径，供后续文件操作使用。
 * 输入：inputPath 可为相对/绝对；workingDirectory 必须绝对；workspaceRoot 必须绝对。
 * 输出：绝对路径（相对路径基于 workingDirectory 解析，不做 realpath）。
 * 失败语义：inputPath 为空抛 recoverable 的 ToolExecutionFailed（模型可改写重试）；
 * 工作区目录配置非绝对抛不可恢复的 ConfigurationError（属于启动配置错误）。
 * 副作用：无 I/O；不校验目标是否存在。
 */
export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    // 空路径属于模型入参错误：recoverable=true 让上层可以要求模型重新给路径，
    // 而不是把整个 turn 归因为不可恢复的基础设施故障。
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  // Current release intentionally does not hard-block paths outside workspaceRoot.
  // Cause: subagents may need to inspect user-requested sibling repos or external files
  // before the filesystem permission adapter grows explicit ask/deny rules for them.
  // 中文口径：本函数只做“绝对化 + 规范化”，不做工作区边界拦截，也不解析符号链接；
  // 越界访问的最终裁决在权限/sandbox 适配器。workspaceRoot 仅用于配置合法性校验。
  return resolvedPath;
}

/**
 * 解析 Bash/Glob/Grep 等工具的工作目录。
 * 输入：inputCwd 可 undefined（未指定）；options 提供执行默认 cwd 与工作区根。
 * 输出：未指定时返回规范化后的默认 workingDirectory；指定时按 resolveWorkspacePath
 * 的同一口径解析（相对路径基于默认 workingDirectory，而不是 workspaceRoot）。
 * 注意：空字符串与 undefined 一样走默认 cwd（`!inputCwd` 判定），不会触发空路径错误。
 * 失败语义：默认目录或工作区根非绝对时抛 ConfigurationError；无 I/O。
 */
export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

/** 校验并规范化一个“必须是绝对路径”的目录配置；否则抛不可恢复的 ConfigurationError。 */
function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
