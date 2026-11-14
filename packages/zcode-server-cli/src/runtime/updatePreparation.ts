// INV-01 三态返回值是唯一对外契约：up-to-date、prepared、prepared-offline；守住位置：UpdatePreparation 联合类型与 prepareOnlineUpdate 的所有 return；改错故障：调用方拿不到 discard 句柄，准备产物与 pending 指针无人回收。
// INV-02 未配置 catalog 地址时必须回落到 pending 或显式抛错；守住位置：catalogUrl 为空的分支；改错故障：无网络又无 pending 时静默返回，update 命令误报成功。
// INV-03 整包临时目录只在 finally 中递归删除；守住位置：mkdtemp 创建的 temporaryDir 与末尾的 rm；改错故障：下载或安装失败后临时归档常驻系统 temp，磁盘持续增长。
// INV-04 pending 必须在安装成功后才出现；守住位置：installArchive 返回后构造 prepared 的链路；改错故障：先写指针再解压，失败后离线更新会应用一个不存在的 release。
// INV-05 回滚只处理仍指向本次 candidate 的 pending；守住位置：createPreparedReleaseDiscarder 中 sameRelease 的提前 return；改错故障：覆盖并发更新刚写入的指针，用户的更新意图丢失。
// INV-06 discard 必须幂等且只执行一次；守住位置：闭包内 discarded 标志与首行判定；改错故障：重复调用二次删除已回滚的目录，或再次改写 pending。
// INV-07 release 目录只在本次新建时才允许删除；守住位置：releaseDirExisted 与 current.releaseDir 的差异判断；改错故障：删掉正在运行的发布目录，进程后续读文件直接失败。
// INV-08 回滚顺序固定为先恢复指针再删目录；守住位置：discarder 中 writePending 或 removePending 先于 rm 的排列；改错故障：指针短暂指向已被删除的 release，启动校验抛错。
// INV-09 版本比较一律用 numeric 的 localeCompare；守住位置：isStalePending 与候选排序两处比较；改错故障：字符串序把 1.10 判为小于 1.9，选错最新版本或误删新指针。
// INV-10 只清理不新于 current 的遗留 pending；守住位置：isStalePending 末尾的比较结果；改错故障：删掉比 current 更新的 pending，用户无法应用已下载的新版本。
// INV-11 已是最新分支必须顺手清掉 stale pending；守住位置：archiveSha256 相等时的 removePending 调用；改错故障：留下旧指针，下一次离线更新把已最新的机器降级。
// INV-12 增量路径仅在 manifestUrl、components 与 current 组件三者齐备时启用；守住位置：prepareComponentUpdate 的调用条件；改错故障：缺少基线组件仍走增量，组装出缺文件的发布目录。
// INV-13 增量组装不可完成时必须返回 null 而非抛出；守住位置：组件循环中的两处 return null；改错故障：单个组件缺归档让整次更新失败，而整包路径本可完成。
// INV-14 组件缓存命中必须携带 target、componentId、sha256 与扩展名；守住位置：findArchive 的入参构造；改错故障：跨平台或跨摘要复用归档，组装后内容校验必然失败。
// INV-15 组件临时目录与整包临时目录不得复用；守住位置：两处 mkdtemp 的不同前缀与各自 finally；改错故障：整包清理连带删掉增量归档，组装读到空文件。
// INV-16 增量路径必须先组装再写 pending；守住位置：assemble 调用与 writePending 的先后；改错故障：指针先落盘，组装失败后离线更新指向半成品目录。
// INV-17 下载组件前先查缓存，未命中才发起网络请求；守住位置：cachedArchive 空值合并到 downloadComponent；改错故障：每次更新重复下载全部组件，限速网络下直接超时。
// INV-18 组件缺 archiveUrl 或 archiveSha256 必须在下载前抛出；守住位置：downloadComponent 入口的守卫；改错故障：空地址进入下载器，报错与真实原因（清单缺字段）无关。
//
// 模块职责：在线检查最新 release，按增量组件或整包两条路径准备发布目录，写入 pending，并把可撤销的准备结果交给 update 命令。
// 状态所有权：catalog、远端 manifest 与归档来自网络；current.json 与 pending.json 归 ReleaseManager；本模块只持有一次准备过程的临时快照。
// 阅读顺序：先看三态契约，再看 discard 回滚闭包，然后看 prepareOnlineUpdate 分支、整包临时目录、增量组装与单组件下载。
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "../contracts.js";
import { ComponentCache } from "./componentCache.js";
import { currentServerTarget, serverRuntimeManifestSchema } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { fetchReleaseCatalog, fetchReleaseJson, ReleaseDownloader } from "./releaseDownload.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";

