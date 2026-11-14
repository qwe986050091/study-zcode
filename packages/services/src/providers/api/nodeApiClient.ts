// 文件头不变量表（NodeApiClient，深度注入口径见 DEEP-SPEC v1）：
// INV-01：所有发往 ZCode endpoint origin 的请求都必须带来源头（守住位置：resolveRequestHeaders /
//   withZCodeEndpointHeaders）；漏注入会让 OAuth/config/billing/snapshot 链路被后端按来源拒绝。
// INV-02：取消只有一种语义，timeoutMs、调用方 signal 与共享核验 controller 都以 AbortError 收口
//   （守住位置：request 的 signal 合成与 catch）；把超时降级成普通 Error 会让上层无法区分重试与放弃。
// INV-03：业务凭据只允许在「有证据」时判定失效（守住位置：confirmBusinessCredentialInvalid、
//   readBusinessAuthenticationResponse）；误判会登出仍然有效的登录态，属于用户可见的破坏性故障。
// INV-04：businessValidations 中每条共享核验的生命周期由 subscribers 计数唯一决定（守住位置：finally 块）。
import {
  ApiError,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
  type ApiClient,
  type ApiRequestInit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildZCodeSourceHeaders } from "../sourceHeaders.js";
import { withRequestIdHeader } from "./requestIdHeaders.js";

// 进程级 logger：NodeApiClient 同时被桌面宿主与 CLI 复用，固定 scope 保证检索口径一致。
// 该 logger 只允许输出 header key 与状态码，任何调用点泄出 Authorization 都按安全缺陷处理。
const log = createServiceLogger("node-api-client");

// 依赖注入点全部可选：CLI 与测试不需要 transport 观察器，只有桌面宿主装配 JWT/业务失效回调。
// 默认实现必须能独立工作，否则 web 端复用时会被迫传入与自身职责无关的选项。
interface NodeApiClientOptions {
  fetchImpl?: typeof fetch;
  onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  isZcodeJwtRequest?: (input: string | URL, headers: Headers) => boolean | Promise<boolean>;
  isBusinessUnauthorizedRequest?: (
    input: string | URL,
    headers: Headers,
  ) => boolean | Promise<boolean>;
  businessUnauthorizedObservationTimeoutMs?: number;
  resolveBusinessCredentialValidationRequest?: (
    input: string | URL,
    headers: Headers,
  ) => Promise<{ url: string; authorization: string; emptyBodyMeansInvalid: boolean } | null>;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  /** 宿主内存里的实时界面语言；同步读取，未注入或无值时 X-Client-Language 回退进程 Intl locale。 */
  resolveClientLanguage?: () => string | undefined;
}

// 观察器预算独立于请求超时：核验是旁路 best-effort，不能把用户请求拖到同一个 deadline 上。
// 字节上限用来丢弃 HTML 登录页、代理错误页这类异常大响应，避免无界读入后再做判定。
const DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS = 1000;
const MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES = 64 * 1024;

// 把已经发出的 promise 接到 AbortSignal 上：fetch 之外的共享核验没有原生取消能力，
// 缺这一层时订阅者取消后 transport 仍占着连接直到 deadline，Windows 上会耗尽 Handler 句柄。
function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
// [并发] 先挂监听再补查 aborted：只做前置检查会在检查与注册之间丢事件，已取消的 signal 永远等不到 reject。
// 补查时先 cleanup 再 abort，保证同一 signal 上即使触发也不能留下重复的一次性监听。
// promise 正常 settle 的路径同样 cleanup，否则长生命周期 signal（宿主 session 级）会累积监听器。
    if (signal.aborted) {
      cleanup();
      abort();
    }
  });
}

// 单次 read 必须有独立上限：reader.read() 在流停滞时不会返回，外层只剩 deadline 也无法中断它。
// race 的 null 分支与 reject 都归为 null，调用方据此放弃观察，而不是把停流误读成认证失效。
function readChunkWithinTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
// [资源] timer 在 finally 中清除：done、超限与异常提前返回时同样必须释放 setTimeout，
// 否则短命的观察器会把事件循环多续一秒，测试进程收不住，CLI 退出被拖慢。
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return waitWithAbort(Promise.race([reader.read(), timeout]), signal)
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

