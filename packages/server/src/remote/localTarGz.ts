// remote assets 本地缓存所用的 tar.gz 极简读写实现，只覆盖本仓库自己产出的普通文件、目录与符号链接子集。
// 不依赖系统 tar.exe：Windows 客户端的 System32 tar 不一定在 PATH，也不保证接受 GNU 参数。
// 不负责：硬链接、设备与 FIFO、GNU base-256 大尺寸、pax 键值语义、增量与流式处理、压缩级别调优。
//
// INV-01 断言：解包目标根目录必须在 mkdir 之前 resolve 成绝对路径 —— 守住它的位置：extractTarGzArchive 的 targetRoot 与 assertPathInsideBase —— 改错故障：相对路径随工作目录漂移，合法条目被误判越界或越界条目漏过。
// INV-02 断言：条目声明长度必须落在解压后缓冲区之内 —— 守住它的位置：extractTarGzArchive 的 dataEnd 检查 —— 改错故障：subarray 静默截断，产出 0 字节或半截文件，远端资源加载报语法错误。
// INV-03 断言：offset 只能按 512 字节块对齐推进 —— 守住它的位置：roundUpToTarBlock 与 while 循环体 —— 改错故障：后续 header 错位，解析出垃圾 typeflag 并抛 unsupported entry type。
// INV-04 断言：GNU 长名只对紧随其后的那一条条目生效 —— 守住它的位置：nextEntryName 的设置与消费后清空 —— 改错故障：长路径错位挂到别的条目，或提前清空导致长名被截成 100 字节。
// INV-05 断言：空名、单点与 ./ 前缀这类噪声条目应丢弃而不是抛错 —— 守住它的位置：normalizeExtractEntryPath 返回 null 的分支 —— 改错故障：打包器默认写入的首条目让整包解包失败。
// INV-06 断言：任何条目落盘前都必须经过 resolvePathWithinBase —— 守住它的位置：extractTarGzArchive 的 targetPath 构造 —— 改错故障：zip-slip，上跳条目写到本地缓存目录之外。
// INV-07 断言：反斜杠、盘符与绝对路径一律拒绝而不做归一化 —— 守住它的位置：normalizeExtractEntryPath 与 normalizeSymlinkLinkName —— 改错故障：反斜杠形式的上跳在 Windows 上绕过 posix 归一化，越界写文件。
// INV-08 断言：上跳段校验必须发生在 posix.normalize 之后 —— 守住它的位置：normalizeExtractEntryPath 的 normalized 判断 —— 改错故障：a 下两层上跳再进 b 的写法在归一化前不含上跳子串，越界路径被放行。
// INV-09 断言：符号链接目标解析后的真实落点必须仍在目标根内 —— 守住它的位置：normalizeExtractSymlinkTarget 的 relative 判断 —— 改错故障：链接指向缓存目录之外，后续读写跟随链接破坏用户文件。
// INV-10 断言：创建链接前必须先删除同名旧路径 —— 守住它的位置：typeFlag 为 2 分支的 unlinkIfExists —— 改错故障：重复解包抛 EEXIST，升级安装直接失败。
// INV-11 断言：目录条目的 mode 固定写 0755，不用源 stat.mode —— 守住它的位置：appendTarEntry 的目录分支 —— 改错故障：远端叠加 umask 后目录变 0644 不可遍历，资源加载报 EACCES。
// INV-12 断言：子条目写入顺序必须确定 —— 守住它的位置：appendTarEntry 中 readdir 后的排序 —— 改错故障：同内容产出不同字节，包哈希漂移导致缓存反复失效并重复下载。
// INV-13 断言：打包侧取源状态必须用 lstat 而不是 stat —— 守住它的位置：appendTarEntry 的 sourceStat —— 改错故障：符号链接被解引用成实体文件，包体积膨胀且链接语义丢失。
// INV-14 断言：ustar 校验和必须在所有头部字段写完之后按字节求和 —— 守住它的位置：createTarHeader 的 checksum 循环 —— 改错故障：任意解包器报 header checksum 错误，整包不可用。
// INV-15 断言：name 不超过 100 字节且 prefix 不超过 155 字节 —— 守住它的位置：splitTarEntryPath 的拆分循环 —— 改错故障：长路径被 writeTarString 静默截断，解包得到错误文件名。
// INV-16 断言：chmod 失败不得中断解包 —— 守住它的位置：applyMode 的空 catch —— 改错故障：Windows 与受限文件系统上整包安装因权限位失败而中止。
import { gzip, gunzip } from "node:zlib";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import { promisify } from "node:util";

