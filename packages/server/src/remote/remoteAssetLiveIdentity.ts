// INV-01 元数据目录只有一个来源；守住位置：REMOTE_ASSET_COMPONENT_META_DIR 常量与 buildRemoteAssetComponentMetaPath 的拼接；改错故障：读与写落到两个目录，部署后每次检测都判定缺少 marker 并反复重装。
// INV-02 [并发] 本次部署的 manifest 只取一次；守住位置：createFreshRemoteAssetManifestRefResolver 内 manifestPromise 的 ??= 赋值；改错故障：并发组件各自请求 CDN，同一次部署可能出现两份不同 SHA 的制品。
// INV-03 [权衡] 组件身份只认内容哈希；守住位置：RemoteAssetComponentIdentity 仅含 sha256，formatIdentity 只返回该字段；改错故障：把 version 重新拉进身份判断，同版本重发制品会被误判为已是最新。
// INV-04 判定结果是穷尽二态；守住位置：RemoteAssetComponentIdentityDecision 的 shouldDeploy 真假分支；改错故障：新增第三态或省略 reason，调用方无法解释重装原因，排障日志失去依据。
// INV-05 [失败路径] 远端元数据缺失必须重装；守住位置：checkRemoteAssetComponentIdentity 开头的 !remoteMeta 分支；改错故障：把缺失当已安装跳过部署，运行目录实际不存在。
// INV-06 组件 id 不符视为他人目录；守住位置：remoteMeta.id 与 options.componentId 的不等分支；改错故障：组件改名后继续复用旧目录，远端跑的是上一代制品。
// INV-07 平台架构不符必须重装；守住位置：remoteMeta.platformArch 与 options.platformArch 的比较分支；改错故障：x64 与 arm64 共用同名目录，加载到错误架构的二进制。
// INV-08 [失败路径] 旧 marker 缺 SHA 必须重装；守住位置：!remoteMeta.sha256 分支及其上方两句说明；改错故障：旧 live marker 只有 version，无法证明运行目录来自当前 manifest，却按语义版本直接跳过。
// INV-09 SHA 比较前做空白与大小写归一；守住位置：两处 sha256 先裁剪再转小写的比较条件；改错故障：大小写差异被判为不一致，每次部署都重装同一份制品。
// INV-10 [失败路径] 读 meta 失败不向上抛；守住位置：readRemoteAssetComponentMeta 末尾的 catch 返回 null；改错故障：远端首次部署尚无该文件时直接报错中断，永远走不到写入分支。
// INV-11 解析结果逐字段校验类型；守住位置：id、platformArch、version、sha256、pendingRefreshAppVersion 的 typeof 判断；改错故障：残缺 JSON 被当作合法 marker，后续比较在 undefined 上做判断。
// INV-12 可选字段只在有值时回填；守住位置：返回对象里三处条件展开；改错故障：把空串写成 version 或 sha256，使缺 SHA 的判定失效。
// INV-13 [事务] unknown 版本不落盘；守住位置：writeRemoteAssetComponentMeta 开头 version 为 unknown 且无 sha256 的提前返回；改错故障：写入一个永久失配的 marker，此后每次都认为远端已有状态。
// INV-14 [资源] 写 marker 先建目录再落文件；守住位置：mkdir -p 与 buildWriteLiteralFileCommand 以 && 串联后 waitForClose；改错故障：目录不存在导致写失败，或未等命令流关闭就继续，读到半截 JSON。
// INV-15 [权衡] 刷新标记与正式 meta 共用同一文件；守住位置：markRemoteAssetComponentRefreshPending 只传 id、platformArch 与 pendingRefreshAppVersion；改错故障：另开文件后读侧看不到标记，或覆盖掉已写入的 SHA。
// INV-16 pending 判定三条件同时成立；守住位置：hasRemoteAssetComponentRefreshPending 对 id、platformArch 与 pendingRefreshAppVersion 的联合判断；改错故障：只看字段存在，跨组件或跨架构的残留标记会误触发刷新。
// INV-17 [失败路径] 配了 manifest 源却取不到必须抛错；守住位置：resolveFreshComponentManifest 中 !manifestRef && hasConfiguredManifestSource 的抛错分支；改错故障：退回安装器再请求一次，发布切换时可能装到另一份制品。
// INV-18 [失败路径] 网络与解析错误不降级；守住位置：resolveFreshComponentManifest 末尾 catch 内 logWarn 之后的重新抛出；改错故障：把失败改写成 null，丢失原始诊断并让本次部署的 pinned identity 变成缺失。
//
// 模块职责：定义远端资源组件的身份契约，负责读取、写入与比较落在远端 .asset-components 下的组件元数据，并决定本次部署是否需要重装组件。
// 状态所有权：远端 meta 文件是唯一事实，进程内只有 createFreshRemoteAssetManifestRefResolver 持有一次部署的 manifest promise，不缓存组件安装状态。
// 阅读顺序：先读两个身份接口与决策类型，再看 check 的比较顺序，随后读 read 的容错解析、write 的落盘约束、pending 标记对，最后看 manifest 解析的 mock 与 CDN 两条路径。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import type { RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
} from "@zcode/server/remote/posixShell.js";
import {
  fetchRemoteAssetManifestRefFromCdn,
  type RemoteAssetManifest,
  type RemoteAssetManifestRef,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

// [契约] 组件元数据统一放在远端基目录下的 .asset-components，读、写与失效判断都以此为根。
// [契约] buildRemoteAssetComponentMetaPath 用 componentId 直接拼出 <id>.json，id 会进入路径，调用方需保证它与远端 meta 的 id 一致。
// [顺序] 该常量先于所有读写函数定义，readRemoteAssetComponentMeta 与 writeRemoteAssetComponentMeta 共用同一路径来源。
// [失败路径] 改动目录名会让旧 marker 全部读不到，升级后的首次检测被当作缺少元数据并整包重装。
// [权衡] 目录与文件名都不带平台或版本，平台隔离交给 meta 内的 platformArch 字段而不是路径分叉。
const REMOTE_ASSET_COMPONENT_META_DIR = `${REMOTE_BASE}/.asset-components`;

export interface RemoteAssetIdentityResolverOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export function createFreshRemoteAssetManifestRefResolver(
  options: RemoteAssetIdentityResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): () => Promise<RemoteAssetManifestRef | null> {
  let manifestPromise: Promise<RemoteAssetManifestRef | null> | null = null;
  return () => {
    manifestPromise ??= resolveFreshComponentManifest(options, env, loggers);
    return manifestPromise;
  };
}

// [契约] RemoteAssetComponentIdentity 只有 sha256 一个字段，期望身份就是当前 manifest 制品的内容哈希。
// [契约] RemoteAssetComponentMeta 在其上增加 version、sha256、pendingRefreshAppVersion 与 platformArch，是远端落盘后的完整形状。
// [权衡] version 保留仅用于诊断与兼容旧 marker，不参与是否部署的判定。
// [契约] RemoteAssetComponentIdentityDecision 只有跳过与部署两种结果，部署态必带 reason 供日志与排障引用。
// [顺序] 这些类型先于 checkRemoteAssetComponentIdentity 声明，比较规则只依赖 sha256 与 platformArch。
export interface RemoteAssetComponentIdentity {
  sha256: string;
}

export interface RemoteAssetComponentMeta {
  id: string;
  version?: string;
  sha256?: string;
  pendingRefreshAppVersion?: string;
  platformArch: string;
}

export type RemoteAssetComponentIdentityDecision =
  | { shouldDeploy: false }
  | { shouldDeploy: true; reason: string };

// [顺序] 判定次序为：元数据缺失、id 不符、平台不符、缺少 SHA、SHA 不等；任一命中即部署，全部通过才跳过。
// [契约] 期望身份只与 options.expectedIdentity.sha256 比较，remoteMeta.version 不参与。
// [失败路径] 缺 SHA 分支专门兼容旧 live marker，命中后必须重写带 SHA 的 meta 才算收敛。
// [权衡] 比较前后各做空白裁剪与小写归一，避免大小写差异导致每次都重装。
// [契约] 每个部署分支都同时输出 remote 与 expected 两侧取值，故障时可直接定位是哪一项不一致。
// [失败路径] 本函数不做任何写入，调用方拿到 shouldDeploy 后才走部署与 writeRemoteAssetComponentMeta。
export async function checkRemoteAssetComponentIdentity(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    expectedIdentity: RemoteAssetComponentIdentity;
  },
): Promise<RemoteAssetComponentIdentityDecision> {
  const remoteMeta = await readRemoteAssetComponentMeta(backend, options.componentId);
  if (!remoteMeta) {
    return {
      shouldDeploy: true,
      reason: `remote component meta missing expected=${formatIdentity(options.expectedIdentity)}`,
    };
  }
  if (remoteMeta.id !== options.componentId) {
    return {
      shouldDeploy: true,
      reason: `remote component id mismatch remote=${remoteMeta.id} expected=${options.componentId}`,
    };
  }
  if (remoteMeta.platformArch !== options.platformArch) {
    return {
      shouldDeploy: true,
      reason: `remote platform mismatch remote=${remoteMeta.platformArch} expected=${options.platformArch}`,
    };
  }
  if (!remoteMeta.sha256) {
    // 旧 live marker 只记录 version，无法证明运行目录来自当前 manifest 制品。
    // 首次读取旧 marker 时必须重新部署并写入 SHA，不能继续按语义版本跳过。
    return {
      shouldDeploy: true,
      reason: `remote component SHA missing expected=${options.expectedIdentity.sha256}`,
    };
  }
  if (
    remoteMeta.sha256.trim().toLowerCase() !== options.expectedIdentity.sha256.trim().toLowerCase()
  ) {
    return {
      shouldDeploy: true,
      reason: `remote SHA mismatch remote=${remoteMeta.sha256} expected=${options.expectedIdentity.sha256}`,
    };
  }

  return { shouldDeploy: false };
}

