// INV-01 守住位置：connectRemote 外层的 disposeBackendOnce 是 backend 唯一释放点；改错故障：detect 或 deploy 抛错时 SSH/WSL 会话泄漏。
// INV-02 守住位置：connectRemoteUnchecked 每个 await 之后调用 throwIfRemoteConnectAborted；改错故障：取消后仍继续部署与上传，继续占用旧凭据。
// INV-03 守住位置：abort 监听里的 onAbort 先释放 backend 再拒绝等待；改错故障：只结束逻辑等待，初始化任务在后台继续跑。
// INV-04 守住位置：guardedConnecting 在连接完成后复查 aborted；改错故障：取消后仍返回连接，上层持有已废弃的 channel。
// INV-05 守住位置：REMOTE_RUNTIME_ENV_KEYS 白名单；改错故障：整份 env 透传，凭据与内部地址泄漏到远端。
// INV-06 守住位置：pickRemoteRuntimeEnv 的 trim 与非空过滤；改错故障：空串被当成显式覆盖，清掉远端默认配置。
// INV-07 守住位置：detect 之后的 assertSupportedRemoteEnvironment；改错故障：不支持的平台继续部署，错误发生在更晚且更难定位的位置。
// INV-08 守住位置：skipDeploy 分支；改错故障：重复上传覆盖正在运行的 bundle，远端进程读到半写入文件。
// INV-09 守住位置：resolveRemoteRuntimeNetwork 对 resolveRuntimeProxy 的能力判断；改错故障：SSH/Docker 的启动命令被误改写。
// INV-10 守住位置：代理解析失败时的回退分支；改错故障：WSL 本地工作区因解析异常直接不可连接。
// INV-11 守住位置：代理解析成功且值变化时的日志；改错故障：日志打印未脱敏的代理地址，泄漏凭据。
// INV-12 守住位置：handshake 剩余字节的 unshift 回填；改错故障：首帧丢失，RPC 请求永久挂起。
// INV-13 守住位置：topicResourceChannel 的反向频道注册；改错故障：桌面资源中继通道不可用，仅 Desktop Host 受影响。
// INV-14 守住位置：reportRemoteClose 的一次性守卫；改错故障：同一次断连被上报多次，上层重复回收 session。
// INV-15 守住位置：backend.onDidDisconnect 并入同一条关闭链路；改错故障：SSH 半开连接无人感知，UI 长时间显示在线。
// INV-16 守住位置：beginDisposal 的拆除顺序与同步 socket.dispose；改错故障：远端 stdio server 收不到 EOF，进程悬挂。
// INV-17 守住位置：disposeAndWait 的单飞与超时上界；改错故障：并发调用重复等待，或超时后仍在后台等待。
// INV-18 守住位置：buildRemoteServerCommand 的 quotePosixShellArg；改错故障：含空格或引号的代理与版本值破坏命令，甚至形成注入。
//
// 模块职责：把 IRemoteBackend 变成可用的 RemoteConnection，串起 detect、deploy、exec、handshake 与 RPC 包装。
// 状态所有权：backend 与 stream 的生命周期归本模块，services 与 client 的所有权在连接返回后移交调用方。
// 阅读顺序：先 connectRemote 看取消与释放，再看 connectRemoteUnchecked 的阶段推进，最后看 env 与命令拼装。
import { SocketProtocol, ChannelClient, ChannelServer, type IServerChannel } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  formatLogPrefix,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { wrapStdioStream } from "./stdio-socket.js";
import { performHandshake } from "./handshake.js";
import { deployServer } from "./deploy.js";
import type { DeployOptions } from "./deploy.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { quotePosixShellArg } from "./posixShell.js";
import { formatWslProxyForLog } from "./wslProxy.js";

// 断连码固定为 -1：子进程真实退出码在 0 到 255 之间，负数才能与正常退出区分。
// 该值经 onDidRemoteClose 交给上层，上层据此把断连当作需要重建连接的信号。
// 改成 0 或复用某条真实退出码，SSH keepalive 断连会被误判为远端正常关闭，重连策略失效。
// 只在 backend 断连分支使用；stdio 真实关闭必须透传原始 code，不能被该常量覆盖。
// 集中成常量是为了让上报方与消费方共用同一语义，避免各处写魔数后逐渐漂移。
const BACKEND_DISCONNECT_EXIT_CODE = -1;

