// ============================================================================
// validation.ts —— 进程间协议 payload 的运行时校验边界（renderer / host / relay / mobile）
//
// 这个文件里的每个 schema 都运行在「不可信数据进入系统的第一道门」上：
// 上游可能是另一个进程、另一台机器、旧版本客户端，甚至是磁盘上被手工改过的 json。
// 因此校验器的取舍不是「尽量严」，而是「拒绝真正无法处理的输入，放行可以降级处理的数据」。
//
// 不变量表（破坏后果均为线上可观测的故障）：
// INV-1: schema 只判断形状与类型，不做业务可用性检查（路径是否存在、目录是否可写、
//        设备是否在线）。—— 破坏后果：把 IO 判断塞进 schema 会让同一份 payload 在
//        不同机器上得到不同校验结果，缓存、重放与测试全部不可复现。
// INV-2: 面向不可信输入且字段集合固定的消息用 .strict()；用于向前兼容的消息保持默认
//        strip 行为。—— 破坏后果：两者搞反后，要么旧客户端被新字段整体拒绝（版本墙），
//        要么未知字段被静默透传到下游并参与判断（隐藏的行为差异）。
// INV-3: 可选字段一律 .optional()，不用 .default()，除非该默认值对历史数据有确定语义。
//        —— 破坏后果：default 会凭空造出调用方从未发送的值，「未设置」与「显式设为默认」
//        从此无法区分，用户改不回空值。
// INV-4: .nullable() 与 .optional() 不可互换：前者表示「显式发了 null」，后者表示「没发」。
//        —— 破坏后果：把 null 当缺省会让跨字段 refine 把「清空引用」误判成「没有引用」。
// INV-5: 字符串型 id / 路径一律走 nonEmptyStringSchema（trim 后 min 1），不用裸 z.string()。
//        —— 破坏后果：空串会被当作有效值向下传递，最终在落盘时变成当前目录或空文件名。
// INV-6: 需要「长度上限」时上限必须取 PROTOCOL_V4_LIMITS，不写字面量。
//        —— 破坏后果：协议端与校验端各写一个数字，改协议时漏改一侧，合法消息被拒。
// INV-7: 会进入 URL、帧头、文件名的 id 额外加字符白名单正则。
//        —— 破坏后果：允许 "/" 或空白会让 id 在拼接与日志中被截断，出现「找不到会话」。
// INV-8: 时间戳与度量值用 .finite()，不用裸 .number()。
//        —— 破坏后果：NaN/Infinity 经非 JSON 路径进来后所有比较都是 false，排序与过期
//        判断静默失效。
// INV-9: 计数字段用 .int().nonnegative()（或 .positive()）。
//        —— 破坏后果：小数或负数进入计量器会让累计值漂移或变负，容量判断反向。
// INV-10: 路径字段不做归一化（不换分隔符、不折叠大小写、不 realpath）。
//        —— 破坏后果：归一化后的值若被当作真实路径回写，Windows 上会创建出与用户输入
//        不同的目录，且同一目录在不同作用域下被当成两个。
// INV-11: 枚举值用 z.enum 而不是 z.string().refine 白名单。
//        —— 破坏后果：refine 的 issue 不携带允许值，客户端无法据此降级；
//        而 z.enum 会列出候选，前端可以回退到默认项。
// INV-12: discriminatedUnion 的判别字段取值必须互斥且唯一；同一个判别值的多个分支
//        只能放进 z.union，不能进 discriminatedUnion。
//        —— 破坏后果：重复 key 时 zod 只保留最后一个分支，另一分支永远无法通过校验
//        （典型表现：成功响应全部被当成失败响应）。
// INV-13: z.union 的分支顺序有意义：更严格的形状放前面。
//        —— 破坏后果：宽松分支在前会先匹配成功并 strip 掉未知字段，严格分支永远不生效。
// INV-14: 跨字段 refine 必须显式处理可选字段为 undefined 的情况。
//        —— 破坏后果：undefined 参与布尔运算会得到意外的 true，把非法组合放过去，
//        下游拿到「有 taskId 却没有 taskHostId」这类半成品状态。
// INV-15: refine 只用于字段之间的约束；单字段约束优先用内置校验器。
//        —— 破坏后果：refine 不产生具体字段路径，错误只会挂在对象根上，
//        前端无法把错误定位到具体输入框。
// INV-16: 错误消息的路径用 "." 连接，根路径固定为 "<root>"。
//        —— 破坏后果：根路径输出空串会让消息以 ": " 开头，按 ": " 切分的调用方丢字段。
// INV-17: 纯转发型 schema（relay 帧、第三方记录）不得擅自加 .strict()。
//        —— 破坏后果：中继会拒绝未来版本新增的合法字段，形成无法升级的版本墙。
// INV-18: schema 不读取环境变量、不依赖当前工作目录、不引用可变单例。
//        —— 破坏后果：同一 payload 在不同进程中结果不同，线上问题无法在本地复现。
// INV-19: schema 对象被下游引用后不可原地修改（extend / merge / pick 必须产生新对象）。
//        —— 破坏后果：一处「顺手加个字段」会影响所有引用方，且排查时看不到调用点。
// INV-20: 本文件导出的名称即协议字段名，重命名等价于破坏兼容。
//        —— 破坏后果：下游 import 直接失败；即便同步改动，持久化数据里的旧名也读不出来。
// INV-21: 大 schema 的字段顺序与注释顺序保持与协议文档一致。
//        —— 破坏后果：审查 diff 时无法判断「字段是新增还是移动」，容易漏掉兼容性评估。
// ============================================================================
import { mobilePluginDiscoveryTelemetrySchema } from "./telemetry.js";
import { databaseStartupControlSchema, databaseStartupStateSchema } from "./database-startup.js";
import { mcpAppInstanceSchema } from "./mcp-apps/instance.js";
import {
  automationSessionCreateTelemetrySchema,
  sessionCreateTelemetrySchema,
} from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- 运行时 schema 当前集中在共享包入口，外部 relay payload 校验加入后先保持单一导出面。 */
import { z } from "zod";
import { networkCaptureControlSchema, networkCaptureBatchSchema } from "./networkCapture.js";
import { browserCommandSchema } from "./browser-use/commands.js";
import { browserCommandResultSchema } from "./browser-use/result.js";
import { modelSelectionSchema } from "./model-selection.js";
import { localeSchema } from "./validationAppSettings.js";
import { zcodeProcessDiagnosticSchema } from "./process-diagnostic.js";
import { PROCESS_RESOURCE_CLI_LANES } from "./processResourceTelemetry.js";
import {
  providerProvisioningErrorCodeSchema,
  providerProvisioningTriggerSchema,
} from "./provider-provisioning.js";
import { zcodeProviderSchema } from "./providers.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import type { WebRemoteControlAppPayload } from "./web-remote-control.js";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import { sourceServerArtifactPolicySchema } from "./source-server/release.js";
import { sessionWorkflowActivitySchema } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import {
  webRemoteControlRpcTransportAckSchema,
  webRemoteControlRpcTransportFrameSchema,
} from "./web-remote-control-rpc-transport.js";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
  taskOwnerCommandResultSchema,
  taskRealtimeDeliveredEventSchema,
  taskRealtimeEventSchema,
  taskRealtimeHostDeliveryKindSchema,
  taskRunLeaseAcquireRequestSchema,
  taskRunLeaseResultSchema,
  taskRunLeaseTargetSchema,
  taskStreamMirrorPublishOpSchema,
  taskStreamMirrorTargetSchema,
} from "./task-realtime-core.js";
import { wslUserSchema } from "./wslUserValidation.js";
import { legacyZCodeProviderSchema } from "./zcode-agent-policy.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";
import {
  zcodeMcpResourceSamplesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodeProcessResourceSampleSchema,
  zcodeToolExecResourceSchema,
} from "./zcode-protocol/index.js";
import { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";

export {
  appSettingsOccupationEnum,
  appSettingsPatchSchema,
  appSettingsSchema,
  localeSchema,
  postUpdateReleaseNotesPayloadSchema,
} from "./validationAppSettings.js";
export { isValidWslUser, WSL_USER_MAX_LENGTH, wslUserSchema } from "./wslUserValidation.js";
export { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";

// 把 ZodError 压成单行字符串，供日志与 IPC 错误回传使用。
// 只保留 path 与 message，丢掉 code/expected/received：后三者属于两端共享的类型细节，
// 回传会暴露内部结构（例如枚举的全部候选值），也无法直接展示给用户。
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      // 根级 issue 的 path 是空数组，固定写成 "<root>" 而不是空串：
      // 否则消息以 ": " 开头，按 ": " 切分多条错误的调用方会丢掉第一个字段名。
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

// trim 之后再 min(1)：只有空白的字符串同样无效，否则 "   " 会被当成合法 id 传下去。
// 注意输出是 trim 过的值，调用方必须使用 parse 的返回值而不是原始输入，
// 否则会出现「校验通过、落盘却带首尾空格」的漂移，目录名因此对不上。
// 这里不折叠内部空格、不处理全角空格：路径中合法地可能包含它们。
export const nonEmptyStringSchema = z.string().trim().min(1);
// 刻意不设最小长度：空数组合法地表示「本次没有要处理的项」，
// 强制非空会让「清空列表」这类操作无法表达。
export const stringArraySchema = z.array(z.string());
// Task04B：topic physical-frame 计量器按 bridge/recovery id 的协议最大长度计算
// mobile relay 外壳；不在不可信 payload 入口机械限长，1MiB 上限就只是估算。
// 传输层 id 同时作为帧头字段与日志定位键，所以限长与字符白名单双管齐下：
// 长度上限取自协议常量（见 INV-6），字符集排除空白、斜杠与冒号，
// 保证它拼进 URL query 或 "a:b" 形式的日志前缀时不需要二次转义。
// 只用于 id，不要复用到用户可见名称上——中文名会被直接拒绝。
const webRemoteControlTransportIdSchema = nonEmptyStringSchema
  .max(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

// 一个工作区条目：workspacePath 是唯一必需的定位信息，其余都是展示或连接状态。
// workspaceIdentity 可选是有意为之：老版本宿主只上报路径，若强制必填，
// 升级前的老客户端发来的整个列表都会被拒绝，表现为移动端连上后看不到任何工作区。
// remoteSessionId 与 kind 的对应关系（local 时应为空）不在这里校验：
// 那属于跨字段约束，塞进 schema 会让错误挂在对象根上、定位变差（见 INV-15）。
// connectionState 描述「当前连接」而非历史：重连时它会在三个值之间跳动，
// 消费方不能据此判断工作区是否存在。
export const webRemoteControlWorkspaceTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  label: nonEmptyStringSchema,
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  kind: z.enum(["local", "remote"]),
  connectionState: z.enum(["connected", "disconnected", "reconnecting"]).optional(),
  lastConnectionError: z.string().optional(),
});

// 不限制数组长度：工作区数量取决于用户真实打开了多少目录，
// 在这里设上限会把「开了很多目录」误判成非法输入。
// 真正的内存保护在 IPC 帧大小限制那一层，那里能给出更有意义的错误。
export const webRemoteControlWorkspaceTargetsSchema = z.array(
  webRemoteControlWorkspaceTargetSchema,
);

// workspaceKey 而不是 workspacePath：重连只需要定位到一个已存在的会话，
// 用 key 可以避免两端对路径大小写/分隔符处理不同时找不到工作区（见 INV-10）。
// requestId 必填且必须原样回带，用于丢弃超时后迟到的旧响应。
export const webRemoteControlReconnectWorkspaceRequestSchema = z.object({
  requestId: nonEmptyStringSchema,
  workspaceKey: nonEmptyStringSchema,
});

// 成功/失败分支的公共字段重复写两次而不是用 extend：
// 两个分支的判别字段是 success（boolean literal），zod 的 discriminatedUnion
// 虽然支持 boolean，但这里保持 z.union 是为了让 issue 能同时报告两侧的形状，
// 排查「为什么这条响应两种都不匹配」时信息更全。
// [权衡] 失败分支的 error 用裸 z.string() 而不是 nonEmptyStringSchema：
// 服务端有时只能给出空字符串表示「未知错误」，此时若拒绝整个响应，
// 前端连「重连失败」这个状态都收不到，只能干等到超时。
export const webRemoteControlReconnectWorkspaceResultSchema = z.union([
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
]);

// 失败原因是闭合枚举，新增值必须同步前端文案与重试策略：
// 前端按 reason 决定「是否可重试、是否要重新 bootstrap、是否提示用户检查网络」，
// 未知 reason 一律落到兜底文案与不退避重试。
// 之所以不做成开放字符串，正是因为这些值直接驱动控制流，
// 放任未知值会让重连策略失去依据。
// 数组顺序按「从具体到兜底」排列，最后一个是 unexpected-error；
// 消费方只按值匹配，不得依赖顺序做范围判断。
export const webRemoteControlFailureReasonSchema = z.enum([
  "session-not-found",
  "session-expired",
  "session-conflict",
  "workspace-closed",
  "desktop-disconnected",
  "invalid-mobile-connection",
  "desktop-bootstrap-timeout",
  "connection-recovery-timeout",
  "relay-unavailable",
  "unsupported-action",
  "unexpected-error",
]);

// discriminatedUnion("kind") 的两个分支字段高度重叠，但差异是本质性的：
// remote 分支多出必填的 workspaceIdentity 与 remoteSessionId，
// 因此不能合并成一个「带可选字段的宽对象」——那样 local 桥接也会被要求带远端会话。
// capabilities.windowProjectDirectory 用 z.literal(true).optional()：
// 这是能力协商位，只在支持时出现；出现 false 没有语义，索性不允许。
// bridgeGeneration 可选是为了兼容旧宿主（老版本没有代际概念，缺省按 0 处理），
// 新宿主用它丢弃上一代桥接发来的迟到消息；去掉可选会让旧宿主整体失联。
export const webRemoteControlExternalWorkspaceBridgeSchema = z.discriminatedUnion("kind", [
  z.object({
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("local"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("remote"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    remoteSessionId: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
    capabilities: z.object({ windowProjectDirectory: z.literal(true).optional() }).optional(),
  }),
]);

// 移动端视图状态是「上次看到的页面」的快照，所有定位字段都可选：
// 用户可能刚打开 app、还没进入任何工作区，此时两个 key 都不存在。
// 若要求必填，这种合法的初始状态会被拒绝，表现为首次连接就报错。
// updatedAt 必填且为有限数：没有时间的快照无法判断新旧，宁可显式拒绝。
export const webRemoteControlMobileViewStateSchema = z.object({
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
  updatedAt: z.number().finite(),
});

// 这里是 .strict()：该结构由桌面端自己回填给移动端，字段集合完全可控，
// 出现多余字段意味着调用方传错了对象（最常见的是把 viewState 与 taskView 混用）。
// strict 能让这类错误在边界处立刻暴露；若放宽，错传的对象会带着 workspacePath
// 悄悄混进任务定位逻辑，最终表现为「点任务打开了错误的工作区」。
export const webRemoteControlMobileTaskViewSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    taskId: nonEmptyStringSchema,
  })
  .strict();

// 设备信息只用于展示（「当前连接的是哪台手机」）与排障，不参与鉴权，
// 因此所有描述性字段都可选：缺失时前端显示「未知设备」而不是整条拒绝。
// viewport / screen 用有限数而非正整数：折叠屏与缩放下 devicePixelRatio 会是小数，
// 初始渲染前宽高还可能是 0；这里只排除 NaN/Infinity，不排除 0。
// userAgent / language 允许空串：隐私模式下浏览器会把这些值置空，
// 若用 nonEmptyStringSchema，整条设备信息会被拒，设备列表就空了。
export const webRemoteControlMobileDeviceInfoSchema = z.object({
  platform: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  userAgent: z.string().optional(),
  language: z.string().optional(),
  languages: z.array(z.string()).optional(),
  browserPlatform: z.string().optional(),
  viewport: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
      devicePixelRatio: z.number().finite(),
    })
    .optional(),
  screen: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
    })
    .optional(),
  timezone: z.string().optional(),
  online: z.boolean().optional(),
  updatedAt: z.number().finite(),
});

