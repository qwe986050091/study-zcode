/* eslint-disable max-lines -- 远端部署入口集中编排 server/node/agent/tool 资源，拆分需单独整理边界。 */
// deploy（server/remote）深注：只写远端部署的顺序与幂等边界，不重复上传流程说明。
// 做：判定要不要部署，串起版本探测、资源包选择、installer 创建、远端锁与资源部署顺序。
// 不做：不实现传输（installer/backend）、不解析 manifest 内容、不决定资源清单本身。
// 依赖：IRemoteBackend 提供远端文件与命令能力；installer 负责落地；manifest resolver 决定新鲜度。
// 边界：本文件是编排层，必须让调用方区分跳过部署与部署失败，二者不可混淆。
// 边界：任何跳过判断都必须能被 force 或版本变化推翻，不能成为永久短路。
//
// INV-01 断言：部署决策必须在拿到远端锁之后重新计算 —— 守住它的位置：deployUsingCurrentRemoteState —— 改错故障：等待者按过期判断重复覆盖部署目录。
// INV-02 断言：caller-serialized 模式不再创建远端 lock-holder —— 守住它的位置：模式分支 —— 改错故障：为无互斥收益的路径长期占用 SSH channel。
// INV-03 断言：该模式只能由已具备 single-flight 的调用方注入 —— 守住它的位置：分支注释与选项语义 —— 改错故障：并发部署同时写同一远端目录。
// INV-04 断言：部署与释放同时失败必须抛 AggregateError —— 守住它的位置：双失败分支 —— 改错故障：释放错误覆盖部署根因，排障只剩次生症状。
// INV-05 断言：释放失败单独发生也必须上抛 —— 守住它的位置：releaseOutcome 判定 —— 改错故障：锁泄漏但调用方以为部署成功。
// INV-06 断言：部署失败仍必须执行释放 —— 守住它的位置：try/catch 包住部署而非 finally 抛错 —— 改错故障：一次失败永久占住 install-root 锁。
// INV-07 断言：锁内决策不能复用锁前结果 —— 守住它的位置：deployOutcome 赋值处 —— 改错故障：等待者在别人写完后仍按旧状态覆盖。
// INV-08 断言：本地 manifest 固定在锁内首次需要时解析 —— 守住它的位置：getLocalManifestRef —— 改错故障：等待者用旧 SHA 覆盖新 owner 的部署。
// INV-09 断言：mock 缺文件回退 CDN 时与决策共用同一份快照 —— 守住它的位置：getManifestRefForComponents —— 改错故障：SHA 跳过判断与 materialize 用了两份 manifest。
// INV-10 断言：releaseDir 缓存键必须包含组件集合与 forceRefresh —— 守住它的位置：buildReleaseDirCacheKey —— 改错故障：强刷请求命中复用缓存，实际没有重新下载。
// INV-11 断言：版本相同分支仍要按实体补齐 node-pty —— 守住它的位置：跳过分支 —— 改错故障：prebuild 被清理后永久缺失，运行时才崩。
// INV-12 断言：server-bundle 的 SHA marker 只在安装成功后写入 —— 守住它的位置：installFile 之后的写入 —— 改错故障：失败重试把旧 server 误判成当前制品。
// INV-13 断言：app 版本变化是发布边界，content-addressed 资源必须 forceRefresh —— 守住它的位置：刷新判定位 —— 改错故障：复用历史 cache 的 ready 标志，升级不生效。
// INV-14 断言：glm 强刷标记必须先于 server 更新持久化 —— 守住它的位置：markRemoteAssetComponentRefreshPending —— 改错故障：中途失败后 server 已匹配，重试不再刷新 GLM。
// INV-15 断言：只在 force、待刷新标记或版本变化时写 pending —— 守住它的位置：shouldForceRefresh 计算 —— 改错故障：每次连接都写标记，绕过 SHA 判断重复上传。
// INV-16 断言：server 版本不同必须先于身份校验返回 —— 守住它的位置：版本比较分支 —— 改错故障：用新 SHA 比对旧制品，错误信息误导。
// INV-17 断言：检查失败一律视为需要部署 —— 守住它的位置：checkServerDeployDecision 的 catch —— 改错故障：网络或权限错误被当成已部署，远端停在坏状态。
// INV-18 断言：远端 node 或 server 缺失先于版本探测返回 —— 守住它的位置：两次 exists 检查 —— 改错故障：对不存在的文件执行 --version，真实原因被掩盖。
// INV-19 断言：expectedSha256 为空时跳过身份校验 —— 守住它的位置：if (options.expectedSha256) —— 改错故障：拿 null 比对 marker，永久判定不一致。
// INV-20 断言：资源包选择在入口一次性归一 —— 守住它的位置：selectedResourcePackageIds —— 改错故障：各分支分别读配置，同事务内选择不一致。
//
// 阅读提示：先确认当前处于哪条路径（caller-serialized、锁内、版本相同），再判断注释是否仍成立。
// 幂等来源：远端文件存在性、版本、SHA marker 三层；缺任一层都会导致重复上传或误跳过。
// 并发来源：远端 install-root lock 是跨进程唯一互斥点，进程内标志不能替代它。
// 失败语义：抛出即部署失败；false 只表示命中跳过，绝不用 false 编码失败。
// 可观测性：每个跳过与回退分支都要留下带原因日志，否则远端状态与本地日志无法对齐。
// 改动前自检：是否让某条跳过分支不再检查实体文件？是否让 force 无法穿透某层缓存？
// 改动前自检：是否把 manifest 解析提前到获锁之前？是否让 release 失败被吞掉？
// 改动前自检：是否新增了第二个部署决策入口？决策必须只有 checkServerDeployDecision 一条。
// 权衡：刻意保留版本相同与需要部署两套分支，换取每条路径的日志与顺序可独立阅读。
// 结束：正文按执行顺序给出，锚点落在语句之间，不进入对象字面量的属性行之间。
import { join } from "node:path";
import {
  ZCODE_VERSION,
  formatLogPrefix,
  normalizeRemoteResourcePackageSelection,
  type RemoteAssetInstallMode,
  type RemoteResourcePackageId,
  type RemoteResourcePackageSelection,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "./backend.js";
import { deployZCodeAgentRuntime } from "./zcodeAgentDeploy.js";
import {
  deployNodePtyPrebuilds,
  deployNodeRuntime,
  createRemoteComponentVersionResolver,
  logDeployRequired,
} from "@zcode/server/remote/remoteAssetDeployDecision.js";
import {
  REMOTE_BASE,
  fileExists,
  formatOptionalValue,
  formatOptionalValues,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
} from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import { checkServerBundleRequiredMarkers } from "@zcode/server/remote/serverBundleDeployCheck.js";
import { deployRuntimeTools } from "@zcode/server/remote/runtimeToolDeploy.js";
import { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import {
  ensureRemoteReleaseDirFromCdn,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifestRef,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  fetchRemoteDownloadManifest,
  LocalUploadAssetInstaller,
  RemoteDownloadAssetInstaller,
  type RemoteAssetInstaller,
  type RemoteManifestRef,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import {
  checkRemoteAssetComponentIdentity,
  createFreshRemoteAssetManifestRefResolver,
  hasRemoteAssetComponentRefreshPending,
  markRemoteAssetComponentRefreshPending,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";
import { detectRemoteAssetTools } from "@zcode/server/remote/remoteAssetPreflight.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { acquireRemoteDeployLock } from "@zcode/server/remote/remoteDeployLock.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

// [契约] 日志前缀固定带 deploy 与 pid：远端多实例并行时，靠 pid 才能区分是哪次部署。
// 不要改成结构化 logger：本文件被 standalone 与 Host 共用，输出通道必须保持 console。
// [权衡] 前缀与参数分离，保证 grep 只按事件名即可命中。
const log = (...args: unknown[]) => console.log(formatLogPrefix("deploy", process.pid), ...args);
// [契约] warn 与 log 共用同一前缀格式，避免排障时出现两套过滤规则。
// [边界] 这里只做格式化，不决定日志级别；级别由调用点语义决定。
const logWarn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("deploy", process.pid), ...args);
const SERVER_BUNDLE_COMPONENT_ID = "server-bundle";

// [契约] caller-serialized 是调用方承诺，不是本文件的优化提示。
// [并发] 只有已具备 single-flight 的调用方可以传它，否则远端目录会出现并发写。
// [权衡] 默认走远端锁，牺牲一次 SSH channel 换跨进程正确性。
export type DeployLockMode = "remote" | "caller-serialized";

// [契约] signal 取消的是初始化与它拥有的上传，不是整个远端连接。
// [契约] force 必须能穿透版本、marker 与 cache 三层判断，不能只影响第一层。
// [边界] 新增选项默认 undefined 表示沿用旧行为，不允许隐式改变已有部署路径。
export interface DeployOptions {
  /** 取消当前远端连接初始化与其拥有的上传。 */
  signal?: AbortSignal;
  /** 开发态本地“伪 CDN”目录，运行时从这里读取 remote 资源 */
  mockCdnDir?: string;
  /** 生产态 remote 资源 CDN 基址 */
  remoteCdnBaseUrl?: string;
  /** 生产态 remote 资源 CDN 基址候选，按顺序回退 */
  remoteCdnBaseUrls?: string[];
  /** 生产态 remote 资源缓存目录 */
  remoteCacheDir?: string;
  /** 单个 manifest CDN 候选请求的超时时间，默认 10 秒。 */
  manifestRequestTimeoutMs?: number;
  /** Desktop Host 注入的远程资源 HTTP(S) 出口；standalone 未注入时保持直连。 */
  remoteAssetNetwork?: RemoteAssetNetworkPort;
  /** Force deploy even if versions match */
  force?: boolean;
  /** 等待远端 install-root deploy lock 的总 deadline，默认 120 秒。 */
  deployLockAcquireTimeoutMs?: number;
  /** 部署串行化边界；默认由远端 install-root lock 保证。 */
  deployLockMode?: DeployLockMode;
  /** SSH-only remote asset install strategy. */
  assetInstallMode?: RemoteAssetInstallMode;
  /** 只在选中资源包范围内做远端部署检查、下载和上传。 */
  resourcePackages?: RemoteResourcePackageSelection;
}

/**
 * Deploy the zcode server to the remote machine.
 * Uploads Node.js binary, server bundle, and node-pty prebuild.
 *
 * Returns true if a deploy was performed, false if skipped (version matches).
 */
// [事务] 本函数是唯一部署入口：决策、锁、执行、释放必须在这一个事务边界内完成。
// [契约] 返回值 true 表示确实部署，false 表示命中跳过；失败只能以抛错表达。
// [失败路径] 任何半成功都必须抛错，否则调用方会按成功路径放弃重试。
// [资源] 函数退出前锁必须释放，成功与失败路径都不能漏。
export async function deployServer(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options?: DeployOptions,
): Promise<boolean> {
  // [契约] platformArch 由 env 唯一推导，不要从 options 或 manifest 反推。
  // 本函数内所有组件查找都以这一份值为准，避免同一次部署出现两个平台口径。
  // [边界] 文件后部再次出现同名变量是不同作用域，不能合并成模块级常量。
  const platformArch = `${env.platform}-${env.arch}`;
  assertSupportedRemoteEnvironment(env);
  // [契约] 选择在入口归一一次，之后各分支只读这份结果。
  // [事务] 部署中途不再读配置：否则同一事务内不同资源可能按不同选择落地。
  // [边界] 归一函数不接收 options，说明选择不从部署选项传入。
  const selectedResourcePackageIds = normalizeRemoteResourcePackageSelection();
  const shouldDeployResourcePackage = (packageId: RemoteResourcePackageId): boolean =>
    selectedResourcePackageIds.includes(packageId);
  const componentResolverOptions = {
    mockCdnDir: options?.mockCdnDir,
    remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
    remoteCacheDir: options?.remoteCacheDir,
    manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
    remoteAssetNetwork: options?.remoteAssetNetwork,
  };
  // [契约] 这是本地与 mock 资源解析器，允许读 mockCdnDir。
  // 它与下面的 CDN 解析器必须分开创建：两者快照不同，混用会让 SHA 判断失真。
  // [资源] componentResolver 只快照配置，不会发起网络请求；manifest 解析推迟到首次调用，避免部署前多打一轮 CDN。
  // [并发] 单次部署内复用它，避免同一组件解析出两个不同版本。
  const resolveFreshAssetManifestRef = createFreshRemoteAssetManifestRefResolver(
    componentResolverOptions,
    env,
    {
      log,
      logWarn,
    },
  );
  const resolveFreshCdnManifestRef = createFreshRemoteAssetManifestRefResolver(
    { ...componentResolverOptions, mockCdnDir: undefined },
    env,
    { log, logWarn },
  );
  // [并发] 单飞去重：同一部署事务内 remote manifest 只请求一次。
  // [契约] 失败不缓存：promise reject 后不再复用，避免把一次网络抖动固化成本次结论。
  // [边界] 该 promise 只服务 remote-download 路径，本地上传路径不得读它。
  let remoteManifestPromise: Promise<RemoteManifestRef> | null = null;
  // [并发] 用 ??= 固定结果：重复调用复用同一个请求。
  // [契约] 请求参数全部来自 options 快照，不在首次失败后换源重试。
  // [边界] 这里只负责下载 manifest，不负责决定是否部署。
  const getRemoteManifestRef = (): Promise<RemoteManifestRef> => {
    remoteManifestPromise ??= fetchRemoteDownloadManifest(
      {
        version: ZCODE_VERSION,
        platformArch,
        remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
        manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
        remoteAssetNetwork: options?.remoteAssetNetwork,
      },
      { log, logWarn },
    );
    return remoteManifestPromise;
  };
  let localManifestRefPromise: Promise<RemoteAssetManifestRef | null> | null = null;
  // [事务] 首次调用发生在获锁之后：提前解析会让等待者用旧 SHA 覆盖新 owner 的部署。
  // [契约] 之后 GLM 身份判断与 release materialize 复用同一份快照。
  // [并发] 用 ??= 固定，重复调用不重新解析，也不做后台刷新。
  const getLocalManifestRef = (): Promise<RemoteAssetManifestRef | null> => {
    // deploy lock 可能等待较久；在获锁前就启动 fresh manifest
    // 会让等待者用旧 SHA 覆盖新 owner 的部署。改为锁内首次需要时才固定，
    // 后续 GLM 身份判断与 release materialize 仍复用同一份快照。
    localManifestRefPromise ??= resolveFreshAssetManifestRef();
    return localManifestRefPromise;
  };
  // [契约] remote-download 模式只用远端 manifest，不回退本地。
  // [契约] mock 目录缺文件且存在 CDN 或缓存回退时，改用独立的 CDN 解析器。
  // [事务] 回退判定与后续 materialize 必须共用这份返回值，不能各自再解析一次。
  // [失败路径] 无回退源时保留本地解析结果，让缺失在更靠后的上传阶段报出准确路径。
  const getManifestRefForComponents = async (
    componentIds?: string[],
  ): Promise<RemoteAssetManifestRef | null> => {
    if (options?.assetInstallMode === "remote-download") {
      return getRemoteManifestRef();
    }
    const mockReleaseDir = resolveMockCdnReleaseDir(options?.mockCdnDir);
    if (!mockReleaseDir) {
      return getLocalManifestRef();
    }
    const missingMockPaths = await findMissingMockReleasePaths(
      mockReleaseDir,
      platformArch,
      componentIds,
    );
    if (missingMockPaths.length > 0 && hasRemoteAssetCdnFallback(options)) {
      // mock manifest 存在不等于该 component 的文件完整。
      // 回退 CDN 时，SHA 跳过判断与 release materialize 必须共用同一份 CDN 快照。
      return resolveFreshCdnManifestRef();
    }
    return getLocalManifestRef();
  };
  // [资源] 进程内缓存，生命周期等于一次部署事务。
  // [契约] 缓存键包含组件集合与 forceRefresh：任一不同都必须重新解析。
  // [并发] 先查缓存再 await：并发调用可能重复解析，但不会产生错误的复用。
  const resolvedReleaseDirs = new Map<string, string | null>();
  // [契约] forceRefresh 参与缓存键，强刷请求不得命中复用缓存。
  // [契约] 日志区分 components 为 all 与具体列表，便于对齐后续上传记录。
  // [边界] 返回 null 表示没有可用 release 目录，不是错误。
  const getReleaseDir = async (
    componentIds?: string[],
    resolutionOptions?: { forceRefresh?: boolean },
  ): Promise<string | null> => {
    const forceRefresh = Boolean(resolutionOptions?.forceRefresh);
    const cacheKey = buildReleaseDirCacheKey(componentIds, forceRefresh);
    if (resolvedReleaseDirs.has(cacheKey)) {
      return resolvedReleaseDirs.get(cacheKey) ?? null;
    }
    const releaseDir = await resolveReleaseDir(
      options,
      env,
      { log, logWarn },
      componentIds,
      await getManifestRefForComponents(componentIds),
      forceRefresh,
    );
    resolvedReleaseDirs.set(cacheKey, releaseDir);
    log(
      "releaseDir:",
      releaseDir ?? "<missing>",
      "components:",
      componentIds?.join(",") ?? "<all>",
    );
    return releaseDir;
  };
  // [契约] SHA 只从 manifest 读取，不在此计算本地文件哈希。
  // [事务] 与 releaseDir 使用同一份 manifest 快照，保证制品身份一致。
  const getComponentSha256 = async (componentId: string): Promise<string | null> => {
    const manifestRef = await getManifestRefForComponents([componentId]);
    return manifestRef
      ? (selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ??
          null)
      : null;
  };
  // [契约] 这里只做选项搬运，不在此决定 assetInstallMode。
  // [契约] resolveReleaseDir 与 resolveComponentSha256 成对注入，installer 依赖两者一致。
  // [边界] 新增字段必须同时出现在此处与 installer options，否则会出现静默默认值。
  const assetDeployOptions = {
    signal: options?.signal,
    resolveReleaseDir: getReleaseDir,
    resolveComponentSha256: getComponentSha256,
    remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
    remoteCacheDir: options?.remoteCacheDir,
    manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
    remoteAssetNetwork: options?.remoteAssetNetwork,
  };
  const getComponentVersion = createRemoteComponentVersionResolver(componentResolverOptions, env, {
    log,
    logWarn,
  });
  // [契约] 模式决定实现：remote-download 用远端下载，其余走本地上传。
  // [事务] 传入 getRemoteManifest 作为固定 manifest 来源，保证下载与决策同源。
  // [资源] installer 自身不持有连接，可安全跨多个组件复用。
  const installer = createRemoteAssetInstaller(
    backend,
    {
      ...assetDeployOptions,
      platformArch,
      version: ZCODE_VERSION,
      assetInstallMode: options?.assetInstallMode,
    },
    { log, logWarn },
    options?.assetInstallMode === "remote-download" ? getRemoteManifestRef : null,
  );
  // [契约] 优先用 installer 的解析能力：它知道当前安装模式下期望版本从哪来。
  // [契约] 回退到 CDN resolver 是为了 mock-cdn，否则该分支拿不到 expectedVersion。
  // [失败路径] 两者都拿不到时返回 null，表示不做版本比较，不等于无需部署。
  const getExpectedComponentVersion = async (componentId: string): Promise<string | null> => {
    if (installer.resolveComponentVersion) {
      const installerVersion = await installer.resolveComponentVersion(componentId);
      if (installerVersion) {
        return installerVersion;
      }
    }

    // 开发态 mock-cdn 的 manifest 由 LocalUploadAssetInstaller 读取；
    // 之前部署决策只走 CDN resolver，mock-cdn 分支拿不到 expectedVersion，
    // 导致主 server 需要刷新时反复把已匹配的 node-runtime 全量上传。
    return getComponentVersion(componentId);
  };

  log("mockCdnDir:", options?.mockCdnDir ?? "<missing>");
  log("remoteCdnBaseUrl:", formatOptionalValue(options?.remoteCdnBaseUrl));
  log("remoteCdnBaseUrls:", formatOptionalValues(options?.remoteCdnBaseUrls));
  log("remoteCacheDir:", formatOptionalValue(options?.remoteCacheDir));
  log("remote env:", platformArch);
  log("selected remote resource packages:", selectedResourcePackageIds.join(","));

  // [事务] 决策一旦传入就不再重算：重算会让标记与分支走到不同结论。
  // [契约] 版本相同分支也要补齐 node-pty 与随包资源。
  // [契约] 需要部署分支顺序：node-runtime、server-bundle、node-pty、agent runtime、tools。
  // [失败路径] 任一 await 抛错即中断，不吞错、不继续后续组件。
  const deployWithDecision = async (
    serverDeployDecision: ServerDeployDecision,
    expectedServerBundleSha256: string | null,
  ): Promise<boolean> => {
    const hasPendingAppVersionRefresh = await hasRemoteAssetComponentRefreshPending(backend, {
      componentId: "glm",
      platformArch,
    });
    // [事务] force、待刷新标记、版本变化三者取或，任一成立都要绕过同 SHA cache。
    // [契约] 只看 appVersionChanged 是否为 true，不看 reason 文本。
    // [契约] 该布尔值要同时传给 server-bundle、glm 与 tools 三处，不能各自重算。
    // [权衡] 版本升级时宁可让 glm 多下一次，也不复用旧制品：同 SHA cache 命中旧包会让升级静默失效。
    const shouldForceRefreshContentAddressedAssets =
      Boolean(options?.force) ||
      hasPendingAppVersionRefresh ||
      (serverDeployDecision.shouldDeploy && serverDeployDecision.appVersionChanged === true);

    if (shouldForceRefreshContentAddressedAssets) {
      // server 会先于 GLM 更新；若后续步骤失败，下次连接时 server 版本
      // 已经匹配。必须持久化升级强刷状态，让重试继续绕过同 SHA cache，直到 GLM 成功覆盖 marker。
      await markRemoteAssetComponentRefreshPending(backend, {
        componentId: "glm",
        platformArch,
        appVersion: ZCODE_VERSION,
      });
    }

    // Check if deploy is needed
    // [契约] 跳过主 server 不代表资源齐全：这里仍要补 prebuild、GLM 与工具。
    // [事务] node-pty 用 onlyIfMissing，不覆盖已有文件。
    // [契约] 该分支的 force 传的是刷新判定位，不是 options.force，两者语义不同。
    // [契约] 返回 false 表示没有部署 server，但可能已补齐资源，调用方不能认为毫无副作用。
    if (!serverDeployDecision.shouldDeploy) {
      log("skipped — remote version matches");
      // 主 server 版本相同只证明 node/zcode-server.cjs 可启动，不代表随包工具仍存在。
      // glm 内容跟随 app/server 版本刷新；但 wrapper/bundle 被清理或开发态 bundle 变化时仍要按实体检查修复。
      if (shouldDeployResourcePackage("node-pty")) {
        await deployNodePtyPrebuilds(
          backend,
          env,
          {
            ...assetDeployOptions,
            platformArch,
            onlyIfMissing: true,
            installer,
          },
          { log, logWarn },
        );
      }
      await deployZCodeAgentRuntime(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          installer,
          force: shouldForceRefreshContentAddressedAssets,
          selectedResourcePackageIds,
        },
        { log, logWarn },
      );
      await deployRuntimeTools(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          installer,
          selectedResourcePackageIds,
        },
        { log, logWarn },
      );
      return false;
    }

    // [契约] node-runtime 必须在 server-bundle 之前：后者依赖前者解释执行。
    // [契约] expectedVersion 来自当前安装模式，不能硬编码 ZCODE_VERSION。
    // [权衡] force 只透传 options.force，不受 GLM 刷新标记影响。
    await deployNodeRuntime(
      backend,
      {
        ...assetDeployOptions,
        platformArch,
        force: Boolean(options?.force),
        installer,
        expectedVersion: await getExpectedComponentVersion("node-runtime"),
      },
      { log, logWarn },
    );

    logDeployRequired({
      loggers: { logWarn },
      installer,
      componentId: SERVER_BUNDLE_COMPONENT_ID,
      reason: serverDeployDecision.reason,
    });
    await installer.installFile({
      componentId: SERVER_BUNDLE_COMPONENT_ID,
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: `${REMOTE_BASE}/zcode-server.cjs`,
      // App 版本变化是新的发布边界，不能只凭历史 cache 的 `.ready`
      // 判断 server-bundle 可复用；与 GLM 一致，必须重新下载并校验当前 manifest 制品。
      forceRefresh: shouldForceRefreshContentAddressedAssets,
    });
    // [事务] marker 只在 installFile 成功返回后写，失败重试才不会把旧 server 当成当前制品。
    // [契约] 没有期望 SHA 时跳过写入，而不是写空值。
    // [契约] marker 的 platformArch 必须与本事务一致，否则身份校验永远不命中。
    if (expectedServerBundleSha256) {
      // App/version 相同不代表 server-bundle 制品相同。安装成功后才写
      // manifest SHA marker，避免失败重试把旧 server 误判成当前制品。
      await writeRemoteAssetComponentMeta(backend, {
        id: SERVER_BUNDLE_COMPONENT_ID,
        sha256: expectedServerBundleSha256,
        platformArch,
      });
    }
    log("server install done");

    if (shouldDeployResourcePackage("node-pty")) {
      await deployNodePtyPrebuilds(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          force: Boolean(options?.force),
          onlyIfMissing: false,
          installer,
          expectedVersion: await getExpectedComponentVersion("node-pty"),
        },
        { log, logWarn },
      );
    }

    log("all uploads complete");

    // 部署 ZCode Agent runtime 到远程，历史资源包选择已在入口统一忽略。
    await deployZCodeAgentRuntime(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        installer,
        // 旧版 App 会覆盖 agents/glm，却不会同步新版引入的 GLM SHA marker。
        // App 版本变化后该 marker 可能与实际 bundle 不一致，必须绕过 marker 与远端 cache，
        // 按当前 App 的 manifest 重新下载并部署；同 App 版本内仍按 SHA 精确判断。
        force: shouldForceRefreshContentAddressedAssets,
        selectedResourcePackageIds,
      },
      { log, logWarn },
    );
    await deployRuntimeTools(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        installer,
        selectedResourcePackageIds,
      },
      { log, logWarn },
    );

    return true;
  };

  // [事务] force 时直接构造 shouldDeploy，但仍要读 expectedSha256 供后续 marker 使用。
  // [契约] expectedSha256 来自 manifest，不是本地文件哈希。
  // [事务] 该函数必须在持锁后调用，锁外调用会读到别人写了一半的状态。
  const deployUsingCurrentRemoteState = async (): Promise<boolean> => {
    const expectedServerBundleSha256 = await getComponentSha256(SERVER_BUNDLE_COMPONENT_ID);
    const decision = options?.force
      ? {
          shouldDeploy: true,
          reason: "force deploy requested",
        }
      : await checkServerDeployDecision(backend, {
          platformArch,
          expectedSha256: expectedServerBundleSha256,
        });
    return deployWithDecision(decision, expectedServerBundleSha256);
  };

  // [并发] 该模式由调用方保证 single-flight，本文件不再建远端 lock-holder。
  // [契约] caller-serialized 只跳过 acquireRemoteDeployLock，决策与资源检查一步不减，串行化责任上移给调用方。
  // [权衡] 少占一条 SSH channel，代价是把串行化责任显式上移。
  if (options?.deployLockMode === "caller-serialized") {
    // 桌面 SSH 已由窗口级 shared Host readiness 保证同一 target 只有一个部署事务；
    // 若仍创建 remote lock-holder，会为无额外互斥收益的路径长期占用 SSH channel。
    // 该模式必须由已具备 single-flight 的调用方显式注入，WSL/Docker 和其他调用继续默认远端锁。
    return deployUsingCurrentRemoteState();
  }

  // [契约] 锁前决策只用来打印等待原因，不能用作最终部署依据。
  // [契约] expectedSha256 传 null：此时还没有锁内 manifest，身份校验必须留到锁后。
  // [边界] 它在获锁前执行，不能在这里 materialize 或写任何远端文件。
  const preLockDecision = options?.force
    ? { shouldDeploy: true as const, reason: "force deploy requested" }
    : await checkServerDeployDecision(backend, {
        platformArch,
        expectedSha256: null,
      });
  if (preLockDecision.shouldDeploy) {
    log(`waiting for install-root lock: ${preLockDecision.reason}`);
  }
  // [资源] 锁获取失败直接抛，不能降级成无锁部署。
  // [契约] acquireTimeoutMs 由 options 控制，缺省由锁实现决定。
  // [并发] 该锁是跨进程唯一互斥点，进程内标志不能替代。
  const deployLock = await acquireRemoteDeployLock(backend, {
    acquireTimeoutMs: options?.deployLockAcquireTimeoutMs,
  });
  // [失败路径] try 包住部署并捕获错误，是为了保证释放一定执行。
  // [契约] catch 先存 deployOutcome 不立即抛，等 releaseOutcome 落定后再统一抛出，否则锁会泄漏。
  // [事务] 锁内必须重新决策，不能复用 preLockDecision。
  // [契约] 结果用可辨识联合保存，避免用 undefined 表达失败。
  let deployOutcome: { ok: true; value: boolean } | { ok: false; error: unknown };
  try {
    // 进程内 WSL single-flight 无法覆盖不同 Desktop/build/backend。
    // 获得远端 install-root lock 后必须重新检查，等待者不能按过期判断重复覆盖部署目录。
    deployOutcome = {
      ok: true,
      value: await deployUsingCurrentRemoteState(),
    };
  } catch (error) {
    deployOutcome = { ok: false, error };
  }

  // [失败路径] 释放单独失败也要记录并上抛，不能吞。
  // [契约] 用独立 try 捕获，避免释放抛错跳过部署错误的处理。
  // [事务] releaseOutcome 与 deployOutcome 分开保存，两者组合决定抛 AggregateError 还是单因异常，且先报根因。
  let releaseOutcome: { ok: true } | { ok: false; error: unknown };
  try {
    await deployLock.release();
    releaseOutcome = { ok: true };
  } catch (error) {
    releaseOutcome = { ok: false, error };
  }
  // [失败路径] 同时失败必须抛 AggregateError，保留两条因果链。
  // [契约] 不要用 finally 直接抛释放错误：它会覆盖真正的部署失败。
  // [契约] 顺序固定：双失败、部署失败、释放失败，先报根因。
  if (!deployOutcome.ok && !releaseOutcome.ok) {
    // finally 内直接抛 release 错误会覆盖真正的部署失败，排障只能看到次生症状。
    // AggregateError 同时保留 deploy 与 release 两条因果链，且 release deadline 保证这里有界返回。
    throw new AggregateError(
      [deployOutcome.error, releaseOutcome.error],
      "remote deployment and deploy-lock release both failed",
    );
  }
  if (!deployOutcome.ok) {
    throw deployOutcome.error;
  }
  if (!releaseOutcome.ok) {
    throw releaseOutcome.error;
  }
  return deployOutcome.value;
}