export interface ConnectOptions extends DeployOptions {
  /** 仅 Desktop Host 注入，复用当前 stdio 的私有反向资源频道。 */
  topicResourceChannel?: IServerChannel;
  /** Client identifier for handshake */
  clientId?: string;
  /** Handshake timeout in ms (default: 10000) */
  handshakeTimeout?: number;
  /** Skip deploy step (assume server is already deployed) */
  skipDeploy?: boolean;
  /** 桌面 app 版本；用于透传给远端 agent，让模型请求 header 能标识发起方版本 */
  appVersion?: string;
  /** 远端 server/agent 需要继承的非敏感产品环境变量；调用方可传较宽的 env，server 侧会按白名单过滤。 */
  remoteRuntimeEnv?: Record<string, string | undefined>;
  /** Desktop Host 为 desktop-attached WSL server 提供的显式 Agent 网络配置。 */
  remoteRuntimeNetwork?: RemoteRuntimeNetworkOptions;
  /** 远端 stdio 关闭后的回调（用于上层感知断连并触发回收） */
  onDidRemoteClose?: (event: { code: number }) => void;
}

export interface RemoteRuntimeNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /** 只允许 Host 设置权威值覆盖远端自身的旧设置。 */
  authoritative?: boolean;
}

export interface RemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
}

// 这里是远端进程允许继承的唯一 env 白名单，集合必须显式可审计，不能从调用方 env 动态推导。
// 远端 server 由 SSH/WSL/Docker 单独拉起，不继承桌面 host env，只能靠这份列表显式注入。
// 放开为整份 process.env，会把凭据与内部服务地址带到远端，并污染远端自身的默认配置。
// 新增键必须同时确认远端确有消费方，否则只是扩大暴露面而没有收益。
// 两个灰度开关在下方注释里说明来源：分桶在 Desktop Main 完成，远端只消费结果，不重新分桶。
const REMOTE_RUNTIME_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_TEST_OAUTH_ORIGIN",
  "ZAI_PRODUCTION_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_TEST_BUSINESS_BASE_URL",
  "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  "ZAI_TEST_OAUTH_CLIENT_ID",
  "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  // Desktop Main 已完成的单功能灰度结果；远端 server 只消费，不重新分桶。
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  // 同上：本地覆盖由 Desktop Main 按构建档位写定（buildHostProcessEnv），
  // 透传后 SSH/WSL/Docker 远端 Host 与本地 Host 得到同一档位。
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
] as const;

export type RemoteRuntimeEnvKey = (typeof REMOTE_RUNTIME_ENV_KEYS)[number];
export type RemoteRuntimeEnv = Partial<Record<RemoteRuntimeEnvKey, string>>;

// 只保留 trim 后非空的键：空串会被远端误当成显式覆盖，从而清掉远端默认值。
// 返回类型是 Partial 映射，缺省的键表示不注入而不是注入空值，这两种语义必须区分。
// 调用方可以传较宽的 env，白名单与 trim 的职责收敛在这里，命令拼装处不再重复判断。
// 不修改入参对象，避免调用方共享的 env 被意外改写。
// 新增键若绕过本函数直接拼进命令，就会同时失去 trim 与白名单两道保护。
export function pickRemoteRuntimeEnv(env: Record<string, string | undefined>): RemoteRuntimeEnv {
  const picked: RemoteRuntimeEnv = {};
  for (const key of REMOTE_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

function createRemoteConnectAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Remote connection canceled");
  error.name = "AbortError";
  return error;
}

function throwIfRemoteConnectAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRemoteConnectAbortError(signal);
  }
}

/**
 * Connect to a remote zcode server via an IRemoteBackend.
 *
 * Steps:
 * 1. detect() → { platform, arch }
 * 2. Deploy if needed (upload node + server bundle + node-pty)
 * 3. exec server command
 * 4. Handshake (read hello, send ack)
 * 5. Wrap stdio → ISocket → SocketProtocol → ChannelClient → RemoteServiceAccess
 */
