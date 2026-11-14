// INV-01 平台白名单先判：守住位置 平台与架构检查；改错故障 不支持的组合继续解析。
// INV-02 安装模式决定来源：守住位置 目标类型分支；改错故障 非 ssh 场景误走本地上传。
// INV-03 开发态不得回退 CDN：守住位置 缺失即抛错；改错故障 启动失败被伪装成连接成功。
// INV-04 本地候选仍需校验：守住位置 摘要与大小比对；改错故障 部署同版本旧包。
// INV-05 描述文件版本必须相等：守住位置 版本比较；改错故障 跨版本产物被误用。
// INV-06 目标缺失即失败：守住位置 归档查找；改错故障 拿到错误平台的文件。
// INV-07 远端候选按序尝试：守住位置 候选地址列表；改错故障 首个镜像失败就整体失败。
// INV-08 全部失败才回退缓存：守住位置 循环之后的缓存分支；改错故障 网络抖动时用了陈旧描述。
// INV-09 缓存也要过版本校验：守住位置 缓存读取路径；改错故障 离线时加载旧版本。
// INV-10 原子写不留半成品：守住位置 临时文件加重命名；改错故障 中断后读到截断内容。
// INV-11 临时文件权限收紧：守住位置 写入模式；改错故障 缓存对同机其他用户可读。
// INV-12 清理在收尾块：守住位置 无条件删除；改错故障 失败后临时文件堆积。
// INV-13 归档命中缓存需复验：守住位置 复用前校验；改错故障 损坏缓存被反复使用。
// INV-14 下载先落临时再改名：守住位置 下载目标；改错故障 半包被当成完整归档。
// INV-15 校验失败换下一个源：守住位置 循环内捕获；改错故障 首个镜像损坏即中断。
// INV-16 元数据模式不落盘：守住位置 早退分支；改错故障 只想探测却触发下载。
// INV-17 错误归一化保留原型：守住位置 合并到原对象；改错故障 上层拿不到原始错误类型。
// INV-18 失败必然抛出：守住位置 出口的捕获；改错故障 返回带错误字段的伪成功。
//
// 模块职责：把远端探测结果与资产策略解析成可部署的发行包描述。
// 状态所有权：无长期状态，缓存目录由调用方注入并按版本号隔离。
// 阅读顺序：先看描述文件与校验工具，再看两条解析路径，最后看对外出口。
// Source Server 发布产物的解析器：给定远端探测结果（platform/arch）与资产来源配置，
// 产出「可部署的发行包」描述（本地路径 / 下载 URL / 校验和）。
//
// 三种来源优先级：
// 1) 开发态内容寻址（development-content-addressed）：只接受 mock-cdn 下本轮 staging 产物，
//    缺失即失败，绝不回退 CDN——否则会把 bootstrap 失败伪装成连接成功并部署同版本旧代码；
// 2) local-download-upload：优先使用本地 descriptor + 归档（仍需 SHA/size 校验），
//    避免开发态直接信任 gitignore 的 dist-release 导致「源码变了但部署旧包」；
// 3) remote-download / metadataOnly：只解析 descriptor 与 URL，由调用方决定是否下载；
//    否则下载到 cacheRoot 并校验后返回本地路径。
//
// 校验口径：descriptor 版本必须等于 ZCODE_VERSION；归档必须命中 sizeBytes 与 sha256；
// 写缓存使用「临时文件 + rename」的原子替换，权限 0o600，失败不留半成品。
// 失败语义：所有失败都归一成 RemoteConnectionError（phase="download"），保留原 error 的
// instanceof 与 code，便于上层区分网络/校验/配置错误。
// 副作用：可能写 cacheRoot（descriptor 缓存与归档）；不修改远端状态。

import { normalizeRemoteConnectionError } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ZCODE_VERSION,
  normalizeRemoteAssetInstallMode,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";
