// INV-01 同一投影 key 的同轮扫描只发一次请求；守住位置：loadSkillsOnce 的 inFlightSkillLoads 命中分支；改错故障：多个技能消费者首屏并发拉取，服务层镜像同步竞争放大成用户可见报错。
// INV-02 只有 workspace、identity、provider、服务授权 ID 四项全等才可复用缓存；守住位置：initialize 的 hasCachedSkills 判定；改错故障：切换会话后旧技能串到新会话里显示。
// INV-03 缓存命中的判定必须包含 workspaceIdentity 而不只是路径；守住位置：initialize 的 hasCachedSkills 条件；改错故障：同一路径的远程与本地工作区互相污染技能列表。
// INV-04 投影 key 变化后必须丢弃迟到结果；守住位置：initialize 与 refresh 的 activeSkillProjectionKey 比对提前返回；改错故障：快速切换 agent 后旧请求回写覆盖新列表。
// INV-05 写回技能列表前必须同步更新 loaded 快照；守住位置：initialize 与 refresh 的 set 调用；改错故障：下次 initialize 误判缓存有效，显示过期技能。
// INV-06 服务授权 ID 只在成功写回时更新；守住位置：loadedSkillServiceAuthorityId 赋值；改错故障：失败后仍认为旧服务结果可用，缓存跨服务实例泄漏。
// INV-07 存在缓存时必须保持 loading 为 false；守住位置：initialize 与 refresh 的 loading 字段；改错故障：Settings 与 mention 列表整片闪烁。
// INV-08 无缓存时必须置 loading 为 true 并清空 skills；守住位置：initialize 与 refresh 的清空分支；改错故障：空列表与无技能空态混淆，用户误以为技能丢失。
// INV-09 每次新的 initialize 或 refresh 必须先清空 error；守住位置：两者入口 set 的 error 字段；改错故障：上一次失败提示残留，成功加载后仍显示错误。
// INV-10 缺少 skillsService 时必须显式落 error 并结束；守住位置：initialize 的缺依赖分支与 setEnabled 的同类分支；改错故障：静默空列表，用户无法得知依赖注入缺失。
// INV-11 refresh 必须绕过 in-flight 复用；守住位置：refresh 中按 key 删除 inFlightSkillLoads 条目；改错故障：复制技能到通用目录后 mention 仍看到旧列表。
// INV-12 清理 in-flight 只能删除属于自己的 Promise；守住位置：loadSkillsOnce 的 finally 内的同一性判断；改错故障：并发请求互相清除，去重失效并放大竞争。
// INV-13 去重 key 必须包含服务授权 ID；守住位置：getSkillLoadKey 的模板拼接；改错故障：不同服务实例共用 key，串用彼此的扫描结果。
// INV-14 去重 key 的身份段必须优先 identity、缺省才回退路径；守住位置：getSkillLoadKey 的 identity 归一；改错故障：远程身份被路径覆盖，缓存命中错误。
// INV-15 refresh 与 setEnabled 在缺少 workspacePath 时必须直接返回；守住位置：两个 action 的前置守卫；改错故障：未进入工作区就发请求，产生无主错误状态。
// INV-16 setEnabled 成功后必须复用 refresh 刷新投影；守住位置：setEnabled 内的 refresh 调用；改错故障：开关已落盘但列表仍显示旧状态。
// INV-17 setEnabled 失败只写 error，不得改动 skills；守住位置：setEnabled 的 catch 分支；改错故障：失败时列表被清空，用户以为技能被删除。
// INV-18 错误文本必须归一为 string 再入 state；守住位置：三个 action 的 catch 与 error 字段；改错故障：Error 对象进入渲染层，错误提示显示为 [object Object]。
//
// 模块职责：本文件是 UI 侧技能目录的唯一读写投影，把 ISkillsService 的结果收敛成 mention 面板与 Settings 共用的技能列表。
// 状态所有权：技能事实归 ISkillsService，本 store 只持有展示投影、加载态与错误，不保存开关结果的权威副本。
// 阅读顺序：先看 key 构造与单飞去重，再看 initialize 与 refresh 的写回分支，最后看 setEnabled 的命令式转发。
import { create } from "zustand";
import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
  type SkillSummary,
  type SkillsCapability,
} from "@zcode/shared";
// 依赖注入边界：技能数据只经 ISkillsService 进入，store 不直接访问 Repo 或 IPC。
// 服务实例只作为入参传递，store 不持有其引用，避免跨窗口复用同一连接。
import type { ISkillsService } from "@zcode/services";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { logger } from "@/logger.js";
import { getServiceAuthorityId } from "@/store/serviceAuthorityKey.js";

