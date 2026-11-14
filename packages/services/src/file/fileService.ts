// INV 不变量表（fileService）：
// INV-01：所有读取都受硬上限约束（文本 256KB、二进制分块 1MB、媒体 8MB、Office 预览 25MB）。
//   守住位置：DEFAULT_/MAX_ 常量与 clampReadLength / clampMediaPreviewBytes / clampBinaryReadLength /
//   clampBinaryPreviewBytes；破坏后果：超限内容一次性穿过 RPC 会同时拖垮 utility process 与 renderer。
// INV-02：readTextFile / readFileRange 的 bytesRead 恒等于实际读到的字节数，truncated 只在
//   offset+bytesRead < size 时为 true（守住：readTextFile 的返回分支）；
//   破坏后果：分块加载方把截断当完整，静默丢掉文件尾部。
// INV-03：readdir 的软链接必须跟随目标分类（resolveReaddirEntryType）；
//   破坏后果：远程 SSH 选目录时指向目录的链接不可选，或目录被当文件打开后读取失败。
// INV-04：workspace 索引缓存以 workspaceKey（identity 优先于 rootPath）加 .zcodeignore 指纹为键
//   （守住：ensureWorkspaceFileIndex）；破坏后果：改规则后仍返回旧结果，或不同 Host 共用同路径缓存。
// INV-05：文件句柄一律在 finally 中 close（readTextFile / readFileRange）；
//   破坏后果：远程会话句柄泄漏最终触发 EMFILE，整个 Host 停止读写。
// INV-06：FileExistenceCache 只保留 60s 内结论且容量不超过 100 条；
//   破坏后果：长生命周期 Host 的内存随候选路径增长，且过期结论被当作事实。
// 本文件是 desktop / web / remote 三种文件系统的唯一入口，每个上限既是性能参数也是协议边界。
/* eslint-disable max-lines */
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileTextSlice,
  WorkspaceFileEntry,
} from "@zcode/shared";
import { getMediaPreviewFormat } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { IFileService, WorkspaceFileSearchParams } from "./file.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { buildHostFileSearchCandidates, searchHostFileCandidates } from "./workspaceFileSearch.js";
import {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchFilter,
} from "./workspaceFileMentionFilter.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
  readWorkspaceFileSearchIgnore,
  transformWorkspaceFileSearchIgnore,
  writeWorkspaceFileSearchIgnore,
} from "./workspaceFileIgnore.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getConversationWorkspaceDir } from "../paths.js";
// 读取预算：文本默认 128KB / 上限 256KB，媒体 4MB / 8MB，二进制分块 256KB / 1MB，Office 预览 25MB。
// 默认值面向交互（一屏 diff 或一次预览），上限面向调用方明确要更多的场景；两者都不可合并，
// 否则 UI 拿不到可预测的首屏延迟。二进制上限停在 1MB，是因为分块 RPC 只有顶层 Uint8Array
// 走原始字节通道，再大会让序列化缓冲区翻倍。
const DEFAULT_TEXT_READ_BYTES = 128 * 1024;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const DEFAULT_MEDIA_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES = 8 * 1024 * 1024;
const DEFAULT_BINARY_READ_BYTES = 256 * 1024;
const MAX_BINARY_READ_BYTES = 1024 * 1024;
const DEFAULT_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;
// 存在性探测在远程 workspace 上的真实成本是 SSH stat，一次面板刷新可能产生上百次；
// 60s TTL 覆盖同一轮对话里反复提到同一路径的窗口，批次上限 15 限制单次 RPC 的并发尖峰。
// 三者共同约束 FileExistenceCache：TTL 决定新鲜度，MAX_ENTRIES 决定内存，BATCH_LIMIT 决定并发。
const FILE_EXISTENCE_CACHE_TTL_MS = 60_000;
const FILE_EXISTENCE_CACHE_MAX_ENTRIES = 100;
const FILE_EXISTENCE_BATCH_LIMIT = 15;
// 先按扩展名给出确定答案，再回落到 shared 的媒体格式表：扩展名映射覆盖 svg/avif 这类
// mime 与扩展名不一致的常见类型，避免 renderer 再维护一份。两者都不命中时统一 octet-stream，
// 让浏览器按下载而不是内联渲染，防止未知类型被当成 HTML 执行。
const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
// clamp 家族统一处理三种坏输入：undefined（取默认）、NaN/Infinity（Number.isFinite 兜底）、
// 负数或 0（下限 1）。之所以不做单边 Math.min，是因为调用方常把 UI 输入直接透传，
// 负 offset 会变成 read 的越界起点，非整数长度会落到 Buffer.allocUnsafe 的类型校验上。
// [失败路径] 这里静默收敛而不抛错：读文件是高频路径，一次手滑的长度参数不该变成整块 UI 报错；
// 真正的错误（文件不存在、不是文件、超上限）由调用方 stat 后显式抛出。
function clampReadLength(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_TEXT_READ_BYTES)
    : DEFAULT_TEXT_READ_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_TEXT_READ_BYTES);
}
function clampMediaPreviewBytes(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_MEDIA_PREVIEW_BYTES)
    : DEFAULT_MEDIA_PREVIEW_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_MEDIA_PREVIEW_BYTES);
}
function clampBinaryReadLength(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_BINARY_READ_BYTES)
    : DEFAULT_BINARY_READ_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_BINARY_READ_BYTES);
}
function clampBinaryPreviewBytes(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_BINARY_PREVIEW_BYTES)
    : DEFAULT_BINARY_PREVIEW_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_BINARY_PREVIEW_BYTES);
}
function inferMediaTypeFromPath(path: string): string {
  return (
    IMAGE_EXTENSION_TO_MEDIA_TYPE[extname(path).toLowerCase()] ??
    getMediaPreviewFormat(path)?.mediaType ??
    "application/octet-stream"
  );
}
// 二进制判定只看本次读到的窗口：出现 NUL 立即判二进制（任何常见文本编码都不会产生 0x00），
// 其余控制字符占比超过 30% 才算二进制。阈值不能取 0，否则带 ESC 序列的日志会被误判；
// 也不能取更高，否则压缩包与图片在 UTF-8 解码后满是替换字符却仍被当文本塞给编辑器。
// 判定是建议而非结论：readTextFile 命中时返回空 content 而不抛错，让 UI 自行切到预览通道。
function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let suspiciousBytes = 0;
  for (const value of buffer) {
    if (value === 0) {
      return true;
    }
    const isCommonWhitespace = value === 9 || value === 10 || value === 12 || value === 13;
    const isControlChar =
      (value >= 1 && value <= 8) || (value >= 14 && value <= 31) || value === 127;
    if (!isCommonWhitespace && isControlChar) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / buffer.length > 0.3;
}
const SCRATCH_WORKSPACE_ROOT_NAME = "ZCodeProject";
// 名称会直接参与路径拼接（homedir()/ZCodeProject/<name>），因此必须在 join 之前拒绝分隔符：
// 否则 ../.. 或 a/b 可以逃出 ZCodeProject 根，落到用户主目录的任意位置。
// 只校验空值与分隔符，不做字符白名单：过严会让中文名、带空格的目录名不可用。
function validateScratchWorkspaceName(name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Workspace name is required.");
  }
  if (/[\\/]/.test(trimmedName)) {
    throw new Error("Workspace name cannot contain path separators.");
  }
  return trimmedName;
}
// ignore 规则与展示都用 / 分隔的相对路径；Windows 的 relative 给出反斜杠，
// 不归一化会让同一条规则在 desktop 与 web/remote 上命中结果不同，形成跨平台行为分叉。
// 这里不做 realpath：相对路径只用于匹配，跟随软链接会把链接指向的外部路径误纳入 include 判定。
function normalizeRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join("/");
}
// 扫描期可跳过的错误只有权限与消失三类：EACCES/EPERM 表示该子树不可读，
// ENOENT 表示扫描过程中被并发删除。EMFILE、EIO、ENOTDIR 必须上抛，
// 因为跳过会把整个 workspace 扫描失败伪装成目录为空，让 @ 面板静默少文件。
export function isSkippableWorkspaceFileListError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

