// INV-01 lock 路径由构造函数单参数注入，类内不拼接 data root；守住位置：constructor 只存 path 字段；改错故障：路径下沉到类内会让多个 data root 共用同一把锁并互相阻塞启动。
// INV-02 handle 与 ownerToken 只在 tryAcquireOnce 成功后同时赋值；守住位置：成功分支内相邻两行赋值；改错故障：先赋值后写盘会在写失败时留下无法凭 token 回收的所有权。
// INV-03 inspect 的五态必须穷尽且互斥；守住位置：DataRootLockInspection 的联合类型；改错故障：退化成布尔会让调用方把 invalid 当成 stale 去清理。
// INV-04 ENOENT 单独映射为 missing，其余读取错误归 unreadable；守住位置：读取 catch 内的分支；改错故障：把权限错误当 missing 会诱导调用方误判可启动并新建锁。
// INV-05 JSON 解析失败返回 invalid 而不抛出；守住位置：解析处的空 catch；改错故障：抛出会让盘点从可诊断状态退化成上层崩溃。
// INV-06 pid 必须是正整数才算有效；守住位置：pid 归一化的三元表达式；改错故障：放行 0 或小数会让存活探测得出错误结论。
// INV-07 acquire 先建目录再抢锁，目录权限 0o700；守住位置：acquire 首行；改错故障：顺序颠倒会在目录缺失时稳定失败于 ENOENT。
// INV-08 快路径一次成功即返回，不进入 recovery gate；守住位置：acquire 中紧随其后的早返回；改错故障：无条件走慢路径会让正常启动也产生额外文件与毫秒级延迟。
// INV-09 慢路径最多 100 次尝试，每轮失败退避 5ms；守住位置：循环边界与循环末尾的等待；改错故障：去掉上限会在持续竞争下无限自旋。
// INV-10 循环开头先读 owner 并判活，活锁立即抛冲突；守住位置：循环首段；改错故障：跳过判活会把运行中实例的锁 rename 走，造成双实例。
// INV-11 recovery gate 抢不到时退避重试，不立刻报冲突；守住位置：recoveryToken 为空的 continue 分支；改错故障：立刻抛错会把瞬时竞争误报成「已在运行」。
// INV-12 拿到 recovery gate 后必须二次读 owner 复核；守住位置：try 块内的 current 判断；改错故障：只信第一次观察会在窗口期内误清理他人锁。
// INV-13 recovery gate 的归还在 finally 中执行；守住位置：finally 里的释放调用；改错故障：任何提前 return 都会永久占住 gate，让全部实例卡死。
// INV-14 release 的顺序是先关句柄、再清内存态、最后凭 token 归还路径；守住位置：release 的三段顺序；改错故障：顺序打乱会让其他进程仍看到被占用的旧 inode。
// INV-15 抢占用的隔离名带 pid 与随机后缀；守住位置：claimStalePath 首行的 quarantine 命名；改错故障：固定后缀会让并发进程互相覆盖对方的隔离文件。
// INV-16 抢占后必须比对隔离文件内容与预期 raw，不一致就改名还原；守住位置：claimedRaw 的比较分支；改错故障：直接删会删掉后来者刚写入的活锁。
// INV-17 releaseOwnedPath 仅在 token 匹配时删除，不匹配直接返回；守住位置：首段的 token 比较；改错故障：改按 pid 判断会误删同 pid 复用的新 owner。
// INV-18 isHolderAlive 对 EPERM 保守返回 true，只有 ESRCH 视为已退出；守住位置：信号探测的 catch；改错故障：把 EPERM 当死亡会在权限隔离环境下抢走活锁。
//
// 模块职责：为单个 data root 提供跨进程互斥的 lock 文件，并以 ownerToken 保证只释放自己持有的锁。
// 状态所有权：DataRootLock 独占 handle 与 ownerToken 两个字段，磁盘 lock 文件是唯一跨进程事实来源。
// 阅读顺序：先看 inspect 的五态判定，再读 acquire 的快慢路径，然后看 claimStalePath 与 releaseOwnedPath 的 token 校验，最后看 isHolderAlive 的存活语义。
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

