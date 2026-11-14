// 浏览器标签崩溃恢复存储：以单个 JSON 文件保存 tab shell 与 pageState 两张表。
// 主进程是唯一写入者，所有变更经 mutationQueue 串行落盘，读路径只返回深拷贝。
// 文件损坏时隔离为 .corrupt-时间戳 并从空快照重建，避免阻塞应用启动。
// 容量按条数、总字节与单条历史长度三档裁剪，超限记录必须在加入时即被丢弃。
// INV-01 单文件即键空间：shells 与 pageStates 同存一处，一次落盘同时覆盖两张表；守住位置：writeSnapshot；改错故障：重启后标签与页面历史一起回退到上个版本。
// INV-02 schemaVersion 恒为 1，未知版本按损坏而不是按迁移处理；守住位置：parseSnapshot；改错故障：旧版本控件读到新结构，恢复出空白或错乱标签。
// INV-03 windowBindingId 落盘必须恒为 null，进程重启后不认领旧窗口；守住位置：upsert 与 parseSnapshot；改错故障：新窗口接管已失效的 windowId，标签挂到错误窗口。
// INV-04 写入串行：所有变更排入同一条 Promise 链，同一时刻只有一次落盘；守住位置：mutate；改错故障：并发写交叉覆盖，最后写入者吞掉别人的标签。
// INV-05 每次 mutation 先确保快照已加载，再改内存，再整文件重写；守住位置：mutate；改错故障：在未加载状态上直接写入，磁盘旧记录被整体抹掉。
// INV-06 队列尾部吞掉异常，让后续 mutation 继续排队；守住位置：mutate 的 catch 分支；改错故障：一次写失败后队列永久拒绝，后续标签变更全部静默丢失。
// INV-07 落盘原子性：先写同目录临时文件再改名覆盖，读方只会看到完整 JSON；守住位置：writeSnapshot；改错故障：断电留下半截文件，下次启动整份恢复数据被判损坏。
// INV-08 落盘失败必须清理临时文件；守住位置：writeSnapshot 的 catch 分支；改错故障：临时文件在崩溃循环中无限堆积，占满用户磁盘。
// INV-09 会话隔离：listShells 以 workspaceKey、remoteSessionId、sessionId 三段过滤；守住位置：listShells；改错故障：远程会话混进本地标签列表，用户看到别人的页面。
// INV-10 远程会话标识用空串归一，缺省与 undefined 视为同一本地会话；守住位置：listShells 的比较式；改错故障：同一工作区被拆成两份视图，标签时有时无。
// INV-11 恢复顺序稳定：openedAt 相同再按 tabId 字典序；守住位置：listShells 的排序式；改错故障：每次重启标签顺序抖动，用户找不到原来的位置。
// INV-12 条数预算 100 条 pageState；守住位置：upsertPageState 调用的 prunePageStates；改错故障：快照随会话增长无限膨胀，启动解析越来越慢。
// INV-13 字节预算必须为 64MB，按 UTF-8 实际体积计算；守住位置：prunePageStates 的累计循环；改错故障：大页面快照撑爆内存，主进程启动即卡顿。
// INV-14 单条历史上限 500，裁剪以 activeIndex 为锚保留连续窗口；守住位置：normalizePageState；改错故障：当前页被裁掉，恢复后落到错误的历史位置。
// INV-15 单条超限记录不占数量预算；守住位置：prunePageStates 的过滤式；改错故障：一条无效新快照挤掉最旧的正常快照，用户丢失可用历史。
// INV-16 清理按 updatedAt 由新到旧，超出预算立即停止；守住位置：prunePageStates；改错故障：淘汰方向反了，刚写入的页面历史被优先删除。
// INV-17 损坏文件改名隔离并告警，隔离失败只告警不阻断；守住位置：ensureLoaded 的 catch 分支；改错故障：坏文件反复触发解析失败，应用无法启动。
// INV-18 删除标签时 shell 与 pageState 必须同时移除；守住位置：remove；改错故障：残留 pageState 变成孤儿，白占预算并挤掉其他标签历史。
// INV-19 readSnapshot 返回深拷贝，调用方改不动内部状态；守住位置：cloneSnapshot；改错故障：外部批量修改数组，下一次落盘写入被污染的数据。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserViewportSize } from "@zcode/shared";

// 数量预算：pageStates 最多保留 100 条，超出按最近更新淘汰最旧记录。
// 上限必须只作用于 pageState，shell 记录不参与裁剪，避免丢失已打开的标签壳。
// 预算过小会让多标签场景恢复后丢失部分页面的前进后退历史。
export const BROWSER_TAB_PAGE_STATE_MAX_RECORDS = 100;
// 字节预算：pageState 序列化后合计不超过 64MB，防止快照无限膨胀拖慢启动解析。
// 体积按 UTF-8 字节计算，中文标题与编码后的 pageState 都计入真实占用。
// 调小会提前淘汰历史，调大则整文件读写变慢并抬高主进程内存峰值。
export const BROWSER_TAB_PAGE_STATE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const BROWSER_TAB_PAGE_STATE_MAX_HISTORY_ENTRIES = 500;

