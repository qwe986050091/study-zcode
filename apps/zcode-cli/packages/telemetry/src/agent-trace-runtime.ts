// INV-01 span 创建只经统一封装：守住位置 startSpan；改错故障 各处默认值与父上下文不一致。
// INV-02 容量上限默认 5000 且非法值回落：守住位置 构造归一首；改错故障 零容量让遥测全丢。
// INV-03 超容量降级共享空实现：守住位置 安全创建；改错故障 每次降级都新建对象。
// INV-04 容量告警超限期间只报一次：守住位置 告警闩锁；改错故障 刷屏淹没日志。
// INV-05 创建异常转告警并降级：守住位置 捕获分支；改错故障 遥测故障打断业务。
// INV-06 指标异常不得影响 span 生命周期：守住位置 指标包装；改错故障 后端故障导致 span 悬挂。
// INV-07 活动集只含未终结写入器：守住位置 登记与移除；改错故障 容量被僵尸占满。
// INV-08 终结回调负责移出活动集：守住位置 构造参数；改错故障 活动集无限增长。
// INV-09 非子模式用链接表达来源：守住位置 链接分支；改错故障 独立任务被串进父链。
// INV-10 子模式才建立真实父子：守住位置 父上下文选择；改错故障 会话树层级错误。
// INV-11 身份在开启回合时快照：守住位置 关联对象；改错故障 中途换身份污染已开 span。
// INV-12 会话结束按会话标识放弃：守住位置 放弃会话；改错故障 关闭会话后仍上报 span。
// INV-13 进程退出放弃全部写入器：守住位置 放弃进程；改错故障 进程退出留下未结束 span。
// INV-14 尝试 span 固定为客户端类型：守住位置 类型参数；改错故障 外部调用被当作内部操作。
// INV-15 命令 span 必须挂在工具 span 之下：守住位置 父写入器注入；改错故障 命令脱离工具上下文。
// INV-16 属性统一经压缩归一：守住位置 属性构造；改错故障 空值进入后端产生噪声。
// INV-17 非法标识直接丢弃而不是写空串：守住位置 安全标识；改错故障 属性出现空维度。
// INV-18 放弃操作幂等：守住位置 终结闩锁；改错故障 重复放弃重复上报。
//
// 模块职责：统一创建回合、步骤、工具、命令、压缩、游离操作与模型调用各类 span。
// 状态所有权：活动写入器集合、容量闩锁与身份快照由运行时实例持有。
// 阅读顺序：先看运行时与开启方法，再读写入器实现，最后看指标标签与空实现。
import { recordRequestObservation } from "./request-security-edition/index.js";
/* oxlint-disable eslint(max-lines) -- concrete Writer 在同一文件显式维护各自 canonical key，避免运行时 Schema/Registry 再造一层映射。 */
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentStepTraceStart,
  AgentTelemetryAbandonReason,
  AgentTelemetryCancellationReason,
  AgentTelemetryCausation,
  AgentTelemetryErrorCategory,
  AgentTelemetryExecutionContext,
  AgentTurnSpanWriter,
  AgentTurnTraceStart,
  CommandExecutionSpanWriter,
  CommandTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  ModelAttemptFailureStage,
  ModelAttemptSpanWriter,
  ModelAttemptTraceStart,
  ModelCallFailureStage,
  ModelCallSpanWriter,
  ModelCallTraceStart,
  ModelExecutionTelemetryPort,
  ModelFinishReason,
  ModelReasoningControlType,
  ModelReasoningState,
  ResponseModelTelemetryDescriptor,
  TelemetryIdentitySnapshot,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@zcode/contracts/telemetry";
import type { ModelRequestObservation } from "@zcode/contracts/model";
import {
  activeWriterContext,
  BaseSpanWriter,
  compactAttributes,
  executionProjection,
  finiteNonNegative,
  integer,
  isAbortLike,
  safeEnum,
  safeId,
  safeIdentifier,
  safeString,
  contextFromCausation,
  spanContextFromCausation,
  type ActiveWriterContext,
  type WriterHealth,
  type WriterLifecycleKeys,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";
import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
  type ModelTokenType,
} from "./agent-metrics.js";
import {
  commandCompatibilityAttributes,
  httpResponseCompatibilityAttributes,
  modelAttemptCompatibilityAttributes,
  modelResponseCompatibilityAttributes,
  toolCompatibilityAttributes,
} from "./compatibility-adapters.js";
import { sanitizeErrorMessage } from "./error-sanitizer.js";

/**
 * Agent 遥测运行时的构造参数。
 * 职责：注入 Tracer、身份快照、容量与指标记录器，并复用 `WriterHealth` 的告警回调。
 * 缺失值语义：`identity` 缺省为 `{ identityState: "unknown" }`；`maxActiveWriters` 缺省 5000；
 * `metrics` 缺省为空实现，所有指标记录退化为 no-op。
 * 失败语义：参数非法不抛错，按默认值兜底，保证遥测组件不会成为启动失败源。
 */
export interface AgentTraceRuntimeOptions extends WriterHealth {
  /** 身份快照；用于把 userSubjectId 写入 span 属性，缺省表示身份未知。 */
  identity?: TelemetryIdentitySnapshot;
  /** 同时存活的 writer 上限；超出后新建 span 降级为 NOOP 并上报指标。 */
  maxActiveWriters?: number;
  /** 指标记录器；缺省使用 `NOOP_AGENT_TELEMETRY_METRICS`。 */
  metrics?: AgentTelemetryMetricRecorder;
  /** 唯一必需依赖：OTel Tracer，所有 span 都经它创建。 */
  tracer: Tracer;
}

/**
 * 创建单个 span writer 的内部参数集合。
 * 职责：把 tracer.startSpan 所需的属性、父上下文、链路与元数据收敛到一个结构。
 * 缺失值语义：`kind` 缺省 INTERNAL；`context` 缺省当前活跃 Context；`links` 缺省无关联。
 */
interface StartWriterOptions {
  /** 初始属性表；调用方需已做归一化（通常经 `compactAttributes`）。 */
  attributes?: Attributes;
  /** 显式父 Context；缺省使用 `context.active()`，避免丢失调用链。 */
  context?: Context;
  /** 业务执行关联信息，写入 writer 快照供 causation 与属性投影使用。 */
  correlation?: AgentTelemetryExecutionContext;
  /** OTel span 类型；缺省 INTERNAL，跨服务调用才使用 CLIENT。 */
  kind?: SpanKind;
  /** 跨进程/跨任务血缘链接，配合 causation 使用。 */
  links?: Link[];
  /** 上层 writer 快照；设置后父子关系与工具调用标识可被继承。 */
  parent?: ActiveWriterContext;
  /** span 名称，同时作为指标维度与生命周期键名前缀。 */
  spanName: string;
  /** 工具调用标识；仅在工具及其子 span 上出现。 */
  toolCallId?: string;
}

/**
 * 运行时登记表持有的 writer 约定。
 * 职责：让运行时能以统一方式放弃所有类型的 writer，而无需感知具体实现类。
 * 不变量：`state` 必须是构造时绑定 Span 的那个快照对象，供按 sessionId 过滤。
 */
type TrackedWriter = BaseSpanWriter & {
  /** 放弃收尾入口；内部会先抢占终结闩锁，重复调用安全。 */
  abandon(reason: AgentTelemetryAbandonReason): void;
  /** writer 运行态快照，包含 correlation 与 span。 */
  readonly state: ActiveWriterContext;
};

/**
 * Agent 侧遥测运行时：统一创建 Turn/Step/Tool/Command/Compaction/Detached/Model 各类 span。
 * 职责：把业务 trace 入参投影为 span 属性，并管理活动 writer 集合、容量与进程级回收。
 * 输入：各 `startXxx` 接收契约定义的 trace 起始结构；`captureCausation` 读取当前活跃 writer。
 * 输出：返回对应 writer；容量耗尽或创建异常时返回共享的 NOOP writer，调用方无需判空。
 * 副作用：创建 span、写入活动集、记录指标与告警；不修改业务状态。
 * 失败语义：所有创建路径经 `safeCreate` 包裹，异常转为告警并降级，绝不向上抛出。
 * 不变量：活动集只包含未终结的 writer，终结回调负责移出；容量告警在超限期间只报一次。
 */
