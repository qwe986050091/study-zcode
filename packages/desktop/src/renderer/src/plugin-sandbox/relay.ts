// INV-01 纯转发不解析：守住位置 handleFrameMessage；改错故障 shell 变成第二个协议实现。
// INV-02 协议状态在宿主：守住位置 本文件无握手/超时；改错故障 两处状态机互相打架。
// INV-03 allow 白名单唯一：守住位置 PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS；改错故障 iframe 拿到未授权特性。
// INV-04 allow 去重保序：守住位置 Set 展开；改错故障 重复 token 让 allow 串变长且顺序漂移。
// INV-05 非串即空：守住位置 typeof 判断；改错故障 数组被强转成逗号串。
// INV-06 身份解析失败即 null：守住位置 三处 return null；改错故障 畸形 origin 造出可预测的插件地址。
// INV-07 app 身份必须 64 位十六进制：守住位置 正则；改错故障 任意 host 都能映射成插件 origin。
// INV-08 sandboxId 取自路径段：守住位置 pathname.split("/")[2]；改错故障 多实例共用同一页面。
// INV-09 init 结构强校验：守住位置 五个字段判断；改错故障 伪造 init 抢占端口。
// INV-10 sandboxId 必须匹配：守住位置 deps.sandboxId 比较；改错故障 串线帧接到别的 sandbox。
// INV-11 端口唯一：守住位置 ports.length !== 1；改错故障 多端口时转发目标不确定。
// INV-12 重复 init 保留首个：守住位置 if (port) 分支；改错故障 后到端口覆盖在用连接。
// INV-13 转发带固定 origin：守住位置 postMessage 第二参 deps.pluginOrigin；改错故障 消息投递到错误源。
// INV-14 dispose 幂等且可重入：守住位置 disposed 早退；改错故障 二次销毁访问已释放端口。
//
// 模块职责：插件沙箱 shell 的转发内核，只做身份解析、allow 过滤与端口接线。
// 阅读顺序：先看 allow 白名单，再看身份解析，最后看 relay 的 init 与销毁生命周期。
/**
 * 受信 relay shell 的纯逻辑：不解析、不缓冲协议消息，只在宿主 MessagePort 与插件 iframe 之间原样转发 JSON-RPC。
 * 协议状态（握手、超时、teardown）全部在宿主 renderer 的官方 AppBridge 里；DOM 接线在 main.ts。
 */
export interface PluginSandboxRelayFrame {
  postMessage(message: unknown, targetOrigin: string): void;
  remove(): void;
}

export interface PluginSandboxRelayPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

export interface PluginSandboxRelay {
  /** preload 转交的 init 帧：`{ type: "init", sandboxId, initId }` + 一条端口。 */
  handleInit(data: unknown, ports: readonly PluginSandboxRelayPort[]): void;
  /** 来自插件 iframe（source / origin 已由 main.ts 校验）的消息。 */
  handleFrameMessage(data: unknown): void;
  readonly initId: number | null;
  dispose(): void;
}

/** 插件 iframe `allow` 只接受这四个 Permission Policy 特性（与 main 的权限闸门同一集合）。 */
// 四个特性与主进程权限闸门同集。
export const PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS: readonly string[] = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
];

/** 过滤 init 帧里的 allow 串：未知 token 丢弃，去重，保持原顺序。 */
// 过滤只保留白名单内的 token。
export function sanitizePluginSandboxIframeAllow(value: unknown): string {
  // 非字符串一律当作未声明。
  if (typeof value !== "string") return "";
  const tokens = value
    .split(";")
    .map((token) => token.trim())
    .filter((token) => PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS.includes(token));
  // 去重后按原顺序重排。
  return [...new Set(tokens)].join("; ");
}

export const PLUGIN_SANDBOX_SHELL_HOST_PREFIX = "shell-";
export const PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX = "plugin-";

/** 从 shell 自己的 origin（zcode-sandbox://shell-<id>）推导 sandboxId 与插件 iframe 的 origin / URL。 */
// 从 shell 自身 origin 反推插件位置。
export function resolvePluginSandboxShellIdentity(origin: string): {
  sandboxId: string;
  pluginOrigin: string;
  pluginUrl: string;
} | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (!url.hostname.startsWith(PLUGIN_SANDBOX_SHELL_HOST_PREFIX)) return null;
  const sandboxId = url.pathname.split("/")[2];
  if (!sandboxId) return null;
  const appIdentity = url.hostname.slice(PLUGIN_SANDBOX_SHELL_HOST_PREFIX.length);
  // 身份必须是完整摘要，防止伪造。
  if (!appIdentity || !/^[a-f0-9]{64}$/.test(appIdentity)) return null;
  const pluginOrigin = `${url.protocol}//${PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX}${appIdentity}`;
  return { sandboxId, pluginOrigin, pluginUrl: `${pluginOrigin}/instance/${sandboxId}/index.html` };
}

// 依赖全部注入，便于在 shell 内测试。
export function createPluginSandboxRelay(deps: {
  sandboxId: string;
  pluginOrigin: string;
  pluginUrl: string;
  /** `allow` 为空串时不设该属性。 */
  createPluginFrame(src: string, allow: string): PluginSandboxRelayFrame;
  showError(message: string): void;
  log(message: string): void;
}): PluginSandboxRelay {
  let port: PluginSandboxRelayPort | null = null;
  let frame: PluginSandboxRelayFrame | null = null;
  let initId: number | null = null;
  let disposed = false;

  return {
    get initId() {
      return initId;
    },
    // init 帧是唯一建立连接的入口。
    handleInit(data, ports) {
      if (disposed) return;
      const init = data as {
        type?: unknown;
        sandboxId?: unknown;
        initId?: unknown;
        allow?: unknown;
      } | null;
      if (
        typeof init !== "object" ||
        init === null ||
        init.type !== "init" ||
        typeof init.sandboxId !== "string" ||
        typeof init.initId !== "number"
      ) {
        return;
      }
      // 别的 sandbox 的 init 只记日志。
      if (init.sandboxId !== deps.sandboxId) {
        deps.log(
          `[plugin-sandbox-shell] init for another sandbox ${init.sandboxId}, expected ${deps.sandboxId}`,
        );
        return;
      }
      const incoming = ports[0];
      // [契约] 首帧只接受唯一一个 MessagePort：缺端口或多于一个都按协议错误处理，直接 showError 并返回。
      if (!incoming || ports.length !== 1) {
        deps.showError("Plugin sandbox: init without a port.");
        return;
      }
      // 重复 init 关掉新端口，保留首个。
      if (port) {
        // main 只在 guest dom-ready 时发一次 init；重复 init 只可能来自串线，保留首个。
        deps.log(
          `[plugin-sandbox-shell] duplicate init ignored (initId=${init.initId}, current=${initId})`,
        );
        incoming.close();
        return;
      }
      port = incoming;
      initId = init.initId;
      // iframe 的 allow 必须先过白名单。
      frame = deps.createPluginFrame(deps.pluginUrl, sanitizePluginSandboxIframeAllow(init.allow));
      port.onmessage = (event) => {
        frame?.postMessage(event.data, deps.pluginOrigin);
      };
      port.start?.();
    },
    handleFrameMessage(data) {
      if (disposed || !port) return;
      if (typeof data !== "object" || data === null) return;
      port.postMessage(data);
    },
    // 销毁关闭端口、移除 iframe 并置空。
    dispose() {
      if (disposed) return;
      disposed = true;
      port?.close();
      port = null;
      frame?.remove();
      frame = null;
    },
  };
}
