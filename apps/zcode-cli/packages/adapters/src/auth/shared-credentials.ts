import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import { createZCodeCredentialCipher, type ZCodeCredentialCipher } from "./credential-cipher.js";

/*
 * ============================================================
 * auth / shared-credentials.ts —— 进程间共享凭据文件（credentials.json）
 *
 * 定位：CLI / 设置页 / session 多个 Node 进程共用一份凭据 JSON；本文件提供加密读写、
 * 条件删除、变更通知与路径解析，是登录态唯一的持久化入口。
 *
 * 输入输出：键是 SHARED_ZCODE_CREDENTIAL_KEYS 中的稳定字符串，值是明文；落盘时统一经
 * ZCodeCredentialCipher 加密（userInfo 以 JSON 字符串加密）。load 返回 null 表示不存在。
 *
 * 副作用：文件读取/写入（withFileLock 覆盖 read-modify-write，atomicWritePrivateTextFile
 * 原子替换并设私有权限）；变更后通知同进程监听者。
 *
 * 失败语义：文件损坏→先 backupCorruptFile 留证据再抛错（绝不把损坏当空对象覆盖）；
 * 加解密失败向上抛（fail closed）；ENOENT 视为空记录。
 *
 * 不变量：写操作必须整段持锁；任何未加密/空值不会被写入；明文永不回显到日志。
 * ============================================================
 */

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
const ZAI_PROVIDER_ID = "zai";
const credentialChangeListeners = new Map<
  string,
  Set<() => void | Promise<void>>
>();

export const SHARED_ZCODE_CREDENTIAL_KEYS = {
  /** 当前生效的 provider id（如 zai），清除 zai 登录时据此决定是否清 activeProvider。 */
  activeProvider: "oauth:active_provider",
  /** BigModel OAuth 访问令牌。 */
  bigmodelAccessToken: "oauth:bigmodel:access_token",
  /** BigModel OAuth 刷新令牌。 */
  bigmodelRefreshToken: "oauth:bigmodel:refresh_token",
  /** BigModel 用户信息（加密的 JSON 字符串）。 */
  bigmodelUserInfo: "oauth:bigmodel:user_info",
  /** Z.ai 访问令牌。 */
  zaiAccessToken: "oauth:zai:access_token",
  /** Z.ai 刷新令牌。 */
  zaiRefreshToken: "oauth:zai:refresh_token",
  /** Z.ai 用户信息（加密的 JSON 字符串）。 */
  zaiUserInfo: "oauth:zai:user_info",
  /** Z.ai 登录 JWT（兼容旧键名，无分隔符）。 */
  zcodeJwtToken: "zcodejwttoken",
} as const;

export interface SharedZCodeCredentialStoreOptions {
  /** 数据根目录；缺省取 ZCODE_DATA_BASE_DIR 或 home，最终落到 <base>/.zcode/v2。 */
  baseDir?: string;
  /** 注入加解密器（测试用）；缺省按 env 创建。 */
  cipher?: ZCodeCredentialCipher;
  /** 注入环境变量源；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 直接指定 credentials.json 路径，优先级最高。 */
  filePath?: string;
}

export interface ZaiLoginCredentialUser {
  /** 头像地址，可选（用户信息整体加密存储）。 */
  avatar?: string;
  /** 邮箱，可选。 */
  email?: string;
  /** 显示名，可选。 */
  name?: string;
  /** 服务端用户 id，必填。 */
  user_id: string;
}

export interface ZaiLoginCredentialPayload {
  /** Z.ai OAuth 访问令牌（明文入参，落盘前加密）。 */
  accessToken: string;
  /** Z.ai 登录 JWT（明文入参，落盘前加密）。 */
  jwtToken: string;
  /** 用户信息，整体 JSON 序列化后加密。 */
  user: ZaiLoginCredentialUser;
}

