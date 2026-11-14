/**
 * ============================================================================
 * runtime-model.ts —— 从 runtime 配置创建可调用 Model 的工厂入口
 * ============================================================================
 *
 * 【层级】本文件产出的是"裸 Model 句柄"，之上再由 turn-model 叠加：
 *   runtime-model（本文件）：Factory 选择 + 调用上下文层（sessionType/retryBudget/admission）
 *   turn-model：叠加"每次 attempt 前刷新运行时请求头" + off-peak 绑定
 *
 * 【为什么要 withRuntimeInvocationLayer】
 *   准入端口与重试预算回答的是"谁在调"（哪个 runtime、允许多少次重试），
 *   而调用点自己传的上下文回答"为什么调"（step/compact/title）。
 *   如果把前者只在 turn step 注入，WebSearch/compress/title 等 sidecar 调用点
 *   就会绕过准入闸门（实测漏掉大量 429）。因此"谁在调"在句柄创建时绑定一次。
 *
 * 【合并顺序】调用时 `{...当前上下文, ...createContext(request)}`：
 *   本层（句柄）覆盖调用层，且 bind 会递归重包，保证换 options 后仍然生效。
 * ============================================================================
 */

import type { ModelRequestSessionType, ModelRetryBudget } from "@zcode/contracts";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";

/**
 * 创建 runtime 作用域的 Model。
 *
 * selection 允许 undefined 进入函数是为了让执行入口（turn-model）给出更友好的
 * recoverable ConfigurationError；Factory 契约本身仍要求 selection 必填
 * （见下方 throw）。scope=workspace 表示请求借用会话 runtime 但属于工作区级
 * 独立请求，sessionType 记为 other，避免污染会话级限流分类。
 */
export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * 覆盖按 taskType 解析的重试预算，只绑定到本次创建的句柄，不进入 Factory 输入。
     * 目前只有带 selectionFallback 声明的执行作用域 Selection 使用 single-attempt。
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  // 失败处理:selection 为空时抛 ConfigurationError(recoverable=true),
  // 让 UI 提示用户先选模型而不是崩溃;不静默降级(降级会用错误模型执行)。
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  const model = withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
  );
  // off-peak 绑定:闲时模式下用绑定的模型覆盖;无绑定时返回原 model。
  // 失败处理:wrap 失败(如绑定模型不可用)会在实际请求时暴露,不在创建时预判。
  return getOffPeakModelBinding(input.requestDependencies)?.wrap(model) ?? model;
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget?: ModelRetryBudget,
): Model {
  const layer: ModelInvocationContext = {
    // 原因：标题、Memory、工具调用曾按用途覆写 other，丢失宿主分类。
    // 会话类型统一绑定在句柄上；工作区独立请求即使借用会话 runtime 也保持 other。
    modelRequestSessionType: sessionType,
    // 带退回声明的执行句柄显式传入 single-attempt，其余沿用 taskType 默认预算。
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      // 维护不变量#5:modelRequestAdmission 绑定到 runtime 句柄,保证同一 runtime 的所有
      // 模型请求(含 sidecar)都经过同一准入闸门,不会被调用点绕过。
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withModelInvocationContext(model, () => layer);
}

/**
 * 把"调用上下文工厂"包到 Model 上。
 *
 * bind() 必须递归重包：Model 换 options（例如调 reasoning level）后会产生新对象，
 * 若只包最外层，bind 之后的请求就丢失准入/重试预算。
 *
 * generateText / streamText 在**发起时**才调用 createContext(request)，
 * 这样上下文能拿到本次 request 的 abortSignal 等字段；同时先展开当前上下文，
 * 保证调用点已设置的其他字段（trace、用途）不被覆盖丢失。
 */
export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    requestCapabilities: model.requestCapabilities,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      // 递归重包:model.bind(options) 产生新对象,必须重新包一层,
      // 否则换 options 后的请求丢失准入/重试预算上下文。
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      // 合并顺序:先展开当前上下文,再叠加 createContext(request)。
      // 本层(runtime 句柄)压过调用层,保证准入/重试预算不被调用点覆写丢失。
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
