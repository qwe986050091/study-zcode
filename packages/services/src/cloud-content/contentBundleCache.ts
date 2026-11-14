// 云端内容包（zip）本地缓存：下载 → 解包到 staging → 原子 rename 为内容寻址目录 → 租约式读取。
// INV-01：缓存目录名恒为 bundle.sha256 且内容与该摘要一一对应；守住位置：acquire 写入口与
// cached/evict 的目录名过滤；破坏后会把 A 包字节当成 B 包返回，且本地校验发现不了。
// INV-02：对外可见的目录只可能是完整写入态（先写 staging 再 rename）；守住位置：acquire 的
// try/finally；破坏后 read 会看到缺 .bundle.json 或半截文件的目录，表现为随机 bundle_cache_size。
// INV-03：交付给调用方的字节必须复核 sha256（下载、读取各一次）；守住位置：download 的
// bundle_integrity 与 checkedRead 的 bundle_cache_integrity；破坏后可返回被本地篡改的内容。
// INV-04：acquire/read/release/clear 全串行，leases 增删与 evict 跳过判断同处临界区（exclusive）。
// INV-05：解包路径拒绝绝对路径/反斜杠/驱动器号/.. /NTFS 设备名/尾随点空格，并大小写不敏感去重。
// INV-06：解压体积受 ZIP_LIMIT/EXPANDED_LIMIT 双重约束；破坏后可被 zip 炸弹写满磁盘。
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as yauzl from "yauzl";

// 契约由 acquire 复核（sha256 形状、sizeBytes 上下界），不能只当类型提示：这些字段来自云端 payload，
// 任何一项被放宽都会让 ZIP_LIMIT/EXPANDED_LIMIT 失去意义。
export interface ContentBundle {
  format: "zip";
  url: string;
  entry: string;
  sha256: string;
  sizeBytes?: number;
}

// 上限分四层是因为攻击面不同：单文件、解压总量、磁盘占用各管一件事，只留一个总量无法同时覆盖。
// 单个 8MB 的 HTML 完全合法，但 128 个 8MB 的关注点是「一个包撑满磁盘」，与「一次读取撑爆内存」不同。
// [权衡] CACHE_LIMIT 只在 evict 时生效，不阻止超限包写入：拒绝写入会让大包永远无法使用，
// 而淘汰发生在 acquire/release 之后，短时间内磁盘可能短暂超过上限。
const ZIP_LIMIT = 8 * 1024 * 1024;
const EXPANDED_LIMIT = 32 * 1024 * 1024;
const CACHE_LIMIT = 128 * 1024 * 1024;
const MANIFEST = ".bundle.json";
type Manifest = { files: Record<string, { sha256: string; size: number }>; size: number };
// 摘要字符串同时充当目录名、缓存键与完整性断言，三处必须共用同一算法与编码（小写 hex），
// 否则 cached() 会永远 miss，或 evict 的 64 位 hex 正则匹配不到而漏删。
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// 这是解包与读取共用的唯一路径准入点：写侧不校验会越出 staging，读侧不校验会顺着软链接读宿主文件。
// 返回原串而不是规范化结果，是为了让「校验通过的字符串」与「join 时使用的字符串」完全一致。
export function validateContentBundlePath(path: string): string {
  if (
    !path ||
    path.length > 240 ||
    path === MANIFEST ||
    /[\\:]/u.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error("bundle_path");
  for (const part of path.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/u.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
      throw new Error("bundle_path");
  }
// 逐段校验而非整体正则：Windows 上 a\\..\\b 这类写法在拼路径前就被拒绝，不依赖 join 的等价化，
// 也不依赖解压库对尾随空格的处理（该行为在不同平台并不一致）。
  return path;
}

// 解包是唯一把外部字节落盘的路径，因此把「元数据校验 → 路径校验 → 体积校验 → 写入」固定成同一顺序：
// 先校验后写盘让恶意条目在产生任何文件之前失败；若写一半再校验失败，staging 里会留下脏文件，
// 只能依赖 acquire 的 finally 清理，而清理本身失败就会留下可被下次 rename 采用的残留。
async function extract(bytes: Buffer, directory: string): Promise<Manifest> {
// strictFileNames 让 yauzl 拒绝以 / 开头或含 . 段的条目，但不同版本对该检查的严格度会变，
// 因此下面仍对每个 entry 调用 validateContentBundlePath 做二次校验（纵深防御，[权衡] 略慢）。
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) => (error ? reject(error) : resolve(value!)),
    );
  });
