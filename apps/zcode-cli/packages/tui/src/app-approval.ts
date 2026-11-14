// TUI 审批交互（L2）：决策列表、键盘处理与 PermissionBrokerResult 构造。
// 输入来自权限 broker 的 PermissionBrokerRequest；输出为可回放的 result 或 React 状态更新。
// 纯逻辑 + 回调注入：不读写终端、不持久化；cleanup/resolve 由 ApprovalPrompt 自己持有。
import type { PermissionBrokerRequest, PermissionBrokerResult } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { ApprovalDecision, ApprovalPrompt } from "./app-model.js";
import { approvalDecisions } from "./app-model.js";
import { clampIndex } from "./app-input.js";
import { handleQuestionKey } from "./app-question-state.js";
import { asRecord, stringField } from "./state.js";

const COMMAND_INPUT_FIELD = "command";
const DESCRIPTION_INPUT_FIELD = "description";

// 返回本次审批允许展示的决策项。approvalMode === "user-once" 时只给 allow_once/deny，
// 其余模式给 app-model 中的完整集合（含 allow_project）。
// 顺序即 UI 上下切换顺序；不会返回空数组。
export function decisionsForApproval(request: PermissionBrokerRequest): ApprovalDecision[] {
  return request.approvalMode === "user-once" ? ["allow_once", "deny"] : approvalDecisions;
}

// 审批队列的键盘入口：up/down 移动选中项、return 提交当前项、escape 一律拒绝。
// 队列以"只处理队首"为不变量：移动只改 first，提交后把该条从队列移除。
// questionState 存在时整体转交 handleQuestionKey，避免两套按键逻辑互相竞争。
// 副作用：更新 React 状态（队列/状态栏），并对队首调用 cleanup + resolve。
// 未识别的按键不消费，由调用方继续处理。
export function handleApprovalKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  if (approval.questionState) {
    handleQuestionKey(key, approval, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "up" || key.name === "down") {
    const decisions = decisionsForApproval(approval.request);
    const delta = key.name === "up" ? -1 : 1;
    setApprovalQueue((current) => {
      const [first, ...rest] = current;
      // 队列可能在异步间隙被清空，直接返回同一引用，避免无谓重渲染。
      if (!first) return current;
      const selectedIndex = decisions.indexOf(first.selectedDecision);
      // 用 indexOf 把持久化的 decision 映射回本次可选列表；
      // 不在列表（例如模式切换后丢失 allow_project）时由 clampIndex 夹回合法下标。
      return [
        {
          ...first,
          selectedDecision:
            decisions[clampIndex(selectedIndex + delta, decisions.length)] ?? "deny",
        },
        ...rest,
      ];
    });
    return;
  }

  if (key.name === "return") {
    // 回车提交当前选中项；队首被移除后，下一条审批自然成为 first。
    resolveApproval(approval, approval.selectedDecision, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "escape") {
    resolveApproval(approval, "deny", setApprovalQueue, setStatus);
  }
}

// 返回值直接用作按钮/菜单文案，调用方不应再拼接前后缀；request 与 decision 组合决定措辞。
// 文案目前为固定英文，无 i18n 依赖；接入多语言时只需改此处映射。
// 决策项的展示文案。allow_project 在官方 Computer Use 审批下改用更具体的措辞，
// 避免用户误以为授权范围只是普通工具。request 缺省时退回通用文案。
export function approvalDecisionLabel(
  decision: ApprovalDecision,
  request?: PermissionBrokerRequest,
): string {
  if (decision === "allow_once") return "Allow once";
  if (decision === "allow_project") {
    return request && isOfficialCuaProjectApproval(request)
      ? "Always allow Computer Use in this project"
      : "Always allow in this project";
  }
  return "Deny";
}

// 返回 boolean 供 approvalDecisionLabel 与 UI 分支使用；不读取全局配置，结论只取决于本次 request。
// 唯一的规则来源是 request.toolName 与 input 的兜底推导，因此同一 request 重复调用结果稳定。
// 判断该审批是否包含"官方 Computer Use 工具"的项目级 allow 规则。
// 只看 addRules + behavior=allow 的建议更新；无建议更新时由 permissionUpdatesForApproval 兜底推导。
export function isOfficialCuaProjectApproval(request: PermissionBrokerRequest): boolean {
  return permissionUpdatesForApproval(request).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

// 返回值可能为空串，调用方需自行判断是否展示，不能把空串当成"有描述"。
// 只读取字符串字段，不做截断或换行归一，超长文本的裁剪由展示层负责。
// 审批原因文案：优先取 input.description，缺失时退回 request.reason。
// 两者都取不到时返回 request.reason（可能为空串），由调用方决定如何呈现。
export function approvalRequestDescription(request: PermissionBrokerRequest): string {
  return stringField(asRecord(request.input), DESCRIPTION_INPUT_FIELD) ?? request.reason;
}

// 输出为单行可读预览，不做转义或截断；调用方负责按终端宽度裁剪。
// undefined/null 会被序列化为 "undefined"/"null"，属预期降级而非错误。
// 输入预览：优先 command 字段，其次原始字符串，最后 JSON 序列化。
// JSON.stringify 可能因循环引用抛错，此时降级为 String(input)，保证本函数永不抛出。
export function previewPermissionInput(input: unknown): string {
  const command = stringField(asRecord(input), COMMAND_INPUT_FIELD);
  if (command) return command;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// 从建议权限更新中提取 bash 规则的可授权范围，最多 5 条。
// "*:" 后缀视为前缀匹配（展示为 "xxx …"），其余为精确命令。
// 仅收集 addRules + behavior=allow；非 bash 规则与空 ruleContent 被忽略。
export function approvalPermissionScopes(
  request: PermissionBrokerRequest,
): Array<{ kind: "exact" | "prefix"; text: string }> {
  const scopes: Array<{ kind: "exact" | "prefix"; text: string }> = [];
  for (const update of permissionUpdatesForApproval(request)) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== "bash") continue;
      const content = rule.ruleContent?.trim();
      if (!content) continue;
      scopes.push(
        content.endsWith(":*")
          ? { kind: "prefix", text: `${content.slice(0, -2)} …` }
          : { kind: "exact", text: content },
      );
    }
  }
  return scopes.slice(0, 5);
}

