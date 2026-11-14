/* eslint-disable max-lines */
// 安全说明：Cookie 快照、跨平台解密选择与整批写入必须留在同一事务审计边界，
// 避免拆分后让 Windows App-Bound 原子失败语义与 Linux helper 回退顺序发生漂移。
// ═══ chromeCookieManager：Chrome Cookie 导入的唯一装配点 ═══
// 职责：定位 profile 下的 Cookies 库（Network/Cookies 优先，回退 profile 根），在临时目录
// 生成一致性快照，按平台选择解密器还原明文，再整批写入调用方提供的 session。
// 边界：不发现 Chrome 安装路径、不管理 profile 生命周期、不合并同名 Cookie、不重试写失败。
// 存储键：schema 版本读自 meta 表 key='version'；v24+ 的明文前置 32 字节 SHA-256(host_key)。
// 加密前缀：v10 / v11（AES-128-CBC 或 Windows 旧 GCM）、v20（Windows App-Bound GCM）。
// 并发：解密全程串行；写入按 COOKIE_IMPORT_CONCURRENCY=32 分批，批内 allSettled、批间串行。
//
// INV 表（改代码前先定位受影响断言；破坏任一条即视为回归）
// INV-01 断言：数据库路径只在 Network/Cookies、Cookies 两个候选中选取 —— 守住它的位置：resolveChromeCookieDatabasePath —— 改错故障：新版 Chrome 漏读或读到旧 profile 的历史登录态。
// INV-02 断言：所有读取都在临时快照上，绝不直接 SELECT 源库 —— 守住它的位置：withDatabaseSnapshot 内的 readChromeCookies —— 改错故障：Chrome 运行时读到撕裂数据，导入随机缺行。
// INV-03 断言：只有在线备份失败才回退文件拷贝，且最多 DATABASE_SNAPSHOT_COPY_ATTEMPTS=3 次 —— 守住它的位置：withDatabaseSnapshot 的 catch 与 attempt 循环 —— 改错故障：无限重试或吞错，导入静默返回 0 行。
// INV-04 断言：临时目录无论成败都在 finally 内 rm —— 守住它的位置：withDatabaseSnapshot 的 finally —— 改错故障：明文 Cookie 快照残留 tmpdir。
// INV-05 断言：仅 schemaVersion >= 24 且长度 >= 32 才剥离宿主摘要 —— 守住它的位置：stripChromeHostDigest —— 改错故障：旧库值被截断，或新库值前混入二进制摘要。
// INV-06 断言：CBC 只接受 v10、App-Bound 只接受 v20 —— 守住它的位置：两个解密器内的前缀校验 —— 改错故障：用错算法解出乱码却当成功值写入。
// INV-07 断言：密钥对象必须在 finally 内 dispose 并清零 —— 守住它的位置：CookieDecryptorResource.dispose 与 collectCookieDetails 的 finally —— 改错故障：主密钥驻留内存至进程结束。
// INV-08 断言：Windows v20 必须同时具备 App-Bound 密钥与提权授权 —— 守住它的位置：containsAppBoundCookie 分支 —— 改错故障：静默降级或旧 key 硬解 v20。
// INV-09 断言：本批出现 v20 但密钥不可用时整批 skipped，一条不写 —— 守住它的位置：if (!appBoundDecryptor) 的原子返回 —— 改错故障：半批导入，登录态新旧混杂。
// INV-10 断言：单条解密失败或值为空只计 skipped，不中断整批 —— 守住它的位置：逐行循环的内层 catch —— 改错故障：一条坏 Cookie 让整次导入失败。
// INV-11 断言：Chrome 未运行或 helper 不可用时不拉起浏览器，只降级或登记 issue —— 守住它的位置：linux v11 helper 分支与 chrome_executable_not_found —— 改错故障：为读 Cookie 启动 Chrome 进程。
// INV-12 断言：Linux v11 只走同品牌 helper，绝不用 peanuts 硬解密钥环保护的 Cookie —— 守住它的位置：linux-keyring-v11 分支 —— 改错故障：受保护 Cookie 被解成乱码写入。
// INV-13 断言：domain / path / secure / httponly / samesite 由 chromeCookieMapping 决定，本文件不改写 —— 守住它的位置：toCookieDetails 与 toCookieDetailsFromHelper 调用点 —— 改错故障：域或路径漂移，Cookie 落到错误域。
// INV-14 断言：写入只按 allSettled 结果计数，且结束前必须 flushStore —— 守住它的位置：分批写入与 flushStore 调用 —— 改错故障：进程退出前未落盘，导入成功但重启即丢。
// INV-15 断言：databaseFound=false 时返回空结果而非抛错 —— 守住它的位置：importChromeCookies 首段 —— 改错故障：无 Chrome 环境下整条浏览器数据导入被中断。
// INV-16 断言：日志只含计数与错误名，不含 Cookie 值、host 明文与密钥 —— 守住它的位置：toSafeBrowserDataError 与全部 logger 调用 —— 改错故障：隐私与凭据写入日志文件。
//
// 读法：正文块以 [契约]/[并发]/[事务]/[资源]/[失败路径]/[权衡] 打标，标签后第一句即断言。
// 术语：快照 = 临时目录内的 database.sqlite；helper = Chrome 可执行文件代理读取；
// App-Bound = Windows Chrome v20 由系统提权服务保护的加密格式。
// 安全：本文件不得记录或返回 Cookie 明文、host 明文与密钥，日志只允许计数与错误名。
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ChromeBrowserDataImportError } from "@zcode/shared";
import { readChromeCookiesWithHelper } from "./chromeLocalStorageManager.js";
import {
  toCookieDetails,
  toCookieDetailsFromHelper,
  type ChromeCookieRow,
} from "./chromeCookieMapping.js";
import {
  ChromeCookieAccessDeniedError,
  readMacChromeSafeStorageSecret,
  readWindowsChromeMasterKey,
  type MacChromeSafeStorageSecretReader,
} from "./chromeCredentialManager.js";
// [契约] 依赖方向：解密材料、App-Bound 密钥、Linux helper 都由同目录模块提供，
// 本文件只负责编排，不能直接访问 keychain、注册表或拉起子进程。
// [权衡] 解密器 / helper / backup 全部参数注入，测试可替换且不触碰真实 Chrome。
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";
import {
  readWindowsChromeAppBoundKey,
  WindowsChromeAppBoundImportError,
  type WindowsChromeAppBoundKeyReader,
} from "./windowsChromeAppBoundKey.js";

