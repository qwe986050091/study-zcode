// INV-01 只认沙箱协议：守住位置 前缀判断；改错故障 普通页面被当成沙箱 guest。
// INV-02 三重匹配才放行：sandboxId、partition、owner 必须同时匹配；守住位置 标识、分区、所有者；改错故障 其他窗口挂载插件。
// INV-03 地址必须逐字相等：守住位置 全等比较；改错故障 相近地址借用已注册沙箱。
// INV-04 未注册沙箱拒绝：守住位置 记录查找；改错故障 伪造标识进入。
// INV-05 分区不匹配拒绝：守住位置 字段比较；改错故障 复用宿主会话分区。
// INV-06 所有者不匹配拒绝：守住位置 窗口标识比较；改错故障 跨窗口挂载。
// INV-07 沙箱偏好硬编码：守住位置 逐项赋值；改错故障 参数可覆盖安全设置。
// INV-08 预加载脚本由主进程指定：守住位置 覆盖赋值；改错故障 guest 自带预加载。
// INV-09 删除可注入偏好：守住位置 逐项删除；改错故障 参数绕过加固。
// INV-10 弹出窗口一律拒绝：守住位置 窗口打开处理器；改错故障 插件弹出新窗口。
// INV-11 导航白名单两个来源：守住位置 来源集合；改错故障 插件域被误拦。
// INV-12 主框架与子框架同规则：守住位置 两种导航事件；改错故障 子框架跳转外站。
// INV-13 挂载即 pin：守住位置 注册表调用；改错故障 活实例被容量淘汰。
// INV-14 销毁即 unpin：守住位置 一次性监听；改错故障 已销毁实例占额度。
// INV-15 端口随清理关闭：守住位置 返回函数；改错故障 消息端口泄漏。
// INV-16 先宿主再 guest：守住位置 发送顺序；改错故障 初始化消息因宿主未就绪丢失。
// INV-17 权限转成 iframe 白名单：守住位置 允许列表构造；改错故障 插件权限全部失效。
// INV-18 调试日志不落 info：守住位置 等级判断；改错故障 协议日志刷满磁盘。
//
// 模块职责：插件沙箱 webview 的偏好加固、导航限制与端口建立。
// 状态所有权：pin 与端口生命周期绑定本函数，注册表由调用方持有。
// 阅读顺序：先看地址识别与偏好加固，再看挂载策略，最后看 pin 与端口。
import { InternalChannels, PluginSandboxChannels } from "@zcode/shared";
import { buildMcpAppsIframeAllow } from "@zcode/shared/mcp-apps";
import type { WebContents, WebPreferences } from "electron";
import type { PluginSandboxRegistryPort } from "./contract.js";
import { PLUGIN_SANDBOX_SCHEME, buildPluginSandboxPluginOrigin } from "./contract.js";
import { parsePluginSandboxUrl } from "./protocol.js";

/** will-attach-webview 时 `params.src` 是否指向插件沙箱 shell。 */
export function isPluginSandboxSrc(src: string | undefined): boolean {
  return typeof src === "string" && src.startsWith(`${PLUGIN_SANDBOX_SCHEME}://`);
}

export type PluginSandboxGuestDecision =
  | { ok: true; sandboxId: string }
  | {
      ok: false;
      reason: "not-shell-url" | "unknown-sandbox" | "partition-mismatch" | "owner-mismatch";
    };

/**
 * 沙箱 guest 的 webPreferences 硬化。与内置浏览器 guest 相反：不恢复 allowpopups、
 * 不开 nodeIntegrationInSubFrames、关 webviewTag，并要求 sandboxId / partition / owner 三者匹配。
 */
