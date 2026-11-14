import {
  collectTelemetryRendererContext,
  resolveWorkspaceTelemetryDetail,
  type RendererTelemetryEventPayload,
} from "@zcode/shared";
/**
 * ============================================================================
 * services/plugins/pluginManagementService.ts —— 插件管理的 Host 薄服务
 * ============================================================================
 *
 * 【定位】设置页插件管理的唯一 Host 侧消费点：把 UI 的插件操作翻译成
 * IZCodeAgentService 的 agent 协议往返，并上报遥测。
 *
 * 【事实源】插件安装/市场/启停的唯一事实源在 zcode-cli 进程（读写 ~/.zcode
 * 插件目录并热更新运行态）。Host 不保存插件副本，本文件也不做本地状态缓存。
 *
 * 【收敛价值】UI 不再直接触 IZCodeAgentService；plugins/* 旧协议词的消费面
 * 从 UI 散点收拢到这里一处。新增插件能力应加在本服务与 agent 协议，
 * 不要回到已退役的 pluginsService。
 * ============================================================================
 */

// INV-01：本服务不缓存插件状态，读写全部转发给 zcodeAgentService（事实源在 CLI 进程）；
// 缓存会与 ~/.zcode 实际目录分叉，且感知不到热更新。
// INV-02：observe 是唯一上报入口，成功/失败各上报一次且仅一次；漏报压低成功率，
// 重复上报放大失败率。
// INV-03：上报不得改变业务返回、不得触发重试（report 内吞掉同步与异步异常）。
// INV-04：启停共用同一代码路径，动作名由 params.enabled 分流，防止两条路径字段漂移。
// 设置页插件管理薄服务实现——plugins/* 旧协议词的唯一 host 侧消费点。
// 插件安装/市场/启停的事实源在 zcode-cli 进程（读写 ~/.zcode 插件目录并热更新
// 运行态），host 无副本，故实现保持 agent 协议往返；收敛价值在 UI 层不再直触
// IZCodeAgentService，词表消费面从 UI 散点收拢到本文件一处。
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";

// [权衡] 只 Pick 用到的方法而非整个 IZCodeAgentService：测试可传最小桩，也防止
// 本层调用未声明的能力（如 session 管理）。
// 注入 now 是为了让 duration 在测试中确定，直接用 Date.now 会让断言抖动。
export interface PluginManagementServiceDependencies {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  now?: () => number;
  zcodeAgentService: Pick<
    IZCodeAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
  >;
}

// 只包装会变更磁盘/运行态的动作；listPlugins、validatePlugin、describePlugin 等只读调用
// 直接透传，避免只读操作污染生命周期指标。透传保持入参原样（telemetry 由 agent 侧使用）。
export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.zcodeAgentService;
  const now = dependencies.now ?? Date.now;
// Params 是各动作的并集，不同动作只消费其中一部分，report 不得假设字段一定存在。
  type Params =
    import("../zcode-agent/zcodeAgentPluginParams.js").ZCodeAgentPluginMutationTarget & {
      pluginId?: string;
      pluginName?: string;
      marketplace?: string;
      scope?: "user" | "workspace";
      dryRun?: boolean;
      removeCache?: boolean;
    };
// Result 只建模遥测要用的字段：diagnostics 判错、installedPlugins 判后置、removedPlugin 判真删。
  type Result = {
    diagnostics?: Array<{ severity?: string; code?: string }>;
    installedPlugins?: Array<{
      id: string;
      marketplace: string;
      version?: string;
      scope: string;
      listing?: { publisherType?: string };
    }>;
    removedPlugin?: { id: string; marketplace: string; version?: string };
    pluginId?: string;
    marketplaces?: unknown[];
    marketplace?: { id: string };
    plugin?: { id: string; marketplace: string; source: string; version?: string };
  };
