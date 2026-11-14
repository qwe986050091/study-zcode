/* eslint-disable max-lines */
// ============================================================================
// INV 不变量表（remoteAssetCache）
// 职责：把 CDN 上的 remote release 物化成本地缓存目录，供远端会话启动时挂载。
// 整条链路只靠三件事成立：路径身份唯一、就绪标记可信、目录提交原子。
// 任一条被绕过，远端拿到的就是半成品目录或错误平台的二进制，而且失败点
// 落在远端启动阶段，宿主侧日志里只有一句 connect failed，极难回溯。
//
// INV-1: release 目录恒为 <cache>/releases/<version>/<platformArch>，不做扁平化
//   —— 破坏后果：linux 与 darwin 会话共用同一目录，后部署者覆盖前者，远端报
//   Exec format error，且缓存目录本身看起来“已就绪”，无法自动恢复。
// INV-2: 只有 ready 标记存在、且调用方声明的 requiredPaths 全部存在的目录才算命中
//   —— 破坏后果：只落地过 zcode-server.cjs 的旧缓存被当作完整缓存复用，远端运行
//   到 node runtime 时才发现文件缺失，表现为启动即退出。
// INV-3: 目录只能先在 staging 生成、再 rename 原子替换目标；禁止原位写入
//   —— 破坏后果：另一个会话在写入中途 stat 到该目录并判定就绪，读到被截断的文件。
// INV-4: 同一 releaseDir 的物化由 runWithReleaseMaterializeLock 串行化
//   —— 破坏后果：两个会话同时提交，后到者的备份回滚把先到者刚写好的 mount 改走。
// INV-5: 组件缓存目录名取 sha256（内容寻址）或剥掉 +hash 的语义版本
//   —— 破坏后果：同一语义版本重发后继续命中旧目录，部署出去的仍是上一个构建。
// INV-6: server-bundle 与 glm 是内容寻址组件，必须按 sha256 分目录
//   —— 破坏后果：同版本不同内容落到同一目录，A 组件的内容被 B 组件的 ready 标记背书。
// INV-7: manifest 必须 schemaVersion=1，且 appVersion/platformArch 与请求完全一致
//   —— 破坏后果：灰度期间拿到别的平台清单，会下载不兼容的 node-pty 原生二进制。
// INV-8: manifest 中每个组件的 mount 必须等于白名单规则推导出的期望路径
//   —— 破坏后果：mount 写成多级上跳时解压落点逃出 releaseDir，覆盖缓存外的文件。
// INV-9: 下载完成的归档必须先比对 manifest 的 sha256，再允许解压
//   —— 破坏后果：截断或篡改的 tar.gz 被展开成“看起来正常”的目录，错误延迟到运行期。
// INV-10: 解压或迁移出来的目录必须非空才允许写 ready 标记
//   —— 破坏后果：空组件目录被标成就绪，远端 require 时抛 MODULE_NOT_FOUND。
// INV-11: 组件缓存中禁止符号链接，遇到即抛错
//   —— 破坏后果：链接可指向缓存外任意路径，物化后把宿主文件复制进 release 并上传。
// INV-12: 所有来自 manifest 的相对路径先归一化，再经 resolvePathWithinBase 前缀校验
//   —— 破坏后果：路径穿越可以把文件写到缓存根之外，属于可被 CDN 内容触发的写入漏洞。
// INV-13: manifest 请求必须带 AbortSignal 超时
//   —— 破坏后果：半开 TCP 下 fetch 永不返回，single-flight 把所有后续连接绑到同一个
//   pending Promise，用户侧表现为远端会话永久初始化中。
// INV-14: 失败与负结果不得留在 single-flight 表里
//   —— 破坏后果：一次 CDN 抖动被永久记住，之后所有重试都拿到同一次失败结果。
// INV-15: 内容寻址刷新走独立 refresh 表，但仍复用同一次请求的 Promise
//   —— 破坏后果：发布切换瞬间两个会话分别命中旧/新快照，release 里组件版本混装。
// INV-16: 锁 key 必须包含所有会改变结果的判据（cacheDir、组件集合、内容身份、force、
//   timeout）—— 破坏后果：不同语义的调用共用同一个 Promise，B 目录的调用拿到 A 目录路径。
// INV-17: 等待他人锁之后必须用本次调用的 requiredPaths 复检
//   —— 破坏后果：先完成的下载只满足了旧调用的最小路径集，残缺缓存被直接返回。
// INV-18: 提交时旧目录先改名成 backup，成功后再尽力删除；失败必须回滚 backup
//   —— 破坏后果：既不回滚又删不掉，目录处于既没有旧版也没有完整新版的空窗。
// INV-19: ready 标记兼容当前与历史两个文件名
//   —— 破坏后果：已部署机器上的老缓存被判为未就绪，每次连接都全量重下。
// INV-20: 所有 staging 目录在 finally 中删除
//   —— 破坏后果：异常退出留下的半成品永久占用磁盘，还会被人工误认为可用缓存。
// INV-21: forceRefresh 必须绕过全部缓存命中并重新校验 sha256
//   —— 破坏后果：本地上传/热修后用旧缓存重新部署，远端仍在跑修复前的构建。
// ============================================================================
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  type Dirent,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileExists } from "@zcode/server/remote/deployShared.js";
import { extractTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  assertRemoteCdnBaseVersionMatches,
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  normalizeRemoteAssetRelativePath,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";

// [权衡] 清单文件名带平台后缀：同一 app 版本要为每个平台各发一份，发布动作多一次，
// 但避免了“一份清单混装多平台组件”时客户端必须自己挑平台，挑错就是下载到不兼容二进制。
const MANIFEST_FILE_NAME_PREFIX = "manifest-";
// 就绪标记是目录可用的唯一外显证据；它必须后于内容写入落盘，否则标记本身就失去意义。
const REMOTE_ASSET_READY_MARKER = ".ready";
// [权衡] 保留历史名是为了避免已部署机器在升级首连时全量重下（INV-19）；
// 新写入只写新名，旧名仅参与读取，两者不会同时被写。
const LEGACY_REMOTE_ASSET_READY_MARKER = ".remote-assets-ready";
const READY_MARKER_CANDIDATES = [REMOTE_ASSET_READY_MARKER, LEGACY_REMOTE_ASSET_READY_MARKER];
// [并发] 下面五张表是进程内 single-flight 的唯一状态：key 到“正在进行的 Promise”。
// 它们只保证同进程不重复做同一件事，不承担跨进程互斥；跨进程竞争由目录 rename 的
// 原子性兜底。进程崩溃时这些表随内存消失，留下的是磁盘目录而不是幽灵锁。
const remoteAssetReleaseLocks = new Map<string, Promise<string>>();
// [并发] manifest 锁的 value 可能为 null（CDN 404），因此不能只凭“有锁”判断成功，
// 命中后仍要读结果本身；null 结果会被正常返回给探测型调用方。
const remoteAssetManifestLocks = new Map<string, Promise<RemoteAssetManifestFetchResult | null>>();
const remoteAssetManifestRefreshLocks = new Map<
  string,
  Promise<RemoteAssetManifestFetchResult | null>
>();
// [并发] 组件锁的 key 直接用组件缓存目录绝对路径，而非 id+version 拼接：
// 目录名已经包含平台与内容身份，用目录做 key 才与落盘语义一一对应（INV-16）。
const remoteAssetComponentLocks = new Map<string, Promise<string>>();
// [并发] 物化锁是“目录级”的第二道串行：组件锁只保护下载，多个组件仍会并发写入
// 同一个 releaseDir，必须再按 releaseDir 串行才能真正做到整体原子可见（INV-3）。
const remoteAssetReleaseMaterializeLocks = new Map<string, Promise<void>>();
// [权衡] 10s 是“半开连接”和“慢速但可用 CDN”之间的折中：更短会在弱网误杀，
// 更长会让 single-flight 把一整批连接一起拖死（INV-13）。
const DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS = 10_000;
// [权衡] 进度日志按 1s 或 5% 双阈值触发：只按时间会在慢速链路上长期停在 0%，
// 只按百分比会在超大制品上刷爆日志，两者取或能同时覆盖“没进展”和“进展很快”。
const REMOTE_ASSET_PROGRESS_INTERVAL_MS = 1_000;
const REMOTE_ASSET_PROGRESS_PERCENT_STEP = 5;
// [权衡] 只有 server-bundle 与 glm 做内容寻址：它们体积最大、且会在同一语义版本内
// 因热修重发；其余工具包按语义版本缓存，否则每次构建换个 hash 就多占一整份磁盘。
// 这份表同时决定 release 目录名里出现哪些 sha256 段（resolveContentAddressedReleaseSegments）。
const CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS: Record<string, string> = {
  "server-bundle": "server-content",
  glm: "glm-content",
};
// [失败路径] 目录 rename 在 Windows 上会被 Defender/索引器/刚退出的 host 短暂占用，
// 表现为 EPERM/EBUSY/EACCES/ENOTEMPTY。这里给的是有限指数退避而不是无限重试：
// 退避耗尽后仍失败说明是真实占用，必须把错误抛给调用方，不能假装提交成功。
const REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS = [
  50, 100, 200, 400, 800, 1_600, 3_200,
] as const;

// 清单是“本次部署要落地什么”的唯一事实来源：组件列表、内容哈希与挂载点都只从这里来。
// [权衡] 组件版本不写死在客户端：资源必须能随 CDN 发布会话即时更新，写死就等于换资源
// 必须发客户端版本，热修窗口会拖到下一次发版。
export interface RemoteAssetManifest {
  schemaVersion: number;
  appVersion: string;
  platformArch: string;
  components: RemoteAssetManifestComponent[];
}

// sha256 同时承担“完整性校验”和“缓存键”两个角色（内容寻址组件），
// 因此不能只校验不建键：只校验会让同版本的两次重发命中同一目录（INV-5）。
export interface RemoteAssetManifestComponent {
  id: string;
  version: string;
  sha256: string;
  artifactPath: string;
  mount: string;
}

// [并发] 把 manifest 与它命中的 releaseBase 绑成一个不可分对象传递：调用方若分开取，
// 中途清单被刷新就可能出现“清单来自 A 源、组件从 B 源下载”的混装（INV-15）。
export interface RemoteAssetManifestRef {
  manifest: RemoteAssetManifest;
  releaseBaseCandidatesForComponents: string[];
}

type RemoteAssetManifestFetchResult = RemoteAssetManifestRef;

// platformScoped 决定缓存根是否再插一层 platformArch：node/node-pty 是原生二进制，
// 必须按平台分目录；server-bundle 是纯 JS，跨平台共用一份即可，省一份磁盘。
interface ComponentMountRule {
  platformScoped: boolean;
  resolveExpectedMount: (platformArch: string) => string;
}

// INV-8 的白名单来源：mount 由代码推导而不是信任 manifest，manifest 只能“匹配”它。
// [失败路径] 未列出的 id 在解析阶段被跳过而不是报错：旧 release 清单仍可能带已退役的
// 三方组件，跳过只会让缓存变小，报错则会让整条部署链路卡在历史数据上。
const REMOTE_COMPONENT_MOUNT_RULES: Record<string, ComponentMountRule> = {
  "server-bundle": {
    platformScoped: false,
    resolveExpectedMount: () => "server",
  },
  "node-runtime": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node/${platformArch}`,
  },
  "node-pty": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node-pty/${platformArch}`,
  },
  glm: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `glm/${platformArch}`,
  },
  bfs: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/bfs`,
  },
  ripgrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ripgrep`,
  },
  ugrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ugrep`,
  },
};

// logWarn 与 log 分开注入而不是共用一个级别参数：调用方按 warn 决定是否写进用户可见的
// 运维日志，缓存命中/下载开始这类高频事件不应该抬高日志等级。
export interface RemoteAssetCacheLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

// 这是跨进程边界的输入契约：下游有多处 join，任何空串都会静默拼出缓存根目录本身，
// 因此入口处统一 trim + 校验，而不是让每个 join 点各自防御（重复且有遗漏）。
export interface EnsureRemoteReleaseDirOptions {
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  version: string;
  platformArch: string;
  componentIds?: string[];
  requiredReleasePaths?: string[];
  /**
   * 将身份决策与实际物化绑定到同一份 manifest 快照。
   * null 表示本次 transaction 已确认 manifest 缺失，不得再次请求。
   */
  manifestRef?: RemoteAssetManifestRef | null;
  /** 仅用于需要观察同 app 版本制品重发的身份检查。 */
  refreshManifest?: boolean;
  /** 忽略当前内容寻址 cache，重新下载并校验所选组件。 */
  forceRefresh?: boolean;
  // [并发] 超时进入锁 key：同一 cacheDir 上用不同超时并发调用属于不同语义的请求，
  // 合并成一个 Promise 会让短超时调用被长超时的结果带偏，或反之提前放弃。
  /** 单个 manifest CDN 候选请求的超时时间。 */
  manifestRequestTimeoutMs?: number;
  // 注入网络端口而不是直接用全局 fetch：单测与内网代理场景需要替换实现，
  // 同时把“重试/候选切换”策略留在本文件，不被传输层悄悄接管。
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

// [失败路径] 超时值来自外部配置，可能被写成 0、负数或 NaN。校验放在创建 signal 之前，
// 因为 AbortSignal.timeout 对非法值会抛 RangeError，堆栈指向运行时而看不出是哪个配置项。
export function createRemoteAssetManifestRequestSignal(
  timeoutMs = DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS,
): AbortSignal {
  // [权衡] 用 Number.isSafeInteger 而不是 Number.isFinite：setTimeout 系接口对超出
  // 2^53 的值会静默截断，超大超时等于“永不取消”，必须提前拒绝而不是放行。
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[remote-assets] manifest request timeout must be a positive safe integer: ${String(timeoutMs)}`,
    );
  }
  // manifest 是 server-bundle/GLM SHA 跳过判断的前置输入；网络半开时若不主动取消，
  // 已完整部署的远端也会永久卡在初始化，且 single-flight 会把后续连接绑到同一 pending 请求。
  // [失败路径] AbortSignal.timeout 的 abort 原因固定是 TimeoutError，调用方据此区分
  // “主动放弃”与“真实网络错误”，因此这里不使用 AbortController + 自定义 reason。
  return AbortSignal.timeout(timeoutMs);
}

