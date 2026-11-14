// INV-01 模板正文即模型契约：守住位置 常量；改错故障 记忆写入行为发生回归。
// INV-02 占位符只有两个：守住位置 模板；改错故障 替换遗漏导致提示词露出原始标记。
// INV-03 替换按字面量进行：守住位置 replace；改错故障 路径中的特殊字符被正则解释。
// INV-04 根目录补平台分隔符：守住位置 归一化；改错故障 模板出现双斜杠路径。
// INV-05 已带分隔符不重复追加：守住位置 判定；改错故障 尾部分隔符翻倍。
// INV-06 索引先做格式归一：守住位置 formatMemoryIndexContent；改错故障 注入文本尾部出现空行。
// INV-07 空索引给固定文案：守住位置 空值合并；改错故障 模型以为缺少段落字段。
// INV-08 作用域全覆盖：守住位置 Record 类型；改错故障 新增作用域时运行时取到未定义。
// INV-09 三种作用域文案互不重叠：守住位置 映射表；改错故障 本地记忆被当成团队共享。
// INV-10 索引段落在模板之后：守住位置 拼接顺序；改错故障 索引被插到指令中间。
// INV-11 记忆类型固定四类：守住位置 模板；改错故障 模型自造类型破坏索引检索。
// INV-12 反例清单显式列出：守住位置 模板；改错故障 模型把可推导信息也写进记忆。
// INV-13 引用先验证再推荐：守住位置 模板；改错故障 推荐已删除的文件或函数。
// INV-14 记忆与计划任务分工明确：守住位置 模板；改错故障 把短期进度写进长期记忆。
// INV-15 索引行数有上限说明：守住位置 模板；改错故障 索引膨胀后被截断却无人察觉。
// INV-16 路径与文件名的链接规则：守住位置 模板；改错故障 关联记忆无法互相跳转。
// INV-17 纯字符串拼装无 IO：守住位置 函数体；改错故障 读取磁盘导致调用点出现隐式失败。
// INV-18 返回单字符串：守住位置 返回；改错故障 调用方需要再拼接一次。
//
// 模块职责：拼装持久记忆段的系统提示词文本。
// 状态所有权：无状态；全部输入由参数给出。
// 阅读顺序：先看模板常量，再看作用域文案，最后看拼装函数。
import { sep } from "node:path";

import { formatMemoryIndexContent } from "../memory/index-content.js";
import type { AgentMemoryScope } from "./profile.js";

// 持久记忆提示词模板（英文原文即模型契约，改动需评估行为回归）。
// 预处理占位符：`<MEMORY_ROOT>/` 由实际记忆根目录替换，`<SCOPE_GUIDANCE>` 由
// SCOPE_GUIDANCE 中对应 scope 的一行替换；替换按字符串字面量进行，不转义路径。
// PERSISTENT_AGENT_MEMORY_PROMPT_TEMPLATE 的每一项都是模板里的一段原文。
// user 与 feedback 两类 memory type 在模板里必须成对出现。
// <MEMORY_ROOT> 等占位符统一用尖括号标记，替换时按字面量匹配。
// 反例段（negative examples）排在 saving rules 之前，先说明不该做什么。
// 数组在定义时由 join("\n") 拼成完整字符串。
const PERSISTENT_AGENT_MEMORY_PROMPT_TEMPLATE = [
  "# Persistent Agent Memory",
  "",
  "You have a persistent, file-based memory system at `<MEMORY_ROOT>/`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).",
  "",
  "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
  "",
  "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
  "",
  "## Types of memory",
  "",
  "There are several discrete types of memory that you can store in your memory system:",
  "",
  "<types>",
  "<type>",
  "    <name>user</name>",
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
  "    <examples>",
  "    user: I'm a data scientist investigating what logging we have in place",
  "    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]",
  "",
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>feedback</name>",
  "    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>",
  '    <when_to_save>Any time the user corrects your approach ("no not that", "don\'t", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
  "    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>",
  "    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>",
  "    <examples>",
  "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
  "    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]",
  "",
  "    user: stop summarizing what you just did at the end of every response, I can read the diff",
  "    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]",
  "",
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  "    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>project</name>",
  "    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>",
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
  "    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>",
  "    <examples>",
  "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
  "    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]",
  "",
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  "    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>reference</name>",
  "    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>",
  "    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>",
  "    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>",
  "    <examples>",
  '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
  '    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
  "",
  "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
  "    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]",
  "    </examples>",
  "</type>",
  "</types>",
  "",
  "## What NOT to save in memory",
  "",
  "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
  "- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
  "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
  "- Anything already documented in AGENTS.md files.",
  "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
  "",
  "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
  "",
  "## How to save memories",
  "",
  "Saving a memory is a two-step process:",
  "",
  "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
  "",
  "```markdown",
  "---",
  "name: {{short-kebab-case-slug}}",
  "description: {{one-line summary — used to decide relevance in future conversations, so be specific}}",
  "metadata:",
  "  type: {{user, feedback, project, reference}}",
  "---",
  "",
  "{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}",
  "```",
  "",
  "In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.",
  "",
  "**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.",
  "",
  "- `MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise",
  "- Keep the name, description, and type fields in memory files up-to-date with the content",
  "- Organize memory semantically by topic, not chronologically",
  "- Update or remove memories that turn out to be wrong or outdated",
  "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
  "",
  "## When to access memories",
  "- When memories seem relevant, or the user references prior-conversation work.",
  "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
  "- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.",
  "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.",
  "",
  "## Before recommending from memory",
  "",
  "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
  "",
  "- If the memory names a file path: check the file exists.",
  "- If the memory names a function or flag: grep for it.",
  "- If the user is about to act on your recommendation (not just asking about history), verify first.",
  "",
  '"The memory says X exists" is not the same as "X exists now."',
  "",
  "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
  "",
  "## Memory and other forms of persistence",
  "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
  "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
  "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
  "",
  "<SCOPE_GUIDANCE>",
].join("\n");

