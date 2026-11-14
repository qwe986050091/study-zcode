// Host API 网络传输层：把 Host 进程发往模型/网关的 HTTP(S) 请求统一收口到可配置代理与自定义 CA。
// INV-net#01：未配置代理且无自定义 CA 时必须走 globalThis.fetch，不创建任何 dispatcher
//   （守住位置：fetch 的 direct 分支；破坏后直连流量被额外连接池接管，dispose 无法彻底回收）。
// INV-net#02：dispatcher 以「路由种类 + 代理 URL + CA 路径」为键单飞，同一键只允许一个连接池
//   （守住位置：dispatcherKey 与 dispatcherPromises；破坏后每个请求各建 Agent，socket 泄漏且代理连接数暴涨）。
// INV-net#03：dispose 之后的新请求与新 dispatcher 创建必须失败，绝不静默退回直连
//   （守住位置：fetch 内的 disposed/generation 校验；破坏会把企业代理下的流量直发公网）。
// INV-net#04：代理 URL 非法时 fail-closed 抛错（守住位置：resolveHostProxyForUrl 的 invalid 分支）。
// 说明：重试与超时沿用 undici 默认值，本文件只负责路由决策与连接池生命周期，不另设超时。
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

// 选项来自 Host 的设置存储，每次读取都可能变化；这里只描述形状，不做校验与归一。
// 空字符串与 undefined 等价（都表示未配置），调用方不必先清洗。
export interface HostApiNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
}

// dispose 用于进程退出路径：同步触发、不等待；disposeAndWait 用于窗口或 Host 重建，必须等到连接池真正关闭。
// 两者共享同一个单飞 Promise，重复调用不会二次关闭，也不会让 destroy 与 close 互相踩踏。
export interface HostApiNetworkTransport {
  fetch: typeof fetch;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

// 路由只有三种终态，没有「稍后再试」：决策在请求发出前一次完成，未知情况即失败。
// noProxyMatched 只用于诊断，不参与后续分支判断，因此可选。
type HostProxyRoute =
  | { kind: "direct"; noProxyMatched?: boolean }
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "invalid"; reason: string };

// [权衡] 自定义 CA 追加在默认根证书之后而非替换：Node 的 tls.ca 是全量替换语义，
// 一旦替换，未经企业代理重签的公网证书会链校验失败，表现为随机站点 ERR_CERT_AUTHORITY_INVALID。
export function mergeHostApiCaCertificates(
  customCa: string,
  defaultCa: readonly string[] = rootCertificates,
): string[] {
  // Node 的 tls.ca 会替换而不是追加默认根证书。只传企业代理 CA 会让未被
  // 中间人重签的公网证书失去信任链，因此必须同时保留 Node 默认根证书。
// 默认根证书排在前面参与链构建；自定义 CA 放在末尾不影响命中，只是候选顺序靠后。
  return [...defaultCa, customCa];
}

// 用户常把代理写成 host:port 或省略 scheme；缺 scheme 时补 http://，否则 new URL 会把 host 当协议名。
// 只接受 http/https：socks 需要额外 Agent 实现，静默降级成直连会绕过企业审计，因此判为非法。
// 统一返回 url.href，抹平大小写与末尾斜杠差异，使 dispatcher 缓存键稳定。
function normalizeProxyUrl(value: string): string | undefined {
// 只认合法的 scheme:// 前缀；宽松匹配可让带凭证的代理（user:pass@host）不被误补协议。
  const candidate = /^\w[\w+.-]*:\/\//.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
// [失败路径] 缺 hostname 或协议不支持时返回 undefined 而非抛错，由调用方决定判非法还是忽略。
// 不能把空主机当 localhost：代理为空时 undici 会回退系统代理，造成路由漂移。
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

// no_proxy 在 curl/Go/Node 之间并不统一，这里取交集：*、域名后缀、host:port、带 scheme 的写法都接受。
// 只做后缀对齐（等于规则或以 .规则 结尾），避免 evil-example.com 命中 example.com。
function matchesNoProxy(url: URL, value: string | undefined): boolean {
  const host = url.hostname.toLowerCase();
// 未显式写端口时按协议补默认端口，使规则 host:443 能匹配 https://host 的请求。
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (value ?? "").split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
// 全局通配必须最先判断：后续解析会把 "*" 当主机名，得到空 normalizedHost 而误判为不匹配。
    if (rule === "*") return true;

    const ruleWithoutScheme = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    const [ruleHost = "", rulePort] = ruleWithoutScheme.split(":");
// "*.example.com"、".example.com"、"example.com" 三种写法等价，统一去掉前导通配与点。
    const normalizedHost = ruleHost.replace(/^\*\.?/, "").replace(/^\./, "");
    if (!normalizedHost) return false;
    const hostMatches = host === normalizedHost || host.endsWith(`.${normalizedHost}`);
// 规则带端口时要求精确相等：只比主机会把 8443 的流量错误地判为可直连。
    return hostMatches && (!rulePort || rulePort === port);
  });
}