// report 是纯观测函数：只读 params/result/error，不修改、不 await 业务。
// dryRun 或无上报器时直接返回：预演不产生真实变更，计入成功率会稀释指标。
  const report = (
    action: string,
    params: Params,
    startedAt: number,
    result?: Result,
    error?: unknown,
  ) => {
    if (params.dryRun || !dependencies.reportTelemetryEvent) return;
    const diagnostics = result?.diagnostics ?? [];
    const hasError = diagnostics.some((item) => item.severity === "error");
    // JSON-RPC 保留原始异常类型在 data.name；不能用取消请求的 ACK 或错误文案推断。
// 只有对象型 data 才读 name/code，字符串或 null 直接忽略，避免对任意异常做属性访问。
// [权衡] 同时看 error.name 与 error.data.name：错误经传输层重建后只有一层能保留 AbortError。
    const errorData =
      error instanceof Error && "data" in error && error.data && typeof error.data === "object"
        ? (error.data as { name?: unknown; code?: unknown })
        : undefined;
// 取消判定四路取或：传输层 name、业务 code、诊断 code 任一命中即 cancelled，不计 failure。
    const cancelled =
      errorData?.name === "AbortError" ||
      errorData?.code === "plugin_operation_cancelled" ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          ("code" in error && error.code === "plugin_operation_cancelled"))) ||
      diagnostics.some((item) => item.code === "plugin_operation_cancelled");
// 回退链：显式 id → name@marketplace → 结果 pluginId；按名卸载时只能靠结果兜底。
    const pluginId =
      params.pluginId ??
      (params.pluginName && params.marketplace
        ? `${params.pluginName}@${params.marketplace}`
        : result?.pluginId);
// 安装后按 id 在 installedPlugins 里找；找不到说明未真正落盘，后续会判 failure。
    const installed = result?.installedPlugins?.find((item) => item.id === pluginId);
// 状态机按优先级短路：cancelled > failure > partial > noop > success。
// [权衡] partial 只给「批量 update 且有部分成功」：install 没有部分语义，有错即 failure。
// uninstall 没有 removedPlugin 说明本来就不存在，记 noop 而不是失败。
// 嵌套三元保持「互斥且完备」：每个分支对应一个可观测结果，拆函数会丢掉这个结构。
    const status = cancelled
      ? "cancelled"
      : error
        ? "failure"
        : hasError
          ? action === "update" && !params.pluginId && result?.installedPlugins?.length
            ? "partial"
            : "failure"
          : action === "uninstall" && !result?.removedPlugin
            ? "noop"
            : action === "install" && !installed
              ? "failure"
              : action === "update" && !result?.installedPlugins?.length
                ? "noop"
                : "success";
// detail 是扁平 string map：遥测 schema 要求字段类型稳定，数字在入参前转字符串。
// 可选维度用条件展开而非 undefined：不同上报器对 undefined 的序列化行为不一致。
// scope 回退：入参显式 scope → 安装结果 scope → unknown。
    const detail: Record<string, string> = {
      schema_version: "1",
      action,
      result: status,
      duration_ms: String(Math.max(0, now() - startedAt)),
      entry: params.telemetry?.entry ?? "unknown",
      trigger: params.telemetry?.trigger ?? "user",
      client_kind: params.telemetry?.client_kind ?? "unknown",
      scope: params.scope ?? installed?.scope ?? "unknown",
      ...resolveWorkspaceTelemetryDetail(params),
// plugin_id 单独条件展开：缺失时不写空串，避免污染维度基数。
      ...(pluginId || result?.removedPlugin
        ? { plugin_id: pluginId ?? result!.removedPlugin!.id }
        : {}),
// marketplace 四路回退：入参 → 安装结果 → 卸载结果 → 新建市场结果；全缺才省略该维度。
      ...(params.marketplace || installed || result?.removedPlugin || result?.marketplace
        ? {
            marketplace:
              params.marketplace ??
              installed?.marketplace ??
              result?.removedPlugin?.marketplace ??
              result!.marketplace!.id,
          }
        : {}),
// version_after/before 分列：升级场景要同时看到前后版本才能算跨度。
      ...(installed?.version ? { version_after: installed.version } : {}),
      ...(result?.removedPlugin?.version ? { version_before: result.removedPlugin.version } : {}),
      ...(installed?.listing?.publisherType
        ? { publisher_type: installed.listing.publisherType }
        : {}),
// 只有 uninstall 带 remove_cache，默认 true，与 agent 侧默认一致，避免两边语义分叉。
      ...(action === "uninstall" ? { remove_cache: String(params.removeCache ?? true) } : {}),
// 仅非成功结果带 error_category；cancelled 优先于 diagnostic/transport，防止用户取消被记成故障。
      ...(status === "failure" || status === "partial" || status === "cancelled"
        ? { error_category: cancelled ? "cancelled" : hasError ? "diagnostic" : "transport" }
        : {}),
    };
    // 上报只观察最终结果，不等待网络，失败不得改变原业务返回或触发业务重试。
    try {
// [失败路径] 上报 fire-and-forget：Promise.resolve 包住同步 throw，catch 吞异步拒绝，
// 外层 try 吞同步 throw，任一失败都不得冒泡到业务栈。
      void Promise.resolve(
        dependencies.reportTelemetryEvent({
          elementName: "plugin_lifecycle",
          eventRegion: "app",
          eventType: "result",
          context: collectTelemetryRendererContext(),
          eventExtraDetail: detail,
        }),
      ).catch(() => {});
    } catch {
      /* 观测端故障与业务隔离。 */
    }
  };
