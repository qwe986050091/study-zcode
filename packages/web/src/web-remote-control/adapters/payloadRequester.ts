// INV-01 仅可恢复失败才重试：守住位置 原因判断；改错故障 参数错误被反复重放。
// INV-02 超时默认不恢复：守住位置 严格相等；改错故障 普通超时也触发重连。
// INV-03 并发失败共用一次恢复：守住位置 单例承诺；改错故障 抖动被放大成连续重连。
// INV-04 恢复完成后清空单例：守住位置 收尾回调；改错故障 后续请求永远等待旧承诺。
// INV-05 重试只做一次：守住位置 二次调用无保护；改错故障 无限重试打爆链路。
// INV-06 超时时同时清理挂起项：守住位置 删除顺序；改错故障 超时后仍占内存。
// INV-07 超时失败带固定原因：守住位置 失败构造函数；改错故障 上层无法区分超时。
// INV-08 默认超时十秒：守住位置 解构默认值；改错故障 未配置时立刻失败。
// INV-09 单请求超时可覆盖默认：守住位置 空值合并；改错故障 调用方设置被忽略。
// INV-10 发送失败立即清理：守住位置 清理调用；改错故障 请求等满超时才报错。
// INV-11 发送失败按链路不可用上报：守住位置 失败原因；改错故障 上层误判桌面无响应。
// INV-12 挂起表以请求标识为键：守住位置 映射键；改错故障 同标识请求互相覆盖。
// INV-13 响应按匹配函数判定归属：守住位置 类型守卫；改错故障 错误响应被当成目标。
// INV-14 命中后先清定时器再出表：守住位置 语句顺序；改错故障 已决请求仍被超时拒绝。
// INV-15 错误响应只消费真正挂起项：守住位置 命中判断；改错故障 合成错误吃掉他人响应。
// INV-16 未命中返回假：守住位置 默认返回；改错故障 上层误以为已消费。
// INV-17 全量拒绝逐项清理：守住位置 遍历删除；改错故障 断线后挂起项泄漏。
// INV-18 销毁按断连原因拒绝：守住位置 失败原因；改错故障 关闭时上报错误原因。
//
// 模块职责：Web 远控请求的挂起表、超时与链路恢复重试。
// 状态所有权：挂起映射与恢复承诺由工厂闭包持有。
// 阅读顺序：先看可恢复判定与恢复单例，再看请求发起与失败清理，最后看响应消费。
import type { WebRemoteControlAppPayload, WebRemoteControlFailure } from "@zcode/shared";
import { createFailure } from "#src/web-remote-control/adapters/relayMessage.js";

interface WebRemoteControlAppPayloadRequesterOptions {
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  timeoutMs?: number;
}

interface WebRemoteControlAppPayloadRequestOptions {
  timeoutMs?: number;
}

interface PendingAppPayloadRequest<TResponse extends WebRemoteControlAppPayload> {
  isMatch(payload: WebRemoteControlAppPayload): payload is TResponse;
  resolve(payload: TResponse): void;
  reject(error: WebRemoteControlFailure): void;
  timer: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlRelayRequestRecoveryOptions {
  recoverTimeout?: boolean;
}

// 只有 relay-unavailable 与 desktop-bootstrap-timeout 两种 reason 可恢复。
// recoverTimeout 显式为 true 时才恢复超时。
// 其余 failure.reason 一律原样抛出。
function isRecoverableRelayRequestFailure(
  error: unknown,
  options?: WebRemoteControlRelayRequestRecoveryOptions,
): boolean {
  const failure = error as Partial<WebRemoteControlFailure> | undefined;
  return (
    failure?.reason === "relay-unavailable" ||
    (options?.recoverTimeout === true && failure?.reason === "desktop-bootstrap-timeout")
  );
}

// recoveryPromise 只建一次，由 finally 清空。
// 并发请求共用 recoveryPromise 这一次恢复。
// finally 收尾时把 recoveryPromise 置为 undefined。
// 恢复失败后原 sender 请求重放一次。
export function createWebRemoteControlRelayRequestRecovery(recoverConnection: () => Promise<void>) {
  let recoveryPromise: Promise<void> | undefined;

  async function recoverRelayRequestPath(): Promise<void> {
    if (!recoveryPromise) {
      // Bugfix: 多个请求同时撞上 relay suspect 窗口时必须共用一次恢复。
      // 否则每个请求都会触发 recoverConnection，容易把短暂抖动放大成连续重连。
      recoveryPromise = recoverConnection().finally(() => {
        recoveryPromise = undefined;
      });
    }
    await recoveryPromise;
  }

  return async function requestWithRelayRecovery<T>(
    request: () => Promise<T>,
    options?: WebRemoteControlRelayRequestRecoveryOptions,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!isRecoverableRelayRequestFailure(error, options)) {
        throw error;
      }
      await recoverRelayRequestPath();
      return request();
    }
  };
}

