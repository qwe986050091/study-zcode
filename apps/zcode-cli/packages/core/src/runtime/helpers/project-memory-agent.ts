// ============================================================
// project-memory-agent —— project Memory 后台链路的“模型调用上下文”装配
// ============================================================
//
// 【职责】Extraction / Dream / Recall 都复用同一套后台 agent 执行能力；
//   本文件负责从主 runtime 捕获一次不可变上下文快照，并据此构造
//   provider 请求与受限的工具执行器。
//
// 【为什么需要快照】
//   后台链路在 turn 边界被调度、等主 turn 继续推进后才执行。若直接持有 runtime
//   并实时读取 messageHistory / readFileState，会看到“未来”的状态。
//   因此这里立即复制（浅快照）：providerEntries、readFileState、tools。
//   快照成立的前提是 RuntimeMessageEntry 进入 MessageHistory 后不可原地修改。
//
// 【边界】
//   - 只使用调用方传入的 model，不自行降级选择别的 Provider；
//   - 工具集剔除 ToolSearch（Memory 链路不使用历史检索工具）；
//   - 权限一律 deny：后台链路不得触达需要用户授权的操作。
//
// 【副作用】无持久化；不向前端 emit 事件（executor 的 emitEvent 是 no-op）。
// 【失败/降级】各步骤不吞错，由上层 telemetry 统一记录完成 / 取消 / 失败。
// ============================================================
import type { Model, ModelToolContract, TraceContext } from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@zcode/contracts";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { prepareRuntimeProviderRequest } from "./runtime-provider-request-messages.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";

/**
 * project Memory 后台链路的不可变执行上下文快照。
 */
export interface ProjectMemoryAgentContext {
  /** 产生本次工作的 turn 的因果链，用于 telemetry 归属。 */
  causation?: AgentTelemetryCausation;
  /** 该 workspace 的 Memory 根目录；后台工具读写都被限制在此范围内。 */
  memoryRoot: string;
  /** 捕获时刻的 runtime 条目浅快照；后台只能读取，禁止原地修改。 */
  providerEntries: readonly RuntimeMessageEntry[];
  /** 主 runtime 的会话中系统消息配置，保证请求投影与主链路一致。 */
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  /** 实际使用的模型（Extraction 继承 turn model；Dream/Recall 用会话模型）。 */
  model: Model;
  /** 计费 / 遥测用的模型操作类型。 */
  operation: ModelApiOperation;
  /** 捕获时刻“已读文件”的副本，用于 Edit 前置校验；不随主链路变化。 */
  readFileState: ReadFileStateMap;
  /** 过滤后的工具契约快照（已剔除 ToolSearch）。 */
  tools: readonly ModelToolContract[];
  /** 本次后台请求的 trace 上下文。 */
  traceContext: TraceContext;
  /** 执行工具时的工作目录（Bash cd 后的 cwd，不影响 Memory 身份）。 */
  workingDirectory: string;
  /** 会话 workspace 根目录，用于路径边界解析。 */
  workspaceRoot: string;
}

/**
 * 捕获 project Memory 后台链路的执行上下文快照。
 * 输入：runtime + memoryRoot / model（可选）/ operation / traceContext。
 * 输出：ProjectMemoryAgentContext。
 * 副作用：无落盘；会创建模型包装（withModelInvocationContext），使本次调用
 *   不写 transcript（skipTranscript: true），避免后台链路自反馈。
 * 降级：未传 model 时按当前会话选择创建 runtime model（不切换 Provider）。
 * 不变量：providerEntries / readFileState / tools 均为副本，
 *   后台任务不能回写主链路状态。
 */
export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    /** Extraction 继承产生该工作的 Turn Model。 */
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, (request) => ({
    // Extraction 是 transcript 的消费者；不把它自己的请求写回同一 model-io 目录，
    // 避免后台链路占用 rollout 槽位并在后续 Extraction 中自反馈。
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
      skipTranscript: true,
    },
    modelCall: { operation: input.operation },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: input.traceContext,
    }),
    traceContext: input.traceContext,
  }));
  return {
    causation: runtime.agentTelemetry.captureCausation(),
    memoryRoot: input.memoryRoot,
    // Extraction 会跨异步边界消费这份成员浅快照；它依赖 RuntimeMessageEntry
    // 进入 MessageHistory 后保持不可变。后续只能 append、整体 replace 或 copy-on-write，
    // 禁止原地修改共享的 entry/message/content，否则会污染已调度的 Memory 上下文。
    providerEntries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    midConversationSystem: runtime.config.midConversationSystem,
    model,
    operation: input.operation,
    readFileState: new Map(runtime.readFileState),
    // Memory 的既有执行策略不允许 ToolSearch；历史引用只在此请求投影中降级。
    tools: runtime
      .getTools(model)
      .filter((tool) => tool.name !== "ToolSearch")
      .map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

/**
 * 用快照上下文构造 provider 请求。
 * 输入：上下文 + 本次 prompt。
 * 输出：provider 请求对象。
 * 语义：复用主链路的 prepareRuntimeProviderRequest，但只带 Memory 侧的工具与
 *   midConversationSystem 配置，并开启 cache control 以复用缓存前缀。
 * 副作用：无（纯投影）。
 */
export function prepareProjectMemoryAgentRequest(
  context: ProjectMemoryAgentContext,
  prompt: string,
) {
  return prepareRuntimeProviderRequest(
    {
      config: { midConversationSystem: context.midConversationSystem },
    },
    {
      applyCacheControl: true,
      entries: context.providerEntries,
      model: context.model,
      prompt,
      tools: context.tools,
    },
  ).request;
}

/**
 * 为 Memory 后台链路创建受限的工具执行器。
 * 输入：runtime + 上下文快照。
 * 输出：可执行 toolCall 的 executor。
 * 副作用：执行工具会读写文件 / 执行命令；emitEvent 是 no-op，不向前端推送事件。
 * 安全边界：permissionBroker 固定 deny，即后台 agent 不能做需要用户授权的动作；
 *   readFileState 使用快照副本，避免后台读取反过来污染主链路的已读状态。
 */
export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // Memory agent 必须继承 Main 已完成的 Read；否则 provider context 说文件已读，
    // Edit 执行边界却会拒绝同一文件，和基线的 cloned tool context 不一致。
    readFileState: new Map(context.readFileState),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}
