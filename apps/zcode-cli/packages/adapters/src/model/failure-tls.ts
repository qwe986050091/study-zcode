// ============================================================
// TLS 失败归一化
// 定位：provider 的证书校验失败在不同 Node/代理形态下 code 位置不一，先把它们提升为稳定错误码。
// 输入：unknown 错误。输出：原错误（非 TLS）或包装后的 ModelTlsValidationError（保留 cause）。
// 副作用：无。失败语义：不抛错；已包装或非 TLS 时原样返回，保证幂等。
// 不变量：递归沿 cause 链查找且用 WeakSet 防环；错误码判定大小写不敏感。
// ============================================================

const MODEL_TLS_VALIDATION_ERROR_CODE = "MODEL_TLS_VALIDATION_FAILED";

/** 稳定的 TLS 失败错误：code 供跨包装层识别，cause 保留 Node 原始错误链。 */
class ModelTlsValidationError extends Error {
  readonly code = MODEL_TLS_VALIDATION_ERROR_CODE;

  constructor(cause: unknown) {
    super("TLS validation failed for the provider request.", { cause });
    this.name = "ModelTlsValidationError";
  }
}

/**
 * 在 provider fetch 边界调用：若错误链含 TLS 码且尚未包装，则包一层稳定错误。
 * 幂等：已包装/非 TLS 直接返回原对象，避免重复包装导致 cause 层级无限增长。
 */
export function normalizeModelTlsFailure(error: unknown): unknown {
  if (error instanceof ModelTlsValidationError || !hasTlsFailureCode(error)) {
    return error;
  }

  // AI SDK adapter 可能只转发外层错误，丢失 Node TLS cause.code；
  // 在 provider fetch 边界先提升为稳定错误码，后续分类不再依赖运行时英文文案。
  return new ModelTlsValidationError(error);
}

/**
 * 判定 Node TLS/证书错误码：含 CERT/TLS 片段或等于 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 * undefined 返回 false；用片段匹配是为了覆盖 SELF_SIGNED_CERT_IN_CHAIN 等变体。
 */
export function isTlsFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  return Boolean(
    normalized?.includes("CERT") ||
    normalized?.includes("TLS") ||
    normalized === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  );
}

/**
 * 沿 cause 链查找 TLS 错误码；非对象链尾与已访问节点直接 false，
 * seen 集合防环（代理库偶尔把 cause 指回自身）。
 */
function hasTlsFailureCode(error: unknown, seen = new WeakSet<object>()): boolean {
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  if (isTlsFailure(typeof record.code === "string" ? record.code : undefined)) {
    return true;
  }

  return hasTlsFailureCode(record.cause, seen);
}