// [失败路径] 文件不存在、JSON 解析失败与字段类型不符都归为 null，读侧不把异常抛给部署流程。
// [契约] id 与 platformArch 必须是字符串，其余三个字段允许缺省，但一旦出现也必须是字符串。
// [契约] 返回对象按字段有无逐项展开，缺省字段不会以 undefined 形式写进结果。
// [顺序] 先校验类型再构造返回值，避免把解析后的任意结构直接断言成 meta。
// [资源] 读取只走 backend.readFile，路径来自 buildRemoteAssetComponentMetaPath，与写入路径严格同源。
// [失败路径] 放宽成只校验 id 会让缺平台字段的旧文件通过，之后比较永远判不等并反复重装。
export async function readRemoteAssetComponentMeta(
  backend: IRemoteBackend,
  componentId: string,
): Promise<RemoteAssetComponentMeta | null> {
  try {
    const content = await backend.readFile(buildRemoteAssetComponentMetaPath(componentId));
    const parsed = JSON.parse(content) as Partial<RemoteAssetComponentMeta>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.platformArch !== "string" ||
      (parsed.version !== undefined && typeof parsed.version !== "string") ||
      (parsed.sha256 !== undefined && typeof parsed.sha256 !== "string") ||
      (parsed.pendingRefreshAppVersion !== undefined &&
        typeof parsed.pendingRefreshAppVersion !== "string")
    ) {
      return null;
    }
    return {
      id: parsed.id,
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      ...(parsed.pendingRefreshAppVersion
        ? { pendingRefreshAppVersion: parsed.pendingRefreshAppVersion }
        : {}),
      platformArch: parsed.platformArch,
    };
  } catch {
    return null;
  }
}

