// ─────────────────────────────────────────────────────────────────────────────
// 深注释：权限确认窗的职责边界 / 不变量
// ─────────────────────────────────────────────────────────────────────────────
// 做：把 ZCodePermissionRequest 投影成一个可键盘操作的确认窗——选块类型、渲染预览、
//     排序选项、维护选中索引与反馈草稿，最后把用户决策（option + 可选 feedback/content）
//     交回 onRespond。它同时服务桌面、手机 Web 远控与工作流/保存两类专用确认窗。
// 不做：不判断权限策略、不写审计、不重试应答、不持有业务状态。选项含义、排序规则、
//       预览解析都在 lib/permissionRequest 与各 ToolCallBlocks renderer 里；这里只做
//       呈现与交互编排。已提交状态属于宿主（responding 由外部传入）。
// 依赖：useZCodeIntl 做文案、useZCodeStoreWithDefault 取主题/代码预览设置、
//       useToolPresentationHostCapabilities 取宿主展示能力、permissionWorkflowSettings
//       维护工作流设置草稿。本组件不得自己去取服务或 store 之外的第二份业务事实。
//
// 不变量（INV）：
// INV-01 断言：反馈草稿按 requestId 归零 —— 位置：第一个 useEffect —— 改错故障：上一个请求的修改意见泄漏进下一个确认窗，用户误发别人的反馈。
// INV-02 断言：responding 期间任何点击都不再触发 onRespond —— 位置：respondWithOption / submitFeedback 的首行守卫 —— 改错故障：重复应答让 CLI 侧同一个 request 记两次决策。
// INV-03 断言：被 blocked 的选项（子代理模型不可用）不能放行 —— 位置：isOptionBlocked —— 改错故障：用旧模型启动 run，运行期才失败且已被记为已接受。
// INV-04 断言：工作流窗的草稿只属于 Refine，点 Deny 不带它 —— 位置：trimmedFeedback 的 refineOption 判断 —— 改错故障：一段修改意见以普通拒绝理由发出，模型收不到 refine 升级。
// INV-05 断言：提交前必须 trim 且空白不发送 —— 位置：submitFeedback —— 改错故障：CLI 把纯空白 freeText 落成普通 deny，用户的反馈静默丢失。
// INV-06 断言：saveWorkflow 必须最先判定 —— 位置：resolvePermissionBlockKind 首段 —— 改错故障：带 path/script 的保存请求被吸进 edit 块，或掉进 workflow 图块显示错误语言。
// INV-07 断言：workflow 判定必须早于 search/execute —— 位置：identity.family 分支顺序 —— 改错故障：脚本里的命令片段被当成普通命令确认，用户看不到因果图。
// INV-08 断言：权限预览一律合成 completed 节点且 isRunning=false —— 位置：buildPermissionBlockContext —— 改错故障：Bash 确认窗显示“执行中”并转圈，遮住真正的申请原因。
// INV-09 断言：权限中间态不允许收起 —— 位置：getPermissionBlockInteraction —— 改错故障：用户把关键命令/参数折叠起来，盲点确认。
// INV-10 断言：反馈行是独立可选项，序号在选项之后 —— 位置：feedbackIndex/selectableCount —— 改错故障：复用它作为 deny 索引会让按钮与输入框同时高亮。
// INV-11 断言：焦点恢复必须确认输入框未获焦 —— 位置：requestAnimationFrame 回调 —— 改错故障：旧的 RAF 回调抢回焦点，打断用户正在输入的中文。
// INV-12 断言：IME 组合期间方向键/回车不处理 —— 位置：handleFeedbackKeyDown 的 isImeComposingKeyEvent —— 改错故障：输入法选词被当成导航，候选框跳走或误提交。
// INV-13 断言：Escape 只失焦，不关闭也不拒绝 —— 位置：handleFeedbackKeyDown 末段 —— 改错故障：用户想退出输入法时误拒绝权限请求。
// INV-14 断言：选项编号与数字快捷键一一对应 —— 位置：handleOptionKeyDown —— 改错故障：按 2 执行了第 1 项，授权范围放大。
// INV-15 断言：Shift+Tab 在第一项时交还浏览器/宿主 —— 位置：三个 return 分支 —— 改错故障：焦点被困在选项循环里，上方的命令与脚本无法用键盘访问。
// INV-16 断言：手机远控输入框必须避开 iOS 聚焦缩放 —— 位置：avoidIosInputFocusZoom —— 改错故障：反馈输入时整页放大，确认按钮移出视口。
// INV-17 断言：显示给用户的 reason 必须是人话 —— 位置：readUserFacingPermissionReason 的排除集 —— 改错故障：弹窗重复出现“High risk tools...”这类协议文案，用户无法判断本次操作。
// INV-18 断言：option.name 优先于 kind 推导的文案 —— 位置：preferOptionName 分支 —— 改错故障：语义不同但同属 allow_always 的选项被压成两条一样的“始终允许”。
// INV-19 断言：bounded 布局只用于 saveWorkflow —— 位置：bounded 变量 —— 改错故障：普通确认窗被限高后确认栏被裁掉，或出现多层滚动容器导致滚轮失控。
//
// 阅读提示：下方注释聚焦“这个顺序/判空/守卫为什么不能动”，不复述 JSX 结构。
// ─────────────────────────────────────────────────────────────────────────────
import { useToolPresentationHostCapabilities } from "@/hooks/useToolPresentationHostCapabilities.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
/* eslint-disable max-lines */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodeProvider,
} from "@zcode/shared";
import { MAX_PERMISSION_FEEDBACK_CHARS } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  resolveMobileInputTextSizeClassName,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import {
  getPermissionOptionDisplayKind,
  getPermissionRequestPreview,
  shouldPreferPermissionOptionName,
  sortPermissionOptions,
  type PermissionRequestScope,
} from "@/lib/permissionRequest.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import { isPlainRecord, readRawToolCallInput } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { WebFetchToolCallBlock } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { WorkflowPermissionBlock } from "@/WorkflowPermissionBlock.js";
import {
  focusLastWorkflowSettingsControl,
  isWorkflowSettingsCarrier,
  usePermissionWorkflowSettings,
  workflowAdjustedOptionDescriptionId,
} from "@/permissionWorkflowSettings.js";
import { SaveWorkflowPermissionBlock } from "@/SaveWorkflowPermissionBlock.js";
import { isSaveWorkflowToolCall } from "@/lib/workflowToolNames.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { Info, LoaderIcon, WrenchIcon } from "lucide-react";

// [契约] MCP 图标提升到模块级常量：权限确认窗会在同一帧渲染多个 MCP 选项，
// 每次新建元素会让 ToolLayout 的浅比较失效，导致整棵预览树重挂载。
// 图标是纯展示值，不再暴露尺寸/颜色参数，避免调用点各自漂移。
const MCP_PERMISSION_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

// [契约] 块类型的封闭枚举是“分流规则只有一份”的前提：新增 kind 必须同时补上
// resolvePermissionBlockKind 的判定与 getPermissionBlockInteraction 的分支，
// TS 的穷尽性检查会在遗漏时直接报错。
type PermissionBlockKind =
  | "edit"
  | "execute"
  | "mcp"
  | "web-fetch"
  | "search"
  | "skill"
  | "workflow"
  | "saveWorkflow"
  | "fallback";

