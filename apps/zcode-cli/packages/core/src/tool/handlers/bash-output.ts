// INV-01 本层只做展示映射：守住位置 toBashOutput 职责；改错故障 命令语义被展示逻辑改写。
// INV-02 provider 错误不识别图片：守住位置 providerError 分支；改错故障 错误输出被当截图展示。
// INV-03 provider 错误不加限流提示：守住位置 三元分支；改错故障 错误文案里的字样误触发提示。
// INV-04 正常路径先剥离提示行：守住位置 stripClaudeCodeHintLines；改错故障 模型看到注入残留。
// INV-05 持久化大小用截断前字节：守住位置 bytes 字段；改错故障 展示值与真实观测不符。
// INV-06 持久化路径优先取标准输出：守住位置 空值合并；改错故障 双流时路径指向错误一侧。
// INV-07 标准错误回退到错误消息：守住位置 逻辑或链；改错故障 失败信息丢失。
// INV-08 工作目录提示追加在尾部：守住位置 appendBashCwdStderrSuffix；改错故障 提示混入正文开头。
// INV-09 超时与取消都标中断：守住位置 interrupted 表达式；改错故障 前端显示为失败而非未完成。
// INV-10 静默命令不提示无输出：守住位置 isSilentBashCommand；改错故障 cd 也被标记为空结果。
// INV-11 图片存在才标记图片：守住位置 isImage 判断；改错故障 空图卡占用界面。
// INV-12 退出码解释随结果下发：守住位置 returnCodeInterpretation；改错故障 前端自行猜测语义。
// INV-13 限流提示只在命中时占字段：守住位置 条件展开；改错故障 空字段污染输出契约。
// INV-14 遥测不记录命令原文：守住位置 只取分类与哈希；改错故障 敏感参数进入遥测。
// INV-15 耗时统一取非负整数：守住位置 roundNonNegativeMs；改错故障 出现负耗时。
// INV-16 首输出耗时缺省回落总耗时：守住位置 noOutputMs；改错故障 指标出现空值断层。
// INV-17 后台任务单独标记状态：守住位置 backgrounded 常量；改错故障 后台命令显示为已完成。
// INV-18 状态映射超时优先于取消：守住位置 判断顺序；改错故障 同时发生时报错归因错误。
//
// 模块职责：把执行结果映射成 BashOutput 契约，并附加图片、提示与遥测。
// 状态所有权：无状态；所有派生值都在单次调用内计算。
// 阅读顺序：先看主映射，再看遥测构造，最后看状态归一。
/**
 * Bash 执行结果 → BashOutput 的组装层：把 ExecutionResult 的 stdout/stderr/退出码/截断/取消状态
 * 映射成工具输出契约，并附加 cwd 提示、图片识别、gh 限流提示与性能遥测。
 * 由 bash.ts 在每次执行结束后调用；这里不改写命令语义，只做展示与元数据映射。
 * 关键口径：provider 级错误不识别图片、不加 gh 提示，避免把错误输出当成正常内容增强。
 */

