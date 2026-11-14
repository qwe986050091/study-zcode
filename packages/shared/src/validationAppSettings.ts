/* oxlint-disable eslint(max-lines) -- AppSettings schema 聚合历史迁移、默认值和 patch 校验，拆分会削弱设置迁移的单一入口。 */
// validationAppSettings（shared）深注：设置 schema 是读取容错与写入严格的唯一分界线。
// 做：定义设置形状、默认值、读取期迁移与 patch 校验；对外只导出 schema 与枚举。
// 不做：不读写文件、不做 IO、不决定 UI 展示；迁移只返回新对象，不持久化。
// 依赖：zod、其他域 schema 与枚举常量；所有迁移必须纯函数，可重复执行。
// 边界：读取路径要容错（坏字段丢弃），写入路径要严格（坏值拒绝），二者不能共用一份宽松规则。
// 边界：本文件同时服务 Desktop main、renderer 与 server，改动等于跨进程协议变更。
//
// INV-01 断言：完整 schema 必须声明所有可持久化字段 —— 守住它的位置：appSettingsObjectSchema —— 改错故障：显式 false 被剥离，重启后回到默认值。
// INV-02 断言：patch 与完整 schema 的字段集保持同步 —— 守住它的位置：appSettingsPatchSchema —— 改错故障：patch 接受但读取丢弃，改动看似成功实际不生效。
// INV-03 断言：locale 与 localePreference 是两个独立事实 —— 守住它的位置：migrateLegacyLocalePreference —— 改错故障：无法区分用户显式选择与默认值，升级后误切 system。
// INV-04 断言：每个迁移都必须幂等 —— 守住它的位置：各 migrate* 的 marker 判定 —— 改错故障：每次读取都重置用户选择。
// INV-05 断言：marker 缺省值必须与未迁移语义一致 —— 守住它的位置：initialized 字段判定 —— 改错故障：老配置被当成已迁移，迁移永不执行。
// INV-06 断言：读取阶段只丢弃坏字段，不让整份设置回退 —— 守住它的位置：sanitize* 函数 —— 改错故障：一个坏偏好清空全部用户设置。
// INV-07 断言：patch 写入保持严格校验 —— 守住它的位置：patch schema —— 改错故障：坏值通过 patch 持续落盘，读取时才暴露。
// INV-08 断言：preprocess 的组合顺序固定且不可随意重排 —— 守住它的位置：appSettingsSchema —— 改错故障：后续迁移读到前一步尚未归一的结构。
// INV-09 断言：lastWorkspaceSession 是会话唯一真相源 —— 守住它的位置：migrateLegacyWorkspaceSession —— 改错故障：新旧字段并存，列表与恢复分叉。
// INV-10 断言：迁移完成后必须 delete 旧字段 —— 守住它的位置：migrated 收尾 —— 改错故障：下次读取再次迁移，产生重复条目。
// INV-11 断言：历史资源包 ID 必须先剥离再解析 —— 守住它的位置：stripHistoricalRemoteResourcePackages 调用点 —— 改错故障：旧 ID 让整条远程历史被丢弃。
// INV-12 断言：内置 Agent CLI provider 统一归一为 ZCode Agent —— 守住它的位置：transform —— 改错故障：旧 provider 状态与 server 侧唯一状态打架。
// INV-13 断言：remoteBoundaryOnboardingVersion 迁移并回写旧值 2 —— 守住它的位置：migrateRemoteBoundaryIntroAcknowledgement —— 改错故障：旧客户端读到 3 后整份设置回退默认。
// INV-14 断言：taskAutoArchive 首次读取只重置一次 —— 守住它的位置：resetVersion 判定 —— 改错故障：升级启动时突然归档历史会话。
// INV-15 断言：初始化标记必须与值在同一次迁移里写入 —— 守住它的位置：closeToTray 与 reasoning 迁移 —— 改错故障：下次读取再次覆盖用户手动选择。
// INV-16 断言：zcodeEndpointOrigin 坏值只删字段 —— 守住它的位置：sanitizeZCodeEndpointOrigin —— 改错故障：开发辅助字段拖垮生产设置读取。
// INV-17 断言：desktopWindowSize 校验失败只丢弃该字段 —— 守住它的位置：sanitizeDesktopWindowSize —— 改错故障：窗口尺寸坏值让所有设置回退默认。
// INV-18 断言：枚举容错用 optional 与 catch，不整体拒绝 —— 守住它的位置：dynamicWorkflowMode —— 改错故障：新版本写的枚举让旧版本读不了整份设置。
// INV-19 断言：remoteStartupAutoReconnectEnabled 必须 optional 而非 default —— 守住它的位置：两套 schema —— 改错故障：缺省被写成 false，用户的显式设置被覆盖。
// INV-20 断言：nonEmptyStringSchema 统一 trim —— 守住它的位置：共享字符串规则 —— 改错故障：纯空白通过校验，后续路径拼接产生空段。
//
// 阅读提示：先判断当前改动落在读取路径还是写入路径，两条路径的容错策略相反。
// 迁移原则：只补字段、不删用户数据；无法理解的旧值宁可保留原样，也不要猜测。
// 失败语义：迁移函数不得抛错；schema 解析失败由调用方决定回退，本文件不决定。
// 可观测性：迁移本身不打日志，调用方通过字段变化或 marker 判断是否发生过迁移。
// 改动前自检：新增字段是否同时进了完整 schema 与 patch schema？默认值是否与旧行为一致？
// 改动前自检：迁移是否用 marker 保证只执行一次？执行后是否删除被替代的旧字段？
// 改动前自检：是否把容错逻辑加到了 patch 上，让非法值获得持久化通道？
// 权衡：读取期容错削弱了 schema 的严格性，但换来单字段损坏不炸整份设置。
// 结束：正文按声明顺序给出，锚点落在语句或对象属性之间，不进入表达式内部。
// 注意：本文件被跨进程复用，任何字段语义变化都视为协议变更，必须同步检查调用方。
import { z } from "zod";
import { appToolSearchModeSchema } from "./app-runtime-preferences.js";
import type { AppSettings } from "./protocol.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import { wslUserSchema } from "./wslUserValidation.js";
import { ZCODE_ENABLED_AGENT_PROVIDERS } from "./zcode-agent-policy.js";
import { DYNAMIC_WORKFLOW_MODES } from "./dynamic-workflow-feature.js";
import { normalizeZCodeEndpointOrigin } from "./zcodeEndpoint.js";
import {
  DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  embeddedBrowserViewportPreferenceSchema,
} from "./browser-use/command-metadata.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";
import {
  connectionProfileSchema,
  sourceServerRecordSchema,
  sourceServerWorkspaceHistoryEntrySchema,
} from "./source-server/contracts.js";

