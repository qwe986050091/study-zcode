// 插件 UI 沙箱登记桥的实现（Host 侧）。
//
// 职责：为每次 UI 沙箱登记生成 requestId，通过 inject 的 send 发往 Main，并把 Main 回包
// 按 requestId 解析成 PluginSandboxHandle。
// 输入输出：输入 send 与可选 createRequestId；输出 register / accept / dispose。
// 副作用：调用 send（postMessage）；向 pending Map 写入等待项。
// 失败语义：bridge 已 dispose 时 register 直接 reject；send 抛错时同步删除 pending 并 reject；
// accept 对未知 requestId 静默忽略（迟到或重复回包不得影响其他请求）。
// 维护的不变量：请求/响应/关闭共享同一生命周期，只有一个 pending Map；dispose 必须给所有
// 未完成登记一个明确终态（reject），否则 Host 退出时调用方 Promise 永久悬空。

import { HostResponseTypes } from "@zcode/shared";
import type {
  PluginSandboxHandle,
  PluginSandboxRegisterRequestPayload,
} from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type { PluginSandboxRegistrationBridge } from "./contract.js";

// 创建登记桥。
// 状态：pending（requestId → resolve/reject）与 closed 标志；没有第二个缓存或重试队列。
// 输出：PluginSandboxRegistrationBridge；createRequestId 可注入以便测试可预测 requestId。
// 失败语义：closed 后 register 立即 reject；dispose 后 accept 因 pending 已清而自然 no-op。
/** 请求/响应/关闭共享同一生命周期，入口不再维护第二处 pending Map。 */
export function createPluginSandboxRegistrationBridge(deps: {
  send(
    message: PluginSandboxRegisterRequestPayload & { type: "plugin-sandbox-register-request" },
  ): void;
  createRequestId?: () => string;
}): PluginSandboxRegistrationBridge {
  const pending = new Map<
    string,
    { resolve(handle: PluginSandboxHandle): void; reject(error: Error): void }
  >();
  let closed = false;
  return {
    // 发起一次登记请求。
    // 先登记 pending 再 send：Main 的回包可能在 send 返回前到达（同进程/同步调度），
    // 顺序反过来会出现「回包找不到 pending」的竞态丢结果。
    // 失败语义：closed → reject；send 抛错 → 删除 pending 并 reject（不带半条记录）。
    register(input) {
      if (closed) return Promise.reject(new Error("Plugin sandbox registration bridge closed"));
      const requestId = (deps.createRequestId ?? randomUUID)();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try {
          deps.send({ type: HostResponseTypes.PluginSandboxRegisterRequest, requestId, ...input });
        } catch (error) {
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    // 消费 Main 回包：requestId 命中才处理，处理后立即删除。
    // ok=true 但缺任一必填字段视为失败（用 result.error 兜底文案），防止半成品 handle
    // 流入 renderer；resourceMeta 仅在存在时展开，避免 undefined 键。
    // 失败语义：未知 requestId 直接 return（不抛错）。
    accept(result) {
      const request = pending.get(result.requestId);
      if (!request) return;
      pending.delete(result.requestId);
      if (
        result.ok &&
        result.instance &&
        result.sandboxId &&
        result.initId !== undefined &&
        result.shellUrl &&
        result.partition
      ) {
        request.resolve({
          instance: result.instance,
          sandboxId: result.sandboxId,
          initId: result.initId,
          shellUrl: result.shellUrl,
          partition: result.partition,
          // 资源级尺寸 / 边框提示原样回 renderer。
          ...(result.resourceMeta ? { resourceMeta: result.resourceMeta } : {}),
        });
      } else request.reject(new Error(result.error ?? "插件 UI 沙箱登记失败"));
    },
    // 关闭桥：置 closed 并 reject 全部未完成登记，然后清表。
    // 先置 closed 再遍历，保证遍历期间新来的 register 也被拒绝。
    // 失败语义：不抛出；重复 dispose 时空表循环不执行，安全幂等。
    dispose() {
      // 修复：原 Host 退出只释放 services，未完成的登记 Promise 没有明确终态。
      closed = true;
      for (const request of pending.values())
        request.reject(new Error("Plugin sandbox registration bridge closed"));
      pending.clear();
    },
  };
}
