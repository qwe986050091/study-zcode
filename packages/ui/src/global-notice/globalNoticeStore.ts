// INV-01 存储键固定且带版本号：守住位置 键常量；改错故障 新旧结构互相污染。
// INV-02 读取时必须校验版本，不符即回空状态：守住位置 读取函数版本判断；改错故障 旧数据被当成新结构使用。
// INV-03 解析异常一律回空状态，不让坏数据阻塞启动：守住位置 读取函数的捕获；改错故障 一条脏记录导致通知系统整体不可用。
// INV-04 早期模拟分享通知必须清理：守住位置 历史脏数据判定；改错故障 关闭模拟后重启仍出现假分享卡。
// INV-05 清理写失败不能回退整份状态：守住位置 清理后的返回值；改错故障 关闭冷却记录被一并丢弃。
// INV-06 持久化是增强而不是前提：写失败仍通知订阅者：守住位置 持久化函数；改错故障 存储异常导致已更新的通知不可见。
// INV-07 发布时按去重键记录「刚关闭即重发」标记：守住位置 发布方法；改错故障 关闭后同一通知立刻再次弹出。
// INV-08 仅最新态持久化的通知才替换当前通知：守住位置 发布分支；改错故障 内存型通知顶掉持久通知。
// INV-09 关闭只接受当前通知标识：守住位置 关闭方法首行判断；改错故障 迟到的关闭请求误关新通知。
// INV-10 关闭冷却按去重键写入到期时间，无冷却写当前时刻：守住位置 冷却计算；改错故障 关闭后永久不再出现或立即重现。
// INV-11 可见性依次判断：存在、未过期、未在冷却、未被关闭标记抑制：守住位置 可见性方法；改错故障 过期通知仍展示。
// INV-12 关闭标记必须在一次成功发布后才清除：守住位置 发布时的标记重算；改错故障 关闭后刷新页面仍能看到。
// INV-13 订阅返回退订函数，且不立即回调：守住位置 订阅方法；改错故障 订阅方在渲染期被同步调用。
// INV-14 状态快照返回内部引用，调用方不得修改：守住位置 快照方法；改错故障 外部就地改写绕过持久化。
// INV-15 浏览器存储被禁用时退回内存实现：守住位置 存储解析；改错故障 隐私模式下一访问即抛错。
// INV-16 无窗口环境下不创建浏览器实例：守住位置 导出的三目；改错故障 服务端渲染时报窗口未定义。
// INV-17 错误描述必须包含名称与消息：守住位置 错误描述函数；改错故障 日志只有对象占位符。
// INV-18 所有状态迁移都产生新对象，不就地修改：守住位置 发布与关闭；改错故障 订阅者拿到的快照被悄悄改写。
//
// 模块职责：`globalNoticeStore` 持有唯一最新通知与关闭冷却，持久层只存快照且订阅者只读广播。
// 状态所有权：内存状态由工厂闭包持有；持久层只存快照，不参与判定。
// 阅读顺序：先看类型与读取，再读工厂内的持久化、发布、关闭与可见性，最后看浏览器存储退回策略。
import { logger } from "@/logger.js";

export type GlobalNoticePriority = "low" | "normal" | "high";
export type GlobalNoticeInterruptPolicy = "passive" | "replace-lower-priority";

// GlobalNoticeEnvelope 是跨进程契约：noticeId 只用于 dismiss、dedupeKey 决定冷却与抑制粒度、payload/actions/dismissPolicy/persistencePolicy 由展示层解释；除 expiresAt 外全部必需，缺 dedupeKey 会让 dismiss 与冷却对不上，persistencePolicy 为 "memory" 时 publish 不替换 state.latest。
export interface GlobalNoticeEnvelope {
  noticeId: string;
  dedupeKey: string;
  type: string;
  schemaVersion: number;
  scope: "user" | "workspace" | "task";
  priority: GlobalNoticePriority;
  interruptPolicy: GlobalNoticeInterruptPolicy;
  createdAt: number;
  expiresAt?: number;
  payload: Record<string, unknown>;
  actions: Array<{ id: string; label: string }>;
  dismissPolicy: { kind: "none" } | { kind: "cooldown"; cooldownMs: number };
  persistencePolicy: "memory" | "latest-only";
  source: string;
  revision: number;
}

interface PersistedGlobalNoticeState {
  version: 1;
  latest: GlobalNoticeEnvelope | null;
  dismissedUntilByKey: Record<string, number>;
  requiresPublishAfterDismissalByKey: Record<string, boolean>;
}

export interface GlobalNoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GlobalNoticeStore {
  publish(notice: GlobalNoticeEnvelope): void;
  dismiss(noticeId: string): void;
  getVisible(): GlobalNoticeEnvelope | null;
  getSnapshot(): PersistedGlobalNoticeState;
  subscribe(listener: () => void): () => void;
}

const STORAGE_KEY = "zcode:global-notice:v1";

function emptyState(): PersistedGlobalNoticeState {
  return {
    version: 1,
    latest: null,
    dismissedUntilByKey: {},
    requiresPublishAfterDismissalByKey: {},
  };
}

// isLegacyHighspeedMockNotice 只认 notice.type === "highspeed-share" 且 typeof payload.cardId === "string" && cardId.startsWith("hsc_mock_")：前缀是唯一判据，避免误删真实分享卡；纯判断无副作用，类型不符直接 false。
function isLegacyHighspeedMockNotice(notice: GlobalNoticeEnvelope | null): boolean {
  if (notice?.type !== "highspeed-share") return false;
  const cardId = notice.payload.cardId;
  return typeof cardId === "string" && cardId.startsWith("hsc_mock_");
}

