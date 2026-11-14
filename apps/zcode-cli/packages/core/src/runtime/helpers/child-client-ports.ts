// ============================================================
// child runtime 的「对外交互」端口派生（唯一出口）
// ============================================================
//
// 子 runtime 有两条会话身份轴：
//   账本身份 sessionId —— 事件持久化 / transcript / trace / session store，子用自己的；
//   路由身份         —— 一切 agent → app 反向请求（permission、AskUserQuestion、provider
//                        runtime headers），子必须用父的，直到根会话。
// 客户端只认识根会话；拿子会话去问，桌面侧找不到 session，response 永不发出，子代理挂死。
//
// 过去这条规则散在各 child 装配点：core 的 subagent 包了两层私有 wrapper，dwf actor 与 legacy
// workflow child 直接透传 appOptions 的端口——于是两处错、一处对。这里把派生收敛成一处，并由
// **父 runtime** 调用（`AgentRuntime.createChildClientPorts`），`parentSessionId` 由父自己填，
// 调用方给不了错的值。

import type { PermissionBrokerPort, SessionId } from "../deps.js";
import type { ProviderRuntimeHeadersPort } from "../types.js";
import type { SubagentInteractionOriginContext } from "../../subagent/interaction-origin.js";
import { createSubagentInteractionBroker } from "./subagent-interaction-broker.js";

/**
 * 一个 runtime 面向协议客户端的端口集合。
 *
 * 字段口径：
 * - permissionBroker：agent → app 的权限/交互请求通道；子 runtime 必须改写成父会话路由。
 * - providerRuntimeHeadersPort：模型请求前刷新鉴权/路由 header 的通道；同样按父会话路由。
 *
 * 两个字段都是可选的：未注入端口的场景（纯本地/测试）不派生，也不伪造空实现，
 * 由调用方自行判断"没有客户端交互能力"。
 */
/** 一个 runtime 面向协议客户端的端口集合。 */
export interface ClientFacingPorts {
  permissionBroker?: PermissionBrokerPort;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
}

/**
 * 铸造一个 child 所需的归属信息。`parentSessionId` 不在这里——它只能由父 runtime 提供，
 * 这正是「路由身份选不错」的机械保证。
 *
 * 口径：origin（子代理归属/交互来源）由装配点传入，但父会话 id 由父 runtime 自己填，
 * 调用方即使拿到子会话也无法把它当成路由身份。无副作用（纯类型约束）。
 */
export type ChildClientPortsContext = Omit<SubagentInteractionOriginContext, "parentSessionId">;

/**
 * 由父的对外端口派生子的对外端口。
 *
 * - `providerRuntimeHeadersPort`：包一层把入参的 `sessionId` 改写成父会话（主 runtime 报自己的
 *   会话，见 methods/model-runtime-headers.ts）。多层嵌套时**外层后写**（离客户端更近的一层最后
 *   执行），最终值必然是根会话。
 * - `permissionBroker`：包一层改写 `request.sessionId`，同样外层后写；`origin` 则保留最内层已有值，
 *   子代理归属不被外层抹掉。
 *
 * 输入：parent 是父 runtime 当前对外端口；context 是子的归属 + 父会话 id。
 * 输出：新的端口对象；父端口缺失时对应字段直接省略（不构造空实现）。
 * 不变量：子拿到的路由身份恒为父会话；账本身份（事件/transcript）仍由子 runtime 自己使用
 * 自己的 sessionId。副作用：无；返回的是包装后的新对象。
 */
export function deriveChildClientPorts(
  parent: ClientFacingPorts,
  context: ChildClientPortsContext & { parentSessionId: SessionId },
): ClientFacingPorts {
  return {
    ...(parent.permissionBroker === undefined
      ? {}
      : { permissionBroker: createSubagentInteractionBroker(parent.permissionBroker, context) }),
    ...(parent.providerRuntimeHeadersPort === undefined
      ? {}
      : {
          providerRuntimeHeadersPort: rerouteProviderRuntimeHeadersPort(
            parent.providerRuntimeHeadersPort,
            context.parentSessionId,
          ),
        }),
  };
}

/**
 * provider runtime headers 是独立的反向协议请求，不经子事件镜像；子会话的 sessionId 只是 CLI
 * 内部账本，桌面端只订阅父 task 的会话，所以刷新账号凭据 header 时必须用父会话路由。服务层会
 * 识别请求模型与父会话当前模型是否一致，不一致时只同步本次 header，不把父会话切到子模型。
 *
 * 字段口径：
 * - shouldRefreshBeforeModelRequest：透传父实现；父未实现时默认 true（宁可多刷新一次，
 *   避免用过期凭据发起请求）。
 * - refreshBeforeModelRequest：强制用父会话 id 覆盖 input.sessionId，其余参数原样透传。
 * 副作用：refresh 会触发一次真实的凭证/路由同步；本身不写本地会话状态。
 */
function rerouteProviderRuntimeHeadersPort(
  parentPort: ProviderRuntimeHeadersPort,
  parentSessionId: SessionId,
): ProviderRuntimeHeadersPort {
  return {
    shouldRefreshBeforeModelRequest(input) {
      return parentPort.shouldRefreshBeforeModelRequest?.(input) ?? true;
    },
    refreshBeforeModelRequest(input) {
      return parentPort.refreshBeforeModelRequest({ ...input, sessionId: parentSessionId });
    },
  };
}
