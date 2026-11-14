/**
 * ============================================================================
 * tool/handlers/bash.ts —— Bash 工具（命令执行的主入口）
 * ============================================================================
 *
 * 【定位】把模型给的 command 变成一次 ExecutionRequest，交给 ExecutionPort；
 * 本文件不直接触碰 child_process。它负责：
 *   - 输入校验与超时策略（DEFAULT_BASH_TIMEOUT_POLICY / per-session policy）；
 *   - 前台 / 显式后台 / 超时自动转后台 三种执行模式的选择；
 *   - 进度事件（progress）转成 session 事件，并记录首个输出时间；
 *   - 结束后按 cwd 策略更新工作目录（成功保留、越界重置）；
 *   - 把命令对文件的读取副作用写回 readFileState（Bash 读过的文件也算"已读"）。
 *
 * 【执行模式选择】
 *   run_in_background=true 且端口支持后台生命周期 → explicit 后台；
 *   否则若命令适合自动后台（isBashAutoBackgroundEligible）→ auto_on_timeout；
 *   其余 → 前台 run。端口不支持后台生命周期时显式后台直接报 ConfigurationError，
 *   而不是静默退化成前台（那会让模型以为任务在后台跑）。
 *
 * 【权限分层】本文件的 isBashInputReadOnly / isBashInputConcurrencySafe /
 *   prepareBashPermissionMatcher 是只读判定与权限匹配的"语义入口"；
 *   具体命令文法解析在 bash-readonly-policy-*.ts，权限规则评估在
 *   bash-command-rule-evaluator.ts。Bash 的只读判定必须保守：
 *   拿不准的命令一律按可写处理，交由权限链拦截。
 *
 * 【遥测】startCommand/finish*：只有 Adapter 明确给出结构化失败时才计失败率；
 *   非零退出码是命令事实（如 grep 未匹配），不算执行框架失败。
 * ============================================================================
 */

// ============================================================================
// tool/handlers/bash.ts —— Bash 工具编排层：输入校验、执行模式选择、进度事件转发、
// cwd 收编、已读回填与静态注册声明。命令文法、只读判定、超时策略与输出投影均在
// 同级模块内实现，本文件只做串联，不直接触碰 child_process。
// 不负责：子进程启停（ExecutionPort/adapter）、输出截断与落盘（bash-output.ts）、
// 权限规则求值（bash-command-rule-evaluator.ts）、只读文法（bash-readonly-policy-*.ts）。
//
// INV-01 断言：只有空白字符的 command 不得进入执行端口，也不得申请后台任务 —— 守住它的位置：executeBashHandler 里 trim 长度判断 —— 改错故障：模型误传空串时起一个永不退出的交互 shell，或留下无意义后台任务
// INV-02 断言：executionPort 缺失必须抛 ConfigurationError 且 recoverable 为 false —— 守住它的位置：executeBashHandler 开头的端口检查 —— 改错故障：静默返回空输出，模型以为命令跑过且无输出
// INV-03 断言：run_in_background 为真而端口不支持后台生命周期时必须报错，不得降级为前台 —— 守住它的位置：supportsBashBackgroundLifecycle 分支 —— 改错故障：模型不再取结果，命令实际阻塞前台，用户看到长时间无响应
// INV-04 断言：执行模式优先级恒为显式后台、超时自动后台、前台 —— 守住它的位置：runCommand 的三元分支链 —— 改错故障：显式后台被自动后台覆盖，返回的 mode 与实际生命周期不符
// INV-05 断言：后台请求的 captureCwdAfterSuccess 必须缺省 —— 守住它的位置：createExecutionRequest 里 run_in_background 三元 —— 改错故障：把后台启动瞬间的 cwd 当最终 cwd 写回 session，后续命令跑错目录
// INV-06 断言：firstOutputMs 只写一次，且要求 stdoutBytes 与 stderrBytes 之和大于 0 —— 守住它的位置：createExecutionRunOptions 的 onEvent —— 改错故障：零字节轮询事件把首字节时延记成 0，性能指标整体失真
// INV-07 断言：非零退出码是命令事实，不得计入执行框架失败率 —— 守住它的位置：finishBashCommandTelemetry 的分支序 —— 改错故障：grep 未匹配这类正常结果污染失败指标，告警噪声淹没真实故障
// INV-08 断言：遥测归因顺序为超时、取消、启动失败、带错误的执行失败、成功 —— 守住它的位置：finishBashCommandTelemetry 的 if 链 —— 改错故障：同时超时与取消时归因漂移，超时率漏计
// INV-09 断言：内联字节上限在执行层与结果预算两处必须同值 —— 守住它的位置：MAX_INLINE_OUTPUT_BYTES 与 bashToolEntry.resultBudget —— 改错故障：执行层先截断，投影层按更大预算处理，尾部内容凭空消失
// INV-10 断言：后台任务输出恒落盘，前台仅在截断时落盘 —— 守住它的位置：createExecutionRequest 的 persistOutput —— 改错故障：后台结束后模型读不到输出，或前台大输出无谓占满磁盘
// INV-11 断言：沙箱默认开启，显式绕过时仍保留结构化标记 —— 守住它的位置：createExecutionRequest 的 sandbox 字段 —— 改错故障：权限与遥测无法区分「沙箱内」与「显式绕过」，审计断链
// INV-12 断言：静态 metadata 的 readOnly 与 concurrentSafe 恒为 false —— 守住它的位置：bashToolEntry.metadata —— 改错故障：任意 Bash 命令被当只读放行，写操作绕过审批
// INV-13 断言：guarded 模式下 shell selection 缺失时按 POSIX 文法匹配危险命令 —— 守住它的位置：resolveBashPermissionCapability 的默认方言兜底 —— 改错故障：selection 未初始化时静默退回放行模式，危险命令直接通过
// INV-14 断言：并发安全判定与只读判定同源 —— 守住它的位置：isBashInputConcurrencySafe —— 改错故障：只读命令被误判为不可并发，或可写命令被并行调度互相踩文件
// INV-15 断言：cwd 更新必须先于输出投影，且重置文案随判定结果一并交出 —— 守住它的位置：executeBashHandler 的 decideBashCwdPolicy 段 —— 改错故障：重置提示丢失，模型看到的目录与 session 实际状态不一致
// INV-16 断言：已读回填必须在 handler 返回之前执行 —— 守住它的位置：executeBashHandler 末尾的 applyBashReadFileStateEffects —— 改错故障：命令里 cat 过的文件不算已读，随后 Edit 被读前写校验拒绝
// INV-17 断言：超时预算解析必须与 handler 共用 resolveBashTimeoutMs —— 守住它的位置：createBashTimeoutBudgetResolver —— 改错故障：0 被压成 1ms，字符串数字绕过策略上限
// INV-18 断言：自定义实例只覆盖 handler、schema、描述与超时，其余声明沿用默认实例 —— 守住它的位置：createBashToolEntry 的对象展开 —— 改错故障：权限、结果预算或取消声明丢失，注册的工具残缺
// ============================================================================
import { matchDangerousCommand } from "./guarded/command.js";
import {
  BashInputSchema,
  BashInputJsonSchema,
  BashOutputJsonSchema,
  BashOutputSchema,
  CoreErrorType,
  SessionEventType,
  createCoreError,
  type BashInput,
  type BashOutput,
  type BackgroundExecutionStartResult,
  type CommandCategory,
  type CommandExecutionSpanWriter,
  type CommandShellKind,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutionRequest,
  type ExecutionRunOptions,
  type ExecutionShellSelection,
  type TraceContext,
} from "@zcode/contracts";
import {
  shouldInjectEmbeddedSearchBashPrelude,
  supportsEmbeddedSearchShellSelection,
} from "../../embedded-search/shell.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveToolWorkingDirectory } from "../path-policy.js";
import { decideBashCwdPolicy } from "./bash-cwd-policy.js";
export {
  getBashActivityDescription,
  getBashAutoClassifierInput,
  getBashDescription,
  getBashToolUseSummary,
  getBashUserFacingName,
} from "./bash-metadata.js";
import { readStringProperty } from "./bash-metadata.js";
import { formatBashModelContent, formatPersistedBashModelContent } from "./bash-model-content.js";

