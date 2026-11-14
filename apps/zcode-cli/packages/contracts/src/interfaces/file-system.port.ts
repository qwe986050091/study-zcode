// ============================================================
// FileSystem Port - file I/O boundary
// ============================================================
// 定位：CLI 内所有文件读写的唯一出口。工具层只表达意图，adapter 负责原子性、编码、
// 行尾归一、stale 检测与跨平台差异（大小写、符号链接、可执行位、路径长度）。
// 路径口径：request.path 必须是规范化绝对路径，相对路径由 tool 层先解析；端口对相对路径
// 直接返回 invalid_path，避免不同 cwd 下产生歧义。
// 权限口径：端口刻意不做权限判定。写、删、读取敏感路径之前，调用方必须已完成工具权限
// 流程（权限 service + memory 边界 + 沙箱），端口只负责执行和错误分类。
// 错误口径：所有失败统一抛 FileSystemPortError，调用方按 code 分支，不解析 message。

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

// 端口错误码。stale_write 专指 expectedRevision 不匹配，cancelled 专指 AbortSignal，
// too_large 表示超过 maxBytes 硬上限（不是截断），invalid_path 是调用方路径未规范化。
// 新增取值必须同步 adapter 的映射与所有消费方 switch，不得用 message 兜底。
export type FileSystemErrorCode =
  | "not_found"
  | "permission_denied"
  | "is_directory"
  | "not_file"
  | "too_large"
  | "stale_write"
  | "invalid_path"
  | "invalid_pattern"
  | "unsupported"
  | "cancelled"
  | "io_error";

// 错误明细：path 是规范化后的绝对路径（可能缺席），cause 保留底层 Node 错误供日志展开，
// 不跨进程序列化。
export interface FileSystemErrorDetails {
  code: FileSystemErrorCode;
  path?: string;
  message: string;
  cause?: unknown;
}

// 端口错误类型。所有 adapter 抛出的错误都必须归一化成该类型，便于调用方统一捕获；
// name 固定为 FileSystemPortError，用于跨包/多副本打包时与 instanceof 互补判定。
export class FileSystemPortError extends Error {
  readonly code: FileSystemErrorCode;
  readonly path?: string;
  override readonly cause?: unknown;

  constructor(details: FileSystemErrorDetails) {
    super(details.message);
    this.name = "FileSystemPortError";
    this.code = details.code;
    this.path = details.path;
    this.cause = details.cause;
  }
}

// 工厂：把明细收敛成端口错误实例；adapter 内部一律经它抛出，保证 code/name 一致。
export function createFileSystemError(details: FileSystemErrorDetails): FileSystemPortError {
  return new FileSystemPortError(details);
}

// 类型守卫。非端口错误应继续向上冒泡，调用方只在确需按码分支时使用它。
export function isFileSystemPortError(error: unknown): error is FileSystemPortError {
  return error instanceof FileSystemPortError;
}

// 节点类型。missing 表示 stat 时不存在；symlink 表示链接本身（不跟随）；
// other 覆盖设备/管道等不能当普通文件处理的节点。adapter 用 lstat 语义抹平平台差异。
export type FileSystemNodeKind = "file" | "directory" | "symlink" | "other" | "missing";

// 修改标记。id 是 adapter 生成的稳定指纹（Node adapter 为 mtime:size），hash 可选且非必填；
// 写操作携带 expectedRevision，与 id 比对失败即 stale_write。该值只用于同进程内的乐观并发
// 控制，不是内容摘要，也不能跨机器比较。
export interface FileSystemRevision {
  id: string;
  mtimeMs?: number;
  sizeBytes?: number;
  hash?: string;
}

// 行尾风格。结果里报告源文件的"主导"风格，写入时可用 lineEndings 要求还原；
// 端口内部内容始终按 LF 归一，归一只发生在文本读写路径，二进制读写不参与。
export type FileSystemLineEndings = "LF" | "CRLF";
// 文本编码。除 Node 的 BufferEncoding 外，额外允许中文环境常见的 gb2312/gbk/gb18030；
// 不支持的编码由 adapter 返回 unsupported，而不是静默按 utf8 解码。
export type FileSystemTextEncoding = BufferEncoding | "gb2312" | "gbk" | "gb18030";

// stat 请求：path 必须已规范化绝对化；trace 仅用于日志关联，不参与结果。
export interface FileSystemStatRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  trace?: TraceContext;
}

// stat 结果：kind 已归一化，sizeBytes 对目录为 0；revision 供后续写操作做乐观校验，
// 不存在的节点以 kind="missing" 返回而不是抛 not_found。
export interface FileSystemStatResult {
  path: string;
  kind: FileSystemNodeKind;
  sizeBytes: number;
  mtimeMs?: number;
  revision?: FileSystemRevision;
}

