/**
 * ============================================================================
 * runtime/off-peak/model-binding.ts —— 闲时请求的凭据绑定与票据闸门
 * ============================================================================
 *
 * 【定位】把 off-peak 的动态凭据（requestAuth）和票据（ticketId）绑定到一次模型请求的
 *   ModelRequestDependencies 上：模型真正发起请求前先等票，失败若归因为票据过期则换票重试。
 *
 * 【三层事实】ticketId/requestAuth 只驻内存（动态凭据，绝不落盘）；AsyncLocalStorage 按
 * 请求记录"本次用了哪张票"，并发请求之间互不串票。
 *
 * 【不变量】
 *   1) 同一 dependencies 只对应一个 binding（WeakMap 绑定），release 后不可再用；
 *   2) 解析出的凭据必须与本次记录的票一致，否则递归重新解析（防止解析期间换票）；
 *   3) 只重试"归因为本 provider + 约定期过期错误码"的失败，其它错误原样抛出；
 *   4) 流式请求一旦已交付内容，绝不在此层重试（交给既有流恢复路径）。
 * ============================================================================
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Model,
  ModelRequestAuth,
  ModelRequestAuthSource,
  ModelRequestDependencies,
} from "@zcode/contracts";
import { projectExecutionErrorPayload } from "../helpers/turn-errors.js";
import type { OffPeakLifecycle } from "./lifecycle.js";

/**
 * 一次闲时执行对模型请求的绑定。
 *
 * 字段口径：
 *   - requestDependencies：注入到 modelExecution 的依赖对象，核心是 requestAuth.source.resolve
 *     （每次请求前等票 + 取凭据）；同时作为 WeakMap 的 key；
 *   - wrap：包装原 Model，拦截 generateText/streamText 加上"等票 + 过期换票重试"；
 *     bind 递归包装，保证派生 model 仍带闸门；
 *   - release：释放本轮模型占用（幂等）；释放后再发起请求会抛 off_peak_round_completed。
 */
export interface OffPeakModelBinding {
  readonly requestDependencies: ModelRequestDependencies;
  wrap(model: Model): Model;
  release(): void;
}

/**
 * 依赖对象 → 绑定的弱引用索引。
 *
 * 用 WeakMap 而非 Map：绑定随请求依赖一起被回收，不会因长时间会话泄漏；
 * 同一个 dependencies 在生命周期内只应有一个 binding（createBinding 每次新建，
 * 调用方必须保证不复用旧 dependencies）。
 */
const bindings = new WeakMap<ModelRequestDependencies, OffPeakModelBinding>();
/**
 * 按请求依赖查回绑定（turn 接管刷新时用它 release 旧绑定）。
 *
 * 输入：可选 dependencies。输出：对应绑定或 undefined。
 * 注意：查不到不代表"没有闲时执行"，只表示该 dependencies 不是由 off-peak 创建的。
 */
export function getOffPeakModelBinding(
  dependencies?: ModelRequestDependencies,
): OffPeakModelBinding | undefined {
  return dependencies ? bindings.get(dependencies) : undefined;
}

/**
 * 闲时票据与动态凭据的唯一持有者。
 *
 * 职责：把 lifecycle 的"票"语义翻译成模型请求可用的 requestAuth.source；
 *   并在票据过期、Host 下发新票后同步替换内存凭据。
 * 字段口径：
 *   - ticketId：当前有效票（与 lifecycle 持有的票保持同步；替换前先等 lifecycle 确认）；
 *   - requestAuth：动态凭据的**深拷贝**，仅驻内存、不落盘、不与其他请求共享引用；
 *   - attempts：AsyncLocalStorage，按请求记录本次使用的 ticketId，供重试判定归属，
 *     避免并发请求把旧票的错误错误地归到新票上。
 */
