// 历史导入修复：早期导入可能只写了 user 消息或用固定 msg_import_* 主键，导致串会话。
// 修复策略是按 taskId 找回权威历史（legacy 快照或原生 jsonl），再幂等重建 session。
import { existsSync, readFileSync } from "node:fs";
import type {
  ZCodeAgentMcpServer,
  ZCodeSessionImportHistory,
  ZCodeSessionImportMessage,
  ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import { buildImportedClaudeTaskId } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";

// 修复目标只认 workspace + taskId 的组合，taskId 本身即导入会话的稳定主键。
// identity 参与快照路径计算，缺失时回退到无身份布局。
export interface ImportedClaudeHistoryRepairTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

// 修复结果同时带来源标记：legacySnapshot 表示读的备份文件，nativeJsonl 表示回读原始日志。
// messages 已过滤为 user/assistant 两类，可直接写入 importedHistory。
export interface ImportedClaudeHistoryRepairResult {
// 标题仅用于展示，缺失时由调用方回退到首条用户消息。
  title?: string;
// 创建/更新时间保持毫秒时间戳，缺失表示源日志未提供。
  createdAt?: number;
// 更新时间用于重建后的排序，不影响消息内容。
  updatedAt?: number;
// 消息已过滤为 user/assistant，顺序即原始日志顺序。
  messages: ZCodeSessionImportMessage[];
// 来源标记用于日志与调试，不参与业务判断。
  source: "legacySnapshot" | "nativeJsonl";
}

// 会话修复目标额外携带 MCP 配置，重建 session 时需要原样继承。
export interface ImportedClaudeSessionRepairTarget extends ImportedClaudeHistoryRepairTarget {
  mcpServers?: ZCodeAgentMcpServer[];
}

// 重建参数固定 persistence=immediate：修复必须同步落盘，否则重启后问题复现。
// mode/model/thoughtLevel 从当前快照读取，保留用户最近的运行时选择。
export interface ImportedClaudeSessionRepairCreateParams {
  workspacePath: string;
  workspaceIdentity?: string;
// 重建时 sessionId 固定传 taskId，保证幂等覆盖。
  sessionId: string;
  mode: ZCodeSessionStateSnapshot["session"]["mode"];
  model: ZCodeSessionStateSnapshot["settings"]["model"]["current"];
  thoughtLevel?: string;
// 立即持久化：修复结果必须在进程重启后仍然存在。
  persistence: "immediate";
  mcpServers?: ZCodeAgentMcpServer[];
// 导入历史整体传入，由会话层一次性写入，避免分步写入产生中间态。
  importedHistory: ZCodeSessionImportHistory;
}

// 只保留 user/assistant 两类消息；system/tool 记录不进入导入历史。
// role 在此收窄为字面量联合，后续消费方无需再判类型。
function toImportMessages(
  messages: readonly { role: string; content: string; timestamp?: number }[],
): ZCodeSessionImportMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
      timestamp: message.timestamp,
    }));
}

// 用 assistant 消息数量衡量历史完整度：只有 user 的备份说明曾经写坏。
function countAssistantMessages(messages: readonly ZCodeSessionImportMessage[]): number {
// 只统计 assistant 数量，用于比较两个来源的完整度。
  return messages.filter((message) => message.role === "assistant").length;
}

