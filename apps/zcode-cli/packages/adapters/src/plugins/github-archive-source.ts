import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
  resolveInside,
} from "./helpers.js";
import {
  PluginZipDownloadError,
  resolveHttpZipSource,
  type ResolvedZipPluginSourceRoot,
} from "./zip-source.js";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/*
 * ============================================================
 * plugins / github-archive-source.ts —— GitHub 公开仓库 zipball 源物化
 *
 * 定位：把 https://github.com/<owner>/<repo> 转成 api.github.com zipball 下载，
 * 再决定“能否安全用 Archive 语义安装”，否则抛 GitHubArchiveRequiresGitError 让上层
 * 回退系统 Git。
 *
 * 输入输出：返回 {path, cleanup} 的临时目录；path 可指向仓库内 subdir。
 *
 * 副作用：网络下载 zip、解压到临时目录、文件系统探测；失败时清理临时目录。
 *
 * 失败语义：非公开 HTTPS GitHub 仓库→RequiresGit；subdir 缺失/符号链接/未知 zip 条目/
 * 401/403/404→可回退 Git；submodule/LFS→RequiresGit（避免装出缺文件的“表面成功”）。
 *
 * 不变量：owner/repo 只允许安全字符且恰好两段；所有 subdir 路径经 resolveInside；
 * 清理错误只追加到原错误，不覆盖原因。
 * ============================================================
 */

export interface PublicGitHubRepository {
  /** 仓库 owner/组织名。 */
  owner: string;
  /** 仓库名（已去掉 .git 后缀）。 */
  repo: string;
}

export interface ResolveGitHubArchiveSourceInput {
  /** 仓库内子目录；不是插件根时用于二次选择。 */
  path?: string;
  /** git pin（分支/tag/sha），默认 HEAD。 */
  pin?: string;
  /** 取消信号，贯穿下载与解压。 */
  signal?: AbortSignal;
  /** 原始源 URL。 */
  url: string;
}

export class GitHubArchiveRequiresGitError extends Error {
  /** 触发回退的原因（submodules/LFS 等），供上层诊断。 */
  readonly reason: string;

  constructor(reason: string) {
    super(`GitHub Archive requires system Git fallback: ${reason}`);
    this.name = "GitHubArchiveRequiresGitError";
    this.reason = reason;
  }
}

/**
 * 严格解析公开 GitHub 仓库 URL：https、github.com、无 userinfo/query/hash、恰好两段路径。
 * 任何不符合都返回 null（调用方据此回退 Git），不抛错。
 */
export function parsePublicGitHubRepositoryUrl(value: string): PublicGitHubRepository | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !GITHUB_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/u, "");
  if (
    !owner ||
    !repo ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !GITHUB_REPOSITORY_SEGMENT.test(owner) ||
    !GITHUB_REPOSITORY_SEGMENT.test(repo)
  ) {
    return null;
  }
  return { owner, repo };
}

/** 拼接 zipball 下载 URL；pin 空值回退 HEAD，并做 URL 编码防止路径注入。 */
export function buildGitHubArchiveUrl(repository: PublicGitHubRepository, pin = "HEAD"): string {
  const normalizedPin = pin.trim() || "HEAD";
  return `https://api.github.com/repos/${repository.owner}/${repository.repo}/zipball/${encodeURIComponent(normalizedPin)}`;
}

/**
 * 下载并物化 GitHub 归档源：解析 URL → zip 下载/解压 → 选 subdir → 检测 Git 专属语义。
 *
 * 成功返回临时根与 cleanup；任何后续失败都会先清理临时目录再抛出（清理错误追加到
 * 原错误 message）。subdir 必须存在且位于解压根内。
 */
