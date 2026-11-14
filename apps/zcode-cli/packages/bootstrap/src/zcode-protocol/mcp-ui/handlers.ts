// INV-01 活动调用表按会话隔离：守住位置 键前缀；改错故障 关闭一个会话误杀另一个会话的调用。
// INV-02 调用结束即删活动项：守住位置 清理分支；改错故障 取消命中已结束的调用。
// INV-03 已完成墓碑防止标识复用：守住位置 重复检查；改错故障 同一调用标识拿到错配结果。
// INV-04 关闭会话同时清墓碑：守住位置 前缀清理；改错故障 重开会话后旧标识永久失效。
// INV-05 终止返回数量可观测：守住位置 计数返回；改错故障 关闭流程无法判断是否有残留。
// INV-06 归属校验失败即关闭：守住位置 服务器存在性判断；改错故障 非本会话服务器可被访问。
// INV-07 插件标识不作授权依据：守住位置 仅用服务器名；改错故障 展示字段被当成凭证。
// INV-08 处理器集合无实例状态：守住位置 每次请求新建；改错故障 跨请求串用会话状态。
// INV-09 工具必须对页面可见：守住位置 可见性判断；改错故障 仅模型可用的工具被页面调用。
// INV-10 两个取消信号合并：守住位置 信号组合；改错故障 宿主取消无法中断底层请求。
// INV-11 调用前后都检查中止：守住位置 双次抛出；改错故障 已取消仍返回结果。
// INV-12 结果保留原始形状：守住位置 直接返回；改错故障 页面拿到改写后的结构。
// INV-13 日志区分取消与失败：守住位置 状态字段；改错故障 用户取消被记成错误。
// INV-14 清理只删自己登记的项：守住位置 引用比较；改错故障 后到调用被前一次清理误删。
// INV-15 取消未命中仍写墓碑：守住位置 空值分支；改错故障 重复取消产生二次登记。
// INV-16 订阅键绑定实例代次：守住位置 双重相等判断；改错故障 旧页面继续收到推送。
// INV-17 退订与订阅键同构：守住位置 键构造复用；改错故障 退订漏掉真实订阅。
// INV-18 资源读取按大小与类型设限：守住位置 边界函数；改错故障 超大内容内联进页面。
//
// 模块职责：为 MCP App 页面提供工具调用、资源列表、订阅与读取的宿主适配。
// 状态所有权：进行中调用与完成墓碑是模块级表，处理器实例本身无状态。
// 阅读顺序：先看会话级清理，再看归属校验，最后看各处理器与资源边界。
import type { Logger } from "@zcode/contracts";
import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";
import {
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  isMcpAppsUiReadResourceMimeAllowed,
} from "@zcode/shared/mcp-apps";
import type {
  McpUiCallToolParams,
  McpUiCallToolResult,
  McpUiCancelCallParams,
  McpUiCancelCallResult,
  McpUiHandlers,
  McpUiListResourceTemplatesResult,
  McpUiListResourcesParams,
  McpUiListResourcesResult,
  McpUiPluginScope,
  McpUiReadResourceForUiResult,
  McpUiReadResourceParams,
  McpUiReadResourceResult,
  McpUiResourceContent,
  McpUiResourceSubscriptionParams,
  McpUiSessionAccess,
} from "./contract.js";
import {
  McpUiNotSupportedError,
  McpUiResourceRejectedError,
  McpUiServerScopeError,
  McpUiToolAccessError,
  buildMcpUiSubscriberKey,
} from "./contract.js";

/**
 * 进行中的 UI 工具调用，键 = sessionId + callId。唯一 owner；调用结束即删。
 * 模块级而不是 handlers 实例级：protocol.ts 每次请求都新建 handlers，取消请求必须能找到别的请求登记的调用。
 */
const activeUiToolCalls = new Map<string, AbortController>();
const finishedUiToolCalls = new Set<string>();
const uiToolCallKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

