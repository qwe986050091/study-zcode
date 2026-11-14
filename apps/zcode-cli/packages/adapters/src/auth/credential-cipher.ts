import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";

/*
 * ============================================================
 * auth / credential-cipher.ts —— 本地凭据值加密（AES-256-GCM）
 *
 * 定位：把要写入磁盘的凭据值转为 `enc:v1:` 前缀的自描述密文，供 shared-credentials
 * 统一加解密；明文值原样透传，兼容历史未加密条目。
 *
 * 输入输出：encrypt 返回 enc:v1:<iv>.<tag>.<ciphertext>（base64url 三段）；
 * decrypt 对非 enc:v1: 值直接返回原文，对密文要求格式/长度合法。
 *
 * 副作用：仅读取环境变量 ZCODE_CREDENTIAL_SECRET 与 OS 用户信息来派生密钥，无网络/IO。
 *
 * 失败语义：密文格式错误、IV/tag 长度错误、GCM 校验失败（密钥不匹配或密文损坏）一律
 * 抛出，绝不返回空串——凭据层必须 fail closed。
 *
 * 不变量：密钥由 sha256(secret) 派生；未配置 secret 时退化为“平台+home+用户名”的
 * 本机绑定字符串，换机/换用户后旧密文将无法解密。
 * ============================================================
 */

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

export interface ZCodeCredentialCipher {
  /** 解密 enc:v1: 值；非加密值原样返回，格式/密钥错误抛错。 */
  decrypt(value: string): string;
  /** 加密任意明文字符串；每次使用随机 IV，同一明文输出不同密文。 */
  encrypt(value: string): string;
}

export interface ZCodeCredentialCipherOptions {
  /** 注入环境变量源（测试用）；缺省读 process.env。 */
  env?: Record<string, string | undefined>;
}

/**
 * 创建凭据加解密器，密钥在构造时一次性派生。
 *
 * 明文→密文使用 AES-256-GCM（随机 12 字节 IV + 16 字节 auth tag），decrypt 遇到非加密
 * 前缀直接返回原值以兼容旧数据。无文件/网络副作用。
 *
 * 失败语义：密钥不匹配、密文损坏、格式不合法都抛出具体错误，由上层 fail closed，
 * 不回退到明文或空值。
 */
export function createZCodeCredentialCipher(
  options: ZCodeCredentialCipherOptions = {},
): ZCodeCredentialCipher {
  const key = deriveCipherKey(resolveCredentialSecret(options.env ?? process.env));

  return {
    decrypt(value: string): string {
      if (!isEncryptedZCodeCredentialValue(value)) {
        return value;
      }

      const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      // 段数必须恰为 3：多/少一段都说明写入端已损坏，宁可抛错也不能猜。
      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }

      const iv = Buffer.from(ivRaw, "base64url");
      const authTag = Buffer.from(authTagRaw, "base64url");
      const cipherText = Buffer.from(cipherRaw, "base64url");

      // 固定长度校验可提前区分“换了算法版本”与“密钥/内容损坏”。
      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw new Error("Credential decrypt failed: invalid IV length");
      }
      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw new Error("Credential decrypt failed: invalid auth tag length");
      }

      try {
        const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return plainText.toString("utf-8");
      } catch (error) {
        // GCM 认证失败 = 密钥不匹配或密文被篡改；保留 cause 便于诊断但绝不降级。
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
          cause: error,
        });
      }
    },

    encrypt(value: string): string {
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        ENCRYPTED_VALUE_PREFIX,
        iv.toString("base64url"),
        ".",
        authTag.toString("base64url"),
        ".",
        encrypted.toString("base64url"),
      ].join("");
    },
  };
}

/** 判断值是否为本模块产生的密文；仅看前缀，不做长度/格式校验。 */
export function isEncryptedZCodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

/** 用 sha256 把任意长度 secret 压成 32 字节 AES key，避免直接使用原始口令。 */
function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * 解析加密 secret：优先 ZCODE_CREDENTIAL_SECRET（trim 后非空）。
 * 未配置时退化为本机标识串，保证同一台机器/用户可解密，但不提供跨机可移植性。
 */
function resolveCredentialSecret(env: Record<string, string | undefined>): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Some packaged or sandboxed runtimes cannot resolve OS user info.
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}