export async function resolveGitHubArchiveSource(
  input: ResolveGitHubArchiveSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  const repository = parsePublicGitHubRepositoryUrl(input.url);
  if (!repository) {
    throw new GitHubArchiveRequiresGitError(
      `source is not a public GitHub HTTPS repository: ${input.url}`,
    );
  }
  const resolved = await resolveHttpZipSource({
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ZCode-Plugin-Installer",
    },
    requireSingleRoot: true,
    signal: input.signal,
    stripRoot: true,
    url: buildGitHubArchiveUrl(repository, input.pin),
  });
  try {
    let selectedPath = resolved.path;
    if (input.path) {
      const subdir = resolveInside(resolved.path, input.path);
      if (!subdir || !directoryExists(subdir)) {
        throw new Error(`Plugin source subdirectory does not exist: ${input.path}`);
      }
      selectedPath = subdir;
    }
    const gitReason = await detectRequiredGitSemantics(resolved.path, selectedPath);
    if (gitReason) throw new GitHubArchiveRequiresGitError(gitReason);
    return { cleanup: resolved.cleanup, path: selectedPath };
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(resolved.cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

/**
 * 判断是否应退回系统 Git：显式 RequiresGit、私有/不存在仓库（401/403/404），
 * 或 zip 含符号链接/未知条目（Archive 无法安全表达）。
 */
export function shouldFallbackGitHubArchiveToGit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof GitHubArchiveRequiresGitError ||
    (error instanceof PluginZipDownloadError &&
      (error.status === 401 || error.status === 403 || error.status === 404)) ||
    /plugin zip entry symlinks are not supported|unsupported plugin zip entry type/iu.test(message)
  );
}

/**
 * 检测 Archive 无法完整表达的 Git 语义：submodule、LFS（含祖先目录继承的 LFS 规则）。
 * 返回非 null 即表示必须回退 Git；只读文件，不抛业务错误。
 */
async function detectRequiredGitSemantics(
  repositoryRoot: string,
  selectedRoot: string,
): Promise<string | null> {
  // Archive 不会物化 submodule 或 Git LFS 对象；若仍把指针文件当插件安装，
  // 会得到表面成功但运行时缺文件的损坏缓存，因此这两类仓库必须回到完整 Git 语义。
  if (fileExists(join(repositoryRoot, ".gitmodules"))) {
    return "repository declares Git submodules";
  }
  if (await directoryDeclaresGitLfs(repositoryRoot, selectedRoot === repositoryRoot)) {
    return "repository declares Git LFS filters";
  }
  if (selectedRoot !== repositoryRoot) {
    // Git attributes 从仓库根到目标文件逐级继承。只检查仓库根和插件目录
    // 会漏掉 packages/.gitattributes -> packages/plugin/** 这类父目录 LFS 规则，
    // 进而把 Archive 内的 LFS pointer 当成真实插件资源写入缓存。
    if (await ancestorDirectoriesDeclareGitLfs(repositoryRoot, selectedRoot)) {
      return "selected plugin path inherits Git LFS filters";
    }
    if (await directoryDeclaresGitLfs(selectedRoot, true)) {
      return "selected plugin path declares Git LFS filters";
    }
  }
  return null;
}

/** 从 selectedRoot 的父目录逐级向上检查 .gitattributes（不检查仓库根自身），命中 LFS 即返回 true。 */
async function ancestorDirectoriesDeclareGitLfs(
  repositoryRoot: string,
  selectedRoot: string,
): Promise<boolean> {
  const normalizedRepositoryRoot = resolve(repositoryRoot);
  let current = dirname(resolve(selectedRoot));
  while (current !== normalizedRepositoryRoot) {
    if (await directoryDeclaresGitLfs(current, false)) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** 检查目录 .gitattributes 是否声明 filter=lfs；recursive=true 时递归所有子目录。 */
async function directoryDeclaresGitLfs(rootPath: string, recursive: boolean): Promise<boolean> {
  const attributesPath = join(rootPath, ".gitattributes");
  if (fileExists(attributesPath)) {
    const attributes = await readFile(attributesPath, "utf8");
    if (/(?:^|\s)filter=lfs(?:\s|$)/mu.test(attributes)) return true;
  }
  if (!recursive) return false;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await directoryDeclaresGitLfs(join(rootPath, entry.name), true)) return true;
  }
  return false;
}