/** 供 session 关闭时清理：abort 该 session 全部进行中的 UI 调用。 */
// 同时清掉该 session 的 finished 墓碑，返回被 abort 的调用数（供日志/断言）。
// 副作用：触发各 AbortController，使底层 MCP client 请求随之中断。
// 不变量：只处理 `sessionId\0` 前缀的键，不误伤其他 session 同 callId 的调用。
// finishedUiToolCalls 按前缀整批清除，会话关闭后墓碑不再占内存。
// 前缀是 sessionId 加 \u0000，同 callId 不同会话互不可见。
// count 在 controller.abort() 后自增，只统计真正被中断的调用。
// 中断后在同一循环里 activeUiToolCalls.delete(key)，表与控制器状态一致。
export function abortMcpUiToolCallsForSession(sessionId: string): number {
  for (const key of finishedUiToolCalls)
    if (key.startsWith(`${sessionId}\u0000`)) finishedUiToolCalls.delete(key);
  let count = 0;
  for (const [key, controller] of activeUiToolCalls) {
    if (!key.startsWith(`${sessionId}\u0000`)) continue;
    controller.abort();
    activeUiToolCalls.delete(key);
    count += 1;
  }
  return count;
}

export interface CreateMcpUiHandlersOptions {
  logger?: Logger;
}

/** 归属校验 fail closed：serverName 不在本 session 的 MCP server 表里一律 -32602；pluginId 不参与判定。 */
// pluginId 只是展示/日志维度，不能作为授权依据；
// 失败抛 McpUiServerScopeError，由 protocol.ts 统一转成 ProtocolRequestError。
// assertMcpUiServerScope 只判 scope.serverName 是否属于本会话。
// scope.pluginId 不参与授权判断，仅作展示与日志维度。
// 失败即关闭：异常直接冒泡，本函数不返回布尔值。
// 通过后才允许触碰 access 上的会话端口。
export async function assertMcpUiServerScope(
  access: McpUiSessionAccess,
  scope: McpUiPluginScope,
): Promise<void> {
  if (!(await access.hasMcpServer(scope.serverName))) {
    throw new McpUiServerScopeError(scope.serverName);
  }
}

/**
 * 构造 MCP App 页面可用的 handler 集合（每次请求新建，无实例状态）。
 * 所有方法第一步都做 serverName 归属校验，之后才触碰 session 的 mcpPort；
 * 输入均来自已 schema 校验的 protocol params，输出为宿主直接透传给页面的形状。
 * 失败语义：归属错 → McpUiServerScopeError；工具不可见 → McpUiToolAccessError；
 * 服务器不支持资源操作 → McpUiNotSupportedError；资源超限/mime 不符 → McpUiResourceRejectedError。
 * 副作用：callTool 会登记/清理模块级 active 调用表并写 info/warn 日志。
 */