const nodeRequire = createRequire(import.meta.url);
// tsup/esbuild 会把动态 import("node:sqlite") 错误改写为 import("sqlite")，
// Electron 运行时因此报 ERR_MODULE_NOT_FOUND。createRequire 能稳定保留 node: 协议。
const { DatabaseSync, backup } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// [权衡] 32 是写入批大小：更大时主进程 IPC 队列尖峰，更小时 set 往返次数放大。
// 它只决定分批粒度与失败隔离范围，不改变最终条数，也不会把失败的 Cookie 变成成功。
// [并发] 批内 Promise.allSettled 并行、批间串行 await，所以同时在飞的 set 最多 32 个。
const COOKIE_IMPORT_CONCURRENCY = 32;
const DATABASE_SNAPSHOT_COPY_ATTEMPTS = 3;

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

// [契约] 目标 session 只要求 set + flushStore，不假设 Electron 完整 Session 形状；details 已归一。
// [事务] flushStore 是本文件唯一一次显式落盘请求，调用时所有 set 必须已 settled。
interface CookieTargetSession {
  cookies: {
    set(details: Electron.CookiesSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
}

// [契约] 签名保留 hostKey 形参但当前两个实现都未使用：v24+ 只按固定长度剥离摘要。
// schemaVersion 决定是否剥离 32 字节 SHA-256(host_key)，传错会让值前混入二进制头。
type CookieDecryptor = (encrypted: Uint8Array, hostKey: string, schemaVersion: number) => string;
export type ChromeCookieHelper = typeof readChromeCookiesWithHelper;
export type ChromeCookieDatabaseBackup = typeof backup;

interface CookieDecryptorResource {
  decrypt: CookieDecryptor;
  dispose(): void;
}

// [契约] 返回结构是导入结果的唯一事实：databaseFound 区分「没有库」与「有库但没导入」。
// stats 三项之和与 rowCount 无需相等：helper 路径的 skipped 由行数差推导；issues 已去重。
export interface ChromeCookieImportResult {
  databaseFound: boolean;
  issues: ChromeBrowserDataImportError[];
  rowCount: number;
  stats: {
    imported: number;
    skipped: number;
    failed: number;
  };
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// [失败路径] 只取 name 与 code，丢弃 message 与 stack：系统错误可能夹带路径与键值。
// 非 Error 必须一律归为 UnknownError，且 code 仅在确为 string 时携带，避免 errno 数字外泄。
function toSafeBrowserDataError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

// [契约] 仅当 schemaVersion >= 24 且解密后长度 >= 32 才切掉前 32 字节宿主摘要。
// 长度不足时原样返回而不抛错：空值与极短值在 Chrome 中合法存在。
function stripChromeHostDigest(value: Buffer, schemaVersion: number): Buffer {
  // Chrome Cookie schema 24+ 在加密明文前附加 SHA-256(host_key)；这里只移除固定长度摘要。
  return schemaVersion >= 24 && value.length >= 32 ? value.subarray(32) : value;
}

// [契约] 密钥必须 = PBKDF2(secret, "saltysalt", iterations, 16, sha1)，盐、长度与摘要均为 Chrome 固定值。
// macOS 用 1003 轮 + Safe Storage 口令，Linux 用 1 轮 + peanuts；key 每次重建不缓存以缩短驻留。
function createCbcDecryptor(secret: string, iterations: number): CookieDecryptorResource {
  const key = pbkdf2Sync(secret, "saltysalt", iterations, 16, "sha1");
  return {
    decrypt: (encrypted, _hostKey, schemaVersion) => {
      const buffer = Buffer.from(encrypted);
      if (buffer.subarray(0, 3).toString("ascii") !== "v10") {
        throw new Error("chrome_cookie_encryption_unsupported");
      }
      // [契约] IV 必须固定为 16 个 0x20 空格字节，这是 Chrome 既定实现，不是可配置项。
      // final() 会校验 PKCS#7 padding，padding 非法即抛错，正好用于识别 key 不匹配。
      // [失败路径] 解密结果先剥离宿主摘要再 utf8 解码；异常时 decrypted 仍在 finally 内清零。
      const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      const decrypted = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
      try {
        return stripChromeHostDigest(decrypted, schemaVersion).toString("utf8");
      } finally {
        decrypted.fill(0);
      }
    },
    dispose: () => key.fill(0),
  };
}

// [契约] GCM 布局：3 字节前缀 + 12 字节 nonce + 密文 + 末尾 16 字节 authTag。
// acceptedPrefixes 划定容忍范围：旧 key 解 v10/v11，App-Bound key 只解 v20。
// [失败路径] setAuthTag 后的 final() 做完整性校验，任何字节被改都会抛错而非返回脏值。
function createWindowsGcmDecryptor(
  masterKey: Buffer,
  acceptedPrefixes: ReadonlySet<string>,
): CookieDecryptorResource {
  return {
    decrypt: (encrypted, _hostKey, schemaVersion) => {
      const buffer = Buffer.from(encrypted);
      const prefix = buffer.subarray(0, 3).toString("ascii");
      if (!acceptedPrefixes.has(prefix)) {
        throw new Error("chrome_cookie_encryption_unsupported");
      }
      // [契约] nonce 必须固定 12 字节、tag 必须取末尾 16 字节，密文是二者之间的切片。
      // 故 buffer 至少需 31 字节，否则切片为空并让 final() 抛错，属于可接受的失败。
      const nonce = buffer.subarray(3, 15);
      const authTag = buffer.subarray(buffer.length - 16);
      const ciphertext = buffer.subarray(15, buffer.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return stripChromeHostDigest(decrypted, schemaVersion).toString("utf8");
      } finally {
        decrypted.fill(0);
      }
    },
    dispose: () => masterKey.fill(0),
  };
}

// [契约] 平台分派必须为 darwin → CBC(1003)，win32 → GCM(v10/v11)，其余走 CBC(peanuts)。
// profilePath 仅用于定位 Windows Local State，不参与密钥派生。
// [权衡] 本函数失败只代表材料拿不到，是否致命由调用方判断（AccessDenied 会上抛）。
async function createCookieDecryptor(
  platform: NodeJS.Platform,
  profilePath: string,
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader,
): Promise<CookieDecryptorResource> {
  if (platform === "darwin") {
    return createCbcDecryptor(
      await readMacChromeSafeStorageSecret(macChromeSafeStorageSecretReader),
      1003,
    );
  }
  if (platform === "win32") {
    return createWindowsGcmDecryptor(
      await readWindowsChromeMasterKey(dirname(profilePath)),
      new Set(["v10", "v11"]),
    );
  }
  // [权衡] Linux 旧格式用固定口令 peanuts 单轮派生，这是 Chrome 公开的默认实现。
  // 该分支只覆盖 v10；Linux 的 v11 已被 keyring helper 分支拦截，不会落到这里。
  return createCbcDecryptor("peanuts", 1);
}

// [事务] 契约：run 拿到的路径一定是闭合可信的快照，源库即使被 Chrome 占用也不直读。
// 快照目录以 zcode-browser-import- 为前缀便于排查遗留，正常路径由 finally 无条件删除。
// [权衡] 先试 SQLite Online Backup（跨 WAL 一致），失败才退化为文件拷贝 + WAL 重放。
async function withDatabaseSnapshot<T>(
  sourcePath: string,
  logger: BrowserDataLogger,
  databaseBackup: ChromeCookieDatabaseBackup,
  run: (snapshotPath: string) => T | Promise<T>,
): Promise<T> {
  // [资源] mkdtemp 保证目录唯一，避免并发导入互相覆盖 database.sqlite。
  // 目录位于系统临时区：进程被强杀时明文快照可能残留，只能依赖系统清理。
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-browser-import-"));
  const snapshotPath = join(tempDir, "database.sqlite");
  let sourceDatabase: import("node:sqlite").DatabaseSync | null = null;
  try {
    try {
      sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
      await databaseBackup(sourceDatabase, snapshotPath);
      sourceDatabase.close();
      sourceDatabase = null;
    // [失败路径] 此处必须只吞掉「在线备份不可用」，它不是数据错误，随即进入 WAL 快照回退。
    // 先关闭并置空可能残留的 sourceDatabase，防止回退路径复用半死句柄；日志只带安全错误码。
    } catch (onlineBackupError) {
      sourceDatabase?.close();
      sourceDatabase = null;
      logger.warn(
        "[browser-data] Chrome Cookie 在线备份不可用，回退 WAL 文件快照",
        toSafeBrowserDataError(onlineBackupError),
      );

      let fallbackError: unknown = onlineBackupError;
      // [失败路径] 上限 3 次只覆盖 Chrome 正在提交 WAL 的瞬时窗口，不为锁冲突无限让步。
      // 每轮使用独立 stagedPath，失败残留由该轮 finally 清理，避免跨轮污染。
      // [权衡] 三次仍失败直接上抛，宁可整次导入失败，也不返回可能撕裂的快照。
      for (let attempt = 1; attempt <= DATABASE_SNAPSHOT_COPY_ATTEMPTS; attempt += 1) {
        const stagedPath = join(tempDir, `source-${attempt}.sqlite`);
        let stagedDatabase: import("node:sqlite").DatabaseSync | null = null;
        try {
          await rm(snapshotPath, { force: true });
          // [事务] 先删旧 snapshotPath 再拷主库，保证 run 永远看不到上一轮的残留快照。
          // [失败路径] 只拷主库不拷 -shm：SHM 仅用于并发协调，Windows 上可能被独占且可重建。
          await copyFile(sourcePath, stagedPath);
          const sourceWalPath = `${sourcePath}-wal`;
          // [事务] 只把 -wal 复制到 staged 同前缀路径，SQLite 打开时会自动重放合并。
          // [失败路径] 探测本身不抛错；WAL 在复制瞬间消失则按无 WAL 继续，一致性由 backup 保证。
          if (await pathExists(sourceWalPath)) {
            await copyFile(sourceWalPath, `${stagedPath}-wal`);
          }
          // Chrome 的 SHM 仅用于并发协调且在 Windows 上可能被独占锁定。
          // 临时目录中的 SQLite 会自行重建 SHM，再通过 Online Backup 固化并校验主库与 WAL。
          stagedDatabase = new DatabaseSync(stagedPath, { readOnly: true });
          await databaseBackup(stagedDatabase, snapshotPath);
          stagedDatabase.close();
          stagedDatabase = null;
          logger.info("[browser-data] Chrome Cookie WAL 文件快照完成", { attempt });
          fallbackError = null;
          break;
        } catch (error) {
          fallbackError = error;
        } finally {
          stagedDatabase?.close();
          await rm(stagedPath, { force: true });
          await rm(`${stagedPath}-wal`, { force: true });
          await rm(`${stagedPath}-shm`, { force: true });
        }
      }
      if (fallbackError) {
        logger.warn(
          "[browser-data] Chrome Cookie WAL 文件快照失败",
          toSafeBrowserDataError(fallbackError),
        );
        throw fallbackError;
      }
    }
    // [事务] run 是唯一接触快照的入口，读取与解密都在其中，返回值原样透传。
    // run 抛错不在此捕获：让调用方区分「快照失败」与「写入失败」。
    return await run(snapshotPath);
  } finally {
    // TypeScript 会把前面显式置空后的 finally 路径收窄成 never，
    // 但 SQLite backup 在异常边界仍可能留下句柄；保留运行时兜底并显式恢复实际联合类型。
    const danglingDatabase = sourceDatabase as import("node:sqlite").DatabaseSync | null;
    danglingDatabase?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

// [契约] 固定两处查询：meta.version 提供 schema 版本，cookies 表取全部行含 encrypted_value。
// 不按 host_key 过滤、不分页：过滤与去重留给 Electron set，避免两处规则漂移。
async function readChromeCookies(databasePath: string): Promise<{
  rows: ChromeCookieRow[];
  schemaVersion: number;
}> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versionRow = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value?: string }
      | undefined;
    const statement = database.prepare(
      "SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, value, encrypted_value FROM cookies",
    );
    statement.setReadBigInts(true);
    return {
      rows: statement.all() as unknown as ChromeCookieRow[],
      schemaVersion: Number(versionRow?.value ?? 0),
    };
  } finally {
    database.close();
  }
}

// [契约] 候选顺序固定：Network/Cookies（Chrome 96+）优先，profile 根 Cookies 作为旧版回退。
// 顺序不可颠倒：新版 profile 根可能残留历史 Cookies，优先读会把旧登录态当成新数据。
// [失败路径] 两候选都不存在时返回 null，由调用方转成 databaseFound=false 的空结果。
async function resolveChromeCookieDatabasePath(profilePath: string): Promise<string | null> {
  for (const candidate of [join(profilePath, "Network", "Cookies"), join(profilePath, "Cookies")]) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

// [契约] 只看密文前 3 字节（v10/v11），不看是否已有明文：有明文的行也可能同时携带密文副本。
// 该判断决定是否启用 helper 或 App-Bound 密钥，属于整批预检而非逐行判断。
function hasEncryptedCookiePrefix(rows: ChromeCookieRow[], prefix: "v11" | "v20"): boolean {
  return rows.some(
    (row) => Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii") === prefix,
  );
}

// [契约] 输入必须为快照行与平台上下文，输出可直接 set 的 details 与 skipped，自身不写 session。
// 流程固定四段：Linux v11 helper → Windows v20 App-Bound 预检 → 旧格式解密器 → 逐行解码。
// [并发] 全程串行：解密器持有密钥状态，并行收益低于密钥扩散与顺序不可控的风险。
// [失败路径] 平台级失败一律落成 issue 码，不抛给 importChromeCookies 中断整次导入。
async function collectCookieDetails(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieHelper: ChromeCookieHelper;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  cookieDatabasePath: string;
  cookieDatabaseRelativePath: string;
  importedAt: number;
  issues: Set<ChromeBrowserDataImportError>;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  platform: NodeJS.Platform;
  profilePath: string;
  rows: ChromeCookieRow[];
  schemaVersion: number;
  windowsChromeAppBoundKeyReader: WindowsChromeAppBoundKeyReader;
}): Promise<{ details: Electron.CookiesSetDetails[]; skipped: number }> {
  // [失败路径] Linux v11 绑定系统密钥环，进程内无法自解，只能借同品牌 Chrome 的 helper。
  // 条件同时要求存在 v11 密文：纯明文库不触发 helper，避免无谓拉起浏览器。
  // [权衡] helper 读取的是运行中 Chrome 的口径，其条数可能与快照行数不同。
  if (options.platform === "linux" && hasEncryptedCookiePrefix(options.rows, "v11")) {
    if (options.chromeExecutablePath) {
      try {
        const helperCookies = await options.chromeCookieHelper({
          cookieDatabasePath: options.cookieDatabasePath,
          cookieDatabaseRelativePath: options.cookieDatabaseRelativePath,
          executablePath: options.chromeExecutablePath,
          logger: options.logger,
          ...(options.platform === "linux" && options.chromePasswordStore
            ? { passwordStore: options.chromePasswordStore }
            : {}),
          profilePath: options.profilePath,
        });
        // [契约] helper 返回非空即整批采用其结果，不再混入本进程自解的旧格式行。
        // 空库时即使 helper 也返回空仍算成功完成，skipped 为 0；否则 skipped 由行数差推导并下限 0。
        if (helperCookies.length > 0 || options.rows.length === 0) {
          options.logger.info("[browser-data] Chrome helper Cookie 快照读取完成", {
            returnedCount: helperCookies.length,
            reason: "linux-keyring-v11",
          });
          return {
            details: helperCookies.map((cookie) =>
              toCookieDetailsFromHelper(cookie, options.importedAt),
            ),
            skipped: Math.max(0, options.rows.length - helperCookies.length),
          };
        }
      } catch (error) {
        options.logger.warn("[browser-data] Chrome Cookie helper 不可用", {
          reason: "linux-keyring-v11",
          ...toSafeBrowserDataError(error),
        });
      }
    } else {
      options.issues.add("chrome_executable_not_found");
    }
    // Linux v11 绑定系统密钥环；同品牌 Chrome helper 不可用时，只能继续尝试
    // 当前进程可安全解密的旧格式，不能绕过系统密钥保护。
    options.issues.add("chrome_cookie_protection_unsupported");
  }

  // [契约] v20 与旧格式分开持解密器：v20 只认 App-Bound key，绝不回落到 master key。
  // [资源] 该变量在逐行循环的 finally 内 dispose，覆盖正常结束与异常中断两条路径。
  let appBoundDecryptor: CookieDecryptorResource | null = null;
  const containsAppBoundCookie =
    options.platform === "win32" && hasEncryptedCookiePrefix(options.rows, "v20");
  if (containsAppBoundCookie) {
    // [失败路径] 未授权提权时不下探密钥，只登记 chrome_cookie_elevation_required。
    // 这是用户可见的选择权边界：拒绝提权必须导致 v20 全跳过，而不是尝试旁路。
    if (!options.allowElevatedChromeDecryption) {
      options.issues.add("chrome_cookie_elevation_required");
    } else if (options.chromeExecutablePath) {
      try {
        const key = await options.windowsChromeAppBoundKeyReader({
          chromeExecutablePath: options.chromeExecutablePath,
          logger: options.logger,
          userDataDir: dirname(options.profilePath),
        });
        appBoundDecryptor = createWindowsGcmDecryptor(key, new Set(["v20"]));
        options.logger.info("[browser-data] Chrome App-Bound 解密材料已就绪");
      } catch (error) {
        const issue =
          error instanceof WindowsChromeAppBoundImportError
            ? error.code
            : "chrome_cookie_app_bound_decryption_failed";
        options.issues.add(issue);
        options.logger.warn(
          "[browser-data] Chrome App-Bound Cookie 原生解密失败",
          toSafeBrowserDataError(error),
        );
      }
    } else {
      options.issues.add("chrome_executable_not_found");
    }

    // [事务] 原子性断言：本批出现 v20 却拿不到密钥时整批返回 skipped，一条也不写。
    // [权衡] 宁可全部不导入，也不留下新旧登录态混用的半批 Cookie。
    if (!appBoundDecryptor) {
      // 同一 Chrome 数据库可能同时包含明文、旧版和 v20 Cookie。
      // App-Bound 授权失败时 Cookie 阶段必须保持原子性，不能悄悄写入同批的普通 Cookie。
      return { details: [], skipped: options.rows.length };
    }
  }

  // [契约] 旧解密器按需创建：仅当存在既无明文、又非 v20 的密文行时才读系统密钥。
  // [失败路径] 创建失败只登记 issue；循环中 legacyDecryptor 为 null 会把对应行计入 skipped。
  let legacyDecryptor: CookieDecryptorResource | null = null;
  const needsLegacyDecryptor = options.rows.some((row) => {
    if (row.value || row.encrypted_value.length === 0) return false;
    return Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii") !== "v20";
  });
  if (needsLegacyDecryptor) {
    try {
      legacyDecryptor = await createCookieDecryptor(
        options.platform,
        options.profilePath,
        options.macChromeSafeStorageSecretReader,
      );
    } catch (error) {
      // [失败路径] 访问被拒是唯一上抛的凭据错误：它代表用户明确拒绝，降级会掩盖真实意图。
      // 其余错误（无 key、格式不支持）必须降级为 issue + skipped，允许明文行继续导入。
      if (error instanceof ChromeCookieAccessDeniedError) throw error;
      options.issues.add("chrome_cookie_protection_unsupported");
      options.logger.warn("[browser-data] Chrome Cookie 系统解密材料不可用");
    }
  }

  const details: Electron.CookiesSetDetails[] = [];
  let skipped = 0;
  let protectedCookieSkipped = false;
  try {
    // [契约] 逐行优先级：有明文直接用；否则按前缀选解密器；两者皆空则计 skipped。
    // [失败路径] 单行失败只影响该行，protectedCookieSkipped 把信号汇总到批末再补 issue。
    for (const row of options.rows) {
      let value = row.value;
      if (!value && row.encrypted_value.length > 0) {
        const prefix = Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii");
        const decryptor = prefix === "v20" ? appBoundDecryptor : legacyDecryptor;
        if (!decryptor) {
          skipped += 1;
          protectedCookieSkipped = true;
          continue;
        }
        try {
          value = decryptor.decrypt(row.encrypted_value, row.host_key, options.schemaVersion);
        } catch {
          skipped += 1;
          protectedCookieSkipped = true;
          continue;
        }
      }
      if (!value) {
        skipped += 1;
        continue;
      }
      details.push(toCookieDetails(row, value, options.importedAt));
    }
  } finally {
    // [资源] 两个解密器在同一 finally 内释放，覆盖 return、throw 与 continue 三种出口。
    // 此刻解密已完成，清 key 不影响已生成的值；可选链保证无 v20 场景零成本且必须在 return 前执行。
    appBoundDecryptor?.dispose();
    legacyDecryptor?.dispose();
  }
  if (protectedCookieSkipped && options.issues.size === 0) {
    options.issues.add("chrome_cookie_protection_unsupported");
  }
  return { details, skipped };
}

// [契约] 唯一公开入口必须接收 profile 路径、平台、目标 session 与可选注入项，输出导入统计。
// 执行顺序固定：定位数据库 → 建快照 → 读行 → 收集 details → 分批 set → flushStore。
// [事务] 快照存在期间不写目标 session；写入阶段不再触碰源库。
// [失败路径] 仅快照失败与 flushStore 失败会上抛，单条 Cookie 失败只进 stats.failed。
export async function importChromeCookies(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieHelper?: ChromeCookieHelper;
  databaseBackup?: ChromeCookieDatabaseBackup;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  platform: NodeJS.Platform;
  profilePath: string;
  targetSession: CookieTargetSession;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
}): Promise<ChromeCookieImportResult> {
  const cookieDatabasePath = await resolveChromeCookieDatabasePath(options.profilePath);
  // [失败路径] 找不到数据库属于正常环境（未装 Chrome 或未登录），返回 databaseFound=false。
  // 此处不写 issue、不抛错：调用方据此把 Cookie 阶段标记为跳过而非失败。
  if (!cookieDatabasePath) {
    return {
      databaseFound: false,
      issues: [],
      rowCount: 0,
      stats: { imported: 0, skipped: 0, failed: 0 },
    };
  }
  // [契约] 相对路径（Network/Cookies 或 Cookies）原样传给 helper 定位与记录。
  // 它基于真实源库路径计算而非快照路径：helper 需要知道 Chrome 侧的原始位置。
  const cookieDatabaseRelativePath = relative(options.profilePath, cookieDatabasePath);
  return withDatabaseSnapshot(
    cookieDatabasePath,
    options.logger,
    options.databaseBackup ?? backup,
    async (snapshotPath) => {
      // [契约] 读取目标始终是 snapshotPath：源库此刻可能正被 Chrome 写入。
      // schemaVersion 只用于剥离宿主摘要，缺失或非数字时按 0 处理即不剥离。
      const { rows, schemaVersion } = await readChromeCookies(snapshotPath);
      options.logger.info("[browser-data] Chrome Cookie 快照读取完成", {
        sourceCount: rows.length,
      });
      const issues = new Set<ChromeBrowserDataImportError>();
      const collected = await collectCookieDetails({
        allowElevatedChromeDecryption: options.allowElevatedChromeDecryption,
        chromeCookieHelper: options.chromeCookieHelper ?? readChromeCookiesWithHelper,
        chromeExecutablePath: options.chromeExecutablePath,
        chromePasswordStore: options.chromePasswordStore,
        cookieDatabasePath: snapshotPath,
        cookieDatabaseRelativePath,
        importedAt: Math.floor(Date.now() / 1000),
        issues,
        logger: options.logger,
        macChromeSafeStorageSecretReader: options.macChromeSafeStorageSecretReader,
        platform: options.platform,
        profilePath: options.profilePath,
        rows,
        schemaVersion,
        windowsChromeAppBoundKeyReader:
          options.windowsChromeAppBoundKeyReader ?? readWindowsChromeAppBoundKey,
      });
      // [契约] skipped 在写入前已确定（解密阶段结果），imported 与 failed 由写入结果累加。
      // 因此 failed 只统计 set 失败，解密失败永远只出现在 skipped 里。
      const stats = { imported: 0, skipped: collected.skipped, failed: 0 };
      // [并发] 批间必须串行、批内并行：上一批全部 settled 后才发起下一批，避免 IPC 队列堆积。
      // [失败路径] 分批的意义是隔离失败：某批坏一条不影响其他批次继续写入。
      for (let offset = 0; offset < collected.details.length; offset += COOKIE_IMPORT_CONCURRENCY) {
        const batch = collected.details.slice(offset, offset + COOKIE_IMPORT_CONCURRENCY);
        // [并发] allSettled 而非 all：单条 set 拒绝不得让整批提前结束或丢失其余结果。
        // 统计只看 status，不读取 rejection 原因，避免把 Cookie 值带进日志。
        const statuses = await Promise.allSettled(
          batch.map((details) => options.targetSession.cookies.set(details)),
        );
        for (const status of statuses) {
          if (status.status === "fulfilled") stats.imported += 1;
          else stats.failed += 1;
        }
      }
      // [事务] 批次全部结束后才 flush：此时 session 已是最终状态，一次落盘即可。
      // [失败路径] flushStore 失败会上抛：调用方必须感知「内存成功、磁盘失败」的差异。
      await options.targetSession.cookies.flushStore();
      options.logger.info("[browser-data] Chrome Cookie 写入完成", {
        importedCount: stats.imported,
        skippedCount: stats.skipped,
        failedCount: stats.failed,
      });
      return { databaseFound: true, issues: [...issues], rowCount: rows.length, stats };
    },
  );
}
