// INV-01 缺失配置投影成稳定码：守住位置 模型缺失码；改错故障 首页提示条不显示。
// INV-02 内部等待原因不外泄：守住位置 返回对象；改错故障 用户看到 Agent 故障。
// INV-03 未就绪判定先归一化：守住位置 归一化调用；改错故障 字符串错误漏判。
// INV-04 详情串字段顺序固定：守住位置 四段拼接；改错故障 日志检索口径漂移。
// INV-05 未知值按类型字符串化：守住位置 类型分支；改错故障 对象显示成对象标签。
// INV-06 循环引用不二次抛错：守住位置 序列化包裹；改错故障 原始错误被覆盖。
// INV-07 序列化失败回退字符串化：守住位置 末尾回退；改错故障 错误信息丢失。
// INV-08 实例优先消息：守住位置 实例分支；改错故障 空消息时显示空串。
// INV-09 空消息再退名称：守住位置 或运算链；改错故障 无名错误没有提示。
// INV-10 对象消息仅取有效值：守住位置 空值判断；改错故障 未定义被当成文案。
// INV-11 其余值统一字符串化：守住位置 末尾调用；改错故障 数字错误无文案。
// INV-12 有展示文案才包装：守住位置 空值判断；改错故障 多包一层空错误。
// INV-13 包装保留原错误名：守住位置 名称复制；改错故障 错误分类丢失。
// INV-14 包装保留原堆栈：守住位置 堆栈复制；改错故障 定位不到调用点。
// INV-15 结构化字段白名单透传：守住位置 键数组；改错故障 敏感字段进入展示层。
// INV-16 仅透传已定义字段：守住位置 未定义判断；改错故障 覆盖已有默认值。
// INV-17 详情只补不覆盖：守住位置 已有详情判断；改错故障 上游详情被覆盖。
// INV-18 缓存命中复用结构化错误：守住位置 消息相等判断；改错故障 缺失配置重显原文。
//
// 模块职责：聊天与工作区准备阶段的错误归一化与用户可见文案构造。
// 状态所有权：无状态；错误对象由调用方传入。
// 阅读顺序：先看缺失码与未就绪判定，再读字符串化，最后看包装与缓存复用。
import {
  normalizeUnknownError,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  type ZCodeProvider,
  type ZCodeError,
} from "@zcode/shared";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";

export const MODEL_CONFIG_MISSING_UI_ERROR_CODE = "model_config_missing";

export type ModelConfigMissingUiError = ZCodeError & {
  code: typeof MODEL_CONFIG_MISSING_UI_ERROR_CODE;
};

// 返回值固定使用 MODEL_CONFIG_MISSING_UI_ERROR_CODE，首页 modelConfigMissing 提示条按该码命中；message 面向最终用户，不得写入 provider_not_ready 这类内部等待原因。
export function buildModelConfigMissingUiError(): ModelConfigMissingUiError {
  // provider_not_ready 是进程启动门禁的内部等待原因，直接展示会被当成
  // Agent 故障。草稿首页统一投影成已有 modelConfigMissing banner 的稳定 code。
  return {
    code: MODEL_CONFIG_MISSING_UI_ERROR_CODE,
    message: "No usable model provider is configured.",
  };
}

export function isProviderNotReadyError(error: unknown): boolean {
  return (
    normalizeUnknownError(error).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE
  );
}

interface WorkspacePrepareErrorContext {
  workspacePath: string;
  provider: ZCodeProvider;
  reason:
    | "mount"
    | "retry"
    | "first-send"
    | "select-provider"
    | "reload-session"
    | "sync-model-config";
  attempt: number;
  maxAttempts: number;
  taskId?: string;
  displayMessage?: string;
}

function buildWorkspacePrepareDetail(
  context: WorkspacePrepareErrorContext,
): string {
  return (
    `workspace=${context.workspacePath} ` +
    `provider=${context.provider} ` +
    `reason=${context.reason} ` +
    `attempt=${context.attempt}/${context.maxAttempts}`
  );
}

// stringifyUnknownValue 不允许抛错：JSON.stringify 遇到循环引用会抛，必须 catch 后回退 String(value)，否则二次异常会覆盖原始错误；null 与 undefined 分别固定返回 "null"、"undefined"，不能返回空串。
function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // 部分错误对象会带循环引用，序列化失败时回退到 String，避免二次抛错覆盖原始错误。
  }

  return String(value);
}

// getChatErrorMessage 的三级顺序不可反转：Error 实例先取 err.message，为空再退 err.name，最后 String(err)；普通对象只有 message 经 stringifyUnknownValue 后既非 "undefined" 也非空串才采用，其余一律走 stringifyUnknownValue。
export function getChatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || String(err);
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    const normalizedMessage = stringifyUnknownValue(message);
    if (normalizedMessage !== "undefined" && normalizedMessage.length > 0) {
      return normalizedMessage;
    }
  }

  return stringifyUnknownValue(err);
}

// buildDisplayErrorInput 在 displayMessage 为空时原样返回 err，避免多包一层空错误；否则新建 Error 并复制 err.name、err.stack，再按 code/data/detail/details/providerCode/taskId/traceId/attribution 白名单透传，值为 undefined 的键跳过，防止覆盖 normalizeZCodeUiError 的默认值。
function buildDisplayErrorInput(
  err: unknown,
  displayMessage: string | undefined,
): unknown {
  if (!displayMessage) {
    return err;
  }

  const displayError = new Error(displayMessage) as Error &
    Record<string, unknown>;
  if (err instanceof Error) {
    displayError.name = err.name;
    displayError.stack = err.stack;
  }

  if (typeof err === "object" && err !== null) {
    const errorRecord = err as Record<string, unknown>;
    for (const key of [
      "code",
      "data",
      "detail",
      "details",
      "providerCode",
      "taskId",
      "traceId",
      "attribution",
    ] as const) {
      const value = errorRecord[key];
      if (value !== undefined) {
        displayError[key] = value;
      }
    }
  }

  return displayError;
}

export function buildWorkspacePrepareUiError(
  err: unknown,
  context: WorkspacePrepareErrorContext,
): ZCodeError & { detail?: string } {
  const normalizedError = normalizeZCodeUiError(
    buildDisplayErrorInput(err, context.displayMessage),
    {
      fallbackCode: "WORKSPACE_PREPARE_FAILED",
      taskId: context.taskId,
    },
  );
  if (normalizedError.detail) {
    return normalizedError;
  }

  return {
    ...normalizedError,
    detail: buildWorkspacePrepareDetail(context),
  };
}

export function buildCachedWorkspacePrepareUiError(
  message: string,
  cachedError: (ZCodeError & { detail?: string }) | null | undefined,
  context: WorkspacePrepareErrorContext,
): ZCodeError & { detail?: string } {
  if (cachedError?.message === message) {
    // Bugfix: workspaceInit 目前只缓存纯 message；页面返回命中 failed 短路时，
    // 必须复用上一轮 prepare 的结构化 code，否则模型配置缺失会重新显示 CLI 原文。
    return cachedError.detail
      ? cachedError
      : {
          ...cachedError,
          detail: buildWorkspacePrepareDetail(context),
        };
  }

  return buildWorkspacePrepareUiError(new Error(message), context);
}
