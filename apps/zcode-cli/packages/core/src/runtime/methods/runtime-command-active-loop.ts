/**
 * ============================================================================
 * runtime/methods/runtime-command-active-loop.ts —— 活动 turn 内的命令吸收
 * ============================================================================
 *
 * 活动 turn 的模型请求之间,可以把"已经可以安全注入"的命令直接吸收进本轮:
 *   task-notification  后台任务完成/进展(可合并)
 *   subagent-message   子代理回传(单条)
 * 其它 mode 不在本文件处理:
 *   control-only-turn  必须等当前 turn 结束(它要落一条 user 消息,不能插在
 *                      tool_use/tool_result 之间);它之后的命令也不吸收,
 *                      保证模型先读到"设置轮"再读到新 run 的进展。
 *   prompt / 续跑       由外层队列按轮执行。
 *
 * 【一致性】消费前检查 branchGeneration:rewind 后旧分支的通知必须丢弃,
 * 否则模型会看到不属于当前分支的结果。
 * ============================================================================
 */
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { MessageId } from "../deps.js";
import type { RuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistBackgroundTaskNotificationCommand,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "./background-notifications.js";
import { persistSubagentMessageCommand } from "./subagent-messages.js";
import { isStaleBranchRuntimeCommand } from "./runtime-command-generation.js";
import { createRuntimeUserEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";

export interface ActiveLoopRuntimeCommandDrainResult {
  backgroundSubagentResultConsumed: boolean;
  workflowResultConsumed: boolean;
  consumedCommandIds: RuntimeCommandId[];
  drained: number;
  messageIds: MessageId[];
  runtimeEntries: readonly RuntimeMessageEntry[];
}

export async function drainPendingRuntimeCommandsForActiveLoop(
  this: AgentRuntimeInternal,
): Promise<ActiveLoopRuntimeCommandDrainResult> {
  // 只取 priority <= next 的命令:later 的命令属于"turn 结束后再处理",
  // 活动循环不能把它们提前吸进来。
  const commands = this.runtimeCommandQueue.getByMaxPriority("next");
  const consumedCommandIds: RuntimeCommandId[] = [];
  let backgroundSubagentResultConsumed = false;
  let workflowResultConsumed = false;
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];

  for (const command of commands) {
    // 排队的 controlOnly 轮（GUI「配置」的设置轮）不进活动 turn，而且它之后入队的通知也不能被
    // 这里先吸收：那些通知说的是它刚记下的新 run，模型必须先读到「设置已调整、新 run 是谁」，
    // 再读到新 run 的进展。在它这里停下，
    // 后面的留给外层队列按序跑。
    if (command.mode === "control-only-turn") break;
    if (command.mode !== "task-notification" && command.mode !== "subagent-message") {
      continue;
    }
    const removed = this.runtimeCommandQueue.removeById(command.id);
    if (!removed) continue;
    // 先 remove 再判 stale:即使这条命令已过期,也要把它从队列移除,
    // 否则 rewind 后队列里会长期残留一堆永远不会被消费的旧分支通知。
    // 不变量 6：消费前必须校验 branchGeneration；旧分支命令即使已入队也不能注入模型。
    if (isStaleBranchRuntimeCommand(this, removed)) continue;

    let messageId: MessageId;
    if (removed.mode === "task-notification") {
      if (shouldSuppressTaskNotificationRuntimeCommand.call(this, removed)) {
        continue;
      }
      messageId = await persistBackgroundTaskNotificationCommand.call(this, removed);
    } else if (removed.mode === "subagent-message") {
      messageId = await persistSubagentMessageCommand.call(this, removed, true);
    } else {
      continue;
    }

    consumedCommandIds.push(removed.id);
    // active-loop 不会创建新的 TurnStarted；这里把已消费事实带到当前 turn 的终态，且只认结构化 subagent 来源，避免 Bash 混入。
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "subagent"
    ) {
      backgroundSubagentResultConsumed = true;
    }
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "workflow"
    ) {
      workflowResultConsumed = true;
    }
    messageIds.push(messageId);
    runtimeEntries.push(
      createRuntimeUserEntry(
        removed.text,
        runtimeInputMetadata(
          removed.mode === "task-notification" ? "task_notification_steer" : "subagent_reply_steer",
        ),
      ),
    );
  }

  return {
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    consumedCommandIds,
    drained: consumedCommandIds.length,
    messageIds,
    runtimeEntries,
  };
}
