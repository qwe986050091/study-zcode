// INV-01 加载态是派生结果，不承载服务端事实；守住位置：loadInto 的回写分支；改错故障：界面显示过期插件清单，用户误删或误装。
// INV-02 同服务、同工作区、同配置层的在途查询只发一次；守住位置：loadsByService 与 loadKey 分支；改错故障：StrictMode 双触发导致重复请求与多次 30s 超时。
// INV-03 变更后启动的新查询不得复用变更前的在途任务；守住位置：fresh 与 revision 比较分支；改错故障：安装完成后列表仍是变更前快照。
// INV-04 配置层参与去重键，user 与 workspace 各占一桶；守住位置：loadKey 拼接处；改错故障：切换配置层后读到另一层的插件清单。
// INV-05 回写结果前必须核对当前上下文；守住位置：工作区路径、身份、授权键、配置层四路比较；改错故障：切换工作区后旧响应覆盖新页面。
// INV-06 只有最近发起的操作能写错误态；守住位置：ownsVisibleOperation 分支；改错故障：旧操作失败覆盖新操作的成功提示。
// INV-07 失败时保留上次成功的插件数据，只把加载态置为 false 并写入错误；守住位置：runLoadInto 的两级降级；改错故障：网络抖动后整页插件消失。
// INV-08 加载中与错误提示互斥，进入操作即清空错误；守住位置：beginPluginOperation 的状态写入；改错故障：加载中同时显示红色错误条。
// INV-09 overview 失败时不得把来源状态标记为已知；守住位置：marketplaceAvailabilityKnown 赋值；改错故障：来源插件被批量误判为孤立安装。
// INV-10 离开或切换上下文后不再写状态；守住位置：loadInto 回写前的上下文比较；改错故障：已切换页面仍触发渲染更新与状态污染。
// INV-11 操作收尾只移除自己的条目；守住位置：beginPluginOperation 返回的清理闭包；改错故障：并发安装时清掉他人进度，进度环提前消失。
// INV-12 每次操作递增 operationVersion，作为可见性判据；守住位置：beginPluginOperation 与 runWorkspaceOperation；改错故障：迟到的失败态覆盖新一次操作。
// INV-13 通知监听器异步执行，单个监听器失败不影响其他监听器；守住位置：notifyPluginManagementChange 的循环；改错故障：一个投影刷新抛错后其余视图停止刷新。
// INV-14 revision 只增不减，作为失效信号时间戳；守住位置：notifyPluginManagementChange 首行；改错故障：变更前后查询无法区分，去重逻辑失效。
// INV-15 缓存键按授权键优先、身份次之、路径兜底；守住位置：buildWorkspaceKey；改错故障：同一远程工作区被拆成多个缓存桶，重复拉取。
// INV-16 相关性判断对 workspace 作用域要求键相等，对 user 作用域要求来源键相等；守住位置：isPluginManagementChangeRelevant；改错故障：跨工作区收到无关刷新或漏掉应刷新。
// INV-17 后台刷新不覆盖本视图未处理的操作错误；守住位置：loadInto 的 background 合并分支；改错故障：本视图报错被后台成功结果悄然清除。
// INV-18 在途条目在任务结束时按身份清理，避免长期驻留；守住位置：loadInto 的 finally 块；改错故障：内存泄漏，多次切换后旧任务被误复用。
//
// 本文件是插件管理的加载与失效协调层：去重、失效信号、上下文核对、失败兜底四条线并行。
// 写出状态的地方只有三处：开始操作、操作回写、加载回写；新增写入路径前请重新核对上文不变量。
// 阅读顺序建议：先看 loadsByService 的去重键，再看 revision 失效语义，最后看两级降级的字段差异。
import type { IPluginManagementService } from "@zcode/services";
import {
  remoteHostIdFromWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type ZCodePluginScope,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

// [失败路径] 统一错误文案：Error 取消息，其它值转字符串，避免把对象字面量直接抛给界面。
// 日志与 error 字段共用这份文案，排查时可直接对照同一句话。
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// [权衡] 缓存键由授权键与身份/路径两段拼成，用 NUL 分隔以防前缀碰撞。
// 空授权键落到 workspace 段，保证本地未授权场景仍命中同一个桶。
// [并发] 拼键是纯字符串运算、无 IO，可在任意调用点重复计算而不引入抖动。
export function buildWorkspaceKey(
  workspacePath: string,
  workspaceIdentity: string | null,
  authorityKey: string | null,
): string {
  return `${authorityKey?.trim() || "workspace"}\0${workspaceIdentity?.trim() || workspacePath}`;
}

// 只共享同服务、同身份、同配置投影的在途查询；每个视图仍独立写回和保存错误态。
// [并发] 按服务实例分桶：服务被重建时旧任务随弱引用键一起失效，无需手动清理。
// 内层映射的值同时携带任务与 revision，二者分别是复用凭据和失效判据。
// 该结构只服务于去重，不参与状态持久化，进程退出即整体丢弃。
const loadsByService = new WeakMap<
  IPluginManagementService,
  Map<string, { task: Promise<Partial<PluginManagementState>>; revision: number }>
>();
export interface PluginManagementChange {
  owner?: () => PluginManagementState;
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  scope: ZCodePluginScope;
}
const changeListeners = new Set<(change: PluginManagementChange) => void | Promise<void>>();
// [事务] `globalLoadingEpoch` 只增不减，唯一作用是给在途查询标注失效时间。
let revision = 0;
export const getPluginManagementRevision = () => revision;
// 订阅即注册，返回值是幂等注销函数，调用方必须持有它在卸载时释放。
// [资源] 注销只删除自己传入的引用，不会顺手清理他人的订阅。
export function subscribePluginManagementChanges(
  listener: (change: PluginManagementChange) => void | Promise<void>,
) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
// 每次通知先推进 revision 再广播，顺序不能颠倒，否则新查询拿不到失效信号。
// 监听器异常被逐个捕获并降级为 warn，故一个失败不阻断其他视图刷新。
export function notifyPluginManagementChange(change: PluginManagementChange): void {
  revision += 1;
  // 派生视图不能拖住已成功的写入；发布失效信号后，后台查询各自收口。
  for (const listener of changeListeners) {
    void Promise.resolve()
      .then(() => listener(change))
      .catch((error: unknown) => {
        logger.warn("[plugins] background projection refresh failed", {
          message: toMessage(error),
        });
      });
  }
}
export function isPluginManagementChangeRelevant(
  state: Pick<
    PluginManagementState,
    "workspacePath" | "workspaceIdentity" | "authorityKey" | "configScope"
  >,
  change: PluginManagementChange,
): boolean {
  if (!state.workspacePath) return false;
  // workspace 作用域要求两端键完全相等，且本视图不能停留在 user 配置层。
  // [失败路径] 本视图工作区路径为空时在上一步已判不相关，避免空键误命中。
  // user 作用域改由来源键比较，下一处的 hostKey 负责把身份折叠成来源。
  if (change.scope === "workspace") {
    return (
      state.configScope !== "user" &&
      buildWorkspaceKey(state.workspacePath, state.workspaceIdentity, state.authorityKey) ===
        buildWorkspaceKey(change.workspacePath, change.workspaceIdentity, change.authorityKey)
    );
  }
  // Source 用户设置没有项目身份，但与该来源下的项目共享同一份用户配置。
  // 优先级：显式授权键 > 来源设置标记 > 远程主机 > 本地。
  // [权衡] 兜底取 local，使本地多个工作区在用户作用域下互通。
  const hostKey = (target: { workspaceIdentity: string | null; authorityKey: string | null }) => {
    const identity = target.workspaceIdentity ?? "";
    const sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    // Source 用户设置没有项目 identity，但和该 Source 下项目共享用户配置。
    return (
      target.authorityKey ??
      (sourceServerId
        ? `source-settings:${sourceServerId}`
        : (remoteHostIdFromWorkspaceIdentity(identity) ?? "local"))
    );
  };
  return hostKey(state) === hostKey(change);
}

// 单个 operationId 会被后一次安装覆盖；每次调用持有独立条目，完成时只移除自己。
// 通过条目身份清理，同名并发操作以及切换配置层后的新操作都不会被误清除。
// [事务] 开启操作时一次性写入四项：追加条目、推进版本、清空错误与失败目标。
// 清空错误保证加载与报错互斥，用户不会在加载中看到上一条提示。
// 返回的闭包只移除自己持有的条目对象，避免同名并发操作互相清理。
export function beginPluginOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  id: string,
): () => void {
  const entry = { id };
  set({
    activeOperations: [...get().activeOperations, entry],
    operationVersion: get().operationVersion + 1,
    error: null,
    lastFailedPluginId: null,
  });
  return () => {
    set({ activeOperations: get().activeOperations.filter((operation) => operation !== entry) });
  };
}