// 递归建目录请求：父目录自动创建，已存在视为成功（不报错、不改动已有内容）。
export interface FileSystemCreateDirectoryRequest {
  /** Normalized absolute path. Parent directories are created recursively. */
  path: string;
  trace?: TraceContext;
}

// 建目录结果回显最终规范化路径，供调用方记录与后续操作复用。
export interface FileSystemCreateDirectoryResult {
  path: string;
}

// 读文本请求。maxBytes 是"截断上限"：超过时只读到该长度并置 truncated，不报错；
// encoding 缺省 utf8，读取后内容统一归一为 LF。要硬拒绝超限请用二进制读。
export interface FileSystemReadTextRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  encoding?: FileSystemTextEncoding;
  maxBytes?: number;
  trace?: TraceContext;
}

// 读文本结果。content 已 LF 归一，lineEndings 记录归一前的主导风格，bytesRead 是实际读取量，
// sizeBytes 是文件总大小，truncated 表示因 maxBytes 截断；revision 供写回时校验。
export interface FileSystemReadTextResult {
  path: string;
  /**
   * Text content normalized to LF line endings for tool/core consumption.
   * The original dominant file line ending is reported via `lineEndings`.
   */
  content: string;
  encoding: FileSystemTextEncoding;
  /** Dominant line ending style observed before LF normalization. */
  lineEndings?: FileSystemLineEndings;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  revision?: FileSystemRevision;
}

// 读二进制请求。maxBytes 这里是硬上限：超过抛 too_large，绝不截断；上层需要截断时
// 应改用文本读或显式分块。
export interface FileSystemReadBytesRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Optional total file size guard. Exceeding it fails with `too_large`; it does not truncate. */
  maxBytes?: number;
  trace?: TraceContext;
}

// 原始字节结果，不经任何解码；revision 同时返回以便写回时做 stale 校验。
export interface FileSystemReadBytesResult {
  path: string;
  content: Uint8Array;
  bytesRead: number;
  sizeBytes: number;
  revision?: FileSystemRevision;
}

// 行区间读取请求。offsetLine 是零基逻辑行偏移（工具面的一基行号在上层已转换），
// limitLines 缺省读到 EOF；maxBytes 仍是硬上限，超限抛 too_large 而不是截断。
export interface FileSystemReadTextRangeRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  encoding?: FileSystemTextEncoding;
  /** Zero-based logical line offset. Tool-facing one-based offsets are translated before this port. */
  offsetLine?: number;
  /** Number of logical lines to return. Omit to return from offset through EOF. */
  limitLines?: number;
  /** Optional total file size guard. Exceeding it fails with `too_large`; it does not truncate. */
  maxBytes?: number;
  trace?: TraceContext;
}

// 区间读取结果。startLine 是一基行号，lineCount 是实际返回行数，totalLines 是文件逻辑总行数；
// truncated 只在刻意截断的 adapter 为 true（Node adapter 区间读失败而非静默截断），
// bytesRead 是 adapter 为产出该区间实际消费的字节数。
export interface FileSystemReadTextRangeResult {
  path: string;
  /**
   * Selected text content normalized to LF line endings for tool/core consumption.
   * The original dominant file line ending is reported via `lineEndings`.
   */
  content: string;
  encoding: FileSystemTextEncoding;
  /** Dominant line ending style observed before LF normalization. */
  lineEndings?: FileSystemLineEndings;
  /** Number of bytes consumed by the adapter while producing this range. */
  bytesRead: number;
  /** Total file size in bytes. */
  sizeBytes: number;
  /** True only for adapters that intentionally truncate range reads. Node adapter range reads fail instead. */
  truncated: boolean;
  /** One-based line number of the first returned/requested line. */
  startLine: number;
  /** Number of lines returned in `content`. */
  lineCount: number;
  /** Total logical line count in the file. */
  totalLines: number;
  revision?: FileSystemRevision;
}

// 写文本请求。content 是 LF 归一的逻辑文本，lineEndings 指定写回风格；
// atomic 缺省 true：走临时文件 + fsync + rename，且拒绝写符号链接（避免跟随链接写到目标外）；
// expectedRevision 冲突时抛 stale_write，调用方必须重新读取后再写。
export interface FileSystemWriteTextRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  content: string;
  encoding?: FileSystemTextEncoding;
  /** Restore this line ending style while writing logical LF-normalized text. */
  lineEndings?: FileSystemLineEndings;
  createParents?: boolean;
  atomic?: boolean;
  expectedRevision?: FileSystemRevision;
  trace?: TraceContext;
}

// 写结果。revision 是写后重新计算的新指纹，调用方可据此继续乐观并发；bytesWritten 是实际落盘字节。
export interface FileSystemWriteTextResult {
  path: string;
  bytesWritten: number;
  revision?: FileSystemRevision;
}

// 删文件请求。missingOk=true 时文件不存在视为成功；端口只删文件，不递归删目录，
// 目录请先由调用方判定或走其他能力。
export interface FileSystemRemoveFileRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Treat a missing file as a completed no-op. */
  missingOk?: boolean;
  trace?: TraceContext;
}

