// INV-01 事件名与分组固定：守住位置 导出常量；改错故障 看板找不到事件。
// INV-02 敏感文本整段替换：守住位置 正则判断；改错故障 认证头进入遥测。
// INV-03 脱敏只影响副本：守住位置 独立变量；改错故障 界面显示被替换文案。
// INV-04 空值直接丢弃：守住位置 裁剪判断；改错故障 出现空字段。
// INV-05 截断上限固定：守住位置 常量；改错故障 上报正文超长。
// INV-06 内部自动恢复不上报动作：守住位置 提前返回；改错故障 内部重试被当成可见恢复。
// INV-07 非业务错误不报动作：守住位置 码判断；改错故障 普通错误带恢复按钮。
// INV-08 键片段裁剪并替换空白：守住位置 归一函数；改错故障 键含冒号破坏结构。
// INV-09 键片段长度上限：守住位置 切片；改错故障 维度基数失控。
// INV-10 缺失字段给固定兜底：守住位置 空值分支；改错故障 聚合出现空维度。
// INV-11 指纹不含完整正文：守住位置 拼接内容；改错故障 上报正文被放大。
// INV-12 指纹用稳定哈希：守住位置 哈希函数；改错故障 同一错误每次键不同。
// INV-13 键结构固定六段：守住位置 数组拼接；改错故障 下游解析错位。
// INV-14 详情字段只报存在性：守住位置 布尔取值；改错故障 完整详情被上传。
// INV-15 来源与原因统一解析：守住位置 归因函数；改错故障 各面板口径不一致。
// INV-16 提供者范围归一：守住位置 共享函数；改错故障 自定义提供者泄露标识。
// INV-17 上报失败只告警：守住位置 捕获分支；改错故障 遥测失败影响聊天。
// INV-18 上报出口固定 ARMS：守住位置 调用点；改错故障 错误进入业务数仓。
//
// 模块职责：聊天错误横幅的遥测负载组装与 ARMS 上报。
// 状态所有权：无状态，平台能力与错误对象由调用方注入。
// 阅读顺序：先看脱敏与截断，再看恢复动作判定，最后看负载与上报。
import {
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  getProviderBusinessErrorUiAction,
  isProviderBusinessErrorCode,
  resolveRequestVerificationBusinessCode,
  type ProviderBusinessErrorUiAction,
} from "@/lib/providerBusinessError.js";
import { resolveTelemetryAttribution } from "@/lib/chatErrorAttribution.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

export const CHAT_ERROR_BANNER_ARMS_EVENT_NAME = "chat_error_banner";
export const CHAT_ERROR_BANNER_ARMS_GROUP = "ui_error";
export type ChatErrorBannerSurface = "chat_input_error_banner" | "session_subscription_error";

const CHAT_ERROR_BANNER_MESSAGE_LIMIT = 500;

function sanitizeUnderlyingTelemetryText(value: string | undefined): string | undefined {
  // 空串与纯空白一律返回 undefined：上报负载里"有值但为空"会被当成真实维度，聚合出空桶（INV-04）。
  if (!value?.trim()) return undefined;
  // 底层 message 可能包含认证头或原始响应，不能因新增诊断字段绕过遥测隐私边界。
  // 只影响上报副本；错误展示、分类及本地详情仍使用原值。
  // 命中即整段替换为固定文案，而不是局部打码：局部掩盖仍会留下前缀、长度或结构线索（INV-02）。
  if (
    /authorization|\b(?:bearer|basic)\s+\S+|(?:https?|wss?|file):\/\/|(?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]|<(?:html|body|script|form|!doctype)\b/i.test(
      value,
    )
  ) {
    return "sensitive error redacted";
  }
  // 未命中敏感模式也要按 500 字符截断：底层 message 可能整段是响应体（INV-05）。
  return truncateTelemetryText(value);
}

// provider/model 白名单与归一实现已收敛到 @zcode/shared 的 telemetryRedaction：
// plan_usage、ui_perf 等事件复用同一条白名单，避免多份副本各自漂移。

interface ChatProviderBusinessRecoveryAction {
  kind: ProviderBusinessErrorUiAction;
  providerBusinessCode: string;
}