// bootstrap 结果同时带回「工作区列表」与「上次的视图状态」：
// 移动端首次连上必须一次拿全，否则会先渲染空列表再闪一下，
// 而移动端没有稳定可达的重试入口（用户只能杀进程重开）。
// initialViewState 与 mobileViewState 并存属于版本过渡期：
// 两个字段都 optional：新客户端读 initialViewState、老客户端读 mobileViewState，任一缺失也不会报错。
// mobileTaskViewEpoch 缺失表示「宿主不支持任务视图」，是合法状态而非错误。
export const webRemoteControlWindowBootstrapResultSchema = z.object({
  windowControlSessionId: nonEmptyStringSchema,
  desktopAppVersion: nonEmptyStringSchema.optional(),
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  initialViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileTaskViewEpoch: webRemoteControlTransportIdSchema.optional(),
});

// 列表响应与列表推送（workspace-list-updated）共用这一份结构，只是外层 zcode_type 不同：
// 共享 schema 保证两条路径的字段演进永远同步，不会出现「推送有字段、响应没有」。
// activeWorkspaceKey 允许指向一个不在 workspaces 里的 key（工作区刚被关闭）：
// schema 不做引用完整性校验：activeWorkspaceKey 与 workspaces 的一致性由消费方保证。
export const webRemoteControlWorkspaceListResultSchema = z.object({
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
});

// 平台能力方法是白名单枚举：新增方法必须两端同时发版。
// 用 z.enum 而不是 z.string() 的原因是可操作性——老宿主收到未知方法时
// 在校验层直接得到 unsupported-action，前端可以据此隐藏入口；
// 若允许任意字符串，请求会走进不存在的分支并抛运行时异常。
export const webRemoteControlPlatformMethodSchema = z.enum([
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
]);

// 入站 app 消息的候选 schema 列表，由下面的 parse 函数按顺序逐个尝试。
// 数组顺序不影响正确性（每条都带自己的 zcode_type 字面量），但第一个元素与其余不同：
// telemetry-report 用了 .strict()，因为它的字段集合完全由本仓库定义，
// 出现多余字段几乎一定是字段名拼错。
// 其余条目不 strict：它们由不同版本的客户端产生，未知字段必须被 strip 掉而不是拒绝（见 INV-2）。
// 新增消息类型只需往这里加一条；parse 函数本身不需要改动，
// 因为它对所有候选走同一条 safeParse 循环。
const webRemoteControlAppPayloadSchemas = [
  // telemetry 的 event 用 union 而不是 discriminatedUnion：两种遥测 payload
  // 没有共同的判别字段，只能按形状尝试。顺序上把出现频率更高的 sessionCreate 放前面，
  // 减少平均尝试次数——遥测上报是高频路径，这一层开销会被放大。
  z
    .object({
      zcode_type: z.literal("telemetry-report"),
      event: z.union([sessionCreateTelemetrySchema, mobilePluginDiscoveryTelemetrySchema]),
    })
    .strict(),
  // bootstrap 请求/响应成对出现：响应里的 success 固定为字面量 true，
  // 失败不走这个类型而是走 workspace-bridge-error / 连接关闭，
  // 因此前端不需要在这里处理 false 分支。
  z.object({
    zcode_type: z.literal("bootstrap-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("bootstrap-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWindowBootstrapResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-updated"),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  // 这个请求同时表达三种意图：打开已有任务、打开文件树、或为草稿新建工作区。
  // 下面的 refine 强制它们互斥：
  //   1) 带 project（草稿意图）时不能再指定已有 taskId / fileTreeTaskId；
  //   2) taskId 与 fileTreeTaskId 不能同时出现；
  //   3) 有 fileTreeTaskId 必须有 taskHostId；
  //   4) taskHostId 反向约束：它只在 taskId 或 fileTreeTaskId 同时存在时有意义，单独出现即无法定位。
  // 少任何一条，下游就会拿到「不知道要打开哪个任务」的请求，
  // 用户侧表现为点开移动端是空白页，而不是一条可读的错误。
  // project.projectId 允许 null：null 明确表示「尚未分类的草稿」，
  // 与字段缺省（完全不涉及草稿）是两种语义（见 INV-4）。
  z
    .object({
      zcode_type: z.literal("workspace-bridge-open"),
      requestId: nonEmptyStringSchema,
      bridgeSessionId: webRemoteControlTransportIdSchema,
      bridgeGeneration: z.number().int().nonnegative().optional(),
      recoveryId: webRemoteControlTransportIdSchema.optional(),
      workspaceKey: nonEmptyStringSchema,
      taskId: nonEmptyStringSchema.optional(),
      taskHostId: nonEmptyStringSchema.optional(),
      fileTreeTaskId: nonEmptyStringSchema.optional(),
      project: z
        .object({
          projectId: nonEmptyStringSchema.nullable(),
          hostId: nonEmptyStringSchema.optional(),
          draftId: z.string().uuid().optional(),
          reuseDraft: z.boolean().optional(),
        })
        .strict()
        .refine(
          (intent) =>
            (!intent.draftId || intent.projectId === null) &&
            (!intent.reuseDraft || Boolean(intent.draftId)),
          "Only an unclassified draft can reuse its directory",
        )
        .optional(),
    })
    .refine(
      (request) =>
        (!request.project || (!request.taskId && !request.fileTreeTaskId)) &&
        !(request.taskId && request.fileTreeTaskId) &&
        (!request.fileTreeTaskId || Boolean(request.taskHostId)) &&
        (!request.taskHostId || Boolean(request.taskId || request.fileTreeTaskId)),
      "Project draft cannot target an existing task",
    ),
  z.object({
    zcode_type: z.literal("workspace-bridge-ready"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    bridge: webRemoteControlExternalWorkspaceBridgeSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-bridge-error"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-request"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-view-state-update"),
    viewState: webRemoteControlMobileViewStateSchema,
    deviceInfo: webRemoteControlMobileDeviceInfoSchema.optional(),
  }),
  z
    .object({
      zcode_type: z.literal("mobile-task-view-update"),
      epoch: webRemoteControlTransportIdSchema,
      seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      bridgeSessionId: webRemoteControlTransportIdSchema,
      bridgeGeneration: z.number().int().nonnegative().optional(),
      view: webRemoteControlMobileTaskViewSchema.nullable(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("mobile-task-view-request"),
      epoch: webRemoteControlTransportIdSchema,
    })
    .strict(),
  z.object({
    zcode_type: z.literal("platform-request"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    args: z.unknown().optional(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  // Bugfix：04D-3 必须让 fragment/ACK 与 acknowledged adapter 原子切换。
  // 继续接受 legacy 单片会让 raw bytes 绕过 ACK/replay owner 和 1MiB 外壳硬边界。
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
  z.object({
    zcode_type: z.literal("bridge-degraded"),
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: z.enum([
      "rpc-transport-fault",
      "rpc-frame-gap",
      "buffer-overflow",
      "buffer-timeout",
      "source-session-replaced",
    ]),
    seq: z.number().int().nonnegative().optional(),
    expectedSeq: z.number().int().nonnegative().optional(),
    droppedCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    zcode_type: z.literal("app-error"),
    requestId: nonEmptyStringSchema.optional(),
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-diagnostic"),
    event: z.enum([
      "state-transition",
      "socket-close",
      "socket-error",
      "recover-start",
      "recover-scheduled",
      "pair-status",
      "failure",
    ]),
    timestamp: z.number().int().nonnegative(),
    state: z.string().optional(),
    previousState: z.string().optional(),
    pairStatus: z.enum(["waiting", "matched"]).optional(),
    closeCode: z.number().int().optional(),
    closeReason: z.string().optional(),
    wasClean: z.boolean().optional(),
    wasPaired: z.boolean().optional(),
    failureReason: webRemoteControlFailureReasonSchema.optional(),
    failureMessage: z.string().optional(),
    visibilityState: z.string().optional(),
    online: z.boolean().optional(),
    hiddenDurationMs: z.number().int().nonnegative().optional(),
  }),
] as const;

// Bugfix: app payload 里多个消息共享 zcode_type（例如 platform-response），
// 不能直接用 z.discriminatedUnion("zcode_type")，否则 schema 初始化会因重复值失败。
// 这里保留同一批运行时约束，改用普通 union，让外部 relay 的不可信 payload
// 在进入 desktop/web 路由前仍然先被机械校验。
// 对外的总入口用 union 而不是 discriminatedUnion：判别字段 zcode_type 的取值集合
// 来自数组内各条目自带的字面量，zod 无法从 union 成员反向推导出 discriminant。
// 代价是校验失败时会产出 N 条 issue（每条候选一个），由下面的 parse 统一压成 null。
export const webRemoteControlAppPayloadSchema = z.union(webRemoteControlAppPayloadSchemas);

// safeParse 后只返回 null，不抛错：调用方是 message 事件监听器，
// 抛异常会变成未捕获的 rejection，而这条错误本身无法回传给发送方（对方可能已断开）。
// 返回 null 让调用方统一走「忽略未知消息」这一条路径。
// [权衡] 刻意丢掉 issue 明细：这里只做路由前的粗筛，具体错误由各分支自己报，
// 把 20 条候选的 issue 全打到日志里反而会淹没真正有用的那条。
export function parseWebRemoteControlAppPayload(
  payload: unknown,
): WebRemoteControlAppPayload | null {
  const result = webRemoteControlAppPayloadSchema.safeParse(payload);
  return result.success ? (result.data as WebRemoteControlAppPayload) : null;
}

// 凭据是扁平的 key→value 字符串表：不嵌套对象，避免「值里带结构」时两端
// 序列化方式不一致（一边 JSON、一边 querystring）。
// key 与 value 都允许空串：部分平台用空密码表示「免密登录」，拒绝会让这类目标连不上。
export const credentialRecordSchema = z.record(z.string(), z.string());
// 单独导出 key/value schema 是为了让调用方能只校验其中一侧（例如导入时只查 key 合法性）。
// key 用 nonEmptyStringSchema：空 key 写进凭据文件后无法被任何读取方定位。
export const credentialKeySchema = nonEmptyStringSchema;
export const credentialValueSchema = z.string();

// SSH 连接参数：host/username 必填，凭据三选一（password、privateKeyPath、
// sshConfigAlias 指向的本机配置）。这里不校验三者互斥——同时给出时由服务层按优先级选择，
// 在 schema 层拒绝会把「配置里多填了一项」变成硬错误，用户很难自己发现。
// port 限制在 1..65535：0 与负数在 Node 的 net 层会被当作随机端口或直接抛错。
export const sshConnectOptionsSchema = z.object({
  kind: z.literal("ssh"),
  host: nonEmptyStringSchema,
  port: z.number().int().positive().max(65535).optional(),
  username: nonEmptyStringSchema,
  sshConfigAlias: nonEmptyStringSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
});

// distro 与 user 都可选：不指定发行版用默认发行版，不指定用户用发行版默认用户。
// 这两项必须可选，否则「刚装好 WSL、还没建过用户配置」的机器完全无法连接。
export const wslConnectOptionsSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: wslUserSchema.optional(),
});

// container 必填且非空：docker exec 需要一个确定目标，
// 空串会被 docker CLI 解释成「未指定容器」，报出的错误与真实原因（漏填）无关。
export const dockerConnectOptionsSchema = z.object({
  kind: z.literal("docker"),
  container: nonEmptyStringSchema,
});

// url 用 z.string().url() 而不是自定义正则：URL 的合法性边界（IPv6 字面量、
// 带端口、IDN、末尾斜杠）非常多，自己写正则几乎一定会误拒合法地址。
// token 与 workspacePath 允许空串：前者表示匿名 server，后者表示由 server 决定默认目录。
export const serverConnectOptionsSchema = z.object({
  kind: z.literal("server"),
  url: z.string().url(),
  name: nonEmptyStringSchema.optional(),
  token: z.string().optional(),
  workspacePath: z.string().optional(),
  serverId: nonEmptyStringSchema.optional(),
});

// 四种连接方式按 kind 判别：discriminatedUnion 保证每条分支只校验自己的字段，
// 不会出现「ssh 的 host 被当成 docker 的 container」这种交叉误判。
// 分支顺序不影响结果（判别值互斥），但新增 kind 时必须同步所有消费方的 switch，
// 否则新分支能通过校验却在业务层落不到任何处理逻辑，表现为「连接无反应」。
export const remoteTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
  serverConnectOptionsSchema,
]);

// hello 是握手的第一帧，字段刻意全部宽松（version/platform/arch 都是裸 string）：
// 两端版本不一致时仍要能把握手做完，否则连「你的版本过低」这条信息都回传不了。
// pid 用 z.number().int() 而不要求正数：容器里的 pid 命名空间可能给出 0。
export const helloMessageSchema = z.object({
  type: z.literal("zcode-hello"),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  pid: z.number().int(),
});

// ack 里的 clientId 反过来必须非空：它是后续所有帧的路由键，
// 空 clientId 会让定向消息退化成广播，落到不该收的客户端上。
export const helloAckMessageSchema = z.object({
  type: z.literal("zcode-hello-ack"),
  version: z.string(),
  clientId: nonEmptyStringSchema,
});

// 日志参数用 z.unknown()：renderer 会把任意对象塞进 console 调用，
// 在这里收窄会拒掉合法的调试输出；可读性与脱敏由下游的序列化逻辑负责。
export const rendererLogPayloadSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  args: z.array(z.unknown()),
});

// 通知状态是闭合枚举：每种状态对应一个点击行为（打开任务、去授权、看反馈），
// 未知状态落到哪个行为都不对，宁可拒绝让这条通知静默丢弃，也不要误导航。
export const taskNotificationPayloadSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: z.enum([
    "completed",
    "failed",
    "permission_request",
    "elicitation_request",
    "feedback_update",
  ]),
  requestId: nonEmptyStringSchema.optional(),
  title: z.string(),
  body: z.string(),
});

// 遥测上下文三项必填：缺时区/语言会让平台侧无法按地区聚合，
// 而这三项在 renderer 里总能从 Intl API 拿到，要求必填不会误伤合法调用。
export const telemetryRendererContextSchema = z.object({
  clientTimezone: nonEmptyStringSchema,
  clientLanguage: nonEmptyStringSchema,
  screenResolution: nonEmptyStringSchema,
});

// eventExtraDetail 用 record<string,string>：平台侧按 key 建索引，
// 值统一成字符串可避免同一 key 在不同事件里类型漂移（数值与布尔混用会让聚合列变成混合类型）。
export const rendererTelemetryEventPayloadSchema = z.object({
  context: telemetryRendererContextSchema,
  elementName: nonEmptyStringSchema,
  eventRegion: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  eventText: z.string().optional(),
  eventExtraDetail: z.record(z.string(), z.string()),
  userId: z.string().optional(),
  talkId: z.string().optional(),
  messageId: z.string().optional(),
});

// properties 的值联合里带 z.undefined()：调用方会用显式 undefined 占位，
// 若不允许，整个事件会因为一个可选属性被拒。
// value 用 finite：NaN 传到平台侧会把聚合图表画成断线，且事后无法回溯原始值。
export const armsCustomEventPayloadSchema = z.object({
  name: nonEmptyStringSchema,
  group: nonEmptyStringSchema,
  value: z.number().finite().optional(),
  properties: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.undefined()]))
    .optional(),
});

