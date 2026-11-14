// ============================================================
// Node Context Source Adapter
// ============================================================
/**
 * ============================================================================
 * context/index.ts —— 会话启动上下文采集
 * ============================================================================
 *
 * 【定位】组装 provider-visible 的环境快照：cwd/平台/shell/node 版本、
 * git 快照、当前日期、用户/工作区指令（AGENTS.md）与项目类型。
 *
 * 【指令优先级】用户级 `~/.zcode/AGENTS.md`（scope=user）+ 工作区沿目录链
 * 找到的最近 AGENTS.md（scope=workspace）；两者内容按 "\n\n" 拼接，
 * workspace 作为主来源。同一路径去重。读取上限默认 100KB/文件，超限截断。
 *
 * 【失败语义】上下文采集是 best-effort：文件读取失败只写 diagnostic，不抛；
 * 非 git 项目返回 isGitRepository=false；package.json 解析失败仍标记 node。
 *
 * 【副作用】只读文件系统 + 执行只读 git 命令（见 git-snapshot.ts）。
 * ============================================================================
 */

import { readFile, stat } from "node:fs/promises";
import { arch, homedir, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { formatLocalIsoDate } from "@zcode/contracts";
import type {
  ContextSourceDiagnostic,
  ContextSourcePort,
  ContextSourceRequest,
  ContextSourceSnapshot,
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";
import { resolveGitSnapshot } from "./git-snapshot.js";

const DEFAULT_PRIORITY_FILES = ["AGENTS.md"];
const DEFAULT_MAX_BYTES = 100 * 1024;

export interface NodeContextSourceAdapterOptions {
  /** 环境变量来源；缺省 process.env，测试可注入。 */
  env?: NodeJS.ProcessEnv;
}

export class NodeContextSourceAdapter implements ContextSourcePort {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: NodeContextSourceAdapterOptions = {}) {
    this.env = options.env ?? process.env;
  }

  /**
   * 生成一份上下文快照。
   *
   * request 中 envInfo/userInstructions/projectContext 若已由调用方给出则直接
   * 复用（避免重复 IO 与不一致）；否则现场探测。输出 diagnostics 里的告警
   * 不影响成功返回。只读文件系统，可能执行 git 命令。
   */
  async resolveContextSources(request: ContextSourceRequest): Promise<ContextSourceSnapshot> {
    const workingDirectory = resolve(request.workingDirectory);
    const diagnostics: ContextSourceDiagnostic[] = [];
    const projectRoot = await findProjectRoot(workingDirectory);

    const envInfo =
      request.envInfo ??
      (await this.detectEnvInfo(workingDirectory, request.effectiveShellDisplayName));
    const userInstructions = request.userInstructions
      ? await resolveUserInstructions(
          {
            ...request.userInstructions,
            workingDirectory: request.userInstructions.workingDirectory ?? workingDirectory,
            projectRoot: request.userInstructions.projectRoot ?? projectRoot ?? undefined,
          },
          diagnostics,
          this.env,
        )
      : undefined;
    const projectContext =
      request.projectContext ?? (projectRoot ? await detectProjectContext(projectRoot) : undefined);

    return {
      workingDirectory,
      envInfo,
      currentDate: request.currentDate ?? formatLocalIsoDate(new Date()),
      userInstructions,
      projectContext,
      diagnostics,
    };
  }

  /**
   * 探测环境信息。
   *
   * shell 优先用调用方给的可读名（如 "PowerShell"），否则取 SHELL/ComSpec
   * 的 basename；git 快照失败时只返回非 git 字段（见 git-snapshot）。
   */
  private async detectEnvInfo(
    workingDirectory: string,
    effectiveShellDisplayName?: string,
  ): Promise<EnvInfo> {
    const shellPath = this.env.SHELL ?? this.env.ComSpec ?? this.env.COMSPEC ?? "";
    const shell = effectiveShellDisplayName ?? (shellPath ? basename(shellPath) : "unknown");
    const gitSnapshot = await resolveGitSnapshot(workingDirectory);
    return {
      cwd: workingDirectory,
      platform: process.platform,
      shell,
      osVersion: `${process.platform} ${release()} ${arch()}`,
      nodeVersion: process.version,
      ...gitSnapshot,
    };
  }
}

/** 创建上下文源适配器（无缓存，每次调用重新采集）。 */
export function createNodeContextSourceAdapter(
  options: NodeContextSourceAdapterOptions = {},
): NodeContextSourceAdapter {
  return new NodeContextSourceAdapter(options);
}

/**
 * 解析用户/工作区指令文件。
 *
 * 用户级固定为 ~/.zcode/AGENTS.md（仅当 priorityFiles 含 AGENTS.md）；
 * 工作区从 workingDirectory 向上找到 projectRoot（含）为止。两个候选按路径
 * 去重后逐个读取，全部失败或为空时返回 undefined。
 */
async function resolveUserInstructions(
  options: UserInstructionsOptions,
  diagnostics: ContextSourceDiagnostic[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUserInstructions | undefined> {
  const priorityFiles = options.priorityFiles ?? DEFAULT_PRIORITY_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const projectRoot = options.projectRoot ?? (await findProjectRoot(options.workingDirectory));

  const defaultUserInstructionFile = await findDefaultUserInstructionFile(priorityFiles, env);
  const workspaceInstructionFile = await findInstructionFile(
    options.workingDirectory,
    projectRoot,
    priorityFiles,
  );
  const candidates = dedupeInstructionFileCandidates([
    defaultUserInstructionFile
      ? { ...defaultUserInstructionFile, scope: "user" as const }
      : undefined,
    workspaceInstructionFile
      ? { ...workspaceInstructionFile, scope: "workspace" as const }
      : undefined,
  ]);
  const sources: ResolvedUserInstructionSource[] = [];

  for (const candidate of candidates) {
    const source = await readInstructionSource(candidate, maxBytes, diagnostics);
    if (source) {
      sources.push(source);
    }
  }

  if (sources.length === 0) return undefined;

  return mergeInstructionSources(sources);
}

/**
 * 只读文件头 maxBytes 字节并按 UTF-8 解码。
 *
 * 不做 BOM/换行归一；截断可能切断多字节字符（尾部替换字符可接受，因为
 * 上下文只是提示）。
 */
async function readFirstTextBytes(path: string, maxBytes: number): Promise<string> {
  const content = await readFile(path);
  return content.subarray(0, maxBytes).toString("utf8");
}

type InstructionFileCandidate = {
  filePath: string;
  fileName: string;
  scope: ResolvedUserInstructionSource["scope"];
};

/**
 * 按绝对路径去重候选（用户级与工作区可能指向同一文件，如 home 恰是项目根）。
 *
 * 保留先出现的候选及其 scope，后出现的重复项丢弃。
 */
function dedupeInstructionFileCandidates(
  candidates: Array<InstructionFileCandidate | undefined>,
): InstructionFileCandidate[] {
  const seen = new Set<string>();
  const deduped: InstructionFileCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = resolve(candidate.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

/**
 * 读取单个指令文件为 source。
 *
 * 输入 maxBytes 是读取上限；输出 sizeBytes 恒为真实文件大小，truncated 表示
 * 是否被截断。读取/stat 失败写 diagnostic 并返回 undefined，不抛错。
 */
async function readInstructionSource(
  candidate: InstructionFileCandidate,
  maxBytes: number,
  diagnostics: ContextSourceDiagnostic[],
): Promise<ResolvedUserInstructionSource | undefined> {
  try {
    const info = await stat(candidate.filePath);
    const bytesToRead = Math.min(info.size, maxBytes);
    const content = await readFirstTextBytes(candidate.filePath, bytesToRead);
    return {
      scope: candidate.scope,
      filePath: candidate.filePath,
      fileName: candidate.fileName,
      content,
      bytesRead: Buffer.byteLength(content),
      sizeBytes: info.size,
      truncated: info.size > maxBytes,
    };
  } catch (error) {
    diagnostics.push({
      code: "user_instructions_read_failed",
      message: error instanceof Error ? error.message : "Failed to read user instructions",
      path: candidate.filePath,
    });
    return undefined;
  }
}

/**
 * 合并多份指令源。
 *
 * content 按来源顺序用空行拼接；filePath/fileName/bytesRead/sizeBytes 取主源
 * （优先 workspace，否则第一份）；truncated 为任一源截断即为 true。
 */
function mergeInstructionSources(
  sources: ResolvedUserInstructionSource[],
): ResolvedUserInstructions {
  const primary = sources.find((source) => source.scope === "workspace") ?? sources[0];
  const content = sources.map((source) => source.content).join("\n\n");

  return {
    filePath: primary.filePath,
    fileName: primary.fileName,
    content,
    bytesRead: sources.reduce((sum, source) => sum + source.bytesRead, 0),
    sizeBytes: sources.reduce((sum, source) => sum + source.sizeBytes, 0),
    truncated: sources.some((source) => source.truncated),
    sources,
  };
}

/**
 * 从 startDir 向上查找优先级文件，直到 projectRoot（含）或文件系统根。
 *
 * 同一目录内按 priorityFiles 顺序取第一个存在的文件；先到先得，因此越靠近
 * 工作目录的同名文件优先级越高。
 */
async function findInstructionFile(
  startDir: string,
  projectRoot: string | null,
  priorityFiles: string[],
): Promise<{ filePath: string; fileName: string } | undefined> {
  let current = resolve(startDir);

  while (true) {
    for (const fileName of priorityFiles) {
      const filePath = join(current, fileName);
      if (await isFile(filePath)) {
        return { filePath, fileName };
      }
    }

    if (current === projectRoot || current === dirname(current)) {
      break;
    }

    current = dirname(current);
  }

  return undefined;
}

/**
 * 查找用户级 AGENTS.md：`~/.zcode/AGENTS.md`。
 *
 * 只有 priorityFiles 包含 AGENTS.md 时才查找；HOME/USERPROFILE 为空则回退
 * 到 os.homedir()。
 */
async function findDefaultUserInstructionFile(
  priorityFiles: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ filePath: string; fileName: string } | undefined> {
  if (!priorityFiles.includes("AGENTS.md")) {
    return undefined;
  }

  const filePath = join(resolveUserHomeDir(env), ".zcode", "AGENTS.md");
  if (await isFile(filePath)) {
    return { filePath, fileName: "AGENTS.md" };
  }

  return undefined;
}

function resolveUserHomeDir(env: NodeJS.ProcessEnv): string {
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/**
 * 轻量识别项目类型与包管理器。
 *
 * 类型按 package.json → python 标记 → Cargo.toml → go.mod → java 构建文件的
 * 顺序首个命中；packageManager 按 lockfile 判定。只读少量标记文件，不解析
 * 依赖树。package.json 解析失败仍标记为 node（文件存在即说明是 Node 项目）。
 */
async function detectProjectContext(projectRoot: string): Promise<ProjectContext> {
  let type: ProjectType = "unknown";
  let packageManager: PackageManager | undefined;
  let scripts: Record<string, string> | undefined;
  const buildFiles: string[] = [];

  const packageJsonPath = join(projectRoot, "package.json");
  if (await isFile(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: unknown;
      };
      type = "node";
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts = pkg.scripts as Record<string, string>;
      }
    } catch {
      type = "node";
    }
  }

  if (type === "unknown") {
    const pythonIndicators = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"];
    for (const file of pythonIndicators) {
      if (await isFile(join(projectRoot, file))) {
        type = "python";
        break;
      }
    }
  }

  if (type === "unknown" && (await isFile(join(projectRoot, "Cargo.toml")))) {
    type = "rust";
  }
  if (type === "unknown" && (await isFile(join(projectRoot, "go.mod")))) {
    type = "go";
  }
  if (type === "unknown") {
    for (const file of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
      if (await isFile(join(projectRoot, file))) {
        type = "java";
        break;
      }
    }
  }

  if (await isFile(join(projectRoot, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (await isFile(join(projectRoot, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (await isFile(join(projectRoot, "bun.lockb"))) {
    packageManager = "bun";
  } else if (await isFile(join(projectRoot, "package-lock.json"))) {
    packageManager = "npm";
  }

  for (const file of ["Makefile", "docker-compose.yml", "docker-compose.yaml", "Dockerfile"]) {
    if (await isFile(join(projectRoot, file))) {
      buildFiles.push(file);
    }
  }

  return {
    type,
    packageManager,
    scripts,
    buildFiles: buildFiles.length > 0 ? buildFiles : undefined,
  };
}

/**
 * 向上查找项目根（含 .git 的目录）。
 *
 * 只检查到文件系统根之前；未找到返回 null。.git 为文件（worktree）也算。
 */
async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = resolve(startDir);

  while (current !== dirname(current)) {
    if (await hasGitMarker(current)) return current;
    current = dirname(current);
  }

  return null;
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
