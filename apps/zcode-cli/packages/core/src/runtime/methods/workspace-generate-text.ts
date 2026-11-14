// INV-01 不创建回合：守住位置 不写消息历史；改错故障 辅助调用污染对话。
// INV-02 流必须见完成事件：守住位置 完成标志；改错故障 半截响应当成功。
// INV-03 错误事件即抛：守住位置 事件分支；改错故障 失败被流吞掉。
// INV-04 探测只用一 token：守住位置 绑定上限；改错故障 连通性检查白等推理。
// INV-05 探测提示词固定：守住位置 常量；改错故障 探测混入会话内容。
// INV-06 无信号才加超时：守住位置 空值合并；改错故障 覆盖调用方更短的中止。
// INV-07 辅助档位只给提交信息：守住位置 来源判断；改错故障 其他调用被降档。
// INV-08 输入非空才请求：守住位置 校验函数；改错故障 空请求打到提供者。
// INV-09 请求事件先落盘：守住位置 追加顺序；改错故障 失败时看不到发起内容。
// INV-10 消息先复制再发：守住位置 映射复制；改错故障 上游改写影响记账。
// INV-11 usage 从事件切片：守住位置 起始下标；改错故障 归因混入历史事件。
// INV-12 失败也记 usage 再抛：守住位置 捕获分支；改错故障 失败被改写成成功。
// INV-13 完成事件只在成功发：守住位置 调用位置；改错故障 失败也发完成事件。
// INV-14 回显调用方选择：守住位置 返回值；改错故障 调用方误判档位被改写。
// INV-15 预算只认调用方提供：守住位置 来源判断；改错故障 伪造固定上限。
// INV-16 遥测独立于回合：守住位置 分离上报器；改错故障 面板出现悬空操作。
// INV-17 取消与失败分开归因：守住位置 中止判断；改错故障 用户取消被记成失败。
// INV-18 遥测收尾必执行：守住位置 两条完成路径；改错故障 异常时没有结束事实。
//
// 模块职责：工作区级一次性文本生成与模型连通性探测。
// 状态所有权：不持有状态，仅向会话事件流追加请求与完成事实。
// 阅读顺序：先看连通性探测，再看生成包装与遥测，最后看实现细节。
/**
 * ============================================================================
 * runtime/methods/workspace-generate-text.ts —— 工作区级辅助模型调用（无 turn）
 * ============================================================================
 * 【定位】给 git commit message、连接性测试等提供一次性文本生成；不创建 turn、
 *   不进 messageHistory，只发 ModelRequest/ModelComplete 事件并记录 usage。
 * 【关键点】60s 硬超时、探测固定 1 token、git_commit_message 走辅助档位且不接预算参数。
 * 【关键不变量】#2：流必须在 finish 后结束才算成功；半截输出不能当可用结果。
 * ============================================================================
 */