// 广播 payload 是 unknown：广播内容是业务自定义的，
// 这一层只保证「有 channel 且非空」，内容校验由各订阅方按自己的协议负责。
// 在这里收窄会迫使所有广播业务共用一套 schema，新增广播类型就要改共享包。
export const broadcastMessageSchema = z.object({
  channel: nonEmptyStringSchema,
  payload: z.unknown(),
  sourceWindowId: z.number().int().optional(),
});

// 远端资源目录全部可选：本地开发与离线安装都不带这些字段，
// 强制必填会让「只连远端、不下发资源包」的场景连握手都过不去。
// remoteCdnBaseUrl 与 remoteCdnBaseUrls 并存属于版本过渡：新代码读数组、旧代码读单值，
// 两者都不校验「至少给一个」，因为 mock 模式下可以完全没有 CDN。
export const remoteAssetDirsSchema = z.object({
  mockCdnDir: z.string().optional(),
  remoteCdnBaseUrl: z.string().optional(),
  remoteCdnBaseUrls: z.array(z.string()).optional(),
  remoteCacheDir: z.string().optional(),
  sourceServerArtifactPolicy: sourceServerArtifactPolicySchema.optional(),
});

// 预热目标只描述「在哪预热」：去重与数量上限由调用点按
// STARTUP_AGENT_WARMUP_LIMIT 控制（下文的 max(1)），不写进这个基础结构。
// 把策略写进 schema 会让「以后想预热两个」变成一次协议变更。
const hostAgentWarmupTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
});

// 启动消息是 host 入站消息里字段最多的一个，因此几乎全部可选：
// 它同时要接受多个版本 main 进程的输入，新增必填字段会让旧 main 直接起不来 host
// （表现为应用启动后没有任何 agent 可用，而不是一条可读的错误）。
// zcodeBuiltinProviderConfigFilePath 是唯一必填项：它由 main 按安装布局算出来，
// host 自己推导不出，缺了就无法加载内置 provider。
export const hostInitLocalMessageSchema = z.object({
  type: z.literal("init-local"),
  databaseStartupId: z.string().min(1).max(128).optional(),
  hostId: nonEmptyStringSchema.optional(),
  deliveryKind: taskRealtimeHostDeliveryKindSchema.optional(),
  deviceMid: z.string().optional(),
  feedbackApiBase: z.string().url().optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  // 启动只预热 active workspace（desktop STARTUP_AGENT_WARMUP_LIMIT = 1），协议层同步收紧上限。
  agentWarmupTargets: z.array(hostAgentWarmupTargetSchema).max(1).optional(),
  agentSpawnFallbackCwd: nonEmptyStringSchema.optional(),
  remoteAssets: remoteAssetDirsSchema.optional(),
  /** spawn 时刻 Main 的实时界面语言；后续变化由 application-locale-changed 推送。 */
  locale: localeSchema.optional(),
  zcodeBuiltinProviderConfigFilePath: nonEmptyStringSchema,
  runtimeProcessEnvPatch: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
    .optional(),
});

// 描述符是「远程工作区已就绪」的完整快照：target 与 remoteSessionId 必填，其余可选。
// reusedConnectionTarget 只描述「本次复用了哪条在线连接」，不进持久状态——
// 把它当持久字段会让重启后仍显示一条早已断开的复用连接。
// generation 必填且为正：它用于丢弃上一代描述的迟到消息；缺失会让新旧描述互相覆盖，
// 用户在切换远端工作区后看到上一个工作区的文件树。
export const windowHostRemoteWorkspaceDescriptorSchema = z
  .object({
    /** 本次请求直接复用的在线连接；只包含脱敏目标，不是 session 持久状态。 */
    reusedConnectionTarget: remoteTargetSchema.optional(),
    sourceServerId: nonEmptyStringSchema.optional(),
    remoteSessionId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    generation: z.number().int().positive(),
  })
  .strict();
export type WindowHostRemoteWorkspaceDescriptor = z.infer<
  typeof windowHostRemoteWorkspaceDescriptorSchema
>;

/** Desktop Main → Preload → Renderer 的 remote workspace MessagePort 元数据合同。 */
// 用 pick + extend 而不是重写一份：保证 sourceServerId/target/workspacePurpose
// 三个字段的类型与描述符永远一致（注意 pick/extend 产生的是新对象，不修改原 schema）。
// 这里不能省 strict：该结构经 preload 直接交给 renderer，
// 多出的字段意味着有人把整份描述符塞了进来，会把 remoteSessionId 这类内部 id 泄露到渲染进程。
export const scopedServicePortPayloadSchema = windowHostRemoteWorkspaceDescriptorSchema
  .pick({
    sourceServerId: true,
    target: true,
    workspacePurpose: true,
  })
  .extend({
    attachmentId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
  })
  .strict();
export type ScopedServicePortPayload = z.infer<typeof scopedServicePortPayloadSchema>;

// attachment 作用域分三支：local 不带任何额外 id（本机），source-settings 只带
// sourceServerId，remote 带完整远端定位。合并成「全字段可选」的宽对象会让 local
// 也能携带 remoteSessionId，下游无法判断该用哪个身份去路由连接。
export const windowHostAttachmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("source-settings"),
      sourceServerId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      sourceServerId: nonEmptyStringSchema.optional(),
      remoteSessionId: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WindowHostAttachmentScope = z.infer<typeof windowHostAttachmentScopeSchema>;

// 连接远端：remoteAssets 必填（即使全空也要显式给对象），
// 因为「没传」与「传了空」在服务层分别代表「沿用上次策略」与「本次不下发资源」。
// confirmSourceServerInstall 是用户的二次确认结果，可选且不设默认：
// 缺省表示「还没问过」，服务层据此决定是否弹确认，不能被当成 false。
export const hostConnectRemoteWorkspaceMessageSchema = z
  .object({
    type: z.literal("connect-remote-workspace"),
    requestId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    remoteAssets: remoteAssetDirsSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    confirmSourceServerInstall: z.boolean().optional(),
  })
  .strict();

