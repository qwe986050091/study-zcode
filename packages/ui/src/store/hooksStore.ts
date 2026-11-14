// INV-01 store 只投影一个 workspace 的 hooks，切换必须整份替换；守住位置：initialize 的 key 比较分支；改错故障：界面显示上一个仓库的钩子并可被误改。
// INV-02 派生 key 必须由 path、identity、authorityKey 三者共同决定；守住位置：getHooksCacheKey；改错故障：不同授权视角串用同一份列表。
// INV-03 任何异步结果写回前都要重算当前 key；守住位置：loadCurrentHooks 与 refresh 的返回点；改错故障：旧请求覆盖新 workspace 的钩子。
// INV-04 loading 是全局单字段，跨 workspace 不可共享；守住位置：refresh 的启动前置判断；改错故障：切走后界面永久停在加载态。
// INV-05 同一 key 的并发初始化只发一次请求；守住位置：inflightLoads 的复用分支；改错故障：重复请求互相覆盖，列表抖动。
// INV-06 写操作统一走乐观更新、持久化、失败回滚三步；守住位置：applyHookMutation；改错故障：保存失败后界面仍显示成功结果。
// INV-07 回滚前必须确认 workspace 未漂移；守住位置：applyHookMutation 的 catch 分支；改错故障：旧数组被写进新 workspace 并落盘。
// INV-08 持久化之后要重新拉取，以磁盘结果为准；守住位置：persistHooks 尾部；改错故障：界面与磁盘分叉，重启后配置消失。
// INV-09 operatingHookId 只标记正在写入的单条钩子；守住位置：applyHookMutation 的 set 与成功分支；改错故障：按钮一直转圈或整列表被禁用。
// INV-10 只有可编辑的钩子允许改删开关；守住位置：isEditableHook 与 updateHook、deleteHook、toggleHook；改错故障：改动外部来源配置，写盘失败。
// INV-11 仅 zcode 来源的钩子能导入为本地副本；守住位置：importHook 的来源判断；改错故障：重复导入自身，列表出现同名重复项。
// INV-12 新建钩子的 id 必须全局唯一；守住位置：hookFromConfig 与 importHook 的 id 生成；改错故障：更新命中错误条目，改动张冠李戴。
// INV-13 配置到钩子的映射要为不同类型裁剪残留字段；守住位置：updateHookFromConfig；改错故障：切换类型后残留 args 导致执行异常。
// INV-14 新建钩子默认启用且超时回落到 60 秒；守住位置：hookFromConfig 的默认值；改错故障：用户以为已开启，钩子实际不执行。
// INV-15 无 workspace 时的写操作必须显式失败；守住位置：persistHooks 与 addHook、importHook 的前置判断；改错故障：改动被静默丢弃。
// INV-16 错误信息统一转成字符串再入 store；守住位置：errorMessage 与各 catch 分支；改错故障：抛非 Error 值时界面显示 undefined。
// INV-17 空串的 path 与 identity 一律归一为 null；守住位置：initialize 与 refresh 的归一化；改错故障：缓存键出现空串差异，重复加载。
// INV-18 选择器只读已投影的数组，不在其中新建对象；守住位置：hooks 字段的消费方；改错故障：每次渲染都触发重渲染甚至无限循环。
//
// 本文件是 workspace 钩子配置的唯一 UI 投影：读靠 hooks 数组，写全部经服务层落盘。
// 所有异步边界都用三元组 key 做漂移守卫，改时序前先确认 key 的组成与写回点。
// 注释批次只补说明，不改任何逻辑与行为。
import { create } from "zustand";
import type { Hook, HookConfig } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";

// state 字段分三类：target 三元组（workspacePath、workspaceIdentity、authorityKey）、
// 投影（hooks、loadedWorkspaceKey、loading、error）、写操作的 operatingHookId。
// target 与投影必须同源，任何字段被单独改写都会让漂移守卫失效。
interface HooksStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  loadedWorkspaceKey: string | null;
  hooks: Hook[];
  loading: boolean;
  error: string | null;
  operatingHookId: string | null;
  initialize: (
    workspacePath: string | undefined,
    workspaceIdentity: string | undefined,
    hooksService: IHooksService,
    authorityKey?: string,
  ) => Promise<void>;
  /**
   * refresh 必须显式传入发起时的 target（path/identity/service 三元组）。
   * 旧签名只传 service，load 时才从 store 读 workspace——Trust 等待期间用户从
   * workspace A 切到 B 会形成「A 的 service + B 的 path/identity」，把 B 的列表
   * 污染成 A 的数据。现在三元组在调用点原子捕获，store 状态只用于漂移守卫。
   */
  refresh: (
    hooksService: IHooksService,
    target: {
      workspacePath?: string | null;
      workspaceIdentity?: string | null;
      authorityKey?: string | null;
    },
  ) => Promise<void>;
  addHook: (config: HookConfig, hooksService: IHooksService) => Promise<void>;
  updateHook: (id: string, config: HookConfig, hooksService: IHooksService) => Promise<void>;
  deleteHook: (id: string, hooksService: IHooksService) => Promise<void>;
  toggleHook: (id: string, enabled: boolean, hooksService: IHooksService) => Promise<void>;
  importHook: (id: string, hooksService: IHooksService) => Promise<void>;
}

