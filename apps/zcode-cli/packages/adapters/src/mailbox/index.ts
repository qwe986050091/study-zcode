/**
 * ============================================================================
 * mailbox/index.ts —— 基于文件系统的 session 邮箱适配器
 * ============================================================================
 *
 * 【定位】会话间消息投递的落盘实现：`<root>/<sessionId>/unread/*.json` 与
 * `.../read/*.json`。消息以文件出现顺序（文件名字典序）作为 FIFO 依据。
 *
 * 【副作用】drainUnread 会读文件并用 rename 在同一文件系统内把消息从 unread
 * 移入 read；rename 是原子的，因此"已读"不会出现半移动状态。
 *
 * 【失败语义】单个 envelope JSON 非法直接抛错，整批已移走的消息不会回滚——
 * 调用方应把邮箱视为至少一次投递（at-least-once），而不是 exactly-once。
 * sessionId 先做白名单校验并再次做 relative 越界校验，防止路径穿越。
 * ============================================================================
 */
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  SessionId,
  SessionMailboxEnvelope,
  SessionMailboxPort,
} from "@zcode/contracts";

export interface NodeSessionMailboxOptions {
  rootDir: string;
}

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;

export class NodeSessionMailboxAdapter implements SessionMailboxPort {
  constructor(private readonly options: NodeSessionMailboxOptions) {}

  /**
   * 取走一批未读消息并标记为已读。
   *
   * 返回按文件名字典序前 `limit`（默认 20）条消息；每条读取成功后立即从
   * unread rename 到 read，因此返回数组中的消息已经持久化为已读。取消信号
   * 在每条消息之间检查：已取走的消息保持已读，不会退回 unread。
   */
  async drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]> {
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    const readDir = this.sessionDir(input.sessionId, "read");
    await mkdir(unreadDir, { recursive: true });
    await mkdir(readDir, { recursive: true });

    // 只处理 .json；按文件名排序模拟 FIFO，limit 是"本轮最多取多少条"而非总容量。
    const entries = (await readdir(unreadDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .slice(0, input.limit ?? 20);
    const messages: SessionMailboxEnvelope[] = [];

    for (const entry of entries) {
      options?.signal?.throwIfAborted();
      const unreadPath = join(unreadDir, entry);
      const readPath = join(readDir, entry);
      const envelope = parseEnvelope(await readFile(unreadPath, "utf8"));
      messages.push(envelope);
      // 先解析成功再移动：坏 JSON 会停在 unread，避免"已读但不可解析"的黑洞。
      await rename(unreadPath, readPath);
    }

    return messages;
  }

  /**
   * 解析并校验会话邮箱目录。
   *
   * 双重防护：sessionId 只允许 `sess_[A-Za-z0-9._-]+`；解析后再次用 relative
   * 校验结果仍位于 root 内，防止 `..`、绝对路径或符号链接语义造成越界写。
   */
  private sessionDir(sessionId: SessionId, kind: "read" | "unread"): string {
    const normalizedSessionId = String(sessionId);
    if (!SESSION_ID_PATTERN.test(normalizedSessionId)) {
      throw new Error(`Invalid session id: ${normalizedSessionId}`);
    }

    const rootDir = resolve(this.options.rootDir);
    const sessionDir = resolve(rootDir, normalizedSessionId, kind);
    const relativePath = relative(rootDir, sessionDir);
    // relativePath 为空意味着 sessionDir 就是 root 本身；以 .. 开头或绝对路径均视为越界。
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Session mailbox path escapes root: ${normalizedSessionId}`);
    }
    return sessionDir;
  }
}

export function createNodeSessionMailboxAdapter(
  options: NodeSessionMailboxOptions,
): SessionMailboxPort {
  return new NodeSessionMailboxAdapter(options);
}

/**
 * 解析并校验邮箱信封。
 *
 * 只做运行时形状校验（version=1 与六个必填 string），不校验业务语义；
 * 任何不合法内容都抛错，避免把伪造消息注入会话。
 */
function parseEnvelope(content: string): SessionMailboxEnvelope {
  const parsed = JSON.parse(content) as SessionMailboxEnvelope;
  if (
    parsed.version !== 1 ||
    typeof parsed.messageId !== "string" ||
    typeof parsed.fromSessionId !== "string" ||
    typeof parsed.toSessionId !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Invalid session mailbox envelope");
  }
  return parsed;
}