// 按记忆作用域给出的差异化指引：user 跨项目通用，project 进版本库与团队共享，
// local 不入版本库、仅本机可见。三种 scope 必须全覆盖，新增 scope 时此处会编译报错。
// SCOPE_GUIDANCE 的 key 覆盖 AgentMemoryScope 的三个取值，每个取值一行文案。
// user 级文案强调这条记忆跨项目通用。
// project 级文案强调随版本库与团队共享。
// local 级文案强调仅本机可见，不入版本库。
// Record<AgentMemoryScope, string> 保证新增 scope 时此处编译报错。
const SCOPE_GUIDANCE: Record<AgentMemoryScope, string> = {
  user: "- Since this memory is user-scope, keep learnings general since they apply across all projects",
  project:
    "- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project",
  local:
    "- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine",
};

// 生成持久记忆段提示词：模板 + 作用域指引 + 当前 MEMORY.md 索引内容。
// 输入 rootDir 必须已存在（目录创建由调用方负责）；这里只做字符串拼装，无 IO。
// 路径口径：统一补上平台分隔符后缀，保证模板里 `<MEMORY_ROOT>/` 不会出现双斜杠。
// indexContent 为空串或仅空白时退化为“索引为空”的固定文案，不留下空段落。
export function buildPersistentAgentMemoryPrompt(input: {
  indexContent: string;
  rootDir: string;
  scope: AgentMemoryScope;
// 先确保 rootDir 以 path.sep 结尾，避免模板里出现双斜杠。
// indexContent 先交给 formatMemoryIndexContent 做格式归一。
// 替换顺序固定为先 <MEMORY_ROOT> 后 <SCOPE_GUIDANCE>。
// 索引段落固定拼在 prompt 最末。
}): string {
  // 用平台 sep 统一，避免调用方传入的目录已带分隔符时重复追加。
  // 已带 sep 后缀的 rootDir 原样使用，不再追加分隔符。
  // 空索引走“索引为空”的固定文案，不留空段落。
  // 拼接结果不留多余空行，避免 prompt 尾部出现空白。
  // buildPersistentAgentMemoryPrompt 不做任何磁盘访问，目录创建由调用方负责。
  const memoryRoot = input.rootDir.endsWith(sep) ? input.rootDir : `${input.rootDir}${sep}`;
  // 索引内容先做格式归一（如去尾部空行），保证注入文本尾部没有多余空白。
  const indexContent = formatMemoryIndexContent(input.indexContent);
  const prompt = PERSISTENT_AGENT_MEMORY_PROMPT_TEMPLATE.replace(
    "<MEMORY_ROOT>/",
    memoryRoot,
  ).replace("<SCOPE_GUIDANCE>", SCOPE_GUIDANCE[input.scope]);
  return [
    prompt,
    "",
    "## MEMORY.md",
    "",
    // 空索引使用固定说明而非留白，避免模型误以为缺少段落字段。
    indexContent ||
      "Your MEMORY.md is currently empty. When you save new memories, they will appear here.",
  ].join("\n");
}
