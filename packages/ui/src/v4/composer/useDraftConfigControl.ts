/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// 当前编辑由 Composer 持有；进入已有 Session 从当前快照恢复权限/Plan，在线只响应新变化。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
// 本文件职责：Composer 草稿的唯一 owner，收口选择、正文、模式与提交生命周期的状态边界。
//   - 做什么：维护当前作用域的草稿，把菜单意图写成 Renderer 状态，在已有会话的首份快照时
//     恢复权限与计划，并负责工作区目录水合的单飞与状态落库。
//   - 不做什么：不发提交、不生成已接纳队列、不持有 Host 侧事实；提交门禁由视图层承担。
//   - 依赖谁：模型选择服务视图、settings 的跟进模式、会话 store 的草稿命名空间与配置选项。
//   - 被谁调用：V4 Composer 容器，返回绑定当前会话与工作区的控制对象。
//   - 边界：菜单点击立即保存意图，预热与提交只消费它，不允许反向覆盖草稿。
//   - 边界：新建任务与已有会话共用同一面板，靠作用域键与初始化标记区分，不重挂载。
//   - 失败边界：读取未就绪时保留展示，提交由门禁阻断，不把短暂不可用写成空选择。
//
// INV（不变量：每一条都对应一处已知的草稿串号或配置错写，改动前逐条确认）：
// INV-01 切换模型时必须删除思考档位字段：保留源模型的值会被首发前的配置屏障当成显式切换 —— 守住它的位置：applyDraftModelSelection 末尾的删除 —— 改错故障：切模型后首条消息把旧档位写到新模型上。
// INV-02 目录水合判定必须同时看斜杠命令与模式目录：任一为空都要重新水合 —— 守住它的位置：shouldHydrateWorkspaceCatalog 的返回条件 —— 改错故障：已有会话的斜杠命令列表永久为空。
// INV-03 目录水合必须按工作区键单飞：草稿、已有会话与严格模式双挂载只能发一次请求 —— 守住它的位置：模块级登记表与进行中判断 —— 改错故障：双挂载各发一次请求，目录状态在加载与就绪之间抖动。
// INV-04 目录水合的加载状态必须在发起前写入、在成功与失败分支分别落定 —— 守住它的位置：水合效应里的三处状态写入 —— 改错故障：请求失败后状态停在加载，菜单永远不可用。
// INV-05 就绪门禁未通过时只能把目录状态置为空闲并提前返回：不能直接发起请求 —— 守住它的位置：启动允许分支 —— 改错故障：注册表未就绪就拉起 Agent，页面记下目录水合错误。
// INV-06 水合成功后必须写入配置选项、状态与斜杠命令三项：只写其中一项会让目录半可用 —— 守住它的位置：成功分支的三次写入 —— 改错故障：模式下拉有值但斜杠命令仍为空。
// INV-07 单飞条目必须在收尾阶段删除：成功与失败都要释放 —— 守住它的位置：水合链的收尾回调 —— 改错故障：一次失败后同一工作区再也不会重新水合。
// INV-08 作用域键必须包含工作区、会话、焦点版本与根命名空间：少一项就会复用错草稿 —— 守住它的位置：作用域键的序列化 —— 改错故障：新建任务复用上一个任务残留的正文。
// INV-09 初始草稿的依赖只有作用域键：依赖更多会让每次渲染都重新读磁盘 —— 守住它的位置：初始草稿的依赖数组 —— 改错故障：输入过程中每帧读一次本地存储，打字卡顿。
// INV-10 跨作用域必须重新加载，只有首发地址迁移允许沿用内存状态 —— 守住它的位置：当前状态的三元收敛 —— 改错故障：切换会话后仍显示上一个会话的草稿与权限。
// INV-11 地址迁移只允许同工作区且晋升会话匹配时沿用：其它情况必须回落重新加载 —— 守住它的位置：当前状态的晋升分支 —— 改错故障：换工作区后把上一份草稿迁移到新会话。
// INV-12 只有状态引用变化时才写回 React state：相等时不要写入 —— 守住它的位置：渲染阶段的比较与写回 —— 改错故障：每次渲染都触发一次额外更新，形成渲染循环。
// INV-13 已有会话只在首份快照时恢复权限与计划，且不覆盖草稿已有的模式 —— 守住它的位置：首份快照分支 —— 改错故障：历史授权被当成新指令重放，覆盖最新确认的模式。
// INV-14 在线只处理本次打开后新出现的授权与计划关联：必须比较上一次标识 —— 守住它的位置：配置观察分支与标识写回 —— 改错故障：每次重渲染都把历史事件重放一遍。
// INV-15 根草稿缺少模型时只补齐一次：不能替换失效的旧选择或已有会话的配置 —— 守住它的位置：根草稿补齐分支 —— 改错故障：用户显式选择的模型被默认值覆盖。
// INV-16 展示用选择必须与持久化意图分离：读取未就绪时只派生展示，草稿保留原意图 —— 守住它的位置：有效选择的派生 —— 改错故障：一次读取失败把用户选择永久写成空。
// INV-17 草稿配置的字段必须同源：模式、计划、模型、提供方与思考档位一起构造 —— 守住它的位置：草稿配置的计算 —— 改错故障：提交时提供方与模型不匹配，被 Host 拒绝。
// INV-18 所有写草稿的路径都必须先校验当前作用域：迟到的编辑器回调不能写进新会话 —— 守住它的位置：更新草稿与晋升的入口守卫 —— 改错故障：切换会话瞬间旧编辑覆盖新会话正文。
// INV-19 提交捕获的写回必须校验作用域且原选择未变：旧确认不能覆盖期间的新意图 —— 守住它的位置：捕获函数返回的写回回调 —— 改错故障：用户改选后又被旧回执改回，界面跳变。
//
// 阅读顺序：先看模型选择应用与水合判定两个纯函数，再看 hook 的作用域计算、三条状态收敛
// （新任务、首份会话快照、地址迁移）、持久化、提交捕获与三个菜单处理器。
// 术语：作用域指草稿命名空间，晋升指首发后把根草稿迁移到真实会话，水合指目录请求。
// 任何写草稿的路径都必须先过当前作用域校验，否则迟到的编辑器回调会写进新会话。
// 任何持久化都必须带同一个根作用域，读写用不同的命名空间会让草稿互相覆盖。
// 状态对象以引用相等表达未变化，所以构造新对象之前先确认是否真的需要切换。
// 这里没有定时器，异步只有目录水合；需要清理的只有挂载标记。
// 菜单处理器只写意图，不校验额度与权限，权限校验属于 Host 与提交路径。
// 改动前先确认配置引用与草稿的同步时机，二者不同步会让首帧提交带上旧配置。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { resolveComposerScope, composerScopeKey } from "@/v4/composer/composerDraftStore.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
// [并发] 目录水合按工作区键单飞，草稿、已有会话与严格模式双挂载共享同一个进行中的请求。
// 键必须用稳定的工作区身份，而不是组件实例或会话：不同会话的目录其实来自同一次请求。
// 只在登记表里增删，任何绕过它的直接请求都会让双挂载重复拉取目录。
// 条目在收尾阶段删除，成功与失败都要释放，否则一次失败会让该工作区永久不再水合。
// pendingRequests 是模块级 Map，组件卸载不中断在飞的请求。
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

