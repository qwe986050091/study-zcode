// 定时任务（Cron automation）的 Bot 终态回推订阅。
//
// 职责：在 prompt 真正派发之前，按 automation 的 Bot 投递目标注册一次 run 订阅，
// 让 Bot 能收到该 run 的最终结果；本文件只做「查目标 + 订阅」，不承载投递逻辑。
// 输入输出：输入 automationId / runId / taskId 与 workspace 三元组 + repo/bots 依赖；
// 输出 boolean，表示是否存在可投递目标（无目标时调用方通常只跳过回推）。
// 副作用：向 BotsService 注册 watchAutomationRun（会创建远端订阅/回推链路）。
// 失败语义：repo 或 bots 抛错时向上冒泡；此时调用方应视为派发前置失败，而不是静默丢回推。

import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";

interface CronBotDeliveryRepo {
  getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined>;
}

interface CronBotDeliveryService {
  watchAutomationRun(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    runId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
}

// 在派发前订阅 Bot 终态，返回是否存在投递目标。
// 顺序约束：先 getBotDeliveryTarget 再 watchAutomationRun，且都必须在 prompt 派发之前完成，
// 否则快速任务可能先结束、后注册 listener，导致回推丢失（见下方原注释）。
// runId 与 workspaceIdentity 是可选项：不存在时不能传 undefined 键，避免下游按「有该字段」判断。
// 失败语义：查目标或订阅失败直接抛出，不吞错——漏回推比派发失败更难排查。
/**
 * 在 prompt 派发前完成 Bot 终态订阅，避免快速任务先完成、后注册 listener 而漏回推。
 */
export async function watchCronRunBotDelivery(params: {
  automationId: string;
  runId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  repo: CronBotDeliveryRepo;
  botsService: CronBotDeliveryService;
}): Promise<boolean> {
  const target = await params.repo.getBotDeliveryTarget(params.automationId, params.workspaceKey);
  if (!target) return false;
  await params.botsService.watchAutomationRun({
    target,
    ...(params.runId ? { runId: params.runId } : {}),
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  });
  return true;
}
