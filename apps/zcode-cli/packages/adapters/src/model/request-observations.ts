// ============================================================
// 模型请求观测暂存（按 requestId 的记录缓冲）
// 定位：fetch 包装层写观测，执行器按 requestId 取走并并入错误/遥测；跨请求不共享。
// 输入输出：record 追加；take 返回数组并删除条目（未记录返回空数组）。
// 副作用：内存 Map 读写（有界 LRU：最多 64 个 requestId）。
// 失败语义：不抛错；溢出时静默淘汰最旧 requestId。
// 不变量：take 后条目必须消失，保证同一请求不会被重复消费；淘汰粒度是整个 requestId。
// ============================================================

import type { ModelRequestObservation } from "@zcode/contracts";

const MAX_TRACKED_REQUESTS = 64;

/**
 * 有界观测缓冲。record 在条目不存在时先按插入顺序淘汰最旧 requestId，
 * 保证长时间进程不会因未 take 的请求无限增长；淘汰丢的是整组观测而非单条。
 */
export class RequestObservationStore {
  private readonly entries = new Map<string, ModelRequestObservation[]>();

  /**
   * 追加一条观测。requestId 首次出现时若已达上限，先淘汰最旧键（Map 迭代序即插入序）；
   * 已存在则只 push，不刷新顺序，因此"最旧"始终指最早出现的 requestId。
   */
  record(requestId: string, observation: ModelRequestObservation): void {
    let observations = this.entries.get(requestId);
    if (!observations) {
      if (this.entries.size >= MAX_TRACKED_REQUESTS) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      observations = [];
      this.entries.set(requestId, observations);
    }
    observations.push(observation);
  }

  /** 取走某 requestId 的全部观测并删除条目；从未记录时返回空数组，调用方无需判空指针。 */
  take(requestId: string): ModelRequestObservation[] {
    const observations = this.entries.get(requestId) ?? [];
    this.entries.delete(requestId);
    return observations;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * 从 init.headers 或 Request 自带 headers 读取 x-request-id（init 优先）。
 * 返回 undefined 表示该请求未被外部打标，属正常情况；不做生成、不补写，避免伪造关联 id。
 */
export function readRequestObservationId(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): string | undefined {
  const fromInit = init?.headers ? new Headers(init.headers).get("x-request-id") : null;
  const value = fromInit ?? (input instanceof Request ? input.headers.get("x-request-id") : null);
  return value?.trim() || undefined;
}