// [契约] 三态互斥：up-to-date 只带版本；prepared 必带 discard；prepared-offline 只报告已有 pending 的版本，不产生任何新产物。
// [契约] discard 是 prepared 专属的回收句柄，调用方在 guard 拒绝或应用失败时用它撤销本次准备；另外两态不提供。
// [并发] discard 在被调用时才读取 pending，而不是准备时快照；在回滚时刻读取才能识别并发写入者。
// [事务] discard 不重启进程、不修改 current，只把 pending 与候选 release 目录恢复到准备前状态。
// [契约] version 来自 catalog 的 release.version，可能不同于 appVersion；目录命名使用 appVersion，两者不可互换。
// [权衡] prepared-offline 不返回 discard：复用既有 pending 不产生新文件，撤销反而会破坏用户已表达的离线意图。
// [失败路径] 三态之外没有第四种失败返回值；不可恢复问题一律以异常抛给 update 命令统一收尾。
// [边界] 该类型只描述准备结果，不描述运行中的进程；切换到新版本由 apply-update 与事务文件负责。
export type UpdatePreparation =
  | { status: "up-to-date"; version: string }
  | { status: "prepared"; version: string; discard: () => Promise<void> }
  | { status: "prepared-offline"; version: string };

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

function sameRelease(left: ReleaseManifest | null, right: ReleaseManifest): boolean {
  return left?.version === right.version && left.releaseDir === right.releaseDir;
}

function isStalePending(pending: ReleaseManifest, current: ReleaseManifest): boolean {
  if (sameRelease(pending, current)) return true;
  if (pending.archiveSha256 && current.archiveSha256 && pending.archiveSha256 === current.archiveSha256) return true;
  // 只清理不可能比 current 更新的遗留候选；未来版本的 pending 仍保留，供用户在
  // catalog 暂时回滚或离线时显式应用。
  return pending.version.localeCompare(current.version, undefined, { numeric: true }) <= 0;
}

// [资源] 闭包捕获准备时刻的 previousPending 与 releaseDirExisted，回滚判断全部依赖这份快照。
// [并发] discarded 标志让撤销幂等：重复调用直接返回，避免二次写入指针。
// [并发] 执行时重新读取 pending，再与本次 prepared 比对；不一致说明有别的写入者接手。
// [事务] 只有指针仍指向本次 prepared 才继续，否则整体放弃，保留他人的更新意图。
// [失败路径] 读取 pending 的异常不在此吞掉，交由命令层做 best-effort 记录，保留真实错误。
// [事务] previousPending 存在则原子写回，否则删除 pending，两个分支互斥且顺序固定。
// [资源] 仅在准备时目录不存在且 current 未指向它时才递归删除候选 release，绝不碰运行中的目录。
// [权衡] 不清理组件缓存归档：摘要命中的缓存可被后续更新复用，删除会失去增量收益。
function createPreparedReleaseDiscarder(input: {
  layout: ServerLayout;
  current: ReleaseManifest | null;
  previousPending: ReleaseManifest | null;
  prepared: ReleaseManifest;
  releaseDirExisted: boolean;
}): () => Promise<void> {
  let discarded = false;
  return async () => {
    if (discarded) return;
    discarded = true;
    const releaseManager = new ReleaseManager(input.layout);
    const pending = await releaseManager.readPending();
    // 准备期间任务可能启动，apply-update 随后拒绝切换；若直接返回错误，
    // 本次 CLI 生成的 pending/release 会遗留并被下一次更新误认为可直接应用。只回滚仍
    // 指向本次 candidate 的 pending，避免覆盖并发更新已经写入的更新意图。
    if (!sameRelease(pending, input.prepared)) return;
    if (input.previousPending) await releaseManager.writePending(input.previousPending);
    else await releaseManager.removePending();
    if (!input.releaseDirExisted && input.current?.releaseDir !== input.prepared.releaseDir) {
      await rm(input.prepared.releaseDir, { recursive: true, force: true });
    }
  };
}

