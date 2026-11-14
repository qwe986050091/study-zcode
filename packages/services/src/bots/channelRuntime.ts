// bots/channelRuntime.ts — 渠道 runtime 共用的锁、指纹与等待原语。
//
// INV-01 锁是“目录 + owner.json + lease 文件”的复合状态，必须先在唯一临时目录
//        写全再原子 rename；竞争者看到目录即代表锁已完整初始化。
// INV-02 锁租约 30s、心跳 10s；只有“进程存活且租约新鲜”才算有效锁，
//        进程已死或租约过期都允许接管。
// INV-03 release 必须核对 pid/botId/nonce，不能删除别人的锁。
// INV-04 指纹只由调用方给定的有序身份片段组成；顺序变化即视为不同连接。
// INV-05 回调结果必须 ok=true 才允许提交外部游标；失败要抛错阻断确认。
// INV-06 等待原语必须在结束时移除 abort 监听器，signal 会长期复用。
// [平台] Windows 上 rename 到已存在目录为 EPERM，需要与权限错误区分。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig, BotProviderCallbackResult, BotRuntimeInfo } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

// 拿不到锁时的重试间隔，与租约时长分开配置。
export const BOT_RUNTIME_LOCK_RETRY_MS = 10_000;
export const BOT_RUNTIME_LOCK_LEASE_MS = 30_000;
// 心跳必须显著小于租约，留出至少两次续租机会。
const BOT_RUNTIME_LOCK_HEARTBEAT_MS = 10_000;
// 清理陈旧锁的退避序列；用尽仍失败则上抛。
const BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const;

// 日志接口：traceId 可为空，渠道层负责补齐。
export interface BotRuntimeLogger {
  debug(traceId: string | undefined, message: string): void;
  info(traceId: string | undefined, message: string): void;
  warn(traceId: string | undefined, message: string): void;
}

// 运行态读写接口；由 runtime 宿主实现。
export interface BotRuntimeStatusSink {
  getRuntimeStatus(botId: string): BotRuntimeInfo | undefined;
  setRuntimeStatus(status: BotRuntimeInfo): void;
}

// 连接指纹：有序片段做 JSON 编码后 sha256，顺序敏感（见 INV-04）。
export function createBotConnectionFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 回调返回值语义：ok=false 是业务失败，不是“无消息”。
export function assertBotCallbackSucceeded(
  provider: string,
  result: BotProviderCallbackResult,
): void {
  if (result.ok) {
    return;
  }
  // Bugfix: provider callback 以返回值表达可恢复的业务失败，不一定 reject。
  // 外部消费游标只能在 ok=true 后提交，否则瞬时失败会被错误确认并永久丢消息。
  throw new Error(`${provider} callback failed: status=${result.status ?? "unknown"}`);
}

// 串行刷新队列：后一轮等待前一轮，但失败不阻断后续。
export function createLatestRuntimeRefreshQueue() {
  // 代次用于判断 reconcile 是否仍是最新配置。
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    // 入队即分配代次；执行时用 isLatest 决定是否继续。
    enqueue(reconcile: (isLatest: () => boolean) => Promise<void>): Promise<void> {
      const currentGeneration = ++generation;
      // 前一轮失败已被 catch 折叠，不会阻断本轮。
      const result = queue
        .catch(() => undefined)
        .then(() => reconcile(() => currentGeneration === generation));
      // Bugfix: 配置保存会连续触发 fire-and-forget refresh。串行队列既要让后一轮等待
      // 前一轮释放连接，又不能因前一轮失败永久阻断后续最新配置。
      // 队列自身永远保持 resolved 状态。
      queue = result.catch(() => undefined);
      return result;
    },
    // 使所有已入队但未执行的 reconcile 判定为过期。
    invalidate(): void {
      generation += 1;
    },
  };
}

// owner 文件内容；nonce 用于区分同一进程的多次获取。
interface BotRuntimeLockOwner {
  pid: number;
  botId: string;
  nonce: string;
  createdAt: number;
}