export function resolveVisibleChatErrorTelemetryRecoveryAction(
  error: Pick<ZCodeUiError, "code" | "message">,
): ChatProviderBusinessRecoveryAction | null {
  // 修复原因：旧 UI 会把普通 provider 业务错误的可见恢复动作作为聚合维度上报；
  // 3007 的 request verification retry 是内部自动恢复动作，不显示按钮，因此必须继续留空。
  if (resolveRequestVerificationBusinessCode(error.code, error.message)) {
    return null;
  }
  // 非业务码直接返回 null：普通错误不该带恢复按钮，否则界面会给出做不到的建议（INV-07）。
  if (!isProviderBusinessErrorCode(error.code)) {
    return null;
  }
  // kind 为空表示这类业务码没有界面动作（只有内部自动恢复），此时连业务码一起丢弃，
  // 避免看板出现"有恢复码但无动作"的空维度（INV-06）。
  const kind = getProviderBusinessErrorUiAction(error.code);
  return kind ? { kind, providerBusinessCode: error.code } : null;
}

function truncateTelemetryText(value: string | undefined): string {
  // undefined 统一成空串：负载里这些字段类型固定为 string，避免下游再判 null。
  if (!value) {
    return "";
  }
  // 只有超长才截断，且不追加省略号：上报长度必须可预测，省略号会让同一错误长度随内容变化。
  return value.length > CHAT_ERROR_BANNER_MESSAGE_LIMIT
    ? value.slice(0, CHAT_ERROR_BANNER_MESSAGE_LIMIT)
    : value;
}

function normalizeTelemetryKeyPart(value: string | undefined, fallback: string): string {
  // 先 trim 再判空：只有空白的 id 与缺失等价，两者都走 fallback，避免出现空段（INV-08/INV-10）。
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  // 冒号与空白替换成下划线：键本身用冒号分段，片段里再出现冒号会让下游解析错位（INV-08）。
  // 128 字符上限控制维度基数：traceId 或自定义 code 过长时只保留前缀（INV-09）。
  return trimmed.replace(/[:\s]+/g, "_").slice(0, 128);
}