/** session shell selection 尚未初始化时 guarded matcher 采用的文法；与 readonly 判定的假设一致。 */
// [契约] guarded 默认按 posix 文法解析危险命令，与 isRuntimeReadOnlyBashCommand 的兜底假设成对出现
// 两处若改成不同的默认方言，会出现「危险命令按 cmd 判、只读按 posix 判」的自相矛盾
// 不要改成 undefined 交给下游自选，那会让 selection 未初始化时的行为随调用点漂移
const GUARDED_DEFAULT_DIALECT: ExecutionShellSelection["dialect"] = "posix";
import { createBashProviderDescription } from "./bash-prompt.js";
import {
  createBashBackgroundPerformanceTelemetry,
  createEmptyBashPerformanceTelemetry,
  toBashOutput,
  type BashProgressTiming,
} from "./bash-output.js";
import {
  attachToolExecutionTelemetry,
  classifyCommand,
  classifySafeCommandIdentity,
} from "./tool-perf.js";
import { applyBashReadFileStateEffects } from "./bash-read-file-state.js";
import {
  prepareBashPermissionMatcherForCommand,
  isBashReadOnlyCommand,
  isRuntimeReadOnlyBashCommand,
  type BashPermissionMatcher,
} from "./bash-semantics.js";
import { isBashAutoBackgroundEligible } from "./bash-background-policy.js";
import { supportsBashBackgroundLifecycle } from "./bash-background-lifecycle.js";
import { resolveBashPermissionRulePolicy } from "./bash-command-permission-policy.js";
import {
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  type BashTimeoutPolicy,
} from "../bash-timeout-policy.js";

// [契约] 30KB 内联上限在执行层 outputLimit 与 bashToolEntry.resultBudget 两处重复声明
// 两处必须同值，否则执行层先截断、投影层再按更大预算处理，尾部内容凭空消失
// 5GB 只是落盘防御上限，不是模型可见预算，不要拿它推算上下文占用
const MAX_INLINE_OUTPUT_BYTES = 30_000;
const MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const BASH_PROVIDER_DESCRIPTION = createBashProviderDescription({
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
  maxTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
});

// [契约] 描述文本由 timeoutPolicy 决定，自定义策略实例必须让自己的默认值与最大值同步进提示词
// 写死默认策略会让自定义实例的提示词与实际超时不一致，模型据此误判能否传 timeout
export function getBashPrompt(
  timeoutPolicy: BashTimeoutPolicy = DEFAULT_BASH_TIMEOUT_POLICY,
): string {
  // 描述与超时策略同源生成：自定义上限必须同步进提示词，否则模型按默认值估算传参
  return createBashProviderDescription({
    defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
    maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
  });
}

