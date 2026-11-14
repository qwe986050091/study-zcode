// INV-01 存储迁移门禁先于一切远端等待，守住位置在 runZCodeProtocolAgent 首次资源获取；改错会让账号与 Registry 延迟混入迁移耗时并放大取消窗口。
// INV-02 prepareStorageOnly 必须早返回，守住位置在入口的选项分支；改错会把只读探测变成完整运行时启动，凭空创建 logger、Registry、MCP 与 server。
// INV-03 每个远端等待之后都要检查生命周期取消，守住位置在存储、Registry 与 server 创建之间；改错会继续为已取消的会话建资源并造成泄漏。
// INV-04 进程级 Registry 是唯一模型事实源，守住位置在 applyProtocolProviderRegistry；改错会让旧 workspace snapshot 重新参与执行，导致同账号模型不一致。
// INV-05 presentationSurface 只能纯覆盖，守住位置在 applyProtocolPresentationSurface；改错会连带改写 providerRegistry，让两个正交职责纠缠。
// INV-06 官方 MCP 的 origin 只能有一个解析表达式，守住位置在 resolveZCodeApiOrigin 及其两个使用点；改错会让 stdio 目标与信任判定分叉。
// INV-07 workspaceKey 取 identity 优先、缺失退回路径，守住位置在官方鉴权的 resolveWorkspace；改错会让同路径不同身份的工作区在审计中无法区分。
// INV-08 官方 MCP 身份端口与 elicitation 都用惰性 holder，守住位置在连接池构造之前；改错会让连接池拿到空端口或提前捕获未就绪实例。
// INV-09 server 未就绪时 elicitation 必须明确 decline，守住位置在连接池的请求回调；改错会让远端等待一个永远不会绑定的端口并拖住连接建立。
// INV-10 holder 为空时通知直接丢弃、不排队，守住位置在通知回调；改错会形成无界缓冲，迟到消息还会串进下一个会话。
// INV-11 资源回收只发生在 finally，守住位置在 cleanupProtocolRuntime 调用；改错会让成功路径也跳过释放，进程无法退出。
// INV-12 所有可释放资源都要在 try 外声明并登记到清理清单，守住位置在入口变量段与 finally 入参；改错会出现悬挂句柄且难以复现。
// INV-13 启动期资源统一走 acquireProtocolStartupResource，守住位置在存储、Registry 与遥测获取；改错会让取消后已创建的对象无人关闭。
// INV-14 transport 必须在 server 之后构造、在 start 之前不发送，守住位置在连接创建与 sink 绑定段；改错会让通知写入未初始化通道或乱序。
// INV-15 features.mcp 关闭时不得创建 tracker、连接池与 broker，守住位置在三处条件创建；改错会让禁用特性继续产生遥测与句柄开销。
// INV-16 资源采样器要在 server 与 transport 就绪后启动，守住位置在连接 start 之后；改错会让采样器持有半初始化对象并推送空数据。
// INV-17 遥测 idSalt 优先设备标识、缺失才退回 traceId，守住位置在 tracker 创建；改错会让事件无法跨进程关联或把不同机器混在一起。
// INV-18 runtimeSurface 只认显式的 remote_workspace_host，守住位置在入口末尾的解析函数；改错会让远程 SSH、WSL 与容器的 Trace 错归本地。
//
// 模块职责：进程级入口按序装配存储、Registry、遥测、MCP、server 与 transport，并在退出时按所有权回收。
// 状态所有权：sessionStore、providerRegistryRuntime 与 telemetryEnv 由启动资源获取托管；pool、broker、sampler 与 server 交给清理流程释放。
// 阅读顺序：先看主运行函数的 try 主链与 finally，再看两个纯覆盖函数与末尾的 runtimeSurface 判定。
// ZCode Protocol（NDJSON over stdio）的进程级入口：Desktop 的 app-server 由此启动。
//
// 启动顺序是有语义的：
// 1. SQLite 存储准备（迁移门禁）先于一切远端工作，避免把账号/Registry 等待时间混进迁移；
// 2. Worker Provider Registry → 遥测环境 → MCP 遥测/连接池 → 官方鉴权端口；
// 3. server 创建后再建 browser broker 与 transport，最后启动采样器；
// 4. 每个耗时步骤之间 check lifecycle.signal，取消即停；任一失败请求 shutdown 并抛出；
// 5. finally 始终走 cleanupProtocolRuntime（带 deadline），孤立的资源在 shutdown 期间由
//    disposeLate 回收，保证进程可退出。
// prepareStorageOnly 是只读快速路径（仅迁移 + 就绪事件），不启动任何运行时。
import { createConfig } from "@zcode/adapters/config";
import type { McpElicitationPort, McpNotificationPort } from "@zcode/contracts";
import { createNodeModelSelectionFacade } from "@zcode/provider-node";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpTelemetryTracker,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@zcode/adapters/mcp";
import {
  zcodeProtocolNotifications,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
} from "@zcode/shared";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import { traceContextToLogContext, createRootTraceContext } from "@zcode/contracts";
import type { McpPort, ModelSelection } from "@zcode/contracts";
import type { PresentationSurface } from "@zcode/core";
import type { RunZCodeProtocolAgentOptions, ZCodeAppOptions } from "./app/types.js";
import { createZCodeApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./zcode-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { resolveProcessProviderEndpointRoutingPort } from "./provider-endpoint-routing.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installZCodeProtocolAiSdkWarningLogger } from "./zcode-protocol/ai-sdk-warning-logger.js";
import {
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./zcode-protocol/official-mcp-auth-port.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "./zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "./zcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "./zcode-protocol/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./zcode-protocol/resource-sampler.js";
import { acquireProtocolStartupResource } from "./zcode-protocol/startup-resource.js";
import { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";
import type { ZCodeProcessResourceSampler } from "./process-resource-sampler.js";

// 纯函数只重写 runtimeConfig.presentationSurface，providerRegistry 留给后续步骤，两件事的先后不可合并。
// 返回新对象而不改入参，调用方持有的 options 仍可复用，避免一次调用污染后续装配。
// 改错会同时覆盖 registry，让展示面选择与模型事实源耦合，排查时无法判断问题属于哪一层。
// terminal 与 draft 只是展示面差异，不改变存储迁移、MCP 连接或清理顺序。
// 纯覆盖：只替换 runtimeConfig.presentationSurface（terminal/draft 等），
// 不改 providerRegistry，保证调用顺序（surface → registry）与职责正交。
export function applyProtocolPresentationSurface(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ZCodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * 进程级 Registry 已就绪后，它就是当前 Environment 的模型事实源。
 *
 * 旧 workspace snapshot 不再参与 Provider 和 Model 执行。
 */
// 进程级 Registry 就绪后即唯一模型事实源，旧 workspace snapshot 不再参与 Provider 与 Model 执行。
// 配置默认选择只在有值时展开，避免把 undefined 写成显式字段而压掉 Registry 内部的默认推导。
// 改错会出现默认模型丢失或旧快照复活，表现为同一账号在不同入口选到不同模型。
// 用进程级 Registry 替换旧 workspace snapshot；配置默认选择只在存在时加入，
// 避免把 undefined 写成显式值而覆盖 Registry 内部的默认推导。
export function applyProtocolProviderRegistry(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  providerRegistry: ZCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ZCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

/**
 * 运行 ZCode Protocol agent，直到 transport 关闭或生命周期取消。
 *
 * 资源所有权：sessionStore / providerRegistryRuntime / telemetryEnv 通过
 * acquireProtocolStartupResource 获取——创建后若 signal 已取消，create 结果会走 disposeLate
 * 而不是泄漏；其余（pool/broker/sampler）都在 finally 的 cleanupProtocolRuntime 中释放。
 * 异常语义：catch 里 requestShutdown(error) 后原样抛，finally 再 requestShutdown()（幂等），
 * 保证无论成功/失败/取消，退出码与日志都是确定性的。
 */
// 入口只做装配与生命周期编排，不承载业务判断，会话与消息状态都必须落在 server 或应用层。
// options 允许注入 env、cwd、input、output 与 lifecycle，测试替身因此不必触碰全局 process。
// 成功路径以 transport 关闭为终点，失败路径以异常抛出为终点，两者共用同一个 finally 回收。
// 要改启动顺序时先确认迁移门禁与取消检查点，再动远端资源，否则会破坏进程的可退出性。
export async function runZCodeProtocolAgent(
  options: RunZCodeProtocolAgentOptions = {},
): Promise<void> {
  // 快速路径只做 SQLite 迁移与就绪输出，随后立即返回，不创建 logger、Registry、MCP 或 server。
  // 该分支让宿主能在正式拉起前探测存储状态，误加初始化会把探测变成完整启动并拉长退出时间。
  // 此分支不读 lifecycle，也不登记任何清理资源，若后续在此申请资源必须同步补回收路径。
  if (options.prepareStorageOnly) {
    // 只准备 SQLite（迁移/就绪输出）后立即返回；不建 logger、Registry、MCP 或 server。
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loggerFactory = createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "zcode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.zcode_protocol",
  });
  installZCodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.zcode_protocol",
      startupKind: "zcode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ZCode Protocol agent startup started", {
    context: { version: options.version },
    event: "zcode_protocol.startup.started",
    stage: "start",
  });

  // 这里集中声明所有可释放资源并初始化为 undefined，让 finally 只按一份清单回收，避免分支遗漏。
  // 声明放在 try 之外是硬约束：catch 与 finally 都要能看到已经创建的那部分资源。
  // 遗漏任一变量会表现为进程退出挂起或句柄泄漏，尤其是采样器、浏览器 broker 与连接池。
  // 新增资源时同时补声明、补赋值、补清理入参，三处缺一都会变成泄漏。
  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: ZCodeProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let mcpPort: McpPort | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: ZCodeMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: ZCodeMcpTelemetryEvent) => void) | undefined;
  let processResourceSampler: ZCodeProcessResourceSampler | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  try {
    // 迁移门禁必须最先执行：此时还没有账号、Registry 与遥测等待，失败能快速暴露为存储错误。
    // 存储获取也走统一资源获取，signal 已取消时创建结果交给 disposeLate 关闭而不是直接丢弃。
    // 把远端步骤提前会让迁移耗时被网络等待污染，排查启动慢时无法区分本地成本与远端成本。
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    // 若此步之后取消，acquireProtocolStartupResource 会把已创建的 store 交给 disposeLate。
    const configResult = createConfig({ env: options.env });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "zcode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () => startProcessProviderRegistryRuntime(runtimeEnv),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "zcode_protocol.provider_registry.ready",
      module: "bootstrap.zcode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    const runtimeSurface = resolveProtocolRuntimeSurface(runtimeEnv);
    // 遥测环境准备会尝试把 deviceMid/端点等注入 env；失败/取消时 shutdownZCodeTelemetry 兜底。
    const telemetryEnv = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: () => shutdownZCodeTelemetry(),
      create: () =>
        prepareZCodeTelemetryEnv(runtimeEnv, {
          cliVersion: options.version,
          productVersion: options.env?.ZCODE_APP_VERSION,
          runtimeSurface,
        }),
    });
    const telemetryDeviceMid = telemetryEnv.ZCODE_TELEMETRY_DEVICE_MID;
    // MCP 遥测的 idSalt 优先用设备标识，缺失才退回本次进程 traceId（保证事件可关联且不串机）；
    // features.mcp === false 时完全不建 tracker（连统计也不产生）。
    // tracker 只在 features.mcp 未关闭时创建，关闭后连统计也不产生，避免禁用特性仍付观测开销。
    // idSalt 优先设备标识，缺失才退回本次 traceId，保证事件可关联且不跨机器混淆。
    // sink 由外部变量晚绑定，transport 未就绪时事件被丢弃而不是崩溃，这是有意的降级。
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: telemetryDeviceMid ?? traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    // 端口可按端点+网络配置在进程内复用；sourceTitle 固定 electron（此进程由 Desktop 拉起）。
    const providerEndpointRoutingPort =
      options.providerEndpointRoutingPort ??
      resolveProcessProviderEndpointRoutingPort({
        appVersion: options.version,
        env: options.env,
        logger,
        network: configResult.config.network,
        sourceTitle: "electron",
      });
    // 官方 MCP 身份头端口（spec §7.1/§7.2）：连接池构造早于 server，故用惰性 holder 回填。
    // server 就绪前该端口返回 official_auth_unavailable；HTTP tools/call 会匿名交给服务端
    // 返回结构化权限错误，stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    // 官方 MCP 身份端口在连接池构造时就需要，但 server 尚未存在，只能用 holder 延迟回填。
    // server 就绪前端口返回 official_auth_unavailable，HTTP 侧由服务端给出结构化权限错误，stdio 侧把原因下发给插件。
    // targetOrigin 与 trustedOrigins 必须共用同一个解析表达式，两侧各写一份必然造成判定分叉。
    // workspaceKey 取 identity 优先、缺失退回路径，改错会让同路径不同身份的远端工作区在审计里无法区分。
    let officialMcpAuthContext: OfficialMcpAuthRequestContext | undefined;
    // stdio 官方 MCP 没有 url 可供校验，targetOrigin 只能由宿主给出。
    // 与下面 trustedOrigins 的 resolveZCodeApiOrigin 必须是同一个表达式，否则两侧判定分叉。
    const resolveZCodeApiOrigin = (): string =>
      resolveRuntimeZCodeEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        // workspaceKey 必须遵守仓库约定 `workspaceIdentity?.trim() || workspacePath`，
        // 否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
        // 注意：agent 进程当前没有 identity 来源，因此实际多为 undefined，key 退化为 path；
        // 详见 official-mcp-auth-port.ts 的"剩余缺口"说明。
        resolveWorkspace: ({ workspaceIdentity, workspacePath }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveZCodeApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 信任判定只看一条：目标 origin 等于当前 ZCode API origin（https）。pluginId 不参与。
      // origin 运行时解析（跟随 production/test 与自建环境），不硬编码域名。
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveZCodeApiOrigin,
      }),
    };
    // MCP elicitation 归属到协议 server 的会话；pool 先于 server 创建，端口延迟绑定。
    // pool/server 构造顺序决定只能惰性绑定：elicitation 与通知都通过这个可变 holder 转发，
    // server 未就绪时 elicitation 一律 decline（不阻塞连接建立），通知直接丢弃。
    // 连接池先于 server 创建，elicitation 与通知只能通过这个可变 holder 转发，不能提前捕获具体实例。
    // server 未就绪时 elicitation 一律 decline，宁可让调用方拿到明确拒绝也不要阻塞连接建立。
    // 通知在 holder 为空时直接丢弃，不做无界排队，避免迟到消息串到下一个会话。
    let elicitationServer: {
      requestMcpElicitation: McpElicitationPort["requestElicitation"];
      handleMcpNotification: McpNotificationPort["onNotification"];
    } | null = null;
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            elicitation: {
              requestElicitation: (request, elicitationOptions) =>
                elicitationServer
                  ? elicitationServer.requestMcpElicitation(request, elicitationOptions)
                  : Promise.resolve({ action: "decline" as const }),
            },
            // server 通知同样延迟绑定到协议 server。
            notifications: {
              onNotification: (notification) =>
                elicitationServer?.handleMcpNotification(notification),
            },
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            officialMcpAuth,
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    // 设置页使用固定 leaseId；会话级 lease 由 server 的 mcpPortFactory 按 sessionId 动态获取。
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    // 只读同进程 Registry 视图；不发起 Host RPC，也不在 ModelFactory 里二次改选模型。
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new ZCodeProtocolAgentServer({
      createZCodeApp: (appOptions = {}) =>
        createZCodeApp({
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...telemetryEnv,
            ...appOptions.env,
            ...(telemetryDeviceMid ? { ZCODE_TELEMETRY_DEVICE_MID: telemetryDeviceMid } : {}),
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          providerEndpointRoutingPort,
          sourceTitle: "electron",
          onToolExecResource: (params) =>
            connection.send({ method: zcodeProtocolNotifications.toolExecResource, params }),
        }),
      cwd: options.cwd,
      env: options.env,
      loggerFactory,
      mcpPort,
      mcpTelemetry: mcpTelemetryTracker,
      sessionStore,
      syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      version: options.version,
    }));
    officialMcpAuthContext = server.officialMcpAuthRequestContext;
    elicitationServer = server;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    // transport 需要 server 的回调来消费消息与后置批次，因此必须在 server 构造完成后再创建。
    // 通知、资源采样与遥测三个 sink 都在 transport 存在后绑定，早绑会拿到未初始化的连接。
    // connection.start 之前不发送任何消息，否则写入顺序与关闭事件可能倒置。
    // transport 关闭即入口终点，断开回调会把原因交回 server 做会话收尾。
    const connection = new ZCodeProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    // server 持有 transport 之后才能绑定通知；以下三个 sink 都是晚绑定（pool 先于 transport 构建）。
    server.setNotificationSink((notification) => connection.send(notification));
    mcpResourceSink = (samples) =>
      connection.send({
        method: zcodeProtocolNotifications.mcpResourceSamples,
        params: samples,
      });
    mcpTelemetrySink = (event) => {
      // 五分钟资源通知取代旧内存通知；tracker 内部孤儿事实仍保留原判据。
      if (event.kind === "memory") return;
      connection.send({
        method: zcodeProtocolNotifications.mcpTelemetry,
        params: event,
      });
    };
    connection.start();
    mcpTelemetryTracker?.start();
    // 采样器只读本进程指标，经 transport 推送；stop 在 cleanupProtocolRuntime 中调用。
    processResourceSampler = startProtocolResourceSampler(
      server,
      (message) => connection.send(message),
      logger,
    );
    startupTimer.complete("ZCode Protocol agent startup completed", {
      event: "zcode_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  // 异常分支先把错误交给 lifecycle 触发关闭，再记录启动失败，最后原样抛出以保留调用链。
  // 非 Error 抛出物会被包成带 cause 的错误，避免上游拿到字符串后丢失堆栈。
  // 此处不再重复清理资源，回收统一留给 finally，防止两条路径互相踩踏。
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ZCode Protocol agent startup failed", error, {
      event: "zcode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    // finally 先请求关闭再执行清理，该请求幂等，成功、失败与取消都收敛到同一出口。
    // 清理带 deadline，超时也必须返回，保证进程能退出而不是卡在关闭阶段。
    // 清单必须与上方声明一致，漏传的资源不会自动回收，只会变成退出后的悬挂句柄。
    options.lifecycle?.requestShutdown();
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      processResourceSampler,
      mcpTelemetryTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    logger.info("ZCode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "zcode_protocol.shutdown.completed",
      module: "bootstrap.zcode_protocol",
      status: "completed",
    });
  }
}

// 只认显式的 remote_workspace_host；其余（含未注入）一律 desktop_local_host。
// 保留 Host 注入值，不能在入口处无条件覆盖，否则远程 SSH/WSL/容器的 Trace 会被错归本地。
function resolveProtocolRuntimeSurface(
  env: NodeJS.ProcessEnv,
): "desktop_local_host" | "remote_workspace_host" {
  // Bug 根因：入口曾无条件覆盖 Host 注入值，远程 SSH/WSL/容器 Trace 被归入本地 Desktop。
  return env.ZCODE_TELEMETRY_RUNTIME_SURFACE?.trim() === "remote_workspace_host"
    ? "remote_workspace_host"
    : "desktop_local_host";
}