// AgentExecutionTelemetryRuntime 的实例可变状态只有 activeWriters 与 capacityWarningActive：identity 可被 updateIdentity
// 热更新，maxActiveWriters 在构造时经 positiveLimit 归一化（非法值回退 5000）；指标与告警分别走 metrics/health 旁路，
// 所有 startXxx 都经 safeCreate 包裹，异常只告警并降级为 NOOP writer；activeWriters 只存未终结 writer，终结回调负责移出。
export class AgentExecutionTelemetryRuntime
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  /** 活动 writer 集合；用于会话/进程级放弃与容量判定。 */
  private readonly activeWriters = new Set<TrackedWriter>();
  /** 容量告警闩锁；超限期间保持 true，回落到阈值以下后复位，避免重复刷告警。 */
  private capacityWarningActive = false;
  /** 当前身份快照；可被 `updateIdentity` 热更新，后续 span 读取最新值。 */
  private identity: TelemetryIdentitySnapshot;
  /** 活动 writer 数量上限，构造时归一化为正整数。 */
  private readonly maxActiveWriters: number;
  /** OTel Tracer，所有 span 的唯一创建入口。 */
  private readonly tracer: Tracer;
  /** 告警出口；仅包装 onWarning，避免每处重复判空。 */
  private readonly health: WriterHealth;
  /** 指标记录器；缺省为 no-op 实现。 */
  private readonly metrics: AgentTelemetryMetricRecorder;

  /**
   * 建立运行时，只做依赖注入与默认值归一化，不创建任何 span。
   * 输入：见 `AgentTraceRuntimeOptions`；非法上限值回退到 5000。
   * 副作用：无。
   */
  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
  }

  /**
   * 热更新身份快照，只影响后续创建的 span，已开始的 span 属性保持不变。
   * 口径：userSubjectId 必须通过 `safeId` 校验，非法值直接不写入，保持"缺失"语义。
   * 副作用：覆盖内存中的 identity 引用。
   */
  updateIdentity(snapshot: TelemetryIdentitySnapshot): void {
    this.identity = {
      identityState: snapshot.identityState,
      ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
    };
  }

  /**
   * 捕获当前活跃 writer 的 causation，供子任务或下游恢复调用链。
   * 输出：无活跃 writer 或 SpanContext 无效时返回 `undefined`。
   * 口径：`isRemote` 缺省 false；只携带 trace 标识与 session/turn/tool 关联，不含 model 维度。
   * 副作用：无，纯读取。
   */
  captureCausation() {
    const active = activeWriterContext();
    if (!active) return undefined;
    const spanContext = active.span.spanContext();
    if (!trace.isSpanContextValid(spanContext)) return undefined;
    return {
      isRemote: spanContext.isRemote ?? false,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
      ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
      sessionId: active.correlation?.sessionId,
      turnId: active.correlation?.turnId,
      toolCallId: active.toolCallId,
    };
  }

  /**
   * 创建一次 Agent Turn 的根 span，或在 child 模式下作为上层调用的子 span。
   * 输入：`input.context` 为业务关联信息；`causationMode` 与 `causation` 决定父子/关联方式。
   * 输出：TurnWriter；创建异常或超容量时返回 NOOP_TURN_WRITER。
   * 口径：非 child 模式只用 link 表达"逻辑来源"；child 模式才把 causation 转成真实父 Context。
   * 副作用：创建 span、登记活动集；身份状态在此刻快照进 correlation，之后更新不影响本 turn。
   */
  startTurn(input: AgentTurnTraceStart): AgentTurnSpanWriter {
    const correlation: AgentTelemetryExecutionContext = {
      ...input.context,
      identityState: this.identity.identityState,
      ...(this.identity.userSubjectId ? { userSubjectId: this.identity.userSubjectId } : {}),
    };
    // 只有 child 模式才建立真实父子；其余模式用 link 表达来源，避免把独立任务串进父链。
    const linkedRoot = input.causationMode !== "child";
    const links =
      input.causation && linkedRoot ? [causationLink(input.causation, "spawned_by")] : undefined;
    return this.safeCreate(
      "agent_turn",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(correlation, {
              includeActor: true,
              includeAgent: true,
              includeIdentity: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.agent_turn.turn_number": integer(input.turnNumber),
            "zcode.agent_turn.input_source": safeEnum(input.inputSource),
          }),
          context: parentContext,
          correlation,
          links,
          spanName: "agent_turn",
        });
        return this.track(
          new TurnWriter(
            span,
            parentContext,
            {
              correlation,
              spanName: "agent_turn",
            },
            this.health,
            this.metrics,
            turnMetricLabels(correlation, input.inputSource),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_TURN_WRITER,
    );
  }

  /**
   * 创建当前步骤（step）span，默认以活跃 writer 为父。
   * 输入：`stepId`/`stepIndex` 为可选维度，非法值经归一化后丢弃。
   * 输出：StepWriter；创建异常或超容量时返回 NOOP_STEP_WRITER。
   * 口径：无活跃 writer 时以当前活跃 Context 为父；correlation 与 toolCallId 全部继承父级。
   * 副作用：创建 span 并登记活动集。
   */
  startStep(input: AgentStepTraceStart): AgentStepSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "agent_step",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.agent_step.step_id": safeId(input.stepId),
            "zcode.agent_step.step_index": integer(input.stepIndex),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "agent_step",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new StepWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "agent_step"),
            this.health,
            this.metrics,
            stepMetricLabels(parent?.correlation),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_STEP_WRITER,
    );
  }

  /**
   * 创建工具执行 span，并注入工具兼容属性。
   * 输入：`toolCallId` 与 `registeredToolName` 均会被规范化；超长或非法值降级为缺失。
   * 输出：ToolWriter；创建异常或超容量时返回 NOOP_TOOL_WRITER。
   * 口径：工具名截断上限 128；toolCallId 同时用于投影属性与 writer 快照。
   * 副作用：创建 span、登记活动集；ToolWriter 后续可再派生 command span。
   */
  startTool(input: ToolTraceStart): ToolExecutionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "tool_execution",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const toolName = safeString(input.registeredToolName, 128);
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, { includeActor: true }),
            "zcode.execution.tool_call_id": safeId(input.toolCallId),
            "zcode.tool_execution.tool_name": toolName,
            ...toolCompatibilityAttributes({
              toolCallId: input.toolCallId,
              toolName: input.registeredToolName,
            }),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "tool_execution",
          toolCallId: safeId(input.toolCallId),
        });
        return this.track(
          new ToolWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "tool_execution"),
              toolCallId: safeId(input.toolCallId),
            },
            this.health,
            this.metrics,
            toolMetricLabels(input.registeredToolName),
            (writer) => this.activeWriters.delete(writer),
            (command) => this.startCommand(command),
          ),
        );
      },
      NOOP_TOOL_WRITER,
    );
  }

  /**
   * 创建上下文压缩 span，记录触发原因、阶段与 token 阈值口径。
   * 输入：全部维度为可选；token 类字段只接受非负有限值，异常值丢弃而非置 0。
   * 输出：CompactionWriter；创建异常或超容量时返回 NOOP_COMPACTION_WRITER。
   * 口径：`outerAttempt`/`maxAttempts` 使用安全整数；`recoveredFromLogicalCallId` 用于恢复链溯源。
   * 副作用：创建 span 并登记活动集。
   */
  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "context_compaction",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.context_compaction.trigger": safeEnum(input.trigger),
            "zcode.context_compaction.phase": safeEnum(input.phase),
            "zcode.context_compaction.model_mode": safeEnum(input.modelMode),
            "zcode.context_compaction.outer_attempt": integer(input.outerAttempt),
            "zcode.context_compaction.max_attempts": integer(input.maxAttempts),
            "zcode.context_compaction.triggering_step_index": integer(input.triggeringStepIndex),
            "zcode.context_compaction.policy_context_window_tokens": finiteNonNegative(
              input.policyContextWindowTokens,
            ),
            "zcode.context_compaction.threshold_tokens": finiteNonNegative(input.thresholdTokens),
            "zcode.context_compaction.token_source": safeEnum(input.tokenSource),
            "zcode.context_compaction.recovered_from_logical_call_id": safeId(
              input.recoveredFromLogicalCallId,
            ),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "context_compaction",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new CompactionWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "context_compaction"),
            this.health,
            this.metrics,
            compactionMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMPACTION_WRITER,
    );
  }

  /**
   * 创建后台/游离操作 span，用于不阻塞主 turn 的异步任务。
   * 输入：`executionKind` 决定是否作为独立根（非 foreground 即视为游离执行）。
   * 输出：DetachedWriter；创建异常或超容量时返回 NOOP_DETACHED_WRITER。
   * 口径：游离执行只与 causation 建 link（recovery 用 resumed_from，其余 triggered_by），
   * 前台执行则直接以 causation 为父 Context。
   * 副作用：创建 span 并登记活动集。
   */
  // [契约] executionKind !== "foreground" 时 linkedRoot 为真：span 以 ROOT_CONTEXT 起根，causation 只落成 link 不作父上下文。
  // 恢复来源记为 resumed_from。
  // 其余来源记为 triggered_by。
  // 前台执行才继承父上下文。
  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {
    // 游离执行不阻塞主链，作为独立根并用 link 记录来源；仅前台执行才继承父 Context。
    const linkedRoot = input.executionKind !== "foreground";
    const links =
      input.causation && linkedRoot
        ? [
            causationLink(
              input.causation,
              input.trigger === "recovery" ? "resumed_from" : "triggered_by",
            ),
          ]
        : undefined;
    return this.safeCreate(
      "detached_operation",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(input.context, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.detached_operation.operation": safeEnum(input.operation),
            "zcode.detached_operation.execution_kind": safeEnum(input.executionKind),
            "zcode.detached_operation.trigger": safeEnum(input.trigger),
            "zcode.detached_operation.target_kind": safeEnum(input.targetKind),
            "zcode.detached_operation.goal_iteration": integer(input.goalIteration),
            "zcode.detached_operation.chunk_index": integer(input.chunkIndex),
            "zcode.detached_operation.chunk_count": integer(input.chunkCount),
          }),
          context: parentContext,
          correlation: input.context,
          links,
          spanName: "detached_operation",
        });
        return this.track(
          new DetachedWriter(
            span,
            parentContext,
            {
              correlation: input.context,
              spanName: "detached_operation",
            },
            this.health,
            this.metrics,
            detachedMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_DETACHED_WRITER,
    );
  }

  /**
   * 创建逻辑模型调用 span（跨重试保持同一条链路）。
   * 输入：`requested` 描述请求模型与 reasoning 诉求；`callCause`/`previousLogicalCallId` 支持调用归因。
   * 输出：ModelCallWriter；创建异常或超容量时返回 NOOP_MODEL_CALL_WRITER。
   * 口径：`streaming` 直接写入属性；reasoning 的 level 与 budget 分别用字符串/整数归一化。
   * 副作用：创建 span 并登记活动集；后续每次 attempt 由该 writer 派生。
   */
  // startCall 的父上下文取自 activeWriterContext()：无活跃 writer 时 parent 为 undefined，parentContext 回落
  // context.active()，correlation/toolCallId 也不会被继承；有 parent 时 startSpan 同时传 context: parent.activeContext
  // 与 parent，span 才挂在活跃写入器之下；logicalCallId 经 safeId 写入 "zcode.execution.logical_call_id"，
  // 后续 startAttempt 由同一个 ModelCallWriter 派生，跨重试共用一条链路。
  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "model_call",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.logical_call_id": safeId(input.logicalCallId),
            "zcode.model_call.operation": safeEnum(input.operation),
            "zcode.model_call.streaming": input.streaming,
            "zcode.model_call.model_role": safeEnum(input.modelRole),
            "zcode.model_call.requested_provider_id": safeString(input.requested.providerId, 128),
            "zcode.model_call.requested_model": safeString(input.requested.requestedModel, 128),
            "zcode.model_call.reasoning_capability": safeEnum(input.requested.reasoning.capability),
            "zcode.model_call.reasoning_requested_state": safeEnum(
              input.requested.reasoning.requestedState,
            ),
            "zcode.model_call.reasoning_requested_control": safeEnum(
              input.requested.reasoning.requestedControl,
            ),
            "zcode.model_call.reasoning_requested_level": safeString(
              input.requested.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_call.reasoning_requested_budget_tokens": integer(
              input.requested.reasoning.requestedBudgetTokens,
            ),
            "zcode.model_call.call_cause": safeEnum(input.callCause),
            "zcode.model_call.previous_logical_call_id": safeId(input.previousLogicalCallId),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "model_call",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new ModelCallWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "model_call"),
            },
            this.health,
            this.metrics,
            modelCallMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
            (writer, attempt) => this.startAttempt(writer, attempt),
            safeId(input.logicalCallId),
            safeEnum(input.operation),
            safeEnum(input.modelRole),
          ),
        );
      },
      NOOP_MODEL_CALL_WRITER,
    );
  }

  /**
   * 会话结束时放弃该会话下所有仍存活的 writer。
   * 输入：`sessionId` 精确匹配 writer 快照中的 correlation.sessionId。
   * 副作用：逐个 finishAbandoned("session_shutdown")；终结回调会同步移出活动集。
   */
  // abandonSession 只对 writer.state.correlation?.sessionId === sessionId 的 writer 调 abandon("session_shutdown")；
  // Set 的迭代器允许在遍历中 delete，abandon 的终结回调正是通过 activeWriters.delete 移出，不会跳过元素；
  // 不匹配的 writer 保持活动，进程级回收走 abandonProcess()。
  abandonSession(sessionId: string): void {
    for (const writer of this.activeWriters) {
      if (writer.state.correlation?.sessionId === sessionId) {
        writer.abandon("session_shutdown");
      }
    }
  }

  /**
   * 进程退出前放弃所有活动 writer，避免留下永不结束的 span。
   * 副作用：全部以 `process_shutdown` 终结；重复调用安全（终结闩锁保证幂等）。
   */
  abandonProcess(): void {
    for (const writer of this.activeWriters) writer.abandon("process_shutdown");
  }

  /**
   * 由 ToolWriter 派生命令执行 span，父上下文取自工具 writer 快照。
   * 输入：`parent` 由 ToolWriter 注入，保证命令 span 一定挂在工具 span 之下。
   * 输出：CommandWriter；创建异常或超容量时返回 NOOP_COMMAND_WRITER。
   * 口径：命令安全名截断 128；`sandboxed` 直接写布尔值，不做推断。
   * 副作用：创建 span 并登记活动集。
   */
  // startCommand 的 parent 取自 input.parent.state（ToolWriter 快照），context/correlation/toolCallId 全部继承，
  // 命令 span 因此一定挂在工具 span 之下，不另建链路；safeName 经 safeString 截断 128，sandboxed 直接写布尔值，
  // 不做推断；commandCount/shellKind 走 integer/safeEnum，无效值只会缺属性而不会抛错。
  private startCommand(
    input: CommandTraceStart & { parent: ToolWriter },
  ): CommandExecutionSpanWriter {
    const parent = input.parent.state;
    return this.safeCreate(
      "command_execution",
      () => {
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.command_execution.safe_name": safeString(input.safeName, 128),
            "zcode.command_execution.category": safeEnum(input.category),
            "zcode.command_execution.command_count": integer(input.commandCount),
            "zcode.command_execution.shell_kind": safeEnum(input.shellKind),
            "zcode.command_execution.sandboxed": input.sandboxed,
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          parent,
          spanName: "command_execution",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new CommandWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "command_execution"),
            this.health,
            this.metrics,
            commandMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMMAND_WRITER,
    );
  }

  /**
   * 由 ModelCallWriter 派生单次尝试（attempt）span。
   * 输入：`input.target` 描述实际请求目标与 reasoning 诉求；`parentWriter` 提供调用级维度。
   * 输出：ModelAttemptWriter；创建异常或超容量时返回 NOOP_MODEL_ATTEMPT_WRITER。
   * 口径：attempt span 使用 CLIENT 类型（真实外部调用）；retryDelayMs 仅非负时写入。
   * 副作用：创建 span 并登记活动集；attempt 失败会回调父 writer 累计失败次数。
   */
  // startAttempt 从 input.target 解析实际请求目标：provider_* 与 requested_model 都经 safeString/safeEnum 归一化，
  // reasoning 各项分别写 capability/requested_state/requested_control/level/budget；retryDelayMs 只经
  // finiteNonNegative 写入，负数被丢弃；kind 固定 SpanKind.CLIENT 表示真实外部调用；失败回调 parentWriter.recordAttemptFailed。
  private startAttempt(
    parentWriter: ModelCallWriter,
    input: ModelAttemptTraceStart,
  ): ModelAttemptSpanWriter {
    const parent = parentWriter.state;
    return this.safeCreate(
      "model_attempt",
      () => {
        const target = input.target;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.execution.logical_call_id": parentWriter.logicalCallId,
            "zcode.execution.model_operation": parentWriter.operation,
            "zcode.execution.model_role": parentWriter.modelRole,
            "zcode.model_attempt.request_id": safeId(input.requestId),
            "zcode.model_attempt.attempt_number": integer(input.attemptNumber),
            "zcode.model_attempt.max_attempts": integer(input.maxAttempts),
            "zcode.model_attempt.attempt_cause": safeEnum(input.attemptCause),
            "zcode.model_attempt.previous_request_id": safeId(input.previousRequestId),
            "zcode.model_attempt.retry_delay_ms": finiteNonNegative(input.retryDelayMs),
            "zcode.model_attempt.provider_id": safeString(target.providerId, 128),
            "zcode.model_attempt.provider_kind": safeEnum(target.providerKind),
            "zcode.model_attempt.provider_origin": safeString(target.providerOrigin),
            "zcode.model_attempt.provider_route": safeString(target.providerRoute),
            "zcode.model_attempt.requested_model": safeString(target.requestedModel, 128),
            "zcode.model_attempt.transport": safeEnum(input.transport),
            "zcode.model_attempt.api_operation": safeEnum(input.apiOperation),
            "zcode.model_attempt.reasoning_capability": safeEnum(target.reasoning.capability),
            "zcode.model_attempt.reasoning_requested_state": safeEnum(
              target.reasoning.requestedState,
            ),
            "zcode.model_attempt.reasoning_requested_control": safeEnum(
              target.reasoning.requestedControl,
            ),
            "zcode.model_attempt.reasoning_requested_level": safeString(
              target.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_attempt.reasoning_requested_budget_tokens": integer(
              target.reasoning.requestedBudgetTokens,
            ),
            ...modelAttemptCompatibilityAttributes(target),
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          kind: SpanKind.CLIENT,
          parent,
          spanName: "model_attempt",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new ModelAttemptWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "model_attempt"),
            this.health,
            this.metrics,
            modelAttemptMetricLabels(input, parentWriter),
            () => parentWriter.recordAttemptFailed(),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_MODEL_ATTEMPT_WRITER,
    );
  }

  /**
   * 调用 tracer.startSpan 的唯一封装，统一默认 span kind 与父 Context 回退。
   * 口径：未指定 kind 时使用 INTERNAL；未指定 context 时使用当前活跃 Context。
   */
  private startSpan(options: StartWriterOptions): Span {
    return this.tracer.startSpan(
      options.spanName,
      {
        attributes: options.attributes,
        kind: options.kind ?? SpanKind.INTERNAL,
        links: options.links,
      },
      options.context ?? context.active(),
    );
  }

  /**
   * 把新建 writer 登记进活动集合，供会话/进程级放弃与容量统计。
   * 输出：原样返回 writer，便于链式使用。
   */
  private track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  /**
   * 受控创建 span writer：超容量或创建异常时降级为共享 NOOP writer。
   * 输入：`create` 为实际创建逻辑；`fallback` 必须是不可变单例，避免每次降级新建对象。
   * 输出：成功时返回真实 writer，失败时返回 fallback。
   * 副作用：记录 creation_drop 指标；容量告警在持续超限期间只触发一次。
   * 失败语义：吞掉创建异常并转为告警，调用方永远拿到可用对象。
   */
  // safeCreate 先判 activeWriters.size >= maxActiveWriters：超限返回不可变 fallback 并记 recordCreationDrop(..., "process_capacity")，
  // capacityWarningActive 闩锁保证持续超限只告警一次，回落到阈值以下立刻复位；create() 抛错时同样记 creation_drop("unknown")
  // 并降级，两层 try/catch 连 health.onWarning 自身异常也吞掉，调用方永远拿到可用 writer。
  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  /**
   * 执行指标记录并吞掉异常，防止指标后端故障影响 span 创建/终结。
   * 失败语义：记录失败本身再降级为告警；嵌套 try/catch 保证告警回调也不能抛穿。
   */
  private safeMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      try {
        this.health.onWarning?.("Telemetry metric operation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Metric 与健康回调都属于旁路。
      }
    }
  }
}

