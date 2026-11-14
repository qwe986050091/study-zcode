import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";

// 前缀标记密文格式版本，读回时可区分历史明文与需要解密的值。
const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
// 选用 AES-256-GCM：加密同时校验完整性，篡改会在解密阶段直接失败。
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
// 12 字节 IV 是 GCM 的推荐长度，每次加密都重新随机生成。
const CREDENTIAL_CIPHER_IV_BYTES = 12;
// AuthTag 长度固定，解密前可先校验长度以尽早拒绝非法载荷。
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
// 允许部署方通过环境变量注入主密钥；未配置时回退到本机派生值。
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

// 加解密契约：已带前缀的值可解密，未加密输入按明文原样返回。
// `CredentialCipherProvider` 实现不得把明文或密钥写入日志与磁盘。
export interface CredentialCipherProvider {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
}

// 主密钥先做 SHA-256 归一为 32 字节，满足 AES-256 的密钥长度要求。
function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

// 优先使用显式配置的密钥；未配置时用平台、用户目录与用户名拼出本机密钥。
// 该回退只保证同一台机器可解密，不提供跨设备迁移能力。
function defaultCredentialSecret(env: NodeJS.ProcessEnv): string {
// 空字符串同样视为未配置，避免用空密钥产出看似有效的密文。
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

// 解密失败统一使用稳定前缀与错误码，调用方可据此触发重新录入凭据。
// `createCredentialDecryptError` 不携带密文细节，防止敏感内容进入日志。
function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

// 工厂创建时一次性派生密钥，后续加解密复用同一个 Buffer。
export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = options.env ?? process.env;
// 密钥在闭包内保持不可变，运行期替换会导致历史密文无法解开。
  const key = deriveCipherKey(defaultCredentialSecret(env));

  return {
// 输出格式为 前缀 + IV + AuthTag + 密文，四段以点号拼接。
    encrypt(value: string): string {
// IV 必须每次随机；重复使用会破坏 GCM 的安全保证。
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
// 空字符串是合法输入，此时密文长度为零，格式仍保留完整的三段载荷。
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
// AuthTag 必须在 final 之后取出，否则内容不完整。
      const authTag = cipher.getAuthTag();

      return [
        ENCRYPTED_VALUE_PREFIX,
        bufferToBase64url(iv),
        ".",
        bufferToBase64url(authTag),
        ".",
        bufferToBase64url(encrypted),
      ].join("");
    },

// 未带前缀的值视为历史明文，原样返回以兼容旧数据。
    decrypt(value: string): string {
      if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return value;
      }

// 去掉前缀后按点号切分为 IV、AuthTag、密文三段。
      const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      // Bug 根因：AES-GCM 加密空字符串时 cipherText 合法地为空，编码结果以点号结尾。
      // 旧判定把空 cipherRaw 当成缺字段，Provider Sync 为无 API Key 条目保存 journal 后
      // 就无法解密，连 before 回滚也会 fail-closed；这里只拒绝真正缺失的第三段。
// 只拒绝真正缺失的字段；空密文段是加密空字符串的合法结果。
      if (!ivRaw || !authTagRaw || cipherRaw === undefined || parts.length !== 3) {
        throw createCredentialDecryptError("密文格式非法");
      }

// 先解码再逐项校验长度，长度不符说明载荷被截断或拼接错误。
      const iv = base64urlToBuffer(ivRaw);
      const authTag = base64urlToBuffer(authTagRaw);
      const cipherText = base64urlToBuffer(cipherRaw);

// IV 长度异常直接失败，不尝试用错误参数解密。
      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw createCredentialDecryptError("IV 长度非法");
      }

      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw createCredentialDecryptError("AuthTag 长度非法");
      }

// 解密器绑定算法与 IV；随后注入 AuthTag 才能校验完整性。
      const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      try {
        const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return plainText.toString("utf-8");
      } catch {
// 统一转成带错误码的异常，避免向上暴露底层 crypto 的错误文本。
        throw createCredentialDecryptError("密钥不匹配或密文已损坏");
      }
    },
  };
}
