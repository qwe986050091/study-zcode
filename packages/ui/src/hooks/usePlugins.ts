// INV-01 缓存命中必须同时比对路径、身份、已加载路径、已加载身份四键，守住位置是副作用里的复合条件；改错故障是远端同路径工作区短暂显示上一台机器的插件列表。
// INV-02 无活动工作区时必须先复位 store 再返回，守住位置是副作用的首个早退分支；改错故障是 Discover 仍展示旧缓存且安装静默失败。
// INV-03 命中缓存时本 hook 不得再次触发初始化，守住位置是四键相等后的直接返回；改错故障是每次渲染都重复拉取，列表闪烁并产生请求风暴。
// INV-04 副作用的依赖数组必须列全九个输入，守住位置是副作用末尾的依赖表；改错故障是切换工作区后不重新加载，或同一工作区被反复加载。
// INV-05 三个只读动作必须把服务引用与工作区身份透传进 store，守住位置是各回调的闭包参数；改错故障是 store 用到过期服务引用，请求打到旧连接上。
// INV-06 无工作区时安装必须写入中文提示并返回失败，守住位置是安装动作的路径空值分支；改错故障是用户点击后既无反馈也无错误横幅，误以为卡死。
// INV-07 安装前必须校验归属键与已加载键是否仍指向当前工作区，守住位置是安装动作的二次比对；改错故障是安装结果落到上一个工作区的列表上。
// INV-08 任何写动作成功后都不在本地增删条目，守住位置是对 store 刷新动作的调用；改错故障是本地插入与磁盘事实分叉，且下一次刷新后被无声抹掉。
// INV-09 返回值必须由记忆化包住且依赖列全全部字段与回调，守住位置是返回对象的依赖数组；改错故障是消费方拿到旧闭包，或每次渲染都换新引用引发连锁重渲染。
// INV-10 订阅必须逐字段取原子值，守住位置是每个选择器只返回单个字段；改错故障是对象选择器每次产出新引用，直接把组件打进无限重渲染。
// INV-11 工作区身份必须归一化为空值，守住位置是各动作对可选身份的兜底写法；改错故障是空串与未定义被当成两个身份，同一工作区被反复重载。
// INV-12 刷新动作在没有工作区时静默返回，守住位置是刷新回调的首个判断；改错故障是向服务端发出空路径请求，把参数错误写进用户可见的错误位置。
// INV-13 加载中与刷新中必须区分，守住位置是 store 的两个独立标志；改错故障是后台刷新把整屏切成骨架屏，用户正在看的列表被抽走。
// INV-14 安装失败必须以布尔值返回而不是抛出，守住位置是安装回调的异常分支；改错故障是未捕获拒绝冒到渲染层，打断整个事件处理链。
// INV-15 错误文本只由 store 持有并保留到下一次动作入口，守住位置是本 hook 不复制也不清理错误字段；改错故障是失败原因在重渲染后丢失或重复弹出。
// INV-16 本 hook 不设请求取消标记，守住位置是副作用只能依赖 store 的命中键兜底；改错故障是快速切换工作区时旧响应覆盖新列表。
// INV-17 启用停用必须把在途标识与目标布尔值一起交给 store，守住位置是启停回调的实参顺序；改错故障是开关停在中间态或回显方向相反。
// INV-18 原生作用域只在存在时才透传，守住位置是启停回调末尾的可选参数；改错故障是空作用域进入原生层，导致整批插件的启停被整体拒绝。
//
// 模块职责：把插件 store 的订阅、工作区切换加载、动作透传与返回值缓存收敛成一个 React hook，供设置页与侧栏共用。
// 状态所有权：列表事实、加载标志、错误文本与各类忙碌标记全部由插件 store 单例持有，本 hook 只做选择器订阅与调用转发。
// 阅读顺序：先看副作用里的工作区切换与缓存命中，再看安装动作的补加载与写动作透传，最后看返回值缓存与依赖完整性。
import { useCallback, useEffect, useMemo } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePluginStore } from "@/store/pluginStore.js";

