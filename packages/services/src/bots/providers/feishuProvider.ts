import { getUnavailableReplyFallback } from "#src/bots/groupReply.js";
// 群消息解析被抽成纯函数模块（feishuGroupMessages.ts）：mention / 命令切分
// 需要独立单测且不能依赖网络；放回本文件会被 max-lines 与鉴权副作用牵连。
// GroupMemberPage 只用于 createGroupMemberDirectory 的返回值，
// 本文件不感知分页游标格式，群成员拉取能力完全由依赖注入提供。
import {
  createGroupMemberDirectory,
  type GroupMemberPage,
} from "#src/bots/providers/groupMemberDirectory.js";
import { channelContentPartsSchema, channelContentText, botGroupCardSchema } from "@zcode/shared";
// channelContentPartsSchema / botGroupCardSchema 做运行时校验：
// inbound 正文与卡片 value 都是外部输入，不能只按 TS 类型信任。
import {
  isFeishuBotSender,
  isGroupControlCard,
  readGroupConversationCardText,
  readGroupCardText,
  readGroupMessage,
  readGroupMentionText,
} from "#src/bots/providers/feishuGroupMessages.js";
// [权衡] 该文件同时承载鉴权、解析、卡片与 reaction，已超过 max-lines 惯例；
// 拆包需要把 token 缓存改成跨文件共享状态，成本高于收益，因此暂时抑制规则。
/* eslint-disable max-lines -- Feishu provider 集中承载鉴权、消息解析、卡片发送和 reaction typing 适配，后续按能力拆分。 */
import { botTopicMessageSchema } from "@zcode/shared";
import { readTopicHistory, TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
// 统一模型类型只从 shared 公开入口导入，保证 adapter 与 botsService
// 使用同一份字段定义，避免两侧各自演化（INV-01 的边界）。
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  SelectionPrompt,
} from "@zcode/shared";
// 三个 Handle 类型是卡片生命周期契约：streaming 句柄带 providerMessageId
// 供 PATCH 定位；transient 句柄只用于撤回，二者不能混用。
import type {
  BotProviderAdapter,
  BotStreamingReplyCardHandle,
  BotStreamingReplyCardState,
  BotTransientInteractionCardHandle,
} from "./types.js";
import { formatBotMessage } from "../messages.js";
// 所有出站 HTTP 都经 fetchBotProviderJson：统一 15s 超时、统一提取
// x-tt-logid；本文件不直接调用 fetch，否则超时与错误口径会分叉（INV-10）。
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
// 群输入 reaction 独立成模块，本文件只注入 bot/deps，
// 避免 typing 状态与消息解析互相耦合。
import { createGroupInputReactionUpdater } from "#src/bots/providers/groupInputReaction.js";

// ============================================================================
// feishuProvider.ts 第 1 段（1-1456 行）职责与不变量
// ----------------------------------------------------------------------------
// 本文件是飞书 / Lark 渠道的协议适配器：把长连接 / HTTP 回调 payload 翻译成
// 统一 BotInboundMessage，把 BotOutboundMessage 翻译成 Card JSON 2.0，
// 并维护 tenant_access_token、reaction typing 等 channel 侧状态。
// 本段只做「解析 + 卡片构造 + token 获取」，真正发送在 seg2；两段共享同一组
// 模块级缓存，因此缓存的创建/过期/删除口径必须在这里一次说清。
//
// 本文件维持 / 依赖的不变量（编号沿用批次表，不另起）：
// INV-01：适配层只翻译协议；权限、幂等、ownership 判定属于 botsService，
//   正文或按钮 value 里的身份不能提升权限（readFeishuCardAction、
//   addGroupCardContext 的 mention 白名单）。
// INV-02：发送必须拿到 provider message_id 才算成功（sendFeishuInteractiveCard
//   的 delivery 分支，及 seg2 的 1474 行判断）。
// INV-03：入站去重键取 message_id / event_id，缺失时 fail-open 但不得伪造
//   （readFeishuTextMessage 的 messageId、readFeishuCardAction 的兜底链）。
// INV-04：附件下载必须校验状态码、大小上限、超时（本段只定义
//   FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS 与 sizeBytes 口径，执行在 seg2）。
// INV-05：回调必须校验签名 / verification token；本段只解析已通过校验的
//   payload，不提供任何「无签名也放行」的分支。
// INV-06：卡片有元素预算（180 / 200）与流式分片（splitFeishuStreamingCardStates、
//   FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET）。
// INV-07：typing / reaction 必须可撤销且 stop 幂等（typingReactionIds 生命周期）。
// INV-08：凭据只经 deps.loadCredential 读取；token 缓存必须处理过期与并发
//   （readTenantAccessToken）。
// INV-09：文件名先净化再落盘（本段只读取远端 filename，净化责任在下载侧）。
// INV-10：adapter 不自行无限重试，失败映射成稳定错误（createFeishuMessageError）。
// INV-12：close / dispose 后不得再发请求，定时器必须释放（本段只声明
//   FeishuWebSocketClient 契约，实现在 seg2 startFeishuBotWebSocket）。
// ============================================================================
interface FeishuProviderDeps {
  // 凭据唯一入口：adapter 不读环境变量、不读 bot 上的明文 secret，
  // 只按 credentialRef 取值（INV-08）；注入也让单测完全离线。
  loadCredential(key: string): Promise<string | null>;
  // 投递结果回调只在「确定发出 / 确定失败」后触发；它不是成功判据，
  // 成功判据始终是 provider message_id（INV-02）。
  onDeliveryResult?(bot: BotConfig, error: string | undefined): void;
}

// 长连接句柄契约：调用方只拿到 close 与可选终态。
// [资源] close 必须幂等（INV-12）：重复停止时 SDK socket 已是 CLOSED，
// 再次调用只能是 no-op，不能抛错打断上层 stop 流程。
export interface FeishuWebSocketClient {
  close(): void;
  /** SDK 自动重连耗尽后的终态；旧测试替身可不提供。 */
  // terminated 表达「SDK 重连耗尽、链路不可恢复」，供上层触发重建；
  // 老测试替身没有该字段所以可选，读取方必须先判空——否则 TypeError 会
  // 伪装成连接错误，把排障引向错误方向。
  terminated?: Promise<void>;
}

// App ID 形态校验：cli_ + 16 位十六进制是自建应用的固定格式。
// 在建连前失败，避免把畸形 app_id 交给 SDK 反复重连。
const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
// [资源] 建连超时：20s 内不 resolve 就 reject，并关闭已创建的 socket；
// 若只 reject 不关闭，遗留连接会继续占用 SDK 的事件循环与重连计时器。
const FEISHU_WEBSOCKET_START_TIMEOUT_MS = 20_000;
// 轮询 readyState 而非等 SDK 回调：不同版本的 WebSocketClient 暴露的
// ready 信号不一致，轮询是唯一稳定的就绪口径。
const FEISHU_WEBSOCKET_READY_POLL_MS = 100;
// 修复原因：飞书 Card JSON 2.0 最多允许 200 个组件或元素。预留 20 个元素给
// 状态行和服务端计数差异，避免长任务在更新阶段被 11310 拒绝后整轮熔断。
// 预算取 180 而非 200：状态行、tools 面板头以及飞书自身计数差异都要留余量。
export const FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET = 180;
// 只依赖数值 1 而不是 SDK 常量：把 SDK 内部枚举挡在类型边界之外，
// 升级 SDK 时这里不会因为导出改名而编译失败。
const WEBSOCKET_OPEN_READY_STATE = 1;

// tenant_access_token 响应口径：code===0 才是成功；expire 单位为秒，
// 表示从签发时刻起的剩余有效期。飞书可能返回「尚未过期」的旧令牌，
// 因此不能假设它恒等于 7200。
interface FeishuAccessTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

// 发送响应：data.message_id 是唯一可信的投递凭据（INV-02）；
// error.log_id 是排查 400 / 权限 / 限流的关键，必须随错误一起上抛。
interface FeishuSendMessageResponse {
  code?: number;
  msg?: string;
  error?: {
    log_id?: string;
  };
  data?: {
    message_id?: string;
  };
}

// reaction 响应：reaction_id 是后续 DELETE 的唯一凭据；缺失时本层不缓存，
// 也就无法撤销，只能等飞书侧超时回收。
interface FeishuReactionResponse {
  code?: number;
  msg?: string;
  data?: {
    reaction_id?: string;
  };
}

// [资源] 附件下载总超时 30s，执行点在 seg2 的 2862 行。abort 之后必须
// 丢弃已读到的半截 buffer，不能交给上层（INV-04）。
const FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

// 应用信息响应：app_name 为空时退回 primary_language 对应的 i18n 名称，
// 再退回任意非空 i18n；顺序即优先级，改顺序会让展示名随租户抖动。
interface FeishuAppInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    app?: {
      app_name?: string;
      primary_language?: string;
      i18n?: Array<{
        i18n_key?: string;
        name?: string;
      }>;
    };
  };
}

// 用户信息响应：name → en_name → nickname 是通讯录稳定度顺序。
// 后两者可被用户随时修改，只有 name 适合长期展示。
interface FeishuUserInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    user?: {
      name?: string;
      en_name?: string;
      nickname?: string;
    };
  };
}

// [并发] accessTokenCache 是进程级 Map，key = 域:appId:credentialRef。
// 多 bot 共享同一 key 复用同一 token 是安全的（token 属于应用而非会话）；
// credentialRef 必须进 key，换绑凭据后旧 token 不能被继续使用。
// 生命周期：只增不减，同 key 刷新时覆盖；条目数等于绑定应用数，规模有界。
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
// typingReactionIds 记录 messageId → reaction_id，用于撤销 Typing reaction
// （INV-07）。add 成功且拿到 reaction_id 才写入，delete 成功才移除；
// 无 TTL，进程异常退出会留下无法撤销的残留 reaction。
const typingReactionIds = new Map<string, string>();
// 用户展示名缓存 10 分钟：消息事件只带 sender_id 不带姓名，逐条查 contact
// 会放大 QPS；负结果（null）也缓存，避免对无权限用户反复打接口。
const userDisplayNameCache = new Map<string, { name: string | null; expiresAt: number }>();
// 表单字段名固定为 answer：按钮回调按该 key 从 form_value 取用户输入，
// 改名会让提交值取不到而被当成空答案。
const FEISHU_ELICITATION_FORM_FIELD_NAME = "answer";
// __form__: 是「卡片表单提交」哨兵：命令含该前缀时说明必须用 form_value
// 重新拼命令，而不是直接执行按钮上携带的旧命令。
const FEISHU_ELICITATION_FORM_VALUE_PREFIX = "__form__:";
// __custom__ 是「自定义答案」伪选项，不属于 questions.options；
// 它只用于路由（INV-11），服务端必须再校验取值是否合法。
const FEISHU_ELICITATION_CUSTOM_OPTION_ID = "__custom__";

// 统一 record 判定：数组也算 object，但这里只用于取字段，
// 数组下标访问不会误判，因此不额外排除 Array。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 只从 elicitation.schema 读计划正文，且 interaction 必须恰为 plan_approval。
// [权衡] 若改成「任意 string 字段都当计划」，按钮回调 payload 里的恶意文本
// 会被渲染成审批正文，等同允许远端注入卡片内容（INV-01）。
function readPlanApprovalContent(message: BotOutboundMessage): string | null {
  const schema = message.elicitation?.schema;
  if (!isRecord(schema) || schema.interaction !== "plan_approval") {
    return null;
  }
  return typeof schema.plan === "string" && schema.plan.trim() ? schema.plan.trim() : null;
}

// 把 selection 选项翻译成聊天命令文本。真正的鉴权发生在服务端解析命令时，
// 这里只保证与历史命令格式一致，避免新旧两条命令路径语义漂移。
function formatSelectionCommand(selection: SelectionPrompt, optionId: string): string {
  // permission / queue 两类动作的 optionId 本身就是完整命令（如 allow / deny），
  // 再加前缀会让服务端解析出未知命令。
  if (selection.action === "permission.respond" || selection.action === "queue.cancel") {
    return optionId;
  }
  if (selection.action === "elicitation.respond") {
    // elicitation 必须带 token：token 绑定具体提问实例，缺 token 的回答
    // 无法归属到某次提问，服务端会按非法回答丢弃。
    return selection.token
      ? `/elicitation ${selection.token} ${optionId}`
      : `/elicitation ${optionId}`;
  }
  // model.provider.set 与 model.set 共用 /model 前缀但子域不同，这里穷举
  // 而不是拼接，避免 action 含点号时拼出 /model.provider 这种非法命令。
  if (selection.action === "model.provider.set") {
    return `/model provider ${optionId}`;
  }
  if (selection.action === "model.set") {
    return `/model model ${optionId}`;
  }
  // 兜底会去掉 .set 后缀：剩余动作保持 /<action> <id> 的通用形式，
  // 由服务端做最终合法性校验。
  return `/${selection.action.replace(".set", "")} ${optionId}`;
}

// answers 以「题目下标字符串」为 key，取不到视为未答；返回原数组引用，
// 卡片每帧重建时可省一次拷贝。
function readElicitationAnswerValues(message: BotOutboundMessage, questionIndex: number): string[] {
  return message.elicitation?.answers?.[String(questionIndex)] ?? [];
}

// 把已选 value 映射回 label 展示；option 缺失（历史答案对应已删选项）时
// 退回原始 value，保证卡片仍能看到用户当时的选择而不是空白。
function formatElicitationAnswerLabel(message: BotOutboundMessage, questionIndex: number): string {
  const question = message.elicitation?.questions[questionIndex];
  const values = readElicitationAnswerValues(message, questionIndex);
  if (!question || values.length === 0) {
    return "";
  }
  const labels = values.map((value) => {
    const option = question.options.find((item) => item.value === value);
    return option?.label ?? value;
  });
  return labels.join(", ");
}

// Card JSON 2.0 的纯文本节点必须带 tag，裸字符串会被 400 拒绝；
// 统一由该函数产出 plain_text，避免各处遗漏 tag。
function formatFeishuPlainText(content: string): Record<string, string> {
  return { tag: "plain_text", content };
}

// 表单提交命令：由按钮 behaviors.callback 携带，value 为空表示表单占位，
// 真实答案在回调的 action.form_value[answer] 中，由 readFeishuCardAction 拼接。
// encodeURIComponent(JSON.stringify(value)) 保证多选数组与中文答案不被空格切散。
function buildFeishuElicitationFormCommand(token: string, value?: unknown): string {
  const suffix =
    value === undefined
      ? FEISHU_ELICITATION_FORM_VALUE_PREFIX
      : `${FEISHU_ELICITATION_FORM_VALUE_PREFIX}${encodeURIComponent(JSON.stringify(value))}`;
  return `/elicitation ${token} ${suffix}`;
}

// 自定义答案 = 所有不在 options 里的已选值。用 Set 比较 value 而不是 label：
// label 会本地化，value 才是稳定标识。
function readFeishuElicitationCustomValues(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): string[] {
  const optionValues = new Set(question.options.map((option) => option.value));
  return readElicitationAnswerValues(message, questionIndex).filter(
    (value) => !optionValues.has(value),
  );
}

// 选项按钮的勾选态完全由 answers 推导，飞书侧不保存状态：
// 同一份 BotOutboundMessage 重复渲染得到同一张卡，重发/回滚都幂等。
function buildFeishuElicitationChoiceButton(params: {
  message: BotOutboundMessage;
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number];
  option: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number]["options"][number];
  selectedValues: readonly string[];
}): Record<string, unknown> {
  // 单选用 ●/○，多选用 ☑/☐：形状差异表达「互斥 / 可累积」，
  // 只靠颜色区分对色觉障碍用户不友好。
  const selected = params.selectedValues.includes(params.option.value);
  const marker = params.question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
  return buildFeishuButtonElement({
    text: `${marker} ${params.option.label}`,
    type: selected ? "primary" : "default",
    command: buildFeishuElicitationOptionCommand(params.message, params.option.value),
    originalText: params.message.text,
  });
}

// 有 selection.token 时生成带 token 的完整命令；没有 token 只能回退裸
// optionId，这类卡片只可能出现在不依赖回答归属的场景。
function buildFeishuElicitationOptionCommand(
  message: BotOutboundMessage,
  optionId: string,
): string {
  const token = message.selection?.token;
  return token
    ? formatSelectionCommand(
        {
          id: message.selection?.id ?? "",
          token,
          title: message.selection?.title ?? message.text,
          action: "elicitation.respond",
          options: [],
        },
        optionId,
      )
    : optionId;
}

// 「展开自定义输入」是纯 UI 状态，挂在 message.elicitation 上随 outbound
// 传递，避免卡片构造读全局状态导致多会话互相污染。
function isFeishuElicitationCustomExpanded(
  message: BotOutboundMessage,
  questionIndex: number,
): boolean {
  return message.elicitation?.expandedCustomAnswerQuestionIndexes?.includes(questionIndex) ?? false;
}

// 自定义按钮在「已展开」或「已有自定义值」时显示选中：两种情形都说明
// 用户正在/已经使用自定义答案，否则用户会以为选择丢失。
function buildFeishuElicitationCustomButton(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): Record<string, unknown> {
  const customValues = readFeishuElicitationCustomValues(message, question, questionIndex);
  const expanded = isFeishuElicitationCustomExpanded(message, questionIndex);
  const selected = expanded || customValues.length > 0;
  const marker = question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
  const customLabel = formatBotMessage(message.locale, "elicitationCustomOption");
  return buildFeishuButtonElement({
    text: `${marker} ${customLabel}`,
    type: selected ? "primary" : "default",
    command: buildFeishuElicitationOptionCommand(message, FEISHU_ELICITATION_CUSTOM_OPTION_ID),
    originalText: message.text,
  });
}

// 表单只在「需要输入」或「多选」时渲染：单选且已有选项时按钮本身即最终
// 动作，再挂提交按钮会让用户误以为需要二次确认。
function buildFeishuElicitationForm(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): Record<string, unknown> | null {
  const selection = message.selection;
  // 无 token 不渲染表单：提交命令需要 token 才能归属回答，
  // 生成一个点不动的表单比不渲染更糟。
  if (!selection?.token) {
    return null;
  }
  const customExpanded = isFeishuElicitationCustomExpanded(message, questionIndex);
  // [权衡] options 为空视为「必须自由输入」，input 设 required；
  // 有选项但展开自定义时 input 可留空，避免用户只想切回选项却被表单拦住。
  const shouldShowInput = question.options.length === 0 || customExpanded;
  const shouldShowSubmit = question.multiSelect || shouldShowInput;
  if (!shouldShowSubmit) {
    return null;
  }
  const customValues = readFeishuElicitationCustomValues(message, question, questionIndex);
  const formElements: Array<Record<string, unknown>> = [];
  // 输入框 name 必须等于 FEISHU_ELICITATION_FORM_FIELD_NAME：回调按该常量
  // 取值，任一侧改名都会让答案静默丢失。
  if (shouldShowInput) {
    formElements.push({
      tag: "input",
      name: FEISHU_ELICITATION_FORM_FIELD_NAME,
      required: question.options.length === 0,
      width: "fill",
      input_type: "multiline_text",
      rows: 2,
      auto_resize: true,
      max_rows: 5,
      placeholder: formatFeishuPlainText(
        formatBotMessage(message.locale, "elicitationCustomPlaceholder"),
      ),
      default_value: customValues.join(", "),
    });
  }
  // 提交按钮用 form_action_type=submit：飞书把表单内所有 input 汇总到
  // action.form_value 一次性回传，少一轮交互。
  formElements.push({
    tag: "button",
    text: formatFeishuPlainText(formatBotMessage(message.locale, "elicitationSubmitOption")),
    type: "primary",
    form_action_type: "submit",
    name: "submit",
    behaviors: [
      {
        type: "callback",
        value: {
          // 表单命令先不带答案，只带 token 与 __form__: 前缀；答案在回调时注入，
          // 保证卡片本身不携带用户输入。
          command: buildFeishuElicitationFormCommand(selection.token),
          zcodeCardText: message.text,
        },
      },
    ],
  });
  return {
    tag: "form",
    name: `elicitation_form_${questionIndex}`,
    direction: "vertical",
    vertical_spacing: "8px",
    elements: formElements,
  };
}

// 历史答案区只展示「已提交」的题目：进行中的当前题由按钮/表单渲染，
// 若也进入历史区，同一题会同时出现「已回答」和「待回答」（见下方原注释）。
function buildFeishuElicitationAnswerElements(
  message: BotOutboundMessage,
): Array<Record<string, unknown>> {
  const elicitation = message.elicitation;
  if (!elicitation) {
    return [];
  }
  // completed / cancelled 视为终态：终态下答案已定稿，不再按 currentQuestionIndex
  // 截断，否则最后几题会从卡片上消失。
  const total = elicitation.questions.length;
  const isCompleted = elicitation.status === "completed" || elicitation.status === "cancelled";
  const elements: Array<Record<string, unknown>> = [];
  elicitation.questions.forEach((question, index) => {
    // 修复原因：当前题的多选值只是尚未提交的草稿。如果也放进上方历史区，
    // 同一问题会同时显示为“已回答”和“待回答”。进行中只累积此前已提交的题目。
    // 用 index >= currentQuestionIndex 截断而不是「只取有答案的题」：
    // 用户可能跳题，按下标截断能保证展示顺序与提问顺序一致。
    if (!isCompleted && index >= elicitation.currentQuestionIndex) {
      return;
    }
    const answer = formatElicitationAnswerLabel(message, index);
    if (!answer) {
      return;
    }
    // 题干与答案拆成两个 markdown 节点：飞书对单节点内容有长度上限，
    // 合并后长答案更容易被截断。
    elements.push(
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(`#### ${index + 1}/${total} ${question.question}`),
      },
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(answer),
      },
    );
  });
  return elements;
}