import {
  SessionEventType,
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  ModelInputMessage,
  ModelSelection,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { normalizeStreamError } from "../helpers/index.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";

// 辅助调用是同步等待型（用户在等 commit message / 连接结果），必须有硬超时兜底。
const WORKSPACE_GENERATE_TEXT_TIMEOUT_MS = 60_000;
// 探测只回答“能不能通”，1 token 足够；预算留大会白等推理与输出。
const CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS = 1;
// 探测请求使用固定最小 prompt，避免多余推理开销；不可改写角色、文本或混入会话历史。
const CONNECTIVITY_PROBE_SYSTEM = "You are ZCode connectivity probe.";
const CONNECTIVITY_PROBE_USER = "hi";
const GIT_COMMIT_MESSAGE_QUERY_SOURCE = "git_commit_message";

export interface WorkspaceGenerateTextInput {
  selection: ModelSelection;
  prompt?: string;
  messages?: ModelInputMessage[];
  tools?: ModelToolContract[];
  querySource: string;
  maxOutputTokens?: number;
}

export interface WorkspaceGenerateTextResult {
  text: string;
  selection: ModelSelection;
  finishReason: string;
  usage?: ModelUsage;
  toolCalls?: ModelToolCall[];
}

export interface ModelConnectivityTestInput {
  selection: ModelSelection;
}

// 连通性测试用 createRuntimeModel(scope:"workspace") 绑定最低公开档位，不占用户选择。
// maxOutputTokens 固定为 1：只要能返回就说明通道可用，正文本身没有诊断价值。
// 子 trace 上挂 provider 与 model 两个标签，方便按模型筛连通性失败。
// 调用方没给 abortSignal 时自建 AbortController，超时即中止。
// 流在超时前没等到 model_complete 事件，就按失败返回。
export async function testModelConnectivity(
  this: AgentRuntimeInternal,
  input: ModelConnectivityTestInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<void> {
  const baseModel = createRuntimeModel(this, { selection: input.selection, scope: "workspace" });
  // 连接探测不需要生成正文；复用辅助生成的 5,000 预算会等待多余推理和输出。
  // 独立限制为 1 Token，仍使用最低公开档位，不改变其他辅助调用的预算。
  const model = baseModel.bind({
    reasoningLevel: baseModel.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS,
  });
  // 子 trace 带 provider/model/querySource，把探测调用与正式请求区分开，便于排障。
  const traceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: "provider_settings_connectivity",
    },
  });
  // 调用方没给 signal 时用一次性超时，避免设置页的连通性检查永久挂起。
  const abortSignal =
    options?.abortSignal ?? AbortSignal.timeout(WORKSPACE_GENERATE_TEXT_TIMEOUT_MS);
  const request: ModelRequest = {
    abortSignal,
    messages: [
      { role: "system", content: CONNECTIVITY_PROBE_SYSTEM },
      { role: "user", content: CONNECTIVITY_PROBE_USER },
    ],
  };
  let finished = false;
  await runWithModelInvocationContext(
    {
      metadata: traceContextToLogContext(traceContext),
      modelCall: { operation: "workspace_generate_text" },
      statusSink: this.createModelStatusSink(traceContext, []),
      traceContext,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext,
      }),
    },
    async () => {
      for await (const event of model.streamText(request)) {
        // provider 失败被包成 error 事件而不是 reject；这里归一化后再抛，防止失败被流吞掉。
        if (event.type === "error") throw normalizeStreamError(event.error);
        // 只有 finish 才算成功；中途 EOF 不能证明这次请求完成。
        if (event.type === "finish") finished = true;
      }
    },
  );
  // 没有 finish = 流被提前截断；宁可报失败也不能把半截响应当作连接正常。
  if (!finished) throw new Error("模型连通性测试流在 finish 事件前结束");
}

// 入口先过 zod 校验 input，非法参数在动模型之前就抛。
// 遥测操作名按 querySource 分叉，提交信息与通用生成各记各的。
// 成功上报带 result 与字符数，便于看输出规模。
// AbortError 记成 cancelled，不算失败。
// 其余异常记 failed 再原样重抛，调用方拿到的错误不变。
export async function generateWorkspaceText(
  this: AgentRuntimeInternal,
  input: WorkspaceGenerateTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<WorkspaceGenerateTextResult> {
  assertWorkspaceModelInput(input);
  const querySource = input.querySource.trim() || "workspace_generate_text";
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  // 遥测独立于 turn：成功/取消/失败都必须落一条结束事实，否则面板出现悬空操作。
  const operationTelemetry = this.agentTelemetry.detached({
    executionKind: "foreground",
    operation:
      querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
        ? "workspace_git_commit_message"
        : "workspace_generate_text",
    targetKind: "workspace",
    trigger: "user",
    traceContext,
  });
  return operationTelemetry.run(async () => {
    // 取消与失败的归因口径不同：abort 记 cancelled，其余一律 failed 后原样抛出。
    try {
      const result = await generateWorkspaceTextImpl.call(this, input, options);
      operationTelemetry.setResultType("text");
      operationTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        operationTelemetry.finishCancelled("abort_signal");
      } else {
        operationTelemetry.finishFailed("execute", "unknown", error);
      }
      throw error;
    }
  });
}

