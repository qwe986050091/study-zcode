import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionEvent } from "@zcode/contracts";
import type {
  ConversationProviderExchangeRecord,
  ConversationRecorder,
  CreateConversationRecorderOptions,
} from "./contract.js";

/*
 * ============================================================
 * conversation-recording / recorder.ts —— JSONL 落盘实现
 *
 * 定位：ConversationRecorder 的唯一实现，负责目录布局与写入排队；不负责内容裁剪。
 *
 * 输入输出：rootDir/<sanitized sessionId>/capture.jsonl（provider_exchange）与
 * events.jsonl（session event），每条记录一行 JSON；sessionId 缺失时用 no-session。
 *
 * 副作用：mkdir -p 创建目录、appendFile 追加写入；按“文件路径”串行排队，保证同一文件
 * 内行顺序与调用顺序一致，不同文件之间可并行。
 *
 * 失败语义：序列化失败、mkdir/append 失败都只 warn，不向调用方抛出；close 会等待
 * 所有已排队写入完成。
 *
 * 不变量：sessionId 只保留安全字符并截断，任何值都不能逃出 rootDir。
 * ============================================================
 */

const NO_SESSION_SEGMENT = "no-session";
const CAPTURE_FILE_NAME = "capture.jsonl";
const EVENTS_FILE_NAME = "events.jsonl";
const MAX_SESSION_SEGMENT_LENGTH = 80;

/**
 * 完整对话记录的唯一落盘边界。
 *
 * 目录布局、文件命名与失败语义见 docs/design/v2/conversation-recording.md。
 * 所有写入按文件串行排队，保证行顺序；任何失败只记日志，不影响 agent 主路径。
 */
export function createConversationRecorder(
  input: CreateConversationRecorderOptions,
): ConversationRecorder {
  const queues = new Map<string, Promise<void>>();
  const ensuredDirs = new Set<string>();

  /**
   * 把一行 JSON 追加到指定文件：取该文件上一条写入的 Promise 作为前驱，
   * 串行化 read-modify-append，避免并发 appendFile 打乱行序。
   *
   * 前一任务失败被吞掉（catch 返回 undefined），保证后续写入不被历史失败打断；
   * 本次写入失败只 warn 并记录路径，不向上抛。
   */
  const enqueue = (filePath: string, line: string): void => {
    const previous = queues.get(filePath) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await ensureDir(dirname(filePath), ensuredDirs);
        await appendFile(filePath, line, "utf8");
      })
      .catch((error: unknown) => {
        input.logger?.warn?.("Conversation recording write failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "conversation_recording.write_failed",
          module: "adapters.conversation_recording",
          path: filePath,
        });
      });
    queues.set(filePath, next);
  };

  /**
   * 将任意记录序列化为单行 JSON 并入队。
   *
   * 先同步 JSON.stringify：遇到循环引用等不可序列化值只 warn 并丢弃该条，
   * 不能把异常抛给 agent 主路径。sessionId 经 sanitize 后决定子目录。
   */
  const appendRecord = (sessionId: string | undefined, fileName: string, value: unknown): void => {
    let line: string;
    try {
      line = `${JSON.stringify(value)}\n`;
    } catch (error) {
      input.logger?.warn?.("Conversation recording serialization failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "conversation_recording.serialize_failed",
        module: "adapters.conversation_recording",
      });
      return;
    }
    const segment = sanitizeSessionSegment(sessionId);
    enqueue(join(input.rootDir, segment, fileName), line);
  };

  return {
    /** 等待所有文件队列排空；之后新记录仍可写入，但不再保证与旧记录的顺序。 */
    close: async () => {
      await Promise.all(queues.values());
      queues.clear();
    },
    /** 记录一次 provider HTTP 交换，按 sessionId 分目录写 capture.jsonl。 */
    recordProviderExchange: (record: ConversationProviderExchangeRecord) => {
      appendRecord(record.sessionId, CAPTURE_FILE_NAME, record);
    },
    /** 记录一条会话事件，事件自带的 sessionId 优先于外部上下文。 */
    recordSessionEvent: (event: SessionEvent) => {
      appendRecord(String(event.sessionId), EVENTS_FILE_NAME, event);
    },
  };
}

/** 目录创建去重：同一目录在进程内只 mkdir 一次，减少并发 EEXIST 与无谓 IO。 */
async function ensureDir(dir: string, ensuredDirs: Set<string>): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

// 仅保留文件名安全字符，限长避免触达 Windows 路径长度上限；不允许 sessionId 逃出根目录。
function sanitizeSessionSegment(value: string | undefined): string {
  const segment = (value ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SESSION_SEGMENT_LENGTH);
  return segment.length > 0 ? segment : NO_SESSION_SEGMENT;
}