/** 引导职业枚举；单独导出供 onboarding 记录回填 settings 时做窄化校验。 */
// [契约] 职业枚举是 onboarding 回填的窄化入口，新增取值必须同步导出枚举。
// [契约] 该枚举不做容错：未知职业在完整 schema 里用 nullish 处理，而不是在这里放宽。
const appSettingsOccupationSchema = z.enum([
  "office",
  "developer",
  "independent",
  "infrastructure",
  "product",
  "design",
  "student",
  "creator",
  "operations",
  "marketing",
  "finance",
  "accounting",
  "legal",
  "other",
]);
export const appSettingsOccupationEnum = appSettingsOccupationSchema;

// [契约] 共享字符串规则先 trim 再判长度，避免纯空白通过校验。
// [契约] 不要在这里加 transform 改写大小写：调用方依赖原值。
// [边界] trim 后为空表示字段无效，不要把空串当成清空指令，删除语义只属于 patch 哨兵。
const nonEmptyStringSchema = z.string().trim().min(1);

// [契约] locale 是实际生效语言，取值集合必须与 i18n 资源一致。
// 它不是偏好：偏好见 localePreference，两者不能互相替代。
// [契约] 新增语言要同时改这里与 resolveLocale，否则读到新值会被判非法。
export const localeSchema = z.enum(["zh-CN", "en-US"]);
// [契约] preference 允许 system，表示跟随系统而不是固定语言。
// [契约] 它不能从 locale 推导：旧配置迁移时必须保留用户显式选择。
export const localePreferenceSchema = z.enum(["system", "zh-CN", "en-US"]);
// [契约] 交互行为只有排队与引导两种，新增取值会改变输入 admission 语义。
// [边界] 该枚举不做 catch：非法值应被丢弃而不是静默改语义。
const zcodeInteractionBehaviorSchema = z.enum(["queue", "guide"]);
// launch.md「The user's choice」：读文件时未知取值（降级后读到新版本写的值）按「跟随」处理，
// 不能让一个偏好字段把整份设置读坏。
// [契约] catch(undefined) 是刻意的：旧版本读到新枚举时必须退回跟随，而不是整份设置失败。
// optional 与 catch 缺一不可：前者允许缺省，后者吸收降级读到的未知值。
// [边界] 空串不是这里的合法值：空串哨兵只存在于 patch schema。
const dynamicWorkflowModeSettingSchema = z.enum(DYNAMIC_WORKFLOW_MODES).optional().catch(undefined);
// [契约] 发布通道影响更新源，取值必须与 main 进程的通道解析一致。
// [边界] 这里只声明形状，不决定默认通道。
const electronReleaseChannelSchema = z.enum(["stable", "preview"]);
// [契约] 缩放上下限与 Electron zoomLevel 语义绑定，不能只按 UI 需求放宽。
// [契约] 必须是整数：小数缩放会让窗口尺寸计算出现非整数像素。
const desktopZoomLevelSchema = z.number().int().min(-3).max(5);
// [契约] 宽高下限是窗口可用性的硬约束，不是视觉偏好。
// [契约] maximized 必须显式存在：缺省无法区分从未保存与保存为普通态。
const desktopWindowSizeSchema = z.object({
  width: z.number().int().min(480),
  height: z.number().int().min(640),
  maximized: z.boolean(),
});
// [契约] 用 discriminatedUnion 而不是 union：非法 mode 需要快速失败且错误可读。
// [契约] shell 模式下的 id、label、path 都不可为空，缺一无法还原选择。
// [边界] auto 模式不接受额外字段，避免两种模式的状态混存。
export const integratedTerminalShellSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("auto"),
  }),
  z.object({
    mode: z.literal("shell"),
    dialect: z.enum(["cmd", "git-bash"]),
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  }),
]);
// [契约] 历史枚举保留在输入侧，是为了能读懂旧配置文件。
// transform 无条件归一为 ZCode Agent：输出侧永远只有唯一 provider。
// [事务] 归一必须发生在 schema 层：UI 与 bot 各自过滤会产生第二份事实。
const enabledBuiltinAgentCliProvidersSchema = z
  // 兼容旧 settings：历史列表可能残留三方 CLI provider，解析后统一归一为 ZCode Agent。
  .array(z.enum(["claude", "opencode", "gemini", "codex", "glm"]))
  .transform(() => [...ZCODE_ENABLED_AGENT_PROVIDERS]);
