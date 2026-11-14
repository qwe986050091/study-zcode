// 插件同步归档（tar.gz）的写入与解包。上游是 pluginSync 同步/接收链路，下游是磁盘上的插件目录；
// 本文件同时是「不可信字节流 → 文件系统」的唯一入口，所以安全边界全部收敛在这里。
// INV-01：归档条目路径必须先经 normalizeArchivePath 归一，绝不把 header 原始路径直接拼到 targetRoot。
//   若绕过：header 里的 ../ 或绝对路径会写到 workspace 之外，等价任意文件写入。
// INV-02：解包必须先按 header.size 校验数据块边界再读取，越界立即抛错而不是截断继续。
//   若跳过：短读会让 offset 与真实块对齐错位，后续所有条目都解析到垃圾数据。
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  normalizePluginSyncRelativePath,
  resolvePluginSyncPathWithin,
} from "./pluginSyncPath.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
// 512 字节块是 ustar 的固定粒度：每个 header 恰好一块，数据按块向上取整，末尾补两块全零。
const TAR_BLOCK_SIZE = 512;
// 结束标记固定两块；常量集中定义，是为了让读写两侧的取整公式不会各自漂移。
const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

// 元数据固定写在这个保留路径，解包后由上层按同一常量读取；改名等于改协议，旧包会因缺元数据无法恢复启用状态。
export const PLUGIN_SYNC_METADATA_ARCHIVE_PATH = ".zcode-plugin-sync.json";

// 条目二选一：从磁盘文件读取（sourcePath）或直接在内存里给定内容。
// 用 in 判断而不是可选字段，是因为 content 允许空字符串/空字节，不能靠真值区分。
// 两种形态最终都落到 appendTarFile，保证 header 生成只有一条路径。
export type PluginSyncArchiveEntry =
  | {
      sourcePath: string;
      archivePath: string;
    }
  | {
      content: string | Uint8Array;
      archivePath: string;
      mode?: number;
      mtimeMs?: number;
    };

// 元数据描述插件目录名与 marketplace 来源；directoryName 由创建方保证已是合法目录名，
// 解包侧只当数据读、不据此建目录，避免多一处路径来源。
export interface PluginSyncArchiveMetadata {
  plugins: Array<{
    name: string;
    pluginId: string;
    directoryName: string;
    enabled?: boolean;
  }>;
  marketplaceSources?: Array<{
    marketplaceId: string;
    directoryName: string;
  }>;
}

// maxExtractedBytes 是解包侧唯一的体积上限，未设置时完全不限制；
// 只统计普通文件的数据长度，目录条目不占额度（目录本身不写内容）。
export interface PluginSyncArchiveExtractOptions {
  maxExtractedBytes?: number;
}

// 按 entries 顺序写 tar：先写各条目，最后写元数据，再用两块零收尾。
// 顺序有意义：读取方按出现顺序覆盖，元数据放最后可以覆盖同名冲突。
// 全部内容在内存里拼成 Buffer 再 gzip，避免落临时文件；调用方已保证 entries 规模受控。
export async function createPluginSyncArchive(params: {
  entries: readonly PluginSyncArchiveEntry[];
  metadata: PluginSyncArchiveMetadata;
}): Promise<Uint8Array> {
// 用 Buffer 数组累积而不是反复 concat：concat 是 O(n²)，插件目录里文件多时会被放大成卡顿；
// 最后统一 Buffer.concat 一次，只在 gzip 前产生一份完整副本。
  const parts: Buffer[] = [];
// 目录条目由 appendTarEntry 递归展开，调用方只需给出目录路径；
// 递归里同样排序，保证同一棵树两次打包产出相同字节序，便于比对与缓存。
  for (const entry of params.entries) {
    if ("sourcePath" in entry) {
// archivePath 在这里就归一而不是等到写 header：非法路径要在读磁盘之前失败，避免白读整个文件。
      await appendTarEntry(parts, entry.sourcePath, normalizeArchivePath(entry.archivePath));
    } else {
      appendTarFile(
        parts,
        normalizeArchivePath(entry.archivePath),
        typeof entry.content === "string"
          ? Buffer.from(entry.content, "utf-8")
          : Buffer.from(entry.content),
        entry.mode,
        entry.mtimeMs,
      );
    }
  }
  appendTarFile(
    parts,
    PLUGIN_SYNC_METADATA_ARCHIVE_PATH,
    Buffer.from(`${JSON.stringify(params.metadata, null, 2)}\n`, "utf-8"),
  );
// 结尾两块全零是 tar 结束标记；本文件的解包器正是靠空 header 停止循环，缺了会多解析出垃圾条目。
  parts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));
  return await gzipAsync(Buffer.concat(parts));
}

