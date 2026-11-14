/* eslint-disable max-lines -- 插件市场、安装、卸载、启停状态需要集中维护以避免并发操作状态分散 */
// pluginStore —— 插件市场列表、启用状态与操作错误态的集中持有者。
//
// 职责边界：
// - 持有：市场源列表、可用插件列表、已安装插件列表、能力位、加载与刷新标志、错误文本、逐操作忙碌标记。
// - 持有：当前工作区路径、工作区身份，以及“列表事实属于哪个工作区”的已加载键。
// - 不持有：插件文件内容、宿主进程生命周期、Agent 侧真实启用表，这些属于服务层与运行时。
// - 不持有：弹窗开关、筛选词、排序方式等纯视图状态，它们留在组件内部。
// - 写入路径：initialize 与 refresh 全量写入列表，其余动作只写忙碌标记与错误文本。
// - 读取路径：组件按 selector 订阅，插件服务引用由调用方每次传入，不进入状态。
//
// INV 表：
// INV-01 断言：同路径不同工作区身份不得共享缓存 —— 守住它的位置：initialize 的命中判定 —— 改错故障：远端同路径会短暂显示上一台机器的市场与开关
// INV-02 断言：请求失败时错误文本写入而既有列表保持不动 —— 守住它的位置：initialize 与 refresh 的失败分支 —— 改错故障：网络抖动一次就清空整屏列表
// INV-03 断言：有缓存时只置刷新标志，无缓存时才置加载标志 —— 守住它的位置：两处 loading 取值 —— 改错故障：开关插件后列表闪成空态
// INV-04 断言：刷新成功后已加载路径与已加载身份同批更新 —— 守住它的位置：两个成功分支的写入 —— 改错故障：下一次加载误命中陈旧快照
// INV-05 断言：添加市场失败不触碰任何列表字段 —— 守住它的位置：addMarketplace 的失败分支 —— 改错故障：用户看到市场消失而服务端仍存在
// INV-06 断言：移除市场先调服务端再全量刷新 —— 守住它的位置：removeMarketplace 的顺序 —— 改错故障：提前刷新会读回尚未删除的条目
// INV-07 断言：error 级诊断一律判为失败 —— 守住它的位置：更新市场的诊断检查 —— 改错故障：半成功被当成成功，界面与磁盘不一致
// INV-08 断言：安装、卸载、启停都在收尾清空自身忙碌标记 —— 守住它的位置：三个动作的 finally —— 改错故障：该行永远显示加载中且无法再点
// INV-09 断言：三类忙碌标记互不复用 —— 守住它的位置：installing、uninstalling、setting 三组字段 —— 改错故障：并发操作时按钮态串台
// INV-10 断言：缺少工作区时直接失败并写显式提示 —— 守住它的位置：三个动作的路径空值分支 —— 改错故障：点击无反应也无任何提示
// INV-11 断言：服务引用缺失时在发请求前失败 —— 守住它的位置：pluginsService 空值分支 —— 改错故障：空引用抛错污染错误态
// INV-12 断言：每次动作入口先清空错误文本 —— 守住它的位置：各动作开头的错误置空 —— 改错故障：上一次失败提示挂在新一次操作上
// INV-13 断言：启停忙碌值记录目标布尔值并与忙碌 id 成对复位 —— 守住它的位置：settingPluginEnabledValue 的写入与清空 —— 改错故障：开关停在中间态或回弹到旧值
//
// 并发结论：本 store 没有请求序号，先发后到的响应会覆盖后发先到的结果。
// 这是已知取舍：列表是服务端事实，短暂陈旧可接受，换来实现简单与写入路径唯一。
//
// 约定：任何动作都不在本地增删列表条目，列表只由 initialize 与 refresh 全量写入。
//
import { create } from "zustand";
import type {
  AvailablePluginSummary,
  InstalledPluginSummary,
  PluginMarketplaceSummary,
  PluginScope,
  PluginsCapability,
} from "@zcode/shared";
import type { IPluginsService } from "@zcode/services";
import { logger } from "@/logger.js";

// [契约] 操作 id 由作用域、插件名、市场名拼成，是安装、卸载、启停三类忙碌标记的唯一键。
// 同一插件在不同市场或不同作用域下是两条独立记录，键必须区分，不能只按插件名置忙。
// 键里不含工作区，跨工作区复用时依赖 resetWorkspaceContext 先清空忙碌字段。
// 该键只用于本地状态，不发给服务端，也不是服务端的插件唯一标识。
function buildPluginOperationId(
  scope: PluginScope,
  pluginName: string,
  marketplace: string,
): string {
  return `${scope}:${pluginName}@${marketplace}`;
}

