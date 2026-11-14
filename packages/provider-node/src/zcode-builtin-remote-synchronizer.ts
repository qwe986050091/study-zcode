// INV-01 单飞：守住位置 refresh 在途判断；改错故障：并发调用触发多次下载。
// INV-02 释放即短路：守住位置 disposed 检查；改错故障：销毁后仍发起网络请求。
// INV-03 锁内决议：守住位置 租约读写；改错故障：两个进程同时判定可刷新。
// INV-04 锁外下载：守住位置 fetchRelease 调用；改错故障：慢请求长期占用文件锁。
// INV-05 租约归属：守住位置 leaseId 比对；改错故障：后到进程覆盖先到者的租约。
// INV-06 端点复核：守住位置 下载后 endpoint 比较；改错故障：把 A 端点的版本应用到 B 端点。
// INV-07 退避守约：守住位置 nextEligibleAt 判断；改错故障：失败后立刻重试形成风暴。
// INV-08 强制越窗：守住位置 force 分支；改错故障：手动刷新被退避窗口挡住。
// INV-09 取消不计失败：守住位置 cancelled 分支；改错故障：主动销毁被记成一次下载失败。
// INV-10 成功清零：守住位置 success 分支；改错故障：恢复后仍按旧的失败次数退避。
// INV-11 退避有顶：守住位置 最大延迟钳制；改错故障：指数增长直到溢出。
// INV-12 损坏即空：守住位置 控制文件解析失败；改错故障：崩溃残留永久阻断刷新。
// INV-13 缺文件即空：守住位置 ENOENT 分支；改错故障：首次运行被当成错误。
// INV-14 原子写：守住位置 writeControl；改错故障：读到半截 JSON 的控制文件。
// INV-15 回调隔离：守住位置 onRefreshResult 异常；改错故障：日志失败把成功应用变成失败。
// INV-16 空端点拒绝：守住位置 endpointKey 判空；改错故障：用空键共享租约，跨环境串台。
// INV-17 释放幂等：守住位置 finishLease 无租约分支；改错故障：重复释放改写他人窗口。
// INV-18 结果可枚举：守住位置 返回值集合；改错故障：调用方无法区分跳过与失败。
//
// 模块职责：在多进程间协调 ZCode Built-in 远端版本的检查与落地。
// 状态所有权：跨进程状态只存在控制文件；本类仅持在途句柄与释放标志。
// 阅读顺序：常量与选项 → 类骨架 → 刷新主流程 → 租约收尾 → 控制文件读写。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import type { ZCodeBuiltinRelease } from "./zcode-builtin-release.js";

// 小时既是成功刷新间隔的默认值，也是失败退避的上限。
// 两处共用同一常量，避免默认值悄悄漂移。
//
const HOUR_MS = 60 * 60 * 1_000;

export type ZCodeBuiltinRefreshResult =
  | "updated"
  | "unchanged"
  | "stale"
  | "missing"
  | "skipped"
  | "disposed";

export interface ZCodeBuiltinRemoteSynchronizerOptions {
  readonly source: NodeZCodeBuiltinProviderConfigSource;
  readonly controlFilePath: string;
  readonly resolveEndpointKey: () => string | Promise<string>;
  readonly fetchRelease: (
    endpointKey: string,
    signal: AbortSignal,
  ) => Promise<ZCodeBuiltinRelease | null>;
  readonly onRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  readonly now?: () => number;
  readonly successIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly failureBaseDelayMs?: number;
  readonly failureMaxDelayMs?: number;
}

export interface ZCodeBuiltinRefreshEvent {
  readonly result: ZCodeBuiltinRefreshResult;
  readonly reason?: "lease-held" | "not-due" | "endpoint-changed";
  readonly revision?: number;
}

interface RefreshControl {
  readonly schemaVersion: 1;
  readonly endpointKey: string;
  readonly leaseId?: string;
  readonly leaseUntil: number;
  readonly nextEligibleAt: number;
  readonly failureCount: number;
}