/**
 * 把可选上限归一化为正整数，非法值回退到 fallback。
 * 口径：<=0、NaN、Infinity 视为非法；小数向下取整。
 */
function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * 在原有指标标签上补充终态维度，供 recordSpanTerminal 使用。
 * 口径：`error_category` 缺失时被 `compactAttributes` 丢弃，不会写成空字符串。
 */
function terminalMetricLabels(
  labels: Attributes,
  observation: WriterTerminalObservation,
): Attributes {
  return compactAttributes({
    ...labels,
    error_category: observation.errorCategory,
  });
}

/**
 * Turn 级指标标签：actor、输入来源与启动面。
 * 为什么只保留这三个：它们是 turn 维度的低基数维度，避免指标爆炸。
 */
function turnMetricLabels(
  correlation: AgentTelemetryExecutionContext,
  inputSource: AgentTurnTraceStart["inputSource"],
): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation.actorKind),
    input_source: safeEnum(inputSource),
    launch_surface: safeEnum(correlation.launchSurface),
  });
}

/**
 * Step 级指标标签：仅保留 actor_kind，步骤维度由 span 属性承担。
 */
function stepMetricLabels(correlation: AgentTelemetryExecutionContext | undefined): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation?.actorKind),
  });
}

/**
 * Tool 级指标标签：工具名截断到 128，保持与 span 属性同口径。
 */