// 地址解析失败直接拒绝。
// 只接受 shell 类型。
// 注册记录必须存在；partition 与 owner 必须逐项比对；返回 ok 放行标识。
export function configurePluginSandboxGuest(input: {
  webPreferences: WebPreferences;
  params: Record<string, string>;
  registry: PluginSandboxRegistryPort;
  ownerWebContentsId: number;
  preloadPath: string;
}): PluginSandboxGuestDecision {
  const target = parsePluginSandboxUrl(input.params.src ?? "");
  if (!target || target.kind !== "shell") return { ok: false, reason: "not-shell-url" };
  const record = input.registry.get(target.sandboxId);
  if (!record || input.params.src !== record.shellUrl)
    return { ok: false, reason: "unknown-sandbox" };
  if (input.params.partition !== record.partition)
    return { ok: false, reason: "partition-mismatch" };
  if (record.ownerWebContentsId !== input.ownerWebContentsId) {
    return { ok: false, reason: "owner-mismatch" };
  }

  // preload 路径由主进程给出。
  // contextIsolation 与 sandbox 同时开启。
  // 子框架 Node 能力关闭。
  // webview 标签关闭。
  // webPreferences 中可注入偏好逐项删除。
  input.webPreferences.preload = input.preloadPath;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = true;
  input.webPreferences.webSecurity = true;
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;
  input.webPreferences.webviewTag = false;
  input.webPreferences.plugins = false;
  input.webPreferences.disableDialogs = true;
  input.webPreferences.allowRunningInsecureContent = false;
  delete input.params.preload;
  delete input.params.nodeintegration;
  delete input.params.nodeintegrationinsubframes;
  delete input.params.disablewebsecurity;
  delete input.params.allowpopups;
  delete input.params.webpreferences;
  return { ok: true, sandboxId: target.sandboxId };
}

export interface PluginSandboxMessageChannel {
  port1: PluginSandboxMessagePort;
  port2: PluginSandboxMessagePort;
}
export interface PluginSandboxMessagePort {
  close(): void;
}

