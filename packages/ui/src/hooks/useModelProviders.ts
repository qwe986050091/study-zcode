// INV-01 三态互斥：守住位置是 loading 与 loadError 都从 providerSettingsRead.state.status 派生；改错故障是加载中与失败同时为真，界面既转圈又弹错误。
// INV-02 视图可见性：守住位置是 ready 判定后才取 view 的三元表达式；改错故障是加载期间沿用上一版 View，用户看到已经删除的 Provider。
// INV-03 派生列表依赖：守住位置是 effectiveModelProviders 的依赖数组只放 providerSettingsView；改错故障是设置变更后表单仍显示旧的 Provider 列表。
// INV-04 排序依赖双源：守住位置是 providerOrdering 依赖同时包含 providers 与 view；改错故障是拖拽手柄指向错位条目，重排写回错误 id。
// INV-05 引用稳定：守住位置是两处 useMemo 的缓存边界；改错故障是每次渲染产出新数组，下游按引用比较的 memo 全部失效甚至自激循环。
// INV-06 提交单点：守住位置是 commitProviderSettingsView 这个唯一写入口；改错故障是各 mutation 各自写状态，版本守卫被绕过而出现回退快照。
// INV-07 提交函数稳定：守住位置是 commitProviderSettingsView 的依赖写成具体的 commit 引用；改错故障是依赖整个读对象，所有回调每次渲染都重建。
// INV-08 权威快照：守住位置是每个 mutation 都用服务返回的 View 覆盖本地；改错故障是只等变更事件，事件丢失时界面停在删除前的旧快照。
// INV-09 刷新竞态：守住位置是 refresh 开头的 token 自增与 finally 里的相等比较；改错故障是旧请求先返回把刷新态提前清掉，标题加载提示闪灭。
// INV-10 刷新不重抛：守住位置是 refresh 的 catch 只记录日志；改错故障是手动刷新失败把异常抛进渲染层，整块设置页被错误边界接管。
// INV-11 保存重抛：守住位置是 saveDisplayOrder 的 catch 记录后再次抛出；改错故障是排序落盘失败被当成成功，重新进入页面后顺序回弹。
// INV-12 顺序归一化：守住位置是保存前对 providerIds 做去空白、去空串、去重；改错故障是重复或空白 id 进入持久层，列表抖动或丢项。
// INV-13 连通性失败即拒绝：守住位置是 testModelConnectivity 开头的本地目录校验；改错故障是远程激活时回退到远程路径，测试在别的机器上跑出假阳性。
// INV-14 连通性降级：守住位置是该函数返回失败结果而不是抛异常；改错故障是调用方拿不到错误文案，按钮一直停在测试中状态。
// INV-15 依赖逐字段：守住位置是 testModelConnectivity 依赖数组列出的六个字段；改错故障是依赖 target 整体，父组件每次渲染都换新对象导致回调重建。
// INV-16 模板兜底：守住位置是 providerTemplates 的空数组默认值；改错故障是视图未就绪时返回 undefined，调用方遍历模板即刻崩溃。
// INV-17 新建无需继承层：守住位置是 saveProvider 直接由表单构造完整配置；改错故障是新建 Provider 被要求先存在于注册表，首次保存永远失败。
// INV-18 返回形状一致：守住位置是所有 mutation 回调返回同一种 View 类型；改错故障是部分回调返回空值，调用方无法统一刷新或回滚。
//
// 模块职责：把 Provider Settings 服务视图投影成表单模型，并把所有写操作收敛到同一个权威 View 提交点。
// 状态所有权：远程数据归 useProviderSettingsServiceView，本 Hook 只持有刷新标志与刷新令牌，其余全部是派生值。
// 阅读顺序：先看三态派生与两处 memo，再看提交单点与刷新竞态，最后看各 mutation 的返回与失败语义。
import { useState, useCallback, useMemo, useRef } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import {
  projectProviderSettingsViewToFormProviders,
  resolveProviderSettingsFormProviders,
  resolveProviderOrdering,
} from "@/lib/providerSettingsFormProjection.js";
import { persistProviderDisplayOrder } from "@/lib/providerDisplayOrderPersistence.js";
import { persistPersonalProviderDeletion } from "@/lib/providerPersonalPersistence.js";
import { persistPersonalProvider } from "@/lib/providerPersonalSave.js";
import type { ProviderOrderView } from "@/lib/modelProviderOrdering.js";