type StoreSet = (state: Partial<HooksStoreState>) => void;
type StoreGet = () => HooksStoreState;

// [并发] 模块级去重表，key 与投影 key 同构；同 key 的第二个 initialize 只等待首个 promise。
// promise 在 finally 里删除，否则成功一次之后会被永久复用，切换回来拿不到新数据。
// [权衡] 表随会话内切换次数增长且不清理，条目量受切换频次限制，不构成泄漏。
const inflightLoads = new Map<string, Promise<void>>();

// [事务] 缓存键由 authorityKey 与 workspaceKey 拼接，前者决定权限视角，必须参与键。
// 缺 authorityKey 时退化为纯 workspaceKey，本地单授权场景仍能命中同一槽位。
// 两段之间用空字符分隔，避免拼接后出现同形异义键。
function getHooksCacheKey(
  workspacePath: string,
  workspaceIdentity?: string | null,
  authorityKey?: string | null,
): string {
  const targetKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  return authorityKey?.trim() ? `${authorityKey.trim()}\0${targetKey}` : targetKey;
}

// Bugfix：store 是单例，切换 workspace 后先发起的加载可能后到。任何异步结果写回 store 之前
// 都要比对发起时的 target key，否则旧 workspace 的 hooks 会覆盖当前投影，并被后续写操作落盘
// 到当前 workspace。
// 每次写回前现算当前 key，与发起时捕获的 key 比较，构成全文件统一的漂移守卫。
// [失败路径] 无 workspacePath 时返回 null，调用方的相等比较必然不成立并放弃写回。
// 不在模块级缓存该值：await 期间 initialize 可能已把 target 改写成别的 workspace。
function currentWorkspaceKey(get: StoreGet): string | null {
  const { workspacePath, workspaceIdentity, authorityKey } = get();
  return workspacePath ? getHooksCacheKey(workspacePath, workspaceIdentity, authorityKey) : null;
}

function errorMessage(error: unknown): string {
  // 非 Error 值（字符串、对象或 Promise 拒绝包）直接 String 化，对象会退化成 [object Object]，排障时看不到原始原因。
  return error instanceof Error ? error.message : String(error);
}

// 把存储层级翻译成 location：project 级要带 projectPath，user 级只标 scope。
// 两者都把 source 固定为 zcode，因为这里构造的都是可编辑的本地钩子。
function buildZCodeHookLocation(
  workspacePath: string,
  storageLevel: "user" | "project" = "user",
): Hook["location"] {
  return storageLevel === "project"
    ? {
        source: "zcode",
        scope: "project",
        directoryPath: "",
        projectPath: workspacePath,
      }
    : {
        source: "zcode",
        scope: "user",
        directoryPath: "",
      };
}

