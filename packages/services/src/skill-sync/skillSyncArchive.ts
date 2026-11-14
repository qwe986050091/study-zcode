// 技能同步归档：把若干 skill 源文件打成确定性 tar.gz，并在对端按“路径、体积、类型”三重
// 校验后解包到指定目录。归档来自网络对端，除了解包结果可用之外不做任何信任假设。
// 写端与读端共用同一套路径规范化与 512 字节块布局；任何一侧的偏移或补齐不对称，
// 都会让另一侧把内容当 header 解析（表现为“归档损坏”，而不是越界写）。
// INV-01：写盘路径必须先经 normalizeArchivePath 再经 resolveSkillSyncPathWithin（守住：extract 的 targetPath；破坏：../ 或绝对路径条目写到 targetRoot 之外）。
// INV-02：累计解压字节数在读取内容之前按 header 声明的 size 预扣（守住：nextExtractedBytes 检查；破坏：先写后算会先落盘超限内容，限额形同虚设）。
// INV-03：只接受 type 0 普通文件与 5 目录，其余类型一律抛错（守住：typeFlag 分支；破坏：链接条目会被当普通文件写出，解包后可逃逸 root）。
// INV-04：input 与 gunzip 流必须在 finally 中销毁（守住：extract 的 finally；破坏：超限/损坏退出后后台仍解压，持续占内存并可能抛未处理错误）。
// INV-05：header 的 size 必须是非负安全整数（守住：readTarOctal 结果校验；破坏：NaN/负数会让 padding 计算失真，后续条目错位解析）。
// INV-06：目录条目也要跳过其 padding 再 mkdir（守住：typeFlag === "5" 分支；破坏：size>0 的畸形目录条目让下一个 header 从内容中间开始）。
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGunzip, gzip } from "node:zlib";
import {
  normalizeSkillSyncRelativePath,
  resolveSkillSyncPathWithin,
} from "./skillSyncPath.js";
import { createSkillSyncSizeLimitError } from "./skillSyncErrors.js";

const gzipAsync = promisify(gzip);
// tar 固定 512 字节块，条目内容按块补齐；末尾两个全零块才是归档终止标记。
// 块大小参与 padding 计算，改这里必须同步改读端的 tarPaddedBytes，否则解析错位。
const TAR_BLOCK_SIZE = 512;
// 结束标记占两个块：单个零块在部分实现里只表示“本块结束”，双零块才是归档终止。
const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

// 条目只描述“源文件 → 归档内相对路径”：源路径决定读哪里，归档路径由上层决定，二者不做隐式拼接。
// archivePath 在写入前统一走 normalizeArchivePath，保证不会产出解包端必然拒绝的条目。
export interface SkillSyncArchiveEntry {
  sourcePath: string;
  archivePath: string;
}

// maxExtractedBytes 是解压后累计上限；缺省表示不限，默认值应由同步层显式给出而不是在此猜测。
export interface SkillSyncArchiveExtractOptions {
  maxExtractedBytes?: number;
}

// 打包：先在内存里拼出完整 tar，再整体 gzip。包体积受同步层限额约束，这里不做流式背压。
// 返回 Uint8Array 而不是流向调用方：gzip 需要看到全部输入，流式反而要多一层生命周期管理。
export async function createSkillSyncArchive(
  entries: readonly SkillSyncArchiveEntry[],
): Promise<Uint8Array> {
// 分片收集而不是反复 concat：每次 concat 都复制全量字节，条目多时是 O(n^2)。
  const parts: Buffer[] = [];
  for (const entry of entries) {
    await appendTarEntry(parts, entry.sourcePath, normalizeArchivePath(entry.archivePath));
  }
// 必须补两个全零块：解包端读到全零 header 才认为归档结束，缺了会把最后一个条目当损坏。
  parts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));
  return await gzipAsync(Buffer.concat(parts));
}

// 解包是安全边界：归档来自对端同步，路径、大小、类型都不可信，全部在此处校验。
// 采用流式 tar 解析而不是整包解压到内存：解压膨胀比不可控，必须先按 size 预扣再看内容。
// 先算 targetPath 再 mkdir/writeFile；任何一步使用未校验路径都会把 .. 变成真实的目录穿越。
export async function extractSkillSyncArchive(
  archive: Uint8Array,
  targetDir: string,
  options: SkillSyncArchiveExtractOptions = {},
): Promise<void> {
// 先 resolve 成绝对路径，后续所有 within 校验都以它为基准；不同平台的相对基准会让校验失效。
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });
// 上限缺省时仍保留 Number.isSafeInteger 检查，防止超大 size 溢出成“负数通过”的绕过。
  const maxExtractedBytes = options.maxExtractedBytes;
