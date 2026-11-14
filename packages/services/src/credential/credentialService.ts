import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
  isCredentialDecryptError,
} from "@zcode/shared";
import type { ICredentialService } from "./credential.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

/**
 * 凭据存储路径
 *
 * 当前持久化格式仍是 JSON，但 value 会在写入前加密，读取时自动解密。
 * 后续可切换到 Electron safeStorage（钥匙串）托管密钥，
 * 届时 host process 需要向 main 进程请求 encrypt/decrypt。
 */
// 凭据服务：唯一负责 credentials.json 的读写、加解密与跨进程互斥。
// 对外只暴露 ICredentialService 的 load/save/delete；缓存恢复能力保留在 Host 本地接口，
// 避免渲染进程通过 ICredentialService 拿到「删除任意凭据」的写入面。
const logger = createServiceLogger("credentialService");

// 目录延迟解析：每次调用重新读取应用配置目录，避免模块加载时固化 HOME 而破坏测试隔离。
function getCredentialsDir() {
  // getAppConfigDir() 每次调用重新读环境：测试切换 HOME 后，旧实例不会继续写真实用户目录。
  return getAppConfigDir();
}

// 凭据文件名固定，目录变化（如切换用户配置）时无需迁移附加状态。
function getCredentialsFile() {
  // 固定文件名 credentials.json：调用方无法指定路径，也就无法绕开 withFileLock 的跨进程互斥。
  return join(getCredentialsDir(), "credentials.json");
}

// 只认对象上的字符串 code：Node 与 Undici 都把它作为 errno 暴露，避免依赖 instanceof 或错误文案匹配。
function getErrorCode(error: unknown): string | undefined {
  // 走 undefined 分支的三种情况：抛出值不是对象、是 null、或者对象上没有 code 属性；
  // 这三种都不该让调用方拿到 TypeError，而是按「无 errno」继续走通用错误路径。
  if (typeof error !== "object" || error === null || !("code" in error)) {
  // 返回 undefined 表示「无法识别错误码」，由调用方决定是上抛还是降级，这里不吞错。
    return undefined;
  }
  // code 可能是 number 或 Symbol（其它库的 errno 常量），只有 string 才按 Node 约定返回。
  const code = (error as { code?: unknown }).code;
  // 显式收窄到 string | undefined：调用方拿 "ENOENT" 字面量比较时，TS 必须知道它不是 any。
  return typeof code === "string" ? code : undefined;
}

// 读取整份凭据映射；文件不存在视为首次运行的空存储，其余 IO 错误必须上抛。
// 返回的是已校验结构，调用方可以直接按 key 取值，不再重复判型。
async function readAll(credentialsFile = getCredentialsFile()): Promise<Record<string, string>> {
  // raw 在 try 外声明是为满足 TS 的确定赋值检查；catch 分支只 return 或 throw，后面读不到未赋值状态。
  let raw: string;
  try {
  // 读原始文本而不在这里解析：IO 失败与 JSON/schema 损坏要分成两条处置路径（见下面两个 catch）。
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
// ENOENT 之外的失败（权限、磁盘、路径异常）不能被静默当成空 store，否则后续 save 会覆盖现存凭据。
    if (getErrorCode(error) === "ENOENT") {
  // ENOENT 视为首次运行，返回空表让 save 正常建文件；不能返回 null，否则每个调用方都要额外判空。
      return {};
    }
  // 权限、磁盘、路径异常直接上抛：若在这里静默返回 {}，下一次 save 会用空表覆盖现存凭据。
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
  // 先 JSON.parse 成 unknown 再交给 schema：解析和结构校验分开，错误信息才能指到具体字段。
    const rawValue = JSON.parse(raw);
  // safeParse 而不是 parse：要拿 result.error 交给 formatZodError，同时避免 ZodError 直接穿出服务层。
    const result = credentialRecordSchema.safeParse(rawValue);
  // schema 不通过与 JSON 损坏共用下面的备份 + 上抛路径，因为两者都意味着文件不可信。
    if (!result.success) {
  // 抛错前把 issue 格式化成文本：日志里要能看出是哪个 key 类型错了，而不是只有 "invalid input"。
      throw new Error(formatZodError(result.error));
    }
// safeParse 通过后再返回，未知字段与错误类型不会流入内存中的凭据表。
    return result.data;
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      // backupPath 为 undefined 表示备份也失败：日志里保留这个区别，便于判断损坏文件是否还在原路径。
      backupPath,
      credentialsFile,
    });
  // 错误只带文件路径，不带任何凭据内容：这条 message 会进服务日志与崩溃上报。
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