// [契约] 域值决定请求路由，不能由界面文案推导。
// [边界] 可选性由使用处声明，这里只定义取值集合。
const providerFamilyDomainSchema = z.enum(["zai", "bigmodel"]);

// [契约] 更新说明载荷来自远端，字段必须全部非空才可展示。
// releaseNotesByLocale 用 partialRecord：允许只提供部分语言，缺失时回退主文案。
// [边界] 该 schema 只校验形状，不校验 markdown 安全性。
export const postUpdateReleaseNotesPayloadSchema = z.object({
  version: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  markdown: nonEmptyStringSchema,
  releaseDate: nonEmptyStringSchema.optional(),
  releaseNotesByLocale: z
    .partialRecord(
      localeSchema,
      z.object({ title: nonEmptyStringSchema, markdown: nonEmptyStringSchema }),
    )
    .optional(),
});

// [契约] 跳过版本按通道分组，不能合并成一个列表。
// default({}) 保证缺省即空映射：读取方不需要判 undefined。
// [边界] 值是非空版本字符串，空串视为非法而不是清空记录。
const skippedElectronUpdateVersionsSchema = z
  .partialRecord(electronReleaseChannelSchema, nonEmptyStringSchema)
  .default({});

// [契约] 四种 kind 的字段互不复用，新增 kind 必须同步解析与连接入口。
// ssh 的 port 可选但一旦给出必须落在 1 到 65535；越界值不能被静默忽略。
// [契约] wsl 的 user 复用 wslUserSchema：设置入口与连接入口必须同一套校验。
// [边界] resourcePackages 只在这里声明形状，历史裁剪由 strip 函数负责。
const remoteWorkspaceTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ssh"),
    host: nonEmptyStringSchema,
    port: z.number().int().positive().max(65535).optional(),
    username: nonEmptyStringSchema,
    sshConfigAlias: nonEmptyStringSchema.optional(),
    privateKeyPath: z.string().optional(),
    assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
    resourcePackages: z
      .object({
        selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
      })
      .optional(),
    passwordCredentialKey: nonEmptyStringSchema.optional(),
    privateKeyPassphraseCredentialKey: nonEmptyStringSchema.optional(),
  }),
  z.object({
    kind: z.literal("wsl"),
    distro: z.string().optional(),
    // 远程历史重连会直接使用 settings 中的 WSL user，必须和连接入口共用校验，避免绕过 UI 后污染 identity/日志。
    user: wslUserSchema.optional(),
  }),
  z.object({
    kind: z.literal("docker"),
    container: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal("server"),
    url: z.string().url(),
    name: nonEmptyStringSchema.optional(),
    workspacePath: z.string().optional(),
    serverId: nonEmptyStringSchema.optional(),
    tokenCredentialKey: nonEmptyStringSchema.optional(),
  }),
]);

// [契约] local 与 remote 是两个结构，不要用可选字段强行合并。
// workspacePurpose 有默认值：缺省视为 project，而不是 conversation。
// [契约] remote 的 lastConnectionStatus 必须存在：恢复 UI 依赖它决定是否重连。
const appWorkspaceSessionEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    workspacePath: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).default("project"),
  }),
  z.object({
    kind: z.literal("remote"),
    workspacePath: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).default("project"),
    localWorkspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    target: remoteWorkspaceTargetSchema,
    lastOpenedAt: z.number().int().nonnegative(),
    lastConnectionStatus: z.enum(["connected", "failed"]),
    lastConnectionError: z.string().optional(),
  }),
]);

// [契约] 设备三元组缺一不可：deviceSid、userId、endpointOrigin 共同构成身份。
// [边界] 这里不做 endpoint 规范化，规范化由 endpoint schema 负责。
const webRemoteControlRelayV2DeviceSchema = z.object({
  deviceSid: z.string().min(1),
  userId: z.string().min(1),
  endpointOrigin: z.url(),
});
// [契约] strict 是刻意的：该记录不允许未知字段，避免历史脏数据继续扩散。
// [契约] lastResolvedAt 用非负整数，单位是毫秒时间戳。
const remoteConversationWorkspaceRecordSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    lastResolvedAt: z.number().int().nonnegative(),
  })
  .strict();

// [契约] 外部中继设备只能有 deviceSid：多一个字段都会扩大身份面。
// [边界] 与 relay v2 设备分开声明，不能共用一个松散 schema。
const webRemoteControlExternalRelayDeviceSchema = z.object({
  deviceSid: nonEmptyStringSchema,
});
// [契约] workspacePath 必填，identity 与 initialTaskId 可选。
// [边界] 该记录只用于恢复上次开启上下文，不承担路由判定。
const webRemoteControlLastEnabledContextSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  initialTaskId: nonEmptyStringSchema.optional(),
});
// [契约] 非字符串、空白、规范化失败统一归一为 undefined，再由 optional 吸收。
// 规范化在 preprocess 内完成：下游拿到的一定是规范化后的 origin。
// [失败路径] catch 只吞规范化异常，不吞类型错误之外的逻辑错误。
const zcodeEndpointOriginSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return normalizeZCodeEndpointOrigin(trimmed);
  } catch {
    return undefined;
  }
}, z.string().optional());

