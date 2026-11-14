// INV-01 任一时刻至多一次 initialize 在途，所有入口复用同一 Promise；守住位置：initialize 的 initializeInFlight 提前返回分支；改错故障：New Task 与 Automations 重叠挂载时重复取号，后到的 429 覆盖先到的成功，创建入口被误锁。
// INV-02 loading 只能由本轮 initialize 的持有者复位；守住位置：initialize 的 finally 内 initializeInFlight === run 判断；改错故障：旧一轮提前归零 loading，界面显示已就绪但凭证快照仍为空。
// INV-03 资格读取必须先等 initializationReady 落地；守住位置：refreshCodingPlanSupport 的 await initializationReady；改错故障：灰度未就绪时被判为无需读额度，可用入口被永久置成 idle。
// INV-04 eligibilityGeneration 单调递增，只有携带最新代号的完整结果可以写 store；守住位置：drain 循环内三处代号不一致即 continue；改错故障：切换连接后旧 true 快照回写，短暂放开已失效的团队套餐。
// INV-05 同一 service 与同一 freshnessKey 的重复通知只能触发一次查询；守住位置：refreshCodingPlanSupport 开头命中 lastEligibilityTrigger 的提前返回；改错故障：Registry 与 UI 各推一次就打出两次 RPC，限流后准入被判失败。
// INV-06 手动刷新不参与去重且不得写入去重记录；守住位置：lastEligibilityTrigger 赋值处的 undefined 分支；改错故障：用户点刷新拿到缓存结果，连接已修好而界面仍显示不可用。
// INV-07 每次触发都必须同步清空旧 support 与旧额度并置 loading；守住位置：refreshCodingPlanSupport 的首次 set；改错故障：连接切换瞬间旧 true 仍生效，用户点创建后才在服务端失败。
// INV-08 在途 drain 至多一个，待办 service 至多一条，二者构成只进不出的合并单元；守住位置：refreshCodingPlanSupport 的在途提前返回与 pendingEligibilityService 赋值；改错故障：并行两个 drain 时后完成的旧循环覆盖新循环结果。
// INV-09 eligibilityInFlight 必须在 drain 自身同一微任务内清空；守住位置：drain 的 finally 赋值 eligibilityInFlight = null；改错故障：释放被推迟时新请求挂到已结束的检查上，等待永不 resolve，入口卡在 loading。
// INV-10 support 与 availability 必须成对发布，不允许先写支持度再单独补写额度；守住位置：drain 成功分支的单次 set；改错故障：中间态下支持已真而额度是旧值，准入读到不一致组合。
// INV-11 takeNumberAvailabilityStatus 处于 idle、loading、error 时一律禁入；守住位置：状态初值与下游准入判断；改错故障：把依赖异常当成可创建，用户点下去才收到 3103。
// INV-12 support 必须与当前 provider 家族及套餐种类一致才算支持；守住位置：isCurrentOffPeakCodingPlanSupported；改错故障：切到个人套餐后沿用旧团队快照，创建被服务端拒绝。
// INV-13 创建失败必须立即作废额度快照并置 error；守住位置：createTask 的失败分支；改错故障：用户连点创建，每次先过准入再被 3103 打回。
// INV-14 失败只保留结构化分类，传输异常收敛成 network 结果，raw 文本只进日志；守住位置：createTask 的 set error 与 catch 分支；改错故障：跨 RPC 文本被当业务码解析，提示语随宿主语言漂移。
// INV-15 operationId 在任何出口都由 finally 无条件复位；守住位置：各操作方法的 try-finally；改错故障：一次异常后 operationId 残留，按钮永久转圈且无法再次提交。
// INV-16 tasks 只来自服务端快照，改动成功后必须整表重拉，禁止本地乐观增删；守住位置：update、pause、continue、cancel、delete、deleteHistory 的成功路径；改错故障：本地列表与宿主 sqlite 分叉，位次与真实排队不一致。
// INV-17 tasks 每次整体替换为新数组，不原地修改；守住位置：refresh 与 initialize 末尾的 set；改错故障：订阅者持有的旧引用被就地改写，选择器比较不到变化而漏渲染，或读到半更新数组。
// INV-18 任务状态只由宿主推进（queued 到 running 到终态），renderer 不本地迁移，跨窗口可见性依赖宿主写 sqlite 后的下次轮询；守住位置：store 内不存在状态写入；改错故障：renderer 自行推断终态，另一窗口或宿主恢复后状态回跳。
// INV-19 pendingCreateDraft 是一次性读取，取走即清空；守住位置：consumePendingCreateDraft；改错故障：再进创建页时草稿二次灌入，覆盖用户已手填的内容。
import { create } from "zustand";
import {
  normalizeProviderFamilyDomain,
  type AppSettings,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateResult,
  type OffPeakTakeNumberAvailability,
  type ZCodeOffPeakTask,
  type ModelSelection,
} from "@zcode/shared";
import type {
  ICodingPlanSubscriptionService,
  IOffPeakTaskService,
  OffPeakClientConfig,
} from "@zcode/services";
import { logger } from "@/logger.js";

