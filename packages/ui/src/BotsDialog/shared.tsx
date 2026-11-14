// INV-01 全部工作区用空列表表示：守住位置 工作区判定；改错故障 新工作区默认不可见。
// INV-02 绑定码有效期复用共享常量：守住位置 常量再导出；改错故障 前后端倒计时不一致。
// INV-03 机器人父地址固定：守住位置 父地址常量；改错故障 引导跳到错误页面。
// INV-04 展示名去空白后回退：守住位置 展示名函数；改错故障 空白名显示为空。
// INV-05 绑定码状态四项齐全：守住位置 状态类型；改错故障 倒计时缺少起始时间。
// INV-06 飞书注册含双域名：守住位置 域名与轮询域名；改错故障 国际版轮询错域名。
// INV-07 微信注册无域名：守住位置 状态联合类型；改错故障 多余字段进入状态机。
// INV-08 渠道图标按来源映射：守住位置 嵌套三元；改错故障 渠道显示通用机器人图标。
// INV-09 未知来源回退通用图标：守住位置 末尾兜底；改错故障 图标区域为空。
// INV-10 钩子来源单独图标：守住位置 钩子分支；改错故障 钩子显示机器人脸。
// INV-11 图标对读屏隐藏：守住位置 隐藏属性；改错故障 读屏朗读装饰图。
// INV-12 图标尺寸可被覆盖：守住位置 类名合并；改错故障 调用方无法调整大小。
// INV-13 运行文案优先本地化键：守住位置 消息标识判断；改错故障 多语言环境显示英文。
// INV-14 无格式化再退原始消息：守住位置 空值合并顺序；改错故障 无格式函数时文案为空。
// INV-15 运行点按状态分色：守住位置 状态判断顺序；改错故障 错误与轮询同色。
// INV-16 未启用使用边框色：守住位置 末尾分支；改错故障 停用机器人显示活跃色。
// INV-17 倒计时向上取整到秒：守住位置 取整与下界；改错故障 倒计时出现负数。
// INV-18 默认命令全开：守住位置 返回值七项；改错故障 新机器人默认禁用命令。
//
// 模块职责：机器人设置弹窗共享的类型、常量与展示工具。
// 状态所有权：无状态；注册与绑定状态由上层持有。
// 阅读顺序：先看状态类型与常量，再读展示名与图标，最后看运行文案与倒计时。
import { Bot, Webhook } from "lucide-react";
import type {
  BotConfig,
  BotServiceStatus,
  BotWorkspaceRef,
} from "@zcode/shared";
import { ALL_BOT_WORKSPACES, BOT_BIND_CODE_TTL_MS } from "@zcode/shared";
import {
  DingDingChannelIcon,
  DiscordChannelIcon,
  FeishuChannelIcon,
  TelegramChannelIcon,
  WeComChannelIcon,
  WeixinChannelIcon,
} from "@/assets/channel-icons/index.js";
import type { BotProviderEntryId } from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";

export type BindCodeState = {
  botId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
};

export type FeishuRegistrationState = {
  botId: string;
  deviceCode: string;
  qrUrl: string;
  qrDataUrl: string | null;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
  status: "pending" | "success" | "access_denied" | "expired" | "error";
  message?: string;
};

export type WeixinRegistrationState = {
  botId: string;
  qrCode: string;
  qrUrl: string;
  qrDataUrl: string | null;
  interval: number;
  expiresAt: number;
  status: "pending" | "scanned" | "success" | "expired" | "error";
  message?: string;
};

export const BIND_CODE_TTL_MS = BOT_BIND_CODE_TTL_MS;
export const TELEGRAM_BOTFATHER_URL = "https://t.me/BotFather";

export function isAllWorkspacesAllowed(
  allowedWorkspaces: readonly string[],
): boolean {
  return (
    allowedWorkspaces.length === 0 ||
    allowedWorkspaces.includes(ALL_BOT_WORKSPACES)
  );
}

export function formatBotDisplayName(
  name: string,
  fallbackName: string,
): string {
  return name.trim() || fallbackName;
}

// ProviderIcon 按 provider 渠道挑选 iconSrc，未列来源回退 Bot 图标。
// provider 不在列表内时渲染通用 Bot 图标。
// provider 为 webhook 时用 Webhook 专用图标。
// 图片图标带 aria-hidden，对读屏隐藏。
// 尺寸由 className 与 cn("size-4") 合并，调用方可覆盖。
export function ProviderIcon({
  provider,
  className,
}: {
  provider?: BotProviderEntryId | "new";
  className?: string;
}) {
  const iconSrc =
    provider === "telegram"
      ? TelegramChannelIcon
      : provider === "weixin"
        ? WeixinChannelIcon
        : provider === "feishu" || provider === "lark"
          ? FeishuChannelIcon
          : provider === "dingding"
            ? DingDingChannelIcon
            : provider === "discord"
              ? DiscordChannelIcon
              : provider === "wecom"
                ? WeComChannelIcon
                : null;

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        aria-hidden="true"
        className={cn("size-4 object-contain", className)}
      />
    );
  }

  if (provider === "webhook") {
    return <Webhook className={cn("size-4", className)} />;
  }
  return <Bot className={cn("size-4", className)} />;
}

// runtimeText 先看 runtime.messageId 与 formatRuntimeMessage，有则本地化。
// 缺 formatRuntimeMessage 时退回 runtime.message 原文。
// message 为空再退 runtime.status 字符串。
// 最后按 enabled 给 "enabled" 或 "disabled" 默认词。
// runtimeText 不缓存结果，每次调用都重新计算。
export function runtimeText(
  runtime: BotServiceStatus["botRuntime"][number] | undefined,
  enabled: boolean,
  formatRuntimeMessage?: (id: string) => string,
): string {
  if (runtime?.messageId && formatRuntimeMessage) {
    return formatRuntimeMessage(runtime.messageId);
  }
  return (
    runtime?.message ?? runtime?.status ?? (enabled ? "enabled" : "disabled")
  );
}

// runtimeDot 对 status 为 error 的返回 bg-destructive。
// status 为 polling 或 connected 时返回 bg-success。
// enabled 且状态未知时返回 bg-foreground-subtle。
// 未启用时返回 bg-border。
// 判断顺序按严重度从高到低，error 最先命中。
export function runtimeDot(
  runtime: BotServiceStatus["botRuntime"][number] | undefined,
  enabled: boolean,
): string {
  if (runtime?.status === "error") return "bg-destructive";
  if (runtime?.status === "polling" || runtime?.status === "connected")
    return "bg-success";
  if (enabled) return "bg-foreground-subtle";
  return "bg-border";
}

// formatBindCountdown 把 ms 除以 1000 后向上取整。
// Math.max 把负数夹到零，避免显示负倒计时。
// 结果拼上 s 后缀，固定为秒单位。
// 不走 intl 本地化，数字直接拼进返回值模板。
// formatBindCountdown 是纯函数，输出只由 ms 决定。
export function formatBindCountdown(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

export function createDefaultCommands(): BotConfig["allowedCommands"] {
  return {
    status: true,
    new: true,
    workspace: true,
    model: true,
    mode: true,
    thoughtLevel: true,
    reply: true,
  };
}
