/**
 * cli-arguments 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 该对象是架构治理的机器可读清单：id 为模块唯一标识，requires/provides 决定依赖边，
 * publicEntrypoints 声明外部允许导入的入口；requires 为空表示不依赖其他模块。
 * 以 as const 固化字面量，供检查器在编译期静态读取，运行时不产生副作用。
 */
export const cliArgumentsModule = {
  id: "cli-arguments",
  requires: [],
  provides: ["cli-arguments"],
  publicEntrypoints: ["../arguments.ts", "contract.ts"],
} as const;