// 交互能力按块类型静态决定，而不是渲染时再读状态：
// 这样预览组件不会因为用户点击而改变形状，确认窗的高度保持稳定。
interface PermissionBlockInteraction {
  canToggle: boolean;
  forceOpen: boolean;
}

interface PermissionRuleScope {
  display: string;
  truncated: boolean;
}

// [权衡] 160 是“够看出目录前缀、又不撑破单行”的经验值；
// 改小会让用户无法区分相邻规则，改大则长路径把 description 挤出可视区。
// 排除集里的两条文案来自协议兜底，不是任何具体操作的说明，因此不展示。
const PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS = 160;
// [契约] 这两条是协议侧通用策略原因，不携带本次操作信息，展示只会制造噪音。
// 集合必须保持“精确字符串”匹配而不是包含匹配：
// 包含匹配会把用户自己写的相似说明一并吞掉，反而隐藏有效信息。
// 新增排除项前先确认该文案在所有 provider 下都不具有区分度。
const NON_USER_FACING_PERMISSION_REASONS = new Set([
  "High risk tools require explicit approval",
  "Tool has side effects and requires approval",
]);

// [契约] 只取首行 + 截断，保证规则前缀在选项行内不换行；
// truncated 与 display 必须同时返回，供无障碍层标注“已截断”，
// 否则读屏用户会以为看到的是完整规则。
function formatPermissionRuleScope(content: string): PermissionRuleScope {
  const lineBreakIndex = content.search(/\r?\n/);
  const firstLine = lineBreakIndex === -1 ? content : content.slice(0, lineBreakIndex);
  // 换行与超长走同一个截断标记：只要不是原文首行完整呈现就算截断。
  // suffix 预留的长度参与截断计算，否则截完再拼后缀会超长。
  const truncated =
    lineBreakIndex !== -1 || firstLine.length > PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS;

  const suffix = " …";
  const visible = firstLine
    .slice(0, PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS - suffix.length)
    .trimEnd();
  return { display: `${visible}${suffix}`, truncated };
}

// [契约] 只展示 bash 类、以 :* 结尾的 allow 规则：这类是“目录/命令前缀”授权，
// 对用户最有解释价值；exact rule 原文里有完整命令，刻意不展示。
// 上限 5 条是布局约束，超出部分不折叠也不提示——确认窗只负责让人看清主要范围。
function readPermissionRuleScopes(option: ZCodePermissionOption): PermissionRuleScope[] {
  const scopes: PermissionRuleScope[] = [];
  // 必须过滤 behavior === allow：deny 规则同样带 ruleContent，
  // 误展示会让用户以为点了“允许”却看到了拒绝范围。
  for (const update of option.response?.permissionUpdates ?? []) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== "bash") continue;
      const content = rule.ruleContent?.trim();
      if (!content?.endsWith(":*")) continue;
      scopes.push(formatPermissionRuleScope(content.slice(0, -2)));
    }
  }
  return scopes.slice(0, 5);
}

// 官方 CUA 的项目级规则要单独识别：它的 name 与普通项目授权相同，
// 但语义是“允许电脑操作”，文案与描述必须走 cua 专用 key，
// 否则用户会以为只是允许访问项目目录。
function isOfficialCuaProjectPermission(option: ZCodePermissionOption): boolean {
  return (option.response?.permissionUpdates ?? []).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

/**
 * workflow Refine（拒绝并附修改意见）。
 * 该选项不渲染成按钮，而是作为反馈行的应答目标：用户在其他确认窗同一行编号输入行里写修改意见，
 * 提交时应答携带 freeText，CLI broker 据此把 deny 升级为带 workflow_refine_feedback 的用户反馈。
 */
function isWorkflowRefineOption(option: ZCodePermissionOption): boolean {
  return option.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID;
}

// 无规则时返回 null 而不是空 span：父级用三元判断是否渲染 description，
// 空节点会让“有规则但规则为空”和“没有规则”在布局上不可区分。
function InlinePermissionPrefixScopes({ scopes }: { scopes: readonly PermissionRuleScope[] }) {
  if (scopes.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-1 basis-48 flex-col gap-1"
      data-permission-rule-scopes="true"
      data-permission-rule-prefixes="true"
    >
      {scopes.map((scope, index) => (
        <code
          key={`${scope.display}:${index}`}
          className="min-w-0 whitespace-pre-wrap break-all font-mono text-ui-base leading-5 text-foreground-subtle"
          data-permission-rule-scope="prefix"
          data-permission-rule-scope-truncated={scope.truncated ? "true" : undefined}
        >
          {scope.display}
        </code>
      ))}
    </span>
  );
}

// [契约] kind 到文案的映射是兜底路径，只在 option.name 不可信时生效；
// 返回 null 而不是空串，让调用方能区分“没有映射”和“映射到空文案”。
function getOptionLabelMessageId(kind: string): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.approve";
    case "allowAlways":
      return "chat.permission.approveAlways";
    case "rejectOnce":
      return "chat.permission.deny";
    case "rejectAlways":
      return "chat.permission.denyAlways";
    default:
      return null;
  }
}

// provider-native 文案是英文原文，必须在展示前归一：
// 只登记已知的几个 name，不认识的仍原样透出，避免猜测导致错译。
const PROVIDER_PERMISSION_OPTION_NAME_LABELS: Partial<
  Record<ZCodeProvider, Record<string, string>>
> = {
  glm: {
    // GLM/ZCode Agent 通过 ZCode Agent 发来的项目级记忆授权文案是英文原文。
    // 这里把已知 provider-native 权限文案统一归一到 i18n，避免被当成自定义选项直出英文。
    "always allow in this project": "chat.permission.allowForProject",
  },
};

// description 可选是刻意的：会话级选项不能沿用项目级“相同请求不再询问”的描述，
// 但并非每个 name 都有专属描述，缺省时调用方会回落到 kind 推导。
interface PermissionOptionNameMessageIds {
  label: string;
  /** 按 name 命中时可覆盖 kind 推导的描述：会话级选项不能沿用「相同请求不再询问」的项目级文案。 */
  description?: string;
}

// [契约] 匹配键是规范化后的 name，不是 kind：wire 上 kind 只表达按钮语义，
// name 才是用户看到的真实选项文案。
// 新增键必须同时确认 CLI 侧确实发出该 name，否则会变成永远不会命中的死配置。
const GLOBAL_PERMISSION_OPTION_NAME_LABELS: Record<string, PermissionOptionNameMessageIds> = {
  "full access": {
    label: "chat.permission.fullAccess",
    description: "chat.permission.fullAccess.description",
  },
  "always allow in this project": { label: "chat.permission.allowForProject" },
  "always allow computer use in this project": { label: "chat.permission.cua.allowForProject" },
  // workflow 运行确认窗的会话免确认：
  // CLI 侧 name 是匹配键，wire kind 是 allowAlways（排序 / 样式同 always allow）。
  "always allow in this session": {
    label: "chat.permission.workflow.allowForSession",
    description: "chat.permission.workflow.allowForSession.description",
  },
};