// 方法名统一大写后参与日志与错误构造：后端与 ApiError 消费者都按大写匹配，大小写不一致会路由到不同处理器。
function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

// 该观察器只回答一个问题：响应体是否证明凭据失效；任何不确定都返回 null（保留登录）。
// [失败路径] 恒不抛：调用点位于 request 主路径，抛出会把「认证观察」变成「请求失败」。
// 读取 response.clone()，原 body 仍归调用方消费；因此观察器不能依赖流结束事件，只能有界读取。
async function readBusinessAuthenticationResponse(
  response: Response,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<"unauthorized" | "empty" | null> {
  // 业务接口把登录过期封装成 HTTP 200，不能只看 status；读副本避免抢走调用方正文。
  // continuous SSE 没有完整 JSON 正文，观察器不能等待流结束或引入恢复语义。
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
    return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal?.aborted) return null;
// [资源] clone 出独立流：原 response.body 必须完整交给上层，观察器读完会让调用方拿到已消费的流。
// clone 失败（body 已被读走或被 tee 破坏）会落到 catch，按「无证据」处理。
    const body = response.clone().body;
    if (!body) return "empty";
    reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let bytes = 0;
    let text = "";
// 循环每轮重算剩余预算：单轮 read 可能吃满 deadline，用固定超时会累计放大总耗时。
// 任一异常分支都 return null 而不是 break，避免半截 JSON 被当成可解析证据。
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      const result = await readChunkWithinTimeout(reader, remainingMs, signal);
      if (!result) return null;
      if (result.done) break;
      if (!result.value) return null;
      bytes += result.value.byteLength;
// 超限直接放弃而不是截断解析：截断后的 JSON 可能仍能解析出 code，从而伪造失效证据。
// 但 bytes === 0 是另一回事，它由下方单独映射为 empty，供空正文判定使用。
      if (bytes > MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES) return null;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    if (bytes === 0) return "empty";
// [失败路径] JSON.parse 对空串/HTML/损坏正文都会抛，由外层 catch 统一转 null；
// 这里不降级为「宽松匹配 401 字符串」，否则代理页里出现的 401 字样会被当成失效证据。
    const payload: unknown = JSON.parse(text);
    return typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      payload.code === 401
      ? "unauthorized"
      : null;
  } catch {
    // 空正文/HTML/损坏 JSON 只能证明请求异常，不能据此清理登录态。
    return null;
  } finally {
    // 观察副本是 best-effort；超时、超限或解析失败时及时取消，不能占用连接。
// [资源] 观察副本是 best-effort：超时、超限、解析失败与正常读完都必须 cancel，否则连接被挂住。
// cancel 的 rejection 被吞掉：此时已经没有可用的错误通道，冒泡只会变成 unhandledRejection。
// 该 finally 不等待 cancel 完成，避免收尾路径被底层流的慢关闭阻塞。
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

// 只导出排序后的 header key：排序让同一请求的日志稳定可比，也避免 Headers 迭代顺序影响快照断言。
// 该函数是调试日志的唯一入口，返回值不得包含任何 header 值。
function readHeaderKeys(headers: RequestInit["headers"] | undefined): string[] {
  if (!headers) {
    return [];
  }
  return [...new Headers(headers).keys()].sort();
}

// 只按 origin 判定，不比较 pathname：endpoint 可能带 base path，逐段比较会把同源业务请求漏掉。
// 相对 URL 或非法字符串在 new URL 处抛出，返回 false 即「不属于本 endpoint」，绝不抛给调用方。
function isRequestForEndpoint(input: string | URL, endpointOrigin: string): boolean {
  try {
    return new URL(resolveUrl(input)).origin === normalizeZCodeEndpointOrigin(endpointOrigin);
  } catch {
    return false;
  }
}

// [权衡] 先铺来源头、再逐项覆盖调用方 headers：顺序反过来会让调用方传入的旧线头保留在默认值上。
// 覆盖只能 set 不能 delete，保证调用方永远无法剥掉来源头。
function withZCodeEndpointHeaders(
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
  clientLanguage: string | undefined,
): RequestInit["headers"] {
  const next = new Headers(buildZCodeSourceHeaders({ clientLanguage }));
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      next.set(key, value);
    });
  }

