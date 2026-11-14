// INV-01 Bundled、Active 与 Remote 必须共用同一 Release 载体：守住位置 类注释与三段读写；改错故障 三份配置各自漂移。
// INV-02 bundled 路径必须非空：守住位置 构造函数首行校验；改错故障 空路径让读取落在进程工作目录。
// INV-03 Active 缺省时回落到 bundled 路径：守住位置 构造函数赋值；改错故障 未配置缓存时无法启动。
// INV-04 来源键必须由 Active 绝对路径哈希得到：守住位置 sourceKey 构造；改错故障 不同 Endpoint 同序号被误复用。
// INV-05 监听默认开启，只有显式传入 false 才关闭：守住位置 watchEnabled 计算；改错故障 默认静默不刷新。
// INV-06 读取 Active 失败时必须回落到 Bundled：守住位置 read 的捕获分支；改错故障 缓存目录不可用直接阻断启动。
// INV-07 Bundled 自身无效时仍要抛错：守住位置 回落分支的候选选择；改错故障 无有效配置却返回空快照。
// INV-08 Active 的读写必须持有同一把文件锁：守住位置 三处 withFileLock；改错故障 并发写坏 JSON。
// INV-09 远端版本低于当前版本时判定为过期：守住位置 applyRemoteRelease 的首个比较；改错故障 旧版本回滚覆盖新配置。
// INV-10 相同版本必须内容一致，否则显式报错：守住位置 同版本比较分支；改错故障 同序号不同内容被静默接受。
// INV-11 只有更新成功且未销毁时才广播：守住位置 结果判断；改错故障 销毁后仍通知订阅者。
// INV-12 写入 Active 必须使用原子私有写：守住位置 writeActiveLocked；改错故障 半写文件在崩溃后无法解码。
// INV-13 同版本冲突时以 Bundled 为准：守住位置 selectReleaseCandidate 的冲突分支；改错故障 可信基线被坏缓存拖住。
// INV-14 无有效候选时必须聚合两侧错误：守住位置 空候选分支；改错故障 只看到一半失败原因。
// INV-15 候选选择取修订号最大者：守住位置 reduce 比较；改错故障 旧缓存压过新基线。
// INV-16 文件监听只关注目标文件名：守住位置 watch 回调过滤；改错故障 同目录无关写入触发刷新。
// INV-17 刷新必须串行化：守住位置 watchRefresh 链；改错故障 并发刷新互相覆盖签名。
// INV-18 dispose 必须幂等并关闭监听、清空订阅：守住位置 dispose；改错故障 重复关闭或监听泄漏。
//
// 模块职责：把内置 Provider 配置的 Bundled、Active 缓存与远端下发统一为一个可监听的配置来源。
// 状态所有权：Release 内容归本类；签名与监听器由实例持有，文件系统只作为持久化边界。
// 阅读顺序：先看构造与来源键，再读读取与远端应用，最后看监听刷新与候选选择。
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ProviderConfigLayerSnapshot, ProviderSource } from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
  type ZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface NodeZCodeBuiltinProviderConfigSourceOptions {
  readonly bundledFilePath: string;
  readonly activeFilePath?: string;
  readonly watch?: boolean;
}

export type ApplyZCodeBuiltinReleaseResult = "updated" | "unchanged" | "stale";