// 通过共享层的原子私有写落地：先写临时文件再替换并收紧权限，避免半写状态被读到。
async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

// 依赖注入点：测试可替换加密实现，Host 可订阅变更通知而不把回调塞进 RPC 契约。
interface CredentialServiceDependencies {
  // 可选注入：生产调用方不传，测试传入密钥固定的假 provider，避免依赖真实钥匙串。
  cipherProvider?: CredentialCipherProvider;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}

/** Host 私有缓存恢复能力，不进入 Renderer 的 ICredentialService 契约。 */
export interface LocalCredentialService extends ICredentialService {
  // 仅 Host 可调用：确认是派生的缓存凭据且解密失败时删除记录并返回 null，成功则返回明文。
  recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null>;
  // assertCurrent 在锁内复查，覆盖「排队等锁期间会话已切换」的竞态。
  save(key: string, value: string, assertCurrent?: () => void): Promise<void>;
  // delete 幂等：key 不存在也不报错，仍重写文件保证磁盘格式与内存一致。
  delete(key: string, assertCurrent?: () => void): Promise<void>;
}

// 创建凭据服务实例。所有方法先校验 key/value 的 schema，再在文件锁内做整文件读改写，
// 因此并发调用方（Desktop Host 与 CLI 进程）不会互相覆盖对方的记录。
export function createCredentialService(
  // 默认空对象：生产不传参数；测试可通过 dependencies 替换加密实现或订阅变更。
  dependencies: CredentialServiceDependencies = {},
): LocalCredentialService {
  // provider 只解析一次并复用到所有方法：同一实例必须用同一密钥源，否则 save 写的密文 load 解不开。
  const cipherProvider = dependencies.cipherProvider ?? createCredentialCipherProvider();

  // 返回对象字面量，各方法闭包共享上面的 cipherProvider；新增方法不得自己 new provider。
  return {
// 仅用于恢复「可重新派生」的缓存型凭据：解密失败且确认是凭据解密错误时才删除记录，
// 其它异常原样抛出，防止把有效的 OAuth 登录当作损坏缓存清掉。
    async recoverUnreadable(key, assertCurrent) {
      // 先校验 key：非法 key 在进入文件锁前失败，不产生一次无意义的读盘。
      const validatedKey = credentialKeySchema.parse(key);
      // 路径在方法内解析：测试会切换配置目录，模块级常量会固化旧目录。
      const credentialsFile = getCredentialsFile();
      // deleted 用来把 onDidMutate 推到锁外：监听者可能在回调里回读凭据。
      let deleted = false;
// 复核、删除与落盘必须在同一把锁内完成；分开执行会删掉另一窗口刚刚修复的记录。
      const value = await withFileLock(credentialsFile, async () => {
        // 进锁后第一次 assertCurrent：调用方可能在排队期间被取消，此时不应再读盘。
        assertCurrent();
        // 整表读入内存：单独读 key 再写整表会多一次读盘，且两次读之间状态可能已变。
        const creds = await readAll(credentialsFile);
        // 读盘后再复查：readAll 要排队等锁，期间请求可能已经失效。
        assertCurrent();
        // rawValue 是密文；不存在时直接返回 null，不能落到 decrypt 让它抛「密钥错误」。
        const rawValue = creds[validatedKey];
        // 缺失 key 返回 null 而不是抛错：恢复流程对「已经不存在」必须幂等。
        if (rawValue === undefined) return null;
        try {
        // 解密成功立即返回明文，不删除记录；只有确认是解密错误才继续往下走删除分支。
          return cipherProvider.decrypt(rawValue);
        } catch (error) {
        // 只吞 isCredentialDecryptError：其它异常（如密钥源不可用）必须原样上抛，否则会误删有效登录。
          if (!isCredentialDecryptError(error)) throw error;
        }
        // 缓存复核与删除必须共用跨进程锁；分别 load/delete 会误删另一窗口已修复的记录。
        // 此处仅处理调用方明确标记的派生缓存，不能因缓存损坏清理有效 OAuth 登录。
        assertCurrent();
        // 已在锁内才删除：锁外 delete 会被另一窗口的整表写回覆盖，或覆盖掉它刚写入的记录。
        delete creds[validatedKey];
        // 先落盘再置 deleted：写失败时异常穿出，onDidMutate 不会被误触发成「已删除」。
        await writeAll(credentialsFile, creds);
        // deleted 置真表示本次确实删掉了一条，缺失 key 的分支不会通知监听者。
        deleted = true;
        // 返回 null：调用方据此走「缓存不可用、需要重新派生」的分支。
        return null;
      });
// 变更通知放到锁外触发，避免监听者回调里调 load 时与当前 withFileLock 互相等待。
      if (deleted) dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
      // value 可能是明文，也可能是 null（缺失）；两种情况都不在锁外再读一次盘。
      return value;
    },

// 读取并解密；缺失 key 返回 null，解密失败向上抛出由调用方决定是否走恢复流程。
    async load(key: string): Promise<string | null> {
      // load 也校验 key：它是最常被渲染进程间接触发的入口，宽松解析会让脏 key 进入查表。
      const validatedKey = credentialKeySchema.parse(key);
      // 无锁读取：原子写保证读到的要么是旧表要么是新表，不会读到半写状态。
      const creds = await readAll();
      // 与 recoverUnreadable 一致，缺失 key 返回 null。
      const rawValue = creds[validatedKey];
      // 用 === undefined 判断而不是 falsy：空字符串密文也应走 decrypt 报错，而不是被当成缺失。
      if (rawValue === undefined) {
      // 对外契约是 Promise<string | null>，调用方统一用 === null 判断「没有这条凭据」。
        return null;
      }

      // 解密失败直接抛给调用方：load 不知道这个 key 能否重新派生，不能替调用方决定删除。
      return cipherProvider.decrypt(rawValue);
    },

// 保存前先校验并加密，再进入文件锁：加密失败不应占用锁，也不应改动磁盘。
// assertCurrent 在锁内再次执行，覆盖「排队期间请求已失效」的竞态。
    async save(key: string, value: string, assertCurrent?: () => void): Promise<void> {
      // 校验在加密和进锁之前：非法 key/value 不该产生任何写盘副作用。
      const validatedKey = credentialKeySchema.parse(key);
      // value 的长度与字符集由 credentialValueSchema 约束，避免把超长或含控制字符的串写进 JSON。
      const validatedValue = credentialValueSchema.parse(value);
      // 加密在锁外：纯 CPU 操作，占着文件锁会让并发的 load 排队。
      const encryptedValue = cipherProvider.encrypt(validatedValue);
      // 进锁前解析路径：锁键必须与下面 writeAll 的目标完全一致，否则两把锁保护的不是同一个文件。
      const credentialsFile = getCredentialsFile();
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await withFileLock(credentialsFile, async () => {
        // 锁内重新读整表，不复用进锁前的快照：否则会丢掉其它进程在这期间写入的 key。
        const creds = await readAll(credentialsFile);
        // 请求可能在等待文件锁时失效，不能只依赖调用方进入 IO 前的代次检查。
        assertCurrent?.();
        // 只改自己这个 key，其余记录原样写回；这也是必须持有整文件锁的原因。
        creds[validatedKey] = encryptedValue;
        // 原子替换在锁内完成：写失败时异常穿出，onDidMutate 不会被触发成「已保存」。
        await writeAll(credentialsFile, creds);
      });
      // 通知放在锁释放之后：监听者在回调里调 load 时不会与当前锁互等。
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

// 删除是幂等的整文件读改写；不存在的 key 不会报错，但仍会重写文件保持格式一致。
    async delete(key: string, assertCurrent?: () => void): Promise<void> {
      // delete 与 save 用同一套 key 校验，保证「能写进去的 key 才能被删掉」。
      const validatedKey = credentialKeySchema.parse(key);
      // 路径解析在进锁前：withFileLock 的锁键来自这个路径，两者必须一致。
      const credentialsFile = getCredentialsFile();
      // 幂等删除也在锁内做整表读改写：不存在的 key 不报错，文件仍会被重写成规范格式。
      await withFileLock(credentialsFile, async () => {
        // 读整表而不是只判断 key 是否存在：写回需要完整内容，读两次会引入窗口。
        const creds = await readAll(credentialsFile);
        // 与 save 相同的竞态复查：等锁期间请求失效时不再写盘，避免替已取消的会话删凭据。
        assertCurrent?.();
        // 直接删属性；不存在的 key 删了也不报错，这正是幂等语义需要的行为。
        delete creds[validatedKey];
        // 即使没有实际删除也重写一次：保证磁盘上是 2 空格缩进 + 末尾换行的规范格式。
        await writeAll(credentialsFile, creds);
      });
      // 删除通知同样在锁外触发：监听者回读时不会再撞上已经释放的锁。
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },
  };
}