// 只改写仍等于编译期默认值的 Referer：调用方显式指定的来源必须原样保留，否则代理会看错来源。
// 该比较放在合并之后，因此 buildZCodeSourceHeaders 的默认值同样会被纠正。
// [权衡] 不做无条件 set，是为了让自定义 endpoint 的调试请求仍能携带手工 Referer。
  if (next.get("HTTP-Referer") === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    next.set("HTTP-Referer", endpointOrigin);
  }
  return next;
}

// 非本 endpoint 请求原样返回调用方 headers（连对象都不复制）：第三方 URL 不应携带 ZCode 来源头。
// 该函数是 INV-01 的唯一注入点，新增业务链路只要走 request 就自动获得来源头。
function resolveRequestHeaders(
  requestInput: string | URL,
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
  clientLanguage: string | undefined,
): RequestInit["headers"] | undefined {
  if (!isRequestForEndpoint(requestInput, endpointOrigin)) {
    return headers;
  }

  // ZCode 后端请求以前只有部分业务路径手动补来源头。
  // 统一在 ApiClient 出口按 endpoint origin 注入，避免 OAuth/config/billing/snapshot 等链路遗漏。
  return withZCodeEndpointHeaders(headers, endpointOrigin, clientLanguage);
}

// 所有可变状态都收敛在这一个实例里：宿主每个窗口一份，跨窗口共享会破坏 authority 与代际隔离。
// request 无状态，但业务核验表有状态，因此该类不能被当作纯函数式的 fetch 包装随意复制。
// 对外只暴露 ApiClient 契约与 stop/restart 等宿主方法（见 ManagedCuaProductHelperHost 的同类模式）。
export class NodeApiClient implements ApiClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  private readonly resolveClientLanguage?: NodeApiClientOptions["resolveClientLanguage"];
  private readonly onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  private readonly isZcodeJwtRequest?: NodeApiClientOptions["isZcodeJwtRequest"];
  private readonly isBusinessUnauthorizedRequest?: NodeApiClientOptions["isBusinessUnauthorizedRequest"];
  private readonly businessUnauthorizedObservationTimeoutMs: number;
  private readonly resolveBusinessCredentialValidationRequest?: NodeApiClientOptions["resolveBusinessCredentialValidationRequest"];
// [并发] 共享核验表：同一 (url, authorization) 的并发探测必须合并成一次 transport，避免 401 风暴时线性放大请求。
// 条目内保存 promise 而不是结果，是为了让后到订阅者直接 await 同一在途核验；保存 controller 才能在其后取消。
// subscribers 计数是唯一回收条件：先到先等，最后一个离开才 abort，防止提前取消影响仍在等待的请求。
// 该 Map 只由单线程事件循环访问，无需额外锁；但 await 之间必须重读 entry，不能缓存过期引用。
  private readonly businessValidations = new Map<
    string,
    {
      promise: Promise<boolean>;
      controller: AbortController;
      subscribers: number;
    }
  >();

// 构造期只做赋值，不发请求、不读配置：宿主可能在 app ready 之前构造，任何 I/O 都会拖慢启动。
// authority 之类的身份材料同理延后到首次使用，避免构造失败污染整个 provider 初始化。
  constructor(options: NodeApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.onZcodeJwtInvalid = options.onZcodeJwtInvalid;
    this.isZcodeJwtRequest = options.isZcodeJwtRequest;
    this.isBusinessUnauthorizedRequest = options.isBusinessUnauthorizedRequest;
    this.resolveBusinessCredentialValidationRequest =
      options.resolveBusinessCredentialValidationRequest;
    this.businessUnauthorizedObservationTimeoutMs =
      options.businessUnauthorizedObservationTimeoutMs ??
      DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS;
    this.resolveZCodeEndpointOrigin = options.resolveZCodeEndpointOrigin;
    this.resolveClientLanguage = options.resolveClientLanguage;
  }