// [事务] version 为 unknown 且没有 sha256 时直接返回，不写一个注定失配的 marker。
// [顺序] 先 mkdir -p 元数据目录，再用 buildWriteLiteralFileCommand 写入带换行的 JSON，两步在同一条命令里以 && 串联。
// [失败路径] waitForClose 必须等到命令流关闭，否则随后的读取可能拿到半截内容。
// [契约] 序列化的是完整 meta，可选字段由调用方决定是否出现，本函数不再清洗。
// [权衡] 写入不加锁，依赖一次部署只有一个写入者这一上层约束来避免并发覆盖。
export async function writeRemoteAssetComponentMeta(
  backend: IRemoteBackend,
  meta: RemoteAssetComponentMeta,
): Promise<void> {
  // 其它资源包保持既有语义：无法解析版本时不写一个会永久失配的 unknown marker。
  if (meta.version === "unknown" && !meta.sha256) {
    return;
  }
  const stream = await backend.exec(
    [
      `mkdir -p ${quotePosixPathArg(REMOTE_ASSET_COMPONENT_META_DIR)}`,
      buildWriteLiteralFileCommand(
        buildRemoteAssetComponentMetaPath(meta.id),
        `${JSON.stringify(meta)}\n`,
      ),
    ].join(" && "),
  );
  await waitForClose(stream);
}

// [事务] 刷新标记复用正式 meta 文件，只带 id、platformArch 与 pendingRefreshAppVersion，不写 sha256。
// [权衡] 同一文件承载两种语义，是为了让读侧只读一次就能判断是否需要刷新。
// [失败路径] 若该 meta 已有 sha256，这里整体覆盖会把它抹掉，调用方需接受随后重装的语义。
// [契约] appVersion 只记录触发刷新的应用版本，判定阶段仅要求该字段存在。
// [顺序] 本函数直接委托 writeRemoteAssetComponentMeta，不单独维护路径与序列化方式。
export async function markRemoteAssetComponentRefreshPending(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    appVersion: string;
  },
): Promise<void> {
  await writeRemoteAssetComponentMeta(backend, {
    id: options.componentId,
    platformArch: options.platformArch,
    pendingRefreshAppVersion: options.appVersion,
  });
}

