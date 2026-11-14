// INV-01 清洗只作用于上报副本：入参与业务错误保持原样，守住位置 各清洗函数的返回值；改错故障：原地删键后调试面板与业务日志同时丢失诊断信息。
// INV-02 维度字段必须命中枚举白名单：未登记的键一律丢弃，守住位置 插件清洗的过滤分支；改错故障：放行任意键会把配置、网址与路径等高基数内容打进埋点。
// INV-03 标识字段有长度与字符集双重约束：守住位置 标识键的判断链；改错故障：只限长度不限字符集，会把自由文本当作 ID 上报。
// INV-04 标识字段还要过一遍脱敏比对：脱敏后与原值不一致即丢弃，守住位置 同一判断链末尾；改错故障：跳过比对后形似密钥的串仍可能随标识出网。
// INV-05 数值字段只接受纯数字串且有位数上限：守住位置 数值键分支；改错故障：放行小数或科学计数会让统计口径漂移。
// INV-06 错误原文整体替换为占位符：不做正则猜边界，守住位置 错误文案清洗函数；改错故障：保留原文会把任意格式密钥带进事件。
// INV-07 Skill 名称非法即降级为 unknown：不裁剪不截断，守住位置 名称清洗函数；改错故障：截断会让敏感文本残片变成看似合法的标识。
// INV-08 主机名只保留 host 且限 http 与 https：守住位置 网址清洗函数；改错故障：返回完整网址会连带路径、查询串与用户凭据出网。
// INV-09 事件分派先判插件事件族：命中则走更严格的插件清洗，守住位置 通用清洗的首分支；改错故障：顺序颠倒会让插件事件走宽松通道，维度失去约束。
// INV-10 事件细节逐字段映射而不是整体过滤：守住位置 细节映射链；改错故障：整体透传会让未登记的敏感键原样上报。
// INV-11 登录地址在 Core 侧保持幂等：已取 host 的输入不重复解析，守住位置 登录地址清洗函数；改错故障：只接受无协议主机名会让界面已处理过的值被二次拒绝。
// INV-12 渲染上下文全部提供默认值：Intl 不可用时回退 UTC 与 en-US，守住位置 上下文采集函数；改错故障：缺省字段变成空值后 schema 校验失败，整条事件被丢弃。
// INV-13 屏幕信息缺省为零尺寸而非报错：守住位置 同一函数的回退链；改错故障：在无屏幕环境抛错会让服务端渲染路径整体不可用。
// INV-14 移动端 schema 只开放发现类动作：守住位置 动作枚举；改错故障：放宽枚举后移动端会转发管理类事件，与 Host 侧重复计数。
// INV-15 schema 一律使用严格模式：未知字段直接判定失败，守住位置 各处严格模式声明；改错故障：改成宽松模式后新增字段悄悄出网，绕过白名单。
// INV-16 测试桥记录与真实上报分离：抑制只影响是否真正发送，守住位置 相关接口的契约注释；改错故障：把抑制实现成不记录，会让回放对不上。
// INV-17 所有文本字段都有长度上限：标识二百五十六、语言与时区一百二十八、分辨率六十四，守住位置 各清洗与 schema 分支；改错故障：无上限时整段页面或响应体可能进入事件。
// INV-18 本文件不引入运行时单例：只做纯函数与 schema 声明，守住位置 import 区；改错故障：引入有状态单例后清洗结果依赖加载顺序，测试不可复现。
//
// 模块职责：定义插件与通用埋点的维度白名单、清洗函数、移动端发现事件 schema 与渲染上下文采集。
// 状态所有权：无运行时状态；枚举、键集合与 schema 均为模块级常量。
// 阅读顺序：先看维度枚举与键集合，再看插件清洗，最后看通用事件分派与上下文采集。
import { z } from "zod";
import { redactTelemetryText } from "./telemetryRedaction.js";