// [权衡] tar 头与 gzip 都用 node 自带能力实现，为的是不依赖 system tar：Windows 客户端不一定能 spawn 到 System32 下的 tar.exe。
// 写包先把全部条目塞进 Buffer 数组，再一次性 gzip 与 writeFile，没有临时文件加 rename，进程中断会留下半截归档。
// 因此不可解包的半截包只能由调用方按缓存丢弃处理，完整性校验不放在本文件。
// gzip 用默认级别，改 level 会让同一份内容产出不同字节，依赖包体哈希的上层缓存会整批失效。
// promisify 只包一次并复用，逐次调用会反复创建包装函数，解包热路径上没有必要付这个开销。
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

// [契约] sourcePath 是本地磁盘绝对路径，只用于 lstat 与 readFile，绝不会写进归档。
// archivePath 是 POSIX 风格相对路径，入包前会去掉前导点斜杠与尾部斜杠，空值与裸点直接抛错。
// 两个字段不能互相代入：把 sourcePath 当 archivePath 会把本机绝对目录结构打进包，解包侧必然判定越界。
// entries 的顺序就是归档顺序，需要字节级可复现的调用方必须自己先排好序。
// 这里只描述单条目，目录递归由 appendTarEntry 自行展开，调用方不需要预先平铺文件清单。
export interface LocalTarGzEntry {
  sourcePath: string;
  archivePath: string;
}

