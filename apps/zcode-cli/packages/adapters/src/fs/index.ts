// ============================================================
// Node FileSystem Adapter
// ============================================================
/**
 * ============================================================================
 * fs/index.ts —— FileSystemPort 的 Node 实现
 * ============================================================================
 *
 * 【定位】Agent 工具的唯一文件系统入口。所有路径必须是绝对路径（否则
 * invalid_path）；读文本会做编码探测/换行归一，写文本默认原子替换，
 * 搜索优先使用 WASI ripgrep、运行时失败再降级到纯 JS。
 *
 * 【revision 口径】id = `mtime:<整数毫秒>:size:<字节>`，是乐观锁的 CAS 键；
 * 写文件传 expectedRevision 时只比对 id（不比 hash），不符抛 stale_write。
 * 读接口额外附 sha256 供上层做更严格的校验。
 *
 * 【写入语义】atomic=true（默认）走"临时文件 + fsync + rename"，保留原文件
 * 权限位；拒绝写穿符号链接（lstat 预检 + O_NOFOLLOW）。rename 失败时降级为
 * 就地截断写（仍拒绝符号链接）。
 *
 * 【搜索语义】文本搜索默认 ripgrep（files_with_matches/content/count 三模式），
 * ripgrep 运行时故障才降级 JS；用户取消/超时不会降级。JS 模式逐文件读入内存，
 * 跳过疑似二进制；结果统一按 mtime 倒序、再按 headLimit/offset 截断。
 *
 * 【错误归一】所有异常最终映射成 FileSystemPortError：ENOENT→not_found、
 * EACCES/EPERM→permission_denied、EISDIR→is_directory、ENAMETOOLONG→invalid_path、
 * 其余→io_error；AbortError 单独保留为 cancelled。
 * ============================================================================
 */

