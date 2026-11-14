/**
 * ============================================================================
 * skills/roots.ts —— 技能搜索根解析
 * ============================================================================
 *
 * 【定位】与 commands/roots.ts 同构：extraRoots（最高优先）→ 用户级 ~/.zcode
 * 与 ~/.agents → 项目目录链（工作目录到 git 根）→ 额外目录（加 namespace）→
 * extraResolvedRoots（最低优先）。
 *
 * 【口径】每级同时收集 `.zcode/skills` 与 `.agents/skills`（合并非 fallback）；
 * priority 从 10 起每次 +10，升序即扫描顺序。
 *
 * 【副作用】只读：为找 git 根沿父目录 stat。目录不存在也保留（扫描阶段跳过）。
 * ============================================================================
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SkillRoot, SkillSource } from "@zcode/contracts";

const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const PRIORITY_STEP = 10;
const SKILLS_DIR = "skills";
const ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface SkillRootResolutionOptions {
  /** 覆盖 home 目录（测试用）；缺省 os.homedir()。 */
  homeDirectory?: string;
  /** 额外技能根目录；按项目 scope 收录并加目录名 namespace。 */
  additionalDirectories?: readonly string[];
  /** 额外根（支持 ~/ 与相对路径）；优先级最高。 */
  extraRoots?: string[];
  /** 已解析好的根对象，原样追加在最后（优先级最低）。 */
  extraResolvedRoots?: SkillRoot[];
  /** 是否收录 .zcode/skills；false 时只保留 .agents 等兼容来源。 */
  includeZcodeSkills?: boolean;
}

/**
 * 解析默认技能根列表。
 *
 * 输入工作目录会 resolve；输出按 priority 升序即扫描顺序，同路径先到先得。
 * 不做目录存在性判断（唯一 IO 是向上找 .git），不存在的根由扫描阶段跳过。
 */
export async function resolveDefaultSkillRoots(
  workingDirectory: string,
  options: SkillRootResolutionOptions = {},
): Promise<SkillRoot[]> {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const roots: SkillRoot[] = [];
  const includeZcode = options.includeZcodeSkills ?? true;
  const home = options.homeDirectory ?? homedir();
  let priority = 0;
  const nextPriority = () => {
    priority += PRIORITY_STEP;
    return priority;
  };

  for (const extraRoot of options.extraRoots ?? []) {
    roots.push(
      root(
        resolveConfiguredRoot(extraRoot, resolvedWorkingDirectory),
        "project",
        "zcode",
        nextPriority(),
      ),
    );
  }

  if (includeZcode) {
    roots.push(...skillRootsForBase(home, "user", nextPriority));
  }

  const projectDirectories = await resolveProjectSkillDirectories(resolvedWorkingDirectory);
  for (const directory of projectDirectories) {
    if (includeZcode) {
      roots.push(...skillRootsForBase(directory, "project", nextPriority));
    }
  }

  for (const directory of new Set(
    (options.additionalDirectories ?? []).map((path) => resolve(path)),
  )) {
    if (directory === resolvedWorkingDirectory) continue;
    roots.push(
      ...skillRootsForBase(directory, "project", nextPriority).map((item) => ({
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
 * 未找到 .git 时只返回工作目录；找到时包含根自身，顺序由近到远（近者优先）。
 */
async function resolveProjectSkillDirectories(workingDirectory: string): Promise<string[]> {
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
 * 沿父目录查找最近的 .git（文件或目录均可）。
 *
 * 到文件系统根仍未命中返回 null；每层 stat 失败按不存在处理。
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
 * 单个基准目录下的两个技能根。
 *
 * 合并而非 fallback：用户可能同时安装 .zcode 原生技能与 .agents 兼容技能；
 * 同层仍保持 .zcode 先扫（priority 更小），同名时优先。
 */
function skillRootsForBase(
  baseDirectory: string,
  scope: SkillRoot["scope"],
  nextPriority: () => number,
): SkillRoot[] {
  // 合并而不是 fallback：用户可能同时安装原生 `.zcode` skill 和兼容 `.agents` skill。
  // 同一级别仍保持 `.zcode` 优先，后续同名按 root 顺序解析。
  return [
    root(join(baseDirectory, ZCODE_DIR, SKILLS_DIR), scope, "zcode", nextPriority()),
    root(join(baseDirectory, AGENTS_DIR, SKILLS_DIR), scope, "agents", nextPriority()),
  ];
}

function root(
  path: string,
  scope: SkillRoot["scope"],
  source: SkillSource,
  priority: number,
): SkillRoot {
  return {
    path: resolve(path),
    scope,
    source,
    priority,
  };
}

/**
 * 展开配置中的根路径。
 *
 * 仅识别 `~/` 前缀；相对路径相对工作目录解析；结果 resolve 为绝对路径。
 */
function resolveConfiguredRoot(path: string, workingDirectory: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(homedir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}