// [契约] 只在字段存在时处理，缺字段必须原样返回同一引用。
// 解析成功才替换，失败时整字段删除：坏 endpoint 不能拖垮整份设置。
// [契约] 返回新对象而不是修改入参：迁移链上游可能仍持有旧引用。
// [边界] 该字段是开发辅助，删除比报错更符合用户预期。
function sanitizeZCodeEndpointOrigin(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("zcodeEndpointOrigin" in raw)) {
    return value;
  }
  const parsed = zcodeEndpointOriginSchema.safeParse(raw.zcodeEndpointOrigin);
  if (parsed.success && typeof parsed.data === "string") {
    return { ...raw, zcodeEndpointOrigin: parsed.data };
  }
  const { zcodeEndpointOrigin: _zcodeEndpointOrigin, ...next } = raw;
  // 非生产 endpoint override 是开发辅助字段，坏值只丢弃该字段，不能拖垮整个 settings 读取。
  return next;
}

// [契约] 非对象或非数组检查必须都在，数组也是 object 但语义不同。
// 字段缺失时原样返回；存在但非法时只删该字段。
// [契约] 读取容错与写入严格必须分开：patch 仍会拒绝非法尺寸。
// [边界] 这里不修正数值，只丢弃：猜测窗口尺寸会制造新的不一致。
function sanitizeDesktopWindowSize(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("desktopWindowSize" in raw)) {
    return value;
  }
  const parsed = desktopWindowSizeSchema.safeParse(raw.desktopWindowSize);
  if (parsed.success) {
    return value;
  }
  const { desktopWindowSize: _desktopWindowSize, ...next } = raw;
  // 窗口尺寸是非关键偏好，坏值若参与整份 schema 校验，会让其他合法设置全部回退默认。
  // 读取历史设置时只丢弃损坏字段；写入 patch 仍保持严格校验，避免继续产生坏数据。
  return next;
}

// [契约] 与窗口尺寸同构：坏值只丢字段，不整份回退。
// 解析用独立 schema，保证与写入侧同一套约束。
// [事务] 删除字段后由完整 schema 的 default 补齐默认视口。
// [边界] 显示偏好不影响启动，容错尺度可以比关键设置更宽。
function sanitizeEmbeddedBrowserViewportPreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("embeddedBrowserViewportPreference" in raw)) {
    return value;
  }
  const parsed = embeddedBrowserViewportPreferenceSchema.safeParse(
    raw.embeddedBrowserViewportPreference,
  );
  if (parsed.success) {
    return value;
  }
  const { embeddedBrowserViewportPreference: _embeddedBrowserViewportPreference, ...next } = raw;
  // 显示偏好不是关键启动状态，单字段损坏不应让整份 setting.json 被隔离。
  // 读取时只丢弃坏偏好并回到默认值；patch 写入仍严格拒绝非法尺寸与缩放。
  return next;
}

// [事务] 只在版本恰为 3 时迁移：其它值保持原样，避免重复改写。
// 迁移同时回写旧字段为 2，让旧客户端仍能读懂这份配置。
// [契约] 不能改成只收窄 schema：修复版读取存量 3 时会把整份设置判非法。
function migrateRemoteBoundaryIntroAcknowledgement(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.remoteBoundaryOnboardingVersion !== 3) return value;
  // 原因：旧客户端只接受 2，写 3 会让整份设置回退默认值。迁移已确认的 3 到新字段，
  // 同时恢复旧字段合同；不能仅收窄 schema，否则修复版读取存量 3 也会丢设置。
  return {
    ...raw,
    remoteBoundaryOnboardingVersion: 2,
    remoteBoundaryIntroAcknowledgedVersion: 1,
  };
}

// [事务] 用 resetVersion 保证只重置一次，之后尊重用户选择。
// 首次读取统一关闭自动归档：避免修复后启动即归档历史会话。
// [契约] 重置与标记必须同一次返回，分两步会出现已重置但未标记的窗口。
function migrateTaskAutoArchiveReset(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.taskAutoArchiveResetVersion === 1) return value;
  // 旧版开关开启后可能未执行；修复后直接沿用会在启动时突然归档历史会话。
  // 首次读取统一关闭并持久化标记，用户重新开启后不再重置。
  return { ...raw, taskAutoArchiveEnabled: false, taskAutoArchiveResetVersion: 1 };
}

// [事务] 标记为 true 即视为已迁移，直接返回原值。
// 首次迁移统一开启一次，并同时写入初始化标记。
// [契约] 不能只改默认值：默认值无法覆盖已落盘的 false。
function migrateCloseToTrayOnWindowsDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (raw.closeToTrayOnWindowsMigrationInitialized === true) {
    return value;
  }
  return {
    ...raw,
    // 初始化原因：旧版会把默认 false 和用户手动关闭都保存成同一个值，无法可靠区分。
    // 本版本统一开启一次；写入迁移标记后，后续再按用户明确选择保留 true/false。
    closeToTrayOnWindows: true,
    closeToTrayOnWindowsMigrationInitialized: true,
  };
}

// [事务] 与 closeToTray 同构：初始化标记决定是否再迁移。
// 首次统一开启思考过程展示，之后按用户显式选择保留。
// [契约] 两个迁移的 marker 必须独立，不能共用同一个 initialized 字段。
function migrateMessageStreamShowReasoningDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (raw.messageStreamShowReasoningMigrationInitialized === true) {
    return value;
  }
  return {
    ...raw,
    // 初始化原因：旧版会把默认 false 和用户手动关闭都保存成同一个值，无法可靠区分。
    // 本版本统一开启一次；写入迁移标记后，后续再按用户明确选择保留 true/false。
    messageStreamShowReasoning: true,
    messageStreamShowReasoningMigrationInitialized: true,
  };
}

