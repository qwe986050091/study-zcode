// INV-01 决策只由输入快照（存在性探测、期望版本、force、meta 三项）决定，不得读取时钟或随机源；守住位置：shouldDeployVersionedComponent 全部分支；改错故障：同一部署重复执行得出不同结论，增量与全量路径互相覆盖
// INV-02 决策阶段只读远端状态，不写远端文件也不写本地缓存；守住位置：shouldDeployVersionedComponent 仅调用 backend.exists 与 readRemoteAssetComponentMeta；改错故障：决策期写坏 meta 使后续安装误判已完成，终端缺文件却被永久跳过
// INV-03 force 优先级最高，命中后不再探测远端；守住位置：shouldDeployVersionedComponent 首行分支；改错故障：远端不可达时强制部署被“文件不存在”抢先解释，用户的手动覆盖失效
// INV-04 远端文件缺失一律判为需要部署，不看版本与 meta；守住位置：backend.exists 为假的分支；改错故障：目标机首次安装或文件被清理后永久跳过，加载 pty.node 失败致终端不可用
// INV-05 期望版本为空时的行为由 fallbackDeployWhenVersionUnknown 单一开关决定；守住位置：expectedVersion 为空的分支；改错故障：node-pty 的 onlyIfMissing 场景被强制重装，每次启动重复上传数十 MB 资产
// INV-06 node-runtime 恒走“版本未知即部署”，不允许随 onlyIfMissing 变化；守住位置：deployNodeRuntime 传入的 fallbackDeployWhenVersionUnknown 为 true；改错故障：版本解析失败时运行时被跳过，远端 node 与宿主 ZCODE_VERSION 不一致
// INV-07 版本比较两侧都必须先过 normalizeDeployExpectedVersion 归一，禁止比较原始字符串；守住位置：版本不一致判断；改错故障：同一版本的不同写法被判为不同，每次启动都重装
// INV-08 meta 缺失、组件 id 不符、platformArch 不符三者都判为需要部署；守住位置：remoteMeta 的三段校验；改错故障：跨组件或跨架构的 meta 被复用，远端运行错误的二进制
// INV-09 platformArch 必须逐字相等，不做事后兼容映射；守住位置：platformArch 比较分支；改错故障：arm64 机器装入 x64 的 node，exec 直接报格式错误
// INV-10 meta 写入只发生在 installFile 成功之后，顺序不可颠倒；守住位置：两处安装尾段的 writeRemoteAssetComponentMeta；改错故障：安装中途失败但 meta 已写，后续启动全部跳过，缺文件长期无法自愈
// INV-11 期望版本为空时 meta 写 unknown，后续比较依赖归一后的 null 对齐；守住位置：两处 writeRemoteAssetComponentMeta 的 version 字段；改错故障：未知版本的机器在重装循环与永久跳过之间摇摆，破坏幂等
// INV-12 组件 id 字面量在决策、安装、meta 三处必须一致；守住位置：node-runtime 与 node-pty 的三处出现；改错故障：meta 写到别的 id 下，下一轮读取 id 不匹配并重复部署
// INV-13 pty.node 与 spawn-helper 是两次独立判定，后者额外要求 darwin 且远端文件不存在；守住位置：deployNodePtyPrebuilds 的 darwin 分支；改错故障：Linux 上多传 spawn-helper，或主资产判定跳过时漏传 spawn-helper
// INV-14 spawn-helper 的补传条件必须包含 decision.shouldDeploy，主资产需要部署时无条件跟随；守住位置：shouldUploadSpawnHelper 表达式；改错故障：pty.node 已更新而 spawn-helper 仍为旧版，darwin 上拉起终端即崩
// INV-15 非 darwin 平台必须在任何 spawn-helper 副作用之前返回；守住位置：env.platform 不等于 darwin 的提前 return；改错故障：非 darwin 目标被写入不存在的资产，安装器报错中断整次部署
// INV-16 本地资产缺失只告警不抛错，且该分支不得写 meta；守住位置：LocalUploadAssetInstaller 的 tryResolveLocalPath 探测；改错故障：meta 记录了未真正上传的资产，后续启动全部跳过，终端永久不可用
// INV-17 manifest 抓取在每个 resolver 实例内只发生一次，失败也复用同一个 promise；守住位置：componentManifestPromise 的空值赋值；改错故障：并发组件解析各发一次请求，超时叠加把部署拖到分钟级
// INV-18 manifest 抓取失败必须原样抛出，不得降级为 null；守住位置：resolveComponentManifest 的 catch 分支；改错故障：调用方把失败当作“没有 manifest”，持锁路径再发一次默认超时请求，故障长尾放大
// INV-19 mockCdnDir 模式直接返回 null，视为无 manifest 可用且不发起网络请求；守住位置：resolveComponentManifest 首行分支；改错故障：离线测试与本地联调真实打到 CDN，测试变慢且结果依赖外网
// INV-20 日志与告警只是可观测出口，决策与安装流程不得因日志调用而改变；守住位置：logDeployRequired 与各处的 log/logWarn；改错故障：日志异常吞掉后续安装步骤，用户看到部署完成但资产并不存在
import { ZCODE_VERSION } from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
} from "@zcode/server/remote/deployShared.js";
import {
  readRemoteAssetComponentMeta,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";
import {
  fetchRemoteAssetManifestFromCdn,
  resolveRemoteAssetComponentCacheVersion,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifest,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  LocalUploadAssetInstaller,
  type RemoteAssetInstaller,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

// [失败路径] 这两个常量必须与远端包内实际落点逐字节一致，包含 build/Release 这一层。
// 安装器只按 remotePath 覆盖文件，不会纠正目录层级；层级写错时会在远端新建一个
// 空目录再复制资产，backend.exists 永远返回假，于是每次启动都重新部署一遍。
// [权衡] 没有把两个路径合并成按资产名拼接的循环：spawn-helper 只在 darwin 上传，
// 合并后调用方仍要按平台分支，收益为零，反而多一层间接让人误以为平台无关。
// [资源] 两者是纯字符串常量，不含 I/O；目录创建由 installer 在安装时负责，
// 所以拼写错误在启动阶段不会报错，只在终端真正拉起子进程时才暴露。
const REMOTE_NODE_PTY_PATH = `${REMOTE_BASE}/build/Release/pty.node`;
const REMOTE_NODE_PTY_SPAWN_HELPER_PATH = `${REMOTE_BASE}/build/Release/spawn-helper`;

export interface RemoteAssetVersionResolverOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

interface DeployNodePtyPrebuildOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  force?: boolean;
  onlyIfMissing: boolean;
  installer: RemoteAssetInstaller;
  expectedVersion?: string | null;
}

interface DeployNodeRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  force?: boolean;
  installer: RemoteAssetInstaller;
  expectedVersion?: string | null;
}

