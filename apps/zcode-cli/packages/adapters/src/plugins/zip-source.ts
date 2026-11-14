// INV-01 先校验后下载：守住位置 强校验入口；改错故障：未校验的地址被实际请求。
// INV-02 失败必清理：守住位置 resolveHttpZipSource 的捕获；改错故障：失败后临时目录残留。
// INV-03 清理错误不吞：守住位置 错误合并；改错故障：主错误被清理错误覆盖。
// INV-04 重定向有界：守住位置 循环上限；改错故障：恶意跳转导致无限请求。
// INV-05 跨源去头：守住位置 来源比较；改错故障：自定义凭据头泄露给第三方。
// INV-06 手动跳转：守住位置 redirect 选项；改错故障：底层自动跟随绕过白名单校验。
// INV-07 大小双限：守住位置 下载与解压上限；改错故障：压缩炸弹撑爆内存。
// INV-08 条目有界：守住位置 条目计数；改错故障：海量小条目拖死解压。
// INV-09 写盘前判定：守住位置 路径解析；改错故障：越界路径被写出临时目录。
// INV-10 类型白名单：守住位置 条目分类；改错故障：符号链接或设备文件被落盘。
// INV-11 加密即拒：守住位置 标志位判断；改错故障：加密条目产生乱码文件。
// INV-12 路径归一：守住位置 相对路径校验；改错故障：反斜杠与盘符路径绕过检查。
// INV-13 根选择有序：守住位置 resolveZipRoot 的分支顺序；改错故障：显式子目录被忽略。
// INV-14 单根约束：守住位置 顶层计数；改错故障：多根归档被当成单根安装。
// INV-15 凭据头拒绝：守住位置 头白名单；改错故障：授权头被带入外部请求。
// INV-16 协议白名单：守住位置 协议判断；改错故障：明文请求发往任意主机。
// INV-17 取消贯穿：守住位置 各阶段检查；改错故障：下载或解压无法中途停止。
// INV-18 流必关：守住位置 解压收尾；改错故障：句柄泄漏，临时目录无法删除。
//
// 模块职责：下载并安全解压远程 zip 插件源，选出插件根并返回清理函数。
// 状态所有权：临时目录与归档句柄归单次调用；清理函数交调用方持有。
// 阅读顺序：上限常量 → 类型 → 入口 → 下载 → 解压 → 选根 → 条目与路径校验。
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import * as yauzl from "yauzl";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
} from "./helpers.js";

/*
 * ============================================================
 * plugins / zip-source.ts —— 远程 zip 插件源的下载、校验与安全解压
 *
 * 定位：插件 marketplace 的 url+zip 源物化：HTTPS/loopback 下载 → sha256 校验 →
 * 限制条目数/单文件/总大小 → 防 zip-slip/符号链接/加密条目 → 选插件根。
 *
 * 输入输出：返回 {path, cleanup}；path 指向解压后的插件根，cleanup 删除整个临时目录。
 *
 * 副作用：mkdtemp 临时目录、writeFile 解压、网络 GET（经 HttpClient 适配器，遵守代理）；
 * 失败时清理临时目录并把清理错误追加到主错误。
 *
 * 失败语义：非法 URL/header/sha/路径→抛错（本地 fail closed）；下载非 2xx→
 * PluginZipDownloadError；sha 不匹配/条目超限→抛错；解压任一异常→整目录清理。
 *
 * 不变量：禁止 Authorization/Cookie 等 header；跨 origin 重定向丢弃自定义 header；
 * 所有解压目标必须落在 extractRoot 内；同一入口最多 5 次重定向。
 * ============================================================
 */