// observe 只做三件事：记开始时间、剥离 telemetry、成功/失败各上报一次。
// [事务] 语义同事务边界：invoke 抛错时先上报 failure 再原样 rethrow，调用方看到的错误不变。
// 剥离 telemetry 后的 clean 才是 agent 入参，透传会污染 agent 的参数校验。
  const observe = async <T extends Result>(
    action: string,
    params: Params,
    invoke: (clean: Params) => Promise<T>,
  ): Promise<T> => {
// 时间点在 invoke 之前取，覆盖网络往返与 agent 执行；放在之后会漏掉主要耗时。
    const startedAt = now();
// catch 分支仍用原始 params（含 telemetry），因为上报要读 entry/trigger 维度。
    const { telemetry: _telemetry, ...clean } = params;
    try {
      const result = await invoke(clean);
      report(action, params, startedAt, result);
      return result;
    } catch (error) {
      report(action, params, startedAt, undefined, error);
      throw error;
    }
  };
  return {
// 只读调用直接透传，Promise 引用不变，便于上层取消/超时。
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    addPluginMarketplace: (params) =>
      observe("source_add", params, (clean) => agent.addPluginMarketplace(clean as typeof params)),
    removePluginMarketplace: (params) =>
      observe("source_remove", params, (clean) =>
        agent.removePluginMarketplace(clean as typeof params),
      ),
    updatePluginMarketplace: (params) =>
      observe("source_refresh", params, (clean) =>
        agent.updatePluginMarketplace(clean as typeof params),
      ),
    installPlugin: (params) =>
      observe("install", params, (clean) => agent.installPlugin(clean as typeof params)),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) =>
      observe("uninstall", params, (clean) => agent.uninstallPlugin(clean as typeof params)),
    updatePlugin: (params) =>
      observe("update", params, (clean) => agent.updatePlugin(clean as typeof params)),
    restoreBuiltinPlugin: (params) =>
      observe("restore", params, (clean) => agent.restoreBuiltinPlugin(clean as typeof params)),
    configurePlugin: (params) =>
      observe("configure", params, (clean) => agent.configurePlugin(clean as typeof params)),
    resetPluginConfig: (params) =>
      observe("reset_config", params, (clean) => agent.resetPluginConfig(clean as typeof params)),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
// 启停共用 observe，动作名按 enabled 分流；二者耗时与失败特征不同，合并会让指标失去区分度。
    setPluginEnabled: (params) =>
      observe(params.enabled ? "enable" : "disable", params, (clean) =>
        agent.setPluginEnabled(clean as typeof params),
      ),
  };
}