// ============================================================================
// 文件头：职责边界与不变量（INV）
// ============================================================================
//
// 【职责边界】
// - 只做 FileSystemPort 契约到 Node fs API 的适配与错误归一，不承载权限判定、
//   工作区白名单、工具策略；这些属于上层 tool/runtime，写进本文件即越权。
// - 全仓库唯一允许直接 import node:fs 的出口；业务层再引用 node:fs 就绕过了
//   这里的绝对路径校验、原子写与错误归一。
// - 无长期句柄、无内存缓存：每次调用自成事务，实例本身可安全复用与并发调用。
//
// 【不变量 INV】
// INV-01 每个公开方法入口必须经 resolveAbsoluteRequestPath 归一；绕过时相对路径
//   会按进程 cwd 解析，工具执行期 cwd 可能已变，导致写错位置。
// INV-02 每个公开方法 catch 必须经 toFileSystemError；漏掉则 errno 原样外泄，
//   上层依赖的 not_found/permission_denied 分支全部失效。
// INV-03 writeTextFile 的 CAS 必须在 mkdir 与落盘之前执行；顺序颠倒后即使发现
//   stale_write，文件也已被改，无法回滚。
// INV-04 atomicWrite 必须先 lstat 拒绝符号链接；删掉预检会顺着链接写到任意目标。
// INV-05 临时文件必须以 O_EXCL|O_NOFOLLOW 创建；缺 O_EXCL 时并发写会互相覆盖，
//   缺 O_NOFOLLOW 时临时名被预置为链接即可劫持写入。
// INV-06 权限位必须在 rename 之前 chmod 到临时文件；rename 换成新 inode，
//   事后 chmod 作用在旧 inode 上，脚本执行位仍会丢失。
// INV-07 revision.id 必须是 mtime 截断到整数毫秒 + size；提高精度会让浮点尾差
//   产生假 stale_write，降低精度会漏掉真实修改。
// INV-08 CAS 只比对 id，不比对 hash；改成 hash 需要在写前整读大文件，成本不可接受。
// INV-09 只有 RipgrepRuntimeFailure 允许降级到 JS 搜索；把取消/超时也纳入降级会把
//   用户的 stop 变成一次全量慢搜，体验与资源双重恶化。
// INV-10 ripgrep 必须在 Worker 中执行；挪回主线程会占住 event loop，用户 stop 的
//   消息虽已到达却无人处理，表现为中止无效。
// INV-11 worker 的 settle 必须只生效一次并清理 timer 与 abort 监听；重复 settle 会
//   让 Promise 二次结值并泄漏监听，超时后仍可能改写结果。
// INV-12 AbortError 必须优先于 errno 分支映射为 cancelled；否则中止被报成 io_error，
//   上层无法区分用户取消与磁盘故障。
// INV-13 readTextFile 超限允许截断（truncated=true），readBinaryFile 超限必须
//   too_large；两者语义不可互换，二进制截断结果没有使用价值。
// INV-14 JS 搜索在非 content 模式强制 onlyMatching=false；count 模式需要整行匹配数，
//   沿用 onlyMatching 会把计数变成子匹配数。
// INV-15 headLimit 只截断输出，numMatches 必须保持全量；否则上层分页统计与提示失真。
// INV-16 sortPathsByMtime 的 stat 失败按 mtime=0 垫底且不得抛错；搜索与删除并发时
//   文件刚消失属于正常竞态，抛错会让整次搜索失败。
// INV-17 VCS 目录排除必须同时给出目录本身与任意层级子目录两条 glob；只给一条会
//   在嵌套 monorepo 中漏排 .git 内部对象。
// INV-18 glob 匹配必须同时支持相对路径与 basename 口径；只保留一种会漏掉 `*.ts`
//   这类不含斜杠、按文件名匹配的常见写法。
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type { RgArg, RipgrepBufferedResult } from "ripgrep";
import {
  createFileSystemError,
  isFileSystemPortError,
  type FileSystemNodeKind,
  type FileSystemPort,
  type FileSystemCreateDirectoryRequest,
  type FileSystemCreateDirectoryResult,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemListDirectoryRequest,
  type FileSystemListDirectoryResult,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemRevision,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextEntry,
  type FileSystemTextSearchOutputMode,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";
import {
  applyRequestedLineEndings,
  decodeTextBuffer,
  detectLineEndings,
  encodeTextContent,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";
import { readTextFileRangeFromNode } from "./text-range-reader.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";

// [权衡] 100 是 glob 结果的默认上限：既要让模型看到足够候选，
// 又要避免把巨大目录树一次性灌进上下文；需要更多结果时由调用方显式放大 maxResults，
// 而不是在这里调大默认值。
// truncated 字段用于告知调用方「还有剩余」，调大默认值会掩盖这一信号。
const DEFAULT_GLOB_MAX_RESULTS = 100;
const DEFAULT_GREP_HEAD_LIMIT = 250;
const DEFAULT_RIPGREP_TIMEOUT_MS = 30_000;
// [契约] 这里列的是「永不参与搜索」的版本库元数据目录名，大小写按
// POSIX/Linux 惯例；Windows 上大小写不敏感，不做小写归一也能命中常见情况，
// 但不要把用户可见的业务目录加进来——排除是硬编码行为，调用方无法撤销。
// 新增条目只应来自确实会产生海量噪声对象的 VCS 元数据目录。
const VCS_DIRECTORIES_TO_EXCLUDE = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

type RipgrepWorker = Pick<Worker, "once" | "terminate">;

interface RipgrepWorkerData {
  args: string[];
  preopens: Record<string, string>;
}

interface SerializedWorkerError {
  code?: unknown;
  message?: string;
  name?: string;
  stack?: string;
}

type RipgrepWorkerMessage =
  | { type: "result"; result: RipgrepBufferedResult }
  | { type: "error"; error: SerializedWorkerError };

type RipgrepWorkerFactory = (workerData: RipgrepWorkerData) => RipgrepWorker;

// [契约] 模块级可变状态仅服务于测试注入，生产路径默认 undefined 并走真实 Worker。
// 不要把它改造成实例字段：搜索实现是模块级函数，实例化多个 adapter 时须共享同一份
// 注入值，否则测试替换会因实例不同而失效。
let ripgrepWorkerFactoryForTests: RipgrepWorkerFactory | undefined;
let ripgrepTimeoutMsForTests: number | undefined;

// [资源] worker 源码以字符串形式内联，用 eval 启动，避免打包时被拆成独立 chunk
// 而在单文件分发（CLI 打包产物）里丢失路径。
// [失败路径] worker 内把异常序列化成 {code,message,name,stack} 再回传：Error 实例
// 无法结构化克隆，直接 post 会抛 DataCloneError 并掩盖真正的失败原因。
// worker 内部 env 固定为空对象，不继承父进程环境，避免泄露用户凭据类变量。
const RIPGREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "Error" };
  }
  return {
    code: "code" in error ? error.code : undefined,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

(async () => {
  try {
    const { ripgrep } = await import("ripgrep");
    const result = await ripgrep(workerData.args, {
      buffer: true,
      env: {},
      nodeWasi: false,
      preopens: workerData.preopens,
      returnOnExit: true,
    });
    parentPort.postMessage({ type: "result", result });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) });
  }
})();
`;

export interface NodeFileSystemAdapterOptions {
  /** 文本搜索引擎；"javascript" 强制纯 JS，缺省优先 ripgrep 并在运行时失败时降级。 */
  textSearchEngine?: "ripgrep" | "javascript";
}

/**
 * 文件系统端口实现（无状态，可安全复用）。
 *
 * 每个方法只做一次路径归一 + try/catch 归一错误；真正的复杂逻辑在下方
 * 模块级 helper 中。搜索/读写都不持有长期文件句柄。
 */
// [契约] 无状态实现：唯一实例字段是只读的引擎选项，因此可被多个会话共享。
// 新增字段前先确认它不会成为跨会话污染源；需要缓存应放到上层，而不是 adapter。
export class NodeFileSystemAdapter implements FileSystemPort {
  constructor(private readonly adapterOptions: NodeFileSystemAdapterOptions = {}) {}

  /** 递归创建目录（已存在不报错）；返回 normalize 后的绝对路径。 */
  async createDirectory(
    request: FileSystemCreateDirectoryRequest,
  ): Promise<FileSystemCreateDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      maybeThrowStorageFsFault({ operation: "mkdir", path });
      // recursive:true 让「目录已存在」与「多级父目录缺失」都成功，这就是幂等语义的来源。
      // [权衡] 不校验 path 是否已存在且为文件：此处的 EEXIST/ENOTDIR 会由
      // toFileSystemError 归一为 io_error，而不是 is_directory，这是调用方需要容忍的口径。
      await mkdir(path, { recursive: true });
      return { path };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * stat 路径。
   *
   * 输出 kind（file/directory/symlink/other）；revision 只对普通文件给出
   * （mtime+size 的 CAS 键），目录等非文件为 undefined。
   */
  async stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      const info = await stat(path);
      const kind = nodeKind(info);
      return {
        path,
        kind,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        revision:
          kind === "file"
            ? {
                id: revisionId(info.mtimeMs, info.size),
                mtimeMs: info.mtimeMs,
                sizeBytes: info.size,
              }
            : undefined,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 读文本文件。
   *
   * maxBytes 存在时是"允许读取的上限"：超过则只读前 maxBytes 并 truncated=true，
   * 不报错（与 readBinaryFile 的 too_large 不同，文本读取允许截断）。
   * 文本编码会探测（UTF-8/UTF-16 等），可解码编码下换行统一为 LF 并在
   * lineEndings 里回传原始风格；二进制编码（如 latin1）不做换行归一。
   * 副作用：只读；revision.hash 为实际读入内容的 sha256（截断时只覆盖已读部分）。
   */
  async readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as text file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as text: ${path}`,
        });
      }

      // 截断读取用随机读只取头部，避免大文件整体进内存；无上限才整读。
      const maxBytes = request.maxBytes;
      // [契约] 截断与否只在这一处判定，后续 bytesRead/sizeBytes 必须保持「不等」以表达
      // 「文件比返回内容大」；改成按实际读入长度比较会让空文件与截断文件无法区分。
      // [失败路径] stat 与读取之间文件增长时，truncated 仍按 stat 快照计算，
      // 结果可能少截断一部分——这是可接受的弱一致，读取本身仍有界。
      const truncated = maxBytes !== undefined && info.size > maxBytes;
      // 截断路径用随机读只取头部，避免大文件整体进内存；无上限才整读。
      // [资源] 这里是有界读取的唯一分叉点，新增分支必须保证不会整文件读入。
      const buffer = truncated ? await readFirstBytes(path, maxBytes) : await readFile(path);
      const decoded = decodeTextBuffer({ buffer, encoding: request.encoding, path });
      const rawContent = decoded.content;
      const encoding = decoded.encoding;
      // [契约] 只有可判定为文本的编码才做换行探测与归一；latin1 等二进制编码保留原字节，
      // 否则会把合法二进制内容里的 0x0D0A 误改成 0x0A 并破坏数据。
      // lineEndings 只回传原始风格，不参与 revision 计算，避免归一改变 CAS 键。
      const isText = shouldNormalizeLineEndings(encoding);
      const lineEndings = isText ? detectLineEndings(rawContent) : undefined;
      const content = isText ? normalizeLineEndings(rawContent) : rawContent;

      return {
        path,
        content,
        encoding,
        lineEndings,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        truncated,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 读二进制文件。
   *
   * 与文本读取不同：超过 maxBytes 直接抛 too_large，不做截断——二进制被截断
   * 通常不可用。仍有"stat 后文件增长"的二次校验，且读取本身有界。
   * 输出 content 为 Buffer，revision.hash 覆盖实际读入字节。
   */
  async readBinaryFile(request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as binary file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as binary: ${path}`,
        });
      }
      if (request.maxBytes !== undefined && info.size > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content (${formatByteCount(info.size)}) exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }

      const buffer =
        request.maxBytes === undefined
          ? await readFile(path)
          : await readAtMostBytes(path, request.maxBytes + 1, info.size);
      // [失败路径] 这是 stat 之后的二次上限校验：stat 时文件可能还没这么大，
      // 读取期间被追加。必须保留，否则 maxBytes 既挡不住超限内容，也挡不住一次大内存分配。
      // 此处抛 too_large，与文本读取的截断语义刻意不同。
      if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
        // stat 与 readFile 之间文件可能增长；实际读取也必须保持有界，
        // 否则 maxBytes 既挡不住超限内容，也挡不住一次性大内存分配。
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }
      return {
        path,
        content: buffer,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 按行范围读文本（offset/limit）。
   *
   * 具体分块逻辑在 text-range-reader：只读覆盖目标行的字节区间，避免整文件
   * 读入。取消通过 signal 传播，最终统一为 cancelled。空文件/越界范围返回
   * 空内容而非报错（由 reader 定义精确口径）。
   */
  async readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemReadTextRangeResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as text file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as text: ${path}`,
        });
      }

      // [契约] 把已归一的绝对路径和已取得的 stat 一起下传，避免子模块重复 stat 造成
      // 两次快照不一致；分块读取只覆盖目标行所在字节区间。
      // [失败路径] 子模块抛出的 AbortError 由外层 catch 统一归一为 cancelled。
      return await readTextFileRangeFromNode({ ...request, path }, info, options?.signal);
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 写文本文件。
   *
   * 输入 content 先按 lineEndings 转换，再按 encoding 编码（非法编码/不可编码
   * 内容抛 invalid_encoding）。expectedRevision 存在时先做 CAS，不符 stale_write
   * 且不写。createParents 递归建父目录；atomic 默认 true。
   * 副作用：写盘；返回实际写入字节数与写后 revision（hash 为写入内容 hash）。
   */
  async writeTextFile(request: FileSystemWriteTextRequest): Promise<FileSystemWriteTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const encoding = request.encoding ?? "utf8";
    // [契约] 换行转换必须发生在编码之前：先编码再替换字节会破坏多字节字符边界。
    // lineEndings 不做合法性回退，非法取值由 applyRequestedLineEndings 决定行为，
    // 这里不重复兜底。
    const textContent = applyRequestedLineEndings(request.content, request.lineEndings);
    // [契约] 编码在进入 try 之前完成：非法编码/不可编码字符在这里就以 invalid_encoding
    // 失败，不会触碰磁盘。
    // 把编码挪进 try 内不会改变错误码，但会让「尚未产生副作用」这一前提变得不直观，
    // 后续新增写前步骤时容易误判顺序。
    const content = encodeTextContent({ content: textContent, encoding, path });

    try {
      // CAS 必须在任何写入/建目录之前：一旦落盘再发现 revision 不符就无法回滚。
      // [事务] 显式乐观锁：只有调用方传 expectedRevision 才做 CAS，缺省是覆盖写。
      // 不要把这里改成默认校验——很多工具场景（新建文件、生成器输出）没有前置读取。
      // CAS 失败时抛 stale_write 且不写、不建目录，保证「要么整体不发生，要么整体发生」。
      if (request.expectedRevision) {
        await this.assertExpectedRevision(path, request.expectedRevision);
      }

      if (request.createParents) {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(path) });
        // [失败路径] 父目录 creation 在 CAS 之后、写盘之前：CAS 失败时不应留下新建目录。
        // 递归创建使并发写同一新目录成为幂等操作，多个进程同时 mkdir 不会互相报错。
        await mkdir(dirname(path), { recursive: true });
      }

      // [权衡] 缺省 atomic=true 是安全优先：崩溃时最多留下临时文件，不会出现半截内容。
      // atomic=false 只用于调用方明确要求就地写（如某些需要保持 inode 的场景），
      // 此时没有 rename，进程被杀会留下截断文件。
      if (request.atomic ?? true) {
        await atomicWrite(path, content);
      } else {
        maybeThrowStorageFsFault({ operation: "writeFile", path });
        await writeFile(path, content);
      }

      const info = await stat(path);
      return {
        path,
        bytesWritten: content.byteLength,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(content),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 删除文件。
   *
   * missingOk=true 时 ENOENT 返回 {removed:false} 而不抛错（幂等删除）；
   * 其他错误照常归一抛出。取消在 unlink 前检查。
   */
  async removeFile(
    request: FileSystemRemoveFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemRemoveFileResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      throwIfAborted(options?.signal);
      maybeThrowStorageFsFault({ operation: "rm", path });
      await unlink(path);
      return { path, removed: true };
    } catch (error) {
      // [失败路径] 删除失败必须先归一，再判断 missingOk：直接用原始 errno 判断会
      // 把端口错误与 Node 错误混为一谈，跨平台行为不一致。
      // 归一后仍要原样抛出，不能在这里吞掉，幂等只对 not_found 生效。
      const normalized = toFileSystemError(error, path);
      if (
        // [契约] 严格等于 true：调用方传 "yes"、1 等真值都不算开启幂等删除，
        // 避免配置反序列化后的类型漂移悄悄改变副作用语义。
        // 只吞 not_found，权限错误与 IO 错误照旧上抛。
        request.missingOk === true &&
        isFileSystemPortError(normalized) &&
        normalized.code === "not_found"
      ) {
        return { path, removed: false };
      }
      throw normalized;
    }
  }

  /**
   * 列目录（非递归）。
   *
   * 返回按 name 升序的 kind/name/path；durationMs 为实际耗时。路径必须是目录，
   * 否则 not_file。只读；取消在 stat 后与 readdir 后各检查一次。
   */
  async listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemListDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const startedAt = Date.now();

    try {
      throwIfAborted(options?.signal);
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Directory listing path must be a directory: ${path}`,
        });
      }

      const entries = await readdir(path, { withFileTypes: true });
      throwIfAborted(options?.signal);
      const mapped = entries
        .map((entry) => ({
          kind: direntKind(entry),
          name: entry.name,
          path: join(path, entry.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        path,
        durationMs: Math.max(0, Date.now() - startedAt),
        entries: mapped,
        numEntries: mapped.length,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 按 glob 搜文件名（递归）。
   *
   * pattern 为必填、trim 后非空；匹配对象是相对 root 的 POSIX 路径与 basename。
   * 结果按 mtime 倒序（同 mtime 按路径），再按 offset/maxResults（默认 100）
   * 切片；truncated 表示切片后仍有剩余。只返回文件路径，不含目录。
   */
  async searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchFilesResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const pattern = request.pattern.trim();
    const startedAt = Date.now();

    if (pattern.length === 0) {
      throw createFileSystemError({
        code: "invalid_pattern",
        path,
        message: "Glob pattern must not be empty",
      });
    }

    try {
      throwIfAborted(options?.signal);
      const rootInfo = await stat(path);
      if (!rootInfo.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Glob search path must be a directory: ${path}`,
        });
      }

      // glob 在收集阶段就编译一次并复用，避免每个文件都重建正则。
      // [契约] 匹配口径由 createGlobMatcher 统一维护，这里不再附加任何额外规则，
      // 否则 searchFiles 与 textSearch 的 glob 语义会分叉。
      const matcher = createGlobMatcher(pattern);
      const matches: Array<{ path: string; mtimeMs: number }> = [];

      // [并发] 递归遍历是串行的：逐目录 readdir、逐文件 stat，取消在每个条目间检查。
      // 改成 Promise.all 并发遍历会让大目录瞬间打开大量句柄并绕过取消点的节奏，
      // 在 Windows 上还容易触发 EMFILE。
      // [契约] 回调只收集匹配项，不排序；排序与截断由调用方统一处理。
      await walkFiles(path, options?.signal, async (filePath, info) => {
        const relativePath = toPosixRelative(path, filePath);
        if (matcher(relativePath, basename(filePath))) {
          matches.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
        }
      });

      matches.sort((left, right) => {
        const timeComparison = right.mtimeMs - left.mtimeMs;
        return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
      });

      const offset = request.offset ?? 0;
      // [契约] 区分 undefined 与 0：传 0 表示只要文件列表不设上限语义之外的边界，
      // 这里不做特殊处理，由 slice(offset, offset+0) 得到空列表，调用方需自行判断。
      const maxResults = request.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
      const files = matches.slice(offset, offset + maxResults).map((match) => match.path);

      return {
        path,
        pattern,
        durationMs: Math.max(0, Date.now() - startedAt),
        files,
        numFiles: files.length,
        truncated: matches.length > offset + maxResults,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 文本搜索（ripgrep 优先，运行时失败降级 JS）。
   *
   * 三种 outputMode：files_with_matches（仅文件列表）、content（行/匹配片段）、
   * count（每文件匹配数）。path 可为文件或目录。注意只有 RipgrepRuntimeFailure
   * 才降级；取消、超时、用户正则错误、IO 错误都直接抛。
   */
  async searchText(
    request: FileSystemSearchTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    // [契约] 只在路径确实被 normalize 改动时才复制请求，避免无意义分配。
    // 下传的一定是归一后的绝对路径：ripgrep preopen 根与 JS 降级路径都依赖它，
    // 传原始路径会让两条实现得到不同的相对路径前缀。
    const normalizedRequest = request.path === path ? request : { ...request, path };

    // [契约] 显式选择 javascript 时直接走降级实现，不尝试 ripgrep，也不做运行时探测：
    // [契约] textSearchEngine === "javascript" 时跳过 ripgrep 与运行时探测：受限环境里 ripgrep 可能存在但不可用，探测本身不确定。
    // 默认 undefined 才表示「优先 ripgrep，运行时失败再降级」。
    if (this.adapterOptions.textSearchEngine === "javascript") {
      return searchTextWithJavaScript(normalizedRequest, options?.signal);
    }

    try {
      return await searchTextWithRipgrep(normalizedRequest, options?.signal);
    } catch (error) {
      // [失败路径] 这是全文唯一的降级判定点：仅运行时故障转 JS，其余错误归一后上抛。
      // 把判断放宽成「任何 Error 都降级」会让用户正则错误被 JS 版重新解释，
      // 错误码从 invalid_pattern 漂移为 io_error。
      if (error instanceof RipgrepRuntimeFailure) {
        return searchTextWithJavaScript(normalizedRequest, options?.signal);
      }
      throw toFileSystemError(error, path);
    }
  }

  /**
   * 乐观锁比对：只比较 mtime+size 组成的 revision.id。
   *
   * 不比较 hash 是刻意取舍：写前多读一次完整文件才能算 hash，对大文件成本高；
   * mtime+size 已能覆盖绝大多数"读后被改"场景。不符抛 stale_write 且不做任何写。
   */
  // [事务] 这里只读 stat，不打开文件句柄，因此 CAS 与后续写入之间存在极小的
  // 竞态窗口（TOCTOU）；接受它是因为底层没有跨平台的 compare-and-swap 原语。
  // 需要更强保证时应在上层串行化写入，而不是在本方法里加锁。
  // [失败路径] 目标不存在时 stat 抛 ENOENT，被外层归一为 not_found 而非 stale_write，
  // 调用方需据此区分「被删除」与「被修改」。
  private async assertExpectedRevision(path: string, expected: FileSystemRevision): Promise<void> {
    const info = await stat(path);
    const actual = revisionId(info.mtimeMs, info.size);
    if (actual !== expected.id) {
      throw createFileSystemError({
        code: "stale_write",
        path,
        message: `File changed since it was read: ${path}`,
      });
    }
  }
}