function toolMetricLabels(toolName: string): Attributes {
  return {
    tool_name: safeString(toolName, 128),
  };
}

/**
 * Command 级指标标签：命令类别与安全名（已脱敏），不含原始命令文本。
 */
function commandMetricLabels(input: CommandTraceStart): Attributes {
  return compactAttributes({
    command_category: safeEnum(input.category),
    command_safe_name: safeString(input.safeName, 128),
  });
}

/**
 * Compaction 级指标标签：模型模式与触发原因，用于区分压缩场景。
 */
function compactionMetricLabels(input: CompactionTraceStart): Attributes {
  return compactAttributes({
    model_mode: safeEnum(input.modelMode),
    trigger: safeEnum(input.trigger),
  });
}

/**
 * Detached 级指标标签：执行类型与操作名，用于区分后台任务类别。
 */
function detachedMetricLabels(input: DetachedOperationTraceStart): Attributes {
  return compactAttributes({
    execution_kind: safeEnum(input.executionKind),
    operation: safeEnum(input.operation),
  });
}

/**
 * Model Call 级指标标签：调用归因（缺省 initial）、操作类型与模型角色。
 * 口径：`callCause` 缺省补 `initial`，与 span 属性投影保持一致的语义。
 */
function modelCallMetricLabels(input: ModelCallTraceStart): Attributes {
  return compactAttributes({
    call_cause: safeEnum(input.callCause ?? "initial"),
    model_operation: safeEnum(input.operation),
    model_role: safeEnum(input.modelRole),
  });
}

