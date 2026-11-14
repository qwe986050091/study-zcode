// ============================================================
// 文件定位：Bash 合并输出的文件入口。子进程 stdout/stderr 由操作系统直接写入该文件，不过 Node collector。
// 输入输出：path 为落盘路径；result(maxBytes) 返回文本、字节数、截断标记与 artifact 元数据。
// 副作用：递归建目录、open 文件（POSIX 追加 + O_NOFOLLOW，Windows 覆写）、5s stat 轮询、unlink。
// 失败语义：读失败返回占位说明而不是抛错；close/discard 的 IO 异常被吞，不覆盖命令终态。
// 不变量：只有本次新建的文件才允许删除；exit/后台移交后旧观察器必须失效（靠 timer 同一性校验）。
// ============================================================
import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { buildBashOutputPreview } from "./bash-output-preview.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import type { ExecutionStreamResult, ExecutionOutputPreview } from "@zcode/contracts";

const OUTPUT_WATCH_INTERVAL_MS = 5_000;
const OUTPUT_FILE_MODE = 0o600;
const PROGRESS_TAIL_MAX_BYTES = 4096;

/** Bash 只持有文件身份和观察器；原始输出由子进程写入，不经过 Node collector。 */
// 生命周期：prepare 打开句柄并记录 created → 执行期由 OS 写入 → close 释放 → result 读取或 discard 清理。
// limit/progress 两种观察都基于文件大小与有界读，不依赖内存里保留的完整输出。
export class BashFileOutput {
  private handle?: FileHandle;
  private created = false;
  private prepared = false;
  private watchTimer?: NodeJS.Timeout;
  private unsubscribeProgress?: () => void;
  private progressDelay?: NodeJS.Timeout;

  constructor(
    readonly path: string,
    private readonly platform: NodeJS.Platform,
    private readonly legacyEncoding: string | null,
  ) {}

  get fd(): number | undefined {
    return this.handle?.fd;
  }

  // 准备文件：递归建目录、按平台选择打开方式，并记录“是否由本次创建”。
  // 失败直接抛出，由上层转成 spawn_error，或降级到 storage 内的 fallback 路径。
  async prepare(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const existing = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // Windows 的 append-only 句柄被 MSYS 判为只读；Windows 必须用 w。

    const flags =
      this.platform === "win32"
        ? "w"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    this.handle = await open(this.path, flags, OUTPUT_FILE_MODE);
    this.created = existing === undefined;
    this.prepared = true;
  }