/** 创建文件系统适配器；options 仅影响文本搜索引擎选择。 */
// 工厂函数而非直接 new：调用方只依赖 FileSystemPort 接口，便于测试替换。
// options 只影响文本搜索引擎选择，不承载路径或权限配置。
export function createNodeFileSystemAdapter(
  options: NodeFileSystemAdapterOptions = {},
): NodeFileSystemAdapter {
  return new NodeFileSystemAdapter(options);
}

/**
 * 测试钩子：替换 ripgrep worker 工厂，返回恢复函数。
 *
 * 恢复函数把全局变量写回旧值，支持嵌套/并行测试；生产代码不应调用。
 */
// [契约] 返回恢复函数而不是暴露 setter，保证嵌套/并行测试按后进先出还原，
// 不会因为某个用例失败而把全局状态永久改坏。
// 生产代码不得调用；恢复闭包必须在 finally 中执行。
export function setRipgrepWorkerFactoryForTests(
  factory: RipgrepWorkerFactory | undefined,
): () => void {
  const previous = ripgrepWorkerFactoryForTests;
  ripgrepWorkerFactoryForTests = factory;
  return () => {
    ripgrepWorkerFactoryForTests = previous;
  };
}

/** 测试钩子：覆盖 ripgrep 超时（毫秒），返回恢复函数。 */
export function setRipgrepTimeoutMsForTests(timeoutMs: number | undefined): () => void {
  const previous = ripgrepTimeoutMsForTests;
  ripgrepTimeoutMsForTests = timeoutMs;
  return () => {
    ripgrepTimeoutMsForTests = previous;
  };
}

