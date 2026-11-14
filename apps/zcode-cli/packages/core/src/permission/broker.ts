// ============================================================
// Permission Broker - async client permission coordination
// ============================================================
// 职责：把工具执行期的权限询问挂起成 Promise，等客户端（TUI / V4）回填结果，
// 并在超时、取消、重复请求等异常路径上给出确定的失败语义。
// 状态所有权：pending Map 是未决请求的唯一所有者，settle/fail 之后必须立刻删除记录，
// 因此 resolvePermission 返回 false 代表"请求已不在等待中"，而不是"结果被丢弃"。
// 副作用：仅内存状态与定时器/abort 监听；不写盘、不发事件、不调用外部 IO。
// 失败语义：配置缺失抛 ConfigurationError；超时抛 PermissionTimeout；
// 取消抛 ToolCancelled；重复 requestId 抛 InvalidStateTransition。
// 不变量：同一个 Promise 只会 settle 一次；pending 中不存在已 settle 的记录。

import {
  CoreErrorType,
  createCoreError,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
} from "@zcode/contracts";

// 手动 broker 的可选钩子：requestPermission 时通知上层把请求呈现给用户。
// 钩子返回的 Promise 被拒绝时会立即 fail 对应请求，避免请求永久挂起。
export interface ManualPermissionBrokerOptions {
  onRequest?: (request: PermissionBrokerRequest) => Promise<void> | void;
}

// 未决请求的内部记录：request 用于回查展示，resolve/reject 已在 cleanUp 语义下包装，
// 直接调用即完成一次性结算。该结构不外泄，调用方只能通过 resolvePermission 操作。
interface PendingBrokerRecord {
  request: PermissionBrokerRequest;
  resolve: (result: PermissionBrokerResult) => void;
  reject: (error: Error) => void;
}

// 无客户端时的拒绝型 broker：普通请求直接返回 deny，guarded 模式则必须抛错。
// 之所以区分：guarded 表示调用点声明了"没有审批就不能继续"，静默拒绝会让上层丢错因。
// 无状态、可安全复用；所有请求都立即结算，不会留下 pending。
export class DenyPermissionBroker implements PermissionBrokerPort {
  // 返回 deny 时附带 reason 与 resolvedAt，保证结果结构与真实审批一致，调用方无需特判。
  async requestPermission(request: PermissionBrokerRequest): Promise<PermissionBrokerResult> {
    if (request.mode === "guarded") {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        `No permission client configured for ${request.toolName}`,
        { recoverable: true },
      );
    }
    return {
      decision: "deny",
      reason: `No permission client configured for ${request.toolName}`,
      resolvedAt: new Date(),
    };
  }
}

// 人工审批 broker：把每个权限请求登记进 pending，等待 resolvePermission / rejectPermission
// 或超时/取消来结算。实例生命周期内可并发处理多个请求，按 requestId 隔离。
// 非线程安全假设：单进程单事件循环内使用；pending 不对外暴露，只能整体列举。
export class ManualPermissionBroker implements PermissionBrokerPort {
  private readonly pending = new Map<string, PendingBrokerRecord>();

  // options.onRequest 会在此后的 requestPermission 中同步触发一次；
  // 构造阶段不校验回调，也不立即调用，保持构造无副作用。
  constructor(private readonly options: ManualPermissionBrokerOptions = {}) {}

  // 发起一次权限询问，返回的 Promise 只会 settle 一次。
  // options.timeoutMs 到期后 reject PermissionTimeout；signal 取消时 reject ToolCancelled。
  // 调用方必须保证 requestId 在实例内唯一，且拿到结果后不再复用同一 requestId。
  // 该调用会修改 pending 状态，属于有状态副作用；不要在紧接着的同步代码里依赖已登记结果。
  requestPermission(
    request: PermissionBrokerRequest,
    options?: PermissionBrokerRequestOptions,
  ): Promise<PermissionBrokerResult> {
    const key = request.requestId;
    // 重复 requestId 直接拒绝而不是覆盖：覆盖会让先前的等待者永远悬空，也破坏"一请求一结算"。
    if (this.pending.has(key)) {
      return Promise.reject(
        createCoreError(
          CoreErrorType.InvalidStateTransition,
          `Permission request already pending: ${key}`,
          {
            context: { requestId: key, toolCallId: request.toolCallId },
            recoverable: true,
          },
        ),
      );
    }

    return new Promise<PermissionBrokerResult>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      // 统一清理出口：定时器、abort 监听与 pending 记录必须一起撤销，
      // 否则残留监听会导致已结算请求在后续 abort 时再次进入 fail。
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        options?.signal?.removeEventListener("abort", abortHandler);
        this.pending.delete(key);
      };

