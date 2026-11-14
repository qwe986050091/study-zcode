// INV-01 工具登记必须绑定实例代际，注销也带同一代际：守住位置 instanceParams；改错故障 旧页面注销掉新页面的工具。
// INV-02 只有页面声明工具能力才登记：守住位置 onInitialized 首个判断；改错故障 无工具页面产生空登记与无谓刷新。
// INV-03 每次刷新先取运行纪元，返回前必须二次校验：守住位置 纪元变量与两处当前性判断；改错故障 过期刷新覆盖新实例的登记。
// INV-04 登记在途被替换时必须补注销：守住位置 登记后的补注销分支；改错故障 agent 暴露已关闭页面的工具。
// INV-05 列表翻页有硬上限，且游标不前进即停：守住位置 翻页循环；改错故障 页面返回环形游标时死循环。
// INV-06 刷新间隔至少 1 秒，窗口内合并为一次尾随刷新：守住位置 排程函数；改错故障 工具变更风暴打满 agent。
// INV-07 正在刷新时新的刷新请求只置标志，不排队多个定时器：守住位置 刷新中分支；改错故障 重入刷新互相覆盖登记。
// INV-08 已存在定时器时不再新建：守住位置 定时器句柄判断；改错故障 多个定时器并发触发刷新。
// INV-09 认领与回传都按调用标识幂等重试：守住位置 重试包裹；改错故障 传输抖动导致调用永久悬挂。
// INV-10 agent 明确拒绝不重试：守住位置 认领返回值判断；改错故障 被拒调用反复轰炸页面。
// INV-11 取消后不再认领也不再执行：守住位置 中止信号检查；改错故障 用户取消后页面仍执行工具。
// INV-12 页面执行超时与错误消息长度都有上限：守住位置 执行参数与消息切片；改错故障 长错误撑爆回传载荷。
// INV-13 执行异常一律转成错误结果回传，不抛出：守住位置 执行段捕获；改错故障 页面异常导致回传链路断开。
// INV-14 同一调用标识只能开始一次，重复投递直接丢弃：守住位置 已开始集合；改错故障 投影重放让页面执行两次。
// INV-15 执行中用中止控制器登记，重置与销毁时统一中止：守住位置 调用映射；改错故障 页面卸载后仍持有请求。
// INV-16 忙碌状态由进行中调用与挂载态共同决定：守住位置 isBusy；改错故障 页面显示的忙碌状态与实际不符。
// INV-17 重置与销毁都要清理定时器、调用记录与登记：守住位置 两个收尾方法；改错故障 泄漏定时器并残留登记。
// INV-18 代际未知时所有操作直接返回：守住位置 刷新与执行的首行；改错故障 端口未到达时发起无效调用。
//
// 模块职责：把插件页面暴露的工具发现、登记与调用转发接到 agent 的实例信箱上。
// 状态所有权：登记表与调用裁决归 agent；本模块只持有本实例的调用记录、挂载态与刷新节流状态。
// 阅读顺序：先看依赖与常量，再读列表、刷新、节流与重试，最后看执行与两个收尾方法。
import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { IPluginUiAppToolsService, PluginUiPluginScope } from "@zcode/services";
import {
  MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE,
  MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS,
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  normalizeMcpAppsAppTools,
  type McpAppsAppToolCallRequest,
  type McpAppsAppToolCallResult,
} from "@zcode/shared/mcp-apps";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/** tools/list 翻页上限：够取满 50 个工具，防页面返回无穷游标。 */
const MAX_TOOL_LIST_PAGES = 10;
/**
 * 认领与回传按 callId 幂等：传输失败重试；`accepted: false` 是 agent 的明确裁决，不重试。
 * 总等待（0.5 s + 1 s）留在 5 s 认领期限内。
 */
export const PLUGIN_UI_APP_TOOL_RPC_ATTEMPTS = 3;
export const PLUGIN_UI_APP_TOOL_RPC_RETRY_DELAY_MS = 500;

export interface PluginUiAppTools {
  isBusy(): boolean;
  /** 新端口到达：注销上一个页面实例的登记（新实例握手后按自己的能力重新登记）。 */
  resetForAttach(): void;
  /** 握手完成：页面声明了 appCapabilities.tools 才发现并登记，声明 listChanged 时监听变更。 */
  onInitialized(
    active: PluginUiHostBridge,
    capabilities: McpUiAppCapabilities | undefined,
    isCurrent: () => boolean,
  ): void;
  /** 信箱投递到达：认领并让页面执行（按 callId 去重）。 */
  execute(active: PluginUiHostBridge, call: McpAppsAppToolCallRequest): void;
  /** 实例销毁：注销登记（best effort）。 */
  dispose(): void;
}