/**
 * ripgrep 路径的文本搜索实现。
 *
 * 目录搜索时以目录为 WASI preopen 根、target="."；单文件搜索时以父目录为根、
 * target=文件名。退出码：0/1 都算成功（1=无匹配），2=参数/IO 错误按 stderr
 * 分类，其余码一律 io_error。结果路径解析回绝对路径后按 mtime 倒序。
 */
async function searchTextWithRipgrep(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  let rootInfo: Awaited<ReturnType<typeof stat>>;
  try {
    throwIfAborted(signal);
    rootInfo = await stat(path);
  } catch (error) {
    throw toFileSystemError(error, path);
  }

  if (!rootInfo.isFile() && !rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  const mode = request.outputMode ?? "files_with_matches";
  // [契约] 参数拼装全部收敛到 createRipgrepSearchPlan，搜索执行函数不直接拼 CLI 参数，
  // 这样 JSON 与 -c 两种输出的解析假设可以和参数构造放在一起审阅。
  const plan = createRipgrepSearchPlan(path, rootInfo, request, mode);
  // [并发] signal 一路传到 worker 管理函数，由主线程 terminate 打断搜索；
  // 返回后立刻再做一次 throwIfAborted，覆盖「结果已返回但取消同时到达」的窗口。
  // 这里不 catch：错误分类交给 runBundledRipgrep 与上层。
  const result = await runBundledRipgrep(plan.args, plan.preopens, { signal });
  throwIfAborted(signal);

  // [失败路径] ripgrep 退出码 2 表示参数/IO 级错误，需要按 stderr 内容细分；
  // 退出码 0 与 1 都算成功（1 仅表示无匹配），不要把 1 当失败。
  // 分类失败时统一退化为 io_error，绝不静默返回空结果。
  if (result.code === 2) {
    throw toRipgrepFileSystemError(result.stderr, path, pattern);
  }
  // 其余退出码（含 WASI 异常中断）一律 io_error，并附带 stderr 便于诊断。
  // [契约] 不要在此处降级到 JS：非 0/1/2 通常意味着运行时已经不可信。
  if (result.code !== 0 && result.code !== 1) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: `ripgrep exited with code ${result.code}: ${result.stderr || "unknown error"}`,
    });
  }

  const parsed =
    mode === "content"
      ? parseRipgrepJsonOutput(result.stdout, plan.outputRoot, request)
      : parseRipgrepCountOutput(result.stdout, plan.outputRoot, request);
  // [契约] ripgrep 输出顺序不稳定，必须统一按 mtime 倒序，保证同一输入多次搜索结果一致。
  // 排序会额外 stat 每个命中文件，属于可接受的成本，换来可复现的工具输出。
  const files = await sortPathsByMtime(parsed.files);

  return finishTextSearchResult({
    path,
    pattern,
    mode,
    startedAt,
    request,
    files,
    entries: mode === "files_with_matches" ? [] : parsed.entries,
    numMatches: parsed.numMatches,
  });
}

/**
 * 纯 JS 文本搜索（ripgrep 不可用时的降级实现）。
 *
 * 先收集候选文件（文件/目录 + glob/type 过滤），逐文件读 UTF-8 并跳过疑似
 * 二进制；非 content 模式强制 onlyMatching=false（count 需要整行匹配数）。
 * 每文件之间检查取消。功能子集与 ripgrep 对齐，但不支持正则的非 JS 语法。
 */
async function searchTextWithJavaScript(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  try {
    throwIfAborted(signal);
    // [契约] 正则只编译一次并复用；编译失败统一为 invalid_pattern，
    // 与 ripgrep 侧 stderr 分类的对外错误码保持一致。
    const regex = compileSearchRegex(pattern, request);
    const rootInfo = await stat(path);
    const mode = request.outputMode ?? "files_with_matches";
    const candidates = await collectTextSearchCandidates(path, rootInfo, request, signal);

    const searchRequest =
      mode === "content" ? request : { ...request, onlyMatching: false };
    // content 与 count 分开累积，最后按 mode 二选一，避免在循环里反复判断并
    // 错把 count 条目塞进 content 结果。
    const contentEntries: FileSystemSearchTextEntry[] = [];
    const countEntries: FileSystemSearchTextEntry[] = [];
    const matchingFiles: Array<{ path: string; mtimeMs: number }> = [];
    let numMatches = 0;

    // [资源] 逐文件整读后立即丢弃，内存峰值 = 单个最大文件；不要改成先全部读入再处理。
    // [失败路径] 读到一半抛错（权限/编码）会让整次搜索失败：JS 降级是最后兜底，
    // 不做逐文件容错，否则结果会出现「静默缺文件」。
    // [并发] 串行处理且每个文件前检查取消，保证大目录搜索能被及时打断。
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const content = await readFile(candidate.path, "utf8");
      // 以 NUL 字节判定二进制并跳过，与 ripgrep 的默认行为对齐；
      // 跳过是静默的，结果里不会留下错误条目。
      if (looksBinary(content)) continue;

      const search = request.multiline
        ? searchMultilineContent(candidate.path, content, regex, searchRequest)
        : searchLineContent(candidate.path, content, regex, searchRequest);

      if (search.matchCount === 0) continue;

      numMatches += search.matchCount;
      matchingFiles.push({ path: candidate.path, mtimeMs: candidate.mtimeMs });
      if (mode === "content") {
        contentEntries.push(...search.entries);
      } else if (mode === "count") {
        countEntries.push({
          path: candidate.path,
          count: search.matchCount,
        });
      }
    }

    matchingFiles.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    return finishTextSearchResult({
      path,
      pattern,
      mode,
      startedAt,
      request,
      files: matchingFiles.map((item) => item.path),
      entries: mode === "content" ? contentEntries : countEntries,
      numMatches,
    });
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

/**
 * 只读文件头 maxBytes 字节（用于文本截断读取）。
 *
 * 预分配 maxBytes 缓冲，读多少返回多少；句柄在 finally 关闭。
 * maxBytes<=0 时返回空 Buffer。
 */
// [资源] 句柄在 finally 中关闭：即使 read 抛错也不会泄漏 fd。
// maxBytes<=0 时 Buffer.alloc(0) 且 read 长度为 0，返回空 Buffer 而不报错。
async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 有界读取最多 maxBytes 字节（二进制读取用）。
 *
 * 首块按 stat 大小预分配，若文件在 stat 后增长则继续 64KB 分块读到硬上限；
 * 返回长度可能等于 maxBytes（调用方再用 +1 读取判定是否超限）。短读不等于
 * EOF，只有 read 返回 0 才停止。
 */
async function readAtMostBytes(
  path: string,
  maxBytes: number,
  initialSizeBytes: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    // 稳定文件按 stat 大小一次读取；只有文件在 stat 后增长时才继续分块追到硬上限。
    // [权衡] 首块按 stat 大小 +1 预分配：+1 是为了能在一次读里发现「文件比 stat 大」，
    // min 是为了不超过硬上限；allocUnsafe 可行是因为每次 read 都只暴露 bytesRead 前缀。
    // 改成 alloc 会在大文件上多一次零填充，属于无谓开销。
    const firstBuffer = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1, initialSizeBytes + 1)));
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const chunk =
        bytesReadTotal === 0
          ? firstBuffer
          : Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytesReadTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytesReadTotal);
      // FileHandle.read 的短读不等于 EOF；只有明确返回 0 字节才能停止。
      // [契约] FileHandle.read 的短读不等于 EOF，只有返回 0 才停止；
      // 把短读当 EOF 会在网络盘/管道上截断内容。
      // 循环条件同时受 maxBytes 约束，保证有界。
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (chunks.length === 0) return Buffer.alloc(0);
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesReadTotal);
  } finally {
    await handle.close();
  }
}

// 独立错误类型用于区分「安全拒绝」与普通 IO 失败；最终由 toFileSystemError
// 按 name 之外的路径归一，不参与 errno 映射。
class SymlinkWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkWriteRefusedError";
  }
}

function getNodeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * 原子写：临时文件 + fsync + rename。
 *
 * 先 lstat 目标：符号链接直接拒绝（避免写穿链接到意外位置）；若存在则记住
 * 权限位，写临时文件后 chmod 复制（rename 会换成新 inode，不复制就丢执行位）。
 * 临时文件用 O_EXCL|O_NOFOLLOW 创建，名字含 pid+随机串防冲突。
 * rename 失败时清理临时文件并降级为 O_TRUNC 就地写（仍 O_NOFOLLOW，ELOOP 拒绝）。
 * 注意：降级路径不是原子的，但保证内容落盘且不写穿链接。
 */