// 群卡片上下文注入：正文 @、服务注入的提醒、以及 groupCard 路由上下文。
// 该函数就地修改传入 card（body.elements 与按钮 value），调用方必须是
// 该 card 的唯一持有者；共享同一对象再调用会造成重复插入。
function addGroupCardContext(
  card: Record<string, unknown>,
  message: BotOutboundMessage,
): Record<string, unknown> {
  // bodyMentions 记录正文里已 @ 的 id，用于去重：同一人既在正文被 @、
  // 又在 mentionedUserIds 里时只保留一次，飞书对重复 at 会报错。
  const bodyMentions = new Set(
    message.contentParts?.flatMap((part) =>
      part.type === "channelMention" ? [part.targetId] : [],
    ) ?? [],
  );
  // 正文重建：mention 转 <at id=...>，普通文本必须转义 & < >，
  // 否则用户消息里的 at 片段会被当作真实提醒触发越权通知（INV-01）。
  if (message.contentParts && isRecord(card.body)) {
    card.body.elements = [
      {
        tag: "markdown",
        content: message.contentParts
          .map((part) =>
            part.type === "channelMention"
              ? `<at id=${part.targetId}></at>`
              : part.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
          )
          .join(""),
      },
    ];
  }
  // 只接受服务注入的个人 ID，不把正文/姓名解析成提醒，也不允许 all 扩大通知范围。
  // 只接受 ou_ 前缀且形如 open_id 的值：不解析正文/姓名、不允许 all，
  // 否则任意用户都能通过正文扩大提醒范围。
  const ids = [...new Set(message.mentionedUserIds ?? [])].filter(
    (id) => /^ou_[a-zA-Z0-9_-]+$/u.test(id) && !bodyMentions.has(id),
  );
  // 仅群聊（providerUserId 以 oc_ 开头）才注入顶部提醒行；私聊没有群成员
  // 概念，注入会变成对单聊对方的重复 @。
  if (
    message.providerUserId.startsWith("oc_") &&
    ids.length &&
    isRecord(card.body) &&
    Array.isArray(card.body.elements)
  ) {
    card.body.elements.unshift({
      tag: "markdown",
      content: ids.map((id) => `<at id=${id}></at>`).join(" "),
    });
  }
  // groupCard 要挂到每个按钮 value 上，回调才能带回群上下文；递归遍历而非
  // 固定路径，是因为卡片由多个 builder 组合、层级并不固定。
  if (!message.groupCard) return card;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;
    // 只改带 command 的 value：markdown/文本节点的 value 不是按钮回调，
    // 误加 groupCard 会污染渲染内容。
    if (isRecord(node.value) && typeof node.value.command === "string")
      node.value = { ...node.value, groupCard: message.groupCard };
    for (const value of Object.values(node)) visit(value);
  };
  visit(card);
  return card;
}
// 两个对外入口都先构造 body 再注入群上下文，顺序不能反：
// addGroupCardContext 依赖 body.elements 已存在。
function buildFeishuElicitationCardPayload(message: BotOutboundMessage): Record<string, unknown> {
  return addGroupCardContext(buildFeishuElicitationCardPayloadBody(message), message);
}
// 交互卡与问答卡共用群上下文注入，保证两条路径的 @ / groupCard 行为一致。
function buildFeishuInteractiveCardPayload(message: BotOutboundMessage): Record<string, unknown> {
  return addGroupCardContext(buildFeishuInteractiveCardPayloadBody(message), message);
}

// buildFeishuElicitationCardPayloadBody 按「历史答案 → 计划正文 → 当前题 → 按钮/表单」拼装。
// 元素数随题目/选项线性增长，预算与降级由 splitFeishuStreamingCardStates
// 在流式卡侧兜底，这里不做裁剪（INV-06）。
function buildFeishuElicitationCardPayloadBody(
  message: BotOutboundMessage,
): Record<string, unknown> {
  const elicitation = message.elicitation;
  const selection = message.selection;
  if (!elicitation) {
    return buildFeishuInteractiveCardPayloadBody(message);
  }
  // currentQuestionIndex 越界时取第一题：回调控件可能带回旧状态，
  // 越界直接抛错会让整轮交互不可恢复。
  const currentQuestion =
    elicitation.questions[elicitation.currentQuestionIndex] ?? elicitation.questions[0];
  const isCompleted = elicitation.status === "completed" || elicitation.status === "cancelled";
  const answerElements = buildFeishuElicitationAnswerElements(message);
  const planApprovalContent = readPlanApprovalContent(message);
  // elements 顺序即视觉顺序，任何一段插入位置变化都会让用户以为
  // 问题重复或缺失。
  const elements: Array<Record<string, unknown>> = [];
  // 终态 + 计划审批补回计划正文：旧实现只留审批答案，计划正文消失，
  // 用户无法在聊天历史里回看自己批准了什么。
  if (isCompleted && planApprovalContent) {
    // 修复原因：Plan 交互完成后保留卡片时，旧终态分支只渲染审批答案，导致计划正文消失。
    // 只读终态仍需保留完整计划，用户才能在聊天历史中回看自己批准或取消的内容。
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(planApprovalContent),
    });
    if (answerElements.length > 0) {
      elements.push({ tag: "hr" });
    }
  }
  // 用 push(...answerElements) 而不是 concat 新数组：卡片每帧重建，
  // 不再为一次性拼接多分配一层。
  elements.push(...answerElements);
  // 非终态才渲染当前题与按钮；终态渲染按钮等于允许对已结束提问继续作答。
  if (!isCompleted && currentQuestion) {
    if (answerElements.length > 0) {
      elements.push({ tag: "hr" });
    }
    // 计划审批不渲染通用「提问」标题：计划正文自身就是上下文，
    // 再加标题会让长计划卡在手机首屏看不到内容。
    if (!planApprovalContent) {
      elements.push({
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(
          `#### ${formatBotMessage(message.locale, "elicitationQuestionTitle")}`,
        ),
      });
    }
    // 修复原因：ExitPlanMode 不是普通问答。计划正文若只留在流式消息中，审批卡会失去上下文；
    // 因此计划审批使用专属正文，而 AskUserQuestion 继续沿用通用“提问”结构。
    // header 与 question 相同只渲染一次：AskUserQuestion 常见这种重复，
    // 输出两遍会让卡片看起来像两个问题。
    const contentParts = planApprovalContent
      ? [planApprovalContent]
      : [
          currentQuestion.header && currentQuestion.header !== currentQuestion.question
            ? `**${currentQuestion.header}**`
            : null,
          currentQuestion.question,
        ];
    // 过滤空片段后以空行连接：header 为空的题不能留下孤立的空 markdown 节点。
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(
        contentParts
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n"),
      ),
    });
    // planApprovalContent 非空时在正文后插 hr 与「审批」小标题，把内容区与操作区分开；
    // 这是唯一显式区分 ExitPlanMode 与普通问答的位置。
    if (planApprovalContent) {
      elements.push(
        { tag: "hr" },
        {
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(
            `**${formatBotMessage(message.locale, "planApprovalTitle")}**`,
          ),
        },
      );
    }
    // 选中态取当前题的 answers：不能用上一题，否则切题时按钮高亮错位。
    const selectedValues = readElicitationAnswerValues(message, elicitation.currentQuestionIndex);
    for (const option of currentQuestion.options) {
      // 计划审批复用同一组 options，只替换 label/description：服务端仍按原
      // option.id 执行，避免为审批新增一条命令通道（INV-01）。
      const displayOption = planApprovalContent
        ? {
            ...option,
            label: formatBotMessage(message.locale, "planApprovalApprove"),
            description: formatBotMessage(message.locale, "planApprovalApproveDescription"),
          }
        : option;
      elements.push(
        buildFeishuElicitationChoiceButton({
          message,
          question: currentQuestion,
          option: displayOption,
          selectedValues,
        }),
      );
    }
    // 自定义答案按钮始终提供：计划审批下它等价于「拒绝并给出理由」，
    // 语义由服务端结合 elicitation 状态判断。
    elements.push(
      buildFeishuElicitationCustomButton(
        message,
        currentQuestion,
        elicitation.currentQuestionIndex,
      ),
    );
    // 表单与选项按钮并列渲染：单选有选项时 buildFeishuElicitationForm 返回
    // null，这里不需要再判断一次显示条件。
    const form = buildFeishuElicitationForm(
      message,
      currentQuestion,
      elicitation.currentQuestionIndex,
    );
    // form 为 null 表示当前题不需要输入区，原因由 buildFeishuElicitationForm
    // 集中维护，调用方不重复推导。
    if (form) {
      elements.push(form);
    }
    // 取消按钮的显示条件与表单一致（多选 / 无选项 / 已展开自定义）：
    // 这些状态下用户可能改变主意，而选项按钮无法表达「放弃」。
    const shouldShowCancel =
      currentQuestion.multiSelect ||
      currentQuestion.options.length === 0 ||
      isFeishuElicitationCustomExpanded(message, elicitation.currentQuestionIndex);
    // 展开自定义时取消按钮改为回传 __custom__：此时「取消」表示收起输入区，
    // 不是放弃整题；沿用 /cancel 会让服务端误判为用户拒绝回答。
    if (selection && shouldShowCancel) {
      const customExpanded = isFeishuElicitationCustomExpanded(
        message,
        elicitation.currentQuestionIndex,
      );
      // showCancel === false 时完全不追加按钮：严格比较避免 undefined
      // 被当成「不要取消」。
      elements.push(
        ...(selection.showCancel === false
          ? []
          : [
              buildFeishuButtonElement({
                text:
                  selection.cancelLabel ??
                  formatBotMessage(message.locale, "selectionCancelOption"),
                type: "default",
                command:
                  customExpanded && currentQuestion.options.length > 0
                    ? buildFeishuElicitationOptionCommand(
                        message,
                        FEISHU_ELICITATION_CUSTOM_OPTION_ID,
                      )
                    : "/cancel",
                originalText: message.text,
              }),
            ]),
      );
    }
  // 取消后仍保留卡片并追加提示文本：直接删卡会让用户失去上下文，
  // 也无法确认操作是否生效。
  } else if (elicitation.status === "cancelled") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(
        formatBotMessage(message.locale, "elicitationCancelledCard"),
      ),
    });
  }
  // 统一输出 schema 2.0 + wide_screen_mode：旧版 1.0 卡片不支持 behaviors
  // 与 form 组件，混用会被服务端 400 拒绝。
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// 域名只有两档：lark 走 larksuite.com，其余按飞书。未知 provider 退回
// feishu 而不是抛错，保证历史配置仍可发消息。
function getFeishuDomainProvider(bot: Pick<BotConfig, "provider">): "feishu" | "lark" {
  return bot.provider === "lark" ? "lark" : "feishu";
}

// 取事件里记录的渠道，优先于 bot.provider：同一应用可能同时绑定两个域名，
// 按事件来源建 URL 才能命中正确集群。
function readFeishuPayloadProvider(payload: Record<string, unknown>): BotProvider {
  return readString(payload, "zcodeProvider") === "lark" ? "lark" : "feishu";
}

// 所有 API 前缀都走这里推导，避免某处硬编码 open.feishu.cn 导致
// lark 租户 404。
function getFeishuBaseUrl(bot: Pick<BotConfig, "provider">): string {
  return getFeishuDomainProvider(bot) === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

// 宽松取字符串：undefined/null/数字一律返回空串。调用方普遍用 || 串联
// 多个候选字段，空串语义比 undefined 省判断。
function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

// 回调事件的两种封装：HTTP 回调是 {event:{...}}，长连接可能直接给事件体。
// 统一在这里剥一层，下游按同一形状解析（与 725 行的摊平修复同源）。
function readFeishuCallbackEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const event = isRecord(payload.event) ? payload.event : null;
  return event ?? payload;
}

// chat_type 历史上有 group / group_chat 两种写法，这里只做归并；
// topic_group 的拒收在 readFeishuTextMessage 单独处理。
function readFeishuChatType(value: string): "private" | "group" {
  return value === "group" || value === "group_chat" ? "group" : "private";
}

// message.content 是 JSON 字符串，解析失败返回 null 而不抛错：
// 一条畸形消息不能让整批事件处理失败（fail-open，诊断由上层负责）。
function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 去掉 <at ...>...</at> 与裸 @xxx：保证 text 是用户输入而不是带 mention
// 标记的协议文本。
// [权衡] @\S+ 会连带删掉邮箱等文本，但比把 @机器人 留在正文交给模型更安全
// （模型会把 mention 当指令执行）。
function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/giu, "")
    .replace(/@\S+/gu, "")
    .trim();
}

// 富文本多语言结构有三种历史形态：content 直挂、content.zh_cn、content.post.zh_cn。
// 优先 content.content（已按请求语言返回），其次中文，再英文；顺序固定，
// 否则同一消息在不同语言环境下解析出不同正文。
function readFeishuPostLocaleContent(content: Record<string, unknown>): unknown {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return content.content ?? zhCn?.content ?? enUs?.content;
}

// 标题与正文分开读取：post 的 title 在同级而不在 content 数组里，
// 且同样有 zh_cn/en_us 两套，必须与正文同源取值。
function readFeishuPostLocaleTitle(content: Record<string, unknown>): string {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return readString(content, "title") || readString(zhCn, "title") || readString(enUs, "title");
}

// 富文本 token → 纯文本递归：字符串原样、数组按序拼接、对象按 tag 分派。
// 这是把 post 还原成「人读到什么就得到什么」的唯一入口。
function formatFeishuPostToken(token: unknown, botOpenId?: string, mentions?: unknown): string {
  if (typeof token === "string") {
    return token;
  }
  // 数组分支必须 filter(Boolean)：空 at/图片 token 会留下空串，
  // 直接 join 会在正文里插入不可见空段，影响后续命令切分。
  if (Array.isArray(token)) {
    return token
      .map((item) => formatFeishuPostToken(item, botOpenId, mentions))
      .filter(Boolean)
      .join("");
  }
  if (!isRecord(token)) {
    return "";
  }
  const tag = readString(token, "tag");
  // at token：只有已知 botOpenId 时才尝试还原成 mention key；未知身份
  // 返回空串，避免把别人的 open_id 拼进正文（INV-01）。
  if (tag === "at") {
    if (!botOpenId) return "";
    // 群富文本中的自身 @ 也须进入有序 mention，不能在转文本时提前丢掉。
    const id = readString(token, "user_id");
    // 在 message.mentions 里按 open_id 反查 key：key 由飞书分配，同一用户
    // 在不同消息里不同，不能自行拼造。
    const mention = (Array.isArray(mentions) ? mentions : []).find(
      (item) => isRecord(item) && isRecord(item.id) && item.id.open_id === id,
    );
    if (isRecord(mention) && typeof mention.key === "string") return mention.key;
    // @_ 开头的是已废弃内部占位符，原样保留；其余拼成 @user_name，
    // 保证转文本后仍能看出 @ 了谁。
    return id.startsWith("@_") ? id : `@${readString(token, "user_name") || id}`;
  }
  // content / children / elements 是不同版本富文本的子节点字段，三者都试：
  // 新版 SDK 改字段名时不会导致图片/文本整段丢失。
  const nested = token.content ?? token.children ?? token.elements;
  const nestedText = Array.isArray(nested)
    ? formatFeishuPostToken(nested, botOpenId, mentions)
    : "";
  const text =
    readString(token, "text") ||
    readString(token, "un_escape_text") ||
    readString(token, "name") ||
    nestedText;
  // 链接 token：文本与 href 不同时把 href 附在文本后；飞书 markdown 不渲染
  // 裸链接，丢掉 href 会让用户看不到真实地址。
  if (tag === "a") {
    const href = readString(token, "href");
    if (href && href !== text) {
      return text ? `${text} ${href}` : href;
    }
  }
  return text;
}

// post 正文输出「标题 + 换行 + 各行内容」，行内 token 递归格式化；
// 空行被过滤，避免富文本分隔空行变成大量换行。
function readFeishuPostText(
  content: Record<string, unknown> | null,
  botOpenId?: string,
  mentions?: unknown,
): string {
  if (!content) {
    return "";
  }
  const postContent = readFeishuPostLocaleContent(content);
  const lines = Array.isArray(postContent)
    ? postContent
        .map((line) => formatFeishuPostToken(line, botOpenId, mentions).trim())
        .filter(Boolean)
    : [];
  // 标题正文都为空时返回空串，由上层按「无文本」处理；返回标题兜底而不是
  // null，是为了让调用方的 || 链继续工作。
  const title = readFeishuPostLocaleTitle(content).trim();
  const body = lines.join("\n").trim();
  if (title && body) {
    return `${title}\n${body}`;
  }
  return body || title;
}

// msgType → 统一附件类型：media/video 归 video，audio 单独一类，
// 其余（file 及未知类型）落 file。未知类型必须落 file 而不是丢弃，
// 否则新消息类型会静默丢附件。
function inferFeishuAttachmentKind(msgType: string): BotInboundAttachment["kind"] {
  if (msgType === "image") return "image";
  if (msgType === "audio") return "audio";
  if (msgType === "media" || msgType === "video") return "video";
  return "file";
}