type ServerDeployDecision =
  | { shouldDeploy: false }
  | {
      shouldDeploy: true;
      reason: string;
      appVersionChanged?: boolean;
    };

// [契约] 决策只有这一条入口：不要在调用点另写一套存在性与版本判断。
// [契约] 检查顺序：node 存在、server 存在、版本、必需标记、SHA 身份。
// [失败路径] catch 一律返回 shouldDeploy 为 true，宁可重部署也不要停在坏状态。
async function checkServerDeployDecision(
  backend: IRemoteBackend,
  options: {
    platformArch: string;
    expectedSha256: string | null;
  },
): Promise<ServerDeployDecision> {
  try {
    log("checking if deploy needed...");
    const nodePath = `${REMOTE_BASE}/node`;
    const exists = await backend.exists(nodePath);
    log("remote node exists:", exists);
    if (!exists) {
      return {
        shouldDeploy: true,
        reason: `remote file missing path=${nodePath}`,
      };
    }

    const serverPath = `${REMOTE_BASE}/zcode-server.cjs`;
    const serverExists = await backend.exists(serverPath);
    log("remote server exists:", serverExists);
    if (!serverExists) {
      return {
        shouldDeploy: true,
        reason: `remote file missing path=${serverPath}`,
      };
    }

    // Check version
    log("checking remote version...");
    const stream = await backend.exec(
      `${quotePosixPathArg(nodePath)} ${quotePosixPathArg(serverPath)} --version`,
    );
    const version = (await collectStdout(stream)).trim();
    log("remote version:", JSON.stringify(version), "local:", ZCODE_VERSION);
    if (version !== ZCODE_VERSION) {
      return {
        shouldDeploy: true,
        reason: `remote server version mismatch remote=${version} expected=${ZCODE_VERSION}`,
        appVersionChanged: true,
      };
    }
    const requiredFeatureDecision = await checkServerBundleRequiredMarkers(
      backend,
      nodePath,
      serverPath,
    );
    if (requiredFeatureDecision.shouldDeploy) {
      return requiredFeatureDecision;
    }
    if (options.expectedSha256) {
      const identityDecision = await checkRemoteAssetComponentIdentity(backend, {
        componentId: SERVER_BUNDLE_COMPONENT_ID,
        platformArch: options.platformArch,
        expectedIdentity: { sha256: options.expectedSha256 },
      });
      if (identityDecision.shouldDeploy) {
        return identityDecision;
      }
    }
    return { shouldDeploy: false };
  } catch (err) {
    log("checkServerDeployDecision error (will deploy):", err);
    return {
      shouldDeploy: true,
      reason: `remote deploy check failed: ${String(err)}`,
    };
  }
}

