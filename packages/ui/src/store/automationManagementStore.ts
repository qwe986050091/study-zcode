/* eslint-disable max-lines -- 定时任务管理 store 集中维护列表/运行历史/CRUD 与立即运行等操作，稳定后再拆分。 */
// automationManagementStore.ts —— 定时任务管理页的 Zustand store：列表、运行历史、增删改与立即运行。
// 做：按工作区初始化与刷新全量任务列表；创建、更新、删除、启停、重启、立即运行；
//     按任务缓存运行历史；统一维护加载态、错误消息与正在进行的写操作标记。
// 不做：不做 cron 解析、不负责调度、不直接连 RPC；服务实例一律由调用方注入。
// 依赖：共享的定时任务协议类型与限额常量；agent 服务的列表与写接口；统一日志器。
// 被调用：定时任务管理页面与会话内的创建入口；消费方通过选择器订阅所需字段。
// 边界：本 store 是服务端事实的投影，不持有第二份调度状态，也不在本地做排序与过滤。
//
// INV-01 断言：每次列表请求都必须先自增全局序号 —— 守住它的位置：三个方法里的 requestId 自增 —— 改错故障：并发刷新时旧响应覆盖新结果，列表回退。
// INV-02 断言：响应落库前必须同时比对序号与工作区 —— 守住它的位置：loadInto 的两个提前返回 —— 改错故障：切换工作区后仍写入旧项目数据。
// INV-03 断言：视图工作区为空时不得发起写请求 —— 守住它的位置：各写方法开头的判空 —— 改错故障：作用域缺失导致请求打到默认项目，改错任务。
// INV-04 断言：有缓存时后台刷新、无缓存才显示加载态 —— 守住它的位置：initialize 的 hasCache 分支 —— 改错故障：每次切换工作区列表闪白并丢滚动位置。
// INV-05 断言：无缓存时必须清空任务列表与运行历史 —— 守住它的位置：initialize 对两个字段的赋值 —— 改错故障：上一个工作区的历史挂在新列表上，内容错乱。
// INV-06 断言：操作标记是单值，同一时刻只允许一个写操作 —— 守住它的位置：operationId 的字段声明 —— 改错故障：改成集合后多个按钮同时禁用，语义不清。
// INV-07 断言：写操作必须在 finally 清空操作标记 —— 守住它的位置：五个写方法的 finally —— 改错故障：任一次失败后按钮永久禁用，只能刷新页面。
// INV-08 断言：创建前必须做限额快速拒绝 —— 守住它的位置：createAutomation 的长度比较 —— 改错故障：用户提交后才看到服务端报错，体验与错误码都变差。
// INV-09 断言：写请求的作用域取任务所属项目 —— 守住它的位置：resolveAutomationActionScope 的取值 —— 改错故障：跨项目列表里编辑任务会写到当前视图项目。
// INV-10 断言：回源列表使用视图项目而不是任务项目 —— 守住它的位置：写方法里 loadInto 的入参 —— 改错故障：编辑后列表按任务项目重新加载，跨项目视图直接少一批数据。
// INV-11 断言：启停成功必须就地更新状态字段 —— 守住它的位置：setEnabled 的本地映射 —— 改错故障：菜单文案停留在旧状态，用户以为点击没生效。
// INV-12 断言：立即运行必须用同步锁拦截重入 —— 守住它的位置：inFlightRunNowAutomationIds 的判断 —— 改错故障：连点两次触发两次运行，产生重复任务实例。
// INV-13 断言：同步锁必须在 finally 释放 —— 守住它的位置：runAutomationNow 的 finally —— 改错故障：请求异常后该任务永久无法再次立即运行。
// INV-14 断言：返回重复时不得刷新列表 —— 守住它的位置：duplicate 分支的提前返回 —— 改错故障：无意义的回源让列表闪烁并打断用户操作。
// INV-15 断言：非强制模式下已缓存的历史直接复用 —— 守住它的位置：loadRuns 的缓存短路 —— 改错故障：每次展开历史都重复请求，面板反复加载。
// INV-16 断言：历史加载必须先写入加载态 —— 守住它的位置：loadRuns 的 loading 赋值 —— 改错故障：首帧显示空列表，用户以为没有运行记录。
// INV-17 断言：历史响应落库前必须比对工作区 —— 守住它的位置：loadRuns 成功与失败分支的判断 —— 改错故障：切换项目后旧历史写入新缓存，串台。
// INV-18 断言：删除运行记录后必须强制刷新 —— 守住它的位置：deleteRun 传入的强制标记 —— 改错故障：缓存命中导致被删记录仍然显示。
// INV-19 断言：所有错误必须收敛成字符串 —— 守住它的位置：toMessage 与各捕获分支 —— 改错故障：把未知对象直接写进状态，界面渲染出对象字面量。
// INV-20 断言：所有失败写状态并记录日志，不向调用方抛出 —— 守住它的位置：各方法的 catch —— 改错故障：页面未捕获异常导致整块管理视图白屏。
//
// 阅读顺序：先看三个模块级设施（序号、锁、工作区比对），再看列表加载，最后看各写方法的事务边界。
// 常见误改：响应回来不比对序号、写操作 finally 忘记清标记、立即运行的锁不在 finally 释放。
// 与外部的关系：状态字段与方法签名被页面直接消费，改名属于跨文件破坏性变更。
// 测试关注点：并发刷新时后发者胜出、切换工作区后旧响应被丢弃、限额的快速拒绝。
// 性能边界：列表是全量拉取，数据量由服务端限额约束；运行历史按任务惰性加载。
// 错误边界：所有失败都写进错误字段并记录日志，不向调用方抛出异常。
// 一致性边界：写操作成功后统一回源列表，不做本地增量合并，避免排序分叉。
// 并发边界：列表序号解决刷新竞态，同步锁解决点击竞态，两者不能互相替代。
// 维护提示：新增写方法必须遵循取作用域、置标记、请求、回源、清标记的顺序。
// 安全边界：日志只记录任务标识与错误消息，不打印提示词等任务正文。
// 可测试性：服务通过参数注入，store 不持有单例引用，便于在测试中替换。
import { create } from "zustand";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  isAutomationCreateLimitError,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
  type ModelSelection,
} from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";