// [契约] 没有 command 字段一律按可写处理，返回 false 而非抛错，输入合法性由 schema 负责
// 只读判定全部委托给命令文法层，不要在 handler 里额外加命令名字符串特判
// [权衡] 保守优先：管道、重定向、命令替换这类复合命令一律判可写，交权限链拦截
export function isBashInputReadOnly(input: unknown): boolean {
  // 字段不是字符串时返回 undefined，这里按可写处理而不是抛错：输入合法性归 schema 管
  const command = readStringProperty(input, "command");
  // 空命令没有可写副作用，但也不构成只读语义，保守返回 false 交给权限链
  return command ? isBashReadOnlyCommand(command) : false;
}

// [契约] 并发安全与只读同源，只读即可并发；拆成两套实现迟早出现「只读但不可并发」的不一致
// Bash 可写命令会改工作区与 cwd，绝不允许并发，否则同一 session 内两条命令互相踩踏
export function isBashInputConcurrencySafe(input: unknown): boolean {
  // 直接转调只读判定：两套实现迟早分叉，出现"只读却不可并发"或反之
  return isBashInputReadOnly(input);
}

// [契约] 返回 undefined 表示「不表态」，交由权限链继续评估，不要改成显式拒绝
// 只有 resolveBashPermissionCapability 给出只读能力时才返回 allow，两处口径必须一致
// 这个入口不写审批记录也不产生规则 ID，命令文本匹配走 prepareBashPermissionMatcher
export function checkBashInputPermissions(input: unknown): { behavior: "allow" } | undefined {
  // 返回 undefined 表示不表态，权限链会继续按规则评估，不能在这里替它做拒绝决定
  return resolveBashPermissionCapability(input) ? { behavior: "allow" } : undefined;
}

// [契约] 没有 command 时返回 undefined 而不是空 matcher，权限链据此跳过命令文本匹配
// 命令文本原样交给文法层，不做 trim 或规范化，否则 *: 前缀规则的匹配位置会偏移
export function prepareBashPermissionMatcher(input: unknown): BashPermissionMatcher | undefined {
  // 读取原始命令文本，不做 trim：规则里的 *: 前缀依赖命令的精确起始位置
  const command = readStringProperty(input, "command");
  return command === undefined ? undefined : prepareBashPermissionMatcherForCommand(command);
}

// [契约] guarded 模式下危险命令命中优先于只读判定，命中即返回 userApprovalRule 交人工确认
// 命中后必须立即返回，否则同一函数的低风险分支会把刚判定为危险的命令放行
// legacy-shell 显式选择不在默认文法兜底范围内，仍走 unsupported 路径
// 本函数只读上下文，不修改 context，也不缓存判定结果，保证同一输入同一结论
export function resolveBashPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const command = readStringProperty(input, "command");
  // 只有 guarded 模式需要危险命令识别；default 模式不在本函数扩大拦截面
  if (command && context?.mode === "guarded") {
    // selection 缺失是基础设施状态而非语法边界；与下方 isRuntimeReadOnlyBashCommand 一致按 POSIX
    // 文法匹配，避免 guarded 在 selection 尚未初始化时静默退回 YOLO。显式 legacy-shell 仍 unsupported。
    const match = matchDangerousCommand(
      command,
      context.bashShellSelection?.dialect ?? GUARDED_DEFAULT_DIALECT,
    );
    // 命中即返回并带上规则 ID，审批界面据此说明"为什么被拦"，继续往下走会把危险命令放行
    if (match.status === "matched") return { userApprovalRule: match.ruleId };
  }
  // 非只读命令返回 undefined 交回权限链继续评估，不能在这里默认放行
  if (!command || !isRuntimeReadOnlyBashCommand(command, context)) return undefined;
  return {
    // 只读能力四项声明必须同时给出，缺项会让下游按默认的高风险值处理
    destructive: false,
    needsApproval: false,
    readOnly: true,
    riskLevel: "low" as const,
    sideEffectScope: "none" as const,
    permission: {
      needsApproval: false,
      riskLevel: "low" as const,
      sideEffectScope: "none" as const,
    },
  };
}

export const bashHandler: ToolHandler = (input, context) =>
  // 默认实例固定使用全局超时策略，自定义策略只能经 createBashToolEntry 注入
  executeBashHandler(input, context, DEFAULT_BASH_TIMEOUT_POLICY);

function createBashHandler(timeoutPolicy: BashTimeoutPolicy): ToolHandler {
  // 闭包捕获策略，保证同一实例每次调用看到同一份上下限，不受全局默认值后续变动影响
  return (input, context) => executeBashHandler(input, context, timeoutPolicy);
}

/**
 * Bash 执行主流程。
 *
 * 空命令（仅空白）不调用执行端口，直接返回 completed 空输出——
 * 这样模型误传空串时不会启动 shell、也不会产生无意义的后台任务。
 *
 * 执行结果有三类：
 *   - backgrounded：只返回 taskId 与输出路径，正文不回灌上下文；
 *   - 前台完成：toBashOutput 做截断/媒体投影，再按 cwd 策略更新工作目录；
 *   - 失败/取消：仍走 toBashOutput，保证 stderr 与错误状态完整交给模型。
 *
 * applyBashReadFileStateEffects 在最后执行：Bash 里 cat/sed 之类读过的文件
 * 也要登记为"已读"，否则模型随后 Edit 会被 read-before-edit 拒绝。
 */