/** 动态凭据仅驻内存；一次请求的票据记录隔离，避免并发请求把旧票错误归到新票。 */
export class OffPeakTicketAuthority {
  private ticketId: string;
  private requestAuth: ModelRequestAuth | undefined;
  private readonly attempts = new AsyncLocalStorage<{ ticketId: string }>();

/**
 * 创建票据权威。
 *
 * 输入：lifecycle（票状态机）+ initial（初始票、可选凭据与凭据解析源、
 *   providerId、用于识别"票据过期"的 providerErrorCode）。
 * 副作用：深拷贝初始 requestAuth（避免外部后续修改影响已装机凭据）；不发事件。
 */
  constructor(
    private readonly lifecycle: OffPeakLifecycle,
    private readonly initial: {
      ticketId: string;
      requestAuth?: ModelRequestAuth;
      requestAuthSource?: ModelRequestAuthSource;
      providerId: string;
      providerErrorCode: string;
    },
  ) {
    this.ticketId = initial.ticketId;
    this.requestAuth = initial.requestAuth && structuredClone(initial.requestAuth);
  }

/**
 * 安装 Host 下发的新票与新凭据。
 *
 * 输入：renewalId（lifecycle 换票序号）、ticketId、auth（新动态凭据）。
 * 输出：true = 已安装；false = lifecycle 拒绝（序号不匹配/终态/接管/同票）。
 * 顺序不变量：先让 lifecycle.replaceTicket 成功（它会同步 resolve 等票者），
 *   再更新本对象的 ticketId/requestAuth —— 保证等待方恢复时看到的是完整的"新票 + 新凭据"，
 *   绝不暴露"票已换、凭据未换"的中间态。
 * 副作用：深拷贝 auth 并替换内存凭据。
 */
  replaceTicket(renewalId: number, ticketId: string, auth: ModelRequestAuth): boolean {
    if (!this.lifecycle.replaceTicket(renewalId, ticketId)) return false;
    // replaceTicket 只同步解决 Promise；等待方恢复之前安装新凭据，不暴露半更新状态。
    this.ticketId = ticketId;
    this.requestAuth = structuredClone(auth);
    return true;
  }

/**
 * 为一次 turn 创建绑定（持有本轮票据占用，直到 release）。
 *
 * 输出：OffPeakModelBinding（同时登进 bindings WeakMap）。
 * 关键实现：
 *   - requestAuth.source.resolve：先检查 release，再 waitForTicket；票与 authority 不一致
 *     → off_peak_ticket_mismatch；记录到 AsyncLocalStorage；取内存凭据或按需调用
 *     initial.requestAuthSource.resolve；若解析期间又换票，递归重新解析，保证凭据与票同代；
 *   - retryExpired：只在未 abort、且错误归因为本 provider + 约定错误码时判定；
 *     旧请求晚于换票失败 → 直接 true（用当前票重试，不再申请/释放新票）；
 *     否则走 lifecycle.ticketExpired 申请换票，返回是否成功；
 *   - generateText：循环"等票 → 带票据上下文执行 → 失败且可重试则继续"；
 *   - streamText：同上，但一旦 delivered=true 就不再重试；finally 先 abort 底层请求，
 *     再独立异步清理 iterator（清理失败被吞掉，不能覆盖原错误或卡住换票）；
 *   - release：幂等，释放 lifecycle 的模型轮次占用。
 * 副作用：注册 WeakMap、执行 lifecycle.waitForTicket/ticketExpired、可能换票。
 */
  createBinding(): OffPeakModelBinding {
    const lease = this.lifecycle.retainIdleModelRound();
    let released = false;
    const requestDependencies: ModelRequestDependencies = {
      requestAuth: {
        source: {
          resolve: async (input) => {
            if (released) throw new Error("off_peak_round_completed");
            const ticketId = await this.lifecycle.waitForTicket(input.abortSignal);
            if (ticketId !== this.ticketId) throw new Error("off_peak_ticket_mismatch");
            const attempt = this.attempts.getStore();
            if (attempt) attempt.ticketId = ticketId;
            const auth = this.requestAuth ?? (await this.initial.requestAuthSource?.resolve(input));
            if (!auth) throw new Error("off_peak_request_auth_missing");
            // 解析初始鉴权期间可能换票；返回和本次记录相同票据的材料。
            if (ticketId !== this.ticketId)
              return requestDependencies.requestAuth!.source!.resolve(input);
            return structuredClone(auth);
          },
        },
      },
    };
    /**
     * 判断一次失败是否值得"换票后重试"（闭包，绑定本次 binding 的 initial 配置）。
     *
     * 输入：error、本次请求记录的 ticketId、可选 abortSignal。
     * 输出：true = 外层应继续下一轮（重新等票）；false = 原样抛出。
     * 判定：已 abort → false；归因 provider/错误码不匹配 → false；
     *   若票已被换走且尚未接管/终态 → true（旧请求直接用新票重试）；
     *   否则调用 lifecycle.ticketExpired 申请换票，是否受理决定返回值。
     */
    const retryExpired = (error: unknown, ticketId: string, signal?: AbortSignal): boolean => {
      if (signal?.aborted) return false;
      const attribution = projectExecutionErrorPayload(error).attribution;
      if (
        attribution?.providerId !== this.initial.providerId ||
        attribution.providerErrorCode !== this.initial.providerErrorCode
      )
        return false;
      // 旧请求晚于换票失败时直接用当前票重试，不再次申请或释放新票。
      if (ticketId !== this.ticketId && !this.lifecycle.ownedByUser && !this.lifecycle.terminal)
        return true;
      return this.lifecycle.ticketExpired(ticketId) !== undefined;
    };
    const { lifecycle, attempts } = this;
    /**
     * 包装模型：保留全部元数据，只拦截真正发起请求的两个方法。
     *
     * 输出：冻结的 Model 副本。bind 递归调用 wrap，保证派生后的 model 仍带票据闸门；
     *   providerId/modelId/properties/optionSpecs/options 原样透传，不影响请求构造与限额推导。
     */
    const wrap = (model: Model): Model =>
      Object.freeze<Model>({
        providerId: model.providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        properties: model.properties,
        optionSpecs: model.optionSpecs,
        options: model.options,
        bind: (options) => wrap(model.bind(options)),
        async generateText(request) {
          while (true) {
            if (released) throw new Error("off_peak_round_completed");
            const attempt = {
              ticketId: await lifecycle.waitForTicket(request.abortSignal),
            };
            try {
              return await attempts.run(attempt, () => model.generateText(request));
            } catch (error) {
              if (!retryExpired(error, attempt.ticketId, request.abortSignal)) throw error;
            }
          }
        },
        async *streamText(request) {
          while (true) {
            if (released) throw new Error("off_peak_round_completed");
            const attempt = {
              ticketId: await lifecycle.waitForTicket(request.abortSignal),
            };
            const controller = new AbortController();
            const abortSignal = request.abortSignal
              ? AbortSignal.any([request.abortSignal, controller.signal])
              : controller.signal;
            const iterator = model.streamText({ ...request, abortSignal })[Symbol.asyncIterator]();
            let delivered = false;
            try {
              while (true) {
                const next = await attempts.run(attempt, () => iterator.next());
                if (next.done) return;
                delivered = true;
                yield next.value;
              }
            } catch (error) {
              // 已交付内容由既有流恢复路径处理；这里仅重试未产生任何输出的拒绝请求。
              if (delivered || !retryExpired(error, attempt.ticketId, request.abortSignal))
                throw error;
            } finally {
              // 关闭迭代器可能拒绝或永不结束，曾覆盖原错误并卡住换票。
              // 先取消底层请求，再独立清理；清理不能控制请求结果与生命周期收口。
              controller.abort();
              void Promise.resolve()
                .then(() => attempts.run(attempt, () => iterator.return?.()))
                .catch(() => {});
            }
          }
        },
      });
    /**
     * 绑定对象：依赖注入 + 模型包装 + 幂等释放。
     *
     * release 只置一次性标记并释放 lifecycle 的模型轮次，不撤销已发出的请求；
     * 再次调用直接返回（幂等）。
     */
    const binding: OffPeakModelBinding = {
      requestDependencies,
      wrap,
      release() {
        if (released) return;
        released = true;
        lease.release();
      },
    };
    bindings.set(requestDependencies, binding);
    return binding;
  }
}