// [契约] catalog 地址只从环境变量读取并去掉首尾空白；空串等同未配置，不做硬编码兜底。
// [失败路径] 未配置地址且无 pending 时抛错；有 pending 则直接报告 offline，不发起任何网络请求。
// [契约] 目标平台由 currentServerTarget 决定，候选集合只保留 target 相等的 release。
// [顺序] 候选按 numeric 升序后取末尾作为最新；升序取末尾即最大值，不要改成取首项。
// [事务] 判断已是最新需同时满足 target 与 archiveSha256 相等，仅版本号相同不足以豁免。
// [失败路径] 已是最新分支先读 pending 再按 stale 规则清理，避免留下过期指针导致后续降级。
// [权衡] 增量路径只在 release 带 manifestUrl 与 components、且 current 有组件记录时才尝试。
// [失败路径] 增量返回 null 表示放弃增量，控制流继续走整包下载，这不算错误。
export async function prepareOnlineUpdate(layout: ServerLayout): Promise<UpdatePreparation> {
  const catalogUrl = process.env.ZCODE_SERVER_RELEASE_MANIFEST_URL?.trim();
  if (!catalogUrl) {
    const pending = await new ReleaseManager(layout).readPending();
    if (!pending) {
      throw new Error(
        "ZCode Server release source is not configured and no offline pending release is available",
      );
    }
    return { status: "prepared-offline", version: pending.version };
  }
  const target = currentServerTarget();
  const catalog = await fetchReleaseCatalog(catalogUrl);
  const candidates = catalog.releases.filter((release) => release.target === target);
  const release = candidates
    .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }))
    .at(-1);
  if (!release) throw new Error(`No release for target ${target} in catalog`);
  const releaseManager = new ReleaseManager(layout);
  const current = await releaseManager.readCurrent();
  if (current?.target === target && current.archiveSha256 === release.archiveSha256) {
    const pending = await releaseManager.readPending();
    if (pending && isStalePending(pending, current)) {
      // 在线检查确认 current 已是 catalog 最新版本时，不能直接返回
      // up-to-date，却留下旧 pending.json；下一次无网络更新会误应用该指针并降级。
      await releaseManager.removePending();
    }
    return { status: "up-to-date", version: current.version };
  }
  if (release.manifestUrl && release.components && current?.components) {
    const assembled = await prepareComponentUpdate({
      layout,
      target,
      release,
      manifestUrl: release.manifestUrl,
      current,
    });
    if (assembled) {
      return {
        status: "prepared",
        version: release.version,
        discard: createPreparedReleaseDiscarder(assembled),
      };
    }
  }
  // [资源] 临时目录前缀固定为 zcode-server-update-，与组件临时目录区分，便于排查残留。
  // [契约] 归档名按 archiveUrl 后缀决定 zip 或 tar.gz；解压器按扩展名分流，不能凭内容猜测。
  // [事务] releaseDir 由 appVersion、target 与归档摘要前 12 位拼成，摘要参与命名保证同名不同内容不冲突。
  // [资源] releaseDirExisted 必须在安装前采样，它决定 discard 是否有权删除该目录。
  // [并发] previousPending 也在安装前读取，作为回滚基线；晚读会把本次写入误当旧值。
  // [失败路径] 摘要不符由下载器抛出，finally 仍会清理临时目录，不留半包。
  // [资源] 安装完成后临时归档不再被需要，最终清理同时覆盖成功与失败两条路径。
  const temporaryDir = await mkdtemp(join(tmpdir(), "zcode-server-update-"));
  const archiveName = release.archiveUrl.toLowerCase().endsWith(".zip")
    ? "release.zip"
    : "release.tar.gz";
  const archivePath = join(temporaryDir, archiveName);
  try {
    await new ReleaseDownloader().download({
      url: release.archiveUrl,
      destination: archivePath,
      sha256: release.archiveSha256,
      expectedSizeBytes: release.archiveSizeBytes,
    });
    const releaseVersion = release.appVersion ?? release.version;
    const releaseDir = join(layout.releasesDir, `${releaseVersion}-${target}-${release.archiveSha256.toLowerCase().slice(0, 12)}`);
    const releaseDirExisted = await pathExists(releaseDir);
    const previousPending = await new ReleaseManager(layout).readPending();
    const prepared = await new ReleaseInstaller(layout).installArchive({
      archivePath,
      target,
      version: releaseVersion,
      archiveSha256: release.archiveSha256,
    });
    return {
      status: "prepared",
      version: release.version,
      discard: createPreparedReleaseDiscarder({
        layout,
        current,
        previousPending,
        prepared,
        releaseDirExisted,
      }),
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

// [失败路径] 远端 manifest 复用带 10 秒超时的 JSON 下载器，避免服务端无响应时长时间挂起。
// [契约] manifest 的 target 必须与目标一致，不一致立即抛错，不做跨平台降级。
// [事务] 组件是否变更要同时比对摘要与 paths 序列；摘要相同但路径变化仍需重装。
// [失败路径] 缺 archiveUrl 或 archiveSha256 时返回 null，把能否继续的决定权交回整包路径。
// [资源] 临时目录前缀为 zcode-server-components-，与整包临时目录完全分离。
// [事务] 组装以 current.releaseDir 为基线，输出到新的 releaseId 目录，基线目录始终不被改写。
// [顺序] 先 assemble 再 writePending；指针落盘即代表产物已经可用。
async function prepareComponentUpdate(input: {
  layout: ServerLayout;
  target: ReturnType<typeof currentServerTarget>;
  release: NonNullable<Awaited<ReturnType<typeof fetchReleaseCatalog>>["releases"][number]>;
  manifestUrl: string;
  current: NonNullable<Awaited<ReturnType<ReleaseManager["readCurrent"]>>>;
}): Promise<{
  layout: ServerLayout;
  current: ReleaseManifest;
  previousPending: ReleaseManifest | null;
  prepared: ReleaseManifest;
  releaseDirExisted: boolean;
} | null> {
  // 组件增量更新的 manifest 请求原来没有应用层 AbortSignal，服务端无响应时
  // 会等到 undici 默认边界（约数分钟）。复用带超时的 JSON 下载器，和 catalog 行为一致。
  const remoteManifest = await fetchReleaseJson(
    input.manifestUrl,
    serverRuntimeManifestSchema,
    10_000,
    "Runtime manifest",
  );
  if (remoteManifest.target !== input.target) {
    throw new Error(`Runtime manifest target mismatch: ${remoteManifest.target}`);
  }
  const currentComponents = new Map(
    (input.current.components ?? []).map((component) => [component.id, component]),
  );
  if (!remoteManifest.components) return null;
  const changed: Array<{ componentId: string; sha256: string; archivePath: string }> = [];
  const temporaryDir = await mkdtemp(join(tmpdir(), "zcode-server-components-"));
  const cache = new ComponentCache(input.layout);
  try {
    for (const component of input.release.components ?? []) {
      const currentComponent = currentComponents.get(component.id);
      const remoteComponent = remoteManifest.components.find(
        (candidate) => candidate.id === component.id,
      );
      const pathsUnchanged = currentComponent && remoteComponent
        ? currentComponent.paths.length === remoteComponent.paths.length &&
          currentComponent.paths.every((path, index) => path === remoteComponent.paths[index])
        : false;
      if (currentComponent?.sha256 === component.sha256 && pathsUnchanged) continue;
      if (!component.archiveUrl || !component.archiveSha256) return null;
      const extension = component.archiveUrl.toLowerCase().endsWith(".zip") ? "zip" : "tar.gz";
      const cachedArchive = await cache.findArchive({
        target: input.target,
        componentId: component.id,
        sha256: component.sha256,
        extension,
      });
      const cached = cachedArchive ?? await downloadComponent({
        cache,
        component,
        extension,
        target: input.target,
        temporaryDir,
      });
      changed.push({ componentId: component.id, sha256: component.sha256, archivePath: cached });
    }
    const releaseId = `${input.release.version}-${input.target}-${input.release.archiveSha256.slice(0, 12)}`;
    const releaseDir = join(input.layout.releasesDir, releaseId);
    const releaseDirExisted = await pathExists(releaseDir);
    const releaseManager = new ReleaseManager(input.layout);
    const previousPending = await releaseManager.readPending();
    await cache.assemble({
      target: input.target,
      archiveSha256: input.release.archiveSha256,
      baseReleaseDir: input.current.releaseDir,
      releaseDir,
      runtimeManifest: remoteManifest,
      baseComponents: input.current.components,
      changed,
    });
    const prepared = {
      version: input.release.version,
      releaseDir,
      releaseId,
      appVersion: input.release.appVersion ?? input.release.version,
      target: input.target,
      nodeVersion: remoteManifest.nodeVersion,
      archiveSha256: input.release.archiveSha256,
      components: remoteManifest.components,
    } satisfies ReleaseManifest;
    await releaseManager.writePending(prepared);
    return {
      layout: input.layout,
      current: input.current,
      previousPending,
      prepared,
      releaseDirExisted,
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

// [失败路径] 入口再次校验归档来源，与调用方的 null 判断形成双保险，防止绕过。
// [契约] 归档文件名固定为组件 id 加扩展名，id 的字符合法性已在缓存层校验。
// [事务] 下载时携带 archiveSha256，摘要不符会在写入缓存之前就失败。
// [资源] 下载先落到临时目录，再由缓存层用临时名、校验与原子改名收尾。
// [契约] putArchive 返回缓存内的最终路径，changed 列表必须用该路径而不是临时路径。
// [并发] 同摘要的并发下载各持独立临时文件，改名覆盖为最后写入者胜出。
// [权衡] 这里不做重试，失败直接上抛；重试属于命令层策略，避免嵌套多重试放大流量。
async function downloadComponent(input: {
  cache: ComponentCache;
  component: NonNullable<Awaited<ReturnType<typeof fetchReleaseCatalog>>["releases"][number]["components"]>[number];
  extension: string;
  target: ReturnType<typeof currentServerTarget>;
  temporaryDir: string;
}): Promise<string> {
  if (!input.component.archiveUrl || !input.component.archiveSha256) {
    throw new Error(`Component ${input.component.id} has no archive source`);
  }
  const archivePath = join(input.temporaryDir, `${input.component.id}.${input.extension}`);
  await new ReleaseDownloader().download({
    url: input.component.archiveUrl,
    destination: archivePath,
    sha256: input.component.archiveSha256,
  });
  return await input.cache.putArchive({
    target: input.target,
    componentId: input.component.id,
    sha256: input.component.sha256,
    archivePath,
    archiveSha256: input.component.archiveSha256,
  });
}