// 释放句柄；重复调用应保持幂等。
interface BotRuntimeLock {
  release(): Promise<void>;
}
// Node 错误判定：Error 且带 code 字段。
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// 锁竞争错误集合；EPERM 在 Windows rename 场景也代表目标已存在。
export function isBotRuntimeLockConflictError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}

// 清理可重试错误：句柄释放延迟导致的短暂失败。
function isBotRuntimeLockCleanupRetryable(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EPERM" ||
      error.code === "EBUSY" ||
      error.code === "ENOTEMPTY")
  );
}

// `removeBotRuntimeLockPath` 有限退避删除；不可重试错误立即上抛。
async function removeBotRuntimeLockPath(lockPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      // 取本次退避；用尽（undefined）即放弃重试。
      const delay = BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!isBotRuntimeLockCleanupRetryable(error) || delay === undefined) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

// 锁 key 先哈希再拼路径，避免 token/appId 直接出现在文件名。
function getBotRuntimeLockPath(namespace: string, lockKey: string): string {
  // trim 后哈希，避免首尾空白产生不同锁。
  const lockHash = createHash("sha256").update(lockKey.trim()).digest("hex");
  return join(getAppConfigDir(), "bots-runtime-locks", namespace, `${lockHash}.lock`);
}

// owner 缺失或损坏一律返回 null，由调用方按“无主”处理。
async function readBotRuntimeLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {
  try {
    // 读取失败（缺失/损坏）统一按 null 处理。
    const raw = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf-8"),
    ) as Partial<BotRuntimeLockOwner>;
    return typeof raw.pid === "number" &&
      typeof raw.botId === "string" &&
      typeof raw.nonce === "string"
      ? {
          pid: raw.pid,
          botId: raw.botId,
          nonce: raw.nonce,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
        }
      : null;
  } catch {
    return null;
  }
}

// 租约时间取 lease 文件 mtime；缺失按 0 处理（视为过期）。
async function readBotRuntimeLockLeaseAt(lockPath: string, nonce: string): Promise<number> {
  try {
    return (await stat(join(lockPath, `lease-${nonce}`))).mtimeMs;
  } catch {
    return 0;
  }
}

// 信号 0 探测存活；EPERM 说明进程存在但无权限，同样算存活。
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

