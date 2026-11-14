// INV-01 登录入口固定四项：守住位置 items 数组；改错故障 缺少手填密钥入口。
// INV-02 两项 OAuth 与两项密钥成对：守住位置 provider 维度；改错故障 只有一个提供方可登录。
// INV-03 选择器不可过滤：守住位置 filterable 假值；改错故障 用户误用过滤丢掉入口。
// INV-04 文案全部走 i18n：守住位置 getZCodeCopy；改错故障 出现硬编码英文。
// INV-05 密钥输入必须掩码：守住位置 mask 为真；改错故障 密钥明文显示在终端。
// INV-06 每项命令名即分发标识：守住位置 command 字段；改错故障 回车后无法路由。
// INV-07 关键词覆盖提供方与方式：守住位置 keywords 数组；改错故障 搜索命中率下降。
// INV-08 待定态文案四项齐全：守住位置 pending 对象；改错故障 等待时提示缺行。
// INV-09 裸登录只返回引导文案：守住位置 loginSetupResponse；改错故障 无参数调用触发副作用。
// INV-10 账号显示名有回退链：守住位置 name 到 user_id；改错故障 空名字显示空白。
// INV-11 浏览器失败只提示不报错：守住位置 browserNote；改错故障 登录成功却报失败。
// INV-12 结果拼接顺序固定：守住位置 数组顺序；改错故障 关键信息被截断。
// INV-13 手填结果按提供方取名：守住位置 三元判断；改错故障 BigModel 显示成 Z.AI。
// INV-14 授权事件缺少回调即跳过：守住位置 onEvent 判断；改错故障 无头场景抛错。
// INV-15 展示序号不参与顺序保证：守住位置 sequenceNumber 常量；改错故障 调用方误判时序。
// INV-16 事件标识随机生成：守住位置 randomUUID；改错故障 多次推送互相覆盖。
// INV-17 参数首词决定分支：守住位置 kind 判断；改错故障 未知命令被吞进密钥。
// INV-18 密钥允许含空白：守住位置 剩余参数拼接；改错故障 粘贴带空格密钥被截断。
//
// 模块职责：构造 /login 选择器，并格式化登录结果、授权消息与密钥参数。
// 状态所有权：无状态；所有函数均为纯构造或纯格式化。
// 阅读顺序：先看选择器四项，再看结果文案，最后看参数解析。
import type { TuiSelection, TuiSubmitPrompt } from "@zcode/tui";
import { getZCodeCopy } from "@zcode/i18n";
import type { CommandCenterApp, CommandCenterLoginResult } from "./types.js";
import { randomUUID } from "node:crypto";

// 构造 /login 选择器：四个入口（Z.AI/BigModel × OAuth/手填 API key），文案全部走 i18n。
// OAuth 项点击后跳浏览器授权，API key 项进入掩码输入；选择器不可过滤（数量少且语义不同）。
// 四项入口按提供方与方式排列。
// OAuth 项只带待定态。
// 密钥项额外带掩码输入配置。
// 文案对象整体来自 i18n。
// locale 只传给 getZCodeCopy，不影响 command/id/keywords。
export function buildLoginSelection(locale?: string): TuiSelection {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: false,
    help: copy.help,
    items: [
      {
        command: "/login zai-coding-plan",
        id: "zai-coding-plan",
        keywords: ["zai", "oauth", "coding", "plan"],
        pending: {
          cancelStatus: copy.pending.cancelStatus,
          help: copy.pending.help,
          primary: copy.options.zaiOauth.pendingPrimary,
          secondary: copy.options.zaiOauth.pendingSecondary,
          status: copy.pending.status,
        },
        primary: copy.options.zaiOauth.primary,
        secondary: copy.options.zaiOauth.secondary,
      },
      {
        command: "/login bigmodel-coding-plan",
        id: "bigmodel-coding-plan",
        keywords: ["bigmodel", "oauth", "coding", "plan"],
        pending: {
          cancelStatus: copy.pending.cancelStatus,
          help: copy.pending.help,
          primary: copy.options.bigmodelOauth.pendingPrimary,
          secondary: copy.options.bigmodelOauth.pendingSecondary,
          status: copy.pending.status,
        },
        primary: copy.options.bigmodelOauth.primary,
        secondary: copy.options.bigmodelOauth.secondary,
      },
      {
        command: "/login zai-coding-plan-api-key",
        id: "zai-coding-plan-api-key",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.options.zaiApiKey.inputPrimary,
          secondary: copy.options.zaiApiKey.inputSecondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        keywords: ["zai", "api", "key", "manual"],
        primary: copy.options.zaiApiKey.primary,
        secondary: copy.options.zaiApiKey.secondary,
      },
      {
        command: "/login bigmodel-coding-plan-api-key",
        id: "bigmodel-coding-plan-api-key",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.options.bigmodelApiKey.inputPrimary,
          secondary: copy.options.bigmodelApiKey.inputSecondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        keywords: ["bigmodel", "api", "key", "manual"],
        primary: copy.options.bigmodelApiKey.primary,
        secondary: copy.options.bigmodelApiKey.secondary,
      },
    ],
    prompt: copy.prompt,
    title: copy.title,
  };
}

