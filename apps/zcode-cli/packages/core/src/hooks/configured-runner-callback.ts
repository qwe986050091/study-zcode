// INV-01 command 与 process 同语义：守住位置 两条分支；改错故障 两种 hook 行为不一致。
// INV-02 stdin 必须清理：守住位置 最终清理；改错故障 临时文件泄漏。
// INV-03 cwd 优先输入值：守住位置 空值合并；改错故障 忽略 hook 指定目录。
// INV-04 环境覆盖按插件合并：守住位置 覆盖函数；改错故障 插件变量串台。
// INV-05 变量展开含工作目录：守住位置 参数；改错故障 相对路径按进程目录解析。
// INV-06 输出只诊断不落盘：守住位置 持久化选项；改错故障 大输出写产物。
// INV-07 超时来自执行参数：守住位置 透传；改错故障 hook 无限挂起。
// INV-08 输出上限同值：守住位置 两个字段；改错故障 内联与缓冲不对称。
// INV-09 trace 含匹配位置：守住位置 属性；改错故障 无法定位哪个 hook。
// INV-10 信号透传执行端口：守住位置 第二参数；改错故障 取消不生效。
// INV-11 退出码零才算成功：守住位置 双条件；改错故障 非零被当成功。
// INV-12 退出码二转阻断：守住位置 分支；改错故障 拒绝被当失败重试。
// INV-13 其它退出码抛可恢复错：守住位置 末尾；改错故障 静默吞掉失败。
// INV-14 预览截断统一入口：守住位置 修剪函数；改错故障 日志爆炸。
// INV-15 阻断原因优先 stderr：守住位置 回退链；改错故障 用户看不到拒绝理由。
// INV-16 阻断形状按事件分派：守住位置 四分支；改错故障 权限事件字段错。
// INV-17 stdout 像对象才解析：守住位置 首字符判断；改错故障 普通日志报错。
// INV-18 JSON 结构非法要报错：守住位置 schema 校验；改错故障 错误协议被静默接受。
//
// 模块职责：把配置 hook 翻译成一次受控进程执行并归一化结果。
// 状态所有权：无状态；执行端口、目录与信号均由调用方注入。
// 阅读顺序：先看两条执行分支，再看结果归一化，最后看阻断形状。
/**
 * ============================================================================
 * hooks/configured-runner-callback.ts —— 把"配置 hook"翻译成一次进程执行
 * ============================================================================
 *
 * command 类型走 shell 字符串,process 类型走 argv;两者都:
 *   - 注入兼容 stdin(事件 payload)与插件 env overlay;
 *   - 通过 executionPort 执行,受 hook 自己的 timeout / maxOutputBytes 约束;
 *   - persistOutput: "none"(hook 的输出只作为结果/诊断,不落 artifact)。
 *
 * 【退出码语义】
 *   0       成功:stdout 若像 JSON 则按 HookJSONOutput 解析;
 *   2       阻断:转换成该事件对应的 deny/block 输出(而不是当成失败);
 *   其它    失败:抛可恢复的 ToolExecutionFailed,带 stdout/stderr 预览。
 * ============================================================================
 */
import {
  CoreErrorType,
  HookEventName,
  HookJSONOutputSchema,
  createCoreError,
  type ExecutionResult,
  type HookConfig,
  type HookInput,
  type HookJSONOutput,
} from "@zcode/contracts";
import {
  createCompatibleHookStdin,
  createPluginEnvOverlay,
  expandPluginVariables,
} from "./configured-runner-input.js";
import type { ConfiguredHookRunnerOptions, HookCallback, HookCallbackResult } from "./types.js";

// createConfiguredHookCallback 按 hook.type 分派 command 与 process 两条执行分支。
// 两条分支共用 createCompatibleHookStdin 与 processHookExecutionResult，输入与诊断路径一致。
// 变量统一用 expandPluginVariables 展开，工作目录取 options.getWorkingDirectory()。
// timeoutMs 与 maxOutputBytes 由调用方的 execution 参数注入，本函数不设默认值。
// 回调不缓存执行结果，每次调用都重新走一遍 executionPort.run。
export function createConfiguredHookCallback(
  options: ConfiguredHookRunnerOptions,
  event: HookEventName,
  hook: HookConfig,
  matcherIndex: number,
  hookIndex: number,
  execution: { maxOutputBytes: number; timeoutMs: number },
): HookCallback {
  switch (hook.type) {
    case "command":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "shell",
                command: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                shell: hook.shell,
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event);
        } finally {
          await stdin.cleanup();
        }
      };
    case "process":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "argv",
                file: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                args: (hook.args ?? []).map((arg) =>
                  expandPluginVariables(arg, hook.plugin, input, options.getWorkingDirectory()),
                ),
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event);
        } finally {
          await stdin.cleanup();
        }
      };
  }
}