// editable 显式优先，缺省时回落到 location 判断：无 location 或 zcode 来源才可编辑。
// 外部来源（插件、项目文件）在界面只读，避免把用户改动写进别人的配置文件。
function isEditableHook(hook: Hook): boolean {
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// 新建钩子在此生成 id 与默认值：timeout 回落 60 秒，enabled 默认 true。
// 可选字段按类型展开，只有 process 带 args、command 带 async 与 shell，避免写下多余键。
// storageLevel 决定 location 落在用户级还是项目级，导入时会复用同一个构造。
function hookFromConfig(config: HookConfig, workspacePath: string): Hook {
  return {
    id: `hook-${crypto.randomUUID()}`,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    ...(config.type === "process" ? { args: config.args ?? [] } : {}),
    ...(config.type === "command" && config.async !== undefined ? { async: config.async } : {}),
    ...(config.type === "command" && config.shell !== undefined ? { shell: config.shell } : {}),
    ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? true,
    custom: config.custom,
    location: buildZCodeHookLocation(workspacePath, config.storageLevel),
  };
}

function updateHookFromConfig(hook: Hook, config: HookConfig): Hook {
  return {
    ...hook,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    // 类型切走后这里用 undefined 覆盖旧 args，落盘序列化会丢弃该键；若下游改成展开合并旧对象，残留 args 会重新出现。
    args: config.type === "process" ? (config.args ?? []) : undefined,
    async: config.type === "command" ? config.async : undefined,
    shell: config.type === "command" ? config.shell : undefined,
    statusMessage: config.statusMessage,
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? hook.enabled,
    custom: config.custom,
  };
}

// 拉取成功后先比对 key 再写 hooks 与 loadedWorkspaceKey，二者必须同时更新。
// [失败路径] 这里不捕获加载异常，交给调用方决定是否落 error 或回滚。
// loadedWorkspaceKey 是「当前投影来自哪个 workspace」的唯一凭据，不可单独清空。
async function loadCurrentHooks(get: StoreGet, set: StoreSet, hooksService: IHooksService) {
  const { workspacePath, workspaceIdentity, authorityKey } = get();
  if (!workspacePath) return;
  const key = getHooksCacheKey(workspacePath, workspaceIdentity, authorityKey);
  const result = await hooksService.loadHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  if (currentWorkspaceKey(get) !== key) return;
  set({
    hooks: result.hooks,
    loadedWorkspaceKey: key,
  });
}

// [事务] 先 saveHooks 落盘，再 loadCurrentHooks 回读，用磁盘结果覆盖内存投影。
// 无 workspacePath 直接抛错，让上层走回滚分支而不是写进空路径。
async function persistHooks(
  hooks: Hook[],
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
): Promise<void> {
  const { workspacePath, workspaceIdentity } = get();
  if (!workspacePath) throw new Error("No workspace path set");
  await hooksService.saveHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    hooks,
  });
  await loadCurrentHooks(get, set, hooksService);
}

// 五个写操作共享同一条乐观更新 → 持久化 → 回滚流程，收敛到一处以便 stale 守卫只写一遍。
// 五个写操作的公共骨架：捕获旧 hooks 与漂移 key，先乐观写入，再持久化并回读。
// [事务] 乐观写入同时清空 error 并标记 operatingHookId，界面立刻反映预期结果。
// [失败路径] 捕获异常后按 key 是否漂移分两种回滚，漂移时只清标记，绝不写旧数组。
// 回滚完仍向上抛出，由调用点提示用户，store 不吞掉失败。
async function applyHookMutation(
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
  updatedHooks: Hook[],
  operatingHookId?: string,
): Promise<void> {
  const previousHooks = get().hooks;
  const key = currentWorkspaceKey(get);
  set({
    hooks: updatedHooks,
    error: null,
    ...(operatingHookId ? { operatingHookId } : {}),
  });
  try {
    await persistHooks(updatedHooks, get, set, hooksService);
    set({ operatingHookId: null });
  } catch (error) {
    // 保存失败时若已切换 workspace，把捕获的旧 hooks 回滚进 store 会污染当前 workspace。
    set(
      currentWorkspaceKey(get) === key
        ? { hooks: previousHooks, operatingHookId: null, error: errorMessage(error) }
        : { operatingHookId: null },
    );
    throw error;
  }
}

