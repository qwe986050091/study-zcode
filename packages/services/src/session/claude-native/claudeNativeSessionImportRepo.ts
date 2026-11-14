// Claude 原生会话仓库：在 ~/.claude/projects 下发现、筛选并复制可导入的 jsonl。
// 只读源目录，写入只发生在受管副本目录；扫描失败按空结果处理，不阻止启动。
// 本类不做消息解析，头部判断委托给 headParser 与 sessionHistoryJsonl。
import { copyFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir, getDataBaseDir, getWorkspaceHash } from "#src/paths.js";
import {
  extractClaudeNativeSessionHeadInfo,
  hasClaudeNativeSidechainMarker,
} from "#src/session/claude-native/claudeNativeSessionHeadParser.js";
import { readJsonLinesFileHead } from "#src/session/claude-native/sessionHistoryJsonl.js";

// 扫描日志与导入编排共用名称，便于串起一次导入的完整链路。
const logger = createServiceLogger("claude-native-import");
// 扫描时跳过的目录：子代理 transcript 与临时 worktree 都不代表用户主会话。
// 目录名统一转小写比较，兼容不同平台的大小写差异。
const CLAUDE_NATIVE_IGNORED_TRANSCRIPT_DIR_NAMES = new Set(["subagents", "worktree", "worktrees"]);

// 仅用于比较的路径归一，不写回任何持久化字段。
function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// 判定路径是否位于 .claude/worktree(s) 下：这类 workspace 生命周期短，不应进入导入列表。
// 按段比较而不是字符串包含，避免名为 my.worktree 的普通目录被误判。
function isClaudeWorktreeWorkspacePath(path: string): boolean {
// 统一分隔符并转小写后按段比较，避免字符串包含造成误判。
// 段数组保留原始顺序，用于判断 .claude 后紧跟的目录名。
  const normalizedSegments = normalize(resolve(path))
    .replaceAll("\\", "/")
    .split("/")
// 仅用于比较的大小写归一，不改变真实路径。
    .map((segment) => segment.toLowerCase());

// 任一层命中 .claude/worktree(s) 即判定为临时 workspace。
  return normalizedSegments.some(
    (segment, index) =>
// 必须同时满足 .claude 段与紧随其后的 worktree 段。
      segment === ".claude" &&
// worktree 与 worktrees 两种目录名历史上都出现过。
      (normalizedSegments[index + 1] === "worktree" ||
        normalizedSegments[index + 1] === "worktrees"),
  );
}

// 目录名统一小写后查表，规则集中在一处便于扩展。
function shouldIgnoreClaudeNativeTranscriptDir(name: string): boolean {
  return CLAUDE_NATIVE_IGNORED_TRANSCRIPT_DIR_NAMES.has(name.toLowerCase());
}

// 存在性探测吞掉所有 stat 异常：权限不足也按不存在处理，避免扫描中断。
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// 仓库类无内部可变状态，可安全复用于并发扫描；所有方法都从磁盘现读。
// 对外只暴露扫描、查找与复制三类操作。
export class ClaudeNativeSessionImportRepo {
// 原生历史根目录候选：当前用户 HOME、$HOME 与数据根目录下的 .claude/projects。
// 之所以要多候选，是因为数据目录可能被迁移到其他盘而 .claude 仍在真实 HOME。
// 返回去重后的路径列表，顺序不影响结果。
  private getNativeProjectsRoots(): string[] {
// 用 Set 去重，避免同一 HOME 被重复扫描。
    const homes = new Set<string>();
// 当前进程用户的 HOME 永远是第一候选。
    homes.add(homedir());

// 环境变量 HOME 可能被测试或启动器覆盖，优先纳入候选。
    const envHome = process.env.HOME?.trim();
// $HOME 可能被启动器覆盖，存在时一并扫描。
    if (envHome) {
      homes.add(envHome);
    }

// 数据根目录用于兼容把 .claude 一起迁移到数据盘的用户。
    const dataBaseDir = getDataBaseDir();
// 数据根目录只在其配置存在时加入，避免扫描无意义的相对路径。
    if (dataBaseDir) {
      homes.add(dataBaseDir);
    }

    // 关键业务逻辑：扫描 Claude Code 原生历史目录 ~/.claude/projects，不是 zcode 自己的数据目录。
    // 当 ZCODE_DATA_BASE_DIR 把 .zcode 放到别处时，原生 .claude 往往仍在真实用户 HOME 下。
// 统一拼成 .claude/projects；不存在的路径在后续 readdir 时自然失败并被忽略。
    return [...homes].map((homePath) => join(homePath, ".claude", "projects"));
  }

// 深度优先查找 {sessionId}.jsonl；命中即返回，找不到返回 null。
  private async findSessionFile(rootDir: string, sessionId: string): Promise<string | null> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (shouldIgnoreClaudeNativeTranscriptDir(entry.name)) {
            continue;
          }
// 递归进入子目录；被忽略的目录名（subagents/worktree）在上方已跳过。
          const nestedMatch = await this.findSessionFile(entryPath, sessionId);
          if (nestedMatch) {
            return nestedMatch;
          }
          continue;
        }
