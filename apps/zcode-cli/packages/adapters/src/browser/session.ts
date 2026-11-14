// ============================================================
// 文件定位：一个浏览会话的 tab（Page）与 dialog 登记表，托管在独立 BrowserContext 上。
// 输入输出：createTab/ensureTab 返回 ManagedCdpTab；listTabs 返回契约化 tab 摘要。
// 副作用：newPage/close/bringToFront/setViewportSize；监听 context 的 page 事件与 page 的 dialog/close。
// 失败语义：指定 tabId 不存在或已关闭时抛错；title 读取失败降级为空串；close 对断连 context 幂等。
// 不变量：tab id 一经生成不回收；activeTab 必须指向现存 tab；dialog 按 tab 唯一。
// ============================================================
import { randomUUID } from "node:crypto";
import type { BrowserContext, Dialog, Page, ViewportSize } from "playwright-core";
import type { BrowserTabSummary } from "@zcode/contracts";

export interface ManagedCdpTab {
  // 稳定标识（tab:<uuid>），跨命令引用同一页面。
  id: string;
  // Playwright 页面句柄；关闭后 isClosed() 为 true，本对象可能仍残留在表中。
  page: Page;
}

// 未设置/被清空时使用 1280x720，保证无头模式截图尺寸可预期。
const DEFAULT_VIEWPORT: ViewportSize = { width: 1280, height: 720 };

// 会话级状态：tabs 按 id 索引，dialogs 按 tab 记录最新未处理弹窗（同一 tab 只保留一个）。
export class ManagedCdpSession {
  readonly #dialogs = new Map<string, Dialog>();
  readonly #tabs = new Map<string, ManagedCdpTab>();
  #activeTabId: string | undefined;

  // 接管 context：把已存在页面登记进来，并订阅后续新页面（window.open/target=_blank）。
  constructor(readonly context: BrowserContext) {
    for (const page of context.pages()) this.registerPage(page);
    context.on("page", (page) => this.registerPage(page));
  }

  // 当前登记的 tab id 列表（含已关闭但尚未清理的条目）。
  get tabIds(): string[] {
    return [...this.#tabs.keys()];
  }

  // 当前活动 tab id；无 tab 时为 undefined。
  get activeTabId(): string | undefined {
    return this.#activeTabId;
  }

  // 新建标签页并设为活动页；新页面可能已被 page 事件提前登记，需去重后再复用。
  async createTab(): Promise<ManagedCdpTab> {
    const page = await this.context.newPage();
    const tab = this.tabForPage(page) ?? this.registerPage(page);
    this.#activeTabId = tab.id;
    await page.bringToFront();
    return tab;
  }

  // 取标签页：指定 id 时强校验（不存在/已关闭即报错，避免对死页面发命令）。
  // 未指定时优先活动页，其次任一存活页，最后才新建；这样无 tab 也能自然恢复。
  async ensureTab(tabId?: string): Promise<ManagedCdpTab> {
    if (tabId) {
      const tab = this.#tabs.get(tabId);
      if (!tab || tab.page.isClosed()) throw new Error(`Browser tab '${tabId}' is unavailable`);
      return tab;
    }
    const active = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
    if (active && !active.page.isClosed()) return active;
    const fallback = [...this.#tabs.values()].find((candidate) => !candidate.page.isClosed());
    return fallback ?? (await this.createTab());
  }

  // 切换活动页并前置；tabId 必须已是存活页面。
  async activateTab(tabId: string): Promise<ManagedCdpTab> {
    const tab = await this.ensureTab(tabId);
    this.#activeTabId = tab.id;
    await tab.page.bringToFront();
    return tab;
  }

  // 关标签：先摘表再关页（关页期间不再被 listTabs/ensureTab 选中），最后把活动页切到剩余最后一个。
  async closeTab(tabId?: string): Promise<void> {
    const tab = await this.ensureTab(tabId);
    this.#tabs.delete(tab.id);
    this.#dialogs.delete(tab.id);
    if (!tab.page.isClosed()) await tab.page.close({ runBeforeUnload: false });
    if (this.#activeTabId === tab.id) {
      this.#activeTabId = [...this.#tabs.keys()].at(-1);
    }
  }

  // 列出存活标签页摘要：跳过已关闭页面；title 读取失败给空串，viewport 缺省用 1280x720。
  // active 字段仅对活动页出现，lifecycle 固定 active（托管会话不支持冻结/丢弃）。
  async listTabs(): Promise<BrowserTabSummary[]> {
    const summaries: BrowserTabSummary[] = [];
    for (const tab of this.#tabs.values()) {
      if (tab.page.isClosed()) continue;
      summaries.push({
        tabId: tab.id,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ""),
        viewport: tab.page.viewportSize() ?? DEFAULT_VIEWPORT,
        ...(tab.id === this.#activeTabId ? { active: true } : {}),
        lifecycle: "active",
      });
    }
    return summaries;
  }

  // 查询某 tab 当前未处理的 dialog；同 tab 只保存最近一个。
  dialogFor(tabId: string): Dialog | undefined {
    return this.#dialogs.get(tabId);
  }

  // 处理完 dialog 后显式清除，避免 getDialog 反复返回已处理弹窗。
  clearDialog(tabId: string): void {
    this.#dialogs.delete(tabId);
  }

  // 设置视口；null 表示恢复默认 1280x720（而不是“保持原样”）。
  async setViewport(tabId: string | undefined, viewport: ViewportSize | null): Promise<void> {
    const tab = await this.ensureTab(tabId);
    await tab.page.setViewportSize(viewport ?? DEFAULT_VIEWPORT);
  }

  // 关闭会话：先清内部表；浏览器仍连接时才关 context，断连时直接返回避免抛错。
  async close(): Promise<void> {
    this.#dialogs.clear();
    this.#tabs.clear();
    if (!this.context.browser()?.isConnected()) return;
    await this.context.close().catch(() => undefined);
  }

  // 登记页面：已登记过则复用；首个页面自动成为活动页。
  // 同时订阅 dialog（记录弹窗）与 close（清理表项并按需切换活动页），保证状态不脏。
  private registerPage(page: Page): ManagedCdpTab {
    const existing = this.tabForPage(page);
    if (existing) return existing;
    const tab = { id: `tab:${randomUUID()}`, page };
    this.#tabs.set(tab.id, tab);
    this.#activeTabId ??= tab.id;
    page.on("dialog", (dialog) => this.#dialogs.set(tab.id, dialog));
    page.on("close", () => {
      this.#tabs.delete(tab.id);
      this.#dialogs.delete(tab.id);
      if (this.#activeTabId === tab.id) this.#activeTabId = [...this.#tabs.keys()].at(-1);
    });
    return tab;
  }

  // 线性查找 page 对应的 tab（tab 数量很小，无需额外索引）。
  private tabForPage(page: Page): ManagedCdpTab | undefined {
    return [...this.#tabs.values()].find((candidate) => candidate.page === page);
  }
}
