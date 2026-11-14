import { create } from "zustand";
import type { ISubagentsService } from "@zcode/services";
import {
  normalizeAgentProviderToZCodeAgent,
  type AgentSummary,
  type AgentsCapability,
  type ZCodeProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { getServiceAuthorityId } from "@/store/serviceAuthorityKey.js";

// INV-01 缓存键三元组：守住 getSubagentsContextKey 里 authority、身份来源、归一化 provider 三段拼接；改错会把不同服务实例的快照混进同一个桶，跨 workspace 读到他处 agents。
// INV-02 身份回落规则：守住 workspaceIdentity 先 trim 再回落 workspacePath 的唯一写法；改错会让同一远程 workspace 的两条路径各建一份快照，启用状态显示互相矛盾。
// INV-03 provider 归一化：守住键与快照内的 provider 都经 normalizeAgentProviderToZCodeAgent；改错会让同一 agent 以两种 provider 名称分成两桶，切换后列表重复或为空。
// INV-04 单例作用域：守住 inFlightLoads 与 latestRequestIds 是模块级、按 key 分桶；改错挪进组件或 hook 会丢失去重，每次挂载都多打一次远端请求。
// INV-05 序号单调：守住 nextRequestId 只增不复位；改错在长会话里回绕或复用旧值，旧响应会被误判为最新并覆盖新数据。
// INV-06 最新者胜：守住 loadContext 成功分支与失败分支入口处的序号比对；改错会让先发后至的响应落地，界面刷新后闪回旧列表。
// INV-07 在途复用：守住 loadAgents 仅在 bypassCache 为假时读取 inFlightLoads；改错会让显式刷新复用旧请求，用户点刷新却拿不到新结果。
// INV-08 清理认身份：守住 finally 里仅当登记项仍是本次 request 才删除 key；改错会删掉后来者的登记，后续调用重新发起重复请求。
// INV-09 初始化幂等：守住 initialize 命中已有 key 时的早返回；改错会让每个 pane 挂载都重新拉取并重置 loading，列表周期性闪烁。
// INV-10 刷新语义：守住 refresh 恒传 bypassCache 为真且不跳过已有快照；改错会让刷新退化成缓存命中，或清空已加载内容造成白屏。
// INV-11 乐观阶段字段：守住装载前 loading 由 existing?.loaded 推导、其余字段保留旧值；改错会在二次加载时清空 agents，用户看到列表消失再出现。
// INV-12 错误保留上下文：守住 catch 分支先取 state.contexts[key] 兜底再只覆盖 loading 与 error；改错会丢掉 workspacePath 等元信息，选择器读到 undefined 崩溃。
// INV-13 错误不落 loaded：守住失败时不把 loaded 置真；改错会让失败后的 initialize 被早返回拦住，重试入口彻底失效。
// INV-14 陈旧错误丢弃：守住 catch 内先比对 requestId 再写 error；改错会让早先的失败消息盖住最新成功结果，界面弹出幽灵错误。
// INV-15 不可变写入：守住 updateContext 以展开方式新建 contexts 对象；改错原地改字段不会触发 zustand 通知，订阅组件不重渲染。
// INV-16 非目标桶保引用：守住写入时只替换目标 key 的 snapshot、其余桶保持原对象；改错全量重建每个快照会让所有 pane 的 selector 判定变化。
// INV-17 启用失败回写：守住 setEnabled 捕获异常后仅更新对应 key 的 error 与 loading；改错把错误抛给调用方会让按钮永远停在 pending 态。
// INV-18 无桶不外建：守住 setEnabled 在 key 不存在时返回空补丁；改错会凭空插入只含错误字段的快照，后续 initialize 被早返回挡住。
//
// 模块职责：为每个 workspace 与 provider 组合维护 Subagents 列表快照，负责加载去重、请求竞态裁决与启用开关的服务调用。
// 状态所有权：本模块是 agents、capability、loading、loaded、error 的唯一写入者；服务端事实来自 ISubagentsService，组件只能通过 selector 读取。
// 阅读顺序：先看 SubagentsContextSnapshot 与 key 构造，再看 loadAgents 的去重、loadContext 的竞态裁决，最后看 store 三个动作的入口语义。
export interface SubagentsContextSnapshot {
  workspacePath: string;
  workspaceIdentity: string | null;
  provider: ZCodeProvider;
  // 快照是纯数据投影，不持有服务引用或运行时句柄，保证 zustand 浅比较与跨窗口序列化都安全。
  // agents 与 capability 只由成功分支整体替换，不做增量合并，避免被删除的 agent 残留在列表里。
  // workspaceIdentity 归一化为 null 而非 undefined，既让快照可 JSON 往返，也与键的回落规则保持同一语义。
  // loaded 表示首次成功加载已经发生，loading 只表示当前是否有请求在途，两者不可互相推导。
  // error 非空时 loaded 仍可能为真，展示层必须同时读取两者，不能只凭 error 是否存在决定空态。
  agents: AgentSummary[];
  capability: AgentsCapability | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

// contexts 以 getSubagentsContextKey 的结果为唯一索引，删掉一个桶等于丢失该 workspace 的加载事实。
// 三个动作都返回 Promise 且不向外抛错，调用方无需 try，也拿不到错误对象，错误只能从快照的 error 字段读。
// subagentsService 每次由参数传入，不在 store 内缓存实例，避免热更新或连接切换后仍持有过期服务引用。
// workspaceIdentity 在接口上是可选项，缺省时必须由键构造与快照写入两处共同退回到 workspacePath。
interface SubagentsContextStoreState {
  contexts: Record<string, SubagentsContextSnapshot>;
  initialize: (
    workspacePath: string,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (
    workspacePath: string,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  setEnabled: (
    workspacePath: string,
    provider: ZCodeProvider,
    agentId: string,
    enabled: boolean,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
}

// 这两个 Map 与计数器是模块级单例而非组件状态，页面卸载不会清空在途请求台账。
// 台账按 key 分桶，不同 workspace 或不同 provider 的请求互不抑制，也不会互相裁决竞态。
// inFlightLoads 存的是 Promise 而不是布尔标记，后来者复用同一结果即可，不必重复发起调用。
// latestRequestIds 只记录每个桶最后一个请求序号，用于判断响应是否过期，不用来取消底层请求。
// 计数器用模块级 let 递增而非每桶独立分配，跨桶共享同一序列，比较时不会出现数值相同却语义不同的情况。
const inFlightLoads = new Map<string, ReturnType<ISubagentsService["list"]>>();
const latestRequestIds = new Map<string, number>();
let nextRequestId = 0;

// 键由服务权威标识、身份来源、归一化 provider 三段拼接，任一段缺失都会造成桶碰撞。
// authority 取自 getServiceAuthorityId，用来区分同一 workspace 在本地与远程连接下的不同服务实例。
// 身份段优先使用 trim 后的 workspaceIdentity，为空才退回 workspacePath，与全局身份约定保持一致。
// provider 必须先归一化再入键，调用方传入的原始值不参与比较，避免别名或大小写差异产生双桶。
// 返回值是纯字符串，可直接作 Map 键与对象属性，调用处不要再做二次拼接或截断。
export function getSubagentsContextKey(
  workspacePath: string,
  provider: ZCodeProvider,
  workspaceIdentity: string | null | undefined,
  subagentsService: ISubagentsService,
): string {
  const authority = getServiceAuthorityId(subagentsService);
  return `${authority}::${workspaceIdentity?.trim() || workspacePath}::${normalizeAgentProviderToZCodeAgent(provider)}`;
}

// 写入以浅拷贝新对象返回，让 zustand 判定状态已变化；原地改字段不会触发任何订阅。
// 只替换目标 key 的 snapshot，其余桶的值保持原引用，其他 pane 的 selector 因此不会被打扰。
// 返回类型限定为只含 contexts 的部分状态，调用方无法顺带覆盖其他全局字段。
// 这里不校验 key 是否存在，新增桶与更新桶走同一条路径，存在性判断留给调用方。
function updateContext(
  state: SubagentsContextStoreState,
  key: string,
  update: SubagentsContextSnapshot,
): Pick<SubagentsContextStoreState, "contexts"> {
  return { contexts: { ...state.contexts, [key]: update } };
}

// 去重只在未要求绕过缓存时生效，显式刷新必须真正打到服务端，不能被在途请求吞掉。
// 命中在途请求时直接返回同一个 Promise，调用方拿到的是共享结果而非副本，不要在此再包一层。
// 登记发生在发起之后：先得到 request 再写入 Map，保证 finally 比较时能对上同一个引用。
// finally 中必须比对登记项是否仍是本次 request，否则会误删后来者的登记，让去重机制整体失效。
// 失败时 Promise 同样被复用并继续向上抛出，由 loadContext 统一裁决并写错误，这里不吞异常。
function loadAgents(
  key: string,
  workspacePath: string,
  provider: ZCodeProvider,
  subagentsService: ISubagentsService,
  workspaceIdentity?: string,
  bypassCache = false,
): ReturnType<ISubagentsService["list"]> {
  if (!bypassCache) {
    const current = inFlightLoads.get(key);
    if (current) return current;
  }
  const request = subagentsService
    .list({ workspacePath, workspaceIdentity, provider })
    .finally(() => {
      if (inFlightLoads.get(key) === request) inFlightLoads.delete(key);
    });
  inFlightLoads.set(key, request);
  return request;
}

// 进入即写入乐观快照并登记新序号，让界面立刻反映目标 workspace 与 provider，而不是等网络返回。
// 序号自增后才发起请求，成功与失败两条分支都先比对序号，过期响应一律丢弃且不改任何状态。
// 装载前的 loading 由既有 loaded 推导：已加载过的桶刷新时不显示骨架，从未加载过的桶才显示。
// 成功分支整体替换 agents 与 capability 并置 loaded 为真，同时清空上一次遗留的 error。
// 失败分支以现有快照为底只覆盖 loading 与 error，保证 workspacePath 等元信息在失败后仍可读。
async function loadContext(
  params: {
    workspacePath: string;
    provider: ZCodeProvider;
    subagentsService: ISubagentsService;
    workspaceIdentity?: string;
    bypassCache: boolean;
  },
  set: (
    updater: (state: SubagentsContextStoreState) => Partial<SubagentsContextStoreState>,
  ) => void,
  get: () => SubagentsContextStoreState,
): Promise<void> {
  const provider = normalizeAgentProviderToZCodeAgent(params.provider);
  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const key = getSubagentsContextKey(
    params.workspacePath,
    provider,
    workspaceIdentity,
    params.subagentsService,
  );
  const existing = get().contexts[key];
  const requestId = ++nextRequestId;
  latestRequestIds.set(key, requestId);
  set((state) =>
    updateContext(state, key, {
      workspacePath: params.workspacePath,
      workspaceIdentity: workspaceIdentity ?? null,
      provider,
      agents: existing?.agents ?? [],
      capability: existing?.capability ?? null,
      loading: existing?.loaded !== true,
      loaded: existing?.loaded ?? false,
      error: null,
    }),
  );
  try {
    const result = await loadAgents(
      key,
      params.workspacePath,
      provider,
      params.subagentsService,
      workspaceIdentity,
      params.bypassCache,
    );
    if (latestRequestIds.get(key) !== requestId) return;
    set((state) =>
      updateContext(state, key, {
        workspacePath: params.workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
        provider,
        agents: result.agents,
        capability: result.capability,
        loading: false,
        loaded: true,
        error: null,
      }),
    );
  } catch (error) {
    if (latestRequestIds.get(key) !== requestId) return;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[subagents] workspace context load failed", {
      workspacePath: params.workspacePath,
      workspaceIdentity,
      provider,
      error: message,
    });
    set((state) =>
      updateContext(state, key, {
        ...(state.contexts[key] ?? {
          workspacePath: params.workspacePath,
          workspaceIdentity: workspaceIdentity ?? null,
          provider,
          agents: [],
          capability: null,
          loaded: false,
        }),
        loading: false,
        error: message,
      }),
    );
  }
}

// 初始化按 key 幂等，桶已存在即返回，多个 pane 同时挂载也只产生一次真实加载。
// 早返回依赖桶的存在而不是 loaded 标志，失败后桶依然存在，重试必须走 refresh 而不是重复 initialize。
// refresh 恒以绕过缓存的方式加载，且不检查桶是否存在，因此也可当作首次加载入口使用。
// 两个入口都不捕获异常，错误在 loadContext 内被转成快照字段，调用方不会收到 reject。
export const useSubagentsContextStore = create<SubagentsContextStoreState>((set, get) => ({
  contexts: {},
  async initialize(workspacePath, provider, subagentsService, workspaceIdentity) {
    const key = getSubagentsContextKey(
      workspacePath,
      provider,
      workspaceIdentity,
      subagentsService,
    );
    // Bugfix：多个可见 pane 会各自挂载 Subagents 消费者。旧单例把“当前 workspace”
    // 当成全局可变字段，跨 workspace pane 会互相触发 initialize；按 workspaceKey+provider
    // 分桶后，每个 effect 只订阅自己的稳定快照。
    if (get().contexts[key]) return;
    await loadContext(
      { workspacePath, provider, subagentsService, workspaceIdentity, bypassCache: false },
      set,
      get,
    );
  },
  async refresh(workspacePath, provider, subagentsService, workspaceIdentity) {
    await loadContext(
      { workspacePath, provider, subagentsService, workspaceIdentity, bypassCache: true },
      set,
      get,
    );
  },
  // 先写服务端再刷新本地快照，顺序反了会出现界面已切换而服务端未生效的假成功。
  // 刷新失败时只回写对应桶的 error 并结束 loading，不回滚 agents，避免列表突然清空。
  // 桶不存在时返回空补丁，绝不凭空创建快照，否则 initialize 的幂等早返回会挡住真正的首次加载。
  // key 在 catch 内重新计算，因为 try 块不产出 key，且传入的 provider 可能尚未归一化。
  async setEnabled(workspacePath, provider, agentId, enabled, subagentsService, workspaceIdentity) {
    try {
      await subagentsService.setEnabled({ agentId, enabled });
      await get().refresh(workspacePath, provider, subagentsService, workspaceIdentity);
    } catch (error) {
      const key = getSubagentsContextKey(
        workspacePath,
        provider,
        workspaceIdentity,
        subagentsService,
      );
      const message = error instanceof Error ? error.message : String(error);
      set((state) => {
        const existing = state.contexts[key];
        return existing
          ? updateContext(state, key, { ...existing, loading: false, error: message })
          : {};
      });
    }
  },
}));
