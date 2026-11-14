// ============================================================
// runtime/methods/background-bash-output.ts —— 后台 Bash 输出的 runtime 薄转发
// ============================================================
// 定位：读取某条后台 Bash work 的累计输出时，runtime 只做归属收口后转给 executionPort。
// 输入：workId + 归属 sessionId（默认当前 runtime 的 sessionId）；
// 输出：BackgroundBashOutputResult，端口缺席或 work 不属于本会话时结构化降级。
// 关键不变量：读取必须按启动时 sessionId 校验归属，祖先 runtime 也不能读到其他会话的
//   workId；可选端口缺席时要显式返回 unsupported，不能把"没读到"伪装成空输出。
//   （链路 3）
// ============================================================
import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";

/** 执行记录按启动时 sessionId 验证归属，祖先 runtime 也不能读到其他会话的 workId。 */
export async function readBackgroundBashOutput(
  this: AgentRuntimeInternal,
  workId: string,
  sessionId = this.sessionId as string,
): Promise<BackgroundBashOutputResult> {
  // 端口/能力缺席（精简宿主或测试替身）时显式返回 unsupported：
  // 让调用方按"能力不支持"处理，而不是把无输出误读成任务已结束（链路 3）。
  if (!this.executionPort?.readBackgroundBashOutput) return { kind: "unsupported", workId };
  // sessionId 一并交给端口做归属校验：workId 只在启动它的会话内可见。
  return this.executionPort.readBackgroundBashOutput(workId, sessionId);
}
