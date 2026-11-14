// INV-01 读取资源必须校验实例凭证且资源地址一致：守住位置 读取入口；改错故障 已打开应用越权读取其他资源。
// INV-02 凭证校验失败统一返回参数错误：守住位置 错误码；改错故障 越权被当成内部错误。
// INV-03 工具回调走统一授权路径且不写会话记录：守住位置 工具回调入口；改错故障 产生多余对话行。
// INV-04 调用标识由页面生成并由服务端幂等查重：守住位置 处理器；改错故障 重试产生重复副作用。
// INV-05 取消是幂等成功而不是错误：守住位置 返回结构；改错故障 关闭页面时报错。
// INV-06 取消必须传播到底层请求：守住位置 中断调用；改错故障 取消后请求继续执行。
// INV-07 资源列表必须透传分页游标：守住位置 参数传递；改错故障 只能加载首页。
// INV-08 资源结果必须剥除宿主无关字段：守住位置 结果投影；改错故障 内部字段泄漏到页面。
// INV-09 不支持资源列表的服务器映射为未支持而不是空列表：守住位置 错误映射；改错故障 页面无法降级。
// INV-10 资源模板与资源列表共用 schema：守住位置 参数解析；改错故障 两种请求参数不一致。
// INV-11 订阅键由会话、作用域与代次组成：守住位置 订阅参数；改错故障 新实例继承旧推送。
// INV-12 换新实例不得继承旧订阅：守住位置 代次校验；改错故障 已关闭实例继续收到推送。
// INV-13 退订必须幂等：守住位置 退订实现；改错故障 关闭页面被错误卡住。
// INV-14 页面发起的资源读取不走绑定地址相等约束：守住位置 页面读取入口；改错故障 页面只能读绑定资源。
// INV-15 页面读取仍必须校验服务器归属：守住位置 归属校验；改错故障 跨插件读资源。
// INV-16 资源超限或类型不允许时返回稳定错误码：守住位置 异常类型；改错故障 静默失败。
// INV-17 领域错误按类型映射并保留诊断字段：守住位置 错误翻译；改错故障 调用方丢失定位信息。
// INV-18 未识别错误原样上抛：守住位置 末尾抛出；改错故障 真实故障被包装成参数错误。
//
// 模块职责：实现插件 UI 的资源、工具与实例生命周期协议入口。
// 状态所有权：实例与订阅状态由 mcp-ui 领域模块持有；本文件只做校验与转发。
// 阅读顺序：先看资源与工具入口，再读实例打开顺序，最后看错误翻译。
import { SessionEventType, createEventId } from "@zcode/contracts";
import {
  zcodeMcpReadResourceParamsSchema,
  zcodeMcpUiCallToolParamsSchema,
  zcodeMcpUiCancelCallParamsSchema,
  zcodeMcpUiCloseInstanceParamsSchema,
  zcodeMcpUiListResourcesParamsSchema,
  zcodeMcpUiOpenInstanceParamsSchema,
  zcodeMcpUiReadResourceParamsSchema,
  zcodeMcpUiResourceSubscriptionParamsSchema,
  type ZCodeMcpReadResourceResult,
  type ZCodeMcpUiCallToolResult,
  type ZCodeMcpUiCancelCallResult,
  type ZCodeMcpUiListResourceTemplatesResult,
  type ZCodeMcpUiListResourcesResult,
  type ZCodeMcpUiReadResourceResult,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "../server-types.js";
import { getMcpUiAppToolRegistry } from "./appToolsProtocol.js";
import {
  McpUiNotSupportedError,
  McpUiResourceRejectedError,
  McpUiServerScopeError,
  McpUiToolAccessError,
} from "./contract.js";
import { clearMcpUiInstanceCalls, createMcpUiHandlers } from "./handlers.js";
import { mcpUiInstances } from "./instances.js";
import { createMcpUiSessionAccess } from "./sessionAccess.js";

/** `mcp/readResource`：插件 UI 的 `ui://` 资源读取，走 session 自己的 mcpPort。 */
// 输入 params 含 sessionId / serverName / instance / uri；instance 凭证须通过
// `mcpUiInstances.validate`（来源、generation、workspace/session 归属），
// 且凭证绑定的 resourceUri 必须与本次 uri 完全一致，否则 -32602 —— 防止
// 一个已打开的 App 借凭证读取其他资源。输出为 MCP ReadResourceResult 原形。
// 失败语义：session 不存在 -32001；凭证失效/不匹配 -32602；scope 错误经 translateScopeError 映射。
// 顺序不可换：parseParams(zcodeMcpReadResourceParamsSchema) → requireSession(params.sessionId) → mcpUiInstances.validate(params.instance, params, snapshot) → 比较 active.binding.resourceUri 与 params.uri，最后才进 translateScopeError 包住的 handlers.readResource；validate 提到 uri 比对之前会让失效凭证先触达资源，漏掉 uri 比对则已打开的 App 可用同一凭证读其他 ui:// 资源。
// requireSession 的 -32001 与凭证/地址不匹配的 -32602 都在 translateScopeError 之外抛出，所以不会被领域错误映射改写。
export async function readMcpUiResource(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpReadResourceResult> {
  const params = parseParams(zcodeMcpReadResourceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/readResource" });
  const active = mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  if (active.binding.resourceUri !== params.uri)
    throw new ProtocolRequestError(-32602, "MCP App resource binding mismatch");
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).readResource(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

/** `mcp/uiCallTool`：插件 UI 回调本插件工具；复用工具授权路径，不产生 transcript row。 */
// 方向为 client（插件页面）→ server → 该 session 的 MCP client。callId 由页面生成，
// 服务端按 session+instance.token+callId 做幂等查重（见 handlers.callTool）。
// 输出为原始 MCP CallToolResult；错误经 translateScopeError 转成稳定 code 的 ProtocolRequestError。
// 只做 parseParams(zcodeMcpUiCallToolParamsSchema) + requireSession + translateScopeError 包装；工具授权与幂等查重都在 createMcpUiHandlers().callTool 内按 session+instance.token+callId 完成，本函数不写 conversation，所以页面回调工具不会生成 transcript row。
// 与 readMcpUiResource 不同，这里不做实例凭证与 uri 的比对：越权由 handlers 抛出的 McpUiToolAccessError 统一裁决。
export async function callMcpUiTool(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiCallToolResult> {
  const params = parseParams(zcodeMcpUiCallToolParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiCallTool" });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).callTool(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

/** `mcp/uiCancelCall`（）：取消 `mcp/uiCallTool` 带 callId 的进行中调用；同样 fail closed 校验归属。 */
// 该方法是 transport 的白名单并发方法，因此在模型任务运行期间也能到达 server。
// 返回 `{cancelled}`：false 表示调用已结束或从未登记，属于幂等成功而非错误。
// 副作用：abort 底层 MCP 请求；不返回结果、不写 conversation。
// 同样先 parseParams(zcodeMcpUiCancelCallParamsSchema) + requireSession，再调用 handlers.cancelToolCall；返回的 {cancelled:false} 表示调用已结束或从未登记，这是幂等成功而不是错误，页面关闭时不能因此抛错。
// 真正的副作用是 abort 底层 MCP 请求，发生在 handlers 内；本函数不返回 CallToolResult、不写会话。
export async function cancelMcpUiToolCall(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiCancelCallResult> {
  const params = parseParams(zcodeMcpUiCancelCallParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiCancelCall" });
  return translateScopeError(async () =>
    createMcpUiHandlers({ logger: context.logger }).cancelToolCall(
      createMcpUiSessionAccess(record, params),
      params,
    ),
  );
}

/** `mcp/uiListResources` / `mcp/uiListResourceTemplates`（同插件服务器，分页游标透传）。 */
// 输入 params 复用 list 资源 schema；cursor 为空表示首页，非空原样交给 MCP。
// 输出只含 uri/name/title/description/mimeType/_meta（模板则 uriTemplate），剥除宿主无关字段。
// 不支持 resources/list 的服务器映射为 not_supported，而不是空列表 —— 页面可据此降级。
export async function listMcpUiResources(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiListResourcesResult> {
  const params = parseParams(zcodeMcpUiListResourcesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiListResources" });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).listResources(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

// 资源模板列表：与 listResources 共用 schema 与游标语义，仅结果投影不同。
export async function listMcpUiResourceTemplates(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiListResourceTemplatesResult> {
  const params = parseParams(zcodeMcpUiListResourcesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiListResourceTemplates",
  });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).listResourceTemplates(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

/** `mcp/uiSubscribeResource` / `mcp/uiUnsubscribeResource`；订阅者 = sessionId + scopeId + generation。 */
// 订阅是每个 App 实例独立持有的：scopeId 必须等于实例 token，generation 必须等于实例代次，
// 因而换新实例不会继承旧实例的推送。成功返回空对象（协议层不携带订阅句柄）。
// 退订幂等：服务器不支持订阅时也按成功处理，避免关闭页面时被错误卡住。
export async function subscribeMcpUiResource(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<Record<string, never>> {
  const params = parseParams(zcodeMcpUiResourceSubscriptionParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiSubscribeResource",
  });
  await translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).subscribeResource(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
  return {};
}

// 退订与订阅参数/校验完全对称；只解绑当前代实例的订阅键，不影响其他页面副本。
export async function unsubscribeMcpUiResource(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<Record<string, never>> {
  const params = parseParams(zcodeMcpUiResourceSubscriptionParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiUnsubscribeResource",
  });
  await translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).unsubscribeResource(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
  return {};
}

/** `mcp/uiReadResource`：插件页面发起的 resources/read（A7）；限同插件服务器、8 MiB、mimeType 白名单。 */
// 与 readMcpUiResource 的差异：不走实例绑定校验里的 resourceUri 相等约束（页面可读 server 内任意
// 白名单资源），但必须通过 serverName 归属校验。输出已剥 `_meta`、未经截断。
// 超限或 mime 不允许时抛 McpUiResourceRejectedError(-32602)，调用方据此提示而非静默失败。
export async function readMcpUiResourceForUi(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodeMcpUiReadResourceResult> {
  const params = parseParams(zcodeMcpUiReadResourceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiReadResource" });
  return translateScopeError(() =>
    createMcpUiHandlers({ logger: context.logger }).readResourceForUi(
      createMcpUiSessionAccess(record, params),
      params,
      { signal },
    ),
  );
}

// 把 mcp-ui 领域错误统一映射为 JSON-RPC 风格的 ProtocolRequestError：
// 保留原始错误码，并把 serverName/toolName/reason/uri 等可诊断字段放进 data；
// 未识别错误不包装，继续上抛给 server 的统一错误处理。
// 映射顺序与字段是契约：McpUiServerScopeError → 只带 serverName；McpUiToolAccessError → 加 reason/toolName/serverName；McpUiNotSupportedError → 加 reason/operation；McpUiResourceRejectedError → 加 reason/uri 与 error.detail；其余 throw error 原样上抛，绝不能兜底成 -32602，否则真实内部故障会被页面当成参数错误。
// data 只放定位字段，不放凭据或资源内容；requireSession 的会话错误发生在本函数调用之前，不经过这里。
async function translateScopeError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpUiServerScopeError) {
      throw new ProtocolRequestError(error.code, error.message, {
        serverName: error.serverName,
      });
    }
    if (error instanceof McpUiToolAccessError) {
      throw new ProtocolRequestError(error.code, error.message, {
        reason: error.reason,
        serverName: error.serverName,
        toolName: error.toolName,
      });
    }
    if (error instanceof McpUiNotSupportedError) {
      throw new ProtocolRequestError(error.code, error.message, {
        reason: error.reason,
        serverName: error.serverName,
        operation: error.operation,
      });
    }
    if (error instanceof McpUiResourceRejectedError) {
      throw new ProtocolRequestError(error.code, error.message, {
        reason: error.reason,
        uri: error.uri,
        ...error.detail,
      });
    }
    throw error;
  }
}

/**
 * `mcp/uiOpenInstance`：为插件页面签发实例凭证。
 *
 * 异步等待 + 同步复核是本函数的关键顺序：`waitForMcpAppConnection` 允许「session ready 但
 * MCP 尚未连上」的首开场景；等待结束后再次比对 session 记录与连接 identity/generation，
 * 因为等待期间 session 可能被替换或连接换代。四者任一不符即 -32001，不签发过期凭证。
 * 首次签发后登记三件事：工具调用活动转发到 v4 gateway、连接失效回调关闭实例、
 * abort 时清理 calls/工具注册/资源订阅并广播 PluginUiInstanceClosed。
 * 返回 lease（token + generation + cancel signal），token 即后续 scopeId。
 */
// 等待+复核的顺序不能省：await record.app.waitForMcpAppConnection(params.serverName) 覆盖「session ready 但 MCP 未连上」的首开，等待后必须重取 getMcpAppConnectionSnapshot 并同时比对 context.sessions.get(sessionId) === record、source 非空、current.identity === source.identity、current.generation === source.generation，任一不符抛 -32001，否则等待期间换 session 或换代仍会签发过期凭证。
// 首次签发（!active.watched）才登记三件事：active.onActivity 向 v4Gateway 转发 PluginUiAppToolCallRequested、record.app.onMcpAppConnectionInvalidated 关闭 lease、active.cancel.signal 的 once abort 回调清理 clearMcpUiInstanceCalls/工具注册/资源订阅并广播 PluginUiInstanceClosed；watched 后直接返回 lease，避免重复登记。
export async function openMcpUiInstance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeMcpUiOpenInstanceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiOpenInstance" });
  // session ready 不代表目标 MCP ready；首次签发等待连接，已有凭证校验仍保持同步拒绝失效来源。
  const source = await record.app.waitForMcpAppConnection(params.serverName);
  const current = record.app.getMcpAppConnectionSnapshot(params.serverName);
  if (
    context.sessions.get(params.sessionId) !== record ||
    !source ||
    current?.identity !== source.identity ||
    current.generation !== source.generation
  )
    throw new ProtocolRequestError(-32001, "MCP App connection is unavailable");
  const lease = mcpUiInstances.open(
    {
      workspace: params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath,
      accountContext: params.accountContext,
      sessionId: params.sessionId,
      pluginId: params.pluginId,
      serverName: params.serverName,
      scopeId: params.scopeId,
      resourceUri: params.resourceUri,
      ownerWebContentsId: params.ownerWebContentsId,
    },
    source,
  );
  const active = mcpUiInstances.validate(lease, params, source);
  if (active.watched) return lease;
  active.watched = true;
  active.onActivity = (callId, activity) =>
    context.v4Gateway?.ingest(params.sessionId, {
      id: createEventId(),
      sessionId: params.sessionId as never,
      type: SessionEventType.PluginUiAppToolCallRequested,
      timestamp: new Date(),
      traceId: String(record.traceContext.traceId) as never,
      sequenceNumber: 0,
      payload: {
        pluginId: params.pluginId,
        serverName: params.serverName,
        subscribers: [{ scopeId: lease.token, generation: lease.generation, instance: lease }],
        callId,
        toolName: "",
        arguments: {},
        activity,
      },
    });
  const off = record.app.onMcpAppConnectionInvalidated(params.serverName, () =>
    mcpUiInstances.close(lease),
  );
  active.cancel.signal.addEventListener(
    "abort",
    () => {
      off();
      clearMcpUiInstanceCalls(params.sessionId, lease.token);
      getMcpUiAppToolRegistry(context).unregister(params.sessionId, {
        scopeId: lease.token,
        generation: lease.generation,
      });
      void record.app
        .unsubscribeMcpResourcesForUi(`${params.sessionId}|${lease.token}|`)
        .catch(() => undefined);
      context.v4Gateway?.ingest(params.sessionId, {
        id: createEventId(),
        sessionId: params.sessionId as never,
        type: SessionEventType.PluginUiInstanceClosed,
        timestamp: new Date(),
        traceId: String(record.traceContext.traceId) as never,
        sequenceNumber: 0,
        payload: {
          pluginId: params.pluginId,
          serverName: params.serverName,
          subscribers: [{ scopeId: lease.token, generation: lease.generation, instance: lease }],
        },
      });
    },
    { once: true },
  );
  return lease;
}
/**
 * `mcp/uiCloseInstance`：关闭实例并释放其资源。
 * 允许连接已断开（故用 find 后 validate，而不是 requireSession），但凭证仍须与实例来源一致，
 * 防止用另一连接/会话的凭证撤销当前实例。`onlyIfIdle=true` 时若有进行中调用直接返回
 * `{closed:false}`，由调用方稍后重试 —— 不在忙时强拆。
 * 关闭成功才反注册工具、退订资源；返回 `{closed}` 表示本次是否真正关闭（幂等）。
 */
export async function closeMcpUiInstance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeMcpUiCloseInstanceParamsSchema, rawParams);
  const active = mcpUiInstances.find(params.instance.token);
  // 清理允许连接已经断开，但不能用另一来源或会话的凭证撤销当前实例。
  if (active) mcpUiInstances.validate(params.instance, params, active.source);
  if (params.onlyIfIdle && mcpUiInstances.isBusy(params.instance)) return { closed: false };
  if (mcpUiInstances.close(params.instance)) {
    getMcpUiAppToolRegistry(context).unregister(params.sessionId, {
      scopeId: params.instance.token,
      generation: params.instance.generation,
    });
    await context.sessions
      .get(params.sessionId)
      ?.app.unsubscribeMcpResourcesForUi(`${params.sessionId}|${params.instance.token}|`);
  }
  return { closed: true };
}

// 只做凭证校验、不改变状态：宿主用它在每次操作前确认实例仍属于当前连接代次。
export async function validateMcpUiInstance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeMcpUiCloseInstanceParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiValidateInstance" });
  mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  return {};
}