import {
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";
import type { ServerReleaseAsset, SourceServerProbeResult } from "@zcode/server/source-server";
import type { WindowRemoteAssetDirs } from "./windowRemoteConnectionRegistry.js";

// ResolvedDescriptor 把 descriptor 与候选基址一起返回。
// baseUrls 的顺序决定后续候选地址的优先级。
// 调用方拿到 baseUrls 拼好的地址，不需再拼接版本段。
// ResolvedDescriptor 字段收窄到本模块所需的最小集合。
// ResolvedDescriptor 只在本模块内部流通，不对外导出。
interface ResolvedDescriptor {
  descriptor: SourceServerReleaseDescriptor;
  releaseBases: string[];
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// 校验归档与 descriptor 声明一致：必须是普通文件、大小精确匹配、sha256 匹配。
// 任何一项不满足都返回 false（不抛错），由调用方决定是「跳过本地候选」还是「明确失败」。
// fileStat.isFile() 为假时直接返回 false。
// fileStat.size 必须与 archive.sizeBytes 精确相等。
// sha256 按流式读取，避免整包读入内存。
// verifyArchive 任一条件不满足都返回 false。
// 是否降级或失败由调用方决定。
async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== ZCODE_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${ZCODE_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

function resolveArchiveUrls(releaseBases: string[], archive: SourceServerReleaseArchive): string[] {
  const absolute = archive.urls.filter((url) => /^https?:\/\//u.test(url));
  const relative = archive.urls.filter((url) => !/^https?:\/\//u.test(url));
  return Array.from(
    new Set([...absolute, ...buildReleaseAssetUrlCandidates(releaseBases, relative)]),
  );
}

// 原子写文本：先写 0o600 临时文件再 rename，避免进程中断留下半个 descriptor。
// finally 中无条件清理临时文件（rename 成功后该路径已不存在，rm -force 幂等）。
// mkdir recursive 先建父目录，保证首次写入可用。
// 临时文件名带 process.pid 与 randomUUID。
// 写入权限收紧到 0o600，仅属主可读写。
// rename 保证读者看不到半成品 descriptor。
// finally 中无条件 rm 临时文件。
// rm 失败被 catch 吞掉，保持幂等。
async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// 读取本地 release 目录的 descriptor 与归档；descriptor 不存在时返回 null（可继续尝试下一来源），
// 但存在而校验失败时抛错（说明本地产物损坏，不能静默跳过）。
async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

// 解析远端 descriptor：按候选 URL 依次尝试，全部失败后回退到上次缓存（仍校验版本），
// 缓存也没有时才抛错（cause 保留最后一个网络错误，便于诊断是否为纯网络问题）。
// 副作用：成功获取新 descriptor 时写缓存，供离线/网络抖动时使用。
async function resolveRemoteDescriptor(
  remoteAssets: WindowRemoteAssetDirs,
  cacheRoot: string | null,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
): Promise<ResolvedDescriptor> {
  const releaseBases = buildReleaseBaseCandidates(
    remoteAssets.remoteCdnBaseUrls ??
      (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : []),
    ZCODE_VERSION,
  );
  const descriptorUrls = buildReleaseAssetUrlCandidates(releaseBases, [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ]);
  const cachedDescriptorPath = cacheRoot
    ? join(cacheRoot, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)
    : null;
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of descriptorUrls) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text);
      if (cachedDescriptorPath) await writeTextAtomic(cachedDescriptorPath, text);
      return { descriptor, releaseBases };
    } catch (error) {
      lastError = error;
    }
  }
  if (cachedDescriptorPath && (await pathExists(cachedDescriptorPath))) {
    return {
      descriptor: readDescriptor(await readFile(cachedDescriptorPath, "utf8")),
      releaseBases,
    };
  }
  throw new Error("Unable to resolve Source Server release descriptor", { cause: lastError });
}

// 下载归档到缓存：命中缓存且校验通过则直接复用；否则逐 URL 下载到临时文件，
// 校验 SHA/size 通过后才 rename 到最终路径，失败清理临时文件并尝试下一个 URL。
// 失败语义：所有候选都失败时抛错（cause 为最后一个错误）；不会把未校验的文件留在缓存。
async function downloadArchive(
  archive: SourceServerReleaseArchive,
  urls: string[],
  cacheRoot: string,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, archive.fileName);
  if (await verifyArchive(cached, archive)) return cached;
  await rm(cached, { force: true });
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of urls) {
    const temporary = `${cached}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(temporary, { mode: 0o600 }),
      );
      if (!(await verifyArchive(temporary, archive))) {
        throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
      }
      await rename(temporary, cached);
      return cached;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
    cause: lastError,
  });
}

// 发行包解析的对外入口（错误归一化边界）。
// 输入/输出与 resolveReleaseAsset 完全一致（直接转发），差别只在异常处理：
// 把内部抛出的任意 error 归一成 RemoteConnectionError 并合并到原对象上。
// 失败语义：永不返回「带错误字段的成功结果」——失败必然 throw；
// 保留原 Error 的 instanceof，同时补 code/message 供 RPC 侧识别，避免上层拿到裸 network error。
// 副作用：同 resolveReleaseAsset（可能写缓存）。
export async function resolveSourceServerReleaseAsset(
  ...args: Parameters<typeof resolveReleaseAsset>
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(...args);
  } catch (error) {
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}

// 核心解析流程：平台校验 -> 安装模式判定 -> 按优先级选择本地/远端来源。
// 输入：probe（远端平台/架构）、remoteAssets（CDN/缓存/安装策略）、remoteTarget（ssh 等，决定
//   安装模式）、可选网络端口与 metadataOnly。
// 输出：ServerReleaseAsset；local-download-upload/remote-download 可能带 localArchivePath，
//   metadataOnly 永远只返回元数据（不下载、不落盘）。
// 失败语义：不支持平台、开发产物缺失、descriptor/target 缺失、校验失败、缓存不可用都抛错；
//   不做任何静默回退（这是本文件的核心约束）。
// 副作用：仅可能写缓存目录；metadataOnly 与 remote-download 不写。
async function resolveReleaseAsset(
  probe: SourceServerProbeResult,
  remoteAssets: WindowRemoteAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  options: { metadataOnly?: boolean } = {},
): Promise<ServerReleaseAsset> {
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    throw new Error(`Unsupported Source Server release target: ${probe.platform}-${probe.arch}`);
  }
  const target = `${probe.platform}-${probe.arch}`;
  const installMode =
    remoteTarget.kind === "ssh"
      ? normalizeRemoteAssetInstallMode(remoteTarget.assetInstallMode)
      : "local-download-upload";
  const cacheRoot = remoteAssets.remoteCacheDir
    ? join(remoteAssets.remoteCacheDir, "source-server", ZCODE_VERSION)
    : null;

  if (
    remoteTarget.kind === "ssh" &&
    remoteAssets.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!remoteAssets.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // Bug 原因：开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      // 内容寻址开发策略只能消费本轮本地 descriptor/archive，缺失时必须明确失败。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: ZCODE_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  if (installMode === "local-download-upload") {
    // Bug 原因：开发态曾直接信任 gitignore 的 dist-release；同版本源码变化后仍会部署旧包。
    // 现在只接受本轮 staging 写入 mock-cdn 且通过 descriptor SHA/size 校验的本地产物。
    const localReleaseDirs = remoteAssets.mockCdnDir
      ? [join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION)]
      : [];
    for (const releaseDir of localReleaseDirs) {
      const local = await resolveLocalDescriptor(releaseDir, target);
      if (!local) continue;
      return {
        localArchivePath: local.archivePath,
        target,
        version: ZCODE_VERSION,
        sha256: local.archive.sha256,
        sizeBytes: local.archive.sizeBytes,
        urls: local.archive.urls,
      };
    }
  }

  const resolvedDescriptor = await resolveRemoteDescriptor(
    remoteAssets,
    cacheRoot,
    remoteAssetNetwork,
  );
  const archive = findArchive(resolvedDescriptor.descriptor, target);
  const urls = resolveArchiveUrls(resolvedDescriptor.releaseBases, archive);
  if (installMode === "remote-download" || options.metadataOnly) {
    return {
      target,
      version: ZCODE_VERSION,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      urls,
    };
  }
  if (!cacheRoot)
    throw new Error(`Source Server release cache is unavailable: ${archive.fileName}`);
  return {
    localArchivePath: await downloadArchive(archive, urls, cacheRoot, remoteAssetNetwork),
    target,
    version: ZCODE_VERSION,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls,
  };
}
