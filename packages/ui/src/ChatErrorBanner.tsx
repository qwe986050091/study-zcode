// ChatErrorBanner：聊天错误横幅，把 ZCodeUiError 投影成可读文案与可操作按钮组。
// 负责：错误 code 到展示文案的本地化决策、横幅显隐判定、复制/反馈/详情/重试/换模型等按钮的组装。
// 不负责：产生错误、重试请求本身、写反馈后端、模型配置持久化；这些都在上层调用方与 services 层。
// 不负责：错误详情的内嵌展开排版（已迁到 Dialog），也不负责 traceId 的生成与采集。
//
// 不变量（每条都对应一个容易被顺手改掉的点）：
// INV-01 断言：远端连接失败码命中时文案必须优先走 formatRemoteConnectionError —— 守住它的位置：resolveChatErrorBannerDisplayMessage 的首个分支 —— 改错故障：远端断连退回通用 message，用户看不到有效指引也不知道要重连。
// INV-02 断言：缺模型判定只按 error.code 进行，绝不看 message —— 守住它的位置：isModelConfigMissingError —— 改错故障：UNKNOWN 包装错误的 message 撞上同段文本被误判，复制与反馈入口整组消失。
// INV-03 断言：modelConfigTarget 只影响措辞，配置与升级动作始终指向本机 —— 守住它的位置：文案 id 三元表达式与按钮回调 —— 改错故障：远端场景引导用户去远端改配置，改完仍不下发。
// INV-04 断言：未知命令解析失败时必须原样返回 message —— 守住它的位置：CLAUDE_UNKNOWN_COMMAND 分支的 parsed 判空 —— 改错故障：返回空串后横幅空白，用户也无内容可复制。
// INV-05 断言：服务商业务码解析顺序恒为请求验证码、峰谷券过期、原始 code —— 守住它的位置：providerBusinessCode 的空值合并链 —— 改错故障：顺序调换后过期券提示被通用文案覆盖，用户按错指引操作。
// INV-06 断言：只有 LOCALIZED_ERROR_CODES 白名单内的 code 才按 code 本地化 —— 守住它的位置：函数末尾三元 —— 改错故障：任意 code 直接拼 i18n key，缺翻译时界面露出 zcode.error.xxx。
// INV-07 断言：隐藏条件必须 code 与 message 同时命中 —— 守住它的位置：shouldSuppressChatErrorBanner 的布尔与 —— 改错故障：只按 code 隐藏会吞掉当前发送失败，用户以为请求没返回。
// INV-08 断言：隐藏分支必须位于组件内全部 hooks 调用之后 —— 守住它的位置：ChatErrorBanner 中 if 与 useState 的先后 —— 改错故障：提前 return null 会让 hooks 数量随错误类型变化，React 直接抛渲染错误。
// INV-09 断言：缺模型时只渲染升级与设置两个动作 —— 守住它的位置：三处 modelConfigMissing 条件 —— 改错故障：缺模型仍出现重试，用户反复触发注定失败的请求。
// INV-10 断言：远端连接失败时重试按钮让位给重连按钮 —— 守住它的位置：两组互斥的 remoteConnectionFailure 条件 —— 改错故障：同一横幅同时出现重连与重试，用户分不清哪个能恢复会话。
// INV-11 断言：详情按钮只在非缺模型且存在 detail 时出现 —— 守住它的位置：!modelConfigMissing 与 error.detail 的联合条件 —— 改错故障：detail 为空时弹出空弹窗，用户以为详情加载失败。
// INV-12 断言：详情从内嵌展开改为 Dialog，横幅恒为单行摘要 —— 守住它的位置：setDetailsDialogOpen 与 Dialog —— 改错故障：改回内嵌后长错误撑高消息区，聊天滚动位置跳动。
// INV-13 断言：横幅内所有动作按钮统一使用 Button 组件，不混用原生 button —— 守住它的位置：反馈、重连、重试、关闭等按钮 —— 改错故障：焦点态与禁用态脱离设计系统，并重新引入 Tooltip 状态链导致更新深度循环。
// INV-14 断言：剪贴板不可用时必须提前返回并提示失败 —— 守住它的位置：handleCopyError 的首个守卫 —— 改错故障：直接写剪贴板抛同步异常，点击后毫无反馈。
// INV-15 断言：复制与反馈正文都走统一模板构造函数 —— 守住它的位置：handleCopyError 与 handleOpenFeedback 的载荷 —— 改错故障：手工拼字符串后 TraceID 丢失，开发无法定位用户上报。
// INV-16 断言：反馈标题截断在 80 字符以内 —— 守住它的位置：handleOpenFeedback 的 title 表达式 —— 改错故障：超长标题撑破反馈表单标题栏，或被后端长度校验拒绝。
//
// 阅读顺序：文案决策 resolveChatErrorBannerDisplayMessage → 显隐判定 shouldSuppressChatErrorBanner → 主体渲染与按钮互斥 → buildErrorCopyText。
// 文案链的优先级就是线上可感知的正确性：远端断连、缺模型、未知命令、服务商业务码、可疑空结果、白名单 code、原始 message。
// 所有 i18n id 都是字面量，禁止拼接动态 id；缺翻译时宁可回退原文，也不要露出 key。
// 本文件无请求、无持久化、无日志；异步只有剪贴板写入与反馈面板打开，失败一律自行吞掉并 toast。
// TSX 约束：新增注释只能落在语句或声明层面，JSX 子节点与开标签属性之间一律不得插入。
// 与 CodingPlanEntryButton、feedbackStore、providerBusinessError 是单向依赖，不反向读取本文件的类型。
// 修改按钮可见性前先确认 props 全可选的组合语义，避免某些调用点整排动作按钮消失。
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
/**
 * ChatErrorBanner — 错误提示组件
 *
 * 显示 ZCode Agent 链路中的错误，带 traceId 方便排查。
 */