// 决策顺序固定：协议判定 → no_proxy → 代理可用性。
// 顺序不可调换：no_proxy 命中必须优先于「代理已配置」，否则内网地址会被迫走代理；
// 非 http(s) 协议直接放行（如 file:、ws:），而不是因为配了代理就报非法。
export function resolveHostProxyForUrl(
  requestUrl: string | URL,
  options: HostApiNetworkOptions,
): HostProxyRoute {
// 请求 URL 可能来自拼接结果，解析失败按直连处理：没有合法目标就无从代理，这是唯一允许的静默降级；
// 但代理配置本身的错误一律 fail-closed，不在此处吞掉。
  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { kind: "direct" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "direct" };
  }
// 记录 noProxyMatched，便于调用方区分「本来没配代理」与「被 no_proxy 排除」。
  if (matchesNoProxy(url, options.noProxy)) {
    return { kind: "direct", noProxyMatched: true };
  }
  const configuredProxy = options.httpProxy?.trim();
  if (!configuredProxy) {
    return { kind: "direct" };
  }
// httpProxy 非空但格式非法时返回 invalid，绝不把用户的错误配置解释成直连。
  const proxyUrl = normalizeProxyUrl(configuredProxy);
  return proxyUrl
    ? { kind: "proxy", proxyUrl }
    : { kind: "invalid", reason: "Configured Host proxy URL is invalid" };
}

// 依赖注入点只为测试可替换；生产路径使用下面的默认实现。
// 注入的 fetchWithDispatcher 必须透传 dispatcher，否则自定义 CA 与代理都会静默失效。
interface HostApiNetworkTransportDependencies {
  createDispatcher?: typeof createDispatcher;
  fetchWithDispatcher?: (
    input: string,
    init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
  ) => Promise<Response>;
}

// 传输层所有权在 Host 进程：窗口关闭或远端 Host 重建时必须显式释放，不能依赖 GC。
// resolveOptions 以函数注入而非提前求值，保证设置改动在下一个请求就生效，无需重建 transport。
// 返回对象是稳定引用，fetch 可直接挂到 NodeApiClient，避免调用方每次取新函数。
export function createHostApiNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
  dependencies: HostApiNetworkTransportDependencies = {},
): HostApiNetworkTransport {
  // Host 是独立 Node 进程，Electron Session.setProxy 不会影响它的 globalThis.fetch；
  // 在 NodeApiClient 出口按请求注入 dispatcher，避免把 telemetry 等其它裸 fetch 全局改道。
// 设置读取的单飞缓存：并发请求共享同一次 IPC，避免启动瞬间打爆设置通道。
  let optionsPromise: Promise<HostApiNetworkOptions> | undefined;
// [资源] 键为 dispatcherKey，值为创建中的 Promise 而非 Dispatcher：
// 并发请求在创建完成前即可共享同一实例，避免同一路由建出多个连接池。
  const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
// [并发] disposed 与 generation 是跨 await 的失效判据：await 期间可能发生 dispose，
// 只看 disposed 无法区分「本次请求开始后被销毁」与「销毁后又重新初始化」，generation 用于兜住后者。
  let disposed = false;
  let generation = 0;
// [资源] 计数在创建 Promise 落定后才递减，disposeAndWait 依赖它回收「仍在初始化」的 dispatcher。
  let pendingDispatcherCreations = 0;
  let resolveDispatcherCreations: (() => void) | undefined;
  let dispatcherCreationsDone: Promise<void> | undefined;
// 迟到的 dispatcher（创建完成时已 dispose）在此暂存清理 Promise，由 dispose 统一 await。
  const lateDisposePromises: Promise<void>[] = [];
  let disposePromise: Promise<void> | undefined;
  let disposeMode: "close" | "destroy" | undefined;
// 工厂只取一次，避免依赖对象后续被修改导致同一 transport 内实现不一致。
  const dispatcherFactory = dependencies.createDispatcher ?? createDispatcher;
  const fetchWithDispatcher =
    dependencies.fetchWithDispatcher ??
    ((input, init) => undiciFetch(input, init as never) as unknown as Promise<Response>);

// [并发] 每次调用先取 generation 快照，所有 await 之后重新校验：任何一次 await 都可能跨越 dispose。
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (disposed) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestGeneration = generation;
    if (!optionsPromise) {
      // 设置读取失败只影响当前请求；清掉 rejected promise，避免一次瞬时 IPC/启动竞态
      // 把 Host API 永久锁死，同时仍保持失败请求不回退到直连。
      optionsPromise = resolveOptions().catch((error: unknown) => {
        optionsPromise = undefined;
        throw error;
      });
    }
// [失败路径] 设置读取失败直接抛给当前请求且不缓存失败，下一次请求会重新读取，避免一次启动竞态永久锁死。
    const options = await optionsPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestUrl = input instanceof Request ? input.url : String(input);
// 路由在请求发出前算好并复用：Request 只能被消费一次，提前取 URL 可避免后续读取失败。
    const route = resolveHostProxyForUrl(requestUrl, options);
    if (route.kind === "invalid") {
      throw new Error(route.reason);
    }
// 直连且无自定义 CA 时完全绕过 undici Agent：复用 Node 内置 fetch 的连接池，
// 避免为一个用不到的 dispatcher 付出 keep-alive socket 与关闭成本。
    if (route.kind === "direct" && !options.caCertPath) {
      return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
    }

// 缓存键包含 CA 路径：切换证书后必须重建连接池，否则 TLS 层继续用旧 CA 校验。
// 不把目标 host 放进键——连接池本就按 origin 复用，按 host 分键会让连接数随站点数量增长。
    const dispatcherKey = `${route.kind}:${route.kind === "proxy" ? route.proxyUrl : "direct"}:${options.caCertPath ?? ""}`;
    let dispatcherPromise = dispatcherPromises.get(dispatcherKey);
    if (!dispatcherPromise) {
      if (disposed) {
        throw new Error("Host API network transport has been disposed");
      }
      const dispatcherGeneration = generation;
      pendingDispatcherCreations += 1;
      dispatcherPromise = dispatcherFactory(route, options.caCertPath);
      dispatcherPromises.set(dispatcherKey, dispatcherPromise);
      void dispatcherPromise
        .then((dispatcher) => {
          if (
            (disposed || generation !== dispatcherGeneration) &&
            dispatcherPromises.get(dispatcherKey) === dispatcherPromise
          ) {
            dispatcherPromises.delete(dispatcherKey);
            const cleanupPromise = Promise.resolve(
              disposeMode === "close" ? dispatcher.close() : dispatcher.destroy(),
            ).catch(() => {});
            lateDisposePromises.push(cleanupPromise);
          }
        })
        .catch(() => {});
      const markDispatcherCreationDone = () => {
        pendingDispatcherCreations -= 1;
        if (pendingDispatcherCreations === 0) {
          resolveDispatcherCreations?.();
          resolveDispatcherCreations = undefined;
        }
      };
      void dispatcherPromise.then(markDispatcherCreationDone, markDispatcherCreationDone);
      dispatcherPromise.catch(() => {
        // 设置/CA 等临时 IO 失败只影响当前请求；清理 rejected dispatcher，避免一次启动竞态
        // 把同一路由永久锁死，同时仍保持失败请求 fail-closed、不回退到直连。
        if (dispatcherPromises.get(dispatcherKey) === dispatcherPromise) {
          dispatcherPromises.delete(dispatcherKey);
        }
      });
    }
    const dispatcher = await dispatcherPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    return fetchWithDispatcher(
      input as unknown as string,
      {
        ...init,
        dispatcher,
      } as Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
    );
  };

