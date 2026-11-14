// INV-01 空路径直接拒绝：守住位置 构造函数校验；改错故障 配置写到进程目录。
// INV-02 轮询间隔必须为正：守住位置 数值校验；改错故障 零间隔忙轮询。
// INV-03 可整体关闭轮询：守住位置 假值分支；改错故障 无法禁用后台轮询。
// INV-04 读路径不加锁：守住位置 纯读分支；改错故障 慢 IO 放大成锁超时。
// INV-05 需要写盘才加锁：守住位置 规范化差异判断；改错故障 旧内容覆盖其他写者。
// INV-06 锁内必须重读：守住位置 锁定后读取；改错故障 用加锁前快照覆盖。
// INV-07 写前先规范化校验：守住位置 编解码往返；改错故障 越权来源落盘。
// INV-08 版本基于规范形态：守住位置 同一编码函数；改错故障 写成功即读回变化。
// INV-09 原子写私有文件：守住位置 共享工具；改错故障 他人可读配置。
// INV-10 写后记录版本：守住位置 版本赋值；改错故障 自身写入触发失效通知。
// INV-11 旧轮询结果丢弃：守住位置 世代比较；改错故障 版本倒退。
// INV-12 相同版本不通知：守住位置 版本相等判断；改错故障 重复刷新界面。
// INV-13 损坏文件不覆盖：守住位置 恢复分支；改错故障 用户配置被清空。
// INV-14 恢复回调不阻断：守住位置 捕获分支；改错故障 观测异常导致读取失败。
// INV-15 轮询错误只报一次：守住位置 活跃标志；改错故障 每分钟刷错误。
// INV-16 轮询在飞不重复排期：守住位置 状态组合；改错故障 定时器叠加。
// INV-17 定时器不阻塞退出：守住位置 取消引用；改错故障 进程无法自然结束。
// INV-18 快照与版本同源：守住位置 同一编码内容；改错故障 范围校验误报变化。
//
// 模块职责：个人 Provider 配置文件的读写、轮询与损坏恢复。
// 状态所有权：磁盘是唯一事实源，NodePersonalProviderConfigRepository 只持有 #observedRevision 与轮询计时器；
// 若把文件内容也缓存在类里，其他进程写入后这里会读到过期配置。
// 阅读顺序：先看读写与锁，再看版本与恢复，最后看轮询与通知。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "./provider-config-file-codec.js";

// importLegacy 只在正式文件不存在、进入锁内路径时调用；返回 null 表示无历史可导入，
// 文件仍是缺失态，之后每次锁内读取都会再试。onRecovery / onPollingError 是纯观测回调，
// 异常由仓库内部吞掉，不能反过来改变读写或降级语义。
export interface NodePersonalProviderConfigRepositoryOptions {
  readonly filePath: string;
  readonly importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPollingError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
}

export interface PersonalProviderConfigRecoveryEvent {
  readonly error: unknown;
}

export class NodePersonalProviderConfigRepository implements PersonalProviderConfigRepository {
  readonly #filePath: string;
  readonly #importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly #onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly #onPollingError?: (error: unknown) => void;
  readonly #pollingIntervalMs: number | false;
  readonly #listeners = new Set<(reason: string) => void>();
  #pollingTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingInFlight = false;
  #writeGeneration = 0;
  #pollingErrorActive = false;
  #observedRevision: string | null = null;
  #disposed = false;

  // 构造期就把轮询配置钉死：默认 1s，false 表示整体关闭；<=0 会直接抛错。
  // 这样 setTimeout(0) 不可能出现，保证不会退化成忙轮询（INV-02/INV-03）。
  constructor(options: NodePersonalProviderConfigRepositoryOptions) {
    if (!options.filePath.trim()) throw new Error("Personal Provider Config filePath 不能为空");
    this.#filePath = options.filePath;
    this.#importLegacy = options.importLegacy;
    this.#onRecovery = options.onRecovery;
    this.#onPollingError = options.onPollingError;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
    if (this.#pollingIntervalMs !== false && this.#pollingIntervalMs <= 0) {
      throw new Error("Personal Provider Config pollingIntervalMs 必须大于 0");
    }
  }

