import type { TraceContext, TurnSteerInput, TurnSteerResult } from "@zcode/contracts";
import type { RuntimeTaskMessageSink } from "../runtime-task/registry.js";

interface SteerableRuntime {
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
}

// 创建 runtime task 消息 sink：把父级投递的消息 steer 进子 agent 当前 turn。
// 输入 runtime 只要求 steerTurn 能力，便于测试替换；request.traceContext 为缺省链路。
// 输出 send：成功返回 "steered"，被拒绝则抛错（由 registry 决定重试/失败归属）。
// 副作用：仅调用 runtime.steerTurn，不落盘、不发事件。
export function createSubagentMessageSink(
  runtime: SteerableRuntime,
  request: { traceContext: TraceContext },
): RuntimeTaskMessageSink {
  return {
    async send(message) {
      const result = await steerSubagentMessage(runtime, request, message);
      if (result.kind === "rejected") {
        throw new Error(`Subagent message rejected: ${result.reason}`);
      }
      return "steered";
    },
  };
}

// 尝试把消息 steer 进子 agent，当前没有活动 turn 时做有界重试。
// 重试策略：最多 20 次、每次间隔 10ms，总等待上限约 200ms；仅对
// reason="no_active_turn" 重试，其余拒绝原因立即返回，避免掩盖真实失败。
// 第 21 次为兜底调用（不再等待），保证返回最后一次权威结果而非合成的失败。
async function steerSubagentMessage(
  runtime: SteerableRuntime,
  request: { traceContext: TraceContext },
  message: { id: string; message: string; summary?: string; traceContext?: TraceContext },
): Promise<TurnSteerResult> {
  const input = formatSubagentCoordinatorMessage(message);
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runtime.steerTurn({
      delivery: "guide",
      inputPresentation: "coordinator_steer",
      input,
      inputId: message.id,
      traceContext: message.traceContext ?? request.traceContext,
    });
    // 只有“当前无活动 turn”值得等待；其它拒绝原因重试也不会改变结果。
    if (result.kind !== "rejected" || result.reason !== "no_active_turn") {
      return result;
    }
    await sleep(10);
  }
  return runtime.steerTurn({
    delivery: "guide",
    inputPresentation: "coordinator_steer",
    input,
    inputId: message.id,
    traceContext: message.traceContext ?? request.traceContext,
  });
}

// 把协调消息拼成最终 steer 文本：有 summary 时置于最前，空行分隔正文；
// summary 缺失或去空白为空则只投递正文，不产生前导空行。
function formatSubagentCoordinatorMessage(message: { message: string; summary?: string }): string {
  const summary = message.summary?.trim();
  if (!summary) return message.message;
  return [summary, "", message.message].join("\n");
}

// 最小异步等待工具；仅用于上述有界重试，不参与取消（由外层 turn 生命周期兜底）。
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
