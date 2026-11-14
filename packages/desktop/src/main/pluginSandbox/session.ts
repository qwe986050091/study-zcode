// INV-01 每个 session 只准备一次：守住位置 preparedSessions；改错故障 重复装 handler，权限被二次覆盖。
// INV-02 稳定 origin 不等于可信：守住位置 归属交叉校验；改错故障 任意沙箱读别人实例的资源。
// INV-03 https 只放行 shell 的脚本请求：守住位置 resourceType 判断；改错故障 沙箱发起任意外网请求。
// INV-04 vendor 重定向失败即取消：守住位置 then 的失败分支；改错故障 降级成直连，清单缺失被掩盖。
// INV-05 shell 绝对资源改写到实例路径：守住位置 hostname 比对；改错故障 打包资源指向错误实例。
// INV-06 非首帧必须属于同一 guest：守住位置 initial 判断；改错故障 其他 guest 借用主文档授权。
// INV-07 默认分支一律取消：守住位置 末尾 cancel；改错故障 未登记 URL 被放行。
// INV-08 未装闸门即拒绝全部权限：守住位置 gate 空值分支；改错故障 单测环境静默放行。
// INV-09 权限请求带存活复核：守住位置 isCurrent；改错故障 导航后旧页面仍拿到授权。
// INV-10 闸门异常与同步检查都按拒绝：守住位置 失败分支与 check 处理器；改错故障 请求与检查出现两套结论。
// INV-11 下载一律阻止且代理直连：守住位置 will-download 与 setProxy；改错故障 文件落到用户磁盘、流量走用户代理。
//
// 模块职责：为每个可信 App 身份的持久 partition 锁定沙箱会话能力。
// 阅读顺序：先看一次性准备与协议安装，再看请求拦截的分支顺序，最后看权限与下载收口。
import { webContents, type Session } from "electron";
import type { PluginSandboxRegistryPort } from "./contract.js";
import type { PluginSandboxPermissionGate } from "./permissionGate.js";
import { createGenUiVendorResources, resolveGenUiVendorRedirect } from "./genUiVendor.js";
import {
  createPluginSandboxProtocolHandler,
  installPluginSandboxProtocol,
  parsePluginSandboxUrl,
  type PluginSandboxAssetSource,
} from "./protocol.js";

const preparedSessions = new WeakSet<Session>();

/**
 * 每个可信 App 身份一个持久 partition（多个沙箱共享）。首次使用时把 partition session 锁死：
 * 装 protocol handler、权限交给闸门（未声明一律拒绝）、阻止下载、代理 direct。
 * desktopNetworkPolicy 只覆盖 defaultSession 与 embedded-browser partition，沙箱 session 必须自己设。
 */