/**
 * Model Attempt 级指标标签：目标模型、操作/角色（继承父 Call）与传输方式。
 * 口径：operation 与 modelRole 直接取父 writer 已归一化的值，避免重复解析。
 */
function modelAttemptMetricLabels(
  input: ModelAttemptTraceStart,
  parent: ModelCallWriter,
): Attributes {
  return compactAttributes({
    model: safeString(input.target.requestedModel, 128),
    model_operation: parent.operation,
    model_role: parent.modelRole,
    provider_kind: safeEnum(input.target.providerKind),
    transport: safeEnum(input.transport),
  });
}

/**
 * 所有具体 writer 的公共基类，在 `BaseSpanWriter` 之上补充指标与活动集清理。
 * 职责：在任意终结路径（完成/失败/取消/放弃/兜底）统一触发终态回调与指标记录。
 * 输入：`metricLabels` 为低基数指标维度；`onRemoved` 负责把自身移出运行时活动集。
 * 副作用：终结时记录 span 终态指标、移除活动集条目；数据均取自 writer 已记录的实时事实。
 * 失败语义：所有回调经 `safe` 隔离，指标故障不影响 span 结束。
 * 不变量：终结回调只能由 BaseSpanWriter 的闩锁触发一次，因此指标不会重复计数。
 */
abstract class TrackedBaseWriter extends BaseSpanWriter {
  /** 指标维度标签；具体 writer 可在终结前补充终态维度（如 terminal_reason）。 */
  protected readonly metricLabels: Attributes;

  /**
   * 构造基类 writer，并把自身挂到父 writer 的终结回调上。
   * 为什么用闭包自引用：父构造回调执行时 `this` 尚未就绪，需先占位再回填。
   * 输入：`onRemoved` 为活动集移除函数；`metrics` 为指标记录器。
   */
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    lifecycle: WriterLifecycleKeys,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    const terminalTarget: { writer?: TrackedBaseWriter } = {};
    super(span, parentContext, metadata, lifecycle, health, (outcome, durationMs, observation) => {
      const writer = terminalTarget.writer;
      if (writer) {
        // 终态 Metric 从 Writer 已记录的实时事实投影，覆盖显式 finish、业务异常、
        // missing_terminal 和进程回收；不能只埋在各 finishXxx 分支里留下缺口。
        writer.safe(() => onRemoved(writer));
        writer.safe(() => writer.recordTerminalDetailMetrics(outcome, observation));
        writer.safe(() =>
          metrics.recordSpanTerminal(
            metadata.spanName as AgentMetricSpanName,
            outcome,
            durationMs,
            terminalMetricLabels(metricLabels, observation),
            observation.abandonReason,
          ),
        );
      }
    });
    terminalTarget.writer = this;
    this.metricLabels = metricLabels;
  }

  /**
   * 以 abandoned 结论放弃本 writer，供运行时按会话/进程批量回收。
   * 口径：原因枚举决定 abandon_reason 属性值；已终结时为空操作。
   */
  abandon(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  /**
   * 子类可覆盖的终态明细指标钩子；默认空实现。
   * 为什么预留钩子：把各 writer 特有的指标（首字节耗时、重试恢复态等）收敛到统一终结回调，
   * 避免只能埋在各 finishXxx 分支里而漏掉 missing_terminal 与进程回收路径。
   */
  protected recordTerminalDetailMetrics(
    _outcome: string,
    _observation: WriterTerminalObservation,
  ): void {}
}

/**
 * 构造 OTel Link，用于表达"逻辑来源"而非父子关系。
 * 输入：`relation` 为稳定的关联语义枚举，写入 `zcode.link.relation` 属性。
 * 输出：只带 SpanContext 与 relation，不复制原始 span 的任何业务属性。
 */
function causationLink(
  causation: AgentTelemetryCausation,
  relation: "spawned_by" | "triggered_by" | "resumed_from",
): Link {
  return {
    attributes: {
      "zcode.link.relation": relation,
    },
    context: spanContextFromCausation(causation),
  };
}

/**
 * Turn 级 writer：记录一次 agent turn 的结束类型与终态。
 * 职责：把业务结束结论（completed/failed/cancelled）映射为统一的 span 属性与指标维度。
 * 口径：resultType 缺省 other；失败阶段限定在 turn 生命周期内的枚举集合。
 */