export interface AttachPluginSandboxGuestInput {
  guest: Pick<WebContents, "on" | "once" | "setWindowOpenHandler" | "postMessage" | "isDestroyed">;
  hostWebContents: Pick<WebContents, "postMessage" | "isDestroyed">;
  registry: PluginSandboxRegistryPort;
  sandboxId: string;
  createMessageChannel: () => PluginSandboxMessageChannel;
  logger?: {
    warn: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

/**
 * did-attach-webview 后的 guest 策略：拒绝所有 popup，导航只允许同 sandbox origin，
 * dom-ready 后建一条 MessageChannel（上面跑原始 JSON-RPC），port1 给 guest（经 preload 转交 relay shell），
 * port2 给宿主 renderer 的 AppBridge；input-event 记用户手势（before-input-event 只覆盖键盘，鼠标点击不会触发）。
 */
// 未注册沙箱只记警告。
// 允许来源含 shell 与插件域。
// 挂载即 pin。
// 销毁只解一次 pin。
// dispose 时关闭全部 MessagePort。
export function attachPluginSandboxGuest(input: AttachPluginSandboxGuestInput): () => void {
  const record = input.registry.get(input.sandboxId);
  if (!record) {
    input.logger?.warn(`[plugin-sandbox] attach for unknown sandbox ${input.sandboxId}`);
    return () => {};
  }
  const shellOrigin = `${new URL(record.shellUrl).protocol}//${new URL(record.shellUrl).host}`;
  const pluginOrigin = buildPluginSandboxPluginOrigin(record.instance.appIdentity);
  const allowedOrigins = new Set([shellOrigin, pluginOrigin]);
  let initialized = false;
  let pluginLoaded = false;
  const openPorts: PluginSandboxMessagePort[] = [];

  // H14：挂上即 pin，guest 销毁 / 宿主 detach 时 unpin（只减一次）；活实例不会被 TTL / 容量淘汰。
  input.registry.pin(input.sandboxId);
  let pinned = true;
  const unpin = () => {
    if (!pinned) return;
    pinned = false;
    input.registry.unpin(input.sandboxId);
  };
  input.guest.once("destroyed", unpin);

  input.guest.setWindowOpenHandler(() => ({ action: "deny" }));
  input.guest.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, allowedOrigins)) {
      event.preventDefault();
      input.logger?.warn(`[plugin-sandbox] blocked navigation ${url}`);
    }
  });
  input.guest.on("will-frame-navigate", (event) => {
    const details = event as unknown as { url?: string; isMainFrame?: boolean };
    if (details.url && !isAllowedNavigation(details.url, allowedOrigins)) {
      event.preventDefault();
    }
  });
  // guest 控制台转到 main 日志：沙箱内 CSP 拒绝、脚本报错否则无处可见。
  input.guest.on("console-message", (event: unknown, ...legacy: unknown[]) => {
    const detail = event as { level?: unknown; message?: unknown } | undefined;
    const level = detail?.level ?? legacy[0];
    const message = detail?.message ?? legacy[1];
    const line = `[plugin-sandbox] guest console(${String(level)}): ${String(message)}`;
    // SDK 的逐条协议日志属于 debug，不能提升为生产 info 持续落盘。
    if (level === "debug" || level === 0) input.logger?.debug?.(line);
    else if (level === "error" || level === 3) input.logger?.warn(line);
    else input.logger?.info?.(line);
  });
  // 任一 frame 加载失败都记 warn（含错误码与 URL）：插件页面空白时据此区分被拦截、404 与网络错误。
  input.guest.on(
    "did-fail-load",
    (
      _event,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      input.logger?.warn(
        `[plugin-sandbox] did-fail-load code=${errorCode} ${errorDescription} url=${validatedUrl} mainFrame=${String(isMainFrame)}`,
      );
    },
  );
  input.guest.on(
    "did-frame-navigate",
    (
      _event,
      url: string,
      httpResponseCode: number,
      httpStatusText: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame && url.startsWith(pluginOrigin + "/")) pluginLoaded = true;
      input.logger?.info?.(
        `[plugin-sandbox] did-frame-navigate ${url} ${httpResponseCode} ${httpStatusText} mainFrame=${String(isMainFrame)}`,
      );
    },
  );
  input.guest.on("input-event", (_event, inputEvent) => {
    if (
      inputEvent.type === "mouseDown" ||
      inputEvent.type === "keyDown" ||
      inputEvent.type === "rawKeyDown"
    ) {
      input.registry.markUserGesture(input.sandboxId);
    }
  });
  // 页面主动重载不能继承上一文档的浏览器授权或 MessagePort。
  input.guest.on("did-start-navigation", (event) => {
    if (
      !event.isSameDocument &&
      ((initialized && event.isMainFrame) || (pluginLoaded && !event.isMainFrame))
    ) {
      input.registry.dispose(record.sandboxId, record.initId);
    }
  });
  // 登记前用 registry.get 再查一次。
  // hostWebContents 或 guest 任一侧已销毁则放弃。
  // 先发宿主再发 guest。
  // 负载带 sandboxId 与 initId。
  // permissions 转成允许列表。
  input.guest.once("dom-ready", () => {
    const current = input.registry.get(input.sandboxId);
    if (!current || input.guest.isDestroyed() || input.hostWebContents.isDestroyed()) return;
    initialized = true;
    const channel = input.createMessageChannel();
    openPorts.push(channel.port1, channel.port2);
    const payload = { sandboxId: current.sandboxId, initId: current.initId };
    // 先给宿主 renderer 再给 guest：renderer 先登记 initId，shell 的 init 到达时不会因宿主未就绪而丢。
    input.hostWebContents.postMessage(InternalChannels.PluginSandboxPorts, payload, [
      channel.port2,
    ] as never);
    // 资源声明的权限 → 插件 iframe 的 `allow`（shell 据此把 Permissions Policy 委托给跨源 iframe）。
    input.guest.postMessage(
      PluginSandboxChannels.Init,
      { ...payload, allow: buildMcpAppsIframeAllow(current.permissions) },
      [channel.port1] as never,
    );
  });

  return () => {
    unpin();
    for (const port of openPorts) port.close();
    openPorts.length = 0;
  };
}

function isAllowedNavigation(url: string, allowedOrigins: Set<string>): boolean {
  try {
    const parsed = new URL(url);
    return allowedOrigins.has(`${parsed.protocol}//${parsed.host}`);
  } catch {
    return false;
  }
}
