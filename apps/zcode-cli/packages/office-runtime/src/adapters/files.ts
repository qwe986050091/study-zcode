// 工作区文件适配器：路径校验、分块读取句柄、目录列举与“系统选择器导入”落盘的全部 I/O 收口在此。
// 边界：所有相对路径都以构造时的 workspace 为根，拒绝越界、符号链接逃逸与非普通文件。
// 失败语义：统一抛 OfficeError（带稳定 code）；副作用仅限工作区内的临时导入目录与磁盘读取。
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_FILE_BYTES,
  OfficeError,
  extensionList,
  kindOf,
  type DocKind,
} from "#office/contract.ts";
import { TITLE } from "#office/wording.ts";

// 判断 target 是否落在 root 之内：借助 relative 结果排除绝对路径、上级目录与 ../ 前缀。
function inside(root: string, target: string) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

// 统一输出正斜杠路径，保证跨平台与定位符解析一致。
const toPosix = (path: string) => path.split(sep).join("/");

// 已读取的文件：路径为工作区相对路径，bytes 为完整文件内容。
export interface LoadedFile {
  // 工作区相对路径，固定正斜杠。
  /** Workspace-relative path with forward slashes. */
  path: string;
  // 由扩展名判定的格式。
  kind: DocKind;
  // 文件原始字节，已通过大小上限校验。
  bytes: Uint8Array;
  // 内容指纹（sha256 前 16 位），用于判断文档是否变化。
  revision: string;
  // 文件修改时间（毫秒），与 size 一起构成轻量指纹。
  mtimeMs: number;
}

// 工作区文件访问接口：所有方法都会先做路径归一化与越界校验。
export interface WorkspaceFiles {
  /** Normalise a user or model path to a workspace-relative one; throws outside the workspace. */
  // 归一化路径并校验：返回相对路径、真实绝对路径与格式；越界/不支持/不存在均抛 OfficeError。
  resolve(input: string): Promise<{ path: string; absolute: string; kind: DocKind }>;
  // 读取完整文件；同时做文件类型与大小校验。
  load(input: string): Promise<LoadedFile>;
  // 轻量变更检查：只用 size + mtime，不读文件内容。
  /** Cheap change check: size + mtime, without reading the file. */
  fingerprint(input: string): Promise<string>;
  // 广度优先枚举工作区内的文档，默认最多 500 条，供工具做候选提示。
  list(options?: {
    limit?: number;
  }): Promise<{ path: string; kind: DocKind; bytes: number; mtimeMs: number }[]>;
}

// 枚举时跳过的目录：依赖、版本库与构建产物既耗时又几乎不含用户文档。
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".venv",
  "__pycache__",
]);

