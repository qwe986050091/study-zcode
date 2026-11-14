// ============================================================
// workspace hook review flow 的监管循环（唯一的 await 点）
// ============================================================
// 每开一个 flow（requestReview 或 revoke 后重开）都必须交给这里；否则 deadline 到期后 flow 在
// registry 内静默 timed_out，前端收不到 ReviewSettled，面板会一直按 pending 渲染。
// supersede 时沿 registry 的当前 flow 继续跟，直到某一代真正终结才返回。

import { SessionEventType } from "@zcode/contracts";
import type { WorkspaceHookReviewFlow, WorkspaceHookReviewFlowRegistry } from "@zcode/core";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";

/**
 * 监管一个 review flow 直到它终结：跟随 supersede 链，并在 timeout 时补齐
 * telemetry 与 ReviewSettled。
 *
 * 这段逻辑是**唯一** await flow.result 的地方：若无人 await，它的 10 分钟 deadline 到期后会在 registry
 * 内静默 settle 成 timed_out，前端收不到 ReviewSettled、面板继续按 pending 渲染，
 * 之后每次点击都被 registry.validate 判为 workspace_hooks_review_superseded
 * （实测连续 9 次点击全部被拒，且不会自动重开）。
 *
 * 抽成独立模块供 requestReview 与 revoke 后的重开路径共用：任何新开 flow 的入口都必须
 * 交给它监管，否则同样会产生无人看管的孤儿 flow。
 *
 * 返回 Promise<void>：正常终结或没有后继时 resolve；emit 失败会向上抛，由调用方决定是否
 * 记录——本函数不吞异常，也不自行重试。
 */
export async function superviseWorkspaceHookReviewFlow(input: {
  flow: WorkspaceHookReviewFlow;
  host: WorkspaceHookReviewHostPort;
  registry: WorkspaceHookReviewFlowRegistry;
  sessionId: string;
  telemetry: WorkspaceHookReviewTelemetry;
}): Promise<void> {
  let flow = input.flow;
  while (true) {
    const outcome = await flow.result;
    if (outcome.reasonCode === "workspace_hooks_review_superseded") {
      const current = input.registry.getCurrentFlow(input.sessionId);
      if (!current || current === flow) return;
      flow = current;
      continue;
    }
    if (outcome.reasonCode === "workspace_hooks_interaction_timeout") {
      input.telemetry.timeout(flow.request);
      await input.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: flow.request.interactionId,
          state: "timed_out",
          reasonCode: outcome.reasonCode,
        },
      });
    }
    return;
  }
}
