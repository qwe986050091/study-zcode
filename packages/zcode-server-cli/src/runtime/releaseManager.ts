// INV-01 临时文件名带进程与随机段：守住位置 路径拼接；改错故障 并发写同毫秒互相覆盖。
// INV-02 原子写以独占权限落盘：守住位置 写入选项；改错故障 其他用户可改发布指针。
// INV-03 临时文件在收尾统一删除：守住位置 收尾分支；改错故障 失败重试残留临时文件。
// INV-04 重命名仅在特定平台重试：守住位置 上限计算；改错故障 每次写盘都做无谓退避。
// INV-05 只对可恢复错误重试：守住位置 错误码判断；改错故障 真实错误被吞掉。
// INV-06 退避次数有界：守住位置 循环条件；改错故障 持续占用进程无法退出。
// INV-07 初始化目录权限收紧：守住位置 目录创建；改错故障 同机他人可读发布内容。
// INV-08 安装归属先校验再使用：守住位置 初始化顺序；改错故障 冒名进程接管安装目录。
// INV-09 更新前先落事务标记：守住位置 调用顺序；改错故障 中途退出后无法回滚指针。
// INV-10 事务标记缺失视为无需恢复：守住位置 错误判断；改错故障 首次启动报错退出。
// INV-11 事务内容非法则拒绝启动：守住位置 模式解析；改错故障 损坏标记被静默忽略。
// INV-12 恢复优先回到旧指针：守住位置 恢复调用；改错故障 启动指向未验证的发布。
// INV-13 恢复成功后删除标记：守住位置 收尾调用；改错故障 每次启动重复回滚。
// INV-14 执行前再次校验发布目录：守住位置 读取入口；改错故障 元数据读取被当成执行授权。
// INV-15 发布目录必须位于发布根内：守住位置 前缀判断；改错故障 指针可指向任意目录。
// INV-16 边界校验前先规范化路径：守住位置 真实路径解析；改错故障 符号链接别名被误判越界。
// INV-17 目标必须是已存在目录：守住位置 类型判断；改错故障 指向文件或缺失目录仍被执行。
// INV-18 写入前统一解析绝对路径：守住位置 入参构造；改错故障 相对路径随工作目录漂移。
//
// 模块职责：发布指针的原子读写、更新事务与中断恢复。
// 状态所有权：无模块级状态；指针与事务标记都在磁盘上，实例只持有布局。
// 阅读顺序：先看原子写与重试，再看事务流程，最后看边界校验。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { releaseManifestSchema, type ReleaseManifest } from "../contracts.js";
import type { ServerLayout } from "./paths.js";
import { ensureServerInstallOwnership } from "./installationOwnership.js";

interface UpdateTransaction {
  previous: ReleaseManifest | null;
}