// [事务] 只在有 locale、无 localePreference 时迁移。
// 旧 locale 解析成功才当作显式偏好，失败则保持原样。
// [契约] 不能把 locale 与 preference 合并：否则无法区分显式选择与默认。
function migrateLegacyLocalePreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as Record<string, unknown>;
  if ("localePreference" in raw || !("locale" in raw)) {
    return value;
  }

  const parsedLocale = localeSchema.safeParse(raw.locale);
  if (!parsedLocale.success) {
    return value;
  }

  return {
    ...raw,
    // 旧 setting.json 只有 locale，无法区分“用户显式选择 zh-CN”和“默认值 zh-CN”。
    // 对已经落盘的旧配置保留原 locale 作为显式偏好，避免升级后误切到 system。
    localePreference: parsedLocale.data,
  };
}

// [契约] 该 schema 只用于读取历史条目，不参与新写入。
// 字段是历史形态的超集，解析后仍需剥离退役资源包。
// [边界] 不要把它与 appWorkspaceSessionEntrySchema 合并：两者生命周期不同。
const legacyRemoteWorkspaceHistoryEntrySchema = z.object({
  id: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  localWorkspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  target: remoteWorkspaceTargetSchema,
  lastOpenedAt: z.number().int().nonnegative(),
  lastConnectionStatus: z.enum(["connected", "failed"]),
  lastConnectionError: z.string().optional(),
});

// [事务] 无条件覆盖该字段，不读旧值：旧值本身已无合法语义。
// 这样的归一让核心 provider 状态只有一个事实源。
// [契约] 必须在 schema 入口做，UI 或 bot 各自过滤会产生分叉。
// [边界] 迁移不删除字段，而是写入归一后的数组。
function migrateLegacyBuiltinAgentCliProviders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as {
    enabledBuiltinAgentCliProviders?: unknown;
  };

  // Bugfix: 单 ZCode Agent 迁移后，旧 setting.json 可能还保存已移除的第三方 CLI provider
  // 的启用状态。若这些值继续进入 UI / bot 的 provider 选项，会和 server 侧唯一 glm 状态打架。
  // 这里在 schema 入口统一归一到 ZCode Agent，让核心 provider 状态只有一个事实源。
  return {
    ...raw,
    enabledBuiltinAgentCliProviders: [...ZCODE_ENABLED_AGENT_PROVIDERS],
  };
}

// [契约] 只处理 ssh 且有 resourcePackages 的目标，其它原样返回。
// 返回新对象并移除字段：不能在入参上 delete。
// [事务] 剥离必须发生在解析前，否则旧 ID 让整条历史解析失败。
function stripHistoricalRemoteResourcePackages(target: unknown): unknown {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return target;
  }

  const rawTarget = target as Record<string, unknown>;
  if (rawTarget.kind !== "ssh" || !("resourcePackages" in rawTarget)) {
    return target;
  }

  const { resourcePackages: _resourcePackages, ...nextTarget } = rawTarget;
  // SSH 部署固定使用完整 active 资源集；旧 setting.json 里的 resourcePackages 是历史裁剪，
  // 在配置入口清掉，避免后续重连或 tab 恢复继续读取。
  return nextTarget;
}

