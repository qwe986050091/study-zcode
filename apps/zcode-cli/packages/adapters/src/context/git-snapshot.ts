/**
 * ============================================================================
 * context/git-snapshot.ts —— 只读 git 环境快照
 * ============================================================================
 *
 * 【定位】采集 provider-visible 的 git 信息：是否仓库、当前分支、主分支、
 * user.name、git status 摘要、最近 5 条提交。
 *
 * 【只读约束】全部命令只读；status/log 加 `--no-optional-locks`，避免与用户
 * 正在执行的 git 操作争抢 index.lock。
 *
 * 【失败语义】所有 git 命令都不抛：非仓库返回 isGitRepository=false；
 * 命令失败丢弃输出（防止错误文本进入 prompt），最多 3s 超时、1MB 输出上限。
 *
 * 【口径】status 按 2k 字符截断后转行数组，非空即 dirty；分支取不到时回退
 * "HEAD"；主分支优先 origin/HEAD，再试 main/master，最终默认 "main"。
 * ============================================================================
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { EnvInfo } from "@zcode/contracts";

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_COMMAND = "git";
const GIT_STATUS_NOT_REPO = "not_repo" as const;
const GIT_STATUS_CLEAN = "clean" as const;
const GIT_STATUS_DIRTY = "dirty" as const;
const MAX_RECENT_COMMITS = 5;
const DEFAULT_MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;
const MAX_GIT_STATUS_CONTEXT_CHARS = 2000;

const execFile = promisify(execFileCallback);

interface GitCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface ExecFileFailure extends Error {
  code?: number | string | null;
}

/**
 * 采集 git 快照。
 *
 * 输入工作目录；输出 Partial<EnvInfo>：非 git 时只含 isGitRepository=false 与
 * gitStatus="not_repo"；是 git 时尽量填充各字段，取不到的字段为 undefined。
 * 只读、无副作用（除 git 自身的只读开销），永不抛错。
 */
export async function resolveGitSnapshot(workingDirectory: string): Promise<Partial<EnvInfo>> {
  const insideWorkTree = await readTrimmedGitOutput(
    ["rev-parse", "--is-inside-work-tree"],
    workingDirectory,
  );
  if (insideWorkTree !== "true") {
    // 明确非仓库：不再执行后续命令，避免在非仓库目录产生一串失败开销。
    return {
      isGitRepository: false,
      gitStatus: GIT_STATUS_NOT_REPO,
    };
  }

  const gitBranch = await resolveGitBranch(workingDirectory);
  const gitMainBranch = await resolveMainBranch(workingDirectory);
  const gitUser = await resolveGitUser(workingDirectory);
  const statusOutput = await readGitOutput(
    ["--no-optional-locks", "status", "--short"],
    workingDirectory,
  );
  const gitStatusLines = splitGitStatusForContext(statusOutput?.trim() ?? "");
  const recentCommitOutput = await readGitOutput(
    ["--no-optional-locks", "log", "--oneline", "-n", String(MAX_RECENT_COMMITS)],
    workingDirectory,
  );
  const recentCommits = splitNonEmptyLines(recentCommitOutput).slice(0, MAX_RECENT_COMMITS);

  return {
    isGitRepository: true,
    gitBranch,
    gitMainBranch,
    gitUser,
    gitStatus: gitStatusLines.length > 0 ? GIT_STATUS_DIRTY : GIT_STATUS_CLEAN,
    gitStatusLines,
    recentCommits,
  };
}

async function resolveGitBranch(workingDirectory: string): Promise<string | undefined> {
  const branch = await readTrimmedGitOutput(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    workingDirectory,
  );
  return branch || "HEAD";
}

async function resolveMainBranch(workingDirectory: string): Promise<string | undefined> {
  const remoteHead = await readTrimmedGitOutput(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    workingDirectory,
  );
  const originHeadBranch = remoteHead?.replace(/^origin\//, "");
  const candidates = originHeadBranch
    ? [originHeadBranch, ...DEFAULT_MAIN_BRANCH_CANDIDATES]
    : [...DEFAULT_MAIN_BRANCH_CANDIDATES];

  for (const candidate of candidates) {
    // 只有远程分支真实存在才算主分支；否则继续尝试下一个候选，避免误报。
    if (
      await gitCommandSucceeds(
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
        workingDirectory,
      )
    ) {
      return candidate;
    }
  }

  return "main";
}

async function resolveGitUser(workingDirectory: string): Promise<string | undefined> {
  return readTrimmedGitOutput(["config", "user.name"], workingDirectory);
}

async function gitCommandSucceeds(args: string[], workingDirectory: string): Promise<boolean> {
  const result = await execGitNoThrow(args, workingDirectory);
  return result.code === 0;
}

async function readTrimmedGitOutput(
  args: string[],
  workingDirectory: string,
): Promise<string | undefined> {
  const output = await readGitOutput(args, workingDirectory);
  const trimmed = output?.trim();
  return trimmed ? trimmed : undefined;
}

async function readGitOutput(
  args: string[],
  workingDirectory: string,
): Promise<string> {
  const result = await execGitNoThrow(args, workingDirectory);
  return result.stdout;
}

/**
 * 执行 git 命令且永不抛错。
 *
 * 成功返回 code=0 与 stdout/stderr；失败返回非 0 code，但刻意清空输出：
 * git 的错误文本可能包含路径/凭据痕迹，不应进入 provider-visible 上下文。
 * 超时/缓冲超限同样走 catch，统一按失败处理。
 */
async function execGitNoThrow(
  args: string[],
  workingDirectory: string,
): Promise<GitCommandResult> {
  try {
    const result = await execFile(GIT_COMMAND, args, {
      cwd: workingDirectory,
      encoding: "utf8",
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER_BYTES,
      timeout: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      code: 0,
      stderr: outputToString(result.stderr),
      stdout: outputToString(result.stdout),
    };
  } catch (error) {
    const failure = error as ExecFileFailure;
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      // 命令失败时丢弃 stdout/stderr，避免把不可靠的错误输出写入 provider-visible git context。
      stderr: "",
      stdout: "",
    };
  }
}

function outputToString(output: Buffer | string | undefined): string {
  if (typeof output === "string") {
    return output;
  }
  return output?.toString("utf8") ?? "";
}

function splitGitStatusForContext(status: string): string[] {
  if (status.length === 0) {
    return [];
  }

  // 超长 status 只保留前 2k 字符并追加提示，避免单条上下文挤占 prompt 预算。
  const boundedStatus =
    status.length > MAX_GIT_STATUS_CONTEXT_CHARS
      ? `${status.substring(0, MAX_GIT_STATUS_CONTEXT_CHARS)}
... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${gitStatusToolName()})`
      : status;

  // 与上游 CLI 保持一致：git status 只按 2k 字符截断，不按文件条目数截断，避免 provider-visible prompt 形状漂移。
  return boundedStatus.split(/\r?\n/u).filter((line) => line.length > 0);
}

function gitStatusToolName(): "Bash" | "PowerShell" {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
