import { randomUUID } from "node:crypto";
import type {
  CoordinatorResponsePort,
  CoordinatorResponseResult,
  SessionId,
} from "@zcode/contracts";
import type { EnqueueSubagentMessageInput } from "../runtime/types.js";

// 构造 coordinator 响应端口的依赖项；全部由调用方（子 agent runtime）注入。
export interface CreateCoordinatorResponsePortOptions {
  // 子 agent 实例 id，写入入队消息用于反查归属。
  agentId: string;
  // 子 agent 类型名，供父级展示来源类型。
  agentType: string;
  // 子 agent 会话 id，入队后由父级路由到正确会话。
  childSessionId: SessionId;
  // 触发该子 agent 的父 tool call id；undefined 时消息不携带该字段而非空串。
  parentToolCallId?: string;
  // 响应 id 生成器（测试可替换）；undefined 时退化为 `response_<uuid>`。
  createResponseId?: () => string;
  // void 会接受 async callback；undefined 才能让类型系统守住同步入队 ack。
  enqueue(input: EnqueueSubagentMessageInput): undefined;
}

// 创建子 agent 向 coordinator（父会话）回传结果的端口适配器。
// 输入：依赖项 + 每次 respond 的请求内容；输出：同步返回的排队结果。
// 副作用：通过 enqueue 把消息写入父级队列（唯一外部副作用），不直接触发网络或落盘。
// 失败语义：入队抛出异常会被捕获并转成 status="failed" + error 文案，
// 调用方（模型侧工具）因此总能拿到结构化结果，不会因异常中断 turn。
export function createCoordinatorResponsePort(
  options: CreateCoordinatorResponsePortOptions,
): CoordinatorResponsePort {
  return {
    respond(request): CoordinatorResponseResult {
      // 先确定 responseId：即使入队失败也返回它，便于上层关联失败尝试。
      const responseId = options.createResponseId?.() ?? `response_${randomUUID()}`;
      try {
        options.enqueue({
          responseId,
          agentId: options.agentId,
          agentType: options.agentType,
          childSessionId: options.childSessionId,
          // 工具调用 id 统一转字符串，避免上游不同 id 类型在队列里产生两套键。
          childToolCallId: String(request.childToolCallId),
          ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
          summary: request.summary,
          message: request.message,
          traceContext: request.trace,
        });
        return {
          status: "success",
          responseId,
          message: "Response was queued for the coordinator.",
        };
      } catch (error) {
        // 入队失败不外抛：转为结构化失败结果，保留原始错误文案供上层排查。
        return {
          status: "failed",
          responseId,
          message: "Response could not be queued for the coordinator.",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
