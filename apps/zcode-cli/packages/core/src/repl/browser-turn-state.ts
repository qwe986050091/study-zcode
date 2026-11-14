import type { BrowserResponseMeta, SessionId, TurnId } from "@zcode/contracts";

// 一次 turn 内可用于截图的浏览器候选：browserId 标识浏览器实例，
// browserGeneration 是实例代际，用于丢弃跨代（已重启）的旧候选。
export interface BrowserTurnScreenshotCandidate {
  // 浏览器实例 ID，与 BrowserResponseMeta 同源。
  browserGeneration: number;
  // 浏览器实例 ID，字符串形式直接用于后续截图请求。
  browserId: string;
}

// 进程内 turn 级状态；只保存最新候选，同一 turn 多次页面活动会覆盖前值。
interface BrowserTurnState {
  // 最近一次可截图的页面候选；未产生页面活动时不存在。
  candidate?: BrowserTurnScreenshotCandidate;
}

// 以 `${sessionId}:${turnId}` 为键的内存表；turn 结束须由 consume/clear 清理，
// 否则长进程会随 turn 数量线性增长。
const states = new Map<string, BrowserTurnState>();

// 生成内存键；只用于本模块字典查找，不进入持久化或日志。
function stateKey(sessionId: SessionId, turnId: TurnId): string {
  return `${sessionId}:${turnId}`;
}

// 读取状态，缺失时就地创建空对象并登记，保证调用方可直接赋值 candidate。
// 副作用：可能向 states 插入新键；因此只允许在有 turnId 的路径调用，避免污染表。
function readState(sessionId: SessionId, turnId: TurnId): BrowserTurnState {
  const key = stateKey(sessionId, turnId);
  const existing = states.get(key);
  if (existing) return existing;
  const created: BrowserTurnState = {};
  states.set(key, created);
  return created;
}

// 记录浏览器响应里的页面活动：有 turnId 且带 tabId 时更新截图候选。
// 无 turnId（如非 turn 驱动的调用）或未打开 tab 时直接忽略，不创建空状态。
// 副作用仅为内存写入，不触发截图；browserGeneration/browserId 由响应元数据提供。
export function recordBrowserTurnPageActivity(input: {
  meta: BrowserResponseMeta;
  sessionId: SessionId;
  turnId?: TurnId;
}): void {
  if (!input.turnId || !input.meta.tabId) return;
  readState(input.sessionId, input.turnId).candidate = {
    browserGeneration: input.meta.browserGeneration,
    browserId: input.meta.browserId,
  };
}

// 仅接受普通对象（排除 null 与数组），用于逐层解包工具输出，非对象返回 undefined。
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// 从 js / mcp__node_repl__js 工具输出中提取 zcode/browserTurnScreenshot 候选。
// 非这两个工具、输出非对象、或候选缺 browserId/整数 browserGeneration 时静默返回，
// 因为该通道只是"锦上添花"的截图提示，不能因解析失败影响工具结果本身。
// 兼容 _meta 与 responseMeta 两种放置位置；命中后覆盖同 turn 的旧候选。
export function recordBrowserTurnToolResult(input: {
  output: unknown;
  sessionId: SessionId;
  toolName: string;
  turnId: TurnId;
}): void {
  if (input.toolName !== "js" && input.toolName !== "mcp__node_repl__js") return;
  const output = asRecord(input.output);
  const responseMeta = asRecord(output?._meta) ?? asRecord(output?.responseMeta);
  const candidate = asRecord(responseMeta?.["zcode/browserTurnScreenshot"]);
  if (
    typeof candidate?.browserId !== "string" ||
    typeof candidate.browserGeneration !== "number" ||
    !Number.isInteger(candidate.browserGeneration)
  ) {
    return;
  }
  readState(input.sessionId, input.turnId).candidate = {
    browserGeneration: candidate.browserGeneration,
    browserId: candidate.browserId,
  };
}

export function consumeBrowserTurnState(
  sessionId: SessionId,
  turnId: TurnId,
): BrowserTurnState | undefined {
  const key = stateKey(sessionId, turnId);
  const state = states.get(key);
  states.delete(key);
  return state;
}

export function clearBrowserTurnState(sessionId: SessionId, turnId: TurnId): void {
  states.delete(stateKey(sessionId, turnId));
}
