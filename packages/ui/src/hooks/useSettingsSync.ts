// useSettingsSync：设置迁移向导的 UI 状态机，负责发现、勾选、导入与首启提示消费。
//
// 职责（做什么）：调用 settingsSyncService 的 detect、importSelected 与 markFirstRunPromptHandled，
// 把发现结果规范化为固定类别集合，维护选中键、任务进度与导入结果，并对外暴露关闭、重开与勾选动作。
// 职责（不做什么）：不直接读写文件系统，不决定迁移策略，不渲染视图，也不缓存服务端事实。
// 职责（依赖谁）：依赖 useServices 注入的 settingsSyncService、useZCodeSessionService 用于技能变更后
// 的草稿失效，以及 shared 包里的发现与导入结果类型；调用方是 onboarding 弹窗与设置页的迁移入口。
// 边界：workspacePath 缺失时整套流程保持空态；服务抛错只落成 error 文案，不阻断宿主页面。
//
// 状态所有权：discovery、selectedKeys、tasks、result、error 全部由本 hook 独占，组件只读 state 与 actions，
// 不允许在组件内再派生一份选中集合，否则两处勾选状态会互相覆盖。
// 首启提示的消费语义：只有关闭弹窗、空发现或成功进入才写 handled，检测失败的路径不写，
// 保证下次启动仍会重试，而不是永久静默。
//
// 导入流程的并发语义：runningImportRef 是唯一的运行标识，关闭弹窗即自增作废在途导入；
// 任务逐条推进只是展示节奏，真实结果以 importSelected 返回的 promise 为准。
// 技能类导入完成后必须触发草稿会话失效，否则旧草稿会引用已经迁移走的技能路径。
//
// 阅读顺序：先看 createInitialState 与 normalizeDiscovery，再看 loadDiscovery 与首启 effect，
// 最后看 startImportWithAdditionalSelections 的入库与失效链路。
//
// 以下不变量在改造时必须逐条自检，任一破坏都会造成重复弹窗、丢选中或导入状态错乱。
// INV-01 workspacePath 缺失必须早退：不得调用任何服务方法 —— 守住它的位置：loadDiscovery 与 startImportWithAdditionalSelections 的开头 —— 改错故障：空路径请求打到服务端，返回无效结果并污染状态。
// INV-02 关闭必须抢占在途导入：close 先自增 runningImportRef —— 守住它的位置：close 的第一行 —— 改错故障：关窗后旧导入继续回写 tasks，弹窗数据鬼影重现。
// INV-03 首启提示只在关闭或空发现时写 handled —— 守住它的位置：close 与 loadDiscovery 的首启空发现分支 —— 改错故障：用户没看过提示却再也不会被提醒。
// INV-04 检测失败不得写 handled —— 守住它的位置：loadDiscovery 的 catch —— 改错故障：一次网络抖动就让首启提示永久消失。
// INV-05 手动重开遇空发现必须保持 open —— 守住它的位置：intent 为 manual 的分支 —— 改错故障：设置页点引导后弹窗一闪即关。
// INV-06 首启空发现必须写 handled 并回到初始态 —— 守住它的位置：intent 非 manual 的空发现分支 —— 改错故障：每次进入 workspace 都重复检测并弹空窗。
// INV-07 cancelled 闸门不能省：异步续点前必须检查 —— 守住它的位置：首启 effect 的 IIFE 内各处判断 —— 改错故障：快速切换 workspace 时旧结果覆盖新状态。
// INV-08 effect 依赖不能删：loadDiscovery、workspacePath、settingsSyncService 缺一不可 —— 守住它的位置：首启 effect 的依赖数组 —— 改错故障：切换工作区后仍用旧的检测回调。
// INV-09 导入前必须有选中项：selections 为空直接返回 —— 守住它的位置：startImportWithAdditionalSelections 的中段判断 —— 改错故障：弹出进度条却没有任何任务可跑。
// INV-10 隐藏步骤不得暗中导入：includeCurrentSelections 为 false 时不能合并当前选中 —— 守住它的位置：stateSelections 的构造 —— 改错故障：数据迁移向导绕过了用户隐藏的 providers 勾选。
// INV-11 任务 id 必须含作用域与下标 —— 守住它的位置：buildTasksFromSelections 的 id 拼接 —— 改错故障：同类别多条 selection 的任务状态互相覆盖。
// INV-12 结果回写必须按队列匹配：不能按 id 直接对齐 —— 守住它的位置：applyTaskResults 的分组与 shift —— 改错故障：多条同类结果错配到错误任务。
// INV-13 技能导入后必须触发草稿失效 —— 守住它的位置：导入成功分支中对 skills 类别的判断 —— 改错故障：旧草稿继续引用已迁移技能，保存时报路径不存在。
// INV-14 进度是派生值：不得写进 state —— 守住它的位置：taskProgress 的 useMemo —— 改错故障：任务更新与进度写入互相触发，形成渲染循环。
// INV-15 发现结果只保留 providers 类别 —— 守住它的位置：normalizeDiscovery —— 改错故障：已下线的技能与插件类别重新出现在迁移列表。
// INV-16 默认勾选要求发现数大于零 —— 守住它的位置：buildDefaultSelectedKeys 的过滤条件 —— 改错故障：默认生成一批空任务，导入后全部跳过。
// INV-17 错误必须落到 state.error 且记录日志 —— 守住它的位置：loadDiscovery 与导入链路的 catch —— 改错故障：失败无提示，用户反复点击却毫无反馈。
// INV-18 失败也要进入 complete 步骤 —— 守住它的位置：导入 catch 中的 step 赋值 —— 改错故障：弹窗卡在 importing，关闭按钮失去意义。
/* eslint-disable max-lines -- 设置同步流程聚合了发现、选择与导入状态机，集中维护更利于问题定位 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import type { SettingsSyncUiState, SettingsSyncUiTask } from "@/settings-sync/types.js";

const IMPORTING_TASK_DELAY_MS = 320;
const FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH = false;

/** 首启自动检测与设置页手动重开对“空 discovery”的处理不同。 */
type LoadDiscoveryIntent = "firstRun" | "manual";