// [事务] 合并三处旧存储：lastWorkspaceSession、remoteWorkspaceHistory、lastOpenTabs。
// 顺序固定：先建立历史索引，再迁移会话条目，最后补本地 tab。
// 本地 tab 去重依赖已迁移会话的 workspacePath 集合，不能提前。
// [契约] 迁移完成后删除 lastOpenTabs 与 remoteWorkspaceHistory，避免二次迁移。
// [边界] 只有确有旧数据时才重写 lastWorkspaceSession，空配置保持原样。
function migrateLegacyWorkspaceSession(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as {
    lastOpenTabs?: unknown;
    lastWorkspaceSession?: unknown;
    remoteWorkspaceHistory?: unknown;
  };
  const migrated = { ...raw } as Record<string, unknown>;
  const lastWorkspaceSession = Array.isArray(raw.lastWorkspaceSession)
    ? raw.lastWorkspaceSession
    : [];

  const hasLegacyRemoteEntries = lastWorkspaceSession.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return "historyId" in (entry as Record<string, unknown>);
  });

  const legacyRemoteHistory = Array.isArray(raw.remoteWorkspaceHistory)
    ? raw.remoteWorkspaceHistory
    : [];
  const legacyRemoteHistoryById = new Map(
    legacyRemoteHistory.flatMap((entry) => {
      const sanitizedEntry =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? {
              ...(entry as Record<string, unknown>),
              // 更老的 remoteWorkspaceHistory 可能保存了已退役资源包 ID。
              // 先剥离历史选择再走 schema，避免迁移阶段误删整条远程历史。
              target: stripHistoricalRemoteResourcePackages(
                (entry as Record<string, unknown>).target,
              ),
            }
          : entry;
      const parsed = legacyRemoteWorkspaceHistoryEntrySchema.safeParse(sanitizedEntry);
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : [];
    }),
  );

  const migratedWorkspaceSessionEntries: Record<string, unknown>[] =
    lastWorkspaceSession.length > 0
      ? lastWorkspaceSession.flatMap((entry): Record<string, unknown>[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }

          const rawEntry = entry as Record<string, unknown>;
          if (rawEntry.kind === "local" && typeof rawEntry.workspacePath === "string") {
            return [
              {
                kind: "local",
                workspacePath: rawEntry.workspacePath,
                workspacePurpose:
                  rawEntry.workspacePurpose === "conversation" ? "conversation" : "project",
              },
            ];
          }

          if (rawEntry.kind === "remote") {
            if (typeof rawEntry.workspacePath === "string" && rawEntry.target) {
              return [
                {
                  ...rawEntry,
                  target: stripHistoricalRemoteResourcePackages(rawEntry.target),
                },
              ];
            }

            if (typeof rawEntry.historyId === "string") {
              const legacyRemoteEntry = legacyRemoteHistoryById.get(rawEntry.historyId);
              return legacyRemoteEntry
                ? [
                    {
                      kind: "remote",
                      workspacePath: legacyRemoteEntry.workspacePath,
                      ...(legacyRemoteEntry.localWorkspacePath
                        ? { localWorkspacePath: legacyRemoteEntry.localWorkspacePath }
                        : {}),
                      ...(legacyRemoteEntry.workspaceIdentity
                        ? { workspaceIdentity: legacyRemoteEntry.workspaceIdentity }
                        : {}),
                      target: stripHistoricalRemoteResourcePackages(legacyRemoteEntry.target),
                      lastOpenedAt: legacyRemoteEntry.lastOpenedAt,
                      lastConnectionStatus: legacyRemoteEntry.lastConnectionStatus,
                      ...(legacyRemoteEntry.lastConnectionError
                        ? { lastConnectionError: legacyRemoteEntry.lastConnectionError }
                        : {}),
                    },
                  ]
                : [];
            }
          }

          return [];
        })
      : [];
  const migratedLegacyLocalEntries = Array.isArray(raw.lastOpenTabs)
    ? raw.lastOpenTabs.flatMap((workspacePath) =>
        typeof workspacePath === "string"
          ? [
              {
                kind: "local" as const,
                workspacePath,
                workspacePurpose: "project" as const,
              },
            ]
          : [],
      )
    : [];
  const existingLocalWorkspacePaths = new Set(
    migratedWorkspaceSessionEntries.flatMap((entry) =>
      entry.kind === "local" && typeof entry.workspacePath === "string"
        ? [entry.workspacePath]
        : [],
    ),
  );
  const nextWorkspaceSession = [
    ...migratedWorkspaceSessionEntries,
    ...migratedLegacyLocalEntries.filter(
      (entry) => !existingLocalWorkspacePaths.has(entry.workspacePath),
    ),
  ];

  // 旧 setting.json 把本地会话、远端历史、组合会话拆在三处存，
  // 一旦只删掉其中一处，启动恢复就会出现“列表还在但恢复不到”或“远端数据残留”的分叉状态。
  // 这里在 schema 解析阶段统一合并进 lastWorkspaceSession，并主动移除旧字段，
  // 保证后续所有读写都只围绕单一真相源展开。
  if (
    nextWorkspaceSession.length > 0 ||
    hasLegacyRemoteEntries ||
    Array.isArray(raw.lastOpenTabs)
  ) {
    migrated.lastWorkspaceSession = nextWorkspaceSession;
  }
  delete migrated.lastOpenTabs;
  delete migrated.remoteWorkspaceHistory;
  return migrated;
}