// createMcpUiHandlers 每次请求新建，不持有实例状态。
// 每个入口第一步都 await assertMcpUiServerScope。
// callTool 先查 activeUiToolCalls 重复，再登记新的 AbortController。
// cancel 路径按 key 删除并写墓碑，重复调用保持幂等。
export function createMcpUiHandlers(options: CreateMcpUiHandlersOptions = {}): McpUiHandlers {
  const logger = options.logger?.child?.({ module: "bootstrap.mcp-ui" }) ?? options.logger;
  return {
    // 反向路径（协议 server → 插件 UI 的宿主适配）：直接转发 resources/read，不改内容形状。
    async readResource(
      access: McpUiSessionAccess,
      params: McpUiReadResourceParams,
      callOptions,
    ): Promise<McpUiReadResourceResult> {
      await assertMcpUiServerScope(access, params);
      return access.readResource(params.serverName, params.uri, callOptions);
    },
    /**
     * 页面 → 插件工具调用。调用键 = sessionId + instance.token + callId，先查重再登记：
     * 重复 callId（含已完成墓碑）直接抛错，防止同一 callId 被复用造成结果错配。
     * 两个 signal 合并：调用方取消与宿主 cancel 任一触发都中断 MCP 请求。
     * 可见性规则：工具必须存在且 visibility 含 "app"（model-only 工具不对页面开放）。
     * 返回原始 MCP CallToolResult，不写 transcript；finally 只删自己登记的 controller。
     */
    async callTool(
      access: McpUiSessionAccess,
      params: McpUiCallToolParams,
      callOptions,
    ): Promise<McpUiCallToolResult> {
      const startedAt = Date.now();
      // H08-a：带 callId 的调用登记 AbortController，宿主卸载卡片时经 mcp/uiCancelCall abort 到 MCP client。
      const cancel = new AbortController();
      const key = uiToolCallKey(params.sessionId, `${params.instance.token}:${params.callId}`);
      if (activeUiToolCalls.has(key) || finishedUiToolCalls.has(key))
        throw new Error("Duplicate MCP App callId");
      activeUiToolCalls.set(key, cancel);
      const signal = callOptions?.signal
        ? AbortSignal.any([callOptions.signal, cancel.signal])
        : cancel.signal;
      try {
        await assertMcpUiServerScope(access, params);
        // H03：归属之外还要看调用方资格——model-only 工具不给页面调，权限仍由现有宿主策略判断。
        const visibility = await access.getToolVisibility(params.serverName, params.toolName);
        if (!visibility) {
          throw new McpUiToolAccessError("tool_not_found", params.serverName, params.toolName);
        }
        if (!visibility.includes("app")) {
          throw new McpUiToolAccessError(
            "tool_not_app_visible",
            params.serverName,
            params.toolName,
          );
        }
        signal?.throwIfAborted();
        const result = await access.callTool(params.serverName, params.toolName, params.arguments, {
          signal,
        });
        signal?.throwIfAborted();
        // UI 调用复用宿主权限链，结果保留原始 MCP 形状，不生成对话回合。
        logger?.info("MCP UI tool call completed", {
          event: "mcp.ui.tool.call",
          pluginId: params.pluginId,
          mcpServerName: params.serverName,
          mcpToolName: params.toolName,
          durationMs: Date.now() - startedAt,
          isError: result.isError === true,
          status: "completed",
        });
        return result;
      } catch (error) {
        logger?.warn("MCP UI tool call failed", {
          event: "mcp.ui.tool.call",
          pluginId: params.pluginId,
          mcpServerName: params.serverName,
          mcpToolName: params.toolName,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          status: cancel?.signal.aborted ? "cancelled" : "failed",
        });
        throw error;
      } finally {
        if (activeUiToolCalls.get(key) === cancel) {
          activeUiToolCalls.delete(key);
          finishedUiToolCalls.add(key);
        }
      }
    },
    /**
     * 取消指定 callId 的页面工具调用。找到 controller 则 abort 并返回 cancelled=true；
     * 找不到也写 finished 墓碑并返回 false —— 调用可能已自然结束，重复取消必须幂等。
     * 先做 serverName 归属校验，避免用其他服务器凭证取消本 session 的调用。
     */
    async cancelToolCall(
      access: McpUiSessionAccess,
      params: McpUiCancelCallParams,
    ): Promise<McpUiCancelCallResult> {
      await assertMcpUiServerScope(access, params);
      const key = uiToolCallKey(params.sessionId, `${params.instance.token}:${params.callId}`);
      const controller = activeUiToolCalls.get(key);
      if (!controller) {
        finishedUiToolCalls.add(key);
        return { cancelled: false };
      }
      controller.abort();
      finishedUiToolCalls.add(key);
      logger?.info("MCP UI tool call cancelled", {
        event: "mcp.ui.tool.cancel",
        pluginId: params.pluginId,
        mcpServerName: params.serverName,
        callId: params.callId,
      });
      return { cancelled: true };
    },
    // 资源列表只下发布局所需字段；nextCursor 原样透传，分页由页面驱动。
    async listResources(
      access: McpUiSessionAccess,
      params: McpUiListResourcesParams,
      callOptions,
    ): Promise<McpUiListResourcesResult> {
      await assertMcpUiServerScope(access, params);
      const result = await translateUnsupported(params.serverName, "resources/list", () =>
        access.listResourcesForUi(params.serverName, params.cursor, callOptions),
      );
      // 只给页面标准描述符；`_meta` 是 MCP Resource 的标准字段，保留（宿主也靠它回退读资源级 csp）。
      return {
        resources: result.resources.map(({ uri, name, title, description, mimeType, _meta }) => ({
          uri,
          ...(name !== undefined ? { name } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(mimeType !== undefined ? { mimeType } : {}),
          ...(_meta !== undefined ? { _meta } : {}),
        })),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    // 模板列表与资源列表走同一归属/分页路径，但只暴露 uriTemplate 等模板字段。
    async listResourceTemplates(
      access: McpUiSessionAccess,
      params: McpUiListResourcesParams,
      callOptions,
    ): Promise<McpUiListResourceTemplatesResult> {
      await assertMcpUiServerScope(access, params);
      const result = await translateUnsupported(params.serverName, "resources/templates/list", () =>
        access.listResourceTemplatesForUi(params.serverName, params.cursor, callOptions),
      );
      return {
        resourceTemplates: result.resourceTemplates.map(
          ({ uriTemplate, name, title, description, mimeType }) => ({
            uriTemplate,
            ...(name !== undefined ? { name } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(mimeType !== undefined ? { mimeType } : {}),
          }),
        ),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    /**
     * 订阅资源更新。订阅键由 sessionId + scopeId + generation 组成，必须与实例凭证一致：
     * scopeId 必须等于 instance.token、generation 必须等于 instance.generation，
     * 否则抛错——旧代实例不能借用新代订阅，防止关闭后的页面继续收推送。
     * 返回 void；不支持订阅的服务器统一映射为 McpUiNotSupportedError。
     */
    async subscribeResource(
      access: McpUiSessionAccess,
      params: McpUiResourceSubscriptionParams,
      callOptions,
    ): Promise<void> {
      await assertMcpUiServerScope(access, params);
      if (
        params.scopeId !== params.instance.token ||
        params.generation !== params.instance.generation
      )
        throw new Error("Invalid MCP App subscription binding");
      const key = buildMcpUiSubscriberKey(params.sessionId, params.scopeId, params.generation);
      await translateUnsupported(params.serverName, "resources/subscribe", () =>
        access.subscribeResourceForUi(params.serverName, params.uri, key, callOptions),
      );
      logger?.info("MCP UI resource subscribed", {
        event: "mcp.ui.resource.subscribe",
        pluginId: params.pluginId,
        mcpServerName: params.serverName,
        uri: params.uri,
        scopeId: params.scopeId,
        generation: params.generation,
      });
    },
    // 退订使用与订阅完全相同的键构造规则；不支持订阅的服务器在退订时静默成功（幂等清理）。
    async unsubscribeResource(
      access: McpUiSessionAccess,
      params: McpUiResourceSubscriptionParams,
      callOptions,
    ): Promise<void> {
      await assertMcpUiServerScope(access, params);
      if (
        params.scopeId !== params.instance.token ||
        params.generation !== params.instance.generation
      )
        throw new Error("Invalid MCP App subscription binding");
      const key = buildMcpUiSubscriberKey(params.sessionId, params.scopeId, params.generation);
      await access.unsubscribeResourceForUi(params.serverName, params.uri, key, callOptions);
    },
    /**
     * 页面发起的 resources/read（A7）。与 readResource 的区别：这里经 boundUiResourceContents
     * 做 8 MiB 总量与 mimeType 白名单裁剪，且剥掉 `_meta`；超限直接拒绝而非截断。
     * 输入 uri 来自已校验 params；输出 contents 为宿主可安全内联的 text/blob。
     */
    async readResourceForUi(
      access: McpUiSessionAccess,
      params: McpUiReadResourceParams,
      callOptions,
    ): Promise<McpUiReadResourceForUiResult> {
      await assertMcpUiServerScope(access, params);
      const startedAt = Date.now();
      const raw = await access.readResourceForUi(params.serverName, params.uri, callOptions);
      const result = boundUiResourceContents(params.uri, raw.contents);
      logger?.info("MCP UI resource read completed", {
        event: "mcp.ui.resource.read",
        pluginId: params.pluginId,
        mcpServerName: params.serverName,
        uri: params.uri,
        durationMs: Date.now() - startedAt,
        bytes: result.bytes,
        status: "completed",
      });
      return { contents: result.contents };
    },
  };
}

// 把「服务器不支持该资源操作」的底层错误收敛为页面可识别的 not_supported，
// 其他错误原样上抛，保留真实失败语义。
async function translateUnsupported<T>(
  serverName: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpResourceSubscribeUnsupportedError) {
      throw new McpUiNotSupportedError(serverName, operation);
    }
    throw error;
  }
}

/**
 * 页面读资源的边界：总大小（text 按 UTF-8、blob 按 base64 解码后）≤ 8 MiB，mimeType 必须在白名单；
 * blob 没有 mimeType 视为不可判定，一律拒绝；去掉 `_meta`。超限不截断——半个 GLB / 图片没有意义。
 */
// bytes 用 Buffer.byteLength 累加：text 按 utf8，blob 按 base64 解码后长度。
// mimeType 已定义但不在 isMcpAppsUiReadResourceMimeAllowed 白名单即抛 mime_not_allowed。
// blob 存在而 mimeType 为 undefined 时按 missing 拒绝。
// bytes 超过上限立即抛 too_large，不返回截断后的内容。
function boundUiResourceContents(
  uri: string,
  contents: readonly McpUiResourceContent[],
): { contents: McpUiReadResourceForUiResult["contents"]; bytes: number } {
  let bytes = 0;
  const bounded: McpUiReadResourceForUiResult["contents"] = [];
  for (const content of contents) {
    const mimeType = content.mimeType;
    if (mimeType !== undefined && !isMcpAppsUiReadResourceMimeAllowed(mimeType)) {
      throw new McpUiResourceRejectedError("mime_not_allowed", content.uri || uri, { mimeType });
    }
    if (content.blob !== undefined && mimeType === undefined) {
      throw new McpUiResourceRejectedError("mime_not_allowed", content.uri || uri, {
        mimeType: "(missing)",
      });
    }
    if (content.text !== undefined) bytes += Buffer.byteLength(content.text, "utf8");
    if (content.blob !== undefined) bytes += Buffer.byteLength(content.blob, "base64");
    if (bytes > MCP_APPS_UI_READ_RESOURCE_MAX_BYTES) {
      throw new McpUiResourceRejectedError("too_large", uri, {
        bytes,
        maxBytes: MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
      });
    }
    bounded.push({
      uri: content.uri,
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.blob !== undefined ? { blob: content.blob } : {}),
    });
  }
  return { contents: bounded, bytes };
}

/** 页面的凭证终结时释放幂等账本；旧凭证已经不可再执行。 */
// 输入 sessionId + token（即实例 scopeId）；按 `sessionId\0token:` 前缀 abort 进行中调用、
// 删除 active 与 finished 键。副作用：中断底层 MCP 请求。终态后调用不会复活凭证。
export function clearMcpUiInstanceCalls(sessionId: string, token: string): void {
  const prefix = `${sessionId}\u0000${token}:`;
  for (const [key, controller] of activeUiToolCalls)
    if (key.startsWith(prefix)) {
      activeUiToolCalls.delete(key);
      controller.abort();
    }
  for (const key of finishedUiToolCalls)
    if (key.startsWith(prefix)) finishedUiToolCalls.delete(key);
}