export const useHooksStore = create<HooksStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  authorityKey: null,
  loadedWorkspaceKey: null,
  hooks: [],
  loading: false,
  error: null,
  operatingHookId: null,

  // 入口先把 path 与 identity 归一化（空串转 null）再写 target 三元组；无 path 时清空投影并返回。
  // key 变化说明换了 workspace，先清掉 hooks 与 loadedWorkspaceKey，防止旧数据被继续操作。
  // [并发] 命中 inflightLoads 时只等待既有 promise，不重复发请求也不重复切换 loading。
  // 首载在内部 promise 里设置 loading，回读结果同样受漂移守卫保护。
  initialize: async (workspacePath, workspaceIdentity, hooksService, authorityKey) => {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const normalizedAuthorityKey = authorityKey?.trim() || null;
    set({
      workspacePath: workspacePath ?? null,
      workspaceIdentity: normalizedIdentity,
      authorityKey: normalizedAuthorityKey,
    });
    if (!workspacePath) {
      set({ hooks: [], loading: false, loadedWorkspaceKey: null });
      return;
    }
    const key = getHooksCacheKey(workspacePath, normalizedIdentity, normalizedAuthorityKey);
    // Bugfix：切到另一个 workspace 时立即丢弃上一份投影，避免新数据到达前展示并操作别人的 hooks。
    if (get().loadedWorkspaceKey !== key) {
      set({ hooks: [], loadedWorkspaceKey: null });
    }
    const existing = inflightLoads.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await hooksService.loadHooks({
          workspacePath,
          ...(normalizedIdentity ? { workspaceIdentity: normalizedIdentity } : {}),
        });
        if (currentWorkspaceKey(get) !== key) return;
        set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
      } catch (error) {
        if (currentWorkspaceKey(get) !== key) return;
        set({ error: errorMessage(error), loading: false });
      } finally {
        inflightLoads.delete(key);
      }
    })();
    inflightLoads.set(key, promise);
    await promise;
  },

  // [事务] service 与 path/identity 成对传入，store 只校验是否仍是当前 target。
  // 发起前 key 不匹配就直接返回，避免把全局 loading 挂到一个已切走的 workspace 上。
  // [失败路径] 等待期间切走则静默丢弃结果，也不改 loading，生命周期归新的 initialize。
  // 这是 Trust 等待窗口内唯一安全的刷新方式：宁可少刷新，不可写错槽。
  refresh: async (hooksService, target) => {
    // 三元组在调用点原子捕获：service 与 path/identity 必须来自同一时刻的同一 target。
    const targetPath = target.workspacePath ?? null;
    const targetIdentity = target.workspaceIdentity?.trim() || null;
    const targetAuthorityKey = target.authorityKey?.trim() || null;
    // target 缺路径时静默返回，调用方无法区分「无需刷新」与「刷新被拒」，靠 loading 变化判断完成会一直等不到。
    if (!targetPath) return;
    const key = getHooksCacheKey(targetPath, targetIdentity, targetAuthorityKey);
    // Bugfix：发起前 target 已不是当前 workspace（Trust 等待期间用户已切走）时必须直接
    // 放弃——loading/error 是全局单一字段，若仍 set({loading:true}) 会在结果因 key 不匹配
    // 被丢弃后，把当前 workspace 永久留在 loading=true。
    if (currentWorkspaceKey(get) !== key) return;
    set({ loading: true, error: null });
    try {
      const result = await hooksService.loadHooks({
        workspacePath: targetPath,
        ...(targetIdentity ? { workspaceIdentity: targetIdentity } : {}),
      });
      // 等待期间 store 已切到别的 workspace → 本次结果对当前投影无效，静默丢弃；
      // loading 生命周期归新 workspace 自己的 initialize 所有，这里不得触碰。
      if (currentWorkspaceKey(get) !== key) return;
      set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
    } catch (error) {
      if (currentWorkspaceKey(get) !== key) return;
      set({ error: errorMessage(error), loading: false });
    }
  },

  // 追加到数组末尾后交给公共骨架，id 与默认值都在 hookFromConfig 内生成。
  // 无 workspacePath 立即抛错，不产生乐观写入。
  addHook: async (config, hooksService) => {
    const { workspacePath, hooks } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    await applyHookMutation(get, set, hooksService, [
      ...hooks,
      hookFromConfig(config, workspacePath),
    ]);
  },

  // 先定位目标并校验可编辑，未命中或只读都直接抛错，不产生任何写入。
  // `upsertHook` 命中后只替换命中项并保持其余引用，减少无关行重渲染。
  updateHook: async (id, config, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? updateHookFromConfig(hook, config) : hook)),
      id,
    );
  },

  // 删除没有二次确认，删掉最后一条后会落盘空数组；异常由公共骨架回滚并上抛，提示责任在调用点。
  deleteHook: async (id, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.filter((hook) => hook.id !== id),
      id,
    );
  },

  // 开关复用同一骨架，只改 enabled 字段，仍标记 operatingHookId 供行内禁用。
  // 同样要求目标可编辑，外部钩子不能从界面切换。
  toggleHook: async (id, enabled, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? { ...hook, enabled } : hook)),
      id,
    );
  },

  // 导入是在本地复制一份：换新 id、强制启用、location 改写为 zcode 来源。
  // 来源已是 zcode 时抛错，避免复制出与自身同源的重复项。
  // 复制保留 scope，项目级钩子导入后仍是项目级，只是归属变为可编辑。
  // 最后仍走公共骨架，导入与新建共享同一套回滚语义。
  importHook: async (id, hooksService) => {
    const { hooks, workspacePath } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    const source = hooks.find((hook) => hook.id === id);
    if (!source || source.location?.source === "zcode") throw new Error("Hook is not importable");
    const imported: Hook = {
      ...source,
      id: `hook-${crypto.randomUUID()}`,
      enabled: true,
      location: buildZCodeHookLocation(workspacePath, source.location?.scope ?? "user"),
    };
    await applyHookMutation(get, set, hooksService, [...hooks, imported], id);
  },
}));
