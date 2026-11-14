import type { RequestVerificationReason } from "@zcode/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { ModelApiCallObservation } from "../telemetry/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
} from "./index.js";

/**
 * Runtime 与 Adapter 之间的调用级执行信息。
 *
 * 它不属于业务 ModelRequest，也不允许普通调用方据此改变 Provider 或模型身份。
 * Runtime 只在统一模型调用边界设置，Adapter 在同一异步调用链内读取。
 *
 * 生产者：runtime 的模型调用入口（turn step、工具内部调用、压缩、标题 sidecar）
 * 通过 `runWithModelInvocationContext` 注入一次，随后整条物理请求重试链共享。
 * 消费者：adapter 的 runner 在每次 attempt 前读取预算/准入/statusSink/trace，
 * 用于事件投递、重试决策与归因，不能据此替换 provider/model 身份。
 *
 * 跨异步不变量：这里存的是 AsyncLocalStorage 值，不是请求级可变快照；
 * 可跨重试复用的是纯事实（trace、session 分类、预算、准入端口、调用分类）；
 * 鉴权材料必须在每个 attempt 重新解析（见 `refreshRuntimeHeadersBeforeAttempt`），
 * 不得把 apiKey/headers 缓存在本上下文中。流式响应即使在被创建回调之外消费，
 * 也必须保留同一上下文（见 runWithModelInvocationContext 的迭代器包装）。
 */