// readState 在无 raw、parsed.version !== 1 或 JSON.parse 抛错时都回 emptyState；缺失的 latest/dismissedUntilByKey/requiresPublishAfterDismissalByKey 用 ?? 补齐；命中 isLegacyHighspeedMockNotice 时先写 cleaned 再返回，setItem 失败只回调 onPersistError，内存态仍用 cleaned——不能把含 24h 静默的整份状态打回空。
function readState(
  storage: GlobalNoticeStorage,
  onPersistError?: (error: unknown) => void,
): PersistedGlobalNoticeState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PersistedGlobalNoticeState>;
    if (parsed.version !== 1) return emptyState();
    const state: PersistedGlobalNoticeState = {
      version: 1,
      latest: parsed.latest ?? null,
      dismissedUntilByKey: parsed.dismissedUntilByKey ?? {},
      requiresPublishAfterDismissalByKey: parsed.requiresPublishAfterDismissalByKey ?? {},
    };
    if (!isLegacyHighspeedMockNotice(state.latest)) return state;

    // Bug 根因：早期 Highspeed mock 通知使用 latest-only 持久化，关闭 mock 后重启仍会恢复假分享数据。
    const cleaned = { ...state, latest: null };
    // 清理写失败不能把整份状态（含 24h 静默）打回空：内存态照常用 cleaned。
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    } catch (error) {
      onPersistError?.(error);
    }
    return cleaned;
  } catch {
    return emptyState();
  }
}

// createGlobalNoticeStore 注入 storage/now/onPersistError：now 缺省 Date.now，初始 state 由 readState 读一次后全部迁移走内存，listeners 用 Set 天然去重；返回的 GlobalNoticeStore 不暴露 state 对象，只能经 publish/dismiss/getVisible/getSnapshot/subscribe 访问。
export function createGlobalNoticeStore(options: {
  storage: GlobalNoticeStorage;
  now?: () => number;
  /** 持久化失败（QuotaExceeded、存储被禁用）的受控回调；缺省静默，浏览器入口接 logger.warn。 */
  onPersistError?: (error: unknown) => void;
}): GlobalNoticeStore {
  const now = options.now ?? Date.now;
  let state = readState(options.storage, options.onPersistError);
  const listeners = new Set<() => void>();

  // persist 是全部状态迁移的唯一出口：先 options.storage.setItem(STORAGE_KEY, JSON.stringify(state))，setItem 抛错只调 onPersistError 并继续，for (const listener of listeners) listener() 不做异常隔离——内存态已更新，订阅者必须收到；写存储失败不能阻断 publish/dismiss，否则 claim 后异常会留下不可重试状态。
  const persist = () => {
    // Bug 根因：setItem 抛错会让 publish/dismiss 抛出，订阅者收不到已更新的内存态；而调用方
    // （SessionPane 自动分享）已先 claim 再 publish，异常会留下不可重试的 claim，用户看不到分享卡且
    // 当前 Renderer 生命周期内无法恢复。持久化只是展示增强：内存态先更新、写存储 best-effort、
    // 无论成败都通知订阅者（spec §6）。
    try {
      options.storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      options.onPersistError?.(error);
    }
    for (const listener of listeners) listener();
  };

  return {
    publish(notice) {
      const dismissedUntil = state.dismissedUntilByKey[notice.dedupeKey] ?? 0;
      state = {
        ...state,
        latest: notice.persistencePolicy === "latest-only" ? notice : state.latest,
        requiresPublishAfterDismissalByKey: {
          ...state.requiresPublishAfterDismissalByKey,
          [notice.dedupeKey]: dismissedUntil > now(),
        },
      };
      persist();
    },
    dismiss(noticeId) {
      const latest = state.latest;
      if (!latest || latest.noticeId !== noticeId) return;
      const cooldownMs =
        latest.dismissPolicy.kind === "cooldown" ? latest.dismissPolicy.cooldownMs : 0;
      state = {
        ...state,
        dismissedUntilByKey: {
          ...state.dismissedUntilByKey,
          [latest.dedupeKey]: now() + cooldownMs,
        },
        requiresPublishAfterDismissalByKey: {
          ...state.requiresPublishAfterDismissalByKey,
          [latest.dedupeKey]: true,
        },
      };
      persist();
    },
    // getVisible 先取 state.latest，为空返回 null；latest.expiresAt !== undefined && expiresAt <= now() 即过期，dismissedUntilByKey[dedupeKey] > now() 表示冷却中，requiresPublishAfterDismissalByKey[dedupeKey] 为 true 表示关闭过——三者任一命中返回 null，返回的是内部引用，调用方只读。
    getVisible() {
      const latest = state.latest;
      if (!latest) return null;
      const current = now();
      if (latest.expiresAt !== undefined && latest.expiresAt <= current) return null;
      if ((state.dismissedUntilByKey[latest.dedupeKey] ?? 0) > current) return null;
      if (state.requiresPublishAfterDismissalByKey[latest.dedupeKey]) return null;
      return latest;
    },
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createMemoryNoticeStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** localStorage 在隐私模式、被禁用或沙箱 iframe 中访问即抛 SecurityError；退回内存存储，通知在本次会话内仍可用。 */
function resolveBrowserNoticeStorage(): GlobalNoticeStorage {
  try {
    const storage = window.localStorage;
    if (storage) return storage;
  } catch (error) {
    logger.warn("[global-notice] localStorage 不可用，改用内存存储", {
      error: describeError(error),
    });
  }
  return createMemoryNoticeStorage();
}

export const browserGlobalNoticeStore =
  typeof window === "undefined"
    ? null
    : createGlobalNoticeStore({
        storage: resolveBrowserNoticeStorage(),
        onPersistError: (error) =>
          logger.warn("[global-notice] 通知持久化失败，仅保留内存态", {
            error: describeError(error),
          }),
      });