// 维度枚举把自由文本收敛成有限取值，是埋点可统计的前提
// [权衡] 新增枚举值等于口径变更，必须与报表同步而不是随手加
// 远端类型允许空串：本地工作区需要显式表达「不适用」
// 未列出的键不会进入通用分支，避免维度名被拼写变体打散
// 枚举值的大小写与连接符风格一致，便于跨端合并
const pluginDimensionEnums: Record<string, readonly string[]> = {
  schema_version: ["1"],
  result: ["success", "failure", "cancelled", "noop", "partial"],
  source_type: ["builtin", "official_cdn", "personal", "unknown"],
  publisher_type: ["official", "community", "unknown"],
  entry: [
    "store_list",
    "store_detail",
    "side_pane_market",
    "recommended_prompt",
    "recommended_ui",
    "component_settings",
    "unknown",
  ],
  trigger: ["user", "dependency", "automatic", "restore", "sync"],
  scope: ["user", "workspace", "unknown"],
  client_kind: ["desktop", "mobile", "unknown"],
  workspace_kind: ["local", "remote"],
  remote_kind: ["", "ssh", "wsl", "docker", "server"],
  error_category: ["diagnostic", "transport", "timeout", "cancelled", "unknown"],
  plugin_component: ["skill", "mcp", "agent", "command", "hook", "lsp", "ui"],
  remove_cache: ["true", "false", "unknown"],
  action: [
    "install",
    "uninstall",
    "update",
    "restore",
    "enable",
    "disable",
    "configure",
    "reset_config",
    "source_add",
    "source_remove",
    "source_refresh",
    "sync",
    "store_view",
    "detail_view",
    "search",
    "ui_open_request",
    "ui_ready",
    "ui_close",
    "ui_tool_call",
  ],
};
// 标识键集合区分「可辨认但非维度」的值，如插件 ID 与版本号
// [失败路径] 把版本号当维度会让基数爆炸，几乎每个版本一个桶
// 这些键仍需长度与字符集约束，标识不等于可信
// 数值键单独成集合，走纯数字校验而不是标识校验
// [权衡] 用集合而非前缀匹配，避免误伤语义相近的其他键
const pluginIdentifierKeys = new Set([
  "plugin_id",
  "marketplace",
  "version_before",
  "version_after",
  "batch_id",
]);
const pluginNumericKeys = new Set(["duration_ms", "target_count", "result_count"]);
export const PLUGIN_TELEMETRY_EVENTS = [
  "plugin_lifecycle",
  "plugin_discovery",
  "plugin_usage",
  "plugin_runtime_error",
] as const;

/** 只清洗上报副本；拒绝任意配置/URL/路径和自由错误文本。 */
// 清洗返回新对象，调用方持有的 detail 不被修改
// 先查枚举再查数值最后查标识，三类互斥且顺序不影响结果
// [失败路径] 标识分支漏掉脱敏比对时，形似密钥的值仍会通过
// 不认识的键直接丢弃，而不是原样保留等待后续处理
// 本函数是插件事件的唯一入口，通用分支遇到插件事件先转到这里
export function sanitizePluginTelemetryDetail(
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).filter(([key, value]) => {
      if (pluginDimensionEnums[key]) return pluginDimensionEnums[key].includes(value);
      if (pluginNumericKeys.has(key)) return /^\d{1,15}$/.test(value);
      return (
        pluginIdentifierKeys.has(key) &&
        value.length <= 256 &&
        /^[A-Za-z0-9@._+:-]+$/.test(value) &&
        redactTelemetryText(value) === value
      );
    }),
  );
}