// [权衡] 用可辨识联合而不是布尔值加可选 reason：布尔值表达不了部署理由，
// 而 reason 会被 logDeployRequired 原样写进告警，是线上定位重复部署的唯一线索。
// 改成 deploy 加可选 reason 后，跳过分支也可能带一条理由，调用方容易误读。
// [失败路径] shouldDeploy 为 false 的分支刻意不带 reason，强制先窄化再取字段，
// 任何想解释“为什么跳过”的调用方只能依赖上游日志，不能伪造一个原因。
// 该类型是纯数据，不含函数、时间戳与随机标识，保证同一快照的比较结果稳定。
// 新增第三态（例如“待确认”）会破坏所有调用点的二元判断，必须改类型而非加字段。
type DeployDecision = { shouldDeploy: false } | { shouldDeploy: true; reason: string };

export function createRemoteComponentVersionResolver(
  options: RemoteAssetVersionResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): (componentId: string) => Promise<string | null> {
  // [并发] 单飞缓存的是 promise 而不是解析后的 manifest：多个组件 resolver 并发
  // 调用时共享同一次网络请求与同一个 deadline，避免超时预算被按组件数放大。
  // 若改为缓存已完成的值，成功路径结论相同，但失败这一次事实会被丢掉，
  // 后续调用会各自重新发请求，把一次故障放大成多轮长尾重试。
  // [失败路径] 该 promise 被拒绝后仍留在变量里，后来者拿到同一个拒绝，
  // 这正是 resolveComponentManifest 选择原样抛出而绝不降级成 null 的原因。
  // [资源] promise 不持有 socket，响应体收尾由 fetchRemoteAssetManifestFromCdn 负责。
  let componentManifestPromise: Promise<RemoteAssetManifest | null> | null = null;
  const getComponentManifest = (): Promise<RemoteAssetManifest | null> => {
    componentManifestPromise ??= resolveComponentManifest(options, env, loggers);
    return componentManifestPromise;
  };

  return async (componentId) => {
    const manifest = await getComponentManifest();
    if (!manifest) {
      return null;
    }
    const componentVersion = selectRemoteAssetManifestComponents(manifest, [componentId])[0]
      ?.version;
    return componentVersion ? resolveRemoteAssetComponentCacheVersion(componentVersion) : null;
  };
}