// 缺省 MIME 只用于展示/落盘提示，不能用于解码判断；
// 真实 MIME 以 content.mime_type 为准。
function defaultFeishuMimeType(kind: BotInboundAttachment["kind"]): string {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

// 从 content 提取附件描述（不下载）：按 image_key/file_key/media_key/
// audio_key/key 的固定优先级取第一个非空值作为 providerFileId。
// 返回 null 表示「这条不是附件消息」，调用方不得据此伪造附件（INV-03）。
function readFeishuAttachment(
  msgType: string,
  content: Record<string, unknown> | null,
): BotInboundAttachment | null {
  if (!content) {
    return null;
  }
  const providerFileId =
    readString(content, "image_key") ||
    readString(content, "file_key") ||
    readString(content, "media_key") ||
    readString(content, "audio_key") ||
    readString(content, "key");
  // 没有任何 key 说明 content 只是文本/卡片结构，此时放弃而不是拿
  // message_id 当文件 id：伪造 id 只会让下载阶段 404 并误导排查。
  if (!providerFileId) {
    return null;
  }
  const kind = inferFeishuAttachmentKind(msgType);
  // [失败路径] filename 直接取远端 content.file_name，本层不净化：
  // 该值只在 BotInboundAttachment 中流转，落盘前必须由下载侧净化（INV-09），
  // 否则 ../ 可以穿越到工作目录之外。
  const filename =
    readString(content, "file_name") ||
    readString(content, "filename") ||
    `${msgType}-${providerFileId.slice(0, 8)}`;
  // mime_type / mimeType 两种写法都兼容（HTTP 回调与 SDK 事件不同）；
  // 仍缺失时用 kind 的缺省值，保证字段永不为 undefined。
  const mimeType =
    readString(content, "mime_type") ||
    readString(content, "mimeType") ||
    defaultFeishuMimeType(kind);
  // id 与 providerFileId 同值：id 是统一模型字段，providerFileId 是下载时
  // 直接拼进 open-apis/im/v1 的参数；分离便于其他渠道复用 id 语义。
  return {
    id: providerFileId,
    kind,
    filename,
    mimeType,
    // sizeBytes 只在远端显式给出数字时才带：用 0 兜底会让下载侧的大小校验
    // 误判为「空文件」。
    ...(typeof content.size === "number" ? { sizeBytes: content.size } : {}),
    providerFileId,
  };
}

// 消息事件 → BotInboundMessage。这是本文件最长的主链，顺序固定：
// 1) 定位 event/message/sender（兼容摊平后的 payload）
// 2) 过滤机器人控制卡（避免两个 bot 互相触发）
// 3) 收集附件（普通 / 被引用 / 引用内联图 / post 内联图）
// 4) 计算 rawText（interactive → post → text_without_at_bot → text）
// 5) 群聊语义（mention 校验、open_id 必填、话题归属）
// 6) 组装 actor / chatId / threadId / providerMessageId
// 任一步不成立即返回 null（静默丢弃），因为这里无法向 provider 回执错误。
// 维护 INV-01（不提权）、INV-03（去重键）、INV-04（附件完整性）。
function readFeishuTextMessage(
  botId: string,
  payload: Record<string, unknown>,
): BotInboundMessage | null {
  // provider 取自 payload.zcodeProvider 而非 bot.provider：长连接事件由
  // channel 侧注入，能反映事件真实来源域名。
  const provider = readFeishuPayloadProvider(payload);
  // Bugfix: 飞书 node-sdk 的 WebSocket EventDispatcher 在不同事件/版本下可能把 event 字段摊平到顶层。
  // 之前只读 payload.event.message，长连接确实收到消息时也会解析成 0 条 inbound。
  // 721 行已记录：只读 payload.event.message 会把有效消息解析成 0 条。
  // event 缺失时退回 payload 本身，是兼容摊平，不改变字段优先级。
  const event = isRecord(payload.event) ? payload.event : payload;
  // message/sender 都可能 undefined：下游统一用 readString 与 isRecord 保护，
  // 而不是到处散布可选链，保证缺失字段一致退化为空串。
  const message = isRecord(event?.message) ? event.message : null;
  const sender = isRecord(event?.sender) ? event.sender : null;
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : null;
  // zcodeNativeCardContent 是服务层已解析好的卡片正文，优先于对
  // message.content 再解析一次：避免同一份 JSON 解析两遍且口径不同。
  const content = isRecord(payload.zcodeNativeCardContent)
    ? payload.zcodeNativeCardContent
    : parseJsonRecord(message?.content);
  // message_type 与 msg_type 并存（HTTP 回调用前者，SDK 事件用后者）；
  // 两个都读，缺失为空串，后续按「未知类型」处理。
  const msgType = readString(message, "message_type") || readString(message, "msg_type");
  // 交互卡及其机器人确认回复属于控制流程，过去提取卡片文字会误触发另一机器人。
  // 控制卡过滤：机器人发出的 interactive 消息若是群控卡片（如「已加入」提示），
  // 不能再当用户指令，否则两个 bot 会互相对话形成回环。
  if (
    payload.zcodeIgnoreInteractionMessage === true ||
    (isFeishuBotSender(readString(sender, "sender_type")) &&
      msgType === "interactive" &&
      isGroupControlCard(content))
  )
    return null;
  // 普通附件只取一个：飞书单条消息最多带一个 file/image key，
  // 多附件场景由引用附件与 post 内联图补齐。
  const attachment = readFeishuAttachment(msgType, content);
  const attachments: BotInboundAttachment[] = attachment ? [attachment] : [];
  // 引用附件：providerMetadata.resourceMessageId 是下载时定位原消息的必要
  // 参数，缺失就无法取得资源，因此整条丢弃而不是降级成普通附件。
  if (isRecord(payload.zcodeReferencedAttachment)) {
    const ref = payload.zcodeReferencedAttachment;
    if (
      (ref.kind === "image" || ref.kind === "file") &&
      typeof ref.providerFileId === "string" &&
      typeof ref.filename === "string" &&
      typeof ref.mimeType === "string"
    ) {
      // 元数据只保留 resourceMessageId：其他字段来自远端，透传会把不可信结构
      // 带进下载层。
      const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : null;
      const resourceMessageId = readString(metadata, "resourceMessageId");
      if (resourceMessageId)
        attachments.push({
          id: ref.providerFileId,
          kind: ref.kind,
          providerFileId: ref.providerFileId,
          filename: ref.filename,
          mimeType: ref.mimeType,
          providerMetadata: { resourceMessageId },
        });
    }
  }
  // 引用内联图：imageKey 与 messageId 都是下载必需，缺一不可；复用
  // readFeishuAttachment 保证与普通附件字段口径一致。
  if (Array.isArray(payload.zcodeReferencedInlineImages)) {
    for (const image of payload.zcodeReferencedInlineImages) {
      if (
        isRecord(image) &&
        typeof image.imageKey === "string" &&
        typeof image.messageId === "string"
      ) {
        const item = readFeishuAttachment("image", { image_key: image.imageKey });
        if (item)
          attachments.push({ ...item, providerMetadata: { resourceMessageId: image.messageId } });
      }
    }
  }
  // malformedInlineImage 表示「必须整条放弃」：post 里有图片 token 但取不到
  // image_key 时，只执行正文会让用户以为图片已成功上传。
  let malformedInlineImage = false;
  // post 内联图递归收集：图片可能嵌在 content/children/elements 任意层级，
  // 与 formatFeishuPostToken 用同一组字段名，保证「能渲染的就能下载」。
  if (msgType === "post" && content) {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (!isRecord(node)) return;
      if (node.tag === "img") {
        const image = readFeishuAttachment("image", node);
        if (image) attachments.push(image);
        else malformedInlineImage = true;
      }
      // 递归只沿 content/children/elements 走，不遍历任意对象：
      // 任意遍历会把按钮 value 里的 image_key 误当内联图。
      visit(node.content ?? node.children ?? node.elements);
    };
    visit(readFeishuPostLocaleContent(content));
  }
  // [失败路径] 图片缺失直接 return null 而不是降级为纯文本：
  // 群聊里「只有图片」的消息会变成空文本并触发一轮无意义对话（INV-04）。
  // 缺少图片引用不能静默降级成只执行正文。
  if (malformedInlineImage) return null;
  // Bugfix: 飞书客户端里看起来像普通文字的富文本/带链接消息会以 message_type=post 推送。
  // 之前只读 content.text，post 消息被解析成空文本并直接丢弃，所以用户侧表现为“发了普通消息但 app 没反应”。
  // rawText 候选顺序即语义优先级：interactive 卡片会话文本（含问答上下文）
  // → content.text → post 富文本 → 事件层 text_without_at_bot → text。
  // 顺序一旦调换，同一消息得到不同正文，命令解析结果随之改变。
  const rawText =
    (msgType === "interactive" ? readGroupConversationCardText(content, message?.mentions) : "") ||
    readString(content, "text") ||
    readFeishuPostText(
      content,
      readString(payload, "zcodeBotOpenId") || undefined,
      message?.mentions,
    ) ||
    // text_without_at_bot 是飞书已去掉 @bot 的版本，优先于 text：
    // 省掉一次 mention 剥离；群聊仍以 readGroupMessage 的结果为准。
    readString(event, "text_without_at_bot") ||
    readString(event, "text");
  // topic_group 整体拒收：话题群的消息归属由服务层用话题历史重建，
  // adapter 在这里解析只能拿到不完整的 thread 上下文。
  const incomingChatType = readString(message, "chat_type") || readString(event, "chat_type");
  if (incomingChatType === "topic_group") return null;
  // 群聊走 readGroupMessage 做 mention/命令切分；私聊保持 undefined，
  // 后续用 stripFeishuMentions。分两条路径是因为群聊需要 mentionedBot
  // 与 commandText，私聊没有这些概念。
  const groupMessage =
    incomingChatType === "group"
      ? readGroupMessage(
          rawText,
          message?.mentions,
          readString(payload, "zcodeBotOpenId"),
          readString(sender, "sender_type"),
          readString(senderId, "open_id"),
        )
      : undefined;
  // 机器人发送者只在「原生 @ 了本 bot」或「话题内回复」时放行：否则
  // @all / 普通发言都会触发另一个 bot，形成自动对话回环。
  // Provider 验证发送者与 mention 身份；机器人群主聊天必须原生 @，群/话题启用状态由服务校验。
  if (
    isFeishuBotSender(readString(sender, "sender_type")) &&
    (incomingChatType !== "group" ||
      (!readString(message, "thread_id") && !groupMessage?.mentionedBot))
  )
    return null;
  // 群聊二次校验：必须能从 readGroupMessage 得到结构且已 @ 本 bot，
  // 或消息位于话题内（话题本身就是对 bot 的持续追问）。
  if (
    incomingChatType === "group" &&
    (!groupMessage || (!groupMessage.mentionedBot && !readString(message, "thread_id")))
  )
    return null;
  // 群聊正文用结构化解析结果，私聊用去 mention 的纯文本；
  // groupMessage.text 已去掉命令前缀，可直接交给服务层。
  const text = groupMessage?.text ?? stripFeishuMentions(rawText);
  // 群权限只认 open_id：user_id/union_id 属于其他命名空间，拿它们匹配
  // 绑定身份会把不同租户的同名用户混为一谈（INV-01）。
  // 群权限只使用应用内 open_id，不能把其他 ID 命名空间误当作绑定身份。
  if (incomingChatType === "group" && !readString(senderId, "open_id")) return null;
  // userId 兜底顺序：sender_id.open_id → user_id → union_id → 事件顶层同名字段。
  // open_id 最稳定；union_id 跨应用可用但无法直接对应绑定身份。
  const userId =
    readString(senderId, "open_id") ||
    readString(senderId, "user_id") ||
    readString(senderId, "union_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(event, "union_id");
  // chatId 在私聊也存在（oc_ 开头），但只在群聊写入 actor.chatId：
  // 服务层若用 chatId 存在判断群聊，会把私聊卡片误判（见 960 行修复）。
  const chatId = readString(message, "chat_id") || readString(event, "open_chat_id");
  // message_id 是去重键（INV-03）：缺失时保留空串，最终 providerMessageId
  // 为 undefined，上层必须 fail-open 而不是自己造 id。
  const messageId = readString(message, "message_id");
  // incomingChatType 为 group 时允许空正文，仅 @ 即唤起，引用与话题由服务层补全；
  // 私聊必须有正文或附件，否则是一条无法处理的消息。
  // 群内仅 @ 仍是有效唤起，空需求由服务结合引用/话题背景处理。
  if ((!text && attachments.length === 0 && incomingChatType !== "group") || !userId) {
    return null;
  }
  // 再次归并 chat_type：这里用 message.chat_type 而不是 incomingChatType，
  // 两者都缺失时为 private。
  const chatType = readFeishuChatType(
    readString(message, "chat_type") || readString(event, "chat_type"),
  );
  return {
    botId,
    text,
    // groupMessage 存在即群聊：这些字段只对群聊有意义，
    // 私聊输出它们会让服务层误走群权限分支。
    ...(groupMessage
      ? {
          // 机器人发送的群消息标记 senderType=app：服务层不必重复判断发送者类型，
          // 也用于抑制自触发。
          ...(isFeishuBotSender(readString(sender, "sender_type"))
            ? { senderType: "app" as const }
            : {}),
          // botOpenId 由 channel 注入，用于 mention 反查；缺失时
          // readFeishuPostText 会丢掉 at token（见 621 行）。
          botOpenId: readString(payload, "zcodeBotOpenId") || undefined,
          mentionedBot: groupMessage.mentionedBot,
          commandText: groupMessage.commandText,
          // contentParts 的 channelMention 要补渠道与 refId：refId 拼上 messageId
          // 才能跨消息唯一，否则不同消息里的同一图片会共享 refId 被去重掉。
          ...(groupMessage.contentParts
            ? {
                contentParts: groupMessage.contentParts.map((part) =>
                  part.type === "text"
                    ? part
                    : {
                        ...part,
                        channel: provider === "lark" ? ("lark" as const) : ("feishu" as const),
                        refId: `${messageId}:${part.refId}`,
                      },
                ),
              }
            : {}),
          // 话题根消息是否由本 bot 创建：只做透传，服务层据此决定是否补上下文；
          // 不能用它推断权限。
          topicRootIsCurrentBot: payload.zcodeTopicRootIsCurrentBot === true,
        }
      : {}),
    // 引用消息整体透传但只保留 messageId/text：引用内容同样是远端输入，
    // 其余字段不进入统一模型。
    ...(isRecord(payload.zcodeReferencedMessage) &&
    typeof payload.zcodeReferencedMessage.messageId === "string" &&
    typeof payload.zcodeReferencedMessage.text === "string"
      ? {
          referencedMessage: {
            ...payload.zcodeReferencedMessage,
            messageId: payload.zcodeReferencedMessage.messageId,
            text: payload.zcodeReferencedMessage.text,
          },
        }
      : {}),
    // attachments 为空时完全省略该字段：服务层用 attachments?.length 判断，
    // 空数组与 undefined 会走不同文案分支。
    ...(attachments.length ? { attachments } : {}),
    // actor 是权限判定的唯一输入：provider/botId/providerUserId/chatType 全部
    // 来自本函数解析，服务层不得再从 text 二次推断（INV-01）。
    actor: {
      provider,
      botId,
      providerUserId: userId,
      // displayName 只用于展示：它来自事件字段，不可作为身份依据。
      displayName: readString(sender, "sender_name") || undefined,
      chatType,
      // 私聊不写 chatId，保留「chatId 存在 = 群聊」的隐式约定，
      // 避免下游把单聊当群校验成员关系。
      chatId: chatType === "group" && chatId ? chatId : undefined,
      // threadId/rootMessageId 只在话题回复时写入；rootMessageId 缺失时退回当前
      // messageId，保证回复锚点永远存在（见 resolveFeishuReplyTarget）。
      ...(chatType === "group" && readString(message, "thread_id")
        ? {
            threadId: readString(message, "thread_id"),
            rootMessageId: readString(message, "root_id") || messageId,
          }
        : {}),
      // providerMessageId 缺失即 undefined 而非空串：上层据此判断「无法去重」，
      // 必须 fail-open 且留诊断（INV-03）。
      providerMessageId: messageId || undefined,
    },
  };
}

// 卡片按钮回调 → BotInboundMessage。命令来源三处，按优先级：
// action.value.command/text → behaviors[].value.command/text；表单提交时
// rawCommand 只含哨兵前缀，真实答案从 form_value.answer 注入。
// 这里只把 value 当路由文本，不据此判权限（INV-11）。
function readFeishuCardAction(
  botId: string,
  payload: Record<string, unknown>,
): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  // form_value 与 behaviors 都可能缺失：新版按钮用 behaviors.callback，
  // 旧版把值放 action.value，两条都兼容。
  const formValue = isRecord(action?.form_value) ? action.form_value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  // rawCommand 允许从 text 读：部分卡片模板用 text 承载命令，
  // 属于历史兼容，不引入新语义。
  const rawCommand =
    readString(value, "command") ||
    readString(value, "text") ||
    readString(behaviorValue, "command") ||
    readString(behaviorValue, "text");
  // 表单提交：按钮只带 /elicitation <token> __form__:，这里取 token 片段
  // 并用 form_value.answer 重拼完整命令。若直接执行 rawCommand，答案会丢失，
  // 服务端只会看到空回答。
  const submittedAnswer = formValue?.[FEISHU_ELICITATION_FORM_FIELD_NAME];
  // [失败路径] token 片段缺失时回退空串，命令变成 /elicitation  <answer>，
  // 由服务端按非法命令拒绝；比在这里抛错安全，因为卡片回调必须回执。
  const command =
    rawCommand && rawCommand.includes(FEISHU_ELICITATION_FORM_VALUE_PREFIX)
      ? buildFeishuElicitationFormCommand(rawCommand.split(/\s+/u)[1] ?? "", submittedAnswer)
      : rawCommand;
  // openId 兜底链覆盖 HTTP 回调（operator）与长连接（event 顶层）两种形状；
  // 拿不到 openId 就无法归属操作者，回调只能丢弃。
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(payload, "open_id") ||
    readString(payload, "user_id");
  // context 只用于取 chat_type / chat_id / open_message_id，不作为权限依据：
  // 这些值同样来自回调 payload。
  const context = isRecord(event.context) ? event.context : null;
  const contextChatType =
    readString(context, "chat_type") ||
    readString(event, "chat_type") ||
    readString(payload, "chat_type");
  const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
  // message 与 header 只在「事件体里嵌了消息对象」的旧格式出现，
  // 只参与 providerMessageId 兜底，不参与正文解析。
  const message = isRecord(event.message) ? event.message : null;
  const header = isRecord(payload.header) ? payload.header : null;
  // providerMessageId 兜底把 event_id 放最前：卡片回调不一定带 message_id，
  // 而 event_id 全局唯一，可安全用于去重（INV-03）；action.value_id 对同一
  // 按钮可能重复，因此放最后。
  const providerMessageId =
    readString(event, "event_id") ||
    readString(header, "event_id") ||
    readString(payload, "uuid") ||
    readString(payload, "event_id") ||
    readString(context, "open_message_id") ||
    readString(context, "message_id") ||
    readString(message, "message_id") ||
    readString(action, "value_id");
  // 缺命令或缺操作者直接丢弃：没有 openId 无法做归属校验，
  // 没有 command 则没有任何可执行动作。
  if (!command || !openId) {
    return null;
  }
  // Bugfix: 飞书卡片回调的 context.open_chat_id 在私聊按钮里也可能存在。
  // 之前用 chatId 是否存在判断群聊，会把私聊里的卡片按钮误拒成“只支持私聊”。
  // chatType 优先取 channel 注入的 zcodeChatType，其次 context.chat_type：
  // 上下文值在私聊卡片上也可能缺失，注入值才是权威口径。
  const chatType = readFeishuChatType(readString(payload, "zcodeChatType") || contextChatType);
  // groupCard 用 shared schema 校验：按钮 value 完全由客户端回传，
  // 未经校验的 threadId 会被当成可信话题锚点（INV-11）。
  const groupCard = botGroupCardSchema.safeParse(value?.groupCard ?? behaviorValue?.groupCard);
  return {
    botId,
    // 只有群聊才标记 groupCardAction：私聊卡片带 groupCard 时按普通命令处理，
    // 避免私聊获得群卡片专属的会话状态。
    ...(chatType === "group"
      ? { groupCardAction: true, ...(groupCard.success ? { groupCard: groupCard.data } : {}) }
      : {}),
    text: command,
    // text 直接放命令：服务层解析时再做权限与归属校验，
    // adapter 不重复实现命令语法。
    actor: {
      provider,
      botId,
      providerUserId: openId,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      // 话题路由只信任通过 schema 的 groupCard.threadId；未通过时不写 threadId，
      // 回复会落在当前会话而不是任意话题。
      ...(chatType === "group" && groupCard.success && groupCard.data.threadId
        ? { threadId: groupCard.data.threadId }
        : {}),
      ...(providerMessageId ? { providerMessageId } : {}),
    },
  };
}

// 更新 token 用于 card/update 同步刷新原卡片。Card JSON 2.0 的
// behaviors.callback 触发时 token 位置不固定（event/context/action 都有），
// 因此按 event → payload → action → context 顺序逐个尝试。
function readFeishuCardUpdateToken(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const context = isRecord(event.context) ? event.context : null;
  // Bugfix: Card JSON 2.0 回调的更新 token 不总在旧版 action.token 上。
  // 新版按钮由 behaviors.callback 触发时，飞书/Lark 可能把 token 放在事件或 context 上；漏读会让 card/update 静默跳过，按钮留在原卡片里。
  // 漏读 token 的后果是刷新被静默跳过、按钮留在原卡里，用户会重复点击；
  // 因此服务层必须幂等（见 seg2 2821 行注释）。
  return (
    readString(event, "token") ||
    readString(event, "card_update_token") ||
    readString(event, "update_token") ||
    readString(payload, "token") ||
    readString(payload, "card_update_token") ||
    readString(payload, "update_token") ||
    readString(action, "token") ||
    readString(action, "card_update_token") ||
    readString(action, "update_token") ||
    readString(context, "token") ||
    readString(context, "card_update_token") ||
    readString(context, "update_token")
  );
}

// 卡片更新的授权对象只返回 operator 的 open_id；回调没有 operator 时
// 返回空数组，调用方据此放弃刷新，而不是「谁都能改」。
function readFeishuCardUpdateOpenIds(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const event = readFeishuCallbackEvent(payload);
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(payload, "open_id");
  return openId ? [openId] : [];
}

// 卡片原始文本（zcodeCardText）用于「保留原问题文案、移除按钮」的收尾卡；
// 读不到时返回 null，由调用方决定退回默认文案。
function readFeishuCardOriginalText(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  return (
    readString(value, "zcodeCardText") ||
    readString(value, "cardText") ||
    readString(behaviorValue, "zcodeCardText") ||
    readString(behaviorValue, "cardText") ||
    null
  );
}

// 把业务层 markdown 适配到 Card JSON 2.0 的渲染口径：
// 1) 标准 Markdown 会把单换行折成一行，非代码块内的单换行补两个空格；
// 2) 独立 --- 前补空行，否则会被当成上文的 setext 标题；
// 3) 代码围栏内一律不改写，避免破坏代码的换行语义。
// 纯函数，不改入参，卡片重复渲染时结果稳定。
function formatFeishuCardMarkdownContent(text: string): string {
  const lines: Array<{ text: string; hardBreak: boolean }> = [];
  // inCodeFence 用围栏出现次数的奇偶切换：飞书不支持嵌套围栏，
  // 因此不需要真正的 Markdown 解析器。
  let inCodeFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
    }
    // 只在非代码围栏内识别 ---：代码块里的 --- 是内容（如 YAML 分隔符），
    // 补空行会改变用户看到的代码。
    if (!inCodeFence && /^-{3,}$/.test(line.trim())) {
      // 前一行已有内容时先补空行：setext 标题判定只看「上一行非空」，
      // 少这一行会让 --- 变成 H2 下划线。
      if (lines.length > 0 && lines.at(-1)?.text !== "") {
        lines.push({ text: "", hardBreak: false });
      }
      lines.push({ text: "---", hardBreak: false }, { text: "", hardBreak: false });
      continue;
    }
    // hardBreak 标记「这是普通正文行」，只有普通行补尾部双空格；
    // 代码围栏内的行不能补，否则空格会被渲染进代码。
    lines.push({ text: line, hardBreak: !inCodeFence });
  }
  return lines
    .map((line, index) => {
      // 只在「本行非空、下一行非空、且非最后一行」时补 hard break：
      // 空行本身即段落分隔，末行补空格只会留下尾随空白。
      if (!line.text || !line.hardBreak || index >= lines.length - 1 || !lines[index + 1]?.text) {
        return line.text;
      }
      // Bugfix: Card JSON 2.0 的 markdown 按标准 Markdown 处理单换行，会把 /status 多行文本折成一行。
      // 飞书通道内把普通单换行转成 hard break，保留业务层给其他 bot 使用的原始文本。
      return `${line.text}  `;
    })
    .join("\n");
}