// 返回裸 /login 的引导文案（本地化），不产生副作用。
export function loginSetupResponse(locale?: string): string {
  return getZCodeCopy(locale).tui.loginSetup.response;
}

// 格式化 Z.AI OAuth 登录结果：账号显示名优先 name/email/user_id；浏览器打开失败时附加原因，
// 但登录本身可能已成功，因此只提示而不报错。credentialsPath/configPath 为落盘位置，便于排查。
// label 依次试 user.name 与 user.email 与 user.user_id 取首个非空值。
// browser 存在且 opened 为 false 时把 reason 追加到末行 Model selection。
// 返回数组固定四行：Configured、Model、Credentials、Model selection。
// credentialsPath 与 configPath 原样输出，不做相对化或省略。
// 本函数不做脱敏，密钥类内容不会进入这两个路径字段。
export function formatLoginResult(result: CommandCenterLoginResult): string {
  const label = result.user.name || result.user.email || result.user.user_id;
  const browserNote =
    result.browser && !result.browser.opened
      ? `\nBrowser open failed: ${result.browser.reason ?? "unknown error"}`
      : "";

  return [
    `Configured Z.AI Coding Plan as ${label}.`,
    `Model: ${result.model}`,
    `Credentials: ${result.credentialsPath}`,
    `Model selection: ${result.configPath}${browserNote}`,
  ].join("\n");
}

// 格式化手动配置结果（BigModel/Z.AI Coding Plan）：providerId 决定展示名，附模型与配置路径。
export function formatProviderSetupResult(result: {
  configPath: string;
  model: string;
  providerId: "bigmodel" | "zai";
}): string {
  const provider = result.providerId === "bigmodel" ? "BigModel" : "Z.AI";
  return [
    `Configured ${provider} Coding Plan.`,
    `Model: ${result.model}`,
    `Model selection: ${result.configPath}`,
  ].join("\n");
}

// 通过 session 事件把授权 URL 推给 TUI/客户端：无 onEvent 时静默跳过（headless 场景）。
// sequenceNumber/时间戳由本函数伪造（0/当前时间），仅用于展示，不参与顺序保证；
// 事件 id 用随机 UUID 避免同一次登录多次推送时冲突。
export async function emitLoginAuthorizeMessage(
  options: Parameters<TuiSubmitPrompt>[1],
  authorizeUrl: string,
  providerName: string,
  session: Pick<CommandCenterApp, "sessionId" | "traceId">,
): Promise<void> {
  const onEvent = options.onEvent;
  if (!onEvent) return;

  await onEvent({
    id: `local-login-authorize-${randomUUID()}` as never,
    payload: {
      content: [
        `Open this URL to sign in with ${providerName}:`,
        "",
        authorizeUrl,
        "",
        "After authorization, return here and I will finish the login automatically.",
      ].join("\n"),
    },
    sequenceNumber: 0,
    sessionId: session.sessionId as never,
    timestamp: new Date(),
    traceId: session.traceId as never,
    type: "assistant_message" as never,
  });
}

// 解析 /login 的 API key 形式：首词必须是两种已知 kind，否则返回 null（交给其他登录分支处理）。
// apiKey 取剩余全部参数并按空格拼接，允许粘贴带空白的密钥；providerId 由 kind 前缀推导。
// kind 必须等于 zai-coding-plan-api-key 或 bigmodel-coding-plan-api-key。
// kind 未命中上面两种时返回 null，由其他 /login 分支接手。
// rest.join(" ").trim() 保留密钥内部空格。
// providerId 由 kind.startsWith("bigmodel") 决定。
export function parseApiKeyLoginArgs(args: string): {
  apiKey: string;
  kind: "bigmodel-coding-plan-api-key" | "zai-coding-plan-api-key";
  providerId: "bigmodel" | "zai";
} | null {
  const [kind, ...rest] = args.split(/\s+/u);
  if (kind !== "zai-coding-plan-api-key" && kind !== "bigmodel-coding-plan-api-key") {
    return null;
  }
  return {
    apiKey: rest.join(" ").trim(),
    kind,
    providerId: kind.startsWith("bigmodel") ? "bigmodel" : "zai",
  };
}
