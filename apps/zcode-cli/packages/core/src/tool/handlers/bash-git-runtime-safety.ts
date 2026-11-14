// INV-01 复合命令逐个检查：守住位置 集合遍历；改错故障 管道后的 git 漏检。
// INV-02 命令名优先归一化：守住位置 归一化函数；改错故障 包装命令绕过检查。
// INV-03 git 与目录切换同时出现才拦截：守住位置 组合判断；改错故障 普通 cd 命令被拒。
// INV-04 逐层剥离内建包装：守住位置 循环；改错故障 command git 识别失败。
// INV-05 无法归一化回退原名：守住位置 空值合并；改错故障 命令被当成未知。
// INV-06 无 cwd 视为安全：守住位置 入口判断；改错故障 只读命令全部被拒。
// INV-07 cwd 无法解析即不安全：守住位置 解析失败分支；改错故障 已删除目录仍放行。
// INV-08 当前目录可信即放行：守住位置 trusted 分支；改错故障 正常仓库被逐级扫描。
// INV-09 向上查找直到根：守住位置 父目录循环；改错故障 嵌套工作区漏判。
// INV-10 裸仓库信号即拒绝：守住位置 HEAD 与 objects；改错故障 裸仓库被当普通目录。
// INV-11 符号链接 .git 解析后再判：守住位置 链接分支；改错故障 链接指向工作区外。
// INV-12 指针文件限长：守住位置 大小判断；改错故障 超大文件拖慢解析。
// INV-13 指针文件禁空字符：守住位置 内容检查；改错故障 二进制内容被当成路径。
// INV-14 gitdir 目标必须在 cwd 外：守住位置 路径包含判断；改错故障 自引用仓库通过。
// INV-15 目标路径必须含 .git 段：守住位置 段判断；改错故障 任意目录被当成仓库。
// INV-16 HEAD 只认引用或对象号：守住位置 两侧正则；改错故障 伪造 HEAD 通过。
// INV-17 commondir 存在即视为工作树：守住位置 二次检查；改错故障 子模块被误判可信。
// INV-18 读取异常按无仓库处理：守住位置 捕获分支；改错故障 权限错误导致命令被拒。
//
// 模块职责：在只读判定放行 git 前校验仓库归属与形态。
// 状态所有权：纯函数；所有输入来自命令分析与运行时上下文。
// 阅读顺序：先看命令识别，再看上下文入口，最后看 .git 形态分类。
/**
 * git 运行时安全校验：在只读判定放行 git 之前，确认 cwd 的 .git 目录/指针没有指向工作区外
 * 或不可信的仓库，防止 `cd repo && git log` 触发恶意 hooks/config。
 * 输入是归一化后的命令名与 BashReadonlyRuntimeContext（cwd/workspaceRoot）；
 * 无法解析或形态异常（符号链接 .git、超大指针文件、指向工作区外的 gitdir、裸仓库）都判 unsafe。
 * 被 bash-semantics.ts 的 isRuntimeReadOnlyBashCommand 与 -argv-git.ts 调用。
 */

import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface BashReadonlyRuntimeContext {
  workingDirectory?: string;
  workspaceRoot?: string;
}

// analysisContainsGitCommand 逐个拆开的 commandPart 检查，只看 argv 里是否出现 git。
// 命令名优先取 normalizeCommandName 的结果，取不到才退回原始 name。
// bash -c / env / xargs 这类包装形式也按内层命令识别，不只匹配第一层。
// 仅判断是否出现 git。
export function analysisContainsGitCommand(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  return commands.some((commandPart) => {
    // 优先用 argv 归一化后的名字：`command git`/`noglob git` 的真实命令名才是 git。
    const name = normalizedSimpleCommandName(commandPart.argv) ?? commandPart.name;
    return name === "git";
  });
}

export function analysisContainsGitAndDirectoryChange(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  let hasGit = false;
  let hasDirectoryChange = false;
  for (const commandPart of commands) {
    const name = normalizedSimpleCommandName(commandPart.argv) ?? commandPart.name;
    hasGit ||= name === "git";
    hasDirectoryChange ||= name === "cd" || name === "pushd" || name === "popd";
  }

  // 因为 git 可能在目标目录加载 hooks/config；普通 `cd && grep/find` 仍可只读放行。
  return hasGit && hasDirectoryChange;
}

function normalizedSimpleCommandName(argv: readonly string[]): string | undefined {
  // 逐层剥掉 command/builtin/noglob 等内建包装，直到拿到真正的可执行名。
  let words = [...argv];
  for (;;) {
    if (words[0] === "command") {
      let index = 1;
      while (words[index] !== undefined && /^-p+$/.test(words[index] ?? "")) index += 1;
      if (words[index] === "--") index += 1;
      if (index >= words.length || words[index]?.startsWith("-")) return words[0];
      words = words.slice(index);
      continue;
    }
    if (words[0] === "builtin") {
      const index = words[1] === "--" ? 2 : 1;
      if (index >= words.length) return words[0];
      words = words.slice(index);
      continue;
    }
    if (words[0] === "noglob") {
      if (words.length <= 1) return words[0];
      words = words.slice(1);
      continue;
    }
    return words[0];
  }
}

type GitDirectoryState = "none" | "trusted" | "unsafe";

// .git 指针文件超过 32KB 视为异常；正常 gitdir: 指针只有一行。
const MAX_GITDIR_FILE_BYTES = 32 * 1024;