// 按钮元素统一构造：text/type 由调用方给，command 写入
// behaviors.callback.value。Card JSON 2.0 不支持 action/actions 容器，
// 按钮必须直接作为 body.elements 组件，否则飞书返回 400（见原注释）。
function buildFeishuButtonElement(params: {
  text: string;
  type: "default" | "primary";
  command: string;
  originalText: string;
}): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.text,
    },
    type: params.type,
    // Bugfix: Card JSON 2.0 不再支持旧版 action/actions 容器。
    // 按钮必须直接作为 body.elements 组件，并通过 behaviors.callback 回传业务值，否则飞书会返回 HTTP 400。
    // behaviors 是数组：2.0 允许一个按钮挂多个行为，这里只挂 callback，
    // 保持「点击即回传命令」的单一语义。
    behaviors: [
      {
        type: "callback",
        value: {
          // value 里的 command 与 zcodeCardText 都会被客户端原样回传，
          // 二者都不可信，只作路由与文案（INV-11）。
          command: params.command,
          zcodeCardText: params.originalText,
        },
      },
    ],
  };
}

// 通用交互卡构造：queue.cancel 用双列紧凑布局（正文 + 按钮并排），
// 其余选择卡用「正文 + 竖排按钮 + 取消」。两种布局共用同一按钮构造器，
// 保证回调 value 形状一致。
function buildFeishuInteractiveCardPayloadBody(
  message: BotOutboundMessage,
): Record<string, unknown> {
  const selection = message.selection;
  // queue.cancel 是高频操作（任务列表里逐个取消），双列布局把卡片高度
  // 压到一行，避免聊天流被大量操作卡刷屏。
  if (selection?.action === "queue.cancel") {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: {
        padding: "8px 12px 8px 12px",
        elements: [
          {
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "8px",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [
                  // 左列 weighted=1 自适应，右列 auto 只占按钮宽度；两列都 weighted 会把
                  // 按钮拉满整行，失去紧凑意义。
                  { tag: "markdown", content: formatFeishuCardMarkdownContent(message.text) },
                ],
              },
              {
                tag: "column",
                width: "auto",
                vertical_align: "center",
                // 每个 option 一个按钮；option.id 作命令参数，label 只用于展示，
                // 二者不能互换（label 会本地化）。
                elements: selection.options.map((option) =>
                  buildFeishuButtonElement({
                    text: option.label,
                    type: "default",
                    command: formatSelectionCommand(selection, option.id),
                    originalText: message.text,
                  }),
                ),
              },
            ],
          },
        ],
      },
    };
  }
  // 普通选择卡：正文 markdown 固定为第一个元素。飞书要求 elements 非空，
  // 即使正文为空也保留一个空 markdown 占位。
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(message.text),
    },
  ];
  // 有 selection 才渲染选项与取消；无 selection 的 interactive 消息只是
  // 富文本，不应出现任何按钮。
  if (selection) {
    elements.push(
      ...selection.options.map((option, index) =>
        buildFeishuButtonElement({
          // label 为空时退回序号：空按钮在飞书里不可点击，序号至少可辨识。
          text: option.label || String(index + 1),
          type: "primary",
          command: formatSelectionCommand(selection, option.id),
          originalText: message.text,
        }),
      ),
      // showCancel === false 时完全不渲染取消按钮；严格比较避免 undefined
      // 被当成「不要取消」。
      ...(selection.showCancel === false
        ? []
        : [
            buildFeishuButtonElement({
              text:
                selection.cancelLabel ?? formatBotMessage(message.locale, "selectionCancelOption"),
              type: "default",
              // 取消命令固定 /cancel：飞书是结构化选项卡，不复用微信纯文本菜单的
              // 「0 表示取消」语义（见原注释）。
              // Bugfix: 飞书走结构化选项卡，不应复用微信纯文本菜单的 0 取消语义。
              command: "/cancel",
              originalText: message.text,
            }),
          ]),
    );
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// 状态行文案：locale 必须由 BotService 传入（state.locale），不能用进程
// 默认语言，否则中文环境会固定显示 Running/Completed。
function formatFeishuStreamingStatus(state: BotStreamingReplyCardState): string {
  // Bugfix: 流式卡片状态行由 provider 生成，必须读取 BotService 传入的 locale，
  // 否则中文环境里会固定显示 Running/Completed。
  const locale = state.locale;
  const status = state.status;
  // 只对外暴露三种状态：completed / error / 其余按运行中处理；
  // sealed 是内部分片状态，不单独展示。
  if (status === "completed") {
    return formatBotMessage(locale, "streamingStatusCompleted");
  }
  if (status === "error") {
    return formatBotMessage(locale, "streamingStatusFailed");
  }
  return formatBotMessage(locale, "streamingStatusRunning");
}

// 工具摘要折叠面板：运行中展开、终态收起（expanded 由调用方按
// block.expanded ?? status 决定）。摘要为空时返回 null，
// 调用方据此跳过该 block，不产生空面板占位。
function buildFeishuStreamingToolPanel(
  toolSummaries: readonly string[],
  options: { expanded: boolean; title: string },
): Record<string, unknown> | null {
  // 逐条 trim 并过滤空串：工具摘要可能含模型输出的空行，
  // 原样拼进 markdown 会在面板里留下大段空白。
  const summaries = toolSummaries
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0);
  if (summaries.length === 0) {
    return null;
  }
  return {
    tag: "collapsible_panel",
    // Bugfix: 流式卡片运行中需要让用户看到当前工具摘要；任务终态后再自动收起，减少最终消息占用空间。
    expanded: options.expanded,
    // Bugfix: Tool summaries 之前只是裸 collapsible panel，和正文没有清晰视觉边界。
    // 飞书 Card JSON 2.0 的折叠面板本身支持背景与边框，这里把它作为 <tools> 容器承载 header/content。
    background_color: "grey-50",
    // 背景与边框用于让面板与正文有视觉边界；纯样式字段，不参与元素预算
    // 统计（countTaggedElements 只数带 tag 的节点）。
    border: {
      color: "grey",
      corner_radius: "8px",
    },
    padding: "8px 8px 8px 8px",
    // 标题带数量 (n)：面板收起后仍能看出调用了多少工具，
    // 这是收起态唯一可见的信息。
    header: {
      title: {
        tag: "plain_text",
        content: `🛠️ ${options.title} (${summaries.length})`,
      },
      vertical_align: "center",
      padding: "8px 8px 8px 8px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    // 面板内容用 markdown 而非纯文本：摘要里可能带代码/链接，
    // 纯文本会丢失格式。
    elements: [
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(summaries.join("\n")),
      },
    ],
  };
}

// 流式卡主体：message block 渲染 markdown，tool block 渲染折叠面板，
// 最后按需追加状态行。elements 为空时必须补一个空格 markdown，
// 因为飞书拒绝空 elements 数组。
function buildFeishuStreamingCardPayload(
  state: BotStreamingReplyCardState,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  // block 顺序即渲染顺序，不做重排：工具面板通常夹在正文中间，
  // 重排会让用户看到与流式输出不一致的顺序。
  for (const block of state.blocks) {
    if (block.type === "message") {
      // 正文 block 为空时不产生元素：连续 delta 可能产生空文本块，
      // 每个空块都渲染会撑爆元素预算（INV-06）。
      const text = block.text.trim();
      if (text) {
        elements.push({
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(text),
        });
      }
      continue;
    }
    // expanded 缺省跟随 status：运行中展开、终态自动收起，
    // 这是 1204 行注释里「终态收起」策略的落点。
    const toolPanel = buildFeishuStreamingToolPanel(block.summaries, {
      expanded: block.expanded ?? state.status === "running",
      title: block.title?.trim() || formatBotMessage(state.locale, "streamingToolSummaries"),
    });
    if (toolPanel) {
      elements.push(toolPanel);
    }
  }
  // 占位空格不是装饰：飞书对 elements: [] 返回 400，
  // 这里保证任何状态下卡片结构合法。
  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: " ",
    });
  }
  // sealed 分片不渲染状态行：否则每个分片都带「运行中」，用户会看到重复
  // 状态；状态行只属于最后一片。
  if (state.status !== "sealed") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(formatFeishuStreamingStatus(state)),
    });
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// 递归统计带 tag 的节点数，与飞书「组件/元素」计数口径对齐：
// 数组按元素累加，对象自身（若有 tag）计 1 再加子节点。
// 预算判断依赖该计数，但不保证与服务端完全一致，因此预算取 180 留余量。
function countTaggedElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTaggedElements(item), 0);
  }
  // 非对象/非数组返回 0：字符串与 null 都不是元素，
  // 计入会让预算被文本长度虚占。
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  // 用 Object.values 递归而非按 schema 遍历：卡片由多个 builder 组合，
  // 新增字段（header、columns 等）无需同步维护计数逻辑。
  return (
    (typeof record.tag === "string" ? 1 : 0) +
    Object.values(record).reduce<number>((total, item) => total + countTaggedElements(item), 0)
  );
}

// 对外暴露的预算查询：供 seg2 发送路径提交前预检，
// 避免超预算卡片被 11310 拒绝后整轮失败（INV-06）。
export function countFeishuCardTaggedElements(state: BotStreamingReplyCardState): number {
  return countTaggedElements(buildFeishuStreamingCardPayload(state));
}

// 按元素预算把流式状态切成多张卡片：逐 block 贪心累积，超出预算即开新片。
// 最后一片保留真实 status，其余标记 sealed；这样单片不超 180 元素，
// 整体语义仍是「一条回复」（INV-06）。
// blocks:[b1 b2 | b3 b4 | b5]
// status:  sealed   sealed  running/completed
export function splitFeishuStreamingCardStates(
  state: BotStreamingReplyCardState,
): BotStreamingReplyCardState[] {
  const blockGroups: BotStreamingReplyCardState["blocks"][] = [];
  let current: BotStreamingReplyCardState["blocks"] = [];
  for (const block of state.blocks) {
    // 候选片按 running 计数：始终为状态行预留预算，使 running → completed
    // 切换不会改变既有分段边界，避免卡片数量在终态时变化。
    const candidate = [...current, block];
    // 始终为状态行预留预算，使 running/completed 切换不会改变既有分段边界。
    const candidateState = { ...state, blocks: candidate, status: "running" as const };
    if (
      // current 为空时不切分：单个 block 自身超预算也只能放进一片，
      // 否则会产生空片并陷入无限切分。
      current.length > 0 &&
      countFeishuCardTaggedElements(candidateState) > FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET
    ) {
      blockGroups.push(current);
      current = [block];
    } else {
      current = candidate;
    }
  }
  // 循环结束把剩余 block 收尾；state.blocks 为空时这里产生一个空片，
  // 调用方仍按「一张空卡」处理，不会拿到空数组。
  blockGroups.push(current);
  return blockGroups.map((blocks, index) => ({
    ...state,
    blocks,
    // 只有最后一片继承原 status，其余置 sealed：sealed 片不再追加状态行，
    // 也提示更新逻辑这是历史分片（见 seg2 更新路径）。
    status: index === blockGroups.length - 1 ? state.status : "sealed",
  }));
}

// 纯文本按 1900 字符切分：飞书单条文本上限约 2000，留 100 字符余量。
// [权衡] 用 UTF-16 下标 slice 可能从代理对中间切断 emoji；改成按码点
// 切分与飞书的长度口径不一致，当前接受该风险。
export function splitFeishuText(text: string): string[] {
  const limit = 1900;
  const chunks: string[] = [];
  // 空串也返回 [""] 而非 []：调用方按「至少发一条」处理，
  // 返回空数组会让空白消息被静默吞掉。
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

// 获取 tenant_access_token。流程：校验配置 → 读凭据 → 查缓存 → HTTP 换取
// → 按 expire 写缓存。缓存 key 含域、appId、credentialRef（INV-08）；
// 命中要求剩余有效期 > 60s，把「即将过期」等同于过期。
// [并发] 未做 in-flight 去重：同一 appId 并发首次调用会同时发出多个换取
// 请求，结果互相覆盖（token 等价，无正确性问题，但会产生额外 QPS）。
// [失败路径] 任何失败都抛错而不是返回空串，由调用方决定降级（INV-10）。
async function readTenantAccessToken(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  signal?: AbortSignal,
): Promise<string | null> {
  // 缺 appId 或 credentialRef 说明该 bot 未配置飞书凭据，返回 null 表示
  // 「不可用」；与网络失败（抛错）区分，便于上层给出不同提示。
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  // 凭据只经 deps.loadCredential 读取，不落日志、不进缓存（INV-08）。
  const appSecret = await deps.loadCredential(bot.credentialRef);
  if (!appSecret) {
    return null;
  }
  // key 必须含 credentialRef：换绑同一 appId 的不同 secret 后，旧 token
  // 可能仍有效但权限不同，绝不能复用。
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId}:${bot.credentialRef}`;
  const cached = accessTokenCache.get(cacheKey);
  // 60s 提前量：网络往返与排队可能吃掉剩余有效期，
  // 卡在过期瞬间会让一次正常发送变成 401。
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  // requestedAt 在发请求前取：expire 是自签发时刻起的剩余秒数，
  // 用响应到达时刻计时会把网络耗时重复计入可用时间（见 1372-1373 原注释）。
  const requestedAt = Date.now();
  // 换取接口是 internal 版：只用于自建应用，secret 放 body 而非 header；
  // 该请求同样受 fetchBotProviderJson 的 15s 超时与外部 signal 约束。
  const response = await fetchBotProviderJson<FeishuAccessTokenResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: bot.feishuAppId,
        app_secret: appSecret,
      }),
      signal,
    },
  );
  // 非 2xx 直接抛错且不透出响应体：避免把带 app_secret 的回显写进日志（INV-08）。
  if (!response.ok) {
    throw new Error(`Feishu tenant_access_token failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  // code !== 0 视为业务失败；tenant_access_token 缺失同样失败——返回空 token
  // 会让下游所有请求 401，把错误位置推迟到更难排查的地方。
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || "Feishu tenant_access_token failed.");
  }
  // 飞书可能返回尚未过期的旧令牌；固定缓存 90 分钟会超过其真实剩余有效期。
  // 从请求开始计时，避免网络耗时被错误计入令牌的可用时间。
  // 只有 expire 是正数才写缓存；缺失/非法时删除旧条目，防止用一条
  // 「永不过期」的旧 token 顶替未知有效期的令牌。
  if (typeof payload.expire === "number" && Number.isFinite(payload.expire) && payload.expire > 0) {
    accessTokenCache.set(cacheKey, {
      token: payload.tenant_access_token,
      expiresAt: requestedAt + payload.expire * 1_000,
    });
  // 用 delete 而不是 set 远期过期时间：缓存语义只有「有效」和「不存在」，
  // 不留「已知无效但仍可读到」的中间态。
  } else {
    accessTokenCache.delete(cacheKey);
  }
  return payload.tenant_access_token;
}

// receive_id_type 由 id 前缀推导：oc_ 是 chat_id，其余按 open_id。
// 传错类型时飞书返回 400 而不是「找不到」，排障成本很高。
function resolveFeishuReceiveIdType(receiveId: string): "chat_id" | "open_id" {
  return receiveId.startsWith("oc_") ? "chat_id" : "open_id";
}

// 统一构造发送错误：把业务 code/msg/log_id/receive_id_type 拼进 message，
// 并挂三个结构化标记供上层决策：
// - deliveryRejected：可证明本次未投递成功（INV-02 的反向证据）；
// - deliveryReplyUnavailable：消息仍在发送中，结果未知；
// - retryAfterMs：可重试的限流类错误（INV-10，adapter 自己不重试）。
function createFeishuMessageError(
  operation: string,
  status: number,
  payload: FeishuSendMessageResponse | undefined,
  responseLogId?: string,
  receiveIdType?: string,
): Error {
  // details 只收集非空项：缺字段时不要让 message 出现 msg=undefined，
  // 那会掩盖真正的错误原因。
  const details = [
    typeof payload?.code === "number" ? `code=${payload.code}` : null,
    payload?.msg ? `msg=${payload.msg}` : null,
    payload?.error?.log_id || responseLogId
      ? `log_id=${payload?.error?.log_id ?? responseLogId}`
      : null,
    receiveIdType ? `receive_id_type=${receiveIdType}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  // 修复原因：飞书的 HTTP 400 会在响应体中携带业务错误码、原因和排查 log_id。
  // 旧实现先按 HTTP 状态抛错，导致这些已解析的信息永久丢失，无法区分权限、限流和卡片错误。
  // 用 Object.assign 挂标记而非自定义 Error 子类：跨包/跨进程传递时
  // instanceof 会失效，调用方只读这些布尔标记。
  return Object.assign(
    new Error(
      `Feishu ${operation} failed: HTTP ${status}${details.length > 0 ? `, ${details.join(", ")}` : ""}`,
    ),
    {
      // deliveryRejected 判定：有业务 code 且非 0，或 4xx（408 超时除外）。
      // 230049 表示「正在发送中」，既非成功也非确定失败，因此单独排除。
      // [权衡] 5xx 一律不置位：服务端可能已落库，乐观重试会重复发送（INV-02）。
      // 无业务回执的服务端错误，以及“正在发送”，都不能证明本次发送未发生。
      deliveryRejected:
        payload?.code !== 230049 &&
        ((typeof payload?.code === "number" && payload.code !== 0) ||
          (status >= 400 && status < 500 && status !== 408)),
      // 230011 表示消息已撤回、回复目标不存在：标记出来让上层改用新消息发送，
      // 而不是重试同一个 reply 目标。
      ...(payload?.code === 230011 ? { deliveryReplyUnavailable: true } : {}),
      // 限流类错误统一给 1s 退避：429 / 230020 / 99991400 都表示请求过频，
      // 具体窗口不公开，1s 是观测到的安全下界。
      ...(status === 429 || payload?.code === 230020 || payload?.code === 99991400
        ? { retryAfterMs: 1000 }
        : {}),
    },
  );
}

// 解析回复目标：优先显式 replyToMessageId，其次话题根消息。
// 话题回复必须有锚点，否则消息会落到群主聊天（见 1471 行注释记录的事故）。
function resolveFeishuReplyTarget(message: BotOutboundMessage) {
  const replyToMessageId =
    message.replyToMessageId || (message.threadId ? message.rootMessageId : undefined);
  // 原因：临时审批／问答卡曾跳过话题路由，直接发到群主聊天；统一解析并拒绝无锚点投递。
  // [失败路径] 抛错并标记 deliveryRejected：这是「确定没有投递」的场景，
  // 上层可安全重试；若静默降级成普通发送，消息会出现在错误的位置。
  if (message.threadId && !replyToMessageId)
    throw Object.assign(new Error("Topic reply target is unavailable"), {
      deliveryRejected: true,
    });
  return { replyToMessageId, replyInThread: Boolean(message.threadId) };
}

// 发送交互卡片：有 replyToMessageId 走 /messages/:id/reply，否则走
// /messages?receive_id_type=... 新建消息。返回 provider message_id；
// 带 uuid 或 reply 目标时缺失 message_id 视为结果未知（seg2 1474 行抛错，INV-02）。
// receive_id 只在新建消息时进 body；reply 时目标由 URL 决定，两者同时出现会被拒绝。
// [资源] signal 透传给底层 fetch，close 后不再有请求发出（INV-12）。
async function sendFeishuInteractiveCard(
  bot: BotConfig,
  token: string,
  receiveId: string,
  card: Record<string, unknown>,
  signal?: AbortSignal,
  delivery?: { replyToMessageId?: string; uuid?: string; replyInThread?: boolean },
): Promise<string | null> {
  // uuid 是飞书侧幂等键：同一 uuid 重复提交只产生一条消息，用于重试场景；
  // 新建消息时它不参与 URL 选择。
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    delivery?.replyToMessageId
      ? `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(delivery.replyToMessageId)}/reply`
      : `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages?receive_id_type=${resolveFeishuReceiveIdType(receiveId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(!delivery?.replyToMessageId ? { receive_id: receiveId } : {}),
        ...(delivery?.uuid ? { uuid: delivery.uuid } : {}),
        ...(delivery?.replyInThread ? { reply_in_thread: true } : {}),
        msg_type: "interactive",
        // 飞书要求 content 是「消息类型专属负载」的字符串：卡片对象必须先序列化再塞进字符串，
        // 直接传对象会被 230001 参数错误拒绝。
        content: JSON.stringify(card),
      }),
      // [资源] signal 透传给 fetch：上层取消/超时会中断在途请求，避免 close 之后仍挂着一个写请求（INV-12）。
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP 成功也可能携带业务拒绝，必须保留错误码和请求 ID。
  // HTTP 2xx 只说明网关受理；payload.code 才是业务结论，漏判会把 230xxx（机器人被移出群等）记成成功。
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "send interactive message",
      response.status,
      payload,
      response.responseLogId,
      // 仅用于诊断：同一个 receiveId 被当作 open_id 还是 chat_id 会得到不同错误码。
      resolveFeishuReceiveIdType(receiveId),
    );
  }
  // [失败路径] 只有需要与上层对账的投递（话题回复/带 uuid 的幂等发送）才强制要求 message_id；
  // 普通群消息允许返回 null，因为调用方不依赖 id 做后续更新。
  if ((delivery?.uuid || delivery?.replyToMessageId) && !payload.data?.message_id)
    throw new Error("Feishu delivery outcome is unknown: no message_id");
  // INV-02：宁可返回 null 让上层按“未投递”处理，也不能伪造 id 伪装成功。
  return payload.data?.message_id ?? null;
}