// [事务] 三步语义：临时文件写满并 fsync → rename 原子替换 → 失败降级就地写。
// fsync 必须发生在 rename 之前：否则崩溃可能留下「名字已换、内容未落盘」的空文件。
// [失败路径] rename 失败（跨设备、Windows 文件被占用）退化为 O_TRUNC 就地写，
// 此时不再原子，但保证不写穿链接且内容落盘。
// [资源] 降级前必须先 unlink 临时文件，失败也不上抛，避免掩盖原始错误。
async function atomicWrite(path: string, content: Buffer): Promise<void> {
  let existingMode: number | undefined;

  try {
    const targetInfo = await lstat(path);
    // [失败路径] 写前拒绝符号链接，防止通过预置链接把写入重定向到工作区外；
    // 这是 lstat 预检而不是靠 O_NOFOLLOW 单点保证，因为 rename 目标无法带 O_NOFOLLOW。
    // 错误信息要求调用方自行解析真实路径再传，不做自动跟随。
    if (targetInfo.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${path}. Resolve the symlink and pass the real target path explicitly.`,
      );
    }
    // [契约] 记录的是完整 mode（含文件类型位），chmod 只关心权限位，多余位会被忽略。
    // 只在目标存在时赋值；不存在时保持 undefined，避免把 0 权限套到新文件上。
    existingMode = targetInfo.mode;
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  // [并发] 临时名包含 pid + 6 字节随机串，避免同进程并发写同一目标互相覆盖；
  // 放在同目录是为了让 rename 落在同一文件系统，跨设备 rename 会 EXDEV。
  // 不要改用 os.tmpdir()：跨设备会导致原子替换退化为复制。
  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;

  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(content);
      if (existingMode !== undefined) {
        // 原子写会用临时文件 inode 覆盖目标文件；必须先复制原文件权限，避免抹掉脚本执行位。
        // [契约] 权限必须在 rename 前复制到临时文件 inode；rename 只是换目录项，
        // 事后 chmod 已作用不到新 inode，脚本执行位会静默丢失。
        // 仅在目标原本存在时执行，新文件沿用 umask 默认值。
        await handle.chmod(existingMode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    // [事务] rename 是唯一的提交点：成功即替换完成，失败进入降级路径。
    // Windows 上目标被其他进程占用会抛 EPERM/EBUSY，这正是需要降级的原因。
    await rename(tempPath, path);
  } catch {
    // [资源] 清理临时文件失败不能上抛：此时原始错误更重要，掩盖它会误导排查方向。
    // 残留的 .tmp.<pid>.<rand> 文件不会命中常规搜索（不在 VCS 目录），可事后人工清理。
    // [失败路径] 降级写仍以 O_NOFOLLOW 打开，ELOOP 单独转成 SymlinkWriteRefusedError。
    await unlink(tempPath).catch(() => undefined);
    const fallbackHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (getNodeErrorCode(error) === "ELOOP") {
        throw new SymlinkWriteRefusedError(`Refusing to write through symlink: ${path} (O_NOFOLLOW)`);
      }
      throw error;
    });

    try {
      await fallbackHandle.writeFile(content);
      await fallbackHandle.sync();
    } finally {
      await fallbackHandle.close();
    }
  }
}

/** stat 信息 → 端口 kind；符号链接优先于"是否文件"判定（stat 会跟随链接，单列仅作兜底）。 */
function nodeKind(info: Awaited<ReturnType<typeof stat>>): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function direntKind(info: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

/** revision 的 CAS 键格式；mtime 截断到整数毫秒，避免浮点尾差导致假 stale。 */
// [契约] 这是跨进程的 CAS 键格式，改动即破坏兼容：旧会话持有的 revision 会全部失效。
// mtime 截断到整数毫秒，规避浮点尾差造成的假 stale_write。
function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

/**
 * 强制绝对路径校验并 normalize。
 *
 * FileSystemPort 不接受相对路径：相对路径的解释依赖进程 cwd，工具调用时
 * cwd 可能已变化，容易导致写到意外位置。normalize 只做字符串归一，不解析 symlink。
 */
// [契约] 相对路径直接拒绝（invalid_path），不做基于 cwd 的补全：
// 工具调用与用户 shell 的 cwd 可能不同，补全会把文件写到意外位置。
// normalize 只做字符串归一，不解析符号链接，因此不改变真实目标。
function resolveAbsoluteRequestPath(path: string): string {
  if (!isAbsolute(path)) {
    throw createFileSystemError({
      code: "invalid_path",
      path,
      message: `FileSystemPort requires an absolute path: ${path}`,
    });
  }
  return normalize(path);
}

function hashBuffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatByteUnit(bytes / 1024)}KB`;
  return `${formatByteUnit(bytes / (1024 * 1024))}MB`;
}

function formatByteUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

/**
 * 把任意异常映射成 FileSystemPortError。
 *
 * 已是端口错误则透传；AbortError 必须先于其他分支判断（Node 中止也可能是
 * ENOENT 形状）；然后按 errno 分类，未知一律 io_error。映射结果保留 cause
 * 链，便于上层日志诊断。
 */
// [契约] 错误映射的唯一入口：端口错误透传，AbortError 优先，其余按 errno 分类。
// 所有分支都保留 cause 链，上层日志才能看到原始系统错误。
// 未知 errno 一律 io_error——新增错误码必须同时更新上层分支，不能随手加。
function toFileSystemError(error: unknown, path: string): Error {
  if (error instanceof Error && error.name === "FileSystemPortError") {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    // Preserve cancellation as its own code so tools do not report user aborts as I/O failures.
    return createFileSystemError({
      code: "cancelled",
      path,
      message: `File system operation was cancelled: ${path}`,
      cause: error,
    });
  }

  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return createFileSystemError({
      code: "not_found",
      path,
      message: `File not found: ${path}`,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message: `Permission denied for path: ${path}`,
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return createFileSystemError({
      code: "is_directory",
      path,
      message: `Path is a directory: ${path}`,
      cause: error,
    });
  }
  if (code === "ENAMETOOLONG") {
    return createFileSystemError({
      code: "invalid_path",
      path,
      message: `Invalid path: ${path}`,
      cause: error,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : `File system error for path: ${path}`,
    cause: error,
  });
}

interface FileSearchCandidate {
  path: string;
  mtimeMs: number;
}

interface TextSearchResult {
  matchCount: number;
  entries: FileSystemSearchTextEntry[];
}

interface LineRange {
  start: number;
  end: number;
}

interface OnlyMatchingMatches {
  matchCount: number;
  ranges: LineRange[];
  entriesByLine: Map<number, FileSystemSearchTextEntry[]>;
}

interface RipgrepSearchPlan {
  args: RgArg[];
  outputRoot: string;
  preopens: Record<string, string>;
}

interface ParsedTextSearch {
  entries: FileSystemSearchTextEntry[];
  files: string[];
  numMatches: number;
}

interface FinishTextSearchParams {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  startedAt: number;
  request: FileSystemSearchTextRequest;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
}

class RipgrepRuntimeFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Bundled ripgrep WASM failed to run");
    this.name = "RipgrepRuntimeFailure";
    this.cause = cause;
  }
}

class RipgrepTimeoutFailure extends Error {
  constructor(timeoutMs: number) {
    super(
      `ripgrep search timed out after ${timeoutMs}ms. The search was terminated before it completed.`,
    );
    this.name = "RipgrepTimeoutFailure";
  }
}

/**
 * 生成 ripgrep 参数计划。
 *
 * 固定 `--no-config --hidden --no-heading --with-filename --max-columns 500`，
 * 并对每个 VCS 目录追加两条 glob 排除（目录本身与任意层级子目录）。WASI 只
 * 能看到 preopen，因此单文件搜索时把父目录作为 "." 根、target 用文件名。
 * JSON 模式用于 content，-c 用于 count/files。
 */
function createRipgrepSearchPlan(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  mode: FileSystemTextSearchOutputMode,
): RipgrepSearchPlan {
  // [契约] WASI 只能看到 preopen 内的路径：目录搜索以目录为根、target="."，
  // 单文件搜索以父目录为根、target 用文件名，否则 ripgrep 拿不到该文件。
  // outputRoot 同时用于把输出路径解析回绝对路径，两处必须一致。
  const outputRoot = rootInfo.isDirectory() ? path : dirname(path);
  const target = rootInfo.isDirectory() ? "." : basename(path);
  const args: RgArg[] = [
    "--no-config",
    "--hidden",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--max-columns",
    "500",
  ];

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`, "--glob", `!**/${dir}/**`);
  }

  if (request.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  if (request.ignoreCase) {
    args.push("-i");
  }

  if (mode === "content") {
    args.push("--json");
    if (request.onlyMatching) {
      args.push("--only-matching");
    }
    addRipgrepContextArgs(args, request);
  } else {
    args.push("-c");
  }

  if (request.glob) {
    addRipgrepGlobArgs(args, request.glob);
  }
  if (request.type) {
    addRipgrepTypeArgs(args, request.type);
  }

  // [契约] `--` 终止选项解析，防止以 - 开头的 pattern 被当成命令行开关。
  // pattern 只 trim 首尾，不转义：正则语法原样交给 ripgrep。
  args.push("-e", request.pattern.trim(), "--", target);

  return {
    args,
    outputRoot,
    preopens: { ".": outputRoot },
  };
}

function addRipgrepContextArgs(args: RgArg[], request: FileSystemSearchTextRequest): void {
  // [契约] context 显式给出时覆盖 before/after；undefined 与 0 语义不同，
  // 所以用 !== undefined 而不是真值判断。
  if (request.context !== undefined) {
    args.push("-C", String(request.context));
    return;
  }
  if (request.beforeContext !== undefined) {
    args.push("-B", String(request.beforeContext));
  }
  if (request.afterContext !== undefined) {
    args.push("-A", String(request.afterContext));
  }
}

function addRipgrepGlobArgs(args: RgArg[], glob: string): void {
  for (const pattern of splitRipgrepGlobPatterns(glob)) {
    args.push("--glob", pattern);
  }
}

function splitRipgrepGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const rawPattern of glob.split(/\s+/)) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      patterns.push(rawPattern);
      continue;
    }
    patterns.push(...rawPattern.split(","));
  }
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}

function addRipgrepTypeArgs(args: RgArg[], type: string): void {
  for (const pattern of fileTypeGlobPatterns(type)) {
    args.push("--glob", pattern);
  }
}

function fileTypeGlobPatterns(type: string): string[] {
  const normalized = normalizeFileType(type);
  if (!/^[a-z0-9_+-]+$/i.test(normalized)) return [];
  const extensions = TYPE_EXTENSION_MAP[normalized] ?? [`.${normalized}`];
  return extensions.flatMap((extension) => [`*${extension}`, `**/*${extension}`]);
}

function normalizeFileType(type: string): string {
  return type.toLowerCase().replace(/^\./, "");
}

/**
 * 运行打包的 WASI ripgrep（Worker 内）。
 *
 * 只把"运行时失败"包装为 RipgrepRuntimeFailure（触发 JS 降级）；取消与超时
 * 原样抛出，因为重跑 JS 版同样会被取消/耗时，没有降级价值。
 */
async function runBundledRipgrep(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal } = {},
): Promise<RipgrepBufferedResult> {
  try {
    return await runBundledRipgrepWorker(args, preopens, {
      signal: options.signal,
      timeoutMs: ripgrepTimeoutMsForTests ?? DEFAULT_RIPGREP_TIMEOUT_MS,
    });
  } catch (error) {
    // [权衡] 取消与超时不降级：JS 版同样会被取消、同样耗时，重跑只会放大延迟，
    // 而用户期待的是立即停止。
    // 只有其他运行时故障才包装为 RipgrepRuntimeFailure 触发降级。
    if (isAbortError(error) || error instanceof RipgrepTimeoutFailure) {
      throw error;
    }
    throw new RipgrepRuntimeFailure(error);
  }
}

/**
 * 在 Worker 中执行 ripgrep，并做超时/取消/单次 settle 管理。
 *
 * 主线程只等待消息，绝不跑 WASI：大目录搜索若在主线程会阻塞 event loop，
 * 导致用户 stop 无法被处理。终止 worker 是唯一能真正打断搜索的手段。
 * settle 保证 resolve/reject 只发生一次，并清理定时器与 abort 监听。
 */
function runBundledRipgrepWorker(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<RipgrepBufferedResult> {
  // [并发] 启动前先看 signal：已取消时不要创建 Worker，否则终止逻辑与启动竞态，
  // 可能留下一个无人回收的 worker。
  // 此分支返回 rejected Promise 而不是 throw，保持异步签名一致。
  if (options.signal?.aborted) {
    return Promise.reject(createAbortError("ripgrep search was cancelled before it started"));
  }

  // 不能在 agent 主线程里直接运行 WASI ripgrep。大目录搜索会占住 Node
  // event loop，导致 session/stop 虽然绕过协议队列，却没有机会被 agent 处理。
  // 放到 Worker 后，用户 stop 和超时都能从主线程 terminate 这个搜索执行单元。
  const worker = createRipgrepWorker({
    args: args.map(String),
    preopens,
  });

  return new Promise<RipgrepBufferedResult>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // [资源] terminate 返回 Promise，这里吞掉 rejection：worker 已异常退出时 terminate
    // 会失败，但结果已由 exit 事件处理，重复报错只会产生 unhandled rejection。
    // 终止是打断 WASI 搜索的唯一手段，不能退化成「只是不再监听消息」。
    const terminateWorker = (): void => {
      const termination = worker.terminate();
      if (typeof termination === "object" && termination !== null && "catch" in termination) {
        void termination.catch(() => undefined);
      }
    };

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener("abort", handleAbort);
    };

    // [并发] 单次 settle 是这里的核心不变量：message/error/exit/abort/timeout 五路
    // 事件都可能先到，重复结值会让后来者被静默丢弃或触发 unhandled rejection。
    // [资源] settle 内先 cleanup 再结值，保证定时器与 abort 监听不泄漏。
    const settle = (settler: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settler();
    };

    const handleAbort = (): void => {
      terminateWorker();
      settle(() => reject(createAbortError("ripgrep search was cancelled")));
    };

    options.signal?.addEventListener("abort", handleAbort, { once: true });
    // [资源] 超时与取消共用 settle：先 terminate 再 reject，保证不会留下仍在跑的 worker。
    // 默认 30s 是防止病态正则/超大目录把会话挂死；测试可通过 setRipgrepTimeoutMsForTests 覆盖。
    // 定时器必须在 cleanup 中清除，否则已完成的搜索会拖住进程退出。
    timeoutId = setTimeout(() => {
      terminateWorker();
      settle(() => reject(new RipgrepTimeoutFailure(options.timeoutMs)));
    }, options.timeoutMs);

    worker.once("message", (message: unknown) => {
      settle(() => {
        const parsed = message as Partial<RipgrepWorkerMessage>;
        if (parsed.type === "result" && parsed.result) {
          resolve(parsed.result);
          return;
        }
        if (parsed.type === "error") {
          reject(deserializeWorkerError(parsed.error));
          return;
        }
        reject(new Error("ripgrep worker returned an unknown message"));
      });
    });

    worker.once("error", (error: Error) => {
      settle(() => reject(error));
    });

    // [失败路径] worker 提前退出（WASM 崩溃、OOM 被杀）必须转成 reject；
    // 若此时已 settled 则忽略，避免覆盖正常结果。
    // exit 与 message 顺序在 Node 中不保证，settle 的幂等性是唯一保障。
    worker.once("exit", (code: number) => {
      if (settled) return;
      settle(() => reject(new Error(`ripgrep worker exited before returning a result: ${code}`)));
    });
  });
}

/** 创建 ripgrep worker；测试可注入工厂替换真实 Worker。 */
function createRipgrepWorker(workerData: RipgrepWorkerData): RipgrepWorker {
  return (
    ripgrepWorkerFactoryForTests?.(workerData) ??
    new Worker(RIPGREP_WORKER_SOURCE, {
      eval: true,
      workerData,
    })
  );
}

function deserializeWorkerError(serialized: SerializedWorkerError | undefined): Error {
  const error = new Error(serialized?.message ?? "ripgrep worker failed");
  error.name = serialized?.name ?? "Error";
  if (serialized?.stack) {
    error.stack = serialized.stack;
  }
  if (serialized && "code" in serialized) {
    Object.assign(error, { code: serialized.code });
  }
  return error;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 解析 ripgrep `--json` 输出。
 *
 * 只关心 match/context 事件；onlyMatching 且存在 submatches 时按每个子匹配
 * 拆条目（可能一行多条），否则整行一条。匹配行计入 files/numMatches，上下文
 * 行只作为 entry。路径相对 preopen 根解析回绝对路径。
 */
function parseRipgrepJsonOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const event = parseRipgrepJsonEvent(line, request.path);
    if (event.type !== "match" && event.type !== "context") continue;

    const rawPath = event.data?.path?.text;
    if (!rawPath) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    const matched = event.type === "match";
    if (matched) {
      files.add(path);
      numMatches += 1;
    }

    // [契约] onlyMatching 只在 match 事件上按 submatches 拆条目，context 行仍整行输出；
    // 没有 submatches 时回落到整行，保证零长度匹配不会丢结果。
    if (request.onlyMatching && matched) {
      const submatches = event.data?.submatches ?? [];
      if (submatches.length > 0) {
        const lineNumber =
          typeof event.data?.line_number === "number" ? event.data.line_number : undefined;
        for (const submatch of submatches) {
          entries.push(...createOnlyMatchingEntries({
            path,
            text: submatch.match?.text ?? "",
            lineNumber,
          }));
        }
        continue;
      }
    }

    entries.push({
      path,
      lineNumber: typeof event.data?.line_number === "number" ? event.data.line_number : undefined,
      text: stripTrailingLineEnding(event.data?.lines?.text ?? ""),
      matched,
    });
  }

  return { entries, files: [...files], numMatches };
}

/**
 * 解析 ripgrep `-c` 输出（`path:count`）。
 *
 * 用最后一个冒号分隔，兼容文件名含冒号（Windows 盘符/特殊名）；count<=0
 * 的行跳过。files 与 numMatches 同时累计。
 */
function parseRipgrepCountOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    // [权衡] 用最后一个冒号切分 path:count，兼容 Windows 盘符与含冒号文件名；
    // 改成 indexOf 会把 C:\ 的冒号当成计数分隔点。
    const separatorIndex = line.lastIndexOf(":");
    if (separatorIndex <= 0) continue;

    const rawPath = line.slice(0, separatorIndex);
    const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
    if (!Number.isFinite(count) || count <= 0) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    files.add(path);
    numMatches += count;
    entries.push({ path, count });
  }

  return { entries, files: [...files], numMatches };
}

/**
 * 统一收尾：对 files 或 entries 应用 headLimit/offset。
 *
 * numMatches 保持全量匹配数（不受截断影响），truncated 表示是否被截断；
 * appliedLimit/appliedOffset 回传实际生效值，便于调用方翻页。
 */
// [契约] 两条实现（ripgrep / JS）共用这一个收尾，保证返回结构、截断语义完全一致。
// files_with_matches 只截断 files；content/count 只截断 entries，files 始终全量。
// numMatches 不参与截断，调用方据此判断是否需要翻页。
function finishTextSearchResult(params: FinishTextSearchParams): FileSystemSearchTextResult {
  if (params.mode === "files_with_matches") {
    const limited = applyHeadLimit(params.files, params.request.headLimit, params.request.offset);
    return {
      path: params.path,
      pattern: params.pattern,
      mode: params.mode,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      files: limited.items,
      entries: [],
      numMatches: params.numMatches,
      truncated: limited.truncated,
      appliedLimit: limited.appliedLimit,
      appliedOffset: limited.appliedOffset,
    };
  }

  const limited = applyHeadLimit(params.entries, params.request.headLimit, params.request.offset);
  return {
    path: params.path,
    pattern: params.pattern,
    mode: params.mode,
    durationMs: Math.max(0, Date.now() - params.startedAt),
    files: params.files,
    entries: limited.items,
    numMatches: params.numMatches,
    truncated: limited.truncated,
    appliedLimit: limited.appliedLimit,
    appliedOffset: limited.appliedOffset,
  };
}

/**
 * 按 mtime 倒序排序路径（去重），stat 失败的文件按 mtime=0 垫底。
 *
 * ripgrep 输出顺序不稳定，统一排序保证工具结果可复现；失败不抛错，
 * 因为文件可能刚被删除，属于正常竞态。
 */
async function sortPathsByMtime(paths: string[]): Promise<string[]> {
  // [并发] 逐个 stat 且失败降级为 mtime=0，不因单个文件消失让整次搜索失败；
  // Promise.all 在这里安全，因为每个分支都自行 catch，不会短路。
  // 去重后再 stat，避免同一路径重复系统调用。
  const withStats = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        const info = await stat(path);
        return { path, mtimeMs: Number(info.mtimeMs) };
      } catch {
        return { path, mtimeMs: 0 };
      }
    }),
  );

  withStats.sort((left, right) => {
    const timeComparison = right.mtimeMs - left.mtimeMs;
    return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
  });
  return withStats.map((item) => item.path);
}

function splitOutputLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    submatches?: Array<{ match?: { text?: string } }>;
    line_number?: number;
  };
}

function parseRipgrepJsonEvent(line: string, path: string): RipgrepJsonEvent {
  try {
    return JSON.parse(line) as RipgrepJsonEvent;
  } catch (error) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: "Failed to parse ripgrep JSON output",
      cause: error,
    });
  }
}

/**
 * 生成结果过滤器（glob + type）。
 *
 * 过滤基于"相对搜索根"的 POSIX 路径，与 ripgrep/JS 两条实现保持同一口径；
 * type 用内置扩展名表匹配，未知 type 退化为 `.type`。
 */
function createTextResultFilter(
  root: string,
  request: FileSystemSearchTextRequest,
): (path: string) => boolean {
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;

  return (path) => {
    const relativePath = toPosixRelative(root, path);
    if (globMatcher && !globMatcher(relativePath, basename(path))) return false;
    if (request.type && !matchesFileType(path, request.type)) return false;
    return true;
  };
}

/**
 * 把 ripgrep 输出的路径还原为绝对路径。
 *
 * 绝对路径直接 normalize；相对路径去掉 "./" 前缀后拼到 outputRoot。
 * 不解析 ".."，因为 ripgrep 不会给出逃出 preopen 根的路径。
 */
function resolveRipgrepOutputPath(root: string, rawPath: string): string {
  if (isAbsolute(rawPath)) return normalize(rawPath);
  const withoutLeadingDot = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  return normalize(join(root, withoutLeadingDot));
}

function stripTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

/**
 * 把 ripgrep exit=2 的 stderr 分类成端口错误。
 *
 * 只识别稳定的 Poppler 风格/OS 错误串（regex parse error、permission denied、
 * os error 13/2），其余归 io_error；无法识别时保留原始 stderr 作为 message。
 */
function toRipgrepFileSystemError(stderr: string, path: string, pattern: string): Error {
  const message = stderr.trim() || `ripgrep failed while searching ${path}`;
  const normalized = message.toLowerCase();

  if (
    normalized.includes("regex parse error") ||
    normalized.includes("error parsing regex") ||
    normalized.includes("unclosed")
  ) {
    return createFileSystemError({
      code: "invalid_pattern",
      path,
      message: `Invalid grep regular expression: ${pattern}`,
    });
  }

  if (normalized.includes("permission denied") || normalized.includes("os error 13")) {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message,
    });
  }

  if (normalized.includes("no such file") || normalized.includes("os error 2")) {
    return createFileSystemError({
      code: "not_found",
      path,
      message,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message,
  });
}

/**
 * 编译 JS 正则。
 *
 * multiline 用 `s` 标志（. 匹配换行），ignoreCase 用 `i`；非法正则统一转
 * invalid_pattern（与 ripgrep 侧口径一致）。
 */
// [契约] multiline 用 s 标志而不是 m：JS 侧要求在整段文本上跨行匹配，
// m 只改变 ^$ 语义，无法实现跨行 .。
// 两个标志拼接顺序固定，便于出错时复现；非法正则统一 invalid_pattern。
function compileSearchRegex(pattern: string, request: FileSystemSearchTextRequest): RegExp {
  try {
    const flags = `${request.ignoreCase ? "i" : ""}${request.multiline ? "s" : ""}`;
    return new RegExp(pattern, flags);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path: request.path,
      message: `Invalid grep regular expression: ${pattern}`,
      cause: error,
    });
  }
}

/**
 * JS 模式候选文件收集。
 *
 * 单文件直接返回自身；目录递归 walkFiles（默认排除 VCS 目录），逐个应用
 * glob/type 过滤并记录 mtime。结果按路径升序，保证后续处理顺序稳定。
 */
async function collectTextSearchCandidates(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const candidates: FileSearchCandidate[] = [];
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;
  const root = rootInfo.isDirectory() ? path : dirname(path);

  const addIfCandidate = async (filePath: string, info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) return;
    const relativePath = toPosixRelative(root, filePath);
    if (globMatcher && !globMatcher(relativePath, basename(filePath))) return;
    if (request.type && !matchesFileType(filePath, request.type)) return;
    candidates.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
  };

  // [契约] 单文件模式直接返回自身候选，不再递归；此时 root 取父目录，
  // 保证相对路径口径与目录模式一致。
  // rootInfo 是调用方已取得的快照，这里不重复 stat，避免两次快照不一致。
  if (rootInfo.isFile()) {
    await addIfCandidate(path, rootInfo);
    return candidates;
  }

  if (!rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  await walkFiles(root, signal, addIfCandidate);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return candidates;
}

/**
 * 单行模式搜索。
 *
 * 逐行 test 得到匹配行索引，再按 context/before/after 扩展成连续行范围，
 * 输出 matched 标记。onlyMatching 走另一条分支（按子匹配拆条目并附带上下文）。
 */
function searchLineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);

  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectLineOnlyMatchingMatches(path, lines, regex),
    });
  }

  // [契约] 用 test 而非 exec 收集行号：带 g 标志的 exec 会推进 lastIndex，
  // 跨行复用同一个 regex 会漏匹配，所以每次 test 前显式重置 lastIndex。
  // 行号按 0 基收集，输出时统一 +1 转成 1 基行号。
  const matchingIndexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[index] ?? "")) {
      matchingIndexes.push(index);
    }
  }

  const ranges = matchingIndexes.map((index) => ({ start: index, end: index }));
  const matchedLineIndexes = new Set(matchingIndexes);
  const entries = createContextLineIndexes(lines.length, ranges, request).map((lineIndex) => ({
    path,
    lineNumber: lineIndex + 1,
    text: lines[lineIndex] ?? "",
    matched: matchedLineIndexes.has(lineIndex),
  }));

  return {
    matchCount: matchingIndexes.length,
    entries,
  };
}

/**
 * 多行模式搜索。
 *
 * 用 `gs` 全局正则在整个文件上 matchAll，每条匹配按起始位置换算行号，
 * 文本只保留匹配的第一行（完整跨行内容不适合直接塞进工具结果）。
 */
function searchMultilineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);
  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectMultilineOnlyMatchingMatches(path, content, regex),
    });
  }

  const flags = `${regex.ignoreCase ? "i" : ""}gs`;
  const globalRegex = new RegExp(regex.source, flags);
  const entries: FileSystemSearchTextEntry[] = [];
  let matchCount = 0;

  for (const match of content.matchAll(globalRegex)) {
    const index = match.index ?? 0;
    const lineNumber = lineNumberForIndex(content, index);
    const text = firstLine(match[0]);
    entries.push({
      path,
      lineNumber,
      text,
      matched: true,
    });
    matchCount += 1;
  }

  return { matchCount, entries };
}

function collectLineOnlyMatchingMatches(
  path: string,
  lines: string[],
  regex: RegExp,
): OnlyMatchingMatches {
  const entriesByLine = new Map<number, FileSystemSearchTextEntry[]>();
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}g`);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const entries: FileSystemSearchTextEntry[] = [];
    globalRegex.lastIndex = 0;
    for (const match of line.matchAll(globalRegex)) {
      entries.push(
        ...createOnlyMatchingEntries({
          path,
          lineNumber: lineIndex + 1,
          text: match[0],
        }),
      );
    }
    if (entries.length > 0) {
      entriesByLine.set(lineIndex, entries);
    }
  }

  return {
    matchCount: entriesByLine.size,
    ranges: Array.from(entriesByLine.keys()).map((lineIndex) => ({
      start: lineIndex,
      end: lineIndex,
    })),
    entriesByLine,
  };
}

