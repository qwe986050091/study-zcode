// ============================================================
// Workflow script analysis - 单槽记忆的共享入口
// ============================================================
//
// 审批 gate 会在执行前分析脚本，handler 执行后又分析一次，一次获批调用因此要跑两遍
// TypeScript 程序。按脚本原文做单槽记忆把这一对折叠成一次编译；刻意不是通用缓存——
// 唯一值得收敛的重复就是这组紧邻的前后调用。
//
// 抽到本模块是因为**两个**工具现在共用它：CreateWorkflow 跑脚本前要编译，SaveWorkflow
// 存脚本前也要编译，而且必须是同一个检查器——「能存下来但跑不起来」是这个特性最难解释的
// 一种坏掉方式。

import { analyzeWorkflowScript, type AnalyzeResult } from "@zcode/dynamic-workflow";

// 单槽记忆：只存最近一次脚本与结果。它**不是**缓存——没有容量、没有淘汰策略、也不跨脚本
// 复用；下一个不同脚本会直接覆盖。这样内存占用有界，也绝不会让「旧版本脚本的分析结果」在
// 编辑后继续被使用。
let lastAnalysis: { script: string; result: AnalyzeResult } | null = null;

/** 编译并分析一段 workflow 脚本，紧邻的重复调用命中记忆槽。 */
// 补充口径：输入是**归一化后**的脚本正文（元数据块已被剥离），不同调用点必须传同一份字节；
// 输出 `AnalyzeResult` 是被记忆槽共享的同一对象，调用方不得原地修改。
// 副作用是更新模块级单槽；无 I/O、不抛——编译失败以 `ok: false` + `diagnostics` 表达。
// 并发调用共享同一槽没有正确性问题：槽只用于加速，结果本身是确定性的。
export function analyzeScript(script: string): AnalyzeResult {
  if (lastAnalysis?.script === script) return lastAnalysis.result;
  const result = analyzeWorkflowScript(script);
  lastAnalysis = { script, result };
  return result;
}
