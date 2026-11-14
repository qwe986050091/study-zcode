/**
 * ============================================================================
 * provider/config-overlay.ts —— 稀疏配置层的覆盖语义
 * ============================================================================
 *
 * 【核心规则】缺省继承、Config 递归覆盖、其他值整体替换。
 *   这三条是 Provider 三层配置（built-in / personal / account）能够逐层叠加的
 *   唯一依据；不能在这里引入"数组深合并"或"按索引覆盖"等未定义语义。
 *
 * 【校验】validateComplete 只应在"覆盖完成后的最终配置"上调用；
 *   稀疏层允许字段缺失，不能把"尚未提供"当成"无效"。
 * ============================================================================
 */
export interface ConfigValidationIssue {
  readonly code:
    | "required-field-missing"
    | "duplicate-key"
    | "duplicate-model"
    | "invalid-option-spec"
    | "invalid-config"
    | "invalid-reasoning-mapping"
    | "invalid-pattern"
    | "invalid-url"
    | "missing-template";
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * 稀疏配置层和覆盖完成后的配置使用同一类型。
 *
 * 子类显式列出字段；本基类只统一“缺省继承、Config 递归覆盖、其他值整体替换”的语义。
 */
export abstract class ConfigOverlay<TSelf extends ConfigOverlay<TSelf>> {
  abstract overlay(next: TSelf): TSelf;

  abstract validateComplete(path?: readonly string[]): readonly ConfigValidationIssue[];

  protected overlayValue<T>(base: T | undefined, next: T | undefined): T | undefined {
    return next === undefined ? base : next;
  }

  protected overlayConfig<T extends ConfigOverlay<T>>(
    base: T | null | undefined,
    next: T | null | undefined,
  ): T | null | undefined {
    if (next === undefined) return base;
    if (next === null || base === null || base === undefined) return next;
    return base.overlay(next);
  }
}

export function requiredFieldIssue(path: readonly string[], field: string): ConfigValidationIssue {
  return {
    code: "required-field-missing",
    path: [...path, field],
    message: `缺少必填配置 ${[...path, field].join(".")}`,
  };
}
