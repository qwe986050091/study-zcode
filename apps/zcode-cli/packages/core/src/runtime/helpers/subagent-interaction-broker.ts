import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

/**
 * 子代理交互 broker 的构造上下文。
 * parentSessionId 是请求的最终路由目标（父/根会话），用于让父界面弹窗；
 * parentToolCallId 是发起该子代理的父工具调用（可缺省，用于 UI 关联与日志）。
 * turnId 等其余字段来自 SubagentInteractionOriginContext，仅作来源归属。
 */
export interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

type BrokerResponse = ReturnType<PermissionBrokerPort["requestPermission"]>;

/**
 * 构造只做"路由 + 归属"的 broker 包装：请求转发给父 broker，sessionId 指向父会话，
 * origin 缺省时补成子代理来源。
 *
 * 输入：父 broker（可继续叠加本包装）、子代理上下文。
 * 输出：满足 PermissionBrokerPort 的新 broker（仅 requestPermission）。
 * 副作用：无本地状态、不落盘；真正的请求/等待/超时仍由父 broker 承担。
 * 失败语义：父 broker 的 reject/超时原样透传，本层不 catch、不重试、不包装错误。
 * 不变量：必须同步返回父 broker 的原始响应对象（含 registered 等挂在 Promise 上的属性），
 *   不得改 async 或 .then 重包，否则会丢失信号并制造"弹窗可见但 deferred 未登记"的竞态。
 */
export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): BrokerResponse {
      // 修复原因：子 agent 的 permission / AskUserQuestion / ExitPlanMode 都需要父 task 的 UI 响应；
      // broker request 对外路由到父 session，origin 保留 child 归属，便于 UI 与日志识别来源。
      // 契约（2026-09-17 review）：registered 只是挂在 Promise 上的属性；本函数必须原样返回父 broker 的
      // 响应对象，不得改成 async 或加 .then 重新包装，否则信号静默丢失、executor 退回同步登记假设并
      // 重新引入"确认窗可见但 deferred 未登记"的竞态。subagent-interaction-broker.test.ts 守护该同一性。
      //
      // 本包装可以叠加。`sessionId` 由**外层**（离客户端更近的一层）
      // 最后改写，所以任意深度最终都落到根会话；`origin` 反过来保留**内层**已有值，
      // 归属永远是真正发起请求的那个子代理，不会被外层覆盖成中间层。
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: request.origin ?? buildSubagentInteractionOrigin(context, request.turnId),
        },
        options,
      );
    },
  };
}