export interface BrowserTabShellRecord {
  schemaVersion: 1;
  tabId: string;
  /**
   * Electron windowId 跨重启无效；仅在当前进程认领后写入内存副本，落盘固定为 null。
   */
  windowBindingId: null;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId?: string;
  browserGeneration?: number;
  origin: "agent" | "user";
  lifecycle: "active" | "deliverable" | "handoff";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  viewport: BrowserViewportSize | null;
  openedAt: number;
  lastSelectedAt: number | null;
  updatedAt: number;
}

export interface BrowserTabNavigationEntry {
  url: string;
  title?: string;
  pageState?: string;
}

export interface BrowserTabPageStateRecord {
  schemaVersion: 1;
  tabId: string;
  entries: BrowserTabNavigationEntry[];
  activeIndex: number;
  updatedAt: number;
}

export interface BrowserTabRecoverySnapshot {
  schemaVersion: 1;
  shells: BrowserTabShellRecord[];
  pageStates: BrowserTabPageStateRecord[];
}

interface BrowserTabRecoveryStoreOptions {
  maxPageStates?: number;
  maxTotalBytes?: number;
  maxHistoryEntries?: number;
  onWarning?: (message: string) => void;
}

// 空快照是首次启动与损坏重建的统一起点，schemaVersion 同步为 1。
// 复用这份常量前必须克隆，否则一次写入就会污染共享基线。
const EMPTY_SNAPSHOT: BrowserTabRecoverySnapshot = {
  schemaVersion: 1,
  shells: [],
  pageStates: [],
};

// [可达性] 生产装配未实例化本类：index.ts 的 residency 选项显式不注入 recoveryStore，
// 产品语义为「完整退出即清空」。因此下面的 INV 与落盘/裁剪逻辑当前只在单测注入替身时执行，
// 生产进程不会写出任何快照文件；启用条件见 ZC-DEFECTS 的 D-9-4。
export class BrowserTabRecoveryStore {
  private snapshot: BrowserTabRecoverySnapshot | null = null;
  // 写入屏障：所有 mutation 以 Promise 链串行排队，同一时刻只有一次落盘。
  // 串行而非去抖：连续 upsert 不会被合并成一次写入，写入次数等于调用次数。
  // 每次变更都整文件重写，高频切换标签时的 writeFile IO 放大是这条约定的代价。
  // 队列只保证顺序，不做超时控制，卡住的写入会让后续 mutation 一起等待。
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly maxPageStates: number;
  private readonly maxTotalBytes: number;
  private readonly maxHistoryEntries: number;
  private readonly onWarning?: (message: string) => void;

  constructor(
    private readonly filePath: string,
    options: BrowserTabRecoveryStoreOptions = {},
  ) {
    this.maxPageStates = options.maxPageStates ?? BROWSER_TAB_PAGE_STATE_MAX_RECORDS;
    this.maxTotalBytes = options.maxTotalBytes ?? BROWSER_TAB_PAGE_STATE_MAX_TOTAL_BYTES;
    this.maxHistoryEntries =
      options.maxHistoryEntries ?? BROWSER_TAB_PAGE_STATE_MAX_HISTORY_ENTRIES;
    this.onWarning = options.onWarning;
  }

  // readSnapshot 先等队列排空，避免读到正在写入的中间快照。
  // 返回前深拷贝，调用方修改返回数组不会穿透到内部持有状态。
  // 首次读取由 ensureLoaded 建立缓存，之后不再访问磁盘。
  async readSnapshot(): Promise<BrowserTabRecoverySnapshot> {
    await this.mutationQueue;
    const snapshot = await this.ensureLoaded();
    return cloneSnapshot(snapshot);
  }

  async getShell(tabId: string): Promise<BrowserTabShellRecord | null> {
    const snapshot = await this.readSnapshot();
    return snapshot.shells.find((record) => record.tabId === tabId) ?? null;
  }

  async getPageState(tabId: string): Promise<BrowserTabPageStateRecord | null> {
    const snapshot = await this.readSnapshot();
    return snapshot.pageStates.find((record) => record.tabId === tabId) ?? null;
  }

