// 组件缓存与归档安全层：负责把平台组件归档落盘到 缓存目录/target/componentId/sha256，
// 校验归档与组件内容摘要，解压到暂存 release 目录，最后原子提升为不可变发布目录。
// 不负责：下载决策、网络重试、组件清单语义、发布目录版本选择与回滚，这些由 installer 与 runtime 承担。
//
// 关键性质：本模块所有写操作都可重入，任意时刻中断只会留下可识别、可被下次运行清理的临时物。
// 关键性质：对外可见状态只有「已改名完成的名字」，不存在边写边被读到的中间态。
//
// INV-01 断言：组件 id 必须以字母数字开头，且只含字母数字与点、下划线、连字符 —— 守住它的位置：assertComponentId —— 改错故障：带路径分隔符的 id 会把缓存目录写到父级目录之外
// INV-02 断言：组件摘要必须是 64 位十六进制 —— 守住它的位置：assertSha256 与 putArchive —— 改错故障：非法摘要被当成目录名，恢复时命中到别的组件内容
// INV-03 断言：归档成员路径不得为绝对路径、不得含 NUL、不得含两个点的独立段 —— 守住它的位置：safeRelativePath —— 改错故障：解压可写到目标目录之外，覆盖发布目录里的其他文件
// INV-04 断言：解压时拒绝符号链接成员，目录遍历时拒绝符号链接 —— 守住它的位置：isZipSymlink 与 listFiles —— 改错故障：组件可借链接读到或改写发布目录之外的内容
// INV-05 断言：同一归档内不允许重复成员路径 —— 守住它的位置：extractZipSafely 的 seen 集合 —— 改错故障：后写覆盖先写，内容摘要与清单不一致却已落盘
// INV-06 断言：缓存命中必须同时核对组件 id、组件摘要、归档摘要三项 —— 守住它的位置：findArchive —— 改错故障：截断或串号的旧归档被复用，组装阶段才失败且永久卡在坏缓存
// INV-07 断言：没有归档摘要字段的旧标记一律视为未命中 —— 守住它的位置：findArchive 的标记判断 —— 改错故障：旧条目永远命中，下载器再无机会修复
// INV-08 断言：写缓存先写临时名，校验通过后再改名覆盖 —— 守住它的位置：putArchive —— 改错故障：进程被杀时留下半个归档并被当成有效缓存
// INV-09 断言：标记文件只在归档改名成功之后写入 —— 守住它的位置：putArchive 尾部 —— 改错故障：先写标记会让后续命中到尚未落盘的归档
// INV-10 断言：组装的目标目录不得等于当前基线发布目录 —— 守住它的位置：assemble 入口比较 —— 改错故障：就地改写正在被进程使用的发布目录，运行时读到半更新文件
// INV-11 断言：全部改动先落在带 incoming 后缀的暂存目录，校验通过才改名 —— 守住它的位置：assemble 全流程 —— 改错故障：中途失败会在发布目录留下混合内容
// INV-12 断言：失败路径必须删除暂存目录 —— 守住它的位置：assemble 的 catch —— 改错故障：残留暂存目录被后续扫描当成候选发布
// INV-13 断言：组件内容摘要必须在写 manifest 之前逐个核对 —— 守住它的位置：assemble 的组件循环 —— 改错故障：清单宣称内容与实际文件不符，后续启动校验永远失败
// INV-14 断言：同一路径被新组件接管时不得按旧组件删除 —— 守住它的位置：ownedByAnotherComponent 判断 —— 改错故障：迁移期间新组件文件被删空
// INV-15 断言：ZIP 一律走同进程解析，不走系统 tar —— 守住它的位置：extractArchiveSafely 的分支 —— 改错故障：Linux 上 tar 无法解 ZIP，Windows 归档安装必然失败
// INV-16 断言：tar 归档解压前必须拒绝硬链接、符号链接与越界成员 —— 守住它的位置：verbose 列目录检查与 validateArchiveEntries —— 改错故障：链接把发布目录之外的文件纳入组件内容
// INV-17 断言：解压出的文件权限固定为 0600、目录为 0700 —— 守住它的位置：写文件流的 mode 与创建目录的 mode —— 改错故障：多用户机器上其他账户可篡改已校验的组件
// INV-18 断言：命中判定中任何读取或解析异常都退化为未命中，不向上抛 —— 守住它的位置：findArchive 的 catch —— 改错故障：损坏缓存变成安装期致命错误，而不是触发重新下载
// INV-19 断言：写入校验失败必须删除临时归档再抛错 —— 守住它的位置：putArchive 的两个删除分支 —— 改错故障：残留未校验归档，占空间并可能被手工误用
// INV-20 断言：子进程只有退出码 0 才算成功，stderr 必须带进错误信息 —— 守住它的位置：run —— 改错故障：tar 失败被静默当成成功，解压出不完整目录
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import type { ServerRuntimeManifest } from "./manifest.js";
import { promoteImmutableReleaseDirectory } from "./immutableRelease.js";
import type { ServerLayout } from "./paths.js";