// pending 挂起表以 requestId 为键。
// defaultTimeoutMs 默认 10_000 毫秒。
// 返回值只含 request 与 consume 等方法，另提供 reject 与 dispose。
export function createWebRemoteControlAppPayloadRequester({
  sendPayload,
  timeoutMs: defaultTimeoutMs = 10_000,
}: WebRemoteControlAppPayloadRequesterOptions) {
  const pending = new Map<string, PendingAppPayloadRequest<WebRemoteControlAppPayload>>();

  function rejectRequest(requestId: string, failure: WebRemoteControlFailure): boolean {
    const request = pending.get(requestId);
    if (!request) {
      return false;
    }
    clearTimeout(request.timer);
    pending.delete(requestId);
    request.reject(failure);
    return true;
  }

  return {
    requestAppPayload<TResponse extends WebRemoteControlAppPayload>(
      payload: WebRemoteControlAppPayload & { requestId: string },
      isMatch: (payload: WebRemoteControlAppPayload) => payload is TResponse,
      options?: WebRemoteControlAppPayloadRequestOptions,
    ): Promise<TResponse> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(payload.requestId);
          reject(createFailure("desktop-bootstrap-timeout", "Desktop did not respond in time."));
        }, options?.timeoutMs ?? defaultTimeoutMs);
        pending.set(payload.requestId, {
          isMatch,
          resolve: resolve as (payload: WebRemoteControlAppPayload) => void,
          reject,
          timer,
        });
        if (!sendPayload(payload)) {
          // Bugfix: 之前非 paired / suspect 状态下 sendPayload 会静默丢弃，
          // requester 仍等到超时并误报“桌面未响应”。这里立即按链路不可发送失败，
          // 让上层可以选择等待重连或重放幂等请求。
          clearTimeout(timer);
          pending.delete(payload.requestId);
          reject(
            createFailure(
              "relay-unavailable",
              "Web remote control transport is not ready to send payload.",
            ),
          );
        }
      });
    },

    acceptPayload(payload: WebRemoteControlAppPayload): boolean {
      if (
        (payload.zcode_type === "app-error" || payload.zcode_type === "workspace-bridge-error") &&
        payload.requestId
      ) {
        // Bugfix: remote session 关闭这类异步 bridge error 会带合成 requestId，
        // 但它不是某个 pending request 的响应。只有真正命中 pending 时才消费，
        // 否则交给上层按 bridge 失效事件触发重连/降级 UI。
        return rejectRequest(payload.requestId, createFailure(payload.reason, payload.error));
      }

      for (const [requestId, request] of pending) {
        if (!request.isMatch(payload)) {
          continue;
        }
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.resolve(payload);
        return true;
      }
      return false;
    },

    rejectAll(failure: WebRemoteControlFailure): void {
      for (const [requestId, request] of pending) {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(failure);
      }
    },

    dispose(): void {
      this.rejectAll(createFailure("desktop-disconnected", "Web remote control transport closed."));
    },
  };
}
