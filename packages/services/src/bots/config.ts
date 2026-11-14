// bots/config.ts — Bot 配置文件路径、默认值与持久化字段归一化。
//
// INV-01 文件名是持久化契约：v3 为当前写入目标，旧文件名只读不写；改名会让
//        存量用户的 Bot 配置因此“丢失”，且无法自动恢复。
// INV-02 归一化必须补齐 DEFAULT_BOT_COMMANDS 的所有键；缺键会让命令策略
//        退化成 undefined 并在授权处被误判。
// INV-03 已移除字段（cli）在归一化时丢弃，禁止再写回新配置。
// INV-04 凭据 key 的前缀是加密存储的命名空间，改动会导致旧凭据取不到。
import {
  DEFAULT_BOT_COMMANDS,
  DEFAULT_BOT_REPLY_GRANULARITY,
  modelSelectionSchema,
  normalizeBotReplyGranularity,
  type BotCurrentOptions,
  type BotDraftOptions,
  type BotCommandPolicy,
  type BotsConfigFile,
  type BotProvider,
} from "@zcode/shared";
// 绑定码有效期从 shared 透出，避免 Bot 层另立默认值。
export { BOT_BIND_CODE_TTL_MS } from "@zcode/shared";

// 回滚兼容：旧 App 对 Options 严格解析，旧文件仅作升级前快照，不得持续回写。
// BOTS_CONFIG_FILE 是当前写入目标；下面的旧文件只在迁移时读取。
export const BOTS_CONFIG_FILE = "bot-config.v3.json";
export const BOTS_LEGACY_CONFIG_FILE = "bot-config.json";
export const BOTS_LEGACY_STATE_FILE = "bot-state.json";
export const BOTS_V2_STATE_FILE = "bot-state.v2.json";
// BOTS_STATE_FILE 与配置分开存放，避免高频写入放大配置损坏面。
export const BOTS_STATE_FILE = "bot-state.v3.json";
// BOTS_MODEL_CACHE_FILE 是新文件名，旧名只由缓存层迁移读取。
export const BOTS_LEGACY_MODEL_CACHE_FILE = "bots-model-cache.json";
export const BOTS_MODEL_CACHE_FILE = "bots-model-cache.v2.json";
// 凭据命名空间前缀，见 INV-04。
const BOT_CREDENTIAL_PREFIX = "bot";

// 空配置：version 固定为 3，不预置任何 Bot。
export function createDefaultBotsConfig(): BotsConfigFile {
  return {
    // version 固定写成字面量 3：schema 靠该值判定 v3 文件，写错会让 readConfig 每次都误判为待迁移。
    version: 3,
    // 每次调用都新建空数组：调用方会直接往 bots 里 push，共享常量数组会让两次默认配置互相污染。
    bots: [],
  };
}

// 返回副本，避免调用方修改共享常量。
export function createDefaultBotCommands(): BotCommandPolicy {
  // 浅拷贝 DEFAULT_BOT_COMMANDS 已足够：命令策略是扁平映射，没有嵌套对象需要深拷贝。
  return { ...DEFAULT_BOT_COMMANDS };
}

