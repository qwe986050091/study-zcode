// subagentsStore —— 子代理配置列表的 UI 投影层，唯一所有者是 useSubagentsStore。
//
// 职责边界：只保存 workspacePath + workspaceIdentity + provider + service authority 四元组
// 确定后的一次性加载快照（agents / capability / loading / error）；运行中的子代理实例、
// 任务队列与消息流归会话运行时所有，绝不回写到 agents。列表态可刷新、可删除；运行态只认
// run/session 标识，因此「列表里消失」不等于「运行已终止」。
//
// INV 表（断言 —— 守住它的位置 —— 改错故障）：
// INV-01 断言：agents 只代表 loaded* 四元组对应的一份快照 —— 守住它的位置：initialize / refresh 的 set 与 hasCachedAgents —— 改错故障：切 workspace 后仍展示上一项目的子代理
// INV-02 断言：loadedSubagentsServiceAuthorityId 只在最新请求通过后写入 —— 守住它的位置：isLatestAgentLoadRequest 之后的赋值 —— 改错故障：过期响应把别的 service 标记成已加载，缓存串号
// INV-03 断言：任何 await 之后先校验 requestId 再 set —— 守住它的位置：initialize / refresh 的两处 isLatestAgentLoadRequest —— 改错故障：慢请求覆盖新 workspace 的列表
// INV-04 断言：缓存命中时不得进入 loading —— 守住它的位置：hasCachedAgents 分支里 loading 取反 —— 改错故障：切换回来时列表闪空并阻塞操作
// INV-05 断言：缺 subagentsService 也要写 loaded* 并留下 error —— 守住它的位置：initialize 的 !subagentsService 分支 —— 改错故障：反复重试同一无效上下文，错误被静默吞掉
// INV-06 断言：provider 一律先经 normalizeAgentProviderToZCodeAgent 归一 —— 守住它的位置：initialize / refresh / createAgent / updateAgent —— 改错故障：provider 拼写差异导致缓存永远不命中
// INV-07 断言：workspaceIdentity 统一 trim 后空串转 null —— 守住它的位置：normalizedWorkspaceIdentity 与 workspaceIdentityFromState —— 改错故障：空串与 null 被当成两个 workspace 互相踢缓存
// INV-08 断言：refresh 缺 workspacePath 时直接返回，不发请求 —— 守住它的位置：refresh 首行的 workspacePath 判空 —— 改错故障：空路径打到 service，报错污染 error 并清空列表
// INV-09 断言：加载失败只写 error，不清空已展示的 agents —— 守住它的位置：initialize / refresh 的 catch 分支未写 agents —— 改错故障：一次网络抖动让整个列表消失
// INV-10 断言：operatingAgentId 在 finally 中必定清空 —— 守住它的位置：setEnabled / createAgent / updateAgent / deleteAgent 的 finally —— 改错故障：异常后 UI 永久停在操作中，行内按钮不可点
// INV-11 断言：变更成功后必须 refresh 并绕过缓存 —— 守住它的位置：四个变更 action 里的 await get().refresh —— 改错故障：本地乐观值与磁盘真实状态分叉
// INV-12 断言：删除进行中的子代理也只从列表移除，不碰运行态 —— 守住它的位置：deleteAgent 只调 service 并 refresh —— 改错故障：UI 越权终止 run，或在列表删掉仍在运行的条目造成幽灵运行
import { create } from "zustand";
import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
  type AgentSummary,
  type AgentsCapability,
  type SubAgentConfig,
} from "@zcode/shared";
import type { ISubagentsService } from "@zcode/services";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { logger } from "@/logger.js";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { getServiceAuthorityId } from "@/store/serviceAuthorityKey.js";
import {
  isLatestAgentLoadRequest,
  loadAgentsOnce,
  nextAgentLoadRequestId,
} from "@/store/subagentsStoreLoading.js";

