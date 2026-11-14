// 导入快照落盘与搜索文本构建：只写 legacy 备份，不承担真实会话续聊。
// 写入采用临时文件 + rename，避免进程中断留下半截 JSON。
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZCodeSessionFile } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath } from "#src/paths.js";
import {
  parseLegacyTaskSessionFile,
  type LegacyTaskSessionFile,
} from "#src/session/legacyTaskSessionFile.js";

// 搜索文本上限 20 万字符：足够覆盖正常会话，同时防止超大历史撑爆索引。
// 超限时在字符边界截断，不按消息条数截断，保证尽量多地保留近期上下文。
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

// 把消息正文拼成可搜索文本：跳过空白消息，消息之间用换行分隔。
// 只累积到上限即停止，后续消息不再参与拼接。
export function buildSearchableTextFromMessages(messages: ZCodeSessionFile["messages"]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
// 先 trim 再判空，纯空白消息不占用配额。
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const next = total > 0 ? `\n${content}` : content;
// 超限时只截取剩余可用长度并立即结束循环。
// 截断点落在当前消息内部，已拼好的前缀保持完整。
    if (total + next.length > TASK_SEARCH_TEXT_MAX_CHARS) {
      parts.push(next.slice(0, TASK_SEARCH_TEXT_MAX_CHARS - total));
      break;
    }
    parts.push(next);
    total += next.length;
  }
// 片段之间不额外插入分隔符，换行已在拼接时写入。
  return parts.join("");
}

// 原子写：同目录临时文件写完再 rename，跨目录 rename 不具备原子性。
async function writeSessionFileAtomic(
  filePath: string,
  sessionFile: LegacyTaskSessionFile,
): Promise<void> {
// 临时名包含 pid、时间与随机串，避免多进程并发写同一快照时互相覆盖。
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  const serialized = JSON.stringify(sessionFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${serialized}\n`, "utf-8");
  await rename(tempPath, filePath);
}

// 写入前先按 legacy schema 解析，保证落盘内容始终可被读回。
export async function writeImportedClaudeTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const filePath = getLegacyTaskSessionSnapshotPath(
    parsed.meta.workspacePath,
    parsed.meta.taskId,
    parsed.meta.workspaceIdentity,
  );

  // legacy ACP 下线后 importClaudeSessions 变成空桩，导入虽复制了 jsonl 却没有写
  // ~/.zcode/v2/sessions/{hash}/{taskId}.json。现在真实 ZCode session 承担续聊，legacy snapshot
  // 只保存过滤后的迁移备份，避免 Claude 来源运行态污染当前模型选择。
  await writeSessionFileAtomic(filePath, parsed);
}