// 这是「业务 200 但凭据失效」的最后一道闸：只有 identity 端点用同一凭据成功判负才允许登出。
// [失败路径] 任何前置条件不满足（无解析器、已取消、URL 不可解析）都返回 false，宁可留着登录态。
// 同 URL 直接复用当前响应的 empty 证据，不再发探测：避免对同一端点做无意义的自我请求。
// 返回 true 才会触发 onZcodeJwtInvalid；该函数本身不产生副作用（除共享核验缓存）。
  private async confirmBusinessCredentialInvalid(
    input: string | URL,
    headers: Headers,
    response: Response,
    evidence: "unauthorized" | "empty" | null,
    signal?: AbortSignal | null,
  ): Promise<boolean> {
// 入口即检查取消：后续会发网络请求并可能登出，已取消的调用不应再产生任何全局副作用。
    if (signal?.aborted) return false;
    const check = await this.resolveBusinessCredentialValidationRequest?.(input, headers);
    if (!check || signal?.aborted) return false;
    const requestUrl = new URL(input),
      identityUrl = new URL(check.url);
    if (requestUrl.origin === identityUrl.origin && requestUrl.pathname === identityUrl.pathname)
      return response.status === 200 && evidence === "empty" && check.emptyBodyMeansInvalid;
// [并发] 键里必须同时包含 url 与 authorization：只按 url 合并会让不同凭据共享核验结果，
// 旧凭据失效的结论会误伤刚轮换的新 token。JSON 数组形式避免分隔符拼接产生的键碰撞。
// 该键只存在内存 Map 中，不落盘、不进日志，凭据不外泄。
    const key = JSON.stringify([check.url, check.authorization]);
    let entry = this.businessValidations.get(key);
    if (!entry) {
      const controller = new AbortController();
      const validationSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.businessUnauthorizedObservationTimeoutMs),
      ]);
      // 空定价/PAT响应或普通403不能直接登出。沿用 transport 核验身份，不递归触发观察器。
// 用 Promise.resolve() 起链：即便下方同步 throw 也会变成 rejection，而不是在 Map 写入前炸掉调用方。
// 核验内部绝不回调 onZcodeJwtInvalid，防止观察器递归触发自身。
// finally 中按 identity 比较后再删除，避免误删后来者新建的同键条目。
      const validation = Promise.resolve()
        .then(async () => {
          try {
            const identity = await waitWithAbort(
              (this.fetchImpl ?? globalThis.fetch)(check.url, {
                method: "GET",
                redirect: "error",
                headers: withRequestIdHeader({
                  Authorization: check.authorization,
                  "Content-Type": "application/json",
                }),
                signal: validationSignal,
              }),
              validationSignal,
            );
// 401 是 identity 端点给出的直接证据，无需再读正文；这是唯一允许「不看 body 就判负」的分支。
// 非 200/403 一律视为不可判定（含 5xx、网关 3xx），保持登录态并等待下次真实请求。
// 403 仍需正文证据，因为部分业务对无权限也返回 403，那不代表凭据过期。
            if (identity.status === 401) return true;
            if (identity.status !== 200 && identity.status !== 403) return false;
            const result = await readBusinessAuthenticationResponse(
              identity,
              this.businessUnauthorizedObservationTimeoutMs,
              validationSignal,
            );
            return (
              result === "unauthorized" ||
              (identity.status === 200 && result === "empty" && check.emptyBodyMeansInvalid)
            );
          } catch {
// [失败路径] 该 catch 必须覆盖 fetch 拒绝、AbortSignal.timeout 与 waitWithAbort 的 AbortError，
// 三者在网络抖动时无法区分，统一按「证据不足」处理才不会误登出。
            // 核验离线、超时或格式不明只能保留登录；不能用探测失败代替认证失效证据。
            return false;
          }
        })
        .finally(() => {
          if (this.businessValidations.get(key)?.promise === validation)
            this.businessValidations.delete(key);
        });
