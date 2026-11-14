#!/usr/bin/env node
// 开工前基线新鲜度检查 —— 防止在旧架构上分析、写测试、修已经消失的问题。
//
// 背景：本地 zcode-cua 曾落后 origin/main 140 个提交（本地 Skill 仍
// 558 行、主线已收敛到 128 行），z-code 集成分支曾落后自己的远端 29 个提交，都曾在
// 旧基线上开工。任何会话开始前先跑本脚本（zcode-cua 仓库用它的 python 等价物）。
//
// 判定三态（b275 起，注解分支长期例外）：
//   aligned             本地已含 origin/main（behind == 0）→ 通过。
//   behind-clean        本分支没有任何注解提交（ahead == 0）且 behind > 0 → 失败：纯过期。
//   diverged-expected   本分支 ahead > 0，且 origin/main 新增提交**全部**是
//                       `sync ZCode source` → **不失败**，但必须打印三项计数：
//                       commits_ahead / commits_behind / 上游最后一次 sync 的 sha 与时间。
//   diverged-unexpected ahead > 0 但 origin/main 含非 sync 提交 → 警告不失败，
//                       逐条列出非 sync 的 subject，由人决断（可能带来真实代码变更）。
//
// 判据：本分支注解提交数 > 0 且 origin 新增提交 subject 匹配 `sync ZCode source`
// 时落 diverged-expected；注解分支不跟 vendor sync 是长期例外，不是红灯。
// 本线**禁止** merge / rebase / push --force，只允许 commit；要同步先单独上报，
// 并给出「注解提交数 / 上游触及文件数」两个数再议。
//
// 用法：node scripts/check-workspace-freshness.mjs [--max-behind-main 50] [--no-fetch]

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const maxBehindMainIndex = args.indexOf("--max-behind-main");
const maxBehindMain =
  maxBehindMainIndex >= 0 ? Number(args[maxBehindMainIndex + 1]) : 50;
if (!Number.isInteger(maxBehindMain) || maxBehindMain < 0) {
  console.error("[freshness] --max-behind-main 需要一个非负整数");
  process.exit(2);
}
const doFetch = !args.includes("--no-fetch");
const SYNC_SUBJECT = /sync ZCode source/i;

async function git(...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { encoding: "utf8" });
  return stdout.trim();
}

if (doFetch) {
  await git("fetch", "origin", "--prune");
}

const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
let upstream = null;
try {
  upstream = await git("rev-parse", "--abbrev-ref", "@{upstream}");
} catch {
  console.warn(
    `[freshness] ${branch} 没有远端跟踪分支，跳过 behind-remote 检查（是否忘了 push -u？）`,
  );
}

// 先算 origin/main 的三态，后面的「落后自己的远端」判定要用它来豁免 vendor sync。
let state = "aligned";
let aheadMain = 0;
let behindMain = 0;
let syncSha = "";
let syncAt = "";
let nonSyncSubjects = [];
let hasMain = true;
try {
  await git("rev-parse", "--verify", "origin/main^{commit}");
  aheadMain = Number(await git("rev-list", "--count", "origin/main..HEAD"));
  behindMain = Number(await git("rev-list", "--count", "HEAD..origin/main"));
  if (behindMain > 0) {
    const raw = await git("log", "--format=%H%x09%cI%x09%s", "HEAD..origin/main");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const syncRows = rows.filter((row) => SYNC_SUBJECT.test(row[2] ?? ""));
    nonSyncSubjects = rows.filter((row) => !SYNC_SUBJECT.test(row[2] ?? "")).map((row) => row[2]);
    if (syncRows.length > 0) {
      syncSha = syncRows[0][0];
      syncAt = syncRows[0][1];
    }
    if (aheadMain > 0 && nonSyncSubjects.length === 0) state = "diverged-expected";
    else if (aheadMain === 0) state = "behind-clean";
    else state = "diverged-unexpected";
  }
} catch {
  hasMain = false;
  console.warn("[freshness] 仓库没有 origin/main，跳过 main 距离检查。");
}

const failures = [];
if (upstream && state !== "diverged-expected") {
  const behindRemote = Number(await git("rev-list", "--count", `HEAD..${upstream}`));
  if (behindRemote > 0) {
    failures.push(
      `${branch} 落后 ${upstream} ${behindRemote} 个提交：先 git merge --ff-only ${upstream}`,
    );
  }
}

if (hasMain && behindMain > 0) {
  const counts = `commits_ahead=${aheadMain} commits_behind=${behindMain}`;
  if (state === "behind-clean") {
    const message = `落后 origin/main ${behindMain} 个提交，超过阈值 ${maxBehindMain}`;
    if (behindMain > maxBehindMain || maxBehindMain === 0) {
      failures.push(`${message}：git merge --ff-only origin/main 或重建分支`);
    }
  } else if (state === "diverged-expected") {
    console.log(
      `[freshness] diverged-expected：${branch} ${counts}；上游最后一次 sync=${syncSha}（${syncAt}）`,
    );
    console.log(
      "[freshness] 判定：注解分支不跟 vendor sync 是长期例外（禁 merge / rebase / push --force）",
    );
  } else {
    console.warn(
      `[freshness] 警告：${branch} ${counts}，origin/main 含非 sync 提交（${nonSyncSubjects.length} 条），分叉需人工决断：`,
    );
    for (const subject of nonSyncSubjects.slice(0, 5)) console.warn(`  - ${subject}`);
  }
}

if (failures.length > 0) {
  console.error(`[freshness] 基线过期，拒绝在旧架构上开工（当前分支：${branch}）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
if (state !== "diverged-expected") {
  console.log(
    `[freshness] 基线新鲜：${branch}${upstream ? `（与 ${upstream} 同步）` : ""}，状态=${state}${
      hasMain ? `，相对 origin/main：ahead ${aheadMain} / behind ${behindMain}` : ""
    }`,
  );
}