// 先查全局表再查 provider 表：全局 name 跨 provider 稳定，
// provider 专属文案只在该 provider 下生效，避免 A 的文案泄漏到 B。
// 归一化（trim、压缩空白、小写）必须在这里统一做，调用点不能各自处理，
// 否则同一个 name 在不同入口命中不同分支。
function getProviderOptionNameMessageIds(
  provider: ZCodeProvider | undefined,
  name: string,
): PermissionOptionNameMessageIds | null {
  const normalizedName = name.trim().replace(/\s+/g, " ").toLowerCase();
  const global = GLOBAL_PERMISSION_OPTION_NAME_LABELS[normalizedName];
  if (global) {
    return global;
  }
  const providerLabel = provider
    ? PROVIDER_PERMISSION_OPTION_NAME_LABELS[provider]?.[normalizedName]
    : undefined;
  return providerLabel ? { label: providerLabel } : null;
}

// 描述必须带上 scope：同样叫“始终允许”，命令级与会话级承诺的范围不同，
// 复用同一条文案会让用户在错误的范围上授权。
function getOptionDescriptionMessageId(kind: string, scope: PermissionRequestScope): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.allowOnce.description";
    case "allowAlways":
      return `chat.permission.allowAlways.description.${scope}`;
    case "rejectOnce":
      return "chat.permission.denyOnce.description";
    case "rejectAlways":
      return `chat.permission.denyAlways.description.${scope}`;
    default:
      return null;
  }
}

// [契约] 只接受非空字符串且返回 trim 后的值：上游 raw 是 unknown，
// 数字/对象/空白串一律视为缺失，避免把调试 payload 当文案渲染。
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// [契约] 先归一化非空字符串，再排除通用原因；两步顺序不能反，
// 否则带前后空白的通用文案会因为不精确相等而漏过排除。
// 返回 null 表示“没有可展示的人话”，调用方必须继续向下回落而不是显示空行。
function readUserFacingPermissionReason(value: unknown): string | null {
  const reason = readNonEmptyString(value);
  // 通用权限策略原因用于协议诊断，不是能帮助用户判断本次操作的具体说明。
  // 之前 UI 无差别展示 reason，导致权限弹窗重复出现和“等待确认”语义相同的英文文案。
  return reason && !NON_USER_FACING_PERMISSION_REASONS.has(reason) ? reason : null;
}

// 取值优先级：工具入参里的 description → reason → summary，再看请求级字段。
// 这个顺序不能反：入参说的是“这次具体做什么”，请求级 reason 往往是通用策略文案，
// 先取后者会让弹窗失去可判断性。
// 每一层都要过 readUserFacingPermissionReason，不能直接把原始字符串塞进 UI。
function getPermissionDisplayReason(request: ZCodePermissionRequest): string | null {
  const rawInput = readRawToolCallInput(request.raw);
  const inputReason = isPlainRecord(rawInput)
    ? (readUserFacingPermissionReason(rawInput.description) ??
      readUserFacingPermissionReason(rawInput.reason) ??
      readUserFacingPermissionReason(rawInput.summary))
    : null;
  const rawReason = isPlainRecord(request.raw)
    ? readUserFacingPermissionReason(request.raw.reason)
    : null;

  return inputReason ?? readUserFacingPermissionReason(request.description) ?? rawReason;
}

// [契约] 工具名可能出现在 raw.toolName / raw.tool_name / kind / title 四处，
// 这个回退顺序对应不同版本 CLI 的写入格式，删掉任何一层都会让旧会话退化成 fallback。
// 只认 mcp__ 前缀：其它工具即使名字里含 mcp 也不能走 MCP 预览，
// 否则会把普通工具的参数当 MCP 调用展示。
function getMcpPermissionToolName(toolCall: TaskChatToolCall): string | null {
  const rawToolName = isPlainRecord(toolCall.raw)
    ? (readNonEmptyString(toolCall.raw.toolName) ?? readNonEmptyString(toolCall.raw.tool_name))
    : null;
  const toolName =
    readNonEmptyString(toolCall.toolName) ??
    rawToolName ??
    readNonEmptyString(toolCall.kind) ??
    readNonEmptyString(toolCall.title);

  return toolName?.startsWith("mcp__") ? toolName : null;
}

// MCP 的 reason 只从 raw 读：普通字段里的 description 是给通用预览用的，
// 混用会让 MCP 块显示两段不同来源的说明。
function getMcpPermissionReason(toolCall: TaskChatToolCall): string | null {
  return isPlainRecord(toolCall.raw) ? readNonEmptyString(toolCall.raw.reason) : null;
}

// [契约] 分流只在这里做一次，聊天区与确认窗共用同一套 tool identity，
// 任何在渲染处临时猜 kind 的写法都会让两处展示漂移。
function resolvePermissionBlockKind(
  preview: ReturnType<typeof getPermissionRequestPreview>,
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
): PermissionBlockKind {
  // SaveWorkflow 按**工具名**最先判定，早于文件摘要与 family 分流。它归一化入参里带着 `path`
  // 与完整 `script`，任何一条「看起来像写文件」的启发式都可能把它吸进 edit 块；而 workflow
  // family 一旦登记这个名字，它又会掉进运行确认块（图 + Refine，对一次写盘完全是错的语言）。
  if (isSaveWorkflowToolCall(toolCall)) {
    return "saveWorkflow";
  }

  if (rawFileSummaries.length > 0 || preview.fileChanges.length > 0) {
    return "edit";
  }

  const identity = resolveToolCallIdentity(toolCall);

  if (getMcpPermissionToolName(toolCall)) {
    // MCP 权限请求不是普通未知工具；以前走 fallback 会把 raw JSON 摊开，并把工具名显示两次。
    // 这里单独展示 MCP 名称和协议里的 reason，避免用户在审批时读调试 payload。
    return "mcp";
  }

  // 权限弹窗之前单独猜 kind/title/rawInput.skill，和聊天区分流规则会漂移。
  // 这里复用固定 tool identity，让 Skill 权限请求在确认前后都走同一套语义。
  if (identity.family === "skill") {
    return "skill";
  }

  if (identity.family === "workflow") {
    // 工作流确认窗的主体是因果图 + 折叠脚本，和聊天区同一 tool identity 分流；
    // 必须早于 search/execute 判定，否则脚本里的命令片段会把它误判成普通命令确认。
    return "workflow";
  }

  if (identity.family === "web-fetch") return "web-fetch";
  if (identity.family === "search") {
    // WebFetch/WebSearch 权限请求以前落到 fallback，会把整包 toolCall JSON 打出来。
    // 这里和聊天区一样走 search renderer，只展示用户关心的 URL/query 摘要。
    return "search";
  }

  if (preview.command) {
    return "execute";
  }

  return "fallback";
}

// [权衡] 只有 edit 块 canToggle=false 且不强开：文件 diff 天然有折叠语义，
// 其余块强制展开是为了不让用户把关键命令藏起来。
// switch 没有 default 分支，新增 kind 时 TS 会用返回值覆盖检查逼你补全。
function getPermissionBlockInteraction(blockKind: PermissionBlockKind): PermissionBlockInteraction {
  switch (blockKind) {
    case "edit":
      return {
        canToggle: false,
        forceOpen: false,
      };
    case "mcp":
    case "skill":
    case "web-fetch":
    case "search":
    case "execute":
    case "workflow":
    case "saveWorkflow":
    case "fallback":
      // 这里是权限弹窗的中间态展示，不提供收起/展开交互，避免用户把关键内容藏起来。
      // workflow / saveWorkflow 只为穷尽性列在这里：它们由各自的专用块直接渲染，不走通用块，
      // 块内脚本折叠是 spec 记录的刻意例外（图、名称与落点仍不可折叠）。
      return {
        canToggle: false,
        forceOpen: true,
      };
  }
}