// 定时任务(automation)管理 store：走 zcode-agent RPC（列表 / 创建 / 编辑 / 启停 / 重跑 / 删除 + 运行历史）。
// 与 pluginManagementStore 同一范式：按 workspace 缓存，切换时后台刷新避免闪烁。

/** 单条 automation 的运行历史缓存（按 automationId 记 loading/data/error）。 */
// [契约] 运行历史按任务标识做三态缓存：加载中、已加载、失败。
// 三态而不是可空数组，是为了区分「没查过」与「查过但为空」。
// [边界] 缓存条目不携带时间戳，刷新由调用方显式传入强制标记。
// [权衡] 错误信息放在条目里而不是全局错误，允许单条历史失败不影响列表。
// 新增字段必须同时考虑切换工作区时的清空逻辑。
export interface AutomationRunsEntry {
  status: "loading" | "loaded" | "error";
  runs?: ZCodeAutomationRun[];
  error?: string;
}

export type AutomationRunNowResult = "queued" | "duplicate" | "failed";

// [契约] 创建入参把项目归属放在最后且可选，缺省时由 store 补齐当前视图项目。
// 调度规则与结束时间都可选，表示沿用服务端默认策略。
// [边界] 这里不校验 cron 表达式，格式校验属于服务层。
// [权衡] 复用共享类型而不是在本文件重新声明，避免协议漂移。
// 工作区身份可选：本地项目没有身份标识，此时只传路径。
export interface CreateAutomationInput {
  projectId?: string | null;
  title: string;
  cronExpr: string;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  // 目标项目;缺省用 store 当前列表所在项目。创建整页可在项目下拉里改。
  workspacePath?: string;
  workspaceIdentity?: string;
}