// [契约] 这是读取侧的唯一完整形状：所有可持久化字段都必须在这里声明。
// default 只对缺省字段生效，已显式保存的 false 必须原样保留。
// [契约] 新增字段若只加在 patch，会被这里剥离，表现为改动不生效。
// [边界] 这里不放迁移逻辑，迁移统一由 preprocess 链完成。
const appSettingsObjectSchema = z.object({
  // [契约] 缺省为空数组，不校验路径存在性：项目可能被移动或删除。
  // [边界] 顺序即最近使用顺序，读取侧不得排序。
  recentProjects: z.array(z.string()).default([]),
  // [契约] locale 缺省 zh-CN，与历史行为一致。
  // 它只是生效值，不能反推用户偏好。
  // [边界] 该字段由 setLocale 写入，读取侧不做规范化。
  locale: localeSchema.default("zh-CN"),
  // 快捷键用户覆盖（语义校验在 ui/src/shortcuts 生效表阶段容错，schema 只管形状）
  // [契约] schema 只管形状，按键语义校验在 UI 生效表阶段完成。
  // [边界] optional 表示未自定义，不能默认成空对象覆盖内置键位。
  shortcutBindings: z.record(z.string(), z.array(z.string())).optional(),
  localePreference: localePreferenceSchema.default("system"),
  terminalInheritSystemProfile: z.boolean().default(true),
  terminalFontFamily: nonEmptyStringSchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
  httpProxy: nonEmptyStringSchema.optional(),
  httpProxyNoProxy: nonEmptyStringSchema.optional(),
  httpProxyCaCertPath: nonEmptyStringSchema.optional(),
  embeddedBrowserAllowInsecureCertificates: z.boolean().default(false),
  embeddedBrowserViewportPreference: embeddedBrowserViewportPreferenceSchema.default(
    DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  ),
  // 输入框电脑操作入口改为默认不展示，设置项保留、默认关闭。
  // default 只对缺省字段生效，显式存过 false 的用户仍保持展示。
  computerUseComposerEntryHidden: z.boolean().default(true),
  taskAutoArchiveEnabled: z.boolean().default(false),
  taskAutoArchiveResetVersion: z.literal(1).default(1),
  taskAutoArchiveOlderThanDays: z.number().int().positive().max(365).default(30),
  closeToTrayOnWindows: z.boolean().default(true),
  closeToTrayOnWindowsMigrationInitialized: z.boolean().default(true),
  // default(false)：新装与存量用户首次启动都视为未归位，由 main 进程按平台决定是否迁移。
  closeToTrayLinuxMigrationInitialized: z.boolean().default(false),
  keepAwakeWhileRunning: z.boolean().default(false),
  desktopZoomLevel: desktopZoomLevelSchema.optional(),
  desktopWindowSize: desktopWindowSizeSchema.optional(),
  desktopChromiumHardwareAccelerationEnabled: z.boolean().default(true),
  messageStreamShowReasoning: z.boolean().default(true),
  messageStreamShowReasoningMigrationInitialized: z.boolean().default(true),
  messageStreamShowTodos: z.boolean().default(false),
  toolGroupingExploreEnabled: z.boolean().default(true),
  toolGroupingTerminalEnabled: z.boolean().default(true),
  toolGroupingChangesEnabled: z.boolean().default(false),
  zcodeInteractionBehavior: zcodeInteractionBehaviorSchema.default("queue"),
  askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
  modelIoFullRetentionEnabled: z.boolean().default(false),
  dynamicWorkflowMode: dynamicWorkflowModeSettingSchema,
  enabledBuiltinAgentCliProviders: enabledBuiltinAgentCliProvidersSchema.default([
    ...ZCODE_ENABLED_AGENT_PROVIDERS,
  ]),
  startPlanRecommendationDismissed: z.boolean().default(false),
  providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema.default({}),
  providerFamilyDomain: providerFamilyDomainSchema.optional(),
  providerFamilyDomainUpdatedAt: z.number().int().nonnegative().optional(),
  providerFamilyDomainMigrated: z.boolean().default(false),
  nativeSearchEnhancementsEnabled: z.boolean().default(true),
  toolSearchMode: appToolSearchModeSchema.default("off"),
  onboardingOccupation: appSettingsOccupationSchema.nullish(),
  proactiveSuggestionsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().default(false),
  lastWorkspaceSession: z.array(appWorkspaceSessionEntrySchema).default([]),
  lastActiveWorkspace: appWorkspaceSessionEntrySchema.nullable().optional(),
  remoteConversationWorkspaceBySourceServerId: z
    .record(nonEmptyStringSchema, remoteConversationWorkspaceRecordSchema)
    .optional(),
  sourceServers: z.array(sourceServerRecordSchema).default([]),
  connectionProfiles: z.array(connectionProfileSchema).default([]),
  sourceServerWorkspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema).default([]),
  // Bug 原因：该开关过去只声明在 patch schema，SettingService 合并后再走完整 schema 时会把
  // 显式 false 剥离，导致重启后恢复为默认开启。完整 schema 必须拥有这项持久化事实。
  // [契约] 必须 optional：default(false) 会把用户的显式开启覆盖掉。
  // [边界] 缺省语义是未设置，由调用方决定是否按平台默认开启。
  remoteStartupAutoReconnectEnabled: z.boolean().optional(),
  sourceServerDirectoryMigrationVersion: z.literal(1).optional(),
  remoteBoundaryOnboardingVersion: z.literal(2).optional(),
  remoteBoundaryIntroAcknowledgedVersion: z.literal(1).optional(),
  lastActiveTabIndex: z.number().int().nonnegative().default(0),
  lastActiveTaskByWorkspace: z.record(z.string(), z.string()).optional(),
  dataBaseDir: z.string().trim().min(1).optional(),
  pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional(),
  receivePreviewUpdates: z.boolean().default(false),
  autoDownloadAndInstallUpdates: z.boolean().default(false),
  skippedElectronUpdateVersions: skippedElectronUpdateVersionsSchema,
  settingsSyncFirstRunPromptHandled: z.boolean().optional(),
  webRemoteControlRelayV2Device: webRemoteControlRelayV2DeviceSchema.optional(),
  webRemoteControlExternalRelayDevice: webRemoteControlExternalRelayDeviceSchema.optional(),
  webRemoteControlLastEnabledContext: webRemoteControlLastEnabledContextSchema.optional(),
  zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional(),
});