// 只有 win32 走有界重试（maxAttempts=5），POSIX 宿主保持一次替换。
// 只在 EPERM 或 EBUSY 上重试，其他错误码立即抛出。
// 退避间隔由 setTimeout 设为 10 * attempt 毫秒，随次数线性增长。
// 达到 maxAttempts 后把最后一次错误原样抛出，不包装也不吞掉。
async function renameWithWindowsRetry(temporary: string, path: string): Promise<void> {
  // 并发写各自持有唯一临时文件，但 rename 替换同一目标时 Windows 的
  // 目标文件会短暂处于替换中状态，后到的 rename 报 EPERM（POSIX 原子替换无此竞争）。
  // 语义上并发写本来就允许"后写覆盖先写"，对 EPERM/EBUSY 做有界退避重试即可收敛；
  // POSIX 宿主不触发重试，行为不变。
  const maxAttempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= maxAttempts || (code !== "EPERM" && code !== "EBUSY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

// 先以 recursive 建好父目录，避免首次写入因目录缺失失败。
// 临时文件名带上 pid 与 randomUUID，保证每次原子写独占一个路径。
// 内容写完后交给 renameWithWindowsRetry 替换目标，读方只会看到完整文件。
// finally 里删临时文件，force + catch 保证成功与失败都不留残骸。
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 同进程内两个 lifecycle 操作可能在同一毫秒写同一个临时文件，先完成
  // rename 的写入会让另一个写入以 ENOENT 失败。随机后缀保证每次原子写独占临时路径。
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithWindowsRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// ensure() 负责创建 serverRoot、releasesDir、runDir 三个私有目录，权限必须为 0700。
// beginUpdate() 先把 previous 指针写入事务文件，后续步骤失败时据此回滚。
// recoverInterruptedUpdate 优先恢复到事务里的 previous 指针，而不是猜测当前发布目录。
// 执行 Core 前重新校验发布目录边界，指针越界就拒绝执行。
export class ReleaseManager {
  public constructor(private readonly layout: ServerLayout) {}

  public async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.layout.serverRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.layout.releasesDir, { recursive: true, mode: 0o700 }),
      mkdir(this.layout.runDir, { recursive: true, mode: 0o700 }),
    ]);
    await ensureServerInstallOwnership(this.layout);
  }

  public async beginUpdate(previous: ReleaseManifest | null): Promise<void> {
    await atomicWriteJson(this.layout.updateTransactionFile, { previous });
  }

  public async completeUpdate(): Promise<void> {
    await rm(this.layout.updateTransactionFile, { force: true });
  }

  public async applyPendingWithTransaction(
    previous: ReleaseManifest | null,
  ): Promise<ReleaseManifest> {
    await this.beginUpdate(previous);
    return await this.applyPending();
  }

  public async recoverInterruptedUpdate(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.layout.updateTransactionFile, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    let transaction: UpdateTransaction;
    try {
      const parsed = JSON.parse(raw) as { previous?: unknown };
      transaction = {
        previous: parsed.previous === null ? null : releaseManifestSchema.parse(parsed.previous),
      };
    } catch (error: unknown) {
      throw new Error(`Update transaction is invalid: ${this.layout.updateTransactionFile}`, {
        cause: error,
      });
    }
    // applyPending 先切换 current，再删除 pending；若进程在 Core ready 前退出，
    // current 可能指向未成功启动的 release。
    // 启动时优先恢复事务中的旧指针，恢复失败则保留 marker，让后续启动继续 fail-closed。
    await this.restoreCurrent(transaction.previous);
    await this.completeUpdate();
  }

  public async readCurrent(): Promise<ReleaseManifest | null> {
    return await this.readManifest(this.layout.currentFile);
  }

  public async readCurrentForExecution(): Promise<ReleaseManifest | null> {
    const manifest = await this.readCurrent();
    if (!manifest) return null;
    // current.json 的写入路径都会校验 releaseDir，但本地残留或外部篡改仍可能
    // 让启动侧读到越界指针。执行 Core 前再次校验边界，避免把恢复/更新元数据读取误当成执行授权。
    await this.assertReleaseDir(manifest);
    return manifest;
  }

  public async readPending(): Promise<ReleaseManifest | null> {
    return await this.readManifest(this.layout.pendingFile);
  }

  public async removePending(): Promise<void> {
    await rm(this.layout.pendingFile, { force: true });
  }

  public async writePending(manifest: ReleaseManifest): Promise<void> {
    const parsed = releaseManifestSchema.parse({
      ...manifest,
      releaseDir: resolve(manifest.releaseDir),
    });
    await this.assertReleaseDir(parsed);
    await atomicWriteJson(this.layout.pendingFile, parsed);
  }

  public async applyPending(): Promise<ReleaseManifest> {
    const pending = await this.readPending();
    if (!pending) {
      throw new Error("No pending release is prepared");
    }
    await this.assertReleaseDir(pending);
    await atomicWriteJson(this.layout.currentFile, pending);
    await rm(this.layout.pendingFile, { force: true });
    return pending;
  }

  public async restoreCurrent(manifest: ReleaseManifest | null): Promise<void> {
    if (manifest) {
      await this.assertReleaseDir(manifest);
      await atomicWriteJson(this.layout.currentFile, manifest);
      return;
    }
    await rm(this.layout.currentFile, { force: true });
  }

  private async readManifest(path: string): Promise<ReleaseManifest | null> {
    try {
      const raw = await readFile(path, "utf8");
      return releaseManifestSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async assertReleaseDir(manifest: ReleaseManifest): Promise<void> {
    const releaseDir = resolve(manifest.releaseDir);
    // canonical server root 会把 /var 等符号链接收敛到物理路径，但旧 manifest
    // 仍可能保存别名路径。校验边界时也 canonicalize，避免合法的历史 release 被误判越界。
    const canonicalReleaseDir = await realpath(releaseDir).catch(() => releaseDir);
    const canonicalReleasesDir = await realpath(this.layout.releasesDir).catch(() =>
      resolve(this.layout.releasesDir),
    );
    if (
      !canonicalReleaseDir.startsWith(
        `${canonicalReleasesDir}${process.platform === "win32" ? "\\" : "/"}`,
      )
    ) {
      throw new Error("Release directory must be inside the server releases directory");
    }
    const releaseStat = await stat(releaseDir).catch(() => null);
    if (!releaseStat?.isDirectory()) {
      throw new Error(`Release directory does not exist: ${releaseDir}`);
    }
  }
}