function assertComponentId(componentId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(componentId)) {
    throw new Error(`Invalid component id: ${componentId}`);
  }
}

function assertSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/iu.test(sha256)) throw new Error(`Invalid component SHA-256: ${sha256}`);
}

// [契约] 归档成员路径的唯一校验口：绝对路径（含 Windows 盘符与 UNC）直接拒绝，
// 不做归一化猜测，调用方拿到的一定是斜杠分隔的相对路径。
// [失败路径] 只把两个点的独立段判为越界；若改成「出现两个点就拒」会误杀 a..b 这类合法文件名。
// 新增调用方时复用本函数，不要另写一套正则，两套判断迟早不一致。
function safeRelativePath(pathValue: string): string {
  if (
    !pathValue ||
    pathValue.includes("\0") ||
    isAbsolute(pathValue) ||
    win32.isAbsolute(pathValue)
  ) {
    throw new Error(`Unsafe component path: ${pathValue}`);
  }
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".."))
    throw new Error(`Unsafe component path: ${pathValue}`);
  return normalized;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else if (entry.isSymbolicLink()) {
      // [契约] 目录遍历遇到符号链接立即失败，而不是跳过或跟随。
      // 跳过会让组件内容与清单声明不一致，跟随则可能把发布目录之外的文件算进摘要。
      // 只读普通文件与目录，其余类型同样视为不支持的组件内容。
      throw new Error(`Component contains unsupported symbolic link: ${relativePath}`);
    }
  }
  return files.sort();
}

// [契约] 组件摘要的规范定义：路径先排序，再按「相对路径 + NUL + 文件字节」逐个喂给 sha256，
// 目录会先展开成其中的文件列表。
// 排序与 NUL 分隔都是协议的一部分，改掉会让所有已发布组件的摘要失配。
// [失败路径] 这里不做任何容错，缺文件直接抛出，摘要不完整就不允许拿去比对。
async function hashPaths(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const rawPath of [...paths].sort()) {
    const relativePath = safeRelativePath(rawPath);
    const absolutePath = join(root, ...relativePath.split("/"));
    const pathStat = await stat(absolutePath);
    const files = pathStat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const normalizedFile = file.split(sep).join("/");
      // 路径必须转成斜杠分隔：Windows 上分隔符是反斜杠，直接拼进去会让同一份组件
      // 在 Windows 与 Linux 算出两个不同摘要，跨平台发布与恢复立刻全部失配。
      // NUL 分隔必须保留，否则 a 与 b 拼出的字节序列会与 ab 之类的命名发生歧义。
      hash.update(`${normalizedFile}\0`);
      hash.update(await readFile(join(root, ...normalizedFile.split("/"))));
    }
  }
  return hash.digest("hex");
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  captureOutput = false,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    // [失败路径] 只认退出码：非 0 时把 stderr 一起塞进错误，否则上层只能看到一条没有上下文的失败。
    // 被信号终止时退出码为 null，同样走失败分支，不允许当成成功返回。
    // stdout 与 stderr 都全量拼接：tar 的诊断通常跨多行，截断会丢掉真正原因。
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(captureOutput ? stdout : "");
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

// 对 tar 列目录的每一行做与 ZIP 相同的越界校验，防止「校验一套、解压另一套」的缺口。
// 先剥掉尾斜杠与点斜杠前缀再校验，剥完为空的行按当前目录处理并跳过。
// 这里只校验不清理，真正落盘仍由 tar 完成，所以必须覆盖全部成员而不能抽样。
function validateArchiveEntries(listing: string): void {
  for (const rawEntry of listing.split(/\r?\n/u)) {
    const entry = rawEntry.trim().replace(/\/$/u, "");
    if (!entry || entry === ".") continue;
    safeRelativePath(entry.replace(/^\.\//u, ""));
  }
}

function openZipFile(archivePath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    openZip(
      archivePath,
      { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error ? rejectPromise(error) : resolvePromise(zip)),
    );
  });
}

function openZipEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) =>
      error ? rejectPromise(error) : resolvePromise(stream),
    );
  });
}