// 下载与解压各自设上限，避免单源吃掉全部内存。
// 条目数与单文件上限另算，防止压缩炸弹。
//
const ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_REDIRECTS = 5;
const ZIP_DOWNLOAD_TIMEOUT_MS = 180_000;
const ZIP_TEMP_PREFIX = "zcode-plugin-zip-";
const ZIP_DENIED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);
const ZIP_REQUIRED_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ResolvedZipPluginSourceRoot {
  /** 删除临时目录；调用方必须在用完后调用（失败路径由实现自己清理）。 */
  cleanup: () => Promise<void>;
  /** 解压后插件根目录绝对路径。 */
  path: string;
}

export interface ResolveZipPluginSourceInput {
  /** 自定义请求头；Authorization/Cookie 等被拒绝。 */
  headers?: Record<string, string>;
  /** 归档内子目录（相对路径）。 */
  path?: string;
  /** 必填的归档 sha256（64 位 hex，大小写不敏感）。 */
  sha256: string;
  /** 取消信号，贯穿下载与解压。 */
  signal?: AbortSignal;
  /** 是否剥离 zip 唯一顶层目录，默认 true。 */
  stripRoot?: boolean;
  /** 归档下载地址，仅 https 或 loopback http。 */
  url: string;
}

export interface ResolveHttpZipSourceInput {
  /** 自定义请求头。 */
  headers?: Record<string, string>;
  /** 归档内子目录。 */
  path?: string;
  /** 要求 zip 恰好一个顶层目录（用于无法容忍多根的安装语义）。 */
  requireSingleRoot?: boolean;
  /** 可选 sha256；提供时必须匹配。 */
  sha256?: string;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 是否剥离唯一顶层目录。 */
  stripRoot?: boolean;
  /** 下载地址。 */
  url: string;
}