// updateFeishuInteractiveMessage：原地更新已经发出的交互卡片（流式回复卡的唯一更新通道）。
// 输入 handle.providerMessageId 只能来自 sendFeishuInteractiveCard 的回执，不能来自卡片按钮
// 的 value 或事件 payload，否则等于“按外部输入修改他人消息”（INV-11）。
// 副作用只有一次 PATCH 请求；失败抛错，由流式节流层决定本轮流式是否收口。
// 返回 void：卡片身份在创建时已固定，更新不需要新的 message_id。
async function updateFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotStreamingReplyCardHandle,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  // 更新走同一资源路径的 PATCH；encodeURIComponent 防止 handle 中的异常字符改变路径语义。
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // 更新时仍要重复声明 msg_type：飞书按消息类型重新校验 content 的结构。
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      // [资源] 流式更新可能每秒多次触发，signal 让任务结束/取消时立即释放这条在途请求。
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP 成功也可能携带业务拒绝，必须保留错误码和请求 ID。
  // 这里刻意不重试：重试会打乱节流窗口，还可能让旧卡片内容覆盖新内容（INV-10）。
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "update streaming card",
      response.status,
      payload,
      response.responseLogId,
    );
  }
}

// deleteFeishuInteractiveMessage：撤回临时交互卡（临时问答/审批卡的清理路径）。
// 与 PATCH 不同，DELETE 成功后平台不再保留该消息，因此没有 message_id 可回填。
// 失败必须抛错：调用方需要知道“旧卡片仍在会话里”，否则用户会重复点击（INV-07 的可撤销语义）。
async function deleteFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotTransientInteractionCardHandle,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
      // 不传 body：DELETE 只需要鉴权头，消息类型由服务端记录决定。
    },
  );
  // [失败路径] 先判 HTTP：5xx/429 属于可重试的服务端问题，与业务拒绝分开描述。
  if (!response.ok) {
    throw new Error(`Feishu recall interaction card failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  // [失败路径] DELETE 的 HTTP 200 也可能是 code!=0（消息已撤回/无权限），必须按失败上报。
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu recall interaction card failed.");
  }
}

// resolveFeishuAppDisplayName：从应用信息响应里挑一个可展示名称，纯函数、无副作用。
// 优先级：app_name（运营配置的正式名）→ 与 primary_language 匹配的 i18n 名称 → 任意非空 i18n 名称。
// 只 trim 判空、不截断：展示宽度由 UI 决定，适配层不猜终端宽度。
function resolveFeishuAppDisplayName(payload: FeishuAppInfoResponse): string | null {
  const app = payload.data?.app;
  const appName = app?.app_name?.trim();
  // 正式名称优先：部分租户的 i18n 表只有默认语言条目，直接取 i18n 会显示错误语言。
  if (appName) {
    return appName;
  }
  const primaryLanguage = app?.primary_language?.trim();
  const primaryI18nName = app?.i18n
    // 只接受与租户主语言同 key 的条目；找不到时得到 undefined，交给下一级兜底。
    ?.find((item) => item.i18n_key === primaryLanguage)
    ?.name?.trim();
  if (primaryI18nName) {
    return primaryI18nName;
  }
  // [权衡] 最后取任意非空名称：语言可能不对，但好过让机器人在列表里显示空字符串。
  return app?.i18n?.find((item) => item.name?.trim())?.name?.trim() ?? null;
}

// fetchFeishuAppDisplayName：GET /application/v6/applications/{appId}，读取应用元信息。
// appId 允许传 "me"：飞书把 me 解释为“当前 token 所属应用”，用于扫码创建后 app_id 尚未同步的场景。
// 副作用：一次 HTTP 请求；非 2xx 或业务码非 0 都抛错，由调用方决定是否降级。
async function fetchFeishuAppDisplayName(
  bot: BotConfig,
  token: string,
  appId: string,
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuAppInfoResponse>(
    // lang=zh_cn 只影响 i18n 内容，不影响 app_name；固定语言避免同一应用在不同环境显示不同名称。
    `${getFeishuBaseUrl(bot)}/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  // [失败路径] 用普通 Error 而非 createFeishuMessageError：本请求不产生消息，没有投递语义可标记。
  if (!response.ok) {
    throw new Error(`Feishu get application info failed app=${appId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  // 业务码非 0（常见无权限）说明当前 token 读不到该应用，调用方会尝试 me 路径。
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get application info failed app=${appId}.`);
  }
  return resolveFeishuAppDisplayName(payload);
}

// readFeishuAppDisplayName：带凭据的应用名读取入口。
// 先按 bot.feishuAppId 读；失败后回退 "me" 路径；两条都失败时抛第一次的错误（更接近真实原因）。
// 无 appId 或拿不到 token 时返回 null 而不抛错：名称只是展示信息，缺它不应阻断 bot 启动。
async function readFeishuAppDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
): Promise<string | null> {
  if (!bot.feishuAppId) {
    return null;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  let appIdError: unknown;
  try {
    const appName = await fetchFeishuAppDisplayName(bot, token, bot.feishuAppId);
    // 空串按“没读到”处理：调用方用 truthy 判断，返回 "" 会把已有展示名覆盖成空。
    if (appName?.trim()) {
      return appName;
    }
  } catch (error) {
    // 暂存不抛：me 路径仍可能成功，只有两条路径都失败才算真失败。
    appIdError = error;
  }
  try {
    // Bugfix: 飞书 / Lark 扫码创建后 app_id 路径可能因为权限或同步延迟暂不可读；me 路径更适合读取当前应用名称。
    return await fetchFeishuAppDisplayName(bot, token, "me");
  } catch (error) {
    // [失败路径] 优先抛 app_id 路径的错误：那是调用方显式指定身份时的真实失败原因。
    throw appIdError ?? error;
  }
}

// resolveFeishuUserIdType：按 ID 前缀推断飞书 ID 类型。
// ou_ = open_id（应用/租户内稳定），on_ = union_id（跨应用稳定），其余按 user_id 处理。
// [权衡] 不认识的格式落到 user_id 而不是抛错：类型不对时飞书会返回明确业务码，
// 比在适配层猜格式更容易定位；但用户输入不能因此被当成可信身份（INV-01）。
function resolveFeishuUserIdType(userId: string): "open_id" | "union_id" | "user_id" {
  if (userId.startsWith("ou_")) {
    return "open_id";
  }
  if (userId.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

// resolveFeishuUserDisplayName：用户展示名的字段优先级。
// name（通讯录姓名）> en_name（英文名）> nickname（昵称）；空串一律视为没有。
// resolveFeishuUserDisplayName 不拼接也不音译，展示格式由上层决定。
function resolveFeishuUserDisplayName(payload: FeishuUserInfoResponse): string | null {
  const user = payload.data?.user;
  // 用 || 串联：任一字段为空串时继续尝试下一级，避免用空名字覆盖已有显示名。
  return user?.name?.trim() || user?.en_name?.trim() || user?.nickname?.trim() || null;
}

// readFeishuUserDisplayName：按用户 ID 读通讯录名称，带 10 分钟进程内缓存。
// 入参 userId 来自消息事件的 sender_id（ou_/on_/user_id 三种都可能），空值直接返回 null。
// 缓存键包含 domain/appId/credentialRef：同一进程可能同时服务飞书与 Lark、多个应用，
// 只用 userId 做键会把 A 租户的姓名泄漏给 B 租户（INV-08 的凭据隔离要求）。
// 副作用：可能发起 contact/v3/users 请求；失败抛错，不静默返回空名。
async function readFeishuUserDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  userId: string,
): Promise<string | null> {
  // 先 trim：事件里偶尔带空白，不 trim 会生成与已有缓存项不同的键，负缓存永远命中不了。
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId ?? ""}:${bot.credentialRef ?? ""}:${trimmedUserId}`;
  const cached = userDisplayNameCache.get(cacheKey);
  // 仅未过期才命中；不做惰性删除，条目靠下一次 set 覆盖（规模由活跃用户数决定，有界）。
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  // [失败路径] 拿不到 token 返回 null：名称缺失不应让整条入站消息解析失败。
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  const userIdType = resolveFeishuUserIdType(trimmedUserId);
  // user_id_type 必须与路径里的 ID 格式一致，否则飞书会把合法 ID 按错误类型解析成 400。
  const response = await fetchBotProviderJson<FeishuUserInfoResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/contact/v3/users/${encodeURIComponent(trimmedUserId)}?user_id_type=${userIdType}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu get user info failed user=${trimmedUserId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  // 通讯录可见范围不足时业务码非 0；抛错让上层回退到 chatId 或 senderType 展示。
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get user info failed user=${trimmedUserId}.`);
  }
  const name = resolveFeishuUserDisplayName(payload);
  // Bugfix: 飞书消息事件只稳定携带 sender_id，不携带发送者名称。
  // 这里缓存通讯录查询结果，避免同一个用户连续发消息时每条都请求 contact API。
  // [权衡] 负结果（name=null）也缓存 10 分钟：否则每个无权限用户都会反复打穿通讯录接口。
  userDisplayNameCache.set(cacheKey, {
    name,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return name;
}

// getFeishuTypingReactionKey：typing reaction 的进程内索引键。
// 用 bot.id + messageId 而不是单用 messageId：同一进程可能挂多个飞书应用，
// 共用键会让 A 应用误删 B 应用创建的 reaction（INV-07 的撤销必须只作用于自己）。
function getFeishuTypingReactionKey(bot: BotConfig, messageId: string): string {
  return `${bot.id}:${messageId}`;
}

// addFeishuTypingReaction：在触发消息上挂一个 Typing 表情，模拟“正在输入”。
// 飞书没有原生 typing 状态，reaction 是唯一可用的即时反馈；它不会自动消失，
// 因此必须把 reaction_id 记进 typingReactionIds，供 stopTyping 精确撤销（INV-07）。
// 幂等：同一 (bot, message) 已记录则直接返回，重复 POST 会产生多个相同表情。
// [失败路径] 拿不到 token 时不抛错、静默降级：typing 是装饰性反馈，不能阻断主回复（INV-07）。
async function addFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const key = getFeishuTypingReactionKey(bot, messageId);
  // 早退而不是覆盖：重复 add 会把旧 reaction_id 丢掉，stop 时旧表情就永远留在消息上。
  if (typingReactionIds.has(key)) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    // message_id 直接拼进路径：飞书 message_id 是 om_ 开头的安全字符集，无需额外编码，
    // 这样与 delete 路径保持完全一致的资源定位方式。
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // emoji_type 固定 Typing：换用其他表情会被用户理解为业务语义（如已读/点赞）。
        reaction_type: {
          emoji_type: "Typing",
        },
      }),
    },
  );
  // [失败路径] 先判 HTTP 再判业务码：两者要分开保留信息，便于区分限流与表情不可用。
  if (!response.ok) {
    throw new Error(`Feishu add typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu add typing reaction failed.");
  }
  // 只缓存服务端回传的 reaction_id：没有 id 就无法 DELETE，宁可不记录，
  // 否则 stop 会拿着假 id 去删别人的表情（INV-02 的同类约束：不伪造平台标识）。
  if (payload.data?.reaction_id) {
    typingReactionIds.set(key, payload.data.reaction_id);
  }
}

// deleteFeishuTypingReaction：撤销 addFeishuTypingReaction 挂上的表情。
// 幂等语义：从未 add 过（或已删除）时直接返回，不产生任何请求（INV-07）。
// 只有 DELETE 成功后才清除缓存；失败保留记录，允许上层再次调用收口。
// [权衡] 不像 add 那样吞掉 HTTP 错误：残留的 typing 表情会被用户长期看到，
// 调用方需要知道撤销失败，才能决定是否在下一轮重试。
async function deleteFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const key = getFeishuTypingReactionKey(bot, messageId);
  const reactionId = typingReactionIds.get(key);
  // 先查缓存再取 token：绝大多数 stop 调用发生在没有 reaction 的场景，省一次凭证加载。
  if (!reactionId) {
    return;
  }
  // [失败路径] 无 token 时保留缓存并返回：reaction 仍在，等下次凭证恢复后还能删。
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    // 删除必须带 reaction_id，而不是按表情类型整体清除：后者会误删用户或其他应用的表情。
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu delete typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu delete typing reaction failed.");
  }
  // 删除成功才移除索引：提前删除会在请求失败时丢失 reaction_id，表情再也删不掉。
  typingReactionIds.delete(key);
}

// readFeishuAppSecret：读取应用的 App Secret，供长连接握手使用。
// 凭据只经 deps.loadCredential 获取，不落日志、不进缓存（INV-08）。
// 缺 appId 或 credentialRef 时返回 null，由调用方转换为可诊断的启动错误。
async function readFeishuAppSecret(
  bot: BotConfig,
  deps: FeishuProviderDeps,
): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  return deps.loadCredential(bot.credentialRef);
}

// createFeishuWebSocketEventHandlers：构造长连接事件分发器用的 handler 表。
// key 是飞书事件名，value 统一把 payload 转交给 onPayload（业务层唯一入口）。
// 这一层只做形状补齐与事件语义标注，不做鉴权/幂等判断（INV-01）。
// 副作用：无网络请求；但 handler 会被 SDK 在事件线程里并发调用，必须自身无共享可变状态。
export function createFeishuWebSocketEventHandlers(params: {
  bot: BotConfig;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
}) {
  const { bot, onPayload } = params;
  return {
    // 普通消息事件：把原始 payload 原样展开，再补 botId/zcodeProvider 供业务层定位渠道实例。
    // 不在这里解析消息体：解析失败要留到 parseCallback 统一处理，避免两套容错分支。
    "im.message.receive_v1": async (payload: unknown) => {
      await onPayload({
        // 非对象事件（理论不该出现）包成 { payload } 而不是丢弃：保留原始数据便于诊断（INV-03）。
        ...(isRecord(payload) ? payload : { payload }),
        botId: bot.id,
        zcodeProvider: bot.provider,
      });
    },
    // 机器人被移出群的系统事件：打上 zcodeBotRemoved，业务层据此停止后续投递。
    // 非对象事件退化为空对象：这里没有可用的消息内容，只需要 bot 身份与移除标记。
    "im.chat.member.bot.deleted_v1": async (payload: unknown) => {
      await onPayload({
        ...(isRecord(payload) ? payload : {}),
        botId: bot.id,
        zcodeProvider: bot.provider,
        zcodeBotRemoved: true,
      });
    },
    // Bugfix: 我们用 Typing reaction 模拟输入中状态，飞书会把自己创建的 reaction 再推回长连接。
    // 业务不需要处理这个事件，但不注册 handler 时 SDK 会持续打印 warn 干扰排查。
    // 返回 undefined 即“无出站消息”，不会触发任何发送副作用。
    "im.message.reaction.created_v1": async () => undefined,
    // 卡片按钮回调：飞书要求 3 秒内给出同步响应，超时客户端就采用默认行为。
    // 这里把业务处理与响应竞速，超时后只切换投递方式，业务仍只执行一次（见下方 deferred）。
    "card.action.trigger": async (payload: unknown) => {
      // responseState 是与业务层共享的可变标记：onPayload 内部若已走旁路更新会置位 deferred，
      // 传输层据此不再返回卡片，避免同一状态被同步响应和旁路 PATCH 写两遍（INV-11）。
      const responseState = { deferred: false };
      const callbackPayload = {
        ...(isRecord(payload) ? payload : { payload }),
        zcodeFeishuCardResponseState: responseState,
        botId: bot.id,
        zcodeProvider: bot.provider,
        // 同步卡片动作：告诉业务层本次必须返回可渲染的卡片，而不是仅返回文本。
        zcodeFeishuSynchronousCardAction: true,
      };
      // 修复原因：飞书点击后的同步响应才是客户端可靠采用的卡片状态。传输层不能再从
      // zcodeCardText 拼简化卡，也不能返回 undefined 后依赖旁路 PATCH；它必须消费业务层
      // 已推进完成的完整 outbound，并用同一份 elicitation 状态生成下一题卡片。
      // 飞书要求三秒内响应。超时只切换卡片投递方式，业务请求仍执行一次。
      let deadline: ReturnType<typeof setTimeout> | undefined;
      // 注意：pending 一旦创建就不可取消，超时只是不再等待它；业务副作用仍会发生一次，
      // 因此 onPayload 必须自身幂等，不能依赖调用方取消来防重复。
      const pending = onPayload(callbackPayload);
      const message = await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          // 2000ms 而非 3000ms：给网络回传和序列化留出余量，避免卡在飞书硬超时边界。
          deadline = setTimeout(() => {
            responseState.deferred = true;
            resolve(null);
          }, 2000);
        }),
      ]).finally(() => {
        // [资源] 无论谁先完成都要清定时器，否则 Node 进程会被这个 2 秒定时器拖住退出。
        if (deadline) clearTimeout(deadline);
      });
      // 已超时：返回空对象表示“暂不更新卡片”，由业务层后续用卡片 update 通道补写。
      if (responseState.deferred) return {};
      // 业务层没有产生出站消息（例如重复点击被幂等吞掉）：不覆盖客户端已有卡片。
      if (!message) {
        return undefined;
      }
      // 仅提示类结果：用 toast 反馈，避免把原卡片正文替换成错误文案。
      if (message.callbackToastOnly) return { toast: { type: "error", content: message.text } };
      return {
        card: {
          // type=raw 表示直接把业务层构造的 Card JSON 交给飞书，不再经过 SDK 模板转换。
          type: "raw",
          data: message.elicitation
            // 问答型卡片必须用 elicitation 载荷，才能带上表单字段与按钮 value。
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        },
      };
    },
  };
}

// startFeishuBotWebSocket：建立飞书长连接并返回可关闭的客户端句柄。
// 与 webhook 渠道不同，这里由本机主动外连，不需要公网回调地址（适配家用网络/NAT 环境）。
// 生命周期分三段：startup（等待 WS 真正 OPEN）→ running（监视重连）→ terminated（关闭或重连耗尽）。
// 失败语义：启动阶段任何错误都走 reject；运行期错误通过 terminated 的 reject 暴露给上层。
// [资源] 定时器、abort 监听、SDK 连接全部由 closeClient/finishLifecycle 收口（INV-12）。
export async function startFeishuBotWebSocket(params: {
  bot: BotConfig;
  deps: FeishuProviderDeps;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
  signal?: AbortSignal;
  onConnectionStateChange?: (state: "reconnecting" | "connected") => void;
}): Promise<FeishuWebSocketClient> {
  const { bot, deps, onPayload, signal, onConnectionStateChange } = params;
  const appId = bot.feishuAppId;
  // 先做本地格式校验再取凭据：明显非法的 App ID 不应触发一次凭证解密和网络请求。
  if (!appId || !FEISHU_APP_ID_PATTERN.test(appId)) {
    throw new Error("Invalid Feishu App ID.");
  }
  const appSecret = await readFeishuAppSecret(bot, deps);
  if (!appSecret) {
    throw new Error("Feishu App ID and App Secret are required.");
  }
  // 取凭据是异步的，期间 channel 可能已被停用；此处是第一个取消检查点。
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  // SDK 全量源码会常驻 Host；只有实际启动长连接才加载，卡片和 HTTP 路径不承担这份开销。
  const Lark = await import("@larksuiteoapi/node-sdk");
  // 加载期间 channel 可能已停用，迟到的模块不能重新创建连接。
  // 这是第二个检查点：漏掉它会让已经 close 的渠道重新建连（INV-12）。
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  // 空配置的 EventDispatcher：只负责按事件名路由，鉴权由 SDK 在握手阶段完成。
  const eventDispatcher = new Lark.EventDispatcher({});
  // 注册 handler 是同步的；onPayload 抛错会由 SDK 记录，不影响长连接本身。
  eventDispatcher.register(createFeishuWebSocketEventHandlers({ bot, onPayload }));
  // 用 Promise 包住整个启动过程：只有 WS 真正 OPEN 才 resolve，避免 start() 早返回造成假就绪。
  return new Promise<FeishuWebSocketClient>((resolve, reject) => {
    // 状态机字段说明：
    // startupSettled：启动 Promise 是否已 settle（成功或失败），保证只 settle 一次；
    // lifecycleSettled：terminated 是否已 settle，保证运行期终态只报一次；
    // clientClosed：closeClient 是否执行过，提供 close 幂等（INV-12）；
    // connectionUnavailable：当前是否处于“曾断开未恢复”状态，用于只在边沿触发 onConnectionStateChange。
    let startupSettled = false;
    let lifecycleSettled = false;
    let clientClosed = false;
    let connectionUnavailable = false;
    // 两个定时器都是资源：startupTimer 负责 20 秒启动超时，connectionPoll 负责轮询真实 readyState。
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionPoll: ReturnType<typeof setInterval> | undefined;
    let resolveTerminated: (() => void) | undefined;
    let rejectTerminated: ((error: unknown) => void) | undefined;
    // terminated 是运行期终态信号：正常 close 时 resolve，重连耗尽或运行错误时 reject。
    // 旧测试替身可以不提供该字段，所以对外类型里它是可选的。
    const terminated = new Promise<void>((resolveLifecycle, rejectLifecycle) => {
      resolveTerminated = resolveLifecycle;
      rejectTerminated = rejectLifecycle;
    });
    // finishLifecycle：运行期终态的唯一写入口，幂等。
    // [资源] 先清轮询定时器再 settle，防止 settle 后回调仍尝试操作已关闭的连接。
    const finishLifecycle = (error?: unknown) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      if (connectionPoll) clearInterval(connectionPoll);
      if (error) {
        rejectTerminated?.(error);
      } else {
        resolveTerminated?.();
      }
    };
    // fail：启动期失败的唯一写入口，保证 reject 只调用一次。
    // 顺序很关键：先置位并清理资源，再 reject；反过来会让失败回调里看到仍存活的定时器。
    const fail = (error: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      // 移除 abort 监听：成功/失败后 signal 仍可能存活很久，不移除会泄漏闭包。
      signal?.removeEventListener("abort", handleAbort);
      closeClient();
      reject(error);
    };
    // abort 监听器只负责把取消翻译成启动失败；运行期取消由上层直接调用 close。
    function handleAbort() {
      // [失败路径] 用固定文案而非 signal.reason：上层据此判断是“取消”而不是协议错误。
      fail(new Error("Feishu WebSocket startup aborted."));
    }
    // closeClient：对外暴露的 close 实现，幂等（INV-12）。
    // 顺序：先置位，再 finishLifecycle（清轮询、resolve terminated），最后关 SDK 连接。
    // 这样即使 wsClient.close() 同步触发回调，回调看到的状态也已经是 closed。
    function closeClient() {
      if (clientClosed) return;
      clientClosed = true;
      finishLifecycle();
      wsClient.close();
    }
    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      // domain 决定连接飞书还是 Lark 国际版；混用会拿到 401/无效应用。
      domain: getFeishuDomainProvider(bot) === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });
    // 修复原因：当前飞书 SDK 不支持 onReady 回调，start() 也会在连接完成前返回。
    // 必须观察 SDK 持有的真实 WebSocket，避免连接已经 OPEN 后仍触发 20 秒超时并被主动关闭。
    // 轮询而非事件监听：SDK 没有暴露 open 事件，readyState 是唯一可靠的连接事实来源。
    connectionPoll = setInterval(() => {
      const sdkClient = wsClient as unknown as {
        isConnecting?: boolean;
        wsConfig?: {
          getWSInstance?(): { readyState?: number } | null;
        };
      };
      // getWSInstance 可能返回 null（尚未创建）；可选链让所有未知形态统一落到“未连接”。
      const connected =
        sdkClient.wsConfig?.getWSInstance?.()?.readyState === WEBSOCKET_OPEN_READY_STATE;
      if (!connected) {
        // 启动尚未 settle 或已显式关闭时不处理：前者由 20 秒超时兜底，后者不应再报状态。
        if (!startupSettled || clientClosed) return;
        // 只在“首次发现断开”时上报 reconnecting，避免每 100ms 刷新一次状态。
        if (!connectionUnavailable) {
          connectionUnavailable = true;
          onConnectionStateChange?.("reconnecting");
        }
        // isConnecting===false 且仍非 OPEN，说明 SDK 的重连循环已经停止，属于终态。
        // 这里不自行重连：adapter 不做无限重试，交由上层重建渠道（INV-10/INV-12）。
        if (sdkClient.isConnecting === false) {
          const error = new Error("Feishu WebSocket reconnect exhausted.");
          finishLifecycle(error);
          closeClient();
        }
        return;
      }
      if (startupSettled) {
        // 运行期恢复：只有之前标记过 unavailable 才上报 connected，避免重复通知。
        if (connectionUnavailable) {
          connectionUnavailable = false;
          onConnectionStateChange?.("connected");
        }
        return;
      }
      // 首次 OPEN：这是启动成功的唯一判据，此刻才 resolve，确保调用方拿到的句柄可立即使用。
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      // 暴露的 close 指向 closeClient，保证重复调用幂等；terminated 供上层等待终态。
      resolve({ close: closeClient, terminated });
    }, FEISHU_WEBSOCKET_READY_POLL_MS);
    // 启动超时：SDK 可能长时间停在 CONNECTING（网络被墙/DNS 失败），必须给上层确定的失败。
    // [权衡] 20 秒是可用性与慢网络的折中；宁可失败让上层重试，也不无限期挂着半个连接。
    startupTimer = setTimeout(() => {
      fail(
        new Error(
          `Feishu WebSocket startup timed out after ${FEISHU_WEBSOCKET_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, FEISHU_WEBSOCKET_START_TIMEOUT_MS);
    // once:true 让监听器在触发后自动移除；正常路径仍显式 remove（成功/失败都会走）。
    signal?.addEventListener("abort", handleAbort, { once: true });
    // 注册监听与检查之间可能已经 abort：补一次同步检查，避免事件在注册前就发生过。
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    // 飞书不需要公网回调地址；这里由本机主动建立长连接接收事件，适配家用网络/NAT 环境。
    // start() 的 Promise 在启动期完成前返回（故上面用轮询判就绪），这里只兜住两种错误：
    void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
      // 启动期：转成启动失败；运行期：转成 terminated 终态并关闭连接。
      // 不区分错误类型：SDK 的拒绝都意味着这条连接不可用，继续保留只会泄漏资源。
      if (!startupSettled) {
        fail(error);
        return;
      }
      finishLifecycle(error);
      closeClient();
    });
  });
}