// [契约] 用外部属性高 16 位的 Unix 模式判断链接类型，yauzl 不会替我们解析链接目标。
// Windows 打包的归档通常没有这个字段，读出来是 0，会自然判为普通文件。
// 真正的逃逸拦截仍由路径校验与目标目录约束完成，这里只做类型层面的第一道拒绝。
function isZipSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

// ZIP 走的独立解压路径：顺序读成员、边读边写，任一成员失败立即终止整次解压。
// [资源] 句柄只在 finally 关闭；不关会一直占着文件描述符，Windows 上还会锁住归档。
// [并发] 成员是惰性推送，必须显式请求下一个；漏掉一次会让整个解压永久挂起。
// 顺序处理是刻意选择：并行写同一目录无法可靠地做重复成员判定。
async function extractZipSafely(archivePath: string, destination: string): Promise<void> {
  const zip = await openZipFile(archivePath);
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      // [并发] 外层 Promise 只能结算一次：错误事件、结束事件与成员回调里的异常会互相竞争，
      // 这个标志是唯一的仲裁点，去掉后会出现二次结算或未捕获的拒绝。
      // 成员回调里的异常也走同一个拒绝通道，因此不需要再额外挂一次错误监听。
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const relativePath = safeRelativePath(entry.fileName).replace(/\/$/u, "");
          if (!relativePath) {
            zip.readEntry();
            return;
          }
          // [失败路径] 重复成员直接失败而不是覆盖：先写的文件已经落盘，覆盖会让最终内容
          // 与归档摘要对不上，却因为当天安装看起来正常而长期潜伏。
          // 记录的是剥掉尾斜杠后的路径，所以带斜杠与不带斜杠的同名成员也会被判为冲突。
          // 判重发生在写盘之前，失败时目录里最多只有前面成员写过的文件，由上层整目录丢弃。
          if (seen.has(relativePath))
            throw new Error(`Component archive contains duplicate entry: ${relativePath}`);
          seen.add(relativePath);
          if (isZipSymlink(entry))
            throw new Error(`Component archive contains a symbolic link: ${relativePath}`);
          const outputPath = join(destination, ...relativePath.split("/"));
          if (entry.fileName.endsWith("/")) {
            await mkdir(outputPath, { recursive: true });
          } else {
            await mkdir(dirname(outputPath), { recursive: true });
            const input = await openZipEntry(zip, entry);
            await pipeline(input, createWriteStream(outputPath, { mode: 0o600 }));
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    // [资源] 关闭放在 finally 里，保证成员抛错、写入中断、正常结束三条路都会释放句柄。
    // `autoClose: false` 把关闭时机交给显式 `close()`，不要改回自动关闭。
    // 提前在成员回调里关闭会让仍在写的文件流报坏句柄，Windows 上还会残留文件锁。
    // 正常结束与异常失败两条路径都汇到同一个 finally，不要在其中一条里单独关闭。
    zip.close();
  }
}

// 解压统一入口：按扩展名分流到同进程 ZIP 解析或系统 tar，两条路都保留越界与链接校验。
// [权衡] 扩展名决定解析器，不看文件头魔数，调用方必须传组件归档的真实后缀。
// [失败路径] tar 分支先列目录再解压，两步之间归档若被替换，列出的安全结论就不作数，
// 因此归档只能来自写入时已校验过的不可变缓存路径。
export async function extractArchiveSafely(
  archivePath: string,
  destination: string,
): Promise<void> {
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (isZip) {
    // macOS/Windows 自带 bsdtar 能读取 ZIP，GNU tar 不能；Linux 上用 tar 解 ZIP 会直接报错，
    // 单测与 Linux 控制端安装 Windows 归档因此稳定失败。ZIP 改走同进程解析并保留路径/链接校验。
    await extractZipSafely(archivePath, destination);
    return;
  }
  const listing = await run("tar", ["-tzf", archivePath], destination, true);
  const verboseListing = await run("tar", ["-tvzf", archivePath], destination, true);
  // [失败路径] 用详细列目录的权限位首字符识别硬链接与符号链接，普通列表不显示类型。
  // 只看首字符即可：普通文件是短横，目录是 d，链接才会是 l 或 h。
  // 这一检查必须在真正解压前完成，解压后再检查，链接指向的内容已经被写入。
  if (verboseListing.split(/\r?\n/u).some((line) => /^[lh]/u.test(line))) {
    throw new Error(`Component archive contains a symbolic or hard link: ${archivePath}`);
  }
  validateArchiveEntries(listing);
  await run("tar", ["-xzf", archivePath, "-C", destination], destination);
}

