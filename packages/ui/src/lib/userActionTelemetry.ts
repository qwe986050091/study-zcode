// ============================================================================
// userActionTelemetry.ts — Renderer 用户操作埋点：把一次 UI 操作编码为 ui_action span，批量旁路上报
// 口径：注释密度与不变量写法见 docs/annotation/DEEP-SPEC.md；本文件守住「严格旁路 + 幂等结算」
// INV-01 埋点严格旁路：sendBatch 抛错只能吞掉。守住 flushImpl 的 try/catch；改错→采集抖动会让用户操作失败
// INV-02 采样门控顺序：目录命中→总开关→分组开关→随机采样。守住 start 的条件链；改错→关闭分组仍上报
// INV-03 NOOP_ACTION_HANDLE 共享且无状态。守住 start 的早返回；改错→不同操作的结算互相串味
// INV-04 未登记的 featureId 与 action 不采集。守住 catalog 解析；改错→拼错的动作名变成静默上报
// INV-05 finish 幂等，先 delete 成功才继续。守住 finish 首行；改错→超时与完成竞争产出两条 span
// INV-06 结算必须 clearTimeout。守住 finish 内 delete 之后；改错→悬挂定时器累积并补记 abandoned
// INV-07 endTime 取 max(endedAt, startedAt)。守住 span 构造；改错→时钟回拨产生负时长
// INV-08 只有 failed 与 rejected 映射为 error。守住 status 三元；改错→cancelled 与 noop 推高失败率
// INV-09 可选属性只在有值时展开。守住 attributes 条件展开；改错→undefined 覆盖后端默认值
// INV-10 完成队列上限 256，超限丢新保旧。守住 finish 容量判断；改错→丢弃计数与批次序号语义错位
// INV-11 达到批量阈值立即 flush，否则 2 秒防抖。守住 finish 尾部分支；改错→高流量下延迟累积
// INV-12 单条超字节上限时丢弃自身并计数。守住 takeNextBatch 的空批次分支；改错→队列死循环
// INV-13 丢弃计数只归属下一批，发送前清零。守住 batch 构造顺序；改错→失败批次重复回填
// INV-14 flush 单飞，复用同一个 Promise。守住 flush 首行；改错→同一批 span 被发送两次
// INV-15 flush 结束仍有残留且无定时器时续排一次。守住 finally；改错→单飞期间入队的数据永不上报
// INV-16 字节估算按 UTF-16 长度乘 2。守住 estimatedBytes；改错→中文属性估算偏小被服务端拒收
// INV-17 shutdown 先结算活跃操作为 abandoned 再 flush。守住 shutdown；改错→关窗丢漏斗末端数据
// INV-18 全局单例默认 NOOP，set 传 null 复位。守住模块级赋值；改错→未初始化即采集在测试环境报错
// INV-19 runUserAction 系列失败必须先 fail 再 rethrow。守住 catch；改错→吞错让调用方误判成功
// INV-20 时钟默认 performance.timeOrigin 加 now。守住 defaultNow；改错→系统休眠或校时让时长跳变
// ============================================================================
import type {
  RendererActionTraceAttributes,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererActionTraceResourceV1,
  RendererActionTraceSpanV1,
} from "@zcode/shared";
import {
  RENDERER_ACTION_TRACE_MAX_BATCH_BYTES,
  RENDERER_ACTION_TRACE_MAX_BATCH_SPANS,
} from "@zcode/shared";
import {
  resolveUserActionCatalogEntry,
  type UserActionFeatureId,
} from "@/lib/userActionTraceCatalog.js";

// 待发送 span 的硬上限；达到上限后丢弃新数据并只累加丢弃计数，绝不淘汰已在队列里的旧数据。
// 选 256 是为了最坏情况下仍能容纳两个满批，避免一次网络抖动就把队列打满。
const RENDERER_ACTION_TRACE_MAX_QUEUE_SPANS = 256;
// 低流量下的合并窗口：单条操作结束后最多等 2 秒再发，减少 renderer 到采集端的小包请求数。
const RENDERER_ACTION_TRACE_FLUSH_DELAY_MS = 2_000;

// 注入时钟只为让测试可控；setNow 是可选能力，生产实现不提供，调用方不得依赖它推进时间。
export interface UserActionTelemetryClock {
  now(): number;
  setNow?(value: number): void;
}