// [并发] 函数内没有跨 await 的可变共享状态，唯一的可变对象是本次调用私有的 progressTiming
// [资源] 取消由 context.abortSignal 承担，这里不新建 AbortController，也不自建超时计时器
async function executeBashHandler(
  input: unknown,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): Promise<BashOutput> {
  // 用 parse 而非 safeParse：输入非法属于调用方 bug，让 ZodError 冒泡到 executor 统一校验
  const parsed = BashInputSchema.parse(input) as BashInput;
  // 端口是唯一出口，先取出避免每处都重复访问 context，也便于下面一眼看出缺失分支
  const executionPort = context.executionPort;

  // [失败路径] 端口缺失是装配错误而非用户输入问题，recoverable 必须为 false
  // 静默返回空输出会让模型以为命令执行过且无输出，比直接报错更难排查
  if (!executionPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort is not configured for Bash tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Bash",
        },
        recoverable: false,
      },
    );
  }

  // [契约] 空白命令在创建 request 之前短路，既不起 shell 也不申请后台任务
  // 遥测仍要 start 与 finish，否则空命令在指标上完全不可见，统计口径出现缺口
  // 判空用 trim 后的长度，纯空格与纯换行同样走这条路径，不要改成 !command 判真值
  if (parsed.command.trim().length === 0) {
    const commandTelemetry = startBashCommandTelemetry(parsed, context);
    commandTelemetry?.finishCompleted();
    return emptyBashOutput(parsed);
  }

  const request = createExecutionRequest(parsed, context, timeoutPolicy);
  // 计时对象在一次调用内共享，onEvent 与最终投影都写同一份，避免首字节时延对不上
  const progressTiming: BashProgressTiming = {};
  // 遥测可能在宿主未配置时返回 undefined，后续一律可选调用，不因缺遥测中断执行
  const commandTelemetry = startBashCommandTelemetry(parsed, context);
  // 进度事件与首字节计时都挂在 runOptions 上，handler 不订阅适配器的原始流
  const runOptions = createExecutionRunOptions(context, progressTiming, commandTelemetry);
  // 闲时后台归属由 Runtime 生命周期保留，Bash 复用普通显式/超时后台路径。
  // 自动后台只是启发式判断，不能覆盖用户显式指定的后台意图
  const eligibleForAutoBackground = isBashAutoBackgroundEligible(parsed);
  // 能力探测失败时保持 undefined，后续分支据此报错或退回前台，避免任务无人认领
  const backgroundLifecyclePort = supportsBashBackgroundLifecycle(executionPort)
    ? executionPort
    : undefined;

  // [失败路径] 显式后台但端口不支持生命周期时必须立即报错，不能静默降级为前台
  // 降级后果是模型不会发取结果请求，命令实际阻塞到底，用户只看到长时间无响应
  // 错误在创建任何后台任务之前抛出，保证不留下半初始化的任务记录
  if (parsed.run_in_background && !backgroundLifecyclePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort does not support the Bash background lifecycle",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Bash",
        },
        recoverable: false,
      },
    );
  }

  // [契约] 分支优先级：显式后台、超时自动后台、前台，顺序不可交换
  // 显式后台只看 run_in_background，不看 eligibility，用户意图优先于启发式
  // 自动后台要求端口具备生命周期能力，否则退回前台，避免任务无人认领
  const runCommand = async () =>
    parsed.run_in_background && backgroundLifecyclePort
      ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
          request,
          { mode: "explicit" },
          runOptions,
        )
      : eligibleForAutoBackground && backgroundLifecyclePort
        ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
            request,
            { mode: "auto_on_timeout" },
            runOptions,
          )
        : {
            kind: "foreground" as const,
            result: await executionPort.run(request, runOptions),
          };
  const runResult = commandTelemetry
    ? await commandTelemetry.run(async () => {
        // 先拿结果再归因：后台化与前台完成收尾方式不同，混在一起会把后台算成成功
        const observed = await runCommand();
        if (observed.kind === "backgrounded") {
          commandTelemetry.finishBackgrounded();
        } else {
          // 只有前台分支拿得到 ExecutionResult，退出码、超时与信号都在这里收口
          finishBashCommandTelemetry(commandTelemetry, observed.result);
        }
        return observed;
      })
    : await runCommand();

  // [契约] 后台化之后立即返回摘要，不回灌正文，也不更新 cwd、不回填已读状态
  // 任务尚未结束，此刻读到的 cwd 与文件内容都不是最终态，写回只会污染 session
  // 输出路径由 adapter 给出，handler 只做透传，不要在这里拼接或规范化路径
  if (runResult.kind === "backgrounded") {
    // taskId 与落盘路径原样透传，模型后续按这些字段取结果，这里不做转码或重命名
    return toBackgroundedBashOutput(runResult.task, parsed);
  }

  const result = runResult.result;
  // cwd 变更交策略层判定：这里不做路径前缀比较，跨平台大小写与符号链接差异由策略层吸收
  const cwdDecision = decideBashCwdPolicy({
    status: result.status,
    exitCode: result.exitCode,
    resolvedCwd: result.resolvedCwd,
    workspaceRoot: context.workspaceRoot,
    runtimeScope: context.runtimeScope,
  });
  // [契约] cwd 变更只采用策略层给出的结论，handler 不自行比较路径前缀
  // 策略返回空表示保持不变，此时不能调用 setWorkingDirectory，否则产生无意义事件
  // setWorkingDirectory 是可选能力，测试替身未提供时必须能安全跳过
  if (cwdDecision.nextWorkingDirectory) {
    // 空值表示维持原目录，此时调用只会制造一次无意义的状态事件，所以必须判空
    // 主线程 Bash 成功后会保留项目内 cwd；
    // 离开项目边界时 reset 回原始工作区，并把 reset 文案放进 Bash stderr。
    await context.setWorkingDirectory?.(cwdDecision.nextWorkingDirectory);
  }
  // [契约] stderrSuffix 来自 cwd 判定，用来把「已重置到工作区根」的提示混进 stderr 给模型看
  // 投影必须在 cwd 更新之后进行，保证输出描述的目录与 session 当前状态一致
  // 截断与媒体投影都在 toBashOutput 内完成，handler 不得二次裁剪 stdout
  const output = await toBashOutput(result, parsed, context, {
    progressTiming,
    // stderrSuffix 是唯一能与 stdout 区分的提示通道，塞进 stdout 会让模型误当成命令输出
    stderrSuffix: cwdDecision.stderrSuffix,
  });
  // [契约] 已读回填是 Bash 的隐含副作用，必须在返回前完成，否则调用方可能已进入下一步
  // 回填的降级策略由该函数内部决定，handler 不包 try，避免把真实命令结果吞成失败
  // command 与 result 必须来自本次调用，不能读 session 上的最新命令状态
  await applyBashReadFileStateEffects({
    command: parsed.command,
    context,
    output,
    result,
  });
  return output;
}

