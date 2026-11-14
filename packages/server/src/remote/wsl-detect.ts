// INV-01 非 Windows 直接判不可用：守住位置 平台判断；改错故障 非 Windows 调用外部命令。
// INV-02 空输出返回空串：守住位置 长度判断；改错故障 解码空缓冲出错。
// INV-03 含零字节走 UTF-16：守住位置 字节判断；改错故障 行内夹满零字符。
// INV-04 其余按 UTF-8 解码：守住位置 回退；改错故障 普通输出乱码。
// INV-05 归一化去零与 BOM：守住位置 清洗链；改错故障 首行带不可见字符。
// INV-06 CR 统一去除：守住位置 替换；改错故障 行尾残留回车。
// INV-07 空白行先过滤：守住位置 过滤；改错故障 解析出空发行。
// INV-08 至少三段才算发行：守住位置 长度判断；改错故障 标题行被当发行。
// INV-09 版本取末段：守住位置 倒数第一；改错故障 名称被当版本。
// INV-10 非数字版本跳过：守住位置 有限数判断；改错故障 版本写成非法值。
// INV-11 状态取倒数第二：守住位置 取值；改错故障 状态与名称错位。
// INV-12 默认标记单独识别：守住位置 星号判断；改错故障 名称带星号。
// INV-13 名称去星后非空才收：守住位置 非空判断；改错故障 收录空名发行。
// INV-14 版本仅接受一二：守住位置 白名单；改错故障 出现版本三。
// INV-15 缓存按执行器隔离：守住位置 弱映射；改错故障 不同执行器共享结果。
// INV-16 缓存只在成功期内复用：守住位置 过期判断；改错故障 过期仍返回旧值。
// INV-17 失败即删缓存：守住位置 捕获；改错故障 拒绝态固化到过期。
// INV-18 支持显式失效：守住位置 失效函数；改错故障 安装后仍读旧列表。
//
// 模块职责：WSL 可用性与发行版列表的探测、解析与短缓存。
// 状态所有权：探测结果按执行器缓存，外部可显式失效。
// 阅读顺序：先看输出解码与解析，再看缓存，最后看两个探测入口。
import { execFile } from "node:child_process";
import type { WSLDistro } from "@zcode/shared";
export type { WSLDistro } from "@zcode/shared";

const WSL_COMMAND = "wsl.exe";
const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

export const WSL_DISCOVERY_CACHE_TTL_MS = 5_000;

// 空缓冲直接返回空串。
// 含零字节按 UTF-16 解。
// 其余按 UTF-8 解。
// 两种编码都要兼容。
// 不修改入参。
function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  // `wsl.exe -l -v` 在 Windows 上常返回 UTF-16LE。
  // 如果这里直接按 UTF-8 解码，行内会夹满 `\0`，distro 解析会全部失效。
  // 通过检测 NUL 字节优先走 UTF-16LE，可以同时兼容 UTF-8/UTF-16LE 两种输出。
  if (buffer.includes(0)) {
    return buffer.toString("utf16le");
  }

  return buffer.toString("utf8");
}

function normalizeWslOutput(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "");
}

// 先归一化再分行。
// 空行先过滤。
// 至少三段才解析。
// 名称去默认星号。
// 版本只接受一二。
export function parseWSLDistroList(rawOutput: string): WSLDistro[] {
  const lines = normalizeWslOutput(rawOutput)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const distros: WSLDistro[] = [];
  for (const line of lines) {
    const parts = line
      .trim()
      .split(/\s{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 3) {
      continue;
    }

    const versionToken = parts.at(-1) ?? "";
    const parsedVersion = Number.parseInt(versionToken, 10);
    if (!Number.isFinite(parsedVersion)) {
      continue;
    }

    const state = parts.at(-2) ?? "";
    const nameToken = parts.slice(0, -2).join(" ").trim();
    const isDefault = nameToken.startsWith("*");
    const name = nameToken.replace(/^\*\s*/, "").trim();
    if (!name) {
      continue;
    }

    distros.push({
      name,
      isDefault,
      state,
      version: parsedVersion === 1 || parsedVersion === 2 ? parsedVersion : null,
    });
  }

  return distros;
}

async function execWslForBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      WSL_COMMAND,
      args,
      {
        encoding: "buffer",
        maxBuffer: WSL_EXEC_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");

        if (error) {
          const stderrText = normalizeWslOutput(decodeWslOutput(stderrBuffer)).trim();
          reject(new Error(stderrText || error.message));
          return;
        }

        resolve(stdoutBuffer);
      },
    );
  });
}

export type WSLBufferExecutor = (args: string[]) => Promise<Buffer>;

interface WSLDiscoveryCacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

let availabilityCache = new WeakMap<WSLBufferExecutor, WSLDiscoveryCacheEntry<boolean>>();
let distroListCache = new WeakMap<WSLBufferExecutor, WSLDiscoveryCacheEntry<WSLDistro[]>>();

// 命中未过期即复用。
// 未命中执行加载。
// 失败删除缓存。
// 缓存按执行器隔离。
function getCachedDiscovery<T>(
  cache: WeakMap<WSLBufferExecutor, WSLDiscoveryCacheEntry<T>>,
  executor: WSLBufferExecutor,
  load: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(executor);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const entry: WSLDiscoveryCacheEntry<T> = {
    expiresAt: Date.now() + WSL_DISCOVERY_CACHE_TTL_MS,
    promise: Promise.resolve().then(load),
  };
  cache.set(executor, entry);
  void entry.promise.catch(() => {
    // 临时 WSL CLI 错误不能把 rejected Promise 固化到 TTL 结束，
    // 后续显式重试需要立刻重新执行探测。
    if (cache.get(executor) === entry) {
      cache.delete(executor);
    }
  });
  return entry.promise;
}

export function invalidateWSLDiscoveryCache(executor?: WSLBufferExecutor): void {
  if (executor) {
    availabilityCache.delete(executor);
    distroListCache.delete(executor);
    return;
  }
  availabilityCache = new WeakMap();
  distroListCache = new WeakMap();
}

// 非 Windows 直接否。
// 状态命令成功即可用。
// 未识别命令视为不可用。
// 其余错误仍视为可用。
export async function isWSLAvailable(
  executor: WSLBufferExecutor = execWslForBuffer,
): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  return getCachedDiscovery(availabilityCache, executor, async () => {
    try {
      await executor(["--status"]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return !/not recognized|enoent/i.test(message);
    }
  });
}

export async function listWSLDistros(
  executor: WSLBufferExecutor = execWslForBuffer,
): Promise<WSLDistro[]> {
  if (process.platform !== "win32") {
    return [];
  }

  return getCachedDiscovery(distroListCache, executor, async () => {
    const output = await executor(["-l", "-v", "--all"]);
    return parseWSLDistroList(decodeWslOutput(output));
  });
}