// 对外唯一连接入口，返回的 RemoteConnection 同时拥有 services 与 client，调用方负责最终 dispose。
// backend 生命周期由本函数接管：失败路径自行释放，成功后才把处置权移交给返回值。
// signal 覆盖整条 detect/deploy/handshake 链路，取消必须让调用方尽快得到拒绝。
// 成功返回后不要再保留可取消的 waiter，否则迟到的取消会误伤已交付的连接。
// 选项里的 skipDeploy 与 handshakeTimeout 只影响流程，不改变上述所有权约定。
export async function connectRemote(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const signal = options?.signal;
  let backendDisposed = false;
  const disposeBackendOnce = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    backend.dispose();
  };
  if (signal?.aborted) {
    disposeBackendOnce();
    throw createRemoteConnectAbortError(signal);
  }

  let removeAbortListener: () => void = () => undefined;
  try {
    const connecting = connectRemoteUnchecked(backend, options);
    if (!signal) {
      return await connecting;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        // 窗口 Host 合并后不能再通过杀独立 SSH Host 进程来取消连接；如果这里只
        // 结束 logical waiter，detect/deploy/upload 会继续占用旧凭据和连接。连接初始化尚未
        // 对外发布，可以安全释放它独占的 backend，并让调用方立即结束等待。
        disposeBackendOnce();
        reject(createRemoteConnectAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    // 竞态兜底：abort 可能恰好发生在连接完成之后、Promise.race 结算之前。
    // 此处再查一次 signal.aborted，命中就先释放刚建好的连接，再抛取消错误。
    // 漏掉这段检查，调用方会拿到一条已被判为取消的连接，远端进程长期泄漏。
    // 释放后抛错而不是返回半可用对象，保证成功分支拿到的连接始终可用。
    const guardedConnecting = connecting.then((connection) => {
      if (signal.aborted) {
        connection.dispose();
        throw createRemoteConnectAbortError(signal);
      }
      return connection;
    });
    return await Promise.race([guardedConnecting, aborted]);
  } catch (error) {
    // detect/deploy/handshake 任一步失败时尚未返回 RemoteConnection，调用方无从 dispose backend。
    disposeBackendOnce();
    throw error;
  } finally {
    removeAbortListener();
  }
}

// 本函数只做正向流程，不处理 abort 释放；所有权与取消统一由外层 connectRemote 收口。
// 每个阶段 await 之后都插一次 throwIfRemoteConnectAborted，让取消在阶段边界及时生效。
// 中间态资源在返回前都是局部变量，抛错时由外层释放 backend 兜底，这里不重复拆。
// 在这里再写一套 dispose 逻辑会与外层重复释放，导致后端被二次 dispose。
async function connectRemoteUnchecked(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const clientId = options?.clientId ?? `desktop-${Date.now()}`;

  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("connectRemote", process.pid), ...args);

  // 1. Detect remote environment
  log("detecting remote env...");
  const env = await backend.detect();
  throwIfRemoteConnectAborted(options?.signal);
  log("detected:", env);
  assertSupportedRemoteEnvironment(env);

  const remoteRuntimeNetwork = await resolveRemoteRuntimeNetwork(
    backend,
    options?.remoteRuntimeNetwork,
    log,
  );

  // 2. Deploy server if needed
  // skipDeploy 用于远端已部署或只重启进程的场景，跳过上传可避免覆盖正在运行的 bundle。
  // 跳过部署不等于跳过检测：detect 与平台断言始终执行，后续命令拼装依赖其结果。
  // 部署结束立刻检查取消，避免用户已取消却仍继续拉起远端进程。
  if (!options?.skipDeploy) {
    log("deploying server...");
    await deployServer(backend, env, options);
    throwIfRemoteConnectAborted(options?.signal);
    log("deploy complete");
  }

  // 3. Launch server
  log("launching remote server...");
  const stream = await backend.exec(buildRemoteServerCommand(options, remoteRuntimeNetwork));
  throwIfRemoteConnectAborted(options?.signal);
  log("remote server exec started");

  // Forward stderr for debugging
  stream.stderr.on("data", (chunk: Buffer) => {
    // 远端 zcode-server 的服务日志走 stderr，直接写 host stderr 时可能被结构化日志中继吞掉。
    // 这里转成 host 的 console 日志，让 remote sqlite 初始化/锁冲突日志能稳定出现在连接日志面板和启动终端。
    console.log(`[remote] ${chunk.toString().trimEnd()}`);
  });

  // 4. Handshake
  log("performing handshake...");
  // 握手读完 hello 后可能已多读到首帧字节，remaining 必须原样保留而不能丢弃。
  // 这些剩余字节属于 RPC 数据流，丢掉会让首帧请求永远等不到响应。
  // 握手超时由 handshakeTimeout 控制，缺省值在选项注释里约定为 10000ms。
  // hello.version 只用于日志，不参与兼容判断，不要在这里加版本分支。
  const { hello, remaining } = await performHandshake(stream, clientId, options?.handshakeTimeout);
  throwIfRemoteConnectAborted(options?.signal);
  log("handshake done, server version:", hello.version);

  // 5. Wrap into RPC channel
  // If there's remaining data from handshake, push it back to the stream
  // so it gets picked up by wrapStdioStream's data listener
  if (remaining && remaining.length > 0) {
    (stream.stdout as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(remaining);
  }

  const socket = wrapStdioStream(stream);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const reverseServer = options?.topicResourceChannel
    ? new ChannelServer(protocol, "desktop-resource")
    : undefined;
  if (reverseServer && options?.topicResourceChannel)
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, options.topicResourceChannel);
  const services = new RemoteServiceAccess(client);
  let hasReportedRemoteClose = false;
  let hasStreamClosed = false;
  let resolveStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClosed = resolve;
  });
  const reportRemoteClose = (code: number) => {
    if (hasReportedRemoteClose) {
      return;
    }
    hasReportedRemoteClose = true;
    options?.onDidRemoteClose?.({ code });
  };

  const backendDisconnectDisposable = backend.onDidDisconnect?.((event) => {
    // SSH keepalive 发现半开连接时，远端 server stdio channel 未必立刻 close。
    // 这里把 backend 断连并入同一条关闭上报链路，让 host/main/UI 复用既有 session-close 收口。
    const errorMessage = event.error?.message;
    log(
      errorMessage
        ? `remote backend disconnected: ${event.reason}: ${errorMessage}`
        : `remote backend disconnected: ${event.reason}`,
    );
    reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE);
  });
  const streamCloseDisposable = stream.onClose((code) => {
    hasStreamClosed = true;
    resolveStreamClosed();
    reportRemoteClose(code);
  });

  let disposalStarted = false;
  let backendDisposed = false;
  let disposeAndWaitInFlight: Promise<void> | null = null;
  // 拆除顺序自上层往下层：先断开断连监听，再关反向频道，最后关 client 与 protocol。
  // socket.dispose 必须同步执行，不能排在 await 之后，否则远端 stdio server 收不到 EOF。
  // disposalStarted 保证幂等，dispose 与 disposeAndWait 并发调用时只拆一次。
  // 先关 client 再关 protocol，能让未完成请求以关闭错误结束，而不是静默悬挂。
  // 反向频道只在桌面 Host 注入时存在，可选链已覆盖未创建的情况，无需额外判断。
  const beginDisposal = () => {
    if (disposalStarted) {
      return;
    }
    disposalStarted = true;
    backendDisconnectDisposable?.dispose();
    reverseServer?.dispose();
    client.dispose();
    protocol.dispose();
    // stdin.end 必须在任何 await 之前同步触发，让远端 stdio server 立即收到 EOF。
    socket.dispose();
  };
  const disposeBackend = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    backend.dispose();
  };
  const disposeBackendAndWait = async () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    if (backend.disposeAndWait) {
      await backend.disposeAndWait();
      return;
    }
    backend.dispose();
  };

  return {
    services,
    client,
    dispose() {
      beginDisposal();
      disposeBackend();
    },
    disposeAndWait(disposeOptions) {
      if (disposeAndWaitInFlight) {
        return disposeAndWaitInFlight;
      }
      beginDisposal();
      if (backendDisposed || hasStreamClosed) {
        disposeBackend();
        return Promise.resolve();
      }

      const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 5_000, 0);
      disposeAndWaitInFlight = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
        });
        const result = await Promise.race([streamClosed.then(() => "closed" as const), deadline]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result === "timed-out") {
          log(`remote stdio close timed out after ${timeoutMs}ms`);
        }
        await disposeBackendAndWait();
      })();
      return disposeAndWaitInFlight;
    },
  };
}