// 部署主入口。语义是“确保这个版本的 release 目录在本地可用”，而不是“下载一次”：
// 命中、并发合并、失败重试都由这一层决定，调用方只需要等待一个路径。
// [事务] 整个函数分三段：命中断言 → 等待/复检既有任务 → 新建任务。三段之间没有
// 共享可变状态，锁表是唯一同步点，因此崩溃只会丢失内存中的“正在下载”记录。
export async function ensureRemoteReleaseDirFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  // trim 不是装饰：调用方常把环境变量原样透传，带首尾空格的路径在 Windows 上会被
  // 当成合法目录名，后续所有相对路径校验都会以它为基准，错误要到运行期才暴露。
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  // [失败路径] 四个字段分别写进错误信息，是为了让远端日志能直接指出缺哪一项；
  // 统一抛 Error 而不是返回 null，因为本函数属于“远端必须起来”的部署路径，
  // 静默失败只会变成远端连接超时，宿主侧看不到配置缺失这个真实原因。
  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    throw new Error(
      `[deploy] production remote assets require remoteCdnBaseUrl or remoteCdnBaseUrls, remoteCacheDir and platformArch ` +
        `(remoteCdnBaseUrl=${options.remoteCdnBaseUrl ?? "<empty>"}, remoteCdnBaseUrls=${JSON.stringify(options.remoteCdnBaseUrls ?? [])}, remoteCacheDir=${options.remoteCacheDir ?? "<empty>"}, platformArch=${options.platformArch ?? "<empty>"}).`,
    );
  }

  // [失败路径] version/platformArch 会直接成为路径段，必须先断言它们不含分隔符且不是
  // "."/".."：CDN 清单或 CLI 参数里一个上跳片段就能把缓存写到预期目录之外（INV-1）。
  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  // [权衡] CDN 地址里带版本是发布约定的一部分，先校验再发请求：地址与版本不一致时
  // 下回来的清单会被 parse 阶段的 appVersion 校验拒绝，但那时已经浪费一次完整下载。
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);
  // [权衡] null 表示“全量”，Set 表示“只落地这些”：两种语义在缓存键、ready 标记、
  // release 目录名上都要分叉，因此只在这里归一化一次，后续函数不再各自 trim。
  const requestedComponentIds = normalizeRequestedComponentIds(options.componentIds);
  // [权衡] 判定口径是“任一组件内容寻址即视为内容寻址”：只要目录名里出现 sha256 段，
  // 整条 release 路径就不能再用 version 唯一标识，命中判断必须改走清单快照。
  const usesContentAddressedArtifactIdentity =
    requestedComponentIds === null ||
    Array.from(requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  // [失败路径] 空串会被归一化成当前目录，等于把整个目录声明为“必须存在”，任何缓存
  // 都能通过校验；因此归一化阶段就过滤空值并去重，而不是留到逐路径检查时兜底。
  const requiredReleasePaths = normalizeRequiredReleasePaths(options.requiredReleasePaths);

  // 之前 cache 目录只按 version 区分，跨平台 remote 会话会互相覆盖资源。
  // 这里改成 version + platformArch 双维隔离，避免 linux/darwin 互串导致部署二进制不匹配。
  const releaseDir = join(remoteCacheDir, "releases", version, platformArch);
  // [权衡] 命中即返回时不再打 info：远端会话可能每隔几秒重连一次，成功路径打日志会
  // 淹没真正需要观察的下载与失败记录，所以只在未命中时打一条 warn 作为下载起点。
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(releaseDir, platformArch, requiredReleasePaths))
  ) {
    return releaseDir;
  }
  loggers.logWarn(
    `[remote-assets] download required: component=<release> reason=local cache missing or invalid path=${releaseDir}`,
  );

  // 同一个桌面窗口可以并发创建多个 remote session。
  // 若不加进程内锁，会出现多个会话同时下载并解压同一版本资源，最终互相覆盖或留下半成品目录。
  // 之前锁 key 没带 remoteCacheDir，不同缓存目录会误复用同一 Promise。
  // 这会把 A 目录的 release 路径返回给 B 调用方，破坏 cache 隔离语义。
  // [并发] 集合排序后再拼 key：请求顺序不同但集合相同的两次调用必须合并成一次下载，
  // 否则同一批组件会被两路并发写入并互相覆盖（INV-16）。
  const requestedComponentLockKey = requestedComponentIds
    ? Array.from(requestedComponentIds).sort().join(",")
    : "<all>";
  // [事务] pinnedContentIdentity 只从清单快照算，不读磁盘：磁盘上可能只有上一轮的
  // 半成品目录，读盘会把“正在写的版本”误当成这次的身份，锁就会跨版本误合并。
  const pinnedContentIdentity = usesContentAddressedArtifactIdentity
    ? resolveContentAddressedReleaseSegments(
        options.manifestRef
          ? selectManifestComponents(options.manifestRef.manifest, requestedComponentIds)
          : [],
        requestedComponentIds,
      ).join("/")
    : undefined;
  // [并发] force 与 timeout 也进 key：强制刷新与复用是两种语义，超时不同意味着调用方
  // 对“失败”的定义不同，合并会让其中一方拿到不符合自己预期的结果（INV-16）。
  const lockKey = [
    resolve(releaseDir),
    requestedComponentLockKey,
    options.manifestRef === null ? "<missing-manifest>" : pinnedContentIdentity || "<unpinned>",
    options.forceRefresh ? "force" : "reuse",
    String(options.manifestRequestTimeoutMs ?? "default"),
  ].join("::");
  // [并发] 这是“等待并复检”而不是互斥等待：已有任务可能在本次调用声明 requiredPaths
  // 之前就完成了，直接复用它的返回值会返回残缺缓存（INV-17）。
  while (true) {
    const lockedTask = remoteAssetReleaseLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedReleaseDir = await lockedTask;
    const missingPaths = await findMissingLocalRelativePaths(
      lockedReleaseDir,
      requiredReleasePaths,
    );
    if (missingPaths.length === 0) {
      return lockedReleaseDir;
    }
    // 并发 remote session 可能先复用一个“不带 required paths”的 release 下载锁。
    // 等待该锁完成后必须按当前调用方声明的关键路径复检，缺失时继续走后续重下流程。
    // [失败路径] 复检不通过继续循环而不是抛错：另一个任务可能马上开始第二轮下载，
    // 重新读锁能搭上那一次，比让调用方重试少一次完整的网络往返。
    loggers.logWarn(
      `[remote-assets] locked release cache still incomplete: missing=${missingPaths.join(",")}; redownloading`,
    );
  }

  // [资源] 锁表项在 finally 里删除而不是在 then 里：成功与失败都必须让下一次调用能
  // 重新发起，否则一次 CDN 5xx 会把该 release 永久钉在失败 Promise 上（INV-14）。
  const task = ensureRemoteReleaseDirFromCdnInternal(
    {
      remoteCdnBaseUrls,
      remoteCacheDir,
      version,
      platformArch,
      requestedComponentIds,
      requiredReleasePaths,
      manifestRef: options.manifestRef,
      forceRefresh: options.forceRefresh,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
  ).finally(() => {
    remoteAssetReleaseLocks.delete(lockKey);
  });

  // [并发] set 发生在注册 finally 之后、返回之前，中间没有 await：
  // 不存在“任务已开始但尚未登记”的窗口被第二个调用读到空锁。
  remoteAssetReleaseLocks.set(lockKey, task);
  return task;
}

// 兼容性别名：只关心清单内容的调用方不必携带 releaseBase 候选列表。
// [权衡] 保持返回 null 而不是抛错：清单缺失在“先探测再决定是否部署”的路径里是正常
// 分支，抛错会迫使每个探测调用方都写 try/catch，反而更容易把真实错误一起吞掉。
export async function fetchRemoteAssetManifestFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifest | null> {
  return (await fetchRemoteAssetManifestRefFromCdn(options, loggers))?.manifest ?? null;
}

// 探测型入口：只读取清单，不物化任何目录。
// [失败路径] 与部署入口相反，参数不全时返回 null 而不是抛错：本地开发/离线模式允许
// 完全没有 CDN 配置，把“没配置”升级成异常会让这些路径也走不下去。
export async function fetchRemoteAssetManifestRefFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    return null;
  }

  // [失败路径] 探测路径也不能跳过路径段校验：version 仍会参与锁 key 与本地清单缓存
  // 定位，放行非法片段会让探测请求污染真正的部署缓存目录。
  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);

  // [并发] 候选顺序即尝试顺序；第一个 200 的源会被记录下来并优先用于组件下载，
  // 避免清单来自 A 节点、组件却从 B 节点取到不同发布批次的版本（INV-15）。
  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, version);
  const manifestFileCandidates = buildRemoteManifestFileCandidates(platformArch);
  // [失败路径] 候选列表理论上非空，兜底值是为了让日志里的 fileLabel 永远可读：
  // 错误信息指向缺失的清单文件名，比打印 undefined 更容易对上 CDN 发布结构。
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );

  // [权衡] refreshManifest 通过注入 shouldRefresh 回调实现，而不是在缓存层内部判断：
  // “是否需要重发请求”属于调用方业务判断，缓存层只负责把它变成一次 single-flight。
  const result = await fetchRemoteAssetManifest(
    {
      remoteCacheDir,
      version,
      platformArch,
      remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    options.refreshManifest ? async () => true : undefined,
  );
  return result;
}