// 闲时任务管理 store（与 automationManagementStore 独立）：走 IOffPeakTaskService RPC。
// 位次/状态靠列表轮询刷新（host offPeakTaskSync 写 sqlite，renderer 只读快照）。

export interface CreateOffPeakTaskInput {
  title: string;
  prompt: string;
  /** 权限四档（build/edit/plan/yolo）；类型收窄在服务端入参处完成。 */
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface UpdateOffPeakTaskInput {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ModelSelection | null;
}

/** New task 页模板卡点击后携带到 Automations 创建表单的预填草稿（模板=预填）。 */
export interface OffPeakCreateDraft {
  title?: string;
  prompt?: string;
  telemetrySource?: {
    eventRegion: "app.session" | "app.automations";
    templateId: string;
  };
}

/** availability 的请求状态与服务端额度快照分离；只有 ready + canTakeNumber=true 才能放行。 */
export type OffPeakTakeNumberAvailabilityStatus = "idle" | "loading" | "ready" | "error";

interface OffPeakTaskState {
  tasks: ZCodeOffPeakTask[];
  loading: boolean;
  error: string | null;
  operationId: string | null;
  /** 灰度配置：null=未加载。未命中/关闭时入口整体不渲染。 */
  grayConfig: OffPeakClientConfig | null;
  /** 当前 selected provider/connection 的脱敏凭证支持快照；不含 JWT/API Key。 */
  codingPlanSupport: OffPeakCodingPlanSupport | null;
  /** 服务端取号额度即时快照；null=尚无成功响应。 */
  takeNumberAvailability: OffPeakTakeNumberAvailability | null;
  /** loading/idle/error 均禁入，避免把依赖异常误当成可创建。 */
  takeNumberAvailabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  /** New task 页横幅本次会话是否已被用户关闭（关闭后下次登录/重启再开）。 */
  newTaskBannerDismissed: boolean;
  /** 模板卡→创建表单的预填草稿（跨视图导航一次性携带）。 */
  pendingCreateDraft: OffPeakCreateDraft | null;
  initialize(deps: {
    offPeakTaskService: IOffPeakTaskService;
    codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  }): Promise<void>;
  refresh(service: IOffPeakTaskService): Promise<void>;
  refreshCodingPlanSupport(service: IOffPeakTaskService, freshnessKey?: string): Promise<void>;
  refreshTakeNumberAvailability(service: IOffPeakTaskService): Promise<void>;
  createTask(
    input: CreateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<OffPeakTaskCreateResult>;
  updateTask(
    offPeakTaskId: string,
    input: UpdateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<boolean>;
  pauseTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  continueTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  cancelTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteHistory(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  dismissNewTaskBanner(): void;
  /** 模板卡点击：暂存预填草稿供 Automations 创建表单消费（consume 后清空）。 */
  setPendingCreateDraft(draft: OffPeakCreateDraft): void;
  consumePendingCreateDraft(): OffPeakCreateDraft | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** support 必须仍对应 renderer 当前选择；切换连接后的旧 true 快照不能短暂放开创建。 */
export function isCurrentOffPeakCodingPlanSupported(
  support: OffPeakCodingPlanSupport | null,
  settings:
    | Pick<AppSettings, "providerFamilyConnectionSelections" | "providerFamilyDomain">
    | null
    | undefined,
): boolean {
  if (!support?.supported || !settings) return false;
  const providerFamily = normalizeProviderFamilyDomain(settings.providerFamilyDomain);
  if (!providerFamily || providerFamily !== support.providerFamily) return false;
  const selection = settings.providerFamilyConnectionSelections?.[providerFamily];
  if (selection?.kind === "individual-coding-plan") {
    return support.kind === `${providerFamily}-personal`;
  }
  if (selection?.kind === "team-coding-plan") {
    return support.kind === `${providerFamily}-team`;
  }
  return false;
}

/** 服务端 3103（取号超限）只按结构化分类识别，不再解析跨 RPC 的错误文本。 */
export function isOffPeakQuotaError(result: OffPeakTaskCreateResult | null | undefined): boolean {
  return (
    result?.ok === false && result.errorCategory === "quota_3103" && result.errorCode === "3103"
  );
}

export type OffPeakCreateErrorMessageId =
  | "offPeak.error.quota"
  | "offPeak.error.unavailable"
  | "offPeak.error.generic";

/** 创建失败只按服务端明确业务码映射；原始 RPC 文本仅留日志，不直接展示给用户。 */
export function resolveOffPeakCreateErrorMessageId(
  result: OffPeakTaskCreateResult | null | undefined,
): OffPeakCreateErrorMessageId {
  if (isOffPeakQuotaError(result)) return "offPeak.error.quota";
  if (
    result?.ok === false &&
    (result.errorCategory === "network" ||
      result.errorCategory === "invalid_response" ||
      result.errorCategory === "unknown")
  ) {
    return "offPeak.error.unavailable";
  }
  return "offPeak.error.generic";
}

// [并发] 下面这几个模块级变量是 zustand state 之外的准入协调层，不放进 store：
// 写它们必须与订阅通知同序，而 set 每写一次都会触发订阅者重算选择器。
// [权衡] 若把在途 Promise 塞进 state，置空那一刻就通知一遍订阅者，
// 且 React 渲染批次无法保证「清空」与「下一次触发」的先后，去重会漏。
// initializeInFlight 只覆盖 initialize，eligibilityInFlight 只覆盖资格查询，不可合并：
// initialize 内部要 await 资格查询，合并后它会等待自身，入口直接死锁。
// [失败路径] 两者都靠 finally 复位，任何绕过 finally 的出口都会永久锁死入口；
// 复位时同时比对 initializeInFlight 的持有者身份，避免旧一轮清掉新一轮的句柄。
let initializeInFlight: Promise<void> | null = null;
let initializationReady: Promise<void> = Promise.resolve();
let eligibilityInFlight: Promise<void> | null = null;
let eligibilityGeneration = 0;
let pendingEligibilityService: IOffPeakTaskService | null = null;
let lastEligibilityTrigger: { service: IOffPeakTaskService; key: string } | null = null;

export const useOffPeakTaskStore = create<OffPeakTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  operationId: null,
  grayConfig: null,
  codingPlanSupport: null,
  takeNumberAvailability: null,
  takeNumberAvailabilityStatus: "idle",
  newTaskBannerDismissed: false,
  pendingCreateDraft: null,

  async initialize({ offPeakTaskService, codingPlanSubscriptionService }) {
    // Bug 原因：New Task 与 Automations 在页面切换时可能短暂重叠挂载，两个 initialize
    // 会并发请求同一个 Team Plan availability，后到的全局 429 可能覆盖先到的成功结果。
    // Store 级 single-flight 保证所有入口共用一次完整准入检查。
    if (initializeInFlight) return initializeInFlight;
    set({ loading: true, error: null });
    // 初始化和后续通知共用资格检查；灰度先就绪，资格与额度不能由两条异步链分别写入。
    // [并发] 灰度配置与任务列表并行发起，二者互不依赖，串行会把首屏拖成两次往返。
    // 两路都就地兜底成空值：grayConfig 拉不到只影响入口可见性，而 tasks 拉不到只影响首屏行数。
    // 任一失败都不该让 initialize 拒绝，否则 loading 永远停在真。
    // [失败路径] 降级后界面呈现「未启用 / 无任务」，这是有意的静默：
    // grayConfig 与 tasks 的降级结果拿不到区分「服务不可用」与「确实没有数据」的依据，
    // 强行报错会把一次网络抖动展示成产品故障。
    // 这条链的 set 只写 grayConfig 与 tasks，不碰 support 与额度：
    // 两处 set 若都写同一批字段，中间态会出现「有任务但支持度未知」的组合被下游读到。
    initializationReady = Promise.all([
      codingPlanSubscriptionService
        .getOffPeakClientConfig({ forceRefresh: true })
        .catch((error) => {
          logger.warn("[off-peak] gray config load failed", toErrorMessage(error));
          return null;
        }),
      offPeakTaskService.list().catch((error) => {
        logger.warn("[off-peak] list failed", toErrorMessage(error));
        return [] as ZCodeOffPeakTask[];
      }),
    ]).then(([grayConfig, tasks]) => {
      set({ grayConfig, tasks });
    });
    // run 必须先取到 Promise 再登记为在途。refreshCodingPlanSupport 是同步函数，
    // 进入它时内部已经把自己的在途句柄设好，这里的单飞分支若先登记就会误判「已在途」，
    // initialize 的 finally 也就会把 loading 归零在真正完成之前。
    // [并发] 这里不 await 而直接赋给 initializeInFlight，是为了让并发的第二个 initialize
    // 在第一次 await 之前就命中提前返回，而不是各自跑完一轮再撞车。
    // [失败路径] finally 里必须比对 initializeInFlight === run 才复位：
    // 若中途被新一轮替换，旧轮不得清空 loading，也不得清掉新轮的句柄。
    const run = get().refreshCodingPlanSupport(offPeakTaskService);
    initializeInFlight = run;
    try {
      await run;
    } finally {
      if (initializeInFlight === run) {
        initializeInFlight = null;
        set({ loading: false });
      }
    }
  },

  async refresh(service) {
    try {
      const tasks = await service.list();
      set({ tasks, error: null });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  refreshCodingPlanSupport(service, freshnessKey) {
    // 两个入口收到同一 Registry/连接通知只检查一次；手动刷新无 key，始终重查。
    if (
      freshnessKey !== undefined &&
      lastEligibilityTrigger?.service === service &&
      lastEligibilityTrigger.key === freshnessKey
    ) {
      return eligibilityInFlight ?? Promise.resolve();
    }
    // [权衡] 去重键取 service 引用加通知方给的 freshnessKey，而不是比凭证内容：
    // renderer 侧只有脱敏快照：比凭据内容既判断不出「变了」也判断不出「没变」，
    // 把「什么算同一次变更」交给知道变更来源的一侧判定，才可能稳定。
    // freshnessKey 为 undefined 表示手动刷新，此时写入 null 而不是一条空键记录，
    // 否则下一次同键的自动通知会误命中「刚查过」而跳过，
    // 而手动刷新又把状态固定住，用户会看到「刷了但没变」。
    // [并发] 该变量只在 refreshCodingPlanSupport 的同步段读写，
    // 异步部分全部走代号校验，不依赖这个键的时效性。
    lastEligibilityTrigger = freshnessKey === undefined ? null : { service, key: freshnessKey };
    eligibilityGeneration += 1;
    pendingEligibilityService = service;
    set({
      codingPlanSupport: null,
      takeNumberAvailability: null,
      takeNumberAvailabilityStatus: "loading",
    });
    if (eligibilityInFlight) return eligibilityInFlight;
    // 旧代码的 support/availability 独立请求会乱序覆盖。串行 drain 合并在途变化，
    // 旧成功、旧失败均丢弃；只有一代完整资格与额度能够一起发布。
    // [并发] 串行 drain：同一时刻只有一个循环在跑，新触发只更新待办 service 与代号，
    // 由当前循环在下一轮消化，N 次通知被压成至多两次 RPC 往返。
    // 用 Promise.resolve 起步而不是立即执行函数，保证返回前句柄已经赋值，
    // 否则并发的第二次调用会看到 null 再起一个循环，两个循环互相覆盖状态。
    // [事务] 每轮先在本地取走 service 与代号、再清空待办：
    // 中途到达的新触发写入 pendingEligibilityService，由本轮结束后接走，既不丢也不重复。
    // 三处代号比对分别挡住「await 前已被取代」「支持度回来时已被取代」「额度回来时已被取代」，
    // 漏掉任意一处，旧一代的完整结果就会覆盖新连接的状态。
    eligibilityInFlight = Promise.resolve().then(async () => {
      try {
        while (pendingEligibilityService) {
          const currentService = pendingEligibilityService;
          const generation = eligibilityGeneration;
          pendingEligibilityService = null;
          await initializationReady;
          if (generation !== eligibilityGeneration) continue;
          try {
            const codingPlanSupport = await currentService.getCodingPlanSupport();
            if (generation !== eligibilityGeneration) continue;
            const grayConfig = get().grayConfig;
            const shouldReadAvailability =
              grayConfig?.enabled &&
              (grayConfig.codingPlanActive === true || codingPlanSupport.supported === true);
            // [权衡] 仅在灰度启用且（套餐已激活或凭证受支持）时读额度：
            // 未启用时该 RPC 在宿主侧必然失败，每次都打只会刷满失败日志并拖慢首屏；
            // 而把它当成 0 又会伪装成「额度已用完」，所以宁可不读、状态回 idle。
            // takeNumberAvailabilityStatus 的 idle 与 error 语义不同：idle 表示「无需读」，而 error 表示「读过但坏了」，
            // 两者的 UI 表现相同（都禁入），日志里靠 warning 原文区分。
            // [失败路径] 支持度失败与额度失败共用同一个 catch，均归为 error：
            // 对用户的后果一致，多分一个分支只会多一条无法处置的提示路径。
            const takeNumberAvailability = shouldReadAvailability
              ? await currentService.getTakeNumberAvailability()
              : null;
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport,
              takeNumberAvailability,
              takeNumberAvailabilityStatus: shouldReadAvailability ? "ready" : "idle",
            });
          } catch (error) {
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport: null,
              takeNumberAvailability: null,
              takeNumberAvailabilityStatus: "error",
            });
            logger.warn("[off-peak] eligibility refresh failed", toErrorMessage(error));
          }
        }
      } finally {
        // 在 drain 同一微任务中释放，避免 finally 排队期间新请求挂到已结束的检查上。
        eligibilityInFlight = null;
      }
    });
    return eligibilityInFlight;
  },

  refreshTakeNumberAvailability(service) {
    return get().refreshCodingPlanSupport(service);
  },

  // 创建是非幂等取号，因此 store 内不做自动重试：一次点击对应一次票据申请，
  // 自动重试会把额度消耗放大，用户看到的是「只点一次却扣了多张」。
  // [事务] 成功路径必须先把列表刷完再返回：调用方拿到 ok 时列表里要已有这条任务，
  // 否则新建后跳转详情会找不到 id。列表与额度读的是不同 RPC，用并发发出。
  // [失败路径] 业务失败与传输失败是两条路径，但都必须作废额度快照：
  // 失败恰恰证明上一份准入已过期，继续沿用会让用户连点连败。
  // 入参 permissionMode 的取值收窄放在服务端，而 store 只透传，
  // 避免 permissionMode 枚举在两端各写一份而慢慢分叉。
  async createTask(input, service) {
    set({ operationId: "offpeak:create", error: null });
    try {
      const result = await service.createTask(
        input as Parameters<IOffPeakTaskService["createTask"]>[0],
      );
      // ok 为真时 result 里带着新任务标识，但 store 不把它拼进 tasks 而要整表重拉：
      // 位次是全局排队序，本地插入必然与其他任务的名次冲突。
      // [并发] 刷新期间 operationId 仍是 create，而按钮据此继续禁用提交，
      // 二次取号被挡在 store 层而不是靠 UI 自觉。
      // 若把这两次刷新挪到 finally 之后，operationId 会先归零，
      // 刷新窗口里按钮已可点击，连点就会发出两个创建请求。
      // 成功返回的 result 原样给调用方，用于跳转与埋点，store 不复制其中的字段。
      if (result.ok) {
        await Promise.all([get().refresh(service), get().refreshTakeNumberAvailability(service)]);
        return result;
      }
      // 创建失败说明之前的准入快照已不足以继续放行；只保存稳定分类，不把 raw error 放进 UI 状态。
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create failed", {
        errorCategory: result.errorCategory,
        errorCode: result.errorCode,
        failureStage: result.failureStage,
      });
      if (isOffPeakQuotaError(result)) {
        await get().refreshTakeNumberAvailability(service);
      }
      return result;
    } catch (error) {
      // Host/RPC transport 仍可能在结构化服务结果之外失败；统一收敛为 network，
      // toast 只消费稳定分类，禁止解析 raw error。
      const result = {
        ok: false,
        failureStage: "ticket_request",
        errorCategory: "network",
        errorCode: "",
        providerName: "",
      } as const satisfies OffPeakTaskCreateResult;
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create RPC transport failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return result;
    } finally {
      set({ operationId: null });
    }
  },