/** Bundled、Active/LKG 与 Remote 共用同一 Release，并最终发布为现有 Config Snapshot。 */
export class NodeZCodeBuiltinProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #bundledFilePath: string;
  readonly #activeFilePath: string;
  readonly #sourceKey: string;
  readonly #watchEnabled: boolean;
  readonly #listeners = new Set<(reason: string) => void>();
  #watcher: FSWatcher | null = null;
  #observedSignature: string | null = null;
  #watchRefresh = Promise.resolve();
  #disposed = false;

  // bundled 路径去空白后必须非空。
  // Active 缺省时与 bundled 指向同一文件。
  // 来源键取 Active 绝对路径的哈希，隔离不同 Endpoint。
  constructor(options: NodeZCodeBuiltinProviderConfigSourceOptions) {
    const bundledFilePath = options.bundledFilePath.trim();
    if (!bundledFilePath) throw new Error("ZCode Built-in bundledFilePath 不能为空");
    this.#bundledFilePath = bundledFilePath;
    this.#activeFilePath = options.activeFilePath?.trim() || bundledFilePath;
    // 旧标识只有发布序号，不同 Endpoint 同序号会让 Registry 误复用上一来源。
    // Active 路径已含规范化 Endpoint 隔离范围；Worker 收到同一路径，不另拼账号事实。
    this.#sourceKey = createHash("sha256").update(resolve(this.#activeFilePath)).digest("hex");
    this.#watchEnabled = options.watch !== false;
  }

  get activeFilePath(): string {
    return this.#activeFilePath;
  }

  // 先确认实例仍可用，再尝试建立监听与读取缓存。
  // 缓存链路整体包在锁内，读取与物化保持原子。
  // [失败路径] 缓存目录、监听或原子写失败都回落到 Bundled。
  // 快照中的修订号拼接来源键，保证跨来源唯一。
  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    let release: ZCodeBuiltinRelease;
    try {
      await this.#ensureWatcher();
      release = await withFileLock(this.#activeFilePath, () => this.#readAndMaterializeLocked());
    } catch {
      // Active 只是可丢弃缓存，目录锁、监听或原子物化失败不能阻断
      // Bundled 基线。缓存边界不可用时绕过 Active；Bundled 自身无效仍会在这里抛错。
      release = selectReleaseCandidate(await readReleaseCandidate(this.#bundledFilePath), null);
    }
    this.#observedSignature ??= signatureOf(release);
    return snapshotFromRelease(release, this.#sourceKey);
  }

  // 远端写入同样先确保监听可用。
  // 整个比较与写入都在同一把文件锁内完成。
  // 低版本直接返回过期，不触碰 Active。
  // [并发] 广播前再次检查销毁标记，避免关闭后通知。
  async applyRemoteRelease(release: ZCodeBuiltinRelease): Promise<ApplyZCodeBuiltinReleaseResult> {
    this.#assertNotDisposed();
    await this.#ensureWatcher();
    const result = await withFileLock(this.#activeFilePath, async () => {
      this.#assertNotDisposed();
      const current = await this.#readAndMaterializeLocked();
      this.#assertNotDisposed();
      if (release.revision < current.revision) return "stale" as const;
      if (release.revision === current.revision) {
        if (serializeZCodeBuiltinRelease(release) === serializeZCodeBuiltinRelease(current)) {
          return "unchanged" as const;
        }
        throw new Error(`ZCode Built-in 相同 revision ${release.revision} 对应不同内容`);
      }
      await this.#writeActiveLocked(release);
      this.#observedSignature = signatureOf(release);
      return "updated" as const;
    });
    if (result === "updated" && !this.#disposed) this.#emit("remote-updated");
    return result;
  }

  // `onDidChange` 订阅前先 `#assertNotDisposed()`，已销毁实例直接抛错。
  // 监听器存入 `#listeners` 集合，同一函数重复订阅天然去重。
  // `#dispose()` 时 `#listeners.clear()` 整体清空，不逐个回调。
  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher?.close();
    this.#watcher = null;
    this.#listeners.clear();
  }

  // 并行读取 Bundled 与 Active，Active 与 Bundled 同路径时跳过。
  // 候选选择在纯函数内完成，读取层不参与优先级判断。
  // 仅当 Active 路径独立时才考虑回写。
  // 返回值为最终选中的 Release。
  async #readAndMaterializeLocked(): Promise<ZCodeBuiltinRelease> {
    const [bundled, active] = await Promise.all([
      readReleaseCandidate(this.#bundledFilePath),
      this.#activeFilePath === this.#bundledFilePath
        ? Promise.resolve(null)
        : readReleaseCandidate(this.#activeFilePath),
    ]);
    const selected = selectReleaseCandidate(bundled, active);
    if (this.#activeFilePath !== this.#bundledFilePath) {
      const activeSignature = active?.release ? signatureOf(active.release) : null;
      if (activeSignature !== signatureOf(selected)) await this.#writeActiveLocked(selected);
    }
    return selected;
  }

  async #writeActiveLocked(release: ZCodeBuiltinRelease): Promise<void> {
    this.#assertNotDisposed();
    await atomicWritePrivateTextFile(
      this.#activeFilePath,
      JSON.stringify(encodeZCodeBuiltinRelease(release), null, 2),
    );
  }

  // 先确保 Active 所在目录存在。
  // 只监听目标文件名，减少无关事件。
  // 监听错误统一转为 watch-error 广播。
  async #ensureWatcher(): Promise<void> {
    await mkdir(dirname(this.#activeFilePath), { recursive: true });
    if (!this.#watchEnabled || this.#watcher || this.#disposed) return;
    const target = basename(this.#activeFilePath);
    this.#watcher = watch(dirname(this.#activeFilePath), (_eventType, fileName) => {
      if (fileName === null || fileName.toString() === target) this.#scheduleWatchRefresh();
    });
    this.#watcher.on("error", () => this.#emit("watch-error"));
  }

  // 刷新任务串接到同一条 Promise 链上。
  // 每轮先检查销毁标记。
  // 读取与物化继续走文件锁。
  // 签名未变不广播，异常转为 watch-error。
  #scheduleWatchRefresh(): void {
    this.#watchRefresh = this.#watchRefresh.then(async () => {
      if (this.#disposed) return;
      try {
        const release = await withFileLock(this.#activeFilePath, () =>
          this.#readAndMaterializeLocked(),
        );
        const signature = signatureOf(release);
        if (this.#disposed || signature === this.#observedSignature) return;
        this.#observedSignature = signature;
        this.#emit("file-changed");
      } catch {
        this.#emit("watch-error");
      }
    });
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeZCodeBuiltinProviderConfigSource 已 dispose");
  }
}

export function createNodeZCodeBuiltinProviderConfigSource(
  options: NodeZCodeBuiltinProviderConfigSourceOptions,
): NodeZCodeBuiltinProviderConfigSource {
  return new NodeZCodeBuiltinProviderConfigSource(options);
}

interface ReleaseCandidate {
  readonly release?: ZCodeBuiltinRelease;
  readonly error?: unknown;
}

async function readReleaseCandidate(filePath: string): Promise<ReleaseCandidate | null> {
  try {
    return { release: decodeZCodeBuiltinRelease(JSON.parse(await readFile(filePath, "utf8"))) };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return { error };
  }
}

function selectReleaseCandidate(
  bundled: ReleaseCandidate | null,
  active: ReleaseCandidate | null,
): ZCodeBuiltinRelease {
  if (
    bundled?.release &&
    active?.release &&
    bundled.release.revision === active.release.revision &&
    serializeZCodeBuiltinRelease(bundled.release) !== serializeZCodeBuiltinRelease(active.release)
  ) {
    // 同 revision 冲突属于 Active 缓存失效，不能反向使可信 Bundled 无法启动。
    // 返回 Bundled 后调用方会在能够写入时原子替换 Active。
    return bundled.release;
  }
  const valid = [bundled?.release, active?.release].filter(
    (candidate): candidate is ZCodeBuiltinRelease => candidate !== undefined,
  );
  if (valid.length === 0) {
    throw new AggregateError(
      [bundled?.error, active?.error].filter((error) => error !== undefined),
      "Bundled 与 Active ZCode Built-in Release 均不可用",
    );
  }
  return valid.reduce((newest, candidate) =>
    candidate.revision > newest.revision ? candidate : newest,
  );
}

function snapshotFromRelease(
  release: ZCodeBuiltinRelease,
  sourceKey: string,
): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: `zcode-builtin:${release.revision}:${sourceKey}`,
    providers: release.config.providers,
    providerTemplates: release.config.providerTemplates,
    models: release.config.modelConfigRules,
  });
}

function signatureOf(release: ZCodeBuiltinRelease): string {
  return `${release.revision}:${serializeZCodeBuiltinRelease(release)}`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