// 封装先执行操作再刷新列表的通用流程，返回值表示结果是否仍被当前上下文承认。
// [失败路径] 没有工作区路径时直接返回 false，不进入任何状态写入。
// [事务] 收尾函数在 finally 中调用，成功、失败与提前返回都会执行。
export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  const finish = beginPluginOperation(set, get, operationId);
  // [并发] 快照当前版本号，后续用它判断本次操作是否仍是最新一次。
  // 他人在操作期间发起新操作会推进该值，届时本次失败态不再回写。
  const operationVersion = get().operationVersion;
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope
    );
  };
  // 只有上下文未变且版本仍是最新时，失败态才允许写回。
  // [失败路径] 旧操作失败不覆盖新操作的提示，避免用户看到错位报错。
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationVersion === operationVersion;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // 并发刷新不能把已成功落盘的安装报告成失败；结果只受当前目标上下文约束。
    // 操作成功但用户已切换上下文：不回写刷新结果，只广播变更让新视图自行拉取。
    // [并发] 并发刷新不能把已成功落盘的安装报告成失败，故此处返回 false 而非抛错。
    if (!isCurrentContext()) {
      await notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    await notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentContext();
  } catch (error) {
    // marketplace add/update 等通用操作失败：无插件目标，归属清空。
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // 旧操作不能覆盖同一配置层中新操作的错误态；只有最近发起的操作才回写。
    // 通用操作失败：日志始终记录，但错误态只由最新一次操作写。
    // [失败路径] 此类失败无可归属插件，失败插件标识一并清空。
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    finish();
  }
}

