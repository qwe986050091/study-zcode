// EvalWorkflowSnippet 的常驻描述（docs/dynamic-workflow/authoring.md「EvalWorkflowSnippet」）。
//
// 2026-09-21 起收短：snippet facade 的范围与写作规则在 `dynamic-workflows` 技能的「Tool
// reference」里，由技能门保证读过；这里只说它是什么、拿来干什么、先读技能。
//
// 文案要约束住的行为是：snippet 是同步、瞬态、无 agent()/report() 的试验台，不是启动 run 的
// 入口；`code` 与 `path` 二选一；未加载技能前调用会被拒。facade 细节留在技能里，避免和
// 编译器权威声明分叉。

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

// 导出常量：EvalWorkflowSnippet 工具的模型侧描述，供 provider 组装工具清单时直接读取。
// 值是一个以空行分段的纯字符串，无运行时插值、无 IO；空值不适用。
// 描述本身不做校验：未加载技能或同时传 code/path 由工具层拒绝，这里只负责告知约束。
export const EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION = [
  "Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox and world-read execution path a real run uses. It is the test bench for workflow authoring: check a parser against real command output, see what a glob actually returns, or exercise a gate predicate on real repository state before putting it in a CreateWorkflow script. No agent()/report(); nothing persists; the result comes back in this call.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool first: it carries the snippet facade and the rules. The call is refused until that skill has been loaded in this session. Pass \`code\` (inline) or \`path\` (a file holding the snippet), never both.`,
].join("\n");