// 文件名精确匹配，避免前缀相同的其他会话被误命中。
        if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
          return entryPath;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

// 递归收集目录下所有 .jsonl 文件；读取失败返回空数组而不是抛错。
  private async collectJsonlFiles(rootDir: string): Promise<string[]> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
// 按目录顺序累积结果，最终由调用方统一去重。
      const files: string[] = [];

      for (const entry of entries) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (shouldIgnoreClaudeNativeTranscriptDir(entry.name)) {
            continue;
          }
// 子目录结果展开合并，保持深度优先顺序。
          files.push(...(await this.collectJsonlFiles(entryPath)));
          continue;
        }
// 只收 .jsonl，其他扩展名（索引、锁文件）一律忽略。
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }

// 读取失败的目录已在上层 catch 中返回空数组。
      return files;
    } catch {
      return [];
    }
  }

// 截取 projects 目录之后的相对路径，用于在受管目录中还原同样的层级。
  private getRelativeProjectsPath(sourcePath: string): string {
// 取最后一个 projects 段，兼容路径中间也出现同名目录的情况。
    const marker = `${sep}projects${sep}`;
    const markerIndex = sourcePath.lastIndexOf(marker);
// 路径不在 projects 下说明不是合法的原生会话文件，直接报错拒绝复制。
    if (markerIndex < 0) {
      throw new Error(`[claude-native] Claude 原生 session 路径非法: ${sourcePath}`);
    }
// 只保留 projects 之后的层级，复制时重建同样的目录结构。
    return sourcePath.slice(markerIndex + marker.length);
  }

// 扫描可导入会话：遍历所有根目录，按 mtime 排序后分页返回。
// 单文件解析失败只告警并跳过，不影响其他候选。
// workspacePath 传入时只返回该路径下的会话。
  async scanImportableSessions(params: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;
// 多根目录并发收集后合并去重：同一文件可能通过不同 HOME 候选被扫到两次。
// 去重按文件路径字符串，不做 realpath 解析。
    const sessionFiles = [
      ...new Set(
        (
          await Promise.all(
// 各根目录并发收集，避免串行等待磁盘遍历。
            this.getNativeProjectsRoots().map((rootDir) => this.collectJsonlFiles(rootDir)),
          )
// 多根目录结果展开成一维数组，随后统一去重。
        ).flat(),
      ),
    ];
// 候选按文件逐个构建，字段全部来自头部解析与 stat。
    const candidates: ZCodeImportableSessionCandidate[] = [];

// 串行处理文件：头部解析要读盘，串行更容易控制内存与失败边界。
    for (const filePath of sessionFiles) {
// stat 失败（文件刚被删除）直接跳过，不算候选。
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

// 使用文件 mtime 作为排序依据，单位取整到毫秒。
      const updatedAt = Math.trunc(fileStat.mtimeMs);
// 增量扫描：早于下界的文件无需解析头部，直接跳过。
      if (params.modifiedSince && updatedAt < params.modifiedSince) {
        continue;
      }

      try {
        const headRecords = await readJsonLinesFileHead(filePath, 16);
        if (hasClaudeNativeSidechainMarker(headRecords)) {
          continue;
        }
        const headInfo = extractClaudeNativeSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        // Claude 会把临时执行面放到 ~/.claude/worktrees 下。
        // 引导数据导入只应展示真实用户 workspace，避免把这些短生命周期 worktree 当成可迁移项目。
        if (isClaudeWorktreeWorkspacePath(headInfo.workspacePath)) {
          continue;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(headInfo.workspacePath) !== workspaceKey
        ) {
          continue;
        }

// createdAt/previewTitle 只在解析到时附带，缺失字段保持不出现。
// sessionId 取文件名去掉扩展名，与原生工具命名保持一致。
        candidates.push({
          provider: "claude",
          sessionId: basename(filePath, ".jsonl"),
          workspacePath: headInfo.workspacePath,
          sourcePath: filePath,
          updatedAt,
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.previewTitle ? { previewTitle: headInfo.previewTitle } : {}),
        });
      } catch (error) {
        logger.warn(undefined, `扫描 Claude 原生 session 失败 path=${filePath}`, error);
      }
    }

