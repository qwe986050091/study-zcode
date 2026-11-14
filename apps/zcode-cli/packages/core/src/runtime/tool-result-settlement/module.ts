/**
 * ============================================================================
 * runtime/tool-result-settlement/module.ts —— 架构治理用的模块清单（声明式，无运行逻辑）
 * ============================================================================
 *
 * 【字段口径】
 *   - id：模块唯一标识，必须与 architecture-policy.yaml 中的条目一致；
 *   - requires：依赖的其它模块 id（此处仅 "zcode-cli"），增删必须同步更新 policy 文件，
 *     否则检查器会报两个清单不一致；
 *   - provides：本模块对外提供的契约名（tool-result-settlement）；
 *   - publicEntrypoints：外部**唯一**允许引用的入口 —— methods 实现文件与 contract.ts。
 *
 * 【边界】这是"纯声明"，不执行任何逻辑；修改 requires/provides 属于架构变更，不是普通代码改动。
 * ============================================================================
 */
/**
 * tool-result-settlement 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const toolResultSettlementModule = {
  id: "tool-result-settlement",
  requires: ["zcode-cli"],
  provides: ["tool-result-settlement"],
  publicEntrypoints: ["../methods/tool-result-settlement.ts", "contract.ts"],
} as const;
