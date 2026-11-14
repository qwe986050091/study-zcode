// pluginManagementStore —— 设置页「插件管理」的 Zustand 数据源：把 IPluginManagementService 的 list/overview 结果、来源与插件的写操作、按需详情缓存收拢成一份可订阅投影。
// 职责边界：只做状态拼装、四元上下文（workspacePath / workspaceIdentity / authorityKey / configScope）比对与失效广播；请求去重、乐观回滚、在途合并都在 pluginManagementStoreLoading 与 pluginManagementStoreEnabled。
// 不负责：RPC 协议字段校验、错误文案措辞、把 error 映射成某个卡片的视觉态（消费方自行读 lastFailedPluginId 判定归属）。
//
// INV-01 断言：workspacePath、workspaceIdentity、authorityKey、configScope 四元组是「当前投影归属」的唯一判据 —— 守住它的位置：initialize 的 contextChanged/hasCache 与 loadInto 的回写比对 —— 改错故障：只比 workspacePath 时，同一项目切到 Source 级设置会复用旧主机缓存，列表显示上一台机器的插件。
// INV-02 断言：上下文变化时必须清空 plugins/marketplaces/available/installed/restorable/diagnostics/describeCache 并递增 operationVersion —— 守住它的位置：initialize 里 contextChanged 的三元展开分支 —— 改错故障：漏清 describeCache 会让新项目复用旧项目的组件清单，详情面板展示不属于该项目的插件组件。
// INV-03 断言：hasCache 为真才走非阻塞刷新，否则 loading 必须为真 —— 守住它的位置：initialize 中 hasCache 计算与 loading 赋值 —— 改错故障：判空放宽成只看 plugins.length 时，切项目会保留旧列表又不显示 loading，用户误以为新项目没有插件。
// INV-04 断言：marketplaceAvailabilityKnown 为 false 表示来源存在性未知，不能据此推导孤立安装 —— 守住它的位置：该字段初值、contextChanged 重置与 loadInto 回写 —— 改错故障：把未知当空数组，overview 失败时官方与缓存插件被批量标成孤立，出现一键清理的误删入口。
// INV-05 断言：lastFailedPluginId 只在该错误确有插件目标时写 pluginId，其余一律写 null —— 守住它的位置：updateMarketplace 部分失败、validateSource 失败、runWorkspaceOperation 的 catch —— 改错故障：来源刷新失败写成某个 pluginId，会点亮该卡片错误态，用户点重试却修不好来源问题。
// INV-06 断言：写 error 时必须同时写 lastFailedPluginId，两者不可单独更新 —— 守住它的位置：本文件全部 set 中带 error 的调用点 —— 改错故障：只更新 error 会残留上一次的归属，新错误被映射到无辜插件，卡片报错但详情完全正常。
// INV-07 断言：operationVersion 用于丢弃跨上下文的异步回写 —— 守住它的位置：validateSource 的 version 快照与两处相等判断 —— 改错故障：去掉判断后旧项目的校验结果会覆盖新项目的 diagnostics，新页面出现不属于它的错误。
// INV-08 断言：除 describe 外的写操作都必须经 runWorkspaceOperation 或 beginPluginOperation 登记 —— 守住它的位置：全部 marketplace 与 plugin 写方法 —— 改错故障：绕过登记后 activeOperations 不自增，按钮不置灰，用户可重复点击并发起同一次安装。
// INV-09 断言：operationId 必须带业务参数（source / marketplace / pluginId） —— 守住它的位置：各操作传给 runWorkspaceOperation 的模板字符串 —— 改错故障：退化成固定串后同名并发操作被当成同一个，后完成者清掉先完成者的置灰条目。
// INV-10 断言：诊断为 error 时必须抛错转为操作失败，不能当作成功继续刷新 —— 守住它的位置：throwForErrorDiagnostic 及 install/update/restore 的调用点 —— 改错故障：忽略返回值继续 reload，无效来源会显示「已安装」并清掉重试入口。
// INV-11 断言：与 CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID 相等的诊断不参与来源刷新失败判定 —— 守住它的位置：updateMarketplace 里 blockingDiagnostic 的过滤条件 —— 改错故障：把官方来源的告警算成失败，每次刷新都返回 false，刷新入口长期停在失败态。
// INV-12 断言：来源刷新部分成功时仍要 reload，并把失败文案留在 refreshError 中在操作之后写回、同时返回 false —— 守住它的位置：updateMarketplace 的 refreshError 暂存与 succeeded && refreshError 分支 —— 改错故障：提前返回会跳过 reload，成功来源的新插件不出现；只 warn 不写 error 则桌面与手机 Web 都把旧快照报成刷新成功。
// INV-13 断言：describe 缓存中的 loading 条目本身就是并发锁 —— 守住它的位置：describePlugin 的 !force && cached.status !== error 早退 —— 改错故障：去掉 status 判断后同一插件每次渲染都发新请求，详情区在空白与加载间反复闪烁。
// INV-14 断言：describe 回写前必须比对缓存的 request 引用是否仍指向自己 —— 守住它的位置：成功与失败两处 describeCache[pluginId] !== request 判断 —— 改错故障：切项目或强制重试后，旧响应把新条目覆盖成旧数据，详情显示上一个项目的组件。
// INV-15 断言：describe 返回零组件且带 error 诊断时必须映射为 error 态而非 loaded —— 守住它的位置：components.length === 0 && blockingDiagnostic 分支 —— 改错故障：缓存成 loaded 后详情永久空白，且命中缓存不再重试，用户没有任何恢复入口。
// INV-16 断言：每个 scoped store 必须随 pluginService 重建并随卸载解绑订阅 —— 守住它的位置：useScopedPluginManagementStore 的 useMemo 依赖与 useEffect 返回值 —— 改错故障：依赖漏掉 pluginService 会跨主机复用旧目录与在途写入状态，切主机后写入落到已失效的服务上。
//
// 阅读顺序：先看状态字段的「权威 / 未知 / 归属」三组语义，再看 initialize 的上下文切换清场，最后看各写操作的诊断式失败契约与 describe 的缓存身份守卫。
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginScope,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import { CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  beginPluginOperation,
  loadInto,
  runWorkspaceOperation,
  subscribePluginManagementChanges,
  isPluginManagementChangeRelevant,
  notifyPluginManagementChange,
} from "@/store/pluginManagementStoreLoading.js";
import { setPluginEnabledOptimistically } from "@/store/pluginManagementStoreEnabled.js";