// Buffer.from 拷贝一次：archive 是调用方持有的 Uint8Array，直接包进流会让 destroy 影响调用方视图。
// 拷贝后流的所有权完全归本次解包，finally 里的销毁不会波及调用方数据。
  const input = Readable.from([Buffer.from(archive)]);
// 每包新建 gunzip：zlib 流带独立状态，复用需要 reset，而错误后不可恢复，复用会把失败传染给下一次解包。
  const gunzipStream = createGunzip();
// pipe 让解压错误顺带关闭上游，但错误本身仍由 iterator.next() 抛出，由 finally 统一销毁两条流。
  const reader = new TarStreamReader(input.pipe(gunzipStream));
// 累计值只在写盘成功后推进，保证失败前已写入的部分不会让后续限额计算偏低。
  let extractedBytes = 0;

  try {
// 循环不设条目数上限：畸形归档可能有极多小条目，靠累计字节上限与流结束兜底，不做额外计数。
    while (true) {
      const header = await reader.readExactly(TAR_BLOCK_SIZE);
      if (header === null) {
        break;
      }
// 全零 header 是唯一终止信号，必须先判再解析 size——全零块的 size 字段也是 0，
// 若先解析会把它当成空文件条目继续循环，直到流末尾才暴露成截断错误。
      if (header.every((byte) => byte === 0)) {
        await reader.drain();
        break;
      }

// size 来自不可信 header：先做安全整数与负数检查，才允许用于 Buffer 分配与 padding 计算。
// 若放过 NaN，tarPaddedBytes 会得到 NaN，skipExactly 的字节数比较全为 false，后续解析静默错位。
      const size = readTarOctal(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) {
// [失败路径] 直接抛错让整包判为损坏，不尝试跳过：size 不可信时无法计算下一个 header 的位置。
        throw new Error("invalid skill sync archive entry size");
      }
// 空 typeflag 按 0 处理：历史 tar 会省略该字段，按普通文件解释是唯一兼容且安全的选择，
// 同时让下面的类型白名单拿到确定值，不会因为空串落到“不支持”分支。
      const typeFlag = readTarString(header, 156, 1) || "0";
// 路径在拼接前就规范化：拒绝绝对路径、盘符与 .. 段，比“拼接后再检查”少一条绕过路径。
// 读取时由 name/prefix 组合还原，与写入端 splitTarEntryPath 严格对称。
      const archivePath = normalizeArchivePath(readTarEntryPath(header));
// 每个条目单独解析到 targetRoot 内：文件与目录走同一校验，不存在“目录已验、文件跳过”的缺口。
// [失败路径] 越界直接抛错终止整个解包，已写入内容由上层清理临时目录。
      const targetPath = resolveWithin(targetRoot, archivePath);

      if (typeFlag === "5") {
        await reader.skipExactly(tarPaddedBytes(size));
// 先跳过内容再建目录：与写入端“目录条目 size=0”呼应，也避免畸形目录条目让偏移错位。
        await mkdir(targetPath, { recursive: true });
        continue;
      }

      if (typeFlag !== "0" && typeFlag !== "\0") {
        throw new Error(`unsupported skill archive entry type: ${typeFlag}`);
      }

      const nextExtractedBytes = extractedBytes + size;
      if (
        !Number.isSafeInteger(nextExtractedBytes) ||
        (maxExtractedBytes !== undefined && nextExtractedBytes > maxExtractedBytes)
      ) {
// [资源] 用专用错误类型携带 actual/max/phase，上层据此提示“归档过大”而不是笼统的解析失败。
        throw createSkillSyncSizeLimitError({
          actualBytes: nextExtractedBytes,
          maxBytes: maxExtractedBytes ?? Number.MAX_SAFE_INTEGER,
          phase: "extracted-content",
        });
      }

      const data = await reader.readExactly(size);
      if (data === null) {
// 声明 size 与真实数据不符：宁可整包失败，也不能写出长度不足的文件让上层以为同步成功。
        throw new Error("truncated skill sync archive entry");
      }
// 只跳过对齐块，有效数据已读完；若写成 skip(size) 会把后面的条目一起吞掉。
      await reader.skipExactly(tarPaddedBytes(size) - size);
// 归档可能缺少目录条目，文件条目的父目录必须递归补建，否则 writeFile 会 ENOENT。
      await mkdir(dirname(targetPath), { recursive: true });
// 最后才写盘：路径、大小、类型全部通过后才产生文件系统副作用。
      await writeFile(targetPath, data);
// 写盘成功后才累加：写失败时不计入已用配额，避免一次失败让后续条目被误判超限。
      extractedBytes = nextExtractedBytes;
    }
  } finally {
    // 发现大小超限或归档损坏时主动销毁流，避免 gzip 在后台继续膨胀或触发未处理错误。
// 两条流都要销毁：input 是数据源，gunzip 是 transform；只销毁其一，另一个仍持有缓冲与解压状态。
// 在 finally 中执行，任何抛错路径（超限、类型不支持、截断）都不会漏掉清理。
    input.destroy();
    gunzipStream.destroy();
  }
}