// 解包入口：先建目标目录、再整包解压，然后逐块消费 header。
// 目标目录已存在不报错（recursive），因为上层可能在同一个 workspace 上重复同步。
// 失败时不做逐文件回滚：已写出的文件留在原地，由上层决定是否清理整个插件目录。
export async function extractPluginSyncArchive(
  archive: Uint8Array,
  targetDir: string,
  options: PluginSyncArchiveExtractOptions = {},
): Promise<void> {
// 一次性把 targetDir 解析成绝对路径，后面所有拼路径都基于它；否则相对路径的基准会随 cwd 漂移。
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });
  const maxExtractedBytes = options.maxExtractedBytes;
// 解压放在限流函数里做：zip bomb 的防线必须在真正解出字节之前生效，先解完再检查大小已经晚了。
  const buffer = await gunzipWithLimit(archive, maxExtractedBytes);
  let offset = 0;
  let extractedBytes = 0;

// 以「还剩至少一个 header 块」为条件：末尾不足 512 字节的残块直接忽略，避免把填充字节误解析成 header。
  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
// 全零 header 是结束标记；不 break 会把它解释成 size=0、路径为空，在根目录上反复 mkdir 空转。
    if (header.every((byte) => byte === 0)) {
      break;
    }

// size 来自不可信 header，这里只做八进制解析；真正的合法性由下面 dataEnd 边界判断兜底，非法值会解析成 0。
    const size = readTarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
// 声明 size 超过剩余字节即视为损坏：不截断、不按剩余长度继续，否则 offset 前进量与真实数据不对齐。
    if (dataEnd > buffer.length) {
      throw new Error("truncated plugin sync archive entry");
    }
// subarray 只建视图不拷贝，因此 data 的生命周期绑定在解压后的 buffer 上；
// 它在 writeFile 返回前一直被引用，不存在提前释放的问题。
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

// 类型位缺失（旧 tar 会把普通文件写成全 0）按 "0" 处理；
    const typeFlag = readTarString(header, 156, 1) || "0";
    const archivePath = normalizeArchivePath(readTarEntryPath(header));
// [失败路径] 路径越界时 resolveWithin 直接抛错而不是静默跳过：越界意味着归档被构造过，继续解包没有意义。
    const targetPath = resolveWithin(targetRoot, archivePath);