function collectMultilineOnlyMatchingMatches(
  path: string,
  content: string,
  regex: RegExp,
): OnlyMatchingMatches {
  const matches: OnlyMatchingMatches = {
    matchCount: 0,
    ranges: [],
    entriesByLine: new Map(),
  };
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}gs`);

  for (const match of content.matchAll(globalRegex)) {
    const matchIndex = match.index ?? 0;
    const startLineNumber = lineNumberForIndex(content, matchIndex);
    const entries = createOnlyMatchingEntries({
      path,
      lineNumber: startLineNumber,
      text: match[0],
    });
    for (const entry of entries) {
      const lineIndex = (entry.lineNumber ?? startLineNumber) - 1;
      const existing = matches.entriesByLine.get(lineIndex) ?? [];
      existing.push(entry);
      matches.entriesByLine.set(lineIndex, existing);
    }

    const endIndex = Math.max(matchIndex, matchIndex + match[0].length - 1);
    matches.ranges.push({
      start: startLineNumber - 1,
      end: lineNumberForIndex(content, endIndex) - 1,
    });
    matches.matchCount += 1;
  }

  return matches;
}

function createOnlyMatchingSearchResult(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): TextSearchResult {
  return {
    matchCount: input.matches.matchCount,
    entries: createOnlyMatchingContentEntries(input),
  };
}

function createOnlyMatchingContentEntries(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): FileSystemSearchTextEntry[] {
  const matchedLineIndexes = createMatchedLineIndexes(input.matches.ranges);

  return createContextLineIndexes(input.lines.length, input.matches.ranges, input.request)
    .flatMap((lineIndex) => {
      const matchedEntries = input.matches.entriesByLine.get(lineIndex);
      if (matchedEntries) return matchedEntries;
      if (matchedLineIndexes.has(lineIndex)) return [];
      return [
        {
          path: input.path,
          lineNumber: lineIndex + 1,
          text: input.lines[lineIndex] ?? "",
          matched: false,
        },
      ];
    });
}

/**
 * 计算需要输出的行索引集合（匹配行 ± 上下文）。
 *
 * before/after 缺省继承 context；范围裁剪到 [0, lineCount-1]；用 Set 去重后
 * 升序返回，保证上下文重叠时行不重复。
 */
function createContextLineIndexes(
  lineCount: number,
  ranges: LineRange[],
  request: FileSystemSearchTextRequest,
): number[] {
  const context = request.context ?? 0;
  const beforeContext = request.beforeContext ?? context;
  const afterContext = request.afterContext ?? context;
  const indexes = new Set<number>();

  for (const range of ranges) {
    const start = Math.max(0, range.start - beforeContext);
    const end = Math.min(lineCount - 1, range.end + afterContext);
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

function createMatchedLineIndexes(ranges: LineRange[]): Set<number> {
  const indexes = new Set<number>();
  for (const range of ranges) {
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }
  return indexes;
}

function createOnlyMatchingEntries(input: {
  path: string;
  lineNumber?: number;
  text: string;
}): FileSystemSearchTextEntry[] {
  if (input.text.length === 0) {
    return [
      {
        path: input.path,
        lineNumber: input.lineNumber,
        text: "",
        matched: true,
      },
    ];
  }

  // ripgrep 只把 LF/CRLF 当作输出行边界；单独的 CR 是普通匹配文本。
  // 同时，跨行 match 内部的空行不生成 entry，但整段零长度 match 需要保留空 entry。
  return input.text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      line.length === 0
        ? []
        : [
            {
              path: input.path,
              lineNumber:
                input.lineNumber === undefined ? undefined : input.lineNumber + index,
              text: line,
              matched: true,
            },
          ],
    );
}

function splitRipgrepSearchLines(content: string): string[] {
  // ripgrep 以 LF/CRLF 作为行结束符；末尾换行不是额外空行，单独的 CR 保留在行内容中。
  if (content.length === 0) return [];
  return content.replace(/\r?\n$/, "").split(/\r?\n/);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function lineNumberForIndex(content: string, index: number): number {
  let lineNumber = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}

async function walkFiles(
  current: string,
  signal: AbortSignal | undefined,
  visitor: (path: string, info: Awaited<ReturnType<typeof stat>>) => Promise<void> | void,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    throwIfAborted(signal);
    const childPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (VCS_DIRECTORIES_TO_EXCLUDE.has(entry.name)) continue;
      await walkFiles(childPath, signal, visitor);
      continue;
    }

    if (!entry.isFile()) continue;

    const info = await stat(childPath);
    await visitor(childPath, info);
  }
}

function createGlobMatcher(pattern: string): (relativePath: string, fileName: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  const regex = globPatternToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : globPatternToRegExp(normalized);

  return (relativePath, fileName) =>
    regex.test(relativePath) || (basenameRegex ? basenameRegex.test(fileName) : false);
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        regex += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }

    regex += escapeRegExp(char ?? "");
  }

  regex += "$";
  try {
    return new RegExp(regex);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      message: `Invalid glob pattern: ${pattern}`,
      cause: error,
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function toPosixRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function applyHeadLimit<T>(
  items: T[],
  headLimit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number; appliedOffset?: number; truncated: boolean } {
  if (headLimit === 0) {
    return {
      items: items.slice(offset),
      appliedOffset: offset > 0 ? offset : undefined,
      truncated: false,
    };
  }

  // [权衡] 未显式给 headLimit 时套用 250 的保守上限，避免一次搜索把上下文灌满；
  // 显式 0 已在上面的分支短路为「不限制」，因此这里不会把 0 误判成缺省值。
  // truncated 依据「剩余条目数 > 上限」计算，与实际 slice 结果保持同一口径。
  const effectiveLimit = headLimit ?? DEFAULT_GREP_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const truncated = items.length - offset > effectiveLimit;

  return {
    items: sliced,
    appliedLimit: truncated ? effectiveLimit : undefined,
    appliedOffset: offset > 0 ? offset : undefined,
    truncated,
  };
}

// NUL 字节判定与 ripgrep 的二进制识别保持同一简化口径；
// 宁可漏判某些 UTF-16 文本，也不引入会误杀正常源码的复杂启发式。
function looksBinary(content: string): boolean {
  return content.includes("\0");
}

function matchesFileType(path: string, type: string): boolean {
  const normalized = type.toLowerCase().replace(/^\./, "");
  const extension = extname(path).toLowerCase();
  const known = TYPE_EXTENSION_MAP[normalized];
  if (known) {
    return known.includes(extension);
  }
  return extension === `.${normalized}`;
}

const TYPE_EXTENSION_MAP: Record<string, string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  css: [".css"],
  go: [".go"],
  html: [".html", ".htm"],
  java: [".java"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc"],
  markdown: [".md", ".markdown"],
  md: [".md", ".markdown"],
  py: [".py"],
  python: [".py"],
  rs: [".rs"],
  rust: [".rs"],
  sh: [".sh", ".bash", ".zsh"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  tsx: [".tsx"],
  txt: [".txt"],
  yaml: [".yaml", ".yml"],
};

// [失败路径] 取消统一以 AbortError 抛出，再由 toFileSystemError 归一为 cancelled；
// 不要在这里直接抛 FileSystemPortError，否则错误归一出现两个入口。
// 无 signal 时零成本返回，递归遍历中的每次调用都不算额外开销。
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled");
  error.name = "AbortError";
  throw error;
}