// [契约] 非 remote-download 模式直接返回本地上传实现，不建远端工具探测。
// [并发] remoteInstallerPromise 单飞：工具探测只做一次。
// [契约] getPinnedRemoteManifest 优先于自建 manifest，保证与决策同源。
// [资源] 返回值是包装层，不持有额外连接。
function createRemoteAssetInstaller(
  backend: IRemoteBackend,
  options: RemoteAssetDeployOptions & {
    version: string;
    platformArch: string;
    assetInstallMode?: RemoteAssetInstallMode;
  },
  loggers: DeployLoggers,
  getPinnedRemoteManifest: (() => Promise<RemoteManifestRef>) | null = null,
): RemoteAssetInstaller {
  if (options.assetInstallMode !== "remote-download") {
    return new LocalUploadAssetInstaller(backend, options, loggers);
  }

  let remoteInstallerPromise: Promise<RemoteAssetInstaller> | null = null;
  let remoteManifestPromise: ReturnType<typeof fetchRemoteDownloadManifest> | null = null;
  const getRemoteManifest = (): ReturnType<typeof fetchRemoteDownloadManifest> => {
    if (getPinnedRemoteManifest) {
      return getPinnedRemoteManifest();
    }
    if (!remoteManifestPromise) {
      remoteManifestPromise = fetchRemoteDownloadManifest(options, loggers);
    }
    return remoteManifestPromise;
  };
  const getRemoteInstaller = async (): Promise<RemoteAssetInstaller> => {
    if (!remoteInstallerPromise) {
      remoteInstallerPromise = detectRemoteAssetTools(backend, loggers).then(
        (tools) =>
          new RemoteDownloadAssetInstaller(backend, options, tools, loggers, getRemoteManifest()),
      );
    }
    return remoteInstallerPromise;
  };

  return {
    mode: "remote-download",
    async resolveComponentVersion(componentId) {
      const manifestRef = await getRemoteManifest();
      return (
        selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.version ?? null
      );
    },
    async resolveComponentSha256(componentId) {
      const manifestRef = await getRemoteManifest();
      return (
        selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ?? null
      );
    },
    async installFile(params) {
      const remoteInstaller = await getRemoteInstaller();
      await remoteInstaller.installFile(params);
    },
    async installDirectory(params) {
      const remoteInstaller = await getRemoteInstaller();
      await remoteInstaller.installDirectory(params);
    },
  };
}