/**
 * App-Provided Tools 的渲染端：发现页面工具并登记到 agent；模型发起的调用经实例信箱到达后
 * 认领 → 页面 tools/call → 回传。登记表与调用态都由 agent 持有，这里只记本实例已经开始处理的 callId。
 */
// 依赖全部注入：桥接服务、作用域、代际读取、定时器与日志。
// 代际读取返回未定义表示端口尚未到达，此时任何登记或调用都跳过。
// 定时器以回调形式注入，便于测试用假时钟驱动节流与重试。
// 日志只在有值时调用，生产路径可完全静默。
// [权衡] 不在本函数内读取全局单例，保证同一页面可创建多个隔离实例。
export function createPluginUiAppTools(deps: {
  bridge: IPluginUiAppToolsService;
  pluginScope: () => PluginUiPluginScope;
  scopeId: string;
  /** 当前实例代际；端口未到达时 undefined。 */
  currentGeneration: () => number | undefined;
  setTimer: (callback: () => void, ms: number) => () => void;
  now?: () => number;
  onBusyChange?(): void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}): PluginUiAppTools {
  const now = deps.now ?? Date.now;
  const pins = new Set<string>();
  let registeredGeneration: number | null = null;
  let refreshing = false;
  let pendingRefresh = false;
  let lastRefreshAt = 0;
  let cancelRefreshTimer: (() => void) | null = null;
  let epoch = 0;
  const started = new Set<string>();
  const calls = new Map<string, AbortController>();

  const instanceParams = (generation: number) => ({
    ...deps.pluginScope(),
    scopeId: deps.pluginScope().instance.token,
    generation,
  });

  const unregister = () => {
    const generation = registeredGeneration;
    registeredGeneration = null;
    if (generation === null) return;
    void deps.bridge.unregisterAppTools(instanceParams(generation)).catch(() => undefined);
  };

  // listTools 把游标翻页收敛成单个数组，调用方无需感知 nextCursor 协议。
  // 翻页在 page 达到 MAX_TOOL_LIST_PAGES 或 nextCursor 为空时停止。
  // nextCursor 与上一次相同即视为页面异常，立即 break 防止死循环。
  // listTools 任何一页失败都向上抛，由 refresh 段统一记日志。
  const listTools = async (active: PluginUiHostBridge) => {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = await active.listTools(cursor ? { cursor } : {});
      tools.push(...result.tools);
      if (tools.length >= MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE || !result.nextCursor) break;
      if (result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  };

  // 先取代际与运行纪元，二者共同标识「这一次刷新」。
  // normalizeMcpAppsAppTools 丢弃不合规工具，skipped 非空时只记一条日志。
  // [并发] 每次等待之后都要重新校验当前性，防止过期结果落地。
  // 尾随刷新只在当前实例且纪元未变时补排，避免跨代刷新。
  const refresh = async (active: PluginUiHostBridge, isCurrent: () => boolean) => {
    const generation = deps.currentGeneration();
    if (generation === undefined) return;
    const runEpoch = epoch;
    const bound = instanceParams(generation);
    refreshing = true;
    lastRefreshAt = now();
    try {
      const { tools, skipped } = normalizeMcpAppsAppTools(await listTools(active));
      if (skipped.length > 0) deps.log?.("[plugin-ui] app tools skipped", { skipped });
      if (!isCurrent() || runEpoch !== epoch) return;
      await deps.bridge.registerAppTools({ ...bound, tools });
      if (!isCurrent() || runEpoch !== epoch) {
        // 登记在途时实例已被替换 / 销毁：补一次注销，避免 agent 暴露已关闭页面的工具。
        void deps.bridge.unregisterAppTools(bound).catch(() => undefined);
        return;
      }
      registeredGeneration = generation;
    } catch (error) {
      deps.log?.("[plugin-ui] app tools registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshing = false;
    }
    if (pendingRefresh && isCurrent() && runEpoch === epoch) {
      pendingRefresh = false;
      schedule(active, isCurrent);
    }
  };

  // list_changed 节流：两次重新登记至少间隔 1 s，窗口内的多次通知合并为一次尾随刷新。
  // refreshing 为真时只置 pendingRefresh，由本次 refresh 的 finally 之后补排。
  // 已有定时器时不重复排程，窗口内的通知自然合并。
  // 等待为 0 时立即刷新，否则在剩余间隔后触发。
  const schedule = (active: PluginUiHostBridge, isCurrent: () => boolean) => {
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    if (cancelRefreshTimer) return;
    const wait = Math.max(0, lastRefreshAt + MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS - now());
    if (wait === 0) {
      void refresh(active, isCurrent);
      return;
    }
    cancelRefreshTimer = deps.setTimer(() => {
      cancelRefreshTimer = null;
      if (isCurrent()) void refresh(active, isCurrent);
    }, wait);
  };

  // withRetry 的重试只针对传输层抖动，业务拒绝不在重试范围内。
  // 退避时长按 attempt 线性增长，整体仍落在 PLUGIN_UI_APP_TOOL_RPC_ATTEMPTS 次窗口内。
  // [失败路径] attempt 达到 PLUGIN_UI_APP_TOOL_RPC_ATTEMPTS 后原样抛出，由调用方记日志。
  // 每次重试都重新执行 run，不做请求级缓存。
  const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (attempt >= PLUGIN_UI_APP_TOOL_RPC_ATTEMPTS) throw error;
        await new Promise<void>((resolve) => {
          deps.setTimer(resolve, PLUGIN_UI_APP_TOOL_RPC_RETRY_DELAY_MS * attempt);
        });
      }
    }
  };

  // 认领成功后才有权让页面执行，未获认领直接放弃。
  // [失败路径] 页面执行异常转成受长度限制的错误消息回传。
  // 回传同样走重试：裁决丢失会让 agent 侧调用悬挂。
  // 取消发生在认领与执行之间时直接 return，不再调用 resolveAppToolCall 回传。
  const run = async (
    active: PluginUiHostBridge,
    call: McpAppsAppToolCallRequest,
    cancel: AbortController,
  ) => {
    const generation = deps.currentGeneration();
    if (generation === undefined) return;
    const scope = { ...instanceParams(generation), callId: call.callId };
    const { accepted } = await withRetry(() => deps.bridge.claimAppToolCall(scope));
    if (!accepted || cancel.signal.aborted) return;
    let outcome: { result: McpAppsAppToolCallResult } | { error: { message: string } };
    try {
      const result = await active.callTool(
        { name: call.toolName, arguments: call.arguments },
        { timeout: MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS, signal: cancel.signal },
      );
      outcome = { result: result as McpAppsAppToolCallResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { error: { message: message.slice(0, MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS) } };
    }
    await withRetry(() => deps.bridge.resolveAppToolCall({ ...scope, ...outcome }));
  };

  return {
    isBusy: () => calls.size > 0 || pins.size > 0,
    // resetForAttach 先自增 epoch：端口更替即开新纪元，旧纪元在途操作全部失效。
    // 中止全部在途调用并清空记录，避免旧页面继续执行。
    // 最后注销上一个实例的登记，新实例握手后会重新登记。
    resetForAttach() {
      epoch += 1;
      for (const cancel of calls.values()) cancel.abort();
      calls.clear();
      pins.clear();
      cancelRefreshTimer?.();
      cancelRefreshTimer = null;
      pendingRefresh = false;
      started.clear();
      unregister();
    },
    onInitialized(active, capabilities, isCurrent) {
      if (!capabilities?.tools) return;
      if (capabilities.tools.listChanged) {
        active.setNotificationHandler("notifications/tools/list_changed", () => {
          if (isCurrent()) schedule(active, isCurrent);
        });
      }
      void refresh(active, isCurrent);
    },
    execute(active, call) {
      if (call.activity !== undefined) {
        if (call.activity) pins.add(call.callId);
        else pins.delete(call.callId);
        deps.onBusyChange?.();
        return;
      }
      if (call.cancelled) {
        calls.get(call.callId)?.abort();
        started.add(call.callId);
        return;
      }
      // 信箱按 callId 去重：投影重放 / 重复投递不会让页面执行两次。
      if (started.has(call.callId)) return;
      started.add(call.callId);
      const cancel = new AbortController();
      calls.set(call.callId, cancel);
      deps.onBusyChange?.();
      void run(active, call, cancel)
        .catch((error) => {
          deps.log?.("[plugin-ui] app tool call relay failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          calls.delete(call.callId);
          deps.onBusyChange?.();
        });
    },
    dispose() {
      epoch += 1;
      for (const cancel of calls.values()) cancel.abort();
      calls.clear();
      pins.clear();
      cancelRefreshTimer?.();
      cancelRefreshTimer = null;
      unregister();
    },
  };
}
