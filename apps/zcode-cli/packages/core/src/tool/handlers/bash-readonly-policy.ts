/**
 * 只读策略族的对外门面：bash-semantics.ts 只从这里取 evaluateBashReadonlyPolicy /
 * hasKnownBashWriteOption / isSedInPlaceOption，不直接依赖内部 argv 拆分实现。
 * 这三个函数对单个 BashCommandInvocation 给出 true（只读）/ false（可写）/ undefined（未知，
 * 上层按不可读处理），是"保守判定"的最后一层出口。
 */

export {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
} from "./bash-readonly-policy-argv.js";
export { isSedInPlaceOption } from "./bash-readonly-policy-callbacks.js";