// [契约] 更新入参全部可选，缺省表示不修改该字段。
// 允许显式传空值的字段是清空语义，与不传是两回事，不能合并。
// [边界] 是否由用户编辑过调度规则单独标记，服务端据此决定是否重算下次运行。
// [权衡] 不做部分更新的字段快照，避免在 store 里维护第二份任务状态。
// 新增可清空字段时必须同时允许空值，否则用户无法撤销设置。
export interface UpdateAutomationInput {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

// [契约] 状态包含视图工作区、任务列表、加载与错误、操作标记、运行历史缓存。
// 操作标记是单值而不是集合，保证同一时刻只有一个写操作在途。
// [边界] 列表是服务端事实的投影，本 store 不做本地排序与过滤。
// [权衡] 运行历史单独缓存而不是挂在每个任务上，避免列表刷新时整块历史重建。
// 所有方法都要求调用方显式传入服务实例，store 不持有服务引用。
export interface AutomationManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  automations: ZCodeAutomation[];
  loading: boolean;
  error: string | null;
  // 正在进行的写操作标记，用于禁用对应按钮（如 `automation:delete:<id>`）。
  operationId: string | null;
  runsCache: Record<string, AutomationRunsEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    agentService: IZCodeAgentService;
  }) => Promise<void>;
  refresh: (agentService: IZCodeAgentService) => Promise<void>;
  createAutomation: (
    input: CreateAutomationInput,
    agentService: IZCodeAgentService,
  ) => Promise<ZCodeAutomation | null>;
  updateAutomation: (
    automationId: string,
    input: UpdateAutomationInput,
    agentService: IZCodeAgentService,
  ) => Promise<boolean>;
  deleteAutomation: (automationId: string, agentService: IZCodeAgentService) => Promise<void>;
  setEnabled: (
    automationId: string,
    enabled: boolean,
    agentService: IZCodeAgentService,
  ) => Promise<void>;
  restartAutomation: (automationId: string, agentService: IZCodeAgentService) => Promise<void>;
  /** 立即运行一次；queued / duplicate / failed 均由调用方 toast。 */
  runAutomationNow: (
    automationId: string,
    agentService: IZCodeAgentService,
  ) => Promise<AutomationRunNowResult>;
  loadRuns: (
    automationId: string,
    agentService: IZCodeAgentService,
    force?: boolean,
  ) => Promise<void>;
  deleteRun: (
    automationId: string,
    runId: string,
    agentService: IZCodeAgentService,
  ) => Promise<void>;
}

// [契约] 错误统一收敛成字符串，未知值也不抛错。
// 区分错误实例与其他值，避免把对象转成无意义的方括号字符串。
// [边界] 这里不做错误分类，限额错误由专门判定函数识别。
// [权衡] 不拼接栈信息，用户界面只需要可读消息。
// `toMessage` 是纯函数，可被所有 `catch` 分支复用。
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// [契约] 全局递增序号是丢弃过期响应的唯一手段。
// 每次发起列表请求都要先自增，确保不同请求的序号不重复。
// [并发] 多个入口可能同时刷新，序号比较保证只有最后一次写入生效。
// [边界] 序号不做回绕处理，实际运行中不可能触达上限。
// [权衡] 用模块级变量而不是 store 字段，避免序号变化触发订阅者重渲染。
let automationLoadSeq = 0;
// [契约] 立即运行的同步锁按任务标识记录，专门拦截同一渲染帧内的重复点击。
// 它只覆盖当前请求期间，请求返回即释放，不承担长时间的幂等。
// [并发] 活动运行的重复触发由宿主侧的单飞机制返回重复状态。
// [资源] 集合只在模块内可见，不进入 store，避免锁状态驱动 UI。
// [失败路径] 忘记在 finally 删除会让该任务永久无法再次立即运行。
const inFlightRunNowAutomationIds = new Set<string>();

