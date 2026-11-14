import {
  collectTelemetryRendererContext,
  resolveWorkspaceTelemetryDetail,
  type RendererTelemetryEventPayload,
} from "@zcode/shared";
import type {
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiReadResourceResult,
  ZCodePluginsListUiSurfacesResult,
} from "@zcode/shared";
import type {
  McpAppResourceMeta,
  PluginSandboxHandle,
  PluginSandboxRegisterInput,
} from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HTML_MAX_BYTES,
  MCP_APPS_HTML_MIME_TYPES,
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  normalizeMcpAppResourceMeta,
} from "@zcode/shared/mcp-apps";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  IPluginUiBridgeService,
  PluginUiCallToolParams,
  PluginUiCancelToolCallParams,
  PluginUiListResourcesParams,
  PluginUiPrepareSandboxParams,
  PluginUiReadResourceParams,
  PluginUiResourceSubscriptionParams,
  PluginUiWorkspaceTarget,
} from "./contract.js";

// Plugin UI bridge：沙箱页面与 agent 侧 MCP 能力之间的唯一通道。
// INV-01：prepareSandbox 以 (runtimeId, token, generation, resourceUri) 为键合并在途请求，
//         同一份沙箱只注册一次；守住位置 preparing Map。
//         破坏后果：两个 sandboxId，其中一个永不释放。
// INV-02：prepareSandboxOnce 内任一阶段失败都须 closeInstance；守住位置两处 catch。
//         破坏后果：已 open 未注册的实例泄漏，窗口关闭后进程不退出。
// INV-03：可选依赖缺失时明确抛 unavailable（取消/退订/列表分组例外，按 best effort 返回空值），
//         守住位置各方法的 dependencies 检查；破坏后果：页面误判成功，问题推迟到更难定位处。
// INV-04：resources/read 结果进入沙箱前必须过一次 8 MiB 解码后大小校验，守住 assertUiReadResourceSize。
export interface PluginUiBridgeServiceDependencies {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  recycleInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<boolean>;
  validateInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;
  openInstance?: (
    params: PluginUiPrepareSandboxParams,
  ) => Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  closeInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;

  readMcpResource?: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    pluginId: string;
    serverName: string;
    uri: string;
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  }) => Promise<ZCodeMcpReadResourceResult>;
  callMcpToolForUi?: (
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ) => Promise<ZCodeMcpUiCallToolResult>;
  /** 取消带 callId 的进行中调用。 */
  cancelMcpToolCallForUi?: (
    params: PluginUiCancelToolCallParams,
  ) => Promise<ZCodeMcpUiCancelCallResult>;
  /** 页面发起的 `resources/read`，agent 侧 `mcp/uiReadResource` 做归属与 mimeType 校验。 */
  readMcpResourceForUi?: (
    params: PluginUiReadResourceParams,
  ) => Promise<ZCodeMcpUiReadResourceResult>;
  /** 资源列表 / 模板 / 订阅代理；缺省（web / 远程）时对应方法抛 unavailable。 */
  listMcpResourcesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  unsubscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  /** 工作区级 `plugins/listUiSurfaces`。 */
  listPluginUiSurfaces?: (
    params: PluginUiWorkspaceTarget,
  ) => Promise<ZCodePluginsListUiSurfacesResult>;
  /** 由 display.ui 提供的 CSP / prefersBorder 在 prepare 时随 params 传入；这里只做透传。 */
}

// 错误码是跨进程契约（经 RPC / 结构化克隆回页面），因此用稳定字符串而非子类或数字；
// 新增 code 属协议扩展，必须同步页面侧分支，否则会落到「未知错误」兜底。
export class PluginUiBridgeError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "resource_not_found"
      | "resource_too_large"
      | "unsupported_mime_type"
      | "invalid_server_uri",
    message: string,
  ) {
    super(message);
    this.name = "PluginUiBridgeError";
  }
}

/**
 * `ui://` 资源 URI 的 server 归属由 agent 侧 catalog 校验；这里只负责把 URI 拆成 server 名。
 * 约定：`ui://<plugin-name>/<path>` 对应 namespaced server 由 params.serverName 显式给出，
 * 不从 URI 猜测。
 */
