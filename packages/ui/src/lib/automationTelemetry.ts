// INV-01 模型值先去空白：守住位置 resolveAutomationModelTelemetry；改错故障 空白值进入维度。
// INV-02 自定义编码优先解析：守住位置 decodeCustomModelValue；改错故障 斜杠拆分破坏编码。
// INV-03 斜杠形式按首段拆提供方：守住位置 slash 判断；改错故障 模型名带提供方前缀。
// INV-04 显式提供方优先于解析：守住位置 三元顺序；改错故障 调用方覆盖失效。
// INV-05 提供方名只对个人标准配置解析：守住位置 四项联合条件；改错故障 企业配置泄露主机名。
// INV-06 主机名解析失败记空串：守住位置 try 捕获；改错故障 非法地址打断埋点。
// INV-07 提供方标识做历史归一：守住位置 legacyTelemetryProviderId；改错故障 看板出现新旧两套标识。
// INV-08 错误只输出固定类别：守住位置 classifyAutomationTelemetryError；改错故障 自由文本进入看板。
// INV-09 额度错误最优先：守住位置 首条判断；改错故障 额度失败被归为校验失败。
// INV-10 超时与网络分列：守住位置 两条正则；改错故障 连接失败与超时混为一类。
// INV-11 认证错误单独归类：守住位置 auth 正则；改错故障 登录失效被记为未知。
// INV-12 校验错误最后判断：守住位置 validation 正则；改错故障 表单错误被记成网络错误。
// INV-13 未知模式不猜测：守住位置 末尾 unknown；改错故障 原始错误被回传。
// INV-14 错误信息先统一脱敏：守住位置 sanitizeAutomationTelemetryError；改错故障 秘密值进入埋点。
// INV-15 创建结果按标识判成功：守住位置 automationId 判断；改错故障 成功也带错误码。
// INV-16 失败才填错误字段：守住位置 条件三元；改错故障 成功事件含残留错误。
// INV-17 事件区域固定：守住位置 EVENT_REGION；改错故障 自动化指标散落多个区域。
// INV-18 点击事件按动作分派：守住位置 elementName 三元；改错故障 运行与删除无法区分。
//
// 模块职责：自动化创建与操作点击的埋点构造与错误归类。
// 状态所有权：无状态；全部为纯函数，事件对象每次新建。
// 阅读顺序：先看模型字段解析，再读错误归类，最后看两类上报。
import {
  decodeCustomModelValue,
  isAutomationCreateLimitError,
  sanitizeTelemetryErrorMessage,
  type IPlatformService,
  type ModelSelection,
  type ZCodeAutomation,
} from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { isApiKeyAccess } from "@zcode/provider";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { legacyTelemetryProviderId } from "@/lib/providerTelemetryIdentity.js";

const EVENT_REGION = "app.automations";
type TelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

// modelValue 先 trim，空白输入按空模型处理。
// providerId 先取显式提供方，再取 decodeCustomModelValue 的编码，最后才按斜杠拆。
// 带斜杠的 model 按首个 "/" 拆成 providerId 与 modelName。
// providerName 只在 providerSettingsView 里查到个人标准配置时才解析。
// baseUrl 解析主机名失败时 providerName 记空串，不上抛。
// 返回值固定三个键：model_name / model_provider / provider_name。
export function resolveAutomationModelTelemetry(
  modelValue: string | null | undefined,
  explicitProvider: string | null | undefined,
  providerSettingsView: ProviderSettingsView | null,
): Record<"model_name" | "model_provider" | "provider_name", string> {
  const model = modelValue?.trim() ?? "";
  const custom = decodeCustomModelValue(model);
  const slash = model.indexOf("/");
  const providerId =
    explicitProvider?.trim() ||
    custom?.providerId?.trim() ||
    (slash > 0 ? model.slice(0, slash).trim() : "");
  const modelName =
    custom?.modelName?.trim() || (slash > 0 ? model.slice(slash + 1).trim() : model);
  const provider = providerSettingsView?.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  let providerName = "";
  const baseURL = provider?.effectiveConfig.api?.baseUrl?.trim();
  if (
    provider &&
    provider.effectiveConfig.group === "standard-personal" &&
    !provider.templateId &&
    isApiKeyAccess(provider.effectiveConfig.access) &&
    baseURL
  ) {
    try {
      providerName = new URL(baseURL).hostname;
    } catch {
      providerName = "";
    }
  }
  return {
    model_name: modelName,
    model_provider: legacyTelemetryProviderId(providerId),
    provider_name: providerName,
  };
}

