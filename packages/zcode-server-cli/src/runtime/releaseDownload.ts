// INV-01 发布 JSON 统一超时：守住位置 fetchReleaseJson；改错故障 请求永久挂起。
// INV-02 非成功状态即抛错：守住位置 状态判断；改错故障 错误页被当数据解析。
// INV-03 响应必须过 schema：守住位置 解析调用；改错故障 合同漂移进入运行时。
// INV-04 计时器必须清理：守住位置 finally；改错故障 计时器泄漏。
// INV-05 空闲超时按无数据计：守住位置 计时重置；改错故障 大文件被误判超时。
// INV-06 总时长有独立上限：守住位置 overallTimeoutMs；改错故障 慢速连接永久占用。
// INV-07 未知大小用默认时长：守住位置 默认计算；改错故障 预算为零。
// INV-08 速率估算带下限：守住位置 取最大值；改错故障 小文件预算过短。
// INV-09 重试仅限可恢复错误：守住位置 可重试判断；改错故障 校验失败被反复重试。
// INV-10 中止与类型错误可重试：守住位置 名称判断；改错故障 网络抖动直接失败。
// INV-11 特定状态码可重试：守住位置 状态判断；改错故障 限流被当成永久失败。
// INV-12 退避按指数增长：守住位置 位移运算；改错故障 重试风暴。
// INV-13 临时文件带进程与随机后缀：守住位置 路径拼接；改错故障 并发下载互相覆盖。
// INV-14 空闲计时随数据重置：守住位置 数据监听；改错故障 传输中被中断。
// INV-15 大小不符即失败：守住位置 期望值比对；改错故障 截断包被接受。
// INV-16 校验和必须匹配：守住位置 摘要比对；改错故障 损坏包被安装。
// INV-17 失败清理临时文件：守住位置 catch；改错故障 残留半成品。
// INV-18 成功才原子改名：守住位置 改名调用；改错故障 目标文件被写坏。
//
// 模块职责：下载发布清单与归档，校验大小与校验和后原子落盘。
// 状态所有权：函数内临时资源；模块只持有默认常量。
// 阅读顺序：先看清单请求与默认值，再看重试判定，最后看单次下载流程。
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { type ZodType } from "zod";
import { releaseCatalogSchema, type ReleaseCatalog } from "../contracts.js";

// fetchReleaseJson() 统一 fetch 的 redirect 与超时策略。
// 非成功状态即抛错。
// 响应必须通过 schema 校验。
// finally 里 clearTimeout()，无论成败都清理计时器。
export async function fetchReleaseJson<T>(
  url: string,
  schema: ZodType<T>,
  timeoutMs = 10_000,
  resourceName = "Release JSON",
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`${resourceName} download failed: HTTP ${response.status}`);
    return schema.parse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchReleaseCatalog(url: string, timeoutMs = 10_000): Promise<ReleaseCatalog> {
  return await fetchReleaseJson(url, releaseCatalogSchema, timeoutMs, "Release catalog");
}

export interface DownloadOptions {
  url: string;
  destination: string;
  sha256: string;
  expectedSizeBytes?: number;
  /** 无数据活动时的超时；收到数据后会重新计时。 */
  timeoutMs?: number;
  /** 可选的总时长上限；未提供时按 expectedSizeBytes 动态计算。 */
  overallTimeoutMs?: number;
  /** 短暂网络错误的最大尝试次数，默认为 3。 */
  maxAttempts?: number;
  /** 重试基础退避时长，主要供测试或诊断缩短。 */
  retryDelayMs?: number;
}

// 空闲超时按 DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS 无数据活动计。
// 每次收到 data 都重置空闲计时。
// DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS 另有总时长上限。
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND = 256 * 1024;
const DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DOWNLOAD_RETRY_ATTEMPTS = 3;
const DEFAULT_DOWNLOAD_RETRY_DELAY_MS = 250;

class ReleaseDownloadHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Release download failed: HTTP ${status}`);
    this.name = "ReleaseDownloadHttpError";
  }
}

// expectedSizeBytes 为 undefined 时直接用默认总时长。
// 按 DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND 估算传输预算。
// Math.min()/Math.max() 把结果夹在空闲与总上限之间。
function defaultOverallTimeoutMs(expectedSizeBytes: number | undefined): number {
  if (expectedSizeBytes === undefined) return DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS;
  const transferBudgetMs = Math.ceil(expectedSizeBytes / DEFAULT_DOWNLOAD_RATE_BYTES_PER_SECOND) * 1_000;
  return Math.min(
    DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS,
    Math.max(DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS, transferBudgetMs + 30_000),
  );
}

// AbortError 与 TypeError 可重试。
// 特定 HTTP 状态可重试。
// ECONNRESET/ETIMEDOUT/EAI_AGAIN/UND_ERR_SOCKET 可重试。
// 其余错误直接失败。
function isRetryableDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TypeError") return true;
  if (error instanceof ReleaseDownloadHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "UND_ERR_SOCKET";
}

async function waitBeforeRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export class ReleaseDownloader {
  // Math.max(1, options.maxAttempts ?? 3) 保证至少一次。
  // 退避按 retryDelayMs * 2 ** attempt 增长。
  // isRetryableDownloadError() 为假时直接 throw。
  public async download(options: DownloadOptions): Promise<void> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_DOWNLOAD_RETRY_ATTEMPTS);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_DOWNLOAD_RETRY_DELAY_MS);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.downloadOnce(options);
        return;
      } catch (error: unknown) {
        if (attempt + 1 >= maxAttempts || !isRetryableDownloadError(error)) throw error;
        await waitBeforeRetry(retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async downloadOnce(options: DownloadOptions): Promise<void> {
    const temporary = `${options.destination}.part-${process.pid}-${randomUUID()}`;
    const controller = new AbortController();
    const idleTimeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS;
    const overallTimeoutMs = options.overallTimeoutMs ?? defaultOverallTimeoutMs(options.expectedSizeBytes);
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    const overallTimer = setTimeout(() => controller.abort(), overallTimeoutMs);
    resetIdleTimer();
    try {
      await mkdir(dirname(options.destination), { recursive: true });
      const response = await fetch(options.url, { redirect: "follow", signal: controller.signal });
      if (!response.ok) throw new ReleaseDownloadHttpError(response.status);
      if (!response.body) throw new Error("Release download failed: response body is empty");
      const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
      const onData = (): void => resetIdleTimer();
      body.on("data", onData);
      try {
        await pipeline(
          body,
          createWriteStream(temporary, { flags: "w" }),
          { signal: controller.signal },
        );
      } finally {
        body.off("data", onData);
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (options.expectedSizeBytes !== undefined) {
        const downloadedSize = (await stat(temporary)).size;
        if (downloadedSize !== options.expectedSizeBytes) {
          throw new Error(`Release archive size mismatch: expected ${options.expectedSizeBytes}, received ${downloadedSize}`);
        }
      }
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(temporary)) digest.update(chunk);
      const actual = digest.digest("hex");
      if (actual.toLowerCase() !== options.sha256.toLowerCase()) {
        throw new Error(`Release archive checksum mismatch: expected ${options.sha256}, received ${actual}`);
      }
      const file = await import("node:fs/promises");
      await file.rename(temporary, options.destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(overallTimer);
    }
  }
}
