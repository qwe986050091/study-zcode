// ============================================================
// executor/memory-file-permission.ts —— 记忆目录写入的定向豁免与边界
// ============================================================
// 只针对 Write/Edit 且目标落在 memoryRoot 内的 .md 文件：放行（免确认），但不越过更严的既有判定。
// 方向不变量：只能把"模式默认的 ask"放宽为 allow，不能把 deny 改成 allow，也不能抹掉 alwaysAsk。
// 顺序有讲究：permission-flow 在 PreToolUse hook 合并之后调用它，所以 Hook/project 的 deny 已经先成立。
// 反直觉：plan 模式下唯一允许被本模块覆盖的 deny 是 mode.plan.nonReadOnly——记忆写属于系统内务，
// 不是用户在工作区的写入；其余 deny 一律保留。

import type { PermissionDecisionResult } from "../../permission/service.js";
import {
  resolveContainedMemoryFilePath,
  resolveSafeMemoryFilePath,
} from "../../memory/memory-file-path.js";

interface MemoryFileTargetInput {
  // 已规范化、即将交给 handler 的入参；这里只读 file_path 一个字段。
  executionInput: unknown;
  // 记忆根目录；缺席 = 不做记忆文件特判（由 deps.getMemoryRoot 提供，属于可选端口）。
  memoryRoot?: string;
  // 只有 Write/Edit 参与；其它工具直接跳过，避免误放行。
  toolName: string;
  // 把相对 file_path 解析成绝对路径的落点，必须与首次判权/执行同源。
  workingDirectory: string;
  // 工作区根，与 workingDirectory 一起判定路径是否合法。
  workspaceRoot: string;
}

interface MemoryFilePermissionInput extends MemoryFileTargetInput {
  // 上一阶段的判定结果；本模块只在它之上放宽或原样返回，不重新判定。
  decision: PermissionDecisionResult;
}

/**
 * 在通用判定之后，对 memoryRoot 内的 .md 写入做一次定向放宽。
 * 输入是上一步 decision 与当前执行入参；输出永远是 decision（新的或原样的），不写存储、不发事件。
 * 放行条件必须同时成立：目标是 memoryRoot 内的 .md、路径通过 resolveSafeMemoryFilePath
 * （不含敏感路径段）、且既有判定不含更严约束（见 preservesExistingPermissionDecision）。
 * 放行时清掉 escalated 并改写 ruleId=memory.file.markdown，便于审计归因。
 */
export function applyMemoryFilePermission(
  input: MemoryFilePermissionInput,
): PermissionDecisionResult {
  const target = resolveMemoryFileTarget(input);
  // 不是记忆目标或没配置 memoryRoot：完全不介入，保持上层判定原样返回。
  if (!target || !input.memoryRoot) return input.decision;

  if (
    !target.endsWith(".md") ||
    resolveSafeMemoryFilePath({
      filePath: target,
      rootDir: input.memoryRoot,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    }) === undefined
  ) {
    // 只放行 .md，且必须过 safe 检查：skills/agents 一类敏感路径段即使落在 memoryRoot 内也不放行。
    return input.decision;
  }
  // 记忆豁免不能压过更严的判定（deny/alwaysAsk/project ask/hook ask），只能接管模式默认 ask。
  if (preservesExistingPermissionDecision(input.decision)) return input.decision;

  return {
    ...input.decision,
    allowed: true,
    decision: "allow",
    // escalated 归零：记忆写不是"权限升级"，只是与模式无关的免确认；ruleId 专用于审计与规则解释。
    escalated: false,
    reason: "Memory Markdown writes are allowed",
    ruleId: "memory.file.markdown",
  };
}

/**
 * 供重判路径回答"这次输入是否命中记忆目标"，纯布尔判断，不改变任何判定。
 */
export function targetsMemoryFile(input: MemoryFileTargetInput): boolean {
  return resolveMemoryFileTarget(input) !== undefined;
}

/**
 * 解析真正落在 memoryRoot 内的目标绝对路径；不是 Write/Edit、没有 memoryRoot、
 * 或缺 file_path 时返回 undefined。只做路径解析，不做 IO。
 */
function resolveMemoryFileTarget(
  input: MemoryFileTargetInput,
): string | undefined {
  // 只有 Write/Edit 会写记忆；读取类工具不需要这道豁免。
  if (input.toolName !== "Write" && input.toolName !== "Edit") return undefined;
  if (!input.memoryRoot) return undefined;

  const requestedPath = filePathFromInput(input.executionInput);
  if (!requestedPath) return undefined;
  // 相对路径必须按判权时的 cwd 解析，否则会把"工作区外"误判成"记忆内"。
  return resolveContainedMemoryFilePath({
    filePath: requestedPath,
    rootDir: input.memoryRoot,
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
}

/** 只认非空字符串 file_path；缺字段/非字符串都视为"不是文件目标"。 */
function filePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const filePath = (input as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

/**
 * 判断既有判定里是否存在"记忆豁免也不能覆盖"的约束：
 *   - deny 一律保留，唯一例外是 plan 的 mode.plan.nonReadOnly（记忆写是系统内务，不是工作区写入）；
 *   - alwaysAsk 恒保留：工具自报"任何情况都要问"，不能被记忆规则抹掉；
 *   - 项目级 ask / PreToolUse ask 保留：它们是"人或 hook 明确要求询问"，不是模式默认值。
 */
function preservesExistingPermissionDecision(decision: PermissionDecisionResult): boolean {
  if (decision.decision === "deny") {
    // 反直觉：plan 的非只读 deny 可以被记忆规则接管，这是刻意豁免，不是漏判。
    return decision.ruleId !== "mode.plan.nonReadOnly";
  }
  // alwaysAsk 是工具自报的"任何情况都要问"，这里不能把它放行掉。今天走不到这条分支
  // （只有 Write/Edit 会命中 memory 目标，二者都没声明 alwaysAsk），但一旦有人给它们加上，
  // 少了这个判断就会出现"memory 文件让模式无关的确认静默消失"——正是本旗标要防的事。
  if (decision.alwaysAsk) return true;
  return (
    decision.decision === "ask" &&
    (decision.ruleId === "rule.project.ask" || decision.ruleId === "hook.PreToolUse.ask")
  );
}