export type UserActionTrigger = RendererActionTraceAttributes["trigger"];
export type UserActionResultSource = NonNullable<RendererActionTraceAttributes["result_source"]>;

// featureId 与 action 的组合必须在 catalog 中登记，否则整次埋点被静默丢弃（见 INV-04）。
// timeoutMs 覆盖 catalog 里的默认超时，用于少数可能长时间挂起的操作；不传就完全交给目录。
// workspaceKind 与 remoteKind 等是低基数维度，只允许传枚举值，不能塞路径或用户输入。
// surface 未传时取 catalog 的默认界面名，保证同一动作在不同入口能被区分。
export interface StartUserActionInput {
  featureId: UserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  surface?: string;
  timeoutMs?: number;
  workspaceKind?: RendererActionTraceAttributes["workspace_kind"];
  remoteKind?: RendererActionTraceAttributes["remote_kind"];
  automationKind?: RendererActionTraceAttributes["automation_kind"];
}

// 这里只放低基数、可枚举的结果维度；任何可能含用户内容或路径的字段都不允许进来。
// failureStage 是分阶段失败归因的关键，必须用稳定短码，不能拼错误消息，否则聚合时会炸基数。
// valueAfter 仅用于设置项等有限取值的场景，禁止写入自由文本。
export interface UserActionResult {
  resultSource?: UserActionResultSource;
  failureStage?: string;
  stateAfter?: RendererActionTraceAttributes["state_after"];
  configured?: boolean;
  requiresRestart?: boolean;
  sectionId?: string;
  valueAfter?: string;
  admissionResult?: RendererActionTraceAttributes["admission_result"];
}

// 失败必须带 failureStage：没有阶段信息的失败在漏斗里无法定位，等于白采。
export interface UserActionFailure extends UserActionResult {
  failureStage: string;
}

// 五种结算方式只对应五种 outcome；一个 handle 只能结算一次，第二次调用由 finish 的幂等判定吸收。
// noop 不是 cancel：它表示用户没有产生实际动作（例如点了无变化的选项），不能计入取消率。
// complete 与 reject 的 result 是可选参数，但失败路径必须提供 failureStage，这是类型层面强制不了的约定。
export interface UserActionHandle {
  complete(result?: UserActionResult): void;
  fail(failure: UserActionFailure): void;
  reject(result?: UserActionResult): void;
  cancel(): void;
  noop(): void;
}

// 对外的唯一入口是 start；组件不得直接构造 span 或触碰队列，保证门控与幂等只有一份实现。
export interface UserActionTelemetry {
  start(input: StartUserActionInput): UserActionHandle;
}

// sendBatch 必须由外部注入：renderer 不自持传输层，测试里可以替换成同步收集器。
// random 与 randomHex 可注入，用于稳定采样与 ID 生成的测试；生产直接落到 Math.random 与 crypto。
// resource 描述 renderer 实例身份，整批共享，start 时不再重复计算。
interface RendererUserActionTelemetryOptions {
  config: RendererActionTraceConfigV1;
  resource: RendererActionTraceResourceV1;
  sendBatch: (batch: RendererActionTraceBatchV1) => Promise<unknown> | unknown;
  clock?: UserActionTelemetryClock;
  random?: () => number;
  randomHex?: (bytes: 8 | 16) => string;
}

// activeActions 里保存的是「已开始未结算」的操作；timeout 句柄与 span 起止时间都必须随对象一起管理。
interface ActiveAction {
  actionId: string;
  entry: NonNullable<ReturnType<typeof resolveUserActionCatalogEntry>>;
  input: StartUserActionInput;
  spanId: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  traceId: string;
}

// 所有方法都是空实现且不读写任何状态，因此可以全局共享一个实例，避免采样外路径产生额外分配。
// 不要在这里加计数器或日志：NOOP 路径本身就可能高频命中，任何副作用都会污染关闭态的行为。
const NOOP_ACTION_HANDLE: UserActionHandle = {
  complete() {},
  fail() {},
  reject() {},
  cancel() {},
  noop() {},
};