export interface ModelInvocationContext {
  /** 请求附带的只读元数据；序列化请求应把 traceId 放这里，而不是依赖运行时对象。 */
  metadata?: Record<string, unknown>;
  /** 调用分类事实（operation/actorKind/logicalCallId）；由 runtime 决定，adapter 只读取上报。 */
  modelCall?: ModelApiCallObservation;
  /** 宿主 session 粗分类；adapter 写入受控归因 header，不允许调用方覆盖。 */
  modelRequestSessionType?: ModelRequestSessionType;
  /** 重试预算档位；runtime 按 taskType 决定，adapter 据此放宽瞬态失败的放弃条件。 */
  modelRetryBudget?: ModelRetryBudget;
  /** 准入端口；runtime 从 deps 带入，adapter 每次尝试先 acquire。 */
  modelRequestAdmission?: ModelRequestAdmission;
  /** 本轮所有 attempt 共用的状态出口；事件只用于观测，不能反过来改变请求结果。 */
  statusSink?: ModelStatusSink;
  /** 统一追踪上下文；异步任务必须沿用，不得中途另造 traceId。 */
  traceContext?: TraceContext;
  /** 仅用于 SSE idle 超时的递增退避；是“第几次重试”的运行时事实，不持久化。 */
  streamIdleTimeoutRetryNumber?: number;
  /** 流恢复的归因事实；只进状态/遥测，不发送给 provider。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /** compact 隐藏流专用开关；保留 provider 流边界 provenance，不影响工具输入提交。 */
  preserveProviderStreamBoundaries?: boolean;
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    attempt: number;
    reason?: RequestVerificationReason;
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

/** Adapter 为单个物理请求 attempt 使用的动态鉴权材料。 */
/**
 * Adapter 为单个物理请求 attempt 使用的动态鉴权材料。
 *
 * 生产者：`ModelRequestAuthSource.resolve` 或 `refreshRuntimeHeadersBeforeAttempt`
 * 在每个 attempt 前解析/刷新后返回。
 * 消费者：adapter 把 apiKey 或 headers 合入该次请求；不得跨 attempt 复用旧值。
 *
 * 不变量：这是 runtime-only 的高敏对象，禁止进入 ModelRequest、日志、遥测或持久化；
 * accountScope 只用于作用域校验，不是身份展示字段。
 */
export interface ModelRequestAuth {
  /** 账号作用域键；用于确认刷新后的凭据仍属于同一账号。 */
  accountScope?: string;
  /** 单次请求使用的密钥正文；禁止打印或序列化。 */
  apiKey?: string;
  /** 密钥的稳定标识（可上报），用于区分轮换来源，不含密钥正文。 */
  apiKeyId?: string;
  /** 直接注入的受控请求头；调用方静态 headers 不能覆盖归因头。 */
  headers?: Record<string, string>;
}

/**
 * 鉴权来源的解析输入：描述“为哪一次 attempt、哪个 provider/model 解析”。
 *
 * 生产者：adapter 的 runner 在每次物理请求前组装。
 * 消费者：`ModelRequestAuthSource.resolve` 按 attempt 决定是否换用新凭据。
 * 不变量：attempt 从 1 开始且每次重试递增；abortSignal 表示调用方取消，
 * resolve 必须响应取消而不是发起不可中断的等待。
 */
export interface ModelRequestAuthSourceInput {
  attempt: number;
  abortSignal?: AbortSignal;
  providerId: string;
  modelId: string;
  traceContext?: TraceContext;
}

/** Model 创建时绑定、在每个物理请求 attempt 前解析的执行作用域鉴权来源。 */
/**
 * Model 创建时绑定、在每个物理请求 attempt 前解析的执行作用域鉴权来源。
 *
 * 生产者：bootstrap/host 在构建 Active Model 时注入（依赖请求时登录态或账号池）。
 * 消费者：adapter 的 runner 每次 attempt 调用 resolve；返回值只作用于该 attempt。
 * 不变量：resolve 允许返回 undefined（表示当前 attempt 无可用鉴权），
 * 是否 fail-closed 由 `ModelRequestDependencies.requestAuth` 的存在性决定；
 * 实现不得把结果缓存到跨请求的单例，否则账号切换会沿用旧密钥。
 */
export interface ModelRequestAuthSource {
  resolve(input: ModelRequestAuthSourceInput): Promise<ModelRequestAuth | undefined>;
}

/**
 * 模型句柄的依赖声明：只暴露“是否需要请求级鉴权”，不暴露凭据本身。
 *
 * 生产者：Active Model 工厂在创建句柄时填充。
 * 消费者：adapter 据此决定缺失 source 时是 fail-closed 还是按静态配置放行。
 * 不变量：`requestAuth` 属性“存在”即代表当前 Model 必须取得请求级鉴权，
 * source 缺失同样按 fail-closed 处理；不能用 undefined 与空对象表达两种语义。
 */
export interface ModelRequestDependencies {
  /** 属性存在表示当前 Model 必须取得请求级鉴权；Source 缺失同样 fail-closed。 */
  requestAuth?: {
    source?: ModelRequestAuthSource;
  };
}

const modelInvocationStorage = new AsyncLocalStorage<ModelInvocationContext>();

/**
 * 读取当前异步调用链上绑定的执行上下文；不在绑定作用域内返回 undefined。
 *
 * 生产者：AsyncLocalStorage 的当前 store（由 runWithModelInvocationContext 写入）。
 * 消费者：adapter 的 runner/transport 在发请求、投递状态事件、决定重试预算时读取。
 * 不变量：返回的是共享引用，调用方只能读，不得就地修改（否则会污染同一链路的
 * 其他 attempt）；跨 await/流迭代时上下文由 ALS 自动延续，无需手工传递。
 */
export function getCurrentModelInvocationContext(): ModelInvocationContext | undefined {
  return modelInvocationStorage.getStore();
}

/**
 * 在指定执行上下文内运行回调；若返回值是异步迭代器，则把上下文“粘”到每次迭代上。
 *
 * 生产者：runtime 的统一模型调用边界（一次调用只设置一次）。
 * 消费者：adapter 的同步调用与流式消费；测试用它验证流在回调外消费仍可读取上下文。
 * 不变量：普通返回值原样透传；AsyncIterable 会被包装成新的迭代器，next/return/throw
 * 都在同一 ALS 作用域内执行，否则流消费阶段的 attempt 会丢失 traceId/预算/statusSink。
 * 包装只影响读取上下文，不改变迭代语义、错误传播或完成状态。
 */
export function runWithModelInvocationContext<T>(context: ModelInvocationContext, run: () => T): T {
  const result = modelInvocationStorage.run(context, run);
  if (!isAsyncIterable(result)) return result;

  const source = result;
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: (value?: unknown) =>
          modelInvocationStorage.run(context, () => iterator.next(value as never)),
        return: (value?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.return
              ? iterator.return(value as never)
              : Promise.resolve({ done: true, value }),
          ),
        throw: (error?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error),
          ),
      };
    },
  } as T;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}
