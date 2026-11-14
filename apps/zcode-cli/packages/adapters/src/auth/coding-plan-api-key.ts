import { AsyncLocalStorage } from "node:async_hooks";
import {
  isHttpClientPortError,
  type HttpClientPort,
  type HttpClientRunOptions,
  type TraceContext,
} from "@zcode/contracts";
import {
  ProjectAccessTokenClient,
  ProjectAccessTokenTransientError,
  resolveBigModelApiOrigin,
  type ProjectAccessTokenMaterial,
} from "@zcode/shared";
import { ZaiBusinessTokenCache, type ZaiBusinessToken } from "./zai-business-token-cache.js";

/*
 * ============================================================
 * auth / coding-plan-api-key.ts —— Coding Plan 短时项目 Token 换取
 *
 * 定位：把登录态 OAuth token 换成短期「项目访问 token」（PAT），并负责 zai 业务 JWT
 * 的单飞缓存、401 失效重试与调用方取消语义。
 *
 * 输入输出：resolve 返回可直接用于请求的 token 字符串；resolveMaterial 额外返回
 * token 的指纹等物化信息（供 401 去重/条件失效）。family 决定走 zai 双跳还是 bigmodel 单跳。
 *
 * 副作用：网络请求（zai 登录 + 项目 token）、locationStore 读写（可能缓存选择位置）、
 * 进程内缓存（业务 JWT 与 PAT client）、observe 观测回调。
 *
 * 失败语义：网络/超时→ProjectAccessTokenTransientError（可重试）；429/5xx→Transient；
 * 401/403 等→CodingPlanApiKeyError；zai 登录失败→project_token_login_failed；
 * clear() 后旧任务以 project_token_scope_invalidated 失败，避免把过期代际写回。
 *
 * 不变量：换证单飞不继承调用方 signal（取消只影响等待者）；业务 JWT 只有明确 401
 * 才失效；凭据 token 不入日志。
 * ============================================================
 */

const BUSINESS_AUTH_MAX_ATTEMPTS = 2;
const SINGLE_ATTEMPT = 1;
const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const ZAI_API_HOST = "https://api.z.ai";
/** 换证路径：bigmodel 直接用 OAuth token；zai 需先换业务 JWT 再取 PAT。 */
export type CodingPlanFamily = "bigmodel" | "zai";
export interface CodingPlanApiKeyResolverOptions {
  /** 必须注入的 HTTP 端口，统一超时/代理/trace。 */
  httpClient: HttpClientPort;
  /** 默认 trace 上下文，单次调用可被 input.trace 覆盖。 */
  trace?: TraceContext;
  /** 项目选择位置的持久化端口；缺省时由 ProjectAccessTokenClient 用内存态。 */
  locationStore?: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** 观测回调（stage=resolve），code 为稳定枚举串而非自由文本。 */
  observe?(event: { family: string; stage: "resolve"; code: string }): void;
}
export interface ResolveCodingPlanApiKeyInput {
  /** 登录态 OAuth access token，必填；空白视为未登录。 */
  accessToken: string;
  /** 换证路径，见 CodingPlanFamily。 */
  family: CodingPlanFamily;
  /** 账号维度标识，用于项目选择缓存隔离；缺省回退 family。 */
  accountIdentity?: string;
  /** 上次被 401 拒绝的 PAT 指纹，用于避免重复选中同一失效 token。 */
  rejectedProjectTokenFingerprint?: string;
  /** 单次调用的 trace，优先级高于 options.trace。 */
  trace?: TraceContext;
}
export interface CodingPlanApiKeyResolver {
  /** 返回可直接发送的短期 token 字符串。 */
  resolve(input: ResolveCodingPlanApiKeyInput, options?: HttpClientRunOptions): Promise<string>;
  /** 同 resolve，但保留完整物化信息（token + 指纹等）。 */
  resolveMaterial(
    input: ResolveCodingPlanApiKeyInput,
    options?: HttpClientRunOptions,
  ): Promise<ProjectAccessTokenMaterial>;
  /** 清空所有缓存并推进代际；进行中的旧换证会以 scope_invalidated 失败。 */
  clear(): void;
}
export class CodingPlanApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingPlanApiKeyError";
  }
}

/**
 * 创建进程级换证器（建议 CLI 内单例）。
 *
 * 内部维护：AsyncLocalStorage 传递单次调用的 context/trace/业务 JWT；ZaiBusinessTokenCache
 * 单飞业务 JWT；ProjectAccessTokenClient 负责 PAT 选择与缓存；generation 做代际失效。
 *
 * 副作用：网络都经注入的 httpClient；观测只通过 observe 回调，不写文件。
 * 失败语义：见文件头；clear() 后旧代际的任何阶段都会抛 scope_invalidated。
 */