// 实现类只依赖注入的配置与传输，不读全局单例；这样控制器与测试实例可以并存互不影响。
// 所有可变队列与计数都是实例字段，跨实例不共享。
export class RendererUserActionTelemetry implements UserActionTelemetry {
  private config: RendererActionTraceConfigV1;
  private readonly resource: RendererActionTraceResourceV1;
  private readonly sendBatch: RendererUserActionTelemetryOptions["sendBatch"];
  private readonly clock: UserActionTelemetryClock;
  private readonly random: () => number;
  private readonly randomHex: (bytes: 8 | 16) => string;
  // 只存已完成待发送的 span；顺序必须保持产生顺序，后端按 sequence 与数组顺序还原时间线。
  private readonly completedQueue: RendererActionTraceSpanV1[] = [];
  private readonly activeActions = new Set<ActiveAction>();
  // 防抖定时器的唯一句柄；置 undefined 表示当前没有待触发的 flush，续排判断依赖这个语义。
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  // 自上次组批以来被丢弃的 span 数，只在构造 batch 时读取并立刻清零。
  private droppedSinceLastFlush = 0;
  // 批次序号单调递增，用于后端发现丢批；进程内唯一，不随 flush 失败回退。
  private sequence = 0;

  // 依赖全部走 options 注入，缺省只在测试便利的随机与时钟上兜底，传输与配置没有默认值。
  // 构造期不做任何 IO 或定时器注册，实例创建必须是纯内存操作。
  constructor(options: RendererUserActionTelemetryOptions) {
    this.config = options.config;
    this.resource = options.resource;
    this.sendBatch = options.sendBatch;
    this.clock = options.clock ?? { now: defaultNow };
    this.random = options.random ?? Math.random;
    this.randomHex = options.randomHex ?? randomHex;
  }

  // 热更新只替换配置引用，不影响已在途的 active 操作；它们的超时与采样在 start 时已经定下。
  updateConfig(config: RendererActionTraceConfigV1): void {
    this.config = config;
  }

  // [契约] 门控顺序即语义：先确认动作在目录中登记，再看总开关与分组白名单，最后才消耗随机数。
  // 采样比较用大于等于丢弃，sampleRatio 为 1 时全部通过，为 0 时全部丢弃，不会出现边界歧义。
  // 命中任一关闭条件都返回共享 NOOP handle，调用方无需判空，也不用关心是否真的在采集。
  // 不要在门控前做 UUID 或定时器：被采样丢弃的操作不应该产生任何可观测副作用。
  start(input: StartUserActionInput): UserActionHandle {
    const entry = resolveUserActionCatalogEntry(input.featureId, input.action);
    if (
      !entry ||
      !this.config.enabled ||
      !this.config.enabledGroups.includes(entry.group) ||
      this.random() >= this.config.sampleRatio
    ) {
      return NOOP_ACTION_HANDLE;
    }

    // actionId 用 crypto.randomUUID 保证跨 renderer 唯一；traceId 与 spanId 由注入的随机源生成，便于测试固定。
    // 超时从 start 时刻起算，默认取 catalog 的 timeoutMs；触发后按 abandoned 结算，不抛错也不重试。
    // 对象先构造再入集合，确保 timeout 回调触发时一定能从集合里 delete 成功，不会漏结算。
    const active: ActiveAction = {
      actionId: crypto.randomUUID(),
      entry,
      input,
      spanId: this.randomHex(8),
      startedAt: this.clock.now(),
      timeout: setTimeout(() => {
        this.finish(active, "abandoned", {});
      }, input.timeoutMs ?? entry.timeoutMs),
      traceId: this.randomHex(16),
    };
    this.activeActions.add(active);

    return {
      // 返回的 handle 每个方法都绑定同一个 active 对象，调用方拿到的是闭包而不是可变引用。
      // complete 与 reject 允许省略 result，统一兜底成空对象，避免 attributes 展开时对 undefined 取值。
      // cancel 与 noop 不接收结果：这两类 outcome 没有可上报的结果维度，传了也会被忽略。
      complete: (result) => this.finish(active, "completed", result ?? {}),
      fail: (failure) => this.finish(active, "failed", failure),
      reject: (result) => this.finish(active, "rejected", result ?? {}),
      cancel: () => this.finish(active, "cancelled", {}),
      noop: () => this.finish(active, "noop", {}),
    };
  }

