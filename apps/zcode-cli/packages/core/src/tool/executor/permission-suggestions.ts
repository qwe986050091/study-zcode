// ============================================================
// executor/permission-suggestions.ts —— 确认窗里"记住选择"的候选规则
// ============================================================
// 生成 suggestedPermissionUpdates：只是候选，真正落盘要等用户在确认窗选 allow。
// 口径：带 capabilityGroup（目前只有 OfficialCua）时用官方 CUA 专用规则名，避免把共享 server 的
//   任意工具名写进规则；否则按工具名 + 入参里最具体的字符串字段生成一条 allow 规则。
// 不变量：候选只描述"允许什么"，绝不生成 deny/ask；未知 capabilityGroup 直接抛错（不静默写错规则）。

import { PermissionCapabilityGroup, type PermissionUpdate } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

/**
 * 依据工具名与入参生成一条 allow 候选规则。toolName 应为规范化后的真实工具名。
 * capabilityGroup 非空时走专用分支；未知 group 直接抛错，避免写出无法解释的规则。
 * ruleContent 依次尝试 command/url/file_path/path/pattern，命中首个非空字符串即停，
 * 让"始终允许"尽量收窄到具体命令/路径，而不是把整个工具永久放行。
 */
export function buildDefaultPermissionUpdates(
  toolName: string,
  input: unknown,
  capabilityGroup?: PermissionCapabilityGroup,
): PermissionUpdate[] {
  // 能力组来自注册时的可信来源，不是模型入参；未知组必须报错，不能猜。
  if (capabilityGroup) {
    if (capabilityGroup !== PermissionCapabilityGroup.OfficialCua) {
      throw new Error(`Unsupported permission capability group: ${capabilityGroup}`);
    }
    // CUA 帧统一用专用规则名：server 共享时不能用单次调用名决定规则。
    return [
      {
        behavior: "allow",
        rules: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
        type: "addRules",
      },
    ];
  }

  const ruleContent = ruleContentFromInput(input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

/** 从入参里提取可持久化的最具体字符串：顶层字符串优先，否则按固定键序找第一个非空值。 */
function ruleContentFromInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) return input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  // 固定键序 = 优先级：command 比 pattern 更具体，先用它可降低"永久放行整个工具"的概率。
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}