interface FileExistenceCacheEntry {
  exists: boolean;
  expiresAt: number;
}

// 缓存按路径字符串索引，不做 realpath 归一：同一文件的两个别名各占一条，
// 换取 get 路径上没有异步开销（调用方在首屏渲染热路径上）。
// 容量与 TTL 的清理集中在 set：读路径只判断单条是否过期，避免 get 里做全表扫描。
export class FileExistenceCache {
  private readonly entries = new Map<string, FileExistenceCacheEntry>();

  get size(): number {
    return this.entries.size;
  }

  get(path: string): boolean | undefined {
    const cached = this.entries.get(path);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.entries.delete(path);
      return undefined;
    }

    // Map 保留插入顺序；命中后重新插入，让真正活跃的路径位于 LRU 队尾。
// [权衡] 命中即 delete 加 set 会让 Map 写入频率翻倍，但换来近似 LRU 的淘汰质量；
// 若改成只读不重排，set 里的 oldest 淘汰会退化成 FIFO，活跃路径被误踢后反复发起远程 stat。
    this.entries.delete(path);
    this.entries.set(path, cached);
    return cached.exists;
  }

// [资源] 写入前先扫一遍过期项：只在 get 时判断 TTL 会让只写不读的候选路径永久驻留，
// 在长会话里等价于内存泄漏。随后按插入顺序淘汰最旧条目，容量上限即内存上限。
  set(path: string, exists: boolean): void {
    const now = Date.now();
    // 旧缓存只在同一路径再次读取时判断 TTL，不同路径的过期项会永久留在 Host 内存中。
    // 每次写入先清理全部过期项，再用固定容量兜住持续生成不同候选路径的长生命周期场景。
    for (const [cachedPath, cached] of this.entries) {
      if (cached.expiresAt <= now) {
        this.entries.delete(cachedPath);
      }
    }

    this.entries.delete(path);
    this.entries.set(path, {
      exists,
      expiresAt: now + FILE_EXISTENCE_CACHE_TTL_MS,
    });
    while (this.entries.size > FILE_EXISTENCE_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

// Dirent 的类型来自 readdir 的 d_type，软链接只会置 isSymbolicLink；
// 目录选择器只接受 type === directory，所以指向目录的链接必须再 stat 一次跟随目标。
// [失败路径] stat 失败（悬空链接、权限不足）时回落 file：宁可让用户点开再报错，
// 也不能把不可读的路径标成目录，否则上层会对它的每个子项连续报错。
async function resolveReaddirEntryType(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): Promise<FileEntry["type"]> {
  if (isDirectory) {
    return "directory";
  }
  if (!isSymbolicLink) {
    return "file";
  }
  try {
    const targetStat = await stat(entryPath);
    // Node 的 Dirent 对软链接目录只返回 isSymbolicLink，不会返回 isDirectory。
    // 目录选择器只展示 directory 类型，远程 SSH 选目录时因此看不到指向目录的软链接；这里跟随目标重新分类。
    return targetStat.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

// 过滤器由 Host 注入（本地、Web、远程各自的 include 规则），扫描与候选构造都通过这个实例走；
// 换成模块级单例会让不同 Host 的过滤规则互相污染。
export interface CreateFileServiceOptions {
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
}

/**
 * listWorkspaceFiles 的 Host 侧短 TTL 缓存：
 * 37 万文件 workspace 的全仓扫描即使并发化也要数秒，同一 workspace 的
 * 反复打开（@ 面板关闭即清理的 renderer 语义、Command Center、文件树）
 * 不应每次都重扫。服务内按 workspaceIdentity（缺省为 rootPath）隔离，
 * 校验 rootPath + .zcodeignore 的 mtime/size 指纹；规则编辑后缓存失效，
 * 保持"编辑规则后下次使用生效"的契约。
 */
// 索引缓存有三个维度：60s TTL（新鲜度）、8 路并发（readdir 吞吐）、4 个 workspace（内存）。
// TTL 与容量上限必须同时存在：只靠 TTL 时反复切换 workspace 会让旧索引长期驻留。
const WORKSPACE_FILE_LIST_CACHE_TTL_MS = 60_000;
const WORKSPACE_FILE_LIST_SCAN_CONCURRENCY = 8;
const WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES = 4;
interface WorkspaceFileIndex {
  at: number;
  signature: string;
  packed: string;
  candidates?: ReturnType<typeof buildHostFileSearchCandidates>;
}

// 指纹只用 mtime 加 size，不读内容：每次 @ 面板打开都读一遍 .zcodeignore 在远程链路上太贵，
// 而这两个字段足以覆盖编辑器保存这一常规路径（同尺寸同毫秒的改写是已知漏检窗口）。
async function statWorkspaceFileSearchIgnoreFingerprint(rootPath: string): Promise<string> {
  try {
    const fileStat = await stat(join(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME));
    return `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return "none";
  }
}

// 服务实例是 Host 作用域的文件系统门面：缓存、在途去重表、日志器都挂在闭包里，
// 因此一个进程内多个 workspace 共享同一份 FileExistenceCache，而索引缓存按 workspaceKey 分区。
// 不挂到模块级：Web 端可能在同一进程内服务多个用户，跨实例复用会串数据。
export function createFileService(options: CreateFileServiceOptions = {}): IFileService {
  const workspaceFileSearchFilter =
    options.workspaceFileSearchFilter ?? defaultWorkspaceFileSearchFilter;
  const workspaceIgnoreLogger = createServiceLogger("workspace-file-ignore");
  const fileExistenceCache = new FileExistenceCache();
  // 索引归服务实例；不同 Host/注入过滤器不能通过模块全局缓存复用同路径结果。
  const workspaceFileListCache = new Map<string, WorkspaceFileIndex>();
  const pendingFileExistenceChecks = new Map<string, Promise<boolean>>();

// [并发] 同一路径的并发探测合并到 pendingFileExistenceChecks 里的同一个 Promise，
// 否则一次首屏会为同一缺失文件发起 N 次远程 stat。finally 中删除登记，
// 保证失败的探测不会永久占位，下一次调用仍会重新尝试。
  const checkFileExists = async (path: string): Promise<boolean> => {
    const cached = fileExistenceCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    const pending = pendingFileExistenceChecks.get(path);
    if (pending) {
      return pending;
    }

    const check = stat(path)
      .then((fileStat) => fileStat.isFile())
      .catch(() => false)
      .then((exists) => {
        // 正负结果都缓存：assistant 自然语言经常重复提到同一缺失路径，避免远程 Host
        // 在一分钟内为同一候选重复发起 SSH stat。
        fileExistenceCache.set(path, exists);
        return exists;
      })
      .finally(() => {
        pendingFileExistenceChecks.delete(path);
      });
    pendingFileExistenceChecks.set(path, check);
    return check;
  };

  // 全量扫描 + 打包（带 60s TTL / .zcodeignore 指纹缓存）。分块 RPC 共享同一份 packed。
  const workspaceFileListScanning = new Map<
    string,
    { signature: string; promise: Promise<WorkspaceFileIndex> }
  >();
// 索引装配分三层：workspaceFileListScanning 合并同签名的在途扫描，workspaceFileListCache 存结果，
// refresh 负责强制穿透两者。签名同时包含 rootPath 与 .zcodeignore 指纹：前者防止不同目录误共享，
// 后者让编辑规则后下次使用生效成为可验证的契约，而不是靠 TTL 碰运气。
// [并发] 刷新中的查询必须等待新扫描而不是命中旧缓存，否则刷新窗口内刚创建的文件不可见。
  const ensureWorkspaceFileIndex = async (
    rootPath: string,
    workspaceIdentity?: string,
    refresh = false,
  ): Promise<WorkspaceFileIndex> => {
    const workspaceKey = workspaceIdentity?.trim() || rootPath;
    const ignoreRules = await loadWorkspaceFileSearchIgnoreRules(rootPath, workspaceIgnoreLogger);
    const cacheSignature = `${rootPath}\n${await statWorkspaceFileSearchIgnoreFingerprint(rootPath)}`;
    for (const [key, value] of workspaceFileListCache) {
      if (Date.now() - value.at >= WORKSPACE_FILE_LIST_CACHE_TTL_MS)
        workspaceFileListCache.delete(key);
    }
    const inFlight = workspaceFileListScanning.get(workspaceKey);
    // 刷新中的同作用域查询等待新索引，不能先命中旧缓存而遗漏刚创建的文件。
    if (!refresh && inFlight?.signature === cacheSignature) return inFlight.promise;
    const cached = workspaceFileListCache.get(workspaceKey);
    if (!refresh && cached?.signature === cacheSignature) {
      workspaceFileListCache.delete(workspaceKey);
      workspaceFileListCache.set(workspaceKey, cached);
      return cached;
    }
    const scanning = (async () => {
      const entries: WorkspaceFileEntry[] = [];
      const pendingDirectories: string[] = [rootPath];
      // 单线程串行 DFS 一次只 await 一个 readdir，
      // 37 万文件的 Windows workspace 实测 21.8s；改为共享目录队列的受限并发遍历，
      // 结果仍按既有规则排序，遍历顺序不影响语义。
// [权衡] 用共享栈加固定 worker 数，而不是递归 Promise.all 全展开：后者会同时打开
// 上万个 readdir 句柄，在 Windows 上直接 EMFILE；代价是遍历顺序不确定，
// 因此排序必须在所有 worker 结束后统一做，不能依赖入队顺序。
// pop 取栈顶即深度优先，更早暴露单目录巨树，但语义上只要求最终集合完整。
      const traverseWorker = async (): Promise<void> => {
        for (;;) {
          const currentPath = pendingDirectories.pop();
          if (!currentPath) {
            return;
          }
          let children: Dirent[];
          try {
            children = await readdir(currentPath, { withFileTypes: true });
          } catch (error) {
            if (isSkippableWorkspaceFileListError(error)) {
              continue;
            }
            throw error;
          }
          for (const entry of children) {
            const entryPath = join(currentPath, entry.name);
            const relativePath = normalizeRelativePath(rootPath, entryPath);
            if (relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME) {
              continue;
            }
            const type = await resolveReaddirEntryType(
              entryPath,
              entry.isDirectory(),
              entry.isSymbolicLink(),
            );
            if (isWorkspaceFileSearchPathIgnored(ignoreRules, relativePath, type)) {
              continue;
            }
            const decision = workspaceFileSearchFilter.evaluate(
              { name: entry.name, path: entryPath, relativePath, type },
              { ignoreRulesActive: true },
            );
            if (decision.include) {
              entries.push({ name: entry.name, path: entryPath, relativePath, type });
            }
            if (type === "directory" && !entry.isSymbolicLink() && decision.traverse) {
              pendingDirectories.push(entryPath);
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: WORKSPACE_FILE_LIST_SCAN_CONCURRENCY }, () => traverseWorker()),
      );
// 排序是输出契约的一部分：目录在前，同类按 relativePath 的 locale 顺序。
// 分块 RPC 按字符串偏移切片，若顺序随遍历时序变化，客户端拼出的列表会出现重复或缺失，
// 所以排序必须在打包之前一次完成，且不能被后续增量结果打乱。
      const sorted = entries.sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "directory" ? -1 : 1;
        }
        return left.relativePath.localeCompare(right.relativePath);
      });
// 打包成单个字符串后再切片：换行分隔的文本比等价 JSON 数组小得多，
// 也让分块读取无需在服务端反复序列化，packed.length 直接就是可用的字节总数。
      const packed = packWorkspaceFileEntries(sorted);
      return { at: Date.now(), signature: cacheSignature, packed };
    })();
    workspaceFileListScanning.set(workspaceKey, { signature: cacheSignature, promise: scanning });
    try {
      const index = await scanning;
      // 显式刷新/规则变化可替换在途扫描，旧扫描完成时只服务旧请求，不覆盖新索引。
      if (workspaceFileListScanning.get(workspaceKey)?.promise === scanning) {
        workspaceFileListCache.delete(workspaceKey);
        workspaceFileListCache.set(workspaceKey, index);
        while (workspaceFileListCache.size > WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES) {
          const oldest = workspaceFileListCache.keys().next().value;
          if (oldest === undefined) break;
          workspaceFileListCache.delete(oldest);
        }
      }
      return index;
    } finally {
      if (workspaceFileListScanning.get(workspaceKey)?.promise === scanning)
        workspaceFileListScanning.delete(workspaceKey);
    }
  };

  return {
// readdir 不套 workspace 索引缓存：它服务目录选择器等当前目录场景，需要即时反映外部改动。
// 隐藏文件默认过滤是为了不改变旧调用方的观感，文件树显式传 includeHidden 才展示点文件。
    async readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]> {
      const entries = await readdir(params.path, { withFileTypes: true });
      const visibleEntries = await Promise.all(
        entries
          .filter((e) => {
            // 修复：workspace 文件树需要展示 .gitignore/.env/.github 等项目文件，
            // 但目录选择器等旧调用仍应默认隐藏 dotfiles，避免突然增加噪音。
            return params.includeHidden === true || !e.name.startsWith(".");
          })
          .map(async (e) => {
            const entryPath = join(params.path, e.name);
            return {
              name: e.name,
              path: entryPath,
              type: await resolveReaddirEntryType(entryPath, e.isDirectory(), e.isSymbolicLink()),
              isSymbolicLink: e.isSymbolicLink(),
            };
          }),
      );
      return visibleEntries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },
// stat 只返回路径身份信息，不返回内容：调用方据此决定走文本、媒体还是二进制预览。
// 目录不返回 size 与 mtime（对目录无意义，且会让 UI 误以为可以分块读取）。
// 这里不跟随软链接做身份归一，realpath 由 resolvePath 单独提供。
    async stat(params: { path: string }) {
      const fileStat = await stat(params.path);
      // markdown 链接点击时需要区分文件和目录。
      // 之前统一当文件打开，目录会落到 CodeViewer 里读文件失败；这里把判断收口到服务层，
      // UI 只根据结构化结果分流到预览或临时文件树。
      const isDirectory = fileStat.isDirectory();
      return {
        path: params.path,
        type: isDirectory ? ("directory" as const) : ("file" as const),
        // 目录的 size 无意义，只对文件返回，供预览层决定二进制文件的加载策略
        ...(isDirectory ? {} : { size: fileStat.size, mtimeMs: fileStat.mtimeMs }),
      };
    },
// 批次上限 15 是协议约束而非性能优化：超出直接抛错而不是截断，
// 避免调用方以为所有候选都检查过。Promise.all 保序让结果与入参一一对应。
    async checkFilesExist(params: {
      paths: string[];
    }): Promise<Array<{ path: string; exists: boolean }>> {
      if (params.paths.length > FILE_EXISTENCE_BATCH_LIMIT) {
        throw new Error(
          `File existence check supports at most ${FILE_EXISTENCE_BATCH_LIMIT} paths.`,
        );
      }

      // 调用方已按正文逆序选出候选；Promise.all 保持输入顺序，并把单批并发硬限制在 15。
      return Promise.all(
        params.paths.map(async (path) => ({
          path,
          exists: await checkFileExists(path),
        })),
      );
    },
// realpath 是 workspace 身份归一化的唯一入口：远程 Host 常用 /dev、/home/dev 这类别名挂载，
// 不归一会让同一目录被当成两个 workspace，进而分裂会话列表与索引缓存。
// [权衡] 它会解析全部软链接段，路径不存在时直接抛错；这正是期望行为，
// 身份计算不接受看起来存在的路径。
    async resolvePath(params: { path: string }): Promise<string> {
      // 远程 workspace 可能通过符号链接别名输入（/dev vs /home/dev）。
      // 这里统一走 realpath，供上层做稳定身份计算，避免同目录被识别成两个 workspace。
      return realpath(params.path);
    },
// 默认 workspace 位于 homedir()/ZCodeProject，recursive 让重复调用幂等；
// 建完必须再 stat 确认是目录：同名文件会让 mkdir 抛错，而某些挂载点的成功语义模糊，
// 统一以 stat 结果为准可以让两条失败路径收敛到同一条报错。
    async createDefaultWorkspace(): Promise<{ path: string }> {
      const workspacePath = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME);
      await mkdir(workspacePath, { recursive: true });
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      return { path: workspacePath };
    },
// 会话 workspace 用 created 标记本次是否真的新建，UI 据此决定是否提示；
// [失败路径] mkdir 失败后不直接抛：并发创建时另一进程可能刚建好目录，
// 因此再 stat 一次，只有确实不是目录时才把原始错误连同 cause 抛出去。
    async ensureConversationWorkspace() {
      const workspacePath = getConversationWorkspaceDir();
      let created = false;
      try {
        created = (await mkdir(workspacePath, { recursive: true })) !== undefined;
      } catch (error) {
        const workspaceStat = await stat(workspacePath).catch(() => null);
        if (!workspaceStat) {
          throw error;
        }
        if (!workspaceStat.isDirectory()) {
          throw new Error(`Workspace path is not a directory: ${workspacePath}`, {
            cause: error,
          });
        }
      }
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      return {
        path: workspacePath,
        created,
        workspacePurpose: "conversation" as const,
      };
    },
// 名称必须先过校验再拼路径，顺序不能反：拼接后校验等于让越界路径先进入 join 的结果，
// 后续任何 stat 或 mkdir 都会作用在 ZCodeProject 之外。
// 只建目录不写模板：Start from scratch 的空目录语义由 UI 呈现，服务层不引入额外副作用。
    async createScratchWorkspace(params: { name: string }): Promise<{ path: string }> {
      const workspaceName = validateScratchWorkspaceName(params.name);
      const workspacePath = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME, workspaceName);
      await mkdir(workspacePath, { recursive: true });
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      // Start from scratch 必须通过 service 层创建空目录，UI 只提交名称。
      // 这里仅确保目录存在，不初始化 git、不写模板文件；mkdir recursive 让已存在目录幂等成功。
      return { path: workspacePath };
    },
// 文本读取走 stat、算窗口、open/read/close 三步，而不是 readFile 后切片：
// 远程链路上 readFile 会把整个文件传回，256KB 上限就完全失去意义。
// [资源] open 之后的所有路径都必须经过 finally 的 close，包括 read 抛错与二进制分支。
    async readTextFile(params: {
      path: string;
      offset?: number;
      length?: number;
    }): Promise<FileTextSlice> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
// offset 先夹成非负整数再与 size 比较：负数 offset 会让 read 的 position 落到文件头之前，
// 底层要么抛 ERR_OUT_OF_RANGE，要么读到意外区域。offset 已到文件尾时直接返回空切片，
// 既省掉一次 open，也让读到底是幂等的空操作。
      const offset = Math.max(0, Math.trunc(params.offset ?? 0));
      if (offset >= fileStat.size) {
        return {
          path: params.path,
          content: "",
          offset,
          bytesRead: 0,
          totalBytes: fileStat.size,
          truncated: false,
          isBinary: false,
        };
      }
// 读取长度受调用方请求、默认值与硬上限三者约束，最后还要与剩余字节取小：
// 少了最后一步，read 会请求超出文件尾的长度，虽然 Node 会截断，
// 但 bytesRead 与 truncated 的语义依赖实际窗口，不能靠底层兜底。
      const targetLength = clampReadLength(params.length);
      const remainingBytes = fileStat.size - offset;
      const readLength = Math.min(targetLength, remainingBytes);
      const handle = await open(params.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        const chunk = buffer.subarray(0, bytesRead);
// 判定只看本窗口：文件开头是文本、后段嵌入二进制时，后续分块会把 isBinary 翻成 true，
// UI 以任一分块为二进制作为整体判据。
        const isBinary = isProbablyBinary(chunk);
        // 性能说明：文本读取始终受 256KB 硬上限约束，调用方可据 truncated 决定是否展示，
        // 避免大文件或远程文件一次性 readFile 把 utility process 和 renderer 一起拖慢。
        return {
          path: params.path,
          content: isBinary ? "" : chunk.toString("utf-8"),
          offset,
          bytesRead,
          totalBytes: fileStat.size,
          truncated: offset + bytesRead < fileStat.size,
          isBinary,
        };
      } finally {
        await handle.close();
      }
    },
// 二进制分块供图片、PDF 等需要精确偏移的预览使用：offset 由调用方按上一次的
// bytesRead 累积，服务端不维护游标，无状态才能重试与水平扩展。
// 空结果用长度为 0 的 Uint8Array 表示而不是 null，避免 RPC 层出现两种没有数据的表示。
    async readFileRange(params: {
      path: string;
      offset: number;
      length: number;
    }): Promise<Uint8Array> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const offset = Math.max(0, Math.trunc(params.offset));
      if (offset >= fileStat.size) {
        return new Uint8Array(0);
      }
// 与文本读取共用 1 到上限的夹取语义，但上限是 1MB：二进制没有按行截断的退路，
// 单块过大会让序列化缓冲区与接收端内存一起翻倍。
      const targetLength = clampBinaryReadLength(params.length);
      const readLength = Math.min(targetLength, fileStat.size - offset);
      const handle = await open(params.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        // 返回顶层 Uint8Array：RPC 序列化只有顶层二进制走原始字节通道，
        // 包成对象字段会退化成 JSON+base64，大文件分段加载的体积收益就没了。
        // 这里拷贝成独立 buffer，避免 allocUnsafe 共享池的无关字节被一起克隆出去。
// [权衡] 这次拷贝无法省：subarray 共享 allocUnsafe 的池化 ArrayBuffer，
// 直接外传会让接收端看到池中相邻的无关字节，也让该 Buffer 池无法回收。
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
// 媒体预览先按扩展名与格式表确定 mediaType，再一次性 base64 返回；
// 超过 8MB 直接抛错而不是截断，因为图片截断后无法解码，静默返回坏数据
// 只会让 UI 显示空白图且没有任何可诊断信息。
    async readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const maxBytes = clampMediaPreviewBytes(params.maxBytes);
      if (fileStat.size > maxBytes) {
        throw new Error(`File is too large to preview: ${params.path}`);
      }
      // 媒体预览继续通过 service 抽象兼容 desktop / web / remote，而不是在 UI 层直接碰文件系统。
      const content = await readFile(params.path);
      return {
        path: params.path,
        mediaType: inferMediaTypeFromPath(params.path),
        dataBase64: content.toString("base64"),
        totalBytes: fileStat.size,
      };
    },
// Office 预览必须是完整 ZIP/OLE 字节：分块读取会让解析器看到半个中央目录。
// 因此这里全量 readFile 加 25MB 硬上限，超限抛 too large 而不是降级为分块，
// 让上层可以明确提示用户改用外部打开，而不是拿到一个永远解析失败的预览。
    async readBinaryPreview(params: {
      path: string;
      maxBytes?: number;
    }): Promise<FileBinaryPreview> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const maxBytes = clampBinaryPreviewBytes(params.maxBytes);
      if (fileStat.size > maxBytes) {
        throw new Error(`File is too large to preview: ${params.path}`);
      }
      // Office 解析器需要完整的 ZIP / OLE 字节，不能复用文本分块读取。
      // 这里在 service 层先做 25 MB 硬上限，再以 base64 跨 RPC 返回，
      // 保持 desktop、Web 和远程 workspace 使用同一文件读取边界。
      const content = await readFile(params.path);
      return {
        path: params.path,
        dataBase64: content.toString("base64"),
        totalBytes: fileStat.size,
      };
    },
// 搜索在 Host 侧完成，不把候选集发给 renderer：37 万文件的候选数组过 RPC 比查询本身更贵。
// limit 同时受协议上限与调用方请求约束，0 直接短路（输入清空时的常见调用）；
// 非有限数与非字符串 query 抛错，避免把 NaN 透传给 slice 变成返回全部。
    async searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]> {
      const requestedLimit = params.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
      if (!Number.isFinite(requestedLimit) || typeof params.query !== "string") {
        throw new Error("Invalid workspace file search query or limit");
      }
      const limit = Math.min(
        WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
        Math.max(0, Math.trunc(requestedLimit)),
      );
      if (limit === 0) return [];
      const index = await ensureWorkspaceFileIndex(
        params.rootPath,
        params.workspaceIdentity,
        params.refresh,
      );
      index.candidates ??= buildHostFileSearchCandidates(index.packed, params.rootPath);
      return searchHostFileCandidates(await index.candidates, params.query, limit);
    },
// 长度与分块共用同一份 packed 索引：两次调用之间若有 refresh，二者可能来自不同代，
// 因此客户端必须以首次拿到的 length 为准，并在 refresh 后重新拉取全部区间。
    async listWorkspaceFilesLength(params: { rootPath: string }): Promise<number> {
      const { packed } = await ensureWorkspaceFileIndex(params.rootPath);
      return packed.length;
    },
// 按字符串区间切片：offset 与 length 都夹成非负整数并与 packed.length 取小，
// 保证任何调用方参数都不会产生越界或负数切片。offset 越界返回空串而不是抛错，
// 让客户端在索引缩短（文件被删）时自然收敛。
    async listWorkspaceFilesRange(params: {
      rootPath: string;
      offset: number;
      length: number;
    }): Promise<string> {
      const { packed } = await ensureWorkspaceFileIndex(params.rootPath);
      const offset = Math.max(0, Math.trunc(params.offset));
      if (offset >= packed.length) {
        return "";
      }
      const length = Math.max(0, Math.trunc(params.length));
      return packed.slice(offset, Math.min(packed.length, offset + length));
    },
// 返回 source 区分用户文件与内置模板，UI 据此决定是否提示尚未自定义；
// 落盘位置与命名由 workspaceFileIgnore 统一管理，服务层只做转发。
    async readWorkspaceFileSearchIgnore(params: {
      rootPath: string;
    }): Promise<{ content: string; source: "file" | "template" }> {
      return readWorkspaceFileSearchIgnore(params.rootPath);
    },
// transform 是纯函数式的规则生成（sync-gitignore、reset-defaults），只返回内容不落盘：
// 应用与否由 UI 再调 write 决定，避免一次误点就覆盖用户规则。
    async applyWorkspaceFileSearchIgnoreTransform(params: {
      rootPath: string;
      transform: "sync-gitignore" | "reset-defaults";
    }): Promise<{ content: string }> {
      return transformWorkspaceFileSearchIgnore(params.rootPath, params.transform);
    },
// 写入后不主动失效索引缓存：签名里的 mtime 加 size 指纹会让下一次
// ensureWorkspaceFileIndex 自然判定为新扫描，本地与远程共用同一套失效逻辑。
    async writeWorkspaceFileSearchIgnore(params: {
      rootPath: string;
      content: string;
    }): Promise<void> {
      await writeWorkspaceFileSearchIgnore(params.rootPath, params.content);
    },
  };
}
