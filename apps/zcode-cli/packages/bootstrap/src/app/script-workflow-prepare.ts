// ============================================================
// 一次脚本工作流 run 的落库准备（定义 upsert → run 创建/恢复）
// ============================================================
// run/resume 两个入口在启动脚本之前都走这里：先按「路径 + 内容 hash」登记定义，再决定是
// 新建 run 记录还是取回被恢复的那条。本文件只读写 ScriptWorkflowStorePort，不执行脚本。
// 失败语义：恢复目标不存在时抛 `Workflow run not found`；存储异常原样上抛。

import type {
  ScriptWorkflowRunRecord,
  ScriptWorkflowStorePort,
  SessionId,
} from "@zcode/contracts";
import type { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import { stableHash } from "./script-workflow-meta.js";
import { emptyScriptWorkflowStats } from "./script-workflow-format.js";
import { inferScriptWorkflowScope } from "./script-workflow-utils.js";

/**
 * 准备一条 run 记录：upsert 定义（id 由 path+hash 派生，内容不变则复用），然后
 * - 有 resumeFromRunId：取回该 run，不新建；
 * - 否则：新建 run，args 同时存原值与 hash，初始统计清零。
 *
 * 返回的 run 已落库，可直接交给执行器；`runId` 不传时由 crypto.randomUUID 生成。
 * 工作目录只用于推断 scope 与 cwd，不参与 run 的身份键。
 */
export async function prepareScriptWorkflowRun(input: {
  args?: unknown;
  document: Awaited<ReturnType<typeof readWorkflowScriptDocument>>;
  parentSessionId: SessionId;
  resumeFromRunId?: string;
  runId?: string;
  store: ScriptWorkflowStorePort;
  workingDirectory: string;
}): Promise<ScriptWorkflowRunRecord> {
  // 定义 id 取 hash 前 24 位：同一脚本内容重复执行只对应一条定义，跨进程稳定。
  const definition = await input.store.upsertScriptWorkflowDefinition({
    id: `script_${stableHash(`${input.document.path}:${input.document.hash}`).slice(0, 24)}`,
    meta: input.document.meta,
    name: input.document.meta.name,
    scope: inferScriptWorkflowScope(input.document.path, input.workingDirectory),
    scriptHash: input.document.hash,
    scriptPath: input.document.path,
    source: "user",
  });
  if (input.resumeFromRunId) {
    // 恢复不新建：旧 run 的 parentSessionId / 统计 / 脚本指针一律沿用，只在定义侧更新。
    const existing = await input.store.getScriptWorkflowRun(input.resumeFromRunId);
    if (!existing) throw new Error(`Workflow run not found: ${input.resumeFromRunId}`);
    return existing;
  }
  // 新 run：argsHash 只在有 args 时给出（undefined 表示未传参数，不等于空对象）。
  return input.store.createScriptWorkflowRun({
    args: input.args,
    argsHash: input.args === undefined ? undefined : stableHash(input.args),
    cwd: input.workingDirectory,
    definitionId: definition.id,
    id: input.runId ?? `wf_${crypto.randomUUID()}`,
    name: input.document.meta.name,
    parentSessionId: input.parentSessionId,
    scriptHash: input.document.hash,
    scriptPath: input.document.path,
    stats: emptyScriptWorkflowStats(),
  });
}