// 取消连接只需要 requestId：真正的目标由 host 侧按 requestId 记住的 in-flight 请求确定，
// 让取消消息再带一次 target 会引入「两者不一致时以谁为准」的二义性。
export const hostCancelRemoteWorkspaceConnectMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-connect"),
    requestId: nonEmptyStringSchema,
  })
  .strict();

// 绑定上下文必须同时给 remoteSessionId 与完整 workspace 定位：
// 只给 session 的话，重连后路径可能已经变化，绑定会指到一个不存在的工作区。
// legacyRouteHint 用于旧版路由：仅在有历史 task 记录时才带，不能作为主定位依据。
export const hostBindRemoteWorkspaceContextMessageSchema = z
  .object({
    type: z.literal("bind-remote-workspace-context"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    legacyRouteHint: nonEmptyStringSchema.optional(),
  })
  .strict();

// 取消绑定带 remoteSessionId 而不是 requestId 单独定位：
// 同一时刻可能有多个 session 在绑定，取消必须指明是哪一个，
// 否则会把另一个正在进行的绑定一起打断。
export const hostCancelRemoteWorkspaceBindMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-bind"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

// dispose 是幂等操作：对同一个 remoteSessionId 重复调用应当无副作用，
// 因此这里不校验会话是否存在；把存在性检查放进 schema 会让「重复关闭」变成错误弹窗。
export const hostDisposeRemoteWorkspaceSessionMessageSchema = z
  .object({
    type: z.literal("dispose-remote-workspace-session"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

// attach 的 clientMode 必填：它决定断线后端口是保持（continuous）还是可重放（replayable），
// 缺省会让 host 猜错语义——桌面重载被当成手机，端口在刷新后直接失效。
export const hostAttachServicePortMessageSchema = z
  .object({
    type: z.literal("attach-service-port"),
    // main 只能声明 attachment 来源；connectionId 仍由 host process 分配。
    // desktop reload/remote reattach 必须显式 continuous，手机 shared-host 必须 replayable。
    requestId: nonEmptyStringSchema,
    attachmentId: nonEmptyStringSchema,
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    scope: windowHostAttachmentScopeSchema,
  })
  .strict();

// detach 只需要 attachmentId：它是 main 侧分配的不透明句柄，
// 不带 scope 是为了让「作用域已经失效」时也能把端口摘掉（清理路径必须永远可达）。
export const hostDetachServicePortMessageSchema = z.object({
  type: z.literal("detach-service-port"),
  attachmentId: nonEmptyStringSchema,
});

export const hostDisposeMessageSchema = z.object({
  type: z.literal("dispose"),
});

export const hostBroadcastEnvelopeSchema = z.object({
  type: z.literal("broadcast"),
  message: broadcastMessageSchema,
});

// 广播占用的三态用 discriminatedUnion("status") 而不是「status + 全可选字段」：
// acquired 必带 claimToken、busy 必带 retryAfterMs、committed 两者都不带。
// 合并成宽对象会让消费方无法在类型层面知道「committed 时有没有 token」，
// 只能靠运行时判断，漏判就会把 undefined 当成 token 发出去。
export const hostBroadcastClaimResultMessageSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("acquired"),
    claimToken: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("busy"),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("committed"),
  }),
]);

// 下面四条是 task 实时通道的双向信封：消息本体（event/result/command）各自有独立 schema，
// 这里只负责包一层 type。之所以不把 type 合进本体，是因为同一个本体会在
// 「下发」与「上报」两个方向出现，方向信息属于信封而不属于内容。
export const hostTaskRealtimeDeliverMessageSchema = z.object({
  type: z.literal("task-realtime-deliver"),
  event: taskRealtimeDeliveredEventSchema,
});

export const hostTaskRunLeaseResultMessageSchema = z.object({
  type: z.literal("task-run-lease-result"),
  result: taskRunLeaseResultSchema,
});

export const hostTaskOwnerCommandDeliverMessageSchema = z.object({
  type: z.literal("task-owner-command-deliver"),
  command: taskOwnerCommandDeliverySchema,
});

export const hostTaskOwnerCommandResultMessageSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

// 会话间消息的三个结构（请求、投递结果、路由）都要求所有 id 非空：
// 消息会被持久化并按 sessionId 反查，空 id 会让它永远无法被检索到，
// 也不会报错——表现为「发出去的消息对方没收到，也没有任何失败提示」。
export const sessionMessageRequestSchema = z.object({
  content: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  fromSessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  toSessionId: nonEmptyStringSchema,
});

// status 是 success/failed 二值，error 只在 failed 时出现；
// 这里不把 error 强制为 failed 必填，是因为失败原因可能由下游日志承载，
// 强行要求会让「没有更多信息」的失败无法表达。
export const sessionMessageDeliveryResultSchema = z.object({
  error: z.string().optional(),
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  status: z.enum(["success", "failed"]),
});

// 路由只含 sessionId：它回答的是「这条消息该送到哪个会话」，
// 传输细节（端口、进程）由调用方按 sessionId 现查，写进路由会让缓存迅速过期。
export const sessionRouteSchema = z.object({
  sessionId: nonEmptyStringSchema,
});

export const hostSessionMessageDeliverMessageSchema = z.object({
  type: z.literal("session-message-deliver"),
  request: sessionMessageRequestSchema,
});

export const hostSessionMessageDeliveryResultMessageSchema = z.object({
  type: z.literal("session-message-delivery-result"),
  result: sessionMessageDeliveryResultSchema,
});

