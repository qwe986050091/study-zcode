// INV-01 只有 browser 前缀的标签会被登记：守住位置 bindGuest 前缀判断；改错故障 普通标签页被拦截原生弹窗。
// INV-02 登记前先解绑同 id 旧记录：守住位置 unbindGuest 调用；改错故障 重绑后仍持有失效 guest。
// INV-03 guest 必须存在、未销毁且类型正确：守住位置 guest 校验；改错故障 向已销毁对象注册监听。
// INV-04 销毁监听必须校验注册身份：守住位置 registration 相等判断；改错故障 新绑定被旧回调误删。
// INV-05 同一 guest 不允许并发弹窗：守住位置 openDialogGuestIds；改错故障 递归弹窗叠加系统框。
// INV-06 自动化期间必须交还原生对话框：守住位置 shouldUseNativeDialog；改错故障 自动化脚本被阻塞。
// INV-07 自动化结束后保留宽限窗口：守住位置 passthroughUntil；改错故障 收尾阶段弹窗被抢走。
// INV-08 释放函数必须幂等：守住位置 released 标记；改错故障 计数被重复递减。
// INV-09 计数归零才启动清理定时器：守住位置 activeCount 判断；改错故障 并行自动化互相清除状态。
// INV-10 清理定时器必须 unref：守住位置 unref 调用；改错故障 进程无法退出。
// INV-11 清理时校验状态仍是同一对象：守住位置 current 与 state 的相等判断；改错故障 新状态被旧定时器删除。
// INV-12 来源标签只信任可信协议与源：守住位置 resolveEmbeddedBrowserDialogSource；改错故障 伪造协议冒充可信站点。
// INV-13 无法解析时使用中性标签：守住位置 兜底返回值；改错故障 暴露内部地址。
// INV-14 空白地址必须回退到 guest 主文档地址：守住位置 双候选传入；改错故障 弹窗显示空白来源。
// INV-15 创建失败不得伪造用户选择：守住位置 catch 分支返回未处理；改错故障 用户被当成已确认。
// INV-16 弹窗期间必须登记并最终移除：守住位置 try 与 finally；改错故障 一次异常后该 guest 永久无法弹窗。
// INV-17 父窗口必须存在且未销毁：守住位置 窗口查找后的校验；改错故障 无父窗口时创建游离对话框。
// INV-18 dispose 必须清空全部映射与定时器：守住位置 dispose；改错故障 窗口关闭后仍持有 guest 引用。
//
// 模块职责：接管用户浏览器标签页的原生 alert 与 confirm，并保证自动化期间不拦截。
// 状态所有权：guest 登记、弹窗中集合与每窗口自动化状态都由控制器实例持有。
// 阅读顺序：先看请求解析与来源标签，再读弹窗主流程，最后看自动化计数与释放。
import { BrowserWindow, dialog, nativeImage, webContents } from "electron";
import type { WebContents } from "electron";
import type { Locale } from "@zcode/shared";

// DEFAULT_AUTOMATION_GRACE_MS 宽限期覆盖自动化脚本收尾阶段；可经 automationGraceMs 构造参数覆盖，便于测试压缩时间；USER_BROWSER_TAB_PREFIX 用于区分用户浏览器标签；前缀不匹配的标签不能参与弹窗接管。
const DEFAULT_AUTOMATION_GRACE_MS = 3_000;
const USER_BROWSER_TAB_PREFIX = "browser:";

interface EmbeddedBrowserDialogRequest {
  type: "alert" | "confirm";
  message: string;
}

export interface EmbeddedBrowserDialogResponse {
  handled: boolean;
  value?: boolean;
}

interface RegisteredGuest {
  guest: WebContents;
  tabId: string;
  windowId: number;
}

interface AutomationWindowState {
  activeCount: number;
  passthroughUntil: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

function parseEmbeddedBrowserDialogRequest(value: unknown): EmbeddedBrowserDialogRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<EmbeddedBrowserDialogRequest>;
  if (
    (candidate.type !== "alert" && candidate.type !== "confirm") ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  return { type: candidate.type, message: candidate.message };
}

// 按 frame 优先、guest 次之的顺序尝试。
// 只接受带 host 的 http 与 https。
// blob 源解析后走同样校验。
// 解析异常时必须继续尝试下一候选 URL。
// 全部失败使用中性标签。
export function resolveEmbeddedBrowserDialogSource(
  frameUrl: string,
  guestUrl?: string,
): string {
  for (const candidate of [frameUrl, guestUrl]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
        return `${parsed.host} says`;
      }
      if (parsed.protocol === "blob:" && parsed.origin) {
        const origin = new URL(parsed.origin);
        if ((origin.protocol === "http:" || origin.protocol === "https:") && origin.host) {
          return `${origin.host} says`;
        }
      }
    } catch {
      // 继续尝试 Chromium 维护的下一层可信 URL。
    }
  }
  // 非法或无 host URL 统一使用不可伪造的中性来源标签。
  return "This page says";
}

export function resolveEmbeddedBrowserDialogButtons(
  locale: Locale,
  type: EmbeddedBrowserDialogRequest["type"],
): string[] {
  if (type === "alert") return [locale === "zh-CN" ? "确定" : "OK"];
  return locale === "zh-CN" ? ["取消", "确定"] : ["Cancel", "OK"];
}

