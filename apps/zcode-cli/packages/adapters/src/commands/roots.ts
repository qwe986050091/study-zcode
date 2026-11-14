/**
 * ============================================================================
 * commands/roots.ts —— 自定义命令搜索根目录解析
 * ============================================================================
 *
 * 【定位】产出 CustomCommandRoot 列表（path/scope/source/priority）。priority
 * 从 10 开始、每项 +10，数值越小越先扫描、同名时越优先。
 *
 * 【顺序】extraRoots（显式配置，最高优先）→ 用户级 ~/.zcode 与 ~/.agents →
 * 项目目录链（工作目录向上直到 git 根）的 .zcode/.agents → 额外目录
 * （加目录名 namespace）→ extraResolvedRoots（调用方已解析，最低优先）。
 *
 * 【口径】`~/` 仅识别前缀；相对路径相对工作目录解析；路径统一 resolve 成绝对。
 * 同目录同时存在 `.zcode/commands` 与 `.agents/commands` 时两者都收录，
 * 不互相 fallback。
 *
 * 【副作用】只读：为找 git 根沿父目录做 stat，不写文件。
 * ============================================================================
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CustomCommandRoot, CustomCommandSource } from "@zcode/contracts";

const COMMANDS_DIR = "commands";
const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const PRIORITY_STEP = 10;
const ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface CustomCommandRootResolutionOptions {
  /** 额外命令目录；按项目 scope 收录，并加上目录名作为命名空间。 */
  additionalDirectories?: readonly string[];
  /** 额外根（可含 ~/ 或相对路径）；优先级最高。 */
  extraRoots?: string[];
  /** 已解析好的根对象，原样追加在最末（优先级最低）。 */
  extraResolvedRoots?: CustomCommandRoot[];
  /** 覆盖 home 目录（测试用）；缺省使用 os.homedir()。 */
  homeDirectory?: string;
  /** 是否包含 .zcode 原生命令目录；false 时只保留 .agents 等外部来源。 */
  includeZcodeCommands?: boolean;
}

/**
 * 解析默认命令根列表。
 *
 * 输入 workingDirectory 会被 resolve；输出按 priority 升序即"扫描顺序"。
 * 不存在的目录也会保留在结果里（discover 阶段自行跳过），因此本函数不做
 * 文件系统存在性判断，只做路径归一；唯一 IO 是向上找 .git。
 */
export async function resolveDefaultCustomCommandRoots(
  workingDirectory: string,
  options: CustomCommandRootResolutionOptions = {},
): Promise<CustomCommandRoot[]> {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const roots: CustomCommandRoot[] = [];
  const includeZcode = options.includeZcodeCommands ?? true;
  const home = options.homeDirectory ?? homedir();
  let priority = 0;
  // 每分配一个 root 就 +10，给未来插入中间优先级留空隙。
  const nextPriority = () => {
    priority += PRIORITY_STEP;
    return priority;
  };

  for (const extraRoot of options.extraRoots ?? []) {
    roots.push(
      root(
        resolveConfiguredRoot(extraRoot, resolvedWorkingDirectory, home),
        "project",
        "zcode",
        nextPriority(),
      ),
    );
  }

  if (includeZcode) {
    roots.push(...commandRootsForBase(home, "user", nextPriority));
  }

  const projectDirectories = await resolveProjectDirectories(resolvedWorkingDirectory);
  for (const directory of projectDirectories) {
    if (includeZcode) {
      // 从工作目录向上直到 git 根，越靠近工作目录优先级越高（先被 push）。
      roots.push(...commandRootsForBase(directory, "project", nextPriority));
    }
  }

  for (const directory of new Set(
    (options.additionalDirectories ?? []).map((path) => resolve(path)),
  )) {
    // 工作目录自身已在上面的项目链处理过，重复收录会造成同名命令优先级的歧义。
    if (directory === resolvedWorkingDirectory) continue;
    roots.push(
      ...commandRootsForBase(directory, "project", nextPriority).map((item) => ({
        ...item,
        namespace: basename(directory),
      })),
    );
  }

  roots.push(...(options.extraResolvedRoots ?? []));

  return roots;
}

/**
 * 工作目录 → [工作目录, ..., git 根]。
 *
 * 找不到 .git 时只返回工作目录本身；找到时包含从工作目录到根的全部层级
 * （含根），顺序由近到远。
 */
async function resolveProjectDirectories(workingDirectory: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workingDirectory);
  if (!worktreeRoot) return [workingDirectory];

  const directories: string[] = [];
  let current = workingDirectory;
  while (true) {
    directories.push(current);
    if (current === worktreeRoot || current === dirname(current)) break;
    current = dirname(current);
  }
  return directories;
}

/**
 * 沿父目录查找最近的 .git 标记（文件或目录都算）。
 *
 * 到达文件系统根仍未找到返回 null；每层 stat 失败即视为不存在。
 */
async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    if (await pathExists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 单个基准目录下的两个命令根。
 *
 * 顺序固定为 .zcode → .agents：同目录同名命令时 .zcode 先被扫描而胜出，
 * 但两者都保留，不做覆盖式 fallback。
 */
function commandRootsForBase(
  baseDirectory: string,
  scope: CustomCommandRoot["scope"],
  nextPriority: () => number,
): CustomCommandRoot[] {
  // 合并而不是 fallback：兼容 `.agents` 命令和原生 `.zcode` 命令需要同时可见。
  // 同一级别 `.zcode` 先扫描，命令同名时仍按“先到先赢”处理。
  return [
    root(join(baseDirectory, ZCODE_DIR, COMMANDS_DIR), scope, "zcode", nextPriority()),
    root(join(baseDirectory, AGENTS_DIR, COMMANDS_DIR), scope, "agents", nextPriority()),
  ];
}

function root(
  path: string,
  scope: CustomCommandRoot["scope"],
  source: CustomCommandSource,
  priority: number,
): CustomCommandRoot {
  return {
    path: resolve(path),
    scope,
    source,
    priority,
  };
}

/**
 * 展开配置里的根路径。
 *
 * 仅识别 `~/` 前缀（不展开 `~user`）；其余相对路径相对工作目录解析；
 * 返回绝对路径。
 */
function resolveConfiguredRoot(path: string, workingDirectory: string, home: string): string {
  const expanded = path.startsWith(HOME_PREFIX) ? join(home, path.slice(HOME_PREFIX.length)) : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}