// Windows 客户端不一定能 spawn System32\tar.exe，远端资源本地缓存不能依赖系统 tar。
// 这里仅支持 ZCode remote assets 使用的普通文件/目录子集，避免扩大归档格式的行为面。
export async function extractTarGzArchive(archivePath: string, targetDir: string): Promise<void> {
  // [契约] 目标根目录必须先 resolve 成绝对路径，后面所有包含性判断都以它为基准。
  // 保留相对路径时，process.cwd() 在任意 await 期间变化都会让同一个条目落到不同位置。
  // 必须用 resolve 而不是 join：join 会保留末尾的上跳段，判断基准随之偏移。
  // 这里刻意不做 realpath 解析：缓存目录本身可能是挂载点或符号链接，解析后前缀与传入值不一致。
  // 若将来改成 realpath，必须同步调整 assertPathInsideBase，并把两次解析结果都显式保留。
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });

  // [权衡] 整包一次性解压进内存，换来对 header 的随机访问与零状态机复杂度。
  // 远端资源包是有限大小的静态资产，这个取舍成立，换成流式要在条目之间维护半块状态，不划算。
  // 代价是解压峰值内存约等于原始包大小，超大包会直接 OOM 而不是缓慢降级。
  // readFile 与 gunzip 的顺序不能反：gunzip 只接收 Buffer，改成 createGunzip 流式就得重写整个 offset 循环。
  // [失败路径] gzip 损坏时 gunzip 直接 reject，异常原样上抛，不包装成 remote-assets 前缀。
  const archiveBuffer = await gunzipAsync(await readFile(archivePath));
  let offset = 0;
  let nextEntryName: string | null = null;

  // [契约] 循环条件用小于等于而不是小于，保证只有凑满一个完整 512 字节块才解析 header。
  // 块尾不足 512 字节的残片被静默忽略，这是为兼容尾部 padding 被裁掉的第三方包。
  // 所以循环正常退出并不代表包完整：缺少两个全零结束块时同样在这里退出，不会额外报错。
  // 不要为严格性在循环后补长度断言，npm 与部分打包器产出的尾块长度并不统一。
  // offset 只允许按块推进，任何 continue 分支都不能跳过这步，否则会在原块上死循环。
  while (offset + TAR_BLOCK_SIZE <= archiveBuffer.length) {
    const header = archiveBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;

    // [契约] 首个全零块即视为归档结束，直接 break，其后内容一概不解析。
    // 不能改成 continue：padding 会被当成 header 继续解析，offset 随垃圾内容滑出边界。
    // 全零判定必须逐字节比较，pax 扩展头的 body 里同样可能出现长串零，不能改用长度或正则近似。
    // tar 规范要求两个全零结束块；这里消费第一个就 break，第二个随 offset 越过 EOF 由 while 条件排除。
    // 因此本函数发现不了尾部被追加垃圾的包，完整性只依赖 gzip 校验和，不依赖 tar 结构。
    if (isZeroBlock(header)) {
      break;
    }

    // [契约] size 字段按 12 字节八进制解析，是数据区长度与 offset 推进的唯一来源。
    // 不支持 GNU base-256 大尺寸扩展：首字节为 0x80 时 parseInt 只能得到 NaN，长度比较与 subarray 会一起失效。
    // 失效表现是解包提前结束且不抛错，而不是明确失败，因此不能拿本函数处理任意来源的 tar。
    // 不要在这里加 NaN 兜底转 0，那会把越界包伪装成空文件，问题从解包期推迟到运行期。
    // parseTarOctal 返回数字而不是字符串，调用方不要重复 parseInt 或再 trim。
    const size = parseTarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    // [失败路径] 条目声明长度超出解压缓冲区即抛错，阻止 subarray 越界后静默截断。
    // 过短的 subarray 会产出 0 字节或半截文件，症状是远端资源加载时报语法错误或哈希不符，比解包失败更难排查。
    // 这个检查必须放在 subarray 之前，放到之后数据已被裁掉，检查失去意义。
    // 错误信息只带 archivePath 不带条目名，是因为此处尚未解析路径，定位要配合包名日志。
    // 抛错会中止整个解包且不回滚已写条目，调用方必须把目标目录当可丢弃缓存。
    if (dataEnd > archiveBuffer.length) {
      throw new Error(`[remote-assets] truncated tar entry in ${archivePath}`);
    }

    const data = archiveBuffer.subarray(dataStart, dataEnd);
    offset = dataStart + roundUpToTarBlock(size);

    const typeFlag = readTarTypeFlag(header);
    // [契约] GNU 长名只对紧随其后的一条条目生效，nextEntryName 在这里设置，并在下一条消费后清空。
    // 不能在 continue 之前清空，也不能让它跨条目复用，否则长路径会错位挂到别的条目上。
    // 长名 body 是 UTF-8 路径字符串，可能带结尾 NUL，截断交给 readTarString。
    // 同时存在 pax 与 GNU 长名时 pax 被跳过，仍以长名为准，这是有意简化而不是遗漏。
    // 不要在这里单独做路径安全校验，校验统一在 normalizeExtractEntryPath，重复实现必然漏掉一边。
    if (typeFlag === "L") {
      nextEntryName = readTarString(data, 0, data.length);
      continue;
    }
    // [权衡] pax 扩展头与全局头整体跳过，既不解析键值，也不套用其中的 path 与 size 覆盖。
    // 若改成抛错，npm 等工具产出的包会整包解包失败，因为现代包几乎都带 pax 头。
    // 跳过是安全的：真正影响落盘的是后续条目的 header 与数据，pax 里的时间戳与本地缓存无关。
    // 代价是超长路径若只写在 pax 里会被忽略，此时按 header 里的截断名解包，症状是文件名少一截。
    // 不要顺手把 pax 的 size 写回 header，offset 已按原始 size 推进过，改了必然错位。
    if (typeFlag === "x" || typeFlag === "g") {
      continue;
    }

    const rawEntryName = nextEntryName ?? readTarEntryPath(header);
    nextEntryName = null;
    // [安全] 条目路径先过 normalizeExtractEntryPath 再拼磁盘路径，这是 zip-slip 的第一道闸。
    // 返回 null 表示空名、裸点与点斜杠前缀等噪声条目，直接 continue 丢弃而不是抛错。
    // 所有打包器都会写一条点斜杠作为首条目，把 null 当错误会让任何正常包都解不开。
    // 必须在这里丢弃而不是交给 resolvePathWithinBase 报越界，因为裸点会解析成根目录本身并触发误判。
    // 丢弃不影响 offset，数据区已经在上方按 size 跳过。
    const safeEntryPath = normalizeExtractEntryPath(rawEntryName);
    if (!safeEntryPath) {
      continue;
    }

    const targetPath = resolvePathWithinBase(targetRoot, safeEntryPath);
    const mode = parseTarOctal(header, 100, 8);

    if (typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
      await applyMode(targetPath, mode);
      continue;
    }

    if (typeFlag === "0" || typeFlag === "\0") {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, data);
      await applyMode(targetPath, mode);
      continue;
    }

    // [资源] 建符号链接前必须先 unlinkIfExists，symlink 遇到已存在路径会抛 EEXIST 而不是覆盖。
    // 若 targetPath 恰好是已存在目录，unlink 会以 EISDIR 失败并中断解包，这里刻意不做递归删除，避免抹掉已解出的缓存内容。
    // 父目录必须先递归建好，链接可能嵌在多层目录里。
    // 链接目标交给 normalizeExtractSymlinkTarget 做磁盘落点校验，这里不做二次拼接。
    // 重复解包同一目录是升级常态，去掉 unlink 会让第二次安装直接失败。
    if (typeFlag === "2") {
      const linkTarget = normalizeExtractSymlinkTarget({
        rawLinkTarget: readTarString(header, 157, 100),
        targetPath,
        targetRoot,
      });
      await mkdir(dirname(targetPath), { recursive: true });
      await unlinkIfExists(targetPath);
      await symlink(linkTarget, targetPath);
      continue;
    }

    throw new Error(
      `[remote-assets] unsupported tar entry type ${JSON.stringify(typeFlag)} for ${rawEntryName}`,
    );
  }
}