// 归档结果里 path 用裸 z.string()：归档失败时该字段为空串是合法的，
// 而 requestId/ok 已经足够让调用方判断成败，不必为了路径再拒绝整条回包。
export const hostFeedbackLogArchiveResultMessageSchema = z.object({
  type: z.literal("feedback-log-archive-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  path: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// main → host：定时任务到点派发。会话内 cron 带 targetTaskId 时直接 sendPrompt 到当前会话；
// 历史未绑定任务才 fallback createTask + sendPrompt 建 session。
// 定时任务派发消息：首跑不带 conversationId/sessionId，由 host 新建会话；
// 续跑与中断恢复带上两者以 resume 同一会话。因此这两个字段必须可选，
// 且不能给默认值——「新建」与「恢复」的区别完全由它们是否存在表达。
// permissionMode 按宽松 string 传输（注释见字段处）：档位映射在业务层，
// 协议层写死枚举会让新增档位必须先发新版协议包。
export const hostCronRunMessageSchema = z.object({
  type: z.literal("cron-run"),
  automationId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  projectId: nonEmptyStringSchema.nullable().optional(),
  hostId: nonEmptyStringSchema.optional(),
  additionalDirectories: z.array(nonEmptyStringSchema).max(256).optional(),
  prompt: nonEmptyStringSchema,
  targetTaskId: nonEmptyStringSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  mode: z.string().optional(),
});

// main → host：闲时任务派发（仿 cron-run，字段独立不复用）。首跑不带 conversationId/sessionId，
// host createTask 新建 session；3h 续跑 / 中断恢复带上两者 resume 同一会话。
// serverTicketId 供 idle plan 适配层注入 X-Off-Peak-Ticket-ID 请求头（run 作用域）。
// 闲时任务与 cron 任务字段独立、不复用同一 schema：两者的身份键不同
// （offPeakTaskId 与 automationId），且闲时任务多了 serverTicketId 这条计费/配额凭证。
// additionalDirectories 限制 256 个：它是 prompt 的附加上下文，
// 不设上限会让一条消息在 IPC 层无限膨胀。
export const hostOffPeakRunMessageSchema = z.object({
  type: z.literal("off-peak-run"),
  offPeakTaskId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  projectId: nonEmptyStringSchema.nullable().optional(),
  hostId: nonEmptyStringSchema.optional(),
  additionalDirectories: z.array(nonEmptyStringSchema).max(256).optional(),
  prompt: nonEmptyStringSchema,
  // 权限四档映射现有 ZCodeTaskMode；与 cron-run 的 mode 同样按宽松 string 传输
  permissionMode: nonEmptyStringSchema,
  modelSelection: modelSelectionSchema,
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  serverTicketId: z.string().optional(),
});

// main → host：browser-use 命令执行结果（按 requestId 关联到 host 的 pending）。
// browser 执行结果按 requestId 关联到 host 侧的 pending 表：
// 该字段必填，否则迟到的结果无法被丢弃，会覆盖另一个请求的结果。
export const hostBrowserExecuteResultMessageSchema = z.object({
  type: z.literal("browser-execute-result"),
  requestId: nonEmptyStringSchema,
  result: browserCommandResultSchema,
});

// ok=false 时 path 与 error 都可能缺失。这里用 strict：回包由本进程自己构造，
// 字段集合完全可控，多一个未声明字段说明两端对 payload 的理解已经分叉，
// 早报错好过让 renderer 读到 undefined 后静默不显示预览。
export const hostLocalMediaPreviewPathAuthorizeResultMessageSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    path: nonEmptyStringSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

/** main → host：插件 UI 沙箱登记结果（PluginSandboxRegisterResultPayload）。 */
export const hostPluginSandboxRegisterResultMessageSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    instance: mcpAppInstanceSchema.optional(),
    sandboxId: nonEmptyStringSchema.optional(),
    initId: z.number().int().nonnegative().optional(),
    shellUrl: nonEmptyStringSchema.optional(),
    partition: nonEmptyStringSchema.optional(),
    // 登记时生效的呈现字段（资源级优先合并后的值），回 renderer 定初始高度 / 边框。
    // Bugfix：这条 schema 是 strict 的——句柄多带一个未声明字段，整条回包会被 host 拒收，桥永远等不到句柄，
    // 卡片卡在 preparing（2026-09-12 inline e2e 复现）。改 PluginSandboxHandle 必须同步这里。
    resourceMeta: z
      .object({
        prefersBorder: z.boolean().optional(),
        heightHint: z.number().int().positive().optional(),
        minFrameHeight: z.number().int().positive().optional(),
        showInline: z.boolean().optional(),
        // 资源声明的浏览器权限随句柄回 renderer（进 hostContext.permissions）；与登记请求的 permissions 同一枚举。
        permissions: z
          .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
          .optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();

// 焦点变化的 revision 用 .safe()：它会被前端当作有序比较依据，
// 超过 2^53 后比较会失去精度，宁可让消息在校验层被拒也不要让焦点顺序错乱。
// sessionId 允许 null：焦点可能落在一个还没有会话的 PiP 窗口上。
export const hostCuaPipFocusChangedMessageSchema = z
  .object({
    type: z.literal("cua-pip-focus-changed"),
    event: z
      .object({
        kind: z.literal("focus-changed"),
        revision: z.number().int().nonnegative().safe(),
        sourceWindowId: nonEmptyStringSchema.max(255),
        sessionId: nonEmptyStringSchema.max(255).nullable(),
      })
      .strict(),
  })
  .strict();

// 语言变化用共享的 localeSchema 而不是裸 string：locale 会被拼进
// i18n 加载路径，非法值（例如带斜杠）会变成一次路径穿越式读取。
export const hostApplicationLocaleChangedMessageSchema = z
  .object({
    type: z.literal("application-locale-changed"),
    locale: localeSchema,
  })
  .strict();

// 触发来源用导入的 providerProvisioningTriggerSchema，不在这里重新枚举：
// 新增触发场景（例如手动重试）必须只改那一个地方，否则会出现
// 「业务层会发、协议层拒收」的单向不一致。
export const hostProviderProvisioningExecuteMessageSchema = z
  .object({
    type: z.literal("provider-provisioning-execute"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    trigger: providerProvisioningTriggerSchema,
  })
  .strict();

/** 手机只提交项目意图；实际目录和远端 scope 必须由窗口 Host 准备。 */
// 消息体里没有 workspacePath 字段，客户端无法指定落盘目录，因此这条路径不会被绕过。
// 因此这里拒绝任何 workspacePath 字段（strict），避免客户端自行指定落盘位置。
// 两条 refine 互斥且互补：
//   1) task 与 projectId 二选一——既打开已有任务、又新建草稿，会让 Host 无法决定复用哪个目录；
//   2) draftId 只允许出现在「未分类草稿」（projectId === null）上，且 reuseDraft 必须伴随 draftId。
export const hostPrepareProjectWorkspaceMessageSchema = z
  .object({
    type: z.literal("prepare-project-workspace"),
    requestId: nonEmptyStringSchema,
    clientMode: z.literal("web-remote-replayable"),
    projectId: nonEmptyStringSchema.nullable().optional(),
    hostId: nonEmptyStringSchema.optional(),
    draftId: z.string().uuid().optional(),
    reuseDraft: z.boolean().optional(),
    task: z
      .object({ taskId: nonEmptyStringSchema, workspaceKey: nonEmptyStringSchema })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (request) => (request.task ? request.projectId === undefined : request.projectId !== undefined),
    "Exactly one task or draft intent is required",
  )
  .refine(
    (request) =>
      (!request.draftId || request.projectId === null) &&
      (!request.reuseDraft || Boolean(request.draftId)),
    "Only an unclassified draft can reuse its directory",
  );
export type HostProjectWorkspaceNavigationInput = Pick<
  z.infer<typeof hostPrepareProjectWorkspaceMessageSchema>,
  "projectId" | "hostId" | "task" | "draftId" | "reuseDraft"
>;
// 准备结果里 projectId 允许 null：新建的草稿还没有正式项目身份，
// 这与「缺省」不同（缺省表示本次不涉及项目），所以用 nullable 而不是 optional。
// workspacePath 必填：Host 必须给出一个真实可用的目录，否则手机无法打开文件树。
export const hostProjectWorkspacePreparedValueSchema = z
  .object({
    hostId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema.nullable(),
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    additionalDirectories: z.array(nonEmptyStringSchema),
    remote: windowHostRemoteWorkspaceDescriptorSchema.optional(),
  })
  .strict();
export type HostPreparedProjectWorkspace = z.infer<typeof hostProjectWorkspacePreparedValueSchema>;
// 响应用 discriminatedUnion("ok") 而不是可选字段：成功必带 value、失败必带 error，
// 合并会让「成功但没有 value」这种半成品状态通过校验，调用方随后解构出 undefined。
export const hostProjectWorkspacePreparedResponseSchema = z
  .object({
    type: z.literal("project-workspace-prepared"),
    requestId: nonEmptyStringSchema,
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: hostProjectWorkspacePreparedValueSchema }).strict(),
      z.object({ ok: z.literal(false), error: nonEmptyStringSchema }).strict(),
    ]),
  })
  .strict();

// 资源快照请求只带 requestId：采样范围由 main 决定，
// 让调用方传「要哪些进程」会把策略散落到各处，也让消息体随需求膨胀。
export const hostResourceUsageSnapshotRequestMessageSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-request"),
    requestId: nonEmptyStringSchema,
  })
  .strict();
export type HostResourceUsageSnapshotRequestMessage = z.infer<
  typeof hostResourceUsageSnapshotRequestMessageSchema
>;

// 入站消息总表：discriminatedUnion("type")。这里可以安全使用 discriminatedUnion 的前提是
// 每个成员的 type 字面量互不重复——新增消息时若与已有 type 撞名，
// zod 会在模块加载时直接抛错（而不是运行时静默取最后一个分支），这也是刻意选它的原因。
// 注意列表里内联的几条（network-capture 等）没有单独导出：它们只有一个字段，
// 单独导出反而会让 import 面变大，不便于一眼看出「谁在消费这条消息」。
export const hostIncomingMessageSchema = z.discriminatedUnion("type", [
  hostPrepareProjectWorkspaceMessageSchema,
  z.object({ type: z.literal("network-capture"), control: networkCaptureControlSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-control"), control: databaseStartupControlSchema })
    .strict(),
  hostResourceUsageSnapshotRequestMessageSchema,
  z
    .object({ type: z.literal("resource-usage-snapshot-cancel"), requestId: nonEmptyStringSchema })
    .strict(),
  hostInitLocalMessageSchema,
  hostConnectRemoteWorkspaceMessageSchema,
  hostCancelRemoteWorkspaceConnectMessageSchema,
  hostBindRemoteWorkspaceContextMessageSchema,
  hostCancelRemoteWorkspaceBindMessageSchema,
  hostDisposeRemoteWorkspaceSessionMessageSchema,
  hostAttachServicePortMessageSchema,
  hostDetachServicePortMessageSchema,
  hostDisposeMessageSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimResultMessageSchema,
  hostTaskRealtimeDeliverMessageSchema,
  hostTaskRunLeaseResultMessageSchema,
  hostTaskOwnerCommandDeliverMessageSchema,
  hostTaskOwnerCommandResultMessageSchema,
  hostSessionMessageDeliverMessageSchema,
  hostSessionMessageDeliveryResultMessageSchema,
  hostFeedbackLogArchiveResultMessageSchema,
  hostCronRunMessageSchema,
  hostOffPeakRunMessageSchema,
  hostBrowserExecuteResultMessageSchema,
  hostLocalMediaPreviewPathAuthorizeResultMessageSchema,
  hostPluginSandboxRegisterResultMessageSchema,
  hostCuaPipFocusChangedMessageSchema,
  hostApplicationLocaleChangedMessageSchema,
  hostProviderProvisioningExecuteMessageSchema,
]);

// 远端工作区响应族：connected / context-bound / bind-failed / reconnected /
// connection-log / connect-failed / closed。它们全部 strict，且都带 requestId（reconnected 除外），
// 因为每一条都要么回应一个具体请求、要么携带一个必须被精确处理的会话状态。
// 少给 requestId 会让请求方永远等不到回包；多给字段则说明两端版本已分叉。
export const hostRemoteWorkspaceConnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connected"),
    requestId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceContextBoundResponseSchema = z
  .object({
    type: z.literal("remote-workspace-context-bound"),
    requestId: nonEmptyStringSchema,
    // Desktop tab rekey only；手机 replayable attachment 不消费该提示。
    previousWorkspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

// bind-failed 的 reasonCode 与 retryable 都可选：老 Host 只会给 error 文本，
// 强制必填会让这类失败退化成「未知错误」，前端也无法决定是否自动重试。
export const hostRemoteWorkspaceContextBindFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-context-bind-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

// reconnected 不带 requestId：它是主动推送（重连由 Host 侧发起），
// previousRemoteSessionId 才是关联键——前端用它把旧会话上的视图迁移到新会话。
export const hostRemoteWorkspaceReconnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-reconnected"),
    previousRemoteSessionId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectionLogResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connection-log"),
    requestId: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: nonEmptyStringSchema,
  })
  .strict();

// resolvedWslTarget 用 wslUserSchema.refine 再兜一层非空：
// 基础 schema 允许空用户名（表示「用默认用户」），但这里已经解析出具体目标，
// 空用户名意味着解析逻辑出错，必须拒绝而不是带着空值继续连接。
export const hostRemoteWorkspaceConnectFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connect-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
    profileId: z.string().uuid().optional(),
    resolvedWslTarget: z
      .object({
        kind: z.literal("wsl"),
        distro: nonEmptyStringSchema,
        user: wslUserSchema.refine((value) => value.length > 0),
      })
      .strict()
      .optional(),
  })
  .strict();

// closed 的字段最多也最"脏"：exitCode/signal 允许 null（进程可能被信号杀掉、
// 也可能正常退出没有信号），recovery* 三个字段只在自动恢复过程中出现。
// 这些全部可选是必要的——强制必填会让「进程被 OOM 直接杀掉」这种没有退出码的关闭
// 无法上报，前端就会一直显示「重连中」。
export const hostRemoteWorkspaceClosedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-closed"),
    remoteSessionId: nonEmptyStringSchema,
    reason: z.enum(["connection-closed", "disposed", "connect-cancelled"]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional(),
    recoverable: z.boolean().optional(),
    recoveryAttempt: z.number().int().positive().optional(),
    recoveryLimit: z.number().int().positive().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

// host 日志不 strict 且 source/message 都用裸 string：
// 日志是排障通道，宁可放行一条格式不完美的记录，也不要在边界处把它丢掉——
// 被丢的往往正是那条「出错前的最后一条日志」。
export const hostLogResponseSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
});

export { zcodeProviderSchema };

// 迁移来源目前只有 claudeCode 一个值，仍然用 z.enum 而不是字面量：
// 保留扩展位（cursor 等）时，消费方的 switch 已经按枚举写好，
// 新增值只需要改这一行，不会散落成多处字符串比较。
export const zcodeTaskMigrationSourceSchema = z.enum(["claudeCode"]);

