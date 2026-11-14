// INV-01 结构化内容优先透传：守住位置 数组判断；改错故障 已结构化结果被重复拼文本。
// INV-02 解析失败降级为字符串：守住位置 安全解析结果；改错故障 展示层抛错中断。
// INV-03 provider 错误保持纯文本：守住位置 状态判断；改错故障 错误被包成结构化块。
// INV-04 图片块先于文本：守住位置 顺序判断；改错故障 图片被当作普通输出。
// INV-05 文本段顺序固定：守住位置 数组字面量顺序；改错故障 阅读顺序与因果错位。
// INV-06 空段统一过滤：守住位置 末尾过滤；改错故障 出现连续空行。
// INV-07 持久化路径只回预览：守住位置 专用格式化函数；改错故障 完整输出回流上下文。
// INV-08 预览前确认 schema：守住位置 入口解析；改错故障 非本工具输出被误格式化。
// INV-09 后台状态不附加持久路径：守住位置 三元条件；改错故障 后台任务给出错误文件。
// INV-10 中断必须有错误标记：守住位置 标记追加；改错故障 半截标准错误被当作完整信息。
// INV-11 自动转后台说明原因：守住位置 标志分支；改错故障 用户误以为命令失败。
// INV-12 手动转后台文案精简：守住位置 独立分支；改错故障 重复冗长说明。
// INV-13 字节数优先取持久化大小：守住位置 数值判断；改错故障 预览标称大小偏差。
// INV-14 缺省时回退流字节数：守住位置 兜底表达式；改错故障 大小显示为零。
// INV-15 单文件路径口径唯一：守住位置 取值顺序；改错故障 出现互相矛盾的双路径。
// INV-16 图片需同时满足两项：守住位置 双重判断；改错故障 文本被误渲染成图片。
// INV-17 尺寸单位按量级选择：守住位置 分支阈值；改错故障 大文件显示为天文数字字节。
// INV-18 记录判断不信任入参类型：守住位置 类型守卫；改错故障 数组被当成对象读取。
//
// 模块职责：把 Bash 结果转换成模型可见内容，并在大输出时改为返回预览包络。
// 状态所有权：无状态；输出对象由调用方传入，本模块不改写。
// 阅读顺序：先看两个对外格式化入口，再看文本段拼装，最后看后台、图片与尺寸辅助。
/**
 * 把 BashOutput 转成模型可见的 ModelMessageContent：结构化内容优先，其次 provider 错误文本、
 * 图片 block、普通文本（stdout + stderr + 后台信息 + stale/gh 提示）。
 * 由 bash.ts 在结果返回给模型前调用；大输出持久化后只返回预览包络，避免把完整内容重复塞回上下文。
 * 失败语义：schema 解析不通过时降级成字符串化输出，不抛错。
 */

