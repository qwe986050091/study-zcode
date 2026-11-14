import type { PluginDiagnosticCode } from "@zcode/contracts";

/*
 * ============================================================
 * plugins / source-errors.ts —— 插件源错误构造与敏感信息脱敏
 *
 * 定位：把下载/git/zip 失败包装成带稳定 diagnosticCode 的错误，并在诊断文案生成边界
 * 统一清除 URL userinfo 里的凭据（持久化后会投影到 UI/日志/截图）。
 *
 * 输入输出：工厂返回 PluginSourceMaterializationError；redactPluginSource 返回脱敏后的源。
 * 副作用：无（纯函数，不读写文件/网络）。
 * 失败语义：脱敏本身从不抛错：URL 解析失败分支用正则兜底或原样返回。
 * 不变量：任何进入诊断文本的用户名/密码都必须被替换，凭据永远不回显。
 * ============================================================
 */

export class PluginSourceMaterializationError extends Error {
  /** 稳定诊断码，调用方据此做 UI 映射，不解析 message。 */
  readonly diagnosticCode: PluginDiagnosticCode;

  constructor(diagnosticCode: PluginDiagnosticCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginSourceMaterializationError";
    this.diagnosticCode = diagnosticCode;
  }
}

/**
 * 构造“系统 Git 不可用”错误；源与 reason 都先脱敏，避免把带凭据 URL 写进持久化诊断。
 * diagnosticCode 固定为 plugin_git_unavailable。
 */
export function createGitUnavailableError(source: string, reason?: string): Error {
  const safeSource = redactPluginSource(source);
  const reasonSuffix = reason ? ` (${redactPluginDiagnosticText(reason)})` : "";
  return new PluginSourceMaterializationError(
    "plugin_git_unavailable",
    `System Git is required for plugin source ${safeSource}${reasonSuffix}, but git is unavailable on this Agent Host. Install Git on the Agent Host, or use a public GitHub HTTPS or verified ZIP source.`,
  );
}

/**
 * 构造归档下载失败错误：源与 cause message 双重脱敏，并把 cause 替换为脱敏后的新错误
 * （保留 cause 链但绝不携带原始凭据）。
 */
export function createArchiveFetchError(source: string, cause: unknown): Error {
  const safeSource = redactPluginSource(source);
  const detail = redactPluginDiagnosticText(cause instanceof Error ? cause.message : String(cause));
  const safeCause = cause instanceof Error ? new Error(detail) : undefined;
  return new PluginSourceMaterializationError(
    "plugin_archive_fetch_failed",
    `Failed to materialize public GitHub plugin source archive ${safeSource}: ${detail}`,
    safeCause ? { cause: safeCause } : undefined,
  );
}

/**
 * source materialization 错误现在会被持久化并投影到桌面/Web UI，不能把 URL
 * userinfo 带入状态文件、日志或截图。凭据只在诊断生成边界清理，所有消费者共享同一规则。
 */
export function redactPluginSource(source: string): string {
  const trimmed = source.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    if (/^[^\s:@]+:[^\s@]+@/u.test(trimmed)) return "configured Git source";
    return trimmed;
  }
}

/**
 * 在任意诊断文本中查找 URL / `user:pass@host` 形态并逐处脱敏。
 * 供错误 message 生成时使用，保证嵌套的源地址也不泄漏凭据。
 */
function redactPluginDiagnosticText(text: string): string {
  return text
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>()[\]{}]+/giu, (source) =>
      redactPluginSource(source),
    )
    .replace(/\b[^\s:@]+:[^\s@]+@[^\s]+/gu, "configured Git source");
}

/** 取结构化诊断码；非本类错误返回 undefined（不解析 message 猜测）。 */
export function getPluginSourceDiagnosticCode(error: unknown): PluginDiagnosticCode | undefined {
  return error instanceof PluginSourceMaterializationError ? error.diagnosticCode : undefined;
}

/** 判断是否为 ENOENT（命令/文件不存在），用于把 spawn 失败映射为“git 不可用”。 */
export function isCommandUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
