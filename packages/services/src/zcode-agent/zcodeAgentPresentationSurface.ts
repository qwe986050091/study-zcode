import type { ServiceAuthorityMode } from "@zcode/shared";

// 目前只定义 desktop 一种呈现面：其他宿主不返回该值，保持 terminal 语义。
export type ZCodeAgentPresentationSurface = "desktop";

export interface ZCodeAgentPresentationHostFacts {
  runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** Main 已完成服务端单功能灰度裁决；未提供时保持历史 Host 装配语义。 */
  desktopContextPromptEnabled?: boolean;
}

export function resolveZCodeAgentPresentationSurface(
  facts: ZCodeAgentPresentationHostFacts,
): ZCodeAgentPresentationSurface | undefined {
  // Desktop 呈现能力必须从 Host 已有的可信装配事实推导，不能让每个调用方重复传递独立开关。
  // 普通 HTTP/manual app-server 没有这两个事实，继续保持 terminal，避免把 Desktop prompt 扩散出去。
// 两个 Host 事实任一成立即可判定为桌面宿主，但都必须是可信装配事实。
  const isDesktopHost =
    facts.runtimeSurface === "desktop_local_host" ||
    facts.serviceAuthorityMode === "desktop-attached-remote";
// [权衡] 灰度开关只有显式 false 才关闭；未提供时沿用历史装配语义。
  if (!isDesktopHost || facts.desktopContextPromptEnabled === false) {
    return undefined;
  }
  return "desktop";
}