// [契约] 判定同时要求 id 与 platformArch 与入参一致，任一不符即视为没有待刷新标记。
// [契约] pendingRefreshAppVersion 非空即为真，不比较具体版本号。
// [顺序] 先读 meta 再做短路求值，meta 为 null 时不会继续访问字段。
// [失败路径] 只判断字段存在而省略 id 与平台校验，别的组件或架构的残留标记会误触发本组件刷新。
// [权衡] 返回布尔而不是版本号，调用方只关心是否需要刷新，不需要知道是谁触发的。
export async function hasRemoteAssetComponentRefreshPending(
  backend: IRemoteBackend,
  options: { componentId: string; platformArch: string },
): Promise<boolean> {
  const meta = await readRemoteAssetComponentMeta(backend, options.componentId);
  return Boolean(
    meta &&
    meta.id === options.componentId &&
    meta.platformArch === options.platformArch &&
    meta.pendingRefreshAppVersion,
  );
}

function buildRemoteAssetComponentMetaPath(componentId: string): string {
  return `${REMOTE_ASSET_COMPONENT_META_DIR}/${componentId}.json`;
}

function formatIdentity(identity: RemoteAssetComponentIdentity): string {
  return identity.sha256;
}

// [顺序] 平台架构由 env.platform 与 env.arch 拼成，mock 与 CDN 两条路径共用同一取值。
// [契约] mockCdnDir 存在时只读本地 releases 下当前版本与平台的 manifest，不发起网络请求。
// [失败路径] mock 读取失败只记 warn 并返回 null，让调用方退回发布检查，而不是中断本地调试。
// [事务] CDN 路径固定把 refreshManifest 置真，保证每次部署重新取 manifest，不复用进程内旧 SHA。
// [失败路径] 配了缓存目录与 CDN 基地址却仍取不到 manifest 时抛错，身份判断与安装必须来自同一份 manifest。
// [失败路径] 末尾 catch 记一条 warn 后原样重新抛出，保留原始诊断，不把超时降级成缺失。
async function resolveFreshComponentManifest(
  options: RemoteAssetIdentityResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const platformArch = `${env.platform}-${env.arch}`;
  if (options.mockCdnDir) {
    try {
      const content = await readFile(
        join(options.mockCdnDir, "releases", ZCODE_VERSION, `manifest-${platformArch}.json`),
        "utf8",
      );
      return {
        manifest: JSON.parse(content) as RemoteAssetManifest,
        releaseBaseCandidatesForComponents: buildReleaseBaseCandidates(
          resolveRemoteCdnBaseUrls(options),
          ZCODE_VERSION,
        ),
      };
    } catch (error) {
      loggers.logWarn(
        `[remote-assets] mock component manifest unavailable, fallback to release checks: ${String(error)}`,
      );
      return null;
    }
  }

  try {
    const manifestRef = await fetchRemoteAssetManifestRefFromCdn(
      {
        remoteCdnBaseUrl: options.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options.remoteCdnBaseUrls,
        remoteCacheDir: options.remoteCacheDir,
        version: ZCODE_VERSION,
        platformArch,
        manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
        remoteAssetNetwork: options.remoteAssetNetwork,
        // server-bundle/GLM 允许在 app/version 不变时重发制品，每次部署必须重新取
        // manifest，不能复用进程内旧 SHA；promise 保证本次部署只刷新一次。
        refreshManifest: true,
      },
      loggers,
    );
    const hasConfiguredManifestSource =
      Boolean(options.remoteCacheDir?.trim()) &&
      (Boolean(options.remoteCdnBaseUrl?.trim()) ||
        Boolean(options.remoteCdnBaseUrls?.some((baseUrl) => baseUrl.trim().length > 0)));
    if (!manifestRef && hasConfiguredManifestSource) {
      // server-bundle 的身份判断与安装必须来自同一 manifest；404 后
      // 不能继续走 installer 再请求一次，否则发布切换时可能部署另一份制品。
      throw new Error(
        `[remote-assets] manifest not found for ${platformArch}: manifest-${platformArch}.json`,
      );
    }
    return manifestRef;
  } catch (error) {
    loggers.logWarn(`[remote-assets] component manifest request failed: ${String(error)}`);
    // 这是内容寻址组件在本次 deploy transaction 的 pinned identity 输入。网络超时/解析失败
    // 不能降级为“manifest 缺失”后再请求一次，否则会丢失原始诊断并翻倍 deadline。
    throw error;
  }
}