// [契约] 空输出的 status 固定 completed，不是 failed，模型不应把它当命令失败处理
// 仍挂空遥测，保证输出结构与正常路径同形，消费方无需特判这个分支
function emptyBashOutput(input: BashInput): BashOutput {
  // 空输出仍走统一投影：status 固定 completed，模型不会把它误判成命令失败
  return attachToolExecutionTelemetry(
    {
      // stdout/stderr 用空串而不是缺字段，消费方无需特判"没有输出"这种形状
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      status: "completed",
      // 原样回显沙箱开关，保证审计能看出这次调用是否显式绕过了沙箱
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    // 空遥测让输出结构与正常路径同形，消费方不必为这个分支单写一条判断
    createEmptyBashPerformanceTelemetry(input),
  );
}

// [契约] 后台化输出只带任务 ID 与落盘路径，正文一律留空，避免未知长度输出塞进上下文
// persistedOutputPath 与 rawOutputPath 同值是有意为之，分别对应读接口与原始接口口径
// 不要把任务 ID 写进 stdout，模型按结构化字段取任务，混进正文会导致重复解析
function toBackgroundedBashOutput(
  task: BackgroundExecutionStartResult,
  input: BashInput,
): BashOutput {
  // 任务 ID 与输出路径都来自 adapter，handler 不拼接也不规范化，避免与落盘实现耦合
  return attachToolExecutionTelemetry(
    {
      // 正文留空是刻意的：输出长度未知，回灌会直接占满上下文
      stdout: "",
      stderr: "",
      interrupted: false,
      // interrupted 不在后台态声明：任务尚未结束，此时说"被中断"是与事实相反
      status: "backgrounded",
      backgroundTaskId: task.taskId,
      rawOutputPath: task.outputPath,
      persistedOutputPath: task.outputPath,
      stdoutPersistedOutputPath: task.stdoutPersistedOutputPath,
      stderrPersistedOutputPath: task.stderrPersistedOutputPath,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createBashBackgroundPerformanceTelemetry(input),
  );
}

// [契约] onEvent 只处理 progress，其余事件类型直接丢弃，不要用类型断言强行处理
// signal 直接透传上下文 abortSignal，不新建控制器，否则取消链会在此断掉一节
function createExecutionRunOptions(
  context: ToolExecutionContext,
  progressTiming?: BashProgressTiming,
  telemetry?: CommandExecutionSpanWriter,
): ExecutionRunOptions {
  return {
    // 直接透传上下文信号：新建控制器会让取消链在此断节，用户取消后子进程还会继续跑
    signal: context.abortSignal,
    onEvent: async (event) => {
      // [并发] firstOutputMs 只在首次出现正字节时写一次，后续事件不得覆盖
      // 用 elapsedMs 而不是本地时间差，保证与 adapter 的计时基准一致
      // 空输出事件（0 字节）不记首字节时间，否则启动噪声会被算成有效输出时延
      if (event.type !== "progress") return;
      if (
        progressTiming &&
        progressTiming.firstOutputMs === undefined &&
        event.stdoutBytes + event.stderrBytes > 0
      ) {
        progressTiming.firstOutputMs = Math.max(0, Math.round(event.elapsedMs));
        telemetry?.markFirstOutput();
      }
      // 进度转发放在计时之后：即使事件通道缺失，性能数据也必须已经落好
      await emitProgressEvent(event, context);
    },
  };
}

// [契约] sandboxed 的判定是「没有显式关闭沙箱」，而不是「请求确实进入了沙箱」
// 命令分类与安全名来自静态分类器，不解析真实参数，指标只用于趋势不用于审计
// 分类结果缺失时命令数记 0、安全名记 other，不要因此跳过整条遥测
function startBashCommandTelemetry(
  input: BashInput,
  context: ToolExecutionContext,
): CommandExecutionSpanWriter | undefined {
  const identity = classifySafeCommandIdentity(input.command);
  return context.telemetry?.startCommand({
    // 分类只影响指标维度，不参与权限判断，分类不准也不会放宽任何拦截
    category: commandCategory(input.command),
    // 命令数解析不出时记 0 而不是跳过整条遥测，否则复合命令在趋势图上直接消失
    commandCount: identity.count ?? 0,
    // 安全名兜底为 other：这里不落命令原文，避免把用户命令行写进指标
    safeName: identity.name ?? "other",
    // 没有显式关闭沙箱即视为沙箱内：该字段描述请求配置，不是实际隔离结果
    sandboxed: input.dangerouslyDisableSandbox !== true,
    // shell 类型可能未知，交由 commandShellKind 区分"未选择"与"选了 posix"
    shellKind: commandShellKind(context.bashShellSelection),
  });
}

// [契约] 退出码、信号、输出字节与超时标记在同一处收口，不要在调用点零散补写
// 分支顺序是超时、取消、启动失败、带错误的执行失败、其余成功，不可重排
function finishBashCommandTelemetry(
  telemetry: CommandExecutionSpanWriter | undefined,
  result: ExecutionResult,
): void {
  if (!telemetry) return;
  // 退出码与信号是命令事实，先无条件写入，再做终止归因，避免归因分支提前 return 丢字段
  if (result.exitCode !== undefined) telemetry.setExitCode(result.exitCode);
  if (result.signal) telemetry.setSignal(result.signal);
  // 输出字节在这里一次算清，调用点不再零散补写，保证每条命令的统计口径一致
  telemetry.setOutputBytes(result.stdout.bytes + result.stderr.bytes);
  telemetry.setTimedOut(result.timedOut);

  if (result.timedOut) {
    // 超时优先于取消：两者可能同时成立，超时率依赖这条优先级才能统计准确
    telemetry.markTerminationRequested("timeout");
    telemetry.finishFailed("timeout", "timeout", result.error);
  } else if (result.cancelled) {
    // 取消是用户主动行为，归到 abort_signal 而不是失败，避免污染失败率
    telemetry.markTerminationRequested("cancelled");
    telemetry.finishCancelled("abort_signal");
  } else if (result.status === "spawn_error") {
    // 启动失败说明可执行文件或环境有问题，属配置类错误，与命令自身退出码无关
    telemetry.finishFailed("spawn", "configuration", result.error);
  } else if (result.status === "failed" && result.error) {
    // 非零退出码是命令事实（例如 grep 未匹配），不等同于执行框架失败。
    // 只有 Adapter 明确提供结构化 failure 时才污染 command failure rate。
    telemetry.finishFailed("execute", "internal", result.error);
  } else {
    telemetry.finishCompleted();
  }
}

function commandCategory(command: string): CommandCategory {
  // 只映射指标枚举：分类器不认识的命令统一归 shell，不要在这里抛错或返回空值
  // 分类只服务于遥测聚合；classifyCommand 是纯函数，不读环境也不执行命令，
  // 因此可以安全地在前台/后台两条路径上重复调用。
  switch (classifyCommand(command)) {
    case "git":
      return "git";
    case "package":
      return "package_manager";
    case "build":
      return "build";
    case "test":
      return "test";
    case "network":
      return "network";
    default:
      // 默认归 shell 是兜底而非判断失败，保证每条命令都有可统计的类别
      return "shell";
  }
}

// [契约] 先按展示名识别具体 shell，再按方言兜底，顺序不能反
// 展示名可能为空或未本地化，方言判断必须保留，否则 Windows 命令会被记成 other
// selection 缺失返回 undefined 而非 sh，表示「未选择」与「选了 posix」是两种状态
function commandShellKind(
  selection: ToolExecutionContext["bashShellSelection"],
): CommandShellKind | undefined {
  const displayName = selection?.display.name.toLowerCase();
  // 顺序重要：powershell 名字里也含 sh，必须先判最具体的家族，否则会被记成 sh
  if (displayName?.includes("powershell")) return "powershell";
  if (displayName?.includes("zsh")) return "zsh";
  if (displayName?.includes("bash")) return "bash";
  // 展示名可能是空串或未本地化，方言判断作为兜底的第二梯队必须保留
  if (selection?.dialect === "cmd") return "cmd";
  if (selection?.dialect === "posix") return "sh";
  // selection 存在但都不匹配记 other；完全未选择才返回 undefined，两者语义不同
  return selection ? "other" : undefined;
}

// [契约] 没有事件通道时静默跳过，进度是可选能力，缺它不影响命令执行结果
// 序号固定 0 由下游会话层统一重编号，这里不要自增，否则两条链路会抢号
// 消息 ID 用随机 UUID，不借 toolCallId，同一次调用可能产生多条进度事件
async function emitProgressEvent(
  event: Extract<ExecutionEvent, { type: "progress" }>,
  context: ToolExecutionContext,
): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    // id 用随机 UUID 而非 toolCallId：同一次调用会产生多条进度事件，共用 ID 会被去重
    id: crypto.randomUUID() as any,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: event.timestamp,
    traceId: context.traceId,
    // 序号固定 0 由下游会话层统一重编号，这里自增会和另一条事件链路抢号
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId,
      toolName: "Bash",
      elapsedMs: event.elapsedMs,
      pid: event.pid,
      stdoutBytes: event.stdoutBytes,
      stderrBytes: event.stderrBytes,
      // outputBytes 现算而不是透传，避免 adapter 少给字段时下游拿到 NaN
      outputBytes: event.stdoutBytes + event.stderrBytes,
      outputPreview: event.outputPreview,
      // 尾部若干行单独携带：预览可能被截断，模型需要尾部才能判断命令是否卡在错误上
      stdoutTail: event.stdoutTail,
      stderrTail: event.stderrTail,
    },
  });
}