// [契约] 合成 toolCall 的 toolId 必须带 requestId：同一个工具可能连续弹两次确认，
// 共用 id 会让 renderer 的内部状态（折叠、滚动）在两次确认间串味。
// status 固定 completed 且 input 优先取 rawInput，是预览语义而不是执行语义。
function buildPermissionToolCall(
  request: ZCodePermissionRequest,
  preview: ReturnType<typeof getPermissionRequestPreview>,
): TaskChatToolCall {
  const rawInput = readRawToolCallInput(request.raw);

  return {
    toolId: `permission:${request.requestId}`,
    kind: request.kind,
    title: request.title ?? request.description ?? preview.title,
    input: rawInput ?? preview.command ?? request.raw,
    status: "completed",
    raw: request.raw,
  };
}

// [契约] 预览上下文由宿主注入 theme/codePreviewSettings，组件不再自取 store：
// 这是 store 耦合剥离后的稳定边界，退回自取会让同一弹窗在不同宿主下配色分叉。
// displayModel 全部关闭输入/输出/摘要，因为此刻工具还没执行，展示执行结果就是撒谎。
// childToolList 固定 null：权限阶段没有子工具，占位会让 ToolLayout 多渲染一层空列表。
function buildPermissionBlockContext(
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
  workspacePath: string,
  blockKind: PermissionBlockKind,
  kindLabelOverride: ReactNode,
  theme: ToolCallBlockRenderContext["theme"],
  codePreviewSettings: ToolCallBlockRenderContext["codePreviewSettings"],
): ToolCallBlockRenderContext {
  const { canToggle, forceOpen } = getPermissionBlockInteraction(blockKind);

  return {
    nestedToolRenderer: ToolCallBlock,
    toolCallNode: {
      toolCall,
      childToolCalls: [],
    } as ToolCallBlockRenderContext["toolCallNode"],
    workspacePath,
    // store 耦合剥离：展示组件不再自取 store，主题/代码预览设置由对话框宿主注入。
    theme,
    codePreviewSettings,
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries,
    // 权限弹窗等待用户确认时工具还没有执行，不能复用 running 状态。
    // 之前 Bash 权限会显示“执行中”并带 loading，遮住真正的申请原因。
    isRunning: false,
    // 权限预览使用合成 completed 节点，必须显式区分，避免误报“没有输出”。
    isPermissionPreview: true,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    kindLabelOverride,
    canToggle,
    forceOpen,
    onOpenCodeViewer: undefined,
    onOpenBrowserUrl: undefined,
  };
}

// [契约] MCP 预览只展示名称与 reason，content 固定 null：
// 以前走 fallback 会把 raw JSON 摊开并把工具名显示两次。
// primaryText 用 useMemo 保持元素引用稳定，避免每次渲染都让 ToolLayout 重排。
function McpPermissionBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const toolName = getMcpPermissionToolName(toolCall) ?? toolCall.title ?? toolCall.kind;
  const reason = getMcpPermissionReason(toolCall);
  const hasKindLabelOverride = context.kindLabelOverride != null;
  // 有 kind 覆盖时优先展示工具名而不是 reason：覆盖文案本身已经解释了这是什么，
  // 再叠一行 reason 会让行内信息互相挤压。
  const primaryText = useMemo(
    () =>
      hasKindLabelOverride ? (
        <span className="min-w-0 truncate text-foreground-subtle">{toolName}</span>
      ) : reason ? (
        <span className="min-w-0 truncate text-foreground-subtle">{reason}</span>
      ) : null,
    [hasKindLabelOverride, reason, toolName],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={MCP_PERMISSION_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={context.kindLabelOverride ?? toolName}
      primaryText={primaryText}
      isRunning={context.isRunning}
      content={null}
    />
  );
}

/**
 * 保存确认窗：聚焦滚动区里最后一个控件（区内只有展开钮与脚本开关）。区不在或没有控件即返回 false，
 * 交回选项列表自己的循环。
 */
// [失败路径] 返回 boolean 而不是 void：调用方要靠它决定是否 preventDefault，
// 区不存在或没有可用控件时必须交回选项列表自己的循环，不能吞掉 Tab。
// disabled 按钮会被排除，否则焦点落到不可操作元素上，键盘用户再次被困。
function focusLastSaveWorkflowControl(root: HTMLElement | null): boolean {
  const controls = root?.querySelectorAll<HTMLElement>(
    "[data-permission-dialog-scroll] button:not([disabled])",
  );
  const last = controls === undefined ? undefined : controls[controls.length - 1];
  if (last === undefined) return false;
  last.focus();
  return true;
}

