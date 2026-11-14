// Automation（定时 / 闲时任务）提交时的模型选择收敛。
//
// 职责：把「Scheduler 请求里的选择 / 已固定 run 的选择 / Host 当前首选模型」收敛成一次
// Submission 真正使用的 ModelSelection，保证同一次 run 重试时模型身份不漂移。
// 输入输出：输入可选 selection、fixedSelection、readSelection；输出经 getView 校验后的
// effectiveSelection（必须带 reasoningLevel）。
// 副作用：只读；会调用 ModelSelectionService.getView（可能触发远端配置读取）。
// 失败语义：选择不可用 / 缺思考档位 / 无法解析首选模型一律抛错，不静默降级到默认模型。

import type { ModelSelection } from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";

// 解析一次 Automation submission 使用的模型选择。
// 优先级：fixedSelection（已是执行事实） > readSelection / selection（Host 侧最新意图） >
// 首选模型兜底。返回值必须通过 getView 校验（无 selectionIssue 且带 reasoningLevel），
// 否则抛错交给调度器记为派发失败——模型身份不可回退成账号默认值。
// 失败语义：全部抛 Error，调用方不应 catch 后继续派发。
/** 在 Automation Select 转为一次 Submission 的边界固定模型身份。 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  // Scheduler 的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}
