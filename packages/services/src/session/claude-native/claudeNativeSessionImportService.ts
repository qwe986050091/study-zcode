// Claude 原生会话导入编排：查找 → 复制副本 → 解析 → 建任务 → 写快照，逐 session 独立成败。
// 单个 session 失败只记录到 failed，不中断整批导入。
// 本文件不直接写库，任务事实由 taskIndexRepo 与 createImportedSession 负责。
import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { normalize, resolve } from "node:path";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedClaudeTaskFile } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import {
  buildSearchableTextFromMessages,
  writeImportedClaudeTaskSnapshot,
} from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

// 与扫描侧共用同一 logger 名称，便于按导入流程聚合日志。
// 日志只记录数量与路径，不记录消息正文。
const logger = createServiceLogger("claude-native-import");

// 路径比较归一：解析为绝对路径并统一分隔符；Windows 下额外转小写。
// 仅用于相等判断，不会把归一结果写回任何持久化字段。
function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// workspace 不存在时导入会被跳过：复制副本与后续续聊都依赖该目录。
async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// 失败回滚：只删除本次真正新建的副本文件（existedBefore 为 false 的那些）。
async function cleanupCreatedArtifacts(paths: readonly string[]): Promise<void> {
// 去重后逐个删除，避免同一路径被重复 rm。
  for (const path of new Set(paths)) {
    try {
      await rm(path, { force: true });
    } catch {
// 回滚本身失败不得掩盖原始导入错误，因此这里只吞掉清理异常。
      // 清理失败不阻断主流程
    }
  }
}

// 批量导入入口：参数显式注入 taskIndexRepo 与创建会话回调，便于测试替换。
// createImportedSession 是唯一的事实写入点；本函数只负责编排顺序。
export async function importClaudeNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession: (source: ClaudeNativeImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
}): Promise<ZCodeImportSessionsResult> {
// sessionId 先去空白、去重、去空，避免同一会话被导入两次。
// 顺序保留首次出现的位置，结果稳定可预期。
  const normalizedSessionIds = [
    ...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean)),
  ];
// 三类结果互斥：每个 session 最终只会进入 imported/skipped/failed 之一。
  const result: ZCodeImportSessionsResult = {
// 三个结果数组都是必需字段，空数组也必须显式给出。
// 调用方按数组长度汇总，不依赖字段是否存在。
    imported: [],
    skipped: [],
    failed: [],
  };

  logger.info(
    undefined,
    `开始导入 Claude 原生 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

// 逐 session 串行处理：导入会写文件并更新任务库，并发执行难以保证顺序与回滚边界。
// 每个 session 的临时状态都在循环体内初始化，互不串扰。
  for (const sessionId of normalizedSessionIds) {
// 记录本次新建的副本路径；catch 中据此回滚，已存在的文件不会被删除。
    let createdOutputPaths: string[] = [];
// 记录本次候选的 workspace，失败结果与日志据此定位。
// 该变量在 catch 中仍可读，因此必须声明在 try 之外。
    let importedWorkspacePath: string | undefined;
    try {
// 查找阶段复用扫描边界（sidechain/worktree/workspace 过滤），保证直接导入与列表一致。
// 传 workspacePath 时要求候选归属完全匹配，防止跨项目误导入。
      const candidate = await claudeNativeSessionImportRepo.findImportableSession({
        workspacePath: params.workspacePath,
        sessionId,
      });
// 找不到可导入会话按 skipped 处理，而不是 failed：这是正常的过滤结果。
      if (!candidate) {
        result.skipped.push({
          provider: "claude",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        });
        continue;
      }

// 先记下候选 workspace，失败结果里据此给出定位信息。
      importedWorkspacePath = candidate.workspacePath;
// 源 workspace 已被删除时跳过：导入后的任务无法在该目录续聊。
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: "claude",
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      if (
// 显式指定 workspace 时再做一次归一比较，兼容大小写与分隔符差异。
        params.workspacePath &&
        normalizePathForComparison(importedWorkspacePath) !==
          normalizePathForComparison(params.workspacePath)
      ) {
        result.skipped.push({
          provider: "claude",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

// 先复制原始 jsonl 到受管目录，再解析副本，保证任务数据与源文件解耦。
// 复制是原子写：临时文件 rename 成功后才返回，失败不会留下半个文件。
      const copiedArtifacts = await claudeNativeSessionImportRepo.copySessionFileToWorkspace({
        workspacePath: importedWorkspacePath,
        workspaceIdentity: params.workspacePath ? params.workspaceIdentity : undefined,
        sourcePath: candidate.sourcePath,
      });
      createdOutputPaths = copiedArtifacts.createdOutputPaths;

// 解析整份历史生成导入源；无可见消息会抛错并进入 failed。
// 时间回退值来自候选的 stat 信息，解析不到时间时兜底。
      const importedSource = await parseClaudeNativeSessionFile({
        filePath: candidate.sourcePath,
        workspacePath: importedWorkspacePath,
        sessionId,
        sourcePath: candidate.sourcePath,
        fallbackCreatedAt: candidate.createdAt,
        fallbackUpdatedAt: candidate.updatedAt,
      });

// 仅在显式指定 workspace 时才继承 identity；全量导入保持候选自身身份。
      const targetWorkspaceIdentity = params.workspacePath ? params.workspaceIdentity : undefined;
      // 导入只能由 CLI 创建持久会话；备份文件不能成为第二个会话事实写者。
// 任务事实先落库，之后才写快照；顺序反过来会出现无主快照文件。
      const created = await params.createImportedSession(importedSource);
// 快照使用真实 taskId，确保搜索/续聊能按同一主键找回。
      const sessionFile = buildImportedClaudeTaskFile(importedSource, undefined, created.taskId);
      await writeImportedClaudeTaskSnapshot({
        sessionFile: {
          ...sessionFile,
          meta: {
            ...sessionFile.meta,
            ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          },
        },
      });
// 展示信息写入 migrationSource 与可搜索文本，任务列表据此识别迁移来源。
// 返回 null 说明事实未持久化，必须当作失败回滚。
      const meta = await params.taskIndexRepo.updateTaskPresentation({
        ...created,
        presentation: { migrationSource: "claudeCode" },
        searchableText: buildSearchableTextFromMessages(sessionFile.messages),
      });
// 没有 meta 就不能继续写状态或回调宿主，直接抛错交给统一 catch。
      if (!meta) throw new Error("CLI import did not persist session facts");
// 导入任务默认不归档，保证用户能在任务列表里立即看到。
      await params.taskIndexRepo.updateTaskState({ ...created, patch: { archived: false } });
// 宿主回调在全部写入成功后触发；回调抛错也会走失败路径并回滚副本。
      params.onTaskImported(meta);

      result.imported.push({
        provider: "claude",
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
// 任一环节失败：先删本次新建副本，再记录失败原因，绝不留下半成品。
// 错误信息只保留 message，避免把堆栈写进结果对象。
    } catch (error) {
      await cleanupCreatedArtifacts(createdOutputPaths);
// 非 Error 抛出物也要转成可读字符串，保证结果可序列化。
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 Claude 原生 session 失败 session=${sessionId}`, error);
// workspace 只在已知时附带，未找到候选的失败不编造路径。
      result.failed.push({
        provider: "claude",
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `Claude 原生 session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
// 无论成功失败都返回汇总结果；异常已在循环内逐条消化。
  return result;
}
