import type {
  ScriptWorkflowRunStats,
  ScriptWorkflowStorePort,
  SessionId,
  SessionStorePort,
  WorkflowAgentCallInput,
} from "@zcode/contracts";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const STRUCTURED_OUTPUT_PROMPT =
  "Return only JSON that conforms to the provided JSON Schema. Do not wrap it in Markdown.";

/**
 * 简单的 FIFO 并发闸：最多 `maxConcurrency` 个任务同时执行，其余按进入顺序排队。
 * `run` 在 finally 里 release，任务抛错也不会漏名额；release 唤醒队首后由被唤醒者自己
 * `active += 1`，名额只转交一次。
 */
export class WorkflowLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveAcquire) => this.queue.push(resolveAcquire));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

/**
 * 拼出子代理的最终 prompt，顺序固定：instructions（若有）→ 技能提示（若有）→ 用户 prompt →
 * 结构化输出约束（schema 序列化进文本）。空块会跳过，块间用空行分隔；纯字符串拼接、无副作用。
 */
export function buildAgentPrompt(input: WorkflowAgentCallInput): string {
  const blocks = [];
  if (input.opts?.instructions) blocks.push(input.opts.instructions);
  if (input.opts?.skills?.length) {
    blocks.push(`Use these skills if they are available: ${input.opts.skills.join(", ")}`);
  }
  blocks.push(input.prompt);
  if (input.opts?.schema) {
    blocks.push(`${STRUCTURED_OUTPUT_PROMPT}\nSchema:\n${JSON.stringify(input.opts.schema)}`);
  }
  return blocks.join("\n\n");
}

/**
 * 解析子代理的结构化输出：先剥 Markdown 代码围栏，再截取第一个完整 JSON 值，最后 JSON.parse。
 *
 * 宽松在“定位”（模型常带解释文字 / 围栏），严格在“值”：截不出完整对象或解析失败时抛
 * `Workflow agent returned non-JSON structured output`，原错误放在 cause 里；绝不返回部分结果。
 */
export function parseStructuredResponse(response: string): unknown {
  const candidate = extractJsonResponse(response);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error("Workflow agent returned non-JSON structured output", { cause: error });
  }
}

function extractJsonResponse(response: string): string {
  const trimmed = response.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const objectStart = firstJsonStart(trimmed);
  if (objectStart < 0) return trimmed;
  const objectEnd = findJsonValueEnd(trimmed, objectStart);
  return objectEnd < 0 ? trimmed : trimmed.slice(objectStart, objectEnd + 1);
}

function firstJsonStart(value: string): number {
  const objectIndex = value.indexOf("{");
  const arrayIndex = value.indexOf("[");
  if (objectIndex < 0) return arrayIndex;
  if (arrayIndex < 0) return objectIndex;
  return Math.min(objectIndex, arrayIndex);
}

function findJsonValueEnd(value: string, start: number): number {
  const stack: string[] = [];
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"' || char === "'") {
      index = scanJsonString(value, index, char);
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function scanJsonString(value: string, start: number, quote: string): number {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === quote) return index;
  }
  return value.length - 1;
}

/**
 * 合并取消信号与超时：没有 timeoutMs 时原样返回 signal（可能 undefined）；有超时则用
 * `AbortSignal.any` 把两者合成一个，任一触发即取消。返回的新 signal 不清理底层计时器。
 */
export function mergedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 能力探测 store 是否实现脚本工作流持久化（run + activity 两个写入口都在才算）。
 * 与 isClosableSessionStore 同规：端口可替换，不靠 instanceof。
 */
export function isScriptWorkflowStore(
  store: SessionStorePort,
): store is SessionStorePort & ScriptWorkflowStorePort {
  return "createScriptWorkflowRun" in store && "createScriptWorkflowActivity" in store;
}

/** 普通对象判定：非 null、typeof object、且不是数组；用于安全读取未信任的 JSON 字段。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 把任意抛出物转成可持久化的记录：Error 保留 name / message / stack，其他值只取 String。
 * 只用于 journal / 失败报告，不能当 JSON 序列化的通用兜底（大对象可能不可序列化已在此丢弃）。
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

/**
 * 从消息表回算一个会话的 workflow 统计：tool part 计数、assistant 消息的四类 token 累加。
 *
 * `agentCalls` 固定为 1（这个会话本身就是一次 agent 调用），调用方再与子 activity 合并；
 * 消息自带 `tokens.total` 时用它，否则用 input+output+reasoning 求和（旧记录没有 total）。
 * 纯读，不写 store，也不去重消息。
 */
export async function collectScriptWorkflowSessionStats(
  sessionStore: SessionStorePort,
  sessionId: SessionId,
  createEmptyStats: () => ScriptWorkflowRunStats,
): Promise<ScriptWorkflowRunStats> {
  const messages = await sessionStore.messages({ sessionID: sessionId });
  const stats = createEmptyStats();
  stats.agentCalls = 1;
  for (const message of messages) {
    stats.toolCalls += message.parts.filter((part) => part.type === "tool").length;
    if (message.info.role !== "assistant") continue;
    stats.tokens.cacheRead += message.info.tokens.cache.read;
    stats.tokens.cacheWrite += message.info.tokens.cache.write;
    stats.tokens.input += message.info.tokens.input;
    stats.tokens.output += message.info.tokens.output;
    stats.tokens.reasoning += message.info.tokens.reasoning;
    stats.tokens.total +=
      message.info.tokens.total ??
      message.info.tokens.input + message.info.tokens.output + message.info.tokens.reasoning;
  }
  return stats;
}

/**
 * 按脚本所在目录推断作用域：`<cwd>/.zcode/workflows` 下为 project，`~/.zcode/workflows` 下为
 * user，其余为 explicit（调用方显式指定、不做自动发现）。只做相对路径判定，不解析符号链接。
 */
export function inferScriptWorkflowScope(
  scriptPath: string,
  workingDirectory: string,
): "explicit" | "project" | "user" {
  if (isWithin(scriptPath, join(workingDirectory, ".zcode", "workflows"))) return "project";
  if (isWithin(scriptPath, join(homedir(), ".zcode", "workflows"))) return "user";
  return "explicit";
}

function isWithin(filePath: string, directory: string): boolean {
  const rel = relative(directory, filePath);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