// 对外契约：inspect 只读不写，调用后 lock 文件的内容与存在性都不得改变。
// 五态语义互斥，调用方必须区分 active 与 stale，只有 stale 才允许进入抢占流程。
// unreadable 携带原始 error 供上报，不能吞掉，否则盘点工具无法区分损坏与权限问题。
// 判定顺序固定为读取、解析、pid 归一化、存活探测，任一环节失败立即返回对应状态。
// 这里不加锁，结果天然是某一瞬间的快照，多进程下必然可能过期，调用方不得据此做写决策。
// 改错预警：若在 inspect 内部顺手清理 stale，只读查询就变成写操作，并会掩盖并发冲突。
export type DataRootLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number }
  | { state: "stale"; pid: number }
  | { state: "invalid" }
  | { state: "unreadable"; error: unknown };

export class DataRootLock {
  private handle: FileHandle | undefined;
  private ownerToken: string | undefined;
  public constructor(private readonly path: string) {}

  public async inspect(): Promise<DataRootLockInspection> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { state: "missing" };
      }
      return { state: "unreadable", error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid" };
    }
    const pid =
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
        ? parsed.pid
        : undefined;
    if (pid === undefined) return { state: "invalid" };
    return this.isHolderAlive(pid) ? { state: "active", pid } : { state: "stale", pid };
  }

  // 对外契约：acquire 正常返回即表示本进程独占锁，失败一律抛同一句冲突文案。
  // 冲突文案保持单一句式，是为了让上层启动提示稳定，不要按分支定制不同措辞。
  // tryAcquireOnce 返回 false 仅代表 EEXIST，其余错误原样抛出，acquire 不额外捕获。
  // 慢路径的前提是锁存在但持有者可能已死，因此必须先证明对方存活才终止。
  // 100 次与 5ms 是协作式退避上限，不是超时兜底，不要在循环外再加等待。
  // 改错预警：把冲突判断改成看文件是否存在，会把 stale 锁当活锁，实例将永远无法启动。
  public async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (await this.tryAcquireOnce()) return;
    const recoveryPath = `${this.path}.recovery`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.readOwner(this.path);
      if (observed && this.isHolderAlive(observed.record.pid)) {
        throw new Error("Another ZCode Server instance is already running");
      }
      const recoveryToken = await this.tryAcquireRecoveryGate(recoveryPath);
      if (!recoveryToken) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const current = await this.readOwner(this.path);
        if (current && this.isHolderAlive(current.record.pid)) {
          throw new Error("Another ZCode Server instance is already running");
        }
        if (current) {
          await this.claimStalePath(this.path, current.raw);
        }
        if (await this.tryAcquireOnce()) return;
      } finally {
        await this.releaseOwnedPath(recoveryPath, recoveryToken);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Another ZCode Server instance is already running");
  }

  // release 必须幂等：重复调用时 handle 与 token 已清空，只剩一次无害的空转。
  // 顺序不可交换：先关句柄、再清内存态、最后凭 token 归还磁盘路径。
  // 关闭句柄的失败被吞掉是有意为之，句柄关闭不了也不应阻止后续释放文件名。
  // 只有 token 存在才尝试归还，避免未持有锁的实例误删他人文件。
  // 归还走 token 校验而不是直接删除，防止退出晚于新 owner 时踩掉新锁。
  // 改错预警：这里若改为无条件删文件，进程退出与新实例接管交错时会直接破坏互斥。
  public async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token) await this.releaseOwnedPath(this.path, token);
  }

  // 原子性来自 open 的 wx 标志：仅在文件不存在时创建成功，这是全流程唯一的互斥点。
  // 权限 0o600 保证 lock 内容不被同机其他用户读取或篡改。
  // 先写 pid、acquiredAt、ownerToken，再发布内存态，保证外部看到的锁一定有可解析内容。
  // EEXIST 是正常竞争结果，返回 false 交给慢路径处理，不应作为错误记录。
  // 非 EEXIST 失败要尽力回滚：关闭句柄，确认 token 仍属于自己再删除文件，然后原样抛出。
  // 改错预警：先赋值 handle 再写文件，写失败会留下指向空内容的句柄且无法凭 token 清理。
  private async tryAcquireOnce(): Promise<boolean> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ownerToken })}\n`,
      );
      this.handle = handle;
      this.ownerToken = ownerToken;
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      await handle?.close().catch(() => undefined);
      const observed = await this.readOwner(this.path);
      if (observed?.record.ownerToken === ownerToken) {
        await this.releaseOwnedPath(this.path, ownerToken);
      }
      throw error;
    }
  }

  // 该读取器服务于竞争路径，因此把「读不到」与「内容不合法」都折叠成可继续处理的值。
  // 文件不存在、权限不足等读取失败统一返回 null，调用方据此视为当前无人持有。
  // 解析失败时仍返回原始 raw 与空 record，让抢占阶段能做内容比对与还原。
  // pid 与 ownerToken 都做类型和范围校验，非法值降级为 undefined 而不是抛错。
  // 改错预警：这里若抛错，acquire 的循环会把可恢复的瞬态读失败直接升级为启动失败。
  private async readOwner(path: string): Promise<{
    raw: string;
    record: { ownerToken?: string; pid?: number };
  } | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { ownerToken?: unknown; pid?: unknown };
      return {
        raw,
        record: {
          ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : undefined,
          pid:
            typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
              ? parsed.pid
              : undefined,
        },
      };
    } catch {
      return { raw, record: {} };
    }
  }

  // 该方法是对外可见的存活判定，inspect 与 acquire 共用同一语义，不允许两处各写一套。
  // pid 等于自身时直接返回 true，因为没必要对当前进程做信号探测。
  // 0 号信号只验证进程存在性，不投递真实信号，因此不会干扰目标进程。
  // EPERM 说明进程存在但无权限，保守判活；ESRCH 才代表已退出并允许抢占。
  // 改错预警：把任何异常都当死亡，会在容器或跨用户环境下抢走正在运行的锁。
  public isHolderAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      // ESRCH 表示进程不存在（stale）；EPERM 表示进程存在但无权限，保守视为存活。
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  }

  private async tryAcquireRecoveryGate(path: string): Promise<string | null> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ownerToken })}\n`,
      );
      await handle.close();
      return ownerToken;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        await handle?.close().catch(() => undefined);
        const observed = await this.readOwner(path);
        if (observed?.record.ownerToken === ownerToken) {
          await this.releaseOwnedPath(path, ownerToken);
        }
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const observed = await this.readOwner(path);
    if (!observed || !this.isHolderAlive(observed.record.pid)) {
      if (observed) await this.claimStalePath(path, observed.raw);
      return null;
    }
    return null;
  }

  // 抢占采用 rename 到隔离名的两阶段方案，先夺走路径再校验，避免边删边被重写。
  // ENOENT 视为已被他人处理并直接返回，属于可接受的竞争结果。
  // 内容与 expectedRaw 一致才真正删除；不一致说明中间换了 owner，必须改名还原。
  // 改错预警：省略内容比对，会让「观察到 stale 之后、rename 之前」新写入的活锁被误删。
  private async claimStalePath(path: string, expectedRaw: string): Promise<void> {
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const claimedRaw = await readFile(quarantine, "utf8").catch(() => null);
    if (claimedRaw === expectedRaw) {
      await rm(quarantine, { force: true });
      return;
    }
    // 陈旧观察误 claim 了后来者时必须恢复，不能删除新 owner 的 lock。
    await rename(quarantine, path).catch(() => undefined);
  }

  private async releaseOwnedPath(path: string, ownerToken: string): Promise<void> {
    const observed = await this.readOwner(path);
    if (observed?.record.ownerToken !== ownerToken) return;
    const quarantine = `${path}.release-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch {
      return;
    }
    const claimed = await this.readOwner(quarantine);
    if (claimed?.record.ownerToken === ownerToken) {
      await rm(quarantine, { force: true });
      return;
    }
    await rename(quarantine, path).catch(() => undefined);
  }
}