import {
  type BashInput,
  type BashOutput,
  type ToolCommandStatus,
  type ExecutionResult,
  type ToolExecutionTelemetry,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { appendBashCwdStderrSuffix } from "./bash-cwd-policy.js";
import { getGhRateLimitHint } from "./bash-gh-rate-limit.js";
import { prepareBashImageOutput } from "./bash-image-output.js";
import {
  interpretBashReturnCode,
  isBashProviderErrorStatus,
  isSilentBashCommand,
  stripClaudeCodeHintLines,
} from "./bash-semantics.js";
import {
  attachToolExecutionTelemetry,
  classifyCommand,
  classifySafeCommandIdentity,
  commandHash,
  compactToolExecutionTelemetry,
  roundNonNegativeMs,
} from "./tool-perf.js";

export interface BashProgressTiming {
  firstOutputMs?: number;
}

// stdoutPersistedOutputPath 与 stderrPersistedOutputPath 分别来自两条流。
// persistedOutputPath 先取 stdout，缺失时回退 stderr。
// stderr 为空时 persistOutputSize 只累加 stdout.bytes。
// 图片识别只走正常路径，不读 artifact 截断后的数据。
// 返回前由 createBashPerformanceTelemetry 统一挂遥测。
export async function toBashOutput(
  result: ExecutionResult,
  input: BashInput,
  context: ToolExecutionContext,
  options: { progressTiming?: BashProgressTiming; stderrSuffix?: string } = {},
): Promise<BashOutput> {
  const stdoutPersistedOutputPath = result.stdout.artifactPath;
  const stderrPersistedOutputPath = result.stderr.artifactPath;
  const persistedOutputPath = stdoutPersistedOutputPath ?? stderrPersistedOutputPath;
  const stdoutPersistedOutputSize = result.stdout.artifactBytes;
  const stderrPersistedOutputSize = result.stderr.artifactBytes;
  // artifactBytes 是 64MiB cap 后的实际文件大小，不是模型可见文案中的
  // 原始观测大小。Bash persisted-output 必须使用截断前的 stream bytes。
  const persistedOutputSize = persistedOutputPath
    ? (stdoutPersistedOutputPath ? result.stdout.bytes : 0) +
      (stderrPersistedOutputPath ? result.stderr.bytes : 0)
    : undefined;
  const stderr = appendBashCwdStderrSuffix(
    result.stderr.text || result.error?.message || "",
    options.stderrSuffix,
  );
  const returnCodeInterpretation = interpretBashReturnCode(input.command, result);
  // provider 级错误（如输出超限/内部失败）走纯文本错误路径，不做图片与限流增强。
  const providerError = isBashProviderErrorStatus({
    exitCode: result.exitCode,
    returnCodeInterpretation,
    status: result.status,
  });
  const providerStdout = providerError
    ? result.stdout.text
    // 正常路径先剥离 Claude Code 提示行，避免污染模型可见输出。
    : stripClaudeCodeHintLines(result.stdout.text);
  const imageOutput = providerError
    ? undefined
    : await prepareBashImageOutput(
        {
          artifactPath: stdoutPersistedOutputPath,
          artifactSize: stdoutPersistedOutputSize,
          inline: providerStdout,
        },
        context,
      );
  const stdout = imageOutput?.stdout ?? providerStdout;

  const ghRateLimitHint = providerError
    ? undefined
    // 只有非 provider 错误才检查限流，避免错误消息里的字样误触发提示。
    : getGhRateLimitHint(input.command, result.stdout.text);
  return attachToolExecutionTelemetry(
    {
      stdout,
      stderr,
      // 超时与取消都标记 interrupted，前端据此显示"未完成"而不是失败。
      interrupted: result.timedOut || result.cancelled,
      isImage: imageOutput !== undefined,
      // 静默命令（cd/export 等）不提示"无输出"。
      noOutputExpected: isSilentBashCommand(input.command),
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdoutTruncated: result.stdout.truncated,
      stderrTruncated: result.stderr.truncated,
      stdoutBytes: result.stdout.bytes,
      stderrBytes: result.stderr.bytes,
      rawOutputPath: persistedOutputPath,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      returnCodeInterpretation,
      persistedOutputPath,
      stdoutPersistedOutputPath,
      stderrPersistedOutputPath,
      persistedOutputSize,
      stdoutPersistedOutputSize,
      stderrPersistedOutputSize,
      ...(ghRateLimitHint ? { ghRateLimitHint } : {}),
    },
    createBashPerformanceTelemetry(input, result, options.progressTiming),
  );
}

// outputBytes 取 result.stdout.bytes 与 result.stderr.bytes 之和。
// firstOutputMs 来自 progressTiming?.firstOutputMs，缺失即 undefined。
// 遥测用 commandHash(input.command) 代替命令原文。
// status 经 resolveBashCommandStatus 归一，不直接透传 result.status。
// progressTiming 为空表示本次不采集首输出耗时。
function createBashPerformanceTelemetry(
  input: BashInput,
  result: ExecutionResult,
  progressTiming: BashProgressTiming | undefined,
): ToolExecutionTelemetry | undefined {
  const outputBytes = result.stdout.bytes + result.stderr.bytes;
  const firstOutputMs = progressTiming?.firstOutputMs;
  // 遥测只记录分类/耗时/字节数/哈希，不记录命令原文，避免泄露敏感参数。
  return compactToolExecutionTelemetry({
    detail: {
      kind: "command",
      command: {
        runMs: roundNonNegativeMs(result.durationMs),
        firstOutputMs,
        noOutputMs: firstOutputMs ?? roundNonNegativeMs(result.durationMs),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputBytes,
        category: classifyCommand(input.command),
        ...classifySafeCommandIdentity(input.command),
        status: resolveBashCommandStatus(result),
        hash: commandHash(input.command),
      },
    },
  });
}

export function createBashBackgroundPerformanceTelemetry(
  input: BashInput,
): ToolExecutionTelemetry | undefined {
  return compactToolExecutionTelemetry({
    detail: {
      kind: "command",
      command: {
        category: classifyCommand(input.command),
        ...classifySafeCommandIdentity(input.command),
        status: "backgrounded",
        hash: commandHash(input.command),
      },
    },
  });
}

export function createEmptyBashPerformanceTelemetry(
  input: BashInput,
): ToolExecutionTelemetry | undefined {
  return compactToolExecutionTelemetry({
    detail: {
      kind: "command",
      command: {
        category: "empty",
        count: 0,
        name: "empty",
        status: "completed",
        hash: commandHash(input.command),
      },
    },
  });
}

// result.timedOut 为 true 时直接判 timed_out。
// 其次看 result.cancelled，判 cancelled。
// status === "completed" 且 exitCode !== 0 记为 failed。
// 其余情况沿用执行层的 status，不做二次推断。
// 未知状态不补默认值，避免掩盖上层错误。
function resolveBashCommandStatus(
  result: ExecutionResult,
): ToolCommandStatus {
  // 状态映射：超时/取消优先；completed 但 exit!=0 记为 failed，其余沿用执行层状态。
  if (result.timedOut) return "timed_out";
  if (result.cancelled) return "cancelled";
  if (result.status === "completed" && result.exitCode !== undefined && result.exitCode !== 0) {
    return "failed";
  }
  return result.status;
}