// [契约] 切换模型要同时写模型选择、提供方与模型标识三处，漏一处就会让下一跳读到不一致。
// 选项只在源模型带有值时展开复制，避免把空对象写进协议字段造成无意义差异。
// 思考档位是模型的附属配置，切模型后必须删除，不能沿用源模型的值。
// 保留它会让首发的配置屏障误判成同一模型的显式档位切换，从而再写一次配置。
// 该函数是纯函数，返回新对象且不修改入参，调用方据此判断是否需要更新草稿。
export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  // [事务] 删除是这次写入的一部分，必须在返回前完成，而不是交给调用方清理。
  // 该字段没有出现在字面量里，只能显式删除，遗漏就会跟着新模型一起提交。
  // 不要改成把档位置空字符串，空串仍会被协议当成一次显式切换。
  // 返回值不复制其它字段，保持调用方的部分配置原样。
  delete next.thought;
  return next;
}

export function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

// [契约] 这个接口是 Composer 与本 hook 之间的唯一契约，新增字段要同步所有消费方。
// 草稿引用用于提交时读取最新值，配置快照用于首帧渲染，二者不能互相替代。
// 捕获函数返回一个写回回调，只有权威接纳后才允许调用，接口注释要保留这个前提。
// 菜单处理器只调 setDraft，接口不暴露网络或存储能力。
export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；恢复采用当前权限，在线授权只同步对应字段。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