// 历史配置可能缺键或带已删除的 cli 字段；这里逐键兜底（见 INV-02）。
export function normalizeBotCommandPolicy(
  commands: Partial<BotCommandPolicy> & { cli?: unknown } = {},
): BotCommandPolicy {
  // Bugfix: /cli 命令已经移除，历史 bot-config.json 里残留的 cli 字段不能继续被保存回新配置。
  return {
    // 先铺整张默认表再按键覆盖：shared 新增命令键时，旧配置自动获得默认值而不必改动这里。
    ...DEFAULT_BOT_COMMANDS,
    // ?? 只兜 undefined：false 表示用户显式关闭，换成 || 会把 false 当缺省而重新开启命令。
    status: commands.status ?? DEFAULT_BOT_COMMANDS.status,
    new: commands.new ?? DEFAULT_BOT_COMMANDS.new,
    workspace: commands.workspace ?? DEFAULT_BOT_COMMANDS.workspace,
    model: commands.model ?? DEFAULT_BOT_COMMANDS.model,
    mode: commands.mode ?? DEFAULT_BOT_COMMANDS.mode,
    thoughtLevel: commands.thoughtLevel ?? DEFAULT_BOT_COMMANDS.thoughtLevel,
    sandboxMode: commands.sandboxMode ?? DEFAULT_BOT_COMMANDS.sandboxMode,
    approvalPolicy: commands.approvalPolicy ?? DEFAULT_BOT_COMMANDS.approvalPolicy,
    // reply 存的是回复颗粒度而非开关，缺省时同样必须回落到 DEFAULT_BOT_COMMANDS 的取值。
    reply: commands.reply ?? DEFAULT_BOT_COMMANDS.reply,
  };
}

// currentOptions 只保留新字段；旧 model/thoughtLevel 在迁移器里读取一次。
export function normalizeBotCurrentOptions(
  options: Partial<BotCurrentOptions> & {
    cli?: unknown;
    model?: unknown;
    thoughtLevel?: unknown;
  } = {},
): BotCurrentOptions {
  // safeParse 而不是 parse：历史文件里的非法 modelSelection 只丢弃该项，不能因此让整个 Bot 读取失败。
  const parsedSelection = modelSelectionSchema.safeParse(options.modelSelection);
  const modelSelection = parsedSelection.success ? parsedSelection.data : undefined;
  // 旧 model/thoughtLevel 只在 Repository 的一次性导入读取，普通保存只认新字段。
  // Bugfix: /cli 命令移除后，历史 currentOptions.cli 只作为旧配置兼容读取，不再保存。
  return {
    ...(modelSelection ? { modelSelection } : {}),
    // mode/sandboxMode/approvalPolicy 只在有真值时展开：空串与 undefined 不写回，避免覆盖用户未触碰的默认。
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
  };
}

// 草稿选项同样只认 modelSelection；非法选择直接丢弃，不抛错。
export function normalizeBotDraftOptions(options: BotDraftOptions): BotDraftOptions {
  // 草稿可能来自前端未完成的编辑，modelSelection 非法时只丢弃该项，不阻断其他字段保存。
  const parsedSelection = modelSelectionSchema.safeParse(options.modelSelection);
  const modelSelection = parsedSelection.success ? parsedSelection.data : undefined;
  return {
    // provider 原样保留：它决定草稿归属的平台账号，改写会让草稿被下发到错误渠道。
    provider: options.provider,
    // 只回填校验通过的 modelSelection：把外部原始对象直接透传会让非法枚举混进草稿。
    ...(modelSelection ? { modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
}

// 未指定 provider 时返回全局默认颗粒度。
export function getDefaultBotReplyGranularity(provider?: BotProvider) {
  // 调用方未指定 provider 时回落到全局默认颗粒度；指定了则交给 shared 的 normalize，本层不另立默认值。
  return provider
    ? normalizeBotReplyGranularity(provider, undefined)
    : DEFAULT_BOT_REPLY_GRANULARITY;
}

// 凭据 key = bot:<botId>:credential。
export function buildBotCredentialKey(botId: string): string {
  // botId 直接拼进命名空间且不做转义：注册流程已限制其为安全字符，否则冒号会与其他 Bot 的凭据键相撞。
  return `${BOT_CREDENTIAL_PREFIX}:${botId}:credential`;
}

// webhook secret 与主凭据分开存放，便于单独轮换。
export function buildBotWebhookSecretKey(botId: string): string {
  // 后缀 webhook-secret 与 credential 分离，让回调密钥可独立轮换而不影响已存的主凭据。
  return `${BOT_CREDENTIAL_PREFIX}:${botId}:webhook-secret`;
}