export async function deployNodeRuntime(
  backend: IRemoteBackend,
  options: DeployNodeRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const { platformArch, installer } = options;
  // 远端落点是 REMOTE_BASE/node 这一固定目录，与本地资产包内的架构子目录是两个
  // 不同口径：前者决定写到哪，后者决定从哪取，二者不可互相替代。
  // [失败路径] 落点不随 platformArch 变化，同一远端目录只能容纳一个架构的 node，
  // 平台判定错误时旧文件被直接覆盖而非并存，回退只能再部署一次旧架构。
  // [事务] 覆盖不是原子的：installFile 成功之后才写 meta，这个窗口里 meta 仍指向
  // 旧版本，下一轮决策会判为不一致并重装，收敛安全但多一次上传。
  // [资源] 落点目录的创建交给 installer，本函数不预先建目录，避免空目录成为存在的假证据。
  const remotePath = `${REMOTE_BASE}/node`;
  const expectedVersion = normalizeDeployExpectedVersion(options.expectedVersion);
  const decision = await shouldDeployVersionedComponent(backend, {
    componentId: "node-runtime",
    platformArch,
    remotePath,
    expectedVersion,
    force: options.force,
    fallbackDeployWhenVersionUnknown: true,
  });
  if (!decision.shouldDeploy) {
    loggers.log("node runtime already matches, skip");
    return;
  }

  logDeployRequired({
    loggers,
    installer,
    componentId: "node-runtime",
    reason: decision.reason,
  });
  await installer.installFile({
    componentId: "node-runtime",
    sourceRelativePath: `node/${platformArch}/node`,
    remotePath,
    executable: true,
  });
  await writeRemoteAssetComponentMeta(backend, {
    id: "node-runtime",
    version: expectedVersion ?? "unknown",
    platformArch,
  });
  loggers.log("node install done");
}

function normalizeDeployExpectedVersion(version: string | null | undefined): string | null {
  return version ? resolveRemoteAssetComponentCacheVersion(version) : null;
}