export function usePlugins(workspacePath: string | null, workspaceIdentity?: string | null) {
  // [资源] 这里的服务引用由工作区上下文提供，本 hook 自身既不缓存也不重建它。
  // 工作区切换会让服务实例变化，因此它必须出现在每个动作回调的依赖里。
  // [权衡] 不把它放进 store，是为了让 store 保持纯数据，测试时可直接注入假实现。
  // 若把它当作稳定引用而漏掉依赖，动作会一直打到上一个工作区的连接上。
  // pluginsService 缺失时不在本 hook 抛错；各动作的空值分支各自给出可读提示，因此调用方无需预判。
  const { pluginsService } = useWorkspaceServices(workspacePath, undefined, workspaceIdentity);
  const storeWorkspacePath = usePluginStore((state) => state.workspacePath);
  const storeWorkspaceIdentity = usePluginStore((state) => state.workspaceIdentity);
  const loadedWorkspacePath = usePluginStore((state) => state.loadedWorkspacePath);
  const loadedWorkspaceIdentity = usePluginStore((state) => state.loadedWorkspaceIdentity);
  const marketplaces = usePluginStore((state) => state.marketplaces);
  const availablePlugins = usePluginStore((state) => state.availablePlugins);
  const installedPlugins = usePluginStore((state) => state.installedPlugins);
  const capability = usePluginStore((state) => state.capability);
  const loading = usePluginStore((state) => state.loading);
  const refreshing = usePluginStore((state) => state.refreshing);
  const error = usePluginStore((state) => state.error);
  const addingMarketplaceSource = usePluginStore((state) => state.addingMarketplaceSource);
  const removingMarketplaceName = usePluginStore((state) => state.removingMarketplaceName);
  const updatingMarketplaceName = usePluginStore((state) => state.updatingMarketplaceName);
  const installingPluginId = usePluginStore((state) => state.installingPluginId);
  const uninstallingPluginId = usePluginStore((state) => state.uninstallingPluginId);
  const settingPluginEnabledId = usePluginStore((state) => state.settingPluginEnabledId);
  const settingPluginEnabledValue = usePluginStore((state) => state.settingPluginEnabledValue);
  const initialize = usePluginStore((state) => state.initialize);
  const resetWorkspaceContext = usePluginStore((state) => state.resetWorkspaceContext);
  const refreshStore = usePluginStore((state) => state.refresh);
  const addMarketplaceStore = usePluginStore((state) => state.addMarketplace);
  const removeMarketplaceStore = usePluginStore((state) => state.removeMarketplace);
  const updateMarketplaceStore = usePluginStore((state) => state.updateMarketplace);
  const installPluginStore = usePluginStore((state) => state.installPlugin);
  const uninstallPluginStore = usePluginStore((state) => state.uninstallPlugin);
  const setPluginEnabledStore = usePluginStore((state) => state.setPluginEnabled);

  useEffect(() => {
    // [事务] 失去工作区必须先清空归属键与全部列表，否则缓存会挂在已经没有上下文的状态上。
    // 只清列表不清已加载键，会让下一次进入同一路径时误判为命中而跳过请求。
    // [失败路径] 复位本身不发请求，因此断开连接期间界面应是空态而不是错误态。
    // 这里刻意不写错误文本：没有工作区属于正常状态切换，不是用户操作失败。
    // 复位后不能留下加载标志为真，否则重新打开工作区会先闪一帧骨架屏。
    if (!workspacePath) {
      // 无活动工作区时保留上一份插件缓存，会让 Discover 仍可点安装但 store.workspacePath 为空而静默失败。
      resetWorkspaceContext();
      return;
    }
    if (
      // [并发] 四个条件必须全部成立才能跳过加载，任一不等都说明列表属于别的上下文。
      // 前两条比对归属键，后两条比对列表事实的已加载键，二者缺一都会读到错位的快照。
      // [权衡] 身份为空时统一折成空值参与比较，避免空串与未定义被当成两个不同工作区。
      // 若只比路径，远端同路径的另一台机器会短暂看到本机的市场与开关状态。
      // 若只比归属键而不比已加载键，初始化尚未成功时也会被判定为数据已就绪。
      storeWorkspacePath === workspacePath &&
      storeWorkspaceIdentity === (workspaceIdentity ?? null) &&
      loadedWorkspacePath === workspacePath &&
      loadedWorkspaceIdentity === (workspaceIdentity ?? null)
    ) {
      return;
    }
    // [并发] 初始化只在这里触发，且没有请求序号，两次交错加载以最后返回者为准。
    // 加载态由 store 依有无缓存决定，本 hook 不自行置位，避免两处状态源打架。
    // [失败路径] 失败时 store 保留旧列表并写入错误文本，界面应同时呈现错误与陈旧数据。
    // 这里用不等待结果的调用方式，副作用不能因为请求未完成而阻塞渲染。
    // 成功与失败都会更新已加载键，所以失败后同参数不会立刻再次触发整屏加载。
    void initialize(workspacePath, pluginsService, workspaceIdentity ?? undefined);
  }, [
    initialize,
    loadedWorkspacePath,
    loadedWorkspaceIdentity,
    pluginsService,
    resetWorkspaceContext,
    storeWorkspacePath,
    storeWorkspaceIdentity,
    workspaceIdentity,
    workspacePath,
  ]);

  // [事务] 刷新是列表事实与启用状态重新派生的唯一入口，开关动作完成后都回到这里对账。
  // [并发] refresh 期间旧列表继续可见，用户看到的是上一份服务端结果；空列表只出现在首次加载。
  // [权衡] 有缓存时只置后台刷新标志，没有缓存才显示加载态，避免开关插件后列表闪一下。
  // 刷新回调必须在依赖里带上工作区身份，否则远程链路会被降级成纯路径匹配。
  // [失败路径] 刷新失败保留已有条目并写错误文本，调用方仍能依据返回值决定是否提示。
  const refresh = useCallback(async () => {
    await refreshStore(pluginsService, workspaceIdentity ?? undefined);
  }, [pluginsService, refreshStore, workspaceIdentity]);

  const addMarketplace = useCallback(
    async (source: string) => {
      return addMarketplaceStore(source, pluginsService, workspaceIdentity ?? undefined);
    },
    [addMarketplaceStore, pluginsService, workspaceIdentity],
  );

  const removeMarketplace = useCallback(
    async (marketplace: string) => {
      return removeMarketplaceStore(marketplace, pluginsService, workspaceIdentity ?? undefined);
    },
    [pluginsService, removeMarketplaceStore, workspaceIdentity],
  );

  const updateMarketplace = useCallback(
    async (marketplace?: string) => {
      return updateMarketplaceStore(
        marketplace ?? null,
        pluginsService,
        workspaceIdentity ?? undefined,
      );
    },
    [pluginsService, updateMarketplaceStore, workspaceIdentity],
  );

  const installPlugin = useCallback(
    async (pluginName: string, marketplace: string, scope: "workspace" | "user" = "user") => {
      if (!workspacePath) {
        usePluginStore.setState({ error: "请先打开一个工作区后再安装插件" });
        return false;
      }
      if (
        // [并发] 安装是跨工作区的长动作：从点击到发请求之间上下文可能已切换，因此发请求前必须重新读实时快照。
        // 这里在发请求前重新读一次实时快照，确认归属键与已加载键仍指向当前工作区。
        // 归属键与 loadedWorkspacePath 不一致时先补一次 initialize，让安装结果落到当前工作区，而不是写进旧上下文。
        // [失败路径] 补加载失败也不会中断安装流程，错误由 store 保留给界面展示。
        // [权衡] 该检查读 usePluginStore.getState() 的实时值，而不是渲染期闭包值；因此同一帧内多次切换也不会读到过期快照。
        usePluginStore.getState().workspacePath !== workspacePath ||
        usePluginStore.getState().loadedWorkspacePath !== workspacePath
      ) {
        await initialize(workspacePath, pluginsService, workspaceIdentity ?? undefined);
      }
      return installPluginStore(
        pluginName,
        marketplace,
        scope,
        pluginsService,
        workspaceIdentity ?? undefined,
      );
    },
    [initialize, installPluginStore, pluginsService, workspaceIdentity, workspacePath],
  );

  const uninstallPlugin = useCallback(
    async (pluginName: string, marketplace: string, scope: "workspace" | "user") => {
      return uninstallPluginStore(
        pluginName,
        marketplace,
        scope,
        pluginsService,
        workspaceIdentity ?? undefined,
      );
    },
    [pluginsService, uninstallPluginStore, workspaceIdentity],
  );

  const setPluginEnabled = useCallback(
    async (
      pluginName: string,
      marketplace: string,
      scope: "workspace" | "user",
      enabled: boolean,
      nativeScope?: "user" | "project" | "local",
    ) => {
      return setPluginEnabledStore(
        pluginName,
        marketplace,
        scope,
        enabled,
        pluginsService,
        workspaceIdentity ?? undefined,
        nativeScope,
      );
    },
    [pluginsService, setPluginEnabledStore, workspaceIdentity],
  );

  // [资源] 返回对象必须稳定，否则消费方的记忆化与副作用依赖每一帧都会失效。
  // 依赖数组要覆盖返回对象里的每个字段与每个回调，漏一项就会拿到上一轮的旧值。
  // [权衡] 字段较多时手写依赖容易漏，但比整体对象依赖更能精确控制重渲染范围。
  // 回调本身已由缓存包装，这里只需保证引用随工作区上下文变化而变化。
  // [失败路径] 若把回调内联进返回对象，卸载后的异步回写会绑在旧闭包上而写错工作区。
  return useMemo(
    () => ({
      marketplaces,
      availablePlugins,
      installedPlugins,
      capability,
      loading,
      refreshing,
      error,
      addingMarketplaceSource,
      removingMarketplaceName,
      updatingMarketplaceName,
      installingPluginId,
      uninstallingPluginId,
      settingPluginEnabledId,
      settingPluginEnabledValue,
      refresh,
      addMarketplace,
      removeMarketplace,
      updateMarketplace,
      installPlugin,
      uninstallPlugin,
      setPluginEnabled,
    }),
    [
      addMarketplace,
      availablePlugins,
      addingMarketplaceSource,
      capability,
      error,
      installPlugin,
      installedPlugins,
      loading,
      refreshing,
      marketplaces,
      removingMarketplaceName,
      refresh,
      removeMarketplace,
      setPluginEnabled,
      uninstallPlugin,
      updateMarketplace,
      updatingMarketplaceName,
      installingPluginId,
      uninstallingPluginId,
      settingPluginEnabledId,
      settingPluginEnabledValue,
    ],
  );
}