// 内部实现不重复入口级参数校验：所有字段都已归一化，这里只负责“按快照物化”。
// [权衡] 两处各写一套校验会随时间漂移成不同口径，最终出现“入口放行、内部拒绝”的
// 不可解释失败；因此校验只保留在唯一入口，内部函数信任入参。
async function ensureRemoteReleaseDirFromCdnInternal(
  options: {
    remoteCdnBaseUrls: string[];
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    manifestRef?: RemoteAssetManifestRef | null;
    forceRefresh?: boolean;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  // [事务] 重算内容寻址判定而不是让调用方传布尔值：该判定只依赖组件集合，重算能保证
  // 与锁 key 使用同一口径；传参则可能在两处演化出不同定义，锁就护不住真正的目录。
  const usesContentAddressedArtifactIdentity =
    options.requestedComponentIds === null ||
    Array.from(options.requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  // [事务] 目录规则必须与入口逐字符一致：两者一旦分叉，锁保护的目录与真正写入的目录
  // 就不是同一个，并发会话会各写各的（INV-1）。
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
  );
  // [权衡] 这里再判一次命中不是重复劳动：入口到内部之间可能等待过别人的锁，
  // 等待期间磁盘上已经出现可用目录，此时直接返回能省掉整轮下载。
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  const releaseBaseCandidates = buildReleaseBaseCandidates(
    options.remoteCdnBaseUrls,
    options.version,
  );
  const manifestFileCandidates = buildRemoteManifestFileCandidates(options.platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );
  // [事务] 有清单快照就直接物化，不再发任何网络请求：这条快照由更上层的部署事务
  // 固定，重新拉取会让“判断能否跳过”与“真正落地”看到两份不同清单（INV-15）。
  if (options.manifestRef) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: options.manifestRef.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      options.manifestRef.manifest,
      loggers,
    );
  }
  if (options.manifestRef === null) {
    // 上游已在 deploy lock 内固定“manifest 缺失”结果；
    // 若 release materialize 再请求一次，会破坏单事务快照并翻倍超时上限。
    // [失败路径] 直接抛错而不是回退到“跳过部署”：缺失清单意味着 CDN 发布不完整，
    // 继续用旧缓存会让远端跑着与宿主版本不匹配的 server-bundle，问题更难定位。
    throw new Error(
      `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
    );
  }

  // [权衡] 只有内容寻址才需要“刷新判定”：普通组件按语义版本缓存，同版本重发属于
  // 发布错误；内容寻址组件必须每次核对 sha256，否则热修会被旧缓存静默吞掉（INV-21）。
  // 回调只查本地清单是否存在，不重新下载，避免把一次判定变成一次完整拉取。
  const manifestFetchResult = await fetchRemoteAssetManifest(
    {
      remoteCacheDir: options.remoteCacheDir,
      version: options.version,
      platformArch: options.platformArch,
      remoteCdnBaseUrls: options.remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    usesContentAddressedArtifactIdentity
      ? async (cachedResult) => {
          // [事务] 按本次调用声明的组件子集计算内容段：子集不同则 release 目录名不同，
          // 用全量清单判断存在性会把“另一个子集的目录”误当成本次已就绪。
          const cachedComponents = selectManifestComponents(
            cachedResult.manifest,
            options.requestedComponentIds,
          );
          const contentSegments = resolveContentAddressedReleaseSegments(
            cachedComponents,
            options.requestedComponentIds,
          );
          // [失败路径] 内容段为空说明快照里没有内容寻址组件，无法证明本目录就绪，
          // 返回 false 让调用方走正常拉取流程，而不是凭“清单有值”乐观跳过。
          return contentSegments.length > 0
            ? pathExists(
                join(
                  options.remoteCacheDir,
                  "releases",
                  options.version,
                  options.platformArch,
                  ...contentSegments,
                  `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`,
                ),
              )
            : false;
        }
      : undefined,
  );
  if (manifestFetchResult) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: manifestFetchResult.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      manifestFetchResult.manifest,
      loggers,
    );
  }

  // 现在生产态只发布 manifest/components。manifest 缺失说明 CDN 发布不完整，
  // 继续探测旧 remote-assets 只会增加无效请求并掩盖真正的发布问题。
  // [失败路径] 这里必须抛错而不是返回一个空 release：调用方会拿空目录去启动远端，
  // 真正的“清单没发上去”就被伪装成远端起不来，排障方向会完全跑偏。
  throw new Error(
    `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
  );
}