export interface SharedZCodeCredentialStore {
  /** 解析后的绝对路径，便于调用方日志/诊断（不含内容）。 */
  readonly filePath: string;
  /** 删除 zai 全部登录态；仅当 activeProvider 为 zai 时一并清 activeProvider。 */
  clearZaiLoginCredentials(): Promise<void>;
  /** 无条件删除单个 key（不存在也视为成功）。 */
  delete(key: string): Promise<void>;
  /** 仅当当前明文值等于 expectedValue 才删除；返回是否真的删除。 */
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;
  /** 批量条件删除，逐 key 判断并返回每个 key 的删除结果。 */
  deleteIfValues(
    expectedValues: Readonly<Record<string, string>>,
  ): Promise<Record<string, boolean>>;
  /** guard 匹配才整体删除 keysToDelete 的原子事务，返回是否执行。 */
  deleteManyIfValue(
    guardKey: string,
    expectedGuardValue: string,
    keysToDelete: readonly string[],
  ): Promise<boolean>;
  /** 读取并解密；key 不存在返回 null。 */
  load(key: string): Promise<string | null>;
  /** 批量读取，返回 key → 明文/null 的对象。 */
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  /** 订阅同进程变更，返回取消订阅函数。 */
  onDidChange?(listener: () => void | Promise<void>): () => void;
  /** 加密并写入单个 key。 */
  save(key: string, value: string): Promise<void>;
  /** 批量加密写入，同一次加锁内完成。 */
  saveMany(entries: Readonly<Record<string, string>>): Promise<void>;
  /** 写入 key 并删除 replacedKeys（不含 key 自身），用于 canonical/legacy 镜像切换。 */
  saveReplacing(key: string, value: string, replacedKeys: readonly string[]): Promise<void>;
  /** 一次事务写入 zai 登录四元组（activeProvider/accessToken/jwt/userInfo）。 */
  saveZaiLoginCredentials(payload: ZaiLoginCredentialPayload): Promise<void>;
}

/**
 * 创建共享凭据存储。
 *
 * 路径与 cipher 在构造时固定；每次读写都重新读文件以保证跨进程最新。所有写操作走
 * mutateRawCredentialRecord：文件锁 + 读-改-写 + 原子替换，结束后通知监听者。
 *
 * 失败语义：损坏文件抛错（含备份路径），加解密错误冒泡，绝不静默清空。
 */