// 创建工作区文件访问器；workspace 会在首次使用时 realpath 解析并缓存，之后所有访问都以真实路径为边界。
// 输入为宿主传入的工作区根目录字符串；返回的对象无状态句柄，可被同一进程内多个调用方共享。
// 失败语义：根目录不存在时首次访问才报 not_found；越界路径一律抛 path_outside_workspace。
// 不缓存文件内容，只缓存 realpath 结果；文件被外部替换后需重新读取以获得最新字节。
export function createWorkspaceFiles(workspace: string): WorkspaceFiles {
  // 真实根路径的惰性缓存：并发首次调用共享同一个 realpath 结果。
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(workspace));

  // 把用户/模型给出的路径解析为工作区相对路径；会拒绝空串、含 NUL、越界与不支持的扩展名。
  async function resolvePath(input: string) {
    // 空路径与 NUL 字节直接判为非法，避免后续 IO 抛出不明确的错误。
    if (typeof input !== "string" || !input.trim() || input.includes("\0"))
      throw new OfficeError("invalid_path", "A document path is required.");
    const base = await root();
    const target = resolve(base, input.trim());
    if (!inside(base, target) && target !== base)
      throw new OfficeError("path_outside_workspace", `Path is outside this workspace: ${input}`);
    const kind = kindOf(target);
    if (!kind)
      throw new OfficeError(
        "unsupported_type",
        `Unsupported file type: ${input}. ${TITLE} opens ${extensionList()} files.`,
      );
    let actual: string;
    // realpath 同时解引用符号链接；ENOENT 统一转成 not_found，其余错误原样上抛。
    try {
      actual = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new OfficeError("not_found", `File not found: ${toPosix(relative(base, target))}`);
      throw error;
    }
    // 二次校验真实路径：防止通过符号链接逃逸工作区。
    if (!inside(base, actual))
      throw new OfficeError("path_outside_workspace", "The path links outside this workspace.");
    return { path: toPosix(relative(base, target)), absolute: actual, kind };
  }

  // 校验目标是普通文件且不超过上限，返回 stat 结果；错误信息里用相对路径，避免泄露绝对路径。
  async function checkedStat(absolute: string, path: string) {
    const info = await stat(absolute);
    if (!info.isFile()) throw new OfficeError("not_found", `Not a file: ${path}`);
    if (info.size > MAX_FILE_BYTES)
      throw new OfficeError(
        "file_too_large",
        `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MiB.`,
      );
    return info;
  }

  return {
    resolve: resolvePath,
    // 读取完整文件并计算内容指纹；先做路径与大小校验，避免把超大文件读入内存。
    async load(input) {
      const { path, absolute, kind } = await resolvePath(input);
      const info = await checkedStat(absolute, path);
      const bytes = new Uint8Array(await readFile(absolute));
      const revision = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      return { path, kind, bytes, revision, mtimeMs: info.mtimeMs };
    },
    // 返回 `${size}:${mtimeMs}`，供上层判断是否需要重新解析。
    async fingerprint(input) {
      const { path, absolute } = await resolvePath(input);
      const info = await checkedStat(absolute, path);
      return `${info.size}:${info.mtimeMs}`;
    },
    // 枚举工作区文档：默认 500 条、最多访问 5000 个目录、深度不超过 8，超过即提前结束。
    async list({ limit = 500 } = {}) {
      const base = await root();
      const found: { path: string; kind: DocKind; bytes: number; mtimeMs: number }[] = [];
      const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
      let visited = 0;
      // 广度优先：工作区很大时，浅层文档优先被收录。
      // Breadth-first so shallow documents win when the workspace is large.
      while (queue.length && found.length < limit && visited < 5000) {
        const { dir, depth } = queue.shift()!;
        visited++;
        let entries;
        // 无权限或已删除的目录直接跳过，不影响其余结果。
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        // 固定按名称排序，保证多次调用结果稳定。
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          // 跳过隐藏项与 Office 临时锁文件（~$ 开头）。
          if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < 8 && !SKIP_DIRS.has(entry.name))
              queue.push({ dir: full, depth: depth + 1 });
          } else if (entry.isFile()) {
            const kind = kindOf(entry.name);
            if (!kind) continue;
            // 用 lstat 而非 stat：符号链接即使指向别处也只取链接本身的信息，不跟随。
            const info = await lstat(full).catch(() => null);
            if (!info) continue;
            found.push({
              path: toPosix(relative(base, full)),
              kind,
              bytes: info.size,
              mtimeMs: info.mtimeMs,
            });
            if (found.length >= limit) break;
          }
        }
      }
      return found;
    },
  };
}

// 系统选择器只提供用户选中的文件字节；导入副本后复用工作区读取与对话引用，绝不放开任意路径读取。
// 空闲导入保留 10 分钟，超时由清扫删除；同时最多 4 个未完成导入。
const IMPORT_IDLE_MS = 10 * 60 * 1000;
const MAX_IMPORTS = 4;

