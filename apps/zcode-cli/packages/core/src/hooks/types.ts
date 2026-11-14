/**
 * ============================================================================
 * hooks/types.ts —— Hook 运行时的对外契约（纯类型）
 * ============================================================================
 *
 * 这里定义注册体、单次 run 的选项/结果、执行器接口与装配选项。
 * 口径重点:admission 是"能否执行"的唯一入口（不变量 #10）;
 * permissionBehavior 只承载权限结论,合并时必须单调收紧（不变量 #3）。
 * 整个文件不含运行期代码,读类型即可看清链路 9 各层的输入与输出边界。
 * ============================================================================
 */
import type {
  ExecutionPort,
  HookEventName,
  HookExecutionDescriptor,
  HookInput,
  HookJSONOutput,
  HookPermissionDecision,
  HookSourceKind,
  HooksRuntimeConfig,
  WorkspaceHookBundleSnapshot,
  Logger,
  PermissionRequestHookDecision,
  SessionEvent,
} from "@zcode/contracts";

import type { WorkspaceHookRuntimeAdmissionPort } from "./workspace-hook-runtime-admission.js";

export interface HookCallbackContext {
  /** 客户端可见序号(跳过隐藏 hook 后连续),不是内部数组下标。 */
  hookIndex: number;
  /** turn 的取消域;hook 必须用它响应 Stop/超时,不能自行忽略。 */
  signal?: AbortSignal;
}

/**
 * 配置 Hook 的执行器可以附带 stderr 等诊断；这些信息只进入生命周期事件，
 * 不参与 Hook 决策，也不会作为 Hook JSON 输出暴露给模型。
 */
export interface HookCallbackDiagnostics {
  errorMessage?: string;
  stderrPreview?: string;
  stdoutPreview?: string;
}

export interface HookCallbackResult {
  /** 判别式:用于区分"纯 JSON 输出"与"带 stderr 诊断的包装结果"。 */
  kind: "hookCallbackResult";
  diagnostics?: HookCallbackDiagnostics;
  output?: HookJSONOutput;
}

export type HookCallback = (
  input: HookInput,
  context: HookCallbackContext,
) =>
  | HookJSONOutput
  | HookCallbackResult
  | void
  | Promise<HookJSONOutput | HookCallbackResult | void>;

export interface HookRunAdmissionDecision {
  allowed: boolean;
  reasonCode?: string;
  /** true 表示该 hook 不发出生命周期事件,也不计入客户端可见数量。 */
  skipLifecycle?: boolean;
}

export interface HookRegistration {
  /** 授权门:每次 dispatch 前都会重新调用,结果不得缓存（不变量 #10）。 */
  admission?: (input: HookInput) => HookRunAdmissionDecision;
  /** 后台执行标记:启动后立即继续,其输出不得反向改变已继续的动作。 */
  async?: boolean;
  callback: HookCallback;
  /** 展示元数据;函数形式按本次输入动态计算(例如带 matcher 的命令行)。 */
  descriptor?: HookExecutionDescriptor | ((input: HookInput) => HookExecutionDescriptor);
  event: HookEventName;
  matcher?: string;
  source?: string;
  sourceKind?: HookSourceKind;
  /** 单 hook 覆盖默认超时;缺省时由 runner 的 defaultTimeoutMs 兜底。 */
  timeoutMs?: number;
}

export interface HookRunOptions {
  /** matcher 的单个匹配目标(如工具名);与 matchValues 取并集后逐个测试。 */
  matchValue?: string;
  matchValues?: readonly string[];
  signal?: AbortSignal;
}

export interface HookRunResult {
  additionalContexts: string[];
  blockRequested?: boolean;
  hookPermissionDecisionReason?: string;
  /** 权限结论;多 hook 合并时按 deny > ask 单调收紧,不允许被后续 allow 覆盖。 */
  permissionBehavior?: HookPermissionDecision;
  /** 对权限请求事件的答复,由权限流合并再生效,不是最终结论。 */
  permissionRequestResult?: PermissionRequestHookDecision;
  /** 已阻断"继续":preventContinuation 与 block 分开表达,便于各事件各自处置。 */
  preventContinuation?: boolean;
  /** 仅 Stop 事件:true 表示 hook 要求继续跑,而不是结束回合。 */
  stopShouldContinue?: boolean;
  stopReason?: string;
  /** hook 改写后的候选工具输入;之后仍要重新过权限规则(不变量 #3)。 */
  updatedInput?: unknown;
}

export interface HookRunner {
  /** 执行器只暴露 run;注册与装配由具体实现负责,调用方不感知内部顺序。 */
  run(input: HookInput, options?: HookRunOptions): Promise<HookRunResult>;
}

export interface HookRunnerOptions {
  defaultTimeoutMs?: number;
  /** 事件发射由外部注入:runner 不直接触碰 event store,保持三类事实分离。 */
  emitEvent?: (event: SessionEvent) => Promise<void>;
  hooks?: HookRegistration[];
  logger?: Logger;
}

export interface ConfiguredHookRunnerOptions {
  config: HooksRuntimeConfig;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  /** 外部进程必须经 ExecutionPort 执行,统一超时/取消/sandbox 语义。 */
  executionPort: ExecutionPort;
  getWorkingDirectory: () => string;
  logger?: Logger;
  /** 工作区 hook 的运行期准入端口;缺省时不装配项目 hook（链路 9 的装配侧 fail closed）。 */
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  /** 装配时使用的快照;真正执行前仍要按当前快照/代际重验（不变量 #10）。 */
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
}