// 缓存层的唯一入口：路径规约、命中判定、原子写入、发布目录组装四件事都集中在这里。
// [契约] 实例只持有布局对象，不缓存任何运行期状态，可以按需重复构造。
// 所有写入都以临时名加改名收尾，任意一步中断都只会留下可识别、可清理的残留物。
// 调用方不得绕过本类直接读写组件缓存目录，否则标记文件与归档会不同步。
export class ComponentCache {
  public constructor(private readonly layout: ServerLayout) {}

  public path(target: string, componentId: string, sha256: string): string {
    assertComponentId(componentId);
    assertSha256(sha256);
    if (!/^(?:darwin|linux|win32)-(?:x64|arm64)$/u.test(target))
      throw new Error(`Invalid component target: ${target}`);
    return join(this.layout.componentsCacheDir, target, componentId, sha256.toLowerCase());
  }

  // 命中判定比「文件存在」严格得多：标记字段、归档可读性与归档摘要三者都要对得上。
  // [失败路径] 任何读取或解析异常都退化为未命中，让下载器重新取一份，而不是把坏缓存抛给安装流程。
  // 命中时要重算整份归档摘要，代价是一次全量读盘，换来的是不会把被改写的归档交给解压。
  public async findArchive(options: {
    target: string;
    componentId: string;
    sha256: string;
    extension?: "zip" | "tar.gz";
  }): Promise<string | null> {
    const targetDir = this.path(options.target, options.componentId, options.sha256);
    const candidates = options.extension
      ? [join(targetDir, options.extension === "zip" ? "component.zip" : "component.tar.gz")]
      : [join(targetDir, "component.tar.gz"), join(targetDir, "component.zip")];
    for (const candidate of candidates) {
      // 标记文件与归档同目录，因此「找归档」等于「找目录里的组件标记」。
      // [权衡] 只探测两种固定文件名，不做目录枚举，枚举会把残留的临时文件也当成候选。
      // 未指定扩展名时优先 tar.gz，是历史上先支持 tar 的兼容顺序，调整会改变命中统计口径。
      // 单个候选失败只影响它自己，循环会继续尝试下一个后缀，两个都失败才返回未命中。
      const markerPath = join(dirname(candidate), "component.json");
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
          archiveSha256?: string;
          componentId?: string;
          sha256?: string;
        };
        // 旧缓存只记录 component sha，无法判断归档内容是否被截断、覆盖或与该 sha
        // 不匹配；直接复用会在 assemble 失败后永久命中坏缓存。缺少归档 hash 的旧条目
        // 统一视为 miss，下一次下载会原子替换成可验证的新条目。
        if (
          marker.componentId !== options.componentId ||
          marker.sha256?.toLowerCase() !== options.sha256.toLowerCase() ||
          !marker.archiveSha256 ||
          !/^[a-f0-9]{64}$/iu.test(marker.archiveSha256)
        )
          continue;
        await stat(candidate);
        const archiveSha256 = createHash("sha256")
          .update(await readFile(candidate))
          .digest("hex");
        if (archiveSha256 !== marker.archiveSha256.toLowerCase()) continue;
        return candidate;
      } catch {
        // 半成品 cache entry is ignored and will be replaced by the downloader.
      }
    }
    return null;
  }

  // 写缓存是三步式：先拷贝到临时名、再校验、最后改名，中途失败都不污染已有缓存。
  // [事务] 临时名带进程号与时间戳，多进程同时下载同一组件不会互相覆盖临时文件。
  // [失败路径] 摘要不合法或与内容不符时先删临时文件再抛错，不留未校验产物。
  // 目录权限刻意收紧，校验通过的归档不允许被其他账户改写。
  public async putArchive(options: {
    target: string;
    componentId: string;
    sha256: string;
    archivePath: string;
    archiveSha256: string;
  }): Promise<string> {
    const targetDir = this.path(options.target, options.componentId, options.sha256);
    const destination = join(
      targetDir,
      options.archivePath.toLowerCase().endsWith(".zip") ? "component.zip" : "component.tar.gz",
    );
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const temporaryArchive = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await cp(options.archivePath, temporaryArchive);
    if (!/^[a-f0-9]{64}$/iu.test(options.archiveSha256)) {
      await rm(temporaryArchive, { force: true });
      throw new Error(`Invalid component archive SHA-256: ${options.archiveSha256}`);
    }
    const digest = createHash("sha256")
      .update(await readFile(temporaryArchive))
      .digest("hex");
    if (digest.toLowerCase() !== options.archiveSha256.toLowerCase()) {
      await rm(temporaryArchive, { force: true });
      throw new Error(
        `Component archive checksum mismatch: expected ${options.archiveSha256}, received ${digest}`,
      );
    }
    // [事务] 改名是这里唯一的原子点：之前可见的是旧归档，之后可见的是新归档。
    // 标记必须在这之后写，反过来写会让命中判定拿到一个尚未落盘的归档。
    // 临时文件与目标同目录，改名不会跨挂载点，因此不会退化成本地拷贝。
    await rename(temporaryArchive, destination);
    const markerTemporary = join(targetDir, `component.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(
      markerTemporary,
      `${JSON.stringify({ archiveSha256: options.archiveSha256.toLowerCase(), componentId: options.componentId, sha256: options.sha256 }, null, 2)}\n`,
      "utf8",
    );
    await rename(markerTemporary, join(targetDir, "component.json"));
    return destination;
  }

  // 组装发布目录：以基线发布为底、按变更组件删掉旧文件、解压新归档、核对全部组件摘要、写清单。
  // [事务] 全过程在带 incoming 后缀的暂存目录进行，只有改名成功那一刻才对外可见。
  // [失败路径] 任何一步抛错都会删掉暂存目录，不会出现一半新一半旧的发布目录。
  // 基线目录本身永远不被改写，这是让已运行进程继续读旧文件的前提。
  public async assemble(options: {
    target: string;
    archiveSha256: string;
    baseReleaseDir: string;
    releaseDir: string;
    runtimeManifest: ServerRuntimeManifest;
    baseComponents?: ServerRuntimeManifest["components"];
    changed: Array<{ componentId: string; sha256: string; archivePath: string }>;
  }): Promise<void> {
    const targetReleaseDir = resolve(options.releaseDir);
    if (targetReleaseDir === resolve(options.baseReleaseDir))
      throw new Error("Component assembly cannot replace the active release");
    const temporaryReleaseDir = `${targetReleaseDir}.incoming-${process.pid}-${randomUUID()}`;
    try {
      await cp(options.baseReleaseDir, temporaryReleaseDir, { recursive: true, dereference: true });
      const nextComponents = options.runtimeManifest.components ?? [];
      const changedIds = new Set(options.changed.map((component) => component.componentId));
      for (const previousComponent of options.baseComponents ?? []) {
        const nextComponent = nextComponents.find(
          (component) => component.id === previousComponent.id,
        );
        const pathsUnchanged = nextComponent
          ? previousComponent.paths.length === nextComponent.paths.length &&
            previousComponent.paths.every((path, index) => path === nextComponent.paths[index])
          : false;
        if (nextComponent && pathsUnchanged && !changedIds.has(previousComponent.id)) continue;
        for (const rawPath of previousComponent.paths) {
          const relativePath = safeRelativePath(rawPath);
          // 组件路径若已转移给新组件，保留它并交给新组件归档覆盖；正常 staging 中
          // 组件路径不重叠，但这个判断避免迁移期间误删另一组件的文件。
          const ownedByAnotherComponent = nextComponents.some(
            (component) =>
              component.id !== previousComponent.id && component.paths.includes(relativePath),
          );
          if (!ownedByAnotherComponent)
            await rm(join(temporaryReleaseDir, ...relativePath.split("/")), {
              recursive: true,
              force: true,
            });
        }
      }
      for (const component of options.changed) {
        assertComponentId(component.componentId);
        assertSha256(component.sha256);
        await extractArchiveSafely(component.archivePath, temporaryReleaseDir);
      }
      for (const component of options.runtimeManifest.components ?? []) {
        const actual = await hashPaths(temporaryReleaseDir, component.paths);
        if (actual.toLowerCase() !== component.sha256.toLowerCase()) {
          throw new Error(
            `Component content checksum mismatch: ${component.id}; expected ${component.sha256}, received ${actual}`,
          );
        }
      }
      await writeFile(
        join(temporaryReleaseDir, "manifest.json"),
        `${JSON.stringify(options.runtimeManifest, null, 2)}\n`,
        "utf8",
      );
      await mkdir(dirname(targetReleaseDir), { recursive: true, mode: 0o700 });
      // [事务] 归档摘要、目标平台与版本共同参与幂等判定：目标已存在且身份一致时直接复用。
      // 复用与失败都不会消费暂存目录，由提升流程内部统一清理，所以外层的删除只是幂等兜底。
      // 目标已存在但身份不一致会抛错而不是覆盖，冲突必须由上层换一个新的版本目录解决。
      await promoteImmutableReleaseDirectory({
        incomingDir: temporaryReleaseDir,
        targetDir: targetReleaseDir,
        identity: {
          archiveSha256: options.archiveSha256,
          target: options.runtimeManifest.target,
          version: options.runtimeManifest.appVersion,
        },
      });
    } catch (error) {
      await rm(temporaryReleaseDir, { recursive: true, force: true });
      throw error;
    }
  }
}