// 每次调用 factory 都得到独立状态（preparing Map 与 logger 都闭包在内），
// 上层应按运行时单例持有——Map 的去重语义只在同一实例内成立。
export function createPluginUiBridgeService(
  dependencies: PluginUiBridgeServiceDependencies = {},
): IPluginUiBridgeService {
  // prepare 每个沙箱只有一两次，info 级留生命周期轨迹（读资源 / 登记 / 失败），排 e2e 与用户现场用。
  // 修复：logger 必须在工厂里创建而不是模块顶层——本文件经 @zcode/services 入口也被打进 renderer bundle，
  // 顶层 createServiceLogger 会在 import 时读 process.pid，renderer 里直接 ReferenceError，整个主界面起不来。
  const log = createServiceLogger("plugin-ui-bridge");
// [并发] preparing 是「在途请求」表而非结果缓存：值 settle 后立刻被 finally 删除，
// 只拦并发重复 prepare，不拦串行重试。
  const preparing = new Map<string, Promise<PluginSandboxHandle>>();
  const prepareSandboxOnce = async (
    params: PluginUiPrepareSandboxParams,
    instance: import("@zcode/shared/mcp-apps").McpAppInstance,
  ) => {
    if (
      !dependencies.readMcpResource ||
      !dependencies.registerSandbox ||
      !dependencies.openInstance
    ) {
      throw new PluginUiBridgeError(
        "unavailable",
        "Plugin UI sandbox is unavailable in this runtime",
      );
    }
// 能力检查放在最前：缺 registerSandbox 时即便读到 HTML 也注册不了，提前失败可省掉最慢的远端读。
// bound 把 instance 合进参数，读资源与失败时关闭用同一份快照，保证对象一致。
    const bound = { ...params, instance };
    const startedAt = Date.now();
    log.info("prepareSandbox start", {
      sessionId: params.sessionId,
      pluginId: params.pluginId,
      scopeId: params.scopeId,
      resourceUri: params.resourceUri,
    });
// 计时起点在 register 前，覆盖读资源、读列表级 meta、注册三段，
// 用于区分慢在远端还是慢在本地注册。
    let result: ZCodeMcpReadResourceResult;
    try {
      result = await dependencies.readMcpResource({ ...bound, uri: params.resourceUri });
    } catch (error) {
// [资源] 读资源失败也必须关实例：openInstance 已创建帧/WebContents，
// 不关就成了孤儿，窗口生命周期结束时无法回收。
      log.warn("prepareSandbox readResource failed", {
        scopeId: params.scopeId,
        resourceUri: params.resourceUri,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
    try {
// mime 白名单与 HTML 体积上限都在 pickHtmlResource 内完成，这里假定返回值可用、不重复校验；
// blob 形式更早一步就已被拒绝。
      const picked = pickHtmlResource(result, params.resourceUri);
      const { html } = picked;
      // 资源级 _meta 是权威：先看 resources/read 选中的 HTML 项，缺省再回退到 resources/list 条目
      // （规范把 csp / prefersBorder 放在列表条目的 _meta 上，官方 SDK 的 registerAppResource 也只写那里）；
      // 工具级声明只在资源两处都没有对应字段时兜底；csp 整体取舍，不逐域并集。
// 三级回退：资源级 _meta（权威）→ 列表条目 _meta → 工具级声明，
// 且 csp 整体取舍而非逐域并集：混用两种来源会放宽到两侧都未声明的域。
      const meta =
        picked.meta ?? (await readListLevelResourceMeta(dependencies.listMcpResourcesForUi, bound));
      const csp = meta?.csp ?? params.csp;
      const prefersBorder = meta?.prefersBorder ?? params.prefersBorder;
      log.info("prepareSandbox resource ready", {
        scopeId: params.scopeId,
        htmlBytes: Buffer.byteLength(html, "utf8"),
        hasResourceMeta: meta !== null,
        durationMs: Date.now() - startedAt,
      });
// 可选字段用「有值才带」的展开：显式传 undefined 会覆盖宿主默认值，
// 而这里的缺省语义是「未声明，用宿主默认」。
      const handle = await dependencies.registerSandbox({
        instance,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ownerWebContentsId: params.ownerWebContentsId,
        sessionId: params.sessionId,
        pluginId: params.pluginId,
        // partition 按 server 身份派生（插件 server 跨工作区共享；普通 MCP server 按工作区隔离）。
        serverName: params.serverName,
        scopeId: params.scopeId,
        html,
        ...(csp ? { csp } : {}),
        // 资源级 `_meta["zcode/csp"]`：unsafe-eval / wasm-unsafe-eval 放宽只认资源自己的声明。
        ...(meta?.cspRelaxations ? { cspRelaxations: meta.cspRelaxations } : {}),
        ...(meta?.permissions ? { permissions: meta.permissions } : {}),
        ...(prefersBorder !== undefined ? { prefersBorder } : {}),
        ...(meta?.heightHint !== undefined ? { heightHint: meta.heightHint } : {}),
        ...(meta?.minFrameHeight !== undefined ? { minFrameHeight: meta.minFrameHeight } : {}),
        ...(meta?.showInline !== undefined ? { showInline: meta.showInline } : {}),
      });
      log.info("prepareSandbox registered", {
        scopeId: params.scopeId,
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        durationMs: Date.now() - startedAt,
      });
      return handle;
    } catch (error) {
// [资源] 注册失败同样要关实例：registerSandbox 可能已部分登记（partition/帧已建），
// close 交给注入方按幂等处理，避免「注册了一半」的句柄留在宿主侧。
      log.warn("prepareSandbox register failed", {
        scopeId: params.scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
  };

  return {
// 三个生命周期方法都是纯委托：bridge 不持有实例状态，
// 归属与幂等由注入方（宿主侧实例注册表）保证。
    async recycleInstance(params) {
      return dependencies.recycleInstance ? dependencies.recycleInstance(params) : false;
    },
    async validateInstance(params) {
      await dependencies.validateInstance?.(params);
    },
    async closeInstance(params) {
      await dependencies.closeInstance?.(params);
    },
    async prepareSandbox(params) {
// 没有 openInstance 就拿不到实例身份，prepare 在此终止；
// 检查先于任何对象创建，避免用空身份算出 Map 键。
      if (!dependencies.openInstance) throw unavailable("instance identity");
      const instance = await dependencies.openInstance(params);
      // 合并键来自 Agent 当前连接凭证；断连后的初始化不能复用上一代正在读取的 HTML。
// [并发] 键必须含实例代数：同一次登录内 token 不变，但重连会推进 generation，
// 此时旧请求读到的 HTML 已不可信，必须重新读取。
// 用数组序列化而非字符串拼接，避免字段含分隔符时算出同一个键。
      const key = JSON.stringify([
        instance.runtimeId,
        instance.token,
        instance.generation,
        params.resourceUri,
      ]);
// 命中在途请求复用同一个 Promise，调用方拿到同一份 handle，
// 因此不会出现「两次 prepare、两个 sandboxId」。
      const existing = preparing.get(key);
      if (existing) return existing;
// [资源] finally 里再比对一次 identity 才删除：盲目 delete 可能把新请求的在途记录删掉，
// 让后续并发准备失去合并。
      const pending = prepareSandboxOnce(params, instance).finally(() => {
        if (preparing.get(key) === pending) preparing.delete(key);
      });
      preparing.set(key, pending);
      return pending;
    },
// 工具调用是本文件唯一的「页面 → agent」写路径：鉴权与归属在 callMcpToolForUi 内完成，
// 这里只做能力检查、耗时统计与结果分类上报。
    async callTool(params, options) {
      if (!dependencies.callMcpToolForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI tool calls are unavailable in this runtime",
        );
      }
      const startedAt = Date.now();
// 上报是纯观测：三类结果分开计数，cancelled 与 failure 必须区分，
// 否则用户主动取消会推高失败率、掩盖真实故障。
// 包一层 try/catch 并吞掉 Promise 拒绝：观测通道异常绝不能改变返回值或抛出。
      const report = (result: "success" | "failure" | "cancelled") => {
        try {
          void Promise.resolve(
            dependencies.reportTelemetryEvent?.({
              elementName: "plugin_usage",
              eventRegion: "app",
              eventType: "result",
              context: collectTelemetryRendererContext(),
              eventExtraDetail: {
                schema_version: "1",
                action: "ui_tool_call",
                result,
                plugin_id: params.pluginId,
                plugin_component: "ui",
                duration_ms: String(Math.max(0, Date.now() - startedAt)),
                ...resolveWorkspaceTelemetryDetail(params),
              },
            }),
          ).catch(() => {});
        } catch {
          /* 观测失败不能改变工具调用结果。 */
        }
      };
      try {
// isError 是 MCP 语义内的「工具执行失败」（结果仍返回给页面），与抛出异常（协议/传输失败）
// 分开上报：两者对页面的处理方式不同。
        const result = await dependencies.callMcpToolForUi(params, options);
        report(result.isError ? "failure" : "success");
        return result;
      } catch (error) {
        report(
          options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")
            ? "cancelled"
            : "failure",
        );
        throw error;
      }
    },
// 取消是跨进程 best effort 通知：目标调用可能已结束或从未到达 agent，
// 因此返回 cancelled:false 而不是抛错。
    async cancelToolCall(params) {
      // 没有 agent 依赖（web / 远程）时视为无可取消，不报错：取消是 best effort 的收尾动作。
      if (!dependencies.cancelMcpToolCallForUi) return { cancelled: false };
      return dependencies.cancelMcpToolCallForUi(params);
    },
// 页面发起的 resources/read 交给 agent 侧做归属与 mimeType 校验，
// 本层只补一道解码后大小防线，防止旧 agent 漏检后把大对象克隆进沙箱。
    async readResource(params) {
      if (!dependencies.readMcpResourceForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI resource reads are unavailable in this runtime",
        );
      }
      const result = await dependencies.readMcpResourceForUi(params);
// 在返回前同步校验：MessagePort 的结构化克隆没有背压，
// 超限对象一旦跨进程就会推高渲染进程内存，必须发送前拦截。
      assertUiReadResourceSize(result, params.uri);
      return result;
    },
// 列表/模板/订阅是可选能力：web 与远程没有本地 MCP catalog，缺失即 unavailable；
// 而取消/退订缺省返回空值，因为它们是收尾或装饰性动作，报错没有可执行的补救。
    async listResources(params) {
      if (!dependencies.listMcpResourcesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourcesForUi(params);
    },
    async listResourceTemplates(params) {
      if (!dependencies.listMcpResourceTemplatesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourceTemplatesForUi(params);
    },
// 订阅是可选能力：缺依赖时抛 unavailable，与列表一致；
// 与退订不同，订阅失败会影响页面后续收到的资源变更通知，因此不能静默吞掉。
    async subscribeResource(params) {
      if (!dependencies.subscribeMcpResourceForUi) throw unavailable("resource subscriptions");
      await dependencies.subscribeMcpResourceForUi(params);
    },
    async unsubscribeResource(params) {
      // 退订是收尾动作：没有依赖时静默成功（与 cancelToolCall 同理）。
      if (!dependencies.unsubscribeMcpResourceForUi) return;
      await dependencies.unsubscribeMcpResourceForUi(params);
    },
// 返回空数组而不是抛错：launcher 用「有无分组」决定是否渲染插件区，
// 空数组等价于「本运行时没有插件面」，页面无需 try/catch。
    async listSurfaces(params) {
      // web / 远程 workspace 没有本地 agent runtime：没有入口而不是报错，launcher 据此隐藏分组。
      if (!dependencies.listPluginUiSurfaces) return [];
      return (await dependencies.listPluginUiSurfaces(params)).surfaces;
    },
  };
}

// 统一构造：message 必须带上缺失的能力名，现场日志只有 message，
// 缺了就无法区分「功能未接线」与「运行时受限」。
function unavailable(feature: string): PluginUiBridgeError {
  return new PluginUiBridgeError(
    "unavailable",
    `Plugin UI ${feature} are unavailable in this runtime`,
  );
}

/**
 * 8 MiB 总量守卫：结果经 MessagePort 结构化克隆进沙箱，
 * agent 侧已按同一常量限流，这里再算一次解码后大小（text 按 UTF-8、blob 按 base64 解码长度）防止旧 agent 漏检。
 */
// 逐项累加解码后大小：text 按 UTF-8 字节，blob 按 base64 还原长度，
// 二者都可能远大于传输层计数，因此必须在这里重算。
export function assertUiReadResourceSize(result: ZCodeMcpUiReadResourceResult, uri: string): void {
  let total = 0;
  for (const content of result.contents) {
    if (typeof content.text === "string") total += Buffer.byteLength(content.text, "utf8");
    if (typeof content.blob === "string") total += decodedBase64Length(content.blob);
  }
  if (total > MCP_APPS_UI_READ_RESOURCE_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource ${uri} decodes to ${total} bytes, exceeding the ${MCP_APPS_UI_READ_RESOURCE_MAX_BYTES} byte limit for resources/read`,
    );
  }
}

// 按公式估算而不真正解码：只需要上界，避免为大 blob 再分配一份内存；
// 先剥空白字符，否则换行会让结果偏大、把合法结果误判超限。
function decodedBase64Length(value: string): number {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** 兼容旧调用：只要 HTML 文本。 */
// 兼容入口：老调用方只要 HTML 文本。语义完全委托 pickHtmlResource，
// 避免两条路径的校验规则分叉。
export function pickHtmlContent(result: ZCodeMcpReadResourceResult, uri: string): string {
  return pickHtmlResource(result, uri).html;
}

// 翻页上限防 cursor 异常（不前进或无限增长）时卡住准备流程；
// 8 页足以覆盖正常插件 server 的资源数，超出即视为「没有声明」。
const LIST_LEVEL_META_MAX_PAGES = 8;

/**
 * resources/read 的 HTML 项没带 `_meta` 时，翻 resources/list 找同 uri 条目的 `_meta`（最多 8 页）。
 * 列表不可用、翻页失败或找不到都视为"没有声明"，不阻塞沙箱准备。
 */
// [失败路径] 整段包在 try 内且只返回 null：列表不可用、翻页抛错、找不到同 uri 条目
// 都等价于「没有资源级声明」，不应阻塞沙箱准备。
async function readListLevelResourceMeta(
  list: PluginUiBridgeServiceDependencies["listMcpResourcesForUi"],
  params: PluginUiPrepareSandboxParams & {
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  },
): Promise<McpAppResourceMeta | null> {
  if (!list) return null;
// 作用域与 prepare 完全一致（instance + workspace + session + plugin + server），
// 少一个字段就可能让列表落到别的工作区或别代实例上。
  const scope = {
    instance: params.instance,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    serverName: params.serverName,
  };
  let cursor: string | undefined;
  try {
// 逐页找 uri 精确相等的条目：不用前缀或包含匹配，否则 ui://a/b 会命中 ui://a/bc；
// 命中即返回，不再继续翻页。
    for (let page = 0; page < LIST_LEVEL_META_MAX_PAGES; page += 1) {
      const result = await list({ ...scope, ...(cursor ? { cursor } : {}) });
      const entry = result.resources.find((item) => item.uri === params.resourceUri);
      if (entry) return normalizeMcpAppResourceMeta(entry._meta);
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 选中实际使用的 HTML 项：遍历 contents，取第一个 mimeType 在 HTML 白名单内的项
 * （同 uri 的优先）；从**该项**的 `_meta` 读资源级 csp / prefersBorder / 尺寸提示。
 * blob、超限一律拒绝，不降级、不截断；没有任何 HTML 项时按第一项的 mimeType 报错。
 */
// 选择顺序：先「uri 相同且 mime 是 HTML」，再退化为「任意 HTML 项」。
// 一个 resources/read 可能返回多个表示，只有与请求 uri 对齐的那项才代表页面本身。
export function pickHtmlResource(
  result: ZCodeMcpReadResourceResult,
  uri: string,
): { html: string; meta: McpAppResourceMeta | null } {
  if (result.contents.length === 0) {
    throw new PluginUiBridgeError("resource_not_found", `MCP resource has no contents: ${uri}`);
  }
  const isHtml = (mimeType: string | undefined) => {
    const normalized = normalizeMimeType(mimeType);
    return (
      normalized !== null && (MCP_APPS_HTML_MIME_TYPES as readonly string[]).includes(normalized)
    );
  };
// [权衡] 双 find 而非单遍：合并成一遍会让「非本 uri 的 HTML」是否先被选中取决于返回顺序，
// 结果不稳定，因此宁可多走一次数组。
  const content =
    result.contents.find((item) => item.uri === uri && isHtml(item.mimeType)) ??
    result.contents.find((item) => isHtml(item.mimeType));
  if (!content) {
    const first = result.contents[0]!;
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      `MCP resource mimeType is not HTML: ${first.mimeType ?? "(missing)"}`,
    );
  }
// blob 一律拒绝：沙箱要的是可直接注入的 HTML 文本，
// 接受 blob 等于把解码责任推给页面，还会绕开上面的文本长度上限。
  if (typeof content.text !== "string") {
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      "MCP resource must return HTML as text, blob is not accepted",
    );
  }
  if (Buffer.byteLength(content.text, "utf8") > MCP_APPS_HTML_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource exceeds ${MCP_APPS_HTML_MAX_BYTES} bytes`,
    );
  }
  return { html: content.text, meta: normalizeMcpAppResourceMeta(content._meta) };
}

// 归一：去空白、转小写、丢掉 charset 参数，但保留 profile=mcp-app，
// 因为白名单里就有带 profile 的条目，整串比较才不会漏判。
function normalizeMimeType(value: string | undefined): string | null {
  if (!value) return null;
  // 去掉 charset 等次要参数，但保留 profile=mcp-app 以匹配白名单。
  const parts = value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !part.startsWith("charset="));
  return parts.join(";");
}
