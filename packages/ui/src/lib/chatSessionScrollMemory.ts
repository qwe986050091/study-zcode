// INV-01 容量上限固定两百条：守住位置 MAX_ENTRIES；改错故障 内存随会话数无界增长。
// INV-02 命中即移到队尾：守住位置 delete 再 set；改错故障 常用会话被优先淘汰。
// INV-03 超限从最旧开始淘汰：守住位置 prune 循环；改错故障 一次性清空全部。
// INV-04 工作区身份优先于路径：守住位置 空值合并；改错故障 同一工作区分裂成两个桶。
// INV-05 面板参与隔离键：守住位置 paneScope；改错故障 左右分栏共享滚动位置。
// INV-06 会话优先于任务：守住位置 sessionScope；改错故障 同一会话出现两个桶。
// INV-07 都缺失时返回空：守住位置 末尾三元；改错故障 生成全局共享键。
// INV-08 任务桶迁移到会话桶：守住位置 migrate；改错故障 元数据补齐后位置丢失。
// INV-09 已存在的会话桶不覆盖：守住位置 has 判断；改错故障 旧位置覆盖新位置。
// INV-10 迁移后删除任务桶：守住位置 delete 调用；改错故障 旧桶继续占用容量。
// INV-11 迁移时间戳刷新：守住位置 updatedAt；改错故障 刚迁移的条目被优先淘汰。
// INV-12 读取也刷新顺序：守住位置 touch；改错故障 恢复后立刻被淘汰。
// INV-13 保存后立即裁剪：守住位置 prune 调用；改错故障 容量延迟一轮才生效。
// INV-14 恢复位置夹在合法区间：守住位置 min 与 max；改错故障 滚动到不存在的偏移。
// INV-15 空键读写直接返回：守住位置 早退；改错故障 空键共享同一份状态。
// INV-16 测试清理入口独立：守住位置 clearForTest；改错故障 单测之间互相污染。
// INV-17 键段空白归一：守住位置 normalizeKeyPart；改错故障 前后空格产生新桶。
// INV-18 淘汰时只删最旧一条：守住位置 循环体；改错故障 单次写入清空全部缓存。
//
// 模块职责：按工作区、面板与会话记住聊天滚动位置，并提供有界淘汰与任务桶迁移。
// 状态所有权：模块级 Map 是唯一存储，容量由常量约束。
// 阅读顺序：先看键构造与归一化，再看迁移，最后看读写与淘汰。
export interface ChatSessionScrollMemoryState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasPinnedToBottom?: boolean;
  updatedAt: number;
}

export const CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES = 200;

const chatSessionScrollMemory = new Map<string, ChatSessionScrollMemoryState>();

function normalizeKeyPart(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

// 先 delete(key) 再 set(key)，把条目移到 Map 队尾。
// set 前先 delete，使写入顺序等于最近使用顺序。
// 返回传入的 state 对象，不复制也不读取。
function touchChatSessionScrollMemoryEntry(
  key: string,
  state: ChatSessionScrollMemoryState,
): ChatSessionScrollMemoryState {
  chatSessionScrollMemory.delete(key);
  chatSessionScrollMemory.set(key, state);
  return state;
}

// size 超过 CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES 才进入循环。
// keys().next() 取最旧 key，每轮只删一条。
// oldestKey 为空时直接 return，避免死循环。
function pruneChatSessionScrollMemory(): void {
  while (chatSessionScrollMemory.size > CHAT_SESSION_SCROLL_MEMORY_MAX_ENTRIES) {
    const oldestKey = chatSessionScrollMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    chatSessionScrollMemory.delete(oldestKey);
  }
}

// workspaceIdentity 优先，缺失时回退 workspacePath。
// paneId 非空时拼成 pane: 段做二级隔离。
// sessionScope 非空时先返回 session 键，task 键只作回退。
// sessionScope 与 taskScope 都为空时返回 null。
export function buildChatSessionScrollMemoryKey({
  workspacePath,
  workspaceIdentity,
  paneId,
  sessionId,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  paneId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}): string | null {
  const workspaceKey = normalizeKeyPart(workspaceIdentity) ?? normalizeKeyPart(workspacePath);
  const paneScope = normalizeKeyPart(paneId);
  const sessionScope = normalizeKeyPart(sessionId);
  const taskScope = normalizeKeyPart(taskId);
  if (!workspaceKey) {
    return null;
  }

  const rendererScope = paneScope ? `${workspaceKey}::pane:${paneScope}` : workspaceKey;

  if (sessionScope) {
    return `${rendererScope}::session:${sessionScope}`;
  }

  return taskScope ? `${rendererScope}::task:${taskScope}` : null;
}

// 分别构造 sessionKey 与 fallbackTaskKey 两类键。
// has(sessionKey) 为真时不覆盖已有会话桶。
// 迁移完成后 delete(fallbackTaskKey)。
export function migrateTaskScrollMemoryToSession({
  workspacePath,
  workspaceIdentity,
  paneId,
  sessionId,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  paneId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}): string | null {
  const sessionKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });
  const fallbackTaskKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId: null,
    taskId,
  });

  if (!sessionKey || !fallbackTaskKey || sessionKey === fallbackTaskKey) {
    return sessionKey ?? fallbackTaskKey;
  }

  if (!chatSessionScrollMemory.has(sessionKey)) {
    const fallbackState = chatSessionScrollMemory.get(fallbackTaskKey);
    if (fallbackState) {
      // sessionId 可能晚于 taskId 回填。这里把临时 task 桶迁移到真实 session 桶，
      // 避免同一会话在元数据补齐前后丢失滚动位置。
      touchChatSessionScrollMemoryEntry(sessionKey, {
        ...fallbackState,
        updatedAt: Date.now(),
      });
    }
  }

  chatSessionScrollMemory.delete(fallbackTaskKey);
  return sessionKey;
}

// key 为 null 时直接返回 null。
// 命中后调用 touchChatSessionScrollMemoryEntry 刷新顺序。
// get 未命中时返回 null，不调用 prune。
export function readChatSessionScrollMemoryState(
  key: string | null,
): ChatSessionScrollMemoryState | null {
  if (!key) {
    return null;
  }

  const state = chatSessionScrollMemory.get(key);
  return state ? touchChatSessionScrollMemoryEntry(key, state) : null;
}

export function saveChatSessionScrollMemoryState(
  key: string | null,
  state: ChatSessionScrollMemoryState,
): void {
  if (!key) {
    return;
  }

  touchChatSessionScrollMemoryEntry(key, state);
  pruneChatSessionScrollMemory();
}

export function resolveChatSessionScrollRestoreTop(
  state: Pick<ChatSessionScrollMemoryState, "scrollTop">,
  metrics: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): number {
  const maxScrollTop = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  return Math.min(Math.max(state.scrollTop, 0), maxScrollTop);
}

export function clearChatSessionScrollMemoryForTest(): void {
  chatSessionScrollMemory.clear();
}