// 市场详情按需拉取的组件清单缓存：按 pluginId 记 loading/data/error，避免重复请求与切换闪烁。
// [契约] 三种 status 是互斥的完整状态机：loading 只有占位、loaded 必带 data、error 必带 error，
// 不要新增「loaded 但 data 为空」的中间态，消费方按 status 分支渲染，空 data 会渲染出空白详情。
// 条目对象还会被当作请求身份（见 describePlugin 的引用比对），因此每次请求必须新建对象，
// 不要原地改 status：原地复用会让旧响应与新请求引用相等，过期回填的守卫全部失效。
export interface PluginDescribeEntry {
  status: "loading" | "loaded" | "error";
  data?: ZCodePluginsDescribeResult;
  error?: string;
}

// 设置页「插件管理」的数据源: 经 IPluginManagementService 薄服务由 zcode-cli 提供 (list + enable/disable)。
// UI 不再直触 IZCodeAgentService，plugins/* 旧协议词的消费收拢到服务实现一处。
// 与已 retired 的 marketplace pluginStore 无关, 故单独建一个精简 store。
// [契约] 这个接口是 UI 与 store 之间唯一的形状约定，字段分三组：数据投影（plugins、marketplaces、
// availablePlugins、installedPlugins、restorableBuiltins、diagnostics）、四元上下文、操作态
// （loading、error、lastFailedPluginId、togglingPluginId、activeOperations、operationVersion、describeCache）。
// 新增字段先判断属于哪一组，混组会出现「上下文已切、操作态没切」的错位。
// 方法签名一律返回 Promise，布尔返回值的语义是「是否真正生效」，不是「界面是否提示过」。
export interface PluginManagementState {
  // [契约] workspacePath 是四元上下文的一员，只用于请求参数与空态判断，不能单独代表「当前项目」。
  // 远程项目与本地同路径项目的 workspacePath 可能相同，必须同时比对 workspaceIdentity 与 authorityKey。
  // authorityKey 是缓存权威键：同一 home 路径下不同 Source 的投影不能互相复用；空值表示尚未解析，
  // 不能与任何具体 Source 视为相等，否则 Source 级设置页会命中项目级缓存。
  workspacePath: string | null;
  workspaceIdentity: string | null;
  /** Source 缓存权威：同一 home 路径下不同 Source 的投影不能互相复用。 */
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  // [契约] plugins 是 list 结果的完整投影，消费方按 id 查找、按 enabled 渲染开关，不在 UI 层再过滤。
  // 启停的乐观投影按 id 替换元素引用，因此这里只能不可变替换，不能原地改元素字段，否则浅比较失效。
  // 上下文变化时该字段必须清空：保留旧项目插件会让用户在加载期间对旧卡片发起卸载，
  // 而请求参数已换成新项目，卸载会落在错误的工作区。
  plugins: ZCodePluginInfo[];
  marketplaces: ZCodePluginMarketplaceSummary[];
  /** 最近一次 overview 是否成功；false 表示来源存在性未知，不能推导孤立状态。 */
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
  diagnostics: ZCodePluginDiagnostic[];
  loading: boolean;
  error: string | null;
  /**
   * 最近一次失败操作的归属插件：带 pluginId 的操作（如 setEnabled）失败写该
   * id；无插件目标的操作（marketplace add/update/validate、列表加载、refresh）写 null。
   * 消费方（CUA 输入框按钮等）只应把「目标是自己」的 error 当成自身错误，避免共享
   * error 字段把无关失败误映射成自己的错误态。
   */
  // [契约] 这是 error 的归属字段，与 error 成对写入：有明确 pluginId 的失败写该 id，其余写 null。
  // 消费方（插件卡片、CUA 输入框按钮）只应把归属等于自己的 error 当成自身错误，
  // 否则一份共享的 error 会把来源刷新失败映射成每个插件的错误态。
  // runWorkspaceOperation 的 catch 与 validateSource 失败都写 null，因为来源级操作没有单一插件目标；
  // 启停失败由 pluginManagementStoreEnabled 写回具体 pluginId，改这里前先确认消费方没有反向推断。
  lastFailedPluginId: string | null;
  togglingPluginId: string | null;
  activeOperations: ReadonlyArray<{ id: string }>;
  operationVersion: number;
  // [资源] 缓存以 pluginId 为键、按 store 实例隔离，不跨项目共享：上下文切换与 scoped store 重建都要丢弃。
  // 条目只增不删会让长会话内存随插件数增长，但主动淘汰会打破「已加载即命中」的语义，
  // 因此清理点只有上下文切换一处，不要加定时淘汰或按视图大小裁剪。
  // 读缓存前必须判断 status：loading 与 loaded 都算命中，只有 error 允许 force 重试。
  describeCache: Record<string, PluginDescribeEntry>;
  // [契约] initialize 是唯一入口初始化：必须给出 workspacePath 与 pluginService，其余上下文缺省为 null。
  // workspaceIdentity 与 authorityKey 以可选形式由调用方传入，不在此从 workspacePath 推导：
  // 远程身份只能由上游提供，本层再猜一次等于新增第二份 workspace Identity 实现。
  // configScope 缺省表示「实际生效层」，与显式 user 不是同一语义，不能合并成同一个默认值。
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    authorityKey?: string;
    configScope?: ZCodePluginScope;
    pluginService: IPluginManagementService;
  }) => Promise<void>;
  // [契约] refresh 的 pluginService 可省略，省略时复用最近一次注入的服务；workspacePath 为空时静默返回。
  // options.background 决定是否展示 loading、是否清空既有 error：后台刷新必须保留当前错误态，
  // 否则其它视图的一次成功刷新会抹掉本视图尚未展示的失败提示。
  // 非后台 refresh 完成后广播失效通知，后台刷新不广播，避免视图之间互相触发刷新风暴。
  refresh: (
    pluginService?: IPluginManagementService,
    options?: { background?: boolean },
  ) => Promise<void>;
  addMarketplace: (source: string, pluginService: IPluginManagementService) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginService: IPluginManagementService,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginService: IPluginManagementService,
  ) => Promise<void>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  uninstallPlugin: (
    pluginId: string,
    pluginService: IPluginManagementService,
    removeCache?: boolean,
  ) => Promise<void>;
  updatePlugin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  restoreBuiltin: (pluginId: string, pluginService: IPluginManagementService) => Promise<boolean>;
  configurePlugin: (
    pluginId: string,
    options: Record<string, string | number | boolean>,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
    clearOptionKeys?: string[],
  ) => Promise<boolean>;
  resetPluginConfig: (
    pluginId: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  validateSource: (source: string, pluginService: IPluginManagementService) => Promise<void>;
  setEnabled: (
    pluginId: string,
    enabled: boolean,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  // 按需拉取插件组件清单（名称+描述）；force 跳过缓存重试。
  describePlugin: (
    pluginId: string,
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    force?: boolean,
  ) => Promise<void>;
}

// [失败路径] 只取 message 不拼 stack：这段文本会直接进入 error 并被卡片与输入框展示，带堆栈会撑破布局。
// 非 Error 值统一 String 化，保证 error 永远是字符串而不是对象，消费方可安全做相等与包含判断。
// 不要在这里截断或加前缀：错误文案的措辞属于展示层，存储层改写会让日志与界面提示对不上。
// 这个方法在 store 内被多处复制使用，改动前确认三个文件里的实现是否仍需保持一致。
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// [契约] install、update、restore 的 RPC envelope 在失败时仍是成功返回，真实原因在 diagnostics 里，
// 这里是唯一把「诊断」翻译成「操作失败」的关口，删掉它不会报编译错，只会让按钮看起来点了没反应。
// 只挑 severity 为 error 的第一条抛出：warning 表示部分可用（例如某个来源被跳过），
// 抛错会把已经成功的写入报告成失败，用户重试后可能重复安装。
// 抛出的 message 会由 runWorkspaceOperation 的 catch 写进 error 且归属为 null，文案必须自解释。
function throwForErrorDiagnostic(diagnostics: ZCodePluginDiagnostic[]): void {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostic) {
    throw new Error(blockingDiagnostic.message);
  }
}