// 判定是否需要修复：运行中的会话不能动，只有明确的 Claude 导入痕迹才进入修复边界。
// 三个触发条件：无 assistant、assistant 抢先、存在旧版固定 messageId。
export function shouldRepairImportedClaudeSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "runtime" | "session">,
): boolean {
// 正在执行的会话跳过修复，避免与活跃写入竞争。
  if (snapshot.session.status === "running" || snapshot.runtime.activeTurnId) {
    return false;
  }
// 旧协议固定主键格式为 msg_import_<数字>，出现即说明可能发生过跨会话改绑。
  const hasLegacyFixedMessageIds = snapshot.messages.some((message) =>
    /^msg_import_\d+$/u.test(message.info.messageId),
  );
// 既不是导入 taskId 又没有旧主键痕迹，说明是普通 ZCode 会话，不能误修。
  if (!snapshot.session.sessionId.startsWith("claude-import-") && !hasLegacyFixedMessageIds) {
    // user-only / assistant-first 只是异常形态，不等于 Claude 导入。
    // 只有稳定导入 taskId 或旧版全局 msg_import_* 污染能证明它属于迁移修复边界，
    // 避免普通 ZCode session 被同名 legacy 备份误回填成 Claude 历史。
    return false;
  }
// 没有 assistant 说明导入只写了用户提问，必须补全回复。
  const hasAssistant = snapshot.messages.some((message) => message.info.role === "assistant");
// 缺 assistant 是最确定的损坏形态，直接修复。
  if (!hasAssistant) {
    return true;
  }
// 首条是 assistant 说明轮次顺序错乱，同样需要按源日志重建。
  if (snapshot.messages[0]?.info.role === "assistant") {
    return true;
  }
  // 旧协议导入把所有 Claude session 都写成 msg_import_0/msg_import_1。
  // 这些 ID 是全局主键，后续导入会把前一个 session 的消息改绑到新 session，
  // 即使当前快照里有 assistant，也必须按原 Claude jsonl 重新回填，修正串会话和反序。
// 其余情况只有旧固定主键才继续修复：它会导致后续导入覆盖前一个会话。
  return hasLegacyFixedMessageIds;
}

// 优先读 legacy 备份：正常与已删除任务两条路径都尝试，取第一个存在的文件。
function readLegacyImportedClaudeHistory(
  target: ImportedClaudeHistoryRepairTarget,
): ImportedClaudeHistoryRepairResult | null {
// 正常快照优先于已删除快照；两者都不存在时返回 null。
// 只做 existsSync 探测，不做目录遍历。
  const snapshotPath = [
    getLegacyTaskSessionSnapshotPath(
      target.workspacePath,
      target.taskId,
      target.workspaceIdentity,
    ),
    getLegacyDeletedTaskSessionSnapshotPath(
      target.workspacePath,
      target.taskId,
      target.workspaceIdentity,
    ),
// 两条候选路径按顺序探测，取第一个存在的备份。
  ].find((path) => existsSync(path));
// 没有备份文件说明这条任务不是从 Claude 迁移而来，交回调用方处理。
  if (!snapshotPath) {
    return null;
  }

// 解析失败或 migrationSource 不是 claudeCode 时一律视为不可用来源。
  const parsed = safeParseLegacyTaskSessionFile(
    JSON.parse(readFileSync(snapshotPath, "utf-8")) as unknown,
  );
// migrationSource 是唯一可信的迁移标记，仅凭文件名不能判定来源。
  if (!parsed.success || parsed.data.meta.migrationSource !== "claudeCode") {
    return null;
  }
// 空消息的备份没有修复价值，直接返回 null。
  const messages = toImportMessages(parsed.data.messages);
  return messages.length > 0
    ? {
        title: parsed.data.meta.title,
        createdAt: parsed.data.meta.createdAt,
        updatedAt: parsed.data.meta.updatedAt,
        messages,
        source: "legacySnapshot",
      }
    : null;
}

// 回读原生 jsonl：按 taskId 反查候选，再重新解析完整历史。
async function readNativeImportedClaudeHistory(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
// 扫描范围限定在目标 workspace，避免同名 session 命中其他项目。
  const candidates = await claudeNativeSessionImportRepo.scanImportableSessions({
    workspacePath: target.workspacePath,
  });
// 用确定性 taskId 反向匹配候选，保证与导入时是同一条会话。
  const candidate = candidates.find(
    (item) => buildImportedClaudeTaskId(item.workspacePath, item.sessionId) === target.taskId,
  );
// 原生目录里找不到对应 taskId，说明源文件已被删除，无法回读。
  if (!candidate) {
    return null;
  }

// 重新走一遍标准解析，确保修复结果与首次导入格式完全一致。
// 解析异常向上抛出，由调用方决定是降级还是报错。
  const importedSource = await parseClaudeNativeSessionFile({
    filePath: candidate.sourcePath,
    workspacePath: candidate.workspacePath,
    sessionId: candidate.sessionId,
    sourcePath: candidate.sourcePath,
    fallbackCreatedAt: candidate.createdAt,
    fallbackUpdatedAt: candidate.updatedAt,
  });
// 原生解析结果同样需要收窄 role，保证两条来源结构一致。
  const messages = toImportMessages(importedSource.messages);
  return messages.length > 0
    ? {
        title: importedSource.title,
        createdAt: importedSource.createdAt,
        updatedAt: importedSource.updatedAt,
        messages,
        source: "nativeJsonl",
      }
    : null;
}