// createFeishuBotProvider：构造飞书渠道适配器，闭包内持有本渠道的进程级状态。
// 状态全部按需创建、随 adapter 存活周期存在，不跨渠道共享：
// reactionBots 保存“reaction key → bot 配置”，readDirectory 是群成员分页缓存，botOpenIds 缓存机器人自身 open_id。
// 适配器只做协议翻译（INV-01）：授权、幂等、归属判断都在 botsService。
export function createFeishuBotProvider(deps: FeishuProviderDeps): BotProviderAdapter {
  // reactionBots 的 key 是 bot 身份四元组的 JSON，value 是完整配置。
  // 存在的唯一理由：更新 reaction 的回调只有 (key, state)，需要据此找回 baseUrl 与凭据引用。
  // 有界性：条目数等于本进程活跃的飞书 bot 数（通常个位数），不需要淘汰。
  const reactionBots = new Map<string, BotConfig>();
  // updateReaction 由 createGroupInputReactionUpdater 包装：同一 key 的更新会被串行化，
  // 避免“列出 reaction → 删除旧表情 → 添加新表情”三步被并发调用交错（否则会删掉刚加的表情）。
  const updateReaction = createGroupInputReactionUpdater(async (key, state) => {
    const [botKey, messageId] = JSON.parse(key) as [string, string];
    // [失败路径] 非空断言在此可证：只有 updateInputReaction 会先写 reactionBots 再调用 updater，
    // 且 key 由同一函数生成；若未来出现其他调用点，这里会立即 TypeError 暴露 bug。
    const bot = reactionBots.get(botKey)!;
    const token = await readTenantAccessToken(bot, deps);
    // 与 typing 不同，状态 reaction 是任务可见反馈，拿不到凭据必须报错而不是静默跳过，
    // 否则用户会一直看到上一次的状态（如“进行中”）。
    if (!token) throw new Error("Feishu reaction credentials unavailable");
    const url = `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    // 状态到表情的映射是适配层的展示决策；cancelled 映射 null 表示“只清理、不新增”。
    const emoji = {
      waiting: "OneSecond",
      working: "OnIt",
      done: "CheckMark",
      failed: "CrossMark",
      cancelled: null,
    }[state];
    // 白名单限定“本适配器可能创建过的表情类型”。没有它，清理逻辑会误删用户或其他应用
    // 手工添加的同名表情；即使 operator 校验通过，也要再按类型收窄一次。
    const ownedTypes = new Set(["OK", "OneSecond", "OnIt", "CheckMark", "CrossMark"]);
    // obsolete 收集本次应删除的 reaction_id；先收集后统一删除，避免边遍历边改列表。
    const obsolete: string[] = [];
    let found = false;
    let cursor = "";
    // cursors 记录已访问的 page_token：平台异常时会返回同一个 token，形成死循环。
    const cursors = new Set<string>();
    do {
      // [失败路径] 重复游标说明分页数据不可信；直接抛错而不是 break，
      // 否则会带着“只检查了部分 reaction”的结果去增删，可能留下重复表情。
      if (cursors.has(cursor)) throw new Error("Feishu reaction pagination repeated");
      cursors.add(cursor);
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{
            reaction_id: string;
            operator?: { operator_type?: string; operator_id?: string };
            reaction_type?: { emoji_type?: string };
          }>;
        };
      }>(`${url}?page_size=50${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ""}`, {
        method: "GET",
        headers,
      });
      // 列表失败必须中止整个更新：继续删除会让状态停留在旧值，用户无法判断任务是否在跑。
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu list reactions failed");
      for (const item of response.payload.data?.items ?? []) {
        // 重启后从平台核对本应用状态，绝不删除群成员或其他机器人的表情。
        // 三重过滤：operator 必须是 app、operator_id 必须是本应用、表情类型必须在本适配器白名单内。
        if (
          item.operator?.operator_type !== "app" ||
          item.operator.operator_id !== bot.feishuAppId ||
          !ownedTypes.has(item.reaction_type?.emoji_type ?? "")
        )
          continue;
        // 同类型只保留一个：平台理论上不会重复，但并发更新可能产生多个，
        // 多出来的也进 obsolete，保证最终状态唯一（幂等收敛）。
        if (item.reaction_type?.emoji_type === emoji && !found) found = true;
        else obsolete.push(item.reaction_id);
      }
      // has_more 但缺 page_token 是协议异常：不置空就会用旧游标再请求一次，最终触发游标重复错误。
      cursor = response.payload.data?.has_more ? (response.payload.data.page_token ?? "") : "";
      if (response.payload.data?.has_more && !cursor)
        throw new Error("Feishu reaction cursor missing");
    } while (cursor);
    // 先删除与目标状态不符的旧表情，再决定是否新增：顺序反过来会出现短暂“两个状态并存”。
    // 删除失败立即抛错，不继续新增，避免用户看到互相矛盾的两个表情。
    for (const id of obsolete) {
      const response = await fetchBotProviderJson<FeishuReactionResponse>(
        `${url}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers },
      );
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu delete status reaction failed");
    }
    // 只有目标表情尚未存在才 POST：重复添加会产生多个相同表情，且后续清理成本更高。
    if (emoji && !found) {
      const response = await fetchBotProviderJson<FeishuReactionResponse>(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu add status reaction failed");
    }
  });
  // 群成员目录创建在 adapter 级别：缓存跨调用复用，避免每条历史消息都重新拉群成员。
  const readDirectory = createGroupMemberDirectory();
  // getGroupMemberNames：返回 open_id → 显示名的映射，供群消息与历史补名。
  // 缓存键包含 domain/bot/appId/credentialRef/chatId：任一维度变化都必须重新拉取，
  // 否则切换凭据后会拿到越权或过期成员表（INV-08）。
  const getGroupMemberNames = (bot: BotConfig, chatId: string) => {
    const key = JSON.stringify([
      getFeishuDomainProvider(bot),
      bot.id,
      bot.feishuAppId,
      bot.credentialRef,
      chatId,
    ]);
    return readDirectory(key, async (cursor) => {
      const token = await readTenantAccessToken(bot, deps);
      // 目录是展示增强；这里抛错由 readDirectory 决定是否回退，不在此吞掉。
      if (!token) throw new Error("Feishu credentials are unavailable");
      // member_id_type=open_id 与消息事件的 sender_id 对齐，否则成员表键与 senderId 对不上。
      const query = new URLSearchParams({ member_id_type: "open_id", page_size: "100" });
      if (cursor) query.set("page_token", cursor);
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: GroupMemberPage;
      }>(
        `${getFeishuBaseUrl(bot)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      // 缺少 data 也视为失败：空页会让 readDirectory 误以为该群没有成员。
      if (!response.ok || response.payload?.code !== 0 || !response.payload.data)
        throw new Error(response.payload?.msg || "Cannot read group members");
      return response.payload.data;
    });
  };
  // trackDelivery：统一上报投递结果，供 delivery owner 记录 / 重试 / 降级。
  // 成功上报 undefined；失败上报错误文本后原样抛出，不改变调用方语义（INV-02/INV-10）。
  async function trackDelivery<T>(
    bot: BotConfig,
    signal: AbortSignal | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await write();
      // [失败路径] 主动取消后不再上报成功：取消不是“平台已接受”，上报会污染投递统计。
      if (!signal?.aborted) deps.onDeliveryResult?.(bot, undefined);
      return result;
    } catch (error) {
      // 主动取消不代表飞书拒绝投递，也不能覆盖已有诊断；任务超时仍由 watcher 处理。
      if (!signal?.aborted)
        deps.onDeliveryResult?.(bot, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  // 两个包装器只为注入 trackDelivery，不改变底层签名；用 Parameters 展开保证参数位一致。
  const sendCard = (...args: Parameters<typeof sendFeishuInteractiveCard>) =>
    // args[4] 是 signal（第 5 个参数）；写死下标是为了与底层签名一一对应，改签名会编译报错。
    trackDelivery(args[0], args[4], () => sendFeishuInteractiveCard(...args));
  const updateCard = (...args: Parameters<typeof updateFeishuInteractiveMessage>) =>
    trackDelivery(args[0], args[4], () => updateFeishuInteractiveMessage(...args));
  // sendReplyCard：带“回复锚点失效”降级的卡片发送封装。
  // 背景：话题回复要求 replyToMessageId 有效；被引用消息被撤回/权限变化时飞书返回
  // deliveryRejected + deliveryReplyUnavailable，此时可退化为普通群消息而不是整轮失败。
  // 循环上限由全局 fallback 决定：每次降级都会改写 target，正常情况下最多两轮。
  const sendReplyCard = async (
    bot: BotConfig,
    token: string,
    message: BotOutboundMessage,
    card: Record<string, unknown>,
    uuid?: string,
  ): Promise<string | null> => {
    let target = message;
    for (;;) {
      try {
        return await sendCard(bot, token, message.providerUserId, card, undefined, {
          ...resolveFeishuReplyTarget(target),
          // uuid 只在调用方提供时透传：它是飞书的幂等键，重复发送会返回同一条消息。
          ...(uuid ? { uuid } : {}),
        });
      } catch (error) {
        const details = error as {
          deliveryRejected?: boolean;
          deliveryReplyUnavailable?: boolean;
        } | null;
        // 持久化结果由 delivery owner 记录降级目标；这里只处理命令和临时卡。
        // 三个前置条件缺一不可：非持久化投递、目标是群会话（oc_）、错误明确表示“回复锚点不可用”。
        // 只按 deliveryRejected 降级会把权限错误也变成普通群发，造成越权投递（INV-01）。
        if (
          message.deliveryId ||
          !message.providerUserId.startsWith("oc_") ||
          !details?.deliveryRejected ||
          !details.deliveryReplyUnavailable
        )
          throw error;
        // 没有可用 fallback 说明连普通发送都无法确定目标，只能把原错误抛给上层。
        const fallback = getUnavailableReplyFallback(target);
        if (!fallback) throw error;
        target = { ...target, ...fallback };
      }
    }
  };
  // botOpenIds：provider:appId → 机器人自身 open_id。
  // 用途是区分“本 bot 发的消息”与“其他 bot 发的消息”，只在 prepareCallbackPayload 里读写。
  // 有界性：条目数等于本进程出现过的应用数；值为空会重新请求，因此不会缓存失败结果。
  const botOpenIds = new Map<string, string>();
  return {
    getGroupMemberNames,
    // resolveTopic：把一条消息解析成话题身份（threadId + 根消息 + 可点击的跳转链接）。
    // 必须两次校验 scope：目标消息与根消息都要属于 actor.chatId/同一 thread，
    // 否则用户可以构造跨群消息 id 让机器人读取他群内容（INV-01）。
    async resolveTopic(bot, actor) {
      const token = await readTenantAccessToken(bot, deps);
      // 缺任一要素就无法证明话题身份；这里直接抛错而不是返回部分字段。
      if (!token || !actor.chatId || !actor.providerMessageId)
        throw new Error("Topic identity unavailable");
      // get 是一次带作用域校验的消息读取：既取正文，也验证归属。
      const get = async (id: string) => {
        const response = await fetchBotProviderJson<{
          code?: number;
          data?: { items?: Array<Record<string, unknown>> };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        // items 是数组且需要按 message_id 再匹配一次：接口偶尔返回邻近消息，不能直接取 [0]。
        const item = response.payload?.data?.items?.find((entry) => entry.message_id === id);
        if (!response.ok || response.payload?.code !== 0 || !item || item.chat_id !== actor.chatId)
          throw new Error("Topic message scope could not be verified");
        return item;
      };
      const message = await get(actor.providerMessageId);
      const threadId = readString(message, "thread_id");
      // actor 自带的 threadId 必须与平台一致：不一致说明调用方拼装的身份过期或被篡改。
      if (!threadId || (actor.threadId && actor.threadId !== threadId))
        throw new Error("Topic scope mismatch");
      // 非话题回复没有 root_id，此时消息自身就是根；话题回复则要再读一次根消息。
      const rootMessageId = readString(message, "root_id") || actor.providerMessageId;
      const root = rootMessageId === actor.providerMessageId ? message : await get(rootMessageId);
      // 根消息也必须落在同一 thread：只校验 chat 不够，同群可以有多个话题。
      if (root.thread_id !== threadId) throw new Error("Topic root scope mismatch");
      const body = isRecord(root.body) ? root.body : null;
      const content = parseJsonRecord(readString(body, "content"));
      // 标题优先级：纯文本 → 富文本 post → threadId 兜底，保证跳转卡片永远有可展示标题。
      const title = readString(content, "text") || readFeishuPostText(content) || threadId;
      const position = root.thread_message_position;
      // 只有纯数字 position 才能拼出有效 applink；非数字会让客户端落到错误话题。
      const topicUrl =
        (typeof position === "number" || typeof position === "string") &&
        /^\d+$/.test(String(position))
          ? `https://${bot.provider === "lark" ? "applink.larksuite.com" : "applink.feishu.cn"}/client/thread/open?${new URLSearchParams(
              {
                openthreadid: threadId,
                openchatid: actor.chatId,
                open_thread_id: threadId,
                open_chat_id: actor.chatId,
                thread_position: String(position),
              },
            )}`
          : undefined;
      return {
        threadId,
        rootMessageId,
        // 标题压平空白并截断到 80：飞书卡片标题不换行，超长文本会挤掉正文。
        topicTitle: title.replace(/\s+/gu, " ").slice(0, 80),
        // 条件展开而不是赋 undefined：上层用 in/truthy 判断时两者语义不同。
        ...(topicUrl ? { topicUrl } : {}),
      };
    },
    // readTopicResourceMessage：读取“归档资源消息”里的附件（话题内历史图片/文件）。
    // 与 downloadAttachment 分离：这里只解析元数据，不下载字节，避免历史浏览触发大流量。
    // 安全约束：消息必须未删除、且 chat_id/thread_id 与 target 完全一致，否则拒绝（INV-01）。
    // 失败语义：任一条件不满足都抛错；返回空列表会让上层误以为“消息里没有附件”。
    async readTopicResourceMessage(bot, target, signal) {
      // [资源] 入口先检查取消：调用方可能在排队期间已经放弃，没必要再取 token（INV-12）。
      signal?.throwIfAborted();
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) throw new Error("Feishu credentials unavailable");
      const response = await fetchBotProviderJson<{
        code?: number;
        data?: { items?: Array<Record<string, unknown>> };
      }>(
        // 按 message_id 读取单条消息；这里不带 card_msg_content_type，因为只关心文件/图片附件。
        `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          // signal 透传：历史浏览可能被用户快速切换打断，避免请求堆积。
          signal,
        },
      );
      // items 需要按 message_id 精确匹配：接口可能返回同话题邻近消息。
      const native = response.payload?.data?.items?.find(
        (item) => item.message_id === target.messageId,
      );
      // 五条校验缺一不可：HTTP/业务码、消息存在、未删除、群一致、话题一致。
      // 少任何一条都可能让用户通过伪造 target 读到其他会话的附件（INV-01）。
      if (
        !response.ok ||
        response.payload?.code !== 0 ||
        !native ||
        native.deleted === true ||
        native.chat_id !== target.chatId ||
        native.thread_id !== target.threadId
      )
        throw new Error("Archived resource must be readable in the same topic");
      const body = isRecord(native.body) ? native.body : null;
      const content = parseJsonRecord(readString(body, "content"));
      const kind = readString(native, "msg_type");
      const attachments: BotInboundAttachment[] = [];
      // add 统一补 providerMetadata.resourceMessageId：下载时必须回到“附件实际所在的消息”，
      // 而不是当前触发下载的消息，否则资源接口会 404。
      const add = (attachment: BotInboundAttachment | null | undefined) => {
        // 元数据解析失败即整条失败：返回部分附件会让用户以为消息只有这些内容（INV-04）。
        if (!attachment) throw new Error("Archived resource metadata unavailable");
        attachments.push({
          ...attachment,
          providerMetadata: { resourceMessageId: target.messageId },
        });
      };
      if (kind === "file" || kind === "image") add(readFeishuAttachment(kind, content));
      else if (kind === "post") {
        // 富文本没有统一的附件字段，必须递归遍历所有节点找 tag==="img"。
        const visit = (value: unknown): void => {
          // 先处理数组再处理对象：post 的 content 是多语言数组，元素结构不固定。
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!isRecord(value)) return;
          // 只把 img 节点当附件；a/at/code 等节点递归进去也不会产生附件。
          if (value.tag === "img") add(readFeishuAttachment("image", value));
          else Object.values(value).forEach(visit);
        };
        visit(content);
      }
      // 空结果按错误处理：调用方请求的是“资源消息”，没有可用资源说明前提不成立。
      if (!attachments.length) throw new Error("Archived message has no supported resources");
      // 保留 target 的其余字段（如 chatId/threadId），只补 attachments，便于上层继续用同一身份。
      return { ...target, attachments };
    },
    // readTopicHistory：读取话题历史，交给通用 history 读取器做窗口/分页/补全。
    // 本函数负责把飞书消息形状规范化成 BotInboundMessage，并处理两类特殊情况：
    // (1) 升级客户端卡片只有占位内容，需要二次请求真实卡片正文；
    // (2) 权限不足要抛出可识别的 TopicHistoryPermissionError，供上层展示引导。
    async readTopicHistory(bot, request) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials unavailable");
      // read 是历史接口的唯一出口：集中处理鉴权头、HTTP/业务码、权限错误分类。
      const read = async (suffix: string) => {
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          data?: { items?: unknown[]; has_more?: boolean; page_token?: string };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages${suffix}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok || response.payload?.code !== 0) {
          const message = response.payload?.msg || "Topic history unavailable";
          // 99991672 是缺失 im:message.group_msg 权限；文案匹配用于兼容不同租户的错误码漂移。
          // 必须用专用错误类型：普通错误会被上层当成临时故障，反复重试也不会成功（INV-10）。
          if (response.payload?.code === 99991672 || message.includes("im:message.group_msg"))
            throw new TopicHistoryPermissionError(message);
          throw new Error(message);
        }
        return response.payload.data;
      };
      // readHistoryAttachments：把消息内容里的附件压成“文件名 + 类型”列表。
      // 历史列表只需要展示附件数量与名称，不需要下载，因此刻意不返回 providerFileId。
      const readHistoryAttachments = (kind: string, content: Record<string, unknown> | null) => {
        const items: Array<{ name: string; kind: string }> = [];
        const add = (type: "image" | "file", value: Record<string, unknown> | null) => {
          const attachment = readFeishuAttachment(type, value);
          if (attachment) items.push({ name: attachment.filename, kind: type });
        };
        if (kind === "image" || kind === "file") add(kind, content);
        else if (kind === "post") {
          // 与 readTopicResourceMessage 相同的递归策略；这里失败只跳过，不中断整页历史。
          const visit = (value: unknown): void => {
            if (Array.isArray(value)) {
              value.forEach(visit);
              return;
            }
            if (!isRecord(value)) return;
            if (value.tag === "img") add("image", value);
            else Object.values(value).forEach(visit);
          };
          visit(content);
        }
        return items;
      };
      // rawMessages：message_id → 原始 payload。normalize 是纯转换，二次展开时不想重新请求列表接口，
      // 所以把原始数据留在本次调用内（生命周期仅此函数，不跨请求）。
      const rawMessages = new Map<string, unknown>();
      // normalize：把飞书原始消息转成领域模型。expandCard=true 时额外拉取真实卡片正文。
      // 抛错语义：结构不合法直接抛，避免把半成品消息交给上层。
      const normalize = async (raw: unknown, expandCard = false) => {
        if (!isRecord(raw)) throw new Error("Invalid topic history message");
        const sender = isRecord(raw.sender) ? raw.sender : null;
        const body = isRecord(raw.body) ? raw.body : null;
        let content = parseJsonRecord(readString(body, "content"));
        const kind = readString(raw, "msg_type");
        if (
          expandCard &&
          kind === "interactive" &&
          // 只有本应用发出的卡片才需要展开：用户发的卡片正文不在我们的 schema 内。
          readString(sender, "sender_type") === "app" &&
          // 已有 body 说明是完整卡片（非占位图），无需二次请求。
          !isRecord(content?.body)
        ) {
          // 历史接口也会返回升级客户端占位图，不能据此把操作卡片误判为普通回复。
          const data = await read(
            `/${encodeURIComponent(readString(raw, "message_id"))}?card_msg_content_type=user_card_content`,
          );
          const native = data?.items?.find(
            (item) => isRecord(item) && item.message_id === readString(raw, "message_id"),
          );
          // 二次请求同样要校验 scope：卡片的 chat/thread 必须与列表中的那条一致，
          // 否则可能用另一个会话的正文替换本条消息内容（INV-01）。
          if (
            !isRecord(native) ||
            native.chat_id !== raw.chat_id ||
            native.thread_id !== raw.thread_id
          )
            throw new Error("History card scope unavailable");
          content = parseJsonRecord(isRecord(native.body) ? native.body.content : undefined);
          // 展开失败即报错：宁可让这一页失败，也不要把占位文案当正文展示。
          if (!content) throw new Error("History card content unavailable");
        }
        rawMessages.set(readString(raw, "message_id"), raw);
        // botTopicMessageSchema.parse 是信任边界：结构不符直接抛 ZodError，
        // 禁止把未校验的远端字段透传给上层（INV-01）。
        return botTopicMessageSchema.parse({
          id: readString(raw, "message_id"),
          chatId: readString(raw, "chat_id"),
          threadId: readString(raw, "thread_id"),
          senderId: readString(sender, "id"),
          senderType: readString(sender, "sender_type"),
          // 空字符串转 undefined：schema 里 senderName 是可选字段，"" 会覆盖后续成员表补名。
          senderName: readString(sender, "name") || undefined,
          // parent_id 只在回复消息上存在；空串同样视为没有父消息。
          parentId: readString(raw, "parent_id") || undefined,
          attachments: readHistoryAttachments(kind, content),
          // create_time 是毫秒时间戳字符串；Number 转换失败会得到 NaN，由 schema 拒绝。
          createdAt: Number(readString(raw, "create_time")),
          kind,
          // controlCard 只对交互卡有意义：用于上层区分“控制卡”与普通卡片回复。
          ...(kind === "interactive" ? { controlCard: isGroupControlCard(content) } : {}),
          // 文本提取按类型分支；未知类型退化为 [kind] 占位，保证列表永远有可读标签。
          text:
            kind === "interactive"
              ? readGroupCardText(content)
              : kind === "text"
                ? readString(content, "text")
                : kind === "post"
                  ? readFeishuPostText(content)
                  : `[${kind}${readString(content, "file_name") ? `: ${readString(content, "file_name")}` : ""}]`,
          // deleted 用严格 true 判断：接口缺字段时不能把消息当已删除。
          deleted: raw.deleted === true,
        });
      };
      const history = await readTopicHistory(request, {
        // list：按 thread 维度倒序分页；容器类型必须是 thread，不能是 chat，
        // 否则会把同群其他话题的消息混进来。
        list: async (page) => {
          const query = new URLSearchParams({
            container_id_type: "thread",
            container_id: request.threadId,
            sort_type: "ByCreateTimeDesc",
            page_size: "50",
            ...(page ? { page_token: page } : {}),
          });
          const data = await read(`?${query}`);
          // items 不是数组说明响应被截断/结构异常；继续 map 会抛 TypeError，不如给出明确错误。
          if (!Array.isArray(data?.items)) throw new Error("Topic history page unavailable");
          // has_more 却没有游标：通用读取器会把它当最后一页，静默截断历史，所以必须显式失败。
          if (data.has_more && !data.page_token)
            throw new Error("Topic history cursor unavailable");
          return {
            // 并行 normalize：单页 50 条，串行会让首屏延迟线性增长；失败由 Promise.all 整体拒绝。
            messages: await Promise.all(data.items.map((raw) => normalize(raw))),
            next: data.has_more ? data.page_token : undefined,
          };
        },
        // 由历史读取器先确定窗口，正文展开不再作用于整页消息。
        // hydrate 使用 rawMessages 里的原始 payload，避免为未展示的消息支付二次请求成本。
        hydrate: (message) => normalize(rawMessages.get(message.id), true),
        // get：读取窗口外/被引用的单条消息；同样走 normalize 保证形状一致。
        get: async (id) => {
          const data = await read(`/${encodeURIComponent(id)}`);
          const raw = data?.items?.find((item) => isRecord(item) && item.message_id === id);
          // 找不到时 normalize 会抛 “Invalid topic history message”，比返回 undefined 更明确。
          return normalize(raw);
        },
      });
      if (history.messages.length) {
        // 成员名是展示增强：群成员接口失败时降级为空表，保留消息里自带的 sender_name。
        // [权衡] 不让整页历史因补名失败而失败——历史正文已经可用，姓名缺失不影响阅读。
        const names = await getGroupMemberNames(bot, request.chatId).catch(
          () => ({}) as Record<string, string>,
        );
        // 成员表优先于消息自带名称：后者在飞书事件里常常为空，且不会随改名更新。
        history.messages = history.messages.map((message) => ({
          ...message,
          senderName: names[message.senderId] || message.senderName,
        }));
      }
      return history;
    },
    // getGroupInfo：读取群名称与会话模式（普通群 / 话题群）。
    // chatMode 只映射为 topic|group 两值：上层用它决定是否按话题路由，未知值按普通群处理更安全。
    // 无缓存：群名改名、模式切换都可能在会话期间发生，且调用频率低。
    async getGroupInfo(bot, chatId) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials are unavailable");
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: { name?: string; chat_mode?: string };
      }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // 权限不足（机器人不在群）与网络错误都走抛错：上层需要区分“读不到”与“不是群”。
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Cannot read group information");
      return {
        // 群名为空时回退 chatId：展示层永远有可用的稳定标识，不会渲染空白。
        name: response.payload.data?.name || chatId,
        chatMode: response.payload.data?.chat_mode === "topic" ? "topic" : "group",
      };
    },
    // prepareCallbackPayload：入站回调的“补全 + 作用域校验”阶段，返回仍保持原 payload 形状。
    // 该函数不改写业务字段，只追加 zcode* 诊断/路由信息；真正的授权判断在 botsService（INV-01）。
    // 三类入口：卡片按钮动作（action.trigger）、机器人控制卡事件、普通群消息（引用解析）。
    async prepareCallbackPayload(bot, payload) {
      // 非对象 payload 原样返回：解析器 parseCallback 会自行判空，不在这里制造异常。
      if (!isRecord(payload)) return payload;
      // 飞书事件可能被包在 event 里（v2 格式），也可能已经是事件本体；统一向下兼容。
      const event = isRecord(payload.event) ? payload.event : payload;
      const action = isRecord(event.action) ? event.action : null;
      const actionValue = isRecord(action?.value) ? action.value : null;
      // behaviors 是卡片 2.0 的新按钮回调形状；同样的 value 也可能出现在这里。
      const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
      const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
      // [权衡] 用 safeParse 而不是直接信任 value.groupCard：按钮 value 完全由客户端回传，
      // 只能用来“识别这是本平台的卡片”，不能作为授权依据（INV-11）。
      const card = botGroupCardSchema.safeParse(actionValue?.groupCard ?? behaviorValue?.groupCard);
      if (card.success) {
        const context = isRecord(event.context) ? event.context : null;
        // context 里的 open_chat_id/open_message_id 是飞书注入的点击上下文，优先于 value 中的同名字段。
        const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
        const cardId = readString(context, "open_message_id") || readString(context, "message_id");
        // 卡片回调只有短响应窗口，位置验证与 token 请求共用同一 deadline。
        // 1.5 秒比同步响应的 2 秒更紧，确保验证失败也能在飞书超时前返回错误。
        const signal = AbortSignal.timeout(1500);
        const token = await readTenantAccessToken(bot, deps, signal);
        // 超时/取消必须立刻中止：继续请求会拿到已失效的 token 结果，且拖过响应窗口。
        signal.throwIfAborted();
        // 这里只校验“按钮声明的卡片属于点击发生的会话”，不是权限判定；
        // card.data.chatId 来自按钮 value，故必须再用平台侧消息核对。
        if (!token || !cardId || chatId !== card.data.chatId)
          throw new Error("Card scope unavailable");
        const response = await fetchBotProviderJson<{
          code?: number;
          data?: { items?: Array<Record<string, unknown>> };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(cardId)}`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
        const native = response.payload?.data?.items?.find((item) => item.message_id === cardId);
        // 按钮参数不是原生位置真源；必须验证卡片实际所在的话题。
        // 校验 chat_id 与 thread_id 双重一致，防止把 A 话题的卡片操作套到 B 话题上（INV-01/INV-11）。
        if (
          !response.ok ||
          response.payload?.code !== 0 ||
          native?.chat_id !== chatId ||
          (readString(native ?? null, "thread_id") || undefined) !== card.data.threadId
        )
          throw new Error("Card topic scope mismatch");
        // 校验通过后原样返回：业务层仍从 payload 读取原始事件，避免两条数据来源。
        return payload;
      }
      // 非卡片动作：只处理群消息；私聊不需要引用/控制卡解析，直接交给下游。
      const message = isRecord(event.message) ? event.message : null;
      if (readString(message, "chat_type") !== "group") return payload;
      const messageSender = isRecord(event.sender) ? event.sender : null;
      // 机器人自己发出的群控制卡不应再次触发业务：否则控制卡会被当成用户输入回环处理。
      if (
        isFeishuBotSender(readString(messageSender, "sender_type")) &&
        (readString(message, "message_type") || readString(message, "msg_type")) ===
          "interactive" &&
        isGroupControlCard(parseJsonRecord(message?.content))
      )
        return payload;
      const identityKey = `${bot.provider}:${bot.feishuAppId}`;
      let openId = botOpenIds.get(identityKey);
      if (!openId) {
        // 首次需要机器人 open_id 时才请求 /bot/v3/info；该值在整个进程生命周期内不变。
        const token = await readTenantAccessToken(bot, deps);
        if (!token) throw new Error("Feishu credentials are unavailable");
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          bot?: { open_id?: string };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/bot/v3/info`, {
          headers: { authorization: `Bearer ${token}` },
        });
        openId = response.payload?.bot?.open_id;
        // 拿不到 open_id 会导致后续“是否本 bot 发言”的判断失效，必须抛错而不是留空。
        if (!response.ok || response.payload?.code !== 0 || !openId)
          throw new Error(response.payload?.msg || "Cannot resolve Feishu bot identity");
        // 只缓存成功结果：失败时不写空值，下一次调用会重试。
        botOpenIds.set(identityKey, openId);
      }
      let nativeCardContent: Record<string, unknown> | undefined;
      // 机器人发出的交互卡片：事件里的 content 可能只是“升级客户端”占位图，
      // 需要读真实正文才能区分控制卡与普通回复卡片。
      if (
        isFeishuBotSender(readString(messageSender, "sender_type")) &&
        (readString(message, "message_type") || readString(message, "msg_type")) === "interactive"
      ) {
        const currentContent = parseJsonRecord(message?.content);
        // 默认事件/历史内容可能只是升级客户端占位图；先读取真实正文再分类。
        if (!isRecord(currentContent?.body)) {
          const token = await readTenantAccessToken(bot, deps);
          if (!token) throw new Error("Card credentials unavailable");
          const response = await fetchBotProviderJson<{
            code?: number;
            data?: {
              items?: Array<{
                message_id?: string;
                chat_id?: string;
                thread_id?: string;
                body?: { content?: string };
              }>;
            };
          }>(
            // card_msg_content_type=user_card_content 才会返回用户视角的卡片正文，
            // 默认视图对机器人卡片只给占位图。
            `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(readString(message, "message_id"))}?card_msg_content_type=user_card_content`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          const native = response.payload?.data?.items?.[0];
          // 三重 scope 校验：消息 id、群 id、话题 id 必须与事件里的一致，
          // 否则可能用另一条消息的正文冒充本次事件内容（INV-01）。
          if (
            !response.ok ||
            response.payload?.code !== 0 ||
            native?.message_id !== readString(message, "message_id") ||
            native.chat_id !== readString(message, "chat_id") ||
            (native.thread_id || "") !== readString(message, "thread_id")
          )
            throw new Error("Card message scope unavailable");
          // 正文解析为空说明卡片结构异常；继续处理会把 null 当正文，交由上层前先失败。
          nativeCardContent = parseJsonRecord(native.body?.content) ?? undefined;
          if (!nativeCardContent) throw new Error("Card content unavailable");
        }
      }
      const sender = isRecord(event.sender) ? event.sender : null;
      const parentId = readString(message, "parent_id");
      const rootId = readString(message, "root_id");
      let topicRootIsCurrentBot = false;
      let referencedAttachment: BotInboundAttachment | undefined;
      let referencedMessage: BotInboundMessage["referencedMessage"];
      const referencedInlineImages: Array<{ imageKey: string; messageId: string }> = [];
      // 引用解析的整体门槛：存在父消息、发送者不是“本 bot 自己”、且确实是回复/提及。
      // 条件写成集合而非层层 if：任一不满足都表示“这条消息没有需要读取的引用”。
      if (
        parentId &&
        // 用户消息一律解析；其他机器人消息只有不是自己发的才解析（避免自触发循环）。
        (readString(sender, "sender_type") === "user" ||
          (isFeishuBotSender(readString(sender, "sender_type")) &&
            readString(isRecord(sender?.sender_id) ? sender.sender_id : null, "open_id") !==
              openId)) &&
        // 话题内“已接受输入”的回声（parent==root 且发送者非 bot）不再当作引用，避免自己引用自己。
        !(
          payload.zcodeTopicHasAcceptedInput === true &&
          parentId === rootId &&
          !isFeishuBotSender(readString(sender, "sender_type"))
        ) &&
        // 位于话题中，或文本里 @ 了本 bot，才需要读取引用；普通群消息的 parent_id 可能是转发残留。
        (Boolean(readString(message, "thread_id")) ||
          readGroupMentionText(
            "",
            message?.mentions,
            openId,
            readString(sender, "sender_type"),
            readString(isRecord(sender?.sender_id) ? sender.sender_id : null, "open_id"),
          ) !== null)
      ) {
        const token = await readTenantAccessToken(bot, deps);
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{
              message_id?: string;
              chat_id?: string;
              thread_id?: string;
              msg_type?: string;
              deleted?: boolean;
              create_time?: string;
              sender?: { id?: string; id_type?: string; sender_type?: string };
              body?: { content?: string };
            }>;
          };
        }>(
          // 默认卡片响应仅含“升级客户端”占位文案；必须请求真实卡片正文供引用解析。
          `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(parentId)}?card_msg_content_type=user_card_content`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const referenced = response.payload?.data?.items?.[0];
        // 引用消息必须在同群且未删除：跨群/已删除的引用不能作为附件或文本来源。
        if (
          !response.ok ||
          response.payload?.code !== 0 ||
          referenced?.message_id !== parentId ||
          referenced.chat_id !== readString(message, "chat_id") ||
          referenced.deleted
        )
          throw new Error("Referenced attachment must be readable in the same group");
        // 引用消息可来自同群另一个话题，不能只用 chat_id 证明附件归属。
        // 例外：parent 就是话题根且根消息没有 thread_id（老群/根消息），此时允许无 thread。
        if (
          (referenced.thread_id || undefined) !== (readString(message, "thread_id") || undefined) &&
          !(parentId === rootId && !referenced.thread_id)
        )
          throw new Error("Referenced attachment must be readable in the same topic");
        // 判断被引用消息是否本 bot 发出的：用 app_id 或 open_id 双口径，兼容不同事件版本的字段。
        topicRootIsCurrentBot =
          parentId === rootId &&
          referenced.sender?.sender_type === "app" &&
          ((referenced.sender.id_type === "app_id" && referenced.sender.id === bot.feishuAppId) ||
            (referenced.sender.id_type === "open_id" && referenced.sender.id === openId));
        // 白名单收窄可解析类型：未知类型没有可靠的正文/附件提取规则，直接报错而不是猜。
        if (!["text", "post", "image", "file", "interactive"].includes(referenced.msg_type ?? "")) {
          throw new Error("Referenced message type is unsupported");
        }
        if (referenced.msg_type === "interactive") {
          // 确认文字没有专用事件类型，须通过可信 parent 消息识别，不能依赖翻译文案。
          // 双方都是 bot 且引用的是控制卡时，标记忽略：否则控制卡会被当成用户输入再次执行。
          if (
            isFeishuBotSender(readString(sender, "sender_type")) &&
            isFeishuBotSender(referenced.sender?.sender_type ?? "") &&
            isGroupControlCard(parseJsonRecord(referenced.body?.content))
          )
            return { ...payload, zcodeIgnoreInteractionMessage: true };
          const text = readGroupCardText(parseJsonRecord(referenced.body?.content));
          // 卡片没有可读文字时不能静默丢弃引用：用户会以为 @ 的内容消失了。
          if (!text) throw new Error("Referenced message has no readable text");
          referencedMessage = { messageId: parentId, text };
        }
        // 文字引用此前只做权限检查后丢弃，导致仅 @ 被误判为空消息。
        // 这里把被引用的文本真正带回，供上层拼接“引用 + 本次输入”。
        if (referenced.msg_type === "text" || referenced.msg_type === "post") {
          const body = parseJsonRecord(referenced.body?.content);
          const quotedText =
            referenced.msg_type === "text" ? readString(body, "text") : readFeishuPostText(body);
          if (referenced.msg_type === "post") {
            // post 里的图片需要单独抽出来：正文只保留文字，图片走 inlineImages 通道下载。
            const visit = (value: unknown): void => {
              if (Array.isArray(value)) {
                value.forEach(visit);
                return;
              }
              if (!isRecord(value)) return;
              if (value.tag === "img") {
                const image = readFeishuAttachment("image", value);
                // 缺少 providerFileId 的图片无法下载，必须报错而不是保留一个坏 key。
                if (!image?.providerFileId) throw new Error("Referenced image is invalid");
                referencedInlineImages.push({
                  imageKey: image.providerFileId,
                  messageId: parentId,
                });
              }
              // post 节点可能用 content/children/elements 三种字段承载子节点，全部递归。
              visit(value.content ?? value.children ?? value.elements);
            };
            if (body) visit(readFeishuPostLocaleContent(body));
          }
          // 引用内容为空且没有图片：说明消息被清空或不可读，不能当成“空引用”继续。
          if (!quotedText.trim() && !referencedInlineImages.length)
            throw new Error("Referenced message is empty or unavailable");
          referencedMessage = { messageId: parentId, text: quotedText };
        }
        if (referencedMessage) {
          const senderId = referenced.sender?.id;
          // 补名失败降级为空表：引用内容本身仍可用，姓名缺失不应阻断解析。
          const names = senderId
            ? await getGroupMemberNames(bot, referenced.chat_id!).catch(
                () => ({}) as Record<string, string>,
              )
            : {};
          const sentAt = Number(referenced.create_time);
          referencedMessage = {
            ...referencedMessage,
            ...(senderId
              ? {
                  senderId,
                  // 姓名优先级：成员表 → 本 bot 自身名称 → 未知（undefined，不伪造）。
                  senderName:
                    names[senderId] ||
                    (senderId === openId ||
                    (referenced.sender?.sender_type === "app" && senderId === bot.feishuAppId)
                      ? bot.name
                      : undefined),
                }
              : {}),
            // 时间戳可能是 NaN/0，只有正有限值才转 ISO；否则不输出 sentAt 字段。
            ...(Number.isFinite(sentAt) && sentAt > 0
              ? { sentAt: new Date(sentAt).toISOString() }
              : {}),
          };
        }
        if (referenced.msg_type === "image" || referenced.msg_type === "file") {
          const attachment = readFeishuAttachment(
            referenced.msg_type,
            parseJsonRecord(referenced.body?.content),
          );
          // 元数据不完整就让整条消息失败：上层需要知道“引用附件不可用”，而不是收到空引用。
          if (!attachment) throw new Error("Referenced attachment is invalid");
          referencedAttachment = {
            ...attachment,
            // 下载必须回到父消息 id：/resources 接口按“消息 + 文件”定位。
            providerMetadata: { resourceMessageId: parentId },
          };
        }
      }
      // 返回仍是原 payload 的超集：只追加派生信息，不删除/改写飞书字段，
      // 这样上层既可用 zcode* 快捷字段，也能回退到原始事件结构。
      return {
        ...payload,
        zcodeBotOpenId: openId,
        ...(nativeCardContent ? { zcodeNativeCardContent: nativeCardContent } : {}),
        zcodeTopicRootIsCurrentBot: topicRootIsCurrentBot,
        zcodeReferencedAttachment: referencedAttachment,
        zcodeReferencedMessage: referencedMessage,
        zcodeReferencedInlineImages: referencedInlineImages,
      };
    },
    // splitStreamingReplyCardStates：把一次流式回复切成多张卡片，每张不超过元素预算（INV-06）。
    // 预算计算与分段都在 seg1 的 splitFeishuStreamingCardStates 内完成；这里只是暴露给上层的绑定。
    // 关键契约：除最后一段外，前面的段状态为 sealed（不再更新），避免同一内容在多张卡里重复刷新。
    splitStreamingReplyCardStates: splitFeishuStreamingCardStates,
    // test：凭据自检，只验证“能拿到 tenant access token”，不发送任何消息。
    // 失败不抛错而是返回 {ok:false}：调用方在设置页展示结果，抛错会变成未处理异常。
    async test(bot) {
      if (!bot.enabled) {
        return { ok: false, message: "Feishu bot is disabled." };
      }
      if (!bot.feishuAppId || !bot.credentialRef) {
        return {
          ok: false,
          message: "Feishu App ID and App Secret are required.",
        };
      }
      const token = await readTenantAccessToken(bot, deps);
      // token 为空可能是凭据缺失、凭证无效或网络失败；这里不细分，避免把内部错误细节暴露到 UI。
      return token
        ? { ok: true, message: "Feishu app credentials are valid." }
        : { ok: false, message: "Feishu app credentials are missing." };
    },

    async resolveName(bot) {
      // Bugfix: Feishu 创建向导以前只能使用手填/默认名称，容易和真实机器人名称不一致。
      // 飞书机器人能力挂在自建应用上，这里读取应用信息中的名称作为 bot 展示名。
      // 读取失败返回 null（见 readFeishuAppDisplayName），由 UI 回退到用户配置的名称。
      return readFeishuAppDisplayName(bot, deps);
    },

    async resolveActorDisplayName(bot, actor) {
      // 群事件不保证携带姓名；群成员接口避免依赖组织通讯录可见范围。
      // 群聊走成员目录（缓存），私聊才查通讯录，减少对 contact API 的依赖与配额消耗。
      if (actor.chatType === "group") {
        // 没有 chatId 就无法定位成员表；返回 null 让上层回退到 senderType 展示。
        if (!actor.chatId) return null;
        // 成员表按 open_id 建索引；actor.providerUserId 不是 open_id 时自然取不到，回退 null。
        return (await getGroupMemberNames(bot, actor.chatId))[actor.providerUserId] ?? null;
      }
      return readFeishuUserDisplayName(bot, deps, actor.providerUserId);
    },

    // send：普通出站消息入口。所有分支最终都走“交互卡片”，而不是纯文本消息，
    // 因为飞书文本消息会把 Markdown 原样显示，与 Telegram 的渲染不一致。
    async send(bot, message) {
      // 先解析并校验回复锚点：话题内没有 replyToMessageId 时这里会抛 deliveryRejected，
      // 避免消息被错发到群主聊天。
      resolveFeishuReplyTarget(message);
      if (message.contentParts) {
        // native channel reply 的结构化校验：mention 渠道、文本一致性与长度都在这里收口。
        // schema.parse 失败会抛 ZodError，属于调用方 bug，不做降级。
        const parts = channelContentPartsSchema.parse(message.contentParts);
        if (
          // 选择消息不允许携带 contentParts：两者叠加会让卡片和文本各说一套。
          message.selection ||
          // native reply 只在群会话（oc_）成立，open_id 私聊没有 @ 语义。
          !message.providerUserId.startsWith("oc_") ||
          // mention 的 channel 必须是本渠道，防止把其他渠道的 @ 语法发到飞书。
          parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider) ||
          // 拼接后的纯文本必须与 message.text 完全一致，防止“校验一套、发送另一套”。
          channelContentText(parts) !== message.text ||
          // 飞书卡片正文有长度上限；超过 2000 的 native reply 直接拒绝而不是截断。
          message.text.length > 2000
        )
          throw Object.assign(new Error("Invalid native channel reply"), {
            // 标记为“平台拒绝”而非网络错误：上层不会重试，避免重复发送。
            deliveryRejected: true,
          });
      }
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        // 持久化投递（有 deliveryId）必须让上层知道失败，才能重试；否则静默返回会显示“已发送”。
        if (message.deliveryId)
          throw Object.assign(new Error("Feishu credentials unavailable"), {
            deliveryRejected: true,
          });
        // 非持久化消息（如临时提示）允许静默丢弃：没有可重试的投递记录。
        return;
      }
      if (message.selection) {
        // 选择消息是一张带按钮的卡片；queue.cancel 需要回传 message id 供后续更新/撤回。
        const providerMessageId = await sendReplyCard(
          bot,
          token,
          message,
          message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        );
        return message.selection.action === "queue.cancel" && providerMessageId
          ? { providerMessageId }
          : undefined;
      }
      let partIndex = 0;
      let providerMessageId: string | null = null;
      // splitFeishuText 按 1900 字符切块（低于飞书上限），每块单独一张卡。
      // [权衡] 不用单卡多段：单条消息有总量上限，长回复会被平台整条拒绝。
      for (const text of splitFeishuText(message.text)) {
        // Bugfix: Feishu 普通文本消息会把 Markdown 原样展示，和 Telegram 的 Markdown 回复不一致。
        // 改用交互卡片的 markdown 元素承载普通回复，选择消息也继续复用同一套卡片结构。
        providerMessageId = await sendReplyCard(
          bot,
          token,
          message,
          buildFeishuInteractiveCardPayload({
            ...message,
            text,
            // @ 只在第一段带：重复 @ 会让同一用户被提及多次并触发多次通知。
            mentionedUserIds: partIndex === 0 ? message.mentionedUserIds : undefined,
            // 分段后 selection 必须清空：按钮只应出现在单张卡上，否则会出现多个可点击副本。
            selection: undefined,
          }),
          // uuid 按段派生：同一 delivery 的分段互不重复，重试同一段又保持幂等（INV-02）。
          message.deliveryId ? `${message.deliveryId.slice(0, 40)}-${partIndex}` : undefined,
        );
        partIndex += 1;
      }
      // 只有持久化投递才回传 message_id；普通消息返回 undefined，避免上层误以为可后续编辑。
      return message.deliveryId && providerMessageId ? { providerMessageId } : undefined;
    },

    // createStreamingReplyCard：创建流式卡片并返回句柄；拿不到 message_id 时返回 null。
    // 元素预算与分段由上层调用 splitStreamingReplyCardStates 保证（INV-06），这里不做二次切分。
    async createStreamingReplyCard(bot, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      // 无凭据返回 null 而不是抛错：流式回复可以降级为最终一次性消息。
      if (!token) {
        return null;
      }
      const providerMessageId = await sendCard(
        bot,
        token,
        state.providerUserId,
        buildFeishuStreamingCardPayload(state),
        signal,
      );
      // INV-02：没有 provider id 就无法后续 PATCH，必须按“创建失败”返回 null 而非伪造句柄。
      return providerMessageId ? { providerMessageId } : null;
    },

    // updateStreamingReplyCard：用同一份 state 重建卡片内容后 PATCH。
    // 无 message_id 可更新（句柄来自创建回执）；无 token 时静默返回，等待下一轮节流重试。
    async updateStreamingReplyCard(bot, handle, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return;
      }
      // 每次都整卡重建而不是增量 patch 元素：飞书 PATCH 语义是整卡替换，
      // 增量拼接需要维护服务端元素索引，反而更容易与本地状态不一致。
      await updateCard(bot, token, handle, buildFeishuStreamingCardPayload(state), signal);
    },

    // createTransientInteractionCard：创建临时交互卡（权限确认、问答等短生命周期卡片）。
    // 与 send 的区别：它只接受群会话与 native reply 形状，且卡片必须在会话结束后被显式撤回。
    async createTransientInteractionCard(bot, message) {
      // 与 send 相同的话题锚点校验：临时卡也曾因跳过路由而发到群主聊天。
      resolveFeishuReplyTarget(message);
      if (message.contentParts) {
        const parts = channelContentPartsSchema.parse(message.contentParts);
        // 与 send 保持完全一致的拒绝条件，避免两条发送路径出现行为差异。
        if (
          message.selection ||
          !message.providerUserId.startsWith("oc_") ||
          parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider) ||
          channelContentText(parts) !== message.text ||
          message.text.length > 2000
        )
          throw Object.assign(new Error("Invalid native channel reply"), {
            deliveryRejected: true,
          });
      }
      const token = await readTenantAccessToken(bot, deps);
      // 临时卡拿不到凭据返回 null：调用方可选择直接以文本形式给出提示。
      if (!token) {
        return null;
      }
      const providerMessageId = await sendReplyCard(
        bot,
        token,
        message,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
      // 没有 id 就无法撤回，按创建失败处理（INV-02）。
      return providerMessageId ? { providerMessageId } : null;
    },

    // updateTransientInteractionCard：原地更新临时卡（如问答进入下一题）。
    // 用 PATCH 而不是“撤回旧卡 + 发新卡”，避免会话里留下明显的撤回痕迹。
    async updateTransientInteractionCard(bot, handle, message) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await updateCard(
        bot,
        token,
        handle,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
    },

    // deleteTransientInteractionCard：撤回临时卡；由上层在问答结束/超时后调用。
    // 删除失败会抛错（见 deleteFeishuInteractiveMessage），调用方据此判断旧选项是否仍可点击。
    async deleteTransientInteractionCard(bot, handle) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await deleteFeishuInteractiveMessage(bot, token, handle);
    },

    // updateInputReaction：更新“用户输入已被接收”的状态 reaction。
    // 先登记 bot 配置再调用串行化 updater：updater 回调内只能拿到 key，需要靠这张表找回凭据。
    async updateInputReaction(bot, messageId, state) {
      const botKey = JSON.stringify([bot.provider, bot.id, bot.feishuAppId, bot.credentialRef]);
      reactionBots.set(botKey, bot);
      // 复合 key 由 botKey + messageId 组成，与 updater 内的解析顺序严格对应。
      await updateReaction(JSON.stringify([botKey, messageId]), state);
    },

    // sendTyping：一次性 typing 反馈，用于命令等非流式场景。
    async sendTyping(bot, target) {
      // 没有触发消息就没有可挂 reaction 的载体；静默返回而不是报错。
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: 飞书/Lark 普通命令不会进入长任务 stream，之前只实现 startTyping/stopTyping，
      // 所以 /状态、/项目 等命令没有任何处理中反馈。这里只加 Typing reaction，删除由 BotService 在同步回复发送完成后显式收口。
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    // startTyping：流式/长任务开始时的 typing 标记，语义上等价于 sendTyping。
    async startTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: 飞书没有原生 typing 状态，只能用 Typing reaction 模拟。
      // reaction 不会自动消失，所以必须记录 reaction_id，任务结束或进入权限等待时再删除。
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    // stopTyping：撤销 typing 标记；未 start 或已撤销时是幂等 no-op（INV-07）。
    async stopTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      await deleteFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    // acknowledgeCallback：处理完卡片点击后，用 callback token 原地改写原卡片。
    // 飞书按钮不会像 Telegram inline keyboard 那样自动消失，必须显式移除选项，
    // 否则旧选项会继续留在会话里被重复点击（INV-11 的交互归属由业务层判定，这里只做呈现）。
    // 失败抛错：调用方需要知道“旧卡片仍可点”，从而决定是否重试或提示用户。
    async acknowledgeCallback(bot, payload, text, message, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      // 四个输入都来自回调 payload：card update token / open_ids / 原问题文案。
      const cardUpdateToken = readFeishuCardUpdateToken(payload);
      const openIds = readFeishuCardUpdateOpenIds(payload);
      const originalText = readFeishuCardOriginalText(payload);
      // 无 token 或没有 update token 时无法原地更新，直接返回（非 elicitation 且无文本同理）。
      if (!token || !cardUpdateToken || (!text?.trim() && !message?.elicitation)) {
        return;
      }
      // Bugfix: 飞书卡片按钮点击后不会像 Telegram inline keyboard 一样自动消失。
      // 使用回调携带的 card update token 更新原卡片为处理结果，避免旧选项继续留在聊天里被重复点击。
      // 非共享卡片延时更新还需要带 open_ids，否则飞书会返回 300090，旧卡片会继续留在会话里。
      // Bugfix: 用户选择后应保留原问题文案并移除按钮；仅依赖 WebSocket 回调 return 的卡片更新不稳定。
      // 因此即使按钮 value 里带了原文，也必须继续调用 card/update，只是更新文案优先使用原文。
      const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
        `${getFeishuBaseUrl(bot)}/open-apis/interactive/v1/card/update`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          // signal 允许上层在用户快速连续点击时放弃过期更新，避免旧状态覆盖新状态。
          signal,
          body: JSON.stringify({
            token: cardUpdateToken,
            // Bugfix: Card JSON 2.0 根节点不接受 open_ids；把 open_ids 塞进 card 会触发
            // “unknown property: open_ids” 并导致按钮点击后原卡片无法移除选项。
            // 空数组不输出该字段：共享卡片不需要 open_ids，传空会被当成非法值。
            ...(openIds.length > 0 ? { open_ids: openIds } : {}),
            // 修复原因：新建下一题再撤回旧卡会在飞书会话中显示明显的撤回痕迹。
            // callback token 是本次点击对应的权威原地更新能力，问答推进和终态都复用同一张卡。
            card: message?.elicitation
              ? buildFeishuElicitationCardPayload(message)
              : buildFeishuInteractiveCardPayload({
                  botId: bot.id,
                  provider: bot.provider,
                  // providerUserId 置空：这是原地更新，不需要重新计算投递目标。
                  providerUserId: "",
                  // Bugfix: 飞书按钮点击后业务结果会另发一条消息；原卡片只需要移除选项按钮。
                  // 之前把原卡片改成结果文案，飞书侧会出现额外状态变化，也不符合用户对“选项消失”的预期。
                  text: originalText?.trim() || (text ?? ""),
                }),
          }),
        },
      );
      // 与发送路径一致：HTTP 与业务码分开判定，前者可重试、后者通常不可重试。
      if (!response.ok) {
        throw new Error(`Feishu update interactive card failed: HTTP ${response.status}`);
      }
      const result = response.payload ?? {};
      if (result.code !== 0) {
        throw new Error(result.msg || "Feishu update interactive card failed.");
      }
      // elicitation 表示“问答已推进”，需要上层继续等待下一个问题；普通卡片更新无需额外结果。
      return message?.elicitation ? { handled: true } : undefined;
    },

    // downloadAttachment：下载消息资源（图片/文件/视频）为内存字节。
    // 校验：调用方 signal、HTTP 状态、30 秒超时；不写磁盘，落盘与净化由上层负责（INV-09）。
    // [失败路径] 缺 fileId 或消息 id 时返回 null：无法定位资源，重试也不会成功。
    async downloadAttachment(bot, attachment, actor, signal) {
      // [资源] 入口检查取消：已取消的下载不应再发起网络请求（INV-12）。
      signal?.throwIfAborted();
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token || !attachment.providerFileId || !actor?.providerMessageId) {
        return null;
      }
      // 独立 controller 承接 30 秒超时；与调用方 signal 用 AbortSignal.any 合并，
      // 任一来源中止都能立刻断开连接（避免慢响应长期占用 socket）。
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetch(
          // type 参数决定资源接口的读取通道：image→image，video→media，其余按原 kind（file/audio）。
          // 消息 id 优先取附件自带的 resourceMessageId，保证引用/归档附件回到真正的宿主消息。
          `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(attachment.providerMetadata?.resourceMessageId ?? actor.providerMessageId)}/resources/${encodeURIComponent(attachment.providerFileId)}?type=${attachment.kind === "image" ? "image" : attachment.kind === "video" ? "media" : attachment.kind}`,
          {
            headers: {
              authorization: `Bearer ${token}`,
            },
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          },
        );
        // [失败路径] 资源接口的错误响应体会是 JSON 错误而不是字节，必须先判状态再读 body，
        // 否则会把错误 JSON 当成附件内容交给上层（INV-04）。
        if (!response.ok) {
          throw new Error(`Feishu attachment download failed: HTTP ${response.status}`);
        }
        return {
          attachment,
          // [权衡] 整块 arrayBuffer 读入内存：本层没有分块/体积阈值，超时是唯一护栏；
          // 超大文件会一次性占用内存，体积限制需要在调用方收口（风险点，未在本层实现）。
          data: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error) {
        // signal?.throwIfAborted() 先暴露取消，再判 AbortError 转成本层超时，两者处理策略不同。
        signal?.throwIfAborted();
        if ((error as { name?: unknown })?.name === "AbortError") {
          // Bugfix: 飞书资源接口偶发长时间不返回，必须让 bot 回调在可预期时间内给用户失败提示。
          throw new Error("Feishu attachment download timed out.");
        }
        // 其他错误原样抛出：保留 HTTP 状态与服务端信息，便于诊断。
        throw error;
      } finally {
        // [资源] 无论成功/失败/取消都清定时器，否则进程会被 30 秒定时器拖住。
        clearTimeout(timeout);
      }
    },

    // parseCallback：把入站 payload 解析成统一消息数组。
    // 只做形状分派，权限与去重由上层负责；无法识别时返回空数组而不是抛错（INV-03 的 fail-open）。
    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      // 没有 botId 就无法归档到具体渠道实例；返回空数组留待上层记录诊断。
      if (!botId) {
        return [];
      }
      // 先按文本消息解析，失败再按卡片动作解析：两种 payload 结构互斥，顺序分派即可。
      const message = readFeishuTextMessage(botId, payload) ?? readFeishuCardAction(botId, payload);
      return message ? [message] : [];
    },
  };
}