export function createSharedZCodeCredentialStore(
  options: SharedZCodeCredentialStoreOptions = {},
): SharedZCodeCredentialStore {
  const env = options.env ?? process.env;
  const filePath = resolveSharedZCodeCredentialsPath(options);
  const cipher = options.cipher ?? createZCodeCredentialCipher({ env });

  return {
    filePath,

    /** 清除 zai 登录四元组；先解密 activeProvider 再判断，避免误删其他 provider 的选中态。 */
    async clearZaiLoginCredentials(): Promise<void> {
      await mutateRawCredentialRecord(filePath, async (rawCredentials) => {
        const activeProviderRaw = rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider];
        const activeProvider = activeProviderRaw ? cipher.decrypt(activeProviderRaw) : null;
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken];
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiRefreshToken];
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo];
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken];
        // 只有当前生效的是 zai 才清 activeProvider，否则会破坏其他 provider 的登录态。
        if (activeProvider === ZAI_PROVIDER_ID) {
          delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider];
        }
      });
    },

    /** 无条件删除单个 key；不做值比较，调用方需自行确认影响范围。 */
    async delete(key: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        delete rawCredentials[validatedKey];
      });
    },

    /** 条件删除（CAS）：解密后与期望值比较一致才删，避免误删并发刷新的新 token。 */
    async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
      const validatedKey = validateCredentialKey(key);
      const validatedExpectedValue = validateCredentialValue(expectedValue);
      let deleted = false;
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        const encryptedValue = rawCredentials[validatedKey];
        if (
          encryptedValue === undefined ||
          cipher.decrypt(encryptedValue) !== validatedExpectedValue
        ) {
          return;
        }
        delete rawCredentials[validatedKey];
        deleted = true;
      });
      return deleted;
    },

    /** 批量 CAS 删除：每个 key 独立比较、独立删除，返回逐 key 结果（部分成功也算成功）。 */
    async deleteIfValues(
      expectedValues: Readonly<Record<string, string>>,
    ): Promise<Record<string, boolean>> {
      const validatedEntries = Object.entries(expectedValues).map(
        ([key, value]) => [validateCredentialKey(key), validateCredentialValue(value)] as const,
      );
      // 空输入无需加锁/落盘，直接返回空结果。
      if (validatedEntries.length === 0) return {};
      const deleted: Record<string, boolean> = {};
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        for (const [key, expectedValue] of validatedEntries) {
          const encryptedValue = rawCredentials[key];
          const matches =
            encryptedValue !== undefined && cipher.decrypt(encryptedValue) === expectedValue;
          deleted[key] = matches;
          if (matches) delete rawCredentials[key];
        }
      });
      return deleted;
    },

    /**
     * 条件事务：`guardKey` 当前值与期望值相等才删除 `keysToDelete` 全部 key，否则一个都不删。
     *
     * `deleteIfValues` 是逐 key 比较、逐 key 删除，无法表达「canonical generation 匹配
     * 才整体失效」——canonical 比较失败时 legacy 镜像仍可能被删掉，反之亦然。OAuth 凭据失效必须
     * 是整对的：stale 事务不能删掉 winner 的 canonical，也不能只删掉它的一半镜像。
     */
    async deleteManyIfValue(
      guardKey: string,
      expectedGuardValue: string,
      keysToDelete: readonly string[],
    ): Promise<boolean> {
      const validatedGuardKey = validateCredentialKey(guardKey);
      const validatedExpectedValue = validateCredentialValue(expectedGuardValue);
      const validatedKeys = keysToDelete.map(validateCredentialKey);
      let deleted = false;
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        const encryptedGuard = rawCredentials[validatedGuardKey];
        if (
          encryptedGuard === undefined ||
          cipher.decrypt(encryptedGuard) !== validatedExpectedValue
        ) {
          return;
        }
        for (const key of validatedKeys) delete rawCredentials[key];
        deleted = true;
      });
      return deleted;
    },

    /** 读取并解密单个 key；不存在返回 null，解密失败抛错（不会把坏密文当空值）。 */
    async load(key: string): Promise<string | null> {
      const rawCredentials = await readRawCredentialRecord(filePath);
      const rawValue = rawCredentials[validateCredentialKey(key)];
      if (rawValue === undefined) {
        return null;
      }
      return cipher.decrypt(rawValue);
    },

    /** 一次读盘批量解密；不存在的 key 返回 null，保证每个入参 key 都有对应条目。 */
    async loadMany(keys: readonly string[]): Promise<Record<string, string | null>> {
      const validatedKeys = keys.map(validateCredentialKey);
      const rawCredentials = await readRawCredentialRecord(filePath);
      return Object.fromEntries(
        validatedKeys.map((key) => {
          const rawValue = rawCredentials[key];
          return [key, rawValue === undefined ? null : cipher.decrypt(rawValue)];
        }),
      );
    },

    /**
     * 注册同进程变更监听（按 filePath 分组）。
     * 只对同进程写入生效，跨进程依赖下次 load，不做文件监听。
     */
    onDidChange(listener: () => void | Promise<void>): () => void {
      let listeners = credentialChangeListeners.get(filePath);
      if (!listeners) {
        listeners = new Set();
        credentialChangeListeners.set(filePath, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        // 集合空了就清理 Map 条目，避免按进程生命周期泄漏。
        if (listeners?.size === 0) credentialChangeListeners.delete(filePath);
      };
    },

    /** 加密后写入单个 key；空 key/空值在落盘前即被拒绝。 */
    async save(key: string, value: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      const encryptedValue = cipher.encrypt(validateCredentialValue(value));
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        rawCredentials[validatedKey] = encryptedValue;
      });
    },

    /** 批量加密并写入，全部在同一次加锁/原子替换内完成，避免出现半组新凭据。 */
    async saveMany(entries: Readonly<Record<string, string>>): Promise<void> {
      const encryptedEntries = Object.entries(entries).map(
        ([key, value]) =>
          [validateCredentialKey(key), cipher.encrypt(validateCredentialValue(value))] as const,
      );
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        for (const [key, encryptedValue] of encryptedEntries) {
          rawCredentials[key] = encryptedValue;
        }
      });
    },

    /**
     * 写 canonical key 并清掉 replacedKeys（旧镜像）。
     * replacedKeys 中若包含 key 自身会被跳过，保证新值不被误删。
     */
    async saveReplacing(
      key: string,
      value: string,
      replacedKeys: readonly string[],
    ): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      const encryptedValue = cipher.encrypt(validateCredentialValue(value));
      const validatedReplacedKeys = replacedKeys.map(validateCredentialKey);
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        rawCredentials[validatedKey] = encryptedValue;
        for (const replacedKey of validatedReplacedKeys) {
          if (replacedKey !== validatedKey) delete rawCredentials[replacedKey];
        }
      });
    },

    /** 原子写入 zai 登录四元组：先全部加密再一次性落盘，避免 activeProvider 与 token 不一致。 */
    async saveZaiLoginCredentials(payload: ZaiLoginCredentialPayload): Promise<void> {
      const encryptedCredentials = {
        activeProvider: cipher.encrypt(ZAI_PROVIDER_ID),
        accessToken: cipher.encrypt(validateCredentialValue(payload.accessToken)),
        jwtToken: cipher.encrypt(validateCredentialValue(payload.jwtToken)),
        userInfo: cipher.encrypt(JSON.stringify(payload.user)),
      };
      await mutateRawCredentialRecord(filePath, (rawCredentials) => {
        rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider] =
          encryptedCredentials.activeProvider;
        rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken] =
          encryptedCredentials.accessToken;
        rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken] = encryptedCredentials.jwtToken;
        rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo] = encryptedCredentials.userInfo;
      });
    },
  };
}