  // 释放句柄；close 失败被吞，避免取消/退出结果被 IO 清理错误覆盖。
  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    // fd 清理失败不能覆盖取消/退出结果，也不能阻止 adapter 释放其它生命周期资源。
    await handle?.close().catch(() => undefined);
  }

  // 关闭并删除“本次新建”的文件；原先已存在的文件绝不删除，清理失败同样吞错。
  async discard(): Promise<void> {
    await this.close();
    if (this.created) {
      // 清理失败不能覆盖取消/spawn 的真实结果，也不能删除原有文件。
      await rm(this.path, { force: true }).catch(() => undefined);
    }
    this.prepared = false;
  }

  // 软阈值观察：每 5s stat 一次，文件超过 maxBytes 时回调一次 onLimit（不直接杀进程）。
  // checking 去重防止慢盘上 stat 重入；timer unref，不单独保活 CLI。
  watchLimit(maxBytes: number, onLimit: () => void): void {
    this.stopWatching();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void stat(this.path)
        .then(
          (file) => {
            // stat 可以在 exit 或后台移交之后才返回；旧观察器不能终止新状态。
            if (this.watchTimer !== timer || file.size <= maxBytes) return;
            this.stopWatching();
            onLimit();
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
        });
    }, OUTPUT_WATCH_INTERVAL_MS);
    timer.unref();
    this.watchTimer = timer;
  }

  // 一次性清空 limit 观察器、进度订阅与延迟计时器；exit、后台移交、close 多处可重复调用。
  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.unsubscribeProgress?.();
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.watchTimer = undefined;
    this.unsubscribeProgress = undefined;
    this.progressDelay = undefined;
  }

  // 延迟 delayMs 后接入共享轮询，每 intervalMs 读取一次有界尾窗并回调预览。
  // 只读文件尾部；迟到读取用 isActive() 丢弃，避免旧任务把过期预览写回。
  watchProgress(
    maxBytes: number,
    delayMs: number,
    intervalMs: number,
    onRead: (output: ExecutionStreamResult, preview: ExecutionOutputPreview) => void,
  ): void {
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = undefined;
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.progressDelay = setTimeout(() => {
      this.progressDelay = undefined;
      let previousLines = 0;
      this.unsubscribeProgress = subscribeBashOutputProgress(intervalMs, async (isActive) => {
        const output = await readBashOutput(
          this.path,
          Math.min(maxBytes, PROGRESS_TAIL_MAX_BYTES),
          true,
          this.legacyEncoding,
        );
        // 共享 interval 仍在服务其他任务；取消/重订阅后必须丢弃本订阅迟到的读取。
        if (!isActive()) return;
        const preview = buildBashOutputPreview(
          output.text,
          output.bytesRead,
          output.bytes,
          previousLines,
        );
        previousLines = preview.totalLines;
        onRead(output, preview);
      });
    }, delayMs);
    this.progressDelay.unref();
  }

  // 读取最终输出：未 prepare 时返回空串；读失败返回带 errno 的占位说明。
  // 这样模型能区分“命令没有输出”和“输出文件读不到”，而不是误判成功空输出。
  async result(maxBytes: number): Promise<ExecutionStreamResult> {
    if (!this.prepared) return { text: "", bytes: 0, truncated: false };
    try {
      const { bytesRead: _bytesRead, ...result } = await readBashOutput(
        this.path,
        maxBytes,
        false,
        this.legacyEncoding,
      );
      return result;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      return {
        text: `<bash output unavailable: output file ${this.path} could not be read (${code}).>`,
        bytes: 0,
        truncated: false,
      };
    }
  }
}

// 有界读取 Bash 输出文件：tail=true 取末尾 maxBytes，false 取开头。
// 返回 bytes=文件总大小、bytesRead=实际读出字节；循环 read 处理部分读，句柄在 finally 关闭。
export async function readBashOutput(
  path: string,
  maxBytes: number,
  tail: boolean,
  legacyEncoding: string | null,
): Promise<ExecutionStreamResult & { bytesRead: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(0, maxBytes));
    const offset = tail ? size - length : 0;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    return {
      text: decodeExecutionOutputBuffer(buffer.subarray(0, bytesRead), legacyEncoding),
      bytes: size,
      bytesRead,
      truncated: size > bytesRead,
      artifactPath: path,
      artifactBytes: size,
      artifactTruncated: false,
    };
  } finally {
    await handle.close();
  }
}

// 空输出 + 非零退出时的诊断：检查输出目录所在文件系统是否空间或 inode 耗尽。
// 只在确实探测到资源枯竭时返回提示文案；statfs 失败静默返回 undefined，不掩盖真实退出码。
export async function diagnoseLostBashOutput(outputPath: string): Promise<string | undefined> {
  try {
    const outputDirectory = dirname(outputPath);
    const fileSystem = await statfs(outputDirectory, { bigint: true });
    const availableMegabytes = (fileSystem.bavail * fileSystem.bsize) / (1024n * 1024n);
    const recoveryHint =
      "Free up space on this filesystem.";
    if (availableMegabytes < 0n) return undefined;
    if (availableMegabytes < 10n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is full (${availableMegabytes}MB free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
    if (fileSystem.files > 0n && fileSystem.ffree < 1000n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is out of inodes (${fileSystem.ffree} free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
  } catch {

  }
  return undefined;
}