// 目录条目只建目录、不写内容；header 里的 size 对目录无意义，忽略它。
    if (typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
    } else if (typeFlag === "0" || typeFlag === "\0") {
// [资源] 普通文件分支：先累计体积再写入，保证超限时磁盘上不会多出刚越过上限的那个文件。
// 累计用 header 声明值而非 data.length，两者在合法包里相等，但声明值能在落盘前就拒绝。
      extractedBytes += size;
      if (maxExtractedBytes !== undefined && extractedBytes > maxExtractedBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${extractedBytes}/${maxExtractedBytes}`,
        );
      }
// 权限位只取低 9 位；header 非法值回落到 0644，防止出现 0 权限导致后续无法读取或清理。
      const fileMode = readTarMode(header);
// 父目录按需创建：归档可能省略目录条目（tar 允许隐式目录），
// 这里补齐可以让两种归档表现一致，recursive 保证并发下重复创建不报错。
      await mkdir(dirname(targetPath), { recursive: true });
// 已存在的文件会被覆盖（同步语义是「镜像远端」）；mode 只在新建时生效，
// 所以非 Windows 平台下面还要再 chmod 一次。
      await writeFile(targetPath, data, { mode: fileMode });
// [资源] 仅 POSIX 需要补 chmod：writeFile 新建文件受 umask 影响，
// plugin 脚本的可执行位必须按归档 header 恢复，否则安装后直接不可运行。
      if (process.platform !== "win32") {
        // writeFile 新建文件会受远端 umask 影响；plugin 脚本的可执行位必须按归档 header 恢复。
        await chmod(targetPath, fileMode);
      }
    } else {
// 未知类型必须显式失败：符号链接/硬链接绕过路径归一，静默跳过则会让「包里有东西没装」变成难查的缺文件问题。
      throw new Error(`unsupported plugin archive entry type: ${typeFlag}`);
    }
  }
}

// 限流的本质是给 zlib 设 maxOutputLength：超过阈值时 zlib 自行中止，
// 压缩比极高的 bomb 也只能撑到上限那一刻，不会把进程内存打满。
async function gunzipWithLimit(
  archive: Uint8Array,
  maxExtractedBytes: number | undefined,
): Promise<Buffer> {
// 未设上限时走无参路径，避免把 undefined 传进 maxOutputLength（那会被当成 0 直接失败）。
  if (maxExtractedBytes === undefined) {
    return await gunzipAsync(Buffer.from(archive));
  }
// 给 tar 的 header 与对齐填充留余量：maxExtractedBytes 只统计文件内容，解压结果却是整个 tar。
// 512 块余量覆盖条目数量带来的固定开销，是宽上限而非精确值，宁可放宽也不能误杀合法大包。
  const maxTarBytes = maxExtractedBytes + TAR_END_BLOCK_BYTES + TAR_BLOCK_SIZE * 512;
  try {
// [失败路径] 解压失败统一包装成上限错误：调用方只关心「包不可用」，不必区分损坏还是超限。
    return await gunzipAsync(Buffer.from(archive), {
      maxOutputLength: maxTarBytes,
    });
  } catch (error) {
    throw new Error(
      `plugin sync archive exceeds limit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// 递归打包：目录先写自身条目，再按名字排序写子项，保证输出稳定。
// 递归深度由目录树深度决定，不做额外限制，因为来源是本地插件目录而非远端输入。
async function appendTarEntry(
  parts: Buffer[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
// 用 lstat 而不是 stat：符号链接必须以链接自身身份出现，
// 否则递归可能沿着链接跑到插件目录之外，把无关文件卷进归档。
  const sourceStat = await lstat(sourcePath);

// 目录条目路径补尾斜杠（tar 惯例）；解包侧按类型位判断，不依赖尾斜杠，两侧因此不会耦合。
// 目录 header 的 size 写 0，实际数据由后续子条目承担。
  if (sourceStat.isDirectory()) {
    const directoryEntryPath = ensureTrailingSlash(archivePath);
    parts.push(
      createTarHeader({
        entryPath: directoryEntryPath,
        mode: sourceStat.mode,
        mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
        size: 0,
        typeFlag: "5",
      }),
    );
// 排序用 localeCompare 而不是字节序：同一份目录在 Windows 与 POSIX 上产出相同的归档顺序。
// withFileTypes 让后续不必再 stat 一次来区分文件/目录。
    const children = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
// 子路径拼接后重新归一并再跑一次长度校验，防止子项名里带 .. 把父目录带出归档范围。
// 这里串行 await 而不是并发：归档顺序必须确定，并发会让 Buffer 追加顺序不确定。
    for (const child of children) {
      await appendTarEntry(
        parts,
        join(sourcePath, child.name),
        normalizeArchivePath(posix.join(archivePath, child.name)),
      );
    }
    return;
  }

// 除目录与普通文件外的源（socket、fifo、设备）无法安全表达，直接拒绝，
// 否则 readFile 会阻塞在无数据的 fifo 上，把整个同步卡死。
  if (!sourceStat.isFile()) {
    throw new Error(`unsupported plugin archive source: ${sourcePath}`);
  }

  appendTarFile(parts, archivePath, await readFile(sourcePath), sourceStat.mode, sourceStat.mtimeMs);
}

// 写一个普通文件条目：header + 内容 + 补零到块边界，三者的 size 必须一致，
// 否则读取侧按 size 截取的数据与 padding 起点会错位。
function appendTarFile(
  parts: Buffer[],
  archivePath: string,
  content: Buffer,
  mode = 0o644,
  mtimeMs = Date.now(),
): void {
  parts.push(
    createTarHeader({
      entryPath: normalizeArchivePath(archivePath),
      mode,
      mtimeSeconds: Math.floor(mtimeMs / 1000),
      size: content.length,
      typeFlag: "0",
    }),
    content,
    Buffer.alloc(Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE - content.length),
  );
}

// 手工构造 ustar header：偏移量全部是 POSIX tar 固定位置，写错一个字段，标准 tar 与本文件读取器会给出不同解释。
function createTarHeader(options: {
  entryPath: string;
  mode: number;
  mtimeSeconds: number;
  size: number;
  typeFlag: "0" | "5";
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarEntryPath(options.entryPath);

// name/prefix 的拆分已由 splitTarEntryPath 完成（ustar 的 100 + 155 双字段限制），
// 这里只负责按固定偏移落字节，不再二次判断长度。
  writeTarString(header, name, 0, 100);
  writeTarOctal(header, options.mode & 0o777, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, options.size, 124, 12);
  writeTarOctal(header, options.mtimeSeconds, 136, 12);
// 校验和字段计算时必须按空格（0x20）处理，所以先填空格再整体求和；
// 否则求和结果里会包含上一次写入的数值，checksum 永远对不上。
  header.fill(0x20, 148, 156);
  writeTarString(header, options.typeFlag, 156, 1);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, "zcode", 265, 32);
  writeTarString(header, "zcode", 297, 32);
  writeTarString(header, prefix, 345, 155);
// [失败路径] 校验和必须最后写：它覆盖整块 512 字节，先写再改任何字段都会让校验失效。
  writeTarChecksum(header, header.reduce((sum, byte) => sum + byte, 0));
  return header;
}

// 超长路径从最右侧切分，让 name 尽量长、prefix 尽量短——反过来切会让更深层的路径无法表达。
// 找不到合法切分点说明超过 ustar 上限，只能失败（本实现不支持 pax 长名扩展）。
function splitTarEntryPath(entryPath: string): { name: string; prefix: string } {
// 按 UTF-8 字节数而不是字符数判断：name 是字节数组，中文路径 3 字节/字，按字符数会误判。
  if (Buffer.byteLength(entryPath) <= 100) {
    return { name: entryPath, prefix: "" };
  }

// 从右往左贪心，等价于把前缀压到最短，从而让 name 段尽可能保留完整文件名。
  const segments = entryPath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`plugin archive path is too long: ${entryPath}`);
}

// 读取时把 prefix 与 name 拼回完整路径；prefix 为空表示没有跨字段拆分。
// 这里不校验路径合法性，交给 normalizeArchivePath 统一处理，读写两侧共用同一判据。
function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

// 字段以 NUL 结尾，也可能写满整段没有 NUL；两种情况都必须能正确截断，否则会读进相邻字段。
function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

// 八进制字段可能为全空格（表示 0）；解析失败一律返回 0，由调用方的边界/类型判断决定是否放行。
function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

// 只保留低 9 位权限，去掉文件类型位；非法或 0 回落到 0644，避免解出的插件脚本不可读或不可执行。
function readTarMode(header: Buffer): number {
  const mode = readTarOctal(header, 100, 8);
  if (!Number.isFinite(mode) || mode <= 0) {
    return 0o644;
  }
  return mode & 0o777;
}

function writeTarString(
  buffer: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  const source = Buffer.from(value, "utf8");
  if (source.length > length) {
    throw new Error(`plugin archive header value is too long: ${value}`);
  }
  source.copy(buffer, offset);
}

// 定长八进制：左侧补 0、最右一位留给 NUL；这个 NUL 位是与标准 tar 对齐的关键，少写会让字段粘连。
function writeTarOctal(
  buffer: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarString(buffer, encoded, offset, length - 1);
  buffer[offset + length - 1] = 0;
}

// 校验和字段是 6 位八进制 + NUL + 空格；最后那个空格是标准规定的填充，
// 多数读取器会校验该位置，写错会让整包被判为损坏。
function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, "0");
  writeTarString(buffer, encoded, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

// 归档内路径统一走 pluginSyncPath 的归一，与解包侧共用同一判定，
// 避免「写的时候允许、读的时候拒绝」这种自相矛盾的包。
function normalizeArchivePath(path: string): string {
  return normalizePluginSyncRelativePath(path, {
    unsafePathLabel: "unsafe plugin archive path",
  });
}

// [并发] 只做纯路径计算、不读文件系统，因此不引入额外竞态；多任务写同一目标时的冲突由上层串行化。
function resolveWithin(targetRoot: string, archivePath: string): string {
  return resolvePluginSyncPathWithin(targetRoot, archivePath, {
    unsafePathLabel: "unsafe plugin archive path",
  });
}
