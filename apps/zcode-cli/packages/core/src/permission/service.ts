// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

// ============================================================
// 权限判定内核 PermissionService：纯同步、无 I/O、无副作用
// ============================================================
// 职责边界：把「协作模式 + 工具能力声明 + 项目规则 + 会话放行」收敛成一个
// PermissionDecisionResult（decision / ruleId / reason / riskLevel），只回答做不做；
// 弹窗、排队、去重、超时与拒绝落点都在调用侧，本文件不 await、不起计时器、不写外部状态。
// 判定保持同步的理由：调用侧并发发起多个工具调用时，排队与去重不得改变规则优先级；
// 一旦这里引入异步等待，超时就会成为判定顺序的一部分，结果不可复现。
// 能力声明缺失时一律向保守侧推导（见 resolveCapability 的 ?? 链），宁愿多问一次。
// 判定不缓存：同一输入必得同一输出，唯一的显式状态是 sessionRules。
// INV（不变式）—— 任一条被打破，越权或误拦都会直接落到用户身上：
// INV-01 断言：需要用户交互的工具先查 disallowedTools 再要求交互 —— 守住它的位置：checkPermission 的 requiresUserInteraction 分支 —— 改错故障：硬禁用工具退化成弹窗即可运行
// INV-02 断言：planEnabled 先于 guarded 的 user-once 直通求出 —— 守住它的位置：planEnabled 赋值早于 guarded 分支 —— 改错故障：审批一次就能绕过 plan 的写限制
// INV-03 断言：自报 alwaysAsk 的工具必须走 checkAlwaysAsk，不被 yolo / guarded 直通吞掉 —— 守住它的位置：alwaysAsk 分支位于两处模式直通之前 —— 改错故障：始终确认的工具静默执行
// INV-04 断言：checkAlwaysAsk 内阻断优先——auto、硬禁用、项目 deny 都先于会话 allow 与 ask —— 守住它的位置：checkAlwaysAsk 前三个 if —— 改错故障：被硬禁用或被项目拒绝的工具弹窗即放行
// INV-05 断言：auto 模式在两处都返回 deny —— 守住它的位置：checkPermission 与 checkAlwaysAsk 的 auto 分支 —— 改错故障：未实现的模式被当作普通询问放行
// INV-06 断言：项目规则顺序为 deny → ask → allow，且 allow 排在 plan 之后 —— 守住它的位置：checkPermission 三次 matchesProjectRules 调用 —— 改错故障：允许规则盖过显式拒绝
// INV-07 断言：sessionRules 只服务 alwaysAsk gate —— 守住它的位置：仅 checkAlwaysAsk 读 this.sessionRules —— 改错故障：会话放行扩大成全局免确认
// INV-08 断言：plan 模式下任何预批（WebFetch、workflow 草稿）都不生效 —— 守住它的位置：planEnabled 分支排在两条预批之前 —— 改错故障：plan 期间网络与写盘被静默放行
// INV-09 断言：plan 模式只放行只读且非破坏、非破坏性 MCP、或显式会话能力 —— 守住它的位置：checkPlanMode 三个放行分支 —— 改错故障：少一个判定维度即破坏只读约束
// INV-10 断言：build 模式 critical 必 ask，high 受 autoApproveHighRisk 控制 —— 守住它的位置：checkBuildMode 风险分支 —— 改错故障：高危命令无确认执行
// INV-11 断言：未声明的 sideEffectScope 兜底为 workspace（只读才 none）—— 守住它的位置：resolveCapability 的 ?? 链 —— 改错故障：未知工具被当成无副作用
// INV-12 断言：official_cua 规则键只在能力组匹配时命中 —— 守住它的位置：matchesRuleScope 的提前返回 —— 改错故障：同名第三方 MCP 冒用可信键
// INV-13 断言：Edit 规则可约束 Write，反方向不成立 —— 守住它的位置：matchesRuleToolName 的单向判断 —— 改错故障：Write 规则意外放行 Edit
// INV-14 断言：allowed 只由 decision 为 allow 推导，escalated 只由 ask 推导 —— 守住它的位置：result() 唯一构造点 —— 改错故障：allowed 与 escalated 同时为真
//
import {
  AMEND_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  isAmendWorkflowOwnedPredecessor,
  isFillWorkflowHoleOwnedRun,
  PermissionCapabilityGroup,
  type PermissionCapabilityGroup as PermissionCapabilityGroupType,
  type PermissionRuleValue,
  type PermissionRuleset,
  type PermissionUpdate,
  type CollaborationMode,
  type ModelToolSideEffectScope,
  type RiskLevel,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";
import { webFetchRuleSubjects, wildcardToRegExp } from "./rule-matching.js";
import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";
import { applyPermissionUpdates } from "../tool/executor/permission-rules.js";
import { isWebFetchPreapprovedUrl } from "../tool/webfetch-preapproved.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";

// -----------------------------------------------
// Types
// -----------------------------------------------

/** 草稿免确认的规则号。 */
const WORKFLOW_DRAFT_PREAPPROVED_RULE_ID = "tool.workflowDraft.preapproved";

export interface PermissionContext {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
  /**
   * 会话工作目录。判定相对路径的落点用（目前只有 workflow 草稿免确认这一条），
   * 可选：拿不到工作目录的调用方照常按其余规则判定，不会因此少一层确认。
   */
  workingDirectory?: string;
}

export interface PermissionToolCapability {
  userApprovalRule?: string;
  allowedInPlanMode?: boolean;
  alwaysAsk?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresUserInteraction?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  riskLevel?: RiskLevel;
  needsApproval?: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permission?: ToolPermissionSpec;
}

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionDecisionResult {
  approvalMode?: "user-once";
  decision: PermissionBehavior;
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  escalated: boolean;
  mode: CollaborationMode;
  ruleId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  /**
   * 该 ask 来自工具的 alwaysAsk 声明，不是模式或规则推导出来的。下游（PreToolUse hook 的
   * allow 覆盖）靠这个结构化标记识别"不可抹掉的确认"，而不是去匹配 ruleId 字符串。
   */
  alwaysAsk?: boolean;
}

// -----------------------------------------------
// Permission Service
// -----------------------------------------------

// [契约] 一个实例 = 一个会话的判定器：持有会话放行表，只暴露 checkPermission / requiresApproval。
// 调用方只消费 PermissionDecisionResult，不读私有状态：本类不提供 getter，也不发事件。
// decision 之后的一切（弹窗、审计、超时、拒绝落地）都在调用侧完成，这里不产生副作用。
// 超时语义不在本文件：调用侧若放弃等待审批，必须按 deny 处理，不能退化成放行。
// 所有返回值都经 result() 收口，allowed / escalated / ruleId 因此必然同源，不会互相矛盾。
export class PermissionService {
  /**
   * 会话级 allow 规则（「Always allow in this session」）。
   * 一个实例 = 一个 app = 一个会话，所以"随会话消亡"不需要任何额外机制：重启 / 冷恢复 / `/new`
   * 都会造一个空的新实例。只服务 alwaysAsk gate（见 checkAlwaysAsk），普通工具的模式语义不认它。
   */
  // [事务] 会话级放行表的唯一事实来源，初值为空：新会话零放行，不需要迁移或清理。
  // 失效方式随实例消亡：重启、冷恢复、/new 都会构造新实例，旧放行不会泄漏进新会话。
  // 不做 TTL、不做后台清扫：实例生命周期短于任何过期策略，比定时失效更难出错。
  // 只被 grantSessionPermission 整体替换，从不就地修改，读方拿到的永远是完整快照。
  // 它只服务 alwaysAsk gate（见 checkAlwaysAsk），不参与普通工具的模式语义。
  private sessionRules: PermissionRuleset = { version: 1 };

  constructor(private config: PermissionConfig = defaultPermissionConfig) {}

  // [并发] 同步纯内存写入：apply 一次即返回，没有 await 点，不会与判定交错。
  // 多次授权后写生效：每次都在上一版快照上追加，不存在并发合并冲突。
  // 重复授予同一条规则是幂等的，去重由 applyPermissionUpdates 内部完成。
  // 只支持追加：没有撤销路径，规则随会话存活到实例死亡为止。
  // 不校验 updates 来源：调用方必须先确认用户真的点了「本会话允许」。
  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  // [契约] 决策入口：先归一能力，再按固定优先级短路，第一个命中的分支即最终结论。
  // 优先级：模式迁移 → 用户交互 → guarded 单次审批 → alwaysAsk → yolo/guarded → auto
  // → 硬禁用 → 项目 deny → 项目 ask → 通道回复预批 → plan → 项目 allow
  // → WebFetch 预批 → 草稿预批 → allowedTools → edit/build 默认策略；顺序即语义，勿重排。
  // projectRules 与 rulePolicy 可缺省：该层规则不参与时，判定退化为模式默认策略。
  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    // [权衡] 先做一次能力归一化，把缺省值一次补齐，后续分支只读不猜。
    // 归一化偏向保守：声明缺失时按工具名分类回退，未列出的工具视为有副作用、需要审批。
    // 不在各分支内重复兜底，避免同一能力在两处得到不同默认值。
    // capability 是本次判定的只读快照，不缓存、不跨调用复用：工具声明可能随会话变化。
    // 风险等级、副作用范围、是否需要审批都在这里一次定稿，分支不再二次推导。
    const capability = this.resolveCapability(context, toolCapability);
    // [契约] 计划模式迁移由独立策略模块判定，优先级最高，不走后续任何规则。
    // 返回 null 表示与迁移无关，继续常规链路；返回 allow 或 deny 则直接短路。
    // 项目规则、用户审批都改不了这次迁移的结论。
    // [权衡] 迁移只有 allow / deny 两种终态，刻意不降级为 ask，避免模式切换卡在半路。
    // 这里不读 config：迁移语义属于模式契约，与部署侧允许/禁用清单正交。
    const planModeTransition = resolvePlanModeTransitionPermission(context);

    if (planModeTransition) {
      return planModeTransition.behavior === "allow"
        ? this.allow(context, capability, planModeTransition.ruleId, planModeTransition.reason)
        : this.deny(context, capability, planModeTransition.ruleId, planModeTransition.reason);
    }

    // [失败路径] 需要用户交互的工具无法无人值守完成，但先判硬禁用，再要求交互。
    // 命中 disallowedTools 直接 deny：配置禁用优先于「问用户」，不能弹窗即放行。
    // 否则返回 ask（ruleId tool.userInteraction），不存在自动放行路径。
    // 该分支不看模式：yolo 也不能让交互类工具静默跑完。
    // 它排在 guarded 单次审批之前，所以交互类工具不会得到 approvalMode user-once。
    if (capability.requiresUserInteraction) {
      if (this.config.disallowedTools.has(context.toolName)) {
        return this.deny(
          context,
          capability,
          "rule.disallowedTools",
          `Tool ${context.toolName} is explicitly disallowed`,
        );
      }

      return this.ask(
        context,
        capability,
        "tool.userInteraction",
        `Tool ${context.toolName} requires user interaction`,
      );
    }

    // 独立 Plan 优先于 Guarded 的 YOLO 基础策略，审批不能解除 Plan 的执行限制。
    // [契约] plan 的依据是「显式开关优先、其次模式名」，避免模式残留导致误判。
    // 独立 plan 优先于 guarded：审批只能解除本次危险命令，不能解除 plan 的执行限制。
    // planEnabled 为真时，yolo/guarded 直通与各类预批全部失效，只走 checkPlanMode。
    // prePlanMode 只服务迁移策略，不参与本文件的放行判定。
    // [失败路径] 这里若误取 false，plan 期间的一切写入都会落到 build 默认策略上。
    const planEnabled = context.planEnabled ?? context.mode === "plan";
    if (!planEnabled && context.mode === "guarded" && toolCapability?.userApprovalRule) {
      return {
        ...this.ask(
          context,
          capability,
          toolCapability.userApprovalRule,
          "Dangerous command requires your approval for this execution",
        ),
        approvalMode: "user-once",
      };
    }

    // 保留 staging 的工具级确认，不被 Guarded 普通调用的 YOLO 基础策略跳过。
    // [失败路径] 工具自报 alwaysAsk（含 permission.alwaysAsk）必须走专用 gate。
    // 位次在 yolo/guarded 直通之前：否则始终确认的工具会被模式静默放行。
    // gate 内部会重跑阻断判定，因此这里不能简化成直接返回 ask。
    // 返回值带 alwaysAsk 标记，供下游 PreToolUse hook 识别不可被 allow 覆盖的确认。
    // [权衡] 该标记是结构化字段而非 ruleId 字符串匹配，下游不必耦合具体规则号。
    if (capability.alwaysAsk) {
      return this.checkAlwaysAsk(context, capability, projectRules, rulePolicy);
    }

    // [权衡] YOLO 基础策略：yolo 与 guarded 在非 plan 下默认放行普通工具。
    // 这是有意留出的 fail-open 面，前提是危险命令与 alwaysAsk 已在前面的分支被拦下。
    // guarded 的 user-once 审批更早处理，走到这里说明该工具没有危险命令声明。
    // plan 必须显式排除，否则只读约束会被这一行整体绕过。
    // 新增模式时必须明确它落在这条直通之内还是之外，不要默认继承。
    if ((context.mode === "yolo" || context.mode === "guarded") && !planEnabled) {
      return this.allow(context, capability, "mode.yolo", "Yolo mode bypasses permission prompts");
    }

    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }

    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }

    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }

    if (this.matchesProjectRules(projectRules, "ask", context, capability, rulePolicy)) {
      return this.ask(
        context,
        capability,
        "rule.project.ask",
        `Tool ${context.toolName} requires approval by project permission rules`,
      );
    }

    // [契约] 通道回复预批：只对内置 ReplyToChannel 且能力全匹配时生效，不靠名字单判。
    // 五个条件缺一不可：权限名 channel.reply、network、medium、非破坏、无需审批。
    // 位次在显式 deny/ask 之后：项目规则仍可压过这条预批。
    // 接收范围由 Host 再次校验，这里只承诺不重复弹窗，不承诺消息内容可信。
    // [失败路径] 任一能力声明变化（例如风险升级）都会自动关闭预批，无需改这里。
    // 原会话回复的接收范围由 Host 再次校验；network 副作用不能让这个免审批契约重新弹窗。
    // 放在显式 deny/ask 之后，且同时匹配内置工具名和能力，不能扩大其他网络工具的权限。
    if (
      context.toolName === "ReplyToChannel" &&
      capability.permissionName === "channel.reply" &&
      capability.sideEffectScope === "network" &&
      capability.riskLevel === "medium" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "tool.channelReply.preapproved",
        "The originating bot conversation is already authorized",
      );
    }

    if (planEnabled) {
      return this.checkPlanMode(context, capability);
    }

    if (this.matchesProjectRules(projectRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.project.allow",
        `Tool ${context.toolName} is allowed by project permission rules`,
      );
    }

    // [失败路径] WebFetch 预批只认 url 命中白名单，input 非对象或缺 url 一律不命中。
    // 位次在 plan 之后：plan 模式下不允许网络预批放行。
    // 在项目 allow 之后、allowedTools 之前，属于工具内建放行而非配置放行。
    // 未命中的请求继续走模式默认策略，最终落到 ask，而不是 deny。
    // [权衡] 预批只省掉一次确认弹窗，副作用范围不变；放行理由固定记为 tool.webfetch.preapproved，调用方仍能从返回的 decision 里读到来源。
    if (this.isPreapprovedWebFetchRequest(context)) {
      return this.allow(
        context,
        capability,
        "tool.webfetch.preapproved",
        "WebFetch URL is preapproved",
      );
    }

    // [契约] workflow 草稿写入免确认，判定委托 workflow-draft-path.ts，本文件只管位次。
    // 位次：plan 之后（草稿仍是写入）、项目 deny/ask 之后（项目规则优先）。
    // 范围只有 Edit / Write 的 file_path：ApplyPatch 一次可改多文件，不在放行之列。
    // 判定是纯路径比较、不碰文件系统：读盘失败不会把「不放行」错判成「放行」。
    // 规则号取常量 WORKFLOW_DRAFT_PREAPPROVED_RULE_ID，便于下游按规则号审计。
    // workflow 草稿免确认：
    // 与 WebFetch 预批同一位次——排在 plan 分支之后，因为 plan 模式必须继续拦下一切写入，
    // 草稿也是写入；也排在项目 deny / ask 之后，项目规则照样压得过它。判定本身见
    // workflow-draft-path.ts（含"为什么这样放行是安全的"）。
    if (
      isPreapprovedWorkflowDraftWrite({
        input: context.input,
        toolName: context.toolName,
        workingDirectory: context.workingDirectory,
      })
    ) {
      return this.allow(
        context,
        capability,
        WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
        "Workflow draft file is preapproved",
      );
    }

    if (this.config.allowedTools.has(context.toolName)) {
      return this.allow(
        context,
        capability,
        "rule.allowedTools",
        `Tool ${context.toolName} is explicitly allowed`,
      );
    }

    if (context.mode === "edit") {
      return this.checkEditMode(context, capability);
    }

    return this.checkBuildMode(context, capability);
  }

  // [契约] 规则求值两步：先按作用域筛出与当前工具相关的规则，再交给策略或逐条匹配。
  // rulePolicy 存在时整批委托 evaluateRules，避免部分命中与工具自定义语义冲突。
  // 无策略时用 some 语义：任一条命中即视为该行为的结论。
  // 规则集为空或非数组一律返回 false，不抛错——缺规则等于没有这一层约束。
  // [权衡] 先过滤再求值，保证 official_cua 等作用域判定不会被无关工具误命中。
  private matchesProjectRules(
    ruleset: PermissionRuleset | null | undefined,
    behavior: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    rulePolicy?: ToolPermissionRulePolicy,
  ): boolean {
    const rules = ruleset?.[behavior];
    if (!Array.isArray(rules)) return false;
    const toolRules = rules.filter((rule) =>
      this.matchesRuleScope(rule, context.toolName, capability),
    );
    if (toolRules.length === 0) return false;
    if (rulePolicy) return rulePolicy.evaluateRules(behavior, toolRules);
    return toolRules.some((rule) => this.matchesRule(rule, context, capability));
  }

  private matchesRule(
    rule: PermissionRuleValue,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (!this.matchesRuleScope(rule, context.toolName, capability)) return false;
    if (!rule.ruleContent) return true;

    const subjects = this.ruleSubjects(context.input, context.toolName);
    if (subjects.length === 0) return false;

    return subjects.some((subject) => this.matchesRuleContent(subject, rule.ruleContent!));
  }

  private matchesRuleToolName(ruleToolName: string, contextToolName: string): boolean {
    if (ruleToolName === contextToolName) return true;
    return contextToolName === "Write" && ruleToolName === "Edit";
  }

  // [契约] official_cua 规则键只在当前工具携带宿主验证过的能力组时才匹配。
  // 同名第三方 MCP、authority 漂移、旧普通工具都不能把可解析字符串升级为可信能力。
  // 其余规则走 matchesRuleToolName，默认要求工具名相等。
  // [失败路径] 若只比字符串，任何 MCP 都能声明同名规则拿到可信能力。
  // 作用域判定被 matchesProjectRules 与 matchesRule 复用，改一处即同时影响两层。
  private matchesRuleScope(
    rule: PermissionRuleValue,
    contextToolName: string,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME) {
      // 保留 key 只有在当前 tool entry 另行携带宿主验证后的 official_cua
      // capability 时才匹配。同名第三方 MCP、authority 漂移以及旧普通 tool
      // 都不能把可解析的 wire/storage 字符串升级成可信能力。
      return capability.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua;
    }
    return this.matchesRuleToolName(rule.toolName, contextToolName);
  }

  private ruleSubjects(input: unknown, toolName: string): string[] {
    if (typeof input === "string") return [input];
    if (!input || typeof input !== "object") return [];

    const record = input as Record<string, unknown>;
    if (toolName === "WebFetch" && typeof record.url === "string") {
      return webFetchRuleSubjects(record.url);
    }

    for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
      const value = record[key];
      if (typeof value === "string") return [value];
    }

    return [];
  }

  private isPreapprovedWebFetchRequest(context: PermissionContext): boolean {
    if (context.toolName !== "WebFetch") return false;
    if (!context.input || typeof context.input !== "object") return false;
    const url = (context.input as Record<string, unknown>).url;
    return typeof url === "string" && isWebFetchPreapprovedUrl(url);
  }

  private matchesRuleContent(subject: string, ruleContent: string): boolean {
    if (ruleContent.endsWith(":*")) {
      const prefix = ruleContent.slice(0, -2);
      return (
        subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
      );
    }

    if (ruleContent.includes("*")) {
      return wildcardToRegExp(ruleContent).test(subject);
    }

    return subject === ruleContent;
  }

  /**
   * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
   * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
   *
   * 为什么不直接返回 ask：disallowedTools 是用户配置的硬禁用，项目 deny 规则符合工具自报的
   * denyPriority: "beforeAsk"，auto 模式是"该模式未实现"的保护。少了这一步，一个被硬禁用的
   * 工具会退化成"弹个窗、用户一点就能跑"。
   *
   * 这些判定在 checkPermission 里按原有顺序还会各自出现一次；此处刻意只覆盖 alwaysAsk 工具，
   * 不改动其他工具的既有优先级（尤其 yolo 目前先于 disallowedTools 放行这一点）。
   */
  // [失败路径] gate 内按「阻断优先、放行最后」排序：auto → 硬禁用 → 项目 deny。
  // 前三步任一命中即 deny，这就是「ask 压不过阻断」的落地方式。
  // 之后才是会话 allow 与 workflow 归属放行，最后统一返回 tool.alwaysAsk 的 ask。
  // 这些判定在 checkPermission 里还会各出现一次，是刻意重复，不要合并。
  // [权衡] 只覆盖 alwaysAsk 工具，从而不改变其他工具体现有的 yolo 先于硬禁用顺序。
  private checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }
    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    // 会话免确认：阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；
    // 与 gate 本身一样不看模式（yolo / plan / build 一致）。
    if (this.matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.session.allow",
        `Tool ${context.toolName} was allowed for this session`,
      );
    }
    // 修订免确认：AmendWorkflow 的前驱是
    // **本会话发起**的 run、不是用户亲手停下的、且这次修订没有引入新 provider，即放行。与会话规则同位——阻断分支之后、ask 之前，
    // 不看模式。事实来自 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），
    // 不是内存表：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的
    // run 照常 ask：钥匙是 run 的归属，不是字段的在场。
    if (this.isOwnedWorkflowAmend(context)) {
      return this.allow(
        context,
        capability,
        "rule.session.workflowOwner",
        `Tool ${context.toolName} amends a run this session started`,
      );
    }
    return this.ask(
      context,
      capability,
      "tool.alwaysAsk",
      `Tool ${context.toolName} always requires explicit approval`,
    );
  }

  /**
   * AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」；或 FillWorkflowHole 且回填的
   * `hole` 说同一件事（docs/dynamic-workflow/launch.md「Approval」：补全是对一个在飞 run 脚本的修订，
   * 由同一条 amend 规则判定）。
   */
  private isOwnedWorkflowAmend(context: PermissionContext): boolean {
    if (!context.input || typeof context.input !== "object") return false;
    const input = context.input as Record<string, unknown>;
    // 谓词本体住在契约里：就地调并发落回修订时读的必须是同一条规则，不能各写一遍。
    if (context.toolName === AMEND_WORKFLOW_TOOL_NAME) {
      return isAmendWorkflowOwnedPredecessor(input.predecessor);
    }
    if (context.toolName === FILL_WORKFLOW_HOLE_TOOL_NAME) {
      return isFillWorkflowHoleOwnedRun(input.hole);
    }
    return false;
  }

  // [契约] plan 模式三个放行口，条件全部用 && 收紧，命中任一即 allow。
  // 只读且非破坏；或非破坏 MCP；或显式 allowedInPlanMode 且副作用限于 session。
  // 三个口都不看风险等级：plan 约束的是「不许产生外部副作用」，不是「风险够低」。
  // 全部不命中时返回 deny 而非 ask：plan 下没有「问一下就执行」的通道。
  // [失败路径] 任一口少一个 && 条件，都会让写入类工具在 plan 下被静默执行。
  private checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.readOnly",
        "Plan mode allows read-only tool execution",
      );
    }

    if (this.isMcpToolCapability(capability) && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.mcp",
        "Plan mode allows non-destructive MCP tool execution",
      );
    }

    if (
      capability.allowedInPlanMode &&
      capability.sideEffectScope === "session" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.plan.explicitSessionCapability",
        "Plan mode allows this explicit non-destructive session control action",
      );
    }

    return this.deny(
      context,
      capability,
      "mode.plan.nonReadOnly",
      "Plan mode only allows read-only, non-destructive tools",
    );
  }

  private isMcpToolCapability(capability: ResolvedPermissionCapability): boolean {
    return capability.permissionName === "mcp";
  }

  // [权衡] build 默认「不确定就 ask」：只有明确低风险且无副作用才自动放行。
  // 只读且无需审批先放行；critical 必 ask；high 看 autoApproveHighRisk 配置。
  // 低风险 session 级状态更新可放行；其余只要需审批、破坏性或有副作用就 ask。
  // 最后兜底 allow 只覆盖副作用为 none 且非破坏的工具，即纯计算类。
  // [失败路径] 若把兜底改成无条件 allow，等于把 build 模式变成 yolo。
  private checkBuildMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
      return this.allow(
        context,
        capability,
        "mode.build.readOnly",
        "Build mode allows read-only tools",
      );
    }

    if (capability.riskLevel === "critical") {
      return this.ask(
        context,
        capability,
        "mode.build.criticalRisk",
        "Critical risk tools require explicit approval",
      );
    }

    if (capability.riskLevel === "high" && !this.config.autoApproveHighRisk) {
      return this.ask(
        context,
        capability,
        "mode.build.highRisk",
        "High risk tools require explicit approval",
      );
    }

    if (
      capability.sideEffectScope === "session" &&
      capability.riskLevel === "low" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.build.sessionState",
        "Build mode allows low-risk session-local state updates",
      );
    }

    if (
      capability.needsApproval ||
      capability.destructive ||
      capability.sideEffectScope !== "none"
    ) {
      return this.ask(
        context,
        capability,
        "mode.build.sideEffect",
        "Tool has side effects and requires approval",
      );
    }

    return this.allow(
      context,
      capability,
      "mode.build.lowRisk",
      "Build mode allows low-risk tool execution",
    );
  }

  private checkEditMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
      return this.allow(
        context,
        capability,
        "mode.edit.fileEdit",
        "Edit mode allows file edit tools",
      );
    }

    return this.checkBuildMode(context, capability);
  }

  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean {
    const decision = this.checkPermission(context, toolCapability);
    return decision.decision === "ask";
  }

  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel {
    if (toolCapability?.riskLevel) {
      return toolCapability.riskLevel;
    }

    if (this.isReadOnlyTool(toolName)) {
      return "low";
    }

    if (this.isWriteTool(toolName)) {
      return "medium";
    }

    if (this.isDestructiveTool(toolName)) {
      return "high";
    }

    return "medium";
  }

  private isReadOnlyTool(name: string): boolean {
    return new Set([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "TodoRead",
      "TodoWrite",
      "AskUserQuestion",
      "Agent",
      "Task",
      "Skill",
    ]).has(name);
  }

  private isWriteTool(name: string): boolean {
    return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
  }

  private isDestructiveTool(name: string): boolean {
    return new Set(["Bash"]).has(name);
  }

  // [失败路径] 归一化顺序：permission 新声明优先，其次旧字段，最后按工具名回退。
  // readOnly / destructive 的回退来自硬编码工具名表，未列出的工具默认非只读、非破坏。
  // sideEffectScope 缺省为 workspace（只读才 none）：未知工具不会被当成无副作用。
  // needsApproval 缺省为「非只读」，这正是 build 模式下 ask 的主要来源。
  // [契约] 返回对象字段齐全，调用方无需再判 undefined，分支因此可写成纯布尔。
  private resolveCapability(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
  ): ResolvedPermissionCapability {
    return {
      allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
      alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
      readOnly: toolCapability?.readOnly ?? this.isReadOnlyTool(context.toolName),
      destructive: toolCapability?.destructive ?? this.isDestructiveTool(context.toolName),
      requiresUserInteraction:
        toolCapability?.requiresUserInteraction ??
        (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
          "userInteraction",
      sideEffectScope:
        toolCapability?.permission?.sideEffectScope ??
        toolCapability?.sideEffectScope ??
        (this.isReadOnlyTool(context.toolName) ? "none" : "workspace"),
      riskLevel:
        toolCapability?.permission?.riskLevel ??
        this.getRiskLevel(context.toolName, toolCapability),
      needsApproval:
        toolCapability?.permission?.needsApproval ??
        toolCapability?.needsApproval ??
        !this.isReadOnlyTool(context.toolName),
      permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
      permissionName: toolCapability?.permission?.permission,
    };
  }

  private allow(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return this.result("allow", context, capability, ruleId, reason);
  }

  private ask(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("ask", context, capability, ruleId, reason);
  }

  private deny(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("deny", context, capability, ruleId, reason);
  }

  private result(
    decision: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return {
      decision,
      allowed: decision === "allow",
      escalated: decision === "ask",
      mode: context.mode,
      reason,
      riskLevel: capability.riskLevel,
      ruleId,
      sideEffectScope: capability.sideEffectScope,
      ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
    };
  }
}

interface ResolvedPermissionCapability {
  allowedInPlanMode: boolean;
  alwaysAsk: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresUserInteraction: boolean;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permissionName?: string;
}

// -----------------------------------------------
// Configuration
// -----------------------------------------------

export interface PermissionConfig {
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  autoApproveHighRisk: boolean;
  allowMediumRiskInAutoMode: boolean;
}

// [失败路径] 默认配置是最保守一档：允许/禁用清单皆空，高风险不自动批准。
// 空 allowedTools 表示没有额外放行，不是全部允许：放行只来自模式与项目规则。
// autoApproveHighRisk 为 false，high 风险在 build 下必须 ask。
// allowMediumRiskInAutoMode 在本文件未被读取：auto 分支恒 deny，配置改不动结论。
// [权衡] 改这个常量等于改全局安全基线，必须同时评估会话级与项目级规则的叠加。
export const defaultPermissionConfig: PermissionConfig = {
  allowedTools: new Set(),
  disallowedTools: new Set(),
  autoApproveHighRisk: false,
  allowMediumRiskInAutoMode: false,
};
