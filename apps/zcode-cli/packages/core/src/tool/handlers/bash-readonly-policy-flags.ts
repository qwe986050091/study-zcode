/**
 * 各命令安全 flag 表的汇总 barrel：把 file/git/process/text 四组表并成单一入口，
 * 供 bash-readonly-policy-simple-commands.ts 与 git 子命令表组合使用。
 * 表里的值类型 SafeFlagValue 决定该 flag 是否吃下一个 argv（"none" 不取值，其余取值），
 * 未登记的 flag 一律由 isArgvAllowedByPolicy 判为不可只读。
 */

export * from "./bash-readonly-policy-flags-file.js";
export * from "./bash-readonly-policy-flags-git.js";
export * from "./bash-readonly-policy-flags-process.js";
export * from "./bash-readonly-policy-flags-text.js";
