// 文件定位：plugin 跨机同步（本机归档 -> 远端落盘）的唯一编排点。
// 边界：负责「扫描候选、生成归档、解包判重、落盘、回写 CLI config」；
// 归档字节格式见 pluginSyncArchive，路径收敛原语见 pluginSyncPath。
// INV-01：凡以落盘/删除为终点的目标路径，必须经 resolvePluginSyncPathWithin 收敛在受控根内
//         （守住它的位置：listRemoteUserPluginStatuses、importPluginsArchive、importMarketplaceSourceArchiveInternal）；
//         破坏后果：directoryName 来自远端归档 metadata 而不可信，越界值会让 cp/rm 作用到主目录其他位置。
// INV-02：导入必须在 staging 拷贝之后、rename 之前重做一次「目标已存在」判定
//         （守住它的位置：importPluginsArchive 的两个 existsSync 分支）；
//         破坏后果：两次判定之间的窗口里他人抢先落盘时，rename 会覆盖其目录，插件文件被静默替换。
// INV-03：config 回写失败必须回滚本次新建的目标目录（守住它的位置：addPluginDirToUserConfig 的 catch）；
//         破坏后果：目录存在但 dirs 未登记，重试被 samePluginId 判为已同步而永久跳过，插件对 Agent 不可见。
// INV-04：正式路径只由 staging 目录 rename 而来，绝不直接 cp 到正式目录（守住它的位置：importPluginsArchive）；
//         破坏后果：cp 中途失败会在正式路径留下半写目录，下次导入因 targetExists 跳过，内容与 metadata 长期不一致。
// INV-05：判重先用 pluginId 归一化小写键，路径存在性只作第二判据（守住它的位置：listRemoteUserPluginStatuses）；
//         破坏后果：同一插件以不同目录名存在时重复安装，runtime 同时加载两份并互相覆盖能力注册。
// INV-06：归档体积在「打包前估算」与「打包后实测」两处都校验（守住它的位置：exportPluginsArchive、exportMarketplaceSourceArchive）；
//         破坏后果：只校验估算值时，硬链接与归档元数据会让实际字节超限，远端写入被截断。
// INV-07：镜像 manifest 的 pluginRoot 只写 metadata 层，不写顶层（守住它的位置：buildMirroredMarketplaceManifest）；
//         破坏后果：agent 按顶层 pluginRoot 把 ./hello-world 解析到市场根，镜像内所有插件源失效。
// INV-08：临时解包目录一律在 finally 中删除（守住它的位置：importPluginsArchive、importMarketplaceSourceArchiveInternal）；
//         破坏后果：失败重试会在 tmpdir 累积完整插件副本，磁盘持续增长且可能被后续扫描误认。
/* eslint-disable max-lines -- plugin 同步需要集中维护候选扫描、归档安全、远端判重和配置写入，拆分会增加远端同步回归面。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  PluginSyncCandidate,
  PluginSyncComponentType,
  PluginSyncImportResult,
  PluginSyncRemoteStatus,
} from "@zcode/shared";
import type { IPluginSyncService } from "./pluginSync.js";
import {
  createPluginSyncArchive,
  extractPluginSyncArchive,
  PLUGIN_SYNC_METADATA_ARCHIVE_PATH,
  type PluginSyncArchiveMetadata,
} from "./pluginSyncArchive.js";
import { normalizePluginSyncRelativePath, resolvePluginSyncPathWithin } from "./pluginSyncPath.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";

interface PluginManifestInfo {
  name: string;
  pluginId: string;
  description?: string;
  version?: string;
  componentTypes: PluginSyncComponentType[];
}

interface UserPluginConfigState {
  dirs: string[];
  enabledOverrides: Map<string, boolean>;
}

interface MarketplaceManifestInfo {
  name: string;
  description?: string;
  pluginRoot?: string;
  plugins: MarketplacePluginEntryInfo[];
  raw: Record<string, unknown>;
}

interface MarketplacePluginEntryInfo {
  name: string;
  dependencies: string[];
  raw: Record<string, unknown>;
  source?: unknown;
}

interface MarketplaceSourceLoadResult {
  manifest: MarketplaceManifestInfo;
  sourceRoot?: string;
}

interface MarketplaceSourceMirrorEntry {
  entry: MarketplacePluginEntryInfo;
  mirroredSourcePath?: string;
  mirroredSourceRelativePath?: string;
}

const INLINE_PLUGIN_MARKETPLACE = "inline";
const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const USER_CONFIG_FILE_MODE = 0o600;
const MARKETPLACE_SOURCE_ROOT_DIRECTORY = "marketplace-sources";
const MIRRORED_MARKETPLACE_PLUGIN_ROOT = "plugins";
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  [".zcode-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".codex-plugin", "plugin.json"],
] as const;

// 工厂只注入 maxArchiveBytes 一个参数：上限是安全参数而非业务状态，作为实例字段
// 可让测试用小上限分别覆盖估算、实测、导入三处校验，而不必构造 50MB 夹具。
// [权衡] 不把扫描函数挂成方法：候选扫描本身无状态，挂到实例上会掩盖「config.json 被多处各读一遍」的事实。
export function createPluginSyncService(options?: {
  maxArchiveBytes?: number;
}): IPluginSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
// 候选与上限一起返回，调用方（RPC/UI）可提前拦截超大打包，
// 避免用户选完几十个插件后才发现整批不可导出。
    async listLocalUserPluginCandidates() {
      return {
        candidates: await collectLocalUserPluginCandidates(),
        maxArchiveBytes,
      };
    },
// 远端判重：目标路径存在或同 pluginId 已登记即标记 exists。
// [并发] 本函数只读文件系统与 config，不做落盘；其结论与真正导入之间存在竞态，
// 因此 importPluginsArchive 必须重做判定（INV-02），不能信任这里的结果。
    async listRemoteUserPluginStatuses(params) {
      const targetRoot = getUserZcodePluginRoot();
      const existingPluginPathById = await collectConfiguredInlinePluginPathById();
      return {
// 判定顺序有意义：先看目标目录是否已落盘（最确定），再按 pluginId 回查本机目录
// （目录名可能与远端不同），两者都未命中才算可同步。
// [失败路径] 判重分两级：先看目标路径是否存在（existsSync 吞掉权限错误而返回 false），
// 再按 pluginId 归一化小写键回查本机已登记目录；无读权限的目录只会落到后续 cp 的 EACCES。
        statuses: params.plugins.map((plugin): PluginSyncRemoteStatus => {
          const directoryName = normalizePluginSyncRelativePath(plugin.directoryName);
          const pluginId = normalizePluginId(plugin.pluginId);
          const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
          if (existsSync(targetPath)) {
            return {
              pluginId,
              directoryName,
              exists: true,
              path: targetPath,
              reason: "targetExists",
            };
          }
          const existingPath = existingPluginPathById.get(normalizePluginIdKey(pluginId));
          return existingPath
            ? {
                pluginId,
                directoryName,
                exists: true,
                path: existingPath,
                reason: "samePluginId",
              }
            : { pluginId, directoryName, exists: false };
        }),
      };
    },
// 只接受调用方显式选中的 id，并在此重扫一次候选：候选集合必须是当前磁盘快照，
// 否则 config 里已删除的 dir 会被打进归档。
    async exportPluginsArchive(params) {
      const candidates = await collectLocalUserPluginCandidates();
// [失败路径] 找不到 id 直接抛错而不是跳过：导出是用户对「这 N 个插件」的承诺，
// 静默丢弃会让远端少装且无提示，比整批失败更难排查。
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = params.pluginIds.map((id) => {
        const candidate = candidateById.get(id);
        if (!candidate) {
          throw new Error(`plugin sync candidate not found: ${id}`);
        }
        return candidate;
      });
// 打包前估算拦截（INV-06 第一处）：只统计文件 size，不含归档头与压缩开销，
// 因此是下界；真正的保证仍依赖打包后的 byteLength 实测。
      const selectedBytes = selected.reduce((total, candidate) => total + candidate.sizeBytes, 0);
      if (selectedBytes > maxArchiveBytes) {
        throw new Error(`plugin sync archive exceeds limit: ${selectedBytes}/${maxArchiveBytes}`);
      }
      const archive = await createPluginSyncArchive({
        entries: await Promise.all(
          selected.map(async (candidate) => ({
// 归档内路径统一用 candidate.directoryName：同一插件在不同机器上目录名可能不同，
// 远端按归档内路径展开，才能复用本端已去重、已净化的安全名。
            sourcePath: await realpath(candidate.path),
            archivePath: candidate.directoryName,
          })),
        ),
        metadata: {
          plugins: selected.map((candidate) => ({
            name: candidate.name,
            pluginId: candidate.pluginId,
            directoryName: candidate.directoryName,
            ...(candidate.enabledOverride !== undefined
              ? { enabled: candidate.enabledOverride }
              : {}),
          })),
        },
      });
// 打包后实测（INV-06 第二处）：硬链接、稀疏文件与元数据都会让实际字节偏离估算，
// 只有这一次校验能保证发往远端的字节确实不超限。
      if (archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return {
        archive,
        archiveBytes: archive.byteLength,
        plugins: selected.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName: candidate.directoryName,
          ...(candidate.enabledOverride !== undefined
            ? { enabled: candidate.enabledOverride }
            : {}),
        })),
      };
    },
// marketplace 源归档与插件归档共用同一上限：两者走同一条 SSH 通道，
// 分开配置只会让上限失去意义。
    async exportMarketplaceSourceArchive(params) {
      const result = await exportMarketplaceSourceArchiveInternal(params, maxArchiveBytes);
      if (result.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${result.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return result;
    },
// 导入入口先拒绝 overwrite：覆盖语义需要「先删后写」的两阶段提交，
// 当前没有事务，贸然支持会在覆盖中途失败时留下新旧混合目录。
    async importPluginsArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin sync overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
// [资源] 传原始 Uint8Array 而非落盘文件：解包在 tmpdir 一次展开，
// 调用方无需管理临时文件，清理责任收敛到内部 finally（INV-08）。
      return await importPluginsArchive(params.archive, maxArchiveBytes);
    },
// 同时探测插件根与 config 目录：同步两端都会写（目录 + dirs 登记），
// 只探一个会在导入成功一半后才暴露权限问题。
    async checkRemoteUserPluginWriteAccess() {
      return checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodePluginRoot(),
        dirname(getUserZcodeConfigPath()),
      ]);
    },
// 同样拒绝 overwrite：marketplace 目录名带内容指纹，内容变化自然换目录，
// 不存在需要覆盖同一路径的场景。
    async importMarketplaceSourceArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin marketplace source overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return await importMarketplaceSourceArchiveInternal(params.archive, maxArchiveBytes);
    },
  };
}

// HOME 优先于 USERPROFILE：SSH 远端常只设 HOME，而 Windows 本机两者可能同时存在
// 且指向不同卷，取 HOME 才与远端路径语义一致。
function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

// config 与 plugin 根必须从同一个 home 派生：分别解析会在环境变量被修改的进程里
// 指向不同目录，出现「目录已写、config 写到别处」的半同步。
function getUserZcodeConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

function getUserZcodePluginRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "plugins");
}

// 候选 = config.dirs 中「有合法 plugin manifest」的目录。无 manifest 的目录静默跳过：
// dirs 允许手填任意路径，把杂项目录当错误上报会淹没真正的问题。
async function collectLocalUserPluginCandidates(): Promise<PluginSyncCandidate[]> {
  const config = await readUserPluginConfigState();
  const candidates: PluginSyncCandidate[] = [];
// [权衡] 去重键用 realpath：同一插件常以软链与真实路径同时登记，只比字符串会让同一批文件
// 被算两次体积并列出两个候选，用户无法分辨该选哪个。
  const seenRealpaths = new Set<string>();
  const usedDirectoryNames = new Set<string>();

  for (const rawDir of config.dirs) {
    const pluginRoot = resolve(rawDir);
    const canonicalRoot = await realpath(pluginRoot).catch(() => pluginRoot);
// realpath 失败时回退原路径（上一行 catch）：断链仍需保留候选，让 computeRecursiveSize
// 报出具体错误，而不是静默丢弃用户显式登记的目录。
    if (seenRealpaths.has(canonicalRoot)) {
      continue;
    }
    seenRealpaths.add(canonicalRoot);
    const manifest = await readPluginManifestInfo(canonicalRoot);
    if (!manifest) {
      continue;
    }
// 启用状态来自 CLI config 的 enabledPlugins，缺失默认 true（与 CLI 解析一致）；
// enabledOverride 只在用户显式设置时携带，远端据此区分「沿用默认」与「显式开启」。
    const enabledOverride = config.enabledOverrides.get(normalizePluginIdKey(manifest.pluginId));
    const directoryName = createUniqueDirectoryName(
      basename(canonicalRoot),
      manifest.name,
      canonicalRoot,
      usedDirectoryNames,
    );
    candidates.push({
      id: createCandidateId(manifest.pluginId, canonicalRoot),
      name: manifest.name,
      pluginId: manifest.pluginId,
      directoryName,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      path: canonicalRoot,
// [资源] sizeBytes 在候选阶段用 computeRecursiveSize 算一次：列表展示与导出估算共用，避免两次遍历大目录。
// 若两次各遍历一遍大目录，导出响应会明显变慢。
      sizeBytes: await computeRecursiveSize(canonicalRoot),
      enabled: enabledOverride ?? true,
      ...(enabledOverride !== undefined ? { enabledOverride } : {}),
      componentTypes: manifest.componentTypes,
    });
  }

// 按显示名排序而非目录名：面板按 name 展示，服务端顺序即 UI 顺序，
// 避免每次刷新顺序抖动导致误选。
  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

// marketplace 导出核心：把「选中插件 + 依赖闭包」的本地源码镜像进归档，
// 远端只消费一份自包含 manifest，无需回源解析市场仓库。
async function exportMarketplaceSourceArchiveInternal(
  params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  },
  maxArchiveBytes: number,
) {
// [失败路径] id 与 name 都走 pluginId 校验（禁路径分隔符）：它们会拼进目录名并参与路径收敛，
// 未校验的 id 可让目标目录跳出受控根。
  const marketplaceId = normalizeMarketplaceId(params.marketplaceId);
// 去重且保持调用方顺序：同名插件重复出现在选择列表里只需打包一次，
// 顺序保持让归档内 manifest 的插件次序可预测、便于比对。
  const pluginNames = Array.from(
    new Set(params.pluginNames.map((name) => readRequiredString(name, "plugin name"))),
  );
  if (pluginNames.length === 0) {
    throw new Error("missing marketplace plugin names");
  }
// source 是远端传来的市场描述对象，解析结果决定后续镜像哪些目录；
// 这里失败即整批导出失败，因为无法凭空推断插件源位置。
  const loaded = await loadMarketplaceSource(params.source);
// 校验市场身份：source 由调用方传入，可能与 marketplaceId 指向不同市场；
// 放行会让远端把 A 市场插件登记到 B 市场目录，后续更新全部错位。
  if (loaded.manifest.name !== marketplaceId) {
    throw new Error(`marketplace id mismatch: ${loaded.manifest.name} !== ${marketplaceId}`);
  }
// [权衡] 打依赖闭包而非只打选中项：远端安装缺依赖会直接不可用，
// 而依赖名在远端无法二次解析（跨市场依赖被显式拒绝），只能在导出侧闭合。
  const closure = resolveMarketplacePluginClosure(loaded.manifest, marketplaceId, pluginNames);
// 并行准备每个闭包条目的镜像信息，但结果顺序与 closure 一致（Promise.all 保序），
// 后续 manifest 里的插件顺序因此稳定，目录名指纹才不会随机抖动。
  const mirrorEntries = await Promise.all(
    closure.map((entry) => buildMarketplaceSourceMirrorEntry(loaded, entry)),
  );
// 镜像 manifest 由原始 manifest 改写而来：保留作者声明的字段，只改写 pluginRoot 与插件源，
// 远端拿到的市场信息与本地一致，避免出现「能装但描述丢失」。
  const manifest = buildMirroredMarketplaceManifest(loaded.manifest, mirrorEntries);
// 序列化格式固定（2 空格缩进 + 尾换行）：内容指纹直接哈希这段文本，
// 格式漂移会让同一市场每次导出都生成新目录名，远端永远无法命中已有目录。
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const selectedBytes =
    Buffer.byteLength(manifestContent, "utf-8") +
    (
      await Promise.all(
        mirrorEntries.map((entry) =>
          entry.mirroredSourcePath ? computeRecursiveSize(entry.mirroredSourcePath) : 0,
        ),
      )
    ).reduce((total, bytes) => total + bytes, 0);
  if (selectedBytes > maxArchiveBytes) {
    throw new Error(
      `plugin marketplace source archive exceeds limit: ${selectedBytes}/${maxArchiveBytes}`,
    );
  }
// 指纹只对本地镜像目录计算（远端源为 null）：目录名必须随内容变化，
// 否则插件升级后仍复用旧目录，远端因 existsSync 永久 skipped。
  const sourceFingerprints = await Promise.all(
    mirrorEntries.map((entry) =>
      entry.mirroredSourcePath
        ? computeRecursiveContentFingerprint(entry.mirroredSourcePath)
        : null,
    ),
  );
// 目录名 = 市场名 + 内容指纹前缀：内容不变名字稳定（幂等），内容一变就换目录，
// 远端只需 existsSync 即可判定，无需读文件比版本。
  const directoryName = createMarketplaceSourceDirectoryName(
    marketplaceId,
    manifestContent,
    sourceFingerprints,
  );
// 归档布局固定 `<目录名>/marketplace.json` + `<目录名>/plugins/<插件名>`：
// 解包端据此直接定位 manifest，不必遍历猜测层级。
  const entries = [
    {
      archivePath: `${directoryName}/marketplace.json`,
      content: manifestContent,
    },
    ...mirrorEntries
      .filter(
        (
          entry,
        ): entry is MarketplaceSourceMirrorEntry & {
          mirroredSourcePath: string;
          mirroredSourceRelativePath: string;
        } => Boolean(entry.mirroredSourcePath && entry.mirroredSourceRelativePath),
      )
      .map((entry) => ({
        archivePath: `${directoryName}/${entry.mirroredSourceRelativePath}`,
        sourcePath: entry.mirroredSourcePath,
      })),
  ];
  const archive = await createPluginSyncArchive({
    entries,
    metadata: {
      plugins: [],
// marketplaceSources 是打包端与解包端唯一契约：解包时强制恰好一条，
// 多市场混装会被 readMarketplaceSourceArchiveMetadata 拒绝。
      marketplaceSources: [
        {
          marketplaceId,
          directoryName,
        },
      ],
    },
  });
  return {
    archive,
    archiveBytes: archive.byteLength,
    marketplaceId,
    pluginNames: closure.map((entry) => entry.name),
  };
}

// marketplace 导入没有「版本更新」语义：目录名含内容指纹，同名即同内容，
// 因此只有 skipped / synced 两态，不做覆盖写入。
async function importMarketplaceSourceArchiveInternal(
  archive: Uint8Array,
  maxArchiveBytes: number,
) {
// [资源] 每次导入用随机临时根：并发导入同一市场时互不覆盖，
// 失败方清理也不会误删成功方解包到一半的内容。
// maxExtractedBytes 与打包上限同值：解包阶段就限制总量，
// 防止压缩比极高的归档先撑爆磁盘再被业务层拒绝。
  const tempRoot = join(tmpdir(), `zcode-plugin-marketplace-source-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const metadata = await readMarketplaceSourceArchiveMetadata(tempRoot);
// 目录名来自归档内容而非调用方参数：先归一化再拼路径，
// 这是 INV-01 在 marketplace 导入侧的收敛点。
    const directoryName = normalizePluginSyncRelativePath(metadata.directoryName);
    const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
    const manifest = await readMarketplaceManifest(join(extractedPath, "marketplace.json"));
// 二次校验：metadata 与归档内 manifest 可能被分别篡改，不一致说明归档不自洽，
// 必须在落盘前失败，而不是留下一个 id 错位的市场目录。
    if (manifest.name !== metadata.marketplaceId) {
      throw new Error(
        `marketplace source archive id mismatch: ${manifest.name} !== ${metadata.marketplaceId}`,
      );
    }
// 目标根固定在 marketplace-sources 下：先判存在（同名即同内容），再建父目录；
// 父级不存在时 cp 不会自动创建，缺 mkdir 会以 ENOENT 失败。
    const targetRoot = join(getUserZcodePluginRoot(), MARKETPLACE_SOURCE_ROOT_DIRECTORY);
    const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
    if (existsSync(targetPath)) {
      return {
        marketplaceId: metadata.marketplaceId,
        path: targetPath,
        status: "skipped" as const,
      };
    }
    await mkdir(dirname(targetPath), { recursive: true });
// [事务] 这里直接 cp 到正式目录，没有 staging + rename：目录名含内容哈希，同名冲突概率极低，
// 且 cp 中断留下的残缺目录会在下次同步被判 skipped。
// 这是已知权衡——残缺目录需人工清理，换来的是只拷一次。
    await cp(extractedPath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return {
      marketplaceId: metadata.marketplaceId,
      path: targetPath,
// marketplace 源只落盘目录，不回写 config：它由 RPC 层登记到市场列表，
// 这里改 config 会与调用方的写入顺序冲突，产生两条真相来源。
// [权衡] 因此本函数成功不代表市场已可用，调用方必须使用返回的 path 完成登记。
      status: "synced" as const,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// 只读 plugins 段，其余字段原样不动：config.json 同时承载 provider/storage，
// 解析时丢弃未知键会在回写阶段把它们清空。
async function readUserPluginConfigState(): Promise<UserPluginConfigState> {
// 以「读不到即空配置」开始：文件在首次安装时确实不存在，
// 缺失 config 不应让插件同步整体失败。
  const parsed = await readJsonFileOrEmpty(getUserZcodeConfigPath());
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
// 只保留布尔型 override：Map 的键是归一化小写 id，读取方必须用同一函数归一化，
// 否则大小写差异会让禁用设置「看起来丢了」，插件被重新启用。
  const enabledOverrides = new Map<string, boolean>();
// 只接受布尔值：字符串 "true"、数字 1 之类脏数据被忽略，
// 避免把误输入当作启用状态传播到远端。
  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (typeof enabled === "boolean") {
      enabledOverrides.set(normalizePluginIdKey(pluginId), enabled);
    }
  }
  return {
// dirs 过滤掉空串与非字符串：空串 resolve 后等于 cwd，
// 会把当前工作目录当成插件目录扫进来。
    dirs: readStringArray(plugins.dirs),
    enabledOverrides,
  };
}

// 建立 pluginId -> 本机目录索引，供导入时判重（INV-05 第二判据）。
// 同一 id 多次出现时保留第一个：dirs 顺序即用户优先级。
async function collectConfiguredInlinePluginPathById(): Promise<Map<string, string>> {
  const config = await readUserPluginConfigState();
  const result = new Map<string, string>();
  for (const rawDir of config.dirs) {
    const pluginRoot = resolve(rawDir);
    const canonicalRoot = await realpath(pluginRoot).catch(() => pluginRoot);
    const manifest = await readPluginManifestInfo(canonicalRoot);
    if (!manifest) {
      continue;
    }
    const pluginIdKey = normalizePluginIdKey(manifest.pluginId);
    if (!result.has(pluginIdKey)) {
      result.set(pluginIdKey, canonicalRoot);
    }
  }
  return result;
}

// 导入主流程，四个不变量在此同时生效：路径收敛（INV-01）、staging 落盘（INV-04）、
// 双重存在性判定（INV-02）、config 失败回滚（INV-03）。放松任何一处都会留下半同步状态。
async function importPluginsArchive(
  archive: Uint8Array,
  maxArchiveBytes: number,
): Promise<PluginSyncImportResult> {
// [资源] 随机临时根 + finally 清理（INV-08）：导入可被并发触发，
// 固定目录名会让两次解包互相覆盖。
  const tempRoot = join(tmpdir(), `zcode-plugin-sync-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
// metadata 决定装谁、装到哪个目录名，解包后立刻读取并校验：
// 它同时是目录名白名单来源，晚读会让循环拿到未校验的值。
    const metadata = await readArchiveMetadata(tempRoot);
    const targetRoot = getUserZcodePluginRoot();
    const existingPluginPathById = await collectConfiguredInlinePluginPathById();
// [权衡] 逐插件处理并各自收敛错误，而非整批原子失败：一个插件损坏不应阻止其余落地；
// 代价是调用方必须逐条检查 status，不能只看是否抛错。
    const results: PluginSyncImportResult["results"] = [];

// 顺序处理而不是 Promise.all：rename 与 config 回写都作用于同一份 config.json，
// 并发会触发读改写互相覆盖。
    for (const plugin of metadata.plugins) {
      const directoryName = normalizePluginSyncRelativePath(plugin.directoryName);
      const pluginId = normalizePluginId(plugin.pluginId);
      const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
      const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
// 源与目标两侧都收敛（INV-01）：归档内若含 ../ 段，cp 会把临时根之外的文件读进来；
// targetRoot 侧的 directoryName 来自远端可控 metadata，未收敛时一次 cp 就能写到插件根之外。
// [失败路径] resolvePluginSyncPathWithin 抛错即整个插件条目 failed，不会被静默改成别的目录。
// staging 与 target 必须同根同盘：rename 不能跨文件系统（会退化为拷贝），
// 先建父目录同时保证 cp 有可写落点。
      let stagingPath: string | undefined;
      try {
// 先确认归档内目录确实是插件：manifest 缺失或 pluginId 与 metadata 不符就拒绝落盘，
// [失败路径] 否则合法 metadata 可让任意目录被复制进插件根，等于绕过来源校验。
        const manifest = await readPluginManifestInfo(extractedPath);
        if (!manifest) {
          throw new Error(`plugin manifest not found: ${directoryName}`);
        }
        if (normalizePluginIdKey(manifest.pluginId) !== normalizePluginIdKey(pluginId)) {
          throw new Error(`plugin manifest id mismatch: ${manifest.pluginId} !== ${pluginId}`);
        }
        if (existsSync(targetPath)) {
          results.push({
            name: manifest.name,
            pluginId,
            directoryName,
            status: "skipped",
            path: targetPath,
          });
          continue;
        }
        const existingPath = existingPluginPathById.get(normalizePluginIdKey(pluginId));
// 第二次判定按 pluginId：目录名不同但插件相同，同样跳过并回填已有路径；
// 调用方由此知道该插件其实可用（INV-05）。
        if (existingPath) {
          results.push({
            name: manifest.name,
            pluginId,
            directoryName,
            status: "skipped",
            path: existingPath,
          });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
// staging 名点前缀 + 随机后缀：点前缀让本地候选扫描忽略它，
// 随机后缀避免并发导入互相覆盖（INV-04）。
        stagingPath = resolvePluginSyncPathWithin(
          targetRoot,
          `.importing-${toSafeDirectoryName(directoryName)}-${randomUUID()}`,
        );
// errorOnExist + force:false 是硬约束：staging 若已存在说明名字冲突，
// 合并写入会得到来源不明的内容，宁可失败。
        await cp(extractedPath, stagingPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        if (existsSync(targetPath)) {
// 第二次存在性判定（INV-02 后半）：cp 可能耗时数秒，期间他人可能已落盘同一目录；
// 此刻 rename 会覆盖对方内容，宁可失败也不能静默替换。
          throw new Error(`plugin target already exists: ${targetPath}`);
        }
// [事务] rename 是唯一可见化时刻：之前目标不存在，之后目标完整。
// 崩溃在 rename 前只有 staging 残留；崩溃在之后目录完整但 config 未写，由回滚分支处理。
        await rename(stagingPath, targetPath);
        stagingPath = undefined;
        // 远端 plugin 只有目录落盘还不会被 Agent runtime 发现；
        // 必须在同一个远端服务里追加远端绝对路径，避免写回本机 plugins.dirs。
        try {
// 目录就绪后才登记 config：反序会在登记成功、拷贝失败时留下指向空目录的 dirs 项，
// 该目录永远不会被修复。
          await addPluginDirToUserConfig(targetPath, pluginId, plugin.enabled);
        } catch (error) {
          // inline plugin 目录落盘但 config 写失败会形成半同步状态；
          // 重试会把目录误判为远端已有，所以必须回滚本次刚创建的目标目录。
// [资源] 回滚刚创建的目标目录（INV-03）：不删则重试被 samePluginId 判重跳过，
// force 让「目录已被外部清理」不二次抛错，避免掩盖原始 config 错误。
          await rm(targetPath, { recursive: true, force: true });
          throw error;
        }
// 立刻更新内存索引：同一批 metadata 若重复出现该 pluginId（恶意或手工构造），
// 后续条目会被第二次判定拦成 skipped，而不是覆盖刚写入的目录。
        existingPluginPathById.set(normalizePluginIdKey(pluginId), targetPath);
        results.push({
          name: manifest.name,
          pluginId,
          directoryName,
          status: "synced",
          path: targetPath,
        });
      } catch (error) {
// [资源] 失败的 staging 必须删：它含插件完整副本，残留会占盘且可能被后续 cp 撞名；
// force 使重复清理不抛错。
        if (stagingPath) {
          await rm(stagingPath, { recursive: true, force: true });
        }
        results.push({
// 失败条目用 metadata 里的 name 而非 manifest.name：manifest 可能根本没读到，
// 但调用方仍需可读标识来告知用户哪个插件失败。
          name: plugin.name,
          pluginId,
          directoryName,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { results };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// 严格校验 metadata：这是远端可控输入，字段缺失/类型错误必须拒绝整批——
// 与「单插件失败不影响其他」分级不同，结构坏了连要装什么都不知道。
async function readArchiveMetadata(tempRoot: string): Promise<PluginSyncArchiveMetadata> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
// [失败路径] plugins 必须是数组：接受对象形态会让下游 for...of 抛类型错误，
// 错误信息与真实原因（归档损坏）无关，排查成本更高。
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error("invalid plugin sync archive metadata");
  }
// 逐条重建而非直接信任 JSON：name/pluginId/directoryName 都经校验或归一化，
// 尤其 directoryName 是后续路径拼接的输入（INV-01）。
  const plugins: PluginSyncArchiveMetadata["plugins"] = [];
  for (const item of parsed.plugins) {
    if (!isRecord(item)) {
      throw new Error("invalid plugin sync archive plugin metadata");
    }
    const name = readRequiredString(item.name, "plugin metadata name");
    const pluginId = normalizePluginId(readRequiredString(item.pluginId, "plugin metadata id"));
    const directoryName = normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "plugin metadata directory"),
    );
    plugins.push({
      name,
      pluginId,
      directoryName,
      ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    });
  }
  return { plugins };
}

// 与插件 metadata 分开解析：marketplace 归档只允许一个市场源，长度校验放在这里，
// 保证任何调用方都拿不到多市场数据。
async function readMarketplaceSourceArchiveMetadata(tempRoot: string): Promise<{
  directoryName: string;
  marketplaceId: string;
}> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.marketplaceSources)) {
    throw new Error("invalid plugin marketplace source archive metadata");
  }
// 恰好一条：多市场混装时无法判断目录名与市场 id 的对应关系，
// 随便取第一条会让后续所有插件归属错误。
  if (parsed.marketplaceSources.length !== 1) {
    throw new Error("plugin marketplace source archive must contain one marketplace");
  }
  const item = parsed.marketplaceSources[0];
  if (!isRecord(item)) {
    throw new Error("invalid plugin marketplace source metadata");
  }
  return {
    marketplaceId: normalizeMarketplaceId(
      readRequiredString(item.marketplaceId, "marketplace source id"),
    ),
    directoryName: normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "marketplace source directory"),
    ),
  };
}

// 支持 file / directory / settings 三种来源，对应市场添加方式；
// settings 形态没有磁盘根，后续本地源解析因此只剩绝对路径特例或直接失败。
async function loadMarketplaceSource(
  source: Record<string, unknown>,
): Promise<MarketplaceSourceLoadResult> {
  const sourceKind = typeof source.source === "string" ? source.source : "";
// sourceRoot 取文件所在目录：市场文件通常放仓库根，
// 取它的目录才能让相对的插件路径（./plugins/x）解析到预期位置。
  if (sourceKind === "file") {
    const filePath = readRequiredString(source.path, "marketplace source file path");
    return {
// file 源只读指定文件，不再探测；path 已由 readRequiredString 校验非空，
// 读失败即整个导出失败，避免按空市场继续打包。
      manifest: await readMarketplaceManifest(filePath),
      sourceRoot: dirname(filePath),
    };
  }
  if (sourceKind === "directory") {
    const sourceRoot = readRequiredString(source.path, "marketplace source directory path");
// directory 源允许两种布局，由 findMarketplaceManifestPath 依次探测；
// 找不到时显式报错并带上目录，用户可直接判断是路径选错还是缺文件。
    const manifestPath = findMarketplaceManifestPath(sourceRoot);
    if (!manifestPath) {
      throw new Error(`marketplace manifest not found in directory: ${sourceRoot}`);
    }
    return {
      manifest: await readMarketplaceManifest(manifestPath),
      sourceRoot,
    };
  }
// settings 源内联 manifest，不落盘：它来自远端下发配置，无可用根目录，
// 这也是后面禁止其相对插件源的根源。
  if (sourceKind === "settings") {
    if (!isRecord(source.marketplace)) {
      throw new Error("settings marketplace source is missing marketplace manifest");
    }
    return {
      manifest: parseMarketplaceManifest(source.marketplace),
    };
  }
// [失败路径] 未知 source 显式抛错而非返回空市场：空市场会让同步「成功」但插件数为 0，
// 用户无法察觉是来源配置写错了。
  throw new Error(`unsupported marketplace source for SSH sync: ${sourceKind || "unknown"}`);
}

// 不做存在性预检：调用方要么已定位路径，要么是用户显式指定的文件，
// 让 ENOENT 原样上抛比包装成「manifest 无效」更容易定位。
async function readMarketplaceManifest(filePath: string): Promise<MarketplaceManifestInfo> {
  const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  return parseMarketplaceManifest(parsed);
}

// plugins 有两种历史形态：数组，或 name->配置 的对象。两者都必须接受，
// 否则旧市场在导入侧会表现为「零插件」而不是报错。
function parseMarketplaceManifest(value: unknown): MarketplaceManifestInfo {
  if (!isRecord(value)) {
    throw new Error("marketplace manifest is invalid");
  }
  const name = readRequiredString(value.name, "marketplace name");
  const rawPlugins = value.plugins;
// 对象形态要补 name 字段：条目内通常没写 name，键名就是唯一标识；
// 不补会让 readRequiredString 抛错，把合法旧市场判为损坏。
  const pluginValues = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
// 非对象条目静默过滤：市场文件由第三方维护，混入注释或空值很常见，
// 为一条脏数据拒绝整个市场会让用户无法添加任何插件。
  const plugins = pluginValues.filter(isRecord).map((plugin): MarketplacePluginEntryInfo => {
// 插件名必填：它是 source 的相对路径与依赖引用键，空名会让后续解析全部指向市场根。
    const pluginName = readRequiredString(plugin.name, "marketplace plugin name");
    const dependencies = Array.isArray(plugin.dependencies)
      ? plugin.dependencies.filter(
          (dependency): dependency is string =>
            typeof dependency === "string" && dependency.trim().length > 0,
        )
      : [];
    return {
      name: pluginName,
      dependencies,
      raw: plugin,
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
    };
  });
  return {
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
// pluginRoot 允许写在顶层或 metadata 下（两种历史写法），顶层优先；
// 镜像 manifest 依赖这个解析结果决定插件源基准目录（INV-07）。
    ...readMarketplacePluginRoot(value),
    plugins,
    raw: value,
  };
}

// 只接受非空字符串：空白值等价于未配置，原样返回会拼出带空段的路径。
function readMarketplacePluginRoot(value: Record<string, unknown>): { pluginRoot?: string } {
  if (typeof value.pluginRoot === "string" && value.pluginRoot.trim()) {
    return { pluginRoot: value.pluginRoot.trim() };
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  if (typeof metadata.pluginRoot === "string" && metadata.pluginRoot.trim()) {
    return { pluginRoot: metadata.pluginRoot.trim() };
  }
  return {};
}

// 只探两个标准位置，不递归搜索：目录形态的市场可能带大依赖树，
// 递归查找会把一次导入放大成整树遍历。
function findMarketplaceManifestPath(sourceRoot: string): string | null {
  const candidates = [
    join(sourceRoot, "marketplace.json"),
    join(sourceRoot, ".claude-plugin", "marketplace.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// 依赖闭包用 DFS + visited 去重：市场里环状依赖（A->B->A）并不罕见，
// 没有 visited 会无限递归至栈溢出，而不是给出可读错误。
function resolveMarketplacePluginClosure(
  manifest: MarketplaceManifestInfo,
  marketplaceId: string,
  pluginNames: readonly string[],
): MarketplacePluginEntryInfo[] {
// 同名条目后者覆盖前者：市场文件里重复插件名属于作者失误，
// 取最后一个与 npm 语义一致，至少保证结果确定而不随遍历顺序变化。
  const byName = new Map(manifest.plugins.map((entry) => [entry.name, entry]));
  const visited = new Set<string>();
  const result: MarketplacePluginEntryInfo[] = [];
// requiredBy 只用于错误信息：跨市场依赖被拒时要能指出是谁引入的，
// 否则用户只知道某个依赖非法，却不知道从哪个插件开始删。
  const visit = (pluginName: string, requiredBy: string) => {
    const normalizedName = readRequiredString(pluginName, "marketplace plugin name");
    if (visited.has(normalizedName)) {
      return;
    }
    const entry = byName.get(normalizedName);
    if (!entry) {
      throw new Error(`marketplace plugin not found: ${normalizedName}`);
    }
    visited.add(normalizedName);
    result.push(entry);
// 递归前先 normalize：它会把 name@market 剥成 name，跨市场依赖在此抛错，
// 因为导出侧无法保证对方市场的源码也一并镜像过去。
    for (const dependency of entry.dependencies) {
      visit(normalizeMarketplaceDependency(dependency, marketplaceId, requiredBy), entry.name);
    }
  };
  for (const pluginName of pluginNames) {
    visit(pluginName, pluginName);
  }
  return result;
}

// 依赖串允许 name@marketplace。分隔符取最后一个 @：插件名本身可能含 @（scope 风格），
// 从第一个 @ 切会把名字截断成不存在插件。
function normalizeMarketplaceDependency(
  dependency: string,
  marketplaceId: string,
  requiredBy: string,
): string {
  const trimmed = dependency.trim();
  const separatorIndex = trimmed.lastIndexOf("@");
  if (separatorIndex < 0) {
    return trimmed;
  }
  const name = trimmed.slice(0, separatorIndex);
  const marketplace = trimmed.slice(separatorIndex + 1);
// [失败路径] 只接受同市场依赖：跨市场依赖在远端镜像里没有对应源码，
// 静默保留会让远端装出缺依赖的插件，故宁可在此失败。
  if (marketplace === marketplaceId) {
    return name;
  }
  throw new Error(
    `cross-marketplace dependency is not supported for SSH source mirror: ${dependency} required by ${requiredBy}`,
  );
}

// 每个闭包条目要么是远端源（github/npm 等，原样透传由远端拉取），
// 要么是本地源（必须复制进归档并改写 source）。
async function buildMarketplaceSourceMirrorEntry(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<MarketplaceSourceMirrorEntry> {
// 远端源不镜像：拷贝会退化成把本机缓存当源码，
// 而远端本就有能力按原始 source 自行拉取，透传才是正确语义。
  if (isRemoteMarketplacePluginSource(entry.source)) {
    return { entry };
  }
  const sourcePath = await resolveLocalMarketplacePluginSource(loaded, entry);
// 镜像目录名取自插件名并净化：它与归档内相对路径绑定，
// 未净化时含斜杠的插件名会把源码散落到归档的不同层级。
  const sourceDirectoryName = toSafeDirectoryName(entry.name);
  return {
    entry,
    mirroredSourcePath: sourcePath,
    mirroredSourceRelativePath: `${MIRRORED_MARKETPLACE_PLUGIN_ROOT}/${sourceDirectoryName}`,
  };
}

// 用白名单而非「除本地外都算远端」：未知 source 必须走本地解析并失败，
// 否则任何拼错的值都会被透传，远端拿到无法解析的源。
function isRemoteMarketplacePluginSource(source: unknown): boolean {
  if (!isRecord(source)) {
    return false;
  }
  const sourceKind = typeof source.source === "string" ? source.source : "";
  return ["github", "git", "url", "git-subdir", "npm", "pip"].includes(sourceKind);
}

// 本地源三种形态（字符串路径、{source:directory}、缺省按插件名推导）都要收敛到
// 「一个存在且带 plugin manifest 的目录」，见 assertLocalMarketplacePluginSourceRoot。
async function resolveLocalMarketplacePluginSource(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<string> {
  if (typeof entry.source === "string") {
    return await resolveLocalMarketplacePluginSourcePath(
      loaded,
      entry.source,
      `${entry.name} source`,
    );
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "directory" && typeof entry.source.path === "string") {
      return await resolveLocalMarketplacePluginSourcePath(
        loaded,
        entry.source.path,
        `${entry.name} directory source`,
        { allowSettingsAbsoluteDirectorySource: !loaded.sourceRoot },
      );
    }
    return await resolveLocalMarketplacePluginFallback(loaded, entry);
  }
  return await resolveLocalMarketplacePluginFallback(loaded, entry);
}

// 缺省本地源按插件名在 pluginRoot 下推导（市场布局约定）；目录不存在直接失败，
// 不打空目录——空目录会让远端装出无技能、无命令的插件。
async function resolveLocalMarketplacePluginFallback(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<string> {
  if (!loaded.sourceRoot) {
    throw new Error(
      `cannot mirror local marketplace plugin source without source root: ${entry.name}`,
    );
  }
  const pluginBaseDir = resolveMarketplacePluginBaseDir(loaded);
  const fallbackPath = resolvePluginSyncPathWithin(pluginBaseDir, entry.name, {
    unsafePathLabel: "unsafe marketplace plugin source path",
  });
// 存在才继续校验 manifest：不存在时给出的是「源不存在」，
// 与「存在但不是插件」区分开，两类错误对应不同的修复动作。
  if (await directoryExists(fallbackPath)) {
    return await assertLocalMarketplacePluginSourceRoot(fallbackPath);
  }
  throw new Error(`local marketplace plugin source does not exist: ${fallbackPath}`);
}

// 相对路径必须以 pluginBaseDir 为根收敛：source 字段来自第三方可写的市场文件，
// 未收敛的 ../../.. 会把本机任意目录当插件源码打包外发。
async function resolveLocalMarketplacePluginSourcePath(
  loaded: MarketplaceSourceLoadResult,
  sourcePath: string,
  label: string,
  options: { allowSettingsAbsoluteDirectorySource?: boolean } = {},
): Promise<string> {
  const requestedPath = readRequiredString(sourcePath, label);
// 只剥开头的 ./：Windows 反斜杠形式不在这里兼容，后续收敛会把它当普通字符处理，
// 从而失败而非误解析到根外。
  const relativeSourcePath = requestedPath.replace(/^\.\//u, "");
// settings 源没有磁盘根，只有绝对路径可解析；显式分支是为了给出可读原因，
// 而不是让 resolve 把相对路径静默解析到进程 cwd。
  if (!loaded.sourceRoot && options.allowSettingsAbsoluteDirectorySource) {
    if (!isAbsolute(requestedPath)) {
      throw new Error(
        `cannot mirror local marketplace plugin source without source root: ${sourcePath}`,
      );
    }
    const absolutePath = resolve(requestedPath);
    if (await directoryExists(absolutePath)) {
      return await assertLocalMarketplacePluginSourceRoot(absolutePath);
    }
    throw new Error(`local marketplace plugin source does not exist: ${sourcePath}`);
  }
  if (!loaded.sourceRoot) {
    throw new Error(
      `cannot mirror local marketplace plugin source without source root: ${sourcePath}`,
    );
  }
  const pluginBaseDir = resolveMarketplacePluginBaseDir(loaded);
  const relativePath = resolvePluginSyncPathWithin(pluginBaseDir, relativeSourcePath, {
    unsafePathLabel: "unsafe marketplace plugin source path",
  });
  if (await directoryExists(relativePath)) {
    return await assertLocalMarketplacePluginSourceRoot(relativePath);
  }
  throw new Error(`local marketplace plugin source does not exist: ${sourcePath}`);
}

async function assertLocalMarketplacePluginSourceRoot(pluginRoot: string): Promise<string> {
// 镜像前必须确认目标是插件目录：路径收敛只保证在根内，不保证内容不敏感；
// 被篡改的市场条目若指向 ~/.ssh 之类目录，这里会因缺 manifest 而拒绝外发。
  const manifest = await readPluginManifestInfo(pluginRoot);
  if (!manifest) {
    // marketplace source mirror 只能复制选中插件目录。先验证 plugin manifest，避免被篡改的 marketplace entry
    // 指向普通目录后，把本机敏感文件作为“插件源码”打包发送到 SSH 远端。
    throw new Error(`local marketplace plugin source is missing plugin manifest: ${pluginRoot}`);
  }
  return pluginRoot;
}

// pluginRoot 不存在时回退 sourceRoot：市场可能把 pluginRoot 写成尚未创建的目录，
// 直接失败会让整个市场不可导出，回退后单个缺源插件仍会各自报错。
function resolveMarketplacePluginBaseDir(loaded: MarketplaceSourceLoadResult): string {
  const sourceRoot = loaded.sourceRoot;
  if (!sourceRoot) {
    throw new Error("cannot resolve marketplace plugin source root");
  }
// 未声明 pluginRoot 时以 sourceRoot 为基准，这是市场默认布局；
// 空字符串在解析阶段已被过滤，走到这里即为合法缺省。
  if (!loaded.manifest.pluginRoot) {
    return sourceRoot;
  }
// pluginRoot 同样收敛：它写在市场文件里（第三方可写），
// 未收敛的 ../ 会把插件基准目录抬到 sourceRoot 之外。
  const pluginRoot = resolvePluginSyncPathWithin(sourceRoot, loaded.manifest.pluginRoot, {
    unsafePathLabel: "unsafe marketplace pluginRoot",
  });
  return existsSync(pluginRoot) ? pluginRoot : sourceRoot;
}

// 镜像 manifest 是远端唯一可读的市场描述，规则有三：删顶层 pluginRoot、
// 把本地源改写成归档内相对路径、metadata.pluginRoot 指向镜像目录（INV-07）。
function buildMirroredMarketplaceManifest(
  manifest: MarketplaceManifestInfo,
  entries: readonly MarketplaceSourceMirrorEntry[],
): Record<string, unknown> {
// 只有存在本地镜像源时才改写 pluginRoot：全远端市场保持原样，
// 否则会把远端源的相对解析基准也挪到镜像目录，远端反而拉不到源码。
  const hasMirroredLocalSource = entries.some((entry) => entry.mirroredSourceRelativePath);
  const rawMetadata = isRecord(manifest.raw.metadata) ? manifest.raw.metadata : {};
// 浅拷贝后再删顶层 pluginRoot：直接改 manifest.raw 会污染同进程内复用该对象的调用方，
// 导致后续导出只看到被改写的视图。
  const rawManifest = { ...manifest.raw };
  delete rawManifest.pluginRoot;
  return {
    ...rawManifest,
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(hasMirroredLocalSource
      ? {
          // agent marketplace 解析只读取 metadata.pluginRoot。
          // 远端镜像 manifest 如果写顶层 pluginRoot，会把 ./hello-world 误解析到市场根目录。
          metadata: {
            ...rawMetadata,
            pluginRoot: MIRRORED_MARKETPLACE_PLUGIN_ROOT,
          },
        }
      : {}),
    plugins: entries.map((entry) => {
      const raw: Record<string, unknown> = { ...entry.entry.raw, name: entry.entry.name };
      if (entry.mirroredSourceRelativePath) {
// 归档内路径形如 plugins/<name>，回写时必须去掉首段：manifest 与插件目录同级，
// source 又相对插件基准目录，保留 plugins/ 会让远端解析到 plugins/plugins/<name>。
        raw.source = `./${entry.mirroredSourceRelativePath.split("/").slice(1).join("/")}`;
      }
      return raw;
    }),
  };
}

// 目录名 = 市场名 + 内容指纹前 12 位：同一内容多次导出同名（幂等），
// 内容一变即换目录，远端仅凭 existsSync 就能判定，无需读文件比版本。
function createMarketplaceSourceDirectoryName(
  marketplaceId: string,
  manifestContent: string,
  sourceFingerprints: readonly (string | null)[],
): string {
  const hashInput = JSON.stringify({
    manifestContent,
    sourceFingerprints,
  });
  return `${toSafeDirectoryName(marketplaceId)}-${createShortHash(hashInput).slice(0, 12)}`;
}

// config 回写是「读-改-写」：调用方已按插件串行处理，本函数不再加锁。
// [并发] 若将来并发调用，后写者会用旧快照覆盖先写者的 dirs，必须在外层串行化。
async function addPluginDirToUserConfig(
  pluginPath: string,
  pluginId: string,
  enabledOverride: boolean | undefined,
): Promise<void> {
// 每次都重新读盘而不是复用调用前的快照：同步期间用户可能在 UI 里改了其他设置，
// 用旧快照整体回写会把这些修改一起抹掉。
  const filePath = getUserZcodeConfigPath();
  const parsed = await readJsonFileOrEmpty(filePath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const resolvedPluginPath = resolve(pluginPath);
// 归一化（resolve）后比较再去重：config 里可能已有带 ~ 或不同分隔符的同一路径，
// 直接字符串比较会插入重复项，候选扫描因此把同一插件读两次。
  const dirs = readStringArray(plugins.dirs);
  const nextDirs = dirs.map((item) => resolve(item)).includes(resolvedPluginPath)
    ? dirs
    : [...dirs, resolvedPluginPath];
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
// 只覆盖本次涉及的 plugins 键，其余字段原样展开：config.json 是多模块共享文件，
// 重写整个对象时丢掉未知键会破坏其他功能的配置。
  await writeJsonFileAtomic(filePath, {
    ...parsed,
    plugins: {
      ...plugins,
      dirs: nextDirs,
// enabled 仅在归档 metadata 显式给出时写：undefined 表示「沿用默认」，
// 写成 false 会与用户本机配置冲突，且无法区分「未设置」与「已关闭」。
      ...(enabledOverride !== undefined
        ? {
            enabledPlugins: {
              ...enabledPlugins,
              [pluginId]: enabledOverride,
            },
          }
// 没有新 override 时保留原有 enabledPlugins：直接省略会让已存在的禁用设置
// 在下次同步时被清除，用户会看到插件意外重新启用。
        : Object.keys(enabledPlugins).length > 0
          ? { enabledPlugins }
          : {}),
    },
  });
}

// 按 .zcode-plugin -> .claude-plugin -> .codex-plugin 顺序探测，先命中先返回：
// 三个生态的 manifest 可能共存，顺序决定以谁为准（ZCode 优先）。
async function readPluginManifestInfo(pluginRoot: string): Promise<PluginManifestInfo | null> {
  for (const segments of PLUGIN_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = join(pluginRoot, ...segments);
    let raw: string;
    try {
// [失败路径] 读失败就试下一个候选路径：多生态共存时文件缺失是常态，
// 与「文件存在但 JSON 损坏」不同，后者直接返回 null 中止探测。
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
// name 是插件标识，缺失即视为不是插件目录（不回退目录名）；
// 空白名会让 normalizePluginId 得到空串，直接信任会把插件登记成空 id。
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) {
      return null;
    }
    return {
      name,
// 内联插件 id 固定带 inline 市场后缀：远端与 UI 都按 name@marketplace 解析，
// 少后缀会被当成官方市场的同名插件，导致安装到错误位置。
      pluginId: `${name}@${INLINE_PLUGIN_MARKETPLACE}`,
      ...(typeof parsed.description === "string" && parsed.description.trim()
        ? { description: parsed.description.trim() }
        : {}),
      ...(typeof parsed.version === "string" && parsed.version.trim()
        ? { version: parsed.version.trim() }
        : {}),
      componentTypes: await resolvePluginComponentTypes(pluginRoot, parsed),
    };
  }
  return null;
}

// 组件类型供 UI 展示「提供技能/命令/hooks/mcp」。manifest 字段与约定目录都要看：
// 部分插件只声明字段，另一些只放文件不声明。
async function resolvePluginComponentTypes(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<PluginSyncComponentType[]> {
  const componentTypes: PluginSyncComponentType[] = [];
// [权衡] 只探约定目录，不递归查找：递归会把 node_modules 里的同名目录算进来，
// 虚报组件类型会让用户在同步前误判插件能力。
  if ("skills" in manifest || (await pathExists(join(pluginRoot, "skills")))) {
    componentTypes.push("skills");
  }
  if ("commands" in manifest || (await pathExists(join(pluginRoot, "commands")))) {
    componentTypes.push("commands");
  }
// hooks 以 hooks.json 是否存在为准而不是 hooks 目录：空目录很常见，
// 只看目录会把没有实际 hook 的插件标成提供 hooks。
  if ("hooks" in manifest || (await pathExists(join(pluginRoot, "hooks", "hooks.json")))) {
    componentTypes.push("hooks");
  }
  if ("mcpServers" in manifest || (await pathExists(join(pluginRoot, ".mcp.json")))) {
    componentTypes.push("mcp");
  }
  return componentTypes;
}

// 用 lstat 而非 stat：软链按链接本身计长、不跟随目标，既避免软链环无限递归，
// 也让体积与归档实际打包内容一致。
async function computeRecursiveSize(path: string): Promise<number> {
  const pathStat = await lstat(path);
  if (pathStat.isFile()) {
    return pathStat.size;
  }
  if (!pathStat.isDirectory()) {
    return 0;
  }
  let total = 0;
// 逐个串行累加而不并行：候选目录可能很深，并行 readdir 会把句柄数放大到
// 系统上限，反过来拖慢整个导出。
  for (const entry of await readdir(path)) {
    total += await computeRecursiveSize(join(path, entry));
  }
  return total;
}

// 内容指纹必须只依赖内容与结构，不能依赖遍历顺序或时间戳：
// 它是 marketplace 目录名的唯一输入，任何不稳定因素都会让幂等失效。
async function computeRecursiveContentFingerprint(path: string): Promise<string> {
  const pathStat = await lstat(path);
  const hash = createHash("sha256");
  if (pathStat.isFile()) {
// 加入类型前缀与 \0 分隔：否则「文件 a 内容 bc」与「文件 ab 内容 c」
// 会算出同一指纹，内容不同却落到同名目录，远端直接跳过。
    hash.update("file\0");
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  if (!pathStat.isDirectory()) {
    throw new Error(`unsupported plugin archive source: ${path}`);
  }
  hash.update("dir\0");
// 显式排序：readdir 顺序由文件系统决定（NTFS 与 ext4 不同），不排序会让同一目录
// 在两台机器上得到不同指纹，远端永远判定为新内容、无法幂等。
  const children = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const child of children) {
    hash.update(child.name);
    hash.update("\0");
    hash.update(await computeRecursiveContentFingerprint(join(path, child.name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// 同名插件目录去重：不同作者可能起同名插件，归档内目录冲突会让导入侧
// 后者被 skipped 或直接覆盖，用户拿不到自己选中的那一份。
function createUniqueDirectoryName(
  directoryBasename: string,
  pluginName: string,
  pluginRoot: string,
  usedDirectoryNames: Set<string>,
): string {
  const baseName = toSafeDirectoryName(directoryBasename || pluginName);
  if (!usedDirectoryNames.has(baseName)) {
    usedDirectoryNames.add(baseName);
    return baseName;
  }
// 用绝对路径哈希做后缀：同一次导出内路径唯一，后缀即稳定；
// 不用递增序号是因为候选顺序会随 config 调整变化，序号会让目录名漂移、破坏幂等。
  const dedupedName = toSafeDirectoryName(`${baseName}-${createShortHash(pluginRoot).slice(0, 8)}`);
  usedDirectoryNames.add(dedupedName);
  return dedupedName;
}

// 把路径分隔符替换成 - 后再复用归一化：目录名最终会拼进归档路径，
// 保留分隔符等于允许目录名嵌套，破坏「一个候选一个顶层目录」的前提。
function toSafeDirectoryName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:]/gu, "-") || "plugin";
  try {
// [失败路径] 归一化拒绝（保留名、纯点段等）时退回哈希名：
// 目录名来自用户或市场的任意字符串，必须保证总能产出一个可落盘的名字。
    return normalizePluginSyncRelativePath(sanitized);
  } catch {
    return `plugin-${createShortHash(value).slice(0, 8)}`;
  }
}

// 候选 id 绑定 pluginId + 绝对路径：同一插件被复制到两个目录时是两个可分别导出的候选；
// 只用 pluginId 会让二者 id 冲突，UI 选中一个却打包另一个。
function createCandidateId(pluginId: string, pluginRoot: string): string {
  return createShortHash(`${pluginId}:${pluginRoot}`);
}

// 只用于生成稳定短标识（目录后缀、候选 id），不做安全用途；
// 因此用 sha256 截断即可，无需引入额外依赖或加盐。
function createShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// pluginId 是路径与 config 键的来源，必须拒绝空值与路径分隔符：
// 含 / 的 id 在远端会拼出跨目录路径，这是 INV-01 的最初入口。
function normalizePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
// 错误信息带原值：id 来自远端归档，用户需要看到具体非法串才能定位是哪个插件，
// 而不是只得到一句「invalid plugin id」。
    throw new Error(`invalid plugin id: ${pluginId}`);
  }
  return normalized;
}

// 市场 id 与插件 id 共用同一套校验：两者都会拼进目录名并参与路径收敛，
// 分别实现容易在其中一处漏掉分隔符检查。
function normalizeMarketplaceId(marketplaceId: string): string {
  return normalizePluginId(marketplaceId);
}

// 判重键统一走 normalize + toLowerCase：先校验再小写，
// 保证非法 id 在任何比较点都会抛错，而不是被小写化成看似合法的键。
function normalizePluginIdKey(pluginId: string): string {
  return normalizePluginId(pluginId).toLowerCase();
}

// 统一「必填非空字符串」校验，label 只用于错误信息：
// 各处因此能指出缺失的是哪个字段，而不是笼统的 invalid metadata。
function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${label}`);
  }
  return value.trim();
}

// 只有 ENOENT 视为空配置：EACCES、EISDIR 等其他错误必须上抛，
// 否则权限问题会被当成默认配置，随后一次写入就覆盖掉原文件。
async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`invalid json object: ${filePath}`);
  }
  return parsed;
}

// 原子写：同目录临时文件 + rename。直接写目标文件时进程崩溃会留下截断的 config.json，
// 下次启动所有插件配置与 provider 设置一起丢失。
async function writeJsonFileAtomic(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
// 临时文件必须与目标同目录：rename 跨文件系统会退化为拷贝+删除，原子性随之丢失；
// 随机后缀避免两个进程的临时文件互相覆盖。
  const tempPath = join(dirname(filePath), `.tmp-${basename(filePath)}-${randomUUID()}`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
// 0600：config.json 可能含 token 等凭据，原子写新建的文件必须立即收紧权限，
// 依赖默认 umask 会因平台差异留下 0644。
    mode: USER_CONFIG_FILE_MODE,
  });
// [事务] rename 是唯一提交点：之前目标仍是旧内容，之后是完整新内容；
// 崩溃在之前只会留下临时文件，旧配置保持可用。
  await rename(tempPath, filePath);
}

// 过滤非字符串与空串：空串 resolve 后等于进程 cwd，
// 会让候选扫描把当前工作目录当成插件目录。
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

// 用 lstat 而不是 stat：软链本身存在即算存在，跟随目标会因断链误判为不存在，
// 组件类型探测因此漏报。
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