// [契约] 组件集合先排序再拼接：顺序不同但集合相同必须命中同一缓存。
// [契约] forceRefresh 必须进键，否则强刷会复用旧目录。
function buildReleaseDirCacheKey(componentIds: string[] | undefined, forceRefresh = false): string {
  const componentKey =
    componentIds && componentIds.length > 0 ? componentIds.slice().sort().join(",") : "<all>";
  return `${componentKey}:${forceRefresh ? "force" : "reuse"}`;
}

// [契约] mock 目录按版本分层：releases 下再拼当前版本。
// [边界] 没有 mockCdnDir 返回 null，表示不进入 mock 分支。
function resolveMockCdnReleaseDir(mockCdnDir?: string): string | null {
  if (!mockCdnDir) {
    return null;
  }

  return join(mockCdnDir, "releases", ZCODE_VERSION);
}

// [契约] mock 目录完整就直接用；缺文件且有回退源才去 CDN 或缓存。
// [契约] 无回退源时返回 mock 目录本身，保留后续文件不存在的准确错误。
// [事务] 回退时传入同一份 manifestRef 与 forceRefresh，保证与决策一致。
async function resolveReleaseDir(
  options: DeployOptions | undefined,
  env: RemoteEnvironment,
  loggers: {
    log: (...args: unknown[]) => void;
    logWarn: (...args: unknown[]) => void;
  },
  componentIds?: string[],
  manifestRef?: RemoteAssetManifestRef | null,
  forceRefresh = false,
): Promise<string | null> {
  const mockReleaseDir = resolveMockCdnReleaseDir(options?.mockCdnDir);
  const platformArch = `${env.platform}-${env.arch}`;
  if (mockReleaseDir) {
    const missingMockPaths = await findMissingMockReleasePaths(
      mockReleaseDir,
      platformArch,
      componentIds,
    );
    if (missingMockPaths.length === 0) {
      return mockReleaseDir;
    }

    // WSL/SSH 开发态可能只有版本目录，但缺当前远端平台的具体组件
    // （例如 Windows 侧 mock-cdn 只有 linux-arm64，却连接 linux-x64 WSL）。
    // 直接返回 mock 目录会在上传阶段报 local remote asset not found；
    // 有 CDN/cache 时应按组件回退到完整缓存，没有回退源时保留原错误指向缺失文件。
    loggers.logWarn(
      `[remote-assets] mock-cdn incomplete for ${platformArch}; missing=${missingMockPaths.join(", ")}`,
    );
    if (!hasRemoteAssetCdnFallback(options)) {
      return mockReleaseDir;
    }

    loggers.logWarn(
      `[remote-assets] fallback to CDN/cache for ${platformArch}; components=${componentIds?.join(",") ?? "<all>"}`,
    );
  }

  // 生产态不再打包 remote 资源，必须先从 CDN 下载到本地 cache。
  // 这里统一把“拿 releaseDir”的逻辑收口，避免后续各资源分支继续散落占位判断。
  return ensureRemoteReleaseDirFromCdn(
    {
      remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
      remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
      remoteCacheDir: options?.remoteCacheDir,
      version: ZCODE_VERSION,
      platformArch,
      componentIds,
      manifestRef,
      forceRefresh,
      manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
      remoteAssetNetwork: options?.remoteAssetNetwork,
    },
    loggers,
  );
}