  // [并发] 单飞入口：已有在途 Promise 时直接复用，杜绝同一批 span 被两次发送。
  // Promise.resolve 起链是为了把同步异常也收进同一 Promise，避免调用方看到半同步半异步的失败语义。
  // finally 里释放句柄后重新检查队列：单飞期间新入队且没有定时器的数据必须在这里续排，否则会滞留在内存。
  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = Promise.resolve()
      .then(() => this.flushImpl())
      .finally(() => {
        this.flushPromise = undefined;
        if (this.completedQueue.length > 0 && this.flushTimer === undefined) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush();
          }, RENDERER_ACTION_TRACE_FLUSH_DELAY_MS);
        }
      });
    return this.flushPromise;
  }

  // 进入即取消待定定时器：本轮 flush 会处理当前队列，旧的防抖触发点已经没有意义。
  // 循环逐批取数直到队列为空；sendBatch 串行等待，保证后端看到的批次顺序与产生顺序一致。
  // 单批失败不中断后续批次，也不回填已取走的 span——采集端丢包比重复上报更容易对账。
  private async flushImpl(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.completedQueue.length > 0) {
      const spans = this.takeNextBatch();
      if (spans.length === 0) break;
      // drop 计数与 sequence 在构造时快照，随后立刻清零；这样即使发送失败，丢弃数也不会被重复计入下一批。
      const batch: RendererActionTraceBatchV1 = {
        version: 1,
        rendererInstanceId: this.resource.rendererInstanceId,
        sequence: this.sequence++,
        droppedSinceLastFlush: this.droppedSinceLastFlush,
        resource: this.resource,
        spans,
      };
      this.droppedSinceLastFlush = 0;
      try {
        await this.sendBatch(batch);
      } catch {
        // Telemetry 是严格旁路；传输失败不能回压或改变用户操作结果。
      }
    }
  }

  // 窗口关闭或 renderer 卸载时调用：先把所有进行中的操作按 abandoned 结算，再统一 flush。
  // 结算必须发生在 flush 之前，否则最后一批 span 进不了本次发送。
  async shutdown(): Promise<void> {
    for (const active of this.activeActions) {
      this.finish(active, "abandoned", {});
    }
    await this.flush();
  }

  // 幂等的唯一闸门：集合里删不到说明已经结算过，直接返回，绝不重复入队。
  // delete 之后再清定时器，顺序反了会让 timeout 回调在「已删除但未清」的窗口里跑一次空结算。
  // endedAt 在清理后立刻取，避免后续属性拼装期间的耗时被算进业务区间。
  // result 里未提供的字段一律不写，禁止用空字符串占位，否则后端会把它当成真实取值。
  private finish(
    active: ActiveAction,
    outcome: RendererActionTraceAttributes["outcome"],
    result: UserActionResult,
  ): void {
    if (!this.activeActions.delete(active)) return;
    clearTimeout(active.timeout);
    const endedAt = this.clock.now();
    // 所有字段来自 catalog 与调用方入参，本函数不做任何推断；缺省维度直接不写入，而不是写空串。
    const attributes: RendererActionTraceAttributes = {
      feature_id: active.entry.featureId,
      action: active.entry.action,
      catalog_group: active.entry.group,
      operation_kind: active.entry.operationKind,
      surface: active.input.surface ?? active.entry.surface,
      trigger: active.input.trigger,
      outcome,
      action_id: active.actionId,
      ...(result.resultSource ? { result_source: result.resultSource } : {}),
      ...(result.failureStage ? { failure_stage: result.failureStage } : {}),
      ...(result.stateAfter ? { state_after: result.stateAfter } : {}),
      ...(result.configured !== undefined ? { configured: result.configured } : {}),
      ...(result.requiresRestart !== undefined ? { requires_restart: result.requiresRestart } : {}),
      ...(result.sectionId ? { section_id: result.sectionId } : {}),
      ...(result.valueAfter ? { value_after: result.valueAfter } : {}),
      ...(active.input.workspaceKind ? { workspace_kind: active.input.workspaceKind } : {}),
      ...(active.input.remoteKind ? { remote_kind: active.input.remoteKind } : {}),
      ...(result.admissionResult ? { admission_result: result.admissionResult } : {}),
      ...(active.input.automationKind ? { automation_kind: active.input.automationKind } : {}),
    };
    // name 固定为 ui_action，status 由 outcome 决定；trace 与 span 的起止时间必须来自同一个时钟源。
    // span 一旦入队就不再修改，后续任何字段调整都要在构造前完成。
    const span: RendererActionTraceSpanV1 = {
      traceId: active.traceId,
      spanId: active.spanId,
      name: "ui_action",
      startTimeUnixMs: active.startedAt,
      endTimeUnixMs: Math.max(endedAt, active.startedAt),
      status: outcome === "failed" || outcome === "rejected" ? "error" : "ok",
      attributes,
    };
    // 队列已满时只累加丢弃计数并返回：丢新保旧能保证已排队数据的顺序与完整性。
    // 不要在这里触发强制 flush 来腾空间：flush 是异步的，同步路径上腾不出位置，反而放大抖动。
    if (this.completedQueue.length >= RENDERER_ACTION_TRACE_MAX_QUEUE_SPANS) {
      this.droppedSinceLastFlush += 1;
      return;
    }
    this.completedQueue.push(span);
    if (this.completedQueue.length >= RENDERER_ACTION_TRACE_MAX_BATCH_SPANS) {
      void this.flush();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, RENDERER_ACTION_TRACE_FLUSH_DELAY_MS);
    }
  }

  // 按顺序取批，遇到字节上限或数量上限即停；取走的 span 立刻从队列头部移除，避免重复发送。
  // 返回空数组表示队列已空，调用方必须据此结束循环。
  // 批次上限取 `USER_ACTION_TELEMETRY_BATCH_LIMIT` 并与发送端接收上限同源，调用点不得写死数字。
  private takeNextBatch(): RendererActionTraceSpanV1[] {
    const spans: RendererActionTraceSpanV1[] = [];
    while (spans.length < RENDERER_ACTION_TRACE_MAX_BATCH_SPANS && this.completedQueue.length > 0) {
      const candidate = this.completedQueue[0];
      if (!candidate) break;
      const next = [...spans, candidate];
      const estimatedBytes = JSON.stringify(next).length * 2;
      // 单条 span 自己就超上限时（属性异常膨胀），丢弃它并计数，否则会永远取不出批次而死循环。
      // 非空批次遇到上限则保留剩余数据，等下一轮 flush 继续发。
      if (estimatedBytes > RENDERER_ACTION_TRACE_MAX_BATCH_BYTES) {
        if (spans.length === 0) {
          this.completedQueue.shift();
          this.droppedSinceLastFlush += 1;
          continue;
        }
        break;
      }
      spans.push(candidate);
      this.completedQueue.shift();
    }
    return spans;
  }
}