// files 用 Object.create(null) 而非普通对象字面量：条目名来自不可信 zip，若取名 __proto__ 或
// constructor，会在普通对象上改写原型或命中继承属性，让下标访问读到非文件信息。
  const manifest: Manifest = { files: Object.create(null), size: 0 };
  const names = new Set<string>();
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
// 先挂 error 再 readEntry：yauzl 的解析错误是异步 emit 的，若在首个 entry 之后才挂监听，
// 错误会变成未捕获异常而不是本函数的 reject；end 只表示条目遍历结束，不代表内容完整。
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
// 条目数在自增的同时判断，保证第 129 个条目在打开流之前就失败；generalPurposeBitFlag 的最低位
// 是加密标志，加密条目无法流式校验内容，直接拒绝而不是尝试解密（解压库不提供密钥）。
          if (++count > 128 || entry.generalPurposeBitFlag & 1)
            throw new Error("bundle_entry_limit");
          const isDirectory = entry.fileName.endsWith("/");
          const name = validateContentBundlePath(
            isDirectory ? entry.fileName.slice(0, -1) : entry.fileName,
          );
// 缓存目录可能落在大小写不敏感的文件系统（APFS/NTFS）：仅按原串去重会让 A.html 与 a.html
// 落到同一 inode，后者静默覆盖前者，而 manifest 里仍记着两份互不相同的摘要。
          const canonical = name.toLowerCase();
// 保留名 .bundle.json 单独拒绝，因为它同时是缓存自描述文件：允许包内出现即可伪造 manifest，
// 让 cached() 信任一份与磁盘内容不符的 size/sha256 表。
          if (names.has(canonical) || canonical === MANIFEST)
            throw new Error("bundle_duplicate_path");
          names.add(canonical);
// externalFileAttributes 高 16 位是 Unix mode；只接受普通文件与目录，显式拒绝符号链接与设备文件，
// 避免解包后 lstat 检查被绕过，或 readFile 卡在 /dev/zero 这类无限流上。
          const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (fileType && fileType !== (isDirectory ? 0o040000 : 0o100000))
            throw new Error("bundle_file_type");
          if (
// 先用声明值做一次总量预检，避免在解压流上白跑一遍才发现超限；声明值不可信，
// 所以下面的流式累计还要再校验一次，两处缺一都可能被伪造的 uncompressedSize 绕过。
            entry.uncompressedSize > ZIP_LIMIT ||
            manifest.size + entry.uncompressedSize > EXPANDED_LIMIT
          )
            throw new Error("bundle_expanded_size");
// 目录条目只建目录、不记入 manifest：manifest 只描述可读文件，目录体积由文件累加，避免重复计数。
          if (isDirectory) {
            await mkdir(join(directory, name), { recursive: true });
          } else {
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zip.openReadStream(entry, (error, value) => (error ? rej(error) : res(value!))),
            );
            const chunks: Buffer[] = [];
            let size = 0;
// 一边读一边累计体积，而不是先 concat 再判断：concat 需要先分配全部内容，
// 恶意条目在被判定超限之前就会占用 ZIP_LIMIT 以上的内存。
            for await (const chunk of stream) {
              const buffer = Buffer.from(chunk);
              size += buffer.length;
              if (size > ZIP_LIMIT || manifest.size + size > EXPANDED_LIMIT)
                throw new Error("bundle_expanded_size");
              chunks.push(buffer);
            }
// 到这一步 size 已确认不超过 ZIP_LIMIT，concat 的内存上界才有保证。
            const content = Buffer.concat(chunks);
            const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
            await mkdir(join(directory, parent), { recursive: true });
// flag wx 是最后一道防覆盖：names 已去重，但大小写不敏感文件系统上仍可能撞名，
// 这里宁可抛 EEXIST 让整包失败，也不静默覆盖已写入的条目；mode 0o600 防止包内容被他人读取。
            await writeFile(join(directory, name), content, { flag: "wx", mode: 0o600 });
            manifest.files[name] = { sha256: hash(content), size };
            manifest.size += size;
          }
          zip.readEntry();