export async function deployNodePtyPrebuilds(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployNodePtyPrebuildOptions,
  loggers: DeployLoggers,
): Promise<void> {
  // onlyIfMissing 是 node-pty 调用方特有的开关，取反后作为 fallbackDeployWhenVersionUnknown
  // 传入：仅在缺失时才装的场景里，版本未知不能成为重新安装的理由。
  // [权衡] 不复用同一个语义字段名，是因为两个调用点的默认方向相反，同名会让
  // node-runtime 的 true 与 node-pty 的取反读起来像笔误。
  // [失败路径] onlyIfMissing 为真且版本未知时决策为跳过，远端可能残留其它版本的
  // pty.node；这是调用方接受的“不主动修复”语义，想强制修复应传 force 而不是放宽比较。
  // installer 在此只做解构，不提前探测本地资产，探测统一放在决策为部署之后。
  const { platformArch, onlyIfMissing, installer } = options;
  const expectedVersion = normalizeDeployExpectedVersion(options.expectedVersion);
  const decision = await shouldDeployVersionedComponent(backend, {
    componentId: "node-pty",
    platformArch,
    remotePath: REMOTE_NODE_PTY_PATH,
    expectedVersion,
    force: options.force,
    fallbackDeployWhenVersionUnknown: !onlyIfMissing,
  });
  if (decision.shouldDeploy) {
    const sourceRelativePath = `node-pty/${platformArch}/pty.node`;
    if (
      installer instanceof LocalUploadAssetInstaller &&
      !(await installer.tryResolveLocalPath(["node-pty"], sourceRelativePath))
    ) {
      loggers.logWarn(`WARNING: no node-pty prebuild for ${platformArch}. Terminal will not work.`);
      loggers.logWarn(
        `Legacy component assets are no longer built; use the R3 Source Server archive flow.`,
      );
    } else {
      logDeployRequired({
        loggers,
        installer,
        componentId: "node-pty",
        reason: decision.reason,
      });
      loggers.log("installing node-pty prebuild...");
      await installer.installFile({
        componentId: "node-pty",
        sourceRelativePath,
        remotePath: REMOTE_NODE_PTY_PATH,
      });
      await writeRemoteAssetComponentMeta(backend, {
        id: "node-pty",
        version: expectedVersion ?? "unknown",
        platformArch,
      });
      loggers.log("node-pty install done");
    }
  } else {
    loggers.log("node-pty prebuild already exists, skip");
  }

  // [失败路径] 非 darwin 在此提前返回，spawn-helper 的两个安装分支都在其后，
  // 保证 Linux 与 Windows 目标不会因为缺本地资产而反复告警。
  // 平台判定读 env.platform 而不是 platformArch 的前缀，避免把 darwin-arm64 这类
  // 拼接字符串当成平台身份，也避免以后新增 darwin-x64 时漏改比较式。
  // [权衡] 提前返回而不是把整段包进条件块：包起来会让主资产日志多两级缩进，
  // 阅读时容易把 pty.node 的成功路径与 spawn-helper 的定位混为一谈。
  // [资源] 走到这里主资产可能已安装并写好 meta，本次提前返回不影响那次写入。
  if (env.platform !== "darwin") {
    return;
  }

  const shouldUploadSpawnHelper =
    decision.shouldDeploy || !(await backend.exists(REMOTE_NODE_PTY_SPAWN_HELPER_PATH));
  if (shouldUploadSpawnHelper) {
    const sourceRelativePath = `node-pty/${platformArch}/spawn-helper`;
    if (
      installer instanceof LocalUploadAssetInstaller &&
      !(await installer.tryResolveLocalPath(["node-pty"], sourceRelativePath))
    ) {
      loggers.logWarn(
        `WARNING: no node-pty spawn-helper for ${platformArch}. Terminal may fail to start.`,
      );
      loggers.logWarn(
        `Legacy component assets are no longer built; use the R3 Source Server archive flow.`,
      );
      return;
    }

    loggers.log("installing node-pty spawn-helper...");
    if (!decision.shouldDeploy) {
      logDeployRequired({
        loggers,
        installer,
        componentId: "node-pty",
        reason: `remote file missing path=${REMOTE_NODE_PTY_SPAWN_HELPER_PATH}`,
      });
    }
    await installer.installFile({
      componentId: "node-pty",
      sourceRelativePath,
      remotePath: REMOTE_NODE_PTY_SPAWN_HELPER_PATH,
      executable: true,
    });
    loggers.log("node-pty spawn-helper install done");
  } else {
    loggers.log("node-pty spawn-helper already exists, skip");
  }
}