async function resolveRemoteRuntimeNetwork(
  backend: IRemoteBackend,
  network: RemoteRuntimeNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (!network || !backend.resolveRuntimeProxy) {
    // 只有实现了远端代理解析能力的 WSL backend 才接收这条权威网络边界；
    // SSH/Docker 即使误传 options 也保持原有启动命令。
    return undefined;
  }
  if (!network.httpProxy?.trim()) {
    return network;
  }

  try {
    const resolvedProxy = await backend.resolveRuntimeProxy(network.httpProxy);
    if (resolvedProxy !== network.httpProxy) {
      log(
        "resolved remote runtime proxy via wsl-host-gateway",
        formatWslProxyForLog(network.httpProxy),
        "->",
        formatWslProxyForLog(resolvedProxy),
      );
    }
    return { ...network, httpProxy: resolvedProxy };
  } catch (error) {
    // 代理解析只是运行时增强；解析失败时沿用设置页原值，避免把 WSL 本地工作区变成不可连接。
    log(
      "remote runtime proxy resolution failed; using configured endpoint",
      error instanceof Error ? error.message : String(error),
    );
    return network;
  }
}

function buildRemoteServerCommand(
  options: ConnectOptions | undefined,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
): string {
  const envParts = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"',
  ];
  for (const [key, value] of Object.entries(
    pickRemoteRuntimeEnv(options?.remoteRuntimeEnv ?? {}),
  )) {
    envParts.push(`${key}=${quotePosixShellArg(value)}`);
  }
  const appVersion = options?.appVersion?.trim();
  if (appVersion) {
    // 远端 server 是通过 SSH/WSL/Docker 单独启动的，不会继承桌面 host env。
    // 这里显式把 app 版本作为远端进程 env 注入，远端 agent 才能在模型请求 header 中带上版本。
    envParts.push(`${ZCODE_APP_VERSION_ENV}=${quotePosixShellArg(appVersion)}`);
  }
  if (remoteRuntimeNetwork?.authoritative) {
    envParts.push(`${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1'`);
    if (remoteRuntimeNetwork.httpProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.httpProxy)}`,
      );
    }
    if (remoteRuntimeNetwork.noProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.noProxy)}`,
      );
    }
  }
  return `${envParts.join(" ")} ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`;
}
