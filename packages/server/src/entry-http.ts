/**
 * ============================================================================
 * entry-http.ts —— 独立 zcode-server 进程入口（HTTP/WS 侧，非 core 子进程）
 * ============================================================================
 *
 * 【整体位置】
 *   本文件是进程的第一段代码，只做三件事：物化内置 Provider 配置 → 装配 services →
 *   交出端口开始监听。真正的业务装配在 @zcode/services/node 的 createServerHostServices，
 *   HTTP 路由与 WS 升级在 ./http.ts 的 createHttpServer。
 *
 * 【启动顺序（不可交换）】
 *   1. materializeBundledZCodeBuiltinProviderConfig：配置必须在 services 构造前落到
 *      ~/.zcode 配置根，createLocalServices 构造时就会读这个路径；晚写一步等于让服务
 *      带着空 Provider 配置启动。
 *   2. 读环境变量：PORT / ZCODE_SERVER_HOST / HOST / ZCODE_WEB_STATIC_ROOT /
 *      ZCODE_SERVER_AUTH_TOKEN。这些是启动期决策，运行中不再回读（见 http.ts 鉴权段）。
 *   3. createTopicResourcePeers：建立「已鉴权连接 → 资源回取通道」的路由表，进程级单例；
 *      只有 desktop-continuous 且拿到 IZCodeAgentService 的连接会在 WS 升级时 attach，
 *      web 连接不 attach，断连时 dispose；它不持有任务状态。
 *   4. createServerHostServices：先派生 projectStorageHostId，再跑存储迁移屏障（迁移消费
 *      该身份），然后构造 workspaceIdentityMapper 与 services 集合
 *      （serviceAuthorityMode=standalone-server，
 *      因此不会以 local owner 身份开放远端项目 RPC）。迁移失败数在这里读取一次，随后透传给
 *      server-info 供客户端提示。
 *   5. createHttpServer：注册路由并 serve；此处只挂载传输层，不初始化任何业务。
 *
 * 【通道路径（读者从这里进入 RPC）】
 *   客户端先 GET /api/server-info 拿到 serverId 与能力位，再升级 /ws（web）或
 *   /ws/host（desktop，需一次性 capability）。升级成功后才在 http.ts 的 onOpen 里
 *   setupChannelServer 建 SocketProtocol/ChannelServer，并用 services.exposeOnChannelServer
 *   把 IZCodeAgentService 等频道暴露出去——也就是说，「通道」是每条 WS 连接各自建立的，
 *   不是进程启动时建好的；本文件只保证 services 在监听前已就绪。
 *
 * 【与 zcodeAgentService 的衔接】
 *   createServerHostServices 返回的 services 里含 IZCodeAgentService 单例；http.ts 每个
 *   连接从它派生一个 connectionScope（随机 connectionId + 由 clientMode 决定的 role），
 *   再以同名频道覆盖注入。所以 agent 状态是进程内共享的，连接隔离只体现在 scope 与
 *   clientMode 上；topicResourcePeers 则负责把连接侧的资源请求反向路由回该连接。
 *
 * 【失败语义】
 *   启动任何一步抛错都走 main().catch：只打一行 startup failed 日志（当前未附带 pid）并置
 *   exitCode=1，不调用 process.exit——让已打开句柄（监听端口、SQLite）自行收敛，避免截断
 *   stdout 与迁移日志。
 * ============================================================================
 */
import {
  createServerHostServices,
  createTopicResourcePeers,
  getAppConfigDir,
} from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";

async function main(): Promise<void> {
  // 必须先物化再装配：services 构造时按这个路径读取内置 Provider 配置。
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  // 端口缺省 3030。注意 `Number(env.PORT) || 3030` 会把 PORT=0 也当成缺省（0 是 falsy），
  // 因此 PORT=0 实际得到 3030，不会走系统分配；留空或非数字同样回落到 3030。
  const port = Number(process.env["PORT"]) || 3030;
  // host 未显式配置时不传 hostname，交给 @hono/node-server 的默认绑定行为。
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  // 只有给了静态根，http.ts 才会注册 catch-all 与 SPA fallback；否则未知路径走 Hono 默认 404。
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  // token 同时决定两件事：/api 与 /ws 的鉴权中间件是否注册；以及
  // providerProvisioningTargetEnabled——未配 token 时 IProviderProvisioningTargetService
  // 压根不注册（见 createLocalServices），配了才注册、再由 http.ts 按 clientMode 限权。
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // 进程级资源回取路由表：getChannel 按 workspaceIdentity+session 惰性取连接通道，
  // 连接侧在 WS 升级时 attach、断连时 dispose。
  const topicResourcePeers = createTopicResourcePeers();
  // serverId 三级回退（显式 → ZCODE_SERVER_ID → hostname → "zcode-server"），
  // 它同时是项目存储身份与 server-info 的稳定标识，必须在装配 services 前定下来。
  const serverId = resolveHttpServerId();
  // 装配顺序：先派生项目存储身份（projectStorageHostId）→ 再跑迁移屏障（迁移消费该身份）
  // → alias repo/mapper → services 集合。
  // migrationFailedPathCount 是迁移阶段的一次性读数，之后只作为展示字段透传。
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
      sourceServerId: serverId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
    });

  // 监听放在 services 就绪之后：WS 升级回调会从 services 里取 IZCodeAgentService，
  // 先监听再装配等于留出一个「连接已建立但服务不存在」的窗口。
  createHttpServer(services, port, {
    serverId,
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  // 只标记失败并让事件循环自然收敛；这里 process.exit() 会丢掉尚未 flush 的启动日志。
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