// 按最近更新降序，最近使用的会话排在前面。
// 排序稳定：相同 mtime 的相对顺序由收集顺序决定。
    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
// limit 只在正数时生效；0 或负数表示不限制。
    const limited =
      typeof params.limit === "number" && params.limit > 0
        ? candidates.slice(0, params.limit)
        : candidates;

    logger.info(
      undefined,
      `Claude 原生 session 扫描完成 workspaceFilter=${params.workspacePath ?? "all"} fileCount=${sessionFiles.length} candidateCount=${limited.length}`,
    );

// 返回截断后的列表，日志同时记录扫描文件数与候选数。
    return limited;
  }

// 按 sessionId 精确查找：命中第一个合法候选即返回。
// 与扫描共用同一套 sidechain/worktree/workspace 过滤边界。
  async findImportableSession(params: {
    workspacePath?: string;
    sessionId: string;
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;

// 依次尝试各根目录，先命中先返回。
    for (const nativeProjectsRoot of this.getNativeProjectsRoots()) {
// 文件不存在时继续下一个根目录，而不是立即返回 null。
      const filePath = await this.findSessionFile(nativeProjectsRoot, params.sessionId);
// 该根目录没有对应文件，尝试下一个候选根目录。
      if (!filePath) {
        continue;
      }

      try {
// 命中文件后仍需 stat 取 mtime，作为候选的更新时间。
        const fileStat = await stat(filePath);
        const headRecords = await readJsonLinesFileHead(filePath, 16);
        if (hasClaudeNativeSidechainMarker(headRecords)) {
          return null;
        }
        const headInfo = extractClaudeNativeSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        // 直接按 sessionId 导入也必须复用扫描边界，防止 UI 过滤后仍能导入临时 worktree。
        if (isClaudeWorktreeWorkspacePath(headInfo.workspacePath)) {
          return null;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(headInfo.workspacePath) !== workspaceKey
        ) {
          continue;
        }

        return {
          provider: "claude",
          sessionId: params.sessionId,
          workspacePath: headInfo.workspacePath,
          sourcePath: filePath,
          updatedAt: Math.trunc(fileStat.mtimeMs),
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.previewTitle ? { previewTitle: headInfo.previewTitle } : {}),
        };
      } catch (error) {
        logger.warn(
          undefined,
          `查找 Claude 原生 session 失败 sessionId=${params.sessionId}`,
          error,
        );
      }
    }

    return null;
  }

// 复制原始 jsonl 到受管目录：目录布局与历史导入位置保持一致。
// 返回 createdOutputPaths 供失败回滚；已存在的目标文件不计入。
  async copySessionFileToWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourcePath: string;
  }): Promise<{ outputPath: string; createdOutputPaths: string[] }> {
    // 导入副本沿用历史目录布局 ~/.zcode/v2/agent-config/claude/{workspaceHash}/projects；
    // 这是 Claude 历史导入的存储位置，与 agent runtime provider（glm）无关。
// 先求相对路径，非法路径在此抛错，不会产生任何写入。
    const relativeProjectsPath = this.getRelativeProjectsPath(params.sourcePath);
// 目标路径 = agent-config/claude/{workspaceHash}/projects/{相对路径}。
    const outputPath = join(
      getAppConfigDir(),
      "agent-config",
      "claude",
      getWorkspaceHash(params.workspacePath, params.workspaceIdentity),
      "projects",
      relativeProjectsPath,
    );
// 目录按需创建，已存在时 mkdir recursive 是幂等的。
    const outputDir = dirname(outputPath);
// 写前记录目标是否存在，决定失败回滚时是否删除。
    const existedBefore = await pathExists(outputPath);
// 临时文件名带 pid/时间/随机串，避免并发复制互相覆盖。
    const tempPath = `${outputPath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;

// 先建目录再写临时文件，mkdir 失败会直接抛错终止复制。
    await mkdir(outputDir, { recursive: true });
// 复制到临时路径，此时目标文件尚未被替换。
    await copyFile(params.sourcePath, tempPath);
// rename 是最后一步：成功即代表副本完整可用。
    await rename(tempPath, outputPath);

    return {
// outputPath 是最终受管路径，调用方可据此展示或续聊。
      outputPath,
// 只有本次新建的文件才允许回滚删除；覆盖已有文件不承担删除责任。
      createdOutputPaths: existedBefore ? [] : [outputPath],
// 返回值同时给出最终路径与本次新建清单，供调用方决定是否回滚。
    };
  }
}

// 导出单例：类无可变状态，共享实例不会引入跨调用污染。
export const claudeNativeSessionImportRepo = new ClaudeNativeSessionImportRepo();
