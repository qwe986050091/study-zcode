// ============================================================
// memory/dream —— 后台记忆整合（consolidation）的判定、互斥与 prompt
// ============================================================
//
// 【定位】Dream 是“跨会话整理”：把最近若干 session 的 transcript 交给受限
//   agent，合并、去重、删除已过期的记忆。本文件只提供纯判定、跨进程锁、
//   提示词和“本次改了哪些文件”的采集；真正的模型循环在 memory-agent-loop。
//
// 【读写边界】锁文件读写在 memoryRoot 内（.consolidate-lock）；prompt 只做
//   字符串拼接；touchedPaths 只观察工具调用，不直接落盘。
//
// 【失效/过期口径】锁的“有效”= mtime 新鲜（1 小时）且 owner PID 存活；
//   上次整合时间直接取锁 mtime，因此锁被删除或改写等于该时间丢失。
//
// 【副作用】evaluate/build 为纯函数；acquire/restore 会创建或改写锁文件。
// ============================================================
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelToolCall } from "@zcode/contracts";

import { analyzeBashCommand } from "../tool/handlers/bash-command-parser.js";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";

// 锁文件名：与记忆文件同目录，随 workspace 记忆一起迁移和清理。
const DREAM_LOCK_FILE = ".consolidate-lock";
// 锁新鲜窗口 1 小时：更老的锁视为上次异常退出留下的 stale 锁，可被抢占。
const DREAM_LOCK_FRESH_MS = 60 * 60 * 1000;
// 两次成功整合的最小间隔 24 小时（以锁 mtime 计），限制后台模型成本。
const AUTO_DREAM_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 同进程内扫描节流 10 分钟：会话不足等跳过路径不必每个 turn 重复 list/stat。
const AUTO_DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000;

/**
 * 自动 Dream 的时间闸门结论。
 * scan 表示可以继续扫描会话；skip 携带具体原因，调用方按 metadata 正常结束。
 */
export type AutoDreamTimingDecision =
  | { decision: "scan" }
  | { decision: "skip"; reason: "minimum-interval" | "scan-throttled" };

/**
 * 判断本次是否值得尝试自动整合（只做时间判定，不读盘）。
 * 输入：上次成功整合时间（锁 mtime，0 表示从未）、上次扫描时间、当前时间。
 * 输出：scan，或带最小间隔/扫描节流原因的 skip。
 * 副作用：无。
 * 失败语义：不抛错；调用方用 0 表达“从未整合 / 从未扫描”。
 * 不变量：最小间隔先于扫描节流判定——冷却期内连扫描都不做。
 */
export function evaluateAutoDreamTiming(input: {
  lastConsolidatedAtMs: number;
  lastScanAtMs: number;
  nowMs: number;
}): AutoDreamTimingDecision {
  // 24 小时内已整合过：直接放弃，避免高频后台模型调用。
  if (input.nowMs - input.lastConsolidatedAtMs < AUTO_DREAM_MINIMUM_INTERVAL_MS) {
    return { decision: "skip", reason: "minimum-interval" };
  }
  // 扫描节流窗口内：上一轮（可能因会话不足）刚扫过，复用其结论即可。
  if (input.nowMs - input.lastScanAtMs < AUTO_DREAM_SCAN_THROTTLE_MS) {
    return { decision: "skip", reason: "scan-throttled" };
  }
  return { decision: "scan" };
}

/**
 * 读取上次成功整合的时间戳。
 * 输入：memoryRoot（memory 目录绝对路径）。
 * 输出：锁文件 mtimeMs；文件不存在或不可读时返回 0（等价“从未整合”）。
 * 副作用：只 stat，不创建目录或文件。
 * 失败语义：吞掉 stat 错误，让首次 Dream 立即具备资格而不是报错。
 * 不变量：未另设时间文件，锁 mtime 就是“上次整合时间”的唯一事实来源。
 */