// [契约] 必须同时有缓存目录与至少一个基址，缺一不能回退。
// [契约] 空白字符串按缺失处理，不能只用 Boolean 判 truthy。
function hasRemoteAssetCdnFallback(options: DeployOptions | undefined): boolean {
  const hasRemoteCacheDir = Boolean(options?.remoteCacheDir?.trim());
  const hasBaseUrl = Boolean(options?.remoteCdnBaseUrl?.trim());
  const hasBaseUrls = Boolean(
    options?.remoteCdnBaseUrls?.some((baseUrl) => baseUrl.trim().length > 0),
  );
  return hasRemoteCacheDir && (hasBaseUrl || hasBaseUrls);
}

// [契约] 逐路径做真实文件存在性检查，不信任目录存在。
// [契约] 返回的缺失列表同时供日志与回退判断使用，不要只用于打印。
async function findMissingMockReleasePaths(
  releaseDir: string,
  platformArch: string,
  componentIds: string[] | undefined,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const relativePath of resolveRequiredMockReleasePaths(platformArch, componentIds)) {
    if (!(await fileExists(releaseDir, ...relativePath.split("/")))) {
      missingPaths.push(relativePath);
    }
  }
  return missingPaths;
}

// [契约] 未指定组件时只要求 server-bundle 与 node-runtime，这是最小可启动集。
// [契约] 每个组件的要求路径必须与安装侧一致，否则回退判断会漏检。
// [契约] darwin 额外要求 spawn-helper，遗漏会在运行时才失败。
function resolveRequiredMockReleasePaths(
  platformArch: string,
  componentIds: string[] | undefined,
): string[] {
  const ids =
    componentIds && componentIds.length > 0
      ? componentIds
      : [SERVER_BUNDLE_COMPONENT_ID, "node-runtime"];
  const requiredPaths = new Set<string>();

  for (const componentId of ids) {
    switch (componentId) {
      case SERVER_BUNDLE_COMPONENT_ID:
        requiredPaths.add("server/zcode-server.cjs");
        break;
      case "node-runtime":
        requiredPaths.add(`node/${platformArch}/node`);
        break;
      case "node-pty":
        requiredPaths.add(`node-pty/${platformArch}/pty.node`);
        if (platformArch.startsWith("darwin-")) {
          requiredPaths.add(`node-pty/${platformArch}/spawn-helper`);
        }
        break;
      case "glm":
        requiredPaths.add(`glm/${platformArch}/zcode.cjs`);
        for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
          requiredPaths.add(`glm/${platformArch}/packages/${relativePath}`);
        }
        break;
      case "bfs":
        requiredPaths.add(`tools/${platformArch}/bfs/bfs`);
        break;
      case "ripgrep":
        requiredPaths.add(`tools/${platformArch}/ripgrep/rg`);
        break;
      case "ugrep":
        requiredPaths.add(`tools/${platformArch}/ugrep/ugrep`);
        break;
    }
  }

  return [...requiredPaths];
}

// [契约] 以 onClose 而不是 data 结束为准：版本输出可能分片。
// [资源] 只消费 stdout，stderr 由调用方另行处理。
function collectStdout(stream: import("./backend.js").StdioStream): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stream.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.onClose(() => resolve(data));
  });
}