/** Environment 共享控制文件合并多进程刷新；网络期间不持有文件锁。 */
// 多进程通过控制文件协商租约，网络请求期间不持有文件锁。
// 同一实例的并发刷新复用 #inFlight 在途 Promise，重复调用方共享同一次下载结果，不会各自再发网络请求。
//
export class ZCodeBuiltinRemoteSynchronizer {
  readonly #options: ZCodeBuiltinRemoteSynchronizerOptions;
  readonly #now: () => number;
  #inFlight: Promise<ZCodeBuiltinRefreshResult> | null = null;
  #disposed = false;
  #abortController: AbortController | null = null;

  constructor(options: ZCodeBuiltinRemoteSynchronizerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  // 已释放实例一律返回 disposed，不再发起网络。
  // 已有在途请求时直接复用，避免重复下载。
  // finally 中只清理属于自己的在途句柄。
  //
  refresh(options: { readonly force?: boolean } = {}): Promise<ZCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#inFlight) return this.#inFlight;
    const controller = new AbortController();
    this.#abortController = controller;
    const refresh = this.#refresh(options.force === true, controller.signal).finally(() => {
      if (this.#inFlight === refresh) {
        this.#inFlight = null;
        this.#abortController = null;
      }
    });
    this.#inFlight = refresh;
    return refresh;
  }

  // dispose 只置 #disposed 并触发 #abortController.abort()，不等在途请求收敛：在途分支随后走取消路径自行释放租约。
  // 在途分支会在中止后走取消路径释放租约。
  //
  dispose(): void {
    this.#disposed = true;
    this.#abortController?.abort();
  }

  // endpoint 在锁外解析，解析失败直接抛出，不留下租约。
  // 空 endpoint 视为配置错误，不用默认值兜底。
  // 租约写入放在文件锁内，读改写一次完成。
  // 同 endpoint 未过期租约直接让出，避免多进程重复下载。
  //
  async #refresh(force: boolean, signal: AbortSignal): Promise<ZCodeBuiltinRefreshResult> {
    const endpointKey = (await this.#options.resolveEndpointKey()).trim();
    if (this.#disposed) return "disposed";
    if (!endpointKey) throw new Error("ZCode Built-in 远端 Endpoint 不能为空");
    const leaseId = randomUUID();
    const acquired = await withFileLock(this.#options.controlFilePath, async () => {
      const now = this.#now();
      const current = await readControl(this.#options.controlFilePath);
      const sameEndpoint = current.endpointKey === endpointKey;
      if (sameEndpoint && current.leaseUntil > now) return "lease-held" as const;
      if (!force && sameEndpoint && current.nextEligibleAt > now) return "not-due" as const;
      await writeControl(this.#options.controlFilePath, {
        schemaVersion: 1,
        endpointKey,
        leaseId,
        leaseUntil: now + (this.#options.leaseDurationMs ?? 30_000),
        nextEligibleAt: sameEndpoint ? current.nextEligibleAt : 0,
        failureCount: sameEndpoint ? current.failureCount : 0,
      });
      return true;
    });
    // 未拿到租约时上报 skipped，并带上具体原因。
    // 网络请求在锁外执行，慢请求不会阻塞其他进程。
    //
    if (acquired !== true) {
      this.#report({ result: "skipped", reason: acquired });
      return "skipped";
    }

    try {
      signal.throwIfAborted();
      const release = await this.#options.fetchRelease(endpointKey, signal);
      if (this.#disposed) {
        await this.#finishLease(endpointKey, leaseId, "cancelled");
        return "disposed";
      }
      const currentEndpointKey = (await this.#options.resolveEndpointKey()).trim();
      signal.throwIfAborted();
      if (currentEndpointKey !== endpointKey) {
        await this.#finishLease(endpointKey, leaseId, true);
        this.#report({ result: "skipped", reason: "endpoint-changed" });
        return "skipped";
      }
      const result = release ? await this.#options.source.applyRemoteRelease(release) : "missing";
      await this.#finishLease(endpointKey, leaseId, true);
      this.#report({ result, ...(release ? { revision: release.revision } : {}) });
      return result;
    } catch (error) {
      await this.#finishLease(endpointKey, leaseId, this.#disposed ? "cancelled" : false);
      if (this.#disposed) return "disposed";
      throw error;
    }
  }

  // 已释放实例不再回调，避免销毁后仍触达监听方。
  // 回调异常被吞掉，日志写失败不能反转业务结果。
  //
  #report(event: ZCodeBuiltinRefreshEvent): void {
    if (this.#disposed) return;
    try {
      this.#options.onRefreshResult?.(event);
    } catch {
      /* 日志不能把成功应用改成下载失败。 */
    }
  }

  // 先复核 endpoint 与 leaseId，防止覆盖别人的租约。
  // success === "cancelled" 时保持 failureCount 与既有退避窗口不变，只把 nextEligibleAt 归零。
  // success === true 时 failureCount 清零并恢复 successIntervalMs 的正常间隔，下一次刷新按点触发。
  // success === false 时按 failureCount 指数退避，delay 封顶 failureMaxDelayMs，防止连续失败把刷新频率压到不可用。
  async #finishLease(
    endpointKey: string,
    leaseId: string,
    success: boolean | "cancelled",
  ): Promise<void> {
    await withFileLock(this.#options.controlFilePath, async () => {
      const current = await readControl(this.#options.controlFilePath);
      if (current.endpointKey !== endpointKey || current.leaseId !== leaseId) return;
      const failureCount =
        success === "cancelled" ? current.failureCount : success ? 0 : current.failureCount + 1;
      const delay =
        success === "cancelled"
          ? 0
          : success
            ? (this.#options.successIntervalMs ?? HOUR_MS)
            : Math.min(
                (this.#options.failureBaseDelayMs ?? 60_000) * 2 ** Math.max(0, failureCount - 1),
                this.#options.failureMaxDelayMs ?? HOUR_MS,
              );
      await writeControl(this.#options.controlFilePath, {
        schemaVersion: 1,
        endpointKey,
        leaseUntil: 0,
        nextEligibleAt: this.#now() + delay,
        failureCount,
      });
    });
  }
}

// 文件不存在视为空控制文件，不是错误。
// 内容损坏同样回退空控制，进程崩溃不能永久阻断刷新。
//
async function readControl(filePath: string): Promise<RefreshControl> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return emptyControl();
    throw error;
  }
  try {
    const input = JSON.parse(raw) as unknown;
    return isRefreshControl(input) ? input : emptyControl();
  } catch {
    // 控制文件不是业务事实；进程崩溃留下的损坏内容在锁内重建，不能永久阻断刷新。
    return emptyControl();
  }
}

function emptyControl(): RefreshControl {
  return { schemaVersion: 1, endpointKey: "", leaseUntil: 0, nextEligibleAt: 0, failureCount: 0 };
}

function writeControl(filePath: string, control: RefreshControl): Promise<void> {
  return atomicWritePrivateTextFile(filePath, JSON.stringify(control, null, 2));
}

// 只接受 schemaVersion 1 的对象。
// failureCount 必须是非负整数。
// 可选字段允许缺失，但存在时类型必须正确。
function isRefreshControl(input: unknown): input is RefreshControl {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    value.schemaVersion === 1 &&
    typeof value.endpointKey === "string" &&
    (value.leaseId === undefined || typeof value.leaseId === "string") &&
    typeof value.leaseUntil === "number" &&
    typeof value.nextEligibleAt === "number" &&
    Number.isInteger(value.failureCount) &&
    (value.failureCount as number) >= 0
  );
}

// 只认对象形态的 ENOENT。
// 其余错误原样抛回，交由上层失败退避。
//
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