// [契约] 初始态固定为关闭、非加载、非导入、selection 步骤，其余字段全部清空
// open 为 false 表示不打扰用户，只有检测到可迁移内容或手动重开才会变 true
// discovery 与 result 用 null 而不是空对象，消费方据此区分尚未检测与检测结果为空
// 该函数在 workspacePath 缺失与首启提示已处理两条路径上都会被复用
// 新增字段必须同时给出默认值，否则切换 workspace 时会残留上一次的数据
function createInitialState(): SettingsSyncUiState {
  return {
    open: false,
    loading: false,
    importing: false,
    step: "selection",
    discovery: null,
    selectedKeys: [],
    tasks: [],
    result: null,
    error: null,
  };
}

function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

/**
 * 首启 Onboarding 代理设置：仅模型供应商（providers），不展示、不迁移技能与插件。
 */
function visibleCategoriesForOnboarding(): SettingsSyncCategory[] {
  return ["providers"];
}

// [契约] 发现结果一律裁剪为仅 providers 类别，技能与插件不再进入 onboarding
// 缺失的类别补零计数并标记为未默认选中，保证 UI 渲染时类别集合稳定
// 已有的类别对象原样透传，不做字段级改写
// agents 为空时不做兜底补位，空数组语义交由 loadDiscovery 决定如何处理
// 这里不修改入参，返回一棵新的对象树
function normalizeDiscovery(discovery: SettingsSyncDiscoveryResult): SettingsSyncDiscoveryResult {
  return {
    agents: discovery.agents.map((agent) => {
      const categoryMap = new Map(
        agent.categories.map((category) => [category.category, category]),
      );
      const categories = visibleCategoriesForOnboarding().map((category) => {
        const existing = categoryMap.get(category);
        if (existing) {
          return existing;
        }
        return {
          category,
          discoveredCount: 0,
          importableCount: 0,
          selectedByDefault: false,
        };
      });
      return {
        ...agent,
        categories,
      };
    }),
  };
}

// [契约] 默认勾选只认 selectedByDefault 且 discoveredCount 大于零的类别
// 键格式必须与 getSelectionKey 一致，否则后续 buildTasks 会匹配不到
// 发现数量为零的类别即使标记默认选中也不勾选，避免导入空任务
// 返回顺序跟随 discovery 的原始顺序，保证首屏勾选状态稳定
// 该函数是纯函数，不读取任何外部状态
function buildDefaultSelectedKeys(discovery: SettingsSyncDiscoveryResult): string[] {
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => category.selectedByDefault && category.discoveredCount > 0)
      .map((category) => getSelectionKey(agent.agent, category.category)),
  );
}

