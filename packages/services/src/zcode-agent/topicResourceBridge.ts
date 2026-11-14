import {
  zcodeTopicResourceReadParamsSchema,
  zcodeTopicResourceReadResultSchema,
  type ZCodeTopicResourceReadParams,
  type ZCodeTopicResourceReadResult,
  type ZCodePromptAttachment,
  type ZCodeProtocolTrace,
} from "@zcode/shared";

// 单次资源读取的总时限：覆盖 validate、read、upload、再 validate 四段异步，
// 任一段卡住都会在 2 分钟后由同一个 AbortController 统一打断。
const RESOURCE_TIMEOUT_MS = 120_000;
export interface TopicResourceBridgeDependencies {
  validate(
    request: ZCodeTopicResourceReadParams,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<void>;
  read(
    request: ZCodeTopicResourceReadParams,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<ZCodePromptAttachment>;
  upload(
    request: ZCodeTopicResourceReadParams,
    attachment: ZCodePromptAttachment,
    signal: AbortSignal,
    trace?: ZCodeProtocolTrace,
  ): Promise<ZCodeTopicResourceReadResult>;
}

/** 每个实际 CLI 连接拥有独立取消域，不能取消另一工作区或另一任务的读取。 */
export function createTopicResourceBridge(
// [并发] 依赖允许惰性求值：调用时才解析到当前连接对应的实现，
// 避免桥在创建时就把某个 workspace 的 client 固化下来。
  dependencies: TopicResourceBridgeDependencies | (() => TopicResourceBridgeDependencies),
) {
// 进行中的请求按 requestId 登记，并附带 taskId 作为归属校验；
// 取消时必须同时匹配两者，否则可以取消别的任务。
  const pending = new Map<string, { taskId: string; controller: AbortController }>();
// 销毁后不再接受新请求，但在途请求由 dispose 逐个 abort，不会悬挂。
  let disposed = false;
  return {
    async read(value: unknown, trace?: ZCodeProtocolTrace): Promise<ZCodeTopicResourceReadResult> {
      const request = zcodeTopicResourceReadParamsSchema.parse(value);
// [失败路径] 已销毁的连接不再读取资源，直接拒绝而不是返回空结果。
      if (disposed) throw new Error("Topic resource connection is closed");
// [并发] 同 requestId 不允许并跑两次：否则两次读取会共享同一条清理路径，
// 先结束的一方会误删另一方的 controller。
      if (pending.has(request.requestId))
        throw new Error("Topic resource request is already active");
// 每个请求独立取消域：取消只影响本请求，不会波及同连接上的其他读取。
      const controller = new AbortController();
      pending.set(request.requestId, { taskId: request.taskId, controller });
// 超时与手动取消共用同一个 controller：下游只处理一种中止原因。
      const timer = setTimeout(
        () => controller.abort(new Error("Topic resource request timed out")),
        RESOURCE_TIMEOUT_MS,
      );
      try {
        // 固定本次请求的路由，异步下载期间不能被后续 workspace 访问改投其他 logical session。
// 依赖解析放在 try 内、首次 await 之前：解析本身失败也要走 finally 清理登记。
        const deps = typeof dependencies === "function" ? dependencies() : dependencies;
// read 只产出内存中的附件对象，不落盘；后续 upload 负责把它交给目标 CLI。
        const attachment = await deps.read(request, controller.signal, trace);
        controller.signal.throwIfAborted();
// upload 成功后才算拿到引用；此前的所有中间态都不对外暴露。
        const result = await deps.upload(request, attachment, controller.signal, trace);
        controller.signal.throwIfAborted();
        // 群可能在分块传输期间停用；返回引用前再核对授权，不暴露已失效请求的文件路径。
        await deps.validate(request, controller.signal, trace);
        // 授权检查也包含异步 IO，检查期间取消的请求不能再返回附件引用。
        controller.signal.throwIfAborted();
        return zcodeTopicResourceReadResultSchema.parse(result);
      } finally {
        clearTimeout(timer);
        pending.delete(request.requestId);
      }
    },
// [并发] 取消是幂等的：找不到或归属不符返回 false，调用方无需区分错误类型。
    cancel(request: { requestId: string; taskId: string }): boolean {
      const operation = pending.get(request.requestId);
      if (!operation || operation.taskId !== request.taskId) return false;
      operation.controller.abort(new Error("Topic resource request cancelled"));
      return true;
    },
// [顺序] dispose 先打断在途请求再清表：迟到的 finally 只会删已不存在的键，不影响新请求。
// 迟到的 finally 只会再删一次已不存在的键，不会影响新请求。
    dispose() {
      disposed = true;
      for (const operation of pending.values())
        operation.controller.abort(new Error("Topic resource connection closed"));
      pending.clear();
    },
  };
}