import { useState } from "react";
import {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import {
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_ERROR_HOOK_ICON,
} from "@zcode/shared/test-ids";
import { AnchorIcon, CopyIcon, InfoIcon, RocketIcon, SettingsIcon, X } from "lucide-react";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import type { IntlInstance } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { cn } from "./components/lib/utils.js";
import { toast } from "./components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getProviderBusinessErrorMessageId } from "@/lib/providerBusinessError.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";
import {
  isSuspiciousEmptyModelResultMessage,
  resolveOffPeakTicketExpiredBusinessCode,
  resolveRequestVerificationBusinessCode,
} from "@/lib/providerBusinessError.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

// [契约] 这是历史任务恢复时服务层写入的固定中文/英文兜底文案，只用于识别旧快照残留，不参与任何新错误的匹配。
// 两条必须保持完整原文：改用片段匹配会把当前新发生的模型下线提示一起隐藏掉。
// 新增语言版本需要同时补这里与 shouldSuppressChatErrorBanner 的判定，否则该语言界面下旧横幅会重新冒出来。
const HISTORICAL_MODEL_UNAVAILABLE_MESSAGES = [
  "历史任务使用的模型已不可用",
  "The model used by this historical task is no longer available",
];

// [契约] 白名单放的是「服务层 message 不可信、必须按 code 重新本地化」的错误码，不是全部可翻译错误码。
// 服务层 message 是跨进程兜底，可能已经写成中文；直接展示会让英文界面混入中文，所以这些 code 一律按 zcode.error.<code> 取文案。
// 未列入的错误继续展示原始 message，不要把新 code 全量塞进来，否则缺翻译时会直接露出 i18n key。
const LOCALIZED_ERROR_CODES = new Set([
  "TASK_OWNED_BY_OTHER_HOST",
  "STALE_TASK_OWNER_COMMAND",
  "NO_ACTIVE_TASK_OWNER",
  "OWNER_COMMAND_FAILED",
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  // 服务层错误 message 是跨进程兜底，不能作为最终 UI 语言来源。
  // 历史任务模型不可用要按稳定 code 本地化，避免英文界面显示中文提示。
  "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
  "ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED",
]);

// [契约] 三种大小写形态是历史版本与不同链路的真实产物，删任何一个都会让对应来源退回原始英文 message。
// 集合只服务结构化 code 匹配，不参与 message 文本匹配。
const MODEL_CONFIG_MISSING_CODES = new Set([
  "model_config_missing",
  "MODEL_CONFIG_MISSING",
  "ModelConfigMissing",
]);

// [契约] 只看 code 不看 message：包装错误的 message 可能恰好包含同一段文本，按文本判定会误伤可诊断错误。
// [失败路径] 判定为真会连带隐藏复制与反馈入口，因此这里宁可漏判保留原文，也不能错判。
function isModelConfigMissingError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  // Bugfix: 桌面端发送前 registry 为空时，agent 会退回 CLI config 并抛 Model config is missing。
  // 真实原因是“当前没有可用模型”，不能把 CLI 配置路径直接暴露给桌面用户。
  // 这里只按结构化 code 识别，避免 UNKNOWN/SEND_FAILED 等包装错误的可读 message
  // 碰巧包含同一段文本时被误判，并连带隐藏复制、反馈等诊断入口。
  return Boolean(error.code && MODEL_CONFIG_MISSING_CODES.has(error.code));
}

