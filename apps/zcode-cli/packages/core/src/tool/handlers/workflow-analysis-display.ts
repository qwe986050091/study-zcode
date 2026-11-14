// ============================================================
// Workflow analysis → display - 静态分析结果到显示图 / 结果卡的唯一投影
// ============================================================
//
// 显示图由**三份**分析投影拼成：因果图给站点与车道，控制流图给阶段词汇表与阶段边，交接图给
// 每阶段的子代理卡与交接边。少传任何一份，图就静默地缺一层——中枢直接启动
// 的 run 详情侧板没有时间线、没有子代理，根因正是启动路径只传了因果图。所以「分析结果 →
// 有界显示图」只在这里拼一次；CreateWorkflow 的 handler、确认窗 gate 与直接启动三处调用它，
// 谁都不再在调用点手拼 `boundCausalityGraph(...)` 的实参。
//
// 失败/降级语义：纯投影，不抛、无副作用。分析失败（`ok: false`）时仍返回 display——确认窗要
// 用同一块载荷展示诊断；只有连因果图都没有（编译早于建图）时图字段才缺席。display 只是展示
// 投影，任何客户端解析失败都不影响工具结果与 durable 事实。

import {
  CREATE_WORKFLOW_TOOL_NAME,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowOutput,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import type { AnalyzeResult } from "@zcode/dynamic-workflow";
import { createCreateWorkflowDisplay } from "../executor/result-display.js";
import { boundCausalityGraph } from "./create-workflow-graph-bounds.js";

/** 分析结果的有界显示图；脚本连一个站点都分析不出（编译失败早于因果图）时缺席。 */
export function boundGraphOfAnalysis(
  analysis: AnalyzeResult,
): CreateWorkflowCausalityGraph | undefined {
  // 因果图是显示图的地基：没有站点就没有车道与阶段节点，另两份图也就无处挂载。
  // 返回 undefined 而不是空图，让读取侧能区分「没有图」与「图是空的」。
  return analysis.causality === undefined
    ? undefined
    : boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff);
}

/**
 * 分析结果的 `create_workflow` display（确认窗、启动轮元数据）。面向模型的 `response` 在这些
 * 读者面前没有内容——display 投影本身也不读它。AmendWorkflow 传自己的工具名：两个启动工具
 * 共用同一个 display kind。
 */
export function displayOfAnalysis(
  analysis: AnalyzeResult,
  toolName: string = CREATE_WORKFLOW_TOOL_NAME,
): ToolResultDisplayPayload | undefined {
  const causalityGraph = boundGraphOfAnalysis(analysis);
  return createCreateWorkflowDisplay(toolName, {
    diagnostics: analysis.diagnostics,
    ok: analysis.ok,
    // display 不消费模型面的 `response`：确认窗与启动元数据都从结构字段渲染，
    // 这里留空串而不是伪造文案，避免展示层与工具结果出现两套说法。
    response: "",
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput);
}