// TurnWriter 构造函数只把 span/parentContext/metadata 交给 TrackedBaseWriter，并固定 lifecycleKeys("agent_turn")，
// metricLabels/onRemoved 原样透传；finishCompleted 只在闩锁未关时写 "zcode.agent_turn.result_type"（缺省 "other"），
// finishFailed 的 stage 与 finishCancelled 都走基类 IfOpen 路径；finishUnhandled 先 isAbortLike 判取消，避免把用户中止计成失败。
class TurnWriter extends TrackedBaseWriter implements AgentTurnSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("agent_turn"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    resultType: "assistant_message" | "tool_request" | "no_output" | "other" = "other",
  ): void {
    this.finishCompletedIfOpen(() => this.setAttribute("zcode.agent_turn.result_type", resultType));
  }

  finishFailed(
    stage: "setup" | "agent_loop" | "finalize" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    // AbortSignal 触发的异常按取消处理，避免把用户主动取消计成系统失败。
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

/**
 * Step 级 writer：记录单个 agent step 的终态与终止原因。
 * 口径：完成时同步把 terminal_reason 写入指标标签，保证指标与 span 属性口径一致。
 */
class StepWriter extends TrackedBaseWriter implements AgentStepSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("agent_step"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    terminalReason:
      | "model_completed"
      | "tool_requested"
      | "turn_completed"
      | "compaction_requested",
  ): void {
    // 必须在终结前补齐指标维度：finishCompletedIfOpen 一旦抢占闩锁就不能再修改。
    this.metricLabels.terminal_reason = terminalReason;
    this.finishCompletedIfOpen(() =>
      this.setAttribute("zcode.agent_step.terminal_reason", terminalReason),
    );
  }

  /**
   * 以 `discarded` 领域结论终结，用于步骤被跳过/丢弃而非失败的情况。
   * 口径：不设置 SpanStatus.ERROR，避免把正常丢弃计入错误率。
   */
  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "tool" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

/**
 * Tool 级 writer：记录工具调用、权限决策与输出规模，并可派生命令执行 span。
 * 口径：`permission_requested` 事件只发一次，重复标记幂等跳过。
 * 不变量：命令 span 必须挂在工具 span 之下，由注入的 createCommand 保证父链。
 */
// ToolWriter 的固定维度来自构造时传入的 metadata 与 lifecycleKeys("tool_execution")，工具名/调用标识不在终结时改写；
// permissionRequested 布尔量保证 markPermissionRequested 只 addEvent 一次；setPermissionDecision 先写
// "zcode.tool_execution.permission_decision"，仅当曾请求且 decision !== "not_required" 才补 permission_decided；
// startCommand 只把 { ...input, parent: this } 交给注入的 createCommand，父链由 ToolWriter 快照保证。
class ToolWriter extends TrackedBaseWriter implements ToolExecutionSpanWriter {
  /** 权限请求是否已记录；用于事件去重，避免重试或重复调用产生多条事件。 */
  private permissionRequested = false;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createCommand: (
      input: CommandTraceStart & { parent: ToolWriter },
    ) => CommandExecutionSpanWriter,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("tool_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  /**
   * 标记工具调用进入权限审批阶段，只发一次事件。
   * 为什么去重：同一工具可能被重复触发审批，重复事件会让下游统计审批次数偏大。
   */
  markPermissionRequested(): void {
    if (this.permissionRequested) return;
    this.permissionRequested = true;
    this.addEvent("permission_requested");
  }

  /**
   * 记录权限决策结果，并在"曾经请求过审批"时补一条 decided 事件。
   * 口径：`not_required` 不产生 decided 事件，因为没有审批过程可配对。
   */
  setPermissionDecision(decision: "granted" | "denied" | "not_required"): void {
    this.setAttribute("zcode.tool_execution.permission_decision", decision);
    if (this.permissionRequested && decision !== "not_required") {
      this.addEvent("permission_decided", { decision });
    }
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.tool_execution.output_bytes", finiteNonNegative(bytes));
  }

  setOutputTruncated(truncated: boolean): void {
    this.setAttribute("zcode.tool_execution.output_truncated", truncated);
  }

  /**
   * 派生命令执行 span，父 writer 固定为当前工具。
   * 口径：命令输入原样透传，仅补 parent 引用；创建降级由运行时 `safeCreate` 负责。
   */
  startCommand(input: CommandTraceStart): CommandExecutionSpanWriter {
    return this.createCommand({ ...input, parent: this });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  /**
   * 以 `denied` 领域结论终结工具调用，并记录拒绝来源。
   * 口径：拒绝属于策略结论而非系统错误，走 domain outcome 不置 ERROR 状态。
   */
  finishDenied(reason: "user_denied" | "policy_denied" | "unavailable" | "unknown"): void {
    this.finishDomainOutcomeIfOpen("denied", () =>
      this.setAttribute("zcode.tool_execution.permission_denial_reason", reason),
    );
  }

  finishFailed(
    stage:
      | "lookup"
      | "validation"
      | "permission"
      | "pre_hook"
      | "handler"
      | "post_hook"
      | "serialize"
      | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

/**
 * Command 级 writer：记录命令执行的首字节时间、退出状态与输出规模。
 * 口径：首字节时间使用单调时钟差值，仅记录一次；退出码/信号额外写兼容属性。
 * 不变量：`firstOutputMs` 一旦写入不再更新，保证首次输出指标稳定。
 */
class CommandWriter extends TrackedBaseWriter implements CommandExecutionSpanWriter {
  /** 是否已记录首次输出；用于事件与指标去重。 */
  private firstOutput = false;
  /** 首次输出耗时（毫秒）；未产生输出时保持 undefined，终结时不记录该指标。 */
  private firstOutputMs: number | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("command_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  /**
   * 记录命令首次输出及其耗时，仅生效一次。
   * 为什么去重：流式输出会多次回调，重复记录会让首字节指标被后续分片覆盖。
   */
  markFirstOutput(): void {
    if (this.firstOutput) return;
    this.firstOutput = true;
    const elapsed = this.elapsedMs();
    this.firstOutputMs = elapsed;
    this.setAttribute("zcode.command_execution.first_output_ms", elapsed);
    this.addEvent("first_output");
  }

  markTerminationRequested(reason: "cancelled" | "timeout" | "shutdown"): void {
    this.addEvent("termination_requested", { reason });
  }

  /**
   * 记录进程退出码，并同步写入兼容属性（供旧版查询维度使用）。
   * 口径：非安全整数会被丢弃，不写 0 或其他默认值。
   */
  setExitCode(exitCode: number): void {
    const normalized = integer(exitCode);
    this.setAttribute("zcode.command_execution.exit_code", normalized);
    this.setAttributes(commandCompatibilityAttributes({ exitCode: normalized }));
  }

  /**
   * 记录终止信号，并同步写入兼容属性。
   * 口径：信号名经 `safeIdentifier` 校验，允许 `-` 与 `/`，非法值整条丢弃。
   */
  setSignal(signal: string): void {
    const normalized = safeIdentifier(signal);
    this.setAttribute("zcode.command_execution.signal", normalized);
    this.setAttributes(commandCompatibilityAttributes({ signal: normalized }));
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.command_execution.output_bytes", finiteNonNegative(bytes));
  }

  setTimedOut(timedOut: boolean): void {
    this.setAttribute("zcode.command_execution.timed_out", timedOut);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "prepare" | "spawn" | "execute" | "timeout" | "collect_output" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  /**
   * 命令转后台时以 `backgrounded` 领域结论终结：执行权已移交，主链路不再等待。
   * 口径：不置 ERROR；后续结果由后台任务自行记录。
   */
  finishBackgrounded(): void {
    this.finishDomainOutcomeIfOpen("backgrounded");
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  /**
   * 终结时上报首次输出耗时指标；未产生任何输出则跳过。
   * 为什么放在终态钩子：无论命令是完成、失败还是被放弃，只要测到首字节都应上报一次。
   */
  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    if (this.firstOutputMs === undefined) return;
    this.metrics.recordCommandFirstOutput(
      this.firstOutputMs,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
    );
  }
}

/**
 * Compaction 级 writer：记录上下文压缩的 token 口径与回退选择。
 * 口径：输入/输出 token 只接受非负有限值；回退事件携带归一化后的原因枚举。
 */
class CompactionWriter extends TrackedBaseWriter implements ContextCompactionSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("context_compaction"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setInputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.input_tokens", finiteNonNegative(tokens));
  }

  setOutputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.output_tokens", finiteNonNegative(tokens));
  }

  /**
   * 记录压缩回退选择事件，用于区分主模型失败后切换到备用策略的场景。
   * 口径：原因经 `safeEnum` 归一化，非法值整条丢弃。
   */
  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeEnum(reason) });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "parse" | "commit" | "fallback" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

/**
 * Detached 级 writer：记录后台/游离操作的结果类型与终态。
 * 口径：resultType 为受控枚举，仅表达结果形态，不承载任意文本。
 */
class DetachedWriter extends TrackedBaseWriter implements DetachedOperationSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("detached_operation"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  /**
   * 记录后台操作的结果形态（文本/布尔/元数据/其他）。
   * 口径：受控枚举直写，不承载实际返回内容，避免大对象进入 trace。
   */
  setResultType(resultType: "text" | "boolean" | "metadata" | "other"): void {
    this.setAttribute("zcode.detached_operation.result_type", resultType);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "schedule" | "execute" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

/**
 * 逻辑模型调用 writer：跨多次 attempt 维护尝试次数与重试恢复口径。
 * 口径：`attemptCount` 每次派生 attempt 时递增；`hadFailedAttempt` 由失败的 attempt 回写。
 * 不变量：logicalCallId/operation/modelRole 构造后只读，供子 attempt span 继承维度。
 */
// ModelCallWriter 的 logicalCallId/operation/modelRole 在构造后只读，子 attempt 从这里继承维度；
// attemptCount 与 hadFailedAttempt 是仅有的可变状态：startAttempt 先自增再 createAttempt(this, input)，
// recordAttemptFailed 只置位不计数（失败次数由 attemptCount 与终态推导）；markFallbackSelected 写 fallback_selected 事件。
class ModelCallWriter extends TrackedBaseWriter implements ModelCallSpanWriter {
  /** 已派生的 attempt 数量；用于重试状态与 attempts 指标。 */
  private attemptCount = 0;
  /** 是否出现过失败 attempt；仅用于区分 recovered / not_recovered。 */
  private hadFailedAttempt = false;
  /** 逻辑调用标识；缺失表示上游未提供，不参与指标维度拼接。 */
  readonly logicalCallId: string | undefined;
  /** 模型角色（如 main/aux）；缺失表示未指定。 */
  readonly modelRole: string | undefined;
  /** 模型操作类型（chat_completions 等）；缺失表示未识别。 */
  readonly operation: string | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createAttempt: (
      writer: ModelCallWriter,
      input: ModelAttemptTraceStart,
    ) => ModelAttemptSpanWriter,
    logicalCallId: string | undefined,
    operation: string | undefined,
    modelRole: string | undefined,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_call"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
    this.logicalCallId = logicalCallId;
    this.operation = operation;
    this.modelRole = modelRole;
  }

  /**
   * 派生子 attempt span，并累加尝试计数。
   * 为什么计数在派生处统一累加：重试可能由不同上游路径触发，集中计数避免漏算。
   */
  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter {
    this.attemptCount += 1;
    return this.createAttempt(this, input);
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeString(reason, 128) });
  }

  /**
   * 由失败 attempt 回写"曾失败"标记，供终态推导重试恢复口径。
   * 只置位不计数：失败次数由 attemptCount 与终态推导，避免与 attempt 计数重复。
   */
  recordAttemptFailed(): void {
    this.hadFailedAttempt = true;
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  /**
   * 终结时上报逻辑调用的尝试次数与重试恢复状态。
   * 口径：单次尝试记 not_needed；多次且最终成功记 recovered；否则 not_recovered。
   * 为什么放在终态钩子：确保放弃/异常收尾也能产出该指标，不留统计缺口。
   */
  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    const retryState =
      this.attemptCount <= 1
        ? "not_needed"
        : outcome === "completed" && this.hadFailedAttempt
          ? "recovered"
          : "not_recovered";
    this.metrics.recordModelCallAttempts(
      this.attemptCount,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
        retry_state: retryState,
      }),
    );
  }
}

/**
 * 单次模型尝试 writer：记录首包/首内容/首文本时间、流停滞与 token 用量。
 * 口径：时间点均相对 writer 起始的单调时钟；token 采用"取最大值"语义处理累计上报。
 * 不变量：每个首事件只记录一次；token 序列必须单调非降，回退值被忽略。
 */
class ModelAttemptWriter extends TrackedBaseWriter implements ModelAttemptSpanWriter {
  /** 是否已记录首个内容分片；用于去重。 */
  private firstContent = false;
  /** 首内容耗时（毫秒）；未出现则 undefined，终结时不上报。 */
  private firstContentMs: number | undefined;
  /** 是否已收到首个 provider 事件（如响应头）；用于去重。 */
  private firstProviderEvent = false;
  /** 首 provider 事件耗时（毫秒）；未出现则 undefined。 */
  private firstProviderEventMs: number | undefined;
  /** 是否已收到首段文本；用于去重。 */
  private firstText = false;
  /** 首文本耗时（毫秒）；未出现则 undefined。 */
  private firstTextMs: number | undefined;
  /** 流停滞次数；用于终态明细指标。 */
  private stallCount = 0;
  /** 观测到的最大停滞时长（毫秒）；用于评估卡顿严重程度。 */
  private streamMaxIdleMs = 0;
  /** 累计 token 用量（单位：token）；作为去重基线，用于计算增量指标。 */
  private readonly usage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    private readonly onAttemptFailed: () => void,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_attempt"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setProviderRequestId(requestId: string): void {
    this.setAttribute("zcode.model_attempt.provider_request_id", safeString(requestId, 256));
  }

  setResponseModel(model: ResponseModelTelemetryDescriptor): void {
    const value = safeString(model.model, 128);
    this.setAttribute("zcode.model_attempt.response_model", value);
    this.setAttributes(modelResponseCompatibilityAttributes({ responseModel: value }));
  }

  setEffectiveReasoningState(state: ModelReasoningState): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_state", safeEnum(state));
  }

  setEffectiveReasoningControl(control: ModelReasoningControlType): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_control", safeEnum(control));
  }

  setEffectiveReasoningLevel(level: string): void {
    this.setAttribute("zcode.model_attempt.reasoning_effective_level", safeString(level, 128));
  }

  setEffectiveReasoningBudgetTokens(tokens: number): void {
    this.setAttribute(
      "zcode.model_attempt.reasoning_effective_budget_tokens",
      finiteNonNegative(tokens),
    );
  }

  setFinishReason(reason: ModelFinishReason): void {
    const value = safeString(reason, 128);
    this.setAttribute("zcode.model_attempt.finish_reason", value);
    this.setAttributes(modelResponseCompatibilityAttributes({ finishReason: value }));
  }

  setInputTokens(tokens: number): void {
    this.setUsage("inputTokens", "input", tokens, "zcode.model_attempt.input_tokens");
    this.setAttributes(modelResponseCompatibilityAttributes({ inputTokens: tokens }));
  }

  setOutputTokens(tokens: number): void {
    this.setUsage("outputTokens", "output", tokens, "zcode.model_attempt.output_tokens");
    this.setAttributes(modelResponseCompatibilityAttributes({ outputTokens: tokens }));
  }

  setReasoningTokens(tokens: number): void {
    this.setUsage("reasoningTokens", "reasoning", tokens, "zcode.model_attempt.reasoning_tokens");
  }

  setCacheReadTokens(tokens: number): void {
    this.setUsage("cacheReadTokens", "cache_read", tokens, "zcode.model_attempt.cache_read_tokens");
  }

  setCacheWriteTokens(tokens: number): void {
    this.setUsage(
      "cacheWriteTokens",
      "cache_write",
      tokens,
      "zcode.model_attempt.cache_write_tokens",
    );
  }

  setStreamOutputCommitted(committed: boolean): void {
    this.setAttribute("zcode.model_attempt.stream_output_committed", committed);
  }

  setHttpStatusCode(statusCode: number): void {
    const normalized = integer(statusCode);
    this.setAttribute("zcode.model_attempt.http_status_code", normalized);
    this.setAttributes(httpResponseCompatibilityAttributes(statusCode));
  }

  setProviderErrorCode(code: string): void {
    this.setAttribute("zcode.model_attempt.provider_error_code", safeString(code, 128));
  }

  setProviderErrorMessage(message: string): void {
    this.setAttribute("zcode.model_attempt.provider_error_message", sanitizeErrorMessage(message));
  }

  setRetryAfterMs(delayMs: number): void {
    this.setAttribute("zcode.model_attempt.retry_after_ms", finiteNonNegative(delayMs));
  }

  /**
   * 记录首个 provider 事件及其耗时，仅生效一次。
   * 口径：该时间点是"开始收到响应"的最早证据，用于区分建连慢与首包慢。
   */
  markFirstProviderEvent(): void {
    if (this.firstProviderEvent) return;
    this.firstProviderEvent = true;
    const elapsed = this.elapsedMs();
    this.firstProviderEventMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_provider_event_ms", elapsed);
    this.addEvent("first_provider_event");
  }

  /**
   * 记录首个内容分片及其耗时，仅生效一次。
   * 口径：只统计真正有响应的时刻，不区分内容类型（文本或工具调用）。
   */
  markFirstContent(): void {
    if (this.firstContent) return;
    this.firstContent = true;
    const elapsed = this.elapsedMs();
    this.firstContentMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_content_ms", elapsed);
    this.addEvent("first_content");
  }

  /**
   * 记录首段文本及其耗时，仅生效一次。
   * 与 firstContent 并存：用于区分"有响应"与"有可见文本"两种体验口径。
   */
  markFirstText(): void {
    if (this.firstText) return;
    this.firstText = true;
    const elapsed = this.elapsedMs();
    this.firstTextMs = elapsed;
    this.setAttribute("zcode.model_attempt.time_to_first_text_ms", elapsed);
    this.addEvent("first_text");
  }

  /**
   * 记录一次流停滞事件，并累计次数与最大停滞时长。
   * 口径：非法的 idleMs 直接忽略，不写入也不计数；均值为派生值，不在此计算。
   */
  markStreamStalled(idleMs: number): void {
    const normalized = finiteNonNegative(idleMs);
    if (normalized === undefined) return;
    this.stallCount += 1;
    this.streamMaxIdleMs = Math.max(this.streamMaxIdleMs, normalized);
    this.addEvent("stream_stalled", { idle_ms: normalized });
  }

  /**
   * 转发请求观测数据（安全校验结果等）到 span 属性/事件。
   * 口径：本 writer 只提供写入适配器，具体字段与脱敏由 recordRequestObservation 决定。
   */
  recordRequestObservation(observation: ModelRequestObservation): void {
    recordRequestObservation(
      {
        setAttribute: (name, value) => this.setAttribute(name, value),
        addEvent: (name, attributes) => this.addEvent(name, attributes),
      },
      observation,
    );
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelAttemptFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    // 先通知父 Call 记"曾失败"，再终结本 attempt：顺序保证父级指标能反映真实重试历史。
    this.onAttemptFailed();
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.onAttemptFailed();
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  /**
   * 写入 token 用量并上报"增量"指标，同时写 span 属性。
   * 输入：`value` 为累计上报的 token 数；`field` 是上次值基线，`tokenType` 为指标维度。
   * 口径：仅当新值不小于旧值时才更新并上报增量；回退值（如上游统计修正）直接忽略，
   * 避免产生负增量污染指标与重复累加。
   */
  private setUsage(
    field: keyof ModelAttemptWriter["usage"],
    tokenType: ModelTokenType,
    value: number,
    attribute: string,
  ): void {
    const normalized = finiteNonNegative(value);
    if (normalized === undefined) return;
    const delta = normalized - this.usage[field];
    if (delta < 0) return;
    this.usage[field] = normalized;
    this.safe(() => this.metrics.recordModelTokenDelta(tokenType, delta, this.metricLabels));
    this.setAttribute(attribute, normalized);
  }

  /**
   * 终结时上报尝试级明细指标（首包/首内容/首文本耗时、停滞次数与最大停滞）。
   * 口径：未出现的首事件保持 undefined，由指标层决定是否跳过，而非填 0。
   */
  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    this.metrics.recordModelAttemptDetail(
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
      {
        firstContentMs: this.firstContentMs,
        firstProviderEventMs: this.firstProviderEventMs,
        firstTextMs: this.firstTextMs,
        stallCount: this.stallCount,
        streamMaxIdleMs: this.streamMaxIdleMs,
      },
    );
  }
}