// 先建条目再 await：后到的并发调用必须能命中同一 promise，否则合并失效。
      entry = { promise: validation, controller, subscribers: 0 };
      this.businessValidations.set(key, entry);
    }
// [资源] 计数在 try 之前自增，保证进入等待后必有对应的 finally 递减，不会出现负计数。
// 每个订阅者用自己的 signal 等待共享 promise：单个调用方取消只结束自己，不影响核验本身。
// 归零时同时 abort 与按 identity 删除，二者顺序固定：先 abort 让在途 fetch 尽早释放 socket。
    entry.subscribers += 1;
    try {
      return await waitWithAbort(entry.promise, signal);
    } finally {
      // 核验曾独立等待，原请求取消后仍 pending 并可能登出；各订阅者独立收口，
      // 只有最后一个离开才取消共享 transport，避免影响仍在等待的并发请求。
      entry.subscribers -= 1;
      if (entry.subscribers === 0) {
        entry.controller.abort();
        if (this.businessValidations.get(key) === entry) this.businessValidations.delete(key);
      }
    }
  }

// URL 先按 endpoint origin 重写再做一切判定：否则 isRequestForEndpoint 会拿旧 origin 比较，来源头丢失。
// 本方法永不抛非 ApiError：上层只按 ApiError 分支处理，裸 TypeError 会绕过重试与提示逻辑。
// 成功路径返回的 response 可能仍带未读 body；观察器只读 clone，因此调用方语义不变。
  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const endpointOrigin = this.resolveZCodeEndpointOrigin
      ? await this.resolveZCodeEndpointOrigin()
      : undefined;
    const activeEndpointOrigin = endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    const requestInput = rewriteZCodeEndpointUrl(input, activeEndpointOrigin);
    const url = resolveUrl(requestInput);
    const method = resolveMethod(init);
    const timeoutMs = init?.timeoutMs;
// 只有正数 timeout 才建 controller：0/负数表示「不限时」，不能被误当成立即超时。
// didTimeout 与 controller 分离记录：abort 后无法从 signal 反查原因，错误消息只能靠这个标志区分。
// [权衡] 不用 AbortSignal.timeout，是因为需要主动 clearTimeout 且要合并调用方 signal，手写更可控。
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let didTimeout = false;
    const timer =
      controller && timeoutMs
