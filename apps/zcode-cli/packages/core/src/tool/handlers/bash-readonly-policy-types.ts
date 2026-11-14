/**
 * Bash 只读策略的公共类型定义：各策略表（simple-commands / flags-* / git-subcommands-* /
 * multiword-*）统一用 BashReadonlyCommandPolicy 描述"一个命令在什么参数形态下算只读"。
 * 只被 bash-readonly-policy-argv.ts / -argv-git.ts / -argv-flags.ts 读取，本文件不含判定逻辑。
 */

// 安全 flag 的取值形态：决定该 flag 是否消费紧随其后的 argv 片段。
// "none" 不取值；"number"/"string"/"char"/"optionalString" 分别校验数字、任意串、单字符、可选串；
// "{}" 与 "EOF" 是 xargs 占位符/结束符的专用形态；未登记的 flag 不在此集合内、由判定层拒绝。
export type SafeFlagValue = "{}" | "EOF" | "char" | "none" | "number" | "optionalString" | "string";

// 描述"一个命令在某种参数形态下是否只读"的策略对象；所有字段均可空，缺省表示不施加该维度约束。
export interface BashReadonlyCommandPolicy {
  // 额外危险判定回调：命令文本 + 前缀之后的 argv；返回 true 即判危险，false/undefined 继续按表校验。
  additionalCommandIsDangerousCallback?: (
    commandText: string,
    argsAfterPrefix: readonly string[],
  ) => boolean;
  // 允许任意参数（如纯查询工具）；true 时跳过 safeFlags 逐项校验，但仍可能受回调约束。
  allowAnyArgs?: boolean;
  // 允许紧凑数字计数短选项（如 grep -n5）；仅在命令支持该写法时置 true。
  allowCompactNumericCountFlag?: boolean;
  // 仅允许"无任何参数"的裸命令；出现操作数或 flag 即视为不可读。
  commandOnly?: boolean;
  // 用于匹配整条命令形态的正则；命中表示该策略适用，不命中则不参与判定。
  regex?: RegExp;
  // 是否把 "--" 之后的词全部当作操作数、不再解析为 flag；适用于遵循 POSIX 的命令。
  respectsDoubleDash?: boolean;
  // 该命令允许的 flag 白名单及其取值形态；键为 flag 字面量，未列出的 flag 判为不可读。
  safeFlags?: Readonly<Record<string, SafeFlagValue>>;
}