// 每个 entry 的异步处理都必须落回外层 reject，否则异常会悬空，外层 Promise 永不结束。
        })().catch(reject);
      });
      zip.readEntry();
    });
    return manifest;
  } finally {
// 外层 finally 保证 close 一定执行：正常 end 与任意 reject 走同一条释放路径。
// [资源] close 释放 yauzl 持有的 fd 与缓冲区；此处已在 Promise settled 之后调用，
// 不会与仍在读取的 entry 流竞争（流要么已结束，要么已被 reject 中断）。
    zip.close();
  }
}

/** 仅供宿主装配：可信源和缓存根不从云端 payload 派生；cacheRoot 必须由单个宿主独占。 */
export function createContentBundleCache(options: {
  cacheRoot: string;
  isTrustedUrl: (url: URL) => boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
// leases 是「正在被宿主使用」的目录白名单，evict 靠它跳过在租目录；它只存 digest 与 manifest，
// 不持有文件句柄，所以 release 之后目录可能被立刻删除，调用方不能假设 read 一定成功。
// 值里的 manifest 是 acquire 时校验过的快照，read 用它比对 sha256/size（见 INV-03）。
  const leases = new Map<string, { digest: string; manifest: Manifest }>();
// 用一条 Promise 链串行化全部公开操作：缓存目录的读写删与 leases 的增删都必须互斥，
// 否则 clear() 可能在 acquire 的 rename 与 leases.set 之间删掉目录，租约指向不存在的路径。
  let pending: Promise<unknown> = Promise.resolve();
// [并发] 用队列而不是 Mutex：调用方是单进程内的多个 async 任务，Promise 链即可保证顺序，
// 且不引入额外依赖。临界区内禁止 await 用户回调或写日志，任何长耗时都会串行放大延迟。
// pending 只保留最后一个结果的 catch 分支：前一个任务失败不能阻塞后续任务，
// 也不能吞掉当前任务的错误，所以 catch 只挂在链上，返回值仍是原始 result。
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
// 先挂 catch 再返回原始 result：若返回 catch 的结果，调用方会拿到 undefined 而不是真实异常，
// 失败路径退化成「成功但无值」，bundle_* 错误码会被彻底掩盖。
    const result = pending.then(run);
    pending = result.catch(() => {});
    return result;
  }
// 只允许 http/https 且无 userinfo：userinfo 会被拼进请求行与日志，也是 SSRF 绕过的常见载体。
  function trustedUrl(value: string): URL {
    const url = new URL(value);
    if (
      !/^https?:$/u.test(url.protocol) ||
      url.username ||
      url.password ||
      !options.isTrustedUrl(url)
    )
      throw new Error("bundle_source");
    return url;
  }
// 重定向手动跟随并逐跳复验：自动跟随会把请求带到未通过 isTrustedUrl 的主机，
// 而 307/308 还会保留 body 与凭据；每跳都重新过 trustedUrl 才等价于「目标主机白名单」。
  async function download(bundle: ContentBundle): Promise<Buffer> {
    let url = trustedUrl(bundle.url);
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
// 最多 4 次请求（0..3）：上限同时限制重定向环与逐跳校验成本；
// 若改成无上限循环，任何一层 throw 都会绕过末尾的 bundle_redirect_limit 语义。
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        redirect: "manual",
        signal,
        credentials: "omit",
      });
// [失败路径] 重定向响应必须显式 cancel body，否则连接不归还连接池，连续重定向会耗尽 socket。
// 只认这 5 个状态码而不是所有 3xx：300/304 没有语义上的 Location，跟随它们会把缓存命中当成跳转。
// location 用 new URL(location, url) 解析，相对地址沿用当前跳的 base，避免跳转链解析错主机。
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("bundle_redirect");
        url = trustedUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("bundle_download");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > ZIP_LIMIT || (bundle.sizeBytes !== undefined && size > bundle.sizeBytes))
          throw new Error("bundle_download_size");
        chunks.push(Buffer.from(chunk));
      }