export class PluginZipDownloadError extends Error {
  /** HTTP 状态码；非 HTTP 失败时缺失。 */
  readonly status?: number;
  /** 发生失败的（重定向后）URL。 */
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "PluginZipDownloadError";
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

interface ZipExtractResult {
  topLevelSegments: Set<string>;
}

type ZipEntryKind = "directory" | "file";

/**
 * 强制要求 sha256 的 zip 源入口：先本地校验 URL/headers/path/sha，再委托 resolveHttpZipSource。
 * 失败语义与 resolveHttpZipSource 一致；不会在未校验的情况下下载。
 */
export async function resolveZipPluginSource(
  input: ResolveZipPluginSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipSourceInput(input);
  const resolved = await resolveHttpZipSource({
    headers: input.headers,
    path: input.path,
    sha256: input.sha256,
    signal: input.signal,
    stripRoot: input.stripRoot,
    url: input.url,
  });
  return resolved;
}

/**
 * 下载并解压 HTTP(S) zip 源，返回插件根与清理函数。
 *
 * 流程：校验输入 → 建临时目录 → 下载 →（可选）sha256 比对 → 写盘解压 → 选根。
 * 任一步失败都会清理整个临时目录，并把清理错误追加到原错误 message。
 */
// 先校验地址、请求头与可选校验值，再建临时目录。
// 任一步失败都清理整目录，并把清理错误并入原错误。
//
export async function resolveHttpZipSource(
  input: ResolveHttpZipSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipDownloadUrl(input.url);
  validateZipHeaders(input.headers);
  if (input.path !== undefined) normalizeZipRelativePath(input.path);
  if (input.sha256 !== undefined && !ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), ZIP_TEMP_PREFIX));
  const archivePath = join(tempRoot, "source.zip");
  const extractRoot = join(tempRoot, "extract");
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { force: true, recursive: true });
  };

  try {
    throwIfAborted(input.signal);
    const zipBytes = await downloadZipArchive({
      headers: input.headers,
      signal: input.signal,
      url: input.url,
    });
    const actualSha256 = createHash("sha256").update(zipBytes).digest("hex");
    if (input.sha256 !== undefined && actualSha256 !== input.sha256.toLowerCase()) {
      throw new Error(
        `Plugin zip sha256 mismatch: expected=${input.sha256.toLowerCase()}, actual=${actualSha256}`,
      );
    }

    await writeFile(archivePath, zipBytes);
    const extracted = await extractZipArchive({
      archivePath,
      signal: input.signal,
      targetRoot: extractRoot,
    });
    const pluginRoot = resolveZipRoot({
      extractRoot,
      path: input.path,
      requireSingleRoot: input.requireSingleRoot,
      stripRoot: input.stripRoot,
      topLevelSegments: extracted.topLevelSegments,
    });
    return { cleanup, path: pluginRoot };
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

/** 只从 {source:"url",type:"zip",url,sha256} 形状读取 sha256；其他源返回 undefined。 */
export function readZipPluginSourceSha256(source: unknown): string | undefined {
  if (!isZipPluginUrlSource(source)) return undefined;
  return source.sha256;
}

/** 类型守卫：识别 url+zip 源；sha256 必须已存在（调用方需再校验其格式）。 */
export function isZipPluginUrlSource(
  source: unknown,
): source is { source: "url"; type: "zip"; sha256: string; url: string } {
  return (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    "source" in source &&
    (source as { source?: unknown }).source === "url" &&
    (source as { type?: unknown }).type === "zip" &&
    typeof (source as { url?: unknown }).url === "string" &&
    typeof (source as { sha256?: unknown }).sha256 === "string"
  );
}

/** 强校验入口：URL 协议、sha256 格式、header 白名单、归档内路径安全，任一不满足即抛错。 */
function validateZipSourceInput(input: ResolveZipPluginSourceInput): void {
  validateZipDownloadUrl(input.url);
  if (!ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  validateZipHeaders(input.headers);
  if (input.path !== undefined) {
    normalizeZipRelativePath(input.path);
  }
}

/**
 * 手动跟随最多 5 次重定向的 zip 下载，返回响应体字节。
 *
 * 副作用：网络请求（200MB/180s 上限，经统一 HttpClient）。失败语义：非 2xx 抛
 * PluginZipDownloadError；缺 Location/超限抛普通错误；取消按 signal 抛出。
 */
// 手动跟随重定向，上限固定五次。
// 跨源跳转立刻丢弃自定义请求头，避免凭据外泄。
//
async function downloadZipArchive(input: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  url: string;
}): Promise<Uint8Array> {
  // agent 会封存用户 shell 代理，ZIP 下载必须和其他应用层 fetch 一样读取 captured proxy fallback。
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
    timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
  });
  let currentUrl = input.url;
  let currentHeaders = input.headers;
  for (let redirectCount = 0; redirectCount <= ZIP_MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(input.signal);
    validateZipDownloadUrl(currentUrl);
    const response = await client.request(
      {
        headers: currentHeaders,
        maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal: input.signal },
    );

    if (isRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Plugin zip download redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 跨 CDN origin 继续发送 marketplace 自定义 header 会把内部元数据泄露给跳转目标。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PluginZipDownloadError(
        `Failed to download plugin zip: ${response.status} ${response.statusText}`,
        currentUrl,
        response.status,
      );
    }
    return response.body;
  }
  throw new Error(`Plugin zip download exceeded redirect limit: ${input.url}`);
}

/**
 * 逐条解压 zip：校验条目数/单文件大小/累计大小/路径安全，目录条目建目录、文件条目写盘。
 *
 * 副作用：mkdir/writeFile；失败时 zipFile 关闭并由上层清理临时目录。
 * 同时收集顶层目录名，供后续 stripRoot/requireSingleRoot 判定。
 */