/** CLI 进程内唯一换证入口；保留旧导出名兼容调用方，返回值已是短期 Token。 */
export function createCodingPlanApiKeyResolver(
  options: CodingPlanApiKeyResolverOptions,
): CodingPlanApiKeyResolver {
  const execution = new AsyncLocalStorage<{
    context?: HttpClientRunOptions["context"];
    trace?: TraceContext;
    business?: ZaiBusinessToken;
  }>();
  const businessTokens = new ZaiBusinessTokenCache(() =>
    options.observe?.({
      family: "zai",
      stage: "resolve",
      code: "project_token_business_login_refresh_deferred",
    }),
  );
  /**
   * 统一网络出口：映射瞬时故障、识别业务 JWT 的 401 失效、解析 JSON。
   *
   * 404 作为“无选中项目”的可恢复信号返回 {code:404}；429/5xx 抛 Transient；
   * 其他非 2xx 抛 request_failed。所有请求 64KB 上限、15s 超时并带 trace。
   */
  const request = async (url: string, init: RequestInit) => {
    const response = await options.httpClient
      .request(
        {
          url,
          method: init.method === "POST" ? "POST" : "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(typeof init.body === "string" ? { body: new TextEncoder().encode(init.body) } : {}),
          maxResponseBytes: 64 * 1024,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
          trace: execution.getStore()?.trace ?? options.trace,
        },
        { context: execution.getStore()?.context },
      )
      .catch((error: unknown) => {
        if (
          isHttpClientPortError(error) &&
          (error.code === "network_error" || error.code === "timeout")
        )
          throw new ProjectAccessTokenTransientError();
        throw error;
      });
    if (response.status === 401 && new URL(url).pathname.startsWith("/api/biz/")) {
      const run = execution.getStore();
      if (
        run?.business &&
        new Headers(init.headers).get("Authorization") === `Bearer ${run.business.token}`
      )
        businessTokens.invalidate(run.business);
    }
    if (response.status === 404) return { code: 404 };
    if (response.status === 429 || (response.status >= 500 && response.status < 600))
      throw new ProjectAccessTokenTransientError();
    if (response.status < 200 || response.status >= 300)
      throw new CodingPlanApiKeyError("project_token_request_failed");
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  };
  const client = new ProjectAccessTokenClient({
    request,
    observe: options.observe,
    locationStore: options.locationStore,
  });
  let generation = 0;
  /**
   * 实际换证流程（可能两跳）：校验 OAuth token →（zai）换业务 JWT → 取 PAT。
   *
   * 每次跨 await 后核对 generation，clear() 推进后立即中止，防止旧凭据写回；
   * 只有明确被拒绝的业务 JWT 才触发一次重登重试。失败分类见文件头。
   */
  const resolveMaterial = async (
    input: ResolveCodingPlanApiKeyInput,
  ): Promise<ProjectAccessTokenMaterial> => {
    const oauth = input.accessToken.trim();
    if (!oauth) throw new CodingPlanApiKeyError("project_token_login_required");
    const capturedGeneration = generation;
    const maxAttempts = input.family === "zai" ? BUSINESS_AUTH_MAX_ATTEMPTS : SINGLE_ATTEMPT;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (generation !== capturedGeneration)
        throw new CodingPlanApiKeyError("project_token_scope_invalidated");
      const business =
        input.family === "zai"
          ? await businessTokens
              .resolve(oauth, () =>
                request(`${ZAI_API_HOST}/api/auth/z/login`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ token: oauth }),
                }),
              )
              .catch(() => {
                options.observe?.({
                  family: input.family,
                  stage: "resolve",
                  code: "project_token_login_failed",
                });
                throw new CodingPlanApiKeyError("project_token_login_failed");
              })
          : undefined;
      if (generation !== capturedGeneration)
        throw new CodingPlanApiKeyError("project_token_scope_invalidated");
      const loginToken = business?.token ?? oauth;
      const run = execution.getStore();
      if (run) run.business = business;
      try {
        const result = await client.resolve({
          origin: input.family === "zai" ? ZAI_API_HOST : resolveBigModelApiOrigin(process.env),
          family: input.family,
          loginToken,
          accountId: input.accountIdentity ?? input.family,
          personalProjectSelection: "default",
          rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
        });
        if (generation !== capturedGeneration)
          throw new CodingPlanApiKeyError("project_token_scope_invalidated");
        return result;
      } catch (error) {
        // 只恢复业务 JWT 的明确 HTTP 401；不把模型 401、403 或网络故障猜成过期。
        if (!business || !businessTokens.wasRejected(business)) throw error;
        businessTokens.invalidate(business);
        if (attempt + 1 === maxAttempts) throw error;
        options.observe?.({
          family: input.family,
          stage: "resolve",
          code: "project_token_business_login_refresh",
        });
      }
    }
    throw new CodingPlanApiKeyError("project_token_request_failed");
  };
  /**
   * 把换证包在 AsyncLocalStorage 里并桥接调用方 AbortSignal。
   *
   * 单飞属于鉴权 owner：context 只保留 trace/logger，不透传会话 signal；调用方取消只
   * 影响它自己的等待，共享换证继续完成并写缓存。
   */
  const resolveForCaller = (
    input: ResolveCodingPlanApiKeyInput,
    runOptions?: HttpClientRunOptions,
  ) =>
    waitForProjectToken(
      () =>
        execution.run(
          {
            // 单飞属于鉴权 owner，不继承会话 signal 或 context.abortSignal；只保留观测上下文。
            context: runOptions?.context
              ? { trace: runOptions.context.trace, logger: runOptions.context.logger }
              : undefined,
            trace: input.trace ?? runOptions?.context?.trace,
          },
          () => resolveMaterial(input),
        ),
      runOptions?.signal,
    );
  return {
    resolveMaterial: resolveForCaller,
    /** 只把 material.token 暴露给调用方，隐藏指纹等内部字段。 */
    async resolve(input, runOptions) {
      const value = await resolveForCaller(input, runOptions);
      return value.token;
    },
    /** 推进代际并清空业务 JWT/PAT 缓存：登出/换账号时调用，保证旧结果无法回填。 */
    clear() {
      generation++;
      businessTokens.clear();
      client.clear();
    },
  };
}

/** 仅取消当前调用方的等待；底层 Promise 始终有拒绝处理器，不误伤共享换证。 */
async function waitForProjectToken<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  const value = await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
  signal.throwIfAborted();
  return value;
}
