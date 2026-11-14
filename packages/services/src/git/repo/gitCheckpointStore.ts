// Git checkpoint 元数据的本地持久化层：把每个 workspace 的快照清单落盘到应用配置目录。
// 只做「按 workspace 分目录 + 单文件原子写」这一件事，不能解释 Git 语义，也不做索引/缓存。
// 读取路径保持宽松：文件缺失、内容损坏或结构不符一律返回 null，由上层决定降级行为。
// 写入路径按文件串行化，避免同一 checkpoint 的并发 save/delete 互相覆盖或读到半成品。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir, getWorkspaceHash } from "../../paths.js";
import type { GitCheckpointMeta } from "@zcode/shared";

// 运行时类型守卫：磁盘上的 JSON 可能来自旧版本或被人工修改，不能直接断言成 GitCheckpointMeta。
// 逐字段校验到 scope 字面量，宁可判定为非法（返回 null）也不把残缺对象泄漏给上层。
// 这里刻意不抛错，保证 load 的「读不到就返回 null」契约对调用方稳定。
function isGitCheckpointMeta(value: unknown): value is GitCheckpointMeta {
  // 磁盘 JSON 可能解析成 null 或数组，先挡掉非对象，否则下面的候选字段访问会抛 TypeError
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // 判定为对象后仍不能用完整类型断言，先用 Partial<GitCheckpointMeta> 承接再逐键校验
  const candidate = value as Partial<GitCheckpointMeta>;
  return (
    // checkpointId 与 workspacePath 是定位文件的键，任一不是字符串就必须判非法，否则 load 会拼出错误路径
    typeof candidate.checkpointId === "string" &&
    typeof candidate.workspacePath === "string" &&
    typeof candidate.repoRoot === "string" &&
    typeof candidate.workspaceInRepoPath === "string" &&
    // createdAt 要求 number 而非字符串，因为列表排序直接比较数值，字符串会让同一时间戳排到错误位置
    typeof candidate.createdAt === "number" &&
    typeof candidate.refName === "string" &&
    // commitOid 与 refName 缺一不可，缺少时上层无法执行 git diff，只能当作损坏文件丢弃
    typeof candidate.commitOid === "string" &&
    // scope 只接受字面量 workspace，出现别的值说明格式来自不兼容版本，返回 null 由上层决定重建
    candidate.scope === "workspace"
  );
}

// 构造参数可选，便于测试注入临时目录；生产环境统一落在 getAppConfigDir()/checkpoints 下。
// 实例本身无共享状态，多实例写同一路径时仅靠原子 rename 保证不产生半截文件。
export class GitCheckpointStore {
  constructor(
    private readonly options?: {
      rootDir?: string;
    },
  ) {}

// 每个目标文件一条 Promise 链，必须把同一 checkpoint 的写操作排成 FIFO，跨文件仍可并行。
// 只记录「最后一次写入完成」的信号，不缓存失败信息，失败不会阻塞后续写入。
  private readonly writeChains = new Map<string, Promise<void>>();

// 目录按 workspace 哈希而非原始路径命名，规避路径分隔符与长度限制带来的非法文件名。
  private get checkpointsDir(): string {
    return this.options?.rootDir ?? join(getAppConfigDir(), "checkpoints");
  }

// 哈希化后不同 workspace 不会互相干扰，也不暴露用户真实目录结构。
  private checkpointDir(workspacePath: string): string {
    return join(this.checkpointsDir, getWorkspaceHash(workspacePath));
  }

// 一个 checkpoint 对应一个 JSON 文件，文件名必须是 checkpointId，便于按 ID 直接定位与删除。
  private checkpointFilePath(workspacePath: string, checkpointId: string): string {
    return join(this.checkpointDir(workspacePath), `${checkpointId}.json`);
  }

// 读之前先等同一文件的在途写入结束，否则可能读到 rename 之前的旧内容（甚至不存在）。
// 等待失败被吞掉是刻意的：写入失败时仍应让读取按「文件不存在」正常降级。
  private async waitForPendingWrite(filePath: string): Promise<void> {
    await this.writeChains.get(filePath)?.catch(() => {});
  }

// 把操作追加到该文件的串行链尾部；previous.catch 保证前一次失败不会中断后续操作。
// completion 恒为 resolve，仅用于链式占位与清理，否则失败会沿链扩散成未处理的 rejection。
// 链尾完成后若没有新操作入队就删除条目，防止 writeChains 随 checkpoint 数量无限增长。
  private enqueueWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    // Map 无条目时用已 resolve 的占位 Promise，首个写入无需特判就能挂到同一条链上
    const previous = this.writeChains.get(filePath) ?? Promise.resolve();
    // previous.catch 吞掉上一次的失败，否则一次写失败会让后续同文件操作全部被拒绝
    const result = previous.catch(() => {}).then(operation);
    // completion 把成功与失败都折成 undefined，使 Map 里不留 rejected Promise 触发未处理拒绝
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    // 入队即更新表尾，后来者拿到的 previous 一定是这个 completion，串行顺序由此保证
    // 写链只活在内存：进程被 kill 时排队中的操作直接消失，不会在下次启动补做，持久性只靠已完成的 rename。
    this.writeChains.set(filePath, completion);
    // finally 排在表项替换之后清理，若不清会随 checkpoint 数量增长而无限驻留
    void completion.finally(() => {
      // 只删除仍等于 completion 的表项，期间已有新链入队时删掉会破坏后续操作的串行性
      if (this.writeChains.get(filePath) === completion) {
        this.writeChains.delete(filePath);
      }
    });
    return result;
  }

