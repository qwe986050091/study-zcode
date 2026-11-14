// INV-01 请求序号单调递增：守住位置 模块计数；改错故障 过期响应覆盖新状态。
// INV-02 在途请求按 store 隔离：守住位置 弱映射；改错故障 多窗口互相取消。
// INV-03 请求键含工作区与插件：守住位置 buildToggleRequestKey；改错故障 不同作用域串扰。
// INV-04 缺工作区直接失败：守住位置 入口判断；改错故障 无上下文也发请求。
// INV-05 乐观投影先行：守住位置 set 调用；改错故障 开关长时间无响应。
// INV-06 投影同时记录失败标记：守住位置 set 字段；改错故障 旧失败提示残留。
// INV-07 插件快照用于回滚：守住位置 previousPlugin；改错故障 失败后无法恢复。
// INV-08 响应需校验是否当前请求：守住位置 isCurrentRequest；改错故障 旧响应覆盖新写入。
// INV-09 非当前请求只通知不落库：守住位置 早退分支；改错故障 过期结果写回状态。
// INV-10 成功后以服务端结果为准：守住位置 结果投影；改错故障 本地状态与服务端分叉。
// INV-11 成功后刷新列表：守住位置 loadInto；改错故障 其他插件状态陈旧。
// INV-12 成功后通知变更：守住位置 notifyPluginManagementChange；改错故障 其他窗口不刷新。
// INV-13 失败返回 false：守住位置 返回值；改错故障 调用方误判成功。
// INV-14 失败仅当前请求才回滚：守住位置 条件判断；改错故障 覆盖后续操作。
// INV-15 失败记录插件标识：守住位置 lastFailedPluginId；改错故障 界面无法定位。
// INV-16 失败信息统一转换：守住位置 toMessage；改错故障 非 Error 值丢失。
// INV-17 结束清除切换标记：守住位置 finally；改错故障 开关永久禁用。
// INV-18 结束清理请求记录：守住位置 条件删除；改错故障 映射无限增长。
//
// 模块职责：以乐观更新方式启停插件，并处理过期响应与失败回滚。
// 状态所有权：插件状态归 store；在途请求记录归模块级弱映射。
// 阅读顺序：先看请求键与序号，再看乐观投影，最后看成功与失败收尾。
import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  buildWorkspaceKey,
  loadInto,
  notifyPluginManagementChange,
} from "@/store/pluginManagementStoreLoading.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// nextToggleRequestId 单调递增，进程内计数即可区分同一插件的连续切换。
// 响应回来时比对 requestId 与请求键，落后即视为过期响应。
// 不引入全局时钟或随机数，模块级计数已足够唯一。
let nextToggleRequestId = 0;
// 按 store 隔离在途请求。
// requestsByStore 的键是 buildToggleRequestKey 生成的切换请求键。
// 弱引用避免长期持有。
const requestsByStore = new WeakMap<() => PluginManagementState, Map<string, number>>();

// buildWorkspaceKey 先归一 workspacePath/workspaceIdentity/authorityKey。
// configScope 为 null 时用 "effective" 占位，保证键三段固定。
// pluginId 放在末段，同一工作区下按插件隔离在途请求。
function buildToggleRequestKey(input: {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  pluginId: string;
}): string {
  const workspaceKey = buildWorkspaceKey(
    input.workspacePath,
    input.workspaceIdentity,
    input.authorityKey,
  );
  return `${workspaceKey}\u0000${input.configScope ?? "effective"}\u0000${input.pluginId}`;
}

// setPluginEnabledOptimistically 先写乐观投影，再发起服务端切换。
// 失败时用 previousPlugin 快照回滚，避免开关停在错误状态。
// 返回值表示本次结果是否仍对应当前请求，调用方据此决定是否提示。
export async function setPluginEnabledOptimistically(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginId: string,
  enabled: boolean,
  pluginService: IPluginManagementService,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  // workspacePath 为空直接返回 false，无工作区上下文不发请求。
  // workspaceIdentity 与 authorityKey 一并取出，参与请求键构造。
  // configScope 随请求键一起传给服务层，缺省为 effective。
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  let activeToggleRequests = requestsByStore.get(get);
  if (!activeToggleRequests) {
    activeToggleRequests = new Map();
    requestsByStore.set(get, activeToggleRequests);
  }

  const requestKey = buildToggleRequestKey({
    workspacePath,
    workspaceIdentity,
    authorityKey,
    configScope,
    pluginId,
  });
  const requestId = ++nextToggleRequestId;
  activeToggleRequests.set(requestKey, requestId);
  // isCurrentRequest 同时比对请求序号与 buildToggleRequestKey。
  // 上下文快照（工作区、作用域、插件）必须与发起时一致。
  // activeToggleRequests 中记录的 requestId 也要匹配，防止同键串扰。
  const isCurrentRequest = (): boolean => {
    const current = get();
    return (
      activeToggleRequests.get(requestKey) === requestId &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope &&
      current.togglingPluginId === pluginId
    );
  };

  const previousPlugin = get().plugins.find((plugin) => plugin.id === pluginId);
  // 启停 RPC 和后续列表刷新存在可感知延迟。先投影最终状态，让开关立刻响应；失败时
  // 在 catch 中恢复快照，避免用户把正常的异步写入误判成“点了没反应”。
  set({
    togglingPluginId: pluginId,
    error: null,
    lastFailedPluginId: null,
    ...(previousPlugin
      ? {
          plugins: get().plugins.map((plugin) =>
            plugin.id === pluginId ? { ...plugin, enabled, enabledSource: scope } : plugin,
          ),
        }
      : {}),
  });

  try {
    const result = await pluginService.setPluginEnabled({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginId,
      enabled,
      scope,
    });
    if (!isCurrentRequest()) {
      notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    set({
      plugins: get().plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, ...result.plugin, enabled: result.enabled } : plugin,
      ),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentRequest();
  } catch (error) {
    // 启停失败时必须返回 false 并恢复 optimistic projection，避免
    // 调用方继续刷新其它能力，或让界面把失败的切换误报成成功。
    logger.error("[plugins] setEnabled failed", { pluginId, enabled, error: toMessage(error) });
    if (isCurrentRequest()) {
      set({
        error: toMessage(error),
        lastFailedPluginId: pluginId,
        ...(previousPlugin
          ? {
              plugins: get().plugins.map((plugin) =>
                plugin.id === pluginId ? previousPlugin : plugin,
              ),
            }
          : {}),
      });
    }
    return false;
  } finally {
    if (isCurrentRequest()) {
      set({ togglingPluginId: null });
    }
    if (activeToggleRequests.get(requestKey) === requestId) {
      activeToggleRequests.delete(requestKey);
    }
  }
}