// 逐条读取 entry，条目数为零时也要正常收束。
// directory 条目只建目录，file 条目才计入累计大小。
// 单条读取失败即 reject 整个解压，不跳过坏条目。
//
async function extractZipArchive(input: {
  archivePath: string;
  signal?: AbortSignal;
  targetRoot: string;
}): Promise<ZipExtractResult> {
  const targetRoot = resolve(input.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const zipFile = await openZipFile(input.archivePath);
  const topLevelSegments = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const rejectOnce = (error: unknown): void => {
        zipFile.close();
        rejectPromise(error);
      };
      zipFile.once("error", rejectOnce);
      zipFile.once("end", () => {
        zipFile.removeListener("error", rejectOnce);
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            throwIfAborted(input.signal);
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES) {
              throw new Error(`Plugin zip has too many entries: ${entryCount}/${ZIP_MAX_ENTRIES}`);
            }

            const normalizedPath = normalizeZipRelativePath(entry.fileName);
            topLevelSegments.add(normalizedPath.split("/")[0] ?? normalizedPath);
            const targetPath = resolveZipPathWithin(targetRoot, normalizedPath);
            const kind = classifyZipEntry(entry);
            if (kind === "directory") {
              await mkdir(targetPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            if (entry.uncompressedSize > ZIP_MAX_SINGLE_FILE_BYTES) {
              throw new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`);
            }
            const bytes = await readZipEntryBuffer(zipFile, entry, input.signal);
            extractedBytes += bytes.byteLength;
            if (extractedBytes > ZIP_EXTRACT_MAX_BYTES) {
              throw new Error(
                `Plugin zip extracted content exceeds limit: ${extractedBytes}/${ZIP_EXTRACT_MAX_BYTES}`,
              );
            }
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, bytes);
            zipFile.readEntry();
          } catch (error) {
            rejectOnce(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  return { topLevelSegments };
}

/**
 * 确定插件根：优先显式 path（必须存在），其次“解压根本身就是插件”（有 manifest），
 * 再其次剥离唯一顶层目录；都不满足时退回解压根。
 *
 * 纯路径判断 + 存在性探测；requireSingleRoot 不满足时抛错。
 */
// 显式子目录优先，其次根目录自带插件清单。
// 再尝试剥离唯一顶层目录，最后退回解压根。
//
function resolveZipRoot(input: {
  extractRoot: string;
  path?: string;
  requireSingleRoot?: boolean;
  stripRoot?: boolean;
  topLevelSegments: Set<string>;
}): string {
  const extractRoot = resolve(input.extractRoot);
  if (input.requireSingleRoot && input.topLevelSegments.size !== 1) {
    throw new Error(
      `Plugin zip must contain exactly one top-level directory: ${input.topLevelSegments.size}`,
    );
  }
  if (input.path !== undefined) {
    const requested = resolveZipPathWithin(extractRoot, normalizeZipRelativePath(input.path));
    if (!directoryExists(requested)) {
      throw new Error(`Plugin zip source subdirectory does not exist: ${input.path}`);
    }
    return requested;
  }

  if (hasPluginManifest(extractRoot)) {
    return extractRoot;
  }

  if (input.stripRoot !== false && input.topLevelSegments.size === 1) {
    const [segment] = [...input.topLevelSegments];
    if (segment) {
      const candidate = resolveZipPathWithin(extractRoot, segment);
      if (directoryExists(candidate)) return candidate;
    }
  }

  if (!directoryExists(extractRoot)) {
    throw new Error("Plugin zip did not extract a plugin root directory");
  }
  return extractRoot;
}

/** 插件根 manifest 判定：兼容 .zcode-plugin / .claude-plugin / .codex-plugin 三种目录约定。 */
function hasPluginManifest(rootPath: string): boolean {
  return (
    fileExists(join(rootPath, ".zcode-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".claude-plugin", "plugin.json")) ||
    fileExists(join(rootPath, ".codex-plugin", "plugin.json"))
  );
}

/** 以 lazyEntries + validateEntrySizes 打开 zip，避免一次性把中心目录/条目读进内存。 */
function openZipFile(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!zipFile) {
        rejectPromise(new Error("Failed to open plugin zip archive"));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

/**
 * 读取单个文件条目到 Buffer：流式累计字节，超过单文件上限即 destroy 并报错；
 * signal 中止会销毁流，且监听器在 end/error 时移除，避免泄漏。
 */
// 流式累计字节，超过单文件上限即 destroy 并报错。
// 取消时 destroy 流，监听器在 end/error 时移除。
// 错误与 end 两条路径都移除监听，避免泄漏。
//
function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!stream) {
        rejectPromise(new Error(`Failed to read plugin zip entry: ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stream.destroy(new Error("Plugin operation cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.byteLength;
        if (bytesRead > ZIP_MAX_SINGLE_FILE_BYTES) {
          stream.destroy(
            new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`),
          );
          return;
        }
        chunks.push(buffer);
      });
      stream.once("error", (streamError) => {
        cleanup();
        rejectPromise(streamError);
      });
      stream.once("end", () => {
        cleanup();
        resolvePromise(Buffer.concat(chunks));
      });
    });
  });
}

/**
 * 分类 zip 条目并拒绝危险类型：加密条目、符号链接、设备/管道等非普通文件/目录。
 * Unix mode 为 0 时退化为按文件名结尾 `/` 判断目录。
 */
// 加密条目直接拒绝，不做任何解密尝试。
// 符号链接与设备文件一律拒绝，只放行普通文件与目录。
//
function classifyZipEntry(entry: yauzl.Entry): ZipEntryKind {
  const isDirectoryByName = entry.fileName.endsWith("/");
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`Encrypted plugin zip entries are not supported: ${entry.fileName}`);
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    throw new Error(`Plugin zip entry symlinks are not supported: ${entry.fileName}`);
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error(`Unsupported plugin zip entry type: ${entry.fileName}`);
  }
  if (fileType === 0o040000 || isDirectoryByName) return "directory";
  return "file";
}

/**
 * 归一化并校验 zip 内相对路径：拒绝 NUL、反斜杠、绝对路径、盘符、空段、`.`/`..`。
 * 通过后返回去掉末尾斜杠的 posix 风格路径。
 */
// 拒绝空字节、反斜杠、绝对路径与盘符。
// 空段与点段同样拒绝，通过后去掉末尾斜杠。
//
function normalizeZipRelativePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  const withoutTrailingSlash = path.replace(/\/+$/u, "");
  if (
    !withoutTrailingSlash ||
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe plugin zip path: ${path}`);
  }
  return withoutTrailingSlash;
}

/** 把归一化后的相对路径解析到 root 内；越界、绝对路径或 `..` 一律抛 Unsafe 错误。 */
// 解析后再做相对路径复核，越界一律拒绝。
// 根目录自身不算合法目标。
//
function resolveZipPathWithin(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath);
  const target = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe plugin zip path: ${relativePath}`);
  }
  return target;
}

/** header 白名单：拒绝 Authorization/Cookie 等凭据头，且值必须是字符串（防止运行时注入）。 */
function validateZipHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (ZIP_DENIED_HEADERS.has(key.toLowerCase())) {
      throw new Error(`Plugin zip source header is not allowed: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
  }
}

/** 只允许 https；http 仅限 loopback（localhost/::1/127.x.x.x），其余协议与主机一律抛错。 */
// 只允许 https，明文 http 仅限 loopback 主机，其余协议必须拒绝。
// 解析失败与协议不符都给出明确错误。
//
function validateZipDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Plugin zip source URL is invalid: ${value}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error(`Plugin zip source URL must be HTTPS: ${value}`);
}

/** 判断主机名是否为本机回环（localhost、::1、[::1]、127.0.0.0/8）。 */
function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isIpv4LoopbackHost(normalized)
  );
}

/** 校验 127.x.x.x 每段在 0-255 内；仅做字面量检查，不解析 DNS。 */
function isIpv4LoopbackHost(hostname: string): boolean {
  const match = /^127(?:\.(\d{1,3})){3}$/u.exec(hostname);
  if (!match) return false;
  return hostname
    .split(".")
    .every((part) => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

/** 可跟随的重定向状态码：301/302/303/307/308（不含 304）。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 取消检查：抛出 name=AbortError 的固定错误，供各阶段统一识别用户取消。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Plugin operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