function tarPaddedBytes(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

class TarStreamReader {
// 直接持有迭代器而不是 stream：所有读取都经过同一游标，避免外部再次消费导致数据竞争。
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private done = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

// 返回 null 表示“流干净结束且无剩余字节”，与 bufferedBytes 不足（截断抛错）是两种语义，
// 调用方必须区分：前者是正常归档结束，后者是数据缺失。
  async readExactly(byteCount: number): Promise<Buffer | null> {
    if (byteCount === 0) {
      return Buffer.alloc(0);
    }
    await this.fill(byteCount);
// 一个字节都没读到才算干净结束；已经读到部分内容但仍不够，说明归档被截断。
    if (this.bufferedBytes === 0) {
      return null;
    }
    if (this.bufferedBytes < byteCount) {
      throw new Error("truncated skill sync archive");
    }

// allocUnsafe 省一次清零；安全性来自随后 consume 必定写满 byteCount，不会外泄未初始化内存。
    const output = Buffer.allocUnsafe(byteCount);
    this.consume(byteCount, output);
    return output;
  }

  async skipExactly(byteCount: number): Promise<void> {
    if (byteCount === 0) {
      return;
    }
    await this.fill(byteCount);
    if (this.bufferedBytes < byteCount) {
      throw new Error("truncated skill sync archive");
    }
    this.consume(byteCount);
  }

// drain 消费到流结束：让 gzip 完整走完以便正常关闭，也保证随后 destroy 不会再触发“还有待处理数据”。
// 只在读到全零结束块时调用；其它路径靠 finally 直接销毁，不需要读完剩余字节。
  async drain(): Promise<void> {
// 直到迭代器 done 才停止：drain 的目的是让源流自然结束，提前 return 会留下未消费数据。
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
      }
    }
  }

// fill 只保证“至少 byteCount 字节可用”或流结束，不保证正好；截断判定留给调用方。
// 空 chunk 直接跳过：零长度数据会让 while 条件永远不前进，形成死循环。
  private async fill(byteCount: number): Promise<void> {
    while (!this.done && this.bufferedBytes < byteCount) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
// 某些解压实现会吐出空块，计入 bufferedBytes 会造成解析提前“满足”而读到错位数据。
      if (next.value.length === 0) {
        continue;
      }
      this.chunks.push(next.value);
      this.bufferedBytes += next.value.length;
    }
  }

// 单块内移动用 subarray 而不是 copy：部分消费时只切视图，避免每次拷贝剩余数据。
// chunks.shift() 只在整块消费完时执行，保证 pending 队列不会累积空块。
  private consume(byteCount: number, output?: Buffer): void {
// remaining 与 outputOffset 分开维护：一个表示还要从缓冲取多少，一个表示写到输出的位置。
    let remaining = byteCount;
    let outputOffset = 0;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) {
        throw new Error("truncated skill sync archive");
      }
// 按块截断消费，跨块读取由 while 迭代完成，避免把单块整体复制一遍。
      const consumed = Math.min(remaining, chunk.length);
// output 为空是纯 skip 路径：不分配、不复制，padding 与不支持的类型都走这里。
      if (output) {
        chunk.copy(output, outputOffset, 0, consumed);
        outputOffset += consumed;
      }
      if (consumed === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(consumed);
      }
// bufferedBytes 必须与 chunks 同步递减，否则下一次 readExactly 会用错长度做截断判断。
      this.bufferedBytes -= consumed;
      remaining -= consumed;
    }
  }
}

// 写端负责生成“解包端能严格对称解析”的字节：目录以 / 结尾且 type=5，文件补齐到块边界。
// 递归写入保证目录条目先于其子项出现，解包端可以在建文件前先把父目录建好。
async function appendTarEntry(
  parts: Buffer[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
// 用 lstat 而非 stat：符号链接会被识别为链接并落入“不支持”分支，避免把链接目标内容打包进归档。
  const sourceStat = await lstat(sourcePath);

// 目录条目 size 固定 0：内容由后续递归条目表达，写内容会让解包端把它当文件处理。
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
// 排序保证确定性：同一目录在不同机器、不同文件系统返回顺序下产出相同 tar 字节，才能用哈希判等。
// localeCompare 而不是裸比较，避免大小写混排时出现平台相关顺序。
    const children = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      await appendTarEntry(
        parts,
        join(sourcePath, child.name),
        normalizeArchivePath(posix.join(archivePath, child.name)),
      );
    }
    return;
  }