// [资源] dispose 单飞：先到者决定 mode（destroy 不可逆），后续调用直接复用同一 Promise；
// 同步退出与等待式退出并发时以先发生者为准，调用方不能指望后到的 close 覆盖 destroy。
  const startDispose = (mode: "close" | "destroy"): Promise<void> => {
// 已有释放流程则直接返回：重复进入会清空新建立的 dispatcherPromises，导致新连接池无人回收。
    if (disposePromise) return disposePromise;
    disposed = true;
    generation += 1;
    disposeMode = mode;
    // dispatcher 不能只被闭包缓存、没有 Host owner：窗口/远端 Host 重建后连接池和
    // keep-alive socket 仍可能存活。释放时对当前单飞 Promise 做快照，确保初始化中的 dispatcher
    // 也会在完成后被收口；同步退出 destroy，等待式退出 close。
    const pendingDispatchers = [...dispatcherPromises.values()];
    dispatcherPromises.clear();
    if (pendingDispatcherCreations > 0) {
      dispatcherCreationsDone = new Promise<void>((resolve) => {
        resolveDispatcherCreations = resolve;
      });
    }
    disposePromise = (async () => {
      await Promise.allSettled(
        pendingDispatchers.map(async (dispatcherPromise) => {
          const dispatcher = await dispatcherPromise;
          if (mode === "close") {
            await dispatcher.close();
          } else {
            await dispatcher.destroy();
          }
        }),
      );
      await dispatcherCreationsDone;
      await Promise.all(lateDisposePromises);
    })();
    return disposePromise;
  };

  return {
    fetch,
    dispose() {
      void startDispose("destroy");
    },
    disposeAndWait() {
      return startDispose("close");
    },
  };
}

async function createDispatcher(
  route: Exclude<HostProxyRoute, { kind: "invalid" }>,
  caCertPath: string | undefined,
): Promise<Dispatcher> {
  const customCa = caCertPath ? await readFile(caCertPath, "utf8") : undefined;
  const ca = customCa ? mergeHostApiCaCertificates(customCa) : undefined;
  if (route.kind === "proxy") {
    return new ProxyAgent({
      uri: route.proxyUrl,
      proxyTls: ca ? { ca } : undefined,
      requestTls: ca ? { ca } : undefined,
    });
  }
  return new Agent({ connect: ca ? { ca } : undefined });
}