  async updateTask(offPeakTaskId, input, service) {
    set({ operationId: `offpeak:update:${offPeakTaskId}`, error: null });
    try {
      const updated = await service.updateTask(offPeakTaskId, input);
      await get().refresh(service);
      return updated !== null;
    } catch (error) {
      set({ error: toErrorMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async pauseTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:pause:${offPeakTaskId}`, error: null });
    try {
      await service.pauseTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async continueTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:continue:${offPeakTaskId}`, error: null });
    try {
      await service.continueTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  // [事务] 取消与暂停、继续、删除共用同一形状：先置 operationId、再发 RPC、
  // 成功后整表重拉、finally 复位。顺序不能改：先刷新后置锁会让刷新窗口内的
  // 反向操作（取消后立刻继续）按到达顺序被服务端定终态，
  // 而 tasks 已按第一个结果渲染，出现「界面已取消、实际仍在跑」。
  // [失败路径] catch 只写 error 不重试：这些操作由用户显式再点一次重试，
  // store 内自动重试会把取消与完成的竞态放大成重复取消，
  // 而终态迁移是单向的，重复取消会污染已经落定的历史记录。
  async cancelTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:cancel:${offPeakTaskId}`, error: null });
    try {
      await service.cancelTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:delete:${offPeakTaskId}`, error: null });
    try {
      await service.deleteTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteHistory(offPeakTaskId, service) {
    set({
      operationId: `offpeak:delete-history:${offPeakTaskId}`,
      error: null,
    });
    try {
      await service.deleteHistory(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  dismissNewTaskBanner() {
    set({ newTaskBannerDismissed: true });
  },

  setPendingCreateDraft(draft) {
    set({ pendingCreateDraft: draft });
  },

  consumePendingCreateDraft() {
    const draft = get().pendingCreateDraft;
    if (draft) set({ pendingCreateDraft: null });
    return draft;
  },
}));