// 字段分四组：目标投影（workspacePath、workspaceIdentity、provider）表示本次请求意图。
// 第二组 loaded 前缀字段是已提交快照，仅用于缓存有效性判定，不参与渲染。
// 第三组 skills、capability、loading、error 是渲染面，必须与 loaded 字段同一次写回。
interface SkillStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  provider: ZCodeProvider;
  loadedProvider: ZCodeProvider | null;
  skills: SkillSummary[];
  capability: SkillsCapability | null;
  loading: boolean;
  error: string | null;
  initialize: (
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (skillsService: ISkillsService, workspaceIdentity?: string) => Promise<void>;
  setEnabled: (
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
}

// [并发] 单飞表以投影 key 为索引存放 Promise，生命周期由 finally 收敛。
// [权衡] 表放在模块级而非 state 内，避免登记请求触发重渲染与引用抖动。
const inFlightSkillLoads = new Map<string, ReturnType<ISkillsService["list"]>>();
// [并发] 该模块级变量记录最后一次被采纳的投影 key，充当迟到结果写回栅栏。
// 它不进入 state，因为竞态判定属于实现细节，渲染层无需感知。
let activeSkillProjectionKey: string | null = null;
// [资源] 记录最近成功写回的服务实例授权 ID，防止旧服务缓存跨实例命中。
let loadedSkillServiceAuthorityId: number | null = null;
// 去重与竞态共用同一套 key 构造，任何一侧改动都必须同步另一侧。
// key 依次拼接服务授权 ID、身份段、provider，三段缺一都会误命中。
function getSkillLoadKey(
  workspacePath: string,
  provider: ZCodeProvider,
  skillsService: ISkillsService,
  workspaceIdentity?: string,
): string {
  // 身份段遵循仓库统一规则：identity 去空白后优先，缺省回退 workspacePath。
  // provider 已在上游归一为 ZCode provider，此处不再做二次转换。
  return `${getServiceAuthorityId(skillsService)}::${workspaceIdentity?.trim() || workspacePath}::${provider}`;
}

function loadSkillsOnce(
  workspacePath: string,
  provider: ZCodeProvider,
  skillsService: ISkillsService,
  workspaceIdentity?: string,
  options: { bypassCache?: boolean } = {},
): ReturnType<ISkillsService["list"]> {
  const key = getSkillLoadKey(workspacePath, provider, skillsService, workspaceIdentity);
  // [并发] 默认开启单飞；只有 refresh 场景才允许跳过缓存读。
  // 跳过读缓存不等于跳过写表，新 Promise 仍会覆盖同 key 的旧条目。
  if (!options.bypassCache) {
    const current = inFlightSkillLoads.get(key);
    if (current) {
      return current;
    }
  }
  // 复制/移除技能到通用目录后 refresh 必须拿到最新结果。
  // 若复用 in-flight Promise 会返回旧扫描结果，导致 chat mention 看不到新加的技能。
  // [失败路径] list 的 rejected Promise 也必须走 finally，否则 key 会永久占位。
  // 请求参数原样透传 workspacePath、workspaceIdentity 与 provider，不做本地拼装。
  const request = skillsService.list({ workspacePath, workspaceIdentity, provider }).finally(() => {
    // 仅在自己是当前活跃 in-flight 时清理，避免覆盖其他并发请求。
    if (inFlightSkillLoads.get(key) === request) {
      inFlightSkillLoads.delete(key);
    }
  });
  // [并发] 写表发生在 finally 绑定之后，保证清理时能比对同一引用。
  inFlightSkillLoads.set(key, request);
  return request;
}

// store 工厂只创建一份实例，所有窗口内消费者共享同一份投影。
// set 用于提交，get 用于读取最新快照，二者都不跨 await 缓存旧值。
export const useSkillStore = create<SkillStoreState>((set, get) => ({
  // 初始投影为空，表示尚未绑定工作区，此阶段的 action 一律空转。
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  provider: ZCODE_AGENT_PROVIDER,
  // loaded 字段初值为 null，确保首次 initialize 必然走真实加载而非缓存分支。
  loadedProvider: null,
  skills: [],
  capability: null,
  loading: false,
  error: null,
  // initialize 是唯一入口：归一 provider、校验依赖、建立投影 key 后决定是否复用缓存。
  // 它同时推进目标投影与已提交快照，失败时两者都要落地以便后续诊断。
  async initialize(
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    // 参数位兼容两种调用形态：带 provider 的新签名与只传 service 的旧签名。
    // 判定只看首参是否为字符串，布尔值不会出现在 initialize 的这个位置。
    const hasProvider = typeof providerOrSkillsService === "string";
    const provider = normalizeAgentProviderToZCodeAgent(
      hasProvider ? providerOrSkillsService : ZCODE_AGENT_PROVIDER,
    );
    const skillsService = hasProvider ? maybeSkillsService : providerOrSkillsService;
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    // [失败路径] 依赖缺失属于调用方错误，必须立即落 error 并结束，不能抛异常穿透。
    // 此时同时写 loaded 字段，让缓存判定保持自洽而不是停留在上一工作区。
    if (!skillsService) {
      set({
        workspacePath,
        workspaceIdentity: normalizedWorkspaceIdentity,
        provider,
        loading: false,
        error: "skillsService is required",
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
      return;
    }
    const serviceAuthorityId = getServiceAuthorityId(skillsService);
    const projectionKey = `${serviceAuthorityId}::${normalizedWorkspaceIdentity || workspacePath}::${provider}`;
    activeSkillProjectionKey = projectionKey;
    const hasCachedSkills =
      currentState.skills.length > 0 &&
      loadedSkillServiceAuthorityId === serviceAuthorityId &&
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      currentState.loadedProvider === provider;
    // 切换 agent 筛选时会触发 initialize。
    // 之前总是 loading=true，会先清空成“加载中”再渲染结果，导致列表闪烁。
    // 这里改成“只有同一 workspace+provider 的缓存才允许复用”，避免上一套技能误显示到当前会话里。
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      provider,
      // [权衡] 命中缓存时保留旧数组引用，未命中才清空，避免列表重建导致的闪烁。
      // capability 与 skills 同源，必须一起保留或一起清空，否则出现有列表无能力。
      skills: hasCachedSkills ? currentState.skills : [],
      capability: hasCachedSkills ? currentState.capability : null,
      loading: !hasCachedSkills,
      error: null,
    });
    try {
      // 聊天输入区会同时挂载多个技能消费者（例如 $ mention 与 / 面板）。
      // 之前它们首屏会并发触发相同的 list 请求，进而把服务层镜像同步竞争放大成用户可见报错。
      // 这里先按 workspace+provider 去重，同一轮只复用一个请求结果。
      // [并发] initialize 与 refresh 共用 loadSkillsOnce，区别仅在 refresh 会先摘除缓存。
      // 结果返回后不直接写回，先做投影 key 比对再提交，迟到结果一律丢弃。
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        normalizedWorkspaceIdentity ?? undefined,
      );
      // [并发] 该提前返回是竞态核心：投影已被替换时既不写列表也不改 loaded 字段。
      if (activeSkillProjectionKey !== projectionKey) return;
      loadedSkillServiceAuthorityId = serviceAuthorityId;
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    } catch (error) {
      if (activeSkillProjectionKey !== projectionKey) return;
      // [失败路径] 先记一条 error 日志保留 provider 与错误文本，再统一归一入 state。
      logger.error("[skills] initialize failed", {
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
  // refresh 面向已绑定的工作区，不接收路径，路径始终取自当前 state。
  // 它强制新请求但仍受投影 key 栅栏约束，与 initialize 共用同一套写回。
  async refresh(skillsService: ISkillsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const provider = normalizeAgentProviderToZCodeAgent(get().provider);
    const serviceAuthorityId = getServiceAuthorityId(skillsService);
    const projectionKey = `${serviceAuthorityId}::${workspaceIdentityFromState || workspacePath}::${provider}`;
    activeSkillProjectionKey = projectionKey;
    const hasCachedSkills =
      get().skills.length > 0 && loadedSkillServiceAuthorityId === serviceAuthorityId;
    // Bugfix: 开关技能后会触发 refresh，之前每次都把 loading 置 true，
    // Settings 列表会先切到“加载中”再切回数据，用户看到整列表闪烁。
    // 这里改成“仅首次无缓存时显示阻塞 loading”，有缓存时后台刷新并保留当前列表。
    set({
      skills: hasCachedSkills ? get().skills : [],
      capability: hasCachedSkills ? get().capability : null,
      loading: !hasCachedSkills,
      error: null,
    });
    // Bugfix: refresh 必须保证拿到「最新一次」的服务端结果。
    // 此前直接调 loadSkillsOnce 会复用 in-flight 的旧请求，
    // 导致复制 skill 到通用目录后 chat mention 仍看到旧列表。
    // 这里在 refresh 时显式跳过 in-flight 缓存，强制发起一次新请求。
    // [失败路径] 主动摘除同 key 条目是本次刷新的关键：旧 Promise 可能已完成但仍带旧快照。
    // 摘除只影响单飞表，不影响已在等待该 Promise 的调用方，它们仍会拿到旧结果。
    inFlightSkillLoads.delete(
      getSkillLoadKey(workspacePath, provider, skillsService, workspaceIdentityFromState),
    );
    try {
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        workspaceIdentityFromState,
      );
      if (activeSkillProjectionKey !== projectionKey) return;
      loadedSkillServiceAuthorityId = serviceAuthorityId;
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    } catch (error) {
      if (activeSkillProjectionKey !== projectionKey) return;
      // 刷新失败保留既有列表不动，只更新 error，避免把可用数据换成空态。
      logger.error("[skills] refresh failed", {
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
  async setEnabled(
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    // [权衡] 通过首参类型区分新旧签名，旧调用把 service 放在第三参。
    const legacyCall = typeof providerOrEnabled === "boolean";
    const provider = normalizeAgentProviderToZCodeAgent(
      legacyCall ? get().provider : providerOrEnabled,
    );
    const scope = legacyCall ? undefined : (scopeOrSkillsService as SkillSummary["scope"]);
    const enabled = legacyCall ? providerOrEnabled : (enabledOrSkillsService as boolean);
    const skillsService = legacyCall
      ? (scopeOrSkillsService as ISkillsService)
      : maybeSkillsService;
    if (!skillsService) {
      set({ error: "skillsService is required" });
      return;
    }
    try {
      // 写操作先落服务再回头刷新投影，顺序不可颠倒，否则列表与磁盘短暂不一致。
      // scope 为空时不传该字段，交由服务层决定默认作用域。
      await skillsService.setEnabled({
        workspacePath,
        workspaceIdentity: workspaceIdentityFromState,
        provider,
        ...(scope ? { scope } : {}),
        skillId,
        enabled,
      });
      // [并发] 刷新沿用调用方传入的 identity，避免与 setEnabled 的目标工作区错位。
      await get().refresh(skillsService, workspaceIdentityFromState);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

type SkillStoreE2EBridge = typeof useSkillStore;

declare global {
  interface Window {
    __skillStoreE2E?: SkillStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E 诊断入口必须由 WDIO 显式打开，不能复用 ZCODE_ENV=test，避免产品测试环境暴露可变全局 store。
  // [资源] E2E 桥仅在 WDIO 显式开启时挂到 window，测试环境默认不外露可变 store。
  window.__skillStoreE2E = useSkillStore;
}