// 两轮尝试：第一轮正常创建，冲突时判断接管或失败。
async function acquireBotRuntimeLock(
  namespace: string,
  lockKey: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  // 正式锁路径；临时目录以 nonce 后缀保证唯一。
  const lockPath = getBotRuntimeLockPath(namespace, lockKey);
  // nonce 每次获取都重新生成。
  const owner: BotRuntimeLockOwner = {
    pid: process.pid,
    botId,
    nonce: randomBytes(8).toString("hex"),
    createdAt: Date.now(),
  };
  // 租约文件按 nonce 命名，心跳只更新自己的文件。
  const leasePath = join(lockPath, `lease-${owner.nonce}`);
  // 父目录（namespace）只建一次，可递归。
  await mkdir(dirname(lockPath), {
    recursive: true,
  });
  // `attempt < 2`：最多两轮，正常创建或接管一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 临时目录与正式路径同父目录，保证 rename 原子。
    const pendingLockPath = `${lockPath}.${owner.nonce}.pending`;
    try {
      // Bugfix: 锁目录和 owner 文件必须作为一个完整状态对外可见。
      // 先在唯一临时目录写完 owner，再原子 rename，避免竞争者把尚未初始化完成的锁误判为 stale。
      // 先建临时目录，后续写入都在其中完成。
      await mkdir(pendingLockPath);
      // owner 与 lease 必须在 rename 前写全（见 INV-01）。
      await writeFile(join(pendingLockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
      // 空的 lease 文件只需存在，续租靠 mtime。
      await writeFile(join(pendingLockPath, `lease-${owner.nonce}`), "");
      try {
        // 原子发布：成功即代表锁已完整可见。
        await rename(pendingLockPath, lockPath);
      } catch (error) {
        // Bugfix：Windows 将临时锁目录 rename 到已存在锁目录时返回 EPERM；这里只把 rename 冲突当作锁竞争，
        // 避免把 mkdir/writeFile 的权限错误误判为可接管锁。
        // 非竞争错误（权限/磁盘）直接上抛，不能误接管。
        if (!isBotRuntimeLockConflictError(error)) {
          throw error;
        }
        // EPERM 也可能只是目录权限错误；只有正式锁路径确实存在时，才进入冲突接管分支。
        // 正式路径不存在说明不是竞争，保留原始错误。
        if (!(await stat(lockPath).catch(() => undefined))) {
          throw error;
        }
        const currentOwner = await readBotRuntimeLockOwner(lockPath);
        // 读取现任 owner，判断是否可接管。
        if (currentOwner) {
          const leaseAt = await readBotRuntimeLockLeaseAt(
            lockPath,
            currentOwner.nonce,
          );
          // 租约年龄；0 表示没有 lease 文件。
          const leaseAge = Date.now() - leaseAt;
          if (
            isProcessAlive(currentOwner.pid) &&
            leaseAt > 0 &&
            leaseAge < BOT_RUNTIME_LOCK_LEASE_MS
          ) {
            return null;
          }
        }
        // 陈旧锁：清理后重试一轮（见 INV-02）。
        // Bugfix：陈旧目录可能短暂被 Windows 文件句柄占用；有限重试后再放弃，避免静默残留。
        await removeBotRuntimeLockPath(lockPath);
        continue;
      }
      // 心跳写保护，避免 utimes 堆积。
      let heartbeatWriting = false;
      // 周期续租；进程退出后租约自然过期。
      const heartbeat = setInterval(() => {
        // 上一轮 utimes 未完成时跳过本轮。
        if (heartbeatWriting) return;
        heartbeatWriting = true;
        const now = new Date();
        // 续租失败不致命，下一次心跳继续尝试。
        void utimes(leasePath, now, now)
          .catch(() => undefined)
          .finally(() => {
            heartbeatWriting = false;
          });
      }, BOT_RUNTIME_LOCK_HEARTBEAT_MS);
      // 心跳不能阻止进程退出。
      heartbeat.unref();
      return {
        // 释放前核对 owner，防止误删他人锁（见 INV-03）。
        async release() {
          // 先停心跳再删锁，避免释放后又把租约续回来。
          clearInterval(heartbeat);
          const currentOwner = await readBotRuntimeLockOwner(lockPath);
          if (
            currentOwner?.pid === owner.pid &&
            currentOwner.botId === owner.botId &&
            currentOwner.nonce === owner.nonce
          ) {
            await removeBotRuntimeLockPath(lockPath);
          }
        },
      };
    } finally {
      // 无论成功失败都清理临时目录，避免残留。
      await removeBotRuntimeLockPath(pendingLockPath);
    }
  }
  return null;
}

// Telegram 轮询锁：以 token 为 key。
export async function acquireTelegramPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("telegram-polling", token, botId);
}

// 微信轮询锁：以 token 为 key。
export async function acquireWeixinPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("weixin-polling", token, botId);
}

// 飞书 WebSocket 锁：以 provider+appId 为 key。
export function acquireFeishuWebSocketLock(
  bot: Pick<BotConfig, "id" | "provider" | "feishuAppId">,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock(`${bot.provider}-websocket`, bot.feishuAppId?.trim() ?? "", bot.id);
}

// 可取消的延时；abort 时立即 resolve 而不是 reject。
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    // 清理定时器与监听器，保证 signal 不累积监听。
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    // abort 与超时共用 finish，保证只 resolve 一次。
    const onAbort = () => finish();
    // 超时与 abort 谁先到都只 resolve 一次。
    const timeout = setTimeout(finish, ms);
    // Bugfix: runtime 会长期复用同一个 signal；每次等待结束都必须移除监听器，避免重试时持续累积。
    // once 只是保险；finish 里仍显式移除（见 INV-06）。
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// 等待 signal abort；已 abort 时立即返回。
export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  // 只注册一次监听，resolve 后由 once 自动移除。
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