export function resolveAutomationSelectionTelemetry(
  selection: ModelSelection | null | undefined,
  providerSettingsView: ProviderSettingsView | null,
): Record<"model_name" | "model_provider" | "provider_name", string> {
  return resolveAutomationModelTelemetry(
    selection ? `${selection.providerId}/${selection.modelId}` : undefined,
    selection?.providerId,
    providerSettingsView,
  );
}

export function sanitizeAutomationTelemetryError(error: string | null | undefined): string {
  // 修复原因：旧正则只遮住 Authorization 后的 Bearer，秘密值仍会泄露；统一丢弃原文。
  return sanitizeTelemetryErrorMessage(error);
}

// 返回固定类别枚举，不把原始 error 文本带出去。
// isAutomationCreateLimitError 最先判定，额度错误优先级最高。
// 超时用 timeout 正则，网络错误用 network 正则分开归类。
// 认证错误归 auth 一类，与网络错误分开。
// 校验错误用 validation 正则最后判断：若前移，ZodError 文本里的 "timeout" 会先命中 timeout 分支，真错因被归成网络错误。
// 都不匹配时返回 unknown，不猜测具体原因。
function classifyAutomationTelemetryError(
  error: string | null | undefined,
): "limit" | "timeout" | "network" | "auth" | "validation" | "unknown" {
  // 修复原因：删除错误原文后，恒空的 error_code 让创建失败无法归因。
  // 只输出固定类别；错误已被 store 转成字符串，未知模式不猜测、更不回传原文。
  const message = error ?? "";
  if (isAutomationCreateLimitError(message)) return "limit";
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError|timed? out|timeout)\b/i.test(message)) {
    return "timeout";
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed|network error)\b/i.test(
      message,
    )
  ) {
    return "network";
  }
  if (/\b(?:unauthorized|unauthenticated|forbidden|authentication failed)\b/i.test(message)) {
    return "auth";
  }
  if (
    /\b(?:ZodError|invalid automation mode|validation failed|invalid cron)\b|Automation 模型选择不可用/i.test(
      message,
    )
  ) {
    return "validation";
  }
  return "unknown";
}

// automationId 存在即 status=success，否则按失败上报。
// 失败分支才填 error_code 与 error_msg。
// error_msg 先经 sanitizeAutomationTelemetryError 统一脱敏。
// modelFields 的三个键直接平铺进 eventExtraDetail。
// eventRegion 固定为 EVENT_REGION（app.automations）。
export function reportAutomationCreateResult(
  platform: TelemetryPlatform,
  params: {
    automationId?: string;
    cronExpr: string;
    templateId?: string;
    error?: string | null;
    modelFields: Record<"model_name" | "model_provider" | "provider_name", string>;
  },
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    {
      elementName: "automation_create_result",
      eventRegion: EVENT_REGION,
      eventType: "result",
      eventExtraDetail: {
        status: params.automationId ? "success" : "fail",
        automation_id: params.automationId ?? "",
        create_source: "manual",
        cron_expr: params.cronExpr,
        template_id: params.templateId ?? "",
        error_code: params.automationId ? "" : classifyAutomationTelemetryError(params.error),
        error_msg: params.automationId ? "" : sanitizeAutomationTelemetryError(params.error),
        ...params.modelFields,
      },
    },
    "automation-telemetry",
  );
}

// run_now 与 delete 共用同一个上报入口，details 里用 action 区分。
// elementName 按 params.action 在 automation_run_now_ck 与 automation_delete_ck 之间分派。
// action_source 记录入口是 list 还是 editor。
// 仅 run_now 附带 modelFields，delete 不带模型字段。
// automation_id 两种动作都始终上报。
export function reportAutomationActionClick(
  platform: TelemetryPlatform,
  params: {
    action: "run_now" | "delete";
    source: "list" | "editor";
    automation: ZCodeAutomation;
    providerSettingsView: ProviderSettingsView | null;
  },
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    {
      elementName: params.action === "run_now" ? "automation_run_now_ck" : "automation_delete_ck",
      eventRegion: EVENT_REGION,
      eventType: "ck",
      eventExtraDetail: {
        automation_id: params.automation.automationId,
        action_source: params.source,
        ...(params.action === "run_now"
          ? resolveAutomationSelectionTelemetry(
              params.automation.modelSelection,
              params.providerSettingsView,
            )
          : {}),
      },
    },
    "automation-telemetry",
  );
}