// [契约] 工作区比对同时看路径与身份，两者都相等才算同一工作区。
// 只比路径会让远端与本地同路径的任务串台。
// [边界] 身份为空与身份为空字符串在这里等价，调用前已归一。
// [权衡] 用参数而不是从 store 内部读取，保证比较的是发起请求时的快照。
// [失败路径] 漏掉身份比较会让切换远端会话后仍接受旧响应。
function sameWorkspace(
  current: Pick<AutomationManagementState, "workspacePath" | "workspaceIdentity">,
  workspacePath: string,
  workspaceIdentity: string | null,
): boolean {
  return current.workspacePath === workspacePath && current.workspaceIdentity === workspaceIdentity;
}

// [契约] 写操作的作用域优先取任务自身的项目，缺省才回落到视图项目。
// 这是为了让管理页跨项目展示时，编辑仍然作用在任务所属项目上。
// [边界] 找不到任务且视图项目为空时返回空，调用方直接放弃操作。
// [权衡] 不在找不到任务时抛错，管理页可能刚删除该任务，静默放弃更稳。
// 身份同样遵循任务优先、视图兜底的顺序。
function resolveAutomationActionScope(
  state: Pick<AutomationManagementState, "automations" | "workspacePath" | "workspaceIdentity">,
  automationId: string,
): { workspacePath: string; workspaceIdentity: string | null } | null {
  const automation = state.automations.find((candidate) => candidate.automationId === automationId);
  const workspacePath = automation?.workspacePath ?? state.workspacePath;
  if (!workspacePath) return null;
  return {
    workspacePath,
    workspaceIdentity: automation?.workspaceIdentity ?? state.workspaceIdentity,
  };
}

// [契约] 列表加载抽成独立函数，供初始化、刷新与写操作后的回源共用。
// 请求前不写状态，加载态由调用方决定，避免重复置位。
// [并发] 成功与失败分支都要先比对序号与工作区，再写状态。
// [失败路径] 失败只记录日志并写错误消息，不抛出，保证调用链继续。
// [边界] 列表展示所有项目的任务，不按当前工作区过滤。
async function loadInto(
  set: (partial: Partial<AutomationManagementState>) => void,
  get: () => AutomationManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    agentService: IZCodeAgentService;
    requestId: number;
  },
): Promise<void> {
  const { workspacePath, workspaceIdentity, agentService, requestId } = params;
  try {
    // 定时任务管理视图展示所有项目的任务，不按当前 workspace 过滤（创建/编辑仍带项目）。
    // [契约] 列表接口返回全部项目的任务，这是管理视图的设计前提。
    // 不要改成按工作区过滤，否则跨项目列表会缺项。
    // [边界] 这里不传分页参数，任务数量由服务端限额约束。
    // [失败路径] 请求抛错会进入统一捕获分支，先比对序号再写错误。
    // [并发] 该等待之后的所有判断都必须重新读取最新状态快照。
    const automations = await agentService.listAllAutomations();
    if (
      requestId !== automationLoadSeq ||
      !sameWorkspace(get(), workspacePath, workspaceIdentity)
    ) {
      return;
    }
    set({ automations, loading: false });
  } catch (error) {
    if (
      requestId !== automationLoadSeq ||
      !sameWorkspace(get(), workspacePath, workspaceIdentity)
    ) {
      return;
    }
    logger.error("[automations] load failed", {
      workspacePath,
      error: toMessage(error),
    });
    set({ error: toMessage(error), loading: false });
  }
}