// 无 cwd 视为安全。
// 当前目录可信即放行。
// 否则逐级向上查找。
export function isGitRuntimeContextUnsafe(
  context: BashReadonlyRuntimeContext | undefined,
): boolean {
  const cwd = context?.workingDirectory;
  if (!cwd) return false;

  const cwdCanonical = canonicalPath(cwd);
  // cwd 无法 realpath（被删除/无权限）时无法校验 .git 归属，按不安全处理。
  if (!cwdCanonical) return true;

  const cwdDotGit = classifyDotGitDirectory(cwd, cwdCanonical);
  // 当前目录自身就是可信仓库时直接放行；unsafe 立即拒绝；none 则继续向上查找。
  if (cwdDotGit === "trusted") return false;
  if (cwdDotGit === "unsafe") return true;

  let current = cwd;
  for (;;) {
    if (hasBareGitIndicators(current)) return true;

    const parent = dirname(current);
    if (parent === current) return false;

    const parentState = classifyDotGitDirectory(parent, cwdCanonical);
    if (parentState === "trusted") return false;
    if (parentState === "unsafe") return true;
    current = parent;
  }
}

// 符号链接先 readlink 到真实路径，再判断该路径是否落在 cwdCanonical 之内。
// 指针文件限长且禁空字符。
// 目录形态检查 HEAD 与对象。
// 读取失败按无仓库处理。
function classifyDotGitDirectory(directory: string, cwdCanonical: string): GitDirectoryState {
  // .git 可能是符号链接或 gitdir 指针文件，真实仓库位置必须解析后再判断是否可信。
  const dotGitPath = join(directory, ".git");
  try {
    const dotGitStat = lstatSync(dotGitPath);
    if (dotGitStat.isSymbolicLink()) {
      const target = readFileSystemLinkTarget(dotGitPath, directory);
      return target ? classifyGitDirTarget(target, cwdCanonical) : "unsafe";
    }
    if (dotGitStat.isFile()) {
      if (dotGitStat.size > MAX_GITDIR_FILE_BYTES) return "unsafe";
      const content = readFileSync(dotGitPath, "utf8");
      if (content.includes("\0")) return "unsafe";
      if (!content.startsWith("gitdir: ")) return "none";
      const targetText = content.slice("gitdir: ".length).replace(/[\r\n]+$/, "");
      return classifyGitDirTarget(
        isAbsolute(targetText) ? targetText : join(directory, targetText),
        cwdCanonical,
      );
    }
    if (dotGitStat.isDirectory()) return hasTrustedGitDirectory(dotGitPath) ? "trusted" : "none";
  } catch {
    return "none";
  }
  return "none";
}

// 目标必须可解析。
// 目标不能等于或位于 cwd 内。
// 路径中必须有 .git 段。
function classifyGitDirTarget(target: string, cwdCanonical: string): GitDirectoryState {
  const targetCanonical = canonicalPath(target);
  if (!targetCanonical) return "unsafe";
  // 目标就是 cwd 本身或在 cwd 内 → 等于把当前目录当仓库，布局异常；路径中不含 .git 段同理。
  if (pathIsSameOrInside(targetCanonical, cwdCanonical)) return "unsafe";
  if (!pathHasGitSegment(targetCanonical)) return "unsafe";
  return hasValidGitHead(targetCanonical) ? "trusted" : "none";
}

function readFileSystemLinkTarget(path: string, directory: string): string | undefined {
  try {
    const target = readlinkSync(path);
    return isAbsolute(target) ? target : join(directory, target);
  } catch {
    return undefined;
  }
}

// HEAD 必须合法。
// objects 与 refs 必须可访问。
// 出现 commondir 即视为工作树。
function hasTrustedGitDirectory(directory: string): boolean {
  // 可信 .git 需要合法 HEAD、可访问的 objects/refs，且不能是 worktree 的 commondir 指针。
  if (!hasValidGitHead(directory)) return false;
  try {
    for (const child of ["objects", "refs"]) {
      const childPath = join(directory, child);
      if (!statSync(childPath).isDirectory()) return false;
      accessSync(childPath, constants.X_OK);
    }
    try {
      statSync(join(directory, "commondir"));
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function hasValidGitHead(directory: string): boolean {
  try {
    const headPath = join(directory, "HEAD");
    const headStat = lstatSync(headPath);
    if (!headStat.isFile() || headStat.size > 4096) return false;
    const head = readFileSync(headPath, "utf8").slice(0, 255);
    // HEAD 只能是 refs/ 引用或 40/64 位十六进制对象 ID，其它内容视为伪造/异常仓库。
    return /^ref:[ \t]*refs\//.test(head) || /^[0-9a-f]{40}([0-9a-f]{24})?[ \t\n\r]*$/.test(head);
  } catch {
    return false;
  }
}

// 目录里出现 HEAD 或 objects/refs，说明这是裸仓库根；git 会在该目录直接读写仓库，故判不安全。
function hasBareGitIndicators(directory: string): boolean {
  const headPath = join(directory, "HEAD");
  try {
    const head = lstatSync(headPath);
    if (head.isFile() || head.isSymbolicLink()) return true;
  } catch {
    // 缺少 HEAD 不是裸仓库信号，继续检查 objects/refs。
  }
  return ["objects", "refs"].some((child) => pathExists(join(directory, child)));
}

function canonicalPath(path: string): string | undefined {
  try {
    return normalizeCanonicalPath(realpathSync.native(resolve(path)));
  } catch {
    return undefined;
  }
}

function normalizeCanonicalPath(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC").toLowerCase();
}

function pathIsSameOrInside(path: string, base: string): boolean {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return path === base || path.startsWith(normalizedBase);
}

function pathHasGitSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".git");
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