// removed 表示是否真的执行了删除：missingOk 命中时为 false，调用方据此区分"删了"与"本来就没有"。
export interface FileSystemRemoveFileResult {
  path: string;
  removed: boolean;
}

// 列目录请求：只列一层、不递归；path 必须已规范化绝对化，符号链接按 lstat 语义呈现。
export interface FileSystemListDirectoryRequest {
  /** Normalized absolute directory path. Relative paths are resolved by the caller. */
  path: string;
  trace?: TraceContext;
}

// 目录项：kind 与 stat 同一枚举，path 是拼好的绝对路径，name 是原始条目名（不做大小写归一）。
export interface FileSystemListDirectoryEntry {
  kind: FileSystemNodeKind;
  name: string;
  path: string;
}

// 结果含 numEntries 与 durationMs，便于上层做规模与性能判断；entries 顺序由 adapter 决定，
// 调用方不得依赖排序。
export interface FileSystemListDirectoryResult {
  durationMs: number;
  entries: FileSystemListDirectoryEntry[];
  numEntries: number;
  path: string;
}

// 文件搜索请求。pattern 是相对 path 的 glob；maxResults/offset 构成分页，
// 达到上限时结果置 truncated 而不是报错。
export interface FileSystemSearchFilesRequest {
  /** Normalized absolute directory path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Glob pattern relative to path unless the adapter documents additional support. */
  pattern: string;
  maxResults?: number;
  offset?: number;
  trace?: TraceContext;
}

// files 的路径形态由 adapter 约定；truncated 表示因 maxResults 截断，numFiles 是本次返回数量。
export interface FileSystemSearchFilesResult {
  path: string;
  pattern: string;
  durationMs: number;
  files: string[];
  numFiles: number;
  truncated: boolean;
}

// 文本搜索输出三态：content 返回命中行及上下文，files_with_matches 只返回文件列表，
// count 只返回每文件命中数。模式决定 entries 的哪些字段有值，调用方不得跨模式读取。
export type FileSystemTextSearchOutputMode = "content" | "files_with_matches" | "count";

// 文本搜索请求，参数语义与 ripgrep 对齐：before/after/context 控制上下文行，
// headLimit/offset 控制截取，multiline 允许跨行匹配，type 是文件类型过滤，glob 是路径过滤。
export interface FileSystemSearchTextRequest {
  /** Normalized absolute file or directory path. Relative paths are resolved by the tool layer. */
  path: string;
  pattern: string;
  glob?: string;
  outputMode?: FileSystemTextSearchOutputMode;
  beforeContext?: number;
  afterContext?: number;
  context?: number;
  showLineNumbers?: boolean;
  onlyMatching?: boolean;
  ignoreCase?: boolean;
  type?: string;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
  trace?: TraceContext;
}

// 命中条目。content 模式带 lineNumber/text；count 模式带 count；files_with_matches 不带 entries。
// matched 用于区分上下文行（false）与真正命中行（true）。
export interface FileSystemSearchTextEntry {
  path: string;
  lineNumber?: number;
  text?: string;
  count?: number;
  matched?: boolean;
}

// 搜索结果带回实际生效的 limit/offset（appliedLimit/appliedOffset），便于上层还原分页位置；
// truncated 表示结果被截断，numMatches 是本页命中数而非全局总数。
export interface FileSystemSearchTextResult {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  durationMs: number;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
  truncated: boolean;
  appliedLimit?: number;
  appliedOffset?: number;
}

// 操作级控制。signal 取消会产生 cancelled 错误码（不抛底层 AbortError）；
// context 提供 trace 之外的执行上下文；两者都不参与路径解析。
export interface FileSystemOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

// 文件系统端口。所有方法以 Promise 返回，失败统一抛 FileSystemPortError。
// 调用方必须先完成权限判定再调用写/删/敏感读：端口刻意不做路径白名单、记忆目录或沙箱校验，
// 那些边界属于权限 service 与 memory 策略层；在端口里复制一套只会产生两条判定路径。
// searchFiles/searchText 可能启动外部进程（ripgrep），同样受超时与取消约束。
export interface FileSystemPort {
  createDirectory(
    request: FileSystemCreateDirectoryRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemCreateDirectoryResult>;
  stat(
    request: FileSystemStatRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemStatResult>;
  readTextFile(
    request: FileSystemReadTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadTextResult>;
  readBinaryFile(
    request: FileSystemReadBytesRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadBytesResult>;
  readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadTextRangeResult>;
  writeTextFile(
    request: FileSystemWriteTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemWriteTextResult>;
  removeFile(
    request: FileSystemRemoveFileRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemRemoveFileResult>;
  listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemListDirectoryResult>;
  searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemSearchFilesResult>;
  searchText(
    request: FileSystemSearchTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemSearchTextResult>;
}