// 先写同目录临时文件再 rename，利用同分区 rename 的原子性避免读到写了一半的 JSON。
// 临时名混入 pid、时间戳与随机串，防止多进程并发写同一 checkpoint 时互相覆盖临时文件。
// 不在此处 try/catch：失败应向上冒泡，让调用方感知落盘失败而不是静默丢数据。
  private async writeManifestAtomic(filePath: string, meta: GitCheckpointMeta): Promise<void> {
    // 临时名混入 process.pid 与时间戳，多进程同写一个 checkpoint 时不会互相覆盖临时文件
    const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    // 先写 tempPath 而不是目标，进程在序列化中途被杀时 filePath 仍是上一份完整内容
    // 崩溃窗口只存在于 writeFile(tempPath) 与 rename 之间：此时 load 仍读到旧元数据，temp 残留不影响正确性；
    // 反过来先 rm 目标再 rename 会打开「文件不存在」窗口，并发 load 会把 checkpoint 误判为已删除。
    await writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
    // rename 在同一目录内原子替换，并发读者只会看到旧文件或新文件，不会读到半截 JSON
    await rename(tempPath, filePath);
  }

// 先建目录再入队写文件；mkdir 放在队列内，保证并发首次写入不会相互竞争目录创建。
// 同一 workspace+checkpointId 的 save 会按调用顺序串行执行，后写的结果覆盖先写的。
  async save(meta: GitCheckpointMeta): Promise<void> {
    // 路径由 workspacePath 与 checkpointId 决定，先算出来才能作为串行队列的键
    const filePath = this.checkpointFilePath(meta.workspacePath, meta.checkpointId);
    await this.enqueueWrite(filePath, async () => {
      // mkdir 放在队列回调内，两个并发首次 save 不会同时创建同一目录而竞争
      // 顺序约束：mkdir 必须早于 writeManifestAtomic，目录不存在时 writeFile(tempPath) 会直接 ENOENT，rename 无从执行。
      await mkdir(this.checkpointDir(meta.workspacePath), { recursive: true });
      // 原子写完成后队列才放行下一个操作，后一次 save 必然看到前一次的完整结果
      await this.writeManifestAtomic(filePath, meta);
    });
  }

// 统一在任何异常（读失败、JSON 解析失败、结构不符）下返回 null，调用方无需区分错误类型。
// 先等待在途写入完成，保证「save 后立刻 load」能读到刚提交的内容。
  async load(workspacePath: string, checkpointId: string): Promise<GitCheckpointMeta | null> {
    // load 先解析出与 save 相同的 filePath，后续等写入与删除都落在同一个键上
    const filePath = this.checkpointFilePath(workspacePath, checkpointId);
    try {
      // 先等同一文件的在途写入，否则 save 后立刻 load 会读到旧文件甚至 ENOENT
      await this.waitForPendingWrite(filePath);
      const raw = await readFile(filePath, "utf-8");
      // 用 unknown 承接解析结果，后续必须过类型守卫，直接断言会让损坏字段流入调用方
      const parsed = JSON.parse(raw) as unknown;
      // 结构不符时返回 null 而不抛错，上层据此把该 checkpoint 当作不存在
      return isGitCheckpointMeta(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

// 删除也走同一条写队列，确保不会与并发 save 交错，最终状态由入队顺序决定。
  async delete(workspacePath: string, checkpointId: string): Promise<void> {
    // 删除同样按 workspacePath 与 checkpointId 解析路径，保证与 save 命中同一个键
    const filePath = this.checkpointFilePath(workspacePath, checkpointId);
    // delete 也进同一条写队列，与并发 save 的先后由入队顺序决定，不会出现删完又被旧写复活
    await this.enqueueWrite(filePath, async () => {
      await rm(filePath, { force: true });
    });
  }
}