// 来源选择：legacy 备份有 assistant 就直接用，否则比较两边 assistant 数量取更完整的一方。
export async function resolveImportedClaudeHistoryForRepair(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
// legacy 读取是同步的，失败返回 null 而不是抛错。
  const legacyHistory = readLegacyImportedClaudeHistory(target);
// legacy 备份完整（含 assistant）时直接采用，无需扫描原生目录。
  if (legacyHistory && countAssistantMessages(legacyHistory.messages) > 0) {
    return legacyHistory;
  }

// 原生 jsonl 只在需要时读取，避免每次修复都做目录扫描。
  const nativeHistory = await readNativeImportedClaudeHistory(target);
  if (
    nativeHistory &&
    countAssistantMessages(nativeHistory.messages) >= countAssistantMessages(legacyHistory?.messages ?? [])
  ) {
    // 旧版本可能已经把 user-only 的 legacy 备份写坏了。
    // 这时 legacy 不能再作为权威来源，需要按 taskId 反查原 Claude jsonl 重建 assistant。
    return nativeHistory;
  }

  return legacyHistory;
}

// 修复主流程：判定 → 找权威历史 → 回调通知 → 幂等重建 session。
// 返回 null 表示无需修复，调用方继续使用现有快照。
export async function repairImportedClaudeSessionSnapshot<T>(params: {
  snapshot: ZCodeSessionStateSnapshot;
  target: ImportedClaudeSessionRepairTarget;
  createSession(input: ImportedClaudeSessionRepairCreateParams): Promise<T>;
  onRepair?(history: ImportedClaudeHistoryRepairResult): void;
}): Promise<T | null> {
// 不满足修复条件时什么都不做，避免误伤正常会话。
  if (!shouldRepairImportedClaudeSnapshot(params.snapshot)) {
    return null;
  }
  const history = await resolveImportedClaudeHistoryForRepair(params.target);
// 两个来源都拿不到有效历史时保持现状，不创建空会话。
  if (!history) {
    return null;
  }

// 通知回调在重建前触发，便于宿主记录修复来源与消息数量。
  params.onRepair?.(history);
  // 早期导入可能已经创建了真实 ZCode session，但没有把 Claude 历史写入
  // zcode-cli sessionStore，或用了全局 msg_import_* 导致串会话。这里统一用同名 sessionId
  // 幂等回填 importedHistory，让 session/read、task snapshot 和远控恢复路径走同一套修复。
// sessionId 固定为 taskId，同名重建保证幂等：重复修复不会产生新会话。
// importedHistory.source 固定 claudeCode，供后续读取方识别迁移来源。
  return params.createSession({
    workspacePath: params.target.workspacePath,
    workspaceIdentity: params.target.workspaceIdentity,
    sessionId: params.target.taskId,
    mode: params.snapshot.session.mode,
    model: params.snapshot.settings.model.current,
    thoughtLevel: params.snapshot.settings.thoughtLevel.current,
    persistence: "immediate",
// MCP 配置原样继承，修复不改变用户的外部工具设置。
    mcpServers: params.target.mcpServers,
    importedHistory: {
      source: "claudeCode",
      title: history.title,
      createdAt: history.createdAt,
      updatedAt: history.updatedAt,
      messages: history.messages,
    },
  });
}
