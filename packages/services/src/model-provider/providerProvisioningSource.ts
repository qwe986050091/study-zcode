import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  providerProvisioningEnvelopeSchema,
  type ProviderProvisioningCredentialEntry,
  type ProviderProvisioningEnvelope,
} from "@zcode/shared";
import type {
  PersonalProviderConfigRepository,
  ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "../credential/providers/credentialCipherProvider.js";
import type { ISettingService } from "../setting/setting.js";

// INV-01：本文件只产出「可同步事实」，绝不导出完整 Registry Snapshot：Provider/Model 的
// 系统禁用原因、Catalog enrichment 等本地派生值一旦回传，会在目标端覆盖远端权威配置。
// INV-02：一轮同步内的所有读取必须同源，禁止把两次读取拼成一个并不存在的配置版本。
const CREDENTIAL_FILE_NAME = "credentials.json";
// 这份 allowlist 同时是「传输白名单」和「删除语义边界」：目标端按它做 replace-allowlist，
// 新增 key 必须同时出现在这里，否则会被静默忽略。
// 只覆盖 OAuth 登录态；Personal Provider 的 API Key 走 Personal Config，不在此列。
export const PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "zcodejwttoken",
] as const;

// syncId 是幂等键：同一 syncId 重复投递时目标端返回 already-applied，不会重放写入。
export interface ProviderProvisioningSource {
  read(syncId: string): Promise<ProviderProvisioningEnvelope>;
}

// personalRepository 与 personalConfigFilePath 必须指向同一份文件：前者提供带 revision 的内存快照，
// 后者用于确认磁盘内容未漂移；两者错配会让 revision 永远对不上。
export interface ProviderProvisioningSourceOptions {
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly settingService: ISettingService;
  readonly credentialFilePath: string;
  readonly personalConfigFilePath: string;
  readonly cipherProvider?: CredentialCipherProvider;
}

/** 从 Local Environment 读取可 Provision 的事实；不会读取或导出完整 Registry Snapshot。 */
// 三个来源并发读取：Personal 文件、账号设置、凭据文件互不依赖，串行会把首次同步延迟叠加。
// [失败路径] 任一读取失败即整体抛出，Host 把本轮视为未同步，不推进 syncId。
export function createProviderProvisioningSource(
  options: ProviderProvisioningSourceOptions,
): ProviderProvisioningSource {
  return {
    async read(syncId: string): Promise<ProviderProvisioningEnvelope> {
// personal 的读取带 revision 校验（见 readProvisionablePersonalConfig），
// 保证 personalConfig 内容与其 revision 描述同一份文件。
      const [personal, settings, credentials] = await Promise.all([
        readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
        options.settingService.get(),
        readProvisioningCredentials(options.credentialFilePath, options.cipherProvider),
      ]);
      // 默认与规则来自同一份持锁读取，不能把两次读取的值拼成不存在的配置版本。
// 编码一次得到线格式，不把内部类实例塞进协议；目标端用同一 codec 解码，口径唯一。
      const personalConfig = encodeProviderConfigFile(personal).config;
// 只同步账号域与连接选择两项：其余设置属于本机偏好（主题、语言等），
// 推送过去会覆盖目标端用户自己的选择。
      const accountSettings = {
        providerFamilyDomain: settings.providerFamilyDomain ?? null,
        providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
      };
// schemaVersion 固定 2：目标端按版本忽略未知字段，解析失败说明本地事实越界，直接抛出。
      return providerProvisioningEnvelopeSchema.parse({
        schemaVersion: 2,
        syncId,
        personalConfig,
        accountSettings,
        credentials,
      });
    },
  };
}