// 只有 GIT_COMMIT_MESSAGE_QUERY_SOURCE 走辅助档位，其余用调用方给的模型。
// model_request 事件先 push 进 events，再发请求。
// events 同时作为归因来源，失败时按最后一个事件判断停在哪一步。
// 失败分支先写 usage 账再抛出，保证失败也有 token 记录。
// 成功分支先 push model_complete 再记账，事件顺序与账一致。
async function generateWorkspaceTextImpl(
  this: AgentRuntimeInternal,
  input: WorkspaceGenerateTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<WorkspaceGenerateTextResult> {
  // wrapper 已校验一次；直接调用 impl 的路径（测试/内部）也必须守住同一输入契约。
  assertWorkspaceModelInput(input);
  const requestedSelection = input.selection;
  const querySource = input.querySource.trim() || "workspace_generate_text";
  const baseModel = createRuntimeModel(this, { selection: requestedSelection, scope: "workspace" });
  // 辅助请求需要的是最低公开档位，不是扫描 off/nothink 等名称后强制关闭。
  // 只有 git_commit_message 用辅助档位；其它 querySource 原样使用调用方 selection。
  const model =
    querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
      ? baseModel.bind(auxiliaryModelOptions(baseModel))
      : baseModel;
  const baseTraceContext = options?.traceContext ?? this.rootTraceContext;
  const modelTraceContext = createChildTraceContext(baseTraceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource,
    },
  });

  const events: SessionEvent[] = [];
  // 复制 messages 再发出：请求事件与 usage 记账共用同一份快照，避免被上游后续改写。
  const messages: ModelInputMessage[] = input.messages
    ? input.messages.map((message) => ({ ...message }))
    : [{ role: "user", content: input.prompt!.trim() }];
  const tools = input.tools ?? [];
  // 请求事件记录“实际发给模型”的内容与 tool 数，供回放与排障。
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: tools.length,
    },
    modelTraceContext,
  );
  // 先落投影事实再请求模型：即使请求失败，也能看到当时发起了什么。
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  events.push(modelRequestEvent);

  const modelStartedAt = Date.now();
  // usage 归因只统计本条请求产生的事件，从当前长度开始切分。
  const networkEventStartIndex = events.length;
  // 同样以 60s 兜底：没有调用方 signal 时不能无限等待辅助生成。
  const abortSignal =
    options?.abortSignal ?? AbortSignal.timeout(WORKSPACE_GENERATE_TEXT_TIMEOUT_MS);
  // Git Commit 调用方曾传入固定 256，Core 又按 querySource 丢弃，形成虚假接口。
  // 通用生成入口只处理调用方真实提供的预算；Git 辅助调用不再由上游伪造固定上限。
  const requestMaxOutputTokens =
    querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE ? undefined : input.maxOutputTokens;

  // maxOutputTokens 只取 input.maxOutputTokens，不叠加默认值。
  // 值为 undefined 时整个字段不出现，避免把「没设」传成 0。
  // tools 缺省为空数组，模型请求里按无工具处理。
  // messages 是独立副本，后续追加不会改到调用方的数组。
  // abortSignal 原样透传给模型请求，取消能一路传到底。
  // 模型只收到展开后的 options，看不到 select 这一层包装。
  const modelRequest = {
    abortSignal,
    messages,
    tools,
    ...(requestMaxOutputTokens === undefined
      ? {}
      : { options: { maxOutputTokens: requestMaxOutputTokens } }),
  };

  const result = await runWithModelInvocationContext(
    {
      metadata: traceContextToLogContext(modelTraceContext),
      modelCall: {
        operation:
          querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
            ? "workspace_git_commit_message"
            : "workspace_generate_text",
        ...(querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE && model.options.reasoningLevel
          ? { reasoning: { requestedLevel: model.options.reasoningLevel } }
          : {}),
      },
      statusSink: this.createModelStatusSink(modelTraceContext, events),
      traceContext: modelTraceContext,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext: modelTraceContext,
      }),
    },
    () => model.generateText(modelRequest),
  ).catch(async (error: unknown) => {
    // 失败也要记 usage/错误事实；记账完成后必须重抛，不能把失败改写成成功。
    await recordModelUsageFact(this, {
      error,
      events,
      model,
      networkEventStartIndex,
      querySource,
      startedAt: modelStartedAt,
      status: "error",
      traceContext: modelTraceContext,
    });
    throw error;
  });

  const toolCalls = this.extractToolCallsFromResult(result);
  // 只有正常返回才发 ModelComplete；stopReason 直接取模型的 finishReason。
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: result.text,
      querySource,
      stopReason: result.finishReason,
      toolCallCount: toolCalls.length,
      usage: result.usage,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);
  // 本次 events 同时供 usage 归因：request/complete 与 usage 必须能对上。
  await recordModelUsageFact(this, {
    events,
    model,
    networkEventStartIndex,
    querySource,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
    traceContext: modelTraceContext,
  });

  // 回显调用方传入的 selection，不返回绑定后的模型身份，避免调用方误以为档位被改写。
  return {
    text: result.text,
    selection: {
      providerId: requestedSelection.providerId,
      modelId: requestedSelection.modelId,
      ...(requestedSelection.options ? { options: { ...requestedSelection.options } } : {}),
    },
    finishReason: result.finishReason,
    usage: result.usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function assertWorkspaceModelInput(input: WorkspaceGenerateTextInput): void {
  // 空 prompt/空 messages 无法构成请求；提前失败优于发空请求再让 provider 报错。
  if (input.messages && input.messages.length > 0) return;
  if (input.prompt?.trim()) return;
  throw new Error("模型文本生成 prompt 或 messages 不能为空");
}