// 长度不符单独判一次：下载流可能被截断但 HTTP 层未报错（chunked 连接提前关闭），
// 这种短读不会被 hash 校验解释清楚，只会得到难排查的 bundle_integrity。
      if (bundle.sizeBytes !== undefined && size !== bundle.sizeBytes)
        throw new Error("bundle_download_size");
      const bytes = Buffer.concat(chunks);
// 摘要在读完后统一算，而不是边读边 update：边读边算结束后仍要比对，
// 统一算能让「超限提前失败」与「摘要失败」两条路径的报错不互相遮蔽。
      if (hash(bytes) !== bundle.sha256) throw new Error("bundle_integrity");
      return bytes;
    }
    throw new Error("bundle_redirect_limit");
  }
// 读路径不复用 extract 的目录假设：缓存目录可能被其他进程或用户改动，因此每次 read 都重新校验
// 每一段路径类型（拒绝软链接）、文件大小与摘要。这是「缓存不可信」的落地，代价是每次读多一次
// stat 与一次全量 hash；对不超过 8MB 的 HTML 可接受，放宽会在热路径上产生可感知延迟（[权衡]）。
  async function checkedRead(
    directory: string,
    name: string,
    info: { sha256: string; size: number },
  ): Promise<Buffer> {
    validateContentBundlePath(name);
    let current = directory;
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink())
      throw new Error("bundle_cache_type");
    for (const part of name.split("/")) {
      current = join(current, part);
// 逐段 lstat 而不是 realpath：realpath 只给最终目标，中间段被替换成软链接时无法判断，
// 会让 cacheRoot 之外的任意文件被当作包内容读出（TOCTOU 窗口仍存在，但大小与摘要会再拦一次）。
      if ((await lstat(current)).isSymbolicLink()) throw new Error("bundle_cache_symlink");
    }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.size !== info.size || stat.size > ZIP_LIMIT)
      throw new Error("bundle_cache_size");
    const content = await readFile(current);
// 大小与摘要都必须匹配 manifest，任一不符即视为缓存被篡改或损坏，直接拒绝返回。
    if (hash(content) !== info.sha256) throw new Error("bundle_cache_integrity");
    return content;
  }