// 一次加载的完整入参：目标上下文、配置层、服务引用与两个意图开关。
// fresh 表示必须绕过在途任务，background 表示这是后台投影刷新。
interface PluginLoadParams {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  pluginService: IPluginManagementService;
  fresh?: boolean;
  background?: boolean;
}
export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: PluginLoadParams,
): Promise<void> {
  let inFlightLoads = loadsByService.get(params.pluginService);
  if (!inFlightLoads) {
    inFlightLoads = new Map();
    loadsByService.set(params.pluginService, inFlightLoads);
  }
  // [并发] 去重键 = 工作区键 + 配置层，缺任一段都会把不同目标的查询混在一起。
  // 配置层为空时落到 effective 段，与服务端解析默认层的行为对齐。
  const workspaceKey = buildWorkspaceKey(
    params.workspacePath,
    params.workspaceIdentity,
    params.authorityKey,
  );
  const loadKey = `${workspaceKey}\0${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  // 变更前启动的查询不能充当变更后的刷新；同一轮通知的新查询仍可共用。
  // [事务] 变更后必须重查：fresh 直接放弃旧任务，后台刷新还需比 revision 判过期。
  // 旧任务先等完再递归重入，保证同一时刻只有一轮真实请求在飞。
  // [权衡] 递归重入而非循环，靠递归时置 fresh 为 false 防止无限自我重试。
  if (existing && (params.fresh || (params.background && existing.revision < revision))) {
    await existing.task;
    return loadInto(set, get, { ...params, fresh: false });
  }
  const request = existing ?? { task: runLoadInto({ ...params, workspaceKey }), revision };
  inFlightLoads.set(loadKey, request);
  try {
    const result = await request.task;
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.authorityKey !== params.authorityKey ||
      current.configScope !== params.configScope
    )
      return;
    // 其它视图的成功操作只刷新数据，不能抹掉本视图尚未处理的操作错误。
    // [权衡] 后台成功结果只覆盖数据字段，错误与失败标识沿用当前值。
    // 否则其他视图的成功刷新会抹掉本视图尚未处理的操作错误。
    set(
      params.background && current.error
        ? { ...result, error: current.error, lastFailedPluginId: current.lastFailedPluginId }
        : result,
    );
  } finally {
    // [资源] 按条目身份清理：期间若已被新任务替换，就不删他人的条目。
    // 清理放在 finally 中，抛错与提前返回都不会留下僵尸在途任务。
    if (inFlightLoads.get(loadKey) === request) inFlightLoads.delete(loadKey);
  }
}

async function runLoadInto(
  params: PluginLoadParams & { workspaceKey: string },
): Promise<Partial<PluginManagementState>> {
  try {
    // React StrictMode、settings service 引用刷新或快速切换设置页时，
    // 同一 workspace 会并发触发 initialize。每次触发都发成独立 plugins/list 的话，
    // agent 已经 stale 时这些请求会排队产生多个 30s timeout。按 workspaceKey 复用 in-flight
    // 请求，并在仍处于同一 workspace 时才回写结果，避免过期响应覆盖当前设置页。
    const [listResult, overviewResult] = await Promise.all([
      params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
      params.pluginService.getPluginsOverview({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    ]);
    const diagnostics = [...listResult.diagnostics, ...overviewResult.diagnostics];
    return {
      plugins: listResult.plugins,
      marketplaces: overviewResult.marketplaces,
      marketplaceAvailabilityKnown: true,
      availablePlugins: overviewResult.availablePlugins,
      installedPlugins: overviewResult.installedPlugins,
      restorableBuiltins: overviewResult.restorableBuiltins,
      diagnostics,
      loading: false,
    };
  // [失败路径] overview 失败不整体失败：先降级为仅查列表，保住插件数据可用。
  // 降级结果把市场来源置空，表示来源状态未知而非全部已删除。
  // [权衡] 未知态需要显式标记，否则官方与缓存插件会被误判为孤立安装。
  } catch (error) {
    logger.error("[plugins] overview/list failed", {
      workspacePath: params.workspacePath,
      workspaceKey: params.workspaceKey,
      lastFailedPluginId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const result = await params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      });
      return {
        plugins: result.plugins,
        marketplaces: [],
        // overview 失败时空数组表示“来源状态未知”，而不是“所有来源已删除”。
        // 保留该边界，避免 list fallback 返回的 official/cache 插件被批量误判为孤立安装。
        marketplaceAvailabilityKnown: false,
        availablePlugins: [],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: result.diagnostics,
        loading: false,
      };
    // [失败路径] 两级都失败时只返回错误与加载结束标记，上次成功的插件清单原样保留。
    // 未知态继续标记为未确认，避免失败场景把来源判断放宽。
    } catch (listError) {
      logger.error("[plugins] list fallback failed", {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
      return {
        loading: false,
        marketplaceAvailabilityKnown: false,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      };
    }
  }
}