async function shouldDeployVersionedComponent(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    remotePath: string;
    expectedVersion?: string | null;
    force?: boolean;
    fallbackDeployWhenVersionUnknown: boolean;
  },
): Promise<DeployDecision> {
  // [权衡] force 必须排在 backend.exists 探测之前：远端不可达时探测会抛错，
  // 若先探测，强制部署会被“文件不存在”抢先解释，真实的强制原因被日志掩盖。
  // [失败路径] 该分支不读 meta，因此 meta 描述的是另一架构也会直接进入安装，
  // 覆盖结果由 installer 决定，本函数不为 force 的后果补校验。
  // 幂等性在 force 下主动放弃：同一输入仍返回部署，这是调用方显式要求的行为。
  // [资源] 提前返回省掉一次 stat 与一次 meta 读取，代价是每次强制部署都要重传资产。
  // 只有把 force 放在最前，优先级链才是 force 高于存在性高于版本与 meta。
  if (options.force) {
    return { shouldDeploy: true, reason: "force deploy requested" };
  }

  if (!(await backend.exists(options.remotePath))) {
    return {
      shouldDeploy: true,
      reason: `remote file missing path=${options.remotePath}`,
    };
  }

  // [失败路径] 版本未知时只剩两个出口，由 fallbackDeployWhenVersionUnknown 单选，
  // 不存在“再读一眼 meta 再定”的第三条路，避免多源判断互相矛盾。
  // node-runtime 恒传真：远端 node 与宿主 ZCODE_VERSION 强绑定，版本说不清时
  // 宁可重装，也不能沿用来源不明的二进制。
  // node-pty 在 onlyIfMissing 下传假：终端插件是辅件，每次冷启动重传会明显拖慢启动。
  // [权衡] 用显式布尔参数而非默认常量，让每个调用点必须表态，新增组件不会默默继承错口径。
  // 此处的未知只表示调用方没给出期望版本，不代表远端 meta 里的版本可以被忽略。
  if (!options.expectedVersion) {
    return options.fallbackDeployWhenVersionUnknown
      ? {
          shouldDeploy: true,
          reason: "component version unavailable, using legacy full deploy",
        }
      : { shouldDeploy: false };
  }

  // [失败路径] 这是决策过程中唯一一次读取远端 meta 的动作，只在这里发生；
  // 文件存在而 meta 缺失，说明安装被中断或来自旧版本部署，一律判为需要部署。
  // [失败路径] 读 meta 的 I/O 异常不在此吞掉，向上冒泡由调用方决定是否中断整次部署，
  // 避免把“读不到”误当成“没有 meta”而静默重装。
  // [并发] 两次决策之间远端 meta 可能被其他部署进程改写，本函数只做一次快照比较，
  // 不重读也不加锁，因此结论对应的是读取瞬间的远端状态。
  // [资源] 返回值是普通对象，不持有远端句柄，比较结束后无需清理。
  const remoteMeta = await readRemoteAssetComponentMeta(backend, options.componentId);
  if (!remoteMeta) {
    return {
      shouldDeploy: true,
      reason: `remote component meta missing expected=${options.expectedVersion}`,
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
  if (
    // 比较口径：两侧都先归一再比，远端存的是缓存版本形态，本地可能带构建后缀，
    // 直接比原字符串会把同一版本判成不同，导致每次都重装。
    // [失败路径] 归一函数把空值与未知值都收敛为 null，所以远端写 unknown 且本地期望
    // 也为空时两侧同为 null，判为一致并跳过，这是有意保留的兼容路径。
    // [权衡] 不比较文件大小或 mtime：二者受上传方式与时钟影响，不能作为版本证据。
    // 该判断不引入时钟与随机源，同一快照在任何时刻、任何机器上都得到同一结论。
    // [失败路径] 不一致时 reason 同时打印远端与本地原值，便于反查归一前后的差异。
    normalizeDeployExpectedVersion(remoteMeta.version) !==
    normalizeDeployExpectedVersion(options.expectedVersion)
  ) {
    return {
      shouldDeploy: true,
      reason: `remote version mismatch remote=${remoteMeta.version} expected=${options.expectedVersion}`,
    };
  }

  return { shouldDeploy: false };
}

export function logDeployRequired(options: {
  loggers: Pick<DeployLoggers, "logWarn">;
  installer: RemoteAssetInstaller;
  componentId: string;
  reason: string;
}): void {
  const action =
    options.installer.mode === "remote-download" ? "download required" : "upload required";
  options.loggers.logWarn(
    `[remote-assets] ${action}: component=${options.componentId} reason=${options.reason}`,
  );
}

async function resolveComponentManifest(
  options: RemoteAssetVersionResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): Promise<RemoteAssetManifest | null> {
  if (options.mockCdnDir) {
    return null;
  }

  try {
    return await fetchRemoteAssetManifestFromCdn(
      {
        remoteCdnBaseUrl: options.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options.remoteCdnBaseUrls,
        remoteCacheDir: options.remoteCacheDir,
        version: ZCODE_VERSION,
        platformArch: `${env.platform}-${env.arch}`,
        manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      loggers,
    );
  } catch (error) {
    loggers.logWarn(`[remote-assets] component manifest request failed: ${String(error)}`);
    // version resolver 与 pinned identity 共享同一 manifest deadline。
    // 网络/响应体失败时不得降级成 null，否则持锁路径会再发起默认 10s 请求。
    throw error;
  }
}