// cached 是「缓存命中」的唯一判定：manifest 结构、条目数、每个文件的 size/sha256 全部复验通过才返回。
// 任何一项失败都返回 undefined（等价于未命中）而不是抛错——损坏缓存对调用方不应变成新的错误码。
// 这里不修复也不删除，删除只发生在 acquire 的 rename 前 rm 与 evict，避免读路径写盘。
  async function cached(digest: string): Promise<Manifest | undefined> {
    const directory = join(options.cacheRoot, digest);
    try {
      const stat = await lstat(join(directory, MANIFEST));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
      const manifest: Manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
      if (
        !manifest.files ||
        !Number.isSafeInteger(manifest.size) ||
        manifest.size < 0 ||
        manifest.size > EXPANDED_LIMIT
      )
        return undefined;
      const entries = Object.entries(manifest.files);
      if (entries.length > 128) return undefined;
      let size = 0;
      for (const [name, info] of entries) {
        await checkedRead(directory, name, info);
        size += info.size;
      }
      return size === manifest.size ? manifest : undefined;
    } catch {
      return undefined;
    }
  }
  async function evict(clear: boolean) {
// [资源] 淘汰以目录 mtime 近似 LRU：acquire 成功后会 utimes 刷新，正在使用的目录不会被优先选中。
// 只统计名字匹配 64 位 hex 的目录，staging 与临时目录永不参与，避免删掉正在写入的包。
// readdir 失败退化为空数组：缓存根被并发删除时应让淘汰静默跳过，而不是让 acquire 因清理失败而失败。
    const names = await readdir(options.cacheRoot).catch(() => []);
    const entries = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}$/u.test(name))
        .map(async (name) => {
          const directory = join(options.cacheRoot, name);
          const stat = await lstat(directory);
// 拿不到 manifest 时按 EXPANDED_LIMIT 估算体积：宁可高估让淘汰更激进，也不要低估导致磁盘打满。
          const manifest = await cached(name);
          return { name, directory, time: stat.mtimeMs, size: manifest?.size ?? EXPANDED_LIMIT };
        }),
    );
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
// 按 mtime 升序删到达标为止；clear 模式忽略 CACHE_LIMIT，所以循环条件里必须让 clear 短路。
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (!clear && total <= CACHE_LIMIT) break;
// 在租目录一律跳过，即使它最旧：删掉会让已返回的 leaseId 在 read 时变成 bundle_resource_missing，
// 且宿主可能正持有其中文件的描述符（Unix 可删，Windows 上 rm 会失败并中断整轮淘汰）。
      if ([...leases.values()].some((lease) => lease.digest === entry.name)) continue;
      await rm(entry.directory, { recursive: true, force: true });
      total -= entry.size;
    }
  }
  return {
// 契约校验先于任何 IO：非法 sha256/sizeBytes 不能进缓存目录，避免用坏键建目录。
    acquire(bundle: ContentBundle) {
      return exclusive(async () => {
        if (
          bundle.format !== "zip" ||
          !/^[a-f0-9]{64}$/u.test(bundle.sha256) ||
          (bundle.sizeBytes !== undefined &&
            (!Number.isSafeInteger(bundle.sizeBytes) ||
              bundle.sizeBytes <= 0 ||
              bundle.sizeBytes > ZIP_LIMIT))
        )
          throw new Error("bundle_contract");
        validateContentBundlePath(bundle.entry);
        if (!bundle.entry.endsWith(".html")) throw new Error("bundle_entry");
        trustedUrl(bundle.url);
        const stagingRoot = join(options.cacheRoot, "staging");
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        let manifest = await cached(bundle.sha256);
        const cacheHit = Boolean(manifest);
// 未命中才下载；已命中仍要查 lease 冲突：命中却有人在租说明同一摘要正被使用，
// 此时缓存却被判定损坏属于宿主侧状态异常，继续下载并在 rename 前 rm 会删掉在租目录（INV-01/04）。
        if (!manifest) {
          if ([...leases.values()].some((lease) => lease.digest === bundle.sha256))
            throw new Error("bundle_active_cache_corrupt");
          const bytes = await download(bundle);
// 每个包独立 staging 目录（mkdtemp 保证唯一），rename 才是原子的；复用固定目录会让并发包互相污染。
          const staging = await mkdtemp(join(stagingRoot, "bundle-"));
          try {
            manifest = await extract(bytes, staging);
            if (!Object.hasOwn(manifest.files, bundle.entry))
              throw new Error("bundle_entry_missing");
            await writeFile(join(staging, MANIFEST), JSON.stringify(manifest), {
              flag: "wx",
              mode: 0o600,
            });
            const destination = join(options.cacheRoot, bundle.sha256);
            await rm(destination, { recursive: true, force: true });
// [事务] 只有 rename 成功后目标目录才对读者可见；此前已清掉旧目录，崩溃落在 rm 与 rename 之间
            await rename(staging, destination);
          } finally {
// [资源] finally 兜底清理：extract 抛错、入口缺失、manifest 写入失败都走到这里；残留 staging 虽不会被
// cached 采纳（目录名非 64 位 hex），但会永久占盘直到 clear，因此不能省略这一步。
            await rm(staging, { recursive: true, force: true });
          }
        }
        if (!Object.hasOwn(manifest.files, bundle.entry)) throw new Error("bundle_entry_missing");
        const now = new Date();
        await utimes(join(options.cacheRoot, bundle.sha256), now, now);
        const leaseId = randomUUID();
// 先登记租约再淘汰：evict 依据 leases 跳过在租目录，顺序反过来会让刚 acquire 的目录被本轮选中。
        leases.set(leaseId, { digest: bundle.sha256, manifest });
        await evict(false);
        return { leaseId, sha256: bundle.sha256, entry: bundle.entry, cacheHit };
      });
    },
    read(leaseId: string, path: string) {
      return exclusive(async () => {
        const lease = leases.get(leaseId);
        if (!lease) throw new Error("bundle_lease");
        validateContentBundlePath(path);
        const info = Object.hasOwn(lease.manifest.files, path)
          ? lease.manifest.files[path]
          : undefined;
        if (!info) throw new Error("bundle_resource_missing");
        return checkedRead(join(options.cacheRoot, lease.digest), path, info);
      });
    },
    release(leaseId: string) {
      return exclusive(async () => {
        leases.delete(leaseId);
        await evict(false);
      });
    },
    clear() {
      return exclusive(() => evict(true));
    },
  };
}