export function useModelProviders(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 本地 Provider Settings 的连通性测试使用的本地 cwd；不复用远程激活路径。 */
  connectivityWorkspacePath?: string;
  /** 远程激活时没有本地 cwd 必须 fail-closed，不能回退到远程 workspacePath。 */
  connectivityWorkspaceRequired?: boolean;
  /** 没有本地 workspace 时展示给用户的本地化错误文案。 */
  connectivityUnavailableMessage?: string;
}) {
  const { providerSettingsService } = useServices();
  const providerSettingsRead = useProviderSettingsServiceView(providerSettingsService);
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // [权衡] 依赖只写 providerSettingsView 而不是整个读状态：读状态对象每次变化都可能换引用，写它会让投影在数据没变时反复重算。
  // 投影结果被表单与排序两处消费，所以必须缓存；否则每次渲染都是新数组，下游按引用比较的 memo 全部失效。
  // 视图为 null 时由投影函数给出空列表兜底，这里不再额外判空，避免出现两套空值语义。
  // 缓存结果而不是缓存函数，是因为消费方只关心列表内容，函数签名一变它们就得跟着改调用方式。
  // [失败路径] 投影只做纯数据搬运且不吞异常；字段形状不合预期时应当尽早暴露，而不是静默生成一份空配置。
  const effectiveModelProviders = useMemo(
    () =>
      resolveProviderSettingsFormProviders({
        view: providerSettingsView,
      }),
    [providerSettingsView],
  );
  // [并发] 排序必须同时依赖 providers 与 view：只依赖 view 时，由模板推导出的 Provider 变化不会触发重算，拖拽手柄会指向错位条目。
  // 展示顺序与可重排 id 集合来自同一次计算，拆成两个 memo 会出现短暂不一致的一帧。
  // [权衡] 不在 Hook 里保存本地顺序副本，顺序的唯一真相仍是服务视图，避免本地与服务两份排序互相覆盖。
  // 重算成本随 Provider 数量线性增长，但只在视图换代时发生，比每次渲染都排序更划算。
  const providerOrdering = useMemo(
    () =>
      resolveProviderOrdering({
        view: providerSettingsView,
        providers: effectiveModelProviders,
      }),
    [effectiveModelProviders, providerSettingsView],
  );
  const commitProviderSettingsView = useCallback(
    (view: ProviderSettingsView): void => {
      // 远端 mutation 的返回值是目标 Environment 已刷新后的权威 View，
      // 只依赖 onDidChange 会在 attachment 换代/事件丢失时留下删除前的 UI 快照。
      // 统一在 Hook 边界提交返回 View，仍由 useProviderSettingsServiceView 做 Service/revision 守卫。
      providerSettingsRead.commit(view);
    },
    [providerSettingsRead.commit],
  );
  const [refreshing, setRefreshing] = useState(false);
  // [并发] 令牌用 ref 而不是 state：它只用于比较新旧请求，写它不应触发渲染，否则每次刷新都多一轮无意义重绘。
  // 自增发生在发起请求之前，保证同一时刻只有最新那一次收尾有资格清除刷新态。
  // `latestRefreshTokenRef` 初值零：第一次刷新拿到一，更早请求的令牌都小于当前值。
  // [资源] ref 的生命周期跟随组件实例，卸载后旧请求仍读到同一个 ref，不会因组件消失而误判为最新。
  const latestRefreshTokenRef = useRef(0);

  // [并发] 主动拉取不去重：连点都是有效意图，`latestRefreshTokenRef` 只让最后一次收尾。
  // 先等结论再提交，中途一律不写本地状态，避免半刷新视图被渲染出来。
  // [失败路径] 失败只落日志并保留旧视图，手动刷新属于可重试动作，把异常抛给渲染层会让整块设置页被错误边界替换。
  // 收尾必须比较令牌：旧请求若无条件清除刷新态，最新请求还在飞时标题上的加载提示就会闪灭。
  // 两个依赖都是稳定引用，任一变化说明服务换代或提交入口改变，此时闭包必须重建才能拿到新实例。
  // [权衡] 不把刷新结果回传给调用方，调用方只需触发，结果统一从视图状态读取。
  const refresh = useCallback(async () => {
    const refreshToken = latestRefreshTokenRef.current + 1;
    latestRefreshTokenRef.current = refreshToken;
    setRefreshing(true);
    try {
      const view = await providerSettingsService.refresh("settings-manual");
      commitProviderSettingsView(view);
    } catch (err) {
      logger.error("[useModelProviders] 加载模型供应商失败", err);
    } finally {
      // 用户连续触发刷新时，旧请求可能先返回。
      // 若不做 token 守卫，旧请求 finally 会把 refreshing 提前置 false，导致标题 loading 提示闪灭。
      if (refreshToken === latestRefreshTokenRef.current) {
        setRefreshing(false);
      }
    }
  }, [commitProviderSettingsView, providerSettingsService]);

  const saveProvider = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      // 新建 Provider 尚未进入 Registry，自然也不会出现在当前 Settings View。
      // 保存边界允许缺少继承层，并直接从新建表单构造完整配置。
      const savedView = await persistPersonalProvider({ provider, providerSettingsService });
      commitProviderSettingsView(savedView);
      return projectProviderSettingsViewToFormProviders(savedView);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const createPersonalProvider = useCallback(
    async (input?: Parameters<typeof providerSettingsService.createPersonalProvider>[0]) => {
      const created = await providerSettingsService.createPersonalProvider(input);
      commitProviderSettingsView(created.view);
      return created;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  // [事务] 服务端返回的是写完之后完整视图，本地不拼接数组：任何本地拼装都会和服务端归一化结果产生偏差。
  // 链接式写法只是风格选择，关键在提交紧跟返回值，中间不能夹带可能抛错的逻辑。
  // [失败路径] 这里不捕获异常，失败语义交给调用方决定弹提示还是回滚，Hook 层擅自吞掉会让用户误以为已经保存。
  // 依赖只列提交函数与服务实例，二者都稳定，这个回调在整个会话里最多重建两次。
  const addPersonalModel = useCallback(
    (
      providerId: string,
      modelId: string,
      config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
      useRecommendedConfig?: boolean,
    ) =>
      providerSettingsService
        .addPersonalModel(providerId, modelId, config, useRecommendedConfig)
        .then((view) => {
          commitProviderSettingsView(view);
          return view;
        }),
    [commitProviderSettingsView, providerSettingsService],
  );

  const savePersonalModelDraft = useCallback(
    async (input: Parameters<typeof providerSettingsService.savePersonalModelDraft>[0]) => {
      const view = await providerSettingsService.savePersonalModelDraft(input);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const setPersonalModelEnabled = useCallback(
    async (providerId: string, modelId: string, enabled: boolean) => {
      const view = await providerSettingsService.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
      );
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deletePersonalModel = useCallback(
    async (providerId: string, modelId: string) => {
      const view = await providerSettingsService.deletePersonalModel(providerId, modelId);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      const view = await persistPersonalProviderDeletion({
        providerId: id,
        providerSettingsService,
      });
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const reorderProviderModels = useCallback(
    async (providerId: string, modelIds: readonly string[]) => {
      const view = await providerSettingsService.reorderPersonalModels(providerId, modelIds);
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  // [事务] 归一化在发请求之前完成：去空白消除拖拽产生的脏 id，过滤空串，再按首次出现顺序去重。
  // 去重必须保留首次出现的位置，否则用户刚拖好的相对次序会被集合语义打乱。
  // [失败路径] 与刷新相反，这里记录后要重新抛出：排序是用户显式提交的动作，静默失败会让界面显示成功而磁盘没落盘。
  // [权衡] 不在此处回滚界面顺序，回滚需要旧顺序快照，交给调用方捕获后重新拉取更可靠。
  // 归一化后的对象是新构造的，不改动调用方传进来的状态，避免把外部引用一起污染。
  const saveDisplayOrder = useCallback(
    async (state: ProviderOrderView) => {
      const normalizedState: ProviderOrderView = {
        providerIds: [...new Set(state.providerIds.map((id) => id.trim()).filter(Boolean))],
      };
      try {
        const view = await persistProviderDisplayOrder({
          state: normalizedState,
          providerSettingsService,
        });
        commitProviderSettingsView(view);
      } catch (err) {
        logger.warn("[useModelProviders] 保存 Personal Provider 顺序失败", err);
        throw err;
      }
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  // [失败路径] 本地目录缺失且处于远程激活或指定了工作区身份时，必须直接返回失败结果，不能回退到远程路径。
  // 回退会把测试发到别的机器上执行，得到的成功是假阳性，用户会以为本地凭据可用。
  // 错误文案允许外部注入，未注入时用英文兜底，保证任何调用方都能拿到可展示的信息。
  // 依赖逐个字段列出而不是依赖 target 整体，父组件每次渲染都会传新对象，写整体会让这个回调失去缓存意义。
  const testModelConnectivity = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      const connectivityWorkspacePath = target.connectivityWorkspacePath?.trim();
      if (
        !connectivityWorkspacePath &&
        (target.connectivityWorkspaceRequired || target.workspaceIdentity?.trim())
      ) {
        return {
          success: false,
          error: {
            message:
              target.connectivityUnavailableMessage ??
              "A local workspace is unavailable for connectivity testing.",
          },
        };
      }
      return providerSettingsService.testModelConnectivity({
        workspacePath: connectivityWorkspacePath || target.workspacePath,
        providerId,
        modelId,
      });
    },
    [
      providerSettingsService,
      target.connectivityUnavailableMessage,
      target.connectivityWorkspacePath,
      target.connectivityWorkspaceRequired,
      target.workspacePath,
      target.workspaceIdentity,
    ],
  );

  // [失败路径] 三态在这里收敛成三个派生字段：加载中为真、错误非空、其余按成功处理，互斥性由上层状态机保证。
  // loadError 只在错误态暴露对象，其余时刻为 null，调用方不必再比对状态字符串。
  // [权衡] 直接透出视图与重载入口，给需要精细控制的高级调用方留出口，代价是它们要自己承担状态判断。
  return {
    modelProviders: effectiveModelProviders,
    providerTemplates: providerSettingsView?.providerTemplates ?? [],
    displayOrder: providerOrdering.displayOrder,
    reorderableProviderIds: providerOrdering.reorderableProviderIds,
    loading: providerSettingsRead.state.status === "loading",
    loadError:
      providerSettingsRead.state.status === "error" ? providerSettingsRead.state.error : null,
    reload: providerSettingsRead.reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    testModelConnectivity,
    providerSettingsView,
  };
}