export async function createTarGzArchive(
  archivePath: string,
  entries: readonly LocalTarGzEntry[],
): Promise<void> {
  const archiveParts: Buffer[] = [];
  for (const entry of entries) {
    await appendTarEntry(archiveParts, entry.sourcePath, entry.archivePath);
  }
  archiveParts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, await gzipAsync(Buffer.concat(archiveParts)));
}

async function appendTarEntry(
  archiveParts: Buffer[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  const sourceStat = await lstat(sourcePath);
  const normalizedArchivePath = normalizeCreateEntryPath(archivePath);

  if (sourceStat.isDirectory()) {
    const directoryEntryPath = ensureTrailingSlash(normalizedArchivePath);
    archiveParts.push(
      createTarHeader({
        entryPath: directoryEntryPath,
        // Windows lstat 的目录 mode 只有读写语义，常见为 0666；原样写进 tar 后，
        // 远端 tar 叠加 umask 会落成不可遍历的 0644。远端资源目录统一使用 POSIX 0755。
        mode: 0o755,
        mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
        size: 0,
        typeFlag: "5",
      }),
    );

    // [契约] 子条目按名字排序后写入，保证同一份输入产出字节级相同的归档。
    // 缓存命中与包体校验都依赖这种确定性，顺序漂移会让同样内容算出不同 gzip 结果。
    // 排序按 name 而不是完整路径，同层前缀相同，按 name 排等价且比较成本更低。
    // localeCompare 受运行环境 locale 影响，需要跨机器一致时不要随手换成小于号比较。
    // 递归调用自身展开子目录，当前目录条目已在上方写入，这里只负责子孙。
    const children = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      await appendTarEntry(
        archiveParts,
        join(sourcePath, child.name),
        posix.join(normalizedArchivePath, child.name),
      );
    }
    return;
  }

  // [契约] sourceStat 来自 lstat，符号链接不会被跟随，isFile 为 false 正是链接分支的入口。
  // 若换成 stat，链接会被解引用成实体文件写进归档，包体积膨胀且链接语义丢失。
  // 非常规文件走到最后的抛错分支，不要静默跳过，否则包内容与预期文件清单不一致。
  // 目录与文件都在前面返回，这里剩下的只有链接与非法类型。
  // 判断顺序不能调整：先目录再链接再普通文件，链接指向目录时仍按链接处理。
  if (!sourceStat.isFile()) {
    if (sourceStat.isSymbolicLink()) {
      const linkTarget = normalizeCreateSymlinkTarget({
        archivePath: normalizedArchivePath,
        rawLinkTarget: await readlink(sourcePath),
      });
      archiveParts.push(
        createTarHeader({
          entryPath: normalizedArchivePath,
          linkName: linkTarget,
          mode: 0o777,
          mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
          size: 0,
          typeFlag: "2",
        }),
      );
      return;
    }

    throw new Error(`[remote-assets] unsupported local archive source: ${sourcePath}`);
  }

  const content = await readFile(sourcePath);
  archiveParts.push(
    createTarHeader({
      entryPath: normalizedArchivePath,
      mode: sourceStat.mode,
      mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
      size: content.length,
      typeFlag: "0",
    }),
    content,
    Buffer.alloc(roundUpToTarBlock(content.length) - content.length),
  );
}

