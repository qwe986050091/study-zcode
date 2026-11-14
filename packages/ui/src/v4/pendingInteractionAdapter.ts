// INV-01 拒绝类三种映射为同一拒绝：守住位置 或运算；改错故障 部分拒绝被当作允许。
// INV-02 永远允许附带规则更新：守住位置 规则数组；改错故障 项目授权下次仍需询问。
// INV-03 规则内容取首个非空输入：守住位置 查找调用；改错故障 规则为空导致匹配过宽。
// INV-04 兼容路径只生成精确规则：守住位置 字段原样；改错故障 两端匹配语义分叉。
// INV-05 未知种类默认允许：守住位置 末尾返回；改错故障 新种类让弹窗无法关闭。
// INV-06 全量访问选项并入列表：守住位置 条件展开；改错故障 用户看不到全量入口。
// INV-07 选项响应优先用自带值：守住位置 空值合并；改错故障 宿主给出的响应被覆盖。
// INV-08 缺响应才按种类推导：守住位置 兜底调用；改错故障 旧快照选项不可用。
// INV-09 任务标识复用会话标识：守住位置 字段赋值；改错故障 旧弹窗无法关联任务。
// INV-10 自由文本仅为真时声明：守住位置 条件展开；改错故障 弹窗出现空输入框。
// INV-11 来源信息必须透传：守住位置 条件展开；改错故障 子代理申请被当成主代理。
// INV-12 展示数据走独立通道：守住位置 条件展开；改错故障 权限弹窗解析器互相污染。
// INV-13 原始详情缺失时补最小集：守住位置 空值兜底；改错故障 弹窗读不到工具标识。
// INV-14 提问视图保留原始提示：守住位置 字段直传；改错故障 提示被本地化覆盖。
// INV-15 敏感标记原样保留：守住位置 可选字段；改错故障 敏感输入被当作普通文本。
// INV-16 无问题清单不生成请求：守住位置 空值判断；改错故障 生成空白问卷。
// INV-17 问题标题缺省回退提示语：守住位置 空值兜底；改错故障 问卷首行空白。
// INV-18 多选与草稿按需展开：守住位置 条件展开；改错故障 出现虚假多选状态。
//
// 模块职责：把 v4 待处理交互适配成旧权限弹窗与问卷可消费的形状。
// 状态所有权：无状态；纯映射，不改写入参。
// 阅读顺序：先看选项到响应的映射，再看权限请求，最后看问卷两件。
import type {
  ZCodePermissionOption,
  ZCodePermissionRequest,
  ZCodePermissionResponse,
  ZCodeElicitationRequest,
} from "@zcode/shared";
import type {
  PendingInteraction,
  PermissionRequestPayload,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

const LEGACY_PERMISSION_RULE_INPUT_KEYS = [
  "command",
  "url",
  "file_path",
  "path",
  "pattern",
] as const;

// deny / rejectOnce / rejectAlways 都返回 decision: "deny"
// allowAlways 固定带一条 addRules 的 exact 规则
// ruleContent 取 LEGACY_PERMISSION_RULE_INPUT_KEYS 首个非空值
// 未命中任何 kind 时兜底 decision: "allow"
function permissionKindToResponse(
  kind: string,
  payload: PermissionRequestPayload,
): ZCodePermissionResponse {
  if (kind === "deny" || kind === "rejectOnce" || kind === "rejectAlways") {
    return { decision: "deny" };
  }
  if (kind === "allowAlways") {
    const detail =
      typeof payload.detail === "object" && payload.detail !== null
        ? (payload.detail as Record<string, unknown>)
        : {};
    const ruleContent = LEGACY_PERMISSION_RULE_INPUT_KEYS.map((key) => detail[key]).find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    // 旧 v4 snapshot 的 option 没有 response；若只回退 allow，项目级授权会
    // 丢失持久规则。兼容路径只生成原始 exact，不在 UI 重算 CLI 的 AST prefix。
    return {
      decision: "allow",
      permissionUpdates: [
        {
          behavior: "allow",
          rules: [
            {
              toolName: payload.toolName,
              ...(ruleContent ? { ruleContent } : {}),
            },
          ],
          type: "addRules",
        },
      ],
    };
  }
  return { decision: "allow" };
}

/** v4 permission payload → 旧 PermissionDialog 可消费的 ZCodePermissionRequest。 */
// fullAccessOption 追加在 payload.options 末尾
// option.response ?? permissionKindToResponse(...)，自带值优先
// origin 与 display 只在存在时展开进结果
// raw 缺失时兜底 { toolCallId, toolName }
export function pendingPermissionToLegacyRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: PermissionRequestPayload },
): ZCodePermissionRequest {
  const { payload } = interaction;
  const advertisedOptions = payload.fullAccessOption
    ? [...payload.options, payload.fullAccessOption]
    : payload.options;
  const options: ZCodePermissionOption[] = advertisedOptions.map((option) => ({
    optionId: option.optionId,
    kind: option.kind,
    name: option.label,
    response: option.response ?? permissionKindToResponse(option.kind, payload),
  }));

  return {
    type: "permission_request",
    taskId: sessionId,
    traceId: sessionId,
    requestId: interaction.interactionId,
    description: payload.summary,
    kind: payload.toolName,
    title: payload.toolName,
    options,
    ...(payload.freeText ? { freeText: true } : {}),
    // V4 permission 的 subagent 来源已经存在于 pendingInteraction，
    // 旧适配器漏传后 PermissionDialog 无法展示来源，用户会误以为是主 Agent 在申请权限。
    ...(payload.origin ? { origin: payload.origin } : {}),
    // 工具自报的确认预览走独立的 display 通道，不塞进 raw/detail：detail 的形状被所有
    // 工具的预览解析共用，改一处会波及全部权限弹窗。
    ...(payload.display ? { display: payload.display } : {}),
    raw: payload.detail ?? {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    },
  };
}

export interface V4UserInputViewModel {
  interactionId: string;
  prompt: string;
  freeText: boolean;
  sensitive?: boolean;
  options: ReadonlyArray<{ optionId: string; label: string }>;
}

export function pendingUserInputToViewModel(
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): V4UserInputViewModel {
  return {
    interactionId: interaction.interactionId,
    prompt: interaction.payload.prompt,
    freeText: interaction.payload.freeText,
    sensitive: interaction.payload.sensitive,
    options: interaction.payload.options ?? [],
  };
}

// questions 为空时返回 null
// message 回退到 firstQuestion.question ?? payload.prompt
// multiSelect / answerDrafts 只在存在时展开
export function pendingUserInputToElicitationRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): ZCodeElicitationRequest | null {
  const { payload } = interaction;
  if (!payload.questions || payload.questions.length === 0) {
    return null;
  }
  const firstQuestion = payload.questions[0];
  return {
    type: "elicitation_request",
    taskId: sessionId,
    traceId: payload.traceId ?? sessionId,
    requestId: interaction.interactionId,
    message: firstQuestion?.question ?? payload.prompt,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions: payload.questions,
    ...(payload.currentQuestionIndex !== undefined
      ? { currentQuestionIndex: payload.currentQuestionIndex }
      : {}),
    ...(payload.answerDrafts ? { answerDrafts: payload.answerDrafts } : {}),
    ...(payload.origin ? { origin: payload.origin } : {}),
    schema: payload.schema ?? payload.input,
  };
}