// 定时器只负责 abort，不直接 reject：统一由 catch 收口，避免两条错误路径产生不同 ApiError 形态。
// unref 在 finally 中通过 clearTimeout 完成；此处保持引用以便清理。
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;

    try {
// [并发] AbortSignal.any 合并调用方 signal 与超时 signal：任一触发都取消 fetch，且两条来源互不覆盖。
// 无超时时必须原样透传 init.signal，而不是包一层新的，避免改变调用方对 signal 身份的判断。
// 合并后的 signal 会传给观察器，保证主请求取消后旁路核验同步停止。
      const signal = controller
        ? init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        : init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
// 注入优先于全局 fetch：测试与受限运行时（Electron 特定网络栈）需要替换传输层。
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      // X-Client-Language 曾取进程 Intl locale：从 Dock 启动时无 LANG 会回退 en-US，且不跟随界面语言。
      // 宿主注入内存中的实时界面语言；同步读取，不引入 I/O，不改变请求的取消与超时语义。
      const requestHeaders = withRequestIdHeader(
        resolveRequestHeaders(
          requestInput,
          init?.headers,
          activeEndpointOrigin,
          this.resolveClientLanguage?.(),
        ),
      );
// 只对 ZCode 请求打调试日志：第三方请求量可能极大，且其 header 与本服务无关。
// 该分支必须在 fetch 之前，日志才能覆盖「请求已发出但无响应」的场景。
      if (isRequestForEndpoint(requestInput, activeEndpointOrigin)) {
        // 调试说明：这里只记录 header key，避免 Authorization / token 等敏感值落盘。
        log.debug(undefined, "zcode endpoint request headers prepared", {
          headerKeys: readHeaderKeys(requestHeaders),
          method,
          url,
        });
      }
      const response = await fetchImpl(requestInput, {
        ...init,
        headers: requestHeaders,
        ...(signal ? { signal } : {}),
      });
// 只有 200/401/403 值得观察：其余状态码不可能携带「登录过期」证据，提前排除以省掉 clone 与读流。
// 观察过程被 waitWithAbort 包裹且整体 try 住：观察失败绝不能改变原始响应的返回。
// [权衡] 这里 await 观察完成再返回 response，是为了让登出副作用先于上层后续请求发生，代价是首包延迟。
      if ([200, 401, 403].includes(response.status) && this.onZcodeJwtInvalid) {
        try {
          await waitWithAbort(
            (async () => {
              const requestHeadersForObservation = new Headers(requestHeaders);
              const isCurrentZCodeJwtRequest = await this.isZcodeJwtRequest?.(
                requestInput,
                requestHeadersForObservation,
              );
              if (isCurrentZCodeJwtRequest) {
// 401 直接判负；200/403 需要正文或 identity 核验补证，因此默认值是 false。
                let invalid = response.status === 401;
                if (
                  !invalid &&
                  (await this.isBusinessUnauthorizedRequest?.(
                    requestInput,
                    requestHeadersForObservation,
                  ))
                ) {
                  const evidence = await readBusinessAuthenticationResponse(
                    response,
                    this.businessUnauthorizedObservationTimeoutMs,
                    signal,
                  );
// 只有明确的 unauthorized 证据才置位；empty 在该分支不足以判负，必须交给 identity 核验。
                  invalid = evidence === "unauthorized";
                  if (
                    !invalid &&
                    (response.status === 403 || (response.status === 200 && evidence === "empty"))
                  )
                    invalid = await this.confirmBusinessCredentialInvalid(
                      requestInput,
                      requestHeadersForObservation,
                      response,
                      evidence,
                      signal,
                    );
                }
// [顺序] onZcodeJwtInvalid 触发前必须再查 signal.aborted：本地登出不可逆，调用方已放弃的请求不能再引发副作用。
// 回调是 fire-and-forget 语义，其异常由外层 catch 记录，不影响响应返回。
                if (invalid && !signal?.aborted)
                  this.onZcodeJwtInvalid?.(requestInput, requestHeadersForObservation);
              }
            })(),
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
// 观察阶段的异常被刻意吞掉并降级为 warn：鉴权观察是增强路径，失败不能污染主请求结果。
// 但取消属于调用方意图，必须原样抛 AbortError，让 request 的外层 catch 统一成 ApiError。
          log.warn("zcode jwt invalid response observation failed", { error });
        }
      }
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return response;
    } catch (error) {
// 已是 ApiError 的直接透传，不能再包一层：重复包装会让 cause 链与 message 前缀逐层退化。
// 该分支同时保护宿主主动抛出的 ApiError（例如自定义 fetchImpl 的拒绝）。
      if (error instanceof ApiError) {
        throw error;
      }

// [失败路径] 用 didTimeout 区分「超时」与「调用方取消」：两者都是 AbortError，但上层文案与重试策略不同。
// 超时消息带具体毫秒数，便于用户与日志核对预算；取消则保留原始 message 以免伪造原因。
// 这里只认 DOMException + name，不按字符串匹配，避免把业务错误里的 abort 字样误判。
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError({
          message:
            didTimeout && timeoutMs ? `Request timed out after ${timeoutMs}ms` : error.message,
          url,
          method,
          cause: error,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError({
        message,
        url,
        method,
        cause: error,
      });
    } finally {
// [资源] finally 清理定时器：成功、业务异常与取消三条路径都会经过这里，
// 漏清理会让一次已完成的请求继续持有 timer，长驻进程中累积成内存与事件循环泄漏。
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

// 工厂只做构造，不缓存实例：每个宿主窗口需要独立的业务核验表与取消域。
export function createNodeApiClient(options: NodeApiClientOptions = {}): ApiClient {
  return new NodeApiClient(options);
}