// 创建分块写入的导入器：begin 分配 token，chunk 按 offset 顺序写入，finish 校验后落成工作区文件。
// 所有准入与 IO 都经串行队列执行，保证并发下槽位上限与 offset 顺序不被破坏。
// 返回的 begin/chunk/finish 三阶段必须按序调用，token 只能对应一个导入槽；空闲槽超时后自动回收。
export function createDocumentImporter(
  workspace: string,
  options: { now?: () => number; onCleanupError?: (error: unknown) => void } = {},
) {
  const now = options.now ?? Date.now;
  const uploads = new Map<
    string,
    {
      directory: string;
      name: string;
      size: number;
      offset: number;
      handle: FileHandle;
      touched: number;
    }
  >();
  // 串行队列尾指针：失败也会被吞掉，避免一次错误卡死后续任务。
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(workspace));
  // 准入和 IO 共用串行队列，避免 await 之间突破槽位上限，也让 cancel 等待写入结束。
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation);
    queue = task.catch(() => undefined);
    return task;
  };
  // 返回导入根目录（工作区下的 .zcode/document-imports）；create=false 时目录不存在则返回 null。
  // 目录若指向工作区外则拒绝，防止工作区配置被篡改后越界写入。
  async function parent(create = true) {
    const base = await root();
    const directory = join(base, ".zcode", "document-imports");
    if (create) await mkdir(directory, { recursive: true });
    else if (!(await lstat(directory).catch(() => null))) return null;
    if (!inside(base, await realpath(directory)))
      throw new OfficeError("invalid_path", "Import directory must remain inside the workspace.");
    return directory;
  }
  // 丢弃一个导入：关闭句柄并递归删除其目录；清理失败只回调，不影响其他导入。
  async function discard(id: string) {
    const upload = uploads.get(id);
    if (!upload) return;
    uploads.delete(id);
    await upload.handle.close().catch((error) => options.onCleanupError?.(error));
    await rm(upload.directory, { recursive: true, force: true }).catch((error) =>
      options.onCleanupError?.(error),
    );
  }
  // 清扫过期导入与残留的 .partial 文件；只处理长时间未更新的项，避免误删其他会话正在写的文件。
  async function sweep() {
    for (const [id, upload] of uploads)
      if (now() - upload.touched >= IMPORT_IDLE_MS) await discard(id);
    const directory = await parent(false);
    if (!directory) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(directory, entry.name);
      if ([...uploads.values()].some((upload) => upload.directory === candidate)) continue;
      const partial = join(candidate, ".partial");
      const info = await lstat(partial).catch(() => null);
      // 不能清空所有 UUID 目录：成品和其他会话近期写入的文件必须保留。
      if (!info?.isFile() || now() - info.mtimeMs < IMPORT_IDLE_MS) continue;
      await rm(partial, { force: true }).catch((error) => options.onCleanupError?.(error));
      // 只删除空目录，不递归删除潜在成品。
      await rmdir(candidate).catch((error) => options.onCleanupError?.(error));
    }
  }
  return {
    // 只读工作区仍可预览；启动清扫失败只记录，不能阻断插件连接。
    initialize: () => run(() => sweep().catch((error) => options.onCleanupError?.(error))),
    // 开始一次导入：校验文件名（不允许路径分隔符）与大小，创建 UUID 目录并打开 .partial 写入句柄。
    // 返回 token；失败会清理已建目录，不留半成品。
    begin: (name: string, size: number) =>
      run(async () => {
        if (closed) throw new OfficeError("invalid_token", "Importer is closed.");
        if (basename(name) !== name || name.includes("\\") || !kindOf(name))
          throw new OfficeError("unsupported_type", "Unsupported file name or type.");
        if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES)
          throw new OfficeError("file_too_large", "File size is outside the supported range.");
        await sweep();
        if (uploads.size >= MAX_IMPORTS)
          throw new OfficeError("invalid_token", "Too many pending imports.");
        const id = randomUUID();
        const directory = join((await parent())!, id);
        await mkdir(directory);
        try {
          const handle = await open(join(directory, ".partial"), "wx");
          uploads.set(id, { directory, name, size, offset: 0, handle, touched: now() });
          return id;
        } catch (error) {
          await rm(directory, { recursive: true, force: true }).catch((cleanupError) =>
            options.onCleanupError?.(cleanupError),
          );
          throw error;
        }
      }),
    // 追加一块数据：offset 必须与已写进度完全一致且总长不超声明大小，否则整块拒绝。
    // 写入可能不足一块，循环续写直到本次字节全部落盘；无进度则判为损坏。
    chunk: (id: string, offset: number, bytes: Uint8Array) =>
      run(async () => {
        const upload = uploads.get(id);
        if (!upload || offset !== upload.offset || offset + bytes.length > upload.size)
          throw new OfficeError("invalid_token", "Invalid import offset or token.");
        let written = 0;
        while (written < bytes.length) {
          const result = await upload.handle.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten)
            throw new OfficeError("corrupt_file", "File import could not be written.");
          written += result.bytesWritten;
        }
        upload.offset += written;
        upload.touched = now();
      }),
    // 完成导入：要求已写入字节数与声明大小一致，关闭句柄后把 .partial 重命名为正式文件名。
    // 返回工作区相对路径，调用方随后可按普通文档读取；token 随之失效。
    finish: (id: string) =>
      run(async () => {
        const upload = uploads.get(id);
        if (!upload || upload.offset !== upload.size)
          throw new OfficeError("invalid_token", "File import is incomplete.");
        await upload.handle.close();
        const target = join(upload.directory, upload.name);
        await rename(join(upload.directory, ".partial"), target);
        uploads.delete(id);
        // macOS 的 /var 可能链接到 /private/var，计算相对路径时必须使用同一真实根目录。
        return toPosix(relative(await root(), target));
      }),
    // 取消导入：未知 token 视为已取消，不报错。
    cancel: (id: string) => run(() => discard(id)),
    // 关闭导入器：标记 closed 拒绝后续 begin，并清理所有未完成导入；可重复调用。
    close: () =>
      run(async () => {
        closed = true;
        for (const id of uploads.keys()) await discard(id);
      }),
  };
}
