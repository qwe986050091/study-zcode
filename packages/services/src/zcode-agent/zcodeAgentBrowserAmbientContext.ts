// 浏览器 ambient context：只读采集 provider 侧浏览器状态，作为 prompt 的附带事实。
// 任何失败都退化为 undefined，绝不因为 UI 状态异常阻断真实对话。
import { randomUUID } from "node:crypto";
import {
  browserCommandResultSchema,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  type ZCodeBrowserAmbientContext,
} from "@zcode/shared";

// executor 由宿主注入：list 负责枚举后端，execute 负责发只读命令。
// workspaceIdentity/remoteSessionId 必须透传，远端同名路径不能路由到本地浏览器。
export interface BrowserAmbientContextExecutor {
  list(input: {
    requestId: string;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
  }): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
    command: BrowserCommand;
  }): Promise<{ ok: boolean; [key: string]: unknown }>;
}

// clientMode 可选：缺省按桌面连续链路处理；重放链路由调用方显式指定。
// 采集目标只描述「哪个会话、哪个 workspace」，不携带任何可执行意图。
interface BrowserAmbientContextTarget {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: BrowserClientMode;
}

// [失败路径] URL 将进入 prompt，必须当不可信输入处理：
// 解析失败、协议不符或超长一律丢弃，宁可少一条上下文也不外泄异常串。
function sanitizeAmbientUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
// 只允许三种协议：about: 用于新建页，http/https 才是真实浏览内容。
// file:、javascript: 等协议即使被浏览器接受也不能进入模型上下文。
    if (!["about:", "http:", "https:"].includes(url.protocol)) return undefined;
// 主动剥离 userinfo：URL 里内嵌的账号口令不应随 ambient state 上报。
    url.username = "";
    url.password = "";
    const value = url.toString();
// 长度上限防止超长 data/重定向 URL 撑爆 prompt 预算。
    return value.length <= 4096 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 只读收集 provider ambient state。失败时返回 undefined，不能让浏览器 UI 状态阻断真实 prompt。
 */
export async function collectBrowserAmbientContext(
  executor: BrowserAmbientContextExecutor | undefined,
  target: BrowserAmbientContextTarget,
): Promise<ZCodeBrowserAmbientContext | undefined> {
// 未注入浏览器能力的环境（如无界面宿主）直接跳过，不视为错误。
  if (!executor) return undefined;
// [并发] 身份 key 统一为 identity 优先、路径兜底，与全局 workspaceKey 规则一致；
// 若只用路径，两个远端同名 workspace 会共享同一份浏览器状态。
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
// 采集侧的默认必须是桌面连续链路：重放链路只能由明确知道语义的调用方指定。
  const clientMode = target.clientMode ?? "desktop-continuous";
// 三条命令共享同一组路由字段，抽取后避免某条分支漏传 identity 或 sessionContext。
// sessionContext 固定 live：采集的是当前正在运行的浏览器，不是缓存快照。
  const common = {
    sessionId: target.sessionId,
    workspaceKey,
    workspacePath: target.workspacePath,
// 可选字段用条件展开：缺席时不下发空串，避免远端把空 identity 当成真实身份。
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    clientMode,
    sessionContext: "live" as const,
  };

  try {
// 每次采集使用新的 requestId，便于宿主侧关联与去重；
// 不复用固定 id，避免上一条超时请求的结果被误认成本次结果。
    const descriptors = await executor.list({
      requestId: randomUUID(),
      ...common,
    });
// 只认 iab 后端：其他类型（如 user 浏览器）没有稳定的命令语义，采集会失真。
    const browser = descriptors.find((candidate) => candidate.type === "iab");
    if (!browser) return undefined;

// [失败路径] 两个列举并行且互不阻塞：用户标签页读取失败时，
// 受控标签页的信息仍然有效，整体不应因此降级为无上下文。
    const [controlledOutcome, userOutcome] = await Promise.allSettled([
      executor.execute({
        requestId: randomUUID(),
        browserId: browser.id,
        browserGeneration: browser.generation,
        ...common,
        command: { method: "list" },
      }),
      executor.execute({
        requestId: randomUUID(),
        browserId: browser.id,
        browserGeneration: browser.generation,
        ...common,
        command: { method: "listUserTabs" },
      }),
    ]);
    const controlled =
      controlledOutcome.status === "fulfilled"
        ? browserCommandResultSchema.safeParse(controlledOutcome.value)
        : undefined;
// 用户标签页同理：一侧失败只让该集合为空，另一侧结果照常参与合并。
    const users =
      userOutcome.status === "fulfilled"
        ? browserCommandResultSchema.safeParse(userOutcome.value)
        : undefined;
// schema 校验放在结果侧而不是信任 executor：跨进程返回值必须重新验证，
// safeParse 失败按空列表处理，不抛错。
    const controlledTabs =
      controlled?.success && controlled.data.ok ? (controlled.data.tabs ?? []) : [];
    const userTabs = users?.success && users.data.ok ? (users.data.userTabs ?? []) : [];
    const tabIds = new Set([
      ...controlledTabs.map((tab) => tab.tabId),
      ...userTabs.map((tab) => tab.id),
    ]);
// [事务] 两类标签页按 id 求并集：同一页面可能同时出现在两侧，
// 去重后才能得到真实的 tabCount；为空说明确实没有可描述的上下文。
    if (tabIds.size === 0) return undefined;

    // 显式 finalize 后页面属于 user tabs；漏 finalize 的 handoff 仍属于 controlled tabs。
    // 两类都必须进入 ambient state，否则下一轮会把空 tabs.list() 误判为浏览器断线。
// 当前 URL 的优先级：受控活动页 → 首个用户页 → 最后一个受控页。
// 前两者代表用户正在看的内容，最后的兜底避免在切页瞬间丢失 URL。
    const currentControlled = controlledTabs.find((tab) => tab.active);
    const currentUrl = sanitizeAmbientUrl(
      currentControlled?.url ?? userTabs[0]?.url ?? controlledTabs.at(-1)?.url,
    );
    return {
// 只上报 tabCount 与 currentUrl 两个事实，不泄露具体标签页列表或标题。
      tabCount: tabIds.size,
      ...(currentUrl ? { currentUrl } : {}),
    };
  } catch {
    return undefined;
  }
}