/**
 * 用户 Browser 的 preload 在网页调用原生 alert/confirm 之前同步进入这里，因此用户路径
 * 不会先创建 Chromium Dialog。自动化期间返回 handled=false，由 preload 调回原生 API，
 * 继续让 BrowserGuestManager 的 getDialog/handleDialog 处理。
 */
export class EmbeddedBrowserJavaScriptDialogController {
  private readonly guests = new Map<number, RegisteredGuest>();
  private readonly openDialogGuestIds = new Set<number>();
  private readonly automationByWindow = new Map<number, AutomationWindowState>();

  constructor(
    private readonly options: {
      iconPath: string;
      getLocale: () => Locale;
      logger: { warn: (...args: unknown[]) => void };
      automationGraceMs?: number;
    },
  ) {}

  // 解绑所有 guest 并移除销毁监听。
  // 清理全部待执行定时器；清空 automationByWindow 与 openDialogGuestIds；dispose 必须幂等，可重复调用。
  dispose(): void {
    for (const webContentsId of this.guests.keys()) this.unbindGuest(webContentsId);
    for (const state of this.automationByWindow.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    }
    this.automationByWindow.clear();
    this.openDialogGuestIds.clear();
  }

  bindGuest(tabId: string, webContentsId: number, windowId: number): void {
    this.unbindGuest(webContentsId);
    if (!tabId.startsWith(USER_BROWSER_TAB_PREFIX)) return;

    const guest = webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return;

    const registration: RegisteredGuest = { guest, tabId, windowId };
    this.guests.set(webContentsId, registration);
    guest.once("destroyed", () => {
      if (this.guests.get(webContentsId) === registration) this.unbindGuest(webContentsId);
    });
  }

  // 解析、登记与自动化状态任一不满足都必须返回 handled=false。
  // shouldUseNativeDialog 为真时必须交还原生处理路径。
  // 弹窗期间登记 guest 标识防止重入。
  // 成功路径按类型返回确认值。
  // 失败路径记录日志后交还原生接口。
  handleDialogRequest(
    webContentsId: number,
    frameUrl: string,
    payload: unknown,
  ): EmbeddedBrowserDialogResponse {
    const request = parseEmbeddedBrowserDialogRequest(payload);
    const registration = this.guests.get(webContentsId);
    if (
      !request ||
      !registration ||
      this.openDialogGuestIds.has(webContentsId) ||
      this.shouldUseNativeDialog(registration.windowId)
    ) {
      return { handled: false };
    }

    const parent = BrowserWindow.fromId(registration.windowId);
    if (!parent || parent.isDestroyed()) return { handled: false };

    this.openDialogGuestIds.add(webContentsId);
    try {
      const icon = nativeImage.createFromPath(this.options.iconPath);
      const selected = dialog.showMessageBoxSync(parent, {
        type: request.type === "alert" ? "info" : "question",
        buttons: resolveEmbeddedBrowserDialogButtons(this.options.getLocale(), request.type),
        defaultId: request.type === "alert" ? 0 : 1,
        cancelId: 0,
        // 同源 iframe 的可信 frame URL 可能是 about:blank；该 URL 没有
        // 可展示 host，必须继续使用 Chromium 维护的 guest 主文档 URL。
        message: resolveEmbeddedBrowserDialogSource(frameUrl, registration.guest.getURL()),
        detail: request.message,
        noLink: true,
        normalizeAccessKeys: true,
        ...(!icon.isEmpty() ? { icon } : {}),
      });
      return {
        handled: true,
        ...(request.type === "confirm" ? { value: selected === 1 } : {}),
      };
    } catch (error) {
      // 系统框创建失败时不能伪造用户选择；通知 preload 调回网页原生 API。
      this.options.logger.warn("[browser-pane] failed to handle JavaScript dialog with source", {
        error: error instanceof Error ? error.message : String(error),
        tabId: registration.tabId,
      });
      return { handled: false };
    } finally {
      this.openDialogGuestIds.delete(webContentsId);
    }
  }

  // 取得或创建该窗口的 AutomationWindowState；开始前必须先取消 cleanupTimer；进入自动化时把 passthroughUntil 设为正无穷；每次开始都递增 activeCount；返回的释放函数只能生效一次；计数归零后启动带宽限的清理定时器。
  beginAutomation(windowId: number): () => void {
    const state = this.automationByWindow.get(windowId) ?? {
      activeCount: 0,
      passthroughUntil: 0,
    };
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    state.activeCount += 1;
    state.passthroughUntil = Number.POSITIVE_INFINITY;
    this.automationByWindow.set(windowId, state);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.activeCount = Math.max(0, state.activeCount - 1);
      if (state.activeCount > 0) return;

      const graceMs = this.options.automationGraceMs ?? DEFAULT_AUTOMATION_GRACE_MS;
      state.passthroughUntil = Date.now() + graceMs;
      state.cleanupTimer = setTimeout(() => {
        const current = this.automationByWindow.get(windowId);
        if (current === state && current.activeCount === 0) {
          this.automationByWindow.delete(windowId);
        }
      }, graceMs);
      state.cleanupTimer.unref?.();
    };
  }

  private shouldUseNativeDialog(windowId: number): boolean {
    const state = this.automationByWindow.get(windowId);
    return Boolean(state && (state.activeCount > 0 || Date.now() < state.passthroughUntil));
  }

  private unbindGuest(webContentsId: number): void {
    this.guests.delete(webContentsId);
    this.openDialogGuestIds.delete(webContentsId);
  }
}