// [契约] 返回 null 表示「不像服务层兜底文案」，调用方必须原样返回 message，不能返回空串。
// 正则带 u 标志并匹配中文全角括号，是为了兼容服务层已本地化的旧快照；去掉全角分支会让参数永远解析不出来。
// 参数为空或纯空白时整个字段省略，下游据此选择无参数文案，避免出现只有前缀的空壳提示。
function parseClaudeUnknownCommandMessage(message: string): {
  command: string;
  args?: string;
} | null {
  const match = message.match(/Claude Code 未知命令\s+(\S+?)(?:（参数：([^）]+)）)?。/u);
  if (!match?.[1]) {
    return null;
  }

  return {
    command: match[1],
    ...(match[2]?.trim() ? { args: match[2].trim() } : {}),
  };
}

/**
 * 缺模型横幅的措辞目标。远端 workspace 的模型目录来自远端 Registry，但本机配置保存后
 * 会由 Provisioning 自动下发到远端，因此只区分措辞，配置/升级动作始终指向本机。
 */
// [契约] 两个取值只区分措辞，不改变动作指向：远端配置保存后由 Provisioning 下发，入口始终是本机设置。
// 新增取值必须先确认两处 i18n id 都存在，否则界面会直接显示 key 本身。
export type ChatErrorBannerModelConfigTarget = "local" | "remote";

// [契约] 唯一语言来源：横幅正文、复制内容、反馈标题、详情弹窗标题的文案都从这里出，不要在 JSX 或 handler 里另起一套判断。
// 分支顺序即优先级，调换任意相邻两支都会改变线上可感知的文案，例如缺模型会盖掉未知命令提示。
// 函数必须保持纯函数：只读 error、intl 与 modelConfigTarget，不读 store 不发请求，才能在 render 中直接调用。
// [权衡] 每次渲染重算而不加缓存：文案量级极小，缓存反而会在语言切换后短暂显示旧语言。
export function resolveChatErrorBannerDisplayMessage(
  error: ZCodeUiError,
  intl: IntlInstance,
  modelConfigTarget: ChatErrorBannerModelConfigTarget = "local",
): string {
  // [契约] 远端失败码必须最先解析：它的 message 由服务层生成，格式与本地错误完全不同。
  // 命中后立即返回，不再进入缺模型、未知命令等分支；把这段下移会让远端断连被当成普通模型错误。
  // 不要在这里写日志：横幅可能高频重渲染，日志会淹没真正的连接事件。
  const remoteCode = getRemoteConnectionFailureCode(error);
  if (remoteCode)
    return formatRemoteConnectionError({
      fallback: error.message,
      reasonCode: remoteCode,
      formatMessage: intl.formatMessage,
    });
  // [契约] 缺模型分支排在未知命令与业务码之前，因为它对应「当前没有可用模型」这一更基础的前置条件。
  // 文案 id 由 modelConfigTarget 决定，动作固定为本机设置与升级，不要在此处按远端改按钮。
  // [失败路径] 该分支返回后不再走后续兜底，若 id 缺失用户会看到 key 而不是可读提示。
  if (isModelConfigMissingError(error)) {
    return intl.formatMessage({
      id:
        modelConfigTarget === "remote"
          ? "chat.error.remoteNoAvailableModel"
          : "chat.error.noAvailableModel",
    });
  }

  // [契约] 服务层为兼容历史快照仍持久化中文兜底文案，UI 必须按稳定 code 重新本地化。
  // 解析失败即回退原始 message，绝不抛错也不返回空串；这一段是英文界面混入中文的唯一出口。
  // 有参与无参是两个不同 i18n id，合并会让带参数命令丢失参数信息。
  if (error.code === "CLAUDE_UNKNOWN_COMMAND") {
    const parsed = parseClaudeUnknownCommandMessage(error.message);
    if (!parsed) {
      return error.message;
    }

    // Bugfix: 服务层为了兼容历史快照仍持久化中文兜底文案，UI 需要按稳定 code
    // 重新本地化，否则英文界面会混入中文错误提示。
    return parsed.args
      ? intl.formatMessage(
          { id: "zcode.error.CLAUDE_UNKNOWN_COMMAND_WITH_ARGS" },
          { command: parsed.command, args: parsed.args },
        )
      : intl.formatMessage(
          { id: "zcode.error.CLAUDE_UNKNOWN_COMMAND" },
          { command: parsed.command },
        );
  }

  // [契约] 顺序固定为请求验证码、峰谷券过期、原始 code，空值合并只在前一项返回空时继续。
  // 调换顺序会让过期券提示被更泛的验证码文案覆盖，用户按错误指引反复去获取验证码。
  // 这里只解析出 code 不做展示，文案映射统一交给 getProviderBusinessErrorMessageId。
  const providerBusinessCode =
    resolveRequestVerificationBusinessCode(error.code, error.message) ??
    resolveOffPeakTicketExpiredBusinessCode(error.code, error.message) ??
    error.code;
  const providerBusinessMessageId = getProviderBusinessErrorMessageId(providerBusinessCode);
  if (providerBusinessMessageId) {
    return intl.formatMessage({ id: providerBusinessMessageId });
  }

  // [契约] 可疑空结果优先于白名单 code：这类错误往往 code 通用，但 message 已经没有任何信息量。
  // 改为直接展示 message 会让用户看到一段没有行动指引的技术描述。
  if (isSuspiciousEmptyModelResultMessage(error.message)) {
    return intl.formatMessage({ id: "zcode.error.modelSuspiciousEmpty" });
  }

  // [契约] 白名单命中才按 zcode.error.<code> 取文案，其余一律回退原始 message。
  // 不要去掉白名单直接拼 key：缺翻译时界面会出现 zcode.error.xxx 这种原始标识。
  // code 为空时由短路判断兜住，避免拼出 zcode.error.undefined 这种不存在的键。
  return error.code && LOCALIZED_ERROR_CODES.has(error.code)
    ? intl.formatMessage({ id: `zcode.error.${error.code}` })
    : error.message;
}