// 完成一次审批：先 cleanup 再 resolve（顺序不可颠倒，cleanup 负责撤销 UI 订阅/计时器），
// 然后从队列移除该条并写状态栏。resolve 传入的 result 由 createApprovalResult 生成。
function resolveApproval(
  approval: ApprovalPrompt,
  decision: ApprovalDecision,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  approval.cleanup();
  approval.resolve(createApprovalResult(approval.request, decision));
  setApprovalQueue((current) => current.filter((item) => item !== approval));
  setStatus(`Permission ${approvalStatusLabel(decision)} for ${approval.request.toolName}.`);
}

// 把 TUI 决策转换成 broker 结果。deny 与 "user-once 模式下的 allow_project" 都降级为 deny，
// 因为该模式不允许写入持久规则。只有 allow_project 才携带 permissionUpdates。
// resolvedAt 取当前时间；纯函数，便于单测断言。
export function createApprovalResult(
  request: PermissionBrokerRequest,
  decision: ApprovalDecision,
): PermissionBrokerResult {
  if (
    decision === "deny" ||
    (decision === "allow_project" && request.approvalMode === "user-once")
  ) {
    return {
      decision: "deny",
      reason: "Denied in TUI",
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "allow",
    permissionUpdates:
      decision === "allow_project" ? permissionUpdatesForApproval(request) : undefined,
    reason: decision === "allow_project" ? "Approved for this project in TUI" : "Approved in TUI",
    resolvedAt: new Date(),
  };
}

// 项目级授权要写回的规则：优先使用 broker 给出的 suggestedPermissionUpdates（非空时），
// 否则按 toolName + 从 input 推断的 ruleContent 自造一条 addRules。
// 推断不出 ruleContent 时省略该字段，表示工具级整体授权。
function permissionUpdatesForApproval(request: PermissionBrokerRequest) {
  if (request.suggestedPermissionUpdates?.length) return request.suggestedPermissionUpdates;
  const permissionRuleContent = ruleContentFromApprovalInput(request.input);
  return [
    {
      behavior: "allow" as const,
      rules: [
        {
          toolName: request.toolName,
          ...(permissionRuleContent ? { ruleContent: permissionRuleContent } : {}),
        },
      ],
      type: "addRules" as const,
    },
  ];
}

// 决策到状态栏动词的映射：denied / approved for this project / approved。
function approvalStatusLabel(decision: ApprovalDecision): string {
  if (decision === "deny") return "denied";
  return decision === "allow_project" ? "approved for this project" : "approved";
}

// 从工具输入里推断可写入权限规则的字符串：原样字符串优先，其次常见字段
// （command/url/file_path/path/pattern）。都取不到返回 undefined，由调用方省略规则内容。
function ruleContentFromApprovalInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const record = asRecord(input);
  for (const key of [COMMAND_INPUT_FIELD, "url", "file_path", "path", "pattern"]) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return undefined;
}