// 进程生命周期四事件（spawned / ready / exited / error / exception）共享同一套定位字段：
// lane 可选是为了兼容还没打标的旧 Host（见下面各字段注释），
// provider/workspacePath/pid 必填，否则前端无法把事件归到某个工作区的某个进程卡片上。
export const hostAgentProcessSpawnedResponseSchema = z.object({
  type: z.literal("agent-process-spawned"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  startedAt: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive().optional(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
});
export type HostAgentProcessSpawnedResponse = z.infer<typeof hostAgentProcessSpawnedResponseSchema>;

// ready 的 runtimeGeneration / runtimeInstanceId 在这里是必填（spawned 里是可选）：
// 「就绪」这个状态必须对应一个确定的运行时实例，否则重启后迟到的 ready
// 会把新实例标记成就绪，而实际上新实例还在启动中。
export const hostAgentProcessReadyResponseSchema = z.object({
  type: z.literal("agent-process-ready"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  readyAt: z.number().int().nonnegative(),
  startupDurationMs: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema,
});
export type HostAgentProcessReadyResponse = z.infer<typeof hostAgentProcessReadyResponseSchema>;

// stderrTail 限量（每行 1100 字符、最多 20 行）是为了让「进程崩溃」这条消息
// 即使带着一段栈也不会撑爆 IPC 帧；截断在采集侧完成，这里只做最后一道保险。
// terminationKind 是闭合枚举：它直接决定是否自动重启，未知值不能靠猜。
export const hostAgentProcessExitedResponseSchema = z.object({
  type: z.literal("agent-process-exited"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  endedAt: z.number().int().nonnegative(),
  terminationKind: z.enum(["expected", "unexpected", "watchdog_recycle"]),
  terminationReason: z.string().optional(),
  /** rolling-upgrade 兼容：旧 Host 缺字段时 desktop 映射 crash_phase=unknown。 */
  runtimeReady: z.boolean().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  uptimeMs: z.number().int().nonnegative(),
  stderrLineCount: z.number().int().nonnegative(),
  stderrTail: z.array(z.string().max(1_100)).max(20).optional(),
});

export type HostAgentProcessExitedResponse = z.infer<typeof hostAgentProcessExitedResponseSchema>;

// error 事件的 pid 允许 null：有些错误发生在 spawn 成功之前，
// 此时没有 pid 可报。用 nullable 而不是 optional，是为了让「明确没有 pid」
// 与「调用方忘了传」在类型层面可区分。
export const hostAgentProcessErrorResponseSchema = z.object({
  type: z.literal("agent-process-error"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive().nullable(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  errorName: nonEmptyStringSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string(),
  errorStack: z.string().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  occurredAt: z.number().int().nonnegative(),
});

export type HostAgentProcessErrorResponse = z.infer<typeof hostAgentProcessErrorResponseSchema>;

// exception 走 strict 且诊断信息整体交给 zcodeProcessDiagnosticSchema：
// 这条消息只在真正的崩溃场景发出，字段集合完全由本仓库定义，
// 多余字段说明发错了对象——早拒比让诊断信息里混进无关字段更好排查。
export const hostAgentProcessExceptionResponseSchema = z
  .object({
    type: z.literal("agent-process-exception"),
    lane: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive(),
    provider: zcodeProviderSchema,
    workspacePath: nonEmptyStringSchema,
    runtimeGeneration: z.number().int().positive(),
    runtimeInstanceId: nonEmptyStringSchema,
    diagnostic: zcodeProcessDiagnosticSchema,
  })
  .strict();
export type HostAgentProcessExceptionResponse = z.infer<
  typeof hostAgentProcessExceptionResponseSchema
>;

/**
 * services 打标后的 CLI 资源样本。
 *
 * `lane` 不是 CLI 协议字段：CLI 进程不知道自己被哪个进程管理器拉起，由 services 层在解析
 * 协议样本时按所属进程管理器补上。样本自身仍按 CLI 协议 schema 严格校验，因此 CLI 自报 lane
 * 会被协议层直接拒绝。`lane` 可选是为了兼容版本落后、还没打标的远端 server。
 */
export const processResourceCliLaneSchema = z.enum(PROCESS_RESOURCE_CLI_LANES);
export const agentLaneResourceSampleSchema = zcodeProcessResourceSampleSchema
  .extend({ lane: processResourceCliLaneSchema.optional() })
  .strict();
export type AgentLaneResourceSample = z.infer<typeof agentLaneResourceSampleSchema>;

/** Host 仅传运行环境的 SHA-256 哈希，避免原始主机、用户或 URL 进入消息与日志。 */
const resourceTelemetryEnvironmentKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

// 资源样本的三层来源（CLI 自采、Node 自采、renderer heap）各自有独立 schema，
// 不做成一个「全可选字段」的联合：三者的必填项完全不同，
// 合并后「缺了必填字段」会退化成「值为 undefined 但校验通过」，图表出现空洞。
// environmentKey 只传 SHA-256：原始主机名/用户名/URL 不进消息，避免日志侧泄露环境信息。
export const hostAgentResourceSampleResponseSchema = z
  .object({
    type: z.literal("agent-resource-sample"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    sample: agentLaneResourceSampleSchema,
  })
  .strict();
export type HostAgentResourceSampleResponse = z.infer<typeof hostAgentResourceSampleResponseSchema>;

/**
 * Node 进程（host / scheduler）每 60 秒自采的瞬时事实
 *
 * 只带这三项：CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，heap 只有进程自己读得到。
 */
export const nodeSelfResourceSampleSchema = z
  .object({
    /**
     * 整机归一化 CPU 百分比，100 表示所有逻辑核占满。
     * 上限刻意放宽（与 CLI 的 `zcodeProcessResourceSampleSchema` 同口径）：读数异常时宁可让
     * 样本带着离谱数值上去、由平台侧数值异常规则暴露，也不在客户端静默丢样本。
     */
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NodeSelfResourceSample = z.infer<typeof nodeSelfResourceSampleSchema>;

/**
 * 主窗口 renderer 每 60 秒经 preload 桥送 main 的 heap 读数
 *
 * 只带 heap：renderer 的 CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，
 * renderer 自己也读不到。`strict` 保证 UI 侧不会顺手夹带路径、session 等隐私字段。
 */
export const rendererHeapSampleSchema = z
  .object({
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RendererHeapSample = z.infer<typeof rendererHeapSampleSchema>;

// 三类资源遥测响应的外壳形状一致：type + runtimeSurface + 样本本体。
// runtimeSurface 必填且只有 local/remote 两个值——它决定平台侧把样本记到哪个环境的账上，
// 缺省或猜测会让本地开发机的资源消耗被算进线上租户。
export const hostResourceSampleResponseSchema = z
  .object({
    type: z.literal("host-resource-sample"),
    sample: nodeSelfResourceSampleSchema,
  })
  .strict();
export type HostResourceSampleResponse = z.infer<typeof hostResourceSampleResponseSchema>;

export const hostMcpResourceSamplesResponseSchema = z
  .object({
    type: z.literal("mcp-resource-samples"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    samples: zcodeMcpResourceSamplesSchema,
  })
  .strict();
export type HostMcpResourceSamplesResponse = z.infer<typeof hostMcpResourceSamplesResponseSchema>;

export const hostToolExecResourceResponseSchema = z
  .object({
    type: z.literal("tool-exec-resource"),
    runtimeSurface: z.enum(["local", "remote"]),
    sample: zcodeToolExecResourceSchema,
  })
  .strict();
export type HostToolExecResourceResponse = z.infer<typeof hostToolExecResourceResponseSchema>;

export const hostMcpTelemetryResponseSchema = z
  .object({
    type: z.literal("mcp-telemetry"),
    runtimeSurface: z.enum(["local", "remote"]),
    event: zcodeMcpTelemetryEventSchema,
  })
  .strict();
export type HostMcpTelemetryResponse = z.infer<typeof hostMcpTelemetryResponseSchema>;

// plugin telemetry 用 refine 限定 elementName 三个取值：
// 这里不能换成 z.enum，因为 event 是共享的 rendererTelemetryEventPayloadSchema，
// 它的 elementName 是开放字符串（其他遥测会用别的名字），
// 只能在插件这一条通路上再加一层过滤。
export const hostPluginTelemetryResponseSchema = z
  .object({
    type: z.literal("plugin-telemetry"),
    event: rendererTelemetryEventPayloadSchema.refine((event) =>
      ["plugin_lifecycle", "plugin_usage", "plugin_runtime_error"].includes(event.elementName),
    ),
  })
  .strict();
export type HostPluginTelemetryResponse = z.infer<typeof hostPluginTelemetryResponseSchema>;

export const hostSessionCreateTelemetryResponseSchema = z
  .object({
    type: z.literal("session-create-telemetry"),
    event: automationSessionCreateTelemetrySchema,
  })
  .strict();
export type HostSessionCreateTelemetryResponse = z.infer<
  typeof hostSessionCreateTelemetryResponseSchema
>;

// 两个「运行中任务数」消息刻意分成 agent 级与 workspace 级两条：
// agent 级用于侧边栏汇总（不关心目录），workspace 级用于目录上的角标。
// 合成一条会让不需要路径的场景也必须携带路径，且 workspace 缺失时无法表达。
export const hostAgentRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("agent-running-task-count-changed"),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostWorkspaceRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("workspace-running-task-count-changed"),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  runningTaskCount: z.number().int().nonnegative(),
});

// cua 操作态必须带全 session/turn/workspace 三段定位：
// active 只表示「有没有人在操作」，前端要靠这三段把「正在被远程操作」的提示
// 精确挂到对应任务的标题栏上，缺任何一段都会挂到错误的会话。
export const hostCuaOperationStateResponseSchema = z
  .object({
    type: z.literal("cua-operation-state"),
    active: z.boolean(),
    sessionId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export type HostCuaOperationStateResponse = z.infer<typeof hostCuaOperationStateResponseSchema>;

// 占用请求/提交/释放都带 key，且 commit/release 额外带 claimToken：
// token 是「谁真正持有这把锁」的唯一凭证，只按 key 释放会让一个超时的旧持有者
// 释放掉别人刚抢到的锁，表现为两个窗口同时广播。
export const hostBroadcastClaimRequestResponseSchema = z.object({
  type: z.literal("broadcast-claim-request"),
  requestId: nonEmptyStringSchema,
  key: nonEmptyStringSchema.max(1_024),
});

export const hostBroadcastClaimCommitResponseSchema = z.object({
  type: z.literal("broadcast-claim-commit"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostBroadcastClaimReleaseResponseSchema = z.object({
  type: z.literal("broadcast-claim-release"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

// 以下 task-realtime 发布消息都是「main 把事件转交给 host」的信封：
// 本体 schema 来自 task-realtime-core，这里不重复定义字段，
// 保证「下发」与「上报」两个方向对同一事件的理解永远一致。
export const hostTaskRealtimePublishResponseSchema = z.object({
  type: z.literal("task-realtime-publish"),
  event: taskRealtimeEventSchema,
});

// 流镜像发布把 target 与 op 分开：target 决定「镜像到哪」，op 是「镜像什么」。
// 顺序上 target 在前是因为下游先按 target 找通道、再解码 op；
// 合并成一条会让同一 target 的多次 op 无法复用通道查找结果。
export const hostTaskStreamOpPublishResponseSchema = z.object({
  type: z.literal("task-stream-op-publish"),
  target: taskStreamMirrorTargetSchema,
  op: taskStreamMirrorPublishOpSchema,
});

// 租约的 acquire 带 request（含期望时长），release 只带 target：
// 释放不需要时长，若两边用同一个结构，release 就必须传一个无意义的时长字段，
// 容易被误填成 0 而触发「立即过期」的分支。
export const hostTaskRunLeaseAcquireResponseSchema = z.object({
  type: z.literal("task-run-lease-acquire"),
  request: taskRunLeaseAcquireRequestSchema,
});

export const hostTaskRunLeaseReleaseResponseSchema = z.object({
  type: z.literal("task-run-lease-release"),
  target: taskRunLeaseTargetSchema,
});

// owner command 的 request 与 result 分成两条消息：
// 命令执行可能跨越一次进程重启，result 必须能在不知道原 request 的情况下独立送达，
// 因此它携带的是 result 而不是「requestId + 结果」的复合体。
export const hostTaskOwnerCommandRequestResponseSchema = z.object({
  type: z.literal("task-owner-command-request"),
  command: taskOwnerCommandRequestSchema,
});

export const hostTaskOwnerCommandResultResponseSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

// send-requested 与 route-announce 是两条不同的消息：前者表示「有消息要发」，
// 后者表示「我已准备好接收」。合成一条会让发送方在对方还没就绪时误判为可投递。
export const hostSessionMessageSendRequestedResponseSchema = z.object({
  type: z.literal("session-message-send-requested"),
  request: sessionMessageRequestSchema,
});

export const hostSessionRouteAnnounceResponseSchema = z.object({
  type: z.literal("session-route-announce"),
  route: sessionRouteSchema,
});

// deliver-result 单独成消息而不是放在 send-requested 的返回值里：
// 投递是异步的，且可能跨进程重启，发送方需要一条独立、可重放的结果通道。
export const hostSessionMessageDeliverResultResponseSchema = z.object({
  type: z.literal("session-message-deliver-result"),
  result: sessionMessageDeliveryResultSchema,
});

// 归档请求只带 sourceDir：要归档哪些文件由 main 侧按目录扫描决定，
// 让 Host 传文件列表会把「什么该进归档」的策略散到两端，且列表可能很长。
export const hostFeedbackLogArchiveRequestResponseSchema = z.object({
  type: z.literal("feedback-log-archive-request"),
  requestId: nonEmptyStringSchema,
  sourceDir: nonEmptyStringSchema,
});

// host → main：定时任务派发结果。ok=已成功创建 session 且 prompt 已发出。
// cron 运行结果只带 automationId + runId：任务本体已经在会话里落盘，
// 这里再回传一份 meta 会让「以哪份为准」出现二义性。
// 失败时 error 可缺失（中断类失败没有 message），因此不强制成对出现。
export const hostCronRunResultResponseSchema = z.object({
  type: z.literal("cron-run-result"),
  runId: nonEmptyStringSchema,
  ok: z.boolean(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：闲时任务派发结果。ok=session 已确保存在且 prompt 已发出；迟到结果用 offPeakTaskId 兜底结算。
// off-peak 结果多带 serverTicketId：它是配额结算凭证，missing 会让闲时用量算到在线额度上，
// 所以这条消息里它是必填，与 cron 结果刻意不同。
export const hostOffPeakRunResultResponseSchema = z.object({
  type: z.literal("off-peak-run-result"),
  offPeakTaskId: nonEmptyStringSchema,
  ok: z.boolean(),
  /** Host 已在开放 CLI 生命周期事件前完成接纳落库；调度器只清理退避。 */
  lifecycleManaged: z.literal(true).optional(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：manual run 落库后的 scheduler 唤醒请求；业务数据仍由 scheduler 从 sqlite 读取。
// 两个 scheduler-wake 消息只带 trigger（谁唤醒了调度器）：
// 唤醒不携带任何业务数据，真正的任务参数由调度器自行从持久化里读，
// 这样即使唤醒消息丢失一次，下一次定时仍能正常调度。
export const hostCronSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("cron-scheduler-wake-request"),
  automationId: nonEmptyStringSchema,
});

// host → main：闲时任务 schedulable 翻转后的 scheduler 唤醒；业务数据仍由 scheduler 从 sqlite 读取。
// off-peak 的唤醒单独一条而不是复用 cron 的：两者由不同调度器维护，
// 合并后 trigger 枚举会被迫接受对方的取值，校验就失去了区分能力。
export const hostOffPeakSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("off-peak-scheduler-wake-request"),
  offPeakTaskId: z.string().optional(),
});

// host → main：执行一条 browser-use 命令（main 用 WebContentsView+CDP 执行）。
// browser 请求的 request 用 unknown：动作脚本本身由浏览器工具自己定义，
// 协议层只负责转发；在这里收窄会迫使每新增一个动作都改共享包。
// 这里是 .strict()，因为信封字段集合由本仓库完全掌握。
export const hostBrowserExecuteRequestResponseSchema = z.object({
  type: z.literal("browser-execute-request"),
  requestId: nonEmptyStringSchema,
  // 迁移兼容：旧 host bundle 没有 browserId/context；新 browser-client 链路始终携带。
  browserId: nonEmptyStringSchema.optional(),
  browserGeneration: z.number().int().nonnegative().optional(),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema.optional(),
  workspaceKey: nonEmptyStringSchema.optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  sessionContext: z.enum(["live", "cached"]).optional(),
  command: browserCommandSchema,
});

// 授权请求带 path 而不是 url：预览走本地文件协议，url 形式会被用来绕过
// 路径白名单。这里 strict 且 path 非空，避免 renderer 传入空路径后
// 授权逻辑把它解析成当前工作目录，从而放行整个目录。
export const hostLocalMediaPreviewPathAuthorizeRequestResponseSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-request"),
    requestId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strict();

/** host → main：登记已校验的插件 UI HTML。 */
// 插件沙箱登记同时服务两种来源（gen-ui 与 tool/surface），末尾的 refine 保证来源字段自洽：
// gen-ui 是 MCP App 自带的 UI 资源，不允许带 pluginId/serverName/permissions；
// 其余来源必须同时给出 pluginId 与 serverName。
// 这条互斥约束不能省：缺了它，一个 gen-ui 资源可以伪造 pluginId，
// 从而在渲染进程里拿到插件级的权限与持久化存储。
// csp 与 cspRelaxations 各自 .strict()：CSP 多一个键就意味着「以为放宽了但没生效」，
// 静默 strip 会让人排查很久（策略看起来写了，浏览器行为却不变）。
export const hostPluginSandboxRegisterRequestResponseSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-request"),
    instance: mcpAppInstanceSchema,
    requestId: nonEmptyStringSchema,
    workspacePath: z.string().optional(),
    workspaceIdentity: z.string().optional(),
    ownerWebContentsId: z.number().int().nonnegative(),
    sessionId: nonEmptyStringSchema,
    contentKind: z.literal("gen-ui").optional(),
    pluginId: nonEmptyStringSchema.optional(),
    // 资源所属 MCP server 运行时名：沙箱 partition 按它派生。
    serverName: nonEmptyStringSchema.optional(),
    // 沙箱作用域 id（`tool:<toolCallId>` / `surface:<surfaceId>`），main 只当不透明字符串。
    scopeId: nonEmptyStringSchema,
    html: z.string(),
    // MCP Apps 资源级 CSP 的四类域；与 mcp-apps 的 mcpToolUiCspSchema 同步。
    csp: z
      .object({
        connectDomains: z.array(z.string()).optional(),
        resourceDomains: z.array(z.string()).optional(),
        frameDomains: z.array(z.string()).optional(),
        baseUriDomains: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // 资源级 `_meta["zcode/csp"]` 放宽项；与 mcp-apps 的 mcpAppCspRelaxationsSchema 同步。
    cspRelaxations: z
      .object({ unsafeEval: z.boolean().optional(), wasmUnsafeEval: z.boolean().optional() })
      .strict()
      .optional(),
    // 资源级 `_meta.ui.permissions`（规范四键）；与 mcp-apps 的 MCP_APPS_RESOURCE_PERMISSIONS 同步。
    permissions: z
      .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
      .optional(),
    prefersBorder: z.boolean().optional(),
    // 资源级尺寸提示，main 原样放进句柄的 resourceMeta。strict schema：改 PluginSandboxRegisterRequestPayload 必须同步这里。
    heightHint: z.number().int().positive().optional(),
    minFrameHeight: z.number().int().positive().optional(),
    showInline: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.contentKind === "gen-ui"
        ? !value.pluginId && !value.serverName && !value.permissions?.length
        : Boolean(value.pluginId && value.serverName),
    "Invalid sandbox provenance",
  );

// 单条网络观测：transport 是闭合枚举（决定后续按哪种协议解读时延字段），
// 其余全部可选，因为失败观测往往只有 ok=false 与 errorKind，没有 dns/tcp/tls 分段。
// durationMs 用裸 number 而不是 finite：这一层只做形状校验，
// 极端值（被系统时钟跳变影响）不应该让整批遥测被丢弃。
export const networkObservationSchema = z.object({
  transport: z.enum(["http", "websocket", "rpc"]),
  interface: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  statusCode: z.number().optional(),
  errorKind: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  dnsMs: z.number().optional(),
  tcpMs: z.number().optional(),
  tlsMs: z.number().optional(),
  ttfbMs: z.number().optional(),
  downloadMs: z.number().optional(),
});

// 一批最多 500 条：观测是高频数据，不设上限时一次上报可能撑爆 IPC 帧，
// 而这里的 500 是「收集窗口内可能出现的真实上限」，不是随意选的性能参数。
export const hostNetworkTelemetryBatchResponseSchema = z.object({
  type: z.literal("network-telemetry-batch"),
  observations: z.array(networkObservationSchema).max(500),
});

// 这里用 exclude 去掉 environment-online：该触发源由另一条消息负责，
// 让它出现在这条消息里会导致同一事件被处理两次，provisioning 重复执行。
// exclude 的结果仍是枚举，因此非法值依然会被拒绝。
export const hostProviderProvisioningSourceChangedResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-source-changed"),
    trigger: providerProvisioningTriggerSchema.exclude(["environment-online"]),
  })
  .strict();

// status 用五值枚举而不是 ok+error 两段：already-applied 与 unsupported 都不是失败，
// 但后续动作完全不同（前者什么也不做，后者要提示用户升级），
// 压成布尔值会让这两种状态被迫归入「失败」并触发错误的回滚逻辑。
// error/errorCode 都可选：只有 failed 与 rollback_failed 才会带，缺失不算异常。
export const hostProviderProvisioningExecutionResultResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-execution-result"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    error: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
  })
  .strict();

// 进程条目的 cpuPercent/memoryBytes 用 finite().nonnegative()：
// 采样器在进程刚退出时会读到 0 或瞬时负值（两次采样的差值），
// 这里拒绝负数但允许 0；非有限值（除零产生）必须拒绝，否则前端宽度计算会得到 NaN。
// groupKey 与 groupLabel 都必填：前者用于聚合去重，后者用于展示，缺任一都只能显示原始 pid。
export const hostResourceUsageProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: nonEmptyStringSchema,
    category: z.enum(["base", "builtin-plugin", "community-plugin"]),
    groupKey: nonEmptyStringSchema,
    groupLabel: nonEmptyStringSchema,
    cpuPercent: z.number().finite().nonnegative(),
    memoryBytes: z.number().finite().nonnegative(),
  })
  .strict();

// 快照上限 10000 个进程：超出说明采样逻辑出错（例如按线程而不是按进程枚举），
// 与其把几十 MB 的数组送过去，不如在边界处拒绝并让上层看到错误。
export const hostResourceUsageSnapshotResultResponseSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-result"),
    requestId: nonEmptyStringSchema,
    sampledAt: z.number().int().nonnegative(),
    processes: z.array(hostResourceUsageProcessSchema).max(10_000),
  })
  .strict();
export type HostResourceUsageSnapshotResultResponse = z.infer<
  typeof hostResourceUsageSnapshotResultResponseSchema
>;

// host → main 的响应总表：与 hostIncomingMessageSchema 方向相反，同样是 discriminatedUnion。
// 这里的成员绝大多数是导出的具名 schema，只有两条内联（network-capture-batch、
// database-startup-state）：它们只在这个方向出现一次，独立导出反而增加维护面。
// 新增响应时除了往这里加，还必须确认对应 type 字面量在入站表里没有被占用——
// 两个方向共用一个 type 值会让日志与抓包无法区分流向。
export const hostResponseMessageSchema = z.discriminatedUnion("type", [
  hostProjectWorkspacePreparedResponseSchema,
  z.object({ type: z.literal("network-capture-batch"), batch: networkCaptureBatchSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-state"), state: databaseStartupStateSchema })
    .strict(),
  hostResourceUsageSnapshotResultResponseSchema,
  hostRemoteWorkspaceConnectionLogResponseSchema,
  hostRemoteWorkspaceConnectedResponseSchema,
  hostRemoteWorkspaceContextBoundResponseSchema,
  hostRemoteWorkspaceContextBindFailedResponseSchema,
  hostRemoteWorkspaceReconnectedResponseSchema,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  hostRemoteWorkspaceClosedResponseSchema,
  hostLogResponseSchema,
  hostAgentProcessSpawnedResponseSchema,
  hostAgentProcessReadyResponseSchema,
  hostAgentProcessExitedResponseSchema,
  hostAgentProcessErrorResponseSchema,
  hostAgentProcessExceptionResponseSchema,
  hostAgentResourceSampleResponseSchema,
  hostResourceSampleResponseSchema,
  hostMcpTelemetryResponseSchema,
  hostMcpResourceSamplesResponseSchema,
  hostToolExecResourceResponseSchema,
  hostSessionCreateTelemetryResponseSchema,
  hostPluginTelemetryResponseSchema,
  hostAgentRunningTaskCountChangedResponseSchema,
  hostWorkspaceRunningTaskCountChangedResponseSchema,
  hostCuaOperationStateResponseSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimRequestResponseSchema,
  hostBroadcastClaimCommitResponseSchema,
  hostBroadcastClaimReleaseResponseSchema,
  hostTaskRealtimePublishResponseSchema,
  hostTaskStreamOpPublishResponseSchema,
  hostTaskRunLeaseAcquireResponseSchema,
  hostTaskRunLeaseReleaseResponseSchema,
  hostTaskOwnerCommandRequestResponseSchema,
  hostTaskOwnerCommandResultResponseSchema,
  hostSessionMessageSendRequestedResponseSchema,
  hostSessionRouteAnnounceResponseSchema,
  hostSessionMessageDeliverResultResponseSchema,
  hostFeedbackLogArchiveRequestResponseSchema,
  hostBrowserExecuteRequestResponseSchema,
  hostLocalMediaPreviewPathAuthorizeRequestResponseSchema,
  hostPluginSandboxRegisterRequestResponseSchema,
  hostNetworkTelemetryBatchResponseSchema,
  hostProviderProvisioningSourceChangedResponseSchema,
  hostProviderProvisioningExecutionResultResponseSchema,
  hostCronRunResultResponseSchema,
  hostOffPeakRunResultResponseSchema,
  hostCronSchedulerWakeRequestResponseSchema,
  hostOffPeakSchedulerWakeRequestResponseSchema,
]);

// 持久化任务状态只有三态：这里的值会写进 tasks 表的索引列，
// 新增状态必须同时改表结构与所有按 status 过滤的查询，否则新状态的任务在列表里会消失。
export const zcodeTaskPersistStatusSchema = z.enum(["running", "completed", "error"]);

// 图片附件允许 dataBase64 与 localPath 都不存在：只登记元信息（大小、mime）而不带内容的
// 场景是合法的（例如会话被裁剪过大附件后保留占位）。因此这里不能要求二者至少有一个，
// 否则历史会话会整条解析失败，用户看到会话内容缺失。
export const zcodePromptImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// 附件 TypeScript 联合类型新增 video 后，手写的持久化运行时 schema 未同步，
// session 恢复解析会拒绝含视频的用户消息。字段与 image 的 inline/local 引用语义保持一致。
export const zcodePromptVideoAttachmentSchema = z.object({
  kind: z.literal("video"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// pdf 与 image/video 结构完全一致仍然分开声明：三者是判别式联合的独立分支，
// 合并意味着 kind 不再能定位到具体的处理逻辑（预览器不同）。
export const zcodePromptPdfAttachmentSchema = z.object({
  kind: z.literal("pdf"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// file 与前三者的差异是 sizeBytes 必填且有 textContent：
// 文本类附件必须知道大小（用于决定是否内联进 prompt），
// 同时它可能以纯文本而非 base64 传输，所以不能复用前三个 schema。
export const zcodePromptFileAttachmentSchema = z.object({
  kind: z.literal("file"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string().optional(),
  textContent: z.string().optional(),
  localPath: z.string().optional(),
});

// 四个分支的 kind 互斥，因此用 discriminatedUnion 而不是 union：
// 解析时能直接定位到分支，非法输入会得到「kind 不在候选内」这种可读错误，
// 而不是四条分支各报一堆缺失字段。
// 新增附件类型（例如音频）必须同时加到这里与前面的 TypeScript 联合类型——
// 只加类型不加 schema 会出现「新类型能构造、持久化后被静默剥掉」的问题（见下方 video 注释）。
export const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  zcodePromptImageAttachmentSchema,
  zcodePromptVideoAttachmentSchema,
  zcodePromptPdfAttachmentSchema,
  zcodePromptFileAttachmentSchema,
]);

// 工具调用记录整体宽松（除 input 外全可选）：它是历史回放用的快照，
// 各个 provider 的字段差异很大，任何一处收紧都会让旧会话在恢复时被拒绝。
// input 必填是因为工具卡片必须能展示参数；output/error 互斥但这里不校验，
// 失败工具也可能有部分输出（流式中断），强行互斥会丢掉那部分内容。
// snapshotRefs 只记录「哪个字段被外置成了快照」，不存内容本身，
// 因此它的存在与否不影响字段可读性，可安全省略。
export const zcodePersistedToolCallSchema = z.object({
  toolName: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(["completed", "failed", "denied", "stopped"]).optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
  snapshotRefs: z
    .array(
      z.object({
        field: z.enum(["input", "output", "raw"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

// 消息分段只有三种：content / thought / tool-call。
// tool-call 分支用 toolIndex 而不是完整工具对象——工具本体存在 messages[].tools 里，
// 分段只保留索引，避免同一份工具数据在会话文件里存两份（体积与一致性都会出问题）。
const zcodePersistedMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: z.string() }),
  z.object({ type: z.literal("thought"), content: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolIndex: z.number().int().nonnegative(),
  }),
]);

// 持久化消息是会话文件里体量最大的结构，因此这里的取舍是「宁可放过、不可误拒」：
// id/timestamp 之外几乎全部可选，因为不同年代的会话文件字段集不断变化，
// 收紧任何一项都会让老会话在恢复时整条被剥掉（用户看到对话凭空少了几轮）。
// checkpointState 只有 partial 一个值：它标记「这条消息是被中断后补写的」，
// 用 enum 而不是 boolean 是为了将来能扩展更多中断态而不改字段语义。
// turnIndex 参与多轮工具结果的归属判断，缺省时下游按消息顺序推断。
export const zcodePersistedMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  model: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  // assistant 历史耗时已经在服务层落盘为 durationMs，
  // 但校验 schema 没同步，saveTask/getTaskSnapshot 解析时会把它静默剥掉，
  // 导致新消息结束后 UI 仍然只能看到“Worked”。这里补上字段以保留持久化值。
  durationMs: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
  attachments: z.array(zcodePromptAttachmentSchema).optional(),
  tools: z.array(zcodePersistedToolCallSchema).optional(),
  thought: z.string().optional(),
  parts: z.array(zcodePersistedMessagePartSchema).optional(),
  checkpointState: z.enum(["partial"]).optional(),
  checkpointReason: z.enum(["tool_completed", "part_boundary", "periodic"]).optional(),
  checkpointUpdatedAt: z.number().int().nonnegative().optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  // snapshot 按需加载依赖 bodyRefs（content/thought -> refId）定位完整内容；
  // 若 schema 缺字段，Zod 会在解析 session 文件时静默剥离，导致“加载完整内容”功能失效。
  bodyRefs: z
    .array(
      z.object({
        field: z.enum(["content", "thought"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  toolSlice: z
    .object({
      persistedMessageIndex: z.number().int().nonnegative(),
      totalTools: z.number().int().nonnegative(),
      startToolIndex: z.number().int().nonnegative(),
      endToolIndexExclusive: z.number().int().nonnegative(),
    })
    .optional(),
});

// 目标状态四态：budget_limited 是「预算耗尽但目标未完成」，与 complete 必须分开——
// 前者要提示用户加预算，后者是成功终态。合并两者会让配额耗尽的提示变成「已完成」。
export const zcodeTaskGoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

// 变更动作是审计用的闭合枚举：usage_accounted 与 run_started/finished 属于内部记账，
// 与用户可见的 set/cleared 混在同一个字段里，是为了让「一次目标变更」只产生一条事件，
// 而不是拆成业务事件 + 记账事件两条（否则前端要按时间合并）。
export const zcodeTaskTargetChangedActionSchema = z.enum([
  "set",
  "status_updated",
  "cleared",
  "usage_accounted",
  "run_started",
  "run_finished",
  "summary_updated",
]);

// 来源只有 command / tool / runtime：它决定变更事件是否需要回显到对话流。
// tool 触发的变更要显示成一张工具卡片，runtime 触发的（例如自动暂停）只更新状态栏。
export const zcodeTaskTargetChangedSourceSchema = z.enum(["command", "tool", "runtime"]);

// 目标本体同时是「持久化结构」与「事件 payload」，因此字段取值必须两端都能解读：
// tokenBudget 用 positive().nullable()——null 表示「不限额」，而不是 0；
// 若允许 0，会让「没设预算」和「预算已用完」无法区分。
// activeInputId / activeRun* 三个字段可选：只有在目标处于运行中时才存在，
// 用 nullable+optional 是为了区分「有值」「显式清空」「从没有过」三种历史状态。
// time.created/updated 必填：没有时间的目标无法参与「最近使用」排序与冲突合并。
export const zcodeTaskGoalSchema = z.object({
  sessionID: nonEmptyStringSchema,
  targetID: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  // 2.15.0 之前的 /goal 历史任务没有写 summaryTitle。
  // 读取 task index 老数据时要补成 null，否则整个任务列表会被运行时 schema 拒绝。
  summaryTitle: z.string().min(1).nullable().default(null),
  status: zcodeTaskGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  activeInputId: nonEmptyStringSchema.nullable().optional(),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().optional(),
  activeRunLastSeenAtMs: z.number().int().nonnegative().nullable().optional(),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  }),
});

// patch 里 target 允许 null（表示目标被清除），previousTarget 可选（表示「没有旧值」）。
// 两者都必须可空，否则「清除目标」这条最常见的事件无法表达——
// 用空对象代替 null 会让下游把它当成一个字段全空的新目标。
export const zcodeTaskGoalChangedPatchSchema = z.object({
  action: zcodeTaskTargetChangedActionSchema,
  source: zcodeTaskTargetChangedSourceSchema,
  target: zcodeTaskGoalSchema.nullable(),
  previousTarget: zcodeTaskGoalSchema.nullable().optional(),
});

// 这三个别名是历史命名（target 系列）到新命名（goal 系列）的过渡：
// 保留同一对象而不是各自定义，保证两套名字的校验行为永远一致；
// 删除别名之前必须先确认持久化数据与外部调用方都已迁移。
export const zcodeTaskTargetStatusSchema = zcodeTaskGoalStatusSchema;
export const zcodeTaskTargetSchema = zcodeTaskGoalSchema;
export const zcodeTaskTargetChangedPatchSchema = zcodeTaskGoalChangedPatchSchema;

// 任务元信息是索引与旧会话文件共享的结构，因此大量字段可选：
// 收紧任何一个都会让历史任务在列表里整条消失（而不是显示成缺字段）。
// title 允许空串：新建任务后、首个 prompt 生成标题前就处于这个状态。
// workspacePath 必填：没有目录的任务无法被恢复，与其让它出现在列表里点开报错，
// 不如在校验阶段就拒绝。
// lastError.message 用 min(1)：错误卡片必须有一段可读文本，空消息会渲染成一个空框。
export const zcodeTaskMetaSchema = z.object({
  taskId: nonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  mode: zcodeTaskModeSchema,
  model: z.string().optional(),
  thoughtLevel: nonEmptyStringSchema.optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  // meta 直接解析自 tasks-index/旧 session 文件；历史 provider 值在此归一为 glm。
  provider: legacyZCodeProviderSchema.optional(),
  migrationSource: zcodeTaskMigrationSourceSchema.optional(),
  forkedFromTaskId: nonEmptyStringSchema.optional(),
  // cron automation 身份：随 meta_json 一起持久化（单一来源），同时在写入时投影到 tasks 表
  // cron_automation_id 索引列，供按 automation 反查 session。runId 属于 automation_runs /
  // 投递 metadata，不属于 task 表。
  cronAutomationId: nonEmptyStringSchema.optional(),
  // off-peak 身份：与 cron 同款持久化策略——meta_json 单一来源 + tasks 表
  // off_peak_task_id 索引投影列（兜底/反查）。
  offPeakTaskId: nonEmptyStringSchema.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: zcodeTaskPersistStatusSchema.optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      detail: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyStringSchema.optional(),
      taskId: nonEmptyStringSchema.optional(),
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  repairState: z
    .object({
      claudeNativeSnapshotAssistantContentVersion: z.number().int().nonnegative().optional(),
      codexNativeSnapshotSubagentToolsVersion: z.number().int().nonnegative().optional(),
    })
    .optional(),
  changeSummary: z
    .object({
      fileCount: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      files: z.array(
        z.object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  target: zcodeTaskGoalSchema.nullable().optional(),
});

// 绑定状态五态：stale 表示「会话文件还在但已落后于数据库」，
// 它必须与 failed 分开——stale 可以自动补齐，failed 只能让用户重试，
// 合并后前端会对可自愈的状态弹错误框。
export const zcodeTaskSessionBindingStateSchema = z.enum([
  "idle",
  "syncing",
  "ready",
  "stale",
  "failed",
]);

// binding 里的 lastSyncedTurnIndex 允许 -1（空任务的锚点），因此不能套 nonnegative，
// 但仍要求整数：小数会让「已同步到第几轮」的比较出现偏移一位的错误。
// provider 用 legacy 兼容 schema：历史绑定里可能存在已下线的 provider 名，
// 这里归一为 glm 而不是拒绝，否则老任务会打不开。
export const zcodeTaskSessionBindingSchema = z.object({
  // 绑定状态由 services 从持久化数据投影；旧绑定残留的历史 provider 值在此归一为 glm。
  provider: legacyZCodeProviderSchema,
  sessionId: nonEmptyStringSchema,
  // 绑定锚点需要支持空 task 的 -1，所以这里不能套 nonnegative。
  lastSyncedTurnIndex: z.number().int(),
  state: zcodeTaskSessionBindingStateSchema,
});

// 索引条目只存 workspaceHash + taskId：hash 由路径派生（跨机器稳定），
// 存真实路径会让同一份索引在换机器后全部失效。
export const zcodeTaskIndexEntrySchema = z.object({
  workspaceHash: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
});

// version 固定为字面量 "1"：这是文件格式版本，不是应用版本。
// 用字面量而不是 number，是为了让「未知版本」直接校验失败，
// 而不是被当成 1 继续解析并把文件写坏。
export const zcodePinnedTasksFileSchema = z.object({
  version: z.literal("1"),
  tasks: z.array(zcodeTaskIndexEntrySchema),
});

// 快照里 beforeContent 允许 null（新建文件没有旧内容），afterContent 必填（删除的文件
// 由单独的 fileState 表达，不在快照里体现）。writeCount 用 positive：
// 一条快照至少对应一次写入，0 说明采集逻辑出错。
// contentRefs 只在内容被外置到快照存储时出现，因此可选。
const zcodePersistedFileSnapshotSchema = z.object({
  path: z.string(),
  beforeContent: z.string().nullable(),
  afterContent: z.string(),
  writeCount: z.number().int().positive(),
  contentRefs: z
    .array(
      z.object({
        field: z.enum(["beforeContent", "afterContent"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

// fileChange 按轮次聚合快照：turnIndex 必填，因为回退操作需要精确定位到某一轮。
// fileState 可选：旧版本没有记录「已应用/已回退」，
// 缺省语义是「已应用」，强制必填会让历史会话里的变更无法回滚。
const zcodePersistedFileChangeSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  snapshots: z.array(zcodePersistedFileSnapshotSchema),
  fileState: z.enum(["applied", "reverted"]).optional(),
});

// 轮次检查点必须同时有 base 与 result 才能做回退；result 可选是因为
// 「轮次尚未结束」时只有基线，此时不允许回退到这一轮，但检查点本身要能保存下来。
const zcodePersistedTurnCheckpointSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  baseFileCheckpointId: nonEmptyStringSchema,
  resultFileCheckpointId: nonEmptyStringSchema.optional(),
});

// 会话文件的顶层结构：meta 与 messages 必填（没有它们就不是一个可恢复的会话），
// fileChanges / turnCheckpoints 可选——老会话完全没有这两个字段，
// 要求必填会让所有历史会话在升级后立即无法打开。
export const zcodeSessionFileSchema = z.object({
  meta: zcodeTaskMetaSchema,
  messages: z.array(zcodePersistedMessageSchema),
  fileChanges: z.array(zcodePersistedFileChangeSchema).optional(),
  turnCheckpoints: z.array(zcodePersistedTurnCheckpointSchema).optional(),
});