// [契约] 只有历史恢复残留的模型不可用提示才隐藏，必须 code 与 message 同时命中。
// 当前发送或草稿阶段的同类报错必须展示，否则用户看到请求没有返回却得不到任何反馈。
// [权衡] 用 includes 而非全等，是为了容忍服务层附加的前后缀；但也正因如此不能放宽到只匹配 code。
export function shouldSuppressChatErrorBanner(
  error: Pick<ZCodeUiError, "code" | "message">,
): boolean {
  // 只有历史恢复残留的模型不可用提示才隐藏；当前发送/草稿报错需要展示，
  // 否则 registry 移除模型后用户会看到“请求没返回”而没有任何可操作反馈。
  return Boolean(
    error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE" &&
    HISTORICAL_MODEL_UNAVAILABLE_MESSAGES.some((message) => error.message.includes(message)),
  );
}

// [契约] 受控展示组件：所有动作都是可选回调，本文件不持有错误状态、不发起重试、不写反馈。
// props 全可选意味着调用点组合差异很大，按钮可见性由 modelConfigMissing、remoteConnectionFailure 与回调存在性共同决定。
// 关闭与重试互不依赖：onDismiss 存在就渲染关闭，因此某些调用点可能既有关闭又有重试。
// 缺模型时整组操作收敛为升级与设置，这是唯一允许同时出现两个主按钮的分支。
// [权衡] 不在内部做错误去重或节流：错误身份由上层 error 对象决定，组件重复渲染是正常路径。
export function ChatErrorBanner({
  error,
  onRetry,
  retryLabel,
  retryDisabled,
  onDismiss,
  onOpenModelSettings,
  onOpenUpgrade,
  modelConfigTarget = "local",
  onReconnect,
  remoteKind,
}: {
  error: ZCodeUiError;
  onReconnect?: () => void;
  remoteKind?: string;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  onOpenModelSettings?: () => void;
  onOpenUpgrade?: () => void;
  modelConfigTarget?: ChatErrorBannerModelConfigTarget;
}) {
  // 只取 intl 做文案，不在这里订阅 locale 状态；语言切换由 Provider 重渲染本组件。
  // 下方所有 formatMessage 的 id 都是字面量，禁止拼接，否则容易产生静默回退。
  const { intl } = useZCodeIntl();
  // [契约] 用 selector 订阅 store 里的稳定函数引用，不订阅整个 store，避免反馈面板状态变化引起横幅重渲染。
  // `openFeedbackSubmit` 只允许在用户点击反馈按钮后调用，不得在渲染期触发。
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const actionButtonClassName = "shrink-0";
  const iconButtonClassName = "shrink-0";
  // [契约] 文案只算一次并复用：横幅正文、复制载荷、反馈标题与详情弹窗标题必须完全一致。
  // 各处理函数若各自重算，语言切换后可能出现正文与复制内容不同步。
  // 不要为了性能加缓存：它依赖 intl 实例，缓存陈旧会导致切换语言后仍显示旧文案。
  const localizedErrorMessage = resolveChatErrorBannerDisplayMessage(
    error,
    intl,
    modelConfigTarget,
  );
  const remoteConnectionFailure = Boolean(getRemoteConnectionFailureCode(error));
  const modelConfigMissing = isModelConfigMissingError(error);
  const hookBlocked = error.code === "fault.runtime.hookBlocked";
  // [契约] 这个提前返回必须在全部 hooks 调用之后，保证不同 error 之间 hooks 数量恒定。
  // 挪到 useState 之前会触发 React 的 hooks 顺序错误，整个会话面板白屏。
  // [失败路径] 隐藏是静默的，不 toast 也不记日志，因此判定条件必须足够窄。
  if (shouldSuppressChatErrorBanner(error)) {
    return null;
  }

  // [契约] 标题截断到 80 字符，模块名按远端类型分流，缺省落到模型调用报错。
  // 严重级别与是否带日志是固定策略，不随错误类型变化，改动会污染反馈分类统计。
  // 函数声明为 async 但内部并无等待：调用方用 void 丢弃返回值，失败提示交给 toast。
  const handleOpenFeedback = async () => {
    openFeedbackSubmit({
      title: localizedErrorMessage.slice(0, 80),
      type: "bug",
      module: remoteConnectionFailure
        ? remoteKind === "ssh"
          ? "SSH连接失败"
          : remoteKind === "wsl"
            ? "WSL连接失败"
            : "其它"
        : "模型调用报错",
      severity: "P2-中",
      includeLogs: true,
      description: buildErrorFeedbackDescription({
        message: localizedErrorMessage,
        detail: error.detail,
        traceId: error.traceId,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
  };

  // [契约] 先检查 navigator 与 clipboard 是否可用，不可用时直接提示失败并返回。
  // [失败路径] 写入异常必须被捕获并转成 toast，绝不能让 Promise 逃逸成未捕获拒绝。
  // 复制内容统一走 buildErrorCopyText，保证摘要、TraceID 与详情三段齐全。
  const handleCopyError = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "chat.error.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      // 错误横幅之前只能复制 TraceID，开发拿不到完整上下文。
      // 这里统一复制摘要、TraceID 和详情，方便用户一键转发完整报错信息。
      await navigator.clipboard.writeText(
        buildErrorCopyText({
          message: localizedErrorMessage,
          detail: error.detail,
          traceId: error.traceId,
          formatMessage: (id: string, values?: Record<string, string>) =>
            intl.formatMessage({ id }, values),
        }),
      );
      toast(intl.formatMessage({ id: "chat.error.copyFull.copied" }));
    } catch (copyError) {
      toast(
        intl.formatMessage(
          { id: "chat.error.copyFailed" },
          {
            error: copyError instanceof Error ? copyError.message : String(copyError),
          },
        ),
      );
    }
  };

  // [契约] 根节点始终渲染外层居中容器与内层卡片，不参与聊天区高度计算，也不额外占位。
  // 按钮区的显示条件互斥且由 modelConfigMissing 与 remoteConnectionFailure 组合决定，新增按钮必须同时确认这两条分支。
  // 详情放在 Dialog 内而不是横幅内嵌，是为了避免长文本撑高消息区导致滚动跳动。
  return (
    <div className="flex w-full justify-center">
      <div
        data-testid={TID_CHAT_ERROR_BANNER}
        data-error-code={error.code}
        className={cn(
          "w-full flex flex-wrap items-center gap-2 rounded-xl bg-surface backdrop-blur-md border border-border px-3 py-2",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground">
          {hookBlocked ? (
            <AnchorIcon
              aria-hidden="true"
              className="size-4 shrink-0"
              data-testid={TID_CHAT_ERROR_HOOK_ICON}
            />
          ) : (
            <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
          )}
          <div className="min-w-0 truncate font-medium">{localizedErrorMessage}</div>
        </div>

        {modelConfigMissing ? (
          <>
            {onOpenUpgrade ? (
              <CodingPlanEntryButton
                type="button"
                variant="default"
                size="sm"
                onClick={onOpenUpgrade}
                className={cn(
                  actionButtonClassName,
                  "button-gradient gap-1.5 text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
                )}
                aria-label={intl.formatMessage({
                  id: "chat.quota.action.upgrade",
                })}
              >
                <RocketIcon className="size-3.5" />
                {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
              </CodingPlanEntryButton>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenModelSettings}
              className={cn(actionButtonClassName, "gap-1.5")}
              aria-label={intl.formatMessage({ id: "chat.error.setModels" })}
            >
              <SettingsIcon className="size-3.5" />
              {intl.formatMessage({ id: "chat.error.setModels" })}
            </Button>
          </>
        ) : null}

        {!modelConfigMissing && error.detail ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={actionButtonClassName}
              data-testid={TID_CHAT_ERROR_DETAILS_BUTTON}
              onClick={() => {
                // 详情之前内嵌在 banner 里展开，长错误会把消息区直接撑高，聊天滚动也会突然跳动。
                // 改成 dialog 后，横幅只保留单行摘要，详细内容放到独立浮层里看，结构和交互都更稳定。
                setDetailsDialogOpen(true);
              }}
            >
              {intl.formatMessage({ id: "chat.error.expandDetails" })}
            </Button>
            <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle className="whitespace-pre-wrap">{localizedErrorMessage}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "chat.error.expandDetails" })}
                  </DialogDescription>
                </DialogHeader>
                <pre className="max-h-[60vh] overflow-auto rounded-xl border border-border bg-surface px-3 py-2 text-ui-base whitespace-pre-wrap text-foreground-subtle">
                  {error.detail}
                </pre>
              </DialogContent>
            </Dialog>
          </>
        ) : null}

        {!modelConfigMissing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleCopyError();
            }}
            className={cn(actionButtonClassName, "gap-1.5")}
            aria-label={intl.formatMessage({ id: "chat.error.copyFull" })}
          >
            <CopyIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.error.copyFull" })}
          </Button>
        ) : null}

        {/* Bugfix: 错误横幅本身就是异常态，不能再经过 Radix Tooltip 的 Popper/Slot 状态链。
            这里改成普通 Button，避免无可用模型等错误触发横幅时发生 Maximum update depth 循环。 */}
        {!modelConfigMissing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleOpenFeedback();
            }}
            // ChatErrorBanner 这里之前混用了原生 button，导致按钮体系、焦点态和禁用态都绕开了设计系统。
            // 统一收口到 Button 组件后，错误横幅里的所有操作按钮才能保持同一套交互和主题表现。
            className={cn(actionButtonClassName)}
            aria-label={intl.formatMessage({ id: "chat.error.feedback" })}
            title={error.traceId}
          >
            {intl.formatMessage({ id: "chat.error.feedback" })}
          </Button>
        ) : null}

        {remoteConnectionFailure && onReconnect ? (
          <Button variant="outline" size="sm" onClick={onReconnect}>
            {intl.formatMessage({ id: "remote.conversation.reconnect" })}
          </Button>
        ) : null}
        {!remoteConnectionFailure && !modelConfigMissing && onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retryDisabled}>
            {retryLabel ?? intl.formatMessage({ id: "chat.error.retry" })}
          </Button>
        ) : null}

        {onDismiss ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onDismiss}
            className={cn(iconButtonClassName)}
            title={intl.formatMessage({ id: "chat.error.dismiss" })}
            aria-label={intl.formatMessage({ id: "chat.error.dismiss" })}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// [契约] 以模板数组拼装，空串用于分段；详情与 TraceID 缺失时对应行整体剔除。
// 过滤时用类型守卫保证 join 前没有空值，否则分段会塌成连续空行，反馈正文结构变乱。
// 这里调用的模板 id 来自 i18n，不要在别处复制这套拼接逻辑，否则文案版本会漂移。
function buildErrorCopyText({
  message,
  detail,
  traceId,
  formatMessage,
}: {
  message: string;
  detail?: string;
  traceId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  return [
    formatMessage("feedback.submit.template.section.copyErrorHeading"),
    "",
    formatMessage("feedback.submit.template.section.errorSummary"),
    message,
    "",
    traceId ? formatMessage("feedback.submit.template.section.errorTraceId", { traceId }) : null,
    detail
      ? ["", formatMessage("feedback.submit.template.section.errorDetail"), detail].join("\n")
      : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
