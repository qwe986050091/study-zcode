// 权限对话框选项的纯投影（CLI 内部 → v3/v4 wire），不含任何授权执行。
//
// 三种 optionsPolicy 的语义：
// - 默认（无策略）：once / always(project) / deny，always 携带 suggested 或默认规则；
// - no-always-allow：完全不提供持久授权（每次调用都是不同代码），只剩 once/deny；
// - session-always-allow：只提供「本会话内免确认」，response 里没有 permissionUpdates，
//   会话规则由 broker 在应答侧合成（纯内存，绝不写项目规则）；
// approvalMode=user-once 再裁成 once/deny 两项。
import type { PermissionOptionsPolicy, PermissionUpdate } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME, type ZCodePermissionOption } from "@zcode/shared";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

// 普通交互 permission 的用户拒绝需要明确告知模型工具未执行，
// 并等待用户后续指示；该 reason 同时作为 provider-visible tool_result.content。
export const PERMISSION_DENIED_BY_USER_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// 拒绝文案追加用户反馈时保留原文前缀：模型必须先看到「工具未执行、停止当前动作」，
// 再看到用户的后续指示；feedback 为空则只给固定文案。
export function buildPermissionDeniedContent(feedback?: string): string {
  const trimmed = feedback?.trim();
  return trimmed
    ? `${PERMISSION_DENIED_BY_USER_CONTENT} To tell you how to proceed, the user said:\n${trimmed}`
    : PERMISSION_DENIED_BY_USER_CONTENT;
}

/**
 * 会话授权选项的标识、内部种类与显示名称。
 * optionId 上 v4 wire 原样传递（broker 靠它精确命中）；kind 是 CLI 内部值，v4 投影把它映到
 * 闭集里的 `allowAlways`；name 是 GUI 本地化的匹配键（PermissionDialog 的全局 name 映射表）。
 */
const SESSION_ALLOW_PERMISSION_OPTION_ID = "allowSession";
export const SESSION_ALLOW_PERMISSION_OPTION_KIND = "allow_session";
const SESSION_ALLOW_PERMISSION_OPTION_NAME = "Always allow in this session";

interface PermissionOptionSource {
  approvalMode?: "user-once";
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  toolName: string;
}

/**
 * v3 与 v4 共用的纯权限选项投影。放在协议目录之外，避免 v4 权威投影反向依赖旧协议。
 *
 * - 优先使用工具给出的 suggestedPermissionUpdates（例如 MCP 精确规则）；
 *   缺失时按 toolName + 输入中的 command/url/path/pattern 构造项目级规则；
 * - 若规则里出现 official CUA 规则名，文案切换为「本项目内 Computer Use 免确认」；
 * - session-always-allow 的 response 故意不带 permissionUpdates（strict schema 也不接受），
 *   由 broker 在应答侧转成 sessionPermissionUpdates；
 * - user-once 最后过滤非 once/deny，防止调用方误以为持久选项可用。
 */
export function buildProtocolPermissionOptions(
  source: PermissionOptionSource,
): ZCodePermissionOption[] {
  const permissionUpdates = source.suggestedPermissionUpdates?.length
    ? source.suggestedPermissionUpdates
    : defaultPermissionUpdates(source);
  const officialCuaProjectScope = permissionUpdates.some((update) =>
    update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
  const options: ZCodePermissionOption[] = [
    {
      kind: "allow_once",
      name: "Allow once",
      optionId: "allow_once",
      response: {
        decision: "allow",
        reason: "Approved once",
      },
    },
    // 工具可以声明 no-always-allow：每次调用都是不同代码时，持久规则不是"记住这次决定"，
    // 而是把这道确认永久关掉。session-always-allow 则换成会话作用域的免确认：response 里
    // **没有** permissionUpdates——wire 上 zcodePermissionUpdateSchema 是 strict，会话语义由
    // broker 在应答侧合成为 sessionPermissionUpdates（纯内存，绝不落项目规则）。
    ...(source.optionsPolicy === "no-always-allow"
      ? []
      : source.optionsPolicy === "session-always-allow"
        ? [
            {
              description: "Do not ask again for this tool in this session",
              kind: SESSION_ALLOW_PERMISSION_OPTION_KIND,
              name: SESSION_ALLOW_PERMISSION_OPTION_NAME,
              optionId: SESSION_ALLOW_PERMISSION_OPTION_ID,
              response: {
                decision: "allow" as const,
                reason: "Approved for this session",
              },
            },
          ]
        : [
            {
              description: officialCuaProjectScope
                ? "Do not ask again for official Computer Use tools in this project"
                : "Do not ask again for matching requests in this project",
              kind: "allow_always" as const,
              name: officialCuaProjectScope
                ? "Always allow Computer Use in this project"
                : "Always allow in this project",
              optionId: "allow_project",
              response: {
                decision: "allow" as const,
                permissionUpdates,
                reason: "Approved for this project",
              },
            },
          ]),
    {
      kind: "deny",
      name: "Deny",
      optionId: "deny",
      response: {
        decision: "deny",
        reason: PERMISSION_DENIED_BY_USER_CONTENT,
      },
    },
  ];
  return source.approvalMode === "user-once"
    ? options.filter((option) => option.kind === "allow_once" || option.kind === "deny")
    : options;
}

/**
 * 会话授权按工具整体授予（无 ruleContent）：脚本每次都不同，授权的是「这个工具」而不是某段脚本。
 */
export function buildSessionPermissionUpdates(toolName: string): PermissionUpdate[] {
  return [{ behavior: "allow", rules: [{ toolName }], type: "addRules" }];
}

/**
 * legacy v3（session-mapper、broker 的 v3 反向 RPC）认不出会话语义：旧桌面回传的是 option
 * response 原文，投放会话选项只会得到一个名不副实的「一次允许」。所以两种策略在 legacy 上
 * 都只表现为「裁掉 always allow」。
 */
export function toLegacyPermissionOptionsPolicy(policy: unknown): "no-always-allow" | undefined {
  switch (policy) {
    case "no-always-allow":
    case "session-always-allow":
      return "no-always-allow";
    default:
      return undefined;
  }
}

// 默认持久规则：工具名 + 从输入提取的规则内容（有则带，无则是整工具范围）。
function defaultPermissionUpdates(source: PermissionOptionSource): PermissionUpdate[] {
  const ruleContent = ruleContentFromPermissionInput(source.input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName: source.toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

// 提取规则内容的固定键顺序：command/url/file_path/path/pattern；字符串输入直接作为规则。
// 全空时返回 undefined，让上层退化为「整个工具」的项目级授权。
function ruleContentFromPermissionInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) {
    return input;
  }

  const record = asRecord(input);
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = stringField(record, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