// [契约] 状态形状按「输入四元组 + 输出快照 + 瞬时操作标记」三段划分。
// 输入是 workspacePath / workspaceIdentity / provider；输出是 agents / capability / loading / error。
// loaded* 是快照归属证明，不是输入副本，只允许在确认请求生效后同步。
interface SubagentsStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  provider: ZCodeProvider;
  loadedProvider: ZCodeProvider | null;
  // [契约] agents 仅是「已加载列表」的投影，不含 running / streaming 等运行态字段。
  // 子代理是否正在执行由 run/session 决定，本数组刷新或删除都不代表运行被终止。
  // 因此 UI 必须把它当只读快照消费，不能据此推断实例存活。
  agents: AgentSummary[];
  capability: AgentsCapability | null;
  loading: boolean;
  error: string | null;
  // [并发] operatingAgentId 是全局单值，同一时刻只表达一个进行中的写操作。
  // 它以 agentId 标识行级忙碌；新建时借用 new:name 形式的临时键占位。
  // 该字段只驱动视觉禁用，不承担互斥，真正的串行化由 service 与刷新时序保证。
  /** 正在操作的 agent ID（用于 UI 状态指示） */
  operatingAgentId: string | null;
  initialize: (
    workspacePath: string,
    providerOrSubagentsService: ZCodeProvider | ISubagentsService,
    maybeSubagentsService?: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (subagentsService: ISubagentsService, workspaceIdentity?: string) => Promise<void>;
  setEnabled: (
    agentId: string,
    enabled: boolean,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  createAgent: (
    config: SubAgentConfig,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<AgentSummary | null>;
  updateAgent: (
    agentId: string,
    config: SubAgentConfig,
    oldFilePath: string | undefined,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<AgentSummary | null>;
  deleteAgent: (
    agentId: string,
    filePath: string,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
}

// [契约] 模块级变量记录「当前 agents 快照属于哪个 service 实例」的 authority。
// 它不进入 store 状态，因为它是缓存有效性的旁证，而不是可渲染的数据。
// 跨 action 共享它是为了让 refresh 也能判断缓存是否仍可复用。
let loadedSubagentsServiceAuthorityId: number | null = null;

// [契约] 单一 create 入口：所有读写都经 set/get，禁止在模块外持有可变副本。
// 初始为空快照且 loaded* 全为 null，表示「尚未加载任何上下文」。
export const useSubagentsStore = create<SubagentsStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  provider: ZCODE_AGENT_PROVIDER,
  loadedProvider: null,
  agents: [],
  capability: null,
  loading: false,
  error: null,
  operatingAgentId: null,
  // [契约] initialize 是唯一的上下文切换入口，入参兼容两种重载。
  // 新签名带 provider，旧签名只传 service，由 hasProvider 判别后补齐默认 provider。
  // 它负责「先落输入、再决定缓存、最后请求」三拍，任何一拍失败都要保持状态自洽。
  // 这里不感知运行态，切换上下文不会停止已在跑的子代理。
  async initialize(
    workspacePath: string,
    providerOrSubagentsService: ZCodeProvider | ISubagentsService,
    maybeSubagentsService?: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    // [并发] 先取一次快照再计算，避免多次 get() 之间被其他 action 插入修改。
    // 后续所有分支都基于这份 currentState 判断缓存，保持同一次调用的判断一致。
    const currentState = get();
    // [契约] typeof 为 string 说明走的是新排列 (provider, service)。
    // 否则第二位就是 service，provider 取 ZCODE_AGENT_PROVIDER 默认值。
    // 归一化后的 provider 既用于请求，也用于 loadedProvider 比对，二者必须同源。
    const hasProvider = typeof providerOrSubagentsService === "string";
    const provider = normalizeAgentProviderToZCodeAgent(
      hasProvider ? providerOrSubagentsService : ZCODE_AGENT_PROVIDER,
    );
    const subagentsService = hasProvider ? maybeSubagentsService : providerOrSubagentsService;
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    // [失败路径] service 缺失属于调用方契约违约，不能静默返回。
    // 这里仍写全 loaded* 并关掉 loading，标明「该上下文已尝试加载且失败」，避免上层重试风暴。
    // 注意不动 agents：保留旧列表比清空更利于用户判断，错误由 error 单独表达。
    if (!subagentsService) {
      set({
        workspacePath,
        workspaceIdentity: normalizedWorkspaceIdentity,
        provider,
        loading: false,
        error: "subagentsService is required",
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
      return;
    }
    // [权衡] authority 用 service 实例身份而非 workspacePath，因为同名 workspace 可能接到不同后端。
    // 取 id 是开销极小的稳定映射，可以安全放进每次加载的热路径。
    // 它只在请求确认最新后才写入模块变量，防止失败请求污染缓存归属。
    const serviceAuthorityId = getServiceAuthorityId(subagentsService);
    // [资源] 缓存命中要求四个条件同时成立：列表非空、authority 相同、路径相同、identity 与 provider 均相同。
    // `hasCachedAgents` 为假即视为新上下文，走清空重载而不是增量合并。
    // 这里用 loaded* 而不是入参本身比较，是为了区分「已生效的快照」和「刚写入的输入」。
    const hasCachedAgents =
      currentState.agents.length > 0 &&
      loadedSubagentsServiceAuthorityId === serviceAuthorityId &&
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      currentState.loadedProvider === provider;
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      provider,
      // [事务] 输入字段无条件覆盖，快照字段则按缓存命中与否二选一。
      // 未命中时在同一次 set 里清空 agents 与 capability，避免出现「新路径配旧列表」的中间态。
      // loading 取反 hasCachedAgents：命中即静默刷新，未命中才展示骨架。
      agents: hasCachedAgents ? currentState.agents : [],
      capability: hasCachedAgents ? currentState.capability : null,
      loading: !hasCachedAgents,
      error: null,
    });
    // [并发] 发请求前领号，号只增不减，用于让「最后发出的请求」拥有写入权。
    // 号在 await 之前取得，保证比较基准早于任何可能的并发插入。
    const requestId = nextAgentLoadRequestId();
    try {
      const result = await loadAgentsOnce(
        workspacePath,
        provider,
        subagentsService,
        normalizedWorkspaceIdentity ?? undefined,
      );
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      // [并发] 通过最新性校验才允许写入 authority 与快照。
      // 过期请求直接 return，既不写 agents 也不改 loading，避免抢走当前上下文的加载态。
      // authority 与 loaded* 在同一分支内更新，保证缓存归属和数据永远同代。
      loadedSubagentsServiceAuthorityId = serviceAuthorityId;
      set({
        agents: result.agents,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    } catch (error) {
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      // [失败路径] catch 同样先做最新性校验：被取代的请求失败不应覆盖当前 error。
      // 记录 workspacePath、provider 与 message，便于区分是上下文错误还是后端故障。
      // 只写 loading / error 与 loaded*，刻意保留旧 agents，实现「错误时保留旧数据」。
      logger.error("[subagents] initialize failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    }
  },
  // [契约] refresh 复用当前 workspacePath，不改变输入四元组，只重新取一次快照。
  // 它比 initialize 多一个 bypassCache，用于写操作后的强制回源。
  // 因此 refresh 的失败语义是「刷新失败」而非「切换失败」，不应清空已加载内容。
  async refresh(subagentsService: ISubagentsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    // [失败路径] 未 initialize 前没有可信上下文，静默返回而不是报错。
    // 此时不写 error，因为「还没选 workspace」是正常启动态，不是故障。
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const provider = normalizeAgentProviderToZCodeAgent(get().provider);
    const serviceAuthorityId = getServiceAuthorityId(subagentsService);
    const hasCachedAgents =
      get().agents.length > 0 && loadedSubagentsServiceAuthorityId === serviceAuthorityId;
    set({
      agents: hasCachedAgents ? get().agents : [],
      capability: hasCachedAgents ? get().capability : null,
      loading: !hasCachedAgents,
      error: null,
    });
    const requestId = nextAgentLoadRequestId();
    try {
      const result = await loadAgentsOnce(
        workspacePath,
        provider,
        subagentsService,
        workspaceIdentityFromState,
        // [权衡] 写操作后必须绕过缓存，否则可能读回写前的旧快照。
        // 代价是多一次请求；收益是列表与磁盘状态一致，胜过本地乐观更新。
        { bypassCache: true },
      );
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      loadedSubagentsServiceAuthorityId = serviceAuthorityId;
      set({
        agents: result.agents,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    } catch (error) {
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      // [失败路径] 刷新失败同样只记录并写 error，不触碰 agents 与 capability。
      // 最新性校验在前，防止旧刷新失败把新上下文的错误覆盖。
      // 成功与失败都同步 loaded*，确保「已尝试」的归属判断在下次调用时成立。
      logger.error("[subagents] refresh failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    }
  },
  // [事务] setEnabled 是「先写后端、再整表回源」的两段式，不做本地乐观翻转。
  // 成功后统一走 refresh，让服务端返回的 enabled 成为唯一事实。
  // 失败时仅写 error 并原样返回，列表保持上一次成功快照。
  async setEnabled(
    agentId: string,
    enabled: boolean,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    // [并发] 操作开始即标记该行忙碌，UI 据此禁用同行按钮。
    // 标记早于请求发出，避免用户在下一次渲染前重复点击造成并发写。
    set({ operatingAgentId: agentId });
    try {
      await subagentsService.setEnabled({
        agentId,
        enabled,
      });
      // [事务] 写入成功后立即回源，refresh 内部会用 bypassCache 拿到最新列表。
      // 若刷新失败，错误由 refresh 自己写入，这里不重复覆盖，保留首个根因。
      // finally 负责清空 operatingAgentId，成功与异常路径都不会漏。
      await get().refresh(subagentsService, workspaceIdentityFromState);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set({ operatingAgentId: null });
    }
  },
  // [契约] createAgent 返回新建的 AgentSummary，供调用方立即定位或选中。
  // 失败返回 null 而不是抛出，让 UI 用 error 字段统一呈现。
  // workspacePath 未就绪时直接返回 null，不制造半初始化状态。
  async createAgent(
    config: SubAgentConfig,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    // [并发] 新建没有 agentId，用 new:name 作为临时忙碌键，避免与其他行冲突。
    // `new:` 前缀键只在请求期间存在，刷新后由真实 `agentId` 行接管展示。
    // 取名占位也意味着同名新建会被视作同一行的忙碌态，这是可接受的保守行为。
    set({ operatingAgentId: `new:${config.name}` });
    try {
      // [事务] provider 再次归一化后下传，确保落盘与内存缓存使用同一套枚举。
      // 请求成功才 refresh；失败不 refresh，避免用一次失败清掉用户正在看的列表。
      const result = await subagentsService.createAgent({
        config,
        provider: normalizeAgentProviderToZCodeAgent(provider),
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
      return result.agent;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      set({ operatingAgentId: null });
    }
  },
  // [契约] updateAgent 额外接收 oldFilePath：改名或迁移目录时用它定位旧文件。
  // 成功后返回新摘要，失败返回 null 并写 error，语义与 createAgent 对齐。
  // 与 createAgent 一样先判 workspacePath，未就绪不发起写。
  async updateAgent(
    agentId: string,
    config: SubAgentConfig,
    oldFilePath: string | undefined,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ operatingAgentId: agentId });
    try {
      const result = await subagentsService.updateAgent({
        agentId,
        config,
        oldFilePath,
        provider: normalizeAgentProviderToZCodeAgent(provider),
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
      return result.agent;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      set({ operatingAgentId: null });
    }
  },
  // [契约] deleteAgent 返回布尔值表达「后端删除是否成功」，不返回被删条目。
  // filePath 必须由调用方给出，store 不负责从 agents 里反查路径。
  // 删除是破坏性操作，因此失败时绝不在本地先移除，保证列表与磁盘同源。
  async deleteAgent(
    agentId: string,
    filePath: string,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ operatingAgentId: agentId });
    try {
      // [并发] 删除进行中的子代理时，只标记该行为忙碌并调用 service，不主动终止运行。
      // 运行时归属会话层：列表移除后条目可能仍在执行，UI 不得据列表推断存活。
      // 真正的运行终止必须走 run/session 的显式接口，不能由本 action 代劳。
      // 成功后统一 refresh 回源，让后端决定该条目是否真的消失。
      // 这样列表态与运行态各自演进，避免「删了列表却留下幽灵运行」或反向越权。
      await subagentsService.deleteAgent({
        agentId,
        filePath,
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      // [失败路径] 删除失败返回 false 且只写 error，旧列表保持不变。
      // 调用方据返回值决定是否提示，不要依赖 error 的时序。
      return false;
    } finally {
      set({ operatingAgentId: null });
    }
  },
}));

type SubagentsStoreE2EBridge = typeof useSubagentsStore;

declare global {
  interface Window {
    __subagentsStoreE2E?: SubagentsStoreE2EBridge;
  }
}

// [资源] E2E 桥由独立开关控制，只在 WDIO 显式开启时才挂到 window。
// 它暴露的是整个 store 引用，属测试专用后门，不能随普通测试环境默认打开。
if (shouldExposeE2EStoreBridge()) {
  // E2E 诊断入口必须由 WDIO 显式打开，不能复用 ZCODE_ENV=test，避免产品测试环境暴露可变全局 store。
  // [契约] 挂载的是 store hook 本身，测试可直接读写状态并调用 action。
  // 该赋值只在判定通过的分支执行，未开启时 window 上不存在该键。
  window.__subagentsStoreE2E = useSubagentsStore;
}

// [契约] 该函数用于「保存配置后」按 scope 精准刷新已加载的投影，不新建 store。
// user scope 只刷与当前已加载 authority 一致的实例；workspace scope 要求路径与 identity 双匹配。
// 它同时刷新主 store 与 contextStore 中的上下文投影，二者各自维护缓存。
// 返回 Promise.all，调用方可等待全部刷新完成再关闭面板。
export async function refreshLoadedSubagentsStoreForWorkspace(params: {
  scope?: "user" | "workspace";
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  subagentsService: ISubagentsService;
}): Promise<void> {
  const userScope = params.scope === "user";
  const workspacePath = params.workspacePath?.trim();
  if (!userScope && !workspacePath) return;
  const workspaceIdentity = params.workspaceIdentity?.trim() || null;
  const state = useSubagentsStore.getState();
  const contextStore = useSubagentsContextStore.getState();
  const refreshes: Promise<void>[] = [];
  // Bug 根因：User 保存曾按 active remote workspace 刷新，空路径又跳过本机 @ 缓存。
  // 只刷新同 authority 已有的投影；新目标加载中不能借用旧 loaded authority。
  // [并发] refreshLegacy 是投影刷新资格判定：只有同 authority 且同路径同 identity 才允许。
  // 新目标正在加载时 loaded* 尚未更新，此时旧 authority 不能被借用，否则会刷错实例。
  // user scope 额外比对 loadedSubagentsServiceAuthorityId，避免跨 service 误刷。
  // 不满足条件就跳过该路刷新，宁可少刷也不写错缓存归属。
  const refreshLegacy = userScope
    ? state.workspacePath === state.loadedWorkspacePath &&
      state.workspaceIdentity === state.loadedWorkspaceIdentity &&
      loadedSubagentsServiceAuthorityId === getServiceAuthorityId(params.subagentsService)
    : state.workspacePath === workspacePath && state.workspaceIdentity === workspaceIdentity;
  if (state.workspacePath && refreshLegacy) {
    refreshes.push(state.refresh(params.subagentsService, state.workspaceIdentity ?? undefined));
  }
  // [资源] 逐个遍历上下文投影，键由 path + provider + identity + service 共同决定。
  // 只有键完全一致的投影才参与刷新，防止把一次保存扩散到无关上下文。
  for (const [key, context] of Object.entries(contextStore.contexts)) {
    if (
      !userScope &&
      (context.workspacePath !== workspacePath || context.workspaceIdentity !== workspaceIdentity)
    )
      continue;
    if (
      key !==
      getSubagentsContextKey(
        context.workspacePath,
        context.provider,
        context.workspaceIdentity,
        params.subagentsService,
      )
    )
      continue;
    refreshes.push(
      contextStore.refresh(
        context.workspacePath,
        context.provider,
        params.subagentsService,
        context.workspaceIdentity ?? undefined,
      ),
    );
  }
  // [失败路径] 并发刷新用 all 等待，任一失败会整体 reject 给调用方处理。
  // 各 refresh 自身已写入 error，这里不再吞异常，保持错误可追溯。
  await Promise.all(refreshes);
}