  // 会话隔离的真实入口：先按 workspaceKey 精确匹配，跨工作区的标签互不可见。
  // remoteSessionId 用空串归一，缺省字段与 undefined 视为同一本地会话。
  // sessionId 仅在调用方显式传入时生效，未传则返回该工作区全部会话的标签。
  // 排序按 openedAt 升序并以 tabId 兜底，保证恢复顺序可复现。
  async listShells(scope: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserTabShellRecord[]> {
    const snapshot = await this.readSnapshot();
    return snapshot.shells
      .filter(
        (record) =>
          record.workspaceKey === scope.workspaceKey &&
          (record.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
          (scope.sessionId === undefined || record.sessionId === scope.sessionId),
      )
      .sort(
        (left, right) => left.openedAt - right.openedAt || left.tabId.localeCompare(right.tabId),
      );
  }

  // 按 tabId 覆盖已有记录而不追加，避免同一标签在快照里重复出现。
  // 写入前强制把 windowBindingId 置空，内存中的窗口绑定绝不进入磁盘。
  // 覆盖保留数组原位置，标签顺序不会因为再次保存而跳动。
  async upsert(record: BrowserTabShellRecord): Promise<void> {
    await this.mutate((snapshot) => {
      const normalized: BrowserTabShellRecord = {
        ...record,
        windowBindingId: null,
      };
      const index = snapshot.shells.findIndex((candidate) => candidate.tabId === record.tabId);
      if (index >= 0) snapshot.shells[index] = normalized;
      else snapshot.shells.push(normalized);
    });
  }

  // upsertPageState 先按历史长度归一化，再落表并整体裁剪，任何写入后都满足三档预算。
  // 归一化与裁剪在同一次 mutation 内完成，磁盘上不会出现超限的中间态。
  // pageState 与 shell 分开存储，页面历史丢失不应连累标签壳的恢复。
  async upsertPageState(record: BrowserTabPageStateRecord): Promise<void> {
    await this.mutate((snapshot) => {
      const normalized = normalizePageState(record, this.maxHistoryEntries);
      const index = snapshot.pageStates.findIndex((candidate) => candidate.tabId === record.tabId);
      if (index >= 0) snapshot.pageStates[index] = normalized;
      else snapshot.pageStates.push(normalized);
      snapshot.pageStates = prunePageStates(
        snapshot.pageStates,
        this.maxPageStates,
        this.maxTotalBytes,
      );
    });
  }

  async removePageState(tabId: string): Promise<void> {
    await this.mutate((snapshot) => {
      snapshot.pageStates = snapshot.pageStates.filter((record) => record.tabId !== tabId);
    });
  }

  // 删除标签必须同时摘掉 shell 与 pageState，任一残留都会变成孤儿。
  // 孤儿 pageState 会白占条数与字节预算，间接挤掉其他标签的历史。
  // remove 过滤后立即落盘，删除是同步终态而不是延迟生效的意图。
  async remove(tabId: string): Promise<void> {
    await this.mutate((snapshot) => {
      snapshot.shells = snapshot.shells.filter((record) => record.tabId !== tabId);
      snapshot.pageStates = snapshot.pageStates.filter((record) => record.tabId !== tabId);
    });
  }

  /** 等待所有已提交 mutation 完成，供应用正常退出建立持久化屏障。 */
  // 退出屏障：应用正常退出前等队列排空，保证最后一次变更已经落盘。
  // 该等待只覆盖已入队的 mutation，不会拦截之后新提交的写入。
  async whenIdle(): Promise<void> {
    await this.mutationQueue;
  }

  // 所有写操作的唯一通道必须满足：加载、变更、落盘三步在同一次排队任务内完成。
  // 任务以 then 链接到队尾，前一次落盘结束后才读取内存快照。
  // 落盘异常向调用方抛出，持久化问题不被静默吞掉。
  private async mutate(mutation: (snapshot: BrowserTabRecoverySnapshot) => void): Promise<void> {
    const task = this.mutationQueue.then(async () => {
      const snapshot = await this.ensureLoaded();
      mutation(snapshot);
      await this.writeSnapshot(snapshot);
    });
    this.mutationQueue = task.catch(() => undefined);
    await task;
  }

  // 加载是惰性单次：snapshot 一旦建立就不再回读磁盘，外部改文件不会热生效。
  // ENOENT 视为首次启动，直接建空快照而不进入损坏隔离分支。
  // parseSnapshot 其余读取或解析错误一律按损坏处理，避免启动被坏文件卡死。
  private async ensureLoaded(): Promise<BrowserTabRecoverySnapshot> {
    if (this.snapshot) return this.snapshot;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.snapshot = parseSnapshot(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 损坏隔离：把坏文件改名成 .corrupt-时间戳，保留现场供事后排查。
        // 隔离失败只上报告警，仍从空快照继续，恢复能力优先于完整性。
        // 改名失败必须与文件已消失区分，后者不算错误，前者才提示用户。
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          await rename(this.filePath, corruptPath);
          this.onWarning?.(`browser tab recovery 文件损坏，已隔离到 ${corruptPath}`);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
            this.onWarning?.(
              `browser tab recovery 损坏文件隔离失败: ${
                renameError instanceof Error ? renameError.message : String(renameError)
              }`,
            );
          }
        }
      }
      this.snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
    }
    return this.snapshot;
  }

  // 原子落盘：先写同目录临时文件再改名覆盖，读方只能看到完整 JSON。
  // 临时名带随机 UUID，避免重入或并发时互相覆盖同一个中间文件。
  // writeSnapshot 写前递归创建父目录，首次启动时目录可能还不存在。
  private async writeSnapshot(snapshot: BrowserTabRecoverySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

// 历史裁剪以 activeIndex 为锚：超出上限时保留包含当前页的连续窗口。
// activeIndex 先夹到合法范围，空历史统一为 0，避免恢复时越界。
// 裁剪后 activeIndex 减去窗口起点，索引随数组平移而不是失效。
function normalizePageState(
  record: BrowserTabPageStateRecord,
  maxHistoryEntries: number,
): BrowserTabPageStateRecord {
  const entries = record.entries.map((entry) => ({ ...entry }));
  const clampedIndex =
    entries.length === 0
      ? 0
      : Math.max(0, Math.min(Math.trunc(record.activeIndex), entries.length - 1));
  if (entries.length <= maxHistoryEntries) {
    return { ...record, entries, activeIndex: clampedIndex };
  }

  const maximumStart = entries.length - maxHistoryEntries;
  const start = Math.max(0, Math.min(clampedIndex, maximumStart));
  return {
    ...record,
    entries: entries.slice(start, start + maxHistoryEntries),
    activeIndex: clampedIndex - start,
  };
}

// 清理顺序按 updatedAt 由新到旧，超出预算即停止，最旧的快照先被淘汰。
// prunePageStates 先判断每条候选是否超过总预算，超限记录在源头就被过滤。
// 字节累计含 JSON 数组括号与逗号，估算与真实文件体积保持同一口径。
function prunePageStates(
  records: BrowserTabPageStateRecord[],
  maxPageStates: number,
  maxTotalBytes: number,
): BrowserTabPageStateRecord[] {
  const candidates = [...records]
    .sort(
      (left, right) => right.updatedAt - left.updatedAt || left.tabId.localeCompare(right.tabId),
    )
    .map((record) => ({
      record,
      serialized: JSON.stringify(record),
    }))
    .filter(({ serialized }) => {
      // 先把超大新记录放到 LRU 头部、再从尾部逐条删除会让所有正常旧快照
      // 先被淘汰，最后才删掉超大记录；同时每次 pop 都全量 stringify，放大主进程开销。
      return Buffer.byteLength(`[${serialized}]`, "utf8") <= maxTotalBytes;
    })
    // 单条超限记录不应占用数量预算，否则一个无效新快照仍会挤掉最旧的正常快照。
    .slice(0, Math.max(0, maxPageStates));
  const retained: BrowserTabPageStateRecord[] = [];
  let totalBytes = 2; // JSON 数组的 []。
  for (const [index, candidate] of candidates.entries()) {
    const nextBytes = Buffer.byteLength(candidate.serialized, "utf8") + (index === 0 ? 0 : 1);
    if (totalBytes + nextBytes > maxTotalBytes) break;
    retained.push(candidate.record);
    totalBytes += nextBytes;
  }
  return retained;
}

// 反序列化即校验：非对象、版本不是 1、两张表不是数组，一律抛出并按损坏处理。
// 校验通过后逐条重建并清空 windowBindingId，旧进程的窗口绑定不得复活。
// entries 逐项浅拷贝，防止解析结果与外部引用共享同一批对象。
function parseSnapshot(value: unknown): BrowserTabRecoverySnapshot {
  if (!value || typeof value !== "object") throw new TypeError("invalid browser recovery snapshot");
  const candidate = value as Partial<BrowserTabRecoverySnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.shells) ||
    !Array.isArray(candidate.pageStates)
  ) {
    throw new TypeError("unsupported browser recovery snapshot");
  }
  return {
    schemaVersion: 1,
    shells: candidate.shells.map((record) => ({
      ...record,
      windowBindingId: null,
    })),
    pageStates: candidate.pageStates.map((record) => ({
      ...record,
      entries: record.entries.map((entry) => ({ ...entry })),
    })),
  };
}

// 克隆分两层：记录级展开与 entries 逐项复制，读方拿不到内部引用。
// 所有对外出口都过这里，深拷贝缺失会让并发读取看到半更新的数组。
function cloneSnapshot(snapshot: BrowserTabRecoverySnapshot): BrowserTabRecoverySnapshot {
  return {
    schemaVersion: 1,
    shells: snapshot.shells.map((record) => ({ ...record })),
    pageStates: snapshot.pageStates.map((record) => ({
      ...record,
      entries: record.entries.map((entry) => ({ ...entry })),
    })),
  };
}