// 只允许普通文件与目录：socket/fifo/设备文件既无法稳定读内容，也会让对端解出无意义条目。
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    throw new Error(`unsupported skill archive source: ${sourcePath}`);
  }

// 整文件读入内存：tar header 的 size 必须提前可知，流式写入将无法校验实际读到的长度。
  const content = await readFile(sourcePath);
  parts.push(
    createTarHeader({
      entryPath: archivePath,
      mode: sourceStat.mode,
      mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
      size: content.length,
      typeFlag: "0",
    }),
    content,
    Buffer.alloc(Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE - content.length),
  );
}

function createTarHeader(options: {
  entryPath: string;
  mode: number;
  mtimeSeconds: number;
  size: number;
  typeFlag: "0" | "5";
}): Buffer {
// 全零初始化：未显式写入的字段（如 linkname）在 ustar 中必须是 NUL，否则外部 tar 会读到随机残留。
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
// 先切分路径再逐字段写：header 是定长结构，字段偏移不能靠字符串拼接。
  const { name, prefix } = splitTarEntryPath(options.entryPath);

  writeTarString(header, name, 0, 100);
  writeTarOctal(header, options.mode & 0o777, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, options.size, 124, 12);
  writeTarOctal(header, options.mtimeSeconds, 136, 12);
// checksum 字段先填 8 个空格再求和，这是 tar 规范要求的计算前置状态。
  header.fill(0x20, 148, 156);
  writeTarString(header, options.typeFlag, 156, 1);
// 显式写 magic/version：不写多数实现也能读，但可能被当成 pre-POSIX tar 而拒绝长路径。
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, "zcode", 265, 32);
  writeTarString(header, "zcode", 297, 32);
  writeTarString(header, prefix, 345, 155);
// 校验和必须在所有字段写完后才计算：先算再改字段会让 checksum 与实际内容不符，解包直接拒绝。
  writeTarChecksum(header, header.reduce((sum, byte) => sum + byte, 0));
  return header;
}

// ustar 的 name 只有 100 字节、prefix 155 字节；长路径必须在 / 处切开，且两段各自满足上限。
// 从最右的切分点往左找，优先让 name 短、prefix 长，深层嵌套路径更容易成功。
function splitTarEntryPath(entryPath: string): { name: string; prefix: string } {
// 用字节长度而不是字符数：UTF-8 汉字占 3 字节，按 length 判断会写出超长 header 字段。
  if (Buffer.byteLength(entryPath) <= 100) {
    return { name: entryPath, prefix: "" };
  }

  const segments = entryPath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

// 两段都放不下时抛错而不是截断：截断会生成一个能写出但无法正确解包的归档。
  throw new Error(`skill archive path is too long: ${entryPath}`);
}

function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

// 定长写入并不补 NUL——Buffer 已全零初始化，未写满的尾部天然是终止符。
function writeTarString(
  buffer: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  buffer.write(value, offset, length, "utf8");
}

// 八进制宽度固定且末位留 NUL：padStart 到 length-1 再取低位，超宽值被截断成低位而不是溢出字段。
// slice(-(length-1)) 与 readTarString 的终止符语义一致，写读两侧必须成对修改。
function writeTarOctal(
  buffer: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  writeTarString(buffer, encoded.slice(-(length - 1)), offset, length - 1);
}

// checksum 字段是 6 位八进制 + NUL + 空格，这 8 字节是 tar 里唯一不能用纯字符串写的布局。
// 154 必须是 NUL、155 必须是空格；写反会让外部 tar 与解包端都判定头部损坏。
function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, "0").slice(-6);
  writeTarString(buffer, encoded, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

// 归档内路径统一用 POSIX 分隔符并做反转义校验；写入与读取共用本函数，保证两侧口径一致。
// 写端与读端各调一次是刻意的冗余：单侧漏调就会让对端收到无法校验的路径。
function normalizeArchivePath(path: string): string {
  return normalizeSkillSyncRelativePath(path, {
    unsafePathLabel: "unsafe skill archive path",
  });
}

// 写盘前必须再做一次“落在 targetRoot 内”的解析：路径已规范化，但目录拼接后仍可能越界。
function resolveWithin(targetRoot: string, archivePath: string): string {
  return resolveSkillSyncPathWithin(targetRoot, archivePath, {
    unsafePathLabel: "unsafe skill archive path",
  });
}

// 目录条目必须以 / 结尾：解包端据此与 type=5 呼应，外部 tar 也按此识别目录。
function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}