interface ComposerState {
  scopeKey: string;
  workspaceKey: string;
  draft: V4ComposerDraft;
  initialization: "new-task" | "session" | "promotion";
  observedConfig?: { permissionGrantId?: string; planTransitionId?: string };
  promotedSessionId?: string;
}

// [契约] 入参的会话标识为空表示新任务，非空表示已有会话，两条初始化路径不同。
// 会话配置允许为空表示首份投影还没到，此时不能据此判定用户没有权限。
// 启动允许开关默认打开，是为了兼容没有渲染器就绪门禁的宿主，接入方仍应显式传入。
// 模型服务允许为空，此时读取视图停在非就绪，界面保留草稿展示但不放行提交。
// 解构入参时不要加默认值覆盖显式传来的空值，空值与缺省在本文件语义不同。
export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** 会话切换恢复文字/模型，权限和 Plan 使用当前快照。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  // [契约] 工作区身份键必须优先取身份标识，缺失时才退回路径，这是全局统一的隔离口径。
  // 只用路径会让远程与本地同路径的工作区共享草稿与目录，属于数据串号。
  // 展示提供方只在调用方未指定时回退到默认 Agent，不参与模型选择。
  // 这两个值都参与目录水合的依赖，改动会让同一工作区被判成不同目标。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  // [契约] 新任务的草稿命名空间是固定的根作用域，已有会话则用会话标识作为作用域。
  // 根作用域在首发后才会被迁移，因此创建会话之前所有输入都应落在根草稿上。
  // 作用域标识同时用于读取、写入、迁移与清理，四处必须使用同一个值。
  // 不要把会话标识为空理解成没有作用域，根作用域本身就是一个有效作用域。
  // 命名空间还依赖客户端命名空间，多窗口或嵌入场景下不能退化成固定字符串。
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const clientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const rootScope = useMemo(
    () => resolveComposerScope(draftProjectId, workspaceIdentity, clientNamespace),
    [draftProjectId, workspaceIdentity, clientNamespace],
  );
  const draftFocusVersion = useZCodeSessionStore((state) =>
    sessionId === null ? (state.workspaces[workspaceKey]?.draftFocusVersion ?? 0) : 0,
  );
  // New Task 可以复用同一个 pane；无文字时必须重新取 Recent，不能只清磁盘留旧内存。
  // [契约] 作用域键由工作区、会话、焦点版本与根命名空间序列化而成，是草稿切换的唯一依据。
  // 焦点版本用于新建任务复用同一个面板时强制重新读取最近记录，不能省略。
  // 根命名空间只在新建任务时参与，已有会话用空值占位，避免两套键互相污染。
  // 数组顺序固定，调整顺序会让所有存量键失效并触发一次全量重读。
  // 该键同时用于渲染期比较与持久化守卫，拼接方式变化要同步清理旧草稿。
  const scopeKey = JSON.stringify([
    workspaceKey,
    scopeId,
    draftFocusVersion,
    sessionId === null ? composerScopeKey(rootScope) : null,
  ]);
  const navigationInitialization = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace?.activeTaskId === sessionId &&
      workspace?.composerInitialization?.taskId === sessionId
      ? workspace.composerInitialization
      : undefined;
  });
  // [事务] 读取磁盘草稿并补上导航初始化配置，得到当前作用域的新初始状态。
  // 没有存量草稿时才用导航配置兜底，它来自上一次菜单操作留下的意图，不能覆盖已写内容。
  // 初始化标记按新任务、会话、以及带导航初始化的新任务三种情况判定。
  // 依赖只有作用域键，这是有意的：读取磁盘昂贵，不能随每次渲染重复。
  // 这里不写状态，返回值只作为后续状态收敛的候选。
  const loadedScope = useMemo<ComposerState>(() => {
    const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, rootScope);
    return {
      scopeKey,
      workspaceKey,
      draft: saved ?? { text: "", updatedAt: 0, ...navigationInitialization?.config },
      initialization:
        sessionId === null || (!saved && navigationInitialization) ? "new-task" : "session",
    };
  }, [scopeKey]);
  const [storedState, setStoredState] = useState(loadedScope);
  // 首发是同一 pane 的地址迁移，保持其间的新编辑；换页或卸载不保留第二份配置。
  // [事务] 渲染期先做三态收敛：同键直接用存储状态，晋升会话沿用内存，其余重新加载。
  // 晋升分支要求工作区相同且晋升会话与当前会话一致，两个条件缺一都会把草稿迁错。
  // 沿用内存时清空观察配置与晋升标记，让后续快照重新作为首份快照处理。
  // 这里在渲染阶段计算但不直接写状态，避免渲染期副作用；写回放在后面的比较里。
  // 状态对象的引用相等是未变化的唯一信号，构造新对象等于声明发生了变化。
  let currentState: ComposerState =
    storedState.scopeKey === scopeKey
      ? storedState
      : storedState.workspaceKey === workspaceKey && storedState.promotedSessionId === sessionId
        ? {
            ...storedState,
            scopeKey,
            initialization: "promotion",
            observedConfig: undefined,
            promotedSessionId: undefined,
          }
        : loadedScope;
  let draft = currentState.draft;
  // [契约] 模型服务读取以 waitForRemote 启动，入参只带 draft 里的选择。
  // 读取可能停在加载或错误，此时视图为空，依赖视图的初始化都必须跳过。
  // 不要把读取状态提升为草稿状态，服务事实与用户意图分属两层。
  // 该读取的引用会进入菜单处理器的依赖，引用变化才允许重新绑定选择。
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // [契约] 新任务草稿没有模式时才做一次初始化，已有模式的草稿不再覆盖。
  // 初始化会补齐权限、计划与默认模型，依赖目标宿主的选择视图与工作区作用域。
  // 条件里包含视图非空，读取未就绪时保持原样，等下一次渲染再尝试。
  // 这一步只改 draft 局部，持久化由后续 useEffect 统一完成。
  // 把条件放宽成只要没有模式，会让缺少视图的场景反复进入并覆盖已有字段。
  if (currentState.initialization === "new-task" && !draft.mode && modelSelectionView) {
    draft = initializeNewTaskDraft(
      draft,
      workspacePath,
      workspaceIdentity,
      modelSelectionView,
      rootScope,
    );
  }
  // 空配置先初始化了权限，旧逻辑便因已有 mode 永久跳过模型初始化。
  // 仅为无模型原意图的 Root 草稿补齐首次可用选择；不重置正文、权限或 Plan，
  // 也不替换失效的旧选择、已有 Session 或分享导入的配置。
  // [契约] 只为新建任务且没有模型选择的根草稿补齐一次首选模型。
  // 条件是会话为空、草稿无选择、视图可用三者同时成立，缺一不可。
  // 补齐不重置正文、权限与计划，也不替换用户已选但暂时失效的选择。
  // 历史缺陷是权限先被初始化后，旧逻辑因已有模式而永久跳过模型初始化。
  // 这里只在内存里补，不直接落盘，避免把一次兜底写成用户意图。
  if (sessionId === null && !draft.modelSelection && modelSelectionView) {
    const selection = resolveDraftInitialModelSelection(modelSelectionView, null).selection;
    if (selection) draft = { ...draft, modelSelection: selection };
  }
  // [事务] 已有会话的配置观察分两步：首份快照恢复事实，后续快照只响应新增关联。
  // 首份快照恢复模式与计划，但模型选择只在草稿尚无模式时采用，避免覆盖本次改动。
  // 权限与计划分别以交互标识与工具调用标识作为新关联的判据，不能靠时间比较。
  // 只处理本次打开后出现的关联，历史记录里的旧授权不能被当成新指令重放。
  // 观察配置最后要写回状态，否则同一份快照会被重复当作首次处理。
  if (sessionId && sessionConfig) {
    const previous = currentState.observedConfig;
    const observedConfig = {
      permissionGrantId: sessionConfig.permissionGrant?.interactionId,
      planTransitionId: sessionConfig.planTransition?.toolCallId,
    };
    const firstSnapshot = !previous;
    const mode = submissionModeSchema.safeParse(sessionConfig.mode);
    const currentMode = mode.success && mode.data !== "plan" ? mode.data : "build";
    const currentPlan = resolveExecutionState(sessionConfig).planEnabled;
    if (firstSnapshot && currentState.initialization === "session") {
      // 历史授权曾被当成新指令重放，覆盖最新确认模式。恢复直接采用当前事实，文字只恢复模型。
      draft = {
        ...draft,
        mode: currentMode,
        planEnabled: currentPlan,
        modelSelection: draft.mode ? draft.modelSelection : sessionConfig.modelSelection,
      };
    } else if (previous) {
      // 只处理本次打开后出现的新关联；使用最新快照值，不能从历史事件推导固定 yolo/Plan。
      const permissionChanged =
        observedConfig.permissionGrantId &&
        observedConfig.permissionGrantId !== previous.permissionGrantId;
      const planChanged =
        observedConfig.planTransitionId &&
        observedConfig.planTransitionId !== previous.planTransitionId;
      if (permissionChanged || planChanged)
        draft = {
          ...draft,
          ...(permissionChanged ? { mode: currentMode } : {}),
          ...(planChanged ? { planEnabled: currentPlan } : {}),
        };
    }
    if (
      firstSnapshot ||
      observedConfig.permissionGrantId !== previous.permissionGrantId ||
      observedConfig.planTransitionId !== previous.planTransitionId
    ) {
      currentState = { ...currentState, observedConfig };
    }
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  // [并发] 状态引用是事件回调读取最新草稿的唯一通道，必须在每次渲染后同步。
  // 回调读 draftRef.current 而非闭包 draft，后者是上一次渲染的旧值。
  // 写入引用不触发渲染，因此可以放心在事件与持久化路径中使用。
  // 引用更新放在渲染阶段末尾，保证同一次渲染内所有回调看到同一份状态。
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：按 revision 清草稿会把短暂不可用永久写成空选择。这里只派生当前结果，
  // 正文/模式自动保存继续保存 draft 中的原意图；读取未就绪时保留展示，提交由 View 门禁阻断。
  const effectiveSelection = modelSelectionView
    ? (modelSelectionView.effectiveSelection ?? undefined)
    : draft.modelSelection;
  // [契约] 草稿配置是提交与预热共同消费的投影：模式、计划、模型、提供方与档位同源。
  // 已有会话在尚未观察到配置时把模式置空，表示模式应沿用服务端事实而不是草稿。
  // 计划缺省为关闭，模型与提供方都从展示选择推导，三者必须来自同一个选择对象。
  // 依赖包含初始化标记与观察配置，因为这两者决定模式是否输出。
  // 不要在这里补默认模型，兜底属于初始化路径，投影只表达当前意图。
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode:
        currentState.initialization === "session" && !currentState.observedConfig
          ? undefined
          : draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [
      draft.mode,
      draft.planEnabled,
      effectiveSelection,
      currentState.initialization,
      currentState.observedConfig,
    ],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  // [事务] 持久化必须使用当前作用域，但首发已绑定而界面尚未切换时写入目标会话。
  // 根草稿写入时要把工作区的项目与任务组补进去，仅当存储中已有值时才覆盖原值。
  // 依赖包含工作区、身份、作用域与根命名空间，缺一项都会把草稿写到错的命名空间。
  // 这里刻意不读取草稿状态，而由调用方传入值，避免写入与最新编辑不一致。
  // 持久化失败不抛错也不回滚内存，草稿仍以内存为准，下次编辑会再次尝试。
  const persistDraft = useCallback(
    (value: V4ComposerDraft) => {
      const workspace = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      return persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        // 首发已绑定但 React 尚未切换地址时，新输入也属于已创建的会话。
        stateRef.current.promotedSessionId ?? scopeId,
        scopeId === V4_DRAFT_SCOPE_ROOT
          ? {
              ...value,
              projectId:
                workspace.draftProjectId !== undefined ? workspace.draftProjectId : value.projectId,
              taskGroupId:
                workspace.draftTaskGroupId !== undefined
                  ? workspace.draftTaskGroupId
                  : value.taskGroupId,
            }
          : value,
        rootScope,
      );
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope],
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (navigationInitialization)
      useZCodeSessionStore
        .getState()
        .consumeComposerInitialization(workspacePath, navigationInitialization, workspaceIdentity);
  }, [scopeKey, navigationInitialization, workspacePath, workspaceIdentity]);
  // [并发] 作用域校验要同时满足挂载、作用域键相等，以及新建任务时的焦点版本一致。
  // 会话非空时不再比较焦点版本，因为已有会话不参与新建任务的面板复用。
  // 焦点版本从 store 实时读取而不是闭包，保证菜单与延迟回调能感知最新切换。
  // 依赖必须包含作用域键、会话、路径、身份与焦点版本，删除任一都会放行过期回调。
  // 该校验是写入前的最后一道闸，任何新的持久化路径都要复用它。
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      (sessionId !== null ||
        (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion ?? 0) === draftFocusVersion),
    [scopeKey, sessionId, workspacePath, workspaceIdentity, draftFocusVersion],
  );
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      draft.mode &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistDraft(draft);
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey, persistDraft]);
  // [事务] 更新草稿是一次原子写：校验作用域、更新内存、同步配置投影、写盘、记录已持久化值。
  // 模型选择未变化时沿用配置引用，避免无意义的对象新建引发下游重渲染。
  // 配置投影在这里同步构造，是为了让提交路径立刻读到新值，而不必等下一次渲染。
  // 步骤顺序不能调换，先写盘后改内存会让失败时内存与磁盘不一致。
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      const previous = stateRef.current.draft;
      const next = update(previous);
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistDraft(next);
      lastPersistedDraftRef.current = next;
    },
    [isCurrentScope, persistDraft],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // 导入等待目录期间的显式选择也是有效选择，不能再被默认初始化覆盖。
        ...(current.mode ? {} : { mode: mode.success ? mode.data : "build" }),
      }));
    },
    [updateComposerDraft],
  );
  // [契约] 捕获时记录原选择与当前有效选择，任一不匹配就返回空操作。
  // 比较只取提供方、模型与思考档位，对象键顺序不构成选择身份。
  // 写回回调先校验 scope，再比对 draft 选择是否仍是捕获值。
  // 旧回执若覆盖期间的新意图，界面会在用户改选后突然跳回。
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      updateComposerDraft(() => ({ ...replacement, updatedAt: Date.now() }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (!isCurrentScope() || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // 首发 Snapshot 可能迟到：空正文只在内存交接配置，有新文字则先写目标再删来源。
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      if (!written) return;
      const next = { ...stateRef.current, promotedSessionId: targetSessionId };
      stateRef.current = next;
      setStoredState(next);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
    },
    [scopeId, isCurrentScope, workspaceIdentity, workspacePath, rootScope],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  // [资源] 目录水合效应按工作区键单飞，并在注册表未就绪时只置空闲而不发请求。
  // 已经满足条件的目录直接跳过，只有缺少模式或斜杠命令时才重新拉取。
  // 发起前写入加载状态，成功写配置与命令，失败写错误，三条路径都要落定。
  // 依赖包含启动允许、展示提供方、会话、工作区与身份，缺一项都会用旧目标水合。
  // 效应内只读一次 store 快照，异步回调里重新取最新 store 再写入。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  // [契约] 菜单选择先拼出完整模型标识再解析，带提供方前缀与不带前缀的写法都要兼容。
  // 调档之后解析尚未返回时，允许使用同一宿主的保留目录补全选择，避免写成无档位。
  // 保留目录只用于补全选择，不能据此放行提交，提交仍受读取就绪门禁约束。
  // 选择写入统一走配置更新，由它负责校验模式并同步草稿。
  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string, reasoningLevel?: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 原因：调档后解析尚未返回时，菜单仍使用同 Host 的保留目录；只读 ready view
      // 会把随后主动选模写成无档位意图，永久显示“—”。目录仅用于选模，不放行提交。
      const catalog =
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
      const modelSelection = reasoningLevel
        ? { ...parsedSelection, options: { reasoningLevel } }
        : catalog
          ? (completeNewModelSelection(catalog, parsedSelection) ?? parsedSelection)
          : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [
      modelSelectionView,
      modelSelectionRead.state,
      updateDraftConfig,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  // [契约] 计划模式是开关语义：开启写 plan，关闭回退到 previousMode。
  // 普通模式必须经过协议校验后才写入，非法值直接忽略而不是落成默认。
  // 模式只写当前作用域，不写全局偏好，避免其他任务反向往回覆盖。
  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
        }));
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
        }));
    },
    [updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