// [契约] 状态分两层：列表事实（市场、可用、已安装、能力位）与操作反馈（loading、refreshing、error、各类忙碌 id）。
// loadedWorkspacePath 与 loadedWorkspaceIdentity 记录“列表事实属于哪个工作区”，是缓存命中的判据。
// 忙碌字段用 null 表示空闲，用操作 id 表示在途，界面据此禁用单行而不是全局禁用。
// [权衡] 服务引用不放进状态：每次动作由调用方传入，避免 store 持有可替换的外部依赖。
interface PluginStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  marketplaces: PluginMarketplaceSummary[];
  availablePlugins: AvailablePluginSummary[];
  installedPlugins: InstalledPluginSummary[];
  capability: PluginsCapability | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  addingMarketplaceSource: string | null;
  removingMarketplaceName: string | null;
  updatingMarketplaceName: string | null;
  installingPluginId: string | null;
  uninstallingPluginId: string | null;
  settingPluginEnabledId: string | null;
  settingPluginEnabledValue: boolean | null;
  initialize: (
    workspacePath: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (pluginsService: IPluginsService, workspaceIdentity?: string) => Promise<void>;
  addMarketplace: (
    source: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  uninstallPlugin: (
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  setPluginEnabled: (
    pluginName: string,
    marketplace: string,
    scopeOrEnabled: InstalledPluginSummary["scope"] | boolean,
    enabledOrPluginsService: boolean | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
    nativeScope?: InstalledPluginSummary["nativeScope"],
  ) => Promise<boolean>;
  resetWorkspaceContext: () => void;
}

// [事务] 初始值全部为空列表与 null，表示“尚未加载任何工作区”，与“已加载但为空”严格区分。
// 该区分由 loadedWorkspacePath 承担，空列表本身不能说明加载是否发生过。
// [资源] store 单例只创建一次，resetWorkspaceContext 负责回到初始值而不是重建 store。
export const usePluginStore = create<PluginStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  marketplaces: [],
  availablePlugins: [],
  installedPlugins: [],
  capability: null,
  loading: false,
  refreshing: false,
  error: null,
  addingMarketplaceSource: null,
  removingMarketplaceName: null,
  updatingMarketplaceName: null,
  installingPluginId: null,
  uninstallingPluginId: null,
  settingPluginEnabledId: null,
  settingPluginEnabledValue: null,
  // [事务] 切换工作区或断开连接时整体复位，所有列表、能力位、错误文本与忙碌标记一并清空。
  // 复位必须显式覆盖每一个字段，而不是依赖局部解构，否则残留的忙碌 id 会锁住新工作区的行。
  // 这里不发起任何请求：复位只让本地状态与“无工作区”一致，数据由后续 initialize 拉取。
  // [失败路径] 复位后若 initialize 失败，界面应呈现空态加错误文本，而不是上一工作区的旧列表。
  resetWorkspaceContext() {
    set({
      workspacePath: null,
      workspaceIdentity: null,
      loadedWorkspacePath: null,
      loadedWorkspaceIdentity: null,
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      capability: null,
      loading: false,
      refreshing: false,
      error: null,
      addingMarketplaceSource: null,
      removingMarketplaceName: null,
      updatingMarketplaceName: null,
      installingPluginId: null,
      uninstallingPluginId: null,
      settingPluginEnabledId: null,
      settingPluginEnabledValue: null,
    });
  },
  // [契约] initialize 是全量加载唯一入口，负责写入工作区路径、身份与列表事实。
  // 命中缓存时沿用旧列表并保持 loading 为假，未命中时先把列表清空再进入加载态。
  // [并发] 本动作没有请求序号：两次 initialize 交错时，后到的响应直接覆盖先到的结果。
  // [失败路径] 请求失败只写错误文本与加载标志，不清空已经命中的缓存列表。
  // 失败时仍标记已加载键，避免同参数重复触发整屏加载态，但错误文本会保留到下一次动作入口。
  async initialize(
    workspacePath: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    // [契约] 先取一次当前快照，后续所有命中判定都基于同一份状态，避免读两次之间被其他动作改写。
    // 命中条件同时要求路径、身份、以及至少一类列表非空或能力位已就绪。
    // [权衡] 能力位单独参与判定：只有能力位的场景同样算有效缓存，不能因列表为空而重复加载。
    // 只有列表全部为空且能力位未就绪才视为无缓存，此时允许整屏加载。
    const currentState = get();
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    const hasCachedData =
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      (currentState.marketplaces.length > 0 ||
        currentState.availablePlugins.length > 0 ||
        currentState.installedPlugins.length > 0 ||
        currentState.capability !== null);
    // 远程同路径 workspace 会共享同一个 workspacePath。
    // 如果这里只按路径复用插件缓存，上一台机器的市场和开关状态会短暂显示到当前远端。
    // 这里把 workspaceIdentity 一起纳入命中条件，保证同路径不同主机严格隔离。
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      marketplaces: hasCachedData ? currentState.marketplaces : [],
      availablePlugins: hasCachedData ? currentState.availablePlugins : [],
      installedPlugins: hasCachedData ? currentState.installedPlugins : [],
      capability: hasCachedData ? currentState.capability : null,
      // [事务] 这次 set 只写 workspaceIdentity 与列表保留策略，列表内容等响应回来再写。
      // 命中缓存时四个列表字段原样回填，未命中时统一清空，避免新旧工作区数据混在一起。
      // [资源] refreshing 在此刻强制归零：新工作区不应继承上一个工作区遗留的后台刷新标记。
      // error 置空属于动作入口约定，旧的失败提示不能跨工作区继续展示。
      loading: !hasCachedData,
      refreshing: false,
      error: null,
    });
    try {
      // [契约] 请求只带工作区路径，身份存在时才附加，避免把空字符串传给服务端。
      // [并发] 响应回来后无条件覆盖四个列表字段与能力位，没有请求序号可以丢弃过期响应。
      // [事务] 覆盖与加载键更新在同一次状态写入中完成，中间不会出现列表属于旧键的窗口。
      // [失败路径] 异常分支不写列表字段，只写错误文本与加载键，保住已有数据。
      const result = await pluginsService.getOverview({
        workspacePath,
        ...(normalizedWorkspaceIdentity ? { workspaceIdentity: normalizedWorkspaceIdentity } : {}),
      });
      set({
        marketplaces: result.marketplaces,
        availablePlugins: result.availablePlugins,
        installedPlugins: result.installedPlugins,
        capability: result.capability,
        loading: false,
        refreshing: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
      });
    } catch (error) {
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
      });
    }
  },
  // [契约] refresh 只做全量覆盖，是列表事实的唯一写入路径，动作成功后的对账都走这里。
  // 工作区身份优先取调用方传入值，其次取状态里的身份，保证远程链路不被降级成纯路径匹配。
  // [权衡] 有缓存时保留列表做后台刷新，只有全无缓存才显示 loading，避免开关插件后列表闪烁。
  // [并发] 同样没有请求序号：并发刷新以最后返回的响应为准，先发慢回的结果会盖掉新结果。
  // [失败路径] 失败只写错误文本并结束刷新标志，已展示的列表保持不动。
  async refresh(pluginsService: IPluginsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const state = get();
    // [契约] 这里的有缓存判定只看三类列表，不含能力位：refresh 场景下列表为空即视为需要加载态。
    // 与 initialize 的判定故意不同，因为 refresh 发生在已有工作区上下文中，能力位不承担首屏判据。
    // [权衡] 该差异是有意保留的，统一两处判定会改变首屏加载态的出现时机。
    const hasCachedData =
      state.marketplaces.length > 0 ||
      state.availablePlugins.length > 0 ||
      state.installedPlugins.length > 0;
    // 插件开关/卸载后会走 refresh，之前强制 loading=true 会让列表切成空态再恢复，造成“闪一下”。
    // 这里保留已有列表做后台刷新，只在首次无缓存数据时显示 loading。
    set({ loading: !hasCachedData, refreshing: true, error: null });
    try {
      // [并发] 后台 refresh 期间旧列表仍在展示，条目可能短暂落后于服务端。
      // [契约] 成功写入四个列表字段与能力位，并把已加载键对齐到本次请求使用的工作区。
      // [事务] 列表与加载键同批写入，避免刷新成功后命中判定仍指向旧身份。
      // [权衡] 不清空已有列表是刻意的：刷新失败时用户仍能看到上一次成功的市场与插件。
      const result = await pluginsService.getOverview({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
      });
      set({
        marketplaces: result.marketplaces,
        availablePlugins: result.availablePlugins,
        installedPlugins: result.installedPlugins,
        capability: result.capability,
        loading: false,
        refreshing: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
      });
    } catch (error) {
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
      });
    }
  },
  // [契约] 添加市场是“先写服务端、再全量对账”的顺序，本地不预插列表条目。
  // [事务] 源地址先 trim 再判空，空白输入按参数错误直接失败，不触发请求也不污染错误态。
  // [资源] addingMarketplaceSource 只记录本次源地址，界面据此禁用的应是提交按钮而非整张列表。
  // [失败路径] 服务端拒绝时写错误文本并返回失败，已存在的市场列表不受影响。
  async addMarketplace(
    source: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    const trimmedSource = source.trim();
    // [失败路径] 无工作区或源为空都走同一早退分支，返回失败且不写错误文本。
    // 这里与 install/uninstall 不同：空输入是调用方错误，不写 error 横幅。
    // [契约] 早退发生在置忙之前，因此不会留下任何在途标记。
    // [权衡] 若后续要让用户看到“请先打开工作区”，需要与安装动作对齐提示语义。
    // 当前保持静默失败，调用方依据布尔返回值自行决定提示。
    if (!workspacePath || !trimmedSource) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ error: null, addingMarketplaceSource: trimmedSource });
    try {
      await pluginsService.addMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        source: trimmedSource,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ addingMarketplaceSource: null });
    }
  },
  // [契约] 移除市场同样先调服务端，成功后再全量刷新，避免本地先删造成与磁盘不一致。
  // [事务] removingMarketplaceName 记录市场名，用于只禁用对应行的移除按钮。
  // [失败路径] 服务端失败时保留列表并写错误文本，用户可重试同一市场。
  // [资源] 收尾统一在 finally 清空忙碌名，无论成功还是异常都不留下禁用态。
  async removeMarketplace(
    marketplace: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ error: null, removingMarketplaceName: marketplace });
    try {
      await pluginsService.removeMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        marketplace,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ removingMarketplaceName: null });
    }
  },
  // [契约] updateMarket 的 marketId 为空表示全部市场，置忙用固定占位名。
  // [事务] 服务端返回后再全量刷新，保证列表反映的是更新后的真实市场集合。
  // [失败路径] 抛出的异常只写错误文本，不触碰列表与已加载键。
  // [权衡] 刷新先于诊断检查：即使诊断判定失败，列表也已经是最新结果，避免展示过期条目。
  async updateMarketplace(
    marketplace: string | null,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    // [失败路径] 缺少工作区时不能静默返回，否则设置页的安装按钮看起来毫无反应。
    // [契约] 这里写入显式的用户可读提示，且不改动任何列表字段与忙碌标记。
    // [权衡] 提示文案面向用户，与其他分支的英文参数错误区分开。
    // [事务] 早退发生在置忙之前，安装忙碌键不会被置上，也就没有收尾清空的问题。
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({
      error: null,
      updatingMarketplaceName: marketplace ?? "__all__",
    });
    try {
      const result = await pluginsService.updateMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        marketplace: marketplace || undefined,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      // legacy usePlugins 入口虽已退役，仍是公开 hook；它必须与 PluginManagementStore
      // 共用部分成功语义，不能在 Agent 返回 error diagnostic 后无条件报告成功。
      // [契约] 只要存在 error 级诊断就按失败处理，即使服务端已经完成部分写入。
      // [失败路径] 该分支写错误文本并返回失败，界面不应给出成功提示。
      // [事务] 列表已在前面刷新过，因此失败只体现在错误横幅，不回滚已落盘的部分成功。
      // [权衡] 这种“列表已更新但操作报失败”的组合是有意的，用于暴露源地址无效等半成功场景。
      const blockingDiagnostic = result?.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (blockingDiagnostic) {
        set({ error: blockingDiagnostic.message });
        return false;
      }
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ updatingMarketplaceName: null });
    }
  },
  // [契约] install 兼容两种签名：旧形态省略 scope，默认按 user 级处理。
  // [并发] busyKey 由 scope 与 pluginName 拼成，安装期间只锁这一行。
  // [事务] 安装成功后必须全量刷新，本地不自行插入条目，已安装列表只认服务端结果。
  // [失败路径] 失败写错误文本并在收尾清空安装忙碌键，列表维持安装前状态。
  // [资源] 成功与失败都记录带插件 id 的日志，便于对照界面状态排查。
  async installPlugin(
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    // [失败路径] 无工作区时给出卸载专属提示，避免与安装提示混淆。
    // [契约] 该分支不置忙、不刷新、不改列表，只写一条错误文本。
    // [权衡] 提示语为中文且面向用户，内部参数错误仍保留英文，便于区分来源。
    if (!workspacePath) {
      // 设置页尚未绑定 workspace 时 store 里可能还留着上一份缓存列表；
      // 直接 return false 会让点击安装看起来毫无反应，这里先写入显式错误提示。
      set({ error: "请先打开一个工作区后再安装插件" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const scope = typeof scopeOrPluginsService === "string" ? scopeOrPluginsService : "user";
    const pluginsService =
      typeof scopeOrPluginsService === "string" ? maybePluginsService : scopeOrPluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({ error: null, installingPluginId: pluginId });
    // [资源] 置忙之后立刻记一条开始日志，与成功、失败日志共用同一个插件 id。
    // [契约] 日志只带 id、工作区路径与错误消息，不打印插件内容或凭据类字段。
    // [失败路径] 开始日志先于请求发出，因此请求超时也能在日志里找到对应的开始记录。
    // [并发] 同一插件重复点击安装时，开始日志会出现多条，需按 id 与时间对齐判断。
    // [权衡] info 级别只在安装这类低频动作使用，刷新不写日志以免刷屏。
    logger.info("[Plugins] install start", { pluginId, workspacePath });
    try {
      await pluginsService.installPlugin({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      logger.info("[Plugins] install success", { pluginId, workspacePath });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Plugins] install failed", { pluginId, workspacePath, message });
      set({ error: message });
      return false;
    } finally {
      set({ installingPluginId: null });
    }
  },
  // [契约] 卸载与安装共用同一条“先服务端、再全量刷新”的顺序，本地不预先移除条目。
  // [并发] 卸载忙碌键与安装忙碌键互相独立，同一插件理论上可同时出现两种标记。
  // [失败路径] 失败只写错误文本，已安装列表保持原样，用户能看到插件仍在。
  // [资源] 收尾清空卸载忙碌键，成功与异常路径一致。
  async uninstallPlugin(
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      set({ error: "请先打开一个工作区后再卸载插件" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const scope = typeof scopeOrPluginsService === "string" ? scopeOrPluginsService : "user";
    const pluginsService =
      typeof scopeOrPluginsService === "string" ? maybePluginsService : scopeOrPluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({ error: null, uninstallingPluginId: pluginId });
    try {
      await pluginsService.uninstallPlugin({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ uninstallingPluginId: null });
    }
  },
  // [契约] 启停同时兼容旧形态：第二个参数既可能是作用域，也可能是启用值，需按类型分流。
  // [并发] settingPluginEnabledId 与 settingPluginEnabledValue 一起写入，用于让开关显示目标态。
  // [事务] 服务端成功后再全量刷新，本地不先翻转开关，避免失败后还要回滚视觉状态。
  // [失败路径] 失败写错误文本，开关因未做乐观修改而自然停在旧值。
  // [资源] 收尾同时清空忙碌 id 与忙碌值，二者必须成对复位，否则开关会卡在中间态。
  async setPluginEnabled(
    pluginName: string,
    marketplace: string,
    scopeOrEnabled: InstalledPluginSummary["scope"] | boolean,
    enabledOrPluginsService: boolean | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
    nativeScope?: InstalledPluginSummary["nativeScope"],
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      set({ error: "请先打开一个工作区后再修改插件状态" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    // [契约] 第三参为 enabled（旧）或 scope（新），按 typeof 布尔分流。
    // [权衡] 参数重载让公开接口保持兼容，代价是这里的分流逻辑与调用方顺序强耦合。
    // [并发] 旧形态固定按用户级置忙，因此同一插件在项目级的在途标记不会被它覆盖。
    // [失败路径] 分流后服务引用可能为空，交由后面的空值分支统一拒绝。
    // [事务] 只有分流完成才会生成忙碌键，任何形状的调用都共用同一个键格式。
    const legacyCall = typeof scopeOrEnabled === "boolean";
    const scope = legacyCall ? "user" : scopeOrEnabled;
    const enabled = legacyCall ? scopeOrEnabled : (enabledOrPluginsService as boolean);
    const pluginsService = legacyCall
      ? (enabledOrPluginsService as IPluginsService)
      : maybePluginsService;
    // [失败路径] 服务引用缺失时立即失败并写固定英文提示，不发出任何请求。
    // [契约] 这里在置忙之前返回，所以不会出现只有忙碌标记没有收尾的悬空状态。
    // [权衡] 该提示面向开发者，未做本地化，与无工作区的用户提示刻意区分。
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({
      error: null,
      settingPluginEnabledId: pluginId,
      settingPluginEnabledValue: enabled,
    });
    try {
      await pluginsService.setPluginEnabled({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
        ...(nativeScope ? { nativeScope } : {}),
        enabled,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({
        settingPluginEnabledId: null,
        settingPluginEnabledValue: null,
      });
    }
  },
}));