// [契约] 任务 id 复用冒号分隔的选中键，与勾选来源同源，便于进度回写
// 只有被选中的类别才生成任务，未选中的类别不产生占位任务
// status 初始为 pending，running 由导入循环逐条推进
// discoveredCount 直接取类别计数，用于展示每条任务的规模
// 任务顺序跟随 agent 与类别的遍历顺序，UI 侧不再重排
function buildTasks(
  discovery: SettingsSyncDiscoveryResult,
  selectedKeys: string[],
): SettingsSyncUiTask[] {
  const selected = new Set(selectedKeys);
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => selected.has(getSelectionKey(agent.agent, category.category)))
      .map((category) => ({
        id: getSelectionKey(agent.agent, category.category),
        agent: agent.agent,
        category: category.category,
        discoveredCount: category.discoveredCount,
        status: "pending" as const,
      })),
  );
}

// [契约] 选中键按第一个冒号切分，agent 与 category 各取一段
// 键格式由 getSelectionKey 保证，这里不再校验字面量合法性
// 返回的 selection 不带作用域字段，表示走服务端默认作用域
// 切分结果使用类型断言，因为键的来源可信，不要在此加运行期分支
// 空数组输入返回空数组，不做兜底补位
function buildStateSelections(selectedKeys: string[]): SettingsSyncSelection[] {
  return selectedKeys.map((key) => {
    const [agent, category] = key.split(":");
    return {
      agent: agent as SettingsSyncSelection["agent"],
      category: category as SettingsSyncSelection["category"],
    };
  });
}