/** 分发读取不能把坏文件的内存降级当成权威；Source 与 Target 使用同一完整读取约束。 */
// 两步读取：先取 Repository 的内存快照，再读磁盘原文做 revision 对齐。
// [权衡] 多一次文件读换来「同步出去的内容确实已落盘」；只用内存快照会把尚未 flush
// 的修改当作权威事实，目标端可能先于本机看到新配置。
export async function readProvisionablePersonalConfig(
  repository: PersonalProviderConfigRepository,
  filePath: string,
): Promise<ProviderConfigLayerSnapshot> {
// 先读内存再读磁盘：磁盘读失败时，内存快照用于判断是否为「合法空配置」。
  const personal = await repository.read();
  let raw: string;
  try {
// 读原文而不是信任 Repository 的缓存：只有原文与 revision 对得上，
// 才能证明「即将同步出去的内容已经落盘」。
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
// 首次启动没有 Personal 文件是正常状态；只有内存也确实为空时才允许返回空快照，
// 文件已存在内容却消失属于故障，必须让调用方看到错误。
      const rules = personal.models.toPersonalJSON();
      // 首次尚无 Personal 文件是合法空配置；已有内容后文件消失不能继续导出旧快照。
      if (
        personal.providers.keys().length === 0 &&
        rules.providerModelRules.length === 0 &&
        rules.manualProviderModelRules.length === 0 &&
        !personal.providerOrder?.length &&
        personal.defaultModelSelection === undefined
      )
        return personal;
    }
    throw new Error(`本地 Personal Provider Config 无法同步: ${filePath}`, { cause: error });
  }
  try {
// 用正规 codec 往返编码后算 sha256，与 Repository 的 revision 口径完全一致，
// 因此「文件被其它进程改过」能在推送前发现，而不是把旧快照发给目标端。
// [并发] 这里不加文件锁：检测到不一致就失败，下一轮重试，避免与 Repository 形成锁序依赖。
    const decoded = decodeProviderConfigFile(JSON.parse(raw) as unknown);
    const actualRevision = createHash("sha256")
      .update(JSON.stringify(encodeProviderConfigFile(decoded)))
      .digest("hex");
// [失败路径] 不一致时抛错并由外层包装；不重读重试，重读仍可能落在下一次写入的中间态。
    if (actualRevision !== personal.revision) {
      throw new Error("Personal Provider Config 在读取期间发生变化");
    }
    return personal;
  } catch (error) {
    throw new Error(`本地 Personal Provider Config 无法同步: ${filePath}`, { cause: error });
  }
}

// Credential Store 是加密 JSON，值必须是 cipher 可解的字符串；
// 只返回 allowlist 内且解密后非空的条目——空串代表用户已登出，不能当作有效凭据。
async function readProvisioningCredentials(
  credentialFilePath: string,
  cipherProvider?: CredentialCipherProvider,
): Promise<ProviderProvisioningCredentialEntry[]> {
  let raw: string;
  try {
    raw = await readFile(credentialFilePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Credential Store 必须是 JSON 对象");
  }
// cipher 可注入：测试用固定实现避免依赖钥匙串；生产默认取本机 Credential Cipher。
// 解密失败会直接抛出，宁可本轮不同步，也不能把密文当成明文 Secret 传出去。
  const cipher = cipherProvider ?? createCredentialCipherProvider();
// 每轮新建 Set：allowlist 是常量，但避免调用方修改共享集合影响后续同步。
  const allowedKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const entries: ProviderProvisioningCredentialEntry[] = [];
  // Credential Store 还可能包含不属于 Provisioning allowlist 的历史记录；
  // 这些记录不是本次同步事实，不能因为其值损坏而阻断合法账号凭据的同步。
  // allowlist 内的条目仍保持字符串和解密校验，避免把未知内容当成 Secret 传输。
// 遍历整个 Store 而不是按键取：缺失的 key 直接不出现，目标端据此把「未提供」理解为删除。
  for (const [key, encrypted] of Object.entries(parsed)) {
    // OAuth 换证不再依赖旧账号 Key；它的坏密文也不能阻断远端登录态同步。
    if (!allowedKeys.has(key)) continue;
// allowlist 内的条目仍做强类型校验：非字符串说明 Store 被外部改写，必须暴露而不是跳过。
    if (typeof encrypted !== "string") {
      throw new Error(`Credential allowlist value must be a string: ${key}`);
    }
    const value = cipher.decrypt(encrypted);
    if (!value.trim()) continue;
    entries.push({ scope: "oauth-session", key, value });
  }
  return entries;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

// 只认 ENOENT：EACCES/EPERM 等同样代表「读不到」，但语义是故障而非「尚无文件」。
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// Credential 文件与 config.json 同目录，两端必须用同一函数解析，避免路径口径漂移。
export function resolveCredentialFilePath(appConfigDir: string): string {
  return join(appConfigDir, CREDENTIAL_FILE_NAME);
}

/** 只枚举 Provisioning allowlist 的物理 key，供目标端实现 replace-allowlist 删除语义。 */
// 目标端的 replace-allowlist 删除语义需要知道源端当前存在哪些 key；
// 这里只返回 allowlist 交集，防止把本地其它凭据的 key 暴露给远端。
// 与 read 不同，本函数只列 key 不解密：删除判定不需要凭据明文。
export async function listProviderProvisioningCredentialKeys(
  credentialFilePath: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(credentialFilePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Credential Store 必须是 JSON 对象");
  const oauthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  return Object.keys(parsed).filter((key) => oauthKeys.has(key));
}