function hashTelemetryFingerprint(value: string): string {
  // FNV-1a 32 位：同一输入稳定产出同一短哈希，用于聚合去重（INV-12）。
  // 不能引入时间戳或随机盐——那会让同一条错误每次上报都成为新键，看板基数失控。
  let hash = 0x811c9dc5;
  // 逐 UTF-16 码元累乘：这里只求稳定，不追求密码学强度，所以不做编码归一（INV-12）。
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 转无符号再补足 8 位：负哈希直接 toString(16) 会带减号，破坏六段键结构（INV-13）。
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveErrorKey(params: {
  errorKey?: string | null;
  error: ZCodeUiError;
  displayMessage: string;
  providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
}): string {
  const providerBusinessRecoveryAction = params.providerBusinessRecoveryAction;
  // 指纹输入包含完整 message，但只以 8 位哈希出现在键里：正文不会随键上报（INV-11）。
  // 用 \u001f 分隔而不是逗号：message 里可能含逗号，而单元分隔符不会出现在正常文案中。
  const fingerprint = [
    params.errorKey?.trim() ?? "",
    params.error.taskId ?? "",
    params.error.code ?? "",
    params.error.traceId ?? "",
    params.error.message,
    params.displayMessage,
    providerBusinessRecoveryAction?.kind ?? "",
    providerBusinessRecoveryAction?.providerBusinessCode ?? "",
  ].join("\u001f");

  // 修复原因：UI 本地去重 key 包含完整 error.message，不能绕过 500 字符截断进入埋点。
  // telemetry 只保留结构化维度和短 hash，既能去重聚合，也避免扩大上报正文范围。
  // 六段顺序固定为 task/code/trace/action/providerCode/hash，增删任何一段都要同步下游解析（INV-13）。
  return [
    normalizeTelemetryKeyPart(params.error.taskId, "no-task"),
    normalizeTelemetryKeyPart(params.error.code, "UNKNOWN"),
    normalizeTelemetryKeyPart(params.error.traceId, "no-trace"),
    normalizeTelemetryKeyPart(providerBusinessRecoveryAction?.kind, "no-action"),
    normalizeTelemetryKeyPart(
      providerBusinessRecoveryAction?.providerBusinessCode,
      "no-provider-code",
    ),
    hashTelemetryFingerprint(fingerprint),
  ].join(":");
}

export function buildChatErrorBannerTelemetryPayload(params: {
  surface?: ChatErrorBannerSurface;
  errorKey?: string | null;
  displayMessage: string;
  error: ZCodeUiError;
  providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
}): ArmsCustomEventPayload {
  // 展示文案独立截断：它面向用户，与底层错误的脱敏规则不同，不能共用一套处理。
  const errorMsg = truncateTelemetryText(params.displayMessage);
  // 底层错误可能含响应体或认证头，必须走脱敏而不是普通截断。
  const underlyingErrorMessage = sanitizeUnderlyingTelemetryText(
    params.error.underlyingErrorMessage,
  );
  // taskId 缺省是空串而不是 undefined：ARMS 属性表不接受 undefined 值。
  const taskId = params.error.taskId ?? "";
  const providerBusinessRecoveryAction = params.providerBusinessRecoveryAction;
  const attribution = params.error.attribution;
  // 提供者范围走共享归一：自定义 provider 只报 scope 与匿名 id，不泄露配置里的标识（INV-16）。
  const provider = resolveTelemetryProviderScope(attribution?.providerId);
  // 来源与阶段由同一归因函数产出：各面板若各自推断，同一错误会出现两种归因（INV-15）。
  const { errorSource, failureReason } = resolveTelemetryAttribution({
    displayMessage: params.displayMessage,
    error: params.error,
  });

  // 事件名与分组使用导出常量：看板按固定值聚合，换成字面量会让历史数据断档（INV-01）。
  return {
    name: CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
    group: CHAT_ERROR_BANNER_ARMS_GROUP,
    value: 1,
    properties: {
      surface: params.surface ?? "chat_input_error_banner",
      // error_key 由结构化维度加短哈希组成，不含正文；本地去重的完整 key 不进上报（INV-11）。
      error_key: resolveErrorKey({
        errorKey: params.errorKey,
        error: params.error,
        displayMessage: params.displayMessage,
        providerBusinessRecoveryAction,
      }),
      error_code: params.error.code ?? "",
      error_message: errorMsg,
      // 只有脱敏后有值才加字段：空字段会让看板出现"已上报但为空"的歧义（INV-04）。
      ...(underlyingErrorMessage ? { error_detail_message: underlyingErrorMessage } : {}),
      // 现行遥测契约禁止上传完整 detail；仅在本地协议中保留，不能照搬上游 error_detail_text。
      trace_id: params.error.traceId ?? "",
      task_id: taskId,
      has_detail: Boolean(params.error.detail),
      provider_business_action: providerBusinessRecoveryAction?.kind ?? "",
      provider_business_code: providerBusinessRecoveryAction?.providerBusinessCode ?? "",
      error_source: errorSource,
      failure_reason: failureReason,
      failure_phase: attribution?.errorPhase ?? "",
      failure_exception_kind: attribution?.exceptionKind ?? "",
      provider_scope: provider.providerScope,
      provider_id: provider.providerId,
      model_id: resolveTelemetryModelId(provider.providerScope, attribution?.modelId),
      provider_kind: attribution?.providerKind ?? "",
      transport: attribution?.transport ?? "",
      status_code: attribution?.statusCode ?? "",
      provider_error_code: attribution?.providerErrorCode ?? "",
      failure_retryable: attribution?.retryable ?? "",
    },
  };
}

export async function reportChatErrorBannerTelemetry(
  platform: Pick<IPlatformService, "reportArmsCustomEvent">,
  params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
    providerBusinessRecoveryAction: ChatProviderBusinessRecoveryAction | null;
  },
): Promise<void> {
  // 上报是旁路：任何异常都只告警，绝不能让遥测失败影响错误横幅展示（INV-17）。
  try {
    // 修复原因：错误横幅属于异常可观测，不能走数仓业务 telemetry；
    // 这里改走 ARMS custom，与 React ErrorBoundary 保持同一监控出口。
    await platform.reportArmsCustomEvent(buildChatErrorBannerTelemetryPayload(params));
  } catch (error) {
    // 捕获后不重试也不回抛：ARMS 没有幂等保证，重试只会放大日志量与重复事件。
    logger.warn("[ChatViewErrorBanner] ARMS 上报失败:", error);
  }
}