function createTarHeader(options: {
  entryPath: string;
  linkName?: string;
  mode: number;
  mtimeSeconds: number;
  size: number;
  typeFlag: "0" | "2" | "5";
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarEntryPath(options.entryPath);

  writeTarString(header, name, 0, 100);
  writeTarOctal(header, options.mode & 0o777, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, options.size, 124, 12);
  writeTarOctal(header, options.mtimeSeconds, 136, 12);
  header.fill(0x20, 148, 156);
  writeTarString(header, options.typeFlag, 156, 1);
  if (options.linkName) {
    if (Buffer.byteLength(options.linkName) > 100) {
      throw new Error(`[remote-assets] tar symlink target is too long: ${options.linkName}`);
    }
    writeTarString(header, options.linkName, 157, 100);
  }
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, "zcode", 265, 32);
  writeTarString(header, "zcode", 297, 32);
  writeTarString(header, prefix, 345, 155);

  // [契约] ustar 校验和是 header 前 512 字节的逐字节求和，必须等所有字段写完才能算。
  // 148 到 155 这 8 字节在校验时按空格计，所以上面先填空格再求和，写结果时也回填同样的空格。
  // 若先求和再写 typeflag 或 prefix，真实解包器会报 header checksum 错误，整包不可用。
  // 校验和是六位八进制加 NUL 加空格，最后两个字节的写法不能省。
  // 解包侧不校验读到的 checksum，损坏但可解压的包只能靠 gzip 完整性兜住。
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarChecksum(header, checksum);
  return header;
}

function splitTarEntryPath(entryPath: string): { name: string; prefix: string } {
  const encodedLength = Buffer.byteLength(entryPath);
  if (encodedLength <= 100) {
    return { name: entryPath, prefix: "" };
  }

  // [契约] 路径超过 100 字节时才走 ustar 的 name 加 prefix 拆分，拆分点从右往左找。
  // 从右往左是为了让 name 尽量长、prefix 尽量短，反过来会拒绝掉本可表达的路径。
  // prefix 上限 155、name 上限 100，任一超限就继续左移，全部尝试失败才抛错。
  // 字节长度必须用 Buffer.byteLength 而不是字符串长度，中文路径按 UTF-8 会膨胀到三倍。
  // 拆不出来时抛错而不是截断，截断会解出错误文件名，症状比直接失败隐蔽得多。
  const segments = entryPath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`[remote-assets] tar entry path is too long: ${entryPath}`);
}

function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarTypeFlag(header: Buffer): string {
  const value = header[156] ?? 0;
  return value === 0 ? "0" : String.fromCharCode(value);
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value, offset, length, "utf8");
}

function parseTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, "0");
  writeTarString(buffer, encoded.slice(-(length - 1)), offset, length - 1);
}