// [事务] preprocess 的组合顺序是执行顺序：最内层先跑，逐层向外。
// 顺序不可重排：会话合并必须先于 endpoint 清洗与视口清洗。
// 所有迁移都必须先于完整 schema 解析，否则旧形态直接被判非法。
// [契约] 任何一步都必须返回对象或原始值，不能返回 undefined 之外的空值。
// [失败路径] 迁移内部不抛错：抛错会让整份设置读取失败，与容错目标相反。
export const appSettingsSchema = z.preprocess(
  (value) =>
    sanitizeEmbeddedBrowserViewportPreference(
      sanitizeDesktopWindowSize(
        migrateMessageStreamShowReasoningDefault(
          migrateCloseToTrayOnWindowsDefault(
            migrateLegacyLocalePreference(
              sanitizeZCodeEndpointOrigin(
                migrateLegacyWorkspaceSession(
                  migrateLegacyBuiltinAgentCliProviders(
                    migrateRemoteBoundaryIntroAcknowledgement(migrateTaskAutoArchiveReset(value)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  appSettingsObjectSchema,
);

// [契约] patch 是写入路径，所有字段 optional，但类型校验必须严格。
// 它必须与完整 schema 的字段集同步，缺字段等于没有写入通道。
// [契约] 空串哨兵只出现在 patch：它表示删除选择，不是合法持久值。
// [边界] patch 不跑迁移：写入的是新形态，迁移只服务历史读取。
export const appSettingsPatchSchema = z.object({
  recentProjects: z.array(z.string()).optional(),
  locale: localeSchema.optional(),
  shortcutBindings: z.record(z.string(), z.array(z.string())).optional(),
  localePreference: localePreferenceSchema.optional(),
  terminalInheritSystemProfile: z.boolean().optional(),
  terminalFontFamily: nonEmptyStringSchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
  httpProxy: nonEmptyStringSchema.optional(),
  httpProxyNoProxy: nonEmptyStringSchema.optional(),
  httpProxyCaCertPath: nonEmptyStringSchema.optional(),
  embeddedBrowserAllowInsecureCertificates: z.boolean().optional(),
  embeddedBrowserViewportPreference: embeddedBrowserViewportPreferenceSchema.optional(),
  computerUseComposerEntryHidden: z.boolean().optional(),
  taskAutoArchiveEnabled: z.boolean().optional(),
  taskAutoArchiveOlderThanDays: z.number().int().positive().max(365).optional(),
  closeToTrayOnWindows: z.boolean().optional(),
  keepAwakeWhileRunning: z.boolean().optional(),
  closeToTrayOnWindowsMigrationInitialized: z.boolean().optional(),
  closeToTrayLinuxMigrationInitialized: z.boolean().optional(),
  desktopZoomLevel: desktopZoomLevelSchema.optional(),
  desktopWindowSize: desktopWindowSizeSchema.optional(),
  desktopChromiumHardwareAccelerationEnabled: z.boolean().optional(),
  messageStreamShowReasoning: z.boolean().optional(),
  messageStreamShowReasoningMigrationInitialized: z.boolean().optional(),
  messageStreamShowTodos: z.boolean().optional(),
  toolGroupingExploreEnabled: z.boolean().optional(),
  toolGroupingTerminalEnabled: z.boolean().optional(),
  toolGroupingChangesEnabled: z.boolean().optional(),
  zcodeInteractionBehavior: zcodeInteractionBehaviorSchema.optional(),
  askUserQuestionAutoResolutionEnabled: z.boolean().optional(),
  modelIoFullRetentionEnabled: z.boolean().optional(),
  // 空串是「删除选择、回到跟随」的哨兵：RPC 会吞掉 undefined，normalizeSettingsPatch 把它归一成删除。
  dynamicWorkflowMode: z.union([z.enum(DYNAMIC_WORKFLOW_MODES), z.literal("")]).optional(),
  enabledBuiltinAgentCliProviders: enabledBuiltinAgentCliProvidersSchema.optional(),
  startPlanRecommendationDismissed: z.boolean().optional(),
  providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema.optional(),
  providerFamilyDomain: z.union([providerFamilyDomainSchema, z.literal("")]).optional(),
  providerFamilyDomainUpdatedAt: z.number().int().nonnegative().optional(),
  providerFamilyDomainMigrated: z.boolean().optional(),
  nativeSearchEnhancementsEnabled: z.boolean().optional(),
  toolSearchMode: appToolSearchModeSchema.optional(),
  onboardingOccupation: z
    .enum([
      "office",
      "developer",
      "independent",
      "infrastructure",
      "product",
      "design",
      "student",
      "creator",
      "operations",
      "marketing",
      "finance",
      "accounting",
      "legal",
      "other",
    ])
    .nullish(),
  proactiveSuggestionsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  lastWorkspaceSession: z.array(appWorkspaceSessionEntrySchema).optional(),
  lastActiveWorkspace: appWorkspaceSessionEntrySchema.nullable().optional(),
  remoteConversationWorkspaceBySourceServerId: z
    .record(nonEmptyStringSchema, remoteConversationWorkspaceRecordSchema)
    .optional(),
  sourceServers: z.array(sourceServerRecordSchema).optional(),
  connectionProfiles: z.array(connectionProfileSchema).optional(),
  sourceServerWorkspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema).optional(),
  remoteStartupAutoReconnectEnabled: z.boolean().optional(),
  sourceServerDirectoryMigrationVersion: z.literal(1).optional(),
  remoteBoundaryOnboardingVersion: z.literal(2).optional(),
  remoteBoundaryIntroAcknowledgedVersion: z.literal(1).optional(),
  lastActiveTabIndex: z.number().int().nonnegative().optional(),
  lastActiveTaskByWorkspace: z.record(z.string(), z.string()).optional(),
  dataBaseDir: z.string().trim().min(1).optional(),
  pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional(),
  receivePreviewUpdates: z.boolean().optional(),
  autoDownloadAndInstallUpdates: z.boolean().optional(),
  skippedElectronUpdateVersions: z
    .partialRecord(electronReleaseChannelSchema, nonEmptyStringSchema)
    .optional(),
  settingsSyncFirstRunPromptHandled: z.boolean().optional(),
  webRemoteControlRelayV2Device: webRemoteControlRelayV2DeviceSchema.optional(),
  webRemoteControlExternalRelayDevice: webRemoteControlExternalRelayDeviceSchema.optional(),
  webRemoteControlLastEnabledContext: webRemoteControlLastEnabledContextSchema.optional(),
  zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional(),
});