/**
 * 从父 writer 快照继承关联信息，构造子 writer 的元数据。
 * 口径：correlation 与 toolCallId 直接引用父级，不做拷贝或补默认值；`spanName` 由调用方指定。
 * 缺失值语义：父级为空时只保留 spanName，等价于一个根 writer。
 */
function inheritedMetadata(
  parent: ActiveWriterContext | undefined,
  spanName: string,
): Omit<ActiveWriterContext, "activeContext" | "span"> {
  return {
    correlation: parent?.correlation,
    parent,
    spanName,
    toolCallId: parent?.toolCallId,
  };
}

/**
 * 按 span 名生成该 writer 的生命周期属性键集合。
 * 口径：统一前缀 `zcode.<spanName>`，八个键一一对应 `WriterLifecycleKeys`。
 * 不变量：同一 span 类型必须始终使用同一前缀，否则同一 Span 的终结属性会分裂成两套。
 */
function lifecycleKeys(spanName: string): WriterLifecycleKeys {
  const prefix = `zcode.${spanName}`;
  return {
    abandonReason: `${prefix}.abandon_reason`,
    cancelReason: `${prefix}.cancel_reason`,
    errorCategory: `${prefix}.error_category`,
    errorCode: `${prefix}.error_code`,
    errorMessage: `${prefix}.error_message`,
    errorType: `${prefix}.error_type`,
    failureStage: `${prefix}.failure_stage`,
    outcome: `${prefix}.outcome`,
  };
}

