// 技能/命令的 enable 覆盖 → 发现阶段的 disabledPaths。
//
// 约定：只有显式 enable === false 才算禁用；缺省/true/无法识别的值都不禁用（opt-out 语义），
// 避免配置写错时意外关闭用户的技能或命令。返回顺序与配置键顺序一致，便于稳定诊断输出。
export interface EnableOverride {
  /** false = 禁用；true/undefined = 保持可见。 */
  enable?: boolean;
}

// 收集被显式禁用的路径；undefined 视为没有覆盖（空数组），不报错。
export function collectDisabledPaths(
  overrides: Record<string, EnableOverride> | undefined,
): string[] {
  if (!overrides) return [];
  return Object.entries(overrides)
    .filter(([, value]) => value?.enable === false)
    .map(([path]) => path);
}
