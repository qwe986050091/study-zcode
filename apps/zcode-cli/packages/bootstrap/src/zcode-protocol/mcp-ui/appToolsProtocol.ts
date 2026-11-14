import {
  SessionEventType,
  createEventId,
  type PluginUiAppToolCallRequestedPayload,
  type SessionEvent,
} from "@zcode/contracts";
import {
  zcodeMcpUiClaimAppToolCallParamsSchema,
  zcodeMcpUiRegisterAppToolsParamsSchema,
  zcodeMcpUiResolveAppToolCallParamsSchema,
  zcodeMcpUiUnregisterAppToolsParamsSchema,
  type ZCodeMcpUiAppToolAcceptedResult,
  type ZCodeMcpUiRegisterAppToolsResult,
  type ZCodeMcpUiUnregisterAppToolsResult,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "../server-types.js";
import { McpUiAppToolRegistry } from "./appTools.js";
import { McpUiServerScopeError } from "./contract.js";
import { assertMcpUiServerScope } from "./handlers.js";
import { mcpUiInstances } from "./instances.js";
import { createMcpUiSessionAccess } from "./sessionAccess.js";

/**
 * App-Provided Tools 的四个协议方法。登记表按 agent 进程（context）唯一；信箱投递用 v4Gateway.ingest 的
 * live-only 事件（seq 0），与资源通知同一条路。
 */
const registries = new WeakMap<ZCodeProtocolAgentServerContext, McpUiAppToolRegistry>();

/**
 * 取（并按需创建）agent 进程内的 App-Tools 登记表，按协议 context 缓存。
 * 两个宿主回调把登记表接到会话 runtime：
 * - applyTools：整体替换该会话暴露给模型的工具集合，并绑定 execute；会话已关闭返回 null（登记表随之清空）；
 * - publishCall：把一次待执行调用写成 PluginUiAppToolCallRequested live-only 事件（seq 0），只投给目标实例；
 * 事件里的 traceId 取自会话 traceContext，不另造关联 id。
 */
export function getMcpUiAppToolRegistry(
  context: ZCodeProtocolAgentServerContext,
): McpUiAppToolRegistry {
  let registry = registries.get(context);
  if (!registry) {
    registry = new McpUiAppToolRegistry({
      applyTools: (sessionId, definitions, execute) => {
        const record = context.sessions.get(sessionId);
        return record
          ? record.app.replaceMcpAppProvidedTools(
              definitions.map((definition) => ({
                ...definition,
                retainExecution: (callId: string) =>
                  mcpUiInstances.retain(definition.scopeId, callId),
              })),
              execute,
            )
          : null;
      },
      publishCall: (sessionId, target, call) => {
        const record = context.sessions.get(sessionId);
        if (!record || !context.v4Gateway) return;
        const payload: PluginUiAppToolCallRequestedPayload = {
          pluginId: target.pluginId,
          serverName: target.serverName,
          subscribers: [{ ...target.instance, instance: target.credential }],
          cancelled: call.cancelled,
          callId: call.callId,
          toolName: call.toolName,
          arguments: call.arguments,
        };
        const event: SessionEvent = {
          id: createEventId(),
          sessionId: sessionId as never,
          type: SessionEventType.PluginUiAppToolCallRequested,
          timestamp: new Date(),
          traceId: String(record.traceContext.traceId) as never,
          // 只进 live 投影、不落盘：seq 0 让 gateway 分配 transport 序号。
          sequenceNumber: 0,
          payload,
        };
        context.v4Gateway.ingest(sessionId, event);
      },
      ...(context.logger ? { logger: context.logger } : {}),
    });
    registries.set(context, registry);
  }
  return registry;
}

/**
 * 把 App 归属错误翻译成协议错误：McpUiServerScopeError 保留 code 与 serverName，
 * 其余异常原样冒泡（不做兜底吞错）。
 */
async function withScopeError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpUiServerScopeError) {
      throw new ProtocolRequestError(error.code, error.message, { serverName: error.serverName });
    }
    throw error;
  }
}

/**
 * mcp/uiRegisterAppTools：先做 serverName 归属校验（fail closed），再校验 scopeId/generation 与凭证一致，
 * 最后交给登记表整体同步暴露集合。返回本实例实际被暴露的 { name, modelName }。
 */
export async function registerMcpUiAppTools(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiRegisterAppToolsResult> {
  const params = parseParams(zcodeMcpUiRegisterAppToolsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiRegisterAppTools",
  });
  return withScopeError(async () => {
    await assertMcpUiServerScope(createMcpUiSessionAccess(record, params), params);
    if (
      params.scopeId !== params.instance.token ||
      params.generation !== params.instance.generation
    )
      throw new Error("Invalid MCP App registration binding");
    return getMcpUiAppToolRegistry(context).register(params);
  });
}

/**
 * mcp/uiUnregisterAppTools：页面关闭时注销本实例工具，并触发一次暴露集合重算。
 * 这是 best effort：会话已关闭时登记表已随会话清空，直接返回 removed=0 而不是报错。
 */
export async function unregisterMcpUiAppTools(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiUnregisterAppToolsResult> {
  const params = parseParams(zcodeMcpUiUnregisterAppToolsParamsSchema, rawParams);
  if (params.scopeId !== params.instance.token || params.generation !== params.instance.generation)
    throw new Error("Invalid MCP App binding");
  // 实例销毁时的 best effort 收尾：会话已关闭（登记已清空）不报错。
  if (!context.sessions.has(params.sessionId)) return { removed: 0 };
  return { removed: getMcpUiAppToolRegistry(context).unregister(params.sessionId, params) };
}

/**
 * mcp/uiClaimAppToolCall：渲染端认领一次待执行调用。先用连接快照校验凭证仍有效（错 server /
 * 旧代际会撤销凭证），再由登记表核对 callId 归属；重复认领幂等返回 accepted=true。
 */
export async function claimMcpUiAppToolCall(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiAppToolAcceptedResult> {
  const params = parseParams(zcodeMcpUiClaimAppToolCallParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiClaimAppToolCall" });
  mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  if (params.scopeId !== params.instance.token || params.generation !== params.instance.generation)
    throw new Error("Invalid MCP App binding");
  return { accepted: getMcpUiAppToolRegistry(context).claim(params) };
}

/**
 * mcp/uiResolveAppToolCall：渲染端回传执行结果或错误。只接受已认领且 callId 属于本实例的调用；
 * 结果大小超限由登记表转成错误结算，未认领/已结算返回 accepted=false。
 */
export async function resolveMcpUiAppToolCall(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpUiAppToolAcceptedResult> {
  const params = parseParams(zcodeMcpUiResolveAppToolCallParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    operation: "mcp/uiResolveAppToolCall",
  });
  mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  if (params.scopeId !== params.instance.token || params.generation !== params.instance.generation)
    throw new Error("Invalid MCP App binding");
  return { accepted: getMcpUiAppToolRegistry(context).resolve(params) };
}

/**
 * 会话关闭时的收尾：先按 sessionId 关闭全部 App 实例（abort 在途调用），再清登记表。
 * 顺序保证实例取消信号先于登记表丢弃，避免仍在执行的调用拿到已失效的凭证。
 */
export function clearMcpUiAppToolsForSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): void {
  mcpUiInstances.closeSession(sessionId);
  registries.get(context)?.clearSession(sessionId);
}