  // read() 先过 #assertNotDisposed()：dispose 之后调用直接抛错，防止已销毁实例继续返回陈旧快照。
  // 正常路径走 #readCurrent() 的无锁读取，#observedRevision 仅在首次为空时赋值，不能用本轮结果覆盖轮询已观察到的更新版本。
  // 读失败交给 #recoverInvalidFile() 降级为空快照且保留原文件；finally 里的 #ensurePolling() 保证读完就启动轮询。
  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await this.#readCurrent();
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } catch (error) {
      const snapshot = this.#recoverInvalidFile(error);
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  // update() 全程持 withFileLock()：锁内先 #readLocked() 重读，避免用调用方拿到的旧快照覆盖其他进程的写入。
  // transform 结果被 Object.freeze() 冻结后交给 #writeLocked() 原子替换；写成功后记录 #observedRevision，轮询不会把自己的写入当成外部变更重复通知。
  // #emit("updated") 放在锁释放之后，异常原样抛出由调用方决定是否重试。
  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await withFileLock(this.#filePath, async () => {
        const current = await this.#readLocked();
        const next = transform(current);
        const update = Object.freeze({
          providers: next.providers,
          models: next.models,
          providerOrder: next.providerOrder,
          defaultModelSelection: next.defaultModelSelection,
        });
        const committed = await this.#writeLocked(update);
        const snapshot = snapshotFromUpdate(committed);
        // 原子写可能产生多次文件系统事件。写入完成后先记录内容版本，
        // polling 随后读取到同一版本时不会再次发布失效通知。
        this.#observedRevision = snapshot.revision;
        return snapshot;
      });
      this.#emit("updated");
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  // 订阅返回退订闭包；#emit 同步调用监听器，抛错会中断本轮剩余监听器：
  // update() 的异常直接上抛给调用方，轮询路径则由 #pollOnce 的 catch 当成一次轮询错误处理。
  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // dispose 幂等且顺序固定：先清 timer 再清监听，防止已排期的回调在销毁后仍 emit；
  // 在飞的一轮由 #pollOnce 的 disposed 检查自行退出，不会在销毁后再写 #observedRevision。
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
    this.#listeners.clear();
  }

  // #readCurrent() 是纯读路径：不抢排他锁，慢 IO 不会把轮询放大成锁超时。
  // 文件缺失且没有 importLegacy 时直接返回空快照；内容与 encodeProviderConfigFile() 往返一致时同样直接返回，不产生写盘。
  // 只有导入或规范化确实要改文件时才进 withFileLock()，并在锁内重读，否则会覆盖其他 writer 刚提交的内容。
  async #readCurrent(): Promise<ProviderConfigLayerSnapshot> {
    // 多个进程纯读取也争排他锁，慢 IO 会把轮询放大成锁超时。
    // 正式文件通过同目录临时文件原子替换，纯读可以直接观察已提交的完整文档。
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null && !this.#importLegacy) return snapshotFromUpdate(emptyUpdate());
    if (file !== null) {
      const update = decodeProviderConfigFile(file.value);
      if (JSON.stringify(file.value) === JSON.stringify(encodeProviderConfigFile(update))) {
        return snapshotFromUpdate(update);
      }
    }
    // 导入和规范化仍会写盘。拿锁后必须重读，不能用加锁前的旧内容覆盖其他 writer。
    return withFileLock(this.#filePath, () => this.#readLocked());
  }

  // 锁内读取统一走这里：文件缺失时先尝试 importLegacy，导入成功也必须经 #writeLocked 落盘；
  // 编码往返不一致则回写规范化结果，保证返回的 snapshot 与磁盘最终的规范形态同源（INV-06/INV-08）。
  async #readLocked(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) {
      const imported = await this.#importLegacy?.();
      const update = imported ?? emptyUpdate();
      if (imported) return snapshotFromUpdate(await this.#writeLocked(update));
      return snapshotFromUpdate(update);
    }

    const update = decodeProviderConfigFile(file.value);
    const encoded = encodeProviderConfigFile(update);
    if (JSON.stringify(file.value) !== JSON.stringify(encoded)) {
      await this.#writeLocked(update);
    }
    return snapshotFromUpdate(update);
  }

  async #writeLocked(update: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerUpdate> {
    // 同一入口写入规则与默认选择；先严格验证整份结果，不能落盘后才发现来源越权/坏值。
    // 使用与读取相同的规范形态再计算版本，避免外层规则键顺序使“写成功”的版本读回就变化。
    const canonical = decodeProviderConfigFile(encodeProviderConfigFile(update));
    const encoded = encodeProviderConfigFile(canonical);
    await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
    // 每次落盘递增：在飞轮询用它与进入时的基线比较，判断自己读到的是否是旧内容（INV-11）。
    this.#writeGeneration += 1;
    return canonical;
  }

  // 轮询路径只读不写：不触发 importLegacy 与规范化写盘，后台轮询不应产生文件副作用；
  // 文件缺失时按空配置参与版本比较，等下一次 read/update 再做导入。
  async #readPollingSnapshot(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) return snapshotFromUpdate(emptyUpdate());
    return snapshotFromUpdate(decodeProviderConfigFile(file.value));
  }

  // #recoverInvalidFile() 只做降级：正式文件解析失败时原样保留，既不备份也不覆盖成空配置。
  // 本进程改用内存空 Overlay 并返回空快照，再经 #reportRecovery() 上报一次事件；
  // 回调抛出的异常被 #reportRecovery 吞掉，不能反向阻断恢复，随后等待用户手工修复原文件。
  #recoverInvalidFile(error: unknown): ProviderConfigLayerSnapshot {
    // 正式文件无效时必须原样保留，不能备份后覆盖成空配置；本进程仅以内存空
    // Overlay 降级，等待用户修复原文件。
    this.#reportRecovery({ error });
    return snapshotFromUpdate(emptyUpdate());
  }

  // 恢复事件冻结后再交给回调；回调异常在此吞掉，不能反向阻断降级路径（INV-14）。
  #reportRecovery(event: PersonalProviderConfigRecoveryEvent): void {
    try {
      this.#onRecovery?.(Object.freeze(event));
    } catch {
      // 观测回调不是配置事实，不能反向阻断恢复。
    }
  }

  // #ensurePolling() 保证同时只存在一个计时器：pollingIntervalMs 为 false、已有 timer、#pollingInFlight 或 #disposed 任一成立就直接返回。
  // 新 timer 的回调先清空 #pollingTimer 引用再触发 #pollOnce()，并用 unref() 确保后台轮询不阻塞进程退出。
  #ensurePolling(): void {
    // 轮询在飞时 timer 已清空；显式 read/update 的 finally 不能再排入第二轮。
    if (
      this.#pollingIntervalMs === false ||
      this.#pollingTimer ||
      this.#pollingInFlight ||
      this.#disposed
    )
      return;
    this.#pollingTimer = setTimeout(() => {
      this.#pollingTimer = null;
      void this.#pollOnce();
    }, this.#pollingIntervalMs);
    this.#pollingTimer.unref?.();
  }

  // #pollOnce() 进入即置 #pollingInFlight，并记下当前 #writeGeneration 作为本轮基线。
  // 读取不持锁；返回后若 #writeGeneration 已前进，说明本轮结果早于本进程刚完成的保存，必须丢弃以防版本倒退。
  // 只有 revision 变化才更新 #observedRevision 并 #emit("poll-changed")，finally 复位在飞标志并重新排期。
  async #pollOnce(): Promise<void> {
    this.#pollingInFlight = true;
    const writeGeneration = this.#writeGeneration;
    try {
      const snapshot = await this.#readPollingSnapshot();
      // 去掉读锁后，旧轮询可能晚于本进程保存返回；丢弃它，避免版本倒退及重复通知。
      if (writeGeneration !== this.#writeGeneration) return;
      this.#pollingErrorActive = false;
      if (this.#disposed || snapshot.revision === this.#observedRevision) return;
      this.#observedRevision = snapshot.revision;
      this.#emit("poll-changed");
    } catch (error) {
      // 成功保存也使旧轮询的失败失效，不能在新版本之后再发布旧读操作的故障。
      if (this.#disposed || writeGeneration !== this.#writeGeneration) return;
      if (!this.#pollingErrorActive) {
        this.#pollingErrorActive = true;
        try {
          this.#onPollingError?.(error);
        } catch {
          // 观测回调不能反向阻断下一轮自愈。
        }
        this.#emit("poll-error");
      }
    } finally {
      this.#pollingInFlight = false;
      this.#ensurePolling();
    }
  }

  // 销毁后不再派发；监听器同步执行，任一抛错会中断本轮其余监听器。
  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  // 所有公开入口先断言，避免已销毁实例继续排期轮询或返回缓存视图。
  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodePersonalProviderConfigRepository 已 dispose");
  }
}

export function createNodePersonalProviderConfigRepository(
  options: NodePersonalProviderConfigRepositoryOptions,
): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository(options);
}

// 只有 ENOENT 视为“文件不存在”；权限错误与坏 JSON 继续上抛，由 read() 的恢复分支接管（INV-13）。
async function readJsonFileIfExists(filePath: string): Promise<{ readonly value: unknown } | null> {
  try {
    const text = await readFile(filePath, "utf8");
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function emptyUpdate(): ProviderConfigLayerUpdate {
  return Object.freeze({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
}

// revision 由规范编码内容的 SHA-256 派生，与磁盘字节一一对应：同一内容无论字段顺序如何都得到同一版本（INV-18）。
function snapshotFromUpdate(update: ProviderConfigLayerUpdate): ProviderConfigLayerSnapshot {
  const content = JSON.stringify(encodeProviderConfigFile(update));
  return Object.freeze({
    revision: createHash("sha256").update(content).digest("hex"),
    providers: update.providers,
    models: update.models,
    // 快照必须与 revision 对应的磁盘内容一致；补空数组会让未声明排序的文件在 CAS 时误报变化。
    providerOrder: update.providerOrder,
    defaultModelSelection: update.defaultModelSelection,
  });
}