import {
  BashOutputSchema,
  parseImageDataUrl,
  type BashOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import { formatPersistedOutputEnvelope } from "../result-persistence-format.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";

const MODEL_RESULT_PREVIEW_CHARS = 2_000;
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;
const READ_TOOL_NAME = "Read";

// 入口先解析，解析失败直接降级。
// 结构化内容存在时不再拼装文本。
// provider 错误走独立分支。
// 图片与文本最后二选一。
export function formatBashModelContent(output: unknown): ModelMessageContent {
  const parsed = BashOutputSchema.safeParse(output);
  if (!parsed.success) return stringifyFallback(output);

  const result = parsed.data;
  // 结构化内容由上游生成，直接透传，不再拼接文本段。
  if (Array.isArray(result.structuredContent) && result.structuredContent.length > 0) {
    return result.structuredContent as ModelMessageContent;
  }

  // Bash 失败以结果对象返回；模型可见的错误结果应保持为纯文本。
  if (isBashOutputProviderError(result)) {
    return formatProviderErrorContent(result);
  }

  const imageContent = maybeImageContent(result);
  if (imageContent) return imageContent;

  return formatTextContentForModel(result);
}

// formatPersistedBashModelContent 只预览 serializer 已写入的 content。
// 不能退回普通格式化，否则错误文本被重复追加。
// schema 不匹配时明确返回空。
// 预览参数统一由下沉函数拼装。
export function formatPersistedBashModelContent(input: {
  content: string;
  output: unknown;
  persistedPath: string;
  originalBytes: number;
}): ModelMessageContent | undefined {
  if (!BashOutputSchema.safeParse(input.output).success) return undefined;
  // serializer 已经把完整 Bash provider-visible content 写入 artifact；
  // 这里必须只预览该 content，不能重进普通 formatter 后把 stderr/provider-error 文本完整追加回模型上下文。
  return formatBashPersistedOutputContent({
    content: input.content,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
  });
}

// formatProviderErrorContent 保留退出码与三段输出。
// staleReadFileStateHint 等提示段只在存在时参与拼接。
// 空段经 filter(Boolean) 后不留下分隔空行。
function formatProviderErrorContent(result: BashOutput): string {
  return [
    `Exit code ${result.exitCode}`,
    formatStdoutContentForModel(result),
    formatStderrForModel(result),
    formatBackgroundInfoForModel(result),
    result.staleReadFileStateHint?.trim() ?? "",
    result.ghRateLimitHint?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTextContentForModel(result: BashOutput): string {
  // 顺序固定为 stdout→stderr→后台信息→stale→gh 提示，空段被过滤，保证模型按因果顺序阅读。
  return [
    formatStdoutContentForModel(result),
    formatStderrForModel(result),
    formatBackgroundInfoForModel(result),
    result.staleReadFileStateHint?.trim() ?? "",
    result.ghRateLimitHint?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatStdoutContentForModel(result: BashOutput): string {
  let processedStdout = formatStdoutForModel(result.stdout);
  const persistedOutputPath =
    result.status === "backgrounded"
      ? undefined
      : (result.persistedOutputPath ?? result.rawOutputPath);
  if (persistedOutputPath) {
    processedStdout = formatBashPersistedOutputContent({
      content: processedStdout,
      originalBytes: observedOutputBytes(result),
      persistedPath: persistedOutputPath,
    });
  }
  return processedStdout;
}

function stringifyFallback(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function formatStdoutForModel(stdout: string): string {
  if (!stdout) return "";
  // 去掉开头连续空行与尾部空白，避免模型上下文里出现无意义空白占位。
  return stdout.replace(/^(\s*\n)+/, "").trimEnd();
}

// stderr 先 trim 收敛空白。
// interrupted 时补上明确的 error 标记。
// 有正文时标记前置换行，避免与 stderr 粘连。
function formatStderrForModel(result: BashOutput): string {
  let message = result.stderr.trim();
  // 被中断时补一条明确的 error 标记，否则模型可能把半截 stderr 当成完整失败信息。
  if (result.interrupted) {
    if (message) message += "\n";
    message += "<error>Command was aborted before completion</error>";
  }
  return message;
}

export function isBashOutputProviderError(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return isBashProviderErrorStatus(output);
}

function formatBackgroundInfoForModel(result: BashOutput): string {
  if (!result.backgroundTaskId) return "";
  const outputText = formatBackgroundOutputPaths(result);
  // assistant 自动转后台：说明是超时预算导致，并提醒后续用子 agent/后台参数，避免误以为命令失败。
  if (result.assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${result.backgroundTaskId}. It is still running \u2014 you will be notified when it completes.${outputText} In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
  }
  if (result.backgroundedByUser) {
    // 用户手动转后台时不重复"仍在运行"的长说明，只给 ID 与输出路径。
    return `Command was manually backgrounded by user with ID: ${result.backgroundTaskId}.${stripTrailingPeriod(outputText)}`;
  }
  const readHint = outputText
    ? ` To check interim output, use ${READ_TOOL_NAME} on that file path.`
    : "";
  // 普通后台：明确告知完成时会收到通知，并提示如何查看中间输出。
  return `Command running in background with ID: ${result.backgroundTaskId}.${outputText} You will be notified when it completes.${readHint}`;
}

function formatBackgroundOutputPaths(result: BashOutput): string {
  // Bash 的 stdout/stderr 已直接写入单一输出文件，继续追加 stdout/stderr legacy path
  // 会让模型看到与单一输出文件不一致的双路径信息。
  const outputPath =
    result.rawOutputPath ??
    result.persistedOutputPath ??
    result.stdoutPersistedOutputPath ??
    result.stderrPersistedOutputPath;
  return outputPath ? ` Output is being written to: ${outputPath}.` : "";
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function observedOutputBytes(result: BashOutput): number {
  // 优先用截断前的持久化大小；缺失时退回原始 stream 字节数，保证预览包络的 original size 正确。
  if (typeof result.persistedOutputSize === "number") return result.persistedOutputSize;
  if (
    typeof result.stdoutPersistedOutputSize === "number" ||
    typeof result.stderrPersistedOutputSize === "number"
  ) {
    return (result.stdoutPersistedOutputSize ?? 0) + (result.stderrPersistedOutputSize ?? 0);
  }
  return (
    (result.stdoutBytes ?? Buffer.byteLength(result.stdout, "utf8")) +
    (result.stderrBytes ?? Buffer.byteLength(result.stderr, "utf8"))
  );
}

function formatBashPersistedOutputContent(input: {
  content: string;
  originalBytes: number;
  persistedPath: string;
}): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatBashOutputByteSize,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
    previewChars: MODEL_RESULT_PREVIEW_CHARS,
  });
}

function formatBashOutputByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${trimUnit(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimUnit(mb)}MB`;
  return `${trimUnit(mb / 1024)}GB`;
}

function trimUnit(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function maybeImageContent(result: BashOutput): ModelMessageContent | undefined {
  // 仅 isImage 且 stdout 能解析成 data URL 时转 image block；解析失败则退回普通文本路径。
  if (!result.isImage) return undefined;
  const parsed = parseImageDataUrl(result.stdout, { allowWhitespace: true });
  if (!parsed) return undefined;
  return [
    {
      type: "image",
      mediaType: parsed.mediaType,
      dataUrl: parsed.dataUrl,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