// [契约] store 采用单例创建，状态与方法在同一对象上声明。
// 方法内部一律通过 get 读取最新状态，不依赖闭包里的初始快照。
// [边界] 不提供选择器工厂，消费方直接使用选择器读取所需字段。
// [权衡] `automationManagementStore` 不拆多切片：方法共享序号与锁，拆开只增加协调成本。
// 新增字段必须同时初始化，避免首次读取得到空值。
export const useAutomationManagementStore = create<AutomationManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  automations: [],
  loading: false,
  error: null,
  operationId: null,
  runsCache: {},

  // [契约] 初始化负责切换工作区、决定是否显示加载态、清空过期缓存。
  // 身份先归一成去空白后的值或空，保证后续比对口径统一。
  // 有缓存时保留列表并后台刷新，无缓存时才显示阻塞加载，避免切换闪烁。
  // [资源] 无缓存时清空运行历史，历史按任务标识记录，跨工作区没有意义。
  // 初始化也要清空操作标记与错误，避免上一个工作区的残留影响新视图。
  async initialize({ workspacePath, workspaceIdentity, agentService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const requestId = ++automationLoadSeq;
    const current = get();
    const hasCache =
      current.automations.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      // 有缓存时后台刷新、保留列表，避免切 workspace 闪烁；无缓存才显示阻塞 loading。
      loading: !hasCache,
      error: null,
      operationId: null,
      automations: hasCache ? current.automations : [],
      // 切换 workspace 时清运行历史缓存（历史按 automationId 记，跨 workspace 无意义）。
      ...(hasCache ? {} : { runsCache: {} }),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      agentService,
      requestId,
    });
  },

  // [契约] 刷新只针对当前视图工作区，未初始化时直接返回。
  // 刷新前清空错误，让用户重试时不再看到旧失败。
  // [并发] 每次刷新都取新序号，保证后发起的请求胜出。
  // [边界] 刷新不清空列表，保留旧数据直到新响应到达。
  // [权衡] `automationManagementStore` 不区分手动与自动刷新，行为一致更可预测。
  async refresh(agentService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    const requestId = ++automationLoadSeq;
    set({ error: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      agentService,
      requestId,
    });
  },

  // [契约] 创建前必须已有视图工作区，否则直接失败。
  // 限额检查以管理页全量列表为基准，属于快速拒绝而不是最终裁决。
  // 成功后重新拉取列表，而不是把返回值插入本地数组，避免与服务端排序不一致。
  // [失败路径] 限额错误单独告警，其余错误按普通失败记录。
  // [资源] 无论成功失败都要清空操作标记，保证按钮恢复可用。
  async createAutomation(input, agentService) {
    const { automations, workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return null;
    // [契约] 达到上限时直接写错误码并返回空，不发起请求。
    // 错误文案里带错误码，调用方据此区分限额与其他失败。
    // [边界] 该检查只是前置拦截，服务层事务仍会做最终一致性校验。
    // [权衡] 这里不弹提示，错误写进状态由页面统一展示，避免重复提示。
    // [失败路径] 如果误删该分支，用户会看到服务端报错而不是明确的限额说明。
    if (automations.length >= AUTOMATION_CREATE_LIMIT) {
      // 创建入口分散在表单、模板和会话，单独禁用某个按钮仍可绕过。
      // store 以管理页的全量列表做快速拒绝，服务层事务继续承担最终一致性校验。
      set({
        error: `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] automation limit reached`,
      });
      return null;
    }
    set({ operationId: `automation:create:${input.title}`, error: null });
    try {
      const created = await agentService.createAutomation({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...input,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity,
        agentService,
        requestId,
      });
      return created;
    } catch (error) {
      const message = toMessage(error);
      if (isAutomationCreateLimitError(error)) {
        logger.warn("[automations] create blocked by limit", {
          limit: AUTOMATION_CREATE_LIMIT,
        });
      } else {
        logger.error("[automations] create failed", { error: message });
      }
      set({ error: message });
      return null;
    } finally {
      set({ operationId: null });
    }
  },

  // [契约] 更新使用任务所属项目作为请求作用域，回源却使用视图项目。
  // 这两者不能合并：任务可能在另一个项目里，但列表属于当前视图。
  // [边界] 视图工作区缺失时直接返回失败，不做任何写入。
  // [失败路径] 失败只写错误并返回失败标记，不抛给调用方。
  // [并发] 回源前重新取序号，避免与并发的刷新互相覆盖。
  async updateAutomation(automationId, input, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return false;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return false;
    set({ operationId: `automation:update:${automationId}`, error: null });
    try {
      await agentService.updateAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
        ...input,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[automations] update failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async deleteAutomation(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:delete:${automationId}`, error: null });
    try {
      await agentService.deleteAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] delete failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(automationId, enabled, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({
      operationId: `automation:setEnabled:${automationId}`,
      error: null,
    });
    try {
      await agentService.setAutomationEnabled({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
        enabled,
      });
      // 编辑页持有打开时的 automation 对象；如果只等 listAllAutomations
      // 回源，菜单文案会在点击暂停/恢复后继续显示旧状态。
      set({
        automations: get().automations.map((automation) =>
          automation.automationId === automationId
            ? {
                ...automation,
                enabled,
                lifecycleStatus: enabled ? "active" : "paused",
              }
            : automation,
        ),
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] setEnabled failed", {
        automationId,
        enabled,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async restartAutomation(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:restart:${automationId}`, error: null });
    try {
      await agentService.restartAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] restart failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  // [契约] 返回值三态：已排队、重复、失败，全部由调用方负责提示。
  // 重复判定优先于请求，避免同一任务并发触发两次运行。
  // [并发] 请求期间持有同步锁，返回后立即释放。
  // [边界] 返回重复时不刷新列表，因为没有任何状态变化。
  // [失败路径] 捕获后写错误并返回失败，不向外抛。
  async runAutomationNow(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return "failed";
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return "failed";
    // [契约] 命中同步锁直接返回重复，不进入请求分支。
    // 存在这个判断是因为按钮禁用有一帧延迟，连续点击会在界面更新前重入。
    // [边界] 锁的粒度是任务标识，不同任务可以并行立即运行。
    // [权衡] 不在锁里做延时释放，请求结束即释放，长时间幂等交给宿主。
    // [失败路径] 把锁改成异步互斥会增加复杂度，且无法解决渲染帧内的重入。
    if (inFlightRunNowAutomationIds.has(automationId)) {
      return "duplicate";
    }
    // React 禁用按钮存在一次渲染延迟，连续点击会在 UI 更新前重入。
    // 这里只在当前 RPC 请求期间使用同步内存锁；请求返回后恢复入口，
    // 活动 run 的重复触发继续交由 host single-flight 返回 duplicate。
    inFlightRunNowAutomationIds.add(automationId);
    set({ operationId: `automation:runNow:${automationId}`, error: null });
    try {
      const result = await agentService.runAutomationNow({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      if (result.status === "duplicate") {
        return "duplicate";
      }
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return "queued";
    } catch (error) {
      logger.error("[automations] runNow failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      return "failed";
    } finally {
      inFlightRunNowAutomationIds.delete(automationId);
      set({ operationId: null });
    }
  },

  // [契约] 非强制模式下，已加载或加载中的缓存直接复用，失败才重试。
  // [并发] 请求返回后必须再次比对工作区，切走后丢弃结果。
  // [资源] 缓存写入使用展开旧映射的方式，只替换当前任务的条目。
  async loadRuns(automationId, agentService, force = false) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    const { runsCache } = state;
    const cached = runsCache[automationId];
    if (!force && cached && cached.status !== "error") return;
    set({
      runsCache: {
        ...get().runsCache,
        [automationId]: { status: "loading" },
      },
    });
    try {
      const runs = await agentService.listAutomationRuns({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      if (!sameWorkspace(get(), viewWorkspacePath, state.workspaceIdentity)) {
        return;
      }
      set({
        runsCache: {
          ...get().runsCache,
          [automationId]: { status: "loaded", runs },
        },
      });
    } catch (error) {
      if (!sameWorkspace(get(), viewWorkspacePath, state.workspaceIdentity)) {
        return;
      }
      logger.error("[automations] load runs failed", {
        automationId,
        error: toMessage(error),
      });
      set({
        runsCache: {
          ...get().runsCache,
          [automationId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },

  async deleteRun(automationId, runId, agentService) {
    const state = get();
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:deleteRun:${runId}`, error: null });
    try {
      await agentService.deleteAutomationRun({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        runId,
      });
      await get().loadRuns(automationId, agentService, true);
    } catch (error) {
      logger.error("[automations] delete run failed", {
        runId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },
}));