// [契约] onRespond 的 content 只在工作流放行且用户改过设置时出现；
// 没改过就不传，CLI 侧据此区分“默认设置”和“用户显式确认了这组设置”。
// workspacePath 与 workspaceIdentity 是两个维度：前者用于展示与文件操作，
// 后者用于身份隔离与远程路由，任何一处缺失都会让工作流设置落到错误会话。
// isWebRemoteControl 只影响输入框字号与同步入口可见性，不改变权限语义。
export function PermissionDialog({
  request,
  onRespond,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  workflowSessionModel,
  provider,
  isWebRemoteControl = false,
  responding = false,
  responseError,
}: {
  request: ZCodePermissionRequest;
  responding?: boolean;
  responseError?: string;
  /**
   * `content` 只在工作流确认窗的放行应答上出现：用户在窗里改过的设置（docs/dynamic-workflow/launch.md
   * 「Adjusting the settings in the window」）。没改过即不传。
   */
  onRespond: (
    requestId: string,
    option: ZCodePermissionOption,
    feedback?: string,
    content?: Record<string, unknown>,
  ) => void;
  workspacePath: string;
  /** 工作流确认窗的模型清单作用域与会话模型（宿主给）。 */
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workflowSessionModel?: { providerId: string; modelId: string };
  provider?: ZCodeProvider;
  isWebRemoteControl?: boolean;
}) {
  // [契约] 所有面向用户的文案都走 intl；协议字段（reason/name）只作为数据，
  // 不能在渲染处直接拼接英文，否则未翻译的文案会随协议变化漂移。
  const { intl } = useZCodeIntl();
  // 审批直接使用 renderer 时绕过了 ToolCallBlock 的默认 Provider，
  // 所以这里必须显式取宿主能力并在预览外层补回。
  const presentationCapabilities = useToolPresentationHostCapabilities(workspacePath);
  // [契约] `isMobileTextInputViewport` 只在顶层取一次，向下以布尔传递；
  // 在渲染分支里各取一次会读到不同的媒体查询结果，同一帧出现两套字号。
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  // Bug 根因：反馈输入也会渲染在手机 Web 远控的 PermissionDialog 中，14px 输入框聚焦时会触发 iOS 页面放大。
  // 与 composer 复用同一套视口判断和 16px 兼容 token，桌面和非远控 Web 保持原有字号。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // M5②.5 store 耦合剥离：主题/代码预览设置在宿主处取 store，向下走 props/render context。
  // [契约] 主题与代码预览设置由宿主处读取后向下传，组件内不再重复订阅；
  // 默认值兜底是给 Storybook/单测这类没有 Provider 的宿主用的。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // 工作流确认窗的 Refine 选项不进按钮列表：它就是这个窗的反馈行（见 feedbackOption）。
  // Refine 是“拒绝并给修改意见”的应答目标，不渲染成按钮；
  // 在这里按 optionId 精确匹配，不能用 name 判等——name 会随文案变化。
  const refineOption = useMemo(
    () => request.options.find(isWorkflowRefineOption),
    [request.options],
  );
  // [契约] 排序必须走 sortPermissionOptions，UI 不能自己按 kind 排：
  // 允许/拒绝的先后顺序是产品规则，两处各排一次就会出现顺序不一致。
  // 过滤 Refine 放在排序之后，保证“排序后再剔除”的结果与列表序号稳定。
  const orderedOptions = useMemo(
    () =>
      sortPermissionOptions(request.options).filter((option) => !isWorkflowRefineOption(option)),
    [request.options],
  );
  // preview 是纯函数结果，依赖整份 request 而不是字段切片：
  // request.raw 是任意 JSON，浅比较字段会漏掉嵌套变化。
  const preview = useMemo(() => getPermissionRequestPreview(request), [request]);
  // [契约] 合成 toolCall 只依赖 request 与 preview，不依赖任何可变 UI 状态；
  // 否则用户输入反馈时会重建 toolCall，导致预览区滚动位置被重置。
  const toolCall = useMemo(() => buildPermissionToolCall(request, preview), [preview, request]);
  // [契约] 复用聊天区的 edit 解析而不是只读 preview.fileChanges：
  // Write 请求可能只带 file_path/content，少一层解析就会丢掉文件摘要，
  // 同一份请求在聊天区和确认窗显示不同的文件集合。
  const rawFileSummaries = useMemo(
    () =>
      // 权限弹窗之前只认 preview.fileChanges，Write 请求如果只带 file_path/content，
      // 这里就会丢失文件摘要；改成复用聊天区同一套 edit 解析，避免两个入口展示结果不一致。
      readRawToolCallFileSummaries(toolCall.raw, {
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [toolCall],
  );
  // blockKind 是后续所有分流（块组件、交互能力、限高布局）的唯一来源；
  // 不要在渲染处再算一次，两处不一致会让确认窗出现互相矛盾的结构。
  const blockKind = useMemo(
    () => resolvePermissionBlockKind(preview, toolCall, rawFileSummaries),
    [preview, rawFileSummaries, toolCall],
  );
  // [契约] 上下文里 kindLabelOverride 走 intl，不硬编码“等待确认”：
  // `blockContext` 由手机远控与桌面共用，只允许宿主换语言。
  const blockContext = useMemo(
    () =>
      buildPermissionBlockContext(
        toolCall,
        rawFileSummaries,
        workspacePath,
        blockKind,
        intl.formatMessage({ id: "chat.permission.awaitingApproval" }),
        theme,
        codePreviewSettings,
      ),
    [blockKind, codePreviewSettings, intl, rawFileSummaries, theme, toolCall, workspacePath],
  );
  // reason 只在这里解析一次：工作流与保存窗会刻意不展示它，
  // 但仍在 hook 中计算，保持 hook 顺序稳定（不能按分支跳过 useMemo）。
  const displayReason = useMemo(() => getPermissionDisplayReason(request), [request]);
  // 工作流确认窗的两项 run 设置（WorkflowPermissionBlock 画，这里只存改过的值与「模型不可用」）。
  // [契约] 工作流设置只在 workflow 块下挂载：其它确认窗没有 run 设置，
  // 提前挂载会让 usePermissionWorkflowSettings 在无 carrier 时产生空草稿。
  const isWorkflowAsk = blockKind === "workflow";
  // [契约] 工作流设置草稿按 requestId 隔离，组件卸载或请求切换即丢弃；
  // 这是宿主与 CLI 之间“用户改过哪些设置”的唯一来源，不能另存一份到组件 state。
  const workflowSettings = usePermissionWorkflowSettings(request.requestId);
  const workflowSettingsContent = isWorkflowAsk ? workflowSettings.content : undefined;
  const isOptionBlocked = useCallback(
    (option: ZCodePermissionOption) =>
      isWorkflowAsk && workflowSettings.blocked && isWorkflowSettingsCarrier(option),
    [isWorkflowAsk, workflowSettings.blocked],
  );
  // [资源] 选项与输入框的 DOM 句柄集中在这里：键盘导航依赖数组顺序，
  // 用 querySelector 临时查找会让 ref 数组与渲染顺序脱节。
  const rootRef = useRef<HTMLDivElement | null>(null);
  // selectedIndex 覆盖选项 + 反馈行（见 selectableCount），
  // 把反馈行当独立索引而不是选项的别名，是为了避免大范围重渲染选项列表。
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const feedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackCompositionActiveRef = useRef(false);
  // [并发] 焦点标记用 ref 而不是 state：rAF 回调与事件处理器需要读到同步最新值，
  // 用 state 会因为批处理读到上一帧的旧值，重新出现抢焦点问题。
  // 同组三个 ref（焦点/组合/输入框）各自独立，不能合并成一个对象位。
  const feedbackInputFocusedRef = useRef(false);
  // Deny 的目标按 displayKind 的 reject 前缀查找，而不是 optionId：
  // 不同 provider 的拒绝选项 id 不同，但语义前缀稳定。
  const denyOption = useMemo(
    () =>
      orderedOptions.find((option) =>
        getPermissionOptionDisplayKind(option.kind).startsWith("reject"),
      ),
    [orderedOptions],
  );
  // 反馈行的应答目标：工作流确认窗是 Refine（拒绝 + 修改意见升级为真实 user message），
  // 其他确认窗是 Deny（拒绝 + 反馈）。两种确认窗共用同一行输入，只换应答目标与文案，
  // 不再各画一套输入框——同一停靠区里两种反馈输入长得不一样是设计债。
  // 原因：复用 Deny 索引会让拒绝按钮和输入框同时高亮；输入行独立导航，提交才用目标选项。
  const feedbackOption = refineOption ?? (request.freeText === true ? denyOption : undefined);
  // [契约] freeText 未开启且没有 Refine 时不存在反馈行；
  // 用它统一推导选择范围与序号，避免两个布尔各自判断后数量对不上。
  const hasFeedbackInput = Boolean(feedbackOption);
  // 反馈行的序号恒等于选项数：新增选项时序号自动顺延，
  // 不要写死数字，否则数字快捷键会与可见编号错位。
  const feedbackIndex = orderedOptions.length;
  const selectableCount = orderedOptions.length + (hasFeedbackInput ? 1 : 0);
  const isFeedbackSelected = hasFeedbackInput && selectedIndex === feedbackIndex;

  // [契约] 请求切换时同时重置选中项与草稿，二者必须在一个 effect 里完成：
  // 拆成两个 effect 会出现“索引已归零、草稿还是上一条”的中间帧，
  // 用户在这一帧回车就会把旧反馈发给新请求。
  useEffect(() => {
    // 每次请求都从第一项开始，而不是记住上次选择：
    // 确认窗的默认焦点必须可预测，记住上次会把“允许”变成回车默认值。
    setSelectedIndex(0);
    // 草稿按 requestId 归零，避免一个请求的反馈（或工作流修改意见）泄漏进下一个确认窗。
    setFeedback("");
  }, [request.requestId]);

  // [并发] 焦点恢复放在 rAF 里等布局稳定；回调用当前 ref 再判一次焦点状态，
  // 因为安排帧到执行之间用户可能已经点进输入框。
  // cleanup 必须 cancel，否则快速切换请求会让多个帧互相抢焦点。
  useEffect(() => {
    if (orderedOptions.length === 0) {
      return;
    }
    if (feedbackInputFocusedRef.current) {
      return;
    }

    // 反馈输入框新增后，旧的 RAF 可能在用户获得输入焦点后才回调，重新抢回选项焦点。
    // 回调执行时再次确认焦点状态，避免打断用户输入。
    // 回调内再读 ref 而不是捕获渲染时的值：ref 是最新的焦点事实。
    // 这是修复“旧的 RAF 抢回选项焦点”的关键，删掉这层判断会重新引入输入被打断。
    const frameId = requestAnimationFrame(() => {
      if (!feedbackInputFocusedRef.current) {
        if (isFeedbackSelected) feedbackInputRef.current?.focus();
        else optionRefs.current[selectedIndex]?.focus();
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [isFeedbackSelected, orderedOptions.length, request.requestId, selectedIndex]);

  // [契约] 环形移动用取模而不是边界钳制：确认窗的键盘约定是首尾相接。
  // 移动前清掉输入框焦点标记，否则下一次 rAF 会以为用户还在输入而不恢复选项焦点。
  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (selectableCount === 0) {
        return;
      }

      feedbackInputFocusedRef.current = false;
      setSelectedIndex(
        (currentIndex) => (currentIndex + direction + selectableCount) % selectableCount,
      );
    },
    [selectableCount],
  );

  // [失败路径] 首行守卫必须同时判 responding 与 isOptionBlocked：
  // 只判其一都会留下“双击第二个请求”或“用不可用模型放行”的口子。
  // 反馈只随普通确认窗的拒绝发出，工作流窗的草稿必须留给 Refine，
  // content 只在选项是设置载体时浅拷贝，避免把 hook 内部对象直接交出去。
  const respondWithOption = useCallback(
    (option: ZCodePermissionOption) => {
      // 所选子代理模型已不可用：放行要等用户换一个，与「配置」弹层的 Apply 同一条规则。
      if (responding || isOptionBlocked(option)) return;
      const selectedKind = getPermissionOptionDisplayKind(option.kind);
      // 通用确认窗里 Deny 顺带把反馈行草稿作为拒绝理由发出；工作流确认窗的草稿属于 Refine，
      // 点 Deny 就是普通拒绝——否则一段修改意见会以普通拒绝理由的身份发出，
      // 模型收不到 workflow_refine_feedback 的升级递送。
      const trimmedFeedback =
        !refineOption && selectedKind.startsWith("reject") ? feedback.trim() : "";
      const content =
        workflowSettingsContent !== undefined && isWorkflowSettingsCarrier(option)
          ? { ...workflowSettingsContent }
          : undefined;
      if (content === undefined) {
        onRespond(request.requestId, option, trimmedFeedback || undefined);
      } else {
        onRespond(request.requestId, option, trimmedFeedback || undefined, content);
      }
    },
    [
      feedback,
      isOptionBlocked,
      onRespond,
      refineOption,
      request.requestId,
      responding,
      workflowSettingsContent,
    ],
  );

  // [契约] 反馈行走 onRespond 的第三个参数，而不是构造一个虚拟 option：
  // CLI 侧按 freeText 语义处理，虚拟 option 会被当成未知选项拒绝。
  // trim 后为空直接返回，且不改变选中态——用户还能继续输入。
  const submitFeedback = useCallback(() => {
    // 提交前 trim：CLI broker 对空白 freeText 落普通 deny，不能把纯空白当反馈。
    const trimmedFeedback = feedback.trim();
    if (responding || !feedbackOption || !trimmedFeedback) {
      return;
    }
    onRespond(request.requestId, feedbackOption, trimmedFeedback);
  }, [feedback, feedbackOption, onRespond, request.requestId, responding]);

  // 回车与确认按钮共用这一处：反馈行被选中时提交草稿，
  // 否则提交当前选项；两条路径不能各自实现，否则键盘与鼠标行为会分叉。
  const confirmSelection = useCallback(() => {
    if (isFeedbackSelected) {
      submitFeedback();
      return;
    }
    const selectedOption = orderedOptions[selectedIndex];
    if (selectedOption) respondWithOption(selectedOption);
  }, [isFeedbackSelected, orderedOptions, respondWithOption, selectedIndex, submitFeedback]);

  // [契约] 输入框里的按键先 stopPropagation：宿主（对话框/全局快捷键）不能收到回声，
  // 否则方向键既移动选项又滚动外层容器。
  // IME 判断必须在所有分支之前，组合期间的 Enter 是选词不是提交。
  // 上下键/Tab 切走焦点用 preventDefault，保证输入框内不会插入制表符。
  const handleFeedbackKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (
        isImeComposingKeyEvent({
          compositionActive: feedbackCompositionActiveRef.current,
          nativeEvent: event.nativeEvent,
        })
      ) {
        return;
      }
      // 输入框内的 Tab 与上下键都映射为选项导航：
      // 多行输入里的 Tab 插入没有意义，交还给导航更符合键盘优先原则。
      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab") {
        event.preventDefault();
        moveSelection(event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        submitFeedback();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        feedbackInputRef.current?.blur();
      }
    },
    [moveSelection, submitFeedback],
  );

  // [契约] 数字快捷键只认 1/2/3，与可见序号严格对应；
  // 反馈行占用下一个序号，所以先判 feedbackIndex 再判固定数字，顺序不能反。
  // 焦点离开列表的三个出口（命令预览、工作流设置、保存滚动区）都要求
  // 当前按钮是第一个，避免从中间项 Shift+Tab 时跳过上方内容。
  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (hasFeedbackInput && event.key === String(feedbackIndex + 1)) {
        event.preventDefault();
        setSelectedIndex(feedbackIndex);
        return;
      }
      if (event.key === "1" || event.key === "2" || event.key === "3") {
        const shortcutIndex = Number(event.key) - 1;
        const shortcutOption = orderedOptions[shortcutIndex];
        if (!shortcutOption) {
          return;
        }

        event.preventDefault();
        setSelectedIndex(shortcutIndex);
        respondWithOption(shortcutOption);
        return;
      }

      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          moveSelection(1);
          return;
        case "Tab":
          // 长命令新增了阅读按钮，旧的选项循环会困住焦点；第一项反向 Tab 交还浏览器，
          // 按 DOM 顺序进入上方命令按钮，其正向 Tab 自然回到当前第一项，不触发授权。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            rootRef.current?.querySelector("[data-command-preview-toggle]")
          ) {
            return;
          }
          // 工作流确认窗：第一个选项上的 Shift+Tab 离开列表、回到上方的设置控件（阅读次序即焦点次序）。
          // 按事件落在哪个按钮上判，不读 selectedIndex：聚焦与按键可能在同一帧，状态还没提交。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            isWorkflowAsk &&
            focusLastWorkflowSettingsControl(rootRef.current)
          ) {
            event.preventDefault();
            return;
          }
          // 保存确认窗同理：第一个选项上的 Shift+Tab 回到上方滚动区的最后一个控件，正向 Tab 再按 DOM
          // 次序走回当前选项。Bugfix：这里原先没有出口，选项循环困住焦点，折叠起来的说明、参数与脚本
          // 只能用鼠标展开。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            blockKind === "saveWorkflow" &&
            focusLastSaveWorkflowControl(rootRef.current)
          ) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          confirmSelection();
          return;
        default:
          return;
      }
    },
    [
      blockKind,
      confirmSelection,
      feedbackIndex,
      hasFeedbackInput,
      isWorkflowAsk,
      moveSelection,
      orderedOptions,
      respondWithOption,
    ],
  );

  // [契约] 块组件选择是纯映射，不做副作用也不读状态；
  // 新增块类型时这里与 PermissionBlockKind 必须同步，否则会静默落到 Fallback。
  // fallback 是兜底而不是默认分支：未知工具仍然要能确认，但不能伪装成已识别类型。
  const PermissionBlock =
    blockKind === "edit"
      ? EditToolCallBlock
      : blockKind === "mcp"
        ? McpPermissionBlock
        : blockKind === "skill"
          ? SkillToolCallBlock
          : blockKind === "web-fetch"
            ? WebFetchToolCallBlock
            : blockKind === "search"
              ? SearchToolCallBlock
              : blockKind === "execute"
                ? ExecuteToolCallBlock
                : FallbackToolCallBlock;
  // 当前 ZCode Agent 的 ExitPlanMode 权限请求不再传 legacy switch_mode。
  // 这里复用 tool identity，避免审批弹窗和聊天区的计划模式工具分流再次漂移。
  // [契约] 重新解析 identity 而不复用 blockKind，是因为 switch-mode 在聊天区仍是普通块，
  // 只有确认窗需要占位态；两处共用同一个 identity 函数，防止再次漂移。
  const shouldUseSwitchModePlaceholder = resolveToolCallIdentity(toolCall).family === "switch-mode";
  // 工作流确认窗自带本地化标题（「运行此工作流？」）和图主体，走独立块而不是通用预览块。
  // workflow 与 saveWorkflow 各自独立判断，不写成互斥的三元：
  // 两者主体与选项完全不同，合并判断会让新增类型时漏分支。
  const shouldUseWorkflowBlock = isWorkflowAsk;
  // 保存确认窗同理，但问句、内容与选项都不同：没有图、没有 Refine，主体是落点 + 元数据 + 脚本。
  // 保存窗没有图、没有 Refine，主体是落点 + 元数据 + 脚本；
  // 它同时是唯一启用限高滚动的窗，见下方 bounded。
  const shouldUseSaveWorkflowBlock = blockKind === "saveWorkflow";
  // 限高布局目前只给保存确认窗（docs/dynamic-workflow/launch.md「`SaveWorkflow`」第 4 步）：窗口上限与
  // 问答窗（ElicitationDialog）相同；选项以上全部内容是**唯一**的纵向滚动区，选项、反馈行与确认
  // 隔一条细线钉在下面。滚动区用负外边距铺满窗宽，滚动条贴窗口边缘、细线横贯整窗。
  // Bugfix：上一版问句钉顶、中段滚动、段内三块各自滚动、窗口再兜底滚动，最多五层滚动容器叠在
  // 一起，一次滚轮手势的去向取决于指针恰好在哪个框上；块内的长内容改为折叠后，这里只剩一层。
  // 钉底只在屏幕够高（≥36rem）时成立：选项、最多 5 行的反馈、错误行与确认栏本身就有约 320px，
  // 矮屏（如横屏手机）上它们会高过上限、被窗口裁掉，确认按钮跟着消失。所以基础布局是整窗一个
  // 滚动区（选项随内容滚动），够高才切到「选项以上滚、选项钉底」；两种高度下都只有一个滚动容器。
  // [权衡] 限高只在保存窗成立：它的内容（脚本）可能极长，必须给选项留出固定位置。
  // 矮屏（高度不足 36rem）回退为整窗一个滚动区，避免确认栏被裁掉，
  // 两种高度下都只允许存在一个滚动容器——这是上一版五层滚动的修复结论。
  const bounded = shouldUseSaveWorkflowBlock;
  return (
    <div ref={rootRef} className="w-full shrink-0 relative z-1">
      <div
        className={cn(
          "w-full rounded-2xl border border-border bg-popover shadow-xs",
          bounded
            ? "max-h-[min(72dvh,42rem)] overflow-y-auto overscroll-contain [@media(min-height:36rem)]:flex [@media(min-height:36rem)]:flex-col [@media(min-height:36rem)]:overflow-hidden"
            : "overflow-hidden",
        )}
        {...(bounded ? { "data-permission-dialog-bounded": "true" } : {})}
      >
        <div
          className={cn(
            "flex flex-col gap-3 p-3",
            bounded && "[@media(min-height:36rem)]:min-h-0 [@media(min-height:36rem)]:flex-1",
          )}
        >
          <div
            className={cn(
              "space-y-4",
              bounded &&
                "-mx-3 -mt-3 border-b border-border p-3 [@media(min-height:36rem)]:min-h-0 [@media(min-height:36rem)]:overflow-y-auto [@media(min-height:36rem)]:overscroll-contain",
            )}
            {...(bounded ? { "data-permission-dialog-scroll": "true" } : {})}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
                {intl.formatMessage({ id: "chat.permission.title" })}
              </p>
              <InteractionRequestOriginBadge origin={request.origin} />
            </div>
            {!shouldUseSwitchModePlaceholder &&
            !shouldUseWorkflowBlock &&
            !shouldUseSaveWorkflowBlock &&
            displayReason ? (
              <p className="text-ui-base leading-5 text-foreground">{displayReason}</p>
            ) : null}
            {shouldUseSwitchModePlaceholder ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground">
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                <span className="animated-gradient-text font-medium">
                  {intl.formatMessage({
                    id: "chat.permission.switchMode.placeholder",
                  })}
                </span>
              </div>
            ) : shouldUseWorkflowBlock ? (
              // CLI 侧的 reason 是给协议诊断用的（"createWorkflow.runConfirmation: ..."），
              // 这里刻意不渲染 displayReason：块内的本地化标题才是给用户看的那句问句。
              <WorkflowPermissionBlock
                onSettingsBlockedChange={workflowSettings.onBlockedChange}
                onSettingsChange={workflowSettings.onContentChange}
                request={request}
                settingsDisabled={responding}
                workspacePath={workspacePath}
                {...(workspaceIdentity === undefined ? {} : { workspaceIdentity })}
                {...(remoteSessionId === undefined ? {} : { remoteSessionId })}
                {...(workflowSessionModel === undefined
                  ? {}
                  : { sessionModel: workflowSessionModel })}
              />
            ) : shouldUseSaveWorkflowBlock ? (
              // 同上：保存 gate 的问句（保存 / 覆盖两句）由块自己给出，不复用协议 reason。
              <SaveWorkflowPermissionBlock request={request} />
            ) : (
              // 审批直接使用 renderer，绕过 ToolCallBlock 时也必须提供宿主展示能力。
              <ToolPresentationCapabilitiesProvider value={presentationCapabilities}>
                <PermissionBlock {...blockContext} />
              </ToolPresentationCapabilitiesProvider>
            )}
          </div>

          {/* 反馈行曾被外层 gap-3 隔开；用同一 4px 视觉分组，保留 listbox 的权限选项边界。 */}
          <div className="shrink-0 space-y-1">
            <div
              role="listbox"
              aria-label={intl.formatMessage({ id: "chat.permission.title" })}
              className="space-y-1"
            >
              {orderedOptions.map((option, index) => {
                const isSelected = index === selectedIndex;
                const officialCuaProjectPermission = isOfficialCuaProjectPermission(option);
                const labelMessageId = officialCuaProjectPermission
                  ? "chat.permission.cua.allowForProject"
                  : option.name.trim().toLowerCase() === "always allow in this project" &&
                      preview.scope === "command"
                    ? "chat.permission.allowCommand"
                    : getOptionLabelMessageId(option.kind);
                const nameMessageIds = getProviderOptionNameMessageIds(provider, option.name);
                const baseDescriptionMessageId = officialCuaProjectPermission
                  ? "chat.permission.cua.allowForProject.description"
                  : labelMessageId === "chat.permission.allowCommand"
                    ? "chat.permission.allowCommand.description"
                    : (nameMessageIds?.description ??
                      getOptionDescriptionMessageId(option.kind, preview.scope));
                // 工作流确认窗改过设置：放行的两项改口说「按调整后的设置」（docs/dynamic-workflow/launch.md
                // 「The options」）。
                const descriptionMessageId =
                  workflowSettingsContent === undefined
                    ? baseDescriptionMessageId
                    : workflowAdjustedOptionDescriptionId(baseDescriptionMessageId);
                const blocked = isOptionBlocked(option);
                const fallbackLabel = labelMessageId
                  ? intl.formatMessage({ id: labelMessageId })
                  : null;
                const knownNameLabel = nameMessageIds
                  ? intl.formatMessage({ id: nameMessageIds.label })
                  : null;
                // ZCode Agent 协议里 option.name 才是给用户看的真实选项文案，kind 只表示按钮语义。
                // 之前这里一律按 kind 本地化，像 switch_mode 这类不同语义但同属 allow_always 的选项，
                // 会被错误压成两条一模一样的“始终允许”。
                const preferOptionName = shouldPreferPermissionOptionName(option);
                const label =
                  (labelMessageId === "chat.permission.allowCommand"
                    ? fallbackLabel
                    : knownNameLabel) ??
                  (preferOptionName ? option.name : (fallbackLabel ?? option.name));
                const description =
                  (preferOptionName && !knownNameLabel) || !descriptionMessageId
                    ? null
                    : intl.formatMessage({ id: descriptionMessageId });
                const ruleScopes =
                  getPermissionOptionDisplayKind(option.kind) === "allowAlways"
                    ? readPermissionRuleScopes(option)
                    : [];

                return (
                  <button
                    key={option.optionId}
                    // exact rule 按产品语义不展示后，E2E 不能再靠可见规则文本猜 option；
                    // 暴露规范化语义供无障碍自动化稳定选择，不泄露原始命令内容。
                    data-permission-option-kind={getPermissionOptionDisplayKind(option.kind)}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-label={label}
                    aria-selected={isSelected}
                    {...(blocked ? { "aria-disabled": true } : {})}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => {
                      if (isSelected) {
                        respondWithOption(option);
                      } else {
                        setSelectedIndex(index);
                      }
                    }}
                    onFocus={() => setSelectedIndex(index)}
                    onKeyDown={handleOptionKeyDown}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-selected",
                      isSelected ? "bg-selected" : "hover:bg-hover",
                      blocked && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span
                      className={cn(
                        "w-5 shrink-0 text-ui-base font-medium self-center",
                        isSelected ? "text-foreground" : "text-foreground-subtlest",
                      )}
                    >
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex flex-1 flex-col">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-ui-base font-medium text-foreground">{label}</span>
                        {ruleScopes.length > 0 ? (
                          <InlinePermissionPrefixScopes scopes={ruleScopes} />
                        ) : description ? (
                          <span className="text-ui-base leading-4 text-foreground-subtle">
                            {description}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {feedbackOption ? (
              <div
                onClick={(event) => {
                  if (event.target !== feedbackInputRef.current) {
                    feedbackInputRef.current?.focus();
                  }
                }}
                className={cn(
                  "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
                  isFeedbackSelected ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span
                  className={cn(
                    // 匹配 textarea 的首行行高和 1px 边框；手机输入行高不同，但序号字号不变。
                    "mt-px w-5 shrink-0 self-start text-ui-base font-medium md:leading-relaxed",
                    avoidIosInputFocusZoom ? "leading-6" : "leading-5",
                    isFeedbackSelected ? "text-foreground" : "text-foreground-subtlest",
                  )}
                >
                  {feedbackIndex + 1}.
                </span>
                <Textarea
                  ref={feedbackInputRef}
                  rows={1}
                  wrap="soft"
                  value={feedback}
                  maxLength={MAX_PERMISSION_FEEDBACK_CHARS}
                  // Refine 行的文案按稳定 optionId 本地化：协议里的 name 是服务端英文兜底。
                  aria-label={intl.formatMessage({
                    id: refineOption
                      ? "chat.permission.workflow.refine"
                      : "chat.permission.feedback.ariaLabel",
                  })}
                  placeholder={intl.formatMessage({
                    id: refineOption
                      ? "chat.permission.workflow.refine.placeholder"
                      : "chat.permission.feedback.placeholder",
                  })}
                  data-permission-feedback-option={feedbackOption.optionId}
                  onFocus={() => {
                    feedbackInputFocusedRef.current = true;
                    setSelectedIndex(feedbackIndex);
                  }}
                  onBlur={() => {
                    feedbackInputFocusedRef.current = false;
                  }}
                  onChange={(event) => {
                    setFeedback(event.target.value);
                  }}
                  onCompositionStart={() => {
                    feedbackCompositionActiveRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    feedbackCompositionActiveRef.current = false;
                  }}
                  onKeyDown={handleFeedbackKeyDown}
                  className={cn(
                    // Bugfix: 拒绝反馈自动换行，但限制为 5 行并在输入框内滚动，避免窄屏遮住权限选项和确认按钮。
                    "h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 font-medium shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0",
                    resolveMobileInputTextSizeClassName({ avoidIosInputFocusZoom }),
                  )}
                />
              </div>
            ) : null}
          </div>

          {responseError ? (
            <p role="alert" className="shrink-0 text-ui-base text-destructive">
              {responseError}
            </p>
          ) : null}
          <div className="flex shrink-0 items-center justify-between gap-2 px-1">
            <p className="flex gap-2 text-ui-base items-center text-foreground-subtle">
              <Info className="text-foreground size-4 shrink-0" />
              {intl.formatMessage({ id: "chat.permission.keyboardHint" })}
            </p>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.confirm" })}
              size="lg"
              onClick={confirmSelection}
              disabled={
                responding ||
                (isFeedbackSelected
                  ? !feedback.trim()
                  : orderedOptions[selectedIndex] === undefined ||
                    isOptionBlocked(orderedOptions[selectedIndex]))
              }
              className="bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