/**
 * 兜底异常分类器：在业务未显式给出 category 时，从异常结构推断错误类别。
 * 输入：任意异常；非对象或空值直接归为 unknown。
 * 口径：优先看 `status`/`statusCode` 数值（401/403→authentication，408/504→timeout，429→rate_limit），
 * 再看 `code` 文本中的稳定关键字（timeout/network/econn/enotfound/tls）。
 * 失败语义：本函数不抛错；无法识别时返回 unknown，绝不根据 message 文本猜测。
 */
function classifyErrorCategory(error: unknown): AgentTelemetryErrorCategory {
  if (isAbortLike(error)) return "cancelled";
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  const code = String(record.code ?? "").toLowerCase();
  if (code.includes("timeout")) return "timeout";
  if (
    code.includes("network") ||
    code.includes("econn") ||
    code.includes("enotfound") ||
    code.includes("tls")
  ) {
    return "network";
  }
  return "unknown";
}

/**
 * 所有 NOOP writer 共享的最小 scope 实现：causation 恒为 undefined，run 直接执行业务。
 * 为什么共享：降级对象必须零分配、零副作用，并保证业务回调照常执行。
 */
const NOOP_SCOPE = {
  captureCausation: () => undefined,
  run: <T>(execute: () => T): T => execute(),
};

/**
 * 命令 span 的空实现：容量耗尽或创建失败时返回，所有方法无副作用。
 */
const NOOP_COMMAND_WRITER: CommandExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishBackgrounded() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstOutput() {},
  markTerminationRequested() {},
  setExitCode() {},
  setOutputBytes() {},
  setSignal() {},
  setTimedOut() {},
};

/**
 * 工具 span 的空实现；派生命令时继续返回 NOOP，保证降级链路不产生真实 span。
 */
const NOOP_TOOL_WRITER: ToolExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDenied() {},
  finishFailed() {},
  markPermissionRequested() {},
  setOutputBytes() {},
  setOutputTruncated() {},
  setPermissionDecision() {},
  startCommand: () => NOOP_COMMAND_WRITER,
};

/**
 * Step span 的空实现。
 */
const NOOP_STEP_WRITER: AgentStepSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
};

/**
 * Turn span 的空实现。
 */
const NOOP_TURN_WRITER: AgentTurnSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
};

/**
 * 上下文压缩 span 的空实现。
 */
const NOOP_COMPACTION_WRITER: ContextCompactionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
  markFallbackSelected() {},
  setInputTokens() {},
  setOutputTokens() {},
};

/**
 * 游离操作 span 的空实现。
 */
const NOOP_DETACHED_WRITER: DetachedOperationSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  setResultType() {},
};

/**
 * 模型尝试 span 的空实现：覆盖全部 setter/mark 方法，避免降级调用时报缺方法。
 */
const NOOP_MODEL_ATTEMPT_WRITER: ModelAttemptSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstContent() {},
  markFirstProviderEvent() {},
  markFirstText() {},
  markStreamStalled() {},
  recordRequestObservation() {},
  setCacheReadTokens() {},
  setCacheWriteTokens() {},
  setEffectiveReasoningBudgetTokens() {},
  setEffectiveReasoningControl() {},
  setEffectiveReasoningLevel() {},
  setEffectiveReasoningState() {},
  setFinishReason() {},
  setHttpStatusCode() {},
  setInputTokens() {},
  setOutputTokens() {},
  setProviderErrorCode() {},
  setProviderErrorMessage() {},
  setProviderRequestId() {},
  setReasoningTokens() {},
  setResponseModel() {},
  setRetryAfterMs() {},
  setStreamOutputCommitted() {},
};

/**
 * 模型调用 span 的空实现；派生 attempt 时继续返回 NOOP。
 */
const NOOP_MODEL_CALL_WRITER: ModelCallSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFallbackSelected() {},
  startAttempt: () => NOOP_MODEL_ATTEMPT_WRITER,
};

/**
 * 完全关闭遥测时的运行时替代实现：不创建 span、不记录指标，只保证接口可用。
 * 职责：让业务代码无需判空即可调用所有 trace 方法。
 * 输出：所有 `startXxx` 返回共享 NOOP writer；`captureCausation` 返回 undefined。
 * 副作用：无。
 * 不变量：返回对象必须是单例常量，避免高频调用反复分配。
 */
export class NoopAgentExecutionTelemetry
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  abandonSession(): void {}
  captureCausation() {
    return undefined;
  }
  startCall(): ModelCallSpanWriter {
    return NOOP_MODEL_CALL_WRITER;
  }
  startCompaction(): ContextCompactionSpanWriter {
    return NOOP_COMPACTION_WRITER;
  }
  startDetachedOperation(): DetachedOperationSpanWriter {
    return NOOP_DETACHED_WRITER;
  }
  startStep(): AgentStepSpanWriter {
    return NOOP_STEP_WRITER;
  }
  startTool(): ToolExecutionSpanWriter {
    return NOOP_TOOL_WRITER;
  }
  startTurn(): AgentTurnSpanWriter {
    return NOOP_TURN_WRITER;
  }
}