// 模块级默认实现是 NOOP：未接入采集的环境（单测、Storybook）无需显式初始化也不会抛错。
let activeUserActionTelemetry: UserActionTelemetry = {
  start: () => NOOP_ACTION_HANDLE,
};

// 传 null 表示复位为 NOOP，而不是禁用写入；调用方不需要自己保存一个空实现。
export function setUserActionTelemetry(telemetry: UserActionTelemetry | null): void {
  activeUserActionTelemetry = telemetry ?? { start: () => NOOP_ACTION_HANDLE };
}

export function startUserAction(input: StartUserActionInput): UserActionHandle {
  return activeUserActionTelemetry.start(input);
}

// 包装异步操作的便捷入口：成功按 completed 结算，失败先 fail 再原样抛出，绝不吞异常。
// completed 支持函数形式，用于从返回值里提取结果维度；抛错发生在结算之后，不影响业务返回。
export async function runUserActionAsync<T>(options: {
  input: StartUserActionInput;
  operation: () => Promise<T>;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): Promise<T> {
  const handle = startUserAction(options.input);
  try {
    const value = await options.operation();
    handle.complete(
      typeof options.completed === "function" ? options.completed(value) : options.completed,
    );
    return value;
  } catch (error) {
    handle.fail({ failureStage: options.failureStage });
    throw error;
  }
}

// 同步版本与异步版本保持同一套结算语义，唯一区别是不 await；两者不要分叉出不同的失败处理。
// 同步操作里抛错同样走 fail 分支，failureStage 由调用方给出，不能由这里猜测。
export function runUserAction<T>(options: {
  input: StartUserActionInput;
  operation: () => T;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): T {
  const handle = startUserAction(options.input);
  try {
    const value = options.operation();
    handle.complete(
      typeof options.completed === "function" ? options.completed(value) : options.completed,
    );
    return value;
  } catch (error) {
    handle.fail({ failureStage: options.failureStage });
    throw error;
  }
}

// 优先 performance 时间基准再叠加 now，得到接近墙钟又不随系统校时跳变的时间；环境不支持时退回 Date.now。
function defaultNow(): number {
  return typeof performance !== "undefined"
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

// 把随机字节转成小写十六进制；8 字节与 16 字节分别对应 spanId 与 traceId 的长度契约。
function randomHex(bytes: 8 | 16): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}