// manifest 的 single-flight。这里要同时满足两件事：同一份请求只发一次，
// 以及“需要刷新”的调用不能被“已经缓存的旧结果”直接打发走。
// [并发] 用两张表而不是一张，是因为“首次拉取”和“刷新拉取”的生命周期不同：
// 首次结果可以长期留在表里供复用，刷新请求只应在进行中合并，完成后必须能再刷新。
async function fetchRemoteAssetManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    remoteCdnBaseUrls: string[];
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
  shouldRefreshCachedResult?: (result: RemoteAssetManifestFetchResult) => Promise<boolean>,
): Promise<RemoteAssetManifestFetchResult | null> {
  // [并发] 键里带 resolve(cacheDir) 而不是原始串，且带上全部 CDN 源：
  // 不同缓存目录或不同源组合下，同一 version 的清单可能不同，合并会串味（INV-16）。
  const lockKey = [
    resolve(options.remoteCacheDir),
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...options.remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteAssetManifestLocks.get(lockKey);
  if (lockedTask) {
    // [并发] 已有刷新请求在飞时直接接入它，而不是再判一次是否需要刷新：
    // 否则每个等待者都会各自触发一次刷新，single-flight 就退化成扇出。
    const activeRefreshTask = remoteAssetManifestRefreshLocks.get(lockKey);
    if (activeRefreshTask) {
      return activeRefreshTask;
    }
    const cachedResult = await lockedTask;
    // [并发] await 期间可能有人发起了刷新，这里再读一次表：抢在刷新结果之前返回旧值，
    // 会让“检查 SHA 后决定是否重下”的调用方在发布切换点看到过期快照。
    const refreshStartedWhileWaiting = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileWaiting) {
      return refreshStartedWhileWaiting;
    }
    // [失败路径] 判定回调本身可能抛错，这里不 try/catch：抛错应向上暴露为调用失败，
    // 吞掉会退化成“用旧清单继续部署”，而旧清单正是本次要验证的对象（INV-21）。
    const shouldRefresh = Boolean(
      cachedResult && shouldRefreshCachedResult && (await shouldRefreshCachedResult(cachedResult)),
    );
    if (!shouldRefresh) {
      return cachedResult;
    }
    // [并发] 判定期间又有刷新启动时同样接入：判定是异步的，这段窗口内状态可能已变化。
    const refreshStartedWhileDeciding = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileDeciding) {
      return refreshStartedWhileDeciding;
    }
  }

  let task: Promise<RemoteAssetManifestFetchResult | null>;
  task = fetchRemoteAssetManifestInternal(options, loggers).then(
    (result) => {
      // [失败路径] null 是“所有候选都 404”的负结果，不能留在表里：CDN 补发清单后，
      // 后续调用必须能重新探测，否则缺失会被进程生命周期一直记住（INV-14）。
      // 比较 `=== task` 是为了只删自己的项，避免误删后来者刚写入的新任务。
      if (!result && remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      return result;
    },
    (error) => {
      // [失败路径] 网络/解析错误同样要清表：不清会让一次 5xx 变成永久失败，
      // 而且错误对象里含有本次请求的候选地址，复用旧 Promise 也无法重新选源。
      if (remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      throw error;
    },
  );
  remoteAssetManifestLocks.set(lockKey, task);
  if (shouldRefreshCachedResult) {
    // 多个 remote session 可能同时检查内容寻址组件的 SHA。fresh manifest 也必须
    // single-flight，否则同一批会话会重复请求，甚至在发布切换点看到不同快照。
    // [资源] refresh 表只在任务生命周期内存在，成功/失败都删除；删除前比对身份，
    // 避免把后来者覆盖写入的新任务删掉。
    remoteAssetManifestRefreshLocks.set(lockKey, task);
    void task.then(
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
    );
  }
  return task;
}

// 只负责“真的去拉一次清单”，锁/复用都在上层。这样拆分让刷新判定可以在不触发
// 网络请求的前提下先做一次，避免为了判断是否需要刷新而先下载一遍。
async function fetchRemoteAssetManifestInternal(
  options: {
    version: string;
    platformArch: string;
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestFetchResult | null> {
  const manifestFetchResult = await fetchFirstAvailableManifestOrNullWhenNotFound({
    candidates: options.manifestUrlCandidates,
    fileLabel: options.manifestFileName,
    version: options.version,
    platformArch: options.platformArch,
    manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
    fetch: resolveRemoteAssetFetch(options.remoteAssetNetwork),
  });
  // [失败路径] null 表示“所有候选都 404”，而不是“网络失败”：网络失败会抛错并携带
  // 每个候选的原因，两者必须区分，否则 CDN 配置缺失会被误判成网络抖动而不断重试。
  if (!manifestFetchResult) {
    return null;
  }

  loggers.log(`[remote-assets] downloading ${manifestFetchResult.url}`);
  // [事务] 记录清单实际命中的源，并在后续组件下载中把它提到第一位：清单与组件必须
  // 来自同一发布批次，跨源混用会在灰度切换点下载到另一批版本（INV-15）。
  const manifestReleaseBase = resolveReleaseBaseByAssetUrl(
    manifestFetchResult.url,
    options.releaseBaseCandidates,
  );
  // 组件级按需下载后，同一次部署会多次请求 releaseDir。
  // 这里缓存 manifest，并继续优先使用 manifest 命中的 CDN 源，避免重复拉 manifest 和跨源组件不一致。
  // [失败路径] 匹配不到源时保留原候选顺序：说明清单 URL 与候选基址不同源（例如重定向），
  // 此时无法判定“同一批次”，只能退化为按配置顺序重试。
  const releaseBaseCandidatesForComponents = manifestReleaseBase
    ? [
        manifestReleaseBase,
        ...options.releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
      ]
    : options.releaseBaseCandidates;

  return {
    manifest: manifestFetchResult.manifest,
    releaseBaseCandidatesForComponents,
  };
}

// 按清单把组件逐个落地，再组装成 release 目录。
// [事务] 关键顺序：先落全部组件 → 再获取物化锁 → 最后写清单与 ready 标记。
// 组件下载可能耗时数分钟，放在锁外可以让不同 release 并行下载；锁内只剩本地的
// mkdir/link/rename，窗口极短，避免长时间持锁阻塞其他会话。
async function ensureRemoteReleaseDirFromManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    forceRefresh?: boolean;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  manifest: RemoteAssetManifest,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  // [失败路径] 请求了清单里不存在的组件时 selectManifestComponents 会抛错，而不是静默
  // 少装：少装会让 release 看起来就绪但缺模块，报错点会漂移到远端运行期（INV-2）。
  const selectedComponents = selectManifestComponents(manifest, options.requestedComponentIds);
  // [事务] release 目录名里的内容段只来自“本次选中的组件”：全量清单会带上不属于本次
  // 部署的 sha256，目录名就与内容不再一一对应，命中判断随之失真（INV-6）。
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
    ...resolveContentAddressedReleaseSegments(selectedComponents, options.requestedComponentIds),
  );
  // [权衡] 这里也保留一次命中判断：同一 release 可能已被另一次部署完整产出，
  // 直接返回可以省掉逐组件的 stat 与 staging 目录创建。
  if (
    !options.forceRefresh &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  // 之前组装 releaseDir 会按 manifest 拉齐全部组件，即使后续远端版本检查会跳过。
  // 这里只落地本次部署明确需要的组件，避免主 server 升级时额外下载已最新的工具包。
  const componentCacheEntries: Array<{
    component: RemoteAssetManifestComponent;
    componentDir: string;
  }> = [];
  for (const component of selectedComponents) {
    // [事务] 每个组件只索取“落在该 mount 之下的 requiredPaths”子集：把全量路径传给
    // 每个组件会让所有组件都去校验别人的文件，永远缺路径，从而反复重下（INV-17）。
    const componentDir = await ensureRemoteComponentDirFromCdn(
      options,
      component,
      resolveRequiredComponentPaths(component, options.requiredReleasePaths),
      loggers,
      Boolean(options.forceRefresh),
    );
    componentCacheEntries.push({ component, componentDir });
  }

  // [资源] 物化锁内只做本地文件操作：跨组件目录的 link/copy 与清单写入。
  // 若把下载也放进来，锁会横跨数分钟的网络 IO，其他会话只能干等。
  await runWithReleaseMaterializeLock(releaseDir, async () => {
    await mkdir(releaseDir, { recursive: true });
    for (const { component, componentDir } of componentCacheEntries) {
      // [事务] 逐个 mount 独立 staging 后原子替换：某个组件失败不会留下“前一半已提交”
      // 的假象，因为真正的 release 级就绪标记要等下面写完清单才会出现。
      await materializeComponentIntoReleaseDir(
        component,
        componentDir,
        releaseDir,
        options.remoteCacheDir,
        options.platformArch,
      );
    }
    await writeFile(
      join(releaseDir, `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );

    // [事务] 指定组件子集时不写 release 级 ready：该目录只包含部分组件，若被标记就绪，
    // 后续“全量”调用会命中它并缺组件。子集目录靠清单文件本身证明完整性。
    if (options.requestedComponentIds) {
      return;
    }

    // [失败路径] 写 ready 之前做一次结构自检：缺 server 或 node runtime 的目录若被标成
    // 就绪，后续所有调用都会命中它并跳过下载，只能靠人工删缓存恢复（INV-2/INV-10）。
    if (!(await isValidReleaseDir(releaseDir, options.platformArch))) {
      throw new Error("[remote-assets] assembled release directory is invalid");
    }

    await writeReadyMarker(releaseDir, REMOTE_ASSET_READY_MARKER);
  });
  return releaseDir;
}

// 目录级串行器：把同一 releaseDir 上的物化排成一条链，而不是用布尔“有人在写”标记。
// [并发] 用 Promise 链而不是互斥量，是因为调用方可能来自不同事件循环阶段：
// 链式排队天然保证 FIFO，且不需要在异常路径显式释放锁（释放由 Promise 完成触发）。
// [失败路径] 前一个任务失败被 catch 掉是刻意的：它已经把自己写坏的目录留在 staging，
// 当前任务会重新生成并原子替换，阻塞在这里反而让一次失败拖垮整批部署。
async function runWithReleaseMaterializeLock(
  releaseDir: string,
  task: () => Promise<void>,
): Promise<void> {
  // [并发] key 用 resolve 后的绝对路径：同一目录可能以不同相对形式传入，
  // 不归一化会出现两把锁并行写同一个 release，目录内容互相覆盖（INV-4）。
  const lockKey = resolve(releaseDir);
  const previousTask = remoteAssetReleaseMaterializeLocks.get(lockKey);

  const currentTask = (async () => {
    if (previousTask) {
      await previousTask.catch(() => {
        // 前一个写入失败不能阻塞后续重试；当前任务会重新物化自己的组件。
      });
    }
    await task();
  })();

  // [资源] 登记的是当前任务而非“空标记”：后来者 await 到的是本任务完成信号，
  // 因此在 finally 删除后，后来者早已持有自己需要的 Promise 引用。
  remoteAssetReleaseMaterializeLocks.set(lockKey, currentTask);
  try {
    await currentTask;
  } finally {
    // [并发] 删除前比对身份：若本任务尚未删除时已有新任务覆盖写入，直接 delete 会把
    // 新任务的排队关系抹掉，第三个调用就会与本任务并行（锁失效）。
    if (remoteAssetReleaseMaterializeLocks.get(lockKey) === currentTask) {
      remoteAssetReleaseMaterializeLocks.delete(lockKey);
    }
  }
}
// [失败路径] 非法 component id 必须在这里就拒绝，而不是等到拼目录名时：id 会直接成为
// 缓存路径段，允许大写/下划线/斜杠会让白名单查表失败，错误信息也会指向“未知组件”。
function normalizeRequestedComponentIds(componentIds: string[] | undefined): Set<string> | null {
  if (!componentIds) {
    return null;
  }

  // [权衡] 空数组与“全量”同义：上层常把“没有筛选”序列化成 []，若把 [] 解释成
  // “一个组件都不装”，release 目录会缺 server-bundle，远端根本无法启动。
  const normalizedIds = componentIds.map((componentId) => componentId.trim()).filter(Boolean);
  if (normalizedIds.length === 0) {
    return null;
  }

  // [失败路径] 格式校验放在返回 Set 之前，保证调用方拿到的每个 id 都是可直接拼接的
  // 安全路径段；把校验留到 join 处，错误会变成“目录不存在”而不是“id 非法”。
  for (const componentId of normalizedIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(componentId)) {
      throw new Error(`[remote-assets] component id is invalid: ${componentId}`);
    }
  }

  return new Set(normalizedIds);
}

// 关键路径声明在进入缓存前统一归一化：下游有两层（release 级与组件级）都要用这份
// 相对路径，任何一层拿到未归一化的字符串都会与 mount 前缀匹配失败，导致“永远缺失”。
function normalizeRequiredReleasePaths(requiredReleasePaths: string[] | undefined): string[] {
  if (!requiredReleasePaths) {
    return [];
  }

  // [权衡] 去重不是洁癖：调用方常把多处来源的路径合并，重复项会让后续对每个路径都
  // 做一次 stat 且结果完全相同，部署时序会被无谓地拉长。
  return Array.from(
    new Set(
      requiredReleasePaths
        .map((relativePath) =>
          normalizeRemoteAssetRelativePath(relativePath, "requiredReleasePath"),
        )
        .filter(Boolean),
    ),
  );
}

// 对外版本：先归一化再选择，保证外部传入的 id 与内部调用走同一套格式校验，
// 避免“入口校验一次、后续又用原始字符串查表”导致两边集合不一致。
export function selectRemoteAssetManifestComponents(
  manifest: RemoteAssetManifest,
  componentIds?: string[],
): RemoteAssetManifestComponent[] {
  return selectManifestComponents(manifest, normalizeRequestedComponentIds(componentIds));
}

// [失败路径] 请求的组件在清单里缺失时抛错，而不是返回已找到的子集：少装组件会让
// release 结构“看起来完整”，问题被推迟到远端启动阶段（INV-2）。
function selectManifestComponents(
  manifest: RemoteAssetManifest,
  requestedComponentIds: Set<string> | null,
): RemoteAssetManifestComponent[] {
  if (!requestedComponentIds) {
    return manifest.components;
  }

  const selectedComponents = manifest.components.filter((component) =>
    requestedComponentIds.has(component.id),
  );
  const foundIds = new Set(selectedComponents.map((component) => component.id));
  const missingIds = Array.from(requestedComponentIds).filter(
    (componentId) => !foundIds.has(componentId),
  );
  if (missingIds.length > 0) {
    throw new Error(
      `[remote-assets] manifest is missing requested components: ${missingIds.join(", ")}`,
    );
  }

  return selectedComponents;
}

// 把一个已就绪的组件目录“投影”到 release 的 mount 位置。
// [事务] 采用“完整复制到 staging + rename 覆盖 mount”的方式，而不是直接写 mount：
// mount 可能已被上一次部署占用，直接写会先删后建，中间窗口内 release 是不完整状态。
async function materializeComponentIntoReleaseDir(
  component: RemoteAssetManifestComponent,
  componentDir: string,
  releaseDir: string,
  remoteCacheDir: string,
  platformArch: string,
): Promise<void> {
  // [资源] staging 固定落在 cache/staging 下，清理任务只需扫这一层；
  // 名称含 pid 与 randomUUID，保证同进程重试与多进程并行都不会互相覆盖（INV-20）。
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-release-component-${component.id}-${platformArch}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    // [失败路径] 物化前先复制而不是直接 link mount：复制期间源组件目录若被并发的
    // forceRefresh 替换，复制仍会拿到一份完整的一致快照，不会出现半新半旧的文件。
    await materializeDirectoryContents(componentDir, componentStagingDir);
    // [失败路径] 空目录必须在这里拦下：它一旦被 rename 成 mount 并最终写 ready，
    // 后续所有“命中”判断都会通过，只能靠人工删缓存恢复（INV-10）。
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] release component is empty for ${component.id}@${component.version}`,
    );
    // [失败路径] mount 来自 CDN 清单，必须做前缀校验后才允许作为写入目标：
    // 这是唯一能把“清单内容”变成“宿主写路径”的点（INV-8/INV-12）。
    const mountDir = resolvePathWithinBase(
      releaseDir,
      component.mount,
      `component ${component.id} mount`,
    );
    await commitStagingDirectoryAtomically(componentStagingDir, mountDir);
  } finally {
    // [资源] 失败路径也必须删 staging：残留目录不会被任何清理逻辑识别为“可回收”，
    // 会一直占盘，并在人工排查时被误当成组件缓存（INV-20）。
    await rm(stagingDir, { recursive: true, force: true });
  }
}

// 组件级入口：语义是“确保这个组件的缓存目录可用”。
// [权衡] 组件级命中判断只看调用方声明的 requiredRelativePaths，而不是全量文件：
// 全量校验需要遍历整个目录，在大组件上比下载还慢，而声明路径已能覆盖启动所需。
async function ensureRemoteComponentDirFromCdn(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  // [事务] 命中即返回前必须先解析目录身份：目录名由内容哈希决定，解析这一步本身就是
  // “这次请求要的是哪份内容”的唯一答案，跳过它会让后面的锁与命中判断失去依据（INV-5）。
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  // [权衡] forceRefresh 刻意绕过这里：它存在的意义就是让热修能覆盖同版本内容，
  // 若仍先查命中，强制刷新在“缓存恰好完整”时会被静默降级成普通复用（INV-21）。
  if (
    !forceRefresh &&
    (await isReadyComponentDirForRequiredPaths(componentDir, requiredRelativePaths))
  ) {
    return componentDir;
  }

  // 组件锁 key 之前未带 remoteCacheDir，不同缓存目录会被同一组件下载锁串起来。
  // 这里直接使用 componentDir 绝对路径做 key，保证隔离语义与落盘目录一一对应。
  const lockKey = resolve(componentDir);
  // [并发] 同 release 的做法：等锁后必须按本次 requiredRelativePaths 复检，
  // 因为先完成的任务可能只声明了更小的路径集合，直接复用会返回残缺组件（INV-17）。
  while (true) {
    const lockedTask = remoteAssetComponentLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedComponentDir = await lockedTask;
    const missingPaths = await findMissingReadyComponentPaths(
      lockedComponentDir,
      requiredRelativePaths,
    );
    if (missingPaths?.length === 0) {
      return lockedComponentDir;
    }
    // 不同部署调用会共享同一 component cache 锁。等待已有下载后，
    // 仍要用当前调用方的关键路径复检，避免把只满足旧调用的残缺 cache 返回出去。
    loggers.logWarn(
      `[remote-assets] locked component cache still incomplete: component=${component.id} missing=${(missingPaths ?? []).join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteComponentDirFromCdnInternal(
    options,
    component,
    requiredRelativePaths,
    loggers,
    forceRefresh,
  ).finally(() => {
    remoteAssetComponentLocks.delete(lockKey);
  });
  remoteAssetComponentLocks.set(lockKey, task);
  return task;
}

// 组件下载的真正实现：命中 → 迁移 → 下载 → 校验 → 解压 → 原子提交。
// [权衡] remoteAssetComponentLocks 内再查一次命中：拿锁前可能等过别人的下载；等待期间目录补齐就直接返回，省掉整轮下载。
// 等待期间目录可能已被补齐，此时返回能省掉一轮完整下载。
async function ensureRemoteComponentDirFromCdnInternal(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  // [事务] 目录身份再次解析而不是由入口传参：forceRefresh 场景下入口可能已经做过
  // 一次删除，重算能保证这里操作的目录与入口校验的目录是同一个（INV-5）。
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (forceRefresh) {
    // App 版本变化代表一次新的资源发布边界；即使 GLM SHA cache 命中，
    // 也必须重新下载、校验并原子替换，避免本地上传把旧 cache 再次部署到远端。
    // [失败路径] 这里只打 warn 不删目录：删除放到下载成功后的提交阶段，
    // 否则下载失败会让原本可用的缓存也一起消失，远端直接无 cache 可用。
    loggers.logWarn(
      `[remote-assets] forced component refresh: component=${component.id} path=${componentDir}`,
    );
  }
  // [失败路径] 用“返回缺失列表”而不是布尔值：缺少哪些文件要写进日志，
  // 否则线上只能看到“缓存不完整”，无法判断是发布漏文件还是客户端声明错误。
  const initialMissingPaths = await findMissingReadyComponentPaths(
    componentDir,
    requiredRelativePaths,
  );
  if (!forceRefresh && initialMissingPaths?.length === 0) {
    return componentDir;
  }
  if (!forceRefresh && initialMissingPaths) {
    // 旧版本只用 .ready 判断 component cache 可用。用户先部署过只含
    // zcode.cjs 的 glm cache 后，再补传 packages 会一直复用残缺 cache。
    // 这里按调用方声明的关键路径校验，缺失时清掉旧 cache 并从 CDN 重下完整组件。
    // [权衡] 删除范围是整个 componentDir 而不是缺失文件：残缺目录的来源不可判定，
    // 只补文件可能留下未知版本的混杂内容，整目录重下虽然费流量但结果确定（INV-2）。
    loggers.logWarn(
      `[remote-assets] local component cache incomplete: component=${component.id} missing=${initialMissingPaths.join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    // [事务] 迁移只对“按语义版本命名”的组件开放：内容寻址组件的目录名就是内容哈希，
    // 从旧目录搬过来会在内容不一致时伪造出一个“已验证”的目录（INV-6）。
    (await tryMigrateComponentDirFromHashVersionComponentCache(
      options,
      component,
      componentDir,
      loggers,
    ))
  ) {
    // [失败路径] 迁移成功只代表目录“搬过来了”，不代表团建内容齐全：
    // 旧 cache 本身可能就是残缺的，必须按本次声明的路径复检后再决定是否可用（INV-2）。
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    // [权衡] 复检失败就删掉刚迁移的目录：留着它会让下一轮迁移反复命中同一个残缺目录，
    // 每次都走“迁移 → 复检 → 删除”的空转，不如直接回到下载路径。
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    // [事务] 第二级迁移针对更老的“整包 release 目录”布局：它是单向历史兼容，
    // 因此同样排除内容寻址组件，避免把旧布局的内容误标成新身份的产物。
    (await tryMigrateComponentDirFromLegacyReleaseCache(options, component, componentDir, loggers))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    // [失败路径] 与上面同理：旧布局迁移过来的目录也必须复检，否则会把“旧版本残缺”
    // 当成“新版本就绪”，后续再也不会重新下载（INV-2）。
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  // [失败路径] 候选地址由“清单命中的源 + 其余源”组成：artifactPath 来自清单，
  // 若某个源返回 404，后面的源仍可能可用；单源硬失败会让一次节点故障变成部署失败。
  const artifactUrlCandidates = buildComponentArtifactUrlCandidates(
    options.releaseBaseCandidatesForComponents,
    component.artifactPath,
    options.version,
  );

  // [资源] 下载、解压、校验全部在 staging 内完成，最后一步才 rename 到 componentDir：
  // 任何中途失败都只污染 staging，componentDir 保持原状，避免“新内容写坏旧缓存”。
  const stagingBaseDir = join(options.remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-${component.id}-${options.platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const archivePath = join(stagingDir, "component.tar.gz");
  const extractRoot = join(stagingDir, "extract");
  await mkdir(extractRoot, { recursive: true });

  try {
    // [失败路径] fetchFirstAvailableUrl 会按顺序尝试并在全失败时抛出聚合错误：
    // 它必须区分“404 换源”和“网络错误立即失败”，否则网络抖动会被放大成逐个换源重试。
    const { response: artifactResponse, url: artifactUrl } = await fetchFirstAvailableUrl(
      artifactUrlCandidates,
      `${component.id}@${component.version}`,
      resolveRemoteAssetFetch(options.remoteAssetNetwork),
    );
    loggers.log(`[remote-assets] downloading ${artifactUrl}`);
    // [资源] 边读边写而不是先 buffer 到内存：组件包可达数百 MB，
    // 全量读入会让宿主进程 RSS 峰值随并发下载线性增长。
    await writeResponseBodyToFile(artifactResponse, archivePath, loggers);

    // [失败路径] 校验必须发生在解压之前：先解压再校验等于把不可信内容写进文件系统，
    // 恶意归档里的路径条目可能已经生效（INV-9）。
    const actualChecksum = await computeFileSha256(archivePath);
    if (actualChecksum !== component.sha256) {
      throw new Error(
        `[remote-assets] sha256 mismatch for ${component.id}@${component.version}: expected=${component.sha256}, actual=${actualChecksum}`,
      );
    }

    // [失败路径] 解压后必须非空：空 tar.gz 的 sha256 同样能对上，
    // 若不拦下，空目录会被写 ready 并长期命中（INV-10）。
    await extractTarGzArchive(archivePath, extractRoot);
    await assertExtractedArchiveNotEmpty(
      extractRoot,
      `[remote-assets] extracted component archive is empty for ${component.id}@${component.version}`,
    );
    // [事务] ready 标记写在 staging 内、随目录一起 rename：若先 rename 再写标记，
    // 中间窗口里另一个会话会看到“无标记目录”并触发一次冗余下载（INV-3）。
    await writeReadyMarker(extractRoot, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(extractRoot, componentDir);
    return componentDir;
  } finally {
    // [资源] 成功后 stagingDir 只剩一个空壳，失败时里面有半个归档与解压产物；
    // 两种情况都必须在 finally 清理，否则磁盘会按“每次失败一份”增长（INV-20）。
    await rm(stagingDir, { recursive: true, force: true });
  }
}

// 历史兼容迁移一：旧布局把内容哈希拼在版本号后面（version+hash），新版只认纯版本。
// [权衡] 迁移而不是删除：已部署机器上的旧目录可能比重新下载快得多，尤其在内网弱网下；
// 代价是要多一次目录扫描与 rename，且必须处理“旧目录残缺”的场景。
async function tryMigrateComponentDirFromHashVersionComponentCache(
  options: {
    remoteCacheDir: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const cacheVersion = resolveRemoteAssetComponentCacheVersion(component.version);

  const componentRootDir = resolveComponentCacheRootDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  // [失败路径] readdir 失败直接返回 false 而不是抛错：目录不存在意味着“没有可迁移的
  // 旧缓存”，属于正常路径；升级成异常会让首次安装永远走不到下载阶段。
  let entries: Dirent[];
  try {
    entries = await readdir(componentRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyVersionPrefix = `${cacheVersion}+`;
  const candidates: Array<{ dir: string; version: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(legacyVersionPrefix)) {
      continue;
    }

    const candidateDir = join(componentRootDir, entry.name);
    if (resolve(candidateDir) === resolve(componentDir)) {
      continue;
    }
    if (!(await isReadyComponentDir(candidateDir))) {
      continue;
    }

    const candidateStat = await stat(candidateDir);
    candidates.push({
      dir: candidateDir,
      version: entry.name,
      mtimeMs: candidateStat.mtimeMs,
    });
  }

  // [权衡] 按 mtime 倒序取最新一个候选，而不是按字典序：同一语义版本可能有多次带
  // 不同 hash 的历史目录，最新的一次最接近当前发布内容，迁移后需要重下的概率最低。
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const candidate = candidates[0];
  if (!candidate) {
    return false;
  }

  // 旧版组件 cache 把内容 hash 拼进目录名（如 v0.11.1+abcd）。
  // 新版只按语义版本命中；即使线上旧 manifest 仍带 hash，也要先迁移到纯版本目录，
  // 避免同语义版本因为 hash 后缀不同反复下载。
  await migrateComponentSourceDir(
    candidate.dir,
    componentDir,
    component,
    `legacy component cache ${candidate.version}`,
    options.platformArch,
    options.remoteCacheDir,
    loggers,
  );
  return true;
}

// 历史兼容迁移二：更老版本把组件直接摊在 releases/<version>/<platform>/ 下。
// [权衡] 只有“旧目录内容哈希前缀与本次清单一致”才迁移：内容不一致时搬过来等于
// 伪造一份“已验证”的缓存，比不迁移危险得多（INV-6）。
async function tryMigrateComponentDirFromLegacyReleaseCache(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const expectedContentHashPrefix = extractContentHashPrefixFromComponentVersion(component.version);
  // [权衡] 版本里没有 hash 后缀说明当前清单不再提供内容身份，无法与旧目录比对：
  // 此时放弃迁移而不是盲目搬，宁可多下一次也不让来源不明的内容进入缓存。
  if (!expectedContentHashPrefix) {
    return false;
  }

  const releasesRootDir = join(options.remoteCacheDir, "releases");
  // [失败路径] releases 根目录不存在是全新安装的常态，返回 false 让调用方继续下载；
  // 这里吞掉错误是有边界的：只吞 readdir 的 ENOENT/权限错误，后续步骤仍会正常抛错。
  let releaseEntries: Dirent[];
  try {
    releaseEntries = await readdir(releasesRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyReleaseVersions = releaseEntries
    .filter((entry) => entry.isDirectory() && entry.name !== options.version)
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const legacyVersion of legacyReleaseVersions) {
    // [失败路径] 旧 release 目录本身必须“就绪”，否则里面可能只有半套组件：
    // 从一个未完成的旧目录迁移，会把“没下载完”当作内容来源（INV-2）。
    const legacyReleaseDir = join(releasesRootDir, legacyVersion, options.platformArch);
    if (!(await isReadyReleaseDir(legacyReleaseDir, options.platformArch))) {
      continue;
    }

    // [失败路径] mount 来自旧 release 的清单，同样来自外部输入，仍要做前缀校验后才
    // 作为读取源；否则一个被篡改的旧清单可以让迁移去读缓存外的任意目录（INV-12）。
    const legacyComponentSourceDir = resolvePathWithinBase(
      legacyReleaseDir,
      component.mount,
      `legacy component ${component.id} mount`,
    );
    // [失败路径] 旧 release 可能只含部分组件（子集部署），缺失的组件跳过即可，
    // 让调用方继续尝试下一个候选或直接下载，而不是整体失败。
    if (!(await isDirectoryPath(legacyComponentSourceDir))) {
      continue;
    }

    let legacyContentHash: string;
    try {
      // [权衡] 迁移前对整目录做一次哈希，成本是“多读一遍磁盘”，收益是能证明旧目录
      // 与当前清单内容一致；跳过这一步会让迁移变成“按路径猜内容”，风险不可控。
      legacyContentHash = await computePathContentSha256(legacyComponentSourceDir);
    } catch (error) {
      // [失败路径] 单个旧目录读取失败只跳过该候选：它可能正被其他进程删除，
      // 但这不代表其他历史版本也不可用，整体失败会白白放弃可迁移的缓存。
      loggers.logWarn(
        `[remote-assets] skip legacy component migration for ${component.id}@${component.version} from ${legacyVersion}: ${String(error)}`,
      );
      continue;
    }
    // [事务] 前缀比对而不是全等：旧清单只记录短前缀，清单里的 sha256 是完整值；
    // 用全等会永远匹配不上，迁移分支等于死代码（INV-6）。
    if (!legacyContentHash.startsWith(expectedContentHashPrefix)) {
      continue;
    }

    await migrateComponentSourceDir(
      legacyComponentSourceDir,
      componentDir,
      component,
      `legacy release ${legacyVersion}`,
      options.platformArch,
      options.remoteCacheDir,
      loggers,
    );
    return true;
  }

  return false;
}

// 两级迁移的公共落盘实现。即使只是“搬目录”也必须走 staging + ready + rename：
// [事务] 直接 rename 旧目录到新位置会让旧缓存瞬间消失，而新位置尚未写完 ready；
// 中途失败就同时失去新旧两份可用内容（INV-3/INV-18）。
async function migrateComponentSourceDir(
  sourceDir: string,
  componentDir: string,
  component: RemoteAssetManifestComponent,
  sourceLabel: string,
  platformArch: string,
  remoteCacheDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-migrate-${component.id}-${platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    // 迁移时仍走 staging + ready 原子提交，避免半成品目录被后续连接误判为可用 cache。
    // [资源] 复制而不是移动：旧目录保留原位，能让仍在旧布局上运行的其他进程继续使用，
    // 也避免“迁移途中旧目录被删除”导致源在复制一半时消失。
    await materializeDirectoryContents(sourceDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] migrated component source is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(componentStagingDir, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(componentStagingDir, componentDir);
    loggers.log(
      `[remote-assets] migrated ${component.id}@${component.version} from ${sourceLabel}`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export function buildRemoteAssetManifestFileCandidates(platformArch: string): string[] {
  return buildRemoteManifestFileCandidates(platformArch);
}

function buildRemoteManifestFileCandidates(platformArch: string): string[] {
  return [`${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`];
}

function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  // [权衡] 按长度倒序取最长匹配：多个 CDN 基址可能互为前缀（例如 .../cdn 与
  // .../cdn/v2），取第一个会命中较短的源，后续组件下载就会跨源拼出不一致批次。
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}

// 组件制品的多源下载：任一源 200 即返回，全部失败才抛聚合错误。
// [失败路径] 逐个累积错误而不是“遇到第一个错误就抛”：CDN 灰度期常见某节点 404、
// 另一节点正常；只报第一条会让排查者误以为制品根本没发布。
// [资源] 非 200 响应的 body 不读取也不取消：调用方只关心状态码，读取 body 会额外
// 占用连接与带宽，而 fetch 实现会在 GC 时释放底层 socket。
async function fetchFirstAvailableUrl(
  candidates: string[],
  fileLabel: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ response: Response; url: string }> {
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate);
      // [失败路径] 只认 response.ok：3xx 在 fetch 默认跟随重定向后本不该出现，
      // 但若被 redirect: manual 的注入实现返回，继续当成功会解析到空 body。
      if (response.ok) {
        return { response, url: candidate };
      }
      errors.push(`${candidate} -> HTTP ${response.status}`);
    } catch (error) {
      // [失败路径] 网络错误也换下一个候选而不是立即抛出：多源的全部意义就是容错，
      // 但错误仍要记录，否则全失败时的报错会丢失“哪个源因为什么失败”。
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  throw new Error(`[remote-assets] failed to fetch ${fileLabel}: ${errors.join("; ")}`);
}

// 清单下载版：与组件下载的关键差异是“404 不当作错误”，而是换源后返回 null。
// [失败路径] 404 与网络错误必须分开：前者说明“这个源还没发布清单”，后者说明“源不可达”；
// 全部 404 才返回 null（负结果，不缓存），只要有任何网络错误就抛错（INV-14）。
async function fetchFirstAvailableManifestOrNullWhenNotFound(options: {
  candidates: string[];
  fileLabel: string;
  version: string;
  platformArch: string;
  manifestRequestTimeoutMs?: number;
  fetch: typeof globalThis.fetch;
}): Promise<{ manifest: RemoteAssetManifest; url: string } | null> {
  const errors: string[] = [];

  for (const candidate of options.candidates) {
    // [并发] 每个候选创建独立 signal：超时是“单次请求”的预算，复用同一个 signal
    // 会让第一个候选耗尽时间后，后面的候选一开始就处于已 abort 状态（INV-13）。
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await options.fetch(candidate, { signal });
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
      continue;
    }
    // [失败路径] 404 不进 errors：它代表“该源没有本次发布”，全部候选都 404 时应返回
    // null 让上层判定为“未发布”，而不是抛错触发无限重试（INV-14）。
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      errors.push(`${candidate} -> HTTP ${response.status}`);
      continue;
    }

    try {
      return {
        manifest: await parseRemoteAssetManifestFromResponse(
          response,
          candidate,
          options.version,
          options.platformArch,
        ),
        url: candidate,
      };
    } catch (error) {
      // [失败路径] 解析失败是“内容不可信”，不能换源了事，必须立即抛出：换源只会让
      // 同一份错误清单在另一个节点被再解析一次，掩盖真正的发布错误。
      if (!signal.aborted) {
        throw error;
      }
      // fetch 在收到响应头后已经完成，但 response body 仍可能半开；
      // body 超时也属于候选 CDN 的网络失败，应继续尝试下一个候选而不是永久等待。
      // [权衡] 这里用 signal.aborted 区分“解析错误”与“读 body 超时”：前者是内容问题
      // 应立刻失败，后者是网络问题应换源重试，两者共用同一个 catch 才需要这个判据。
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`[remote-assets] failed to fetch ${options.fileLabel}: ${errors.join("; ")}`);
  }
  // [事务] 走到这里说明所有候选都返回 404：返回 null 而非空清单，调用方据此决定
  // “不部署”而不是“按空组件部署”，后者会产出结构合法但无法运行的 release。
  return null;
}

// 清单解析是唯一的“外部输入 → 内部对象”转换点，所有字段校验都必须在这里完成：
// [权衡] 逐字段校验而不是依赖类型断言：清单来自 CDN，任何字段都可能缺失或类型错误，
// 断言只会把错误推迟到 join 路径或下载阶段，届时错误信息已丢失源 URL 上下文。
export async function parseRemoteAssetManifestFromResponse(
  response: Response,
  sourceUrl: string,
  expectedAppVersion: string,
  expectedPlatformArch: string,
): Promise<RemoteAssetManifest> {
  const content = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    // [失败路径] JSON 解析错误必须带上来源 URL：清单请求会尝试多个候选源，
    // 没有 URL 就无法判断是哪个节点发布了坏内容。
    throw new Error(`[remote-assets] invalid manifest json from ${sourceUrl}: ${String(error)}`);
  }
  // [失败路径] 顶层必须是对象：数组或标量也能通过 JSON.parse，若不拦下，
  // 后续 readRequiredString 的报错会变成“字段不存在”，掩盖真正的问题是形状错误。
  if (!isObjectRecord(parsed)) {
    throw new Error(`[remote-assets] invalid manifest payload from ${sourceUrl}: expect object`);
  }

  // [事务] schemaVersion 只接受 1：结构一旦演进必须显式升级判断，
  // 否则新版清单里的字段含义变化会被旧客户端按旧语义解读，静默产出错误目录（INV-7）。
  const schemaVersion = readRequiredNumber(parsed, "schemaVersion", "manifest");
  if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    throw new Error(
      `[remote-assets] unsupported manifest schemaVersion=${schemaVersion} from ${sourceUrl}`,
    );
  }

  // [失败路径] 版本不一致一律拒绝而不是“以清单为准”：调用方已按目标版本算好了
  // releaseDir 与锁 key，用别的版本清单物化会把内容写进错误的版本目录（INV-7）。
  const appVersion = readRequiredString(parsed, "appVersion", "manifest");
  if (appVersion !== expectedAppVersion) {
    throw new Error(
      `[remote-assets] manifest appVersion mismatch from ${sourceUrl}: expected=${expectedAppVersion}, actual=${appVersion}`,
    );
  }

  // [失败路径] 平台校验同理且更严格：node/node-pty 是原生二进制，平台错了不是“行为
  // 异常”而是进程直接无法 exec，禁止降级接受（INV-7）。
  const platformArch = readRequiredString(parsed, "platformArch", "manifest");
  if (platformArch !== expectedPlatformArch) {
    throw new Error(
      `[remote-assets] manifest platformArch mismatch from ${sourceUrl}: expected=${expectedPlatformArch}, actual=${platformArch}`,
    );
  }

  const rawComponents = parsed.components;
  if (!Array.isArray(rawComponents)) {
    throw new Error(`[remote-assets] manifest.components must be array from ${sourceUrl}`);
  }
  // [失败路径] 空组件列表直接拒绝：它会让 release 目录只含清单文件，看起来提交成功，
  // 但远端启动时连 server-bundle 都找不到。
  if (rawComponents.length === 0) {
    throw new Error(`[remote-assets] manifest.components is empty from ${sourceUrl}`);
  }

  const components: RemoteAssetManifestComponent[] = [];
  // [事务] 去重集合而不是事后比较：重复 id 会产生两个不同 mount 的同名组件，
  // 后一个会覆盖前一个，且没有日志说明发生了覆盖。
  const seenIds = new Set<string>();
  for (const [index, rawComponent] of rawComponents.entries()) {
    const context = `manifest.components[${index}]`;
    if (!isObjectRecord(rawComponent)) {
      throw new Error(`[remote-assets] ${context} must be object`);
    }

    const id = readRequiredString(rawComponent, "id", context);
    // [失败路径] id 会成为目录段与白名单键，只允许小写字母数字与连字符：
    // 放行大写会让白名单查不到（等于该组件被跳过），放行斜杠则会越出组件根目录。
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(`[remote-assets] ${context}.id is invalid: ${id}`);
    }
    // [失败路径] 重复 id 必须报错而不是后者覆盖前者：两个条目的 mount 可能不同，
    // 覆盖后只会落下其中一个，另一个 mount 在远端被 require 时才会失踪。
    if (seenIds.has(id)) {
      throw new Error(`[remote-assets] duplicate component id in manifest: ${id}`);
    }
    seenIds.add(id);

    const mountRule = REMOTE_COMPONENT_MOUNT_RULES[id];
    if (!mountRule) {
      // 旧 release manifest 可能仍包含已退役的三方 agent 组件。
      // 当前客户端只认识 ZCode Agent 与基础运行时，未知组件应跳过，不能阻断当前组件下载。
      // [权衡] 跳过发生在读取其他字段之前：退役组件的历史字段格式可能已不符合当前
      // 校验规则，先校验再跳过会让“历史遗留”变成“部署失败”。
      continue;
    }

    const version = readRequiredString(rawComponent, "version", context);
    // [失败路径] version 会拼进缓存目录名，必须校验是否含路径分隔符；
    // 这里不能用 id 的正则，版本号允许点和加号（例如 0.11.1 与 0.11.1+abcd）。
    assertSafePathSegment(version, `${context}.version`);

    const sha256 = readRequiredString(rawComponent, "sha256", context).toLowerCase();
    // [失败路径] 强制小写后校验 64 位十六进制：大小写混写会让同一份内容产生两种
    // 目录名，内容寻址缓存会被拆成两份；长度不符则后续比对必然失败。
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(`[remote-assets] ${context}.sha256 is invalid`);
    }

    // [失败路径] artifactPath 与 mount 都来自清单，先归一化再使用：
    // 归一化会拒绝上跳片段，是路径穿越进入宿主文件系统的第一道闸（INV-12）。
    const artifactPath = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "artifactPath", context),
      `${context}.artifactPath`,
    );
    const mount = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "mount", context),
      `${context}.mount`,
    );
    const expectedMount = normalizeRemoteAssetRelativePath(
      mountRule.resolveExpectedMount(expectedPlatformArch),
      `expected mount for ${id}`,
    );
    // [失败路径] mount 必须与代码推导的期望值完全一致，而不是“只要在 releaseDir 内”：
    // 否则 CDN 内容可以把组件放到任意子目录，远端按固定路径 require 时找不到（INV-8）。
    if (mount !== expectedMount) {
      throw new Error(
        `[remote-assets] ${context}.mount mismatch for ${id}: expected=${expectedMount}, actual=${mount}`,
      );
    }

    components.push({
      id,
      version,
      sha256,
      artifactPath,
      mount,
    });
  }

  return {
    schemaVersion,
    appVersion,
    platformArch,
    components,
  };
}

// 组件缓存目录 = 缓存根 + 身份：
// [事务] 身份成对选择（sha256 / 语义版本）并集中在这里，是为了让“命中判断”“锁 key”
// “下载落点”三处永远算出同一个路径；任何一处自行拼接都会产生两套目录（INV-5）。
function resolveComponentCacheDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  return join(
    resolveComponentCacheRootDir(remoteCacheDir, component, platformArch),
    usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : resolveRemoteAssetComponentCacheVersion(component.version),
  );
}

// 内容寻址的身份判定是对外导出的：部署事务需要在“请求清单之前”就知道本次是否会
// 产生带 sha256 的目录名，从而决定是否必须刷新清单（INV-21）。
export function usesRemoteAssetContentAddressedCacheIdentity(componentId: string): boolean {
  return componentId in CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS;
}

// 把内容寻址组件映射成 release 目录名里的若干段（如 server-content/<sha256>）。
// [事务] 段的顺序由白名单表决定而不是由清单组件顺序决定：清单顺序变化不应改变
// 目录名，否则同一份内容会因发布脚本重排而生成新目录、反复全量下载（INV-6）。
function resolveContentAddressedReleaseSegments(
  components: readonly RemoteAssetManifestComponent[],
  requestedComponentIds: ReadonlySet<string> | null,
): string[] {
  const segments: string[] = [];
  for (const componentId of Object.keys(CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS)) {
    // 兼容历史全量 release：未指定组件时只沿用原有 GLM 内容目录；server
    // 安装始终显式请求 server-bundle，因此仍会进入独立 SHA release。
    // [权衡] 这是刻意的历史特例：若全量调用也把 server-content 段加入目录名，
    // 所有已部署机器会在升级后立刻换目录并全量重下，代价远大于收益。
    if (
      requestedComponentIds === null
        ? componentId !== "glm"
        : !requestedComponentIds.has(componentId)
    ) {
      continue;
    }
    const component = components.find((item) => item.id === componentId);
    const releaseDirName = CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS[componentId];
    if (component && releaseDirName) {
      segments.push(releaseDirName, component.sha256);
    }
  }
  return segments;
}

// 剥离版本号里的内容哈希后缀，得到“语义版本”作为非内容寻址组件的缓存键。
// [失败路径] 不剥离会让每次重发（hash 变化）都生成新目录，缓存命中率归零；
// 但剥离后必须仍靠 artifactPath/sha256 校验下载内容，否则同版本旧内容会被复用。
export function resolveRemoteAssetComponentCacheVersion(version: string): string {
  const contentHashPrefix = extractContentHashPrefixFromComponentVersion(version);
  if (!contentHashPrefix) {
    return version;
  }

  // 已发布 manifest 里的 component.version 仍是 vX+hash。
  // cache key 只看语义版本，因此在落盘目录层剥掉 hash；artifactPath/sha256 仍按 manifest 校验下载内容。
  return version.slice(0, -contentHashPrefix.length - 1);
}

// 缓存根的层级由 mountRule.platformScoped 决定：
// [权衡] 平台相关组件多一层 platformArch，是为了让原生二进制互不覆盖；
// 纯 JS 组件不插这层，可以在多平台共用同一份，减少重复下载与磁盘占用（INV-1）。
function resolveComponentCacheRootDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  const mountRule = REMOTE_COMPONENT_MOUNT_RULES[component.id];
  if (!mountRule) {
    throw new Error(`[remote-assets] component id is not in local whitelist: ${component.id}`);
  }
  return mountRule.platformScoped
    ? join(remoteCacheDir, "components", component.id, platformArch)
    : join(remoteCacheDir, "components", component.id);
}

function resolveRequiredComponentPaths(
  component: RemoteAssetManifestComponent,
  requiredReleasePaths: readonly string[],
): string[] {
  if (requiredReleasePaths.length === 0) {
    return [];
  }

  const mount = component.mount.replace(/\/+$/u, "");
  const requiredComponentPaths: string[] = [];
  for (const requiredReleasePath of requiredReleasePaths) {
    // [失败路径] 恰好等于 mount 的路径属于“组件目录本身”，不是组件内相对路径：
    // 把它当相对路径会得到空串，后续 stat 会指向组件根，任何目录都算“存在”。
    if (requiredReleasePath === mount) {
      continue;
    }
    // [失败路径] 用 `mount + "/"` 而不是 startsWith(mount)：后者会把
    // server-bundle-extra/... 误认成 server-bundle 的子路径，校验到错误的组件上。
    if (requiredReleasePath.startsWith(`${mount}/`)) {
      requiredComponentPaths.push(requiredReleasePath.slice(mount.length + 1));
    }
  }
  return requiredComponentPaths;
}

// 递归复制组件内容，同时承担“安全检查”职责：这是唯一遍历下载产物的地方。
// [资源] 跳过 ready 标记：它属于“目录级元数据”，被复制到新位置会让未完成目录
// 带上“已就绪”的假证据，与 INV-2 直接冲突。
async function materializeDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (READY_MARKER_CANDIDATES.includes(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    // [失败路径] 符号链接一律拒绝：归档可以携带指向任意路径的链接，
    // 复制时若按链接解析，会把宿主机上的任意文件带进 release 再上传（INV-11）。
    if (entry.isSymbolicLink()) {
      throw new Error(`[remote-assets] symlink is not allowed in component cache: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await materializeDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      // [资源] 逐文件 mkdir 而不是假定父目录已存在：tar 可以只含深层文件条目，
      // 不预先建父目录会在 link 时抛 ENOENT，错误信息还会指向无关路径。
      await mkdir(dirname(targetPath), { recursive: true });
      await linkOrCopyFile(sourcePath, targetPath);
      continue;
    }

    // [失败路径] 设备文件/FIFO/socket 等条目必须显式拒绝：复制它们可能阻塞读取
    // （FIFO）或产生不受控的设备访问，属于安全边界而不是功能缺失。
    throw new Error(`[remote-assets] unsupported component entry type: ${sourcePath}`);
  }
}

// 优先硬链接：同一分区上几乎零成本，且 release 与组件缓存共享同一份 inode。
// [失败路径] 跨分区（EXDEV）、权限受限（EPERM/EACCES）、链接数上限（EMLINK）时
// 退化为复制；其他错误必须抛出，否则“没链上也没复制”会被静默当成成功。
async function linkOrCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!shouldFallbackToCopy(error)) {
      throw error;
    }
  }
  // [事务] COPYFILE_EXCL 让目标已存在时直接失败：静默覆盖会掩盖并发写入，
  // 两个会话同时物化同一 mount 时，后到者应失败而不是把先到者的文件换掉。
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
}

// [权衡] 白名单而不是“所有 link 错误都复制”：ENOENT（源文件消失）说明缓存被并发
// 删除，此时复制同样会失败并掩盖真实原因；EMFILE 等资源耗尽也不应盲目降级。
function shouldFallbackToCopy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EMLINK";
}

// 路径穿越的最终防线：先归一化（拒绝上跳片段），再拼接并做“等于或位于其下”校验。
// [失败路径] 只做 startsWith(prefix) 不够：base 为 /a/b 时 /a/bc 也会通过，
// 因此必须比较 `base + sep`；这里两条分支都写出来，缺一不可（INV-12）。
function resolvePathWithinBase(baseDir: string, relativePath: string, label: string): string {
  const normalizedRelativePath = normalizeRemoteAssetRelativePath(relativePath, label);
  const targetPath = resolve(baseDir, ...normalizedRelativePath.split("/"));
  const normalizedBaseDir = resolve(baseDir);
  if (targetPath !== normalizedBaseDir && !targetPath.startsWith(`${normalizedBaseDir}${sep}`)) {
    throw new Error(`[remote-assets] ${label} escapes base dir: ${relativePath}`);
  }
  return targetPath;
}

// 原子提交：旧目录先改名为 backup，再把 staging 改名到目标，最后异步删 backup。
// [事务] 三步的顺序不可交换：先删旧目录会让窗口内目标不存在；先放新目录再删旧目录
// 在这套 API 下做不到（rename 到非空目录会失败），因此必须“让位 → 就位 → 清理”（INV-18）。
async function commitStagingDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true });

  const targetExists = await pathExists(targetDir);
  // [资源] backup 名带 pid + UUID：上一次提交异常退出留下的 backup 与本次不会重名，
  // 也就不会把“上一轮没删干净的备份”误当成本轮的回滚副本。
  const backupDir = targetExists ? `${targetDir}.backup-${process.pid}-${randomUUID()}` : null;

  if (backupDir) {
    await renameRemoteAssetDirectoryWithRetry(targetDir, backupDir);
  }

  try {
    await renameRemoteAssetDirectoryWithRetry(stagingDir, targetDir);
  } catch (error) {
    if (backupDir) {
      try {
        // [失败路径] 回滚失败必须把两个错误都抛出来：只报 commit 失败会让运维以为
        // 旧缓存还在，而实际上目标目录已经被改名成 backup，现场与日志不一致。
        await renameRemoteAssetDirectoryWithRetry(backupDir, targetDir);
      } catch (restoreError) {
        throw new Error(
          `[remote-assets] failed to commit staged directory and failed to restore backup: ` +
            `commit=${String(error)}, restore=${String(restoreError)}`,
        );
      }
    }
    throw error;
  }

  // [资源] backup 删除是 best-effort：删不掉不影响本次提交的正确性，
  // 但会因为异常而让调用方误判“提交失败”，所以这里吞掉并交给重试逻辑（INV-18）。
  if (backupDir) {
    await removeRemoteAssetDirectoryBestEffort(backupDir);
  }
}

// [失败路径] best-effort 的含义是“任何错误都不上抛”：它只用于清理备份与残留，
// 失败的唯一代价是磁盘残留，而把错误抛出去会让一次成功提交被报告成失败。
// 但重试只针对可重试错误，遇到 ENOENT 之类立即返回，避免无意义等待。
async function removeRemoteAssetDirectoryBestEffort(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        return;
      }
      await sleep(retryDelayMs);
    }
  }
}

// [并发] 重试次数由退避表长度决定，而不是固定的“最多 N 次”：两者分开写很容易
// 出现“次数与退避长度不一致”，重试到某个 attempt 时取到 undefined 而提前放弃。
async function renameRemoteAssetDirectoryWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        throw error;
      }

      // Windows 上 AppData remote-assets-cache 目录 rename 可能被 Defender、索引器
      // 或另一个刚退出的 host 进程短暂占用，表现为 EPERM/EBUSY/EACCES/ENOTEMPTY。
      // 提权不能释放这些文件句柄，因此这里对目录提交做有限退避重试，避免缓存已下载完成却连接 WSL 失败。
      // [权衡] 只对目录 rename 重试、不对删除重试到无穷：提交失败会让用户完全无法连接，
      // 而清理失败只留下可人工删除的残留，两者失败代价不对称。
      await sleep(retryDelayMs);
    }
  }
}

function isRetryableRemoteAssetDirectoryCommitError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

// [失败路径] stat 的任何错误都归为“不存在”，包括权限错误：调用方用它判断目录是否
// 可复用，把 EACCES 当成“存在”会让后续复制到该目录时抛出更难解释的错误。
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// 两层命中判断：先看目录级 ready 标记，再看调用方声明的关键路径。
// [事务] 两者必须同时满足：只有标记说明“目录曾提交完成”，只有路径说明“内容满足本次
// 需求”，任一缺失都可能是子集部署或历史残缺（INV-2）。
async function isReadyReleaseDirForRequestedPaths(
  releaseDir: string,
  platformArch: string,
  requiredReleasePaths: readonly string[],
): Promise<boolean> {
  if (!(await isReadyReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return (await findMissingLocalRelativePaths(releaseDir, requiredReleasePaths)).length === 0;
}

async function isReadyComponentDirForRequiredPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<boolean> {
  const missingPaths = await findMissingReadyComponentPaths(componentDir, requiredRelativePaths);
  return missingPaths?.length === 0;
}

// 返回 null 与空数组是两种不同语义，调用方必须区分：
// [失败路径] null 表示“目录本身没有 ready 标记”，需要下载；空数组表示“目录就绪且
// 路径齐全”，可以直接用。把 null 当空数组会让未完成目录被直接返回（INV-2）。
async function findMissingReadyComponentPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[] | null> {
  if (!(await isReadyComponentDir(componentDir))) {
    return null;
  }

  return findMissingLocalRelativePaths(componentDir, requiredRelativePaths);
}

async function findMissingLocalRelativePaths(
  baseDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const requiredRelativePath of requiredRelativePaths) {
    // [失败路径] 这里仍走 resolvePathWithinBase：requiredRelativePaths 可能来自上层
    // 配置而不是清单，允许上跳就能把“存在性检查”变成任意路径探测。
    const absolutePath = resolvePathWithinBase(
      baseDir,
      requiredRelativePath,
      "required cache path",
    );
    if (!(await pathExists(absolutePath))) {
      missingPaths.push(absolutePath);
    }
  }
  return missingPaths;
}

// 流式落盘：响应体直接写文件，避免把整个组件包读进内存。
// [资源] 用 pipeline 而不是手工 pump：pipeline 会在任一环节出错时销毁所有流，
// 手工写法在目标磁盘写满时容易只抛错误但留下未关闭的 writeStream（句柄泄漏）。
async function writeResponseBodyToFile(
  response: Response,
  targetPath: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  if (!response.body) {
    // [失败路径] 无 body 直接抛错而不是写空文件：空文件随后必然通不过 sha256，
    // 但错误会变成“校验失败”，掩盖真正的原因是服务端返回了空响应。
    throw new Error("response body is empty");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  // [资源] flags 显式用 "w"：默认同样会覆盖，但显式声明让“这里允许覆盖已存在的
  // staging 文件”成为可审计的意图，而不是依赖默认值。
  const output = createWriteStream(targetPath, { flags: "w" });
  const reportProgress = createRemoteAssetProgressReporter(
    parseContentLength(response.headers.get("content-length")),
    loggers,
  );
  let transferredBytes = 0;

  const byteMeter = new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      reportProgress(transferredBytes, false);
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    byteMeter,
    output,
  );
  reportProgress(transferredBytes, true);
}

// content-length 缺失或非法时返回 null，而不是 0：
// [失败路径] 返回 0 会让进度计算出现除零，并且把“未知总长”伪装成“总长为 0”，
// 日志里会显示 100% 却仍在下载，反而误导排障。
function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }

  const parsed = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

// 进度上报器是一个有状态的闭包：节流状态只属于一次下载，不能提升为模块级变量，
// 否则多个并发下载会互相覆盖 lastLoggedAt，表现为“有的下载一条进度都没有”。
function createRemoteAssetProgressReporter(
  totalBytes: number | null,
  loggers: RemoteAssetCacheLoggers | undefined,
): (transferredBytes: number, force: boolean) => void {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let lastLoggedPercent = 0;
  let lastLoggedTransferredBytes = -1;

  return (transferredBytes: number, force: boolean) => {
    if (!loggers) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.max((now - startedAt) / 1_000, 0.001);
    const speedMBPerSecond = bytesToMB(transferredBytes) / elapsedSeconds;
    const transferredMB = bytesToMB(transferredBytes);
    const totalMB = totalBytes ? bytesToMB(totalBytes) : null;
    const percent = totalBytes ? Math.min((transferredBytes / totalBytes) * 100, 100) : null;

    const byInterval = now - lastLoggedAt >= REMOTE_ASSET_PROGRESS_INTERVAL_MS;
    const byPercent =
      percent != null && percent - lastLoggedPercent >= REMOTE_ASSET_PROGRESS_PERCENT_STEP;
    const reachedEnd = percent != null && percent >= 100;

    // [权衡] 三个条件取或：只按时间会让慢速链路长时间停在同一个百分比上不刷新，
    // 只按百分比又会在超大文件上频繁刷屏；100% 单独列出保证收尾一定有一条完整记录。
    if (!force && !byInterval && !byPercent && !reachedEnd) {
      return;
    }
    // [失败路径] 收尾调用（force）可能发生在零字节或没有新进展时：
    // 若与上一条完全相同就不再打印，避免日志里出现两条一模一样的 100%。
    if (
      force &&
      transferredBytes === lastLoggedTransferredBytes &&
      (percent == null || percent <= lastLoggedPercent)
    ) {
      return;
    }

    // 之前生产态下载阶段只打印 "downloading URL"，慢网用户无法判断是否卡死。
    // 这里改成输出节流后的进度快照（百分比/MB/速度），让 SSH 连接日志可观测下载进展。
    if (totalMB != null && percent != null) {
      loggers.log(
        `[remote-assets] download progress: ${percent.toFixed(1)}% (${transferredMB.toFixed(1)}/${totalMB.toFixed(1)} MB, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    } else {
      loggers.log(
        `[remote-assets] download progress: ${transferredMB.toFixed(1)} MB (total unknown, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    }

    lastLoggedAt = now;
    lastLoggedTransferredBytes = transferredBytes;
    if (percent != null) {
      lastLoggedPercent = percent;
    }
  };
}

function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

// [权衡] 版本号里的 hash 只取后端一段且下限 12 位：太短会与正常版本尾号混淆，
// 太长则旧清单可能只记录了截断前缀，比对永远失败。上限 64 位对应完整 sha256。
function extractContentHashPrefixFromComponentVersion(version: string): string | null {
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return null;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/u.test(suffix) ? suffix : null;
}

async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isDirectory();
  } catch {
    return false;
  }
}

// 内容哈希是“旧目录能否迁移”的判据，因此必须覆盖结构而不只是文件内容：
// [事务] 把根类型、相对路径、权限位与大小都喂进哈希，才能让“路径改名但内容相同”的
// 目录被识别为不同内容，避免迁移把结构错误的旧目录当成等价物。
async function computePathContentSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const pathStat = await stat(path);

  if (pathStat.isDirectory()) {
    hash.update("root:dir\n");
    await hashDirectoryContent(hash, path);
  } else if (pathStat.isFile()) {
    hash.update("root:file\n");
    await hashFileContent(hash, path, "root-file");
  } else {
    throw new Error(`unsupported path type: ${path}`);
  }

  return hash.digest("hex");
}

async function hashDirectoryContent(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = "",
): Promise<void> {
  // [事务] 目录项必须排序后再遍历：readdir 返回顺序依赖文件系统，不排序会让同一份
  // 内容在不同机器算出不同哈希，迁移判据随机器而变。
  const entries = (await readdir(rootDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dirStat = await stat(entryPath);
      hash.update(`dir:${entryRelativePath}:${dirStat.mode & 0o777}\n`);
      await hashDirectoryContent(hash, entryPath, entryRelativePath);
      continue;
    }
    if (entry.isFile()) {
      await hashFileContent(hash, entryPath, entryRelativePath);
      continue;
    }

    // [失败路径] 目录内容哈希遇到链接或设备文件直接抛错：静默跳过会让不同结构的目录
    // 算出相同哈希，迁移就会把不可用的旧目录判定为等价内容。
    throw new Error(`unsupported entry type: ${entryPath}`);
  }
}

async function hashFileContent(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  // [资源] 元数据先入哈希、内容流式追加：不读入内存，避免对超大二进制做整体 buffer；
  // 但大小与权限位必须在读内容前写入，保证哈希顺序与文件遍历顺序严格一致。
  const fileStat = await stat(filePath);
  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

// [失败路径] 只判断“目录项数量为 0”：归档里可能存在空目录条目，此时条目数为 1
// 但没有任何文件；这类内容仍会被后续的 isValidReleaseDir 拦下，避免在这里做
// 全量遍历（对超大组件是明显的启动开销）。
async function assertExtractedArchiveNotEmpty(
  extractRoot: string,
  errorMessage: string,
): Promise<void> {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error(errorMessage);
  }
}

// release 级就绪 = 结构有效 + ready 标记存在。
// [事务] 两者缺一不可：只有标记说明“提交完成过”，只有结构说明“内容确实齐全”；
// 历史上有目录因中途失败留下部分内容却已带标记的情况（INV-2）。
async function isReadyReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  if (!(await isValidReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return hasReadyMarker(releaseDir);
}

// 结构自检只验证“远端启动必需的极小集合”，不做全量清单比对：
// [权衡] 全量比对需要遍历所有文件，在已经是热路径的连接建立阶段开销过大；
// 而缺少 server 入口或 node runtime 恰好是“目录看似完整但完全不可用”的典型形态。
async function isValidReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  try {
    const dirStat = await stat(releaseDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  if (!(await fileExists(releaseDir, "server", "zcode-server.cjs"))) {
    return false;
  }

  // 分平台归档落地后，继续硬编码校验 linux 目录会把 darwin 包误判为无效。
  // 这里改成按目标 platformArch 校验 node runtime，确保 cache 判断与下载策略一致。
  // [失败路径] 这里不能用 isDirectoryPath 之类的“存在即可”判断：可执行位缺失
  // 会让远端 spawn 失败，而目录仍被判定为就绪。
  if (!(await fileExists(releaseDir, "node", platformArch, "node"))) {
    return false;
  }

  return true;
}

// [事务] 组件目录的就绪只需要标记：组件内容已在下载阶段做过 sha256 校验，
// 再逐文件校验等于重复付出一次完整哈希成本，收益极低。
async function isReadyComponentDir(componentDir: string): Promise<boolean> {
  try {
    const dirStat = await stat(componentDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return hasReadyMarker(componentDir);
}

// [权衡] 按候选顺序探测而不是只查新名：历史目录只有旧名，只查新名会让升级后的
// 首次连接触发全量重下；反过来只写新名则保证未来可以安全下线旧名（INV-19）。
async function hasReadyMarker(baseDir: string): Promise<boolean> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    if (await fileExists(baseDir, readyMarker)) {
      return true;
    }
  }
  return false;
}

// [事务] 标记内容写入时间戳：它只是“目录在何时提交”的旁证，读取方不依赖其格式，
// 因此修改内容不会破坏兼容性，但必须保持“先写内容再写标记”的顺序。
async function writeReadyMarker(baseDir: string, markerFileName: string): Promise<void> {
  await writeFile(join(baseDir, markerFileName), `${Date.now()}\n`, "utf8");
}

// 对外读取标记：任一名命中即返回其内容，全部缺失返回 null。
// [失败路径] 这里吞掉所有读错误（包括权限问题），因为调用方只用它做“是否已有缓存”
// 的展示性判断；把权限错误抛出会让设置页因为一个统计字段而整体报错。
export async function readCachedRemoteAssetMarker(cacheDir: string): Promise<string | null> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    const markerPath = join(cacheDir, readyMarker);
    try {
      return await readFile(markerPath, "utf8");
    } catch {
      // continue
    }
  }
  return null;
}

// 回退目录放在系统临时目录：当用户配置的缓存目录不可写时，仍要能落一份可用缓存。
// [权衡] 临时目录可能被系统清理，因此它只作为回退而不是默认；用固定子目录名
// 是为了让多个进程共享同一份回退缓存，而不是每次启动都重新下载。
export function resolveFallbackRemoteAssetCacheDir(): string {
  return join(tmpdir(), "zcode-remote-assets-cache");
}

// [失败路径] 必须排除数组：typeof [] === "object"，若不排除，数组也能通过这里的
// 类型守卫，随后 readRequiredString 会报“字段缺失”，掩盖真正的形状错误。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [失败路径] 空串在路径语境下与缺失等价，但错误类型不同（类型错 vs 值为空），
// 分开报错能让清单作者直接看出是“忘了填”还是“填错了类型”。
function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const fieldValue = value[key];
  if (typeof fieldValue !== "string") {
    throw new Error(`[remote-assets] ${context}.${key} must be string`);
  }
  const trimmed = fieldValue.trim();
  if (!trimmed) {
    throw new Error(`[remote-assets] ${context}.${key} is empty`);
  }
  return trimmed;
}

// [失败路径] 只接受有限数：NaN/Infinity 能通过 typeof === "number"，
// 但它们进入目录名或校验后会产生 "NaN" 这样的路径段，问题会漂移到更晚的阶段。
function readRequiredNumber(value: Record<string, unknown>, key: string, context: string): number {
  const fieldValue = value[key];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`[remote-assets] ${context}.${key} must be finite number`);
  }
  return fieldValue;
}

// 单个路径段的最后一道校验：同时覆盖三种逃逸方式。
// [失败路径] 三种都必须拒绝：分隔符（跨目录）、"."/".."（上跳）、空串（拼出父目录）。
// 只查 ".." 会漏掉 Windows 反斜杠，只查分隔符会漏掉 "."/".." 本身。
function assertSafePathSegment(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`[remote-assets] ${label} is empty`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`[remote-assets] ${label} must be a single path segment: ${value}`);
  }
  if (value === "." || value === "..") {
    throw new Error(`[remote-assets] ${label} is invalid: ${value}`);
  }
}