function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, "0").slice(-6);
  writeTarString(buffer, encoded, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function roundUpToTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

function normalizeCreateEntryPath(entryPath: string): string {
  const normalized = entryPath.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (!normalized || normalized === ".") {
    throw new Error("[remote-assets] tar entry path must not be empty");
  }
  return normalized;
}

function normalizeExtractEntryPath(entryPath: string): string | null {
  const trimmed = entryPath.trim().replace(/^\.\/+/u, "");
  if (!trimmed || trimmed === ".") {
    return null;
  }
  if (trimmed.includes("\\") || isAbsolute(trimmed) || posix.isAbsolute(trimmed)) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${entryPath}`);
  }

  // [安全] 必须归一化之后再检查上跳段与绝对路径，顺序反了会被 a 上两层再进 b 这类路径绕过。
  // 归一化前该串只含普通段与斜杠，不含上跳子串，前置检查会全部放行。
  // 归一化用 posix.normalize 而不是平台 path.normalize，否则 Windows 下反斜杠会被当成合法分隔符。
  // 尾部斜杠在归一化之后才去掉，避免目录条目与文件条目被视为两个不同的名字。
  // normalized 为 ".."、空串或以 "../" 开头时一律 throw，不降级成 skip：调用方必须显式处理越界。
  const normalized = posix.normalize(trimmed).replace(/\/+$/u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${entryPath}`);
  }
  return normalized;
}

function normalizeCreateSymlinkTarget({
  archivePath,
  rawLinkTarget,
}: {
  archivePath: string;
  rawLinkTarget: string;
}): string {
  const normalizedLinkTarget = normalizeSymlinkLinkName(rawLinkTarget);
  const parentArchivePath = posix.dirname(archivePath);
  const resolvedArchiveTarget = posix.normalize(
    posix.join(parentArchivePath === "." ? "" : parentArchivePath, normalizedLinkTarget),
  );
  if (
    !resolvedArchiveTarget ||
    resolvedArchiveTarget === "." ||
    resolvedArchiveTarget === ".." ||
    resolvedArchiveTarget.startsWith("../")
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalizedLinkTarget;
}

function normalizeExtractSymlinkTarget({
  rawLinkTarget,
  targetPath,
  targetRoot,
}: {
  rawLinkTarget: string;
  targetPath: string;
  targetRoot: string;
}): string {
  const normalizedLinkTarget = normalizeSymlinkLinkName(rawLinkTarget);
  const resolvedTarget = resolve(dirname(targetPath), ...normalizedLinkTarget.split("/"));
  const relativePath = relative(targetRoot, resolvedTarget);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalizedLinkTarget;
}

function normalizeSymlinkLinkName(rawLinkTarget: string): string {
  const normalized = posix.normalize(rawLinkTarget);
  // tar symlink 如果允许绝对路径、Windows drive 或反斜杠，解包后可能把本地缓存指向目标目录外。
  // 这里只保留 POSIX 相对 link target，并在创建/解包两侧继续校验它解析后的落点。
  if (
    !rawLinkTarget ||
    !normalized ||
    normalized === "." ||
    normalized.includes("\\") ||
    isAbsolute(normalized) ||
    posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/u.test(normalized)
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalized;
}

function ensureTrailingSlash(entryPath: string): string {
  return entryPath.endsWith("/") ? entryPath : `${entryPath}/`;
}

function resolvePathWithinBase(baseDir: string, entryPath: string): string {
  const targetPath = resolve(baseDir, ...entryPath.split("/"));
  assertPathInsideBase(baseDir, targetPath, entryPath);
  return targetPath;
}

function assertPathInsideBase(baseDir: string, targetPath: string, sourceLabel: string): void {
  const relativePath = relative(baseDir, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${sourceLabel}`);
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

// [失败路径] mode 为 0 时直接返回，避免对解析失败的条目调用 chmod 把权限清成 0。
// chmod 失败被完全吞掉，Windows 与 FAT 类文件系统不支持权限位，抛出会让整包解包中止。
// 权限位只是尽力而为，远端部署会按 executable 参数重新 chmod，因此这里不回传失败。
// 掩码 0o777 会去掉 setuid 与 sticky 位，归档里的特权位不应带到本地缓存。
// 不要把这个 catch 收窄成只忽略 EPERM，其他错误码同样不该阻断解包。
async function applyMode(filePath: string, mode: number): Promise<void> {
  if (!mode) {
    return;
  }
  try {
    await chmod(filePath, mode & 0o777);
  } catch {
    // 权限位在 Windows 或受限文件系统上可能不可写，远端部署会按 executable 参数重新 chmod。
  }
}
