/**
 * 纯函数规则匹配器：给定命令的 subject 组与已保存的权限规则，判断 allow/deny 是否命中。
 * 被 bash-command-permission-policy.ts 的 evaluateRules 调用，再由权限服务决定最终放行。
 * 关键口径：空 ruleContent 视为无约束命中；allow 要求每个必需命令组都被覆盖，
 * deny 只要任一命令组命中即生效；命令无法静态分析（safe=false）时只认整条命令精确匹配。
 */

import type { PermissionRuleBehavior, PermissionRuleValue } from "@zcode/contracts";
import { wildcardToRegExp } from "../../permission/rule-matching.js";

export interface BashRuleEvaluationInput {
  allSubjectGroups: readonly (readonly string[])[];
  behavior: PermissionRuleBehavior;
  exactCommands: readonly string[];
  requiredSubjectGroups: readonly (readonly string[])[];
  rules: readonly PermissionRuleValue[];
  safe: boolean;
}

export function evaluateBashRules(input: BashRuleEvaluationInput): boolean {
  // 空 ruleContent 表示"不限内容"的通配规则，直接命中。
  if (input.rules.some((rule) => !rule.ruleContent)) return true;
  if (
    input.exactCommands.some((command) => command.length > 0) &&
    input.rules.some((rule) => input.exactCommands.includes(rule.ruleContent ?? ""))
  ) {
    // 整条命令的精确匹配优先，保证用户原样保存的规则始终有效（包括不可分析的命令）。
    return true;
  }
  // 无法静态分析时不能再按前缀放行，否则 `cmd:*` 可能覆盖到未预期的复合命令。
  if (!input.safe) return false;

  const subjectGroups =
    input.behavior === "allow" ? input.requiredSubjectGroups : input.allSubjectGroups;
  if (subjectGroups.length === 0) return false;
  // allow 只需覆盖"非只读命令"；deny 必须覆盖全部命令组，任一命中即拒绝。
  if (input.behavior !== "allow") {
    return subjectGroups.some((subjects) =>
      subjects.some((subject) =>
        input.rules.some((rule) => matchesInvocationRule(subject, rule.ruleContent)),
      ),
    );
  }
  // allow 用 every：每条必需命令都要有规则覆盖；deny 用 some：任一命令命中即拒绝。
  return subjectGroups.every((subjects) =>
    subjects.some((subject) =>
      input.rules.some((rule) => matchesInvocationRule(subject, rule.ruleContent)),
    ),
  );
}

function matchesInvocationRule(subject: string, ruleContent: string | undefined): boolean {
  if (!ruleContent) return true;
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    // `cmd:*` 必须按 token 边界匹配，避免 `git status:*` 命中 `git statusX`。
    return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`);
  }
  if (ruleContent.includes("*")) return wildcardToRegExp(ruleContent).test(subject);
  return subject === ruleContent;
}