// [权衡] 做成工厂而不是模块级单例：每个市场与管理视图需要独立查询投影，但共享同一个 CLI 插件服务。
// initialService 只作为 refresh 的默认值，initialize 仍会用传入服务覆盖它，
// 因此工厂参数不是「绑定服务」，调用方不要依赖它锁定主机。
// 工厂内部用闭包持有 lastService，多个 store 之间不共享可变状态，也不要把 lastService 提升到模块作用域，否则切主机的 scoped store 会互相串服务。
// 唯一的跨实例协作是失效广播，由订阅方用 isPluginManagementChangeRelevant 自行判断相关性。
export const createPluginManagementStore = (initialService?: IPluginManagementService) => {
  // [契约] lastService 只服务于「refresh 不传服务」这一种调用，不是权威来源：initialize 每次都会重写它。
  // 它是每个 store 实例的闭包变量、不进 state，因此修改不触发重渲染，也不受快照回滚影响。
  // 不要在操作路径里读它代替入参：写操作需要调用方显式给出服务，隐式回退会让测试注入失效。
  // 读取点只有 refresh 的默认参数一处，新增读取点前先确认它不会绕过 initialize 的上下文校准。
  let lastService = initialService;
  return create<PluginManagementState>((set, get) => ({
    workspacePath: null,
    workspaceIdentity: null,
    authorityKey: null,
    configScope: null,
    plugins: [],
    marketplaces: [],
    marketplaceAvailabilityKnown: false,
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    loading: false,
    error: null,
    lastFailedPluginId: null,
    togglingPluginId: null,
    activeOperations: [],
    operationVersion: 0,
    describeCache: {},

    // [并发] 这里不做请求去重：in-flight 复用与过期回写保护在 loadInto 里按服务与 workspaceKey 合并。
    // 本函数只负责三件事：校准四元上下文、决定是否清场、决定 loading 初值，然后交给 loadInto。
    // 不要在 set 之后另发 RPC：清场与查询必须保持「先定上下文、再取数据」的顺序，
    // 反过来会让回写守卫拿旧上下文比较，出现列表与 workspacePath 不一致的中间态。
    async initialize({
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
    }) {
      lastService = pluginService;
      const normalizedIdentity = workspaceIdentity?.trim() || null;
      const normalizedAuthorityKey = authorityKey?.trim() || null;
      const normalizedConfigScope = configScope ?? null;
      const current = get();
      const contextChanged =
        current.workspacePath !== workspacePath ||
        current.workspaceIdentity !== normalizedIdentity ||
        current.authorityKey !== normalizedAuthorityKey ||
        current.configScope !== normalizedConfigScope;
      // [权衡] 只有 plugins 非空且四元完全一致才算有缓存，宁可多显示一次 loading 也不复用错项目的列表。
      // 条件放宽（例如只比 workspacePath）会把远程项目缓存当成同路径本地项目的，
      // 用户看到的是另一台机器上的插件与版本号，且任何写操作都会打到错误主机。
      // hasCache 只影响 loading 初值，不影响是否发请求：有缓存仍会后台刷新，缓存不是数据权威。
      const hasCache =
        current.plugins.length > 0 &&
        current.workspacePath === workspacePath &&
        current.workspaceIdentity === normalizedIdentity &&
        current.authorityKey === normalizedAuthorityKey &&
        current.configScope === normalizedConfigScope;
      set({
        workspacePath,
        workspaceIdentity: normalizedIdentity,
        authorityKey: normalizedAuthorityKey,
        configScope: normalizedConfigScope,
        // 有缓存时后台刷新、保留列表, 避免切换 workspace 时闪烁; 无缓存才显示阻塞 loading。
        loading: !hasCache,
        marketplaceAvailabilityKnown: hasCache ? current.marketplaceAvailabilityKnown : false,
        error: null,
        lastFailedPluginId: null,
        // 配置保存后的 overview 刷新可能还没结束，用户已切到另一层配置视图；
        // 旧层的 activeOperations 不能继续把新层的输入控件置灰。旧操作结束时由独立条目防止
        // 它误清理新层后来启动的同名操作。
        // 先清空旧目标的投影，避免新项目加载期间仍能操作旧项目卡片或复用 describe 缓存。
        ...(contextChanged
          ? {
              activeOperations: [],
              operationVersion: current.operationVersion + 1,
              togglingPluginId: null,
              plugins: [],
              marketplaces: [],
              availablePlugins: [],
              installedPlugins: [],
              restorableBuiltins: [],
              diagnostics: [],
              describeCache: {},
            }
          : {}),
      });
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity: normalizedIdentity,
        authorityKey: normalizedAuthorityKey,
        configScope: normalizedConfigScope,
        pluginService,
      });
    },

    // [并发] workspacePath 或服务缺失时静默返回而不写 error：初始化前的自动刷新是常态，报错会污染首屏。
    // background 为 true 时不清 error、不进 loading，且 loadInto 会保留本视图尚未展示的失败信息。
    // 非后台刷新成功后广播 scope 为 user 的失效通知，其它视图据此后台拉取；
    // 漏掉广播会让设置页与市场页在写入后长期显示旧数据，直到用户手动刷新。
    async refresh(pluginService = lastService, options = {}) {
      const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
      if (!workspacePath || !pluginService) return;
      lastService = pluginService;
      if (!options.background) set({ error: null, lastFailedPluginId: null });
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity,
        authorityKey,
        configScope,
        pluginService,
        fresh: !options.background,
        background: options.background,
      });
      if (!options.background)
        notifyPluginManagementChange({
          owner: get,
          workspacePath,
          workspaceIdentity,
          authorityKey,
          scope: "user",
        });
    },

    async addMarketplace(source, pluginService) {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:add:${source}`,
        async (workspace) => {
          await pluginService.addPluginMarketplace({
            ...workspace,
            source,
          });
        },
      );
    },

    // [事务] 来源刷新允许部分成功：某个来源失败时仍要 reload，让其余来源的新数据落地，不能整批回滚。
    // marketplace 为 null 表示刷新全部来源，operationId 用 __all__ 占位，避免空串参与拼接后与具体来源撞名。
    // 诊断要过滤掉与 CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID 相等的项：官方来源的告警属可忽略噪音，
    // 计入失败会让刷新入口长期停在失败态，而实际内容其实已经更新。
    // refreshError 用闭包变量暂存而不立即 set：提前写会被随后的 reload 结果冲掉，用户只看到一闪而过的红条。
    async updateMarketplace(marketplace, pluginService) {
      let refreshError: string | null = null;
      const succeeded = await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:update:${marketplace ?? "__all__"}`,
        async (workspace) => {
          const result = await pluginService.updatePluginMarketplace({
            ...workspace,
            ...(marketplace ? { marketplace } : {}),
          });
          // 刷新允许部分成功，因此仍要 reload overview 保留成功来源；但仅 warn
          // 并返回 true，桌面与手机 Web 都会把旧快照误报成刷新成功。先记住错误，reload 后再写入
          // 共用 store 的可见错误态，同时返回 false，让所有入口获得一致的部分失败语义。
          const blockingDiagnostic = result.diagnostics?.find(
            (diagnostic) =>
              diagnostic.severity === "error" &&
              diagnostic.pluginId !== CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
          );
          if (blockingDiagnostic) {
            refreshError = blockingDiagnostic.message;
            logger.warn("[plugins] marketplace refresh partially failed", {
              diagnostics: result.diagnostics,
            });
          }
        },
      );
      if (succeeded && refreshError) {
        // 列表刷新失败无插件目标，归属清空（不指向任何插件）。
        set({ error: refreshError, lastFailedPluginId: null });
        return false;
      }
      return succeeded;
    },

    async removeMarketplace(marketplace, pluginService) {
      await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `marketplace:remove:${marketplace}`,
        async (workspace) => {
          await pluginService.removePluginMarketplace({
            ...workspace,
            marketplace,
          });
        },
      );
    },

    // [契约] scope 缺省 user，与 configurePlugin 一致；resetPluginConfig 缺省 workspace 是刻意的例外。
    // operationId 带 pluginName 与 marketplace：同名插件在不同来源安装是两次独立操作，不能被合并置灰。
    // 成功与否只由 runWorkspaceOperation 的返回值表达，调用方不要再读 error 判断，
    // 因为上下文切换时它会为保护新上下文主动返回 false 而不写错误。
    async installPlugin(pluginName, marketplace, pluginService, scope = "user") {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:install:${pluginName}@${marketplace}`,
        async (workspace) => {
          const result = await pluginService.installPlugin({
            ...workspace,
            pluginName,
            marketplace,
            scope,
          });
          // CLI 为了保留结构化诊断，安装失败会返回成功的 RPC envelope，
          // 并把实际错误放进 diagnostics。旧 UI 忽略返回值后继续刷新，看起来像按钮无响应，
          // 也没有错误和重试入口；这里将 error diagnostic 收敛到既有 operation 错误态。
          throwForErrorDiagnostic(result.diagnostics);
        },
      );
    },

    async uninstallPlugin(pluginId, pluginService, removeCache = true) {
      await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:uninstall:${pluginId}`,
        async (workspace) => {
          await pluginService.uninstallPlugin({
            ...workspace,
            pluginId,
            removeCache,
          });
        },
      );
    },

    async updatePlugin(pluginId, pluginService) {
      await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:update:${pluginId}`,
        async (workspace) => {
          const result = await pluginService.updatePlugin({ ...workspace, pluginId });
          // update 与 install 共享同一诊断式失败契约。抛入 runWorkspaceOperation 后不会
          // 覆盖当前 overview，因此旧版本和 update badge 会一直保留到用户重试成功。
          throwForErrorDiagnostic(result.diagnostics);
        },
      );
    },

    async restoreBuiltin(pluginId, pluginService) {
      return runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:restore:${pluginId}`,
        async (workspace) => {
          const result = await pluginService.restoreBuiltinPlugin({ ...workspace, pluginId });
          throwForErrorDiagnostic(result.diagnostics);
        },
      );
    },

    async configurePlugin(pluginId, options, pluginService, scope = "user", clearOptionKeys = []) {
      return await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:configure:${pluginId}`,
        async (workspace) => {
          await pluginService.configurePlugin({
            ...workspace,
            pluginId,
            options,
            scope,
            ...(clearOptionKeys.length > 0 ? { clearOptionKeys } : {}),
          });
        },
        scope,
      );
    },

    async resetPluginConfig(pluginId, pluginService, scope = "workspace") {
      return await runWorkspaceOperation(
        set,
        get,
        pluginService,
        `plugin:reset-config:${pluginId}`,
        async (workspace) => {
          await pluginService.resetPluginConfig({
            ...workspace,
            pluginId,
            scope,
          });
        },
        scope,
      );
    },

    // [并发] 本操作绕过 runWorkspaceOperation，直接登记 beginPluginOperation：校验只写 diagnostics，不刷新 overview。
    // version 快照必须在登记之后取，因为登记本身会自增 operationVersion；取早了守卫永远不成立，
    // 校验结果一条都写不进去，界面表现为点了校验没有任何反应。
    // 成功与失败两处都要比对 version：切换配置层后旧校验的 diagnostics 不能落到新页面，否则新项目会显示上一个来源的错误。
    // finally 里的 finish 必须无条件调用，即便上下文已切换：条目按对象身份移除，不会误伤新操作。
    async validateSource(source, pluginService) {
      const { workspacePath, workspaceIdentity } = get();
      if (!workspacePath) return;
      const finish = beginPluginOperation(set, get, `marketplace:validate:${source}`);
      const version = get().operationVersion;
      try {
        const result = await pluginService.validatePlugin({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          source,
        });
        if (get().operationVersion === version) set({ diagnostics: result.diagnostics });
      } catch (error) {
        logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
        if (get().operationVersion === version) {
          set({ error: toMessage(error), lastFailedPluginId: null });
        }
      } finally {
        finish();
      }
    },

    async setEnabled(pluginId, enabled, pluginService, scope = "user") {
      return setPluginEnabledOptimistically(set, get, pluginId, enabled, pluginService, scope);
    },

    // [资源] describe 是唯一不做操作登记的方法：它只读查询，不应置灰按钮或占用 activeOperations。
    // force 只在 error 态生效，用于给用户重试入口；对 loading 或 loaded 强制刷新会产生重复请求。
    // 请求对象既作为状态又是身份令牌：回写前必须比对引用，确保旧项目或已被替代的响应不回填。
    // 零组件加 error 诊断要映射成 error 态而不是 loaded（CLI 用诊断回包代替 RPC reject）；catch 分支同样要先比对引用再写 error，否则旧请求的失败会覆盖刚成功的新详情。
    async describePlugin(pluginId, pluginName, marketplace, pluginService, force = false) {
      const { workspacePath, workspaceIdentity, describeCache } = get();
      if (!workspacePath) return;
      const cached = describeCache[pluginId];
      // 已加载或正在加载时命中缓存，不重复请求；force 时强制重试。
      if (!force && cached && cached.status !== "error") return;
      const request: PluginDescribeEntry = { status: "loading" };
      set({ describeCache: { ...get().describeCache, [pluginId]: request } });
      try {
        const data = await pluginService.describePlugin({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          marketplace,
          pluginName,
        });
        // 旧项目或已被重试替代的 describe 响应不能回填当前详情缓存。
        if (get().describeCache[pluginId] !== request) return;
        const blockingDiagnostic = data.diagnostics?.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (data.components.length === 0 && blockingDiagnostic) {
          // CLI 的 describe 对不可解析来源采用 diagnostics 回包而非 RPC reject。
          // 旧 UI 把该回包缓存为 loaded，详情只显示空白且永远没有重试入口；这里将无组件的
          // error diagnostic 映射成可恢复错误态，同时保留正常的部分成功回包。
          set({
            describeCache: {
              ...get().describeCache,
              [pluginId]: { status: "error", error: blockingDiagnostic.message },
            },
          });
          return;
        }
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "loaded", data },
          },
        });
      } catch (error) {
        if (get().describeCache[pluginId] !== request) return;
        logger.error("[plugins] describe failed", {
          pluginId,
          marketplace,
          error: toMessage(error),
        });
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "error", error: toMessage(error) },
          },
        });
      }
    },
  }));
};

export const usePluginManagementStore = createPluginManagementStore();

// 全局设置消费者与市场投影使用相同的失效通道，避免只更新其中一类视图。
function subscribeStore(store: ReturnType<typeof createPluginManagementStore>) {
  return subscribePluginManagementChanges((change) => {
    if (
      change.owner !== store.getState &&
      isPluginManagementChangeRelevant(store.getState(), change)
    ) {
      return store.getState().refresh(undefined, { background: true });
    }
  });
}
subscribeStore(usePluginManagementStore);

/** 每个市场/管理视图持有独立查询投影，写入仍由同一个 CLI 插件服务负责。 */
// [资源] 每个视图一份 store：目录与在途写入状态不能跨主机复用，服务切换必须重建实例。
// useMemo 依赖只能有 pluginService：把 workspacePath 之类放进来会在路径变化时重建 store，清掉 describe 缓存并让详情闪空。
// useEffect 必须返回订阅的解绑函数且依赖为 store：漏解绑会在热更新与快速切换视图时累积监听，
// 一次写入触发多次后台刷新。
export function useScopedPluginManagementStore(pluginService: IPluginManagementService) {
  // 服务切换后不能复用旧主机的目录和在途写入状态。
  const store = useMemo(() => createPluginManagementStore(pluginService), [pluginService]);
  useEffect(() => subscribeStore(store), [store]);
  return store;
}