      // settled 标志是防重入的关键：resolve 后立刻置位，后续任何 resolve/fail 都变成空操作。
      // resolvedAt 由 broker 补齐，保证客户端未提供时间戳时结果仍然可审计。
      const settle = (result: PermissionBrokerResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ...result,
          resolvedAt: result.resolvedAt ?? new Date(),
        });
      };

      // 失败路径与 settle 互斥；错误对象原样上抛，调用方按 CoreErrorType 分流处理。
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const abortHandler = () => {
        fail(
          createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
            context: { requestId: key, toolCallId: request.toolCallId, toolName: request.toolName },
            recoverable: true,
          }),
        );
      };

      // 已取消的 signal 不再登记 pending：先结算再返回，避免把死请求放进 Map。
      if (options?.signal?.aborted) {
        abortHandler();
        return;
      }

      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          fail(
            createCoreError(
              CoreErrorType.PermissionTimeout,
              `Permission request timed out after ${options.timeoutMs}ms`,
              {
                context: {
                  requestId: key,
                  timeoutMs: options.timeoutMs,
                  toolCallId: request.toolCallId,
                  toolName: request.toolName,
                },
                recoverable: true,
              },
            ),
          );
        }, options.timeoutMs);
      }

      // 先注册监听再写入 pending，保证从登记那一刻起取消就能命中；
      // 失败回调也走 fail，确保客户端呈现层出错不会留下悬空 Promise。
      options?.signal?.addEventListener("abort", abortHandler);
      this.pending.set(key, { request, resolve: settle, reject: fail });

      Promise.resolve(this.options.onRequest?.(request)).catch(fail);
    });
  }

  // 用 requestId 或 toolCallId 结算一个未决请求；返回 false 表示没有匹配的等待者。
  // 不抛错：客户端迟到回填属于正常竞态，调用方按 false 忽略即可。
  // 结算成功后记录立即从 pending 删除，重复调用同一 id 只会得到 false（幂等消费）。
  resolvePermission(requestIdOrToolCallId: string, result: PermissionBrokerResult): boolean {
    const record = this.findPendingRecord(requestIdOrToolCallId);
    if (!record) return false;

    record.resolve(result);
    return true;
  }

  // 以错误结算未决请求（客户端报错、连接断开等场景）；同样以 false 表示无匹配。
  // 传入的 Error 原样透传给等待方，本方法不做包装，保留原始堆栈与错误类型。
  rejectPermission(requestIdOrToolCallId: string, error: Error): boolean {
    const record = this.findPendingRecord(requestIdOrToolCallId);
    if (!record) return false;

    record.reject(error);
    return true;
  }

  // 只读查询：返回原始请求用于 UI 重绘/重连恢复，undefined 表示请求已结算或从未存在。
  // 不修改 pending，也不产生副作用；返回对象是内部引用，调用方不得据此修改状态。
  getPendingRequest(requestIdOrToolCallId: string): PermissionBrokerRequest | undefined {
    return this.findPendingRecord(requestIdOrToolCallId)?.request;
  }

  // 快照式列举当前未决请求（按插入顺序），供客户端启动时重建待办列表。
  // 返回新数组但元素仍是内部引用；列举期间若有请求结算，快照不会回删。
  listPendingRequests(): PermissionBrokerRequest[] {
    return Array.from(this.pending.values(), (record) => record.request);
  }

  // 双键查找：先按 requestId 精确命中，未命中再线性扫描 toolCallId。
  // 优先 requestId 是因为它才是 Map 主键；toolCallId 兜底用于客户端只拿到工具调用的场景。
  private findPendingRecord(requestIdOrToolCallId: string): PendingBrokerRecord | undefined {
    const direct = this.pending.get(requestIdOrToolCallId);
    if (direct) return direct;

    return Array.from(this.pending.values()).find(
      (record) => record.request.toolCallId === requestIdOrToolCallId,
    );
  }
}

// 工厂函数：返回无状态的拒绝型 broker，适合"未接入审批客户端"的默认装配。
export const createDenyPermissionBroker = (): PermissionBrokerPort => new DenyPermissionBroker();

// 工厂函数：创建人工审批 broker；每次调用产生独立实例与独立 pending 表，
// 调用方需自行持有实例以承接后续 resolve/reject，不要每次请求都新建。
export const createManualPermissionBroker = (
  options?: ManualPermissionBrokerOptions,
): ManualPermissionBroker => new ManualPermissionBroker(options);