/**
 * 同步读取单个凭据（启动早期无法用异步时使用）。
 *
 * 文件不存在、JSON 非法、解密失败或值为空白一律返回 undefined——这里刻意吞错，
 * 因为调用方只需要“能不能拿到值”，不能因凭据文件损坏而阻断启动。
 */
export function loadSharedZCodeCredentialSync(
  key: string,
  options: SharedZCodeCredentialStoreOptions = {},
): string | undefined {
  const filePath = resolveSharedZCodeCredentialsPath(options);
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const record = parseCredentialRecord(parsed);
    const rawValue = record[validateCredentialKey(key)];
    if (rawValue === undefined) {
      return undefined;
    }
    const cipher = options.cipher ?? createZCodeCredentialCipher({ env: options.env });
    const decrypted = cipher.decrypt(rawValue);
    // 空白值等价于未登录，统一收敛成 undefined。
    return decrypted.trim().length > 0 ? decrypted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析凭据文件绝对路径，优先级：显式 filePath > baseDir > 环境变量 > home。
 * 支持 `~` 与 `~/` 展开；最终固定为 <base>/.zcode/v2/credentials.json。
 */
export function resolveSharedZCodeCredentialsPath(
  options: SharedZCodeCredentialStoreOptions = {},
): string {
  if (options.filePath) {
    return resolveUserPath(options.filePath);
  }

  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? env[ZCODE_DATA_BASE_DIR_ENV_KEY] ?? homedir();
  return join(resolveUserPath(baseDir), ".zcode", "v2", "credentials.json");
}

/**
 * 读取并按 {key: 密文字符串} 结构解析整个文件。
 *
 * ENOENT 视为空记录（首次登录）；其他读错抛错；JSON/结构非法时先备份现场再抛错，
 * 防止后续写入用空对象覆盖掉其他进程的凭据。
 */
async function readRawCredentialRecord(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read shared ZCode credentials: ${filePath}`, { cause: error });
  }

  try {
    return parseCredentialRecord(JSON.parse(raw));
  } catch (error) {
    // 损坏的凭据文件若被当成空对象继续保存，会一次性抹掉其他进程的全部凭据。
    // 先保留现场再失败，调用方必须显式处理恢复，不能静默覆盖。
    const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
    const evidence = backupPath ? ` Backup: ${backupPath}` : "";
    throw new Error(`Shared ZCode credentials are corrupt: ${filePath}.${evidence}`, {
      cause: error,
    });
  }
}

/**
 * 在文件锁内完成 read-modify-write，并原子写回；之后通知同进程监听者。
 *
 * 锁必须覆盖整段读改写（跨进程并发时单靠原子 rename 仍会丢 key）；监听者通知用
 * allSettled，单个监听者失败不能让已落盘的写入被报告为失败。
 */
async function mutateRawCredentialRecord(
  filePath: string,
  mutation: (value: Record<string, string>) => void | Promise<void>,
): Promise<void> {
  // CLI、设置页和 session 可能位于不同 Node 进程；锁必须覆盖完整的
  // read-modify-write，单独原子 rename 只能防半写，不能防旧快照覆盖新 key。
  await withFileLock(filePath, async () => {
    const value = await readRawCredentialRecord(filePath);
    await mutation(value);
    await atomicWritePrivateTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  });
  const listeners = [...(credentialChangeListeners.get(filePath) ?? [])];
  // 同进程的 Registry Source 需要在登录返回前观察到新凭据；单个监听者失败不应
  // 把已经原子落盘的 Credential 伪装成写入失败。
  await Promise.allSettled(listeners.map((listener) => listener()));
}

/** 把 JSON 值校验为纯字符串字典；任何非对象/非字符串条目都抛错，防止写入结构漂移。 */
function parseCredentialRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Credential record must be an object");
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Credential record value must be a string: ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

/** 安全读取 error.code（Node 错误码）；不是字符串时返回 undefined。 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** key 去除首尾空白后必须非空；规范化结果用于落盘，避免出现 " key " 这类重复键。 */
function validateCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error("Credential key must not be empty");
  }
  return trimmed;
}

/** 空字符串凭据没有语义，直接拒绝；此处不做 trim，以免改变 token 原值。 */
function validateCredentialValue(value: string): string {
  if (value.length === 0) {
    throw new Error("Credential value must not be empty");
  }
  return value;
}

/** 展开 `~` / `~/` 为 home，其余按当前工作目录 resolve 成绝对路径。 */
function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

/** 类型守卫：非数组的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