export async function readDreamLastConsolidatedAt(memoryRoot: string): Promise<number> {
  try {
    return (await stat(dreamLockPath(memoryRoot))).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 尝试获取跨进程 Dream 锁（write-readback 式，而非原子创建）。
 * 输入：memoryRoot、可注入的 nowMs 与 pid（便于测试）。
 * 输出：成功时返回“抢占前的锁 mtime”（0 表示原本无锁，失败还原时用）；
 *   未拿到锁时返回 null。
 * 副作用：必要时创建 memoryRoot；把 owner PID 写入锁文件。
 * 失败语义：读旧锁失败按无锁处理；写入或回读失败返回 null（让出本次 Dream）。
 * 不变量：只有回读到的 PID 与自己一致才算持锁，防止两个进程互相覆盖后
 *   都误以为成功而并发整合。
 */
export async function acquireDreamLock(input: {
  memoryRoot: string;
  nowMs?: number;
  pid?: number;
}): Promise<number | null> {
  const lockPath = dreamLockPath(input.memoryRoot);
  const nowMs = input.nowMs ?? Date.now();
  const pid = input.pid ?? process.pid;
  let priorMtimeMs: number | undefined;
  let priorPid: number | undefined;

  try {
    const [lockStat, content] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
    priorMtimeMs = lockStat.mtimeMs;
    const parsedPid = Number.parseInt(content.trim(), 10);
    if (Number.isFinite(parsedPid)) priorPid = parsedPid;
  } catch {
    // 不存在或不可读都按无 owner 处理，后续 write-readback 决定所有权。
  }

  // 锁仍新鲜且 owner 进程存活 → 他人正在整合；PID 复用风险由新鲜度窗口兜底。
  if (
    priorMtimeMs !== undefined &&
    nowMs - priorMtimeMs < DREAM_LOCK_FRESH_MS &&
    priorPid !== undefined &&
    isLiveProcess(priorPid)
  ) {
    return null;
  }

  // 先写自己的 PID，再回读校验：两个进程可能同时通过上面的存活检查。
  await mkdir(input.memoryRoot, { recursive: true });
  await writeFile(lockPath, String(pid), "utf8");
  let writtenPid: number;
  try {
    writtenPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
  } catch {
    // 回读失败无法证明持锁 → 放弃本次整合。
    return null;
  }
  // 被其他进程覆盖 → 本次未获锁，交由对方执行。
  if (writtenPid !== pid) return null;
  // 把 prior mtime 交还调用方，失败恢复时用它还原节流时间。
  return priorMtimeMs ?? 0;
}

/**
 * Dream 执行失败后还原锁文件的时间语义。
 * 输入：memoryRoot、acquireDreamLock 返回的 priorMtimeMs。
 * 输出：Promise<void>。
 * 副作用：priorMtimeMs 为 0 时删除锁；否则清空内容并把 mtime 改回原值。
 * 失败语义：unlink / utimes 错误向上抛出，由调用方决定是否忽略。
 * 不变量：还原后 readDreamLastConsolidatedAt 仍读到旧时间，
 *   一次失败不会被误判成“刚刚整合过”而压住后续重试。
 */
export async function restoreDreamLockAfterFailure(input: {
  memoryRoot: string;
  priorMtimeMs: number;
}): Promise<void> {
  const lockPath = dreamLockPath(input.memoryRoot);
  if (input.priorMtimeMs === 0) {
    // 原先没有锁：失败即删除，避免遗留内容为当前 PID 的假 owner。
    await unlink(lockPath);
    return;
  }
  await writeFile(lockPath, "", "utf8");
  const priorSeconds = input.priorMtimeMs / 1000;
  // mtime 是唯一的“上次整合时间”，必须精确还原，否则节流会误跳过后续重试。
  await utimes(lockPath, priorSeconds, priorSeconds);
}

/**
 * 生成 Dream 的 agent 提示词（四阶段：定位、取材、整合、修剪索引）。
 * 输入：memoryRoot、参与本次整合的 sessionId 列表、transcript 根目录。
 * 输出：完整 prompt 字符串。
 * 副作用：无（纯字符串拼接）。
 * 失败语义：不校验路径是否存在；不可达路径由 agent 的工具调用阶段报错。
 * 不变量：提示词声明本次 Shell 只允许只读命令与删除记忆目录内 .md，
 *   与 evaluateMemoryAgentToolPolicy 的实际权限收口保持同一口径。
 */
export function buildMemoryDreamPrompt(input: {
  memoryRoot: string;
  sessionIds: readonly string[];
  transcriptRoot: string;
}): string {
  // 逐个列出待整合会话，供 agent 按需窄范围 grep 对应 transcript，而不是整文件读取。
  const sessionLines = input.sessionIds.map((sessionId) => `- ${sessionId}`).join("\n");
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${input.memoryRoot}/\`
This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

Session transcripts: \`${input.transcriptRoot}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`MEMORY.md\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- \`ls -R logs/\` — recent activity logs (one file per session under \`YYYY/MM/DD/\`). If a \`sessions/\` subdirectory also exists, review recent entries there too

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Session logs** (\`logs/YYYY/MM/DD/<id>-<title>.md\`) — the append-only activity stream, one file per session. Read the most recent 1–3 days of sessions (the filename title tells you what each was about); each line is prefix-coded (\`>\` user, \`<\` assistant, \`.\` tool call)
2. **Existing memories that drifted** — facts that contradict something you see in the codebase now
3. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${input.transcriptRoot}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under 200 lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

### Reconcile memories against CLAUDE.md

Project CLAUDE.md instructions are loaded in your system prompt. For each \`feedback\` or \`project\` memory, check whether it contradicts a CLAUDE.md instruction on the same topic:

- **Memory is stale** — CLAUDE.md and the memory describe different procedures for the same task: CLAUDE.md is the maintained, checked-in source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **CLAUDE.md may be stale** — the memory is clearly dated after CLAUDE.md and explicitly corrects it: do NOT edit CLAUDE.md during a dream. Annotate the memory with "contradicts CLAUDE.md — verify which is current" and list it in your summary so the user can update CLAUDE.md.
- **Not a conflict** — the memory adds detail CLAUDE.md doesn't cover, or narrows a CLAUDE.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than CLAUDE.md — CLAUDE.md may have been updated since.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.

## Additional context



**Tool constraints for this run:** Shell access is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar) plus deleting \`.md\` paths inside the memory directory. Anything else that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind — no need to probe.

Sessions since last consolidation (${input.sessionIds.length}):
${sessionLines}`;
}

/**
 * 从一次工具调用中采集“Dream 改动了哪些 memory 文件”。
 * 输入：待累加的 Set、memoryRoot、工具调用、工作目录、workspace 根。
 * 输出：无（原地向 Set 添加解析后的绝对路径）。
 * 副作用：修改传入 Set；不读盘。
 * 失败语义：非 Write/Edit/Bash 忽略；Bash 只看 rm；越界或解析异常静默丢弃。
 * 不变量：只登记 memoryRoot 内、以 .md 结尾的路径，
 *   保证 pendingMemoryUpdate 与 recall 失效都只作用于记忆文件。
 */
export function collectDreamTouchedPaths(
  paths: Set<string>,
  input: {
    rootDir: string;
    toolCall: ModelToolCall;
    workingDirectory: string;
    workspaceRoot: string;
  },
): void {
  // 显式写入/编辑是唯一的内容变更来源。
  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    const filePath = stringProperty(input.toolCall.input, "file_path");
    const resolved = filePath ? resolveTouchedPath(filePath, input) : undefined;
    if (resolved) paths.add(resolved);
    return;
  }
  // 其它工具（Read/Grep 等）不产生记忆变更，直接忽略。
  if (input.toolCall.name !== "Bash") return;
  const command = stringProperty(input.toolCall.input, "command");
  if (!command) return;
  const analysis = analyzeBashCommand(command);
  // 只把 rm 的路径参数当作删除；其它子命令即使有副作用也不在此登记。
  for (const invocation of analysis.commands) {
    if (invocation.argv[0] !== "rm") continue;
    for (const argument of invocation.argv.slice(1)) {
      // 选项与 "--" 不是路径，跳过以免把 -r/-f 当成文件名。
      if (argument === "--" || argument.startsWith("-")) continue;
      const resolved = resolveTouchedPath(argument, input);
      if (resolved) paths.add(resolved);
    }
  }
}

/**
 * 锁文件路径：锁与记忆文件同目录，随工作区记忆一起迁移与清理。
 */
function dreamLockPath(memoryRoot: string): string {
  return join(memoryRoot, DREAM_LOCK_FILE);
}

/**
 * 判断 PID 是否对应存活进程（signal 0 探测）。
 * 失败语义：PID 非法或 kill 抛错（含权限不足）一律视为不存活，
 *   宁可抢占 stale 锁也不长期挂死整条 Dream 链路。
 */
function isLiveProcess(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把工具参数里的路径解析成 memoryRoot 内的绝对路径。
 * 失败语义：非 .md、越界或解析抛错时返回 undefined，不打断整批工具结果采集。
 */
function resolveTouchedPath(
  filePath: string,
  input: Pick<
    Parameters<typeof collectDreamTouchedPaths>[1],
    "rootDir" | "workingDirectory" | "workspaceRoot"
  >,
): string | undefined {
  // Memory 目录中只有 .md 是记忆文件，其它类型不计入 pendingMemoryUpdate。
  if (!filePath.endsWith(".md")) return undefined;
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

/**
 * 从工具输入中安全读取字符串字段。
 * 口径：值必须是普通对象且字段为 string；数组、null、数字等一律返回 undefined。
 */
function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}
