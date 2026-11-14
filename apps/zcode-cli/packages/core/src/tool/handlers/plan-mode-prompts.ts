// ============================================================
// Plan Mode Tool Provider Prompts
// ============================================================

// 本文件只存放 Plan Mode 两个工具的**模型可见文案**，没有任何执行逻辑：
//   - `createEnterPlanModeProviderDescription` 生成 EnterPlanMode 的 provider description；
//   - `EXIT_PLAN_MODE_MODEL_INSTRUCTIONS` 是 ExitPlanMode 的 description 来源。
//
// 这些字符串直接进入模型上下文，因此每一句都在改变模型行为，而不是给读者看的注释：
// 它们决定模型何时主动进入计划模式、在计划模式里用哪些工具探索、以及何时才允许退出。
// 反过来，权限与只读约束不在这里表达——那由 permission 层按 planEnabled 生效（见 plan-mode.ts）。
//
// 文案必须与真实工具面一致，否则模型会调用不存在的工具：嵌入式搜索（find/grep）与
// 外部 Glob/Grep 是两套工具名，所以描述按 `embeddedSearchEnabled` 动态切换探索工具名。
// `EXIT_PLAN_MODE_MODEL_INSTRUCTIONS` 保持数组形状，是为了与 provider 的 instructions
// 数组口径一致；当前只有一个元素，`plan-mode.ts` 直接取 `[0]` 作为单段 description。

/**
 * 生成 EnterPlanMode 的 provider description。
 *
 * @param options.embeddedSearchEnabled 当前工具面是否提供内嵌 `find`/`grep`。
 *   为 true 时描述里写 `find`/Glob、`grep`/Grep；否则只写 Glob、Grep。默认 false。
 * @returns 一段完整的 Markdown 文案（含何时用/何时不用/计划模式流程/示例）。
 *
 * 纯函数、无副作用；输出只影响模型行为，不影响权限或执行结果。
 * 工具名写错会让模型调用不存在的工具，因此该开关必须与真实注册的工具面同源。
 */
export function createEnterPlanModeProviderDescription(options: {
  embeddedSearchEnabled?: boolean;
} = {}): string {
  // 为什么：内嵌搜索工具与外部工具是两套注册名。描述里不能同时列出不存在的工具，
  // 否则模型会在计划模式里发起必然 registry miss 的调用（每条 tool_call 仍需配对失败结果）。
  const explorationTools = options.embeddedSearchEnabled
    ? "`find`/Glob, `grep`/Grep, and Read"
    : "Glob, Grep, and Read";

  return `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using ${explorationTools}
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase
`;
}

/** 默认描述：工具面没有内嵌搜索，按外部 Glob/Grep 口径生成。 */
export const ENTER_PLAN_MODE_PROVIDER_DESCRIPTION = createEnterPlanModeProviderDescription();

/**
 * ExitPlanMode 的模型指令数组。
 *
 * 唯一元素会被 plan-mode.ts 取作 description（`EXIT_PLAN_MODE_MODEL_INSTRUCTIONS[0]`），
 * 因此修改文案就是修改模型的退出行为，需与 handler 的前置条件（必须处于 plan 模式、
 * 必须先给出完整 plan）保持一致。文案里刻意强调不要用 AskUserQuestion 问"计划是否 OK"：
 * 该工具本身就是审批请求，重复询问会让一次审批变成两次交互。
 */
export const EXIT_PLAN_MODE_MODEL_INSTRUCTIONS = [
  `Use this tool when you are in plan mode and have finished writing your plan and are ready for user approval.

## How This Tool Works
- You should have already explored the codebase and finalized the plan you want the user to review
- This tool DOES take the plan content as the required plan parameter in ZCode
- Pass the complete plan in the plan field; the user will review that content before approving implementation
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of the plan parameter when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion before finalizing your plan
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
`,
] as const;
