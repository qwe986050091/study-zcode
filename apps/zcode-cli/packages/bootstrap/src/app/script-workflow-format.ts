import type {
  ScriptWorkflowActivityRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStats,
  WorkflowScriptMeta,
} from "@zcode/contracts";

/**
 * 零值统计：agent / 缓存命中 / 失败 / 工具与五类 token 全部为 0。
 * 用作 `run.stats` 缺席时的显示兜底；返回新对象，调用方可以安全累加。
 */
export function emptyScriptWorkflowStats(): ScriptWorkflowRunStats {
  return {
    agentCalls: 0,
    cachedAgentCalls: 0,
    failedAgentCalls: 0,
    toolCalls: 0,
    tokens: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
  };
}

/**
 * 逐字段相加两份统计（父脚本 + 子工作流 / 多个 activity），不做去重或覆盖率修正。
 * 返回新对象；缺字段视为调用方已用 emptyScriptWorkflowStats 补齐，这里不兜底。
 */
export function mergeScriptWorkflowStats(
  left: ScriptWorkflowRunStats,
  right: ScriptWorkflowRunStats,
): ScriptWorkflowRunStats {
  return {
    agentCalls: left.agentCalls + right.agentCalls,
    cachedAgentCalls: left.cachedAgentCalls + right.cachedAgentCalls,
    failedAgentCalls: left.failedAgentCalls + right.failedAgentCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    tokens: {
      cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      reasoning: left.tokens.reasoning + right.tokens.reasoning,
      total: left.tokens.total + right.tokens.total,
    },
  };
}

/**
 * 校验成功后的多行摘要：名称 / 描述 / 路径 / 前 12 位 hash / phase 标题列表。
 * 纯展示，仅 hash 截断；phase 为空显示 "none"，避免出现空白行。
 */
export function formatScriptWorkflowValidation(input: {
  meta: WorkflowScriptMeta;
  scriptHash: string;
  scriptPath: string;
}): string {
  const phases =
    input.meta.phases.length === 0
      ? "none"
      : input.meta.phases.map((phase) => phase.title).join(", ");
  return [
    `Workflow script is valid: ${input.meta.name}`,
    `Description: ${input.meta.description}`,
    `Script: ${input.scriptPath}`,
    `Hash: ${input.scriptHash.slice(0, 12)}`,
    `Phases: ${phases}`,
  ].join("\n");
}

/**
 * 单次运行的人类可读报告：状态行、runId、脚本路径（内联显示 inline）、统计、活动树与失败信息。
 * 统计缺席时用零值兜底；failure 只在存在时追加，且按 Error / 字符串 / JSON 逐级降级。
 */
export function formatScriptWorkflowRun(input: {
  activities: ScriptWorkflowActivityRecord[];
  run: ScriptWorkflowRunRecord;
}): string {
  const { run } = input;
  const lines = [
    `workflow ${run.status} · ${run.name}`,
    `runId: ${run.id}`,
    `script: ${run.scriptPath ?? "(inline)"}`,
    formatStats(run.stats ?? emptyScriptWorkflowStats()),
  ];
  const tree = formatActivities(input.activities);
  if (tree.length > 0) lines.push("", tree);
  if (run.failure) lines.push("", `failure: ${formatUnknown(run.failure)}`);
  return lines.join("\n");
}

/**
 * 运行列表：每行 `id · status · name · agents · tools`；空列表回固定文案而非空串。
 * 只读传入记录，不排序（排序由存储侧的查询顺序决定）。
 */
export function formatScriptWorkflowList(runs: ScriptWorkflowRunRecord[]): string {
  if (runs.length === 0) return "No workflow runs found.";
  return [
    "Workflow runs:",
    ...runs.map((run) => {
      const stats = run.stats ?? emptyScriptWorkflowStats();
      return [
        `- ${run.id}`,
        `${run.status}`,
        run.name,
        `${stats.agentCalls} agents`,
        `${stats.toolCalls} tools`,
      ].join(" · ");
    }),
  ].join("\n");
}

function formatActivities(activities: ScriptWorkflowActivityRecord[]): string {
  if (activities.length === 0) return "";
  return [
    "Activities:",
    ...activities.map((activity) => {
      const label = activity.label ?? activity.phase ?? activity.type;
      const session = activity.childSessionId ? ` · ${activity.childSessionId}` : "";
      return `- ${activity.status} · ${label}${session}`;
    }),
  ].join("\n");
}

function formatStats(stats: ScriptWorkflowRunStats): string {
  return [
    `agents: ${stats.agentCalls}`,
    `cached: ${stats.cachedAgentCalls}`,
    `failed: ${stats.failedAgentCalls}`,
    `tools: ${stats.toolCalls}`,
    `tokens: ${stats.tokens.total}`,
  ].join(" · ");
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