// processHookExecutionResult 只在 status 为 completed 且 exitCode 为 0 时判成功。
// exitCode 为 2 时转成该事件的 deny 或 block 输出，不按失败处理。
// 其余退出码抛 recoverable 的 ToolExecutionFailed，交由上层重试或提示。
// 成功结果统一经 attachHookDiagnostics 附加 stderr 与 stdout 预览。
// 预览长度由 trimForPreview 截断到 4000 字符，避免日志被大输出撑爆。
function processHookExecutionResult(
  input: HookInput,
  result: ExecutionResult,
  event: HookEventName,
): HookJSONOutput | HookCallbackResult | undefined {
  if (result.status === "completed" && (result.exitCode ?? 0) === 0) {
    // 退出码 0 才是"正常结束";status=completed 但非 0 仍按下面的分支处理。
    return attachHookDiagnostics(parseHookStdout(result.stdout.text, event), result);
  }

  if (result.exitCode === 2) {
    // 退出码 2 是 hook 协议的"阻断"约定,不是执行失败:
    // 转成对应事件形状的 deny/block 输出,让上层按权限/继续语义处理。
    return attachHookDiagnostics(createExitCodeBlockOutput(input, result), result);
  }

  const message =
    result.error?.message ??
    trimForPreview(result.stderr.text) ??
    `Hook process exited with status ${result.status}`;
  throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook process failed", {
    context: {
      exitCode: result.exitCode,
      hookEventName: event,
      status: result.status,
      stderrPreview: trimForPreview(result.stderr.text),
      stdoutPreview: trimForPreview(result.stdout.text),
    },
    cause: new Error(message),
    recoverable: true,
  });
}

function attachHookDiagnostics(
  output: HookJSONOutput | undefined,
  result: ExecutionResult,
): HookJSONOutput | HookCallbackResult | undefined {
  const stderrPreview = trimForPreview(result.stderr.text);
  const stdoutPreview = result.exitCode === 2 ? trimForPreview(result.stdout.text) : undefined;
  if (!stderrPreview && !stdoutPreview) return output;
  return {
    kind: "hookCallbackResult",
    ...(output ? { output } : {}),
    diagnostics: {
      ...(stderrPreview ? { errorMessage: stderrPreview, stderrPreview } : {}),
      ...(stdoutPreview ? { stdoutPreview } : {}),
    },
  };
}

// parseHookStdout 遇到空串直接返回 undefined。
// 首字符不是 { 的文本不按 JSON 解析，普通日志因此不会报错。
// JSON.parse 失败时静默忽略，hook 打印日志是常态。
// HookJSONOutputSchema 校验失败即抛可恢复错误，不允许错误协议被静默接受。
// 错误上下文带 hookEventName 与 validation.error 的前 20 条明细。
function parseHookStdout(stdout: string, event: HookEventName): HookJSONOutput | undefined {
  const trimmed = stdout.trim();
  // 只有"看起来像 JSON 对象"才尝试解析:
  // hook 打印普通日志/空输出是常态,不能因此报错。
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON stdout 是诊断文本，不能因为 hook 打印日志而让当前动作失败。
    return undefined;
  }

  const validation = HookJSONOutputSchema.safeParse(parsed);
  if (!validation.success) {
    // 与"非 JSON 日志"不同:这里 hook 明确输出了 JSON 但结构非法,
    // 说明它试图表达控制结果却写错了协议 → 按可恢复错误拒绝,而不是静默忽略。
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Hook stdout failed HookJSONOutput schema validation",
      {
        context: {
          errors: validation.error.errors.slice(0, 20),
          hookEventName: event,
        },
        recoverable: true,
      },
    );
  }

  return validation.data as HookJSONOutput;
}

// createExitCodeBlockOutput 的 reason 优先取 result.stderr.text。
// stderr 为空时回退到 result.stdout.text。
// 两者都空才落到 "Hook blocked execution" 兜底文案。
// PreToolUse 事件返回 permissionDecision=deny，工具调用被直接拒绝。
// Stop 事件返回 decision=block，阻止本轮任务继续推进。
function createExitCodeBlockOutput(input: HookInput, result: ExecutionResult): HookJSONOutput {
  // 阻断原因优先用 stderr(脚本通常把"为什么拒绝"写 stderr),其次 stdout,最后兜底文案。
  const reason =
    trimForPreview(result.stderr.text) ??
    trimForPreview(result.stdout.text) ??
    "Hook blocked execution";

  // 不同事件的"阻断"形状不同,必须按事件生成对应的协议字段:
  //   PreToolUse        → permissionDecision=deny;
  //   PermissionRequest → decision.behavior=deny;
  //   Stop              → decision=block;
  //   其它              → continue=false。
  if (input.hookEventName === HookEventName.PreToolUse) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  if (input.hookEventName === HookEventName.PermissionRequest) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PermissionRequest,
        decision: {
          behavior: "deny",
          message: reason,
        },
      },
    };
  }

  if (input.hookEventName === HookEventName.Stop) {
    return {
      decision: "block",
      reason,
    };
  }

  return {
    continue: false,
    reason,
  };
}

function trimForPreview(value: string, maxLength = 4000): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