export function preparePluginSandboxSession(input: {
  session: Session;
  registry: PluginSandboxRegistryPort;
  assets: PluginSandboxAssetSource;
  /** 缺省（单测 / 未装闸门）时拒绝全部权限。 */
  permissions?: PluginSandboxPermissionGate;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}): void {
  const { session } = input;
  // 同一 partition 只锁一次：handler 与闸门都不允许叠加。
  // 弱集合登记的是 session 对象本身，进程内复用同一对象才算同一个沙箱。
  if (preparedSessions.has(session)) return;
  preparedSessions.add(session);
  const vendorResources = createGenUiVendorResources(input.assets.aliasDir);
  installPluginSandboxProtocol(
    session.protocol,
    createPluginSandboxProtocolHandler({
      registry: input.registry,
      assets: input.assets,
      vendorResources,
      ...(input.logger ? { logger: input.logger } : {}),
    }),
  );
  // 稳定 origin 不能授予跨实例资源访问；以 Electron 提供的实际 guest 与路径登记交叉验证。
  // 同时监听沙箱协议与外网 https，其余协议不进入这个回调。
  // 每个请求都重新解析 url 与 guest，不信任缓存的身份结论。
  // 结论只有三种：放行、改写重定向、取消；没有默认放行，所以 callback 必须给出明确值。
  // 回调必须同步返回结论，异步结果放在 then 里再 callback。
  // 任何内部异常都收敛成 cancel，不允许异常冒泡放行。
  session.webRequest.onBeforeRequest(
    { urls: ["zcode-sandbox://*/*", "https://*/*"] },
    (details, callback) => {
      const target = parsePluginSandboxUrl(details.url);
      const guest =
        details.webContentsId === undefined ? undefined : webContents.fromId(details.webContentsId);
      const shell = guest && parsePluginSandboxUrl(guest.getURL());
      const url = new URL(details.url);
      // 外网只允许 shell 的脚本请求，用于 vendor 资源。
      // resourceType 或 shell 身份任一不符即放空回调，即取消。
      // 重定向失败按取消处理，不降级为直连。
      if (url.protocol === "https:") {
        if (details.resourceType !== "script" || shell?.kind !== "shell") {
          callback({});
          return;
        }
        // 只为实际 Gen UI guest 的固定脚本改来源；重定向后的实例请求仍走下方归属校验。
        void resolveGenUiVendorRedirect(
          details.url,
          input.registry.get(shell.sandboxId),
          vendorResources,
        ).then(
          (redirectURL) => callback(redirectURL ? { redirectURL } : {}),
          () => {
            input.logger?.warn("[plugin-sandbox] Gen UI vendor manifest unavailable");
            callback({ cancel: true });
          },
        );
        return;
      }
      // shell 的打包 / dev 绝对资源 URL 重定向到同一 guest 的实例路径，顶层站点保持稳定。
      // 只改写主文档所在实例的绝对资源 URL。
      // hostname 必须与登记身份的 shell 主机名完全一致。
      // 改写到 /instance/<sandboxId> 前缀，保持顶层站点稳定。
      if (!target && shell?.kind === "shell") {
        const record = input.registry.get(shell.sandboxId);
        if (record && url.hostname === `shell-${record.instance.appIdentity}`) {
          callback({
            redirectURL: `${url.protocol}//${url.host}/instance/${record.sandboxId}${url.pathname}${url.search}`,
          });
          return;
        }
      }
      if (target?.kind === "shell") {
        const record = input.registry.get(target.sandboxId);
        // 首次主文档已由 will-attach 绑定；后续资源必须仍属于这个实际 guest。
        const initial =
          details.resourceType === "mainFrame" && (!shell || shell.sandboxId === target.sandboxId);
        callback({
          cancel:
            !record ||
            url.hostname !== `shell-${record.instance.appIdentity}` ||
            (!initial && shell?.sandboxId !== target.sandboxId),
        });
        return;
      }
      const record = target && input.registry.get(target.sandboxId);
      callback({
        cancel:
          !record ||
          !shell ||
          shell.kind !== "shell" ||
          shell.sandboxId !== record.sandboxId ||
          url.hostname !== `plugin-${record.instance.appIdentity}`,
      });
    },
  );
  const gate = input.permissions;
  // 没有闸门就拒绝，单测与未装闸门的环境不会静默放行。
  // isCurrent 在授权前必须复核页面仍在、URL 未变、frame 未脱离，任一不成立即拒绝。
  // 闸门拒绝或抛错都回调 false，异常不会被当成同意。
  // setPermissionCheckHandler 复用同一闸门，避免两套结论。
  session.setPermissionRequestHandler((guest, permission, callback, details) => {
    if (!gate) {
      input.logger?.warn(`[plugin-sandbox] permission blocked: ${permission}`);
      callback(false);
      return;
    }
    const guestUrl = guest.getURL();
    const frame = guest.mainFrame.frames.find((child) => child.url === details.requestingUrl);
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    void gate
      .request({
        permission,
        guestUrl,
        isCurrent: () =>
          !guest.isDestroyed() &&
          guest.getURL() === guestUrl &&
          Boolean(frame && !frame.detached && guest.mainFrame.frames.includes(frame)),
        requestingUrl: details.requestingUrl,
        ...(mediaTypes ? { mediaTypes } : {}),
      })
      .then(callback, (error: unknown) => {
        input.logger?.warn(`[plugin-sandbox] permission request failed: ${String(error)}`);
        callback(false);
      });
  });
  session.setPermissionCheckHandler((guest, permission, requestingOrigin, details) => {
    if (!gate) return false;
    const mediaType = (details as { mediaType?: string }).mediaType;
    return gate.check({
      guestUrl: guest?.getURL(),
      permission,
      requestingOrigin,
      ...(mediaType ? { mediaType } : {}),
    });
  });
  session.on("will-download", (event) => {
    event.preventDefault();
    input.logger?.warn("[plugin-sandbox] download blocked");
  });
  void session.setProxy({ mode: "direct" }).catch(() => undefined);
}
