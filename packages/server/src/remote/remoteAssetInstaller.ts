// packages/server/src/remote/remoteAssetInstaller.ts —— 远端资源安装策略
//
// 职责边界：
//   - 提供两种安装模式：local-download-upload（本地取包再上传）与 remote-download（远端直接下载）。
//   - RemoteAssetInstaller 只负责把制品放到远端目标路径，部署顺序与服务重启由调用方决定，业务状态不归本模块维护。
//   - 生成的全部命令都是 POSIX shell，经 SSH backend 执行；本文件不感知平台差异。
//   - 失败语义是本次 owner 的 staging 清干净且正式目录保持不动，跨进程补偿交给上层。
//   - 不写日志文件，只通过 DeployLoggers 输出结构化诊断。
//
// 不变量（INV）：
//   INV-01 所有远端临时路径必须带 owner 后缀（时间戳加 UUID），禁止固定 .new（installFile/installDirectory）——固定名会让并发部署互相覆盖 staging。
//   INV-02 取消后不得复用旧 backend 做清理（signal.aborted 判断）——SSH backend 已释放，旧凭据重连会挂起或误删。
//   INV-03 失败清理只删本次 owner 路径（cleanupRemoteStaging）——扩大匹配面会误删并发部署的正常 staging。
//   INV-04 所有路径与参数都经 quotePosixPathArg/quotePosixShellArg 转义——裸插值遇到空格或单引号会截断命令。
//   INV-05 每个候选 URL 的下载尝试内都要校验 sha（buildRemoteArtifactDownloadAttempt）——只在末尾统一校验会让 CDN 不一致时无法换源。
//   INV-06 校验失败必须先 rm -f 输出文件——残留的坏文件会被下一次尝试误判为成功。
//   INV-07 supportsProgress 为 false 时直接返回原命令——包一层会强加 awk/date 依赖。
//   INV-08 进度循环必须 kill 并 wait，再补打一次终值——不 kill 会留下后台进程，不补打会丢最后一段进度。
//   INV-09 normalizeTotalBytes 对非有限值与小于等于 0 返回 null——返回 0 会让 awk 除零。
//   INV-10 buildRemoteChecksumCommand 的三个分支对应不同输出格式——混用会把文件名当成摘要。
//   INV-11 forceRefresh 命中 .ready 必须先删 cache，不能提前返回（ensureComponentInternal）——否则强制部署拿到旧制品。
//   INV-12 同一 installer 生命周期内 forceRefresh 只执行一次（forceRefreshComponentTasks）——每次绕过 task 会重复删除并下载同一组件。
//   INV-13 组件 task 失败时按 task 身份删除缓存条目（ensureComponent）——无脑 delete 会删掉后来者的新 task。
//   INV-14 完整性检查只在 fromCache 时触发重下（ensureComponentHasRequiredPaths）——刚下载的组件再查会重复删除。
//   INV-15 manifest 锁的 key 覆盖 version/platformArch/timeout/CDN 列表（fetchRemoteDownloadManifest）——少一个维度会复用错误的 manifest。
//   INV-16 manifest 锁在 finally 里按 task 身份删除——直接 delete 会误删后来者的锁。
//   INV-17 本地 tar 必须在 finally 里 unlink（installDirectory）——失败路径否则会持续堆积临时文件。
//   INV-18 远端脚本逐行执行，不能合并成 && 链（ensureComponentInternal 的 command）——分号与 trap 会让失败被后续清理的成功码覆盖。
//   INV-19 .ready 写在解压目录内再整体 move（ensureComponentInternal）——先 move 后写会暴露半成品目录。
//   INV-20 下载锁依赖 mkdir 的原子性加 30 秒心跳，10 分钟无心跳才判过期——纯 sleep 轮询会永久等待。
//   INV-21 内容寻址组件用 sha256 作 cache 段，其余用语义版本——统一用版本会把旧内容当成命中。
//   INV-22 quoteSafeSegment 用白名单替换且结果不能含斜杠——否则 cache 路径会逃逸出前缀。
//   INV-23 HEAD 只服务进度统计，失败不得阻断下载（resolveRemoteArtifactContentLength）——当成必需会让无 content-length 的 CDN 无法安装。
/* eslint-disable max-lines -- 远端资源安装策略同时承载本地上传和远端下载，后续稳定后再拆分。 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import type { RemoteAssetInstallMode } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  createRemoteAssetPlaceholderError,
  fileExists,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";
import {
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  ensureRemoteReleaseDirFromCdn,
  buildRemoteAssetManifestFileCandidates,
  createRemoteAssetManifestRequestSignal,
  parseRemoteAssetManifestFromResponse,
  resolveRemoteAssetComponentCacheVersion,
  selectRemoteAssetManifestComponents,
  usesRemoteAssetContentAddressedCacheIdentity,
  type RemoteAssetManifest,
  type RemoteAssetManifestComponent,
  type RemoteAssetManifestRef,
} from "@zcode/server/remote/remoteAssetCache.js";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import type {
  RemoteAssetTools,
  RemoteDownloadTool,
  RemoteSha256Tool,
} from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";

// 安装器接口由两种实现共用，调用方按 mode 选择。
// resolveComponentVersion/Sha256 是可选的：本地上传模式可能直接从 manifest 读。
// [契约] installFile/installDirectory 的返回即「已就位」，不返回远端路径。
// 新增方法要考虑两种实现的语义差异，不能只在一种里实现。
export interface RemoteAssetInstaller {
  // mode 是部署层选择实现的唯一依据，也是日志里的模式标记。
  // local-download-upload 与 remote-download 的资源来源不同，但目标路径语义一致。
  // [契约] 不要用 mode 做业务分支，它只描述取包方式。
  readonly mode: RemoteAssetInstallMode;
  resolveComponentVersion?(componentId: string): Promise<string | null>;
  resolveComponentSha256?(componentId: string): Promise<string | null>;
  installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void>;
  installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void>;
}

// 取消检查的唯一入口，所有远端写操作前后都要经过它。
// signal 为空视为未启用取消，直接返回。
// [失败路径] 抛出原始 reason 而不是新错误，是为了保留取消来源的诊断信息。
// 没有 reason 时构造 name 为 AbortError 的错误，便于上层按名字分流。
function throwIfRemoteAssetInstallAborted(signal: AbortSignal | undefined): void {
  // 未取消时正常返回，不产生任何副作用。
  // [并发] 这个函数可能被高频调用，必须保持无分配（未取消路径不新建对象）。
  // 把判断反过来写会让正常路径也抛错。
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Remote asset installation canceled");
  error.name = "AbortError";
  throw error;
}

// 生成「回收陈旧 staging」的 shell 片段，只在启用取消时拼接。
// 模式必须带 owner 前缀，find 只删除 mtime 超过一天的候选。
// [资源] 这一步是取消后无法立即清理的兜底，避免 staging 永久堆积。
// [失败路径] 匹配面过宽会删掉其他 owner 正在用的目录，因此末尾固定加 || true。
function buildStaleRemoteStagingCleanupCommand(parentDir: string, patterns: string[]): string {
  const quotedParentDir = quotePosixPathArg(parentDir);
  const candidateExpressions = patterns.map((pattern) => {
    const literalPrefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    return `${quotedParentDir}/${quotePosixShellArg(literalPrefix)}*`;
  });
  return [
    `for candidate in ${candidateExpressions.join(" ")}; do`,
    'test -e "$candidate" || continue',
    // SSH 取消会先释放旧 backend，不能再用旧凭据立即 cleanup。
    // 新连接只回收超过 24 小时的 ZCode owner staging，避免误删当前 owner 或正常时长内的活跃部署。
    'find "$candidate" -prune -mtime +0 -exec rm -rf {} + 2>/dev/null || true',
    "done",
  ].join("\n");
}

// 把多个候选 URL 拼成「逐个尝试」的下载命令。
// 每个候选都自带校验块，失败后由 || 继续下一个源。
// [契约] 返回的命令必须在 set -e 下可用，失败时以非零退出。
// 进度包装统一由 buildRemoteArtifactDownloadCommand 在外层完成，避免每个候选各自实现一份。
export function buildRemoteArtifactDownloadCommand(params: {
  tool: RemoteDownloadTool;
  urls: string[];
  outputPath: string;
  progressLabel: string;
  totalBytes?: number | null;
  expectedSha256?: string;
  sha256Tool?: RemoteSha256Tool;
  supportsProgress?: boolean;
}): string {
  // 只有同时提供 sha256 与校验工具时才启用校验。
  // expectedSha256 或 sha256Tool 缺任一项就退化为只下载不校验，而不是报错。
  // [权衡] 这让老版本远端工具链仍可部署，代价是失去完整性保证。
  const shouldVerifyChecksum =
    typeof params.expectedSha256 === "string" &&
    params.expectedSha256.length > 0 &&
    typeof params.sha256Tool === "string";
  // 每个 URL 生成一个独立尝试块，顺序即 CDN 优先级。
  // curl 与 wget 分支的命令参数不同，但输出路径与校验逻辑一致。
  // [失败路径] 空 URL 列表会生成空尝试集合，外层 join 后得到非法命令。
  const attempts = params.urls.map((url) => {
    const quotedOutputPath = quotePosixPathArg(params.outputPath);
    if (params.tool === "curl") {
      return buildRemoteArtifactDownloadAttempt({
        downloadCommand: `curl -fL --retry 2 --connect-timeout 20 -o ${quotedOutputPath} ${quotePosixPathArg(url)}`,
        outputPath: params.outputPath,
        progressLabel: params.progressLabel,
        expectedSha256: shouldVerifyChecksum ? params.expectedSha256 : undefined,
        sha256Tool: shouldVerifyChecksum ? params.sha256Tool : undefined,
      });
    }
    return buildRemoteArtifactDownloadAttempt({
      downloadCommand: `wget --tries=3 --timeout=20 -O ${quotedOutputPath} ${quotePosixPathArg(url)}`,
      outputPath: params.outputPath,
      progressLabel: params.progressLabel,
      expectedSha256: shouldVerifyChecksum ? params.expectedSha256 : undefined,
      sha256Tool: shouldVerifyChecksum ? params.sha256Tool : undefined,
    });
  });
  return buildRemoteDownloadWithProgressCommand({
    attemptCommand: attempts.map((attempt) => `(${attempt})`).join(" || "),
    outputPath: params.outputPath,
    progressLabel: params.progressLabel,
    totalBytes: params.totalBytes,
    supportsProgress: params.supportsProgress !== false,
  });
}

// 单个候选的下载加校验原子块。
// 没有校验信息时直接返回原始下载命令。
// [契约] 校验失败必须让整块以非零退出，才能触发下一个候选。
function buildRemoteArtifactDownloadAttempt(params: {
  downloadCommand: string;
  outputPath: string;
  progressLabel: string;
  expectedSha256?: string;
  sha256Tool?: RemoteSha256Tool;
}): string {
  if (!params.expectedSha256 || !params.sha256Tool) {
    return params.downloadCommand;
  }

  // buildRemoteChecksumCommand 按远端工具能力生成摘要命令，输出只保留哈希值。
  // 不同工具的输出格式差异被封装在 buildRemoteChecksumCommand 内。
  // [契约] 调用方只比较 expectedSha256 与输出字符串，不解析输出。
  const checksumCommand = buildRemoteChecksumCommand({
    tool: params.sha256Tool,
    filePath: params.outputPath,
  });
  const quotedOutputPath = quotePosixPathArg(params.outputPath);
  const quotedExpectedSha256 = quotePosixShellArg(params.expectedSha256);
  const mismatchPrefix = quotePosixShellArg(
    `[remote-assets] sha256 mismatch for ${params.progressLabel}: expected=${params.expectedSha256}, actual=`,
  );

  // 多 CDN 发布存在短暂不一致时，首个 URL 可能能下载但 sha 指向旧对象。
  // 把校验放进每个候选 URL 的尝试块里，才能在 mismatch 后继续尝试备用 CDN。
  return [
    `rm -f ${quotedOutputPath}`,
    params.downloadCommand,
    `actual_sha=$(${checksumCommand})`,
    `if [ "$actual_sha" = ${quotedExpectedSha256} ]; then true; else echo ${mismatchPrefix}"$actual_sha" >&2; false; fi`,
  ].join(" && ");
}

// 在不依赖 curl/wget 自有进度条的前提下，按目标文件大小输出统一进度。
// 进度由后台循环每秒采样一次文件字节数，awk 计算百分比与速度。
// [权衡] 采样间隔 1 秒，对大文件足够，对极小文件会多打一行。
// 失败时必须停掉后台循环，否则调用方已经退出而子进程仍在跑。
function buildRemoteDownloadWithProgressCommand(params: {
  attemptCommand: string;
  outputPath: string;
  progressLabel: string;
  totalBytes?: number | null;
  supportsProgress: boolean;
}): string {
  // 远端工具不支持时直接透传，不引入 awk/date 依赖。
  // [契约] quotePosixPathArg 原样返回输入字符串而不做拼接，避免额外转义。
  // 这个可测试性分支由 supportsProgress 参数触发，不要为了统一路径而删除。
  if (!params.supportsProgress) return params.attemptCommand;
  const quotedOutputPath = quotePosixPathArg(params.outputPath);
  const quotedProgressLabel = quotePosixShellArg(params.progressLabel);
  // 总字节数先归一化，未知时进度输出省略百分比与总量。
  // 采样循环只依赖文件大小，不依赖 curl/wget 的输出格式。
  // [并发] 循环放在后台子 shell，主流程继续执行下载。
  // [失败路径] 采样失败时 progress_size 回落 0，不会中断下载。
  const totalBytes = normalizeTotalBytes(params.totalBytes);
  const progressPrinter =
    totalBytes != null
      ? `awk -v label=${quotedProgressLabel} -v bytes="$progress_size" -v total=${totalBytes} -v elapsed="$progress_elapsed" 'BEGIN { transferred = bytes / 1048576; total_mb = total / 1048576; speed = transferred / elapsed; percent = bytes / total * 100; if (percent > 100) percent = 100; printf "download progress: [%s] %.1f%% (%.1f/%.1f MB, %.2f MB/s)\\n", label, percent, transferred, total_mb, speed; fflush(); }'`
      : `awk -v label=${quotedProgressLabel} -v bytes="$progress_size" -v elapsed="$progress_elapsed" 'BEGIN { transferred = bytes / 1048576; speed = transferred / elapsed; printf "download progress: [%s] %.1f MB (total unknown, %.2f MB/s)\\n", label, transferred, speed; fflush(); }'`;
  const updateProgressVars = `if [ -f ${quotedOutputPath} ]; then progress_size=$(wc -c < ${quotedOutputPath} 2>/dev/null || printf 0); else progress_size=0; fi; progress_now=$(date +%s); progress_elapsed=$((progress_now - progress_started_at)); if [ "$progress_elapsed" -le 0 ]; then progress_elapsed=1; fi`;
  const progressLoop = `progress_started_at=$(date +%s); progress_pid=; (last_progress_size=-1; while :; do ${updateProgressVars}; if [ "$progress_size" != "$last_progress_size" ]; then ${progressPrinter}; last_progress_size="$progress_size"; fi; sleep 1; done) & progress_pid=$!`;
  const stopProgressLoop = `if [ -n "$progress_pid" ]; then kill "$progress_pid" >/dev/null 2>&1 || true; wait "$progress_pid" 2>/dev/null || true; fi; if [ -f ${quotedOutputPath} ]; then ${updateProgressVars}; ${progressPrinter}; fi`;

  // 远端服务器下载以前只等 wget/curl 结束，连接窗口没有速度和进度反馈。
  // 这里不依赖 wget/curl 各自不稳定的进度条，而是在远端按目标文件大小节流输出统一格式，
  // 连接窗口可以复用现有 download progress 合并逻辑展示最新速度。
  // 先关 set -e 再执行下载，是为了让失败码能被捕获并继续清理。
  // 清理后重新开 set -e，并用 test 把真实状态码还原给调用方。
  // [失败路径] 若直接让 set -e 生效，下载失败会跳过停止循环，留下后台进程。
  // [契约] 五个步骤必须按启动→执行→取码→停止→判定的顺序执行，改动顺序会让 download_status 失真。
  return `set +e; ${progressLoop}; ${params.attemptCommand}; download_status=$?; set -e; ${stopProgressLoop}; test "$download_status" -eq 0`;
}

// 把可选的总字节数收敛成「正数或 null」。
// 非数字、NaN、Infinity 与小于等于 0 都视为未知。
// [失败路径] 放行 0 会让 awk 计算百分比时除零，进度输出变成 nan。
function normalizeTotalBytes(totalBytes: number | null | undefined): number | null {
  if (typeof totalBytes !== "number" || !Number.isFinite(totalBytes)) {
    return null;
  }
  const normalized = Math.floor(totalBytes);
  return normalized > 0 ? normalized : null;
}

// 三种工具的输出格式不同：前两者是「哈希 文件名」，openssl 是「SHA256(文件)= 哈希」。
// 因此截取路径前缀与文件名时分别用 shell 的百分号与井号参数展开算子。
// [契约] 返回的片段必须只输出哈希，不输出换行以外的内容。
// [失败路径] 用错截取方向会把文件名当摘要，校验永久失败。
export function buildRemoteChecksumCommand(params: {
  tool: RemoteSha256Tool;
  filePath: string;
}): string {
  const file = quotePosixPathArg(params.filePath);
  if (params.tool === "sha256sum") {
    return `checksum_output=$(sha256sum ${file}) && printf '%s' "\${checksum_output%% *}"`;
  }
  if (params.tool === "shasum") {
    return `checksum_output=$(shasum -a 256 ${file}) && printf '%s' "\${checksum_output%% *}"`;
  }
  return `checksum_output=$(openssl dgst -sha256 ${file}) && printf '%s' "\${checksum_output##* }"`;
}

// 本地上传模式：本地解析制品路径，再经 backend.upload 推到远端。
// 它需要 backend 的 upload 能力，因此依赖 SSH 连接。
// [契约] 本地 cache 可以共享，但远端 staging 必须按 owner 隔离。
// 构造参数包含 signal，取消检查贯穿取包与上传两段。
export class LocalUploadAssetInstaller implements RemoteAssetInstaller {
  // 模式标识用 as const 保留字面量类型，供部署层做穷尽判断。
  // 它与 RemoteAssetInstaller.mode 的联合类型一一对应。
  // [契约] 不要改成字符串变量，否则类型收窄失效。
  readonly mode = "local-download-upload" as const;

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteAssetDeployOptions & {
      platformArch?: string;
      version?: string;
    },
    private readonly loggers: DeployLoggers,
  ) {}

  // 版本优先取本地 manifest，取不到返回 null 而不是抛错。
  // 调用方用 null 表示「无法确定版本」，自行决定降级策略。
  // [契约] 这里不触发下载，只读缓存文件。
  async resolveComponentVersion(componentId: string): Promise<string | null> {
    return (await this.resolveManifestComponent(componentId))?.version ?? null;
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    const resolvedSha256 = await this.options.resolveComponentSha256?.(componentId);
    if (resolvedSha256) {
      return resolvedSha256;
    }
    return (await this.resolveManifestComponent(componentId))?.sha256 ?? null;
  }

  // 从 release 目录读取 manifest-平台.json，再按 componentId 选取。
  // 缺 platformArch 或 releaseDir 时返回 null，不尝试猜测路径。
  // [失败路径] JSON 解析失败也被吞掉并返回 null，避免启动期硬失败。
  // [契约] resolveManifestComponent 读取的是本地文件，不存在远端 IO。
  private async resolveManifestComponent(
    componentId: string,
  ): Promise<RemoteAssetManifestComponent | null> {
    const platformArch = this.options.platformArch?.trim();
    const releaseDir =
      this.options.releaseDir?.trim() ??
      (await this.options.resolveReleaseDir?.([componentId]))?.trim();
    // platformArch 与 releaseDir 两个必要条件缺一就放弃解析。
    // platformArch 决定 manifest 文件名，releaseDir 决定目录。
    // [失败路径] 空字符串按缺省处理，避免拼出 /manifest-.json。
    if (!platformArch || !releaseDir) {
      return null;
    }

    try {
      const manifest = JSON.parse(
        readFileSync(join(releaseDir, `manifest-${platformArch}.json`), "utf8"),
      ) as RemoteAssetManifest;
      return selectRemoteAssetManifestComponents(manifest, [componentId])[0] ?? null;
    } catch {
      return null;
    }
  }

  // 先查本地 release 目录，缺失关键文件时再回退到 CDN 本地缓存。
  // 返回值是「可上传的本地路径」或 null，不抛错。
  // [契约] 关键文件完整性检查必须针对 requiredReleasePaths 全量比对。
  // [失败路径] 只看父目录存在会继续上传残缺插件资源。
  // 回退顺序固定：本地优先，CDN 缓存其次。
  async tryResolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string | null> {
    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      return null;
    }

    // 拼接本地路径时不做规范化，源相对路径由调用方保证无 .. 穿越。
    // exists 存在性检查与 sha256 完整性检查分两步，先便宜后昂贵。
    // [契约] 返回的路径必须仍在 releaseDir 之下。
    const localPath = join(releaseDir, sourceRelativePath);
    if (await fileExists(localPath)) {
      const missingRequiredPaths = await findMissingLocalRequiredReleasePaths(
        releaseDir,
        requiredReleasePaths,
      );
      if (missingRequiredPaths.length === 0) {
        return localPath;
      }
      // 旧 cache 可能已经有 packages 父目录，但缺少本次部署要求的 plugin.json。
      // 这里不能只看父目录存在，否则会继续上传残缺官方插件资源。
      this.loggers.logWarn(
        `[remote-assets] local release asset incomplete: source=${JSON.stringify(localPath)} missing=${missingRequiredPaths.join(",")}; trying CDN cache fallback`,
      );
    }

    const cdnReleaseDir = await this.tryResolveCdnReleaseDir(
      componentIds,
      requiredReleasePaths,
      forceRefresh,
    );
    if (!cdnReleaseDir) {
      return null;
    }
    const cdnLocalPath = join(cdnReleaseDir, sourceRelativePath);
    if (!(await fileExists(cdnLocalPath))) {
      return null;
    }
    const missingCdnRequiredPaths = await findMissingLocalRequiredReleasePaths(
      cdnReleaseDir,
      requiredReleasePaths,
    );
    if (missingCdnRequiredPaths.length > 0) {
      this.loggers.logWarn(
        `[remote-assets] CDN release asset incomplete: source=${cdnLocalPath} missing=${missingCdnRequiredPaths.join(",")}`,
      );
      return null;
    }
    return cdnLocalPath;
  }

  // resolveLocalPath 严格版拿不到就直接抛错，供 install 路径使用。
  // 错误分两种：无 release 目录时给占位提示，有目录但缺文件时给具体路径。
  // [失败路径] 占位错误提示引导用户先完成资源准备，而不是重试部署。
  // [契约] 不得在此静默返回空字符串。
  async resolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string> {
    const localPath = await this.tryResolveLocalPath(
      componentIds,
      sourceRelativePath,
      requiredReleasePaths,
      forceRefresh,
    );
    if (localPath) {
      return localPath;
    }

    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      // release 目录整体缺失说明资源尚未准备，用占位错误统一暴露。
      // createRemoteAssetPlaceholderError 的错误里带 platformArch 与组件列表，便于用户对照下载。
      // [契约] RemoteAssetPlaceholderError 由上层识别并转成可读提示。
      throw createRemoteAssetPlaceholderError(
        this.options.platformArch ?? "<unknown>",
        this.options,
        componentIds.join(","),
      );
    }
    throw new Error(
      `[deploy] local remote asset not found: ${join(releaseDir, sourceRelativePath)} (component=${componentIds.join(",")})`,
    );
  }

  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    // 解析本身可能触发 CDN 回退或抛占位错误。
    // 这一步没有远端副作用，因此 abort 只在上传前生效。
    // [契约] 返回路径一定可读，不需要二次 stat。
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      undefined,
      Boolean(params.forceRefresh),
    );
    // 共享本地 cache 可以在取消后完成，但不得让迟到 continuation 再写远端 staging。
    throwIfRemoteAssetInstallAborted(this.options.signal);
    // 多个 Desktop 实例或跨窗口连接可能同时部署到同一 distro/user。
    // 固定 `.new` 会互相覆盖 staging 文件，唯一 owner 路径保证失败清理和最终 rename 不串写。
    // owner staging 名由目标名加时间戳加 UUID 组成，保证全局唯一。
    // [并发] 固定 .new 会互相覆盖，且失败清理无法区分归属。
    // [契约] 该路径只用于上传与 rename，绝不直接作为最终目标。
    // 时间戳让陈旧清理可以按 mtime 判断，UUID 防同毫秒碰撞。
    const tempRemotePath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    this.loggers.log(
      `[remote-assets] uploading ${params.sourceRelativePath} to ${JSON.stringify(params.remotePath)}`,
    );
    const remoteParentDir = posix.dirname(params.remotePath);
    // 只删除本次 owner 的 staging 文件，命令里写死具体路径。
    // 清理失败只记 warn，不覆盖原始错误。
    // [失败路径] 清理异常若向上抛，会掩盖真正的部署失败原因。
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(`rm -f ${quotePosixPathArg(tempRemotePath)}`);
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned file staging ${tempRemotePath}: ${String(error)}`,
        );
      }
    };

    try {
      // 准备步骤可选包含陈旧 staging 回收，再加 mkdir。
      // 回收只在启用取消时拼接，因为它需要 find 与 mtime。
      // [契约] mkdir 必须在最后，保证父目录存在后上传才可能成功。
      // 两条命令以换行连接，逐行执行，任一条失败不会静默继续。
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${posix.basename(params.remotePath)}.new-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      // 上传直接写 staging 路径，信号透传给传输层以便中途取消。
      // [资源] 传输失败时远端可能留下部分文件，由清理分支负责删除。
      // [契约] 上传完成不代表就位，必须再走一次原子替换。
      await this.backend.upload(localPath, tempRemotePath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      const stream = await this.backend.exec(
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempRemotePath, params.remotePath)
          : buildRemoteMoveCommand(tempRemotePath, params.remotePath),
      );
      await waitForClose(stream);
    } catch (error) {
      // 文件替换失败时必须清理当前 owner 的 `.new-*` 文件，否则
      // Docker 非 root 场景会把 chmod 失败的宿主 owner 文件长期留在远端。
      // 取消路径可能已经释放 backend，不能用旧凭据再次 cleanup；由后续 janitor 回收。
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    }
  }

  async installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      buildRequiredReleasePaths(params.sourceRelativePath, params.requiredRelativePaths),
      Boolean(params.forceRefresh),
    );
    // 本地归档名由 componentId 与时间戳拼接而成，避免并行部署冲突。
    // 放在系统临时目录，不写入 release 目录以免污染制品。
    // [契约] 该文件只在本次调用内有意义，结束后必须删除。
    const localTarPath = join(
      tmpdir(),
      `zcode-remote-${params.componentId}-${Date.now()}-${randomUUID()}.tar.gz`,
    );
    await createTarGzArchive(localTarPath, [
      { sourcePath: localPath, archivePath: basename(localPath) },
    ]);

    // 单一 owner 后缀同时用于 tar 与 extract 两个路径，便于一起清理。
    // 用同一个后缀而不是各自生成，保证清理命令可以精确覆盖两者。
    // [契约] ownerSuffix 后缀不得包含斜杠或空格。
    const ownerSuffix = `${Date.now()}-${randomUUID()}`;
    // 目录上传曾复用 `<remoteDir>.tar.gz`，并发部署会互相覆盖压缩包，
    // 甚至把半写文件解压到最终目录。archive/extract 都带 owner，失败时也只清理自己的 staging。
    // 压缩包放在 remoteDir 同级的带后缀路径，避免写入目标目录内部。
    // [并发] 复用固定的 tar.gz 名会让并发部署互相覆盖压缩包。
    // [失败路径] 半写压缩包被解压会产生残缺目录，因此必须 owner 隔离。
    const remoteTarPath = `${params.remoteDir}.tar.gz-${ownerSuffix}`;
    // 解压到独立 staging 目录，成功后再整体 move 到目标。
    // 这保证目标目录要么是旧的完整版本，要么是新的完整版本。
    // [契约] 解压目录不能被其他 owner 复用。
    const remoteExtractDir = `${params.remoteDir}.extract-${ownerSuffix}`;
    const extractedSourceDir = `${remoteExtractDir}/${basename(localPath)}`;
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(
          `rm -f ${quotePosixPathArg(remoteTarPath)} && rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
        );
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned directory staging ${ownerSuffix}: ${String(error)}`,
        );
      }
    };

    try {
      // 本地归档不共享远端生命周期；归档完成后再次检查，禁止取消后创建远端 staging。
      throwIfRemoteAssetInstallAborted(this.options.signal);
      this.loggers.log(
        `[remote-assets] uploading ${params.sourceRelativePath} to ${JSON.stringify(params.remoteDir)}`,
      );
      const remoteParentDir = posix.dirname(params.remoteDir);
      const remoteDirName = posix.basename(params.remoteDir);
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${remoteDirName}.tar.gz-*`,
                `${remoteDirName}.extract-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      await this.backend.upload(localTarPath, remoteTarPath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      const stream = await this.backend.exec(
        [
          "set -eu",
          `cleanup_staging() { rm -f ${quotePosixPathArg(remoteTarPath)}; rm -rf ${quotePosixPathArg(remoteExtractDir)}; }`,
          "trap cleanup_staging EXIT HUP INT TERM",
          `rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
          `mkdir -p ${quotePosixPathArg(remoteExtractDir)} ${quotePosixPathArg(posix.dirname(params.remoteDir))}`,
          `tar -xzf ${quotePosixPathArg(remoteTarPath)} -C ${quotePosixPathArg(remoteExtractDir)}`,
          `test -d ${quotePosixPathArg(extractedSourceDir)}`,
          `rm -rf ${quotePosixPathArg(params.remoteDir)}`,
          buildRemoteMoveCommand(extractedSourceDir, params.remoteDir),
          "cleanup_staging",
          "trap - EXIT HUP INT TERM",
        ].join("\n"),
      );
      await waitForClose(stream);
    } catch (error) {
      // 连接取消监听会先释放 SSH backend；若随后仍用同一 backend 清理 staging，
      // SSH 实现可能以旧凭据重新连接。取消路径只保留唯一 owner staging，不再触碰正式目录。
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    } finally {
      try {
        unlinkSync(localTarPath);
      } catch {
        // 忽略临时文件清理失败，部署结果不应受本地清理影响。
      }
    }
  }

  // 本地资源缺失时的 CDN 缓存回退，只有配置齐全才尝试。
  // 缺少 platformArch、version、remoteCacheDir 或 CDN 地址时返回 null。
  // [契约] 该函数不抛错，除非 forceRefresh 明确要求。
  // [权衡] 回退是为了兼容「先 remote-download 后切回 local-download-upload」的使用序列。
  private async tryResolveCdnReleaseDir(
    componentIds: string[],
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string | null> {
    const platformArch = this.options.platformArch?.trim();
    const version = this.options.version?.trim();
    if (!platformArch || !version || !this.options.remoteCacheDir) {
      return null;
    }

    // 单个基址与基址列表任一非空即视为配置了 CDN。
    // 空白字符串按未配置处理，避免拼出非法 URL。
    // [契约] hasRemoteCdnBase 只看配置，不发探测请求。
    const hasRemoteCdnBase =
      Boolean(this.options.remoteCdnBaseUrl?.trim()) ||
      (this.options.remoteCdnBaseUrls?.some((url) => url.trim().length > 0) ?? false);
    if (!hasRemoteCdnBase) {
      return null;
    }

    try {
      // 开发态默认优先 mock-cdn；但用户可先用远端下载再切回本地上传，
      // 此时 mock-cdn 可能没有对应平台/provider 资源。本地上传语义是“本地拿到资源后上传”，
      // 因此缺本地伪 CDN 文件时应回落到真实 CDN 的本地缓存，而不是直接报缺包。
      // 委托给 CDN 缓存层完成下载与解压，本文件只负责转发参数。
      // forceRefresh 会透传，决定是否跳过已有缓存。
      // [契约] 失败时的处理策略由外层 catch 决定，这里不吞错。
      // manifest 超时参数同样透传，保持两层超时语义一致。
      return await ensureRemoteReleaseDirFromCdn(
        {
          remoteCdnBaseUrl: this.options.remoteCdnBaseUrl,
          remoteCdnBaseUrls: this.options.remoteCdnBaseUrls,
          remoteCacheDir: this.options.remoteCacheDir,
          version,
          platformArch,
          componentIds,
          requiredReleasePaths,
          manifestRequestTimeoutMs: this.options.manifestRequestTimeoutMs,
          remoteAssetNetwork: this.options.remoteAssetNetwork,
          forceRefresh,
        },
        this.loggers,
      );
    } catch (error) {
      this.loggers.logWarn(
        `[remote-assets] local upload CDN fallback failed for ${componentIds.join(",")}: ${String(error)}`,
      );
      // App 版本变化时必须重新获取当前 manifest 对应的 GLM 制品。
      // 强制刷新失败后若继续回退旧 cache，会让上传和部署表面成功但远端仍运行旧资源。
      // 强制刷新失败必须向上抛，不能回退旧 cache。
      // [失败路径] 回退会让上传与部署表面成功，远端仍运行旧资源。
      // 非强制时失败只记 warn 并返回 null，交由调用方继续降级。
      if (forceRefresh) {
        throw error;
      }
      return null;
    }
  }
}

// buildRequiredReleasePaths 把 sourceRelativePath 与 requiredRelativePaths 合并成完整性检查清单。
// 两端斜杠在 normalize 之前先归一化，空路径被忽略。
// [契约] sourceRelativePath 本身总是清单第一项。
// 子路径用 posix.join 拼接，保证远端路径语义。
function buildRequiredReleasePaths(
  sourceRelativePath: string,
  requiredRelativePaths: readonly string[] | undefined,
): string[] {
  const sourcePath = sourceRelativePath.replace(/^\/+|\/+$/gu, "");
  if (!sourcePath) {
    return [];
  }

  const paths = [sourcePath];
  for (const requiredRelativePath of requiredRelativePaths ?? []) {
    const normalizedRequiredPath = requiredRelativePath.replace(/^\/+|\/+$/gu, "");
    if (normalizedRequiredPath) {
      paths.push(posix.join(sourcePath, normalizedRequiredPath));
    }
  }
  return paths;
}

// 逐个检查清单中的路径是否存在，返回缺失的绝对路径。
// 只读检查，不创建也不修复。
// [契约] 返回空数组表示完整，调用方据此决定是否回退。
async function findMissingLocalRequiredReleasePaths(
  releaseDir: string,
  requiredReleasePaths: readonly string[] | undefined,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const requiredReleasePath of requiredReleasePaths ?? []) {
    const absolutePath = join(releaseDir, requiredReleasePath);
    if (!(await fileExists(absolutePath))) {
      missingPaths.push(absolutePath);
    }
  }
  return missingPaths;
}

export type RemoteManifestRef = RemoteAssetManifestRef;

// remoteDownloadManifestLocks 是进程内 manifest 请求去重表，key 取版本与平台与超时与 CDN 基址。
// [并发] 同一 key 的并发调用共享同一个 Promise，避免重复下载 manifest。
// [资源] 表项在请求结束后删除，不会长期持有。
// 这张表是进程内锁，不跨进程也不跨 CLI 重启。
const remoteDownloadManifestLocks = new Map<string, Promise<RemoteManifestRef>>();

export type RemoteDownloadAssetInstallerOptions = RemoteAssetDeployOptions & {
  version: string;
  platformArch: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteAssetNetwork?: RemoteAssetNetworkPort;
};

// 组件引用的内部形状：manifest 条目、远端目录与是否来自缓存。
// fromCache 决定完整性检查失败时是否允许重下。
// [契约] componentDir 是最终目录，不含 staging 后缀。
interface RemoteComponentRef {
  component: RemoteAssetManifestComponent;
  componentDir: string;
  fromCache: boolean;
}

// 远端下载模式：制品直接从 CDN 落到远端 cache，再复制到目标。
// 它不需要本地文件，因此不依赖 upload 能力。
// manifest 在构造时启动，后续调用共享同一个 Promise。
// [契约] 组件下载按 componentId 去重，同一组件只下一次。
export class RemoteDownloadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "remote-download" as const;
  // manifest 是构造期就发起的单次请求，失败会被所有调用方看到。
  // 它不可重置：换版本需要新建 installer。
  // [失败路径] 构造后立即失败会保留 rejected Promise，后续调用不会重试。
  private readonly manifestPromise: Promise<RemoteManifestRef>;
  // 组件级去重：同一 componentId 的并发安装共享一次下载。
  // [并发] 存 Promise 而不是结果，保证后来者在下载完成前也能加入等待。
  // [契约] 失败时按 task 身份删除，允许后续重试。
  private readonly componentCache = new Map<string, Promise<RemoteComponentRef>>();
  // 强制刷新的独立缓存表，语义是「本次 installer 内只强刷一次」。
  // GLM bundle 与官方插件来自同一 component，会连续调用两次安装。
  // [失败路径] 不记录强刷 task 会导致同一制品被删除并下载两次。
  // 它与 componentCache 同步写入，读取时优先它。
  private readonly forceRefreshComponentTasks = new Map<string, Promise<RemoteComponentRef>>();

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteDownloadAssetInstallerOptions,
    private readonly tools: RemoteAssetTools,
    private readonly loggers: DeployLoggers,
    manifestPromise?: Promise<RemoteManifestRef>,
  ) {
    // 允许外部注入 manifest Promise，便于测试与多 installer 共享。
    // 缺省时才由 fetchRemoteDownloadManifest 真正发起网络请求。
    // [契约] 注入的 Promise 失败语义与自取一致。
    this.manifestPromise = manifestPromise ?? fetchRemoteDownloadManifest(options, loggers);
  }

  // 文件安装：解析本地路径，上传到 owner staging，再原子替换目标。
  // 上传前后各检查一次取消，避免迟到 continuation 继续写远端。
  // [失败路径] 替换失败时只清理本次 staging，正式文件保持原样。
  // [并发] 多个 Desktop 实例可能同时部署同一目标，因此 staging 名必须唯一。
  // executable 为 true 时额外补 chmod，替换方式不同。
  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const componentRef = await this.ensureComponent(
      params.componentId,
      [],
      Boolean(params.forceRefresh),
    );
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const sourcePath = buildRemoteComponentSourcePath(componentRef, params.sourceRelativePath);
    const tempPath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    const stream = await this.backend.exec(
      [
        `mkdir -p ${quotePosixPathArg(posix.dirname(params.remotePath))}`,
        `cp -f ${quotePosixPathArg(sourcePath)} ${quotePosixPathArg(tempPath)}`,
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempPath, params.remotePath)
          : buildRemoteMoveCommand(tempPath, params.remotePath),
      ].join(" && "),
    );
    await waitForClose(stream);
  }

  // 目录安装：本地打 tar，上传到 owner 路径，远端解压后再整体 move。
  // [资源] 本地 tar 在 finally 里删除，失败路径也不留临时文件。
  // [并发] tar 与 extract 目录都带 owner 后缀，避免互相覆盖。
  // 远端解压脚本用 trap 保证异常时清理自己的 staging。
  // 目标目录的删除与移动由部署层的 install-root 事务锁串行化。
  async installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const componentRef = await this.ensureComponent(
      params.componentId,
      params.requiredRelativePaths,
      Boolean(params.forceRefresh),
    );
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const sourcePath = buildRemoteComponentSourcePath(componentRef, params.sourceRelativePath);
    const stagingDir = `${params.remoteDir}.new-${Date.now()}-${randomUUID()}`;
    // 最终目录的 remove + move 由 deployServer 的 install-root transaction lock 串行化；
    // 这里的 UUID staging 负责隔离 owner，并让异常清理保持局部。
    // 把必需子路径编译成 test -e 检查，放在 move 之后执行。
    // 检查的是最终目录，而不是 staging，能发现 move 后仍缺文件的情况。
    // [契约] requiredRelativePaths 为空时生成空数组，命令里不出现多余检查。
    const requiredPathChecks = (params.requiredRelativePaths ?? []).map(
      (relativePath) =>
        `test -e ${quotePosixPathArg(`${params.remoteDir}/${relativePath.replace(/^\/+/u, "")}`)}`,
    );
    const stream = await this.backend.exec(
      [
        "set -eu",
        // 复制或最终替换失败时，原实现会永久遗留 `.new-*` 目录。
        // trap 仅删除本次 owner staging，不触碰其他并发部署者。
        `cleanup_staging() { rm -rf ${quotePosixPathArg(stagingDir)}; }`,
        "trap cleanup_staging EXIT HUP INT TERM",
        `rm -rf ${quotePosixPathArg(stagingDir)}`,
        `mkdir -p ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(posix.dirname(params.remoteDir))}`,
        `cp -R ${quotePosixPathArg(`${sourcePath}/.`)} ${quotePosixPathArg(stagingDir)}`,
        `rm -rf ${quotePosixPathArg(params.remoteDir)}`,
        buildRemoteMoveCommand(stagingDir, params.remoteDir),
        ...requiredPathChecks,
        "cleanup_staging",
        "trap - EXIT HUP INT TERM",
      ].join("\n"),
    );
    await waitForClose(stream);
  }

  async resolveComponentVersion(componentId: string): Promise<string | null> {
    const manifestRef = await this.manifestPromise;
    return (
      selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.version ?? null
    );
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    const manifestRef = await this.manifestPromise;
    return (
      selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ?? null
    );
  }

  // 组件获取的统一入口：命中缓存则复用，否则启动下载任务。
  // forceRefresh 走独立的表，保证同一 installer 内只强刷一次。
  // [并发] 任务先入表再 await，后来者不会重复下载。
  // [失败路径] 失败时按 task 身份清理两张表，避免删掉后来者的新任务。
  // 无论命中还是新建，返回前都要做必需路径完整性检查。
  private async ensureComponent(
    componentId: string,
    requiredRelativePaths: readonly string[] = [],
    forceRefresh = false,
  ): Promise<RemoteComponentRef> {
    // GLM bundle 与官方插件来自同一个 component，但会依次调用两次安装。
    // 强制刷新若每次都绕过进程内 task，会连续删除并下载两次同一制品；同一次 installer
    // 生命周期内只强刷一次，并让后续 mount 复用这份已校验组件。
    // forceRefresh 优先查 forceRefreshComponentTasks，否则查 componentTasks。
    // 两张表分开是为了区分 downloaded 与 force-refreshed 两种状态。
    // [契约] componentId 命中即复用，不再触发任何远端写操作。
    const existing = forceRefresh
      ? this.forceRefreshComponentTasks.get(componentId)
      : this.componentCache.get(componentId);
    if (existing) {
      const componentRef = await existing;
      return this.ensureComponentHasRequiredPaths(componentRef, requiredRelativePaths);
    }
    const task = this.ensureComponentInternal(componentId, forceRefresh);
    this.componentCache.set(componentId, task);
    if (forceRefresh) {
      this.forceRefreshComponentTasks.set(componentId, task);
    }
    try {
      const componentRef = await task;
      return this.ensureComponentHasRequiredPaths(componentRef, requiredRelativePaths);
    } catch (error) {
      if (this.componentCache.get(componentId) === task) {
        this.componentCache.delete(componentId);
      }
      if (this.forceRefreshComponentTasks.get(componentId) === task) {
        this.forceRefreshComponentTasks.delete(componentId);
      }
      throw error;
    }
  }

  // 对已解析的 component 做关键文件完整性校验，缺失时触发重下。
  // 空清单直接返回，避免无谓的远端 exists 探测。
  // [失败路径] 只有来自缓存且确实缺失时才重下；刚下载的组件缺失属于真实错误。
  // 重下前先删除远端 cache，避免旧 .ready 让流程提前返回。
  private async ensureComponentHasRequiredPaths(
    componentRef: RemoteComponentRef,
    requiredRelativePaths: readonly string[],
  ): Promise<RemoteComponentRef> {
    if (requiredRelativePaths.length === 0) {
      return componentRef;
    }

    const missingPaths = await this.findMissingComponentPaths(
      componentRef.componentDir,
      requiredRelativePaths,
    );
    if (missingPaths.length === 0 || !componentRef.fromCache) {
      return componentRef;
    }

    // 远端 component cache 的 key 只按语义版本命中；如果历史组件缓存缺少关键文件，
    // 部署层会反复把残缺 cache 复制回运行目录。
    // 这里在 cache hit 后按调用方声明的关键文件做完整性检查，缺失时清掉旧 ready/cache 并强制重下组件。
    this.loggers.logWarn(
      `[remote-assets] remote component cache incomplete: component=${componentRef.component.id} missing=${missingPaths.join(",")}; redownloading`,
    );
    await this.removeRemoteComponentCache(componentRef.componentDir);
    const task = this.ensureComponentInternal(componentRef.component.id);
    this.componentCache.set(componentRef.component.id, task);
    return await task;
  }

  // 逐个 exists 探测，返回缺失的远端路径。
  // findMissingComponentPaths 逐个 exists 探测，复杂度是 O(n) 次远端往返。
  // [契约] 返回空数组表示完整。
  private async findMissingComponentPaths(
    componentDir: string,
    requiredRelativePaths: readonly string[],
  ): Promise<string[]> {
    const missingPaths: string[] = [];
    for (const relativePath of requiredRelativePaths) {
      const remotePath = `${componentDir}/${relativePath.replace(/^\/+/u, "")}`;
      if (!(await this.backend.exists(remotePath))) {
        missingPaths.push(remotePath);
      }
    }
    return missingPaths;
  }

  private async removeRemoteComponentCache(componentDir: string): Promise<void> {
    const stream = await this.backend.exec(`rm -rf ${quotePosixPathArg(componentDir)}`);
    await waitForClose(stream);
  }

  // 真正的下载流程先解析 manifest，再算 cache 目录并加锁，随后下载与校验并通过原子 move 落位。
  // [并发] 用 mkdir 锁加心跳实现跨进程互斥，锁目录带 componentDir 前缀。
  // [失败路径] EXIT trap 只清理本次 staging 与锁，不碰正式 cache 与 componentNewDir。
  // 命中 .ready 且非强制刷新时直接返回，不产生任何网络请求。
  // [契约] 脚本逐行执行，不能合并为 &&，否则 set -e 会被清理语句掩盖。
  private async ensureComponentInternal(
    componentId: string,
    forceRefresh = false,
  ): Promise<RemoteComponentRef> {
    const manifestRef = await this.manifestPromise;
    const component = selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0];
    if (!component) {
      throw new Error(`[remote-assets] manifest is missing requested component: ${componentId}`);
    }

    // server-bundle 和 GLM 都允许语义版本不变但制品内容更新，cache
    // 必须直接按 manifest SHA 隔离；其它资源包继续沿用原有语义版本 key。
    // 内容寻址组件用 sha256 作为 cache 段，防止版本不变但内容更新时命中旧包。
    // 其余组件沿用 version 的哈希，保持历史缓存可用。
    // [契约] 分支条件集中在 usesRemoteAssetContentAddressedCacheIdentity，不要就地判断 id。
    const componentCacheSegment = usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : hashRemoteCacheSegment(resolveRemoteAssetComponentCacheVersion(component.version));
    const componentDir = `${REMOTE_BASE}/asset-cache/components/${quoteSafeSegment(this.options.platformArch)}/${quoteSafeSegment(component.id)}/${componentCacheSegment}`;
    // .ready 是组件完整的唯一标记，缺失即视为未就绪。
    // 它写在解压目录内，随整体 move 一起进入最终目录。
    // [契约] 不要在 move 之后单独补写，否则会出现半成品可见窗口。
    const readyPath = `${componentDir}/.ready`;
    // 命中 .ready 时分两种情况：强制刷新要先删，否则直接复用。
    // [失败路径] 强制刷新提前返回会让部署结果仍是旧制品。
    // 删除 .ready 后继续走完整下载流程，不跳过校验。
    if (await this.backend.exists(readyPath)) {
      if (forceRefresh) {
        // 强制部署要求真的重新下载制品：即使 cache 目录已按 manifest SHA 隔离，
        // 命中 ready 时也必须先清掉，否则会提前返回，把既有缓存当作本次部署结果。
        this.loggers.logWarn(
          `[remote-assets] download required: component=${component.id} reason=force refresh path=${JSON.stringify(readyPath)}`,
        );
        await this.removeRemoteComponentCache(componentDir);
      } else {
        this.loggers.log(
          `[remote-assets] remote component cache hit: ${component.id}@${component.version}`,
        );
        return { component, componentDir, fromCache: true };
      }
    }

    if (!forceRefresh) {
      this.loggers.logWarn(
        `[remote-assets] download required: component=${component.id} reason=remote component cache missing path=${readyPath}`,
      );
    }
    // 按 manifest 的制品路径与候选基址生成下载 URL 列表。
    // 候选顺序即 CDN 优先级，manifest 所在源排在最前。
    // [契约] 列表可以为空，此时下载命令会失败并暴露配置问题。
    const artifactUrls = buildComponentArtifactUrlCandidates(
      manifestRef.releaseBaseCandidatesForComponents,
      component.artifactPath,
      this.options.version,
    );
    const totalBytes = await resolveRemoteArtifactContentLength(
      artifactUrls,
      this.options.remoteAssetNetwork,
    );
    // HEAD 只服务进度统计，允许其独立收尾；完成后必须重新检查连接生命周期，
    // 禁止取消后的迟到 continuation 使用旧 backend 创建远端下载与 staging。
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const stagingDir = `${REMOTE_BASE}/asset-cache/staging/${quoteSafeSegment(component.id)}-${Date.now()}-${randomUUID()}`;
    const archivePath = `${stagingDir}/component.tar.gz`;
    const extractDir = `${stagingDir}/extract`;
    const componentNewDir = `${componentDir}.new-${Date.now()}-${randomUUID()}`;
    // 锁目录与组件目录同级，靠 mkdir 的原子性实现互斥。
    // 心跳每 30 秒 touch 一次，等待方据此判断持有者是否存活。
    // [失败路径] 超过 10 分钟没有心跳才判过期并抢占，避免误伤慢速下载。
    // [契约] 清理命令必须同时删锁、staging 与新目录。
    const lockDir = `${componentDir}.lock`;
    const quotedLockDir = quotePosixPathArg(lockDir);
    const cleanupCommand = `if [ -n "\${lock_heartbeat_pid:-}" ]; then kill "$lock_heartbeat_pid" >/dev/null 2>&1 || true; wait "$lock_heartbeat_pid" 2>/dev/null || true; fi; rm -rf ${quotedLockDir} ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(componentNewDir)}`;
    // downloadCommand 内部已包含多源尝试与逐源校验，这里只做参数透传。
    // 进度包装由 supportsProgress 决定是否启用。
    // [契约] 返回的片段必须在 set -eu 下逐行执行，不能拼进 && 链。
    // [失败路径] 任何一行失败都应让脚本立即退出，由 EXIT trap 统一清理。
    const downloadCommand = buildRemoteArtifactDownloadCommand({
      tool: this.tools.download,
      urls: artifactUrls,
      outputPath: archivePath,
      progressLabel: `${component.id}@${component.version}`,
      totalBytes,
      expectedSha256: component.sha256,
      sha256Tool: this.tools.sha256,
      supportsProgress: this.tools.supportsProgress,
    });
    const checksumCommand = buildRemoteChecksumCommand({
      tool: this.tools.sha256,
      filePath: archivePath,
    });
    const checksumMismatchMessage = `[remote-assets] sha256 mismatch for ${component.id}@${component.version}`;
    // 远端脚本按 lock→heartbeat→trap→download→verify→extract→move→cleanup 的顺序逐行拼接。
    // [失败路径] 不能合并成 && 链：分号语句会让失败码被后续清理的成功码覆盖。
    // [并发] 拿到锁后必须再查一次 .ready，避免等待期间别人已完成。
    // 写入 .ready 在解压目录内完成，随后两次 move 保证原子性。
    // 末尾 trap - EXIT 解除陷阱，防止清理执行两次。
    const command = [
      "set -eu",
      `rm -rf ${quotePosixPathArg(stagingDir)}`,
      `mkdir -p ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(posix.dirname(componentDir))}`,
      // 远端下载中断可能留下 .lock 目录。持锁进程定期刷新 mtime，等待方只清理超过 10 分钟没有心跳的锁，
      // 避免用户断开后再次选择远端下载时一直等待，同时不误伤仍在慢速下载的正常进程。
      `while ! mkdir ${quotedLockDir} 2>/dev/null; do if [ -e ${quotePosixPathArg(readyPath)} ]; then rm -rf ${quotePosixPathArg(stagingDir)}; exit 0; fi; lock_mtime=$({ stat -c %Y ${quotedLockDir} || stat -f %m ${quotedLockDir}; } 2>/dev/null || printf 0); lock_now=$(date +%s); if [ "$lock_mtime" -gt 0 ] && [ $((lock_now - lock_mtime)) -ge 600 ]; then echo ${quotePosixShellArg(`[remote-assets] stale lock for ${component.id}@${component.version}, retrying`)} >&2; rm -rf ${quotedLockDir}; continue; fi; sleep 1; done`,
      `lock_heartbeat_pid=; (while :; do touch ${quotedLockDir} 2>/dev/null || exit 0; sleep 30; done) & lock_heartbeat_pid=$!`,
      `trap ${quotePosixShellArg(cleanupCommand)} EXIT`,
      `if [ -e ${quotePosixPathArg(readyPath)} ]; then exit 0; fi`,
      downloadCommand,
      `actual_sha=$(${checksumCommand})`,
      `if [ "$actual_sha" != ${quotePosixShellArg(component.sha256)} ]; then echo ${quotePosixShellArg(checksumMismatchMessage)} >&2; exit 1; fi`,
      `mkdir -p ${quotePosixPathArg(extractDir)}`,
      `${this.tools.tar} -xzf ${quotePosixPathArg(archivePath)} -C ${quotePosixPathArg(extractDir)}`,
      `test "$(find ${quotePosixPathArg(extractDir)} -mindepth 1 -maxdepth 1 | head -n 1)"`,
      `printf ready > ${quotePosixPathArg(`${extractDir}/.ready`)}`,
      `rm -rf ${quotePosixPathArg(componentNewDir)}`,
      buildRemoteMoveCommand(extractDir, componentNewDir),
      `rm -rf ${quotePosixPathArg(componentDir)}`,
      buildRemoteMoveCommand(componentNewDir, componentDir),
      cleanupCommand,
      "trap - EXIT",
      // 下载进度和清理语句含分号，拼进 && 链会让失败被后续清理的成功退出码覆盖，
      // 继而复制不存在的组件。逐行执行让 set -e 在失败处退出，EXIT trap 只负责清理。
    ].join("\n");

    this.loggers.log(`[remote-assets] remote downloading ${component.id}@${component.version}`);
    const stream = await this.backend.exec(command);
    forwardRemoteDownloadProgressLogs(stream, this.loggers);
    await waitForClose(stream);
    return { component, componentDir, fromCache: false };
  }
}

// 拉取 manifest 的进程内单飞去重入口。
// key 覆盖版本、平台、超时与全部 CDN 基址。
// [并发] 同 key 共享 Promise，先到者负责发起，后到者直接等待。
// [契约] 结束后从 remoteDownloadManifestLocks 清理表项，允许后续重新拉取。
export async function fetchRemoteDownloadManifest(
  options: RemoteDownloadAssetInstallerOptions,
  loggers: DeployLoggers,
): Promise<RemoteManifestRef> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls({
    remoteCdnBaseUrl: options.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options.remoteCdnBaseUrls,
  });
  // lockKey 的组成决定去重粒度，四个维度缺一不可。
  // 超时缺省写成 default，避免 undefined 参与拼接。
  // [契约] 改动组成会让旧 key 失效，但不会造成错误复用。
  const lockKey = [
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteDownloadManifestLocks.get(lockKey);
  if (lockedTask) {
    return lockedTask;
  }

  // 先声明再赋值，因为 finally 里要用 task 与表中的值比较身份。
  // [并发] 用 task 身份比较而不是直接删除，避免误删后来者的任务。
  // [契约] 这段写法不能简化成链式赋值。
  let task: Promise<RemoteManifestRef>;
  task = fetchRemoteDownloadManifestInternal(options, remoteCdnBaseUrls, loggers).finally(() => {
    if (remoteDownloadManifestLocks.get(lockKey) === task) {
      remoteDownloadManifestLocks.delete(lockKey);
    }
  });
  remoteDownloadManifestLocks.set(lockKey, task);
  return task;
}

// 按候选 URL 依次尝试，记录每个候选的错误。
// 404 不计入 candidateErrors，因为它代表该源没有发布而不是故障。
// [失败路径] 全部失败时把候选错误拼进异常信息，便于区分未发布与半开连接。
// 成功时把命中的 releaseBase 提到候选首位，后续制品优先进同一源。
async function fetchRemoteDownloadManifestInternal(
  options: RemoteDownloadAssetInstallerOptions,
  remoteCdnBaseUrls: string[],
  loggers: DeployLoggers,
): Promise<RemoteManifestRef> {
  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, options.version);
  const manifestUrls = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    buildRemoteAssetManifestFileCandidates(options.platformArch),
  );
  const candidateErrors: string[] = [];

  // 顺序尝试，遇到第一个可用 manifest 即返回。
  // 每个候选各自创建 signal 超时信号，避免一个源拖垮整体。
  // [契约] 命中后不再尝试 manifestUrls 里的后续候选。
  for (const url of manifestUrls) {
    loggers.log(`[remote-assets] downloading manifest ${url}`);
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await resolveRemoteAssetFetch(options.remoteAssetNetwork)(url, {
        signal,
      });
    } catch (error) {
      candidateErrors.push(`${url} -> ${String(error)}`);
      loggers.logWarn(`[remote-assets] manifest candidate failed ${url}: ${String(error)}`);
      continue;
    }
    if (!response.ok) {
      if (response.status !== 404) {
        candidateErrors.push(`${url} -> HTTP ${response.status}`);
      }
      continue;
    }

    // response.ok 只代表头部成功，响应体解析要与状态码检查分开。
    // [失败路径] 响应体超时后必须取消请求并继续下一个候选，否则初始化会永久挂起。
    // 解析失败且信号已中止时按候选失败处理，而不是直接抛出。
    let manifest: RemoteAssetManifest;
    try {
      manifest = await parseRemoteAssetManifestFromResponse(
        response,
        url,
        options.version,
        options.platformArch,
      );
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      // manifest 响应头成功不代表响应体会结束；body 超时后必须
      // 取消当前请求并尝试下一个 CDN，避免 remote-download 初始化永久挂起。
      loggers.logWarn(`[remote-assets] manifest candidate failed ${url}: ${String(error)}`);
      candidateErrors.push(`${url} -> ${String(error)}`);
      continue;
    }
    const manifestReleaseBase = resolveReleaseBaseByAssetUrl(url, releaseBaseCandidates);
    return {
      manifest,
      releaseBaseCandidatesForComponents: manifestReleaseBase
        ? [
            manifestReleaseBase,
            ...releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
          ]
        : releaseBaseCandidates,
    };
  }

  // 有候选错误时抛出汇总异常，保留每个源的诊断。
  // [失败路径] 过去只报 not found，无法区分未发布与响应体半开。
  // 全部候选都 404 时才落到下一条「manifest not found」。
  if (candidateErrors.length > 0) {
    // remote-download 过去丢弃每个 CDN 候选的 timeout/HTTP 诊断，
    // 最终只报 manifest not found，无法区分资源未发布与响应体半开。
    throw new Error(
      `[remote-assets] failed to fetch manifest for ${options.platformArch}: ${candidateErrors.join("; ")}`,
    );
  }
  throw new Error(`[remote-assets] manifest not found for ${options.platformArch}`);
}

// 把 release 相对路径映射到组件缓存目录内的位置。
// 命中组件 mount 时返回目录本身，用 /. 表示目录内容。
// [契约] 不在 mount 之下时按原样拼接，兼容跨组件共享资源。
// [失败路径] 去掉头部斜杠归一化会让路径逃逸出组件目录。
function buildRemoteComponentSourcePath(
  ref: RemoteComponentRef,
  releaseRelativePath: string,
): string {
  const mount = ref.component.mount.replace(/\/+$/u, "");
  const normalizedSource = releaseRelativePath.replace(/^\/+|\/+$/gu, "");
  const relativeInsideComponent =
    normalizedSource === mount
      ? "."
      : normalizedSource.startsWith(`${mount}/`)
        ? normalizedSource.slice(mount.length + 1)
        : normalizedSource;
  return relativeInsideComponent === "."
    ? `${ref.componentDir}/.`
    : `${ref.componentDir}/${relativeInsideComponent}`;
}

// 从实际命中的 URL 反推最长的基址前缀。
// 按长度降序取第一个，保证嵌套基址选到更具体的那个。
// [契约] 无匹配时返回 null，调用方回落到原始候选顺序。
function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/u, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}

// 用 HEAD 探测制品大小，仅用于进度显示。
// [失败路径] 任一次失败或没有 content-length 都只是继续下一个 URL。
// [契约] 返回 null 表示未知，调用方必须支持无总量模式。
// resolveRemoteArtifactContentLength 不重试也不阻塞，因为下载本身另有重试策略。
async function resolveRemoteArtifactContentLength(
  urls: string[],
  network?: RemoteAssetNetworkPort,
): Promise<number | null> {
  const fetchImpl = resolveRemoteAssetFetch(network);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { method: "HEAD" });
      if (!response.ok) {
        continue;
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength != null) {
        return contentLength;
      }
    } catch {
      // HEAD 只用于连接日志进度总量；失败时下载本身仍按 curl/wget 候选继续执行。
    }
  }
  return null;
}

// 把头部字符串收敛成正整数或 null。
// 非法值（负数、0、NaN）统一按未知处理，parseContentLength 返回 null。
// [失败路径] 放行 0 会让进度计算除零。
function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }
  const parsed = Number.parseInt(contentLengthHeader, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// quoteSafeSegment 把平台或组件 id 里的非白名单字符替换成下划线，用于路径段。
// quoteSafeSegment 的白名单只含 A-Za-z0-9 与下划线，其它字符一律替换。
// [契约] 结果绝不能包含斜杠，否则会逃逸出 cache 前缀。
function quoteSafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._+-]/gu, "_");
}

// 对语义版本做 sha256 并截断 16 位，得到定长且安全的目录名。
// hashRemoteCacheSegment 截断 16 位是为了路径可读，碰撞概率在版本数量级下可忽略。
// [契约] 不要改成明文 version，版本里可能含斜杠或空格。
function hashRemoteCacheSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// 把远端 stdout 里以 download progress 开头的行转成日志。
// [资源] 按行缓冲，未闭合的尾行留到 onClose 再处理。
// [失败路径] 不分行会导致半行被吞或重复输出。
// forwardRemoteDownloadProgressLogs 只转发进度行，其余输出被丢弃，避免污染部署日志。
function forwardRemoteDownloadProgressLogs(stream: StdioStream, loggers: DeployLoggers): void {
  let bufferedStdout = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    bufferedStdout += chunk.toString();
    const lines = bufferedStdout.split(/\r?\n/u);
    bufferedStdout = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^download progress:/iu.test(trimmed)) {
        loggers.log(trimmed);
      }
    }
  });
  stream.onClose(() => {
    const trimmed = bufferedStdout.trim();
    if (/^download progress:/iu.test(trimmed)) {
      loggers.log(trimmed);
    }
  });
}