// [契约] 命令模式固定 shell、profile 固定 posix-bash，真实方言靠 shellOverride 覆盖
// 嵌入搜索预置脚本要求开关、配置与 shell 支持三者同时成立，任一不满足则整体不注入
// [失败路径] 预置脚本的可选字段用展开省略而不是写 undefined，adapter 按字段存在性分支
function createExecutionRequest(
  input: BashInput,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): ExecutionRequest {
  const shellSelection = context.bashShellSelection;
  // 预置脚本要求开关、配置、shell 支持三者同时成立；任一缺失就整体不注入，避免半套脚本
  const bashPrelude =
    shouldInjectEmbeddedSearchBashPrelude() &&
    context.embeddedSearch?.enabled === true &&
    context.embeddedSearch.backend &&
    supportsEmbeddedSearchShellSelection(shellSelection)
      ? {
          kind: "embedded-search" as const,
          backend: context.embeddedSearch.backend,
          ...(context.embeddedSearch.findAndGrepEnabled === false
            ? { findAndGrepEnabled: false }
            : {}),
        }
      : undefined;
  return {
    command: {
      // 固定 shell 模式：整串命令交给 shell 执行，管道与重定向都依赖这层语义
      mode: "shell",
      command: input.command,
      // profile 固定 posix-bash，真实方言靠 shellOverride 覆盖，不要改这里
      shellProfile: "posix-bash",
      // 未选择 shell 时省略字段，adapter 按字段存在性决定是否覆盖默认方言
      ...(shellSelection ? { shellOverride: shellSelection } : {}),
    },
    // cwd 经路径策略解析：工作区边界与不存在目录的降级都在那里处理，这里不自行拼接
    cwd: resolveToolWorkingDirectory(undefined, {
      operation: "execute",
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    }),
    // 预置脚本缺省时不写该字段，避免 adapter 收到一个空的预置配置
    ...(bashPrelude ? { bashPrelude } : {}),
    // 只有前台才回读 cwd：后台进程的 cd 发生在任务结束后，此刻读到的不是最终状态。
    captureCwdAfterSuccess: input.run_in_background ? undefined : true,
    // 超时统一走策略解析：0 与字符串数字都在那里被纠正，不能把原始值直接透传
    timeoutMs: resolveBashTimeoutMs(input.timeout, timeoutPolicy),
    outputLimit: {
      // 内联上限 30KB 与 resultBudget.maxInlineBytes 同值，保证"执行层不截断"的假设成立；
      // 后台输出必须 always 落盘（任务结束后模型仍要能读），前台只在截断时落盘。
      maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
      maxBufferBytes: MAX_INLINE_OUTPUT_BYTES,
      // 落盘上限只是防御性边界，远大于模型可见预算，不要拿它推算上下文占用
      maxPersistedBytes: MAX_RUNTIME_PERSISTED_OUTPUT_BYTES,
      // 后台必须无条件落盘（任务结束后模型才来取），前台只在被截断时才写盘
      persistOutput: input.run_in_background ? "always" : "on_truncate",
    },
    // 沙箱默认开启；dangerouslyDisableSandbox 只是把同一请求的开关翻转，仍会留下
    // 结构化标记（输出里回显该字段），让权限/遥测能区分"沙箱内"与"显式绕过"。
    sandbox: {
      // 默认开启沙箱，只有显式传 true 才翻转；缺省值一律按最安全的一侧处理
      enabled: !input.dangerouslyDisableSandbox,
      // 同时回显原始开关，让权限与遥测能区分"沙箱内"与"显式绕过"
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    trace: {
      // 逐字段搬运而不是整体展开 context：TraceContext 不允许携带业务字段
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attributes: {
        toolCallId: context.toolCallId,
        toolName: "Bash",
      },
    } as unknown as TraceContext,
  };
}

/**
 * 入口口径（与 handler 语义必须一致，否则权限链按错的声明放行）：
 * - readOnly/concurrentSafe 恒为 false：静态元数据无法表达"这条命令是否只读"，真正的
 *   只读/写入判定由 resolvePermissionCapability 按命令文法逐次计算；默认必须按可写处理。
 * - maxOutputBytes=10MB 是 adapter 缓冲上限，不是模型可见上限；模型可见预算见
 *   resultBudget（30KB 内联 + artifact 落盘），两者不要混用。
 * - needsApproval=true、sideEffectScope=system：命令可触及工作区、git、网络与系统状态。
 * - patternSources 取 command：权限规则匹配的是命令文本（:* 前缀或通配），不是工具名。
 */
// [契约] 这里的静态声明必须与 resolvePermissionCapability 的运行时判定自洽，冲突时以运行时为准
// 结果预算与执行层内联上限同值，改动时两处一起改，否则模型可见范围与落盘策略错位
export const bashToolEntry: ToolEntry = {
  capability: "Execute platform shell commands through the execution adapter",
  metadata: {
    name: "Bash",
    description: BASH_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
    maxOutputBytes: 10_000_000,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
  },
  formatModelContent: formatBashModelContent,
  formatPersistedModelContent: formatPersistedBashModelContent,
  handler: bashHandler,
  resolveTimeoutBudgetMs: createBashTimeoutBudgetResolver(DEFAULT_BASH_TIMEOUT_POLICY),
  resolvePermissionCapability: resolveBashPermissionCapability,
  resolvePermissionRulePolicy: resolveBashPermissionRulePolicy,
  inputSchema: BashInputJsonSchema,
  outputSchema: BashOutputJsonSchema,
  runtimeInputSchema: BashInputSchema,
  runtimeOutputSchema: BashOutputSchema,
  permission: {
    permission: "bash",
    reason: "Bash can run subprocesses and may affect workspace, git, network, or system state",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["command"],
    alwaysAllowPatternSources: ["command"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
    maxModelBytes: 30_000,
    strategy: "artifact",
    preview: {
      maxBytes: 30_000,
      direction: "tail",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
    maxMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
    allowCallOverride: true,
    cleanupGraceMs: 6_000,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Bash was cancelled and the child process was asked to stop",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// [契约] 工厂只覆盖 handler、inputSchema、描述与超时，其余字段整份沿用默认实例
// 漏掉展开会让自定义实例丢失权限、结果预算与取消声明，工具注册残缺
// inputSchema 必须重算，否则 JSON Schema 里的上限仍写着默认策略的值
export function createBashToolEntry(
  options: {
    bashTimeoutPolicy?: BashTimeoutPolicy;
    embeddedSearchEnabled?: boolean;
  } = {},
): ToolEntry {
  const timeoutPolicy = options.bashTimeoutPolicy ?? DEFAULT_BASH_TIMEOUT_POLICY;
  // 先整份展开默认实例，再只覆盖与超时/描述相关字段，避免漏掉权限、预算或取消声明
  return {
    ...bashToolEntry,
    handler: createBashHandler(timeoutPolicy),
    // JSON Schema 里的超时上限是编译期文案，换策略后必须重算，否则提示词与实际限制不一致
    inputSchema: createBashInputJsonSchema(timeoutPolicy),
    resolveTimeoutBudgetMs: createBashTimeoutBudgetResolver(timeoutPolicy),
    metadata: {
      ...bashToolEntry.metadata,
      // 描述要带上本实例的默认值与上限，模型据此决定能否传 timeout 以及传多大
      description: createBashProviderDescription({
        defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
        embeddedSearchEnabled: options.embeddedSearchEnabled,
        maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
      }),
      timeoutMs: timeoutPolicy.defaultTimeoutMs,
    },
    timeout: {
      // 默认值与上限必须成对来自同一策略，混用会让校验层与执行层对同一调用给出不同预算
      defaultMs: timeoutPolicy.defaultTimeoutMs,
      maxMs: timeoutPolicy.maxTimeoutMs,
      // 允许单次调用覆盖，但覆盖值仍受上面上限约束，不能绕过策略
      allowCallOverride: true,
      // 清理宽限期固定值：杀进程后要留时间回收输出与临时文件，不能立刻判定结束
      cleanupGraceMs: 6_000,
    },
  };
}

// [契约] 预算解析必须与 handler 共用 resolveBashTimeoutMs，不能直接读原始 timeout
// 直接读原值会把 0 压成 1ms，并让字符串数字绕过策略的上下限
// schema 解析失败时按未传超时处理，兜底到默认值而不是 0
function createBashTimeoutBudgetResolver(
  timeoutPolicy: BashTimeoutPolicy,
): NonNullable<ToolEntry["resolveTimeoutBudgetMs"]> {
  return (input) => {
    // 与 handler 共用 safeParse + resolveBashTimeoutMs，保证预算与真实超时同源
    const parsed = BashInputSchema.safeParse(input);
    // 旧 watchdog 直接读取 raw timeout，导致 0 被压成 1ms，且字符串数字绕过
    // Bash policy。这里和 handler 共用 timeout || default / max 解析后再加 cleanup grace。
    return resolveBashTimeoutMs(parsed.success ? parsed.data.timeout : undefined, timeoutPolicy);
  };
}

// [契约] 只改超时字段的描述文案以反映自定义上限，其余 schema 原样返回
// properties 或 timeout 缺失时直接返回原 schema，不要凭空补字段
function createBashInputJsonSchema(timeoutPolicy: BashTimeoutPolicy): Record<string, unknown> {
  const schema = BashInputJsonSchema as Record<string, unknown>;
  // properties 或 timeout 缺失说明 schema 结构已变，此时原样返回比补一个假字段更安全
  const properties = schema.properties as Record<string, unknown> | undefined;
  const timeoutProperty = properties?.timeout as Record<string, unknown> | undefined;
  if (!properties || !timeoutProperty) return schema;

  // 只替换 description，其余约束原样展开：这里改写文案，不是重新定义 schema
  // 逐层展开而不是就地改 timeoutProperty：BashInputJsonSchema 是共享常量，
  // 就地修改会让同一进程内并发注册的工具串用对方的超时文案。
  return {
    ...schema,
    properties: {
      ...properties,
      timeout: {
        ...timeoutProperty,
        description: `Optional timeout in milliseconds (max ${timeoutPolicy.maxTimeoutMs})`,
      },
    },
  };
}