/** 手机只转发发现行为；管理结果由同一个 Desktop Host 产生。 */
// 移动端只上报发现行为，管理结果由桌面 Host 统一产生
// [并发] 严格模式让未知字段直接失败而不是被忽略
// 动作枚举只含浏览、详情与搜索，避免两端重复计数
// 插件 ID 与结果数都是可选项：搜索无命中时仍要能上报
// 字段上限与清洗函数保持一致，防止一处放宽另一处收紧
export const mobilePluginDiscoveryTelemetrySchema = z
  .object({
    elementName: z.literal("plugin_discovery"),
    eventRegion: z.literal("app"),
    eventType: z.literal("view"),
    context: z
      .object({
        clientTimezone: z.string().max(128),
        clientLanguage: z.string().max(128),
        screenResolution: z.string().max(64),
      })
      .strict(),
    eventExtraDetail: z
      .object({
        schema_version: z.literal("1"),
        action: z.enum(["store_view", "detail_view", "search"]),
        entry: z.enum(["store_list", "store_detail", "side_pane_market"]),
        client_kind: z.literal("mobile"),
        plugin_id: z
          .string()
          .regex(/^[A-Za-z0-9@._+:-]+$/)
          .max(256)
          .optional(),
        result_count: z
          .string()
          .regex(/^\d{1,15}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type MobilePluginDiscoveryTelemetry = z.infer<typeof mobilePluginDiscoveryTelemetrySchema>;

export interface TelemetryRendererContext {
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

/** desktop main 实际传给 armsRum.sendCustom 的最终参数。 */
export interface FinalArmsCustomEventPayload {
  name: string;
  type: "custom";
  group: string;
  value: number;
  properties: Record<string, string>;
}

/** 仅 E2E test bridge 可读取的 main-process 内存记录。 */
export interface FinalArmsCustomEventE2EEntry {
  sequence: number;
  recordedAt: number;
  payload: FinalArmsCustomEventPayload;
}

export interface ConfigureFinalArmsCustomEventE2ERequest {
  /** 命中后仍进入 ring，但不调用真实 armsRum.sendCustom。 */
  suppressedEventNames: string[];
}

/**
 * URL 配置进入业务埋点前只允许提取 hostname。
 * 无效值和非 HTTP(S) 协议返回空串，避免误把完整 URL、userinfo 或任意文本带入 payload。
 */
// 网址只提取主机名：路径、查询串与用户凭据一律不进入上报
// [失败路径] 非 http 与 https 协议返回空串，防止自定义协议携带凭据
// new URL 抛错时 catch 返回空串，而不是回落到原始输入，避免把完整地址带进上报 payload
// 成功路径返回 parsed.hostname.toLowerCase()，让 URL 与 HOST 两种写法落进同一维度
// resolveSafeTelemetryHostname 不校验域名真伪，调用方只能拿空串判断是否可用
export function resolveSafeTelemetryHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 错误原文可能带任意格式密钥；整体丢弃，不用正则猜测秘密边界。 */
export function sanitizeTelemetryErrorMessage(value: string | null | undefined): string {
  return value ? "[redacted]" : "";
}

const MAX_TELEMETRY_SKILL_NAME_LENGTH = 64;
const TELEMETRY_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * 只用于已解析的 Skill 名称，不能据此信任模型请求参数。
 * 不 trim 或截断，以免把敏感文本残片变成看似合法的标识；出网时再次检查同一规则。
 */
export function sanitizeTelemetrySkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TELEMETRY_SKILL_NAME_LENGTH ||
    !TELEMETRY_SKILL_NAME_PATTERN.test(value) ||
    redactTelemetryText(value) !== value
  ) {
    return "unknown";
  }
  return value;
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // UI 已取过 hostname 时 Core 仍需幂等；只接受精确 hostname，不放行无协议的路径或凭据。
  const normalized = value.trim().toLowerCase();
  return normalized && resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** 只清洗上报副本；业务错误、授权地址和调用方持有的 detail 不得被修改。 */
// 事件分派先判插件事件族，命中后交给更严格的插件清洗
// [失败路径] 分支顺序颠倒会让插件事件走通用通道，维度失去约束
// 通用通道逐字段映射：错误文案替换、Skill 名降级、登录地址取主机
// 步骤类事件对插件相关键额外做一次白名单校验
// 未命中的键保持原值，但已经过滤掉插件事件的宽松路径
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  if ((PLUGIN_TELEMETRY_EVENTS as readonly string[]).includes(elementName))
    return sanitizePluginTelemetryDetail(detail);
  return Object.fromEntries(
    Object.entries(detail)
      .filter(
        ([key, value]) =>
          elementName !== "agent_step" ||
          (key !== "plugin_id" && key !== "plugin_component") ||
          key in sanitizePluginTelemetryDetail({ [key]: value }),
      )
      .map(([key, value]) => [
        key,
        key === "error_msg"
          ? sanitizeTelemetryErrorMessage(value)
          : key === "skill_name"
            ? sanitizeTelemetrySkillName(value)
            : elementName === "app_login_ck" && key === "login_url"
              ? sanitizeLoginHostname(value)
              : value,
      ]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

// 渲染上下文在缺省环境下仍产完整三元组，避免整条事件被 schema 拒绝
// [失败路径] Intl 不可用时若不回退，时区与语言会变成空值
// screen 在 options 与 globalThis 都缺失时回落到零宽高占位，避免整条事件被 schema 拒绝
// 时区与语言先读 options 再读 Intl.resolvedOptions，最后才用固定默认值，前一级命中就不再往下看
// 这三个字段只进 TelemetryRendererContext 上报，不参与任何业务分支判定
export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage = options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}