// [契约] 外部 selection 可能带作用域，任务 id 必须把作用域拼进去以区分同类别多条
// discoveredCount 依次回退到技能、命令、插件、MCP 路径数量，最后兜底为 1
// 下标参与 id，保证同一 selection 重复出现时仍能各自推进
// status 同样从 pending 起步，与 buildTasks 产出同构
// 该函数与 buildTasks 的差异只在来源，消费方无需区分
function buildTasksFromSelections(selections: SettingsSyncSelection[]): SettingsSyncUiTask[] {
  return selections.map((selection, index) => ({
    id: `${selection.agent}:${selection.category}:${selection.sourceScope ?? "all"}:${selection.targetScope ?? "auto"}:${index}`,
    agent: selection.agent,
    category: selection.category,
    discoveredCount:
      selection.skillPaths?.length ??
      selection.commandPaths?.length ??
      selection.pluginPaths?.length ??
      selection.mcpServerPaths?.length ??
      1,
    status: "pending" as const,
  }));
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// [契约] 结果按 agent 加 category 分组排队，避免同类别的多条结果互相覆盖
// 每条任务按顺序从队列里取一条结果，取不到就标记为 skipped
// 不能按 id 直接匹配，因为导入结果不携带 UI 侧生成的序号
// 该函数返回新数组，不修改入参中的任务对象
// 结果数量少于任务数量时，剩余任务一律视为跳过
function applyTaskResults(
  tasks: SettingsSyncUiTask[],
  result: SettingsSyncImportResult,
): SettingsSyncUiTask[] {
  const taskResultQueues = new Map<string, SettingsSyncImportResult["taskResults"]>();
  for (const task of result.taskResults) {
    const key = `${task.agent}:${task.category}`;
    taskResultQueues.set(key, [...(taskResultQueues.get(key) ?? []), task]);
  }
  return tasks.map((task) => {
    const matched = taskResultQueues.get(`${task.agent}:${task.category}`)?.shift();
    return matched ? { ...task, status: matched.status } : { ...task, status: "skipped" };
  });
}

// [契约] workspacePath 缺失时所有动作都直接返回，不发起任何服务调用
// runningImportRef 是运行标识，关闭弹窗时自增即可作废在途导入
// zcodeSessionService 目前未被直接读取，保留是为了技能变更后的会话联动
// hook 不接收渲染参数，状态全部自持，不向外泄漏可变引用
// 返回结构固定为 state、selectedCount、taskProgress 与 actions
export function useSettingsSync(params: { workspacePath?: string; workspaceIdentity?: string }) {
  const { settingsSyncService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    params.workspacePath,
    undefined,
    params.workspaceIdentity,
  );
  const runningImportRef = useRef(0);
  const [state, setState] = useState<SettingsSyncUiState>(createInitialState);

  // [事务] 检测前先把 loading 置 true 并清空旧错误，避免上次失败文案残留
  // 检测结果先经过 normalizeDiscovery，再判断是否为空
  // 成功路径统一写入 open、step、discovery 与默认选中键
  // 失败路径同样打开弹窗并写入错误，让用户可以重试
  // 依赖数组包含 workspacePath、workspaceIdentity 与 service，删任一项都会读到旧值
  const loadDiscovery = useCallback(
    async (intent: LoadDiscoveryIntent = "firstRun") => {
      if (!params.workspacePath) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: true,
        error: null,
      }));

      try {
        const rawDiscovery = await settingsSyncService.detect({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
        const discovery = normalizeDiscovery(rawDiscovery);
        if (discovery.agents.length === 0) {
          // [失败路径] 手动重开遇到空发现时必须保持 open 为 true，否则弹窗一闪即关
          // 该分支不写首启已处理标记，因为用户仍可能走会话迁移等流程
          // 首启路径的空发现才写 handled 并回到初始态
          // 两种意图的分支必须显式返回，不能落到下方共享的成功路径
          // 日志要区分 manual 与 handled 两种结果，便于排查重复弹窗
          if (intent === "manual") {
            // 设置页点「引导」会 reopen 并补跑 detect；空结果沿用首启逻辑会把 open 重置为 false，
            // 用户会看到弹窗一闪即关。手动打开应保留欢迎页，让用户仍可走会话迁移等流程。
            setState((current) => ({
              ...current,
              open: true,
              loading: false,
              step: "selection",
              discovery,
              selectedKeys: [],
              tasks: [],
              result: null,
              error: null,
            }));
            logger.info("[settings-sync] discovery empty, keep onboarding open (manual)", {
              workspacePath: params.workspacePath,
            });
            return;
          }
          // 去掉三方 agent 迁移后，首启检测会返回空结果。
          // 空结果不应打开一个没有可操作项的 onboarding 弹窗，应直接标记为已处理。
          await settingsSyncService.markFirstRunPromptHandled();
          setState(createInitialState());
          logger.info("[settings-sync] discovery empty, prompt handled", {
            workspacePath: params.workspacePath,
          });
          return;
        }
        const selectedKeys = buildDefaultSelectedKeys(discovery);
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          step: "selection",
          discovery,
          selectedKeys,
          tasks: [],
          result: null,
          error: null,
        }));
        logger.info("[settings-sync] discovery loaded", {
          workspacePath: params.workspacePath,
          agentCount: discovery.agents.length,
          selectedCount: selectedKeys.length,
        });
      } catch (error) {
        const message = normalizeError(error);
        logger.error("[settings-sync] discovery failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    },
    [params.workspaceIdentity, params.workspacePath, settingsSyncService],
  );

  // [资源] 本 effect 的清理只置 cancelled，防止卸载后继续写状态
  // workspacePath 缺失时直接重置为初始态并返回，不注册任何异步
  // 依赖数组包含 loadDiscovery、workspacePath 与 settingsSyncService
  // effect 内不要直接 await，异步立即执行函数用 void 接续
  // FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH 只是调试开关，生产路径必须走 handled 检查
  useEffect(() => {
    if (!params.workspacePath) {
      setState(createInitialState());
      return;
    }

    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      void loadDiscovery();
      return;
    }

    // [并发] cancelled 是丢弃过期回包的唯一闸门，每次异步续点前都要检查
    // 读取 handled 之后、检测之后、同步错误之前都要重新检查一次
    // 只在清理函数里置 true，不要在正常路径提前置位
    // 该标志不参与渲染，不需要改写为 state
    // 删掉它会让快速切换 workspace 时旧结果覆盖新状态
    let cancelled = false;

    void (async () => {
      try {
        // onboarding 弹窗是“首启提示”，不是普通刷新提示。
        // 之前调试阶段直接每次进入 workspace 都弹，用户一旦跳过仍会被重复打断。
        // 这里先读取 handled 状态，只在第一次尚未消费时才继续做检测和展示。
        const promptState = await settingsSyncService.getFirstRunPromptState();
        if (cancelled) {
          return;
        }

        if (promptState.handled) {
          setState(createInitialState());
          return;
        }

        await loadDiscovery();
      } catch (error) {
        const message = normalizeError(error);
        logger.error("[settings-sync] first run prompt state failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadDiscovery, params.workspacePath, settingsSyncService]);

  const selectedCount = state.selectedKeys.length;
  // [契约] 进度按已完成任务数除以总数取整，pending 与 running 都算未完成
  // 没有任务时返回 0，而不是 NaN 或 100
  // 依赖只包含 state.tasks，任务数组每次更新都会产生新引用
  // 不要把进度写进 state，它是纯派生值
  // 取整使用四舍五入，与文案里的百分比展示保持一致
  const taskProgress = useMemo(() => {
    if (state.tasks.length === 0) return 0;
    const completedCount = state.tasks.filter(
      (task) => task.status !== "pending" && task.status !== "running",
    ).length;
    return Math.round((completedCount / state.tasks.length) * 100);
  }, [state.tasks]);

  // [事务] 关闭先自增运行标识，让在途导入的后续写入全部失效
  // 随后立刻置 open 为 false 并清掉 importing，避免残留进度条
  // 关闭即视为消费首启提示，需要异步写 handled，失败只记日志不阻断
  // 调试开关打开时跳过写库，避免测试环境污染首启状态
  // 依赖必须包含 workspacePath 与 settingsSyncService
  const close = useCallback(() => {
    runningImportRef.current += 1;
    setState((current) => ({ ...current, open: false, importing: false }));
    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      return;
    }
    // “关闭 onboarding”本身就表示用户已经处理过这次首启提示，
    // 无论是直接开始还是跳过迁移，都应该立刻落库，避免下次启动再次重复弹出。
    void settingsSyncService.markFirstRunPromptHandled().catch((error) => {
      logger.error("[settings-sync] mark first run prompt handled failed", {
        workspacePath: params.workspacePath,
        error: normalizeError(error),
      });
    });
  }, [params.workspacePath, settingsSyncService]);

  // [并发] 缺少 discovery 且不在加载中时才补跑检测，避免与进行中的请求重复
  // 补跑在状态更新函数内触发，属于渲染期副作用，依赖调用方保证幂等
  // 只把 open 置 true 不够，否则用户会看到没有数据的空弹窗
  // 依赖包含 loadDiscovery 与 workspacePath
  // 重复点击重开会产生多次检测，由服务层与 loading 标志共同收敛
  const reopen = useCallback(() => {
    setState((current) => {
      if (!current.discovery && !current.loading && params.workspacePath) {
        // 设置页里的“重新打开 onboarding”可能发生在首启提示已处理之后。
        // 这时本地状态已经回到初始态；如果只把 open 设成 true，用户会看到一个没有 discovery 数据的空弹窗。
        // 这里在缺少数据时主动补一次检测，保证从设置页进入仍然能拿到完整可迁移内容。
        void loadDiscovery("manual");
      }
      return { ...current, open: true };
    });
  }, [loadDiscovery, params.workspacePath]);

  // [契约] 单键勾选以集合为中间结构，切换后整体写回 selectedKeys
  // 使用函数式更新读取最新选中集，避免闭包拿到旧数组
  // 依赖数组为空是刻意的，回调只依赖入参与更新函数
  // 不要在切换时联动其他键，跨类别联动由另外两个动作负责
  // 返回的键顺序取决于集合迭代顺序，UI 不应依赖其顺序
  const toggleSelection = useCallback((key: string) => {
    setState((current) => {
      const set = new Set(current.selectedKeys);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...current,
        selectedKeys: [...set],
      };
    });
  }, []);

  const setAgentSelection = useCallback((agent: string, checked: boolean) => {
    setState((current) => {
      if (!current.discovery) {
        return current;
      }
      const next = new Set(current.selectedKeys);
      const targetAgent = current.discovery.agents.find((item) => item.agent === agent);
      if (!targetAgent) {
        return current;
      }
      for (const category of targetAgent.categories) {
        const key = getSelectionKey(agent, category.category);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return {
        ...current,
        selectedKeys: [...next],
      };
    });
  }, []);

  const setCategorySelectionAllAgents = useCallback(
    (category: SettingsSyncCategory, checked: boolean) => {
      setState((current) => {
        if (!current.discovery) {
          return current;
        }
        const next = new Set(current.selectedKeys);
        for (const agentSummary of current.discovery.agents) {
          if (!agentSummary.categories.some((c) => c.category === category)) {
            continue;
          }
          const key = getSelectionKey(agentSummary.agent, category);
          if (checked) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return {
          ...current,
          selectedKeys: [...next],
        };
      });
    },
    [],
  );

  // [事务] 选中项为空时直接返回，不产生空导入与空进度
  // 是否合并当前选中由 includeCurrentSelections 控制，隐藏步骤时不得暗中导入 providers
  // 任务列表在请求发出前就构造好，用于播放逐条推进的进度
  // 依赖数组包含 state.discovery 与 state.selectedKeys，删任一项都会导入旧选择
  // 该回调同时服务引导页与设置页，额外 selection 由调用方注入
  const startImportWithAdditionalSelections = useCallback(
    async (
      additionalSelections: SettingsSyncSelection[] = [],
      options: { includeCurrentSelections?: boolean } = {},
    ) => {
      if (!params.workspacePath) {
        return;
      }

      const includeCurrentSelections = options.includeCurrentSelections ?? true;
      // 数据迁移向导可临时隐藏代理设置步骤；隐藏时不能把默认选中的 providers 暗中导入。
      const stateSelections =
        includeCurrentSelections && state.discovery ? buildStateSelections(state.selectedKeys) : [];
      const selections: SettingsSyncSelection[] = [...stateSelections, ...additionalSelections];
      if (selections.length === 0) {
        return;
      }
      // [并发] 运行标识在导入开始时自增并写回，关闭弹窗时自增即可抢占
      // 所有异步续点都要比较当前标识，不相等就静默退出
      // 不能只用布尔标志，因为连续两次导入需要区分是哪一轮
      // 标识不参与渲染，保存在 ref 中
      // 导入循环与最终结果回写共用同一个标识，避免半途被新轮次接管
      const runId = runningImportRef.current + 1;
      runningImportRef.current = runId;
      const initialTasks =
        state.discovery && includeCurrentSelections
          ? [
              ...buildTasks(state.discovery, state.selectedKeys),
              ...buildTasksFromSelections(additionalSelections),
            ]
          : buildTasksFromSelections(selections);

      setState((current) => ({
        ...current,
        importing: true,
        step: "importing",
        tasks: initialTasks,
        result: null,
        error: null,
      }));

      logger.info("[settings-sync] import started", {
        workspacePath: params.workspacePath,
        selections,
      });

      const importPromise = settingsSyncService.importSelected({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        selections,
      });

      // [资源] 逐条推进只是观感节奏，每个任务置 running 后等待固定延迟
      // 每轮开始前检查运行标识，被抢占就立即返回，不再继续播放
      // 延迟使用常量而非随机值，保证同一环境下节奏可复现
      // 最终结果以 importSelected 返回的 promise 为准，不信任动画进度
      // 任务缺失时跳过而不抛错，防止动画循环被脏数据打断
      for (let index = 0; index < initialTasks.length; index += 1) {
        if (runningImportRef.current !== runId) {
          return;
        }
        const task = initialTasks[index];
        if (!task) {
          continue;
        }
        setState((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === task.id ? { ...item, status: "running" } : item,
          ),
        }));
        await new Promise((resolve) => setTimeout(resolve, IMPORTING_TASK_DELAY_MS));
      }

      try {
        const result = await importPromise;
        if (runningImportRef.current !== runId) {
          return;
        }

        if (selections.some((selection) => selection.category === "skills")) {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            reason: "settings-sync-skill-import",
          });
        }

        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          result,
          tasks: applyTaskResults(current.tasks, result),
        }));
        logger.info("[settings-sync] import completed", {
          workspacePath: params.workspacePath,
          result,
        });
      } catch (error) {
        const message = normalizeError(error);
        if (runningImportRef.current !== runId) {
          return;
        }
        logger.error("[settings-sync] import failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          error: message,
          tasks: current.tasks.map((task) => ({ ...task, status: "failed" })),
          result: {
            successCount: 0,
            skippedCount: 0,
            failedCount: current.tasks.length,
            taskResults: current.tasks.map((task) => ({
              agent: task.agent,
              category: task.category,
              status: "failed" as const,
              importedCount: 0,
              skippedCount: 0,
              failedCount: 1,
            })),
          },
        }));
      }
    },
    [
      params.workspaceIdentity,
      params.workspacePath,
      settingsSyncService,
      zcodeSessionService,
      state.discovery,
      state.selectedKeys,
    ],
  );

  const startImport = useCallback(async () => {
    await startImportWithAdditionalSelections();
  }, [startImportWithAdditionalSelections]);

  const finish = useCallback(() => {
    close();
  }, [close]);

  return {
    state,
    selectedCount,
    taskProgress,
    actions: {
      close,
      reopen,
      reloadDiscovery: loadDiscovery,
      toggleSelection,
      setAgentSelection,
      setCategorySelectionAllAgents,
      startImport,
      startImportWithAdditionalSelections,
      finish,
    },
  };
}
